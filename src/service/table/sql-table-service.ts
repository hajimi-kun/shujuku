/**
 * service/table/sql-table-service.ts — SQLite 模式的 ITableStorageProvider 实现
 *
 * 核心职责：
 * - 管理 SqliteEngine 和 SyncBridge 的生命周期
 * - 将 AI 返回的 SQL 语句路由到引擎执行
 * - 维护 currentJsonTableData_ACU 的同步
 * - 提供 SQL 查询和变更的入口
 */

import type {
  ITableStorageProvider,
  SqlTableApplyScope_ACU,
  SqlQueryResult,
  SqlMutationResult,
  ApplyEditsWithRowIdMaterializationResult_ACU,
  ApplyEditsResult,
  SqlQueryExecutionOptions_ACU,
} from '../../shared/table-storage-provider';
import type { TableDataObject_ACU, Mate_ACU } from '../../shared/models/table-data';
import type { TableMutationOperationV2_ACU, TableSqlBindValueV2_ACU } from './storage-frame-v2-types';
import { SqliteEngine } from '../../data/sqlite/sqlite-engine';
import { SyncBridge } from '../../data/sqlite/sync-bridge';
import {
  currentJsonTableData_ACU,
  _set_currentJsonTableData_ACU,
} from '../runtime/state-manager';
import { mergeAllIndependentTables_ACU } from '../runtime/helpers-data-merge';
import { logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU, stripSeedRowsFromTemplate_ACU } from '../../shared/utils';
import {
  createNameMapperOwnerToken_ACU,
  publishGlobalNameMapperEmptySchema_ACU,
  publishGlobalNameMapperForDDLs_ACU,
  releaseGlobalNameMapperForOwner_ACU,
  type NameMapperOwnerToken_ACU,
} from '../runtime/template-vars/name-mapper';
import { parseDDLTableName, generateDDL, generateInserts, resolveEffectiveDDL } from '../../data/sqlite/schema-mapper';
import { normalizeSqlStructure, normalizeStatementValues } from '../../data/sqlite/sql-normalizer';
import { ensureStableRowIdsForSheetContent_ACU, getEffectiveSeedRowsForSheet_ACU, getCurrentChatTemplateScopeState_ACU, sanitizeTemplateSnapshotForChat_ACU, shouldUseInitialSeedRows_ACU } from '../template/chat-scope';
import { getTemplatePreset_ACU } from '../template/template-preset-service';
import { safeJsonParse_ACU } from '../../shared/json-helpers';
import { assertNoPhysicalTableNameCollision_ACU, getPhysicalTableNameForSheet_ACU, PhysicalTableNameCollisionError_ACU, resolvePhysicalTableNames_ACU } from '../../shared/sheet-identity';
import { getSheetColumnProjection_ACU } from '../../shared/ddl-utils';
import { rebindSqlMutationTableReferences_ACU } from '../../shared/sql-mutation-table-rebind';
import { buildSheetTableAliasMap_ACU } from '../../shared/sql-read-resolver';
import { allocateStableRowId_ACU, createStableRowIdReservation_ACU } from '../../shared/stable-row-id-allocator';

export interface SnapshotSqlApplyResult_ACU extends ApplyEditsResult {
  workingData?: TableDataObject_ACU;
  changes?: number;
  operations?: TableMutationOperationV2_ACU[];
}

export interface SqlSheetBatchBuildResult_ACU {
  operations: TableMutationOperationV2_ACU[];
  classifiedSheetKeys: string[];
  unknownStatements: string[];
  ambiguousStatements: string[];
}

export interface SqlSheetBatchBuildOptions_ACU {
  params?: TableSqlBindValueV2_ACU[][];
  fallbackTargetSheetKeys?: string[];
  allowSingleTargetFallback?: boolean;
  keepLegacyForUnclassified?: boolean;
  reason?: 'manual_crud' | 'import' | 'system';
}

export interface SnapshotSqlOperationOptions_ACU {
  targetSheetKeys?: string[];
  requireSheetScopedOperations?: boolean;
  allowSingleTargetFallback?: boolean;
  keepLegacyForUnclassified?: boolean;
}

const DEFAULT_MATE_ACU: Mate_ACU = {
  type: 'acu',
  version: 1,
  updateConfigUiSentinel: 0,
  globalInjectionConfig: {
    readableEntryPlacement: { position: '', depth: 0, order: 0 },
    wrapperPlacement: { position: '', depth: 0, order: 0 },
  },
};

function resolveSnapshotMate_ACU(tableData: TableDataObject_ACU): Mate_ACU {
  const mate = tableData?.mate;
  if (mate && typeof mate === 'object') {
    return mate as Mate_ACU;
  }
  return JSON.parse(JSON.stringify(DEFAULT_MATE_ACU));
}

export function normalizeSqlStatementsForRuntimeLog_ACU(sqlStatements: string): string[] {
  const cleaned = String(sqlStatements || '').replace(/<!--|-->/g, '').trim();
  if (!cleaned) return [];
  return splitSqlStatements(cleaned)
    .map(stmt => normalizeStatementValues(normalizeSqlStructure(stmt)))
    .filter(Boolean);
}

interface SqlMutationIdentifierToken_ACU {
  start: number;
  end: number;
  value: string;
  quote: '"' | '`' | '[' | null;
  depth: number;
  commaBefore: boolean;
}

function isSqlMutationIdentifierStart_ACU(char: string): boolean {
  return /^[A-Za-z_\u0080-\uFFFF]$/.test(char);
}

function isSqlMutationIdentifierPart_ACU(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return isSqlMutationIdentifierStart_ACU(char) || char === '$' || (code >= 48 && code <= 57);
}

/** Tokenizes identifiers while deliberately skipping SQL strings and comments. */
function tokenizeSqlMutationIdentifiers_ACU(statement: string): SqlMutationIdentifierToken_ACU[] {
  const tokens: SqlMutationIdentifierToken_ACU[] = [];
  let index = 0;
  let depth = 0;
  const commaBeforeDepths = new Set<number>();
  while (index < statement.length) {
    const char = statement[index];
    const next = statement[index + 1];
    if (char === '-' && next === '-') {
      index += 2;
      while (index < statement.length && statement[index] !== '\n' && statement[index] !== '\r') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < statement.length && !(statement[index] === '*' && statement[index + 1] === '/')) index += 1;
      if (index >= statement.length) throw new Error('SQL 块注释未闭合，无法安全重绑定表名。');
      index += 2;
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < statement.length) {
        if (statement[index] !== "'") {
          index += 1;
        } else if (statement[index + 1] === "'") {
          index += 2;
        } else {
          index += 1;
          break;
        }
      }
      if (index > statement.length || statement[index - 1] !== "'") throw new Error('SQL 字符串未闭合，无法安全重绑定表名。');
      continue;
    }
    if (char === ',') {
      commaBeforeDepths.add(depth);
      index += 1;
      continue;
    }
    if (char === '(') {
      commaBeforeDepths.delete(depth);
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      const start = index;
      let value = '';
      index += 1;
      let closed = false;
      while (index < statement.length) {
        if (statement[index] !== closing) {
          value += statement[index++];
        } else if (statement[index + 1] === closing) {
          value += closing;
          index += 2;
        } else {
          index += 1;
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error('SQL 引号标识符未闭合，无法安全重绑定表名。');
      tokens.push({ start, end: index, value, quote: char, depth, commaBefore: commaBeforeDepths.delete(depth) });
      continue;
    }
    if (isSqlMutationIdentifierStart_ACU(char)) {
      const start = index;
      index += 1;
      while (index < statement.length && isSqlMutationIdentifierPart_ACU(statement[index])) index += 1;
      tokens.push({ start, end: index, value: statement.slice(start, index), quote: null, depth, commaBefore: commaBeforeDepths.delete(depth) });
      continue;
    }
    index += 1;
  }
  return tokens;
}

function isSqlMutationKeyword_ACU(token: SqlMutationIdentifierToken_ACU | undefined, keyword: string): boolean {
  return !!token && token.quote === null && token.value.toUpperCase() === keyword;
}

function getSqlMutationActionIndex_ACU(tokens: SqlMutationIdentifierToken_ACU[]): number {
  const first = tokens[0];
  if (!first) throw new Error('SQL 语句为空或缺少可验证的写入动作。');
  if (!isSqlMutationKeyword_ACU(first, 'WITH')) return 0;
  const actionIndex = tokens.findIndex((token, index) => index > 0 && token.depth === 0 && (
    isSqlMutationKeyword_ACU(token, 'INSERT')
    || isSqlMutationKeyword_ACU(token, 'REPLACE')
    || isSqlMutationKeyword_ACU(token, 'UPDATE')
    || isSqlMutationKeyword_ACU(token, 'DELETE')
  ));
  if (actionIndex < 0) throw new Error('WITH SQL 缺少可验证的写入语句。');
  return actionIndex;
}

function getQualifiedSqlIdentifierTail_ACU(
  statement: string,
  tokens: SqlMutationIdentifierToken_ACU[],
  startIndex: number,
): SqlMutationIdentifierToken_ACU | undefined {
  let token = tokens[startIndex];
  if (!token) return undefined;
  let index = startIndex;
  while (tokens[index + 1]
    && tokens[index + 1].depth === token.depth
    && /^\s*\.\s*$/.test(statement.slice(token.end, tokens[index + 1].start))) {
    index += 1;
    token = tokens[index];
  }
  return token;
}

function getSqlMutationTargetToken_ACU(statement: string, tokens: SqlMutationIdentifierToken_ACU[]): SqlMutationIdentifierToken_ACU {
  const actionIndex = getSqlMutationActionIndex_ACU(tokens);
  const action = tokens[actionIndex];
  if (isSqlMutationKeyword_ACU(action, 'INSERT') || isSqlMutationKeyword_ACU(action, 'REPLACE')) {
    let index = actionIndex + 1;
    if (isSqlMutationKeyword_ACU(action, 'INSERT') && isSqlMutationKeyword_ACU(tokens[index], 'OR')) {
      const action = tokens[index + 1];
      if (!action || action.quote !== null || !new Set(['ROLLBACK', 'ABORT', 'REPLACE', 'FAIL', 'IGNORE']).has(action.value.toUpperCase())) {
        throw new Error('INSERT OR 子句非法，无法安全重绑定表名。');
      }
      index += 2;
    }
    const target = getQualifiedSqlIdentifierTail_ACU(statement, tokens, index + 1);
    if (!isSqlMutationKeyword_ACU(tokens[index], 'INTO') || !target) {
      throw new Error('INSERT/REPLACE SQL 缺少可验证的目标表。');
    }
    return target;
  }
  if (isSqlMutationKeyword_ACU(action, 'UPDATE')) {
    let index = actionIndex + 1;
    if (isSqlMutationKeyword_ACU(tokens[index], 'OR')) {
      const action = tokens[index + 1];
      if (!action || action.quote !== null || !new Set(['ROLLBACK', 'ABORT', 'REPLACE', 'FAIL', 'IGNORE']).has(action.value.toUpperCase())) {
        throw new Error('UPDATE OR 子句非法，无法安全重绑定表名。');
      }
      index += 2;
    }
    const target = getQualifiedSqlIdentifierTail_ACU(statement, tokens, index);
    if (!target) throw new Error('UPDATE SQL 缺少可验证的目标表。');
    return target;
  }
  if (isSqlMutationKeyword_ACU(action, 'DELETE')) {
    const target = getQualifiedSqlIdentifierTail_ACU(statement, tokens, actionIndex + 2);
    if (!isSqlMutationKeyword_ACU(tokens[actionIndex + 1], 'FROM') || !target) throw new Error('DELETE SQL 缺少可验证的目标表。');
    return target;
  }
  throw new Error(`SQLite 填表仅允许 INSERT、REPLACE、UPDATE、DELETE 数据变更语句，收到：${action?.value || 'empty'}。禁止输出 CREATE、ALTER、DROP、事务或查询语句。`);
}

function collectSqlMutationTableReferenceTokens_ACU(
  statement: string,
  tokens: SqlMutationIdentifierToken_ACU[],
  mutationTarget: SqlMutationIdentifierToken_ACU,
): SqlMutationIdentifierToken_ACU[] {
  const fromClauseTerminators = new Set([
    'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'RETURNING', 'VALUES', 'SET',
  ]);
  const references = new Map<number, SqlMutationIdentifierToken_ACU>([[mutationTarget.start, mutationTarget]]);
  const cteNames = new Set<string>();
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (isSqlMutationKeyword_ACU(tokens[index], 'WITH') && isSqlMutationKeyword_ACU(tokens[index + 2], 'AS')) {
      cteNames.add(tokens[index + 1].value.toLowerCase());
    }
  }
  const activeFromDepths = new Set<number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const keyword = token.quote === null ? token.value.toUpperCase() : '';
    if (fromClauseTerminators.has(keyword)) activeFromDepths.delete(token.depth);
    if (keyword === 'FROM') activeFromDepths.add(token.depth);

    if (keyword === 'FROM' || keyword === 'JOIN') {
      const reference = getQualifiedSqlIdentifierTail_ACU(statement, tokens, index + 1);
      if (reference && reference.depth === token.depth && !cteNames.has(reference.value.toLowerCase())) {
        references.set(reference.start, reference);
      }
      continue;
    }
    if (token.commaBefore && activeFromDepths.has(token.depth) && !cteNames.has(token.value.toLowerCase())) {
      references.set(token.start, token);
    }
  }
  return [...references.values()];
}

function applySqlMutationIdentifierReplacements_ACU(
  statement: string,
  replacements: Array<{ token: SqlMutationIdentifierToken_ACU; physicalName: string }>,
): string {
  let result = statement;
  for (const { token, physicalName } of [...replacements].sort((a, b) => b.token.start - a.token.start)) {
    result = `${result.slice(0, token.start)}${formatSqlMutationIdentifier_ACU(physicalName, token.quote)}${result.slice(token.end)}`;
  }
  return result;
}

function formatSqlMutationIdentifier_ACU(value: string, quote: SqlMutationIdentifierToken_ACU['quote']): string {
  if (quote === '"') return `"${value.replace(/"/g, '""')}"`;
  if (quote === '`') return `\`${value.replace(/`/g, '``')}\``;
  if (quote === '[') return `[${value.replace(/]/g, ']]')}]`;
  return value;
}

/**
 * Rebinds mutation table identifiers from unique DDL/runtime aliases to their
 * authoritative runtime physical names for SQL generation.
 *
 * 别名来源必须与建表来源一致。建表走 _ensureTablesFromTemplate（模板权威），
 * 而 tableData 常是运行时/聊天合并快照：新卡首次填表时快照里还没有该表，
 * 只用快照建别名会漏掉 DDL 旧名，导致 rebind 原样放行并撞上 no such table。
 * 因此额外接收 supplementalData（通常为当前聊天模板）参与别名解析。
 */
export function rebindSqlMutationTableIdentifiers_ACU(
  statements: string[],
  tableData: TableDataObject_ACU,
  supplementalData?: TableDataObject_ACU | Record<string, unknown> | null,
  options: { requireKnownTables?: boolean } = {},
): string[] {
  // 建表权威是模板（_ensureTablesFromTemplate），运行时快照在新卡首次填表时还没有该表。
  // 未显式传入补充源时默认取当前聊天模板，保证别名覆盖与实际建表一致。
  const templateSource = supplementalData === undefined
    ? resolveCurrentChatTemplateForAliases_ACU()
    : supplementalData;
  // 生成路径和 Strict JSON/调度使用同一份显式身份别名契约。SQL token 一旦
  // 被唯一解析，必须立即替换为物理名；不能因 AI 使用显示名或历史名称而
  // 原样交给 SQLite，再在提交阶段误判为未知/跨表。
  const { aliases } = buildSheetTableAliasMap_ACU(
    [templateSource, tableData],
    { includeExtendedAliases: true, skipInvalidSources: true },
  );
  return rebindSqlMutationTableReferences_ACU(statements, aliases, options);
}

/**
 * 解析当前聊天生效模板，仅用于 rebind 别名补充。
 * 解析失败时返回 null：别名补充是增强项，绝不能因此让 rebind 整体失败。
 */
function resolveCurrentChatTemplateForAliases_ACU(): TableDataObject_ACU | null {
  try {
    const scopeState = getCurrentChatTemplateScopeState_ACU();
    let templateStr: string | null = null;
    if (scopeState?.mode === 'chat_override' && scopeState.templateStr) {
      templateStr = scopeState.templateStr;
    } else if (scopeState?.mode === 'preset_link' && scopeState.presetName) {
      templateStr = getTemplatePreset_ACU(scopeState.presetName)?.templateStr || null;
    }
    if (templateStr) {
      const parsed = safeJsonParse_ACU(templateStr, null);
      if (parsed && typeof parsed === 'object') {
        return stripSeedRowsFromTemplate_ACU(JSON.parse(JSON.stringify(parsed))) as TableDataObject_ACU;
      }
    }
    return parseTableTemplateJson_ACU({ stripSeedRows: true }) as TableDataObject_ACU | null;
  } catch (e: any) {
    logWarn_ACU(`[SqlTableService] rebind 别名模板解析失败，仅用运行时快照: ${e?.message || e}`);
    return null;
  }
}

function resolveChatTemplateData_ACU(
  options: { chat?: any[]; isolationKey?: string; stripSeedRows?: boolean } = {},
): TableDataObject_ACU | null {
  const stripSeedRows = options.stripSeedRows !== false;
  const scopeState = getCurrentChatTemplateScopeState_ACU({
    ...(options.chat ? { chat: options.chat } : {}),
    ...(options.isolationKey !== undefined ? { isolationKey: options.isolationKey } : {}),
  });
  let templateStr: string | null = null;
  if (scopeState?.mode === 'chat_override' && scopeState.templateStr) {
    templateStr = scopeState.templateStr;
  } else if (scopeState?.mode === 'preset_link' && scopeState.presetName) {
    templateStr = getTemplatePreset_ACU(scopeState.presetName)?.templateStr || null;
  }
  if (templateStr) {
    const parsed = safeJsonParse_ACU(templateStr, null);
    if (parsed && typeof parsed === 'object') {
      const cloned = JSON.parse(JSON.stringify(parsed));
      return (stripSeedRows ? stripSeedRowsFromTemplate_ACU(cloned) : cloned) as TableDataObject_ACU;
    }
  }
  const globalTemplate = parseTableTemplateJson_ACU({ stripSeedRows });
  return globalTemplate && typeof globalTemplate === 'object'
    ? JSON.parse(JSON.stringify(globalTemplate)) as TableDataObject_ACU
    : null;
}

/** 在 AI 请求前捕获建表与别名解析所需的不可变模板快照。 */
export function captureSqlTableApplyScope_ACU(options: {
  chat: any[];
  isolationKey: string;
}): SqlTableApplyScope_ACU {
  const templateData = resolveChatTemplateData_ACU({ ...options, stripSeedRows: true });
  const templateDataWithRows = resolveChatTemplateData_ACU({ ...options, stripSeedRows: false });
  if (!templateData || !templateDataWithRows) {
    throw new Error(`[SqlTableService] 无法捕获提交模板上下文 (isolationKey=${options.isolationKey || 'default'})。`);
  }
  assertNoPhysicalTableNameCollision_ACU(templateData);
  return {
    isolationKey: options.isolationKey,
    templateData,
    templateDataWithRows,
  };
}

function splitTopLevelSqlList_ACU(value: string, context: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) throw new Error(`${context} 的括号不匹配。`);
    } else if (char === ',' && depth === 0) {
      const item = value.slice(start, index).trim();
      if (!item) throw new Error(`${context} 包含空项。`);
      items.push(item);
      start = index + 1;
    }
  }
  if (quote || depth !== 0) throw new Error(`${context} 的字符串或括号未闭合。`);
  const item = value.slice(start).trim();
  if (!item) throw new Error(`${context} 包含空项。`);
  items.push(item);
  return items;
}

function findSqlClosingParen_ACU(value: string, openingIndex: number, context: string): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = openingIndex; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) break;
    }
  }
  throw new Error(`${context} 的括号未闭合。`);
}

function buildRowIdReservationsByRuntimeTable_ACU(
  tableData: TableDataObject_ACU,
  additionalReservations?: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const reservations = new Map<string, Set<string>>();
  for (const [sheetKey, value] of Object.entries(tableData || {})) {
    if (!sheetKey.startsWith('sheet_')) continue;
    const content = (value as any)?.content;
    reservations.set(getPhysicalTableNameForSheet_ACU(tableData, sheetKey).toLowerCase(), createStableRowIdReservation_ACU(
      Array.isArray(content) ? content.slice(1) : [],
    ));
  }
  for (const [tableName, rowIds] of additionalReservations || []) {
    const reservation = reservations.get(tableName.toLowerCase()) || new Set<string>();
    for (const rowId of rowIds) reservation.add(rowId);
    reservations.set(tableName.toLowerCase(), reservation);
  }
  return reservations;
}

export class SqlRowIdMaterializationError_ACU extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlRowIdMaterializationError_ACU';
  }
}

export class SqlRuntimeSnapshotError_ACU extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlRuntimeSnapshotError_ACU';
  }
}

/**
 * Makes ordinary AI-authored INSERT statements self-describing before execution and V2 logging.
 * SQLite REPLACE forms retain their native semantics and are persisted unchanged.
 */
export function materializeSystemRowIdsForSqlInserts_ACU(
  statements: string[],
  tableData: TableDataObject_ACU,
  additionalReservations?: Map<string, Set<string>>,
): string[] {
  const reservations = buildRowIdReservationsByRuntimeTable_ACU(tableData, additionalReservations);
  return statements.map((statement, statementIndex) => {
    const tokens = tokenizeSqlMutationIdentifiers_ACU(statement);
    const actionIndex = getSqlMutationActionIndex_ACU(tokens);
    const action = tokens[actionIndex];
    if (isSqlMutationKeyword_ACU(action, 'REPLACE')) return statement;
    if (!isSqlMutationKeyword_ACU(action, 'INSERT')) return statement;
    if (isSqlMutationKeyword_ACU(tokens[actionIndex + 1], 'OR') && isSqlMutationKeyword_ACU(tokens[actionIndex + 2], 'REPLACE')) return statement;
    if (actionIndex !== 0 || isSqlMutationKeyword_ACU(tokens[actionIndex + 1], 'OR')) {
      throw new Error(`AI INSERT 第 ${statementIndex + 1} 条不支持 WITH 或 INSERT OR 语法；请使用标准 INSERT INTO ... (列名) VALUES (...).`);
    }
    const target = getSqlMutationTargetToken_ACU(statement, tokens);
    const reservation = reservations.get(target.value.toLowerCase());
    if (!reservation) {
      throw new Error(`AI INSERT 第 ${statementIndex + 1} 条无法识别目标表：${target.value}。`);
    }
    const suffix = statement.slice(target.end).trim();
    if (!suffix.startsWith('(')) {
      if (/^SELECT\b/i.test(suffix)) {
        throw new Error(`AI INSERT 第 ${statementIndex + 1} 条不支持 INSERT SELECT；请改为显式业务列的 VALUES 插入。`);
      }
      throw new Error(`AI INSERT 第 ${statementIndex + 1} 条必须显式列出业务列，系统才能分配 row_id。`);
    }
    const columnsEnd = findSqlClosingParen_ACU(suffix, 0, `AI INSERT 第 ${statementIndex + 1} 条列清单`);
    const inputColumns = splitTopLevelSqlList_ACU(suffix.slice(1, columnsEnd), `AI INSERT 第 ${statementIndex + 1} 条列清单`);
    const normalizedColumns = inputColumns.map(column => column.trim().replace(/^["`\[]|["`\]]$/g, '').toLowerCase());
    if (normalizedColumns.some(column => !/^[a-z_][a-z0-9_$]*$/i.test(column))) {
      throw new Error(`AI INSERT 第 ${statementIndex + 1} 条的列名无法安全解析。`);
    }
    if (new Set(normalizedColumns).size !== normalizedColumns.length) {
      throw new Error(`AI INSERT 第 ${statementIndex + 1} 条的列名重复。`);
    }
    const suppliedRowIdIndex = normalizedColumns.indexOf('row_id');
    const businessColumns = inputColumns.filter((_, index) => index !== suppliedRowIdIndex);
    if (businessColumns.length === 0) {
      throw new Error(`AI INSERT 第 ${statementIndex + 1} 条剔除 row_id 后没有业务列，无法执行插入。`);
    }
    const valuesText = suffix.slice(columnsEnd + 1).trim();
    if (!/^VALUES\b/i.test(valuesText)) {
      throw new Error(`AI INSERT 第 ${statementIndex + 1} 条只支持 VALUES 插入；不支持 INSERT SELECT。`);
    }
    const tupleText = valuesText.slice('VALUES'.length).trim();
    const tuples = splitTopLevelSqlList_ACU(tupleText, `AI INSERT 第 ${statementIndex + 1} 条 VALUES`);
    const materializedTuples = tuples.map((tuple, tupleIndex) => {
      if (!tuple.startsWith('(') || findSqlClosingParen_ACU(tuple, 0, `AI INSERT 第 ${statementIndex + 1} 条第 ${tupleIndex + 1} 个 VALUES`) !== tuple.length - 1) {
        throw new Error(`AI INSERT 第 ${statementIndex + 1} 条只支持括号包裹的 VALUES 行。`);
      }
      const values = splitTopLevelSqlList_ACU(tuple.slice(1, -1), `AI INSERT 第 ${statementIndex + 1} 条第 ${tupleIndex + 1} 个 VALUES`);
      if (values.length !== inputColumns.length) {
        throw new Error(`AI INSERT 第 ${statementIndex + 1} 条第 ${tupleIndex + 1} 行的值数量与列数量不一致。`);
      }
      const businessValues = values.filter((_, index) => index !== suppliedRowIdIndex);
      return `(${allocateStableRowId_ACU(reservation)}, ${businessValues.join(', ')})`;
    });
    return `${statement.slice(0, target.end)} (row_id, ${businessColumns.join(', ')}) VALUES ${materializedTuples.join(', ')}`;
  });
}

/**
 * Rejects AI-authored INSERT/UPDATE assignments that target hidden physical
 * columns. It deliberately reuses the mutation tokenizer so strings and
 * comments cannot masquerade as identifiers.
 */
export function assertNoHiddenPhysicalColumnMutations_ACU(
  statements: string[],
  tableData: Record<string, any>,
): void {
  const physicalNames = resolvePhysicalTableNames_ACU(tableData as TableDataObject_ACU);
  const sheetsByAlias = new Map<string, { sheetKey: string; sheet: any } | null>();
  for (const [sheetKey, physicalName] of physicalNames) {
    const sheet = tableData[sheetKey] as any;
    for (const alias of [parseDDLTableName(sheet?.sourceData?.ddl || ''), physicalName]) {
      const normalized = String(alias || '').trim().toLowerCase();
      if (!normalized) continue;
      const existing = sheetsByAlias.get(normalized);
      if (existing && existing.sheetKey !== sheetKey) sheetsByAlias.set(normalized, null);
      else if (existing !== null) sheetsByAlias.set(normalized, { sheetKey, sheet });
    }
  }

  for (const statement of statements) {
    const tokens = tokenizeSqlMutationIdentifiers_ACU(statement);
    const actionIndex = getSqlMutationActionIndex_ACU(tokens);
    const action = tokens[actionIndex];
    const actionKeyword = action?.quote === null ? action.value.toUpperCase() : '';
    if (!new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE']).has(actionKeyword)) {
      throw new Error(`SQLite 填表仅允许 INSERT、REPLACE、UPDATE、DELETE 数据变更语句，收到：${action?.value || 'empty'}。禁止输出 CREATE、ALTER、DROP、事务或查询语句。`);
    }
    const target = getSqlMutationTargetToken_ACU(statement, tokens);
    const resolved = sheetsByAlias.get(target.value.toLowerCase());
    if (resolved === undefined) continue;
    if (resolved === null) throw new Error(`无法唯一解析隐藏列保护的 SQL 目标表：${target.value}。`);
    const hidden = new Set(getSheetColumnProjection_ACU(resolved.sheet).hiddenPhysicalColumns.map(name => name.toLowerCase()));
    if (hidden.size === 0) continue;

    const hiddenReferences = tokens.filter(token => token !== target && hidden.has(token.value.toLowerCase()));
    if (hiddenReferences.length > 0) {
      throw new Error(`SQL mutation 不允许引用隐藏物理列：${[...new Set(hiddenReferences.map(token => token.value))].join('、')}。`);
    }

    const isInsert = actionKeyword === 'INSERT' || actionKeyword === 'REPLACE';
    if (isInsert) {
      const targetIndex = tokens.indexOf(target);
      const clauseIndex = tokens.findIndex((token, index) => index > targetIndex
        && token.depth === target.depth
        && token.quote === null
        && new Set(['VALUES', 'SELECT', 'DEFAULT']).has(token.value.toUpperCase()));
      const beforeClause = clauseIndex === -1 ? tokens.slice(targetIndex + 1) : tokens.slice(targetIndex + 1, clauseIndex);
      const columnTokens = beforeClause.filter(token => token.depth === target.depth + 1);
      if (columnTokens.length === 0) {
        throw new Error(`存在隐藏物理列时，INSERT/REPLACE 必须显式列出可见目标列：${target.value}。`);
      }
    }
  }
}

export function mapSqlTableNamesToSheetKeys_ACU(tableData: TableDataObject_ACU | null | undefined, tableNames: string[]): string[] {
  if (!tableData || !Array.isArray(tableNames) || tableNames.length === 0) return [];
  const { aliases, conflicts } = buildSheetTableAliasMap_ACU([tableData], { includeExtendedAliases: true });
  const sheetKeyByPhysicalName = new Map(
    [...resolvePhysicalTableNames_ACU(tableData)].map(([sheetKey, physicalName]) => [physicalName.toLowerCase(), sheetKey]),
  );
  const matchedKeys = new Set<string>();
  for (const rawName of tableNames) {
    const normalized = String(rawName || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
    if (!normalized || conflicts.has(normalized)) continue;
    const physicalName = aliases.get(normalized);
    const sheetKey = physicalName ? sheetKeyByPhysicalName.get(physicalName.toLowerCase()) : undefined;
    if (sheetKey) matchedKeys.add(sheetKey);
  }
  return [...matchedKeys];
}

function appendSqlSheetBatchOperation_ACU(
  operations: TableMutationOperationV2_ACU[],
  sheetKey: string,
  statement: string,
  param: TableSqlBindValueV2_ACU[] | undefined,
  reason: 'manual_crud' | 'import' | 'system',
  tableName: string,
): void {
  const last = operations[operations.length - 1] as any;
  if (last?.kind === 'sql_sheet_batch' && last.sheetKey === sheetKey) {
    if (last.tableName !== tableName) throw new Error(`sql_sheet_batch 合并时发现 runtime 表名不一致：${sheetKey}。`);
    last.statements.push(statement);
    if (param !== undefined || Array.isArray(last.params)) {
      if (!Array.isArray(last.params)) last.params = [];
      last.params.push(param || []);
    }
    return;
  }
  operations.push({
    kind: 'sql_sheet_batch',
    sheetKey,
    statements: [statement],
    ...(param !== undefined ? { params: [param] } : {}),
    tableName,
    reason,
  });
}

function appendLegacySqlBatchOperation_ACU(
  operations: TableMutationOperationV2_ACU[],
  statement: string,
  param: TableSqlBindValueV2_ACU[] | undefined,
): void {
  const last = operations[operations.length - 1] as any;
  if (last?.kind === 'sql_batch') {
    last.statements.push(statement);
    if (param !== undefined || Array.isArray(last.params)) {
      if (!Array.isArray(last.params)) last.params = [];
      last.params.push(param || []);
    }
    return;
  }
  operations.push({
    kind: 'sql_batch',
    statements: [statement],
    ...(param !== undefined ? { params: [param] } : {}),
  });
}

export function buildSqlSheetBatchOperations_ACU(
  statements: string[],
  tableData: TableDataObject_ACU,
  options: SqlSheetBatchBuildOptions_ACU = {},
): SqlSheetBatchBuildResult_ACU {
  const operations: TableMutationOperationV2_ACU[] = [];
  const classifiedSheetKeys = new Set<string>();
  const unknownStatements: string[] = [];
  const ambiguousStatements: string[] = [];
  const fallbackTargetSheetKeys = Array.isArray(options.fallbackTargetSheetKeys)
    ? options.fallbackTargetSheetKeys.filter(key => typeof key === 'string' && key.startsWith('sheet_'))
    : [];
  const allowFallback = options.allowSingleTargetFallback === true && fallbackTargetSheetKeys.length === 1;
  const keepLegacy = options.keepLegacyForUnclassified === true;
  const reason = options.reason || 'system';

  (Array.isArray(statements) ? statements : []).forEach((statement, index) => {
    if (typeof statement !== 'string' || !statement.trim()) return;
    const param = Array.isArray(options.params) ? options.params[index] : undefined;
    const tableNames = extractTableNamesFromStatements([statement]);
    const sheetKeys = mapSqlTableNamesToSheetKeys_ACU(tableData, tableNames);
    if (sheetKeys.length === 1) {
      const sheetKey = sheetKeys[0];
      classifiedSheetKeys.add(sheetKey);
      appendSqlSheetBatchOperation_ACU(operations, sheetKey, statement, param, reason, getPhysicalTableNameForSheet_ACU(tableData, sheetKey));
      return;
    }
    if (sheetKeys.length === 0 && tableNames.length === 0 && allowFallback) {
      const sheetKey = fallbackTargetSheetKeys[0];
      classifiedSheetKeys.add(sheetKey);
      unknownStatements.push(statement);
      appendSqlSheetBatchOperation_ACU(operations, sheetKey, statement, param, reason, getPhysicalTableNameForSheet_ACU(tableData, sheetKey));
      return;
    }
    if (sheetKeys.length > 1) {
      ambiguousStatements.push(statement);
    } else {
      unknownStatements.push(statement);
    }
    if (keepLegacy) appendLegacySqlBatchOperation_ACU(operations, statement, param);
  });

  return {
    operations,
    classifiedSheetKeys: [...classifiedSheetKeys],
    unknownStatements,
    ambiguousStatements,
  };
}

export class SqlTableService implements ITableStorageProvider {
  readonly mode = 'sqlite' as const;
  private engine: SqliteEngine;
  private syncBridge: SyncBridge;
  private _initialized = false;
  private _existingTableSet?: Set<string>;
  /**
   * 本实例的全局 NameMapper 发布凭证。
   *
   * 切聊/重载会出现「新实例已发布映射 → 旧实例才 dispose」的置换顺序，
   * 因此清理必须按所有权判定，否则旧实例会把新 runtime 的映射清成 unbound。
   */
  private readonly nameMapperOwner_ACU: NameMapperOwnerToken_ACU;

  constructor() {
    this.engine = new SqliteEngine();
    this.syncBridge = new SyncBridge(this.engine);
    this.nameMapperOwner_ACU = createNameMapperOwnerToken_ACU('sql-table-service');
  }

  isReady(): boolean {
    return this._initialized && this.engine.isReady;
  }

  /**
   * 以本实例身份按给定 canonical 快照刷新映射。
   * 外部 CRUD 与回滚路径不持有发布凭证，必须经活跃 provider 刷新，
   * 否则会出现「owner 是本实例、内容却由无所有权入口改写」的脱节。
   */
  refreshNameMapperForData_ACU(data: TableDataObject_ACU): boolean {
    return this._buildNameMapper(data);
  }

  createRuntimeSnapshot(): Uint8Array | null {
    if (!this._initialized || !this.engine.isReady) return null;
    return this.engine.exportBinary();
  }

  async restoreRuntimeSnapshot(snapshot: unknown): Promise<void> {
    if (!(snapshot instanceof Uint8Array)) throw new Error('SQLite 运行时快照无效，无法恢复。');
    // 失败时要撤回本实例写入的共享 canonical 视图，避免半成功状态污染其他读者。
    const previousJsonView = currentJsonTableData_ACU as TableDataObject_ACU | null;
    releaseGlobalNameMapperForOwner_ACU(this.nameMapperOwner_ACU);
    await this.engine.loadFromBinary(snapshot);
    this._existingTableSet = undefined;
    // 映射必须基于「刚从恢复后 engine 成功导出」的视图构建。
    // 导出失败时残留的旧 JSON 与新 engine 不同源，绝不能拿它发布映射。
    // ownView 只能取自本次真实写入的返回值：读取全局值会把其他实例在
    // loadFromBinary 等待期间发布的视图误认成本实例的写入。
    const restoredView = this._syncToJson();
    if (!restoredView) {
      this._initialized = false;
      throw new Error('sqlite_snapshot_restore_failed: 快照恢复后无法导出 canonical 视图。');
    }
    if (!this._buildNameMapper(restoredView)) {
      this._initialized = false;
      this._revertOwnJsonView_ACU(restoredView, previousJsonView);
      throw new Error('name_mapper_publish_rejected: 快照恢复后未能发布中英文名映射。');
    }
    this._initialized = true;
  }

  /**
   * 从聊天消息加载表格数据到 SQLite
   * 仅保留兼容入口：回放后委托 loadFromData() 初始化 runtime，
   * 防止聊天回放和 SQLite hydrate 拥有两套不同逻辑。
   */
  async loadFromChat(): Promise<{
    loaded: boolean;
    source: 'merged' | 'initialized' | 'empty';
    error?: string;
  }> {
    try {
      const mergedData = await mergeAllIndependentTables_ACU();
      return await this.loadFromData(mergedData as TableDataObject_ACU | null);
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      logError_ACU(`[SqlTableService] 回放聊天数据失败: ${errMsg}`);
      return { loaded: false, source: 'empty', error: `replay_failed: ${errMsg}` };
    }
  }

  /**
   * 从调用方刚刚恢复的当前聊天 JSON 快照初始化 SQLite runtime。
   * 调用方必须保证 data 与当前聊天/isolationKey 属于同一次回放；本方法绝不自行回放聊天，
   * 从而避免 legacy→V2 迁移与 SQLite 初始化重复产生副作用。
   */
  async loadFromData(data: TableDataObject_ACU | null): Promise<{
    loaded: boolean;
    source: 'merged' | 'initialized' | 'empty';
    error?: string;
  }> {
    const mergedData = data ? JSON.parse(JSON.stringify(data)) as TableDataObject_ACU : null;
    this._resetRuntimeForLoad_ACU();

    // 启动自检（fail-loud）：拼音物理名冲突必须在建表前拦截，给出可读的改名指引，
    // 而不是等到 hydrate 时被 generic catch 吞成 sqlite_hydrate_failed。
    if (mergedData) {
      try {
        assertNoPhysicalTableNameCollision_ACU(mergedData);
      } catch (e: any) {
        if (e instanceof PhysicalTableNameCollisionError_ACU) {
          this._resetRuntimeForLoad_ACU();
          logError_ACU(`[SqlTableService] ${e.message}`);
          return { loaded: false, source: 'empty', error: `physical_table_name_collision: ${e.message}` };
        }
        throw e;
      }
    }

    try {
      await this.engine.init();
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      this._resetRuntimeForLoad_ACU();
      logError_ACU(`[SqlTableService] SQLite 引擎初始化失败: ${errMsg}`);
      return { loaded: false, source: 'empty', error: `sqlite_engine_init_failed: ${errMsg}` };
    }

    try {
      // 判断 mergedData 是否包含真正的用户/AI 写入的数据行，还是仅有模板空壳。
      const hasRealDataRows = mergedData && Object.keys(mergedData)
        .filter(k => k.startsWith('sheet_'))
        .some(k => {
          const sheet = (mergedData as any)[k];
          if (!sheet?.content || !Array.isArray(sheet.content) || sheet.content.length <= 1) return false;
          if (sheet._acu_from_base_state) return false;
          return true;
        });

      if (!mergedData || !hasRealDataRows) {
        const runtimeSeedSource = mergedData;
        const runtimeSeedData = this._buildInitialRuntimeTableData_ACU(runtimeSeedSource);
        if (runtimeSeedData) {
          this.syncBridge.loadFromTableData(runtimeSeedData, { strict: true, allowRuntimeDdlFallback: true });
          this._validateRuntimeSchema_ACU(runtimeSeedData);
          _set_currentJsonTableData_ACU(runtimeSeedData);
          if (!this._buildNameMapper(runtimeSeedData)) {
            throw new Error('name_mapper_publish_rejected: 未能发布当前 runtime 的中英文名映射。');
          }
          this._initialized = true;
          this._existingTableSet = undefined;
          const hasSeedRows = Object.keys(runtimeSeedData)
            .filter(k => k.startsWith('sheet_'))
            .some(k => Array.isArray((runtimeSeedData as any)[k]?.content) && (runtimeSeedData as any)[k].content.length > 1);
          logDebug_ACU(`[SqlTableService] 初始 seedRows 已写入运行时 SQLite: hasSeedRows=${hasSeedRows}`);
          return { loaded: hasSeedRows, source: hasSeedRows ? 'initialized' : 'empty' };
        }

        logDebug_ACU('[SqlTableService] 没有找到表格数据，引擎已就绪，等待第一次填表时从模板建表');
        // runtime 没有任何表可映射。显式标记空 schema，避免同步读门禁把它
        // 误判成「mapper 意外丢失」并按异常反复告警。
        if (!publishGlobalNameMapperEmptySchema_ACU(this.nameMapperOwner_ACU)) {
          throw new Error('name_mapper_publish_rejected: 未能发布空 schema 标记。');
        }
        this._initialized = true;
        this._existingTableSet = undefined;
        return { loaded: false, source: 'empty' };
      }

      this.syncBridge.loadFromTableData(mergedData as TableDataObject_ACU, { strict: true, allowRuntimeDdlFallback: true });
      this._validateRuntimeSchema_ACU(mergedData as TableDataObject_ACU);
      _set_currentJsonTableData_ACU(mergedData as TableDataObject_ACU);
      if (!this._buildNameMapper(mergedData as TableDataObject_ACU)) {
        throw new Error('name_mapper_publish_rejected: 未能发布当前 runtime 的中英文名映射。');
      }
      this._initialized = true;
      this._existingTableSet = undefined;
      logDebug_ACU('[SqlTableService] SQLite 数据库加载完成');
      return { loaded: true, source: 'merged' };
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      this._resetRuntimeForLoad_ACU();
      logError_ACU(`[SqlTableService] SQLite 快照加载失败: ${errMsg}`);
      return { loaded: false, source: 'empty', error: `sqlite_hydrate_failed: ${errMsg}` };
    }
  }

  /**
   * 禁止 provider 自行把运行时数据写入聊天记录。
   * 所有写入必须通过 table-update-commit 公共提交模型完成。
   */
  async saveToChat(
    _targetSheetKeys?: string[] | null,
    _updateGroupKeys?: string[] | null,
    _trackingSheetKeys?: string[] | null,
    _options?: { source?: string; requestId?: string; batchId?: string; operations?: unknown[]; transactionContext?: unknown },
  ): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
    const message = 'SqlTableService.saveToChat is disabled; use table update commit model.';
    logError_ACU(`[SqlTableService] ${message}`);
    return { saved: false, error: message };
  }

  async replaceAllData(data: TableDataObject_ACU): Promise<ApplyEditsResult> {
    // 替换失败不得把本实例数据永久留在共享 canonical 视图里。
    const previousJsonView = currentJsonTableData_ACU as TableDataObject_ACU | null;
    let ownJsonView: TableDataObject_ACU | null = null;
    try {
      const cloned = JSON.parse(JSON.stringify(data || {})) as TableDataObject_ACU;
      releaseGlobalNameMapperForOwner_ACU(this.nameMapperOwner_ACU);
      this.engine.dispose();
      this.engine = new SqliteEngine();
      this.syncBridge = new SyncBridge(this.engine);
      await this.engine.init();
      this.syncBridge.loadFromTableData(cloned, { strict: true });
      _set_currentJsonTableData_ACU(cloned);
      ownJsonView = cloned;
      if (!this._buildNameMapper(cloned)) {
        throw new Error('name_mapper_publish_rejected: 未能发布替换后 runtime 的中英文名映射。');
      }
      this._initialized = true;
      this._existingTableSet = undefined;
      const modifiedKeys = Object.keys(cloned).filter(key => key.startsWith('sheet_'));
      logDebug_ACU(`[SqlTableService] 运行时全量替换完成: tables=${modifiedKeys.length}`);
      return { success: true, modifiedKeys, appliedEdits: modifiedKeys.length };
    } catch (e: any) {
      const message = e?.message || String(e);
      // 替换失败后本实例没有可信 runtime；不得保留旧的 initialized 标志冒充可用。
      this._initialized = false;
      this._existingTableSet = undefined;
      this._revertOwnJsonView_ACU(ownJsonView, previousJsonView);
      releaseGlobalNameMapperForOwner_ACU(this.nameMapperOwner_ACU);
      logError_ACU(`[SqlTableService] 运行时全量替换失败: ${message}`);
      return { success: false, modifiedKeys: [], appliedEdits: 0, error: message };
    }
  }

  clearRuntimeData(): void {
    this.engine.dispose();
    this.engine = new SqliteEngine();
    this.syncBridge = new SyncBridge(this.engine);
    this._initialized = false;
    this._existingTableSet = undefined;
    _set_currentJsonTableData_ACU(null);
    releaseGlobalNameMapperForOwner_ACU(this.nameMapperOwner_ACU);
  }

  /**
   * 获取当前运行时的完整表格数据
   * 从 SQLite 导出最新状态，同步更新 JSON 视图后返回
   */
  getCurrentData(): TableDataObject_ACU | null {
    if (!this._initialized || !this.engine.isReady) {
      return currentJsonTableData_ACU;
    }

    try {
      const mate = (currentJsonTableData_ACU?.mate as Mate_ACU) || { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } };
      const exportedData = this.syncBridge.exportToTableData(mate);
      _set_currentJsonTableData_ACU(exportedData);
      return exportedData;
    } catch (e: any) {
      logError_ACU(`[SqlTableService] getCurrentData 失败: ${e?.message}`);
      return currentJsonTableData_ACU;
    }
  }

  /**
   * 应用 AI 返回的 SQL 编辑指令
   * 1. 拆分多条 SQL 语句
   * 2. 事务包裹执行（runBatch）
   * 3. 同步到 JSON 视图
   * 4. 返回结果
   *
   * 失败时抛出包含详细报错的 Error，供上层重试循环捕获
   */
  applyEdits(sqlStatements: string, _updateMode?: string): ApplyEditsResult {
    return this.applyEditsBatch([sqlStatements], _updateMode);
  }

  applyEditsBatch(sqlTexts: string[], _updateMode?: string, paramsList?: (string | number | null)[][]): ApplyEditsResult {
    this._ensureInitialized();
    this._ensureTablesFromTemplate();

    const userStatements: string[] = [];
    const userParams: ((string | number | null)[] | undefined)[] = [];
    (Array.isArray(sqlTexts) ? sqlTexts : []).forEach((sqlText, index) => {
      const normalizedStatements = normalizeSqlStatementsForRuntimeLog_ACU(sqlText);
      const runtimeStatements = rebindSqlMutationTableIdentifiers_ACU(
        normalizedStatements,
        (currentJsonTableData_ACU || { mate: DEFAULT_MATE_ACU }) as TableDataObject_ACU,
      );
      runtimeStatements.forEach(statement => {
        userStatements.push(statement);
        userParams.push(runtimeStatements.length === 1 ? paramsList?.[index] : undefined);
      });
    });
    if (userStatements.length === 0) {
      return { success: true, modifiedKeys: [], appliedEdits: 0 };
    }

    const reseedInserts = this._collectReseedInsertsForEmptyTables();
    const statements = [...reseedInserts, ...userStatements];
    const statementParams = [
      ...reseedInserts.map((): undefined => undefined),
      ...userParams,
    ];

    try {
      const result = this.engine.runBatch(statements, statementParams);
      this._syncToJson();

      const modifiedTables = extractTableNamesFromStatements(statements);
      const modifiedKeys = this._tableNamesToSheetKeys(modifiedTables);

      logDebug_ACU(`[SqlTableService] SQL 批量执行成功: ${statements.length} 条语句, ${result.totalChanges} 行受影响`);

      return {
        success: true,
        modifiedKeys,
        appliedEdits: userStatements.length,
      };
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      logError_ACU(`[SqlTableService] SQL 批量执行失败: ${errMsg}`);
      throw e;
    }
  }

  applyEditsWithSystemRowIds(
    sqlTexts: string[],
    _updateMode?: string,
    scope?: SqlTableApplyScope_ACU,
  ): ApplyEditsWithRowIdMaterializationResult_ACU {
    this._ensureInitialized();
    this._ensureTablesFromTemplate(scope);

    const normalizedGroups = (Array.isArray(sqlTexts) ? sqlTexts : []).map(sqlText => {
      const normalizedStatements = normalizeSqlStatementsForRuntimeLog_ACU(sqlText);
      return rebindSqlMutationTableIdentifiers_ACU(
        normalizedStatements,
        (currentJsonTableData_ACU || { mate: DEFAULT_MATE_ACU }) as TableDataObject_ACU,
        scope?.templateData,
        { requireKnownTables: Boolean(scope?.templateData) },
      );
    });
    const userStatements = normalizedGroups.flat();
    if (userStatements.length === 0) {
      return {
        success: true,
        modifiedKeys: [],
        appliedEdits: 0,
        materializedSqlTexts: normalizedGroups.map(() => ''),
        tableData: this._exportCurrentDataStrict(),
      };
    }

    const reseedPlan = this._collectReseedPlanForEmptyTables(scope);
    const runtimeData = this._exportCurrentDataStrict();
    let materializedStatements: string[];
    try {
      materializedStatements = materializeSystemRowIdsForSqlInserts_ACU(
        userStatements,
        runtimeData,
        reseedPlan.rowIdsByTable,
      );
    } catch (error: any) {
      throw new SqlRowIdMaterializationError_ACU(error?.message || String(error));
    }

    const materializedSqlTexts: string[] = [];
    let cursor = 0;
    for (const group of normalizedGroups) {
      materializedSqlTexts.push(materializedStatements.slice(cursor, cursor + group.length).join(';\n'));
      cursor += group.length;
    }

    const statements = [...reseedPlan.inserts, ...materializedStatements];
    try {
      const result = this.engine.runBatchWithFinalize(
        statements,
        statements.map((): undefined => undefined),
        () => this._exportCurrentDataStrict(),
      );
      const tableData = result.finalizeResult!;
      _set_currentJsonTableData_ACU(tableData);
      const modifiedTables = extractTableNamesFromStatements(statements);
      const modifiedKeys = this._tableNamesToSheetKeys(modifiedTables);
      logDebug_ACU(`[SqlTableService] 系统 row_id 批量执行成功: ${statements.length} 条语句, ${result.totalChanges} 行受影响`);
      return {
        success: true,
        modifiedKeys,
        appliedEdits: materializedStatements.length,
        materializedSqlTexts,
        tableData,
      };
    } catch (e: any) {
      logError_ACU(`[SqlTableService] 系统 row_id 批量执行失败: ${e?.message || String(e)}`);
      throw e;
    }
  }

  /**
   * 执行 SQL 查询（SELECT）
   *
   * 注意：不触发 _ensureTablesFromTemplate()。
   * 新开卡场景下表尚未创建，查询会抛出 "no such table" 错误——这是预期行为。
   * 建表只在写操作（applyEdits/executeMutation）时触发，确保用户有机会在首次填表前修改表结构。
   */
  executeQuery(
    sql: string,
    params?: (string | number | null)[],
    options?: SqlQueryExecutionOptions_ACU,
  ): SqlQueryResult {
    this._ensureInitialized();
    const result = this.engine.query(sql, params, options);
    return {
      columns: result.columns,
      values: result.values,
      rowCount: result.values.length,
    };
  }

  /**
   * 执行 SQL 变更语句（INSERT/UPDATE/DELETE）
   * 执行后自动同步到 JSON 视图
   */
  executeMutation(sql: string, params?: (string | number | null)[]): SqlMutationResult {
    this._ensureInitialized();
    this._ensureTablesFromTemplate();
    try {
      // 收集空表 seedRows INSERT 并执行（与用户 SQL 不在同一事务，计划已记录风险）
      const reseedInserts = this._collectReseedInsertsForEmptyTables();
      if (reseedInserts.length > 0) {
        this.engine.runBatch(reseedInserts);
        logDebug_ACU(`[SqlTableService] executeMutation 前置补回 ${reseedInserts.length} 条 seedRows`);
      }

      // 对 SQL 做规范化：结构字符兼容化 + 受约束字段值规范化
      const normalizedSql = normalizeStatementValues(normalizeSqlStructure(sql));
      const runtimeSql = rebindSqlMutationTableIdentifiers_ACU(
        [normalizedSql],
        (currentJsonTableData_ACU || { mate: DEFAULT_MATE_ACU }) as TableDataObject_ACU,
      )[0];
      const result = this.engine.run(runtimeSql, params);
      this._syncToJson();
      return { changes: result.changes, errors: [] };
    } catch (e: any) {
      // reseed 可能已成功落库，同步 JSON 视图避免 SQLite/JSON 状态分裂
      this._syncToJson();
      return { changes: 0, errors: [e?.message || String(e)] };
    }
  }

  /**
   * 销毁数据库实例，释放内存
   */
  dispose(): void {
    this.engine.dispose();
    // 本实例可能已被更新的 runtime 置换。只释放自己发布的映射，
    // 否则会把新 runtime 刚发布的 schema 映射清成 unbound。
    releaseGlobalNameMapperForOwner_ACU(this.nameMapperOwner_ACU);
    this._initialized = false;
    this._existingTableSet = undefined;
    logDebug_ACU('[SqlTableService] SQLite 引擎已销毁');
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 撤回本实例写入共享 canonical 视图的内容。
   *
   * 只有当共享视图仍是本实例写入的那一份时才回退：等待期间其他实例可能已经
   * 合法发布了新视图，无条件写回旧值会把它们的更新覆盖掉。
   */
  private _revertOwnJsonView_ACU(
    ownView: TableDataObject_ACU | null,
    previousView: TableDataObject_ACU | null,
  ): void {
    if (!ownView || currentJsonTableData_ACU !== ownView) return;
    _set_currentJsonTableData_ACU(previousView);
  }


  /** 重置本实例的 SQLite runtime；不触碰调用方持有的 canonical JSON 快照。 */
  private _resetRuntimeForLoad_ACU(): void {
    // 新 runtime 在成功 hydrate 前没有可证明匹配的 schema；保留旧 mapper
    // 会让并发/重载后的外部 CRUD 把展示列解析到上一份 SQLite schema。
    // 只撤销本实例发布的映射：其他实例的映射由其自身生命周期负责。
    releaseGlobalNameMapperForOwner_ACU(this.nameMapperOwner_ACU);
    this.engine.dispose();
    this.engine = new SqliteEngine();
    this.syncBridge = new SyncBridge(this.engine);
    this._initialized = false;
    this._existingTableSet = undefined;
  }

  private _buildInitialRuntimeTableData_ACU(sourceData: TableDataObject_ACU | null): TableDataObject_ACU | null {
    const shouldIncludeSeedRows = shouldUseInitialSeedRows_ACU();
    const templateData = this._resolveCurrentChatTemplate(!shouldIncludeSeedRows);
    const baseData = sourceData
      ? JSON.parse(JSON.stringify(sourceData)) as TableDataObject_ACU
      : templateData;
    if (!baseData || typeof baseData !== 'object') return null;

    if (templateData && typeof templateData === 'object') {
      for (const key of Object.keys(templateData).filter(k => k.startsWith('sheet_'))) {
        const templateSheet = (templateData as any)[key];
        if (!templateSheet || typeof templateSheet !== 'object') continue;
        const targetSheet = (baseData as any)[key];
        if (!targetSheet || typeof targetSheet !== 'object') continue;
        if (templateSheet.uid) targetSheet.uid = templateSheet.uid;
        if (templateSheet.name) targetSheet.name = templateSheet.name;
        if (templateSheet.sourceData && typeof templateSheet.sourceData === 'object') targetSheet.sourceData = JSON.parse(JSON.stringify(templateSheet.sourceData));
        if (templateSheet.updateConfig && typeof templateSheet.updateConfig === 'object') targetSheet.updateConfig = JSON.parse(JSON.stringify(templateSheet.updateConfig));
        if (templateSheet.exportConfig && typeof templateSheet.exportConfig === 'object') targetSheet.exportConfig = JSON.parse(JSON.stringify(templateSheet.exportConfig));
        if (templateSheet.orderNo !== undefined) targetSheet.orderNo = templateSheet.orderNo;
        if (Array.isArray(templateSheet.content?.[0])) {
          if (!Array.isArray(targetSheet.content)) targetSheet.content = [];
          targetSheet.content[0] = JSON.parse(JSON.stringify(templateSheet.content[0]));
        }
      }
    }

    let hasSheet = false;
    for (const key of Object.keys(baseData).filter(k => k.startsWith('sheet_'))) {
      const sheet = (baseData as any)[key];
      if (!sheet || typeof sheet !== 'object') continue;
      hasSheet = true;
      delete sheet._acu_from_base_state;

      const headerRow = Array.isArray(sheet.content?.[0]) ? sheet.content[0] : ['row_id'];
      if (!Array.isArray(sheet.content) || sheet.content.length <= 1) {
        const seedRows = getEffectiveSeedRowsForSheet_ACU(key, { allowTemplateFallback: true });
        sheet.content = [headerRow, ...(Array.isArray(seedRows) ? seedRows : [])];
      }
      sheet.content = ensureStableRowIdsForSheetContent_ACU(sheet.content);
    }

    return hasSheet ? baseData : null;
  }

  /**
   * 收集已存在空表的 seedRows INSERT 语句，用于 SQL 写入前补齐基底数据。
   *
   * 触发条件（全部满足才处理）：
   * 1. 表在 SQLite 中已存在（由 _ensureTablesFromTemplate 保证）
   * 2. SELECT COUNT(*) 返回 0（空表）
   * 3. getEffectiveSeedRowsForSheet_ACU 返回非空
   * 4. 表属于当前聊天模板/guide（有 DDL 且可解析表名）
   *
   * 幂等：非空表跳过；无 seedRows 跳过；DDL 缺失跳过。
   *
   * @returns 需要前置执行的 INSERT 语句数组（可能为空）
   */
  private _collectReseedInsertsForEmptyTables(): string[] {
    return this._collectReseedPlanForEmptyTables().inserts;
  }

  private _exportCurrentDataStrict(): TableDataObject_ACU {
    try {
      const mate = (currentJsonTableData_ACU?.mate as Mate_ACU) || DEFAULT_MATE_ACU;
      return this.syncBridge.exportToTableData(mate, { strict: true });
    } catch (error: any) {
      throw new SqlRuntimeSnapshotError_ACU(error?.message || String(error));
    }
  }

  private _collectReseedPlanForEmptyTables(scope?: SqlTableApplyScope_ACU): {
    inserts: string[];
    rowIdsByTable: Map<string, Set<string>>;
  } {
    const inserts: string[] = [];
    const rowIdsByTable = new Map<string, Set<string>>();
    if (!currentJsonTableData_ACU) return { inserts, rowIdsByTable };
    const identitySource = scope?.templateData || currentJsonTableData_ACU;
    const seedSource = scope?.templateDataWithRows;

    const sheetKeys = Object.keys(currentJsonTableData_ACU).filter(k => k.startsWith('sheet_'));
    if (sheetKeys.length === 0) return { inserts, rowIdsByTable };

    for (const sheetKey of sheetKeys) {
      try {
        const sheet = (currentJsonTableData_ACU as any)[sheetKey];
        if (!sheet?.sourceData?.ddl) continue;

        const tableName = getPhysicalTableNameForSheet_ACU((identitySource as any)?.[sheetKey] ? identitySource : currentJsonTableData_ACU, sheetKey);

        const existingTables = this._existingTableSet ??= new Set(this.engine.getTableNames());
        // 检查表是否存在且为空
        if (!existingTables.has(tableName)) continue;

        const countResult = this.engine.query(`SELECT COUNT(*) AS cnt FROM "${tableName.replace(/"/g, '""')}";`);
        const cnt = countResult?.values?.[0]?.[0];
        if (cnt !== 0) continue; // 非空表，跳过

        // AI 提交链显式携带请求前模板时，补种也必须来自同一快照，不能在 await 后重新读取当前模板。
        const capturedRows = (seedSource as any)?.[sheetKey]?.content;
        const seedRows = Array.isArray(capturedRows) && capturedRows.length > 1
          ? capturedRows.slice(1)
          : getEffectiveSeedRowsForSheet_ACU(sheetKey, { allowTemplateFallback: true });
        if (!Array.isArray(seedRows) || seedRows.length === 0) continue;

        // 构造临时 Sheet 对象用于 generateInserts
        const headerRow = Array.isArray(sheet.content?.[0])
          ? JSON.parse(JSON.stringify(sheet.content[0]))
          : ['row_id'];
        const content = [headerRow, ...seedRows.map((r: any) => Array.isArray(r) ? [...r] : [r])];
        const stableContent = ensureStableRowIdsForSheetContent_ACU(content);

        const tempSheet = {
          uid: sheet.uid || sheetKey,
          name: sheet.name || sheetKey,
          sourceData: sheet.sourceData,
          content: stableContent,
          updateConfig: sheet.updateConfig || {},
          exportConfig: sheet.exportConfig || {},
          orderNo: sheet.orderNo ?? 0,
        };

        const sheetInserts = generateInserts(tempSheet as any, tableName);
        if (sheetInserts.length > 0) {
          rowIdsByTable.set(
            tableName.toLowerCase(),
            createStableRowIdReservation_ACU(stableContent.slice(1)),
          );
          inserts.push(...sheetInserts);
          logDebug_ACU(`[SqlTableService] 空表 ${sheetKey} (${tableName}) 补回 ${sheetInserts.length} 行 seedRows`);
        }
      } catch (e: any) {
        // 单表失败不阻塞其他表，但记录日志
        logWarn_ACU(`[SqlTableService] 收集表 ${sheetKey} 的 seedRows INSERT 失败: ${e?.message}`);
      }
    }

    if (inserts.length > 0) {
      logDebug_ACU(`[SqlTableService] 共收集 ${inserts.length} 条 seedRows reseed INSERT 语句`);
    }
    return { inserts, rowIdsByTable };
  }

  /**
   * hydrate 成功不等于 runtime 可用：必须确认当前数据对应的物理表和有效列都已真正落入 SQLite。
   * 这里不修复、不建表；缺表/缺列说明 hydrate 或模板契约已损坏，应在发布 ready 前 fail-closed。
   */
  private _validateRuntimeSchema_ACU(data: TableDataObject_ACU): void {
    const actualTables = new Set(this.engine.getTableNames());
    for (const key of Object.keys(data).filter(key => key.startsWith('sheet_'))) {
      const sheet = (data as any)[key];
      if (!sheet || typeof sheet !== 'object') continue;
      const runtimeTableName = getPhysicalTableNameForSheet_ACU(data, key);
      if (!actualTables.has(runtimeTableName)) {
        throw new Error(`schema_missing_table: ${key} (${runtimeTableName}) 未在 SQLite runtime 中创建。`);
      }
      const effectiveDDL = resolveEffectiveDDL(sheet, sheet.uid || key, runtimeTableName);
      const actualColumns = new Set(this.engine.getTableInfo(runtimeTableName).map(column => column.name));
      for (const mapping of effectiveDDL.columnMap.mappings) {
        if (!actualColumns.has(mapping.sqlName)) {
          throw new Error(`schema_missing_column: ${key} (${runtimeTableName}).${mapping.sqlName} 未在 SQLite runtime 中创建。`);
        }
      }
    }
  }

  /**
   * 从 TableDataObject 中提取所有 DDL，以本实例身份发布全局 NameMapper。
   *
   * @returns 是否已发布可信映射。false 表示本实例不得对外宣称 ready：
   * 没有可信映射时中文表名/列名会被原样下发给 SQLite。
   */
  private _buildNameMapper(data: TableDataObject_ACU): boolean {
    try {
      const ddlMap = new Map<string, string>();
      for (const [key, value] of Object.entries(data)) {
        if (!key.startsWith('sheet_')) continue;
        const sheet = value as any;
        if (!sheet || typeof sheet !== 'object') continue;
        // NameMapper 必须和 SQLite 实际采用的 schema 一致。直接读取 sourceData.ddl
        // 会在 fallback_invalid 场景留下无法映射运行时物理列名的陈旧映射。
        const runtimeTableName = getPhysicalTableNameForSheet_ACU(data, key);
        const effectiveDDL = resolveEffectiveDDL(sheet, sheet.uid || key, runtimeTableName).effectiveDDL;
        ddlMap.set(runtimeTableName, effectiveDDL);
      }
      return publishGlobalNameMapperForDDLs_ACU(ddlMap, this.nameMapperOwner_ACU);
    } catch (e: any) {
      logWarn_ACU(`[SqlTableService] 构建 NameMapper 失败: ${e?.message}`);
      return false;
    }
  }

  /**
   * 同步 SQLite → JSON 视图。
   *
   * @returns 本次实际写入共享视图的对象；导出失败时返回 null。
   * 多数调用点把它当尽力而为的视图刷新，但快照恢复必须据此判断能否发布映射，
   * 并据此确认「共享视图是否由本次调用写入」。不能改为读取全局值反推所有权：
   * 等待期间其他实例可能已经发布了自己的视图。
   */
  private _syncToJson(): TableDataObject_ACU | null {
    try {
      const mate = (currentJsonTableData_ACU?.mate as Mate_ACU) || { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } };
      const exportedData = this.syncBridge.exportToTableData(mate);
      _set_currentJsonTableData_ACU(exportedData);
      return exportedData;
    } catch (e: any) {
      logError_ACU(`[SqlTableService] syncToJson 失败: ${e?.message}`);
      return null;
    }
  }

  /** 将 SQL 表名映射为 sheetKey */
  private _tableNamesToSheetKeys(tableNames: string[]): string[] {
    if (!currentJsonTableData_ACU) return [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(currentJsonTableData_ACU)) {
      if (!key.startsWith('sheet_')) continue;
      const sheet = value as any;
      const runtimeTableName = getPhysicalTableNameForSheet_ACU(currentJsonTableData_ACU, key);
      if (tableNames.includes(runtimeTableName)) keys.push(key);
    }
    return keys;
  }

  /** 确保引擎已初始化 */
  private _ensureInitialized(): void {
    if (!this._initialized || !this.engine.isReady) {
      throw new Error('[SqlTableService] SQLite 引擎未初始化，请先调用 loadFromChat()');
    }
  }

  /**
   * 按需建表：在写操作（applyEdits/executeMutation）前，检查当前聊天模板中的表是否都已存在于 SQLite。
   *
   * 仅在写操作时调用，不在只读查询（executeQuery）时调用。
   * 这样新开卡场景下，用户可以在首次填表前自由修改表结构（DDL），
   * 直到 AI 真正往表里写数据时才锁定表结构并建表。
   *
   * 三种场景：
   * 1. 新卡第一次填表：SQLite 中无任何用户表 → 全量建表
   * 2. 老卡正常运行：所有表都已存在 → 直接返回（幂等）
   * 3. 中途加表：模板中新增了一张表，但 SQLite 中没有 → 只建缺失的表
   *
    * 模板来源优先级：
    * 1. 当前聊天的 chat_override 模板快照
    * 2. 全局模板（inherit_global 或无聊天级模板时的 fallback）
    *
    * 旧版 preset_link 会在 getCurrentChatTemplateScopeState_ACU() 读取时物化为 chat_override。
   *
   * DDL 来源优先级：
   * 1. currentJsonTableData_ACU 中的 sourceData.ddl（可能来自指导表，包含用户在可视化编辑器中的修改）
   * 2. 当前聊天模板中的 sourceData.ddl（fallback）
   */
  private _ensureTablesFromTemplate(scope?: SqlTableApplyScope_ACU): void {
    const existingTables = new Set(this.engine.getTableNames());

    // [修复] 优先从当前聊天模板预设获取模板，而不是依赖全局变量 TABLE_TEMPLATE_ACU
    // 这样确保建表时只使用当前聊天模板预设的内容，不会混入全局模板的表
    const templateData = scope?.templateData || this._resolveCurrentChatTemplate();
    if (!templateData) {
      if (existingTables.size > 0) return;
      throw new Error('[SqlTableService] 模板解析失败，无法建表。请检查模板格式。');
    }

    // 建表前自检：模板内拼音物理名冲突直接 fail-loud，避免建表途中报晦涩的 SQL 错误。
    assertNoPhysicalTableNameCollision_ACU(templateData);

    // 收集当前聊天模板中所有表的 sheetKey 和表名，找出 SQLite 中缺失的
    const sheetKeys = Object.keys(templateData).filter(k => k.startsWith('sheet_'));
    const missingSheets: Record<string, any> = {};

    for (const key of sheetKeys) {
      // 当前聊天模板是建表结构权威；currentJsonTableData_ACU 可能是旧运行时快照，不能让旧 DDL/CHECK 覆盖模板。
      const liveSheet = (currentJsonTableData_ACU as any)?.[key];
      const sheet = (templateData[key] as any) || liveSheet;
      if (!sheet) continue;
      const runtimeTableName = getPhysicalTableNameForSheet_ACU(templateData, key);
      if (!existingTables.has(runtimeTableName)) {
        missingSheets[key] = sheet;
      }
    }

    // 所有表都已存在，无需建表
    if (Object.keys(missingSheets).length === 0) {
      // 不能因物理表已存在就跳过映射同步：删楼回滚/模板切换可重建
      // SQLite runtime，却不会制造缺表；此时外部 CRUD 仍需当前 schema 的列映射。
      if (!this._buildNameMapper(currentJsonTableData_ACU || templateData)) {
        throw new Error('name_mapper_publish_rejected: 未能发布当前 schema 的中英文名映射，已阻止后续写入。');
      }
      return;
    }

    logDebug_ACU(`[SqlTableService] 发现 ${Object.keys(missingSheets).length} 张缺失表，按需建表: ${Object.keys(missingSheets).join(', ')}`);

    // 构造只包含缺失表的数据子集，交给 syncBridge 建表
    // [修复] 同时为缺失表注入 seedRows（初始数据），使建表后 SQLite 中包含初版快照
    // 设计文档 Q9 确认：seedRows 是初版快照，应写入 SQLite 作为真实数据
    const partialData: TableDataObject_ACU = { mate: templateData.mate };
    // 建表用的 templateData 已被 stripSeedRows 剥掉数据行，需要一份保留数据行的模板，
    // 用来还原「模板自带数据」的表。作者在模板里写了数据就代表要保留这个格式，
    // 不能只在「首次填表」时才生效（shouldUseInitialSeedRows_ACU 的限定）。
    const templateWithRows = scope?.templateDataWithRows || this._resolveCurrentChatTemplate(false);
    for (const [key, sheet] of Object.entries(missingSheets)) {
      const sheetCopy = JSON.parse(JSON.stringify(sheet));

      // content 只有表头时补数据：模板作者自带的数据行优先，其次才是 guide/seedRows。
      // templateData 已被 stripSeedRows 剥掉数据行，所以必须回到未 strip 的模板取。
      const templateRows = (templateWithRows as any)?.[key]?.content;
      const authoredRows = Array.isArray(templateRows) && templateRows.length > 1
        ? templateRows.slice(1)
        : [];
      const needsRows = !Array.isArray(sheetCopy.content) || sheetCopy.content.length <= 1;
      if (needsRows) {
        const seedRows = authoredRows.length > 0
          ? authoredRows
          : getEffectiveSeedRowsForSheet_ACU(key, { allowTemplateFallback: true });
        if (Array.isArray(seedRows) && seedRows.length > 0) {
          // seedRows 是不含表头的纯数据行，拼接到表头后面
          sheetCopy.content = [sheetCopy.content[0] || [], ...seedRows];
          sheetCopy.content = ensureStableRowIdsForSheetContent_ACU(sheetCopy.content);
          logDebug_ACU(`[SqlTableService] 表 ${key} (${sheetCopy.name}) 注入 ${seedRows.length} 行 seedRows 作为初版快照`);
        }
      } else {
        // content 已带数据行（未被 strip 的路径）：确保 row_id 稳定后直接使用。
        sheetCopy.content = ensureStableRowIdsForSheetContent_ACU(sheetCopy.content);
      }

      (partialData as any)[key] = sheetCopy;
    }
    this.syncBridge.loadFromTableData(partialData, { strict: true, allowRuntimeDdlFallback: true });

    // 合并新建的表到当前 JSON 视图
    if (currentJsonTableData_ACU) {
      for (const [key, sheet] of Object.entries(missingSheets)) {
        (currentJsonTableData_ACU as any)[key] = sheet;
      }
    } else {
      _set_currentJsonTableData_ACU(templateData);
    }
    if (!this._buildNameMapper(currentJsonTableData_ACU || templateData)) {
      throw new Error('name_mapper_publish_rejected: 建表后未能发布中英文名映射，已阻止后续写入。');
    }

    logDebug_ACU(`[SqlTableService] 按需建表完成，当前共 ${this.engine.getTableNames().length} 张表`);
  }

  /**
   * 解析当前聊天模板预设，返回 stripSeedRows 后的模板对象。
   *
   * 优先级：
   * 1. chat_override —— 当前聊天的专属模板快照
   * 2. inherit_global / 无聊天级模板 —— fallback 到 parseTableTemplateJson_ACU（全局模板）
   *
   * 旧版 preset_link 会在 getCurrentChatTemplateScopeState_ACU() 读取时物化为 chat_override；
   * 这里保留 preset_link 分支只是兼容异常情况下未能写回迁移的旧存档。
   */
  private _resolveCurrentChatTemplate(stripSeedRows = true): TableDataObject_ACU | null {
    try {
      const scopeState = getCurrentChatTemplateScopeState_ACU();

      if (scopeState) {
        let templateStr: string | null = null;

        if (scopeState.mode === 'chat_override' && scopeState.templateStr) {
          // 场景 1：当前聊天有专属模板快照
          templateStr = scopeState.templateStr;
        } else if (scopeState.mode === 'preset_link' && scopeState.presetName) {
          // 旧版兼容兜底：正常读取时已物化为 chat_override。
          const preset = getTemplatePreset_ACU(scopeState.presetName);
          if (preset?.templateStr) {
            templateStr = preset.templateStr;
          }
        }

        if (templateStr) {
          const parsed = safeJsonParse_ACU(templateStr, null);
          if (parsed && typeof parsed === 'object') {
                  const cloned = JSON.parse(JSON.stringify(parsed));
                  const resolved = stripSeedRows ? stripSeedRowsFromTemplate_ACU(cloned) : cloned;
                  logDebug_ACU(`[SqlTableService] 使用当前聊天模板预设 (mode=${scopeState.mode})`);
                  return resolved as TableDataObject_ACU;
          }
        }
      }
    } catch (e: any) {
      logWarn_ACU(`[SqlTableService] 获取当前聊天模板快照失败，fallback 到全局模板: ${e?.message}`);
    }

    // 场景 3：inherit_global 或无聊天级模板，fallback 到全局模板
    logDebug_ACU('[SqlTableService] 使用全局模板 (inherit_global)');
    return parseTableTemplateJson_ACU({ stripSeedRows }) as TableDataObject_ACU | null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 快照级 SQL 应用（用于 grouped unified commit）
// ═══════════════════════════════════════════════════════════════

export async function applyParameterizedSqlMutationToTableDataSnapshot_ACU(
  sql: string,
  params: (string | number | null)[] | undefined,
  tableData: TableDataObject_ACU,
  operationOptions: SnapshotSqlOperationOptions_ACU = {},
): Promise<SnapshotSqlApplyResult_ACU> {
  const engine = new SqliteEngine();
  const syncBridge = new SyncBridge(engine);
  try {
    const normalizedSql = normalizeStatementValues(normalizeSqlStructure(sql));
    const snapshotCopy = JSON.parse(JSON.stringify(tableData || {})) as TableDataObject_ACU;
    const runtimeSql = rebindSqlMutationTableIdentifiers_ACU([normalizedSql], snapshotCopy)[0];
    await engine.init();
    syncBridge.loadFromTableData(snapshotCopy, { strict: true });
    const result = engine.run(runtimeSql, params);
    const workingData = syncBridge.exportToTableData(resolveSnapshotMate_ACU(snapshotCopy), { strict: true });
    const modifiedTableNames = extractTableNamesFromStatements([runtimeSql]);
    const modifiedKeys = mapSqlTableNamesToSheetKeys_ACU(workingData, modifiedTableNames);
    const normalizedParams = Array.isArray(params) && params.length > 0 ? params.map(value => value ?? null) : undefined;
    const operationBuild = buildSqlSheetBatchOperations_ACU([runtimeSql], workingData, {
      params: normalizedParams ? [normalizedParams] : undefined,
      fallbackTargetSheetKeys: operationOptions.targetSheetKeys,
      allowSingleTargetFallback: operationOptions.allowSingleTargetFallback === true,
      keepLegacyForUnclassified: true,
      reason: 'system',
    });

    logDebug_ACU(`[SqlTableService] 参数化快照 SQL 执行成功: changes=${result.changes}, modifiedKeys=${modifiedKeys.join(',')}`);
    return {
      success: true,
      modifiedKeys,
      appliedEdits: 1,
      changes: result.changes,
      workingData,
      operations: operationBuild.operations,
    };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    logError_ACU(`[SqlTableService] 参数化快照 SQL 执行失败: ${errMsg}`);
    return { success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, error: errMsg };
  } finally {
    engine.dispose();
  }
}

export async function applySqlEditsToTableDataSnapshot_ACU(
  sqlStatements: string,
  tableData: TableDataObject_ACU,
  _updateMode?: string,
  operationOptions: SnapshotSqlOperationOptions_ACU = {},
): Promise<SnapshotSqlApplyResult_ACU> {
  const engine = new SqliteEngine();
  const syncBridge = new SyncBridge(engine);
  try {
    const cleaned = sqlStatements.replace(/<!--|-->/g, '').trim();
    if (!cleaned) {
      return { success: true, modifiedKeys: [], appliedEdits: 0, workingData: JSON.parse(JSON.stringify(tableData || {})) };
    }

    const rawStatements = splitSqlStatements(cleaned);
    if (rawStatements.length === 0) {
      return { success: true, modifiedKeys: [], appliedEdits: 0, workingData: JSON.parse(JSON.stringify(tableData || {})) };
    }

    const snapshotCopy = JSON.parse(JSON.stringify(tableData || {})) as TableDataObject_ACU;
    const requireKnownTables = operationOptions.requireSheetScopedOperations === true;
    const reboundStatements = rebindSqlMutationTableIdentifiers_ACU(
      rawStatements.map(stmt => normalizeStatementValues(normalizeSqlStructure(stmt))),
      snapshotCopy,
      snapshotCopy,
      { requireKnownTables },
    );
    const statements = materializeSystemRowIdsForSqlInserts_ACU(reboundStatements, snapshotCopy);
    await engine.init();
    syncBridge.loadFromTableData(snapshotCopy, { strict: true });
    engine.runBatch(statements);

    const workingData = syncBridge.exportToTableData(resolveSnapshotMate_ACU(snapshotCopy), { strict: true });
    const modifiedTableNames = extractTableNamesFromStatements(statements);
    const modifiedKeys = mapSqlTableNamesToSheetKeys_ACU(workingData, modifiedTableNames);
    const operationBuild = buildSqlSheetBatchOperations_ACU(statements, workingData, {
      fallbackTargetSheetKeys: operationOptions.targetSheetKeys,
      allowSingleTargetFallback: operationOptions.allowSingleTargetFallback === true,
      keepLegacyForUnclassified: true,
      reason: 'system',
    });


    logDebug_ACU(`[SqlTableService] 快照 SQL 执行成功: ${statements.length} 条语句, modifiedKeys=${modifiedKeys.join(',')}`);
    return {
      success: true,
      modifiedKeys,
      appliedEdits: statements.length,
      workingData,
      operations: operationBuild.operations,
    };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    logError_ACU(`[SqlTableService] 快照 SQL 执行失败: ${errMsg}`);
    return { success: false, modifiedKeys: [], appliedEdits: 0, error: errMsg };
  } finally {
    engine.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/**
 * 按分号拆分 SQL 语句（跳过字符串内的分号）
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (inString) {
      current += char;
      // 检查字符串结束（处理转义的引号 ''）
      if (char === stringChar) {
        if (i + 1 < sql.length && sql[i + 1] === stringChar) {
          // 转义的引号，跳过
          current += sql[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
    } else if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      current += char;
    } else if (char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
    } else {
      current += char;
    }
  }

  // 最后一条语句（可能没有分号结尾）
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}


/**
 * 从 SQL 语句中提取实际 mutation 目标表。
 * 复用执行边界的 tokenizer，避免字符串、注释或 schema 前缀误导归属。
 */
export function extractTableNamesFromStatements(statements: string[]): string[] {
  const tableNames = new Set<string>();

  for (const stmt of statements) {
    if (typeof stmt !== 'string' || !stmt.trim()) continue;
    try {
      const tokens = tokenizeSqlMutationIdentifiers_ACU(stmt);
      const first = tokens[0];
      if (isSqlMutationKeyword_ACU(first, 'ALTER') && isSqlMutationKeyword_ACU(tokens[1], 'TABLE')) {
        const target = getQualifiedSqlIdentifierTail_ACU(stmt, tokens, 2);
        if (target) tableNames.add(target.value);
        continue;
      }

      const target = getSqlMutationTargetToken_ACU(stmt, tokens);
      tableNames.add(target.value);
    } catch {
      // 本函数只负责归属提取；非法 SQL 由 collect/执行边界给出确定错误。
    }
  }

  return Array.from(tableNames);
}
