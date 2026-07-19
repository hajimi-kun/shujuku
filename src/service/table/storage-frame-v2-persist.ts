import { getChatArray_ACU, saveChatToHost_ACU, saveChatToHostStrict_ACU } from '../../data/gateways/chat-gateway';
import { cloneIsolatedData_ACU, collectSqlTargetTableNamesFromStorageFrameV2_ACU, purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU, purgeSheetKeysFromMessage_ACU, readIsolatedTagData_ACU, writeMessageIdentity_ACU } from '../../data/repositories/chat-message-data-repo';
import { getChatScopedConfigContainer_ACU, getChatSheetGuideContainer_ACU, setChatScopedConfigContainer_ACU, setChatSheetGuideContainer_ACU } from '../../data/storage/chat-history';
import type { Sheet_ACU, TableDataObject_ACU } from '../../shared/models/table-data';
import { logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import { getCurrentIsolationKey_ACU, settings_ACU } from '../runtime/state-manager';
import { normalizeGuideData_ACU, setChatSheetGuideDataForIsolationKey_ACU } from '../template/chat-scope';
import { ensureGlobalInjectionConfigDefaults_ACU } from '../worldbook/injection-engine';
import type { ManualRefillProgressV2_ACU, TableMutationEventV2_ACU, TableMutationLogEntryV2_ACU, TableMutationSourceV2_ACU, TableStorageFrameV2_ACU, TableCheckpointV2_ACU, TableMutationWriteSetV2_ACU, TableMutationOperationV2_ACU, TableSheetCheckpointV2_ACU } from './storage-frame-v2-types';
import { hasLegacyTopLevelTableData_ACU, isLegacyV1TagData_ACU, isV2TagData_ACU } from './storage-strategy-resolver';
import { applyTableOperationV2_ACU, collectScheduleSummaryFromFramesV2_ACU, loadTableStateFromFramesV2_ACU } from './storage-frame-v2-replay';
import { runTableWriteTransaction_ACU, type TableWriteTransactionContext_ACU } from './table-write-transaction';
import { formatCanonicalRowIssues_ACU, normalizeCanonicalTableRows_ACU } from '../../shared/canonical-row-normalizer';
import { createSheetInsertPlan, generateDDL, validateDDLTextAgainstHeaders_ACU } from '../../data/sqlite/schema-mapper';
import { hydrateTableDataStrict_ACU } from './sqlite-template-validation';
import { buildCanonicalFullCheckpoint_ACU, buildCanonicalSheetCheckpoint_ACU } from './canonical-checkpoint-builder';

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
  transactionContext?: Pick<TableWriteTransactionContext_ACU, 'runCommit' | 'baseRevision' | 'writeSet' | 'assertFresh'>;
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
  createdAt?: number;
  baseRevision?: string | null;
}

export interface CommitCurrentFloorTemplateChangesResult_ACU {
  saved: boolean;
  mode?: 'template_only' | 'v2_commit';
  messageIndex?: number;
  checkpoints?: TableSheetCheckpointV2_ACU[];
  removedNullRowCount?: number;
  deletedSheetKeys?: string[];
  purgedMessageCount?: number;
  error?: string;
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

function hasAnyV2Checkpoint_ACU(chat: any[], isolationKey: string, maxMessageIndex = chat.length - 1): boolean {
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

function getOperationReplayScope_ACU(operations: TableMutationOperationV2_ACU[]): { wholeState: boolean; sheetKeys: string[] } {
  const sheetKeys = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === 'data_replace' || operation.kind === 'sql_batch' || operation.kind === 'table_edit_dsl') {
      return { wholeState: true, sheetKeys: [] };
    }
    if ('sheetKey' in operation && typeof operation.sheetKey === 'string' && operation.sheetKey.startsWith('sheet_')) {
      sheetKeys.add(operation.sheetKey);
      continue;
    }
    throw new Error(`V2 operation log 无法确定 operation 影响范围：kind=${(operation as any).kind}。`);
  }
  return { wholeState: false, sheetKeys: [...sheetKeys] };
}

async function getOperationReplayPostconditionError_ACU(
  chat: any[],
  isolationKey: string,
  targetMessageIndex: number,
  operations: TableMutationOperationV2_ACU[],
  afterData: TableDataObject_ACU,
  candidateChangedSheetKeys: string[],
): Promise<string | null> {
  if (operations.length === 0) return null;
  try {
    const replayBase = await loadTableStateFromFramesV2_ACU(chat, isolationKey, {
      maxMessageIndex: targetMessageIndex,
      updateRuntimeState: false,
    });
    if (!replayBase) {
      return 'V2 operation log 回放缺少现有 full checkpoint base，拒绝写入。';
    }
    const replayScope = getOperationReplayScope_ACU(operations);
    const replayCandidate = deepClone_ACU(replayBase);
    for (const operation of operations) await applyTableOperationV2_ACU(replayCandidate, operation);

    if (replayScope.wholeState) {
      if (canonicalJson_ACU(replayCandidate) !== canonicalJson_ACU(afterData)) {
        return 'V2 operation log 回放结果与 afterData 快照不一致。';
      }
      return null;
    }

    const affectedSheetKeys = [...new Set([...candidateChangedSheetKeys, ...replayScope.sheetKeys])];
    if (affectedSheetKeys.length === 0) {
      return 'V2 operation log 缺少可验证的受影响 Sheet，拒绝写入。';
    }
    for (const sheetKey of affectedSheetKeys) {
      const replayedSheet = replayCandidate[sheetKey] as Sheet_ACU | undefined;
      const expectedSheet = afterData[sheetKey] as Sheet_ACU | undefined;
      if (!replayedSheet || !expectedSheet || canonicalJson_ACU(templateSheetPersistentProjection_ACU(replayedSheet)) !== canonicalJson_ACU(templateSheetPersistentProjection_ACU(expectedSheet))) {
        return `V2 operation log 回放结果与 afterData Sheet 不一致：${sheetKey}。`;
      }
    }
    return null;
  } catch (error: any) {
    return `V2 operation log 回放失败：${error?.message || String(error)}`;
  }
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
  return isObjectRecord_ACU(tagData)
    && (tagData._acu_storage_version === 2 || tagData.storageFrame?.version === 2);
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
    && value.kind === 'sheet_introduction'
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
  const afterData = deepClone_ACU(options.afterData);
  const normalization = normalizeCanonicalTableRows_ACU(afterData);
  if (normalization.errors.length > 0) {
    return { saved: false, error: `V2 operation log snapshot 行标识不合法：${formatCanonicalRowIssues_ACU(normalization.errors)}` };
  }
  if (normalization.removedRows.length > 0) {
    return { saved: false, error: `V2 operation log snapshot 包含空 row_id 行，拒绝静默删除：${formatCanonicalRowIssues_ACU(normalization.removedRows)}` };
  }
  const filledSheetKeys = normalizeKeys_ACU(options.filledSheetKeys, afterData);
  const candidateChangedSheetKeys = normalizeKeys_ACU(options.candidateChangedSheetKeys, afterData);
  const hasExistingCheckpoint = hasAnyV2Checkpoint_ACU(chat, isolationKey, target.index);
  const hasExistingV2Frame = hasAnyV2Frame_ACU(chat, isolationKey, target.index);
  const operations = normalizeOperations_ACU(options.operations, afterData, options.source, hasExistingCheckpoint);
  const effectiveChangedSheetKeys = candidateChangedSheetKeys;
  const hasMetadataOnlyFillEvent = filledSheetKeys.length > 0 || (Array.isArray(options.groupKeys) && options.groupKeys.length > 0);
  const hasManualRefillProgress = !!options.manualRefillProgress;
  const isManualRefillProgressOnly = operations.length === 0 && !hasMetadataOnlyFillEvent && hasManualRefillProgress;
  if (!manualRefillProgressIsValidForIntroductionHistory_ACU(options.manualRefillProgress)) {
    return { saved: false, error: 'V2 manualRefillProgress 格式无效，已拒绝写入。' };
  }
  if (isManualRefillProgressOnly && !hasExistingCheckpoint) {
    return {
      saved: false,
      error: 'V2 manualRefillProgress-only write requires an existing full checkpoint anchor.',
    };
  }
  const initialCheckpointReason: TableCheckpointV2_ACU['reason'] = options.checkpointReason
    || (hasExistingV2Frame ? 'migration' : 'init');
  const shouldCheckpoint = !hasExistingCheckpoint
    && !isManualRefillProgressOnly
    && (initialCheckpointReason === 'init' || initialCheckpointReason === 'migration');
  if (shouldCheckpoint && operations.length > 0) {
    return { saved: false, error: 'V2 初始 full checkpoint 不接受 operations；请仅提交 afterData 快照。' };
  }
  if (!shouldCheckpoint && operations.length > 0) {
    const replayPostconditionError = await getOperationReplayPostconditionError_ACU(
      chat,
      isolationKey,
      target.index,
      operations,
      afterData,
      effectiveChangedSheetKeys,
    );
    if (replayPostconditionError) return { saved: false, error: replayPostconditionError };
  }

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
    logDebug_ACU(`[V2 Persist] 写入 full checkpoint: messageIndex=${target.index}, revision=${checkpointRevision}, sheets=${Object.keys(afterData).filter(k => k.startsWith('sheet_')).length}`);
  } else if (shouldAppendLogEntry) {
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
    if (options.strictSave || replacement) {
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
  if (!options.transactionContext) {
    return { saved: false, error: 'V2 operation log write requires TableWriteTransactionContext; direct unsafe writes are not allowed.' };
  }
  if (options.assumeCommitLock) {
    return persistTableMutationLogV2Core_ACU(options);
  }
  return options.transactionContext.runCommit(() => persistTableMutationLogV2Core_ACU(options), options.revisionWriteSet);
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
  try {
    await hydrateTableDataStrict_ACU(data);
  } catch (error: any) {
    throw new Error(`V2 首次模板提交的完整 templateSource 无法通过 SQLite strict hydrate：${error?.message || String(error)}`);
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
    if (change.kind === 'introduction') {
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
    if (chat[target.index] !== target.message || target.message.is_user) {
      throw new Error('target AI message changed before template commit; abort stale table write.');
    }

    if (storageState.kind === 'pristine_without_checkpoint') {
      if (deletedSheetKeys.length > 0) {
        throw new Error('预填表模板提交不支持删除历史 Sheet；当前聊天不存在可清理的 V2 checkpoint。');
      }
      if (!isObjectRecord_ACU(options.templateSource)) {
        throw new Error('预填表模板提交必须提供完整有效的 templateSource。');
      }
      const templateSnapshot = deepClone_ACU(options.templateSource);
      await assertValidInitialTemplateSnapshot_ACU(templateSnapshot, options.guideData);
      for (const change of requestedChanges) {
        const snapshotSheet: unknown = templateSnapshot[change.sheetKey];
        if (!isObjectRecord_ACU(snapshotSheet) || !Array.isArray(snapshotSheet.content)) {
          throw new Error(`预填表模板提交的 templateSource 缺少变更 Sheet：${change.sheetKey}。`);
        }
        const expectedSheet = deepClone_ACU(change.kind === 'introduction' ? change.sheetData : change.targetSheetData);
        const expectedNormalization = normalizeCanonicalTableRows_ACU({ [change.sheetKey]: expectedSheet });
        if (expectedNormalization.errors.length > 0) {
          throw new Error(`预填表模板提交目标 Sheet 行标识不合法：${formatCanonicalRowIssues_ACU(expectedNormalization.errors)}`);
        }
        if (!expectedSheet.sourceData || typeof expectedSheet.sourceData !== 'object') expectedSheet.sourceData = {} as any;
        if (!String(expectedSheet.sourceData.ddl || '').trim()) {
          expectedSheet.sourceData.ddl = generateDDL(expectedSheet, expectedSheet.uid || change.sheetKey);
        }
        if (canonicalJson_ACU(templateSheetPersistentProjection_ACU(snapshotSheet as Sheet_ACU)) !== canonicalJson_ACU(templateSheetPersistentProjection_ACU(expectedSheet))) {
          throw new Error(`预填表模板提交的 templateSource 与目标 Sheet 不一致：${change.sheetKey}。`);
        }
      }
      const previousScopeContainer = cloneOptionalJson_ACU(getChatScopedConfigContainer_ACU(chat));
      const previousGuideContainer = cloneOptionalJson_ACU(getChatSheetGuideContainer_ACU(chat));
      try {
        const guideUpdated = setChatSheetGuideDataForIsolationKey_ACU(isolationKey, options.guideData, {
          reason: options.reason || 'visualizer_v2_template_only',
          syncTemplateScope: true,
          templateSource: templateSnapshot,
          presetName: options.presetName,
          source: options.source,
          updatedAt: createdAt,
        });
        if (!guideUpdated) throw new Error('预填表模板提交无法原子写入 guideData 与 template scope。');
        await saveChatToHostStrict_ACU();
        return { saved: true, mode: 'template_only', messageIndex: target.index, checkpoints: [] as TableSheetCheckpointV2_ACU[], removedNullRowCount: 0 };
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
    }

    const targetTagData = target.message?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (!isV2TagData_ACU(targetTagData)) {
      throw new Error('当前楼层模板提交要求目标 AI 楼层已存在合法 V2 storage frame；请先完成既有迁移。');
    }

    const messageSnapshots = snapshotTemplateDeleteMessages_ACU(chat, deletedSheetKeys.length > 0);
    const previousScopeContainer = cloneOptionalJson_ACU(getChatScopedConfigContainer_ACU(chat));
    const previousGuideContainer = cloneOptionalJson_ACU(getChatSheetGuideContainer_ACU(chat));
    let primarySaveAttempted = false;

    try {
      const purgedMessageCount = deletedSheetKeys.length === 0 ? 0 : messageSnapshots.reduce((count, snapshot) => (
        purgeSheetKeysFromMessage_ACU(snapshot.message, deletedSheetKeys) ? count + 1 : count
      ), 0);

    const introductionSheets = new Map<string, Sheet_ACU>();
    let removedNullRowCount = 0;
    for (const change of requestedChanges) {
      const targetSheetData = deepClone_ACU(change.kind === 'introduction' ? change.sheetData : change.targetSheetData);
      if (change.kind === 'introduction' && targetSheetData.content?.length !== 1) {
        throw new Error(`V2 sheet introduction only accepts a header-only sheet: sheetKey=${change.sheetKey}.`);
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
      if (!targetSheetData.sourceData || typeof targetSheetData.sourceData !== 'object') targetSheetData.sourceData = {} as any;
      if (!String(targetSheetData.sourceData.ddl || '').trim()) {
        targetSheetData.sourceData.ddl = generateDDL(targetSheetData, targetSheetData.uid || change.sheetKey);
      }
      const ddlValidation = validateDDLTextAgainstHeaders_ACU(targetSheetData.sourceData.ddl, headers);
      if (!ddlValidation.valid) {
        throw new Error(`V2 当前楼层模板提交 DDL 无法 strict hydrate：${change.sheetKey}：${ddlValidation.message}`);
      }
      createSheetInsertPlan(targetSheetData);
      if (change.kind === 'introduction') introductionSheets.set(change.sheetKey, targetSheetData);
    }

    const isolatedData = cloneIsolatedData_ACU(target.message) as Record<string, any>;
    const frame = isolatedData[isolationKey]?.storageFrame;
    if (!isV2TagData_ACU(isolatedData[isolationKey]) || !frame) {
      throw new Error('目标 V2 storage frame 在模板提交准备期间发生变化。');
    }
    const activeReplayState = await loadTableStateFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: target.index, updateRuntimeState: false });
    if (!activeReplayState) {
      throw new Error('V2 当前楼层模板提交无法解析 active full checkpoint replay state。');
    }
    const checkpoints: TableSheetCheckpointV2_ACU[] = [];
    const scheduleSummaryBySheet = collectScheduleSummaryFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: target.index });
    const targetFrameLastLogSeq = getValidatedFrameLastLogSeq_ACU(frame);
    for (const change of requestedChanges.filter(item => item.kind === 'introduction')) {
      if (
        historyContainsOrCannotDisproveSheet_ACU(chat, isolationKey, target.index, change.sheetKey)
        || Object.prototype.hasOwnProperty.call(activeReplayState, change.sheetKey)
        || Object.prototype.hasOwnProperty.call(frame.perSheetCheckpoints || {}, change.sheetKey)
      ) {
        throw new Error(`V2 sheet introduction requires a genuinely new sheet: sheetKey=${change.sheetKey} already exists in the active checkpoint state.`);
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

    const operationChanges = requestedChanges.filter((change): change is Extract<TemplateSheetChange_ACU, { kind: 'operations' }> => change.kind === 'operations');
    const replayCandidate = deepClone_ACU(activeReplayState);
    const operations = operationChanges.flatMap(change => change.operations.map(operation => deepClone_ACU(operation)));
    for (const change of operationChanges) {
      for (const operation of change.operations) await applyTableOperationV2_ACU(replayCandidate, operation);
      const replayedSheet = replayCandidate[change.sheetKey] as Sheet_ACU | undefined;
      if (!replayedSheet || canonicalJson_ACU(templateSheetPersistentProjection_ACU(replayedSheet)) !== canonicalJson_ACU(templateSheetPersistentProjection_ACU(change.targetSheetData))) {
        throw new Error(`V2 当前楼层模板提交 operation 回放结果与目标 Sheet 不一致：${change.sheetKey}。`);
      }
    }

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

      frame.perSheetCheckpoints = {
        ...(frame.perSheetCheckpoints || {}),
        ...Object.fromEntries(checkpoints.map(checkpoint => [checkpoint.sheetKey, checkpoint])),
      };
      if (entryOptions) appendMutationLogEntry_ACU(frame, entryOptions);
      target.message.TavernDB_ACU_IsolatedData = isolatedData;
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
      primarySaveAttempted = true;
      await saveChatToHostStrict_ACU();
      logDebug_ACU(`[V2 Persist] 当前楼层模板提交完成: messageIndex=${target.index}, checkpoints=${checkpoints.length}, operations=${operations.length}, isolationKey=${isolationKey}`);
      return {
        saved: true,
        mode: 'v2_commit',
        messageIndex: target.index,
        checkpoints,
        removedNullRowCount,
        ...(deletedSheetKeys.length > 0 ? { deletedSheetKeys, purgedMessageCount } : {}),
      };
    } catch (error: any) {
      restoreTemplateDeleteMessageSnapshots_ACU(messageSnapshots);
      setChatScopedConfigContainer_ACU(chat, previousScopeContainer);
      setChatSheetGuideContainer_ACU(chat, previousGuideContainer);
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
