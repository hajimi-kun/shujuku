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
  SqlQueryResult,
  SqlMutationResult,
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
import { buildGlobalNameMapper, disposeGlobalNameMapper } from '../runtime/template-vars/name-mapper';
import { parseDDLTableName, generateDDL, generateInserts } from '../../data/sqlite/schema-mapper';
import { normalizeSqlStructure, normalizeStatementValues } from '../../data/sqlite/sql-normalizer';
import { ensureStableRowIdsForSheetContent_ACU, getEffectiveSeedRowsForSheet_ACU, getCurrentChatTemplateScopeState_ACU, sanitizeTemplateSnapshotForChat_ACU, shouldUseInitialSeedRows_ACU } from '../template/chat-scope';
import { getTemplatePreset_ACU } from '../template/template-preset-service';
import { safeJsonParse_ACU } from '../../shared/json-helpers';

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

export function mapSqlTableNamesToSheetKeys_ACU(tableData: TableDataObject_ACU | null | undefined, tableNames: string[]): string[] {
  if (!tableData || !Array.isArray(tableNames) || tableNames.length === 0) return [];
  const matchedKeys = new Set<string>();
  for (const [sheetKey, value] of Object.entries(tableData)) {
    if (!sheetKey.startsWith('sheet_')) continue;
    const sheet = value as any;
    const tableNameFromUid = typeof sheet?.uid === 'string' ? sheet.uid.trim() : '';
    const tableNameFromName = typeof sheet?.name === 'string' ? sheet.name.trim() : '';
    const tableNameFromDDL = typeof sheet?.sourceData?.ddl === 'string' ? parseDDLTableName(sheet.sourceData.ddl) : '';
    if (
      (tableNameFromUid && tableNames.includes(tableNameFromUid))
      || (tableNameFromName && tableNames.includes(tableNameFromName))
      || (tableNameFromDDL && tableNames.includes(tableNameFromDDL))
    ) {
      matchedKeys.add(sheetKey);
    }
  }
  return [...matchedKeys];
}

function appendSqlSheetBatchOperation_ACU(
  operations: TableMutationOperationV2_ACU[],
  sheetKey: string,
  statement: string,
  param: TableSqlBindValueV2_ACU[] | undefined,
  reason: 'manual_crud' | 'import' | 'system',
  tableName?: string,
): void {
  const last = operations[operations.length - 1] as any;
  if (last?.kind === 'sql_sheet_batch' && last.sheetKey === sheetKey) {
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
    ...(tableName ? { tableName } : {}),
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
      classifiedSheetKeys.add(sheetKeys[0]);
      appendSqlSheetBatchOperation_ACU(operations, sheetKeys[0], statement, param, reason, tableNames[0]);
      return;
    }
    if (sheetKeys.length === 0 && allowFallback) {
      const sheetKey = fallbackTargetSheetKeys[0];
      classifiedSheetKeys.add(sheetKey);
      unknownStatements.push(statement);
      appendSqlSheetBatchOperation_ACU(operations, sheetKey, statement, param, reason);
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

  constructor() {
    this.engine = new SqliteEngine();
    this.syncBridge = new SyncBridge(this.engine);
  }

  isReady(): boolean {
    return this._initialized && this.engine.isReady;
  }

  createRuntimeSnapshot(): Uint8Array | null {
    if (!this._initialized || !this.engine.isReady) return null;
    return this.engine.exportBinary();
  }

  async restoreRuntimeSnapshot(snapshot: unknown): Promise<void> {
    if (!(snapshot instanceof Uint8Array)) throw new Error('SQLite 运行时快照无效，无法恢复。');
    await this.engine.loadFromBinary(snapshot);
    this._initialized = true;
    this._existingTableSet = undefined;
    this._syncToJson();
    if (currentJsonTableData_ACU) {
      this._buildNameMapper(currentJsonTableData_ACU as TableDataObject_ACU);
    }
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
          this.syncBridge.loadFromTableData(runtimeSeedData, { strict: true });
          _set_currentJsonTableData_ACU(runtimeSeedData);
          this._buildNameMapper(runtimeSeedData);
          this._initialized = true;
          this._existingTableSet = undefined;
          const hasSeedRows = Object.keys(runtimeSeedData)
            .filter(k => k.startsWith('sheet_'))
            .some(k => Array.isArray((runtimeSeedData as any)[k]?.content) && (runtimeSeedData as any)[k].content.length > 1);
          logDebug_ACU(`[SqlTableService] 初始 seedRows 已写入运行时 SQLite: hasSeedRows=${hasSeedRows}`);
          return { loaded: hasSeedRows, source: hasSeedRows ? 'initialized' : 'empty' };
        }

        logDebug_ACU('[SqlTableService] 没有找到表格数据，引擎已就绪，等待第一次填表时从模板建表');
        this._initialized = true;
        this._existingTableSet = undefined;
        return { loaded: false, source: 'empty' };
      }

      this.syncBridge.loadFromTableData(mergedData as TableDataObject_ACU, { strict: true });
      _set_currentJsonTableData_ACU(mergedData as TableDataObject_ACU);
      this._buildNameMapper(mergedData as TableDataObject_ACU);
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
    try {
      const cloned = JSON.parse(JSON.stringify(data || {})) as TableDataObject_ACU;
      this.engine.dispose();
      this.engine = new SqliteEngine();
      this.syncBridge = new SyncBridge(this.engine);
      await this.engine.init();
      this.syncBridge.loadFromTableData(cloned, { strict: true });
      _set_currentJsonTableData_ACU(cloned);
      this._buildNameMapper(cloned);
      this._initialized = true;
      this._existingTableSet = undefined;
      const modifiedKeys = Object.keys(cloned).filter(key => key.startsWith('sheet_'));
      logDebug_ACU(`[SqlTableService] 运行时全量替换完成: tables=${modifiedKeys.length}`);
      return { success: true, modifiedKeys, appliedEdits: modifiedKeys.length };
    } catch (e: any) {
      const message = e?.message || String(e);
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
    disposeGlobalNameMapper();
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
      normalizedStatements.forEach(statement => {
        userStatements.push(statement);
        userParams.push(normalizedStatements.length === 1 ? paramsList?.[index] : undefined);
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
      const result = this.engine.run(normalizedSql, params);
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
    disposeGlobalNameMapper();
    this._initialized = false;
    this._existingTableSet = undefined;
    logDebug_ACU('[SqlTableService] SQLite 引擎已销毁');
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════════════════════

  /** 重置本实例的 SQLite runtime；不触碰调用方持有的 canonical JSON 快照。 */
  private _resetRuntimeForLoad_ACU(): void {
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
    const inserts: string[] = [];
    if (!currentJsonTableData_ACU) return inserts;

    const sheetKeys = Object.keys(currentJsonTableData_ACU).filter(k => k.startsWith('sheet_'));
    if (sheetKeys.length === 0) return inserts;

    for (const sheetKey of sheetKeys) {
      try {
        const sheet = (currentJsonTableData_ACU as any)[sheetKey];
        if (!sheet?.sourceData?.ddl) continue;

        const tableName = parseDDLTableName(sheet.sourceData.ddl);
        if (!tableName) continue;

        const existingTables = this._existingTableSet ??= new Set(this.engine.getTableNames());
        // 检查表是否存在且为空
        if (!existingTables.has(tableName)) continue;

        const countResult = this.engine.query(`SELECT COUNT(*) AS cnt FROM "${tableName.replace(/"/g, '""')}";`);
        const cnt = countResult?.values?.[0]?.[0];
        if (cnt !== 0) continue; // 非空表，跳过

        // 获取 seedRows
        const seedRows = getEffectiveSeedRowsForSheet_ACU(sheetKey, { allowTemplateFallback: true });
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
    return inserts;
  }

  /** 从 TableDataObject 中提取所有 DDL，构建全局 NameMapper */
  private _buildNameMapper(data: TableDataObject_ACU): void {
    try {
      const ddlMap = new Map<string, string>();
      for (const [key, value] of Object.entries(data)) {
        if (!key.startsWith('sheet_')) continue;
        const sheet = value as any;
        const ddl = sheet?.sourceData?.ddl;
        if (!ddl) continue;
        const tableName = parseDDLTableName(ddl);
        if (tableName) {
          ddlMap.set(tableName, ddl);
        }
      }
      if (ddlMap.size > 0) {
        buildGlobalNameMapper(ddlMap);
      }
    } catch (e: any) {
      logWarn_ACU(`[SqlTableService] 构建 NameMapper 失败: ${e?.message}`);
    }
  }

  /** 同步 SQLite → JSON 视图 */
  private _syncToJson(): void {
    try {
      const mate = (currentJsonTableData_ACU?.mate as Mate_ACU) || { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } };
      const exportedData = this.syncBridge.exportToTableData(mate);
      _set_currentJsonTableData_ACU(exportedData);
    } catch (e: any) {
      logError_ACU(`[SqlTableService] syncToJson 失败: ${e?.message}`);
    }
  }

  /** 将 SQL 表名映射为 sheetKey */
  private _tableNamesToSheetKeys(tableNames: string[]): string[] {
    if (!currentJsonTableData_ACU) return [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(currentJsonTableData_ACU)) {
      if (!key.startsWith('sheet_')) continue;
      const sheet = value as any;
      // 从 DDL 中解析表名进行匹配
      const ddl = sheet?.sourceData?.ddl;
      if (ddl) {
        const match = ddl.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
        if (match && tableNames.includes(match[1])) {
          keys.push(key);
        }
      }
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
  private _ensureTablesFromTemplate(): void {
    const existingTables = new Set(this.engine.getTableNames());

    // [修复] 优先从当前聊天模板预设获取模板，而不是依赖全局变量 TABLE_TEMPLATE_ACU
    // 这样确保建表时只使用当前聊天模板预设的内容，不会混入全局模板的表
    const templateData = this._resolveCurrentChatTemplate();
    if (!templateData) {
      if (existingTables.size > 0) return;
      throw new Error('[SqlTableService] 模板解析失败，无法建表。请检查模板格式。');
    }

    // 收集当前聊天模板中所有表的 sheetKey 和表名，找出 SQLite 中缺失的
    const sheetKeys = Object.keys(templateData).filter(k => k.startsWith('sheet_'));
    const missingSheets: Record<string, any> = {};

    for (const key of sheetKeys) {
      // 当前聊天模板是建表结构权威；currentJsonTableData_ACU 可能是旧运行时快照，不能让旧 DDL/CHECK 覆盖模板。
      const liveSheet = (currentJsonTableData_ACU as any)?.[key];
      const sheet = (templateData[key] as any) || liveSheet;
      if (!sheet) continue;
      const ddl = generateDDL(sheet);
      const tableName = parseDDLTableName(ddl);
      if (tableName && !existingTables.has(tableName)) {
        missingSheets[key] = sheet;
      }
    }

    // 所有表都已存在，无需建表
    if (Object.keys(missingSheets).length === 0) return;

    logDebug_ACU(`[SqlTableService] 发现 ${Object.keys(missingSheets).length} 张缺失表，按需建表: ${Object.keys(missingSheets).join(', ')}`);

    // 构造只包含缺失表的数据子集，交给 syncBridge 建表
    // [修复] 同时为缺失表注入 seedRows（初始数据），使建表后 SQLite 中包含初版快照
    // 设计文档 Q9 确认：seedRows 是初版快照，应写入 SQLite 作为真实数据
    const partialData: TableDataObject_ACU = { mate: templateData.mate };
    for (const [key, sheet] of Object.entries(missingSheets)) {
      const sheetCopy = JSON.parse(JSON.stringify(sheet));

      // 如果 sheet 的 content 只有表头（stripSeedRows 后的空壳），尝试注入 seedRows
      if (Array.isArray(sheetCopy.content) && sheetCopy.content.length <= 1) {
        const seedRows = getEffectiveSeedRowsForSheet_ACU(key, { allowTemplateFallback: true });
        if (Array.isArray(seedRows) && seedRows.length > 0) {
          // seedRows 是不含表头的纯数据行，拼接到表头后面
          sheetCopy.content = [sheetCopy.content[0] || [], ...seedRows];
          sheetCopy.content = ensureStableRowIdsForSheetContent_ACU(sheetCopy.content);
          logDebug_ACU(`[SqlTableService] 表 ${key} (${sheetCopy.name}) 注入 ${seedRows.length} 行 seedRows 作为初版快照`);
        }
      }

      (partialData as any)[key] = sheetCopy;
    }
    this.syncBridge.loadFromTableData(partialData, { strict: true });

    // 合并新建的表到当前 JSON 视图
    if (currentJsonTableData_ACU) {
      for (const [key, sheet] of Object.entries(missingSheets)) {
        (currentJsonTableData_ACU as any)[key] = sheet;
      }
    } else {
      _set_currentJsonTableData_ACU(templateData);
    }
    this._buildNameMapper(currentJsonTableData_ACU || templateData);

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
    await engine.init();
    syncBridge.loadFromTableData(snapshotCopy, { strict: true });
    const result = engine.run(normalizedSql, params);
    const workingData = syncBridge.exportToTableData(resolveSnapshotMate_ACU(snapshotCopy));
    const modifiedTableNames = extractTableNamesFromStatements([normalizedSql]);
    const modifiedKeys = mapSqlTableNamesToSheetKeys_ACU(workingData, modifiedTableNames);
    const normalizedParams = Array.isArray(params) && params.length > 0 ? params.map(value => value ?? null) : undefined;
    const operationBuild = buildSqlSheetBatchOperations_ACU([normalizedSql], workingData, {
      params: normalizedParams ? [normalizedParams] : undefined,
      fallbackTargetSheetKeys: operationOptions.targetSheetKeys,
      allowSingleTargetFallback: operationOptions.allowSingleTargetFallback === true,
      keepLegacyForUnclassified: operationOptions.keepLegacyForUnclassified === true || operationOptions.requireSheetScopedOperations !== true,
      reason: 'system',
    });

    if (operationOptions.requireSheetScopedOperations === true && (
      operationBuild.operations.some(operation => operation.kind === 'sql_batch')
      || operationBuild.unknownStatements.length > 0
      || operationBuild.ambiguousStatements.length > 0
    )) {
      return { success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, error: 'SQL 语句无法归属到单表日志，拒绝写入不可预清理的 SQL 增量。' };
    }

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

    const statements = rawStatements.map(stmt => normalizeStatementValues(normalizeSqlStructure(stmt)));
    const snapshotCopy = JSON.parse(JSON.stringify(tableData || {})) as TableDataObject_ACU;
    await engine.init();
    syncBridge.loadFromTableData(snapshotCopy, { strict: true });
    engine.runBatch(statements);

    const workingData = syncBridge.exportToTableData(resolveSnapshotMate_ACU(snapshotCopy));
    const modifiedTableNames = extractTableNamesFromStatements(statements);
    const modifiedKeys = mapSqlTableNamesToSheetKeys_ACU(workingData, modifiedTableNames);
    const operationBuild = buildSqlSheetBatchOperations_ACU(statements, workingData, {
      fallbackTargetSheetKeys: operationOptions.targetSheetKeys,
      allowSingleTargetFallback: operationOptions.allowSingleTargetFallback === true,
      keepLegacyForUnclassified: operationOptions.keepLegacyForUnclassified === true || operationOptions.requireSheetScopedOperations !== true,
      reason: 'system',
    });

    if (operationOptions.requireSheetScopedOperations === true && (
      operationBuild.operations.some(operation => operation.kind === 'sql_batch')
      || operationBuild.unknownStatements.length > 0
      || operationBuild.ambiguousStatements.length > 0
    )) {
      return { success: false, modifiedKeys: [], appliedEdits: 0, error: 'SQL 语句无法归属到单表日志，拒绝写入不可预清理的 SQL 增量。' };
    }


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
 * 从 SQL 语句中提取表名（简单正则匹配）
 * 支持 INSERT INTO、UPDATE、DELETE FROM、ALTER TABLE
 */
export function extractTableNamesFromStatements(statements: string[]): string[] {
  const tableNames = new Set<string>();
  const ident = '(?:`([^`]+)`|"([^"]+)"|\\[([^\\]]+)\\]|([A-Za-z_][A-Za-z0-9_]*))';
  const patterns = [
    new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${ident}`, 'i'),
    new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?${ident}`, 'i'),
    new RegExp(`\\bDELETE\\s+FROM\\s+${ident}`, 'i'),
    new RegExp(`\\bALTER\\s+TABLE\\s+${ident}`, 'i'),
  ];

  for (const stmt of statements) {
    for (const pattern of patterns) {
      const match = stmt.match(pattern);
      if (match) {
        const tableName = match.slice(1).find(Boolean);
        if (tableName) tableNames.add(tableName);
        break;
      }
    }
  }

  return Array.from(tableNames);
}
