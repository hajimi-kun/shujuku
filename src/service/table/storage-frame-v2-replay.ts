import { getChatArray_ACU } from '../../data/gateways/chat-gateway';
import { getCurrentIsolationKey_ACU, independentTableStates_ACU, settings_ACU } from '../runtime/state-manager';
import type { TableDataObject_ACU, Sheet_ACU, Mate_ACU } from '../../shared/models/table-data';
import { logError_ACU, logWarn_ACU, stripSeedRowsFromTemplate_ACU } from '../../shared/utils';
import { startRuntimePerformanceSpan_ACU } from '../../shared/runtime-performance';
import { SqliteEngine } from '../../data/sqlite/sqlite-engine';
import { SyncBridge } from '../../data/sqlite/sync-bridge';
import { normalizeSqlStructure, normalizeStatementValues } from '../../data/sqlite/sql-normalizer';
import type { TableCheckpointV2_ACU, TableMutationLogEntryV2_ACU, TableMutationOperationV2_ACU, TablePatchV2_ACU, TableSheetCheckpointV2_ACU, TableStorageFrameV2_ACU } from './storage-frame-v2-types';
import { isV2TagData_ACU } from './storage-strategy-resolver';
import { readIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import { ensureStableRowIdsForSeedRows_ACU, getCurrentChatTemplateScopeState_ACU, getEffectiveSeedRowsForSheet_ACU, getGlobalTemplateSnapshotForCurrentProfile_ACU, getSortedSheetKeys_ACU, sanitizeTemplateSnapshotForChat_ACU } from '../template/chat-scope';
import { formatCanonicalRowIssues_ACU, isEmptyCanonicalRowId_ACU, normalizeCanonicalTableRows_ACU } from '../../shared/canonical-row-normalizer';
import { allocateStableRowId_ACU, createStableRowIdReservation_ACU } from '../../shared/stable-row-id-allocator';
import { applySheetSchemaMigrationOperation_ACU } from './table-schema-migration';
import { getPhysicalTableNameForSheet_ACU } from '../../shared/sheet-identity';
import { parseDDLTableName } from '../../shared/ddl-utils';
import { decodeSqlIdentifier_ACU, rebindSqlMutationTableReferences_ACU } from '../../shared/sql-mutation-table-rebind';
import { buildSheetTableAliasMap_ACU } from '../../shared/sql-read-resolver';
import { auditTableDataForUpgrade_ACU, getTableDataFingerprint_ACU } from './table-data-upgrade-audit';
import { repairTableDataFromAudit_ACU } from './table-data-repair';

interface V2FrameRef_ACU {
  messageIndex: number;
  aiFloor: number;
  frame: TableStorageFrameV2_ACU;
}

export type TableScheduleSummaryV2_ACU = NonNullable<TableCheckpointV2_ACU['scheduleSummary']>;

export type TableReplayBaseKindV2_ACU = 'full_checkpoint' | 'temporary_template_baseline';

export interface TableReplayCompatibilityRepairV2_ACU {
  kind: 'temporary_sheet_anchor';
  sheetKey: string;
  messageIndex: number;
  seq: number;
  operationIndex: number;
  templateFingerprint: string;
  reason: 'missing_at_operation';
}

export interface TableReplayResultV2_ACU {
  data: TableDataObject_ACU;
  baseKind: TableReplayBaseKindV2_ACU;
  compatibilityRepairs?: TableReplayCompatibilityRepairV2_ACU[];
  requiresCheckpointConvergence?: boolean;
}

export interface LoadTableStateFromFramesV2Options_ACU {
  maxMessageIndex?: number;
  updateRuntimeState?: boolean;
  throwOnRecoveryRequired?: boolean;
  /**
   * 默认关闭，保留无锚点 artifacts 返回 null 的 fail-closed 契约。
   * 开启后只允许从有效模板建立 header-only 临时基线，且仍拒绝孤立 data_replace。
   * 写入编排器应同时开启 throwOnRecoveryRequired，避免把待确认恢复误当成空表。
   */
  allowTemporaryTemplateBaseline?: boolean;
  /** apply 仅在明确 sql_sheet_batch.sheetKey 缺失时使用同 key 模板表做内存临时补锚。 */
  compatibilityMode?: 'apply' | 'disabled';
  performanceRunId?: string;
  performanceParentSpanId?: string;
}

function deepClone_ACU<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getV2FrameRefs_ACU(chat: any[], isolationKey: string): V2FrameRef_ACU[] {
  const refs: V2FrameRef_ACU[] = [];
  let aiFloor = 0;

  for (let i = 0; i < chat.length; i += 1) {
    const message = chat[i];
    if (!message || message.is_user) continue;
    aiFloor += 1;

    const tagData = readIsolatedTagData_ACU(message, isolationKey) as any;
    if (isV2TagData_ACU(tagData)) {
      refs.push({ messageIndex: i, aiFloor, frame: tagData.storageFrame });
    }
  }

  return refs;
}

function hasUnanchoredReplayArtifacts_ACU(frameRefs: V2FrameRef_ACU[]): boolean {
  return frameRefs.some(({ frame }) => {
    const persistedFrame = frame as unknown as Record<string, unknown>;
    const perSheetCheckpoints = persistedFrame.perSheetCheckpoints;
    const hasPerSheetCheckpointArtifact = perSheetCheckpoints !== undefined
      && (perSheetCheckpoints === null
        || typeof perSheetCheckpoints !== 'object'
        || Array.isArray(perSheetCheckpoints)
        || Object.keys(perSheetCheckpoints).length > 0);
    const headRevision = persistedFrame.headRevision;
    const hasHeadRevisionArtifact = headRevision !== undefined
      && headRevision !== null
      && (typeof headRevision !== 'string' || headRevision.length > 0);

    return frame.logEntries.length > 0
      || hasPerSheetCheckpointArtifact
      || persistedFrame.manualRefillProgress !== undefined
      || hasHeadRevisionArtifact;
  });
}

export function hasUnanchoredReplayArtifactsForChatV2_ACU(
  chatArg: any[] | null | undefined,
  isolationKey: string,
  options: { maxMessageIndex?: number } = {},
): boolean {
  const chat = Array.isArray(chatArg) ? chatArg : [];
  const frameRefs = getV2FrameRefs_ACU(chat, isolationKey)
    .filter(ref => options.maxMessageIndex === undefined || ref.messageIndex <= options.maxMessageIndex);
  return hasUnanchoredReplayArtifacts_ACU(frameRefs);
}

function hasOrphanDataReplace_ACU(frameRefs: V2FrameRef_ACU[]): boolean {
  return frameRefs.some(({ frame }) => (frame.logEntries || []).some(entry =>
    (entry.operations || []).some(operation => operation?.kind === 'data_replace')));
}

function resolveHeaderOnlyTemplateSnapshot_ACU(chat: any[], isolationKey: string): TableDataObject_ACU | null {
  const scopeState = getCurrentChatTemplateScopeState_ACU({ chat, isolationKey });
  const globalSnapshot = scopeState ? null : getGlobalTemplateSnapshotForCurrentProfile_ACU();
  const effectiveTemplate = scopeState?.templateStr || scopeState?.templateObj
    || globalSnapshot?.templateObj || globalSnapshot?.templateStr;
  const snapshot = sanitizeTemplateSnapshotForChat_ACU(effectiveTemplate || null);
  if (!snapshot?.templateObj) return null;

  const headerOnly = stripSeedRowsFromTemplate_ACU(deepClone_ACU(snapshot.templateObj));
  if (!headerOnly || typeof headerOnly !== 'object' || Array.isArray(headerOnly)) return null;
  if (!Object.keys(headerOnly).some(key => key.startsWith('sheet_'))) return null;

  const state = headerOnly as TableDataObject_ACU;
  normalizeReplayState_ACU(state, 'temporary template baseline');
  return state;
}

function applyEventToScheduleSummary_ACU(
  summary: TableScheduleSummaryV2_ACU,
  event: Pick<TableMutationLogEntryV2_ACU, 'filledSheetKeys' | 'changedSheetKeys' | 'groupKeys'> | undefined,
  aiFloor: number,
): void {
  if (!event) return;

  const filledKeys = [...new Set([...(event.filledSheetKeys || []), ...(event.groupKeys || [])])];
  for (const sheetKey of filledKeys) {
    if (!summary[sheetKey]) summary[sheetKey] = {};
    summary[sheetKey].lastFilledAiFloor = aiFloor;
  }

  for (const sheetKey of event.changedSheetKeys || []) {
    if (!summary[sheetKey]) summary[sheetKey] = {};
    summary[sheetKey].lastChangedAiFloor = aiFloor;
  }
}

function replayEventForState_ACU(event: Pick<TableMutationLogEntryV2_ACU, 'filledSheetKeys' | 'changedSheetKeys' | 'groupKeys'> | undefined, aiFloor: number): void {
  if (!event) return;

  const filledKeys = [...new Set([...(event.filledSheetKeys || []), ...(event.groupKeys || [])])];
  for (const sheetKey of filledKeys) {
    if (!independentTableStates_ACU[sheetKey]) independentTableStates_ACU[sheetKey] = {};
    independentTableStates_ACU[sheetKey].lastUpdatedAiFloor = aiFloor;
  }

}

function replayCheckpointSchedule_ACU(checkpoint: TableCheckpointV2_ACU, fallbackAiFloor: number): void {
  const summary = checkpoint.scheduleSummary || {};
  for (const [sheetKey, state] of Object.entries(summary)) {
    if (state.lastFilledAiFloor === undefined) continue;
    if (!independentTableStates_ACU[sheetKey]) independentTableStates_ACU[sheetKey] = {};
    independentTableStates_ACU[sheetKey].lastUpdatedAiFloor = state.lastFilledAiFloor;
  }
  replayEventForState_ACU(checkpoint.event, fallbackAiFloor);
}

function replaceState_ACU(state: TableDataObject_ACU, next: TableDataObject_ACU): void {
  Object.keys(state).forEach(key => delete (state as any)[key]);
  Object.assign(state, deepClone_ACU(next));
}

function getValidatedSheetCheckpoints_ACU(frame: TableStorageFrameV2_ACU): TableSheetCheckpointV2_ACU[] {
  const checkpoints = frame.perSheetCheckpoints;
  if (checkpoints === undefined) return [];
  if (!checkpoints || typeof checkpoints !== 'object' || Array.isArray(checkpoints)) {
    throw new Error('perSheetCheckpoints 必须是按 sheetKey 索引的对象');
  }

  return Object.entries(checkpoints).map(([recordKey, checkpoint]) => {
    if (!recordKey.startsWith('sheet_')) {
      throw new Error(`perSheetCheckpoints 包含非法键: ${recordKey}`);
    }
    if (!checkpoint || checkpoint.kind !== 'sheet_full') {
      throw new Error(`perSheetCheckpoints.${recordKey} 缺少有效的 sheet_full checkpoint`);
    }
    if (checkpoint.sheetKey !== recordKey) {
      throw new Error(`perSheetCheckpoints.${recordKey} 的 sheetKey 不一致: ${checkpoint.sheetKey}`);
    }
    if (!checkpoint.data || typeof checkpoint.data !== 'object' || Array.isArray(checkpoint.data)) {
      throw new Error(`perSheetCheckpoints.${recordKey} 缺少有效的单表 data`);
    }
    if (checkpoint.timeline !== undefined) {
      const timeline = checkpoint.timeline;
      if ((timeline.kind !== 'sheet_introduction' && timeline.kind !== 'sheet_rebase'
        && timeline.kind !== 'sheet_reveal' && timeline.kind !== 'sheet_hide')
        || !Number.isInteger(timeline.activateAtMessageIndex)
        || timeline.activateAtMessageIndex < 0
        || !Number.isInteger(timeline.afterSeq)
        || timeline.afterSeq < 0) {
        throw new Error(`perSheetCheckpoints.${recordKey} 包含非法 timeline`);
      }
    }
    return checkpoint;
  }).sort((left, right) => left.sheetKey.localeCompare(right.sheetKey));
}

function getValidatedFrameLogEntries_ACU(frame: TableStorageFrameV2_ACU): TableMutationLogEntryV2_ACU[] {
  const entries = frame.logEntries;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error('logEntries 必须是数组');

  let previousSeq = -1;
  return entries.map((entry, index) => {
    const seq = entry?.seq;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(`logEntries[${index}] 包含非法 seq: ${String(seq)}`);
    }
    if (seq <= previousSeq) {
      throw new Error(`logEntries 必须按唯一且严格递增的 seq 排列: previous=${previousSeq}, current=${seq}`);
    }
    previousSeq = seq;
    return entry;
  });
}

function getValidatedTimelineCheckpointsForFrame_ACU(
  checkpoints: TableSheetCheckpointV2_ACU[],
): TableSheetCheckpointV2_ACU[] {
  // shard 的物理承载 frame 是跨楼层回放位置；聊天插入、删除或导入会让旧的声明索引漂移。
  // activateAtMessageIndex 仍在 getValidatedSheetCheckpoints_ACU 中做类型/范围校验，
  // 但不再作为寻址键。同一 frame 内的真实生效顺序继续由 afterSeq 决定。
  return checkpoints.filter(checkpoint => checkpoint.timeline !== undefined);
}

function splitSqlStatementsForReplay_ACU(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (inString) {
      current += char;
      if (char === stringChar) {
        if (i + 1 < sql.length && sql[i + 1] === stringChar) {
          current += sql[i + 1];
          i += 1;
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
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function normalizeSqlStatementsForReplay_ACU(statements: string[]): string[] {
  return statements
    .flatMap(statement => splitSqlStatementsForReplay_ACU(String(statement || '').replace(/<!--|-->/g, '').trim()))
    .map(statement => normalizeStatementValues(normalizeSqlStructure(statement)))
    .filter(Boolean);
}

interface SqlReplayRuntime_ACU {
  engine: SqliteEngine;
  syncBridge: SyncBridge;
  loaded: boolean;
}

function normalizeReplayState_ACU(state: TableDataObject_ACU, context: string): void {
  const candidate = deepClone_ACU(state);
  const normalization = normalizeCanonicalTableRows_ACU(candidate);
  const canonicalIssues = [...normalization.errors, ...normalization.removedRows];
  if (canonicalIssues.length > 0) {
    throw new Error(`[V2 Replay] ${context} 行标识不合法：${formatCanonicalRowIssues_ACU(canonicalIssues)}`);
  }
  replaceState_ACU(state, candidate);
}

function normalizeLegacyDuplicateCheckpointState_ACU(state: TableDataObject_ACU): void {
  const probe = deepClone_ACU(state);
  const normalization = normalizeCanonicalTableRows_ACU(probe);
  const nonDuplicateErrors = normalization.errors.filter(issue => issue.reason !== 'duplicate_row_id');
  if (normalization.removedRows.length > 0 || nonDuplicateErrors.length > 0) {
    normalizeReplayState_ACU(state, 'full checkpoint');
    return;
  }

  const audit = auditTableDataForUpgrade_ACU(state);
  const duplicateIssues = audit.issues.filter(issue => (
    issue.code === 'upgrade_duplicate_row_id'
    || issue.code === 'upgrade_seed_pool_conflict'
  ));
  const unsupportedIssues = audit.issues.filter(issue => (
    issue.code !== 'upgrade_duplicate_row_id'
    && issue.code !== 'upgrade_seed_pool_conflict'
  ));
  if (audit.status === 'clean' && normalization.errors.length === 0) {
    replaceState_ACU(state, probe);
    return;
  }
  if (audit.status !== 'repairable' || duplicateIssues.length === 0 || unsupportedIssues.length > 0) {
    normalizeReplayState_ACU(state, 'full checkpoint');
    return;
  }
  const repair = repairTableDataFromAudit_ACU(audit);
  if (repair.requiresConfirmation || !repair.candidateData || typeof repair.candidateData !== 'object') {
    normalizeReplayState_ACU(state, 'full checkpoint');
    return;
  }
  const candidate = repair.candidateData as TableDataObject_ACU;
  normalizeReplayState_ACU(candidate, 'legacy duplicate row_id repair');
  replaceState_ACU(state, candidate);
  const affectedSheetKeys = [...new Set(repair.idRemap.map(remap => remap.sheetKey))];
  logWarn_ACU(
    `[V2 Replay] 旧 full checkpoint 含重复 row_id，已在内存副本中保留全部行并重映射 ${repair.idRemap.length} 行：${affectedSheetKeys.join(', ')}。原 storage frame 未修改。`,
  );
}

async function ensureSqlReplayRuntime_ACU(runtime: SqlReplayRuntime_ACU, state: TableDataObject_ACU): Promise<void> {
  if (runtime.loaded) return;
  normalizeReplayState_ACU(state, 'snapshot');
  await runtime.engine.init();
  runtime.syncBridge.loadFromTableData(state, { strict: true });
  runtime.loaded = true;
}

function getExportedSqlReplayRuntimeState_ACU(runtime: SqlReplayRuntime_ACU, state: TableDataObject_ACU): TableDataObject_ACU {
  if (!runtime.loaded) return deepClone_ACU(state);
  const next = runtime.syncBridge.exportToTableData((state.mate || { type: 'acu', version: 1 }) as Mate_ACU, { strict: true });
  normalizeReplayState_ACU(next, 'SQL 导出结果');
  return next;
}

function exportSqlReplayRuntime_ACU(runtime: SqlReplayRuntime_ACU, state: TableDataObject_ACU): void {
  if (!runtime.loaded) return;
  replaceState_ACU(state, getExportedSqlReplayRuntimeState_ACU(runtime, state));
}

async function reloadSqlReplayRuntime_ACU(runtime: SqlReplayRuntime_ACU, state: TableDataObject_ACU): Promise<void> {
  if (!runtime.loaded) return;
  const nextEngine = new SqliteEngine();
  const nextRuntime: SqlReplayRuntime_ACU = {
    engine: nextEngine,
    syncBridge: new SyncBridge(nextEngine),
    loaded: false,
  };
  try {
    await ensureSqlReplayRuntime_ACU(nextRuntime, state);
  } catch (error) {
    nextEngine.dispose();
    throw error;
  }

  const previousEngine = runtime.engine;
  runtime.engine = nextRuntime.engine;
  runtime.syncBridge = nextRuntime.syncBridge;
  runtime.loaded = true;
  previousEngine.dispose();
}

function buildReplayCandidate_ACU(
  runtime: SqlReplayRuntime_ACU | null,
  state: TableDataObject_ACU,
): TableDataObject_ACU {
  return runtime?.loaded
    ? getExportedSqlReplayRuntimeState_ACU(runtime, state)
    : deepClone_ACU(state);
}

async function commitReplayCandidate_ACU(
  runtime: SqlReplayRuntime_ACU | null,
  state: TableDataObject_ACU,
  candidate: TableDataObject_ACU,
  context: string,
): Promise<void> {
  normalizeReplayState_ACU(candidate, context);
  if (runtime?.loaded) await reloadSqlReplayRuntime_ACU(runtime, candidate);
  replaceState_ACU(state, candidate);
}

async function applySheetCheckpointsForReplay_ACU(
  state: TableDataObject_ACU,
  checkpoints: TableSheetCheckpointV2_ACU[],
  runtime: SqlReplayRuntime_ACU,
): Promise<void> {
  if (checkpoints.length === 0) return;
  const candidate = buildReplayCandidate_ACU(runtime, state);
  for (const checkpoint of checkpoints) {
    if (checkpoint.timeline?.kind === 'sheet_hide') {
      // hide：从 active replay state 移除该表的可见性（数据仍留存于 checkpoint.data 供后续 reveal）。
      delete candidate[checkpoint.sheetKey];
    } else {
      // introduction / rebase / reveal：用 checkpoint.data 整表写入 replay state。
      candidate[checkpoint.sheetKey] = deepClone_ACU(checkpoint.data);
    }
  }
  await commitReplayCandidate_ACU(runtime, state, candidate, '单表 checkpoint');
}

function buildReplaySqlTableAliases_ACU(
  state: TableDataObject_ACU,
  operation: Extract<TableMutationOperationV2_ACU, { kind: 'sql_batch' | 'sql_sheet_batch' }>,
): Map<string, string> {
  const isPlainSqlIdentifier = (value: unknown): value is string => (
    typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)
  );
  // 与实时 SQL/Strict JSON 复用同一表身份别名来源；V2 仅额外保留已写入
  // 历史日志的短 sheetKey 和 operation.tableName 兼容语义。
  const sharedRegistry = buildSheetTableAliasMap_ACU([state], { includeExtendedAliases: true });
  const aliases = new Map(sharedRegistry.aliases);
  const conflicts = new Set<string>();
  const addAlias = (alias: unknown, runtimeName: string): void => {
    const normalized = decodeSqlIdentifier_ACU(alias).normalize('NFKC').trim().toLocaleLowerCase('en-US');
    if (!normalized || conflicts.has(normalized) || sharedRegistry.conflicts.has(normalized)) return;
    const existing = aliases.get(normalized);
    if (existing && existing !== runtimeName) {
      aliases.delete(normalized);
      conflicts.add(normalized);
      return;
    }
    aliases.set(normalized, runtimeName);
  };
  for (const [sheetKey, value] of Object.entries(state)) {
    if (!sheetKey.startsWith('sheet_')) continue;
    const sheet = value as Sheet_ACU;
    const runtimeName = getPhysicalTableNameForSheet_ACU(state, sheetKey);
    // historical V2 logs emitted this short key; it is not a current public alias.
    if (isPlainSqlIdentifier(sheetKey.slice('sheet_'.length))) addAlias(sheetKey.slice('sheet_'.length), runtimeName);
  }
  if (operation.kind === 'sql_sheet_batch') {
    // operation.tableName 是写入当时的历史物理表名，属于历史事实。
    // 表可能已改名（原名/拼音名互换）或该 sheetKey 暂不在当前 replay state 中，
    // 但只要能确定目标运行时表，就必须为历史名注册别名，否则这条增量会以
    // no such table 让整次回放失败。
    let target: string | null = null;
    if (state[operation.sheetKey]) {
      target = getPhysicalTableNameForSheet_ACU(state, operation.sheetKey);
      const historical = decodeSqlIdentifier_ACU(operation.tableName).trim().toLowerCase();
      const existingTarget = aliases.get(historical);
      if (historical && existingTarget && existingTarget !== target) {
        throw new Error(
          `[V2 Replay] sql_sheet_batch 历史表名与其他 Sheet 冲突：sheetKey=${operation.sheetKey}, tableName=${operation.tableName}, target=${target}, occupiedBy=${existingTarget}。`,
        );
      }
    } else {
      // sheetKey 不在 state 中时，退而按历史表名在已注册别名里定位目标表。
      const historical = decodeSqlIdentifier_ACU(operation.tableName).trim().toLowerCase();
      target = aliases.get(historical) || null;
    }
    if (target) addAlias(operation.tableName, target);
  }
  return aliases;
}

async function applySqlBatchOperationV2_ACU(
  state: TableDataObject_ACU,
  operation: Extract<TableMutationOperationV2_ACU, { kind: 'sql_batch' | 'sql_sheet_batch' }>,
  runtime: SqlReplayRuntime_ACU,
): Promise<void> {
  const statements = normalizeSqlStatementsForReplay_ACU(operation.statements || []);
  if (statements.length === 0) return;
  await ensureSqlReplayRuntime_ACU(runtime, state);
  const replayStatements = rebindSqlMutationTableReferences_ACU(statements, buildReplaySqlTableAliases_ACU(state, operation), {
    lenient: true,
  });
  const params = Array.isArray(operation.params) ? operation.params : undefined;
  runtime.engine.runBatch(replayStatements, params);
}


function assertMetaUpdateDoesNotChangeDdl_ACU(patch: Extract<TablePatchV2_ACU, { kind: 'meta_update' }>): void {
  const sourceData = patch.meta?.sourceData;
  if (sourceData && typeof sourceData === 'object' && !Array.isArray(sourceData)
    && Object.prototype.hasOwnProperty.call(sourceData, 'ddl')) {
    throw new Error(
      '[V2 Replay] legacy meta_update.sourceData.ddl 无法安全回放；该结构变更需要迁移为 sheet_schema_migrate 或 sheet_replace。',
    );
  }
}

export function applyTablePatchV2_ACU(state: TableDataObject_ACU, patch: TablePatchV2_ACU): void {
  if (patch.kind === 'sheet_replace') {
    state[patch.sheetKey] = deepClone_ACU(patch.sheet);
    return;
  }

  const sheet = state[patch.sheetKey] as Sheet_ACU | undefined;
  if (!sheet || !Array.isArray(sheet.content)) {
    const isLegacyRowUpsertDelete = patch.kind === 'row_upsert'
      && Array.isArray(patch.cells)
      && isEmptyCanonicalRowId_ACU(patch.cells[0]);
    if (isLegacyRowUpsertDelete) {
      throw new Error(
        `[V2 Replay] legacy row_upsert 删除目标 Sheet 缺失或 content 非法：sheetKey=${patch.sheetKey}。`,
      );
    }
    logWarn_ACU(`[V2 Replay] 跳过 patch，缺少表或 content: ${patch.sheetKey}`);
    return;
  }

  if (patch.kind === 'row_upsert') {
    if (!Array.isArray(patch.cells)) {
      throw new Error(`[V2 Replay] row_upsert cells 必须是数组：sheetKey=${patch.sheetKey}。`);
    }
    const nextCells = deepClone_ACU(patch.cells);
    const header = sheet.content[0];
    if (isEmptyCanonicalRowId_ACU(nextCells[0])) {
      const targetRowId = String(patch.rowId ?? '').trim();
      if (!targetRowId) {
        throw new Error(`[V2 Replay] legacy row_upsert 删除缺少 row_id：sheetKey=${patch.sheetKey}。`);
      }
      if (!Array.isArray(header) || header[0] !== 'row_id') {
        throw new Error(`[V2 Replay] legacy row_upsert 删除要求 row_id 表头：sheetKey=${patch.sheetKey}。`);
      }
      const matchingIndexes = sheet.content.reduce<number[]>((indexes, row, index) => {
        if (index > 0 && Array.isArray(row) && String(row[0] ?? '').trim() === targetRowId) indexes.push(index);
        return indexes;
      }, []);
      if (matchingIndexes.length === 0) {
        throw new Error(`[V2 Replay] legacy row_upsert 删除目标 row_id 不存在：sheetKey=${patch.sheetKey}。`);
      }
      if (matchingIndexes.length > 1) {
        throw new Error(`[V2 Replay] legacy row_upsert 删除遇到重复 row_id：sheetKey=${patch.sheetKey}。`);
      }
      sheet.content.splice(matchingIndexes[0], 1);
      return;
    }
    const rowId = String(patch.rowId ?? '').trim();
    const cellsRowId = String(nextCells[0]).trim();
    if (!rowId || rowId !== cellsRowId) {
      throw new Error(`[V2 Replay] row_upsert 身份不一致：sheetKey=${patch.sheetKey}。`);
    }
    if (!Array.isArray(header) || header[0] !== 'row_id') {
      throw new Error(`[V2 Replay] row_upsert 要求 row_id 表头：sheetKey=${patch.sheetKey}。`);
    }
    if (nextCells.length !== header.length) {
      throw new Error(`[V2 Replay] row_upsert 行宽不匹配：sheetKey=${patch.sheetKey}。`);
    }
    const matchingIndexes = sheet.content.reduce<number[]>((indexes, row, index) => {
      if (index > 0 && Array.isArray(row) && String(row[0] ?? '').trim() === rowId) indexes.push(index);
      return indexes;
    }, []);
    if (matchingIndexes.length > 1) {
      throw new Error(`[V2 Replay] row_upsert 遇到重复 row_id：sheetKey=${patch.sheetKey}。`);
    }
    nextCells[0] = rowId;
    if (matchingIndexes.length === 1) sheet.content[matchingIndexes[0]] = nextCells;
    else sheet.content.push(nextCells);
    return;
  }

  if (patch.kind === 'row_delete') {
    const targetRowId = String(patch.rowId ?? '').trim();
    sheet.content = sheet.content.filter((row, index) => {
      if (index === 0 || !Array.isArray(row)) return true;
      return String(row[0] ?? '').trim() !== targetRowId;
    });
    return;
  }

  if (patch.kind === 'meta_update') {
    const meta = deepClone_ACU(patch.meta || {});
    assertMetaUpdateDoesNotChangeDdl_ACU(patch);
    const sourceData = meta.sourceData;
    if (meta.name !== undefined) sheet.name = meta.name;
    if (meta.orderNo !== undefined) sheet.orderNo = meta.orderNo;
    if (meta.updateConfig !== undefined) sheet.updateConfig = meta.updateConfig;
    if (meta.exportConfig !== undefined) sheet.exportConfig = meta.exportConfig;
    if (sourceData !== undefined) {
      sheet.sourceData = { ...sheet.sourceData, ...(sourceData as Record<string, unknown>) };
    }
  }
}

function parseDslArgs_ACU(argsString: string): any[] | null {
  try {
    const firstBracket = argsString.indexOf('{');
    if (firstBracket === -1) return JSON.parse(`[${argsString}]`);
    const paramsPart = argsString.substring(0, firstBracket).trim();
    const jsonPart = argsString.substring(firstBracket);
    const initialArgs = JSON.parse(`[${paramsPart.replace(/,$/, '')}]`);
    return [...initialArgs, JSON.parse(jsonPart)];
  } catch (_) {
    return null;
  }
}

function extractTableEditDslCommands_ACU(text: string): string[] {
  const cleaned = String(text || '').replace(/<!--|-->/g, '');
  const commands: string[] = [];
  const commandPattern = /(?:insertRow|updateRow|deleteRow)\s*\(/g;
  let searchStart = 0;

  while (searchStart < cleaned.length) {
    commandPattern.lastIndex = searchStart;
    const match = commandPattern.exec(cleaned);
    if (!match) break;

    const commandStart = match.index;
    const openParenIndex = cleaned.indexOf('(', commandStart);
    if (openParenIndex === -1) break;

    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let commandEnd = -1;

    for (let i = openParenIndex; i < cleaned.length; i += 1) {
      const char = cleaned[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === stringChar) {
          inString = false;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = true;
        stringChar = char;
        continue;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          commandEnd = i + 1;
          break;
        }
      }
    }

    if (commandEnd === -1) break;
    const command = cleaned.slice(commandStart, commandEnd).trim().replace(/;$/, '');
    if (command) commands.push(command);
    searchStart = commandEnd;
  }

  return commands;
}

function resolveDslReplaySheetKeys_ACU(state: TableDataObject_ACU): string[] {
  const sortedKeys = getSortedSheetKeys_ACU(state as any);
  if (Array.isArray(sortedKeys) && sortedKeys.length > 0) return sortedKeys;
  return Object.keys(state).filter(k => k.startsWith('sheet_'));
}

function materializeSeedRowsForDslReplay_ACU(sheet: Sheet_ACU): void {
  if (!Array.isArray(sheet.content) || sheet.content.length !== 1) return;
  let seedRows = Array.isArray(sheet.seedRows) && sheet.seedRows.length > 0 ? sheet.seedRows : null;
  if (!seedRows && sheet.uid && String(sheet.uid).startsWith('sheet_')) {
    seedRows = getEffectiveSeedRowsForSheet_ACU(String(sheet.uid), {
      guideData: null,
      allowTemplateFallback: true,
    });
    if (Array.isArray(seedRows) && seedRows.length > 0) sheet.seedRows = deepClone_ACU(seedRows);
  }
  if (!Array.isArray(seedRows) || seedRows.length === 0) return;
  const headerRow = Array.isArray(sheet.content[0]) ? deepClone_ACU(sheet.content[0]) : ['row_id'];
  // 与实时 DSL 路径保持同一身份契约：只有明确的 seedRows 新行能在物化时补 row_id。
  sheet.content = [headerRow, ...ensureStableRowIdsForSeedRows_ACU(seedRows)];
}

function applyTableEditDslOperationV2_ACU(state: TableDataObject_ACU, text: string): void {
  const sheetKeys = resolveDslReplaySheetKeys_ACU(state);
  const commands = extractTableEditDslCommands_ACU(text);

  for (const commandLine of commands) {
    const match = commandLine.match(/^(insertRow|deleteRow|updateRow)\s*\((.*)\)$/);
    if (!match) continue;
    const command = match[1];
    const args = parseDslArgs_ACU(match[2]);
    if (!args) continue;
    const tableIndex = Number(args[0]);
    const sheetKey = sheetKeys[tableIndex];
    const sheet = sheetKey ? state[sheetKey] as Sheet_ACU : null;
    if (!sheet || !Array.isArray(sheet.content)) continue;

    materializeSeedRowsForDslReplay_ACU(sheet);

    if (command === 'insertRow') {
      const data = args[1] || {};
      const headers = Array.isArray(sheet.content[0]) ? sheet.content[0].slice(1) : [];
      const row = [allocateStableRowId_ACU(createStableRowIdReservation_ACU(sheet.content.slice(1)))];
      headers.forEach((_, colIndex) => row.push(data[colIndex] ?? data[String(colIndex)] ?? ''));
      sheet.content.push(row);
    } else if (command === 'deleteRow') {
      const rowIndex = Number(args[1]);
      if (Number.isFinite(rowIndex) && sheet.content.length > rowIndex + 1) sheet.content.splice(rowIndex + 1, 1);
    } else if (command === 'updateRow') {
      const rowIndex = Number(args[1]);
      const data = args[2] || {};
      const row = Number.isFinite(rowIndex) ? sheet.content[rowIndex + 1] : null;
      if (!Array.isArray(row)) continue;
      Object.keys(data).forEach(colIndexStr => {
        const colIndex = Number.parseInt(colIndexStr, 10);
        if (!Number.isFinite(colIndex)) return;
        row[colIndex + 1] = data[colIndexStr];
      });
    }
  }
}

export async function applyTableOperationV2_ACU(
  state: TableDataObject_ACU,
  operation: TableMutationOperationV2_ACU,
  runtime?: SqlReplayRuntime_ACU,
): Promise<void> {
  if (!operation || typeof operation !== 'object' || typeof (operation as any).kind !== 'string') {
    throw new Error('[V2 Replay] operation 缺少有效 kind。');
  }
  const ownedRuntime = !runtime && (operation.kind === 'sql_batch' || operation.kind === 'sql_sheet_batch')
    ? { engine: new SqliteEngine(), syncBridge: null as unknown as SyncBridge, loaded: false }
    : null;
  if (ownedRuntime) ownedRuntime.syncBridge = new SyncBridge(ownedRuntime.engine);
  const effectiveRuntime = runtime || ownedRuntime || null;

  try {
    if (operation.kind === 'data_replace') {
      const candidate = deepClone_ACU(operation.data);
      await commitReplayCandidate_ACU(effectiveRuntime, state, candidate, 'data_replace');
      return;
    }
    if (operation.kind === 'sql_batch' || operation.kind === 'sql_sheet_batch') {
      if (!effectiveRuntime) throw new Error(`${operation.kind} replay requires runtime`);
      await applySqlBatchOperationV2_ACU(state, operation, effectiveRuntime);
      if (ownedRuntime) exportSqlReplayRuntime_ACU(ownedRuntime, state);
      return;
    }
    if (operation.kind === 'sheet_schema_migrate') {
      const sourceState = buildReplayCandidate_ACU(effectiveRuntime, state);
      const candidate = await applySheetSchemaMigrationOperation_ACU(sourceState, operation);
      await commitReplayCandidate_ACU(effectiveRuntime, state, candidate, 'sheet_schema_migrate');
      return;
    }
    if (operation.kind === 'sheet_replace') {
      const candidate = buildReplayCandidate_ACU(effectiveRuntime, state);
      candidate[operation.sheetKey] = deepClone_ACU(operation.sheet);
      await commitReplayCandidate_ACU(effectiveRuntime, state, candidate, 'sheet_replace');
      return;
    }
    if (operation.kind === 'row_upsert' || operation.kind === 'row_delete' || operation.kind === 'meta_update') {
      if (operation.kind === 'meta_update') {
        assertMetaUpdateDoesNotChangeDdl_ACU(operation);
      }
      const candidate = buildReplayCandidate_ACU(effectiveRuntime, state);
      applyTablePatchV2_ACU(candidate, operation);
      await commitReplayCandidate_ACU(effectiveRuntime, state, candidate, operation.kind);
      return;
    }
    if (operation.kind === 'table_edit_dsl') {
      const candidate = buildReplayCandidate_ACU(effectiveRuntime, state);
      applyTableEditDslOperationV2_ACU(candidate, operation.text);
      await commitReplayCandidate_ACU(effectiveRuntime, state, candidate, 'table_edit_dsl');
      return;
    }

    throw new Error(`[V2 Replay] 不支持的 operation kind: ${(operation as any).kind}`);
  } finally {
    if (ownedRuntime) ownedRuntime.engine.dispose();
  }
}

export function collectScheduleSummaryFromFramesV2_ACU(
  chatArg: any[] | null | undefined,
  isolationKey: string,
  options: { maxMessageIndex?: number } = {},
): TableScheduleSummaryV2_ACU {
  const chat = chatArg || [];
  if (!Array.isArray(chat) || chat.length === 0) return {};

  const frameRefs = getV2FrameRefs_ACU(chat, isolationKey)
    .filter(ref => options.maxMessageIndex === undefined || ref.messageIndex <= options.maxMessageIndex);
  const checkpointRef = [...frameRefs].reverse().find(ref => ref.frame.checkpoint?.kind === 'full');

  const summary: TableScheduleSummaryV2_ACU = checkpointRef?.frame.checkpoint
    ? deepClone_ACU(checkpointRef.frame.checkpoint.scheduleSummary || {})
    : {};
  if (checkpointRef?.frame.checkpoint) {
    applyEventToScheduleSummary_ACU(summary, checkpointRef.frame.checkpoint.event, checkpointRef.aiFloor);
  }

  for (const ref of frameRefs) {
    if (checkpointRef && ref.messageIndex < checkpointRef.messageIndex) continue;
    const checkpoints = getValidatedSheetCheckpoints_ACU(ref.frame);
    const introductions = getValidatedTimelineCheckpointsForFrame_ACU(checkpoints);
    for (const sheetCheckpoint of checkpoints.filter(checkpoint => checkpoint.timeline === undefined)) {
      summary[sheetCheckpoint.sheetKey] = deepClone_ACU(sheetCheckpoint.scheduleSummary || {});
      applyEventToScheduleSummary_ACU(
        summary,
        sheetCheckpoint.event,
        ref.aiFloor,
      );
    }
    const entries = getValidatedFrameLogEntries_ACU(ref.frame);
    const pendingIntroductions = [...introductions];
    const applyDueIntroductions = (nextSeq: number): void => {
      const due = pendingIntroductions.filter(checkpoint => checkpoint.timeline!.afterSeq < nextSeq);
      for (const checkpoint of due) {
        summary[checkpoint.sheetKey] = deepClone_ACU(checkpoint.scheduleSummary || {});
        applyEventToScheduleSummary_ACU(summary, checkpoint.event, ref.aiFloor);
        pendingIntroductions.splice(pendingIntroductions.indexOf(checkpoint), 1);
      }
    };
    for (const entry of entries) {
      applyDueIntroductions(entry.seq);
      applyEventToScheduleSummary_ACU(summary, entry, ref.aiFloor);
    }
    applyDueIntroductions(Number.POSITIVE_INFINITY);
  }

  return summary;
}

async function loadTableStateFromFramesV2DetailedCore_ACU(
  chatArg?: any[],
  isolationKeyArg?: string,
  options: LoadTableStateFromFramesV2Options_ACU = {},
): Promise<TableReplayResultV2_ACU | null> {
  const chat = chatArg || getChatArray_ACU();
  if (!Array.isArray(chat) || chat.length === 0) return null;

  const isolationKey = isolationKeyArg ?? getCurrentIsolationKey_ACU();
  const frameRefs = getV2FrameRefs_ACU(chat, isolationKey)
    .filter(ref => options.maxMessageIndex === undefined || ref.messageIndex <= options.maxMessageIndex);
  const checkpointRef = [...frameRefs].reverse().find(ref => ref.frame.checkpoint?.kind === 'full');
  const hasUnanchoredArtifacts = hasUnanchoredReplayArtifacts_ACU(frameRefs);
  let baseKind: TableReplayBaseKindV2_ACU = 'full_checkpoint';
  let state: TableDataObject_ACU;
  let replayStartMessageIndex: number;

  if (!checkpointRef?.frame.checkpoint) {
    if (!hasUnanchoredArtifacts) return null;
    if (!options.allowTemporaryTemplateBaseline) {
      logWarn_ACU('[V2 Replay] 未找到 full checkpoint，检测到无锚点 V2 replay artifacts，拒绝恢复不完整 V2 表格数据。');
      return null;
    }
    if (hasOrphanDataReplace_ACU(frameRefs)) {
      const message = '[V2 Replay] 无锚点 artifacts 包含 data_replace，必须通过显式恢复确认，拒绝使用临时模板基线。';
      logWarn_ACU(message);
      if (options.throwOnRecoveryRequired) throw new Error(`${message} 请先在数据管理中执行 V2 恢复诊断并确认恢复。`);
      return null;
    }
    const temporaryBaseline = resolveHeaderOnlyTemplateSnapshot_ACU(chat, isolationKey);
    if (!temporaryBaseline) {
      logWarn_ACU('[V2 Replay] 无锚点 artifacts 缺少同聊天同隔离域的有效模板，拒绝建立临时基线。');
      return null;
    }
    state = temporaryBaseline;
    baseKind = 'temporary_template_baseline';
    replayStartMessageIndex = frameRefs[0]?.messageIndex ?? 0;
    logWarn_ACU('[V2 Replay] 未找到 full checkpoint，正使用当前聊天模板的 header-only 临时基线回放；该状态不是持久化锚点。');
  } else {
    const checkpoint = checkpointRef.frame.checkpoint;
    state = deepClone_ACU(checkpoint.data);
    normalizeLegacyDuplicateCheckpointState_ACU(state);
    replayStartMessageIndex = checkpointRef.messageIndex;
    if (options.updateRuntimeState !== false) replayCheckpointSchedule_ACU(checkpoint, checkpointRef.aiFloor);
  }

  const runtime: SqlReplayRuntime_ACU = {
    engine: new SqliteEngine(),
    syncBridge: null as unknown as SyncBridge,
    loaded: false,
  };
  const compatibilityRepairs: TableReplayCompatibilityRepairV2_ACU[] = [];
  let headerOnlyTemplate: TableDataObject_ACU | null | undefined;
  let headerOnlyTemplateFingerprint = '';
  runtime.syncBridge = new SyncBridge(runtime.engine);

  try {
    for (const ref of frameRefs) {
      if (ref.messageIndex < replayStartMessageIndex) continue;
      const checkpoints = getValidatedSheetCheckpoints_ACU(ref.frame);
      const introductions = getValidatedTimelineCheckpointsForFrame_ACU(checkpoints);
      await applySheetCheckpointsForReplay_ACU(
        state,
        checkpoints.filter(checkpoint => checkpoint.timeline === undefined),
        runtime,
      );
      const entries = getValidatedFrameLogEntries_ACU(ref.frame);
      const pendingIntroductions = [...introductions];
      const applyDueIntroductions = async (nextSeq: number): Promise<void> => {
        const due = pendingIntroductions.filter(checkpoint => checkpoint.timeline!.afterSeq < nextSeq);
        if (due.length === 0) return;
        await applySheetCheckpointsForReplay_ACU(state, due, runtime);
        for (const checkpoint of due) {
          if (options.updateRuntimeState !== false) {
            replayEventForState_ACU(checkpoint.event, ref.aiFloor);
          }
          pendingIntroductions.splice(pendingIntroductions.indexOf(checkpoint), 1);
        }
      };
      for (const entry of entries) {
        try {
          await applyDueIntroductions(entry.seq);
          if (Array.isArray(entry.operations) && entry.operations.length > 0) {
            for (const [operationIndex, operation] of entry.operations.entries()) {
              try {
                if (options.compatibilityMode !== 'disabled'
                  && operation?.kind === 'sql_sheet_batch'
                  && typeof operation.sheetKey === 'string'
                  && operation.sheetKey.startsWith('sheet_')
                  && !Object.prototype.hasOwnProperty.call(state, operation.sheetKey)) {
                  if (headerOnlyTemplate === undefined) {
                    headerOnlyTemplate = resolveHeaderOnlyTemplateSnapshot_ACU(chat, isolationKey);
                    headerOnlyTemplateFingerprint = headerOnlyTemplate
                      ? getTableDataFingerprint_ACU(headerOnlyTemplate)
                      : '';
                  }
                  const templateSheet = headerOnlyTemplate?.[operation.sheetKey];
                  if (templateSheet && typeof templateSheet === 'object' && !Array.isArray(templateSheet)) {
                    const candidate = buildReplayCandidate_ACU(runtime, state);
                    candidate[operation.sheetKey] = deepClone_ACU(templateSheet) as Sheet_ACU;
                    await commitReplayCandidate_ACU(runtime, state, candidate, 'temporary sheet anchor');
                    compatibilityRepairs.push({
                      kind: 'temporary_sheet_anchor',
                      sheetKey: operation.sheetKey,
                      messageIndex: ref.messageIndex,
                      seq: entry.seq,
                      operationIndex,
                      templateFingerprint: headerOnlyTemplateFingerprint,
                      reason: 'missing_at_operation',
                    });
                    logWarn_ACU(`[V2 Replay] operation 执行点缺少目标表，已从当前聊天模板临时补锚：sheetKey=${operation.sheetKey}, messageIndex=${ref.messageIndex}, seq=${entry.seq}, operationIndex=${operationIndex}。该状态需要由 recovery 或 compaction 固化。`);
                  }
                }
                await applyTableOperationV2_ACU(state, operation, runtime);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(
                  `[V2 Replay] operation failed: messageIndex=${ref.messageIndex}, seq=${entry.seq}, operationIndex=${operationIndex}, kind=${String((operation as any)?.kind || 'unknown')}: ${message}`,
                );
              }
            }
          } else {
            const candidate = buildReplayCandidate_ACU(runtime, state);
            // 兼容旧版 derived patch log；新 V2 不再写 patches。
            for (const patch of entry.patches || []) {
              applyTablePatchV2_ACU(candidate, patch);
            }
            await commitReplayCandidate_ACU(runtime, state, candidate, 'legacy patches');
          }
          if (options.updateRuntimeState !== false) {
            replayEventForState_ACU(entry, ref.aiFloor);
          }
        } catch (error) {
          logError_ACU(`[V2 Replay] 应用日志失败: messageIndex=${ref.messageIndex}, seq=${entry.seq}`, error);
          throw error;
        }
      }
      await applyDueIntroductions(Number.POSITIVE_INFINITY);
    }

    if (runtime.loaded) exportSqlReplayRuntime_ACU(runtime, state);
    return {
      data: state,
      baseKind,
      ...(compatibilityRepairs.length > 0 ? { compatibilityRepairs } : {}),
      ...(compatibilityRepairs.length > 0 ? { requiresCheckpointConvergence: true } : {}),
    };
  } finally {
    runtime.engine.dispose();
  }
}

export async function loadTableStateFromFramesV2Detailed_ACU(
  chatArg?: any[],
  isolationKeyArg?: string,
  options: LoadTableStateFromFramesV2Options_ACU = {},
): Promise<TableReplayResultV2_ACU | null> {
  const chat = chatArg || getChatArray_ACU();
  const performanceSpan = startRuntimePerformanceSpan_ACU('v2-replay', {
    runId: options.performanceRunId,
    parentSpanId: options.performanceParentSpanId,
    settings: settings_ACU,
    metrics: {
      messageCount: Array.isArray(chat) ? chat.length : 0,
      maxMessageIndex: options.maxMessageIndex ?? -1,
    },
  });
  try {
    const result = await loadTableStateFromFramesV2DetailedCore_ACU(chatArg, isolationKeyArg, options);
    performanceSpan.end({
      success: result !== null,
      baseKind: result?.baseKind || 'none',
      sheetCount: result?.data
        ? Object.keys(result.data).filter(key => key.startsWith('sheet_')).length
        : 0,
    });
    return result;
  } catch (error) {
    performanceSpan.end({ success: false });
    throw error;
  }
}

export async function loadTableStateFromFramesV2_ACU(
  chatArg?: any[],
  isolationKeyArg?: string,
  options: LoadTableStateFromFramesV2Options_ACU = {},
): Promise<TableDataObject_ACU | null> {
  const result = await loadTableStateFromFramesV2Detailed_ACU(chatArg, isolationKeyArg, options);
  return result?.data ?? null;
}

export async function validateCurrentChatTableRecovery_ACU(
  options: { chat?: any[]; isolationKey?: string } = {},
): Promise<
  | { success: true }
  | { success: false; error: string; diagnosticCode?: 'replay_requires_checkpoint_convergence'; affectedSheetKeys?: string[] }
> {
  const chat = options.chat || getChatArray_ACU();
  if (!Array.isArray(chat) || chat.length === 0) return { success: true };
  try {
    const replay = await loadTableStateFromFramesV2Detailed_ACU(
      chat,
      options.isolationKey ?? getCurrentIsolationKey_ACU(),
      { updateRuntimeState: false },
    );
    if (replay?.requiresCheckpointConvergence || replay?.compatibilityRepairs?.length) {
      const affectedSheetKeys = [...new Set((replay.compatibilityRepairs || []).map(repair => repair.sheetKey))];
      return {
        success: false,
        diagnosticCode: 'replay_requires_checkpoint_convergence',
        affectedSheetKeys,
        error: `当前 V2 历史仍依赖临时 Sheet 补锚：${affectedSheetKeys.join('、') || '未知 Sheet'}。请先在数据管理中完成恢复收敛。`,
      };
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error || '未知错误'),
    };
  }
}
