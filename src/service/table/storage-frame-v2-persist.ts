import { getChatArray_ACU, saveChatToHost_ACU, saveChatToHostStrict_ACU } from '../../data/gateways/chat-gateway';
import { cloneIsolatedData_ACU, collectSqlTargetTableNamesFromStorageFrameV2_ACU, purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU, purgeSheetKeysFromMessage_ACU, readIsolatedTagData_ACU, writeMessageIdentity_ACU } from '../../data/repositories/chat-message-data-repo';
import { getActiveChatStorageIdentity_ACU, peekChatScopedConfigContainer_ACU, peekChatSheetGuideContainer_ACU, setChatScopedConfigContainer_ACU, setChatSheetGuideContainer_ACU } from '../../data/storage/chat-history';
import type { Sheet_ACU, TableDataObject_ACU } from '../../shared/models/table-data';
import type { StorageMode } from '../../shared/table-storage-provider';
import { logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import { startRuntimePerformanceSpan_ACU } from '../../shared/runtime-performance';
import { getCurrentIsolationKey_ACU, settings_ACU } from '../runtime/state-manager';
import { normalizeGuideData_ACU, setChatSheetGuideDataForIsolationKey_ACU } from '../template/chat-scope';
import { ensureGlobalInjectionConfigDefaults_ACU } from '../worldbook/injection-engine';
import type { ManualRefillProgressV2_ACU, TableMutationEventV2_ACU, TableMutationLogEntryV2_ACU, TableMutationSourceV2_ACU, TableStorageFrameV2_ACU, TableCheckpointV2_ACU, TableMutationWriteSetV2_ACU, TableMutationOperationV2_ACU, TableSheetCheckpointV2_ACU, TableV2RecoveryBackup_ACU } from './storage-frame-v2-types';
import { hasLegacyTopLevelTableData_ACU, hasV2TableHistoryEvidence_ACU, isLegacyV1TagData_ACU, isV2TagData_ACU } from './storage-strategy-resolver';
import { applyTableOperationV2_ACU, collectScheduleSummaryFromFramesV2_ACU, hasUnanchoredReplayArtifactsForChatV2_ACU, loadTableStateFromFramesV2Detailed_ACU } from './storage-frame-v2-replay';
import { runTableWriteTransaction_ACU, type TableWriteTransactionContext_ACU } from './table-write-transaction';
import { formatCanonicalRowIssues_ACU, normalizeCanonicalTableRows_ACU } from '../../shared/canonical-row-normalizer';
import { createSheetInsertPlan, generateDDL, validateDDLTextAgainstHeaders_ACU } from '../../data/sqlite/schema-mapper';
import { hydrateTableDataStrict_ACU } from './sqlite-template-validation';
import { buildCanonicalFullCheckpoint_ACU, buildCanonicalSheetCheckpoint_ACU } from './canonical-checkpoint-builder';
import { getTableDataFingerprint_ACU } from './table-data-upgrade-audit';

export interface TableCheckpointGenerationConfig_ACU {
  maxEntriesAfterCheckpoint: number;
  maxOperationKbAfterCheckpoint: number;
  maxOperationBytesAfterCheckpoint: number;
  maxOperationCountAfterCheckpoint: number;
  cumulativeOperationRatioPercent: number;
  singleOperationRatioPercent: number;
  cumulativeOperationRatio: number;
  singleOperationRatio: number;
}

export interface TableCheckpointGenerationStatus_ACU {
  latestCheckpointMessageIndex?: number;
  latestCheckpointAiFloor?: number;
  entryCountAfterCheckpoint: number;
  cumulativeOperationBytes: number;
  cumulativeOperationCount: number;
  fullCheckpointBytes: number;
  nextWriteKind: 'incremental' | 'full';
  config: TableCheckpointGenerationConfig_ACU;
}

export interface ReplaceExistingIncrementalOptions_ACU {
  targetMessageIndices: number[];
  targetSheetKeys: string[];
}

export interface PersistTableMutationV2Options_ACU {
  targetMessageIndex?: number;
  source: TableMutationSourceV2_ACU;
  /**
   * 调用方声明的事务后数据。持久化层不再做 replay-vs-afterData 相等性阻断；
   * 数据正确性由来源链路保证，本层只校验输入合法性、操作可应用性与原子保存。
   */
  afterData: TableDataObject_ACU;
  operations?: TableMutationOperationV2_ACU[];
  filledSheetKeys?: string[];
  candidateChangedSheetKeys?: string[] | null;
  groupKeys?: string[];
  requestId?: string;
  batchId?: string;
  error?: string;
  forceCheckpoint?: boolean;
  checkpointReason?: TableCheckpointV2_ACU['reason'];
  manualRefillProgress?: ManualRefillProgressV2_ACU;
  isolationKey?: string;
  baseRevision?: string | null;
  parentRevision?: string | null;
  writeSet?: TableMutationWriteSetV2_ACU;
  revisionWriteSet?: TableMutationWriteSetV2_ACU;
  /** 在追加本次 entry 前，裁剪指定消息与表的历史手动填表增量。 */
  replaceExistingIncremental?: ReplaceExistingIncrementalOptions_ACU;
  /** 调用方已处于 transactionContext.runCommit 临界区内时使用，避免嵌套 commit 锁。 */
  assumeCommitLock?: boolean;
  /** 对破坏性复合写入要求宿主真实保存；默认保持历史宽松保存语义。 */
  strictSave?: boolean;
  performanceRunId?: string;
  performanceParentSpanId?: string;
  transactionContext?: Pick<TableWriteTransactionContext_ACU, 'runCommit' | 'baseRevision' | 'writeSet' | 'assertFresh'>;
}

export interface PersistTableMutationLogBatchTargetV2_ACU {
  targetMessageIndex: number;
  operations: TableMutationOperationV2_ACU[];
  changedSheetKeys: string[];
}

/**
 * 多消息层 V2 增量提交。所有 target 都在内存 clone 中构造，
 * 确认后一次性写回消息对象并调用严格宿主保存。
 * afterData 正确性由来源链路保证，本层不做 candidate replay 与 afterData 的相等性阻断。
 */
export interface PersistTableMutationLogBatchV2Options_ACU {
  source: TableMutationSourceV2_ACU;
  afterData: TableDataObject_ACU;
  targets: PersistTableMutationLogBatchTargetV2_ACU[];
  isolationKey?: string;
  requestId?: string;
  batchId?: string;
  revisionWriteSet?: TableMutationWriteSetV2_ACU;
  transactionContext?: Pick<TableWriteTransactionContext_ACU, 'runCommit' | 'baseRevision' | 'writeSet' | 'assertFresh'>;
  /** 调用方已处于 transactionContext.runCommit 临界区内时使用。 */
  assumeCommitLock?: boolean;
}

export interface PersistTableSheetCheckpointV2Options_ACU {
  targetMessageIndex?: number;
  sheetKey: string;
  sheetData: Sheet_ACU;
  reason?: TableCheckpointV2_ACU['reason'];
  createdAt?: number;
  event?: TableMutationEventV2_ACU;
  manualRefillProgress?: ManualRefillProgressV2_ACU;
  isolationKey?: string;
  baseRevision?: string | null;
  /** 调用方已处于 transactionContext.runCommit 临界区内时使用，避免嵌套 commit 锁。 */
  assumeCommitLock?: boolean;
  transactionContext?: Pick<TableWriteTransactionContext_ACU, 'runCommit' | 'baseRevision' | 'writeSet' | 'assertFresh'>;
}

export interface CommitCurrentFloorTemplateChangesOptions_ACU {
  /** 未指定时选择当前聊天末尾的最新 AI 楼层。 */
  targetMessageIndex?: number;
  isolationKey?: string;
  sheetChanges: TemplateSheetChange_ACU[];
  /** 在本次模板提交中从全聊天历史精确硬删除的 Sheet。 */
  deletedSheetKeys?: string[];
  guideData: Record<string, any>;
  /** 同步当前聊天模板 scope；由 guide setter 生成一致的 chat_override 快照。 */
  syncTemplateScope?: boolean;
  templateSource?: any;
  presetName?: string;
  source?: string;
  reason?: string;
  /** Correlates one template reconciliation across planning and atomic persistence logs. */
  requestId?: string;
  createdAt?: number;
  baseRevision?: string | null;
  expectedChatIdentity?: string;
  expectedFirstMessage?: unknown;
  signal?: AbortSignal;
  /** native 只校验 canonical JSON；sqlite 额外执行 DDL 与 strict hydrate 门禁。 */
  storageMode?: StorageMode;
}

export interface CommitCurrentFloorTemplateChangesResult_ACU {
  saved: boolean;
  mode?: 'template_only' | 'scope_only' | 'v2_commit';
  messageIndex?: number;
  checkpoints?: TableSheetCheckpointV2_ACU[];
  removedNullRowCount?: number;
  deletedSheetKeys?: string[];
  purgedMessageCount?: number;
  error?: string;
}

export interface CommitCurrentFloorTemplateScopeOnlyOptions_ACU {
  isolationKey?: string;
  baselineData: TableDataObject_ACU;
  candidateData: TableDataObject_ACU;
  guideData: Record<string, any>;
  templateSource: any;
  presetName?: string;
  source?: string;
  reason?: string;
  createdAt?: number;
  expectedChatIdentity?: string;
  expectedFirstMessage?: unknown;
  signal?: AbortSignal;
}

function assertTemplateCommitChatContext_ACU(expectedChat: unknown[], options: { expectedChatIdentity?: string; expectedFirstMessage?: unknown; signal?: AbortSignal }): void {
  if (options.signal?.aborted) throw new Error('模板提交已取消。');
  const activeChat = getChatArray_ACU();
  if (!Array.isArray(activeChat) || activeChat.length === 0) throw new Error('目标聊天已切换，已取消模板提交。');
  if (options.expectedFirstMessage && (expectedChat[0] !== options.expectedFirstMessage || activeChat[0] !== options.expectedFirstMessage)) {
    throw new Error('目标聊天已切换，已取消模板提交。');
  }
  if (options.expectedChatIdentity && getActiveChatStorageIdentity_ACU(activeChat) !== options.expectedChatIdentity) {
    throw new Error('目标聊天已切换，已取消模板提交。');
  }
}

type TemplatePersistOperation_ACU = Extract<TableMutationOperationV2_ACU, {
  kind: 'sheet_schema_migrate' | 'meta_update';
}>;

export type TemplateSheetChange_ACU =
  | {
    kind: 'introduction';
    sheetKey: string;
    sheetData: Sheet_ACU;
  }
  | {
    kind: 'rebase';
    sheetKey: string;
    sheetData: Sheet_ACU;
  }
  | {
    kind: 'reveal';
    sheetKey: string;
    sheetData: Sheet_ACU;
  }
  | {
    kind: 'hide';
    sheetKey: string;
    sheetData: Sheet_ACU;
  }
  | {
    kind: 'operations';
    sheetKey: string;
    targetSheetData: Sheet_ACU;
    operations: TemplatePersistOperation_ACU[];
  };

export type NullRowCleanupPersistStatus_ACU =
  | 'persisted'
  | 'skipped_no_changes'
  | 'skipped_no_target'
  | 'skipped_no_anchor'
  | 'skipped_no_v2_target'
  | 'skipped_invalid_data'
  | 'failed';

export interface PersistNullRowCleanupShardsOptions_ACU {
  sheetDataByKey: Record<string, Sheet_ACU>;
  isolationKey?: string;
  createdAt?: number;
}

export interface PersistNullRowCleanupShardsResult_ACU {
  status: NullRowCleanupPersistStatus_ACU;
  messageIndex?: number;
  checkpoints?: TableSheetCheckpointV2_ACU[];
  error?: string;
}

function safeJsonByteLength_ACU(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function cloneOptionalJson_ACU<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function countOperationUnits_ACU(operations: unknown[]): number {
  return operations.reduce<number>((sum, operation: any) => {
    if ((operation?.kind === 'sql_batch' || operation?.kind === 'sql_sheet_batch') && Array.isArray(operation.statements)) return sum + operation.statements.length;
    if (operation?.kind === 'data_replace' || operation?.kind === 'sheet_replace') return sum + 1;
    return sum + 1;
  }, 0);
}

function normalizePositiveIntegerSetting_ACU(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 1 ? Math.floor(num) : fallback;
}

export function resolveCheckpointGenerationConfig_ACU(): TableCheckpointGenerationConfig_ACU {
  // 单一保留边界 checkpoint 策略下，运行期 full checkpoint 不再由用户阈值触发。
  // 这里保留 status shape 给旧调用方读取日志统计，但这些值不再参与写入判定。
  const maxOperationKbAfterCheckpoint = Number.MAX_SAFE_INTEGER;
  const cumulativeOperationRatioPercent = 100;
  const singleOperationRatioPercent = 100;

  return {
    maxEntriesAfterCheckpoint: Number.MAX_SAFE_INTEGER,
    maxOperationKbAfterCheckpoint,
    maxOperationBytesAfterCheckpoint: maxOperationKbAfterCheckpoint * 1024,
    maxOperationCountAfterCheckpoint: Number.MAX_SAFE_INTEGER,
    cumulativeOperationRatioPercent,
    singleOperationRatioPercent,
    cumulativeOperationRatio: cumulativeOperationRatioPercent / 100,
    singleOperationRatio: singleOperationRatioPercent / 100,
  };
}

function deepClone_ACU<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function generateEntryId_ACU(): string {
  return `v2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildCommitRevision_ACU(seq: number | 'checkpoint', entryId: string): string {
  return `${seq}:${entryId}`;
}

type AppendMutationLogEntryOptions_ACU = Omit<TableMutationLogEntryV2_ACU,
  'seq' | 'entryId' | 'parentRevision' | 'commitRevision'> & {
  seq: number;
  parentRevision?: string | null;
};

function appendMutationLogEntry_ACU(
  frame: TableStorageFrameV2_ACU,
  options: AppendMutationLogEntryOptions_ACU,
): TableMutationLogEntryV2_ACU {
  const entryId = generateEntryId_ACU();
  const parentRevision = options.parentRevision !== undefined
    ? options.parentRevision
    : (frame.headRevision ?? null);
  const commitRevision = buildCommitRevision_ACU(options.seq, entryId);
  const entry: TableMutationLogEntryV2_ACU = {
    seq: options.seq,
    entryId,
    createdAt: options.createdAt,
    source: options.source,
    targetMessageIndex: options.targetMessageIndex,
    aiFloor: options.aiFloor,
    filledSheetKeys: options.filledSheetKeys,
    changedSheetKeys: options.changedSheetKeys,
    groupKeys: options.groupKeys,
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    ...(options.batchId !== undefined ? { batchId: options.batchId } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
    operations: options.operations,
    baseRevision: options.baseRevision,
    parentRevision,
    commitRevision,
    ...(options.writeSet !== undefined ? { writeSet: options.writeSet } : {}),
  };
  frame.logEntries.push(entry);
  frame.headRevision = commitRevision;
  return entry;
}

function findTargetAiMessage_ACU(chat: any[], targetMessageIndex: number | undefined): { message: any; index: number } | null {
  if (targetMessageIndex !== undefined && targetMessageIndex !== -1) {
    const message = chat[targetMessageIndex];
    if (message && !message.is_user) {
      return { message, index: targetMessageIndex };
    }
    return null;
  }

  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (chat[i] && !chat[i].is_user) {
      return { message: chat[i], index: i };
    }
  }

  return null;
}

function normalizeIncrementalReplacement_ACU(
  replacement: ReplaceExistingIncrementalOptions_ACU | undefined,
  targetMessageIndex: number,
  chat: any[],
): { targetMessageIndices: number[]; targetSheetKeys: string[] } | { error: string } | null {
  if (!replacement) return null;
  if (!Array.isArray(replacement.targetMessageIndices) || replacement.targetMessageIndices.length === 0) {
    return { error: 'V2 incremental replacement requires non-empty targetMessageIndices.' };
  }
  if (!Array.isArray(replacement.targetSheetKeys) || replacement.targetSheetKeys.length === 0) {
    return { error: 'V2 incremental replacement requires non-empty targetSheetKeys.' };
  }
  const targetMessageIndices = replacement.targetMessageIndices.map(Number);
  if (targetMessageIndices.some(index => !Number.isInteger(index) || index < 0 || index >= chat.length)
    || new Set(targetMessageIndices).size !== targetMessageIndices.length
    || !targetMessageIndices.includes(targetMessageIndex)
    || targetMessageIndices.some(index => !chat[index] || chat[index].is_user)) {
    return { error: 'V2 incremental replacement targetMessageIndices must contain unique existing AI message indices including the persist target.' };
  }
  const targetSheetKeys = replacement.targetSheetKeys.map(sheetKey => String(sheetKey || '').trim());
  if (targetSheetKeys.some(sheetKey => !sheetKey.startsWith('sheet_'))
    || new Set(targetSheetKeys).size !== targetSheetKeys.length) {
    return { error: 'V2 incremental replacement targetSheetKeys must contain unique sheet_ keys.' };
  }
  return { targetMessageIndices, targetSheetKeys };
}

function collectReplacementSqlTableNames_ACU(
  chat: any[],
  isolationKey: string,
  targetMessageIndices: number[],
  targetSheetKeys: string[],
): Set<string> {
  const maxTargetMessageIndex = Math.max(...targetMessageIndices);
  const sheetKeySet = new Set(targetSheetKeys);
  const knownSqlTableNames = new Set<string>();
  for (let index = 0; index <= maxTargetMessageIndex; index += 1) {
    const tagData = readIsolatedTagData_ACU(chat[index], isolationKey);
    if (!isV2TagData_ACU(tagData)) continue;
    collectSqlTargetTableNamesFromStorageFrameV2_ACU(tagData.storageFrame, sheetKeySet)
      .forEach(tableName => knownSqlTableNames.add(tableName));
  }
  return knownSqlTableNames;
}

function countAiFloor_ACU(chat: any[], messageIndex: number): number {
  let count = 0;
  for (let i = 0; i <= messageIndex && i < chat.length; i += 1) {
    if (chat[i] && !chat[i].is_user) count += 1;
  }
  return count;
}

/**
 * 判断目标楼层及之前是否存在可作为回放锚点的 full checkpoint。
 *
 * 缺少锚点时本次写入会被 persist 层视为初始 full checkpoint，
 * 调用方必须只提交 afterData 快照、不得附带 operations。
 */
export function hasAnyV2Checkpoint_ACU(chat: any[], isolationKey: string, maxMessageIndex = chat.length - 1): boolean {
  return chat.slice(0, Math.max(0, maxMessageIndex + 1)).some(message => {
    const tagData = message?.TavernDB_ACU_IsolatedData?.[isolationKey];
    return isV2TagData_ACU(tagData) && tagData.storageFrame.checkpoint?.kind === 'full';
  });
}

function hasAnyV2Frame_ACU(chat: any[], isolationKey: string, maxMessageIndex = chat.length - 1): boolean {
  return chat.slice(0, Math.max(0, maxMessageIndex + 1)).some(message => {
    const tagData = message?.TavernDB_ACU_IsolatedData?.[isolationKey];
    return isV2TagData_ACU(tagData);
  });
}

function projectReplayComparableData_ACU(data: TableDataObject_ACU): TableDataObject_ACU {
  const projected = deepClone_ACU(data);
  for (const [key, value] of Object.entries(projected)) {
    if (!key.startsWith('sheet_') || !isObjectRecord_ACU(value)) continue;
    delete (value as Record<string, any>).seedRows;
  }
  return projected;
}

async function verifyTemporaryBaselineUpgrade_ACU(
  replayData: TableDataObject_ACU,
  operations: TableMutationOperationV2_ACU[],
  afterData: TableDataObject_ACU,
): Promise<boolean> {
  const expected = deepClone_ACU(replayData);
  for (const operation of operations) await applyTableOperationV2_ACU(expected, operation);
  return getTableDataFingerprint_ACU(projectReplayComparableData_ACU(expected))
    === getTableDataFingerprint_ACU(projectReplayComparableData_ACU(afterData));
}

function buildCandidateChatWithIsolatedDataOverrides_ACU(
  chat: any[],
  isolatedDataByMessageIndex: Map<number, Record<string, any>>,
): any[] {
  return chat.map((message, messageIndex) => {
    const isolatedData = isolatedDataByMessageIndex.get(messageIndex);
    return isolatedData === undefined
      ? message
      : { ...message, TavernDB_ACU_IsolatedData: isolatedData };
  });
}

async function validateTemporaryBaselineUpgradeCandidate_ACU(
  candidateChat: any[],
  isolationKey: string,
  targetMessageIndex: number,
  afterData: TableDataObject_ACU,
): Promise<string | null> {
  const validateReplay = async (
    scope: 'boundary' | 'suffix',
    options: { maxMessageIndex?: number },
  ): Promise<string | null> => {
    let replay;
    try {
      replay = await loadTableStateFromFramesV2Detailed_ACU(candidateChat, isolationKey, {
        ...options,
        updateRuntimeState: false,
        compatibilityMode: 'disabled',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `V2 candidate_${scope}_replay_failed: ${message}`;
    }
    if (!replay || replay.baseKind !== 'full_checkpoint') {
      return `V2 candidate_${scope}_replay_failed: 未能从正式 full checkpoint 建立回放基底。`;
    }
    if (replay.requiresCheckpointConvergence || replay.compatibilityRepairs?.length) {
      return `V2 candidate_requires_convergence: ${scope} replay 仍依赖临时 Sheet 补锚。`;
    }
    if (scope === 'boundary'
      && getTableDataFingerprint_ACU(projectReplayComparableData_ACU(replay.data))
        !== getTableDataFingerprint_ACU(projectReplayComparableData_ACU(afterData))) {
      return 'V2 candidate_boundary_replay_failed: checkpoint 边界回放结果与 afterData 不一致。';
    }
    return null;
  };

  return await validateReplay('boundary', { maxMessageIndex: targetMessageIndex })
    || await validateReplay('suffix', {});
}

export function getLatestTableStorageHeadRevisionV2_ACU(chat: any[] | null | undefined, isolationKey: string): string | null {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  let headRevision: string | null = null;
  for (const message of chat) {
    const tagData = message?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (isV2TagData_ACU(tagData)) {
      headRevision = tagData.storageFrame.headRevision ?? headRevision;
    }
  }
  return headRevision;
}

function findLatestFullCheckpoint_ACU(
  chat: any[] | null | undefined,
  isolationKey: string,
): { message: any; index: number; checkpoint: TableCheckpointV2_ACU } | null {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const tagData = chat[i]?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (isV2TagData_ACU(tagData) && tagData.storageFrame.checkpoint?.kind === 'full') {
      return { message: chat[i], index: i, checkpoint: tagData.storageFrame.checkpoint };
    }
  }
  return null;
}

function getLogEntriesAfterLatestCheckpoint_ACU(chat: any[], isolationKey: string): TableMutationLogEntryV2_ACU[] {
  const latestCheckpoint = findLatestFullCheckpoint_ACU(chat, isolationKey);
  const latestCheckpointIndex = latestCheckpoint?.index ?? -1;
  const entries: TableMutationLogEntryV2_ACU[] = [];
  for (let i = Math.max(0, latestCheckpointIndex); i < chat.length; i += 1) {
    const tagData = chat[i]?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (isV2TagData_ACU(tagData)) {
      entries.push(...(tagData.storageFrame.logEntries || []));
    }
  }
  return entries;
}

export function collectCheckpointGenerationStatusV2_ACU(
  chat: any[] | null | undefined,
  isolationKey: string,
  currentData?: TableDataObject_ACU | null,
): TableCheckpointGenerationStatus_ACU {
  const config = resolveCheckpointGenerationConfig_ACU();
  const safeChat = Array.isArray(chat) ? chat : [];
  const latestCheckpoint = findLatestFullCheckpoint_ACU(safeChat, isolationKey);
  const previousEntries = getLogEntriesAfterLatestCheckpoint_ACU(safeChat, isolationKey);
  const previousOperations = previousEntries.flatMap(entry => entry.operations || []);
  const fullCheckpointSource = currentData || latestCheckpoint?.checkpoint?.data || {};
  const fullCheckpointBytes = Math.max(1, safeJsonByteLength_ACU(fullCheckpointSource));
  const cumulativeOperationBytes = safeJsonByteLength_ACU(previousOperations);
  const cumulativeOperationCount = countOperationUnits_ACU(previousOperations);

  return {
    ...(latestCheckpoint ? {
      latestCheckpointMessageIndex: latestCheckpoint.index,
      latestCheckpointAiFloor: countAiFloor_ACU(safeChat, latestCheckpoint.index),
    } : {}),
    entryCountAfterCheckpoint: previousEntries.length,
    cumulativeOperationBytes,
    cumulativeOperationCount,
    fullCheckpointBytes,
    nextWriteKind: latestCheckpoint ? 'incremental' : 'full',
    config,
  };
}

function normalizeKeys_ACU(keys: string[] | null | undefined, data?: TableDataObject_ACU): string[] {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter(key => typeof key === 'string' && key.startsWith('sheet_') && (!data || Boolean(data[key]))))];
}

function collectScopedAfterDataSheetKeys_ACU(options: PersistTableMutationV2Options_ACU): string[] | null {
  const keys = new Set<string>();
  const addKeys = (values: unknown): void => {
    if (!Array.isArray(values)) return;
    values.forEach(value => {
      if (typeof value === 'string' && value.startsWith('sheet_')) keys.add(value);
    });
  };
  addKeys(options.filledSheetKeys);
  addKeys(options.candidateChangedSheetKeys);
  addKeys(options.groupKeys);
  addKeys(options.replaceExistingIncremental?.targetSheetKeys);

  for (const operation of options.operations || []) {
    if (!operation || typeof operation !== 'object') return null;
    switch (operation.kind) {
      case 'sql_sheet_batch':
      case 'row_upsert':
      case 'row_delete':
      case 'meta_update':
      case 'sheet_schema_migrate':
      case 'sheet_replace': {
        const sheetKey = operation.sheetKey;
        if (typeof sheetKey !== 'string' || !sheetKey.startsWith('sheet_')) return null;
        keys.add(sheetKey);
        break;
      }
      case 'data_replace':
      case 'sql_batch':
      case 'table_edit_dsl':
      default:
        // 未知 operation 不能因“碰巧带 sheetKey”就被推断为单表语义。
        return null;
    }
  }
  return [...keys];
}

function clonePersistAfterData_ACU(
  options: PersistTableMutationV2Options_ACU,
  requiresFullSnapshot: boolean,
): TableDataObject_ACU {
  if (requiresFullSnapshot) return deepClone_ACU(options.afterData);
  const sheetKeys = collectScopedAfterDataSheetKeys_ACU(options);
  if (sheetKeys === null) return deepClone_ACU(options.afterData);
  const projected: TableDataObject_ACU = {} as TableDataObject_ACU;
  if (Object.prototype.hasOwnProperty.call(options.afterData, 'mate')) {
    (projected as any).mate = deepClone_ACU((options.afterData as any).mate);
  }
  sheetKeys.forEach(sheetKey => {
    if (Object.prototype.hasOwnProperty.call(options.afterData, sheetKey)) {
      (projected as any)[sheetKey] = deepClone_ACU((options.afterData as any)[sheetKey]);
    }
  });
  return projected;
}

function normalizeOperations_ACU(
  operations: TableMutationOperationV2_ACU[] | null | undefined,
  afterData: TableDataObject_ACU,
  source: TableMutationSourceV2_ACU,
  allowImportDataReplaceFallback: boolean,
): TableMutationOperationV2_ACU[] {
  if (Array.isArray(operations) && operations.length > 0) {
    return deepClone_ACU(operations);
  }
  if (source === 'import' && allowImportDataReplaceFallback) {
    return [{
      kind: 'data_replace',
      data: deepClone_ACU(afterData),
      reason: 'import',
    }];
  }
  return [];
}

function getOrInitV2Frame_ACU(isolatedData: Record<string, any>, isolationKey: string): TableStorageFrameV2_ACU {
  const tagData = isolatedData[isolationKey];
  if (isV2TagData_ACU(tagData)) {
    return tagData.storageFrame;
  }

  const nextTagData: any = {
    storageFrame: {
      version: 2,
      logEntries: [],
    },
    _acu_storage_version: 2,
  };

  if (tagData?.summaryVectorIndexState !== undefined) {
    nextTagData.summaryVectorIndexState = tagData.summaryVectorIndexState;
  }
  if (tagData?.summaryVectorIndexManifest !== undefined) {
    nextTagData.summaryVectorIndexManifest = tagData.summaryVectorIndexManifest;
  }

  isolatedData[isolationKey] = nextTagData;
  return nextTagData.storageFrame;
}

function isObjectRecord_ACU(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type TemplateCommitStorageState_ACU =
  | { kind: 'pristine_without_checkpoint' }
  | { kind: 'existing_full_checkpoint'; checkpoint: { message: any; index: number; checkpoint: TableCheckpointV2_ACU } }
  | { kind: 'legacy_persisted_data'; details: string[] }
  | { kind: 'orphan_v2_artifacts'; details: string[] };

function classifyTemplateCommitStorageState_ACU(
  chat: any[],
  isolationKey: string,
): TemplateCommitStorageState_ACU {
  const legacyDetails: string[] = [];
  const v2FrameWithoutCheckpointDetails: string[] = [];
  const orphanDetails: string[] = [];
  let latestCheckpoint: { message: any; index: number; checkpoint: TableCheckpointV2_ACU } | null = null;
  const isolationConfig = {
    enabled: settings_ACU.dataIsolationEnabled,
    code: settings_ACU.dataIsolationCode,
  };

  for (let index = 0; index < chat.length; index += 1) {
    const message = chat[index];
    if (!message || message.is_user) continue;
    const tagData = readIsolatedTagData_ACU(message, isolationKey) as any;
    if (isLegacyV1TagData_ACU(tagData) || hasLegacyTopLevelTableData_ACU(message, isolationConfig)) {
      legacyDetails.push(`message#${index}`);
      continue;
    }
    if (isV2TagData_ACU(tagData)) {
      if (tagData.storageFrame.checkpoint?.kind === 'full') {
        latestCheckpoint = { message, index, checkpoint: tagData.storageFrame.checkpoint };
      } else {
        v2FrameWithoutCheckpointDetails.push(`message#${index}: V2 storage frame has no full checkpoint`);
      }
      continue;
    }
    if (hasV2HistoryMarker_ACU(tagData)) {
      orphanDetails.push(`message#${index}: malformed V2 storage marker`);
    }
  }

  if (legacyDetails.length > 0) return { kind: 'legacy_persisted_data', details: legacyDetails };
  if (latestCheckpoint) return { kind: 'existing_full_checkpoint', checkpoint: latestCheckpoint };
  if (v2FrameWithoutCheckpointDetails.length > 0) {
    return { kind: 'orphan_v2_artifacts', details: [...v2FrameWithoutCheckpointDetails, ...orphanDetails] };
  }
  if (orphanDetails.length > 0) return { kind: 'orphan_v2_artifacts', details: orphanDetails };
  return { kind: 'pristine_without_checkpoint' };
}

function classifyTemplateCommitStorageStateAfterDeletedSheets_ACU(
  chat: any[],
  isolationKey: string,
  deletedSheetKeys: string[],
): TemplateCommitStorageState_ACU {
  if (deletedSheetKeys.length === 0) return classifyTemplateCommitStorageState_ACU(chat, isolationKey);
  const simulatedChat = deepClone_ACU(chat);
  for (const message of simulatedChat) {
    if (message && !message.is_user) purgeSheetKeysFromMessage_ACU(message, deletedSheetKeys);
  }
  return classifyTemplateCommitStorageState_ACU(simulatedChat, isolationKey);
}


function isPlainObjectRecord_ACU(value: unknown): value is Record<string, any> {
  if (!isObjectRecord_ACU(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function logEntryConflictsWithSheetCheckpoint_ACU(entry: TableMutationLogEntryV2_ACU, sheetKey: string): boolean {
  if ([...(entry.filledSheetKeys || []), ...(entry.changedSheetKeys || []), ...(entry.groupKeys || [])].includes(sheetKey)) {
    return true;
  }

  for (const operation of entry.operations || []) {
    if (operation.kind === 'data_replace' || operation.kind === 'sql_batch' || operation.kind === 'table_edit_dsl') {
      return true;
    }
    if ('sheetKey' in operation && operation.sheetKey === sheetKey) {
      return true;
    }
  }

  return (entry.patches || []).some(patch => patch.sheetKey === sheetKey);
}

function getValidatedFrameLastLogSeq_ACU(frame: TableStorageFrameV2_ACU): number {
  let previousSeq = -1;
  for (const [index, entry] of frame.logEntries.entries()) {
    const seq = entry?.seq;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(`V2 当前楼层模板提交包含非法 log seq: index=${index}, seq=${String(seq)}。`);
    }
    if (seq <= previousSeq) {
      throw new Error(`V2 当前楼层模板提交要求 log seq 唯一且严格递增: previous=${previousSeq}, current=${seq}。`);
    }
    previousSeq = seq;
  }
  return Math.max(0, previousSeq);
}

function checkpointDataContainsSheet_ACU(checkpoint: TableCheckpointV2_ACU | null | undefined, sheetKey: string): boolean {
  return Boolean(checkpoint?.data && Object.prototype.hasOwnProperty.call(checkpoint.data, sheetKey));
}

function recordContainsSheet_ACU(value: unknown, sheetKey: string): boolean {
  return isObjectRecord_ACU(value) && Object.prototype.hasOwnProperty.call(value, sheetKey);
}

function hasV2HistoryMarker_ACU(tagData: unknown): boolean {
  return hasV2TableHistoryEvidence_ACU(tagData);
}

const CHECKPOINT_REASONS_FOR_INTRODUCTION_HISTORY_ACU = new Set([
  'init', 'periodic', 'manual', 'schema_change', 'compaction', 'import', 'migration', 'integrity_repair',
]);

function isFiniteNonNegativeNumber_ACU(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNonNegativeInteger_ACU(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

const MUTATION_SOURCES_FOR_INTRODUCTION_HISTORY_ACU = new Set<TableMutationSourceV2_ACU>([
  'auto_fill', 'manual_fill', 'group_fill', 'manual_crud', 'raw_sql_mutation', 'raw_sql_batch', 'import', 'merge_summary', 'template_assistant', 'system',
]);

function isStringArray_ACU(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function eventIsValidForIntroductionHistory_ACU(value: unknown): boolean {
  return value === undefined || (
    isObjectRecord_ACU(value)
    && isStringArray_ACU(value.filledSheetKeys)
    && isStringArray_ACU(value.changedSheetKeys)
    && (value.groupKeys === undefined || isStringArray_ACU(value.groupKeys))
    && (value.requestId === undefined || typeof value.requestId === 'string')
    && (value.batchId === undefined || typeof value.batchId === 'string')
    && (value.error === undefined || typeof value.error === 'string')
  );
}

function scheduleSummaryIsValidForIntroductionHistory_ACU(value: unknown): boolean {
  return value === undefined || (
    isObjectRecord_ACU(value)
    && Object.values(value).every(summary => isObjectRecord_ACU(summary)
      && (summary.lastFilledAiFloor === undefined || isFiniteNonNegativeNumber_ACU(summary.lastFilledAiFloor))
      && (summary.lastChangedAiFloor === undefined || isFiniteNonNegativeNumber_ACU(summary.lastChangedAiFloor)))
  );
}

function manualRefillProgressIsValidForIntroductionHistory_ACU(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObjectRecord_ACU(value) || value.kind !== 'manual_refill') return false;
  const legacyStatus = value.status === 'in_progress' || value.status === 'complete';
  const commonFieldsAreValid = isStringArray_ACU(value.selectedSheetKeys)
    && Array.isArray(value.contextMessageIndices) && value.contextMessageIndices.every(Number.isInteger)
    && ['originalStartMessageIndex', 'targetMessageIndex', 'batchSize', 'completedUntilMessageIndex', 'updatedAt']
      .every(key => isFiniteNonNegativeNumber_ACU(value[key]))
    && (value.completedSheetMessageIndexByKey === undefined || (
      isObjectRecord_ACU(value.completedSheetMessageIndexByKey)
      && Object.values(value.completedSheetMessageIndexByKey).every(Number.isInteger)
    ));
  if (!commonFieldsAreValid) return false;
  if (value.version === undefined) return legacyStatus;
  return value.version === 2
    && ['planned', 'collecting', 'committing', 'committed', 'stopped', 'failed', 'sync_pending', 'complete'].includes(value.status)
    && typeof value.runId === 'string' && value.runId.length > 0
    && (value.mode === 'refill' || value.mode === 'catch_up')
    && isFiniteNonNegativeNumber_ACU(value.targetAiFloor)
    && typeof value.planSignature === 'string'
    && ['waveIndex', 'bucketIndex', 'totalWaves', 'totalBuckets'].every(key => isFiniteNonNegativeInteger_ACU(value[key]))
    && (value.lastError === undefined || typeof value.lastError === 'string');
}

function timelineIsValidForIntroductionHistory_ACU(value: unknown): boolean {
  return value === undefined || (
    isObjectRecord_ACU(value)
    && (value.kind === 'sheet_introduction' || value.kind === 'sheet_rebase')
    && Number.isInteger(value.activateAtMessageIndex) && value.activateAtMessageIndex >= 0
    && Number.isInteger(value.afterSeq) && value.afterSeq >= 0
  );
}

function sheetIsValidForIntroductionHistory_ACU(value: unknown): boolean {
  return isObjectRecord_ACU(value)
    && typeof value.uid === 'string'
    && typeof value.name === 'string'
    && isObjectRecord_ACU(value.sourceData)
    && Array.isArray(value.content)
    && value.content.every(row => Array.isArray(row) && row.every(cell => cell === null || typeof cell === 'string'))
    && isObjectRecord_ACU(value.updateConfig)
    && isObjectRecord_ACU(value.exportConfig)
    && typeof value.orderNo === 'number' && Number.isFinite(value.orderNo);
}

function schemaDescriptorIsValidForIntroductionHistory_ACU(value: unknown, version: 1 | 2): boolean {
  if (!isObjectRecord_ACU(value)
    || value.descriptorVersion !== version
    || !['uid', 'tableName', 'ddl', 'normalizedSql', 'tableSuffix'].every(key => typeof value[key] === 'string')
    || !Array.isArray(value.headers) || !value.headers.every(header => header === null || typeof header === 'string')
    || !isStringArray_ACU(value.tableConstraints)
    || !Array.isArray(value.columns)
  ) return false;

  return value.columns.every(column => isObjectRecord_ACU(column)
    && isFiniteNonNegativeInteger_ACU(column.index)
    && ['physicalName', 'displayHeader', 'normalizedDefinition'].every(key => typeof column[key] === 'string')
    && (version === 1 || column.defaultExpression === null || typeof column.defaultExpression === 'string'));
}

function migrationIsValidForIntroductionHistory_ACU(operation: Record<string, any>): boolean {
  if (typeof operation.sheetKey !== 'string'
    || ![1, 2].includes(operation.contractVersion)
    || typeof operation.beforeSchemaDigest !== 'string'
    || typeof operation.targetSchemaDigest !== 'string'
    || !schemaDescriptorIsValidForIntroductionHistory_ACU(operation.beforeSchema, operation.contractVersion)
    || !schemaDescriptorIsValidForIntroductionHistory_ACU(operation.targetSchema, operation.contractVersion)
  ) return false;

  if (operation.contractVersion === 1) {
    return Array.isArray(operation.columnChanges)
      && operation.columnChanges.every(change => isObjectRecord_ACU(change)
        && ['rename_display', 'add', 'drop'].includes(change.kind)
        && typeof change.physicalName === 'string'
        && ((change.kind === 'rename_display' && typeof change.fromHeader === 'string' && typeof change.toHeader === 'string')
          || (change.kind === 'add' && typeof change.header === 'string' && isFiniteNonNegativeInteger_ACU(change.index))
          || (change.kind === 'drop' && typeof change.header === 'string' && isFiniteNonNegativeInteger_ACU(change.index))))
      && isObjectRecord_ACU(operation.migrationPolicy)
      && typeof operation.migrationPolicy.destructiveChangeConfirmed === 'boolean';
  }

  return Array.isArray(operation.physicalColumnMappings)
    && operation.physicalColumnMappings.every(mapping => isObjectRecord_ACU(mapping)
      && typeof mapping.fromPhysicalName === 'string' && typeof mapping.toPhysicalName === 'string')
    && isObjectRecord_ACU(operation.fills)
    && Array.isArray(operation.conversions)
    && operation.conversions.every(conversion => isObjectRecord_ACU(conversion)
      && typeof conversion.fromPhysicalName === 'string'
      && typeof conversion.toPhysicalName === 'string'
      && isObjectRecord_ACU(conversion.policy)
      && ['identity', 'stringify', 'integer_strict', 'real_strict'].includes(conversion.policy.kind))
    && isObjectRecord_ACU(operation.dryRun)
    && ['convertedRowCount', 'failedRowCount', 'lossyRowCount'].every(key => isFiniteNonNegativeInteger_ACU(operation.dryRun[key]))
    && isObjectRecord_ACU(operation.migrationPolicy)
    && typeof operation.migrationPolicy.destructiveChangeConfirmed === 'boolean'
    && typeof operation.migrationPolicy.lossyConversionConfirmed === 'boolean';
}

function logEntryIsValidForIntroductionHistory_ACU(value: unknown): value is Record<string, any> {
  return isObjectRecord_ACU(value)
    && isFiniteNonNegativeInteger_ACU(value.seq)
    && typeof value.entryId === 'string'
    && isFiniteNonNegativeNumber_ACU(value.createdAt)
    && typeof value.source === 'string' && MUTATION_SOURCES_FOR_INTRODUCTION_HISTORY_ACU.has(value.source as TableMutationSourceV2_ACU)
    && isFiniteNonNegativeInteger_ACU(value.targetMessageIndex)
    && isFiniteNonNegativeInteger_ACU(value.aiFloor)
    && eventIsValidForIntroductionHistory_ACU(value)
    && Array.isArray(value.operations)
    && (value.baseRevision === undefined || value.baseRevision === null || typeof value.baseRevision === 'string')
    && (value.parentRevision === undefined || value.parentRevision === null || typeof value.parentRevision === 'string')
    && (value.commitRevision === undefined || typeof value.commitRevision === 'string');
}

function checkpointIsValidForIntroductionHistory_ACU(value: unknown): value is TableCheckpointV2_ACU {
  return isObjectRecord_ACU(value)
    && value.kind === 'full'
    && isFiniteNonNegativeNumber_ACU(value.createdAt)
    && typeof value.reason === 'string' && CHECKPOINT_REASONS_FOR_INTRODUCTION_HISTORY_ACU.has(value.reason)
    && isObjectRecord_ACU(value.data)
    && scheduleSummaryIsValidForIntroductionHistory_ACU(value.scheduleSummary)
    && eventIsValidForIntroductionHistory_ACU(value.event)
    && manualRefillProgressIsValidForIntroductionHistory_ACU(value.manualRefillProgress);
}

function sheetCheckpointMapIsValidForIntroductionHistory_ACU(value: unknown): value is Record<string, TableSheetCheckpointV2_ACU> {
  return isObjectRecord_ACU(value)
    && Object.entries(value).every(([sheetKey, checkpoint]) => (
      sheetKey.startsWith('sheet_')
      && isObjectRecord_ACU(checkpoint)
      && checkpoint.kind === 'sheet_full'
      && checkpoint.sheetKey === sheetKey
      && isFiniteNonNegativeNumber_ACU(checkpoint.createdAt)
      && typeof checkpoint.reason === 'string' && CHECKPOINT_REASONS_FOR_INTRODUCTION_HISTORY_ACU.has(checkpoint.reason)
      && isObjectRecord_ACU(checkpoint.data)
      && scheduleSummaryIsValidForIntroductionHistory_ACU(checkpoint.scheduleSummary)
      && eventIsValidForIntroductionHistory_ACU(checkpoint.event)
      && manualRefillProgressIsValidForIntroductionHistory_ACU(checkpoint.manualRefillProgress)
      && (checkpoint.baseRevision === undefined || checkpoint.baseRevision === null || typeof checkpoint.baseRevision === 'string')
      && timelineIsValidForIntroductionHistory_ACU(checkpoint.timeline)
    ));
}

function operationContainsOrCannotDisproveSheet_ACU(operation: unknown, sheetKey: string): boolean {
  if (!isObjectRecord_ACU(operation)) return true;
  switch (operation.kind) {
    case 'data_replace':
      return !isObjectRecord_ACU(operation.data) || recordContainsSheet_ACU(operation.data, sheetKey);
    case 'sql_sheet_batch':
      return typeof operation.sheetKey !== 'string'
        || !isStringArray_ACU(operation.statements)
        || (operation.params !== undefined && (!Array.isArray(operation.params)
          || !operation.params.every(params => Array.isArray(params)
            && params.every(value => value === null || typeof value === 'string' || typeof value === 'number'))))
        || (operation.tableName !== undefined && typeof operation.tableName !== 'string')
        || (operation.reason !== undefined && !['manual_crud', 'import', 'system'].includes(operation.reason))
        || operation.sheetKey === sheetKey;
    case 'sheet_replace':
      return typeof operation.sheetKey !== 'string'
        || !sheetIsValidForIntroductionHistory_ACU(operation.sheet)
        || !['manual_crud', 'import', 'system'].includes(operation.reason)
        || operation.sheetKey === sheetKey;
    case 'sheet_schema_migrate':
      return !migrationIsValidForIntroductionHistory_ACU(operation) || operation.sheetKey === sheetKey;
    case 'row_upsert':
      return typeof operation.sheetKey !== 'string'
        || typeof operation.rowId !== 'string'
        || !Array.isArray(operation.cells) || !operation.cells.every(value => value === null || typeof value === 'string')
        || operation.sheetKey === sheetKey;
    case 'row_delete':
      return typeof operation.sheetKey !== 'string'
        || typeof operation.rowId !== 'string'
        || operation.sheetKey === sheetKey;
    case 'meta_update':
      return typeof operation.sheetKey !== 'string'
        || !isObjectRecord_ACU(operation.meta)
        || operation.sheetKey === sheetKey;
    // sql_batch and table_edit_dsl are global replay operations; all unknown
    // kinds are future or malformed persisted contracts and must fail closed.
    default:
      return true;
  }
}

function patchContainsOrCannotDisproveSheet_ACU(patch: unknown, sheetKey: string): boolean {
  if (!isObjectRecord_ACU(patch)) return true;
  switch (patch.kind) {
    case 'sheet_replace':
      return typeof patch.sheetKey !== 'string'
        || !sheetIsValidForIntroductionHistory_ACU(patch.sheet)
        || !['schema_change', 'unstable_row_id', 'raw_sql_export', 'import', 'fallback'].includes(patch.reason)
        || patch.sheetKey === sheetKey;
    case 'row_upsert':
      return typeof patch.sheetKey !== 'string'
        || typeof patch.rowId !== 'string'
        || !Array.isArray(patch.cells) || !patch.cells.every(value => value === null || typeof value === 'string')
        || patch.sheetKey === sheetKey;
    case 'row_delete':
      return typeof patch.sheetKey !== 'string'
        || typeof patch.rowId !== 'string'
        || patch.sheetKey === sheetKey;
    case 'meta_update':
      return typeof patch.sheetKey !== 'string'
        || !isObjectRecord_ACU(patch.meta)
        || patch.sheetKey === sheetKey;
    default:
      return true;
  }
}

/**
 * Introduction shards can only represent genuinely new tables. This scans the
 * persisted V2 history rather than trusting the final replay state, because a
 * later data_replace may have removed a table that existed earlier.
 */
function historyContainsOrCannotDisproveSheet_ACU(
  chat: any[],
  isolationKey: string,
  maxMessageIndex: number,
  sheetKey: string,
): boolean {
  for (let messageIndex = 0; messageIndex <= maxMessageIndex; messageIndex += 1) {
    const tagData = chat[messageIndex]?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (!hasV2HistoryMarker_ACU(tagData)) continue;

    const frame = tagData.storageFrame as unknown;
    if (!isObjectRecord_ACU(frame) || frame.version !== 2 || !Array.isArray(frame.logEntries)) return true;
    if (frame.checkpoint !== undefined && !checkpointIsValidForIntroductionHistory_ACU(frame.checkpoint)) return true;
    if (checkpointDataContainsSheet_ACU(frame.checkpoint, sheetKey)) return true;
    if (frame.perSheetCheckpoints !== undefined && !sheetCheckpointMapIsValidForIntroductionHistory_ACU(frame.perSheetCheckpoints)) return true;
    if (recordContainsSheet_ACU(frame.perSheetCheckpoints, sheetKey)) return true;

    for (const entry of frame.logEntries) {
      if (!logEntryIsValidForIntroductionHistory_ACU(entry)) return true;

      for (const operation of entry.operations) {
        if (operationContainsOrCannotDisproveSheet_ACU(operation, sheetKey)) return true;
      }

      if (entry.patches === undefined) continue;
      if (!Array.isArray(entry.patches)) return true;
      for (const patch of entry.patches) {
        if (patchContainsOrCannotDisproveSheet_ACU(patch, sheetKey)) return true;
      }
    }
  }
  return false;
}
/**
 * 定位 reveal 数据来源（语义1：恢复"离开时最新状态"）。
 *
 * 关键数据安全约束：不取任何单一 checkpoint 的静态快照（可能是中间态/过期态），
 * 而是从 target.index 向前逐楼层做 bounded replay，找到该 sheet 仍可见的"最高楼层"，
 * 其 replay 结果即为该表最后一次可见时的完整状态。找不到任何可见状态则返回 null（fail closed）。
 */
async function locateRevealSourceSheetData_ACU(
  chat: any[],
  isolationKey: string,
  maxMessageIndex: number,
  sheetKey: string,
): Promise<Sheet_ACU | null> {
  for (let boundary = maxMessageIndex; boundary >= 0; boundary -= 1) {
    const tagData = chat[boundary]?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (!hasV2HistoryMarker_ACU(tagData)) continue;
    let replayed: Awaited<ReturnType<typeof loadTableStateFromFramesV2Detailed_ACU>> = null;
    try {
      replayed = await loadTableStateFromFramesV2Detailed_ACU(chat, isolationKey, {
        maxMessageIndex: boundary,
        updateRuntimeState: false,
        compatibilityMode: 'disabled',
      });
    } catch {
      // 该边界 replay 失败不代表更早边界不可用；继续向前寻找可信可见状态。
      continue;
    }
    if (replayed && Object.prototype.hasOwnProperty.call(replayed.data, sheetKey)) {
      const candidate = (replayed.data as Record<string, unknown>)[sheetKey];
      if (isObjectRecord_ACU(candidate)) {
        return deepClone_ACU(candidate) as Sheet_ACU;
      }
    }
  }
  return null;
}



function validateSheetCheckpointInput_ACU(
  options: PersistTableSheetCheckpointV2Options_ACU,
): { createdAt: number; reason: TableCheckpointV2_ACU['reason'] } | { error: string } {
  if (typeof options.sheetKey !== 'string' || !options.sheetKey.startsWith('sheet_')) {
    return { error: 'V2 sheet checkpoint requires a sheetKey beginning with "sheet_".' };
  }
  if (!isObjectRecord_ACU(options.sheetData)) {
    return { error: `V2 sheet checkpoint requires object sheetData for ${options.sheetKey}.` };
  }
  if (!options.reason) {
    return { error: 'V2 sheet checkpoint requires an explicit checkpoint reason.' };
  }
  const createdAt = options.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    return { error: 'V2 sheet checkpoint requires a finite non-negative createdAt.' };
  }
  return { createdAt, reason: options.reason };
}

async function persistTableMutationLogV2Core_ACU(
  options: PersistTableMutationV2Options_ACU,
): Promise<{ saved: boolean; messageIndex?: number; entry?: TableMutationLogEntryV2_ACU; error?: string }> {
  const chat = getChatArray_ACU();
  if (!chat || chat.length === 0) {
    return { saved: false, error: 'chat history is empty' };
  }

  const target = findTargetAiMessage_ACU(chat, options.targetMessageIndex);
  if (!target) {
    return { saved: false, error: 'no AI message found' };
  }

  options.transactionContext?.assertFresh?.('persistTableMutationLogV2:before_persist');
  if (!chat[target.index] || chat[target.index] !== target.message || target.message.is_user) {
    return { saved: false, error: 'target AI message changed before persist; abort stale table write.' };
  }

  const isolationKey = options.isolationKey ?? getCurrentIsolationKey_ACU();
  const replacementValidation = normalizeIncrementalReplacement_ACU(options.replaceExistingIncremental, target.index, chat);
  if (replacementValidation && 'error' in replacementValidation) {
    return { saved: false, error: replacementValidation.error };
  }
  const replacement = replacementValidation as { targetMessageIndices: number[]; targetSheetKeys: string[] } | null;
  const hasExistingCheckpoint = hasAnyV2Checkpoint_ACU(chat, isolationKey, target.index);
  const hasCheckpointAnywhere = hasAnyV2Checkpoint_ACU(chat, isolationKey);
  const requiresFullAfterData = !hasCheckpointAnywhere
    || (options.source === 'import' && (!Array.isArray(options.operations) || options.operations.length === 0));
  const afterData = clonePersistAfterData_ACU(options, requiresFullAfterData);
  const normalization = normalizeCanonicalTableRows_ACU(afterData);
  if (normalization.errors.length > 0) {
    return { saved: false, error: `V2 operation log snapshot 行标识不合法：${formatCanonicalRowIssues_ACU(normalization.errors)}` };
  }
  if (normalization.removedRows.length > 0) {
    return { saved: false, error: `V2 operation log snapshot 包含空 row_id 行，拒绝静默删除：${formatCanonicalRowIssues_ACU(normalization.removedRows)}` };
  }
  const filledSheetKeys = normalizeKeys_ACU(options.filledSheetKeys, afterData);
  const candidateChangedSheetKeys = normalizeKeys_ACU(options.candidateChangedSheetKeys, afterData);
  // 「本次是否首次初始化」必须看整个聊天，而不是只看目标楼层之前。
  // 对更早楼层填表（追平/重填）时，锚点可能位于更晚的楼层；
  // 只看之前会误判为首次初始化，从而又写一个 init full checkpoint，
  // 于是聊天里出现两个初始基线，回放只认最后一个，前面楼层的数据全部失效。
  const hasExistingV2Frame = hasAnyV2Frame_ACU(chat, isolationKey, target.index);
  const operations = normalizeOperations_ACU(options.operations, afterData, options.source, hasExistingCheckpoint);
  const effectiveChangedSheetKeys = candidateChangedSheetKeys;
  const hasFillSheets = filledSheetKeys.length > 0 || (Array.isArray(options.groupKeys) && options.groupKeys.length > 0);
  // A metadata-only fill is valid only when there is a real operation to
  // replay. Otherwise operations=[] plus group/filled keys advances the fill
  // gate without durable data (the historical fake-save bug).
  const hasMetadataOnlyFillEvent = operations.length > 0 && hasFillSheets;
  const hasManualRefillProgress = !!options.manualRefillProgress;
  const isManualRefillProgressOnly = operations.length === 0 && !hasFillSheets && hasManualRefillProgress;
  const latestFullCheckpoint = findLatestFullCheckpoint_ACU(chat, isolationKey);
  // Import-without-operations is a full afterData snapshot write, so it is
  // still a replay artifact for boundary ordering even though it is not a
  // metadata-only fill event.
  const writesReplayArtifact = operations.length > 0 || hasFillSheets || hasManualRefillProgress || replacement !== null
    || (options.source === 'import' && operations.length === 0);
  // V2 replay 只从最后一个 full checkpoint 开始。向该 checkpoint 之前写入任何
  // operation、填表事件或追平进度都会制造“保存成功但永远无法回放”的伪提交；不能等到
  // terminal progress-only 写入时才暴露问题。
  if (writesReplayArtifact && latestFullCheckpoint && latestFullCheckpoint.index > target.index) {
    return {
      saved: false,
      error: `V2 write target precedes the latest full checkpoint and would never replay: targetMessageIndex=${target.index}, latestFullCheckpointIndex=${latestFullCheckpoint.index}.`,
    };
  }
  const hasUnanchoredArtifacts = !hasCheckpointAnywhere
    && hasUnanchoredReplayArtifactsForChatV2_ACU(chat, isolationKey);
  let temporaryBaselineUpgrade = false;
  if (hasUnanchoredArtifacts && !isManualRefillProgressOnly) {
    const replay = await loadTableStateFromFramesV2Detailed_ACU(chat, isolationKey, {
      maxMessageIndex: target.index,
      updateRuntimeState: false,
      ...(options.performanceRunId ? { performanceRunId: options.performanceRunId } : {}),
      ...(options.performanceParentSpanId
        ? { performanceParentSpanId: options.performanceParentSpanId }
        : {}),
      allowTemporaryTemplateBaseline: true,
      compatibilityMode: 'disabled',
    });
    if (!replay || replay.baseKind !== 'temporary_template_baseline'
      || replay.requiresCheckpointConvergence || replay.compatibilityRepairs?.length) {
      return { saved: false, error: 'V2 boundary_replay_failed: 无锚点 artifacts 无法从当前聊天模板建立安全临时基线，已拒绝自动升级。' };
    }
    if (!await verifyTemporaryBaselineUpgrade_ACU(replay.data, operations, afterData)) {
      return { saved: false, error: 'V2 boundary_after_data_mismatch: 临时基线回放与本次 afterData 不一致，已拒绝建立 full checkpoint。' };
    }
    temporaryBaselineUpgrade = true;
  }
  if (!manualRefillProgressIsValidForIntroductionHistory_ACU(options.manualRefillProgress)) {
    return { saved: false, error: 'V2 manualRefillProgress 格式无效，已拒绝写入。' };
  }
  if (isManualRefillProgressOnly && !hasExistingCheckpoint) {
    return {
      saved: false,
      error: 'V2 manualRefillProgress-only write requires an existing full checkpoint anchor.',
    };
  }
  const initialCheckpointReason: TableCheckpointV2_ACU['reason'] = temporaryBaselineUpgrade
    ? 'integrity_repair'
    : (options.checkpointReason || (hasExistingV2Frame ? 'migration' : 'init'));
  // 同一隔离键下同一时刻只能存在一个 full checkpoint。
  //
  // 只要整个聊天已经有 full checkpoint，本次写入就只能追加增量，
  // 即使目标楼层在那个 checkpoint 之前也一样。回放只认最后一个 full checkpoint，
  // 多出来的基线会让它之前的所有增量失效（表现为「只有最后一层有数据」）。
  //
  // 这条对所有 source 一致：导入只可能带来「现有没有的表」，
  // 同一张表的差异只是列，新增列按空处理，不需要另立基线。
  const shouldCheckpoint = !hasCheckpointAnywhere
    && !isManualRefillProgressOnly
    && (temporaryBaselineUpgrade
      || initialCheckpointReason === 'init'
      || initialCheckpointReason === 'migration');
  if (shouldCheckpoint && operations.length > 0 && !temporaryBaselineUpgrade) {
    return { saved: false, error: 'V2 初始 full checkpoint 不接受 operations；请仅提交 afterData 快照。' };
  }

  const targetExistingTagData = cloneIsolatedData_ACU(target.message)?.[isolationKey];
  const targetExistingFrame = isV2TagData_ACU(targetExistingTagData)
    ? deepClone_ACU(targetExistingTagData.storageFrame)
    : null;
  const isolatedData = cloneIsolatedData_ACU(target.message) as Record<string, any>;
  const frame = getOrInitV2Frame_ACU(isolatedData, isolationKey);
  const replacementIsolatedDataByMessageIndex = new Map<number, Record<string, any>>();
  if (replacement) {
    const knownSqlTableNames = collectReplacementSqlTableNames_ACU(
      chat,
      isolationKey,
      replacement.targetMessageIndices,
      replacement.targetSheetKeys,
    );
    for (const messageIndex of replacement.targetMessageIndices) {
      const nextIsolatedData = messageIndex === target.index
        ? isolatedData
        : cloneIsolatedData_ACU(chat[messageIndex]) as Record<string, any>;
      const tagData = nextIsolatedData[isolationKey];
      if (!isV2TagData_ACU(tagData)) continue;
      if (purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU(
        tagData.storageFrame,
        new Set(replacement.targetSheetKeys),
        knownSqlTableNames,
      )) {
        replacementIsolatedDataByMessageIndex.set(messageIndex, nextIsolatedData);
      }
    }
  }
  const currentWriteSet = options.writeSet ?? options.transactionContext?.writeSet;
  const revisionWriteSet = options.revisionWriteSet;
  const requestedBaseRevision = options.baseRevision !== undefined
    ? options.baseRevision
    : options.transactionContext?.baseRevision;

  if (operations.length === 0 && !hasMetadataOnlyFillEvent && !hasManualRefillProgress && options.source !== 'import' && hasExistingCheckpoint) {
    return { saved: false, error: `V2 operation log requires explicit operations for source=${options.source}; snapshot diff fallback is not allowed.` };
  }

  if (options.forceCheckpoint && !shouldCheckpoint) {
    logWarn_ACU(`[V2 Persist] 单一保留边界 checkpoint 策略已忽略非初次 forceCheckpoint：reason=${options.checkpointReason || 'unspecified'}, source=${options.source}`);
  }

  if (options.manualRefillProgress) {
    frame.manualRefillProgress = deepClone_ACU(options.manualRefillProgress);
  }
  const shouldAppendLogEntry = operations.length > 0 || hasMetadataOnlyFillEvent;
  const now = Date.now();
  const aiFloor = countAiFloor_ACU(chat, target.index);
  let entry: TableMutationLogEntryV2_ACU | undefined;

  if (shouldCheckpoint) {
    const checkpointRevision = buildCommitRevision_ACU('checkpoint', generateEntryId_ACU());
    const checkpointEvent = {
      filledSheetKeys,
      changedSheetKeys: effectiveChangedSheetKeys,
      groupKeys: options.groupKeys || [],
      requestId: options.requestId,
      batchId: options.batchId,
      error: options.error,
    };
    const checkpointResult = buildCanonicalFullCheckpoint_ACU({
      createdAt: now,
      reason: initialCheckpointReason,
      data: afterData,
      scheduleSummary: collectScheduleSummaryFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: target.index }),
      event: checkpointEvent,
      context: { messageIndex: target.index, aiFloor, isolationKey },
    });
    if (!checkpointResult.checkpoint) {
      return { saved: false, error: checkpointResult.error };
    }
    frame.checkpoint = checkpointResult.checkpoint;
    frame.headRevision = checkpointRevision;
    frame.logEntries = [];
    delete frame.perSheetCheckpoints;
    if (temporaryBaselineUpgrade && targetExistingFrame) {
      const recoveryBackup: TableV2RecoveryBackup_ACU = {
        version: 1,
        createdAt: now,
        recoveryKind: 'temporary_template_baseline_upgrade',
        sourceMessageIndex: target.index,
        storageFrame: targetExistingFrame,
      };
      const tagData = isolatedData[isolationKey];
      if (tagData && typeof tagData === 'object' && !Array.isArray(tagData)) {
        tagData.recoveryBackup = recoveryBackup;
      }
    }
    logDebug_ACU(`[V2 Persist] 写入 full checkpoint: messageIndex=${target.index}, revision=${checkpointRevision}, sheets=${Object.keys(afterData).filter(k => k.startsWith('sheet_')).length}`);
  } else if (shouldAppendLogEntry) {
    // 目标表必须在追加 operation 前的 active replay state 中真实存在。仅仅曾在历史
    // checkpoint 出现过不够：sheet_hide / data_replace 都可能已将它移出 active state；
    // compatibility temporary anchor 也不是可供新写入依赖的持久化锚点。
    const operationSheetKeys = [...new Set(
      operations
        .map(operation => (operation as any)?.sheetKey)
        .filter((sheetKey: unknown): sheetKey is string => typeof sheetKey === 'string' && sheetKey.startsWith('sheet_')),
    )];
    if (operationSheetKeys.length > 0) {
      let replayBeforeAppend;
      try {
        replayBeforeAppend = await loadTableStateFromFramesV2Detailed_ACU(chat, isolationKey, {
          maxMessageIndex: target.index,
          updateRuntimeState: false,
          ...(options.performanceRunId ? { performanceRunId: options.performanceRunId } : {}),
          ...(options.performanceParentSpanId
            ? { performanceParentSpanId: options.performanceParentSpanId }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { saved: false, error: `V2 无法确认 operation 执行前的 active sheet state，已拒绝写入：${message}` };
      }
      const compatibilityOnlySheetKeys = new Set(
        (replayBeforeAppend?.compatibilityRepairs || []).map(repair => repair.sheetKey),
      );
      {
        const missingSheetKeys = operationSheetKeys.filter(
          sheetKey => Boolean((afterData as any)[sheetKey])
            && (!Object.prototype.hasOwnProperty.call(replayBeforeAppend?.data || {}, sheetKey)
              || compatibilityOnlySheetKeys.has(sheetKey)),
        );
        const introduced: TableSheetCheckpointV2_ACU[] = [];
        for (const sheetKey of missingSheetKeys) {
          // 锚点只提供表结构，必须裁成 header-only：
          // 本次增量会自行写入数据行，若锚点带上同样的行，回放时会主键冲突
          // （UNIQUE constraint failed）。
          const anchorSheet = deepClone_ACU((afterData as any)[sheetKey]) as Sheet_ACU;
          if (Array.isArray(anchorSheet?.content) && anchorSheet.content.length > 0) {
            anchorSheet.content = [deepClone_ACU(anchorSheet.content[0])];
          }
          const sheetCheckpointResult = buildCanonicalSheetCheckpoint_ACU({
            createdAt: now,
            reason: 'schema_change',
            sheetKey,
            data: anchorSheet,
            event: { filledSheetKeys: [], changedSheetKeys: [sheetKey], groupKeys: [] },
            baseRevision: requestedBaseRevision,
            context: { messageIndex: target.index, aiFloor, isolationKey },
          });
          if (!sheetCheckpointResult.checkpoint) {
            return { saved: false, error: sheetCheckpointResult.error };
          }
          const timelineKind = historyContainsOrCannotDisproveSheet_ACU(chat, isolationKey, target.index, sheetKey)
            ? 'sheet_reveal' as const
            : 'sheet_introduction' as const;
          // timeline 决定回放时该表在本楼何时进入 state：必须早于本次追加的增量。
          introduced.push({
            ...sheetCheckpointResult.checkpoint,
            timeline: {
              kind: timelineKind,
              activateAtMessageIndex: target.index,
              afterSeq: Math.max(0, ...frame.logEntries.map(item => Number(item.seq) || 0)),
            },
          });
        }
        if (introduced.length > 0) {
          frame.perSheetCheckpoints = {
            ...(frame.perSheetCheckpoints || {}),
            ...Object.fromEntries(introduced.map(checkpoint => [checkpoint.sheetKey, checkpoint])),
          };
          logDebug_ACU(`[V2 Persist] 为本楼缺失的目标表补写 per-sheet checkpoint：${introduced.map(c => c.sheetKey).join('、')}（messageIndex=${target.index}）。`);
        }
      }
    }
    const nextSeq = Math.max(0, ...frame.logEntries.map(item => Number(item.seq) || 0)) + 1;
    const parentRevision = options.parentRevision !== undefined ? options.parentRevision : (frame.headRevision ?? null);
    entry = appendMutationLogEntry_ACU(frame, {
      seq: nextSeq,
      createdAt: now,
      source: options.source,
      targetMessageIndex: target.index,
      aiFloor,
      filledSheetKeys,
      changedSheetKeys: effectiveChangedSheetKeys,
      groupKeys: options.groupKeys || [],
      requestId: options.requestId,
      batchId: options.batchId,
      error: options.error,
      operations,
      baseRevision: requestedBaseRevision ?? parentRevision,
      parentRevision,
      writeSet: currentWriteSet,
    });
    logDebug_ACU(`[V2 Persist] 追加 operation log entry: messageIndex=${target.index}, seq=${entry.seq}, revision=${entry.commitRevision}, operations=${operations.length}`);
  }

  if (!shouldAppendLogEntry && !shouldCheckpoint && options.manualRefillProgress) {
    logDebug_ACU(`[V2 Persist] 仅更新 manualRefillProgress，不追加 mutation entry: messageIndex=${target.index}`);
  }

  replacementIsolatedDataByMessageIndex.set(target.index, isolatedData);
  if (temporaryBaselineUpgrade) {
    const candidateChat = buildCandidateChatWithIsolatedDataOverrides_ACU(chat, replacementIsolatedDataByMessageIndex);
    const candidateValidationError = await validateTemporaryBaselineUpgradeCandidate_ACU(
      candidateChat,
      isolationKey,
      target.index,
      afterData,
    );
    if (candidateValidationError) {
      return { saved: false, error: candidateValidationError };
    }
    options.transactionContext?.assertFresh?.('persistTableMutationLogV2:before_boundary_checkpoint_save');
  }
  const previousMessageState = [...replacementIsolatedDataByMessageIndex.keys()].map(messageIndex => {
    const message = chat[messageIndex];
    return {
      message,
      hadIsolatedData: Object.prototype.hasOwnProperty.call(message, 'TavernDB_ACU_IsolatedData'),
      isolatedData: message.TavernDB_ACU_IsolatedData,
      hadIdentity: Object.prototype.hasOwnProperty.call(message, 'TavernDB_ACU_Identity'),
      identity: message.TavernDB_ACU_Identity,
    };
  });
  try {
    for (const [messageIndex, nextIsolatedData] of replacementIsolatedDataByMessageIndex) {
      chat[messageIndex].TavernDB_ACU_IsolatedData = nextIsolatedData;
    }
    writeMessageIdentity_ACU(target.message, {
      enabled: settings_ACU.dataIsolationEnabled,
      code: settings_ACU.dataIsolationCode,
    });
    // 临时基线升级会替换 orphan frame、清空日志并写 recoveryBackup，必须确认宿主真实落盘。
    if (options.strictSave || replacement || temporaryBaselineUpgrade) {
      await saveChatToHostStrict_ACU();
    } else {
      await saveChatToHost_ACU();
    }
  } catch (error) {
    for (const state of previousMessageState) {
      if (state.hadIsolatedData) state.message.TavernDB_ACU_IsolatedData = state.isolatedData;
      else delete state.message.TavernDB_ACU_IsolatedData;
      if (state.hadIdentity) state.message.TavernDB_ACU_Identity = state.identity;
      else delete state.message.TavernDB_ACU_Identity;
    }
    throw error;
  }
  return { saved: true, messageIndex: target.index, entry };
}

export async function persistTableMutationLogV2_ACU(
  options: PersistTableMutationV2Options_ACU,
): Promise<{ saved: boolean; messageIndex?: number; entry?: TableMutationLogEntryV2_ACU; error?: string }> {
  const performanceSpan = startRuntimePerformanceSpan_ACU('v2-persist-mutation-log', {
    runId: options.performanceRunId,
    parentSpanId: options.performanceParentSpanId,
    settings: settings_ACU,
    metrics: {
      targetMessageIndex: options.targetMessageIndex,
      operationCount: Array.isArray(options.operations) ? options.operations.length : 0,
      changedSheetCount: Array.isArray(options.candidateChangedSheetKeys) ? options.candidateChangedSheetKeys.length : 0,
      source: options.source,
      strictSave: options.strictSave === true,
      replacement: Boolean(options.replaceExistingIncremental),
    },
  });
  if (!options.transactionContext) {
    const result = { saved: false, error: 'V2 operation log write requires TableWriteTransactionContext; direct unsafe writes are not allowed.' };
    performanceSpan.end({ success: false });
    return result;
  }
  try {
    const hasPerformanceContext = Boolean(options.performanceRunId || options.performanceParentSpanId);
    const coreOptions = hasPerformanceContext
      ? { ...options, performanceParentSpanId: performanceSpan.id }
      : options;
    const result = options.assumeCommitLock
      ? await persistTableMutationLogV2Core_ACU(coreOptions)
      : await options.transactionContext.runCommit(() => persistTableMutationLogV2Core_ACU(coreOptions), options.revisionWriteSet);
    performanceSpan.end({ success: result.saved });
    return result;
  } catch (error) {
    performanceSpan.end({ success: false });
    throw error;
  }
}

function validateBatchOperationScope_ACU(
  targetIndex: number,
  operations: TableMutationOperationV2_ACU[],
  changedSheetKeys: string[],
): string | null {
  const changedKeys = new Set(changedSheetKeys);
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') return `V2 batch write target ${targetIndex} has an invalid operation.`;
    if (operation.kind === 'data_replace' || operation.kind === 'sql_batch' || operation.kind === 'table_edit_dsl') {
      return `V2 batch write target ${targetIndex} contains unsupported unscoped operation: ${operation.kind}.`;
    }
    const sheetKey = typeof (operation as any).sheetKey === 'string' ? (operation as any).sheetKey.trim() : '';
    if (!sheetKey || !changedKeys.has(sheetKey)) {
      return `V2 batch write target ${targetIndex} operation scope is outside changed sheet keys.`;
    }
  }
  return null;
}

function mergeBatchTargetsByMessageIndex_ACU(
  targets: PersistTableMutationLogBatchTargetV2_ACU[],
  afterData: TableDataObject_ACU,
): Map<number, PersistTableMutationLogBatchTargetV2_ACU> | { error: string } {
  const targetByIndex = new Map<number, PersistTableMutationLogBatchTargetV2_ACU>();
  for (const target of targets) {
    const targetIndex = Number(target?.targetMessageIndex);
    if (!Number.isInteger(targetIndex)) return { error: `V2 batch write target index is invalid: ${targetIndex}.` };
    if (!Array.isArray(target.operations) || target.operations.length === 0) {
      return { error: `V2 batch write target ${targetIndex} has no operations.` };
    }
    const normalizedKeys = normalizeKeys_ACU(target.changedSheetKeys, afterData);
    if (normalizedKeys.length === 0) return { error: `V2 batch write target ${targetIndex} has no valid changed sheet keys.` };
    const scopeError = validateBatchOperationScope_ACU(targetIndex, target.operations, normalizedKeys);
    if (scopeError) return { error: scopeError };
    const existing = targetByIndex.get(targetIndex);
    if (!existing) {
      targetByIndex.set(targetIndex, {
        targetMessageIndex: targetIndex,
        operations: deepClone_ACU(target.operations),
        changedSheetKeys: normalizedKeys,
      });
      continue;
    }
    existing.operations.push(...deepClone_ACU(target.operations));
    existing.changedSheetKeys = [...new Set([...existing.changedSheetKeys, ...normalizedKeys])].sort();
  }
  return targetByIndex;
}



async function persistTableMutationLogBatchV2Core_ACU(
  options: PersistTableMutationLogBatchV2Options_ACU,
): Promise<{ saved: boolean; messageIndices?: number[]; error?: string }> {
  const chat = getChatArray_ACU();
  if (!Array.isArray(chat) || chat.length === 0) return { saved: false, error: 'chat history is empty' };
  if (!Array.isArray(options.targets) || options.targets.length === 0) return { saved: false, error: 'V2 batch write requires at least one target.' };

  const isolationKey = options.isolationKey ?? getCurrentIsolationKey_ACU();
  const latestCheckpoint = findLatestFullCheckpoint_ACU(chat, isolationKey);
  if (!latestCheckpoint) return { saved: false, error: 'V2 batch write requires an existing full checkpoint anchor.' };
  options.transactionContext?.assertFresh?.('persistTableMutationLogBatchV2:before_persist');

  const mergedTargets = mergeBatchTargetsByMessageIndex_ACU(options.targets, options.afterData);
  if ('error' in mergedTargets) return { saved: false, error: mergedTargets.error };
  const targetByIndex = mergedTargets;
  const changedSheetKeys = new Set<string>();
  for (const [targetIndex, target] of targetByIndex) {
    if (!Number.isInteger(targetIndex) || targetIndex < latestCheckpoint.index || !chat[targetIndex] || chat[targetIndex].is_user) {
      return { saved: false, error: `V2 batch write target is invalid or precedes replay checkpoint: ${targetIndex}.` };
    }
    target.changedSheetKeys.forEach(sheetKey => changedSheetKeys.add(sheetKey));
  }

  const candidateChat = deepClone_ACU(chat);
  for (const [targetIndex, target] of targetByIndex) {
    const message = candidateChat[targetIndex];
    const isolatedData = cloneIsolatedData_ACU(message) as Record<string, any>;
    const tagData = isolatedData[isolationKey];
    if (!isV2TagData_ACU(tagData)) return { saved: false, error: `V2 batch write target ${targetIndex} has no V2 storage frame.` };
    const frame = tagData.storageFrame as TableStorageFrameV2_ACU;
    const nextSeq = Math.max(0, ...(frame.logEntries || []).map(item => Number(item.seq) || 0)) + 1;
    const entryId = generateEntryId_ACU();
    const parentRevision = frame.headRevision ?? null;
    const entry: TableMutationLogEntryV2_ACU = {
      seq: nextSeq,
      entryId,
      createdAt: Date.now(),
      source: options.source,
      targetMessageIndex: targetIndex,
      aiFloor: countAiFloor_ACU(candidateChat, targetIndex),
      filledSheetKeys: [],
      changedSheetKeys: target.changedSheetKeys,
      groupKeys: [],
      requestId: options.requestId,
      batchId: options.batchId,
      operations: deepClone_ACU(target.operations),
      baseRevision: options.transactionContext?.baseRevision ?? parentRevision,
      parentRevision,
      commitRevision: buildCommitRevision_ACU(nextSeq, entryId),
      writeSet: options.transactionContext?.writeSet,
    };
    frame.logEntries = [...(frame.logEntries || []), entry];
    frame.headRevision = entry.commitRevision;
    message.TavernDB_ACU_IsolatedData = isolatedData;
    writeMessageIdentity_ACU(message, {
      enabled: settings_ACU.dataIsolationEnabled,
      code: settings_ACU.dataIsolationCode,
    });
  }
  const targetMessageIndices = [...targetByIndex.keys()].sort((a, b) => a - b);
  const operationCount = [...targetByIndex.values()].reduce((sum, target) => sum + target.operations.length, 0);
  logDebug_ACU(
    `[V2 Persist] batch candidate 写入准备完成（已移除 afterData 相等性阻断）: source=${options.source}, targetMessageIndex=${targetMessageIndices.join(',')}, operations=${operationCount}, targets=${targetByIndex.size}, changedSheets=${changedSheetKeys.size}`,
  );

  const snapshots = [...targetByIndex.keys()].map(index => ({
    index,
    message: chat[index],
    hadIsolatedData: Object.prototype.hasOwnProperty.call(chat[index], 'TavernDB_ACU_IsolatedData'),
    isolatedData: chat[index].TavernDB_ACU_IsolatedData,
    hadIdentity: Object.prototype.hasOwnProperty.call(chat[index], 'TavernDB_ACU_Identity'),
    identity: chat[index].TavernDB_ACU_Identity,
  }));
  try {
    for (const { index } of snapshots) {
      chat[index].TavernDB_ACU_IsolatedData = candidateChat[index].TavernDB_ACU_IsolatedData;
      if (Object.prototype.hasOwnProperty.call(candidateChat[index], 'TavernDB_ACU_Identity')) {
        chat[index].TavernDB_ACU_Identity = candidateChat[index].TavernDB_ACU_Identity;
      } else {
        delete chat[index].TavernDB_ACU_Identity;
      }
    }
    await saveChatToHostStrict_ACU();
  } catch (error) {
    for (const snapshot of snapshots) {
      if (snapshot.hadIsolatedData) snapshot.message.TavernDB_ACU_IsolatedData = snapshot.isolatedData;
      else delete snapshot.message.TavernDB_ACU_IsolatedData;
      if (snapshot.hadIdentity) snapshot.message.TavernDB_ACU_Identity = snapshot.identity;
      else delete snapshot.message.TavernDB_ACU_Identity;
    }
    throw error;
  }

  return { saved: true, messageIndices: [...targetByIndex.keys()].sort((left, right) => left - right) };
}

export async function persistTableMutationLogBatchV2_ACU(
  options: PersistTableMutationLogBatchV2Options_ACU,
): Promise<{ saved: boolean; messageIndices?: number[]; error?: string }> {
  if (!options.transactionContext) {
    return { saved: false, error: 'V2 batch operation log write requires TableWriteTransactionContext; direct unsafe writes are not allowed.' };
  }
  if (options.assumeCommitLock) return persistTableMutationLogBatchV2Core_ACU(options);
  return options.transactionContext.runCommit(
    () => persistTableMutationLogBatchV2Core_ACU(options),
    options.revisionWriteSet,
  );
}

async function persistTableSheetCheckpointV2Core_ACU(
  options: PersistTableSheetCheckpointV2Options_ACU,
): Promise<{ saved: boolean; messageIndex?: number; checkpoint?: TableSheetCheckpointV2_ACU; error?: string }> {
  const validation = validateSheetCheckpointInput_ACU(options);
  if ('error' in validation) return { saved: false, error: validation.error };
  const normalizedSheetData = deepClone_ACU(options.sheetData);
  const normalization = normalizeCanonicalTableRows_ACU({ [options.sheetKey]: normalizedSheetData });
  if (normalization.errors.length > 0) {
    return { saved: false, error: `V2 sheet checkpoint 行标识不合法：${formatCanonicalRowIssues_ACU(normalization.errors)}` };
  }
  if (normalization.removedRows.length > 0) {
    return { saved: false, error: `V2 sheet checkpoint 包含空 row_id 行，拒绝静默删除：${formatCanonicalRowIssues_ACU(normalization.removedRows)}` };
  }

  const chat = getChatArray_ACU();
  if (!chat || chat.length === 0) {
    return { saved: false, error: 'chat history is empty' };
  }
  const isolationKey = options.isolationKey ?? getCurrentIsolationKey_ACU();
  const latestFullCheckpoint = findLatestFullCheckpoint_ACU(chat, isolationKey);
  if (!latestFullCheckpoint) {
    return { saved: false, error: 'V2 sheet checkpoint requires an existing full checkpoint anchor.' };
  }

  const target = findTargetAiMessage_ACU(chat, options.targetMessageIndex);
  if (!target) {
    return { saved: false, error: 'no AI message found' };
  }
  if (target.index < latestFullCheckpoint.index) {
    return { saved: false, error: `V2 sheet checkpoint target precedes the latest full checkpoint and would never replay: targetMessageIndex=${target.index}, latestFullCheckpointIndex=${latestFullCheckpoint.index}.` };
  }

  options.transactionContext?.assertFresh?.('persistTableSheetCheckpointV2:before_persist');
  if (!chat[target.index] || chat[target.index] !== target.message || target.message.is_user) {
    return { saved: false, error: 'target AI message changed before persist; abort stale sheet checkpoint write.' };
  }

  const isolatedData = cloneIsolatedData_ACU(target.message) as Record<string, any>;
  const frame = getOrInitV2Frame_ACU(isolatedData, isolationKey);
  const conflictingEntry = (frame.logEntries || []).find(entry => logEntryConflictsWithSheetCheckpoint_ACU(entry, options.sheetKey));
  if (conflictingEntry) {
    return {
      saved: false,
      error: `V2 sheet checkpoint cannot be inserted before an existing target-sheet log entry: sheetKey=${options.sheetKey}, entryId=${conflictingEntry.entryId}.`,
    };
  }

  const existingCheckpoint = frame.perSheetCheckpoints?.[options.sheetKey];
  if (existingCheckpoint && Number(existingCheckpoint.createdAt) > validation.createdAt) {
    return {
      saved: false,
      error: `V2 sheet checkpoint cannot replace a newer checkpoint: sheetKey=${options.sheetKey}, existingCreatedAt=${existingCheckpoint.createdAt}, requestedCreatedAt=${validation.createdAt}.`,
    };
  }

  const scheduleSummary = collectScheduleSummaryFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: target.index })[options.sheetKey];
  const checkpointResult = buildCanonicalSheetCheckpoint_ACU({
    createdAt: validation.createdAt,
    reason: validation.reason,
    sheetKey: options.sheetKey,
    data: normalizedSheetData,
    ...(scheduleSummary ? { scheduleSummary } : {}),
    ...(options.event ? { event: options.event } : {}),
    ...(options.manualRefillProgress ? { manualRefillProgress: options.manualRefillProgress } : {}),
    baseRevision: options.baseRevision !== undefined ? options.baseRevision : options.transactionContext?.baseRevision,
    context: { messageIndex: target.index, isolationKey },
  });
  if (!checkpointResult.checkpoint) return { saved: false, error: checkpointResult.error };
  const checkpoint = checkpointResult.checkpoint;

  const hadIsolatedData = Object.prototype.hasOwnProperty.call(target.message, 'TavernDB_ACU_IsolatedData');
  const previousIsolatedData = target.message.TavernDB_ACU_IsolatedData;
  const hadIdentity = Object.prototype.hasOwnProperty.call(target.message, 'TavernDB_ACU_Identity');
  const previousIdentity = target.message.TavernDB_ACU_Identity;
  frame.perSheetCheckpoints = {
    ...(frame.perSheetCheckpoints || {}),
    [options.sheetKey]: checkpoint,
  };
  try {
    target.message.TavernDB_ACU_IsolatedData = isolatedData;
    writeMessageIdentity_ACU(target.message, {
      enabled: settings_ACU.dataIsolationEnabled,
      code: settings_ACU.dataIsolationCode,
    });
    await saveChatToHost_ACU();
  } catch (error) {
    if (hadIsolatedData) {
      target.message.TavernDB_ACU_IsolatedData = previousIsolatedData;
    } else {
      delete target.message.TavernDB_ACU_IsolatedData;
    }
    if (hadIdentity) {
      target.message.TavernDB_ACU_Identity = previousIdentity;
    } else {
      delete target.message.TavernDB_ACU_Identity;
    }
    throw error;
  }
  logDebug_ACU(`[V2 Persist] 写入单表 checkpoint: messageIndex=${target.index}, sheetKey=${options.sheetKey}, createdAt=${checkpoint.createdAt}`);
  return { saved: true, messageIndex: target.index, checkpoint };
}

/**
 * Persists normalized sheet snapshots after load-time removal of empty row_id rows.
 * This deliberately updates only per-sheet checkpoints: guide, scope, root checkpoint,
 * operation log and independent data outside the target frame remain untouched.
 */
export async function persistNullRowCleanupShards_ACU(
  options: PersistNullRowCleanupShardsOptions_ACU,
): Promise<PersistNullRowCleanupShardsResult_ACU> {
  const requestedEntries = Object.entries(options.sheetDataByKey || {})
    .filter(([sheetKey]) => sheetKey.startsWith('sheet_'));
  if (requestedEntries.length === 0) return { status: 'skipped_no_changes' };

  const sheetKeys = requestedEntries.map(([sheetKey]) => sheetKey);
  if (new Set(sheetKeys).size !== sheetKeys.length) {
    return { status: 'skipped_invalid_data', error: 'null-row cleanup contains duplicate sheetKey.' };
  }

  const createdAt = options.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    return { status: 'skipped_invalid_data', error: 'null-row cleanup requires a finite non-negative createdAt.' };
  }

  const isolationKey = options.isolationKey ?? getCurrentIsolationKey_ACU();
  try {
    return await runTableWriteTransaction_ACU({
      source: 'system_cleanup',
      reason: 'persistNullRowCleanupShards',
      isolationKey,
      writeSet: sheetKeys.map(sheetKey => ({ kind: 'schema' as const, sheetKey })),
      maintenanceMode: 'exclusive',
    }, async (transactionContext) => transactionContext.runCommit(async () => {
      const chat = getChatArray_ACU();
      const target = findTargetAiMessage_ACU(chat, undefined);
      if (!target) return { status: 'skipped_no_target' };

      const latestFullCheckpoint = findLatestFullCheckpoint_ACU(chat, isolationKey);
      if (!latestFullCheckpoint) return { status: 'skipped_no_anchor' };
      if (target.index < latestFullCheckpoint.index) {
        return { status: 'failed', error: `null-row cleanup target precedes full checkpoint: targetMessageIndex=${target.index}, latestFullCheckpointIndex=${latestFullCheckpoint.index}.` };
      }

      transactionContext.assertFresh?.('persistNullRowCleanupShards:before_commit');
      if (chat[target.index] !== target.message || target.message.is_user) {
        return { status: 'failed', error: 'target AI message changed before null-row cleanup persist.' };
      }

      const normalizedSheets = new Map<string, Sheet_ACU>();
      for (const [sheetKey, sourceSheet] of requestedEntries) {
        if (!isObjectRecord_ACU(sourceSheet)) {
          return { status: 'skipped_invalid_data', error: `null-row cleanup requires object sheetData: ${sheetKey}.` };
        }
        const sheetData = deepClone_ACU(sourceSheet);
        const normalization = normalizeCanonicalTableRows_ACU({ [sheetKey]: sheetData });
        if (normalization.errors.length > 0) {
          return { status: 'skipped_invalid_data', error: `null-row cleanup sheet 行标识不合法：${formatCanonicalRowIssues_ACU(normalization.errors)}` };
        }
        if (!Array.isArray(sheetData.content?.[0]) || sheetData.content[0][0] !== 'row_id') {
          return { status: 'skipped_invalid_data', error: `null-row cleanup sheet 缺少 row_id 表头：${sheetKey}.` };
        }
        normalizedSheets.set(sheetKey, sheetData);
      }

      const targetTagData = target.message?.TavernDB_ACU_IsolatedData?.[isolationKey];
      if (!isV2TagData_ACU(targetTagData)) {
        return { status: 'skipped_no_v2_target' };
      }

      const isolatedData = cloneIsolatedData_ACU(target.message) as Record<string, any>;
      const frame = isolatedData[isolationKey]?.storageFrame;
      if (!isV2TagData_ACU(isolatedData[isolationKey]) || !frame) {
        return { status: 'failed', error: 'target V2 frame changed while preparing null-row cleanup persist.' };
      }
      const scheduleSummaryBySheet = collectScheduleSummaryFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: target.index });
      const checkpoints: TableSheetCheckpointV2_ACU[] = [];
      for (const sheetKey of sheetKeys) {
        const conflictingEntry = (frame.logEntries || []).find((entry: TableMutationLogEntryV2_ACU) => logEntryConflictsWithSheetCheckpoint_ACU(entry, sheetKey));
        if (conflictingEntry) {
          return { status: 'failed', error: `null-row cleanup conflicts with target-sheet log entry: sheetKey=${sheetKey}, entryId=${conflictingEntry.entryId}.` };
        }
        const existingCheckpoint = frame.perSheetCheckpoints?.[sheetKey];
        if (existingCheckpoint && Number(existingCheckpoint.createdAt) > createdAt) {
          return { status: 'failed', error: `null-row cleanup cannot replace newer checkpoint: sheetKey=${sheetKey}, existingCreatedAt=${existingCheckpoint.createdAt}, requestedCreatedAt=${createdAt}.` };
        }
        const scheduleSummary = scheduleSummaryBySheet[sheetKey];
        checkpoints.push({
          kind: 'sheet_full',
          createdAt,
          reason: 'integrity_repair',
          sheetKey,
          data: normalizedSheets.get(sheetKey)!,
          ...(scheduleSummary ? { scheduleSummary: deepClone_ACU(scheduleSummary) } : {}),
          event: { filledSheetKeys: [], changedSheetKeys: [sheetKey] },
          baseRevision: transactionContext.baseRevision,
        });
      }

      const hadIsolatedData = Object.prototype.hasOwnProperty.call(target.message, 'TavernDB_ACU_IsolatedData');
      const previousIsolatedData = target.message.TavernDB_ACU_IsolatedData;
      const hadIdentity = Object.prototype.hasOwnProperty.call(target.message, 'TavernDB_ACU_Identity');
      const previousIdentity = target.message.TavernDB_ACU_Identity;
      try {
        frame.perSheetCheckpoints = {
          ...(frame.perSheetCheckpoints || {}),
          ...Object.fromEntries(checkpoints.map(checkpoint => [checkpoint.sheetKey, checkpoint])),
        };
        target.message.TavernDB_ACU_IsolatedData = isolatedData;
        writeMessageIdentity_ACU(target.message, {
          enabled: settings_ACU.dataIsolationEnabled,
          code: settings_ACU.dataIsolationCode,
        });
        await saveChatToHostStrict_ACU();
        logDebug_ACU(`[V2 Persist] 空 row_id 自愈 shard 已保存: messageIndex=${target.index}, checkpoints=${checkpoints.length}, isolationKey=${isolationKey}`);
        return { status: 'persisted', messageIndex: target.index, checkpoints };
      } catch (error: any) {
        if (hadIsolatedData) target.message.TavernDB_ACU_IsolatedData = previousIsolatedData;
        else delete target.message.TavernDB_ACU_IsolatedData;
        if (hadIdentity) target.message.TavernDB_ACU_Identity = previousIdentity;
        else delete target.message.TavernDB_ACU_Identity;
        try {
          await saveChatToHostStrict_ACU();
        } catch (rollbackError: any) {
          return { status: 'failed', error: `${error?.message || String(error)}；回滚保存也失败：${rollbackError?.message || String(rollbackError)}` };
        }
        return { status: 'failed', error: error?.message || String(error) };
      }
    }, result => result.status === 'persisted'
      ? sheetKeys.map(sheetKey => ({ kind: 'schema' as const, sheetKey }))
      : []));
  } catch (error: any) {
    return { status: 'failed', error: error?.message || String(error) };
  }
}

function templateSheetPersistentProjection_ACU(sheet: Sheet_ACU): Record<string, unknown> {
  return {
    uid: sheet.uid,
    name: sheet.name,
    orderNo: sheet.orderNo,
    content: sheet.content,
    sourceData: sheet.sourceData,
    updateConfig: sheet.updateConfig,
    exportConfig: sheet.exportConfig,
  };
}

function canonicalJson_ACU(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson_ACU).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson_ACU(record[key])}`).join(',')}}`;
}

function templatePersistentProjectionMatches_ACU(
  baselineData: TableDataObject_ACU,
  candidateData: TableDataObject_ACU,
): boolean {
  const project = (data: TableDataObject_ACU): Record<string, unknown> => Object.fromEntries(
    Object.keys(data)
      .filter(key => key.startsWith('sheet_'))
      .sort()
      .map(key => [key, templateSheetPersistentProjection_ACU(data[key] as Sheet_ACU)]),
  );
  return canonicalJson_ACU(project(baselineData)) === canonicalJson_ACU(project(candidateData));
}

/**
 * Persists a chat template selection when reconciliation has proved that no
 * sheet-level storage mutation is necessary. This deliberately remains a
 * separate API: the structural commit entry point must keep rejecting empty
 * change sets so accidental lost migrations cannot be reported as success.
 */
export async function commitCurrentFloorTemplateScopeOnly_ACU(
  options: CommitCurrentFloorTemplateScopeOnlyOptions_ACU,
): Promise<CommitCurrentFloorTemplateChangesResult_ACU> {
  if (!options.guideData || typeof options.guideData !== 'object' || Array.isArray(options.guideData)) {
    return { saved: false, error: 'scope-only 模板提交必须提供有效的 guideData。' };
  }
  if (!options.baselineData || !options.candidateData
    || !templatePersistentProjectionMatches_ACU(options.baselineData, options.candidateData)) {
    return { saved: false, error: 'scope-only 模板提交要求 baseline 与 candidate 的持久化 Sheet 投影完全一致。' };
  }
  const createdAt = options.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    return { saved: false, error: 'scope-only 模板提交 requires a finite non-negative createdAt.' };
  }
  const isolationKey = options.isolationKey ?? getCurrentIsolationKey_ACU();
  try {
    return await runTableWriteTransaction_ACU({
      source: 'template_assistant',
      reason: options.reason || 'commitCurrentFloorTemplateScopeOnly',
      isolationKey,
      writeSet: [{ kind: 'all' }],
      maintenanceMode: 'exclusive',
    }, async transactionContext => transactionContext.runCommit(async () => {
      const chat = getChatArray_ACU();
      if (!Array.isArray(chat) || chat.length === 0) throw new Error('chat history is empty');
      assertTemplateCommitChatContext_ACU(chat, options);
      transactionContext.assertFresh?.('commitCurrentFloorTemplateScopeOnly:before_commit');
      assertTemplateCommitChatContext_ACU(chat, options);
      const previousScopeContainer = cloneOptionalJson_ACU(peekChatScopedConfigContainer_ACU(chat));
      const previousGuideContainer = cloneOptionalJson_ACU(peekChatSheetGuideContainer_ACU(chat));
      try {
        const guideUpdated = setChatSheetGuideDataForIsolationKey_ACU(isolationKey, options.guideData, {
          reason: options.reason || 'chat_template_scope_only',
          syncTemplateScope: true,
          templateSource: options.templateSource,
          presetName: options.presetName,
          source: options.source,
          updatedAt: createdAt,
        });
        if (!guideUpdated) throw new Error('scope-only 模板提交无法写入 guideData 与 template scope。');
        await saveChatToHostStrict_ACU();
        return { saved: true, mode: 'scope_only' as const };
      } catch (error: any) {
        setChatScopedConfigContainer_ACU(chat, previousScopeContainer);
        setChatSheetGuideContainer_ACU(chat, previousGuideContainer);
        try {
          await saveChatToHostStrict_ACU();
        } catch (rollbackError: any) {
          throw new Error(`${error?.message || String(error)}；回滚保存也失败：${rollbackError?.message || String(rollbackError)}`);
        }
        throw error;
      }
    }, []));
  } catch (error: any) {
    return { saved: false, error: error?.message || String(error) };
  }
}

function assertValidTemplateMetaUpdate_ACU(operation: Record<string, any>, sheetKey: string): void {
  if (!isPlainObjectRecord_ACU(operation.meta)) {
    throw new Error(`当前楼层模板提交 meta_update.meta 必须是普通对象：${sheetKey}。`);
  }
  const allowedKeys = new Set(['name', 'orderNo', 'sourceData', 'updateConfig', 'exportConfig']);
  if (Object.keys(operation.meta).some(key => !allowedKeys.has(key))) {
    throw new Error(`当前楼层模板提交 meta_update 包含非法字段：${sheetKey}。`);
  }
  if (operation.meta.name !== undefined && typeof operation.meta.name !== 'string') {
    throw new Error(`当前楼层模板提交 meta_update.name 无效：${sheetKey}。`);
  }
  if (operation.meta.orderNo !== undefined && (typeof operation.meta.orderNo !== 'number' || !Number.isFinite(operation.meta.orderNo))) {
    throw new Error(`当前楼层模板提交 meta_update.orderNo 无效：${sheetKey}。`);
  }
  for (const key of ['sourceData', 'updateConfig', 'exportConfig'] as const) {
    if (operation.meta[key] !== undefined && !isPlainObjectRecord_ACU(operation.meta[key])) {
      throw new Error(`当前楼层模板提交 meta_update.${key} 必须是普通对象：${sheetKey}。`);
    }
  }
  if (operation.meta.sourceData && Object.prototype.hasOwnProperty.call(operation.meta.sourceData, 'ddl')) {
    throw new Error(`当前楼层模板提交禁止 meta_update 修改 sourceData.ddl：${sheetKey}。`);
  }
}

async function assertValidInitialTemplateSnapshot_ACU(
  data: Record<string, any>,
  guideData: Record<string, any>,
  storageMode: StorageMode,
): Promise<void> {
  const mate = data.mate;
  if (!isPlainObjectRecord_ACU(mate) || typeof mate.type !== 'string' || mate.type.length === 0) {
    throw new Error('V2 首次模板提交的 templateSource.mate 无效。');
  }
  if (mate.version !== undefined && (!Number.isFinite(mate.version) || mate.version < 0)) {
    throw new Error('V2 首次模板提交的 templateSource.mate.version 无效。');
  }
  if (mate.updateConfigUiSentinel !== undefined && !Number.isFinite(mate.updateConfigUiSentinel)) {
    throw new Error('V2 首次模板提交的 templateSource.mate.updateConfigUiSentinel 无效。');
  }
  mate.version = mate.version ?? 1;
  mate.updateConfigUiSentinel = mate.updateConfigUiSentinel ?? 0;
  mate.globalInjectionConfig = ensureGlobalInjectionConfigDefaults_ACU(mate.globalInjectionConfig);

  const invalidRootKey = Object.keys(data).find(key => key !== 'mate' && !key.startsWith('sheet_'));
  if (invalidRootKey) {
    throw new Error(`V2 首次模板提交的 templateSource 包含非法根字段：${invalidRootKey}。`);
  }
  const sheetKeys = Object.keys(data).filter(key => key.startsWith('sheet_')).sort();
  if (sheetKeys.length === 0) {
    throw new Error('V2 首次模板提交的 templateSource 不包含任何 Sheet。');
  }
  const normalizedGuideData = normalizeGuideData_ACU(deepClone_ACU(guideData));
  if (!normalizedGuideData) {
    throw new Error('V2 首次模板提交的 guideData 无法规范化。');
  }
  const guideSheetKeys = Object.keys(normalizedGuideData).filter(key => key.startsWith('sheet_')).sort();
  if (sheetKeys.length !== guideSheetKeys.length || sheetKeys.some((key, index) => key !== guideSheetKeys[index])) {
    throw new Error('V2 首次模板提交的 templateSource 与 guideData 的 Sheet 集合不一致。');
  }

  for (const sheetKey of sheetKeys) {
    const sheet = data[sheetKey];
    if (!sheetIsValidForIntroductionHistory_ACU(sheet)) {
      throw new Error(`V2 首次模板提交的 templateSource 包含无效 Sheet：${sheetKey}。`);
    }
    if (sheet.content.length === 0 || sheet.content[0].length === 0 || sheet.content[0][0] !== 'row_id') {
      throw new Error(`V2 首次模板提交的 templateSource Sheet 缺少 row_id 表头：${sheetKey}。`);
    }
    if (storageMode === 'sqlite') {
      if (!String(sheet.sourceData.ddl || '').trim()) {
        sheet.sourceData.ddl = generateDDL(sheet as Sheet_ACU, sheet.uid || sheetKey);
      }
      const ddlValidation = validateDDLTextAgainstHeaders_ACU(sheet.sourceData.ddl, sheet.content[0]);
      if (!ddlValidation.valid) {
        throw new Error(`V2 首次模板提交的 templateSource Sheet DDL 无法 strict hydrate：${sheetKey}：${ddlValidation.message}`);
      }
      try {
        createSheetInsertPlan(sheet as Sheet_ACU);
      } catch (error: any) {
        throw new Error(`V2 首次模板提交的 templateSource Sheet 无法 hydrate：${sheetKey}：${error?.message || String(error)}`);
      }
    }
  }
  if (storageMode === 'sqlite') {
    try {
      await hydrateTableDataStrict_ACU(data);
    } catch (error: any) {
      throw new Error(`V2 首次模板提交的完整 templateSource 无法通过 SQLite strict hydrate：${error?.message || String(error)}`);
    }
  }
}

const TEMPLATE_DELETE_MESSAGE_FIELDS_ACU = [
  'TavernDB_ACU_IsolatedData',
  'TavernDB_ACU_Identity',
  'TavernDB_ACU_IndependentData',
  'TavernDB_ACU_Data',
  'TavernDB_ACU_SummaryData',
  'TavernDB_ACU_ModifiedKeys',
  'TavernDB_ACU_UpdateGroupKeys',
] as const;

type TemplateDeleteMessageSnapshot_ACU = {
  message: Record<string, any>;
  fields: Map<string, { hadValue: boolean; value: unknown }>;
};

function normalizeDeletedTemplateSheetKeys_ACU(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('当前楼层模板提交的 deletedSheetKeys 必须为数组。');
  const keys = value.map(key => String(key || ''));
  if (keys.some(key => !key.startsWith('sheet_'))) throw new Error('当前楼层模板提交包含非法 deletedSheetKey。');
  if (new Set(keys).size !== keys.length) throw new Error('当前楼层模板提交不能包含重复 deletedSheetKey。');
  return keys;
}

function snapshotTemplateDeleteMessages_ACU(chat: unknown[], deepCloneValues: boolean): TemplateDeleteMessageSnapshot_ACU[] {
  return chat
    .filter((message: any) => message && !message.is_user && typeof message === 'object')
    .map((message: Record<string, any>) => ({
      message,
      fields: new Map(TEMPLATE_DELETE_MESSAGE_FIELDS_ACU.map(field => [field, {
        hadValue: Object.prototype.hasOwnProperty.call(message, field),
        value: deepCloneValues ? cloneOptionalJson_ACU(message[field]) : message[field],
      }])),
    }));
}

function restoreTemplateDeleteMessageSnapshots_ACU(snapshots: TemplateDeleteMessageSnapshot_ACU[]): void {
  for (const snapshot of snapshots) {
    for (const [field, previous] of snapshot.fields) {
      if (previous.hadValue) snapshot.message[field] = previous.value;
      else delete snapshot.message[field];
    }
  }
}

function assertValidTemplateSheetChanges_ACU(sheetChanges: TemplateSheetChange_ACU[], deletedSheetKeys: string[]): void {
  if (sheetChanges.length === 0 && deletedSheetKeys.length === 0) {
    throw new Error('当前楼层模板提交必须至少包含一个 sheet change 或 deletedSheetKey。');
  }
  const sheetKeys = sheetChanges.map(change => String(change?.sheetKey || ''));
  if (sheetKeys.some(sheetKey => !sheetKey.startsWith('sheet_'))) {
    throw new Error('当前楼层模板提交包含非法 sheetKey。');
  }
  if (new Set(sheetKeys).size !== sheetKeys.length) {
    throw new Error('当前楼层模板提交不能包含重复 sheetKey。');
  }
  if (sheetKeys.some(sheetKey => deletedSheetKeys.includes(sheetKey))) {
    throw new Error('当前楼层模板提交不能同时删除和变更同一 sheetKey。');
  }
  for (const change of sheetChanges) {
    if (change.kind === 'introduction' || change.kind === 'rebase' || change.kind === 'reveal' || change.kind === 'hide') {
      if (!isObjectRecord_ACU(change.sheetData)) throw new Error(`当前楼层模板提交缺少可恢复 Sheet：${change.sheetKey}。`);
      continue;
    }
    if (change.kind !== 'operations' || !isObjectRecord_ACU(change.targetSheetData) || !Array.isArray(change.operations) || change.operations.length === 0) {
      throw new Error(`当前楼层模板提交 operations action 无效：${change.sheetKey}。`);
    }
    let migrationCount = 0;
    let metaUpdateCount = 0;
    for (const operation of change.operations) {
      if (!operation || (operation.kind !== 'sheet_schema_migrate' && operation.kind !== 'meta_update') || operation.sheetKey !== change.sheetKey) {
        throw new Error(`当前楼层模板提交包含不允许或归属错误的 operation：${change.sheetKey}。`);
      }
      if (operation.kind === 'sheet_schema_migrate') {
        migrationCount += 1;
        if (!migrationIsValidForIntroductionHistory_ACU(operation as Record<string, any>)) {
          throw new Error(`当前楼层模板提交包含畸形 sheet_schema_migrate：${change.sheetKey}。`);
        }
      }
      if (operation.kind === 'meta_update') {
        metaUpdateCount += 1;
        assertValidTemplateMetaUpdate_ACU(operation, change.sheetKey);
      }
    }
    if (migrationCount > 1 || metaUpdateCount > 1 || (migrationCount === 1 && change.operations[0].kind !== 'sheet_schema_migrate')) {
      throw new Error(`当前楼层模板提交 operation 顺序或数量无效：${change.sheetKey}。`);
    }
  }
}

/**
 * 在当前最新 AI 楼层原子写入模板结构变更。
 *
 * 单表 checkpoint API 自带宿主保存，不能用于这里；本函数先完成所有内存写入，
 * 再严格保存一次，失败时恢复 storage frame、guide 与 template scope。
 */
export async function commitCurrentFloorTemplateChanges_ACU(
  options: CommitCurrentFloorTemplateChangesOptions_ACU,
): Promise<CommitCurrentFloorTemplateChangesResult_ACU> {
  if (!options.guideData || typeof options.guideData !== 'object' || Array.isArray(options.guideData)) {
    return { saved: false, error: '当前楼层模板提交必须提供有效的 guideData。' };
  }
  const requestedChanges = Array.isArray(options.sheetChanges) ? options.sheetChanges : [];
  let deletedSheetKeys: string[];
  try {
    deletedSheetKeys = normalizeDeletedTemplateSheetKeys_ACU(options.deletedSheetKeys);
    assertValidTemplateSheetChanges_ACU(requestedChanges, deletedSheetKeys);
  } catch (error: any) {
    return { saved: false, error: error?.message || String(error) };
  }
  const sheetKeys = [...new Set([...requestedChanges.map(change => change.sheetKey), ...deletedSheetKeys])];
  const storageMode = options.storageMode === 'native' ? 'native' : 'sqlite';
  const createdAt = options.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    return { saved: false, error: '当前楼层模板提交 requires a finite non-negative createdAt.' };
  }

  const isolationKey = options.isolationKey ?? getCurrentIsolationKey_ACU();
  const writeSet = sheetKeys.map(sheetKey => ({ kind: 'schema' as const, sheetKey }));
  try {
    return await runTableWriteTransaction_ACU({
    source: 'template_assistant',
    reason: options.reason || 'commitCurrentFloorTemplateChanges',
    isolationKey,
    writeSet,
    maintenanceMode: 'exclusive',
    baseRevision: options.baseRevision,
  }, async (transactionContext) => transactionContext.runCommit(async () => {
    const chat = getChatArray_ACU();
    if (!Array.isArray(chat) || chat.length === 0) {
      throw new Error('chat history is empty');
    }
    assertTemplateCommitChatContext_ACU(chat, options);

    const latestAiTarget = findTargetAiMessage_ACU(chat, undefined);
    const target = findTargetAiMessage_ACU(chat, options.targetMessageIndex);
    if (!latestAiTarget || !target) {
      throw new Error('当前聊天不存在可提交的 AI 楼层。');
    }
    if (target.index !== latestAiTarget.index) {
      throw new Error(`当前楼层模板提交只能写入最新 AI 楼层：requested=${target.index}, latest=${latestAiTarget.index}。`);
    }

    let storageState = classifyTemplateCommitStorageState_ACU(chat, isolationKey);
    if (storageState.kind === 'legacy_persisted_data') {
      const storageStateAfterDeletedSheets = classifyTemplateCommitStorageStateAfterDeletedSheets_ACU(chat, isolationKey, deletedSheetKeys);
      if (storageStateAfterDeletedSheets.kind === 'legacy_persisted_data') {
        throw new Error(`当前楼层模板提交检测到 legacy 持久化数据，必须先完成迁移：${storageStateAfterDeletedSheets.details.join(', ')}。`);
      }
      storageState = storageStateAfterDeletedSheets;
    }
    if (storageState.kind === 'orphan_v2_artifacts') {
      throw new Error(`当前楼层模板提交检测到缺少 full checkpoint 的 V2 存储痕迹，已拒绝覆盖：${storageState.details.join(', ')}。`);
    }
    const latestFullCheckpoint = storageState.kind === 'existing_full_checkpoint'
      ? storageState.checkpoint
      : null;
    if (latestFullCheckpoint && target.index < latestFullCheckpoint.index) {
      throw new Error(`V2 当前楼层模板提交目标早于最近 full checkpoint：targetMessageIndex=${target.index}, latestFullCheckpointIndex=${latestFullCheckpoint.index}。`);
    }

    transactionContext.assertFresh?.('commitCurrentFloorTemplateChanges:before_commit');
    assertTemplateCommitChatContext_ACU(chat, options);
    if (chat[target.index] !== target.message || target.message.is_user) {
      throw new Error('target AI message changed before template commit; abort stale table write.');
    }

    if (storageState.kind === 'pristine_without_checkpoint') {
      if (!isObjectRecord_ACU(options.templateSource)) {
        throw new Error('预填表模板提交必须提供完整有效的 templateSource。');
      }
      const templateSnapshot = deepClone_ACU(options.templateSource);
      // 这条分支不做增量删除：checkpoint 完全由 templateSource 重建，且此时没有任何
      // 历史楼层数据需要回溯清理。因此删除只要求「被删表确实已不在新快照里」，
      // 快照仍保留该表说明调用方状态不一致，必须拒绝而不是静默放行。
      const staleDeletedSheetKeys = deletedSheetKeys.filter(sheetKey => sheetKey in templateSnapshot);
      if (staleDeletedSheetKeys.length > 0) {
        throw new Error(`预填表模板提交的 templateSource 仍包含已删除 Sheet：${staleDeletedSheetKeys.join(', ')}。`);
      }
      await assertValidInitialTemplateSnapshot_ACU(templateSnapshot, options.guideData, storageMode);
      assertTemplateCommitChatContext_ACU(chat, options);
      for (const change of requestedChanges) {
        // hide 的语义就是把该表从活跃模板中移除，因此它不会出现在新的 templateSource
        // 快照里；这里要求快照包含它会让「隐藏表 + 无 checkpoint」的切换直接失败。
        if (change.kind === 'hide') continue;
        const snapshotSheet: unknown = templateSnapshot[change.sheetKey];
        if (!isObjectRecord_ACU(snapshotSheet) || !Array.isArray(snapshotSheet.content)) {
          throw new Error(`预填表模板提交的 templateSource 缺少变更 Sheet：${change.sheetKey}。`);
        }
        const expectedSheet = deepClone_ACU(change.kind === 'operations' ? change.targetSheetData : change.sheetData);
        const expectedNormalization = normalizeCanonicalTableRows_ACU({ [change.sheetKey]: expectedSheet });
        if (expectedNormalization.errors.length > 0) {
          throw new Error(`预填表模板提交目标 Sheet 行标识不合法：${formatCanonicalRowIssues_ACU(expectedNormalization.errors)}`);
        }
        if (storageMode === 'sqlite') {
          if (!expectedSheet.sourceData || typeof expectedSheet.sourceData !== 'object') expectedSheet.sourceData = {} as any;
          if (!String(expectedSheet.sourceData.ddl || '').trim()) {
            expectedSheet.sourceData.ddl = generateDDL(expectedSheet, expectedSheet.uid || change.sheetKey);
          }
        }
        if (canonicalJson_ACU(templateSheetPersistentProjection_ACU(snapshotSheet as Sheet_ACU)) !== canonicalJson_ACU(templateSheetPersistentProjection_ACU(expectedSheet))) {
          throw new Error(`预填表模板提交的 templateSource 与目标 Sheet 不一致：${change.sheetKey}。`);
        }
      }
      const previousScopeContainer = cloneOptionalJson_ACU(peekChatScopedConfigContainer_ACU(chat));
      const previousGuideContainer = cloneOptionalJson_ACU(peekChatSheetGuideContainer_ACU(chat));
      const messageSnapshots = snapshotTemplateDeleteMessages_ACU(chat, true);
      try {
        const checkpointData = deepClone_ACU(templateSnapshot);
        const checkpointSheets = Object.keys(checkpointData).filter(key => key.startsWith('sheet_')).sort();
        for (const sheetKey of checkpointSheets) {
          const sheet = checkpointData[sheetKey] as Sheet_ACU;
          sheet.content = [deepClone_ACU(sheet.content[0])];
        }
        const checkpointResult = buildCanonicalFullCheckpoint_ACU({
          createdAt,
          reason: 'init',
          data: checkpointData as TableDataObject_ACU,
          event: { filledSheetKeys: [], changedSheetKeys: checkpointSheets, groupKeys: [] },
          context: { messageIndex: target.index, aiFloor: countAiFloor_ACU(chat, target.index), isolationKey },
        });
        if (!checkpointResult.checkpoint) throw new Error(checkpointResult.error);

        const initialSheetCheckpoints: TableSheetCheckpointV2_ACU[] = [];
        for (const sheetKey of checkpointSheets) {
          const sheetCheckpointResult = buildCanonicalSheetCheckpoint_ACU({
            createdAt,
            reason: 'schema_change',
            sheetKey,
            data: checkpointData[sheetKey] as Sheet_ACU,
            event: { filledSheetKeys: [], changedSheetKeys: [sheetKey], groupKeys: [] },
            baseRevision: options.baseRevision !== undefined ? options.baseRevision : transactionContext.baseRevision,
            context: { messageIndex: target.index, aiFloor: countAiFloor_ACU(chat, target.index), isolationKey },
          });
          if (!sheetCheckpointResult.checkpoint) throw new Error(sheetCheckpointResult.error);
          initialSheetCheckpoints.push(sheetCheckpointResult.checkpoint);
        }

        const isolatedData = cloneIsolatedData_ACU(target.message) as Record<string, any>;
        const frame = getOrInitV2Frame_ACU(isolatedData, isolationKey);
        frame.checkpoint = checkpointResult.checkpoint;
        frame.perSheetCheckpoints = Object.fromEntries(initialSheetCheckpoints.map(checkpoint => [checkpoint.sheetKey, checkpoint]));
        frame.logEntries = [];
        frame.headRevision = buildCommitRevision_ACU('checkpoint', generateEntryId_ACU());
        target.message.TavernDB_ACU_IsolatedData = isolatedData;
        writeMessageIdentity_ACU(target.message, {
          enabled: settings_ACU.dataIsolationEnabled,
          code: settings_ACU.dataIsolationCode,
        });
        const guideUpdated = setChatSheetGuideDataForIsolationKey_ACU(isolationKey, options.guideData, {
          reason: options.reason || 'visualizer_v2_template_only',
          syncTemplateScope: true,
          templateSource: templateSnapshot,
          presetName: options.presetName,
          source: options.source,
          updatedAt: createdAt,
        });
        if (!guideUpdated) throw new Error('预填表模板提交无法原子写入 guideData 与 template scope。');
        assertTemplateCommitChatContext_ACU(chat, options);
        await saveChatToHostStrict_ACU();
        return { saved: true, mode: 'v2_commit', messageIndex: target.index, checkpoints: initialSheetCheckpoints, removedNullRowCount: 0 };
      } catch (error: any) {
        restoreTemplateDeleteMessageSnapshots_ACU(messageSnapshots);
        setChatScopedConfigContainer_ACU(chat, previousScopeContainer);
        setChatSheetGuideContainer_ACU(chat, previousGuideContainer);
        try {
          await saveChatToHostStrict_ACU();
        } catch (rollbackError: any) {
          throw new Error(`${error?.message || String(error)}；回滚保存也失败：${rollbackError?.message || String(rollbackError)}`);
        }
        throw error;
      }
    }

    const targetTagData = target.message?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (!isV2TagData_ACU(targetTagData)) {
      throw new Error('当前楼层模板提交要求目标 AI 楼层已存在合法 V2 storage frame；请先完成既有迁移。');
    }

    const messageSnapshots = snapshotTemplateDeleteMessages_ACU(chat, deletedSheetKeys.length > 0);
    const previousScopeContainer = cloneOptionalJson_ACU(peekChatScopedConfigContainer_ACU(chat));
    const previousGuideContainer = cloneOptionalJson_ACU(peekChatSheetGuideContainer_ACU(chat));
    let primarySaveAttempted = false;
    let sharedStateMutated = false;
    let purgedMessageCount = 0;

    try {
    const introductionSheets = new Map<string, Sheet_ACU>();
    const rebaseSheets = new Map<string, Sheet_ACU>();
    const revealSheets = new Map<string, Sheet_ACU>();
    const hideSheetKeys = new Set<string>();
    let removedNullRowCount = 0;
    for (const change of requestedChanges) {
      if (change.kind === 'hide') {
        hideSheetKeys.add(change.sheetKey);
        continue;
      }
      const targetSheetData = deepClone_ACU(change.kind === 'operations' ? change.targetSheetData : change.sheetData);
      // introduction 允许两种形态：header-only 空壳（首次填表前可改结构），
      // 或模板自带数据的整表（作者已定义初始格式，引入时即落盘）。
      if (change.kind === 'introduction' && !Array.isArray(targetSheetData.content?.[0])) {
        throw new Error(`V2 sheet introduction requires a header row: sheetKey=${change.sheetKey}.`);
      }
      const normalization = normalizeCanonicalTableRows_ACU({ [change.sheetKey]: targetSheetData });
      removedNullRowCount += normalization.removedRows.length;
      if (normalization.errors.length > 0) {
        throw new Error(`V2 当前楼层模板提交行标识不合法：${formatCanonicalRowIssues_ACU(normalization.errors)}`);
      }
      const headers = targetSheetData.content?.[0];
      if (!Array.isArray(headers) || headers[0] !== 'row_id') {
        throw new Error(`V2 当前楼层模板提交缺少 row_id 表头：${change.sheetKey}。`);
      }
      if (storageMode === 'sqlite') {
        if (!targetSheetData.sourceData || typeof targetSheetData.sourceData !== 'object') targetSheetData.sourceData = {} as any;
        if (!String(targetSheetData.sourceData.ddl || '').trim()) {
          targetSheetData.sourceData.ddl = generateDDL(targetSheetData, targetSheetData.uid || change.sheetKey);
        }
        const ddlValidation = validateDDLTextAgainstHeaders_ACU(targetSheetData.sourceData.ddl, headers);
        if (!ddlValidation.valid) {
          throw new Error(`V2 当前楼层模板提交 DDL 无法 strict hydrate：${change.sheetKey}：${ddlValidation.message}`);
        }
        createSheetInsertPlan(targetSheetData);
      }
      if (change.kind === 'introduction') introductionSheets.set(change.sheetKey, targetSheetData);
      else if (change.kind === 'rebase') rebaseSheets.set(change.sheetKey, targetSheetData);
      else if (change.kind === 'reveal') revealSheets.set(change.sheetKey, targetSheetData);
    }

    const isolatedData = cloneIsolatedData_ACU(target.message) as Record<string, any>;
    const frame = isolatedData[isolationKey]?.storageFrame;
    if (!isV2TagData_ACU(isolatedData[isolationKey]) || !frame) {
      throw new Error('目标 V2 storage frame 在模板提交准备期间发生变化。');
    }
    const activeReplay = await loadTableStateFromFramesV2Detailed_ACU(chat, isolationKey, { maxMessageIndex: target.index, updateRuntimeState: false });
    assertTemplateCommitChatContext_ACU(chat, options);
    if (!activeReplay) {
      throw new Error('V2 当前楼层模板提交无法解析 active full checkpoint replay state。');
    }
    if (activeReplay.requiresCheckpointConvergence || activeReplay.compatibilityRepairs?.length) {
      const affectedSheetKeys = [...new Set((activeReplay.compatibilityRepairs || []).map(repair => repair.sheetKey))];
      throw new Error(
        `V2 当前楼层模板提交拒绝依赖临时 Sheet 补锚的回放基线：${affectedSheetKeys.join('、') || '未知 Sheet'}。请先完成恢复收敛。`,
      );
    }
    const activeReplayState = activeReplay.data;
    const checkpoints: TableSheetCheckpointV2_ACU[] = [];
    const scheduleSummaryBySheet = collectScheduleSummaryFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: target.index });
    const targetFrameLastLogSeq = getValidatedFrameLastLogSeq_ACU(frame);
    // reveal 目标集合：包括显式 reveal change，以及"introduction 但历史存在(active 无)"自动转 reveal 的 sheetKey。
    const revealDataBySheet = new Map<string, Sheet_ACU>();
    for (const change of requestedChanges.filter(item => item.kind === 'introduction')) {
      // 是否“仍活跃”只由 replay 后的 active state 判定。
      //
      // perSheetCheckpoints 只是历史痕迹：表可能经由 hide、data_replace 或早期删除逻辑
      // 离开 active state，却仍留下一个没有 hide timeline 的 sheet checkpoint。
      // 把这种痕迹当作“仍活跃”，会让重新切回带该表的模板时走不到下面的唤醒分支，
      // 被误判成“重复引入”直接拒绝。历史里存在过的表由 historyHas 分支负责唤醒。
      const existingSheetCheckpoint = (frame.perSheetCheckpoints || {})[change.sheetKey] as TableSheetCheckpointV2_ACU | undefined;
      const activeHas = Object.prototype.hasOwnProperty.call(activeReplayState, change.sheetKey);
      const historyHas = historyContainsOrCannotDisproveSheet_ACU(chat, isolationKey, target.index, change.sheetKey);
      if (activeHas) {
        // 仍活跃：既非全新，也非可恢复的隐藏表。绝不能让模板 introduction 覆盖活数据。
        // 正常的 stale plan 应先被 baseRevision 拦截；保留这里作为跨入口/异常状态的最终保险。
        throw new Error(
          `当前模板计划尝试将仍在使用的表作为新表引入，已拒绝覆盖已有数据：sheetKey=${change.sheetKey}，requestId=${options.requestId || 'unknown'}。请重新读取当前表格后重试。 `
          + `V2 sheet introduction requires a genuinely new sheet: sheetKey=${change.sheetKey} already exists in the active checkpoint state.`,
        );
      }
      if (historyHas) {
        // historyHas 有两种含义：(1) 历史确实曾有该表（可恢复的隐藏表）；
        // (2) 历史 frame 畸形/无法证伪（`cannot disprove`）——此时并非真的曾有该表，
        // 不能凭损坏历史臆造 reveal 数据。二者的区分依据：能否 bounded replay 定位到可信数据。
        const revealSource = await locateRevealSourceSheetData_ACU(chat, isolationKey, target.index, change.sheetKey);
        assertTemplateCommitChatContext_ACU(chat, options);
        if (revealSource) {
          // 能定位到可信历史可见数据 → 曾被隐藏的表，reveal 恢复"离开时最新状态"（语义1）。
          revealDataBySheet.set(change.sheetKey, revealSource);
          continue;
        }
        // bounded replay 粒度是楼层：同一楼内离开 active state 的表无法靠“更早楼层”找回可见状态。
        // 此时改用本 frame 里该表 sheet checkpoint 的 data —— 它就是该表离开前的完整状态，
        // 是提交时写入的可信来源，不是臆造。
        //
        // 不要求它带 hide timeline：表也可能经由 data_replace 或早期删除逻辑离开，
        // 只留下无 timeline 的残留 checkpoint；那种 data 同样是可信的离开前状态。
        if (isObjectRecord_ACU(existingSheetCheckpoint?.data)) {
          revealDataBySheet.set(change.sheetKey, deepClone_ACU(existingSheetCheckpoint!.data) as Sheet_ACU);
          continue;
        }
        // 定位不到可信数据（含历史畸形、无法证伪）→ 保持 introduction 保守拒绝，绝不基于损坏历史覆盖。
        // 若强行按全新表引入，新写的空 checkpoint 会在回放时盖掉历史上曾存在的同名表数据。
        throw new Error(`V2 sheet introduction requires a genuinely new sheet: sheetKey=${change.sheetKey} already exists in the active checkpoint state.`);
      }
      // 真正全新表：走 introduction。
      const existingCheckpoint = frame.perSheetCheckpoints?.[change.sheetKey];
      if (existingCheckpoint && Number(existingCheckpoint.createdAt) > createdAt) {
        throw new Error(`V2 sheet checkpoint cannot replace a newer checkpoint: sheetKey=${change.sheetKey}, existingCreatedAt=${existingCheckpoint.createdAt}, requestedCreatedAt=${createdAt}.`);
      }
      const scheduleSummary = scheduleSummaryBySheet[change.sheetKey];
      checkpoints.push({
        kind: 'sheet_full',
        createdAt,
        reason: 'schema_change',
        sheetKey: change.sheetKey,
        data: introductionSheets.get(change.sheetKey)!,
        ...(scheduleSummary ? { scheduleSummary: deepClone_ACU(scheduleSummary) } : {}),
        event: { filledSheetKeys: [], changedSheetKeys: [change.sheetKey] },
        timeline: {
          kind: 'sheet_introduction' as const,
          activateAtMessageIndex: target.index,
          afterSeq: targetFrameLastLogSeq,
        },
        baseRevision: options.baseRevision !== undefined ? options.baseRevision : transactionContext.baseRevision,
      });
    }

    // 显式 reveal change：数据来源为 caller 提供的 sheetData（已在准备循环校验/建表计划）。
    for (const change of requestedChanges.filter(item => item.kind === 'reveal')) {
      revealDataBySheet.set(change.sheetKey, revealSheets.get(change.sheetKey)!);
    }

    // 统一写入 reveal checkpoint（timeline: sheet_reveal，回放语义同 rebase）。
    for (const [sheetKey, revealData] of revealDataBySheet) {
      if (Object.prototype.hasOwnProperty.call(activeReplayState, sheetKey)) {
        throw new Error(`V2 sheet reveal requires a hidden sheet: sheetKey=${sheetKey} 仍存在于 active checkpoint state。`);
      }
      const existingCheckpoint = frame.perSheetCheckpoints?.[sheetKey];
      if (existingCheckpoint && Number(existingCheckpoint.createdAt) > createdAt) {
        throw new Error(`V2 sheet checkpoint cannot replace a newer checkpoint: sheetKey=${sheetKey}, existingCreatedAt=${existingCheckpoint.createdAt}, requestedCreatedAt=${createdAt}.`);
      }
      const scheduleSummary = scheduleSummaryBySheet[sheetKey];
      checkpoints.push({
        kind: 'sheet_full',
        createdAt,
        reason: 'schema_change',
        sheetKey,
        data: revealData,
        ...(scheduleSummary ? { scheduleSummary: deepClone_ACU(scheduleSummary) } : {}),
        event: { filledSheetKeys: [], changedSheetKeys: [sheetKey] },
        timeline: {
          kind: 'sheet_reveal' as const,
          activateAtMessageIndex: target.index,
          afterSeq: targetFrameLastLogSeq,
        },
        baseRevision: options.baseRevision !== undefined ? options.baseRevision : transactionContext.baseRevision,
      });
    }

    for (const change of requestedChanges.filter(item => item.kind === 'rebase')) {
      if (
        !Object.prototype.hasOwnProperty.call(activeReplayState, change.sheetKey)
      ) {
        throw new Error(`V2 sheet rebase requires an existing sheet: sheetKey=${change.sheetKey} is absent from the active checkpoint state.`);
      }
      if (deletedSheetKeys.includes(change.sheetKey)) {
        throw new Error(`V2 sheet rebase 不能与删除同一 sheetKey 组合：${change.sheetKey}。`);
      }
      const existingCheckpoint = frame.perSheetCheckpoints?.[change.sheetKey];
      if (existingCheckpoint && Number(existingCheckpoint.createdAt) > createdAt) {
        throw new Error(`V2 sheet checkpoint cannot replace a newer checkpoint: sheetKey=${change.sheetKey}, existingCreatedAt=${existingCheckpoint.createdAt}, requestedCreatedAt=${createdAt}.`);
      }
      const scheduleSummary = scheduleSummaryBySheet[change.sheetKey];
      checkpoints.push({
        kind: 'sheet_full',
        createdAt,
        reason: 'schema_change',
        sheetKey: change.sheetKey,
        data: rebaseSheets.get(change.sheetKey)!,
        ...(scheduleSummary ? { scheduleSummary: deepClone_ACU(scheduleSummary) } : {}),
        event: { filledSheetKeys: [], changedSheetKeys: [change.sheetKey] },
        timeline: {
          kind: 'sheet_rebase' as const,
          activateAtMessageIndex: target.index,
          afterSeq: targetFrameLastLogSeq,
        },
        baseRevision: options.baseRevision !== undefined ? options.baseRevision : transactionContext.baseRevision,
      });
    }

    // hide：将当前可见的表标记隐藏，数据完整保留在 checkpoint.data，不 purge。
    for (const sheetKey of hideSheetKeys) {
      if (deletedSheetKeys.includes(sheetKey)) {
        throw new Error(`V2 sheet hide 不能与删除同一 sheetKey 组合：${sheetKey}。`);
      }
      const hideSource = await locateRevealSourceSheetData_ACU(chat, isolationKey, target.index, sheetKey);
      assertTemplateCommitChatContext_ACU(chat, options);
      if (!hideSource) {
        throw new Error(`V2 sheet hide 无法定位待隐藏表的当前数据：sheetKey=${sheetKey}。`);
      }
      const existingCheckpoint = frame.perSheetCheckpoints?.[sheetKey];
      if (existingCheckpoint && Number(existingCheckpoint.createdAt) > createdAt) {
        throw new Error(`V2 sheet checkpoint cannot replace a newer checkpoint: sheetKey=${sheetKey}, existingCreatedAt=${existingCheckpoint.createdAt}, requestedCreatedAt=${createdAt}.`);
      }
      const scheduleSummary = scheduleSummaryBySheet[sheetKey];
      checkpoints.push({
        kind: 'sheet_full',
        createdAt,
        reason: 'schema_change',
        sheetKey,
        data: hideSource,
        ...(scheduleSummary ? { scheduleSummary: deepClone_ACU(scheduleSummary) } : {}),
        event: { filledSheetKeys: [], changedSheetKeys: [sheetKey] },
        timeline: {
          kind: 'sheet_hide' as const,
          activateAtMessageIndex: target.index,
          // hide 必须晚于本次提交写入的 log 生效：该 log（seq = targetFrameLastLogSeq + 1）
          // 可能仍包含针对待隐藏表的合法 operation（例如切模板前刚补齐填表）。
          // 回放判定是 afterSeq < nextSeq，用 targetFrameLastLogSeq 会让 hide 抢在该 log 之前
          // 删表，导致后续 operation 撞上 no such table。
          // introduction / rebase / reveal 相反，必须早于本批 log，故仍用 targetFrameLastLogSeq。
          afterSeq: targetFrameLastLogSeq + 1,
        },
        baseRevision: options.baseRevision !== undefined ? options.baseRevision : transactionContext.baseRevision,
      });
    }


    const operationChanges = requestedChanges.filter((change): change is Extract<TemplateSheetChange_ACU, { kind: 'operations' }> => change.kind === 'operations');
    const operations = operationChanges.flatMap(change => change.operations.map(operation => deepClone_ACU(operation)));

    const entryOptions: AppendMutationLogEntryOptions_ACU | undefined = operations.length === 0 ? undefined : (() => {
      const seq = targetFrameLastLogSeq + 1;
      const parentRevision = frame.headRevision ?? null;
      return {
        seq,
        createdAt,
        source: 'template_assistant' as const,
        targetMessageIndex: target.index,
        aiFloor: countAiFloor_ACU(chat, target.index),
        filledSheetKeys: [] as string[],
        changedSheetKeys: operationChanges.map(change => change.sheetKey),
        groupKeys: [] as string[],
        operations,
        baseRevision: options.baseRevision !== undefined ? options.baseRevision : (transactionContext.baseRevision ?? parentRevision),
        parentRevision,
        writeSet,
      };
    })();

      // 所有异步准备完成后，在第一次内存写入前重新核验当前活动聊天与取消状态。
      assertTemplateCommitChatContext_ACU(chat, options);
      sharedStateMutated = true;
      purgedMessageCount = deletedSheetKeys.length === 0 ? 0 : messageSnapshots.reduce((count, snapshot) => (
        purgeSheetKeysFromMessage_ACU(snapshot.message, deletedSheetKeys) ? count + 1 : count
      ), 0);
      frame.perSheetCheckpoints = {
        ...(frame.perSheetCheckpoints || {}),
        ...Object.fromEntries(checkpoints.map(checkpoint => [checkpoint.sheetKey, checkpoint])),
      };
      if (entryOptions) appendMutationLogEntry_ACU(frame, entryOptions);
      target.message.TavernDB_ACU_IsolatedData = isolatedData;
      // isolatedData 在异步准备前已克隆；重新挂回目标消息后必须同步应用删除，
      // 否则会把刚刚从真实消息清理掉的目标 frame 旧快照覆盖回来。
      if (deletedSheetKeys.length > 0) purgeSheetKeysFromMessage_ACU(target.message, deletedSheetKeys);
      writeMessageIdentity_ACU(target.message, {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
      });
      const guideUpdated = setChatSheetGuideDataForIsolationKey_ACU(isolationKey, options.guideData, {
        reason: options.reason || 'visualizer_v2_schema_change',
        syncTemplateScope: options.syncTemplateScope === true,
        templateSource: options.templateSource,
        presetName: options.presetName,
        source: options.source,
        updatedAt: createdAt,
      });
      if (!guideUpdated) throw new Error('当前楼层模板提交无法写入 guideData。');
      assertTemplateCommitChatContext_ACU(chat, options);
      primarySaveAttempted = true;
      await saveChatToHostStrict_ACU();
      logDebug_ACU(`[V2 Persist] 当前楼层模板提交完成: requestId=${options.requestId || 'unknown'}, messageIndex=${target.index}, checkpoints=${checkpoints.length}, operations=${operations.length}, isolationKey=${isolationKey}`);
      return {
        saved: true,
        mode: 'v2_commit',
        messageIndex: target.index,
        checkpoints,
        removedNullRowCount,
        ...(deletedSheetKeys.length > 0 ? { deletedSheetKeys, purgedMessageCount } : {}),
      };
    } catch (error: any) {
      if (sharedStateMutated) {
        restoreTemplateDeleteMessageSnapshots_ACU(messageSnapshots);
        setChatScopedConfigContainer_ACU(chat, previousScopeContainer);
        setChatSheetGuideContainer_ACU(chat, previousGuideContainer);
      }
      if (primarySaveAttempted) {
        try {
          await saveChatToHostStrict_ACU();
        } catch (rollbackError: any) {
          throw new Error(`${error?.message || String(error)}；回滚保存也失败：${rollbackError?.message || String(rollbackError)}`);
        }
      }
      throw error;
    }
  }, writeSet));
  } catch (error: any) {
    return { saved: false, error: error?.message || String(error) };
  }
}

export async function persistTableSheetCheckpointV2_ACU(
  options: PersistTableSheetCheckpointV2Options_ACU,
): Promise<{ saved: boolean; messageIndex?: number; checkpoint?: TableSheetCheckpointV2_ACU; error?: string }> {
  if (!options.transactionContext) {
    return { saved: false, error: 'V2 sheet checkpoint write requires TableWriteTransactionContext; direct unsafe writes are not allowed.' };
  }
  if (options.assumeCommitLock) return persistTableSheetCheckpointV2Core_ACU(options);
  return options.transactionContext.runCommit(() => persistTableSheetCheckpointV2Core_ACU(options), []);
}
