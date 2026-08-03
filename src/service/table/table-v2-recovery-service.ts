import { getChatArray_ACU, saveChatToHostStrict_ACU } from '../../data/gateways/chat-gateway';
import { cloneIsolatedData_ACU, readIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import type { TableDataObject_ACU } from '../../shared/models/table-data';
import { currentChatFileIdentifier_ACU, getCurrentIsolationKey_ACU } from '../runtime/state-manager';
import { buildCanonicalFullCheckpoint_ACU } from './canonical-checkpoint-builder';
import { auditTableDataForUpgrade_ACU, getTableDataFingerprint_ACU } from './table-data-upgrade-audit';
import { repairTableDataFromAudit_ACU, type UpgradeIdRemap_ACU } from './table-data-repair';
import { getCurrentStorageMode } from './storage-mode';
import { isV2TagData_ACU } from './storage-strategy-resolver';
import { didSqliteFallbackAfterReload_ACU, reloadStorageProvider } from './table-storage-strategy';
import { loadTableStateFromFramesV2Detailed_ACU, type TableReplayCompatibilityRepairV2_ACU } from './storage-frame-v2-replay';
import type { TableMutationOperationV2_ACU, TablePatchV2_ACU, TableStorageFrameV2_ACU, TableV2RecoveryBackup_ACU } from './storage-frame-v2-types';
import { runTableWriteTransaction_ACU } from './table-write-transaction';

type RecoveryKind_ACU = 'repaired_full_checkpoint' | 'confirmed_orphan_data_replace' | 'temporary_sheet_anchor_convergence';
export type V2RecoveryStatus_ACU = 'recoverable_repaired_checkpoint' | 'recoverable_orphan_data_replace' | 'recoverable_temporary_sheet_anchor' | 'unrecoverable_no_base' | 'unrecoverable';
export type V2RecoveryCommitStatus_ACU = 'committed' | 'committed_postcondition_failed' | 'commit_failed_rolled_back';

export interface V2RecoveryCommitResult_ACU {
  status: V2RecoveryCommitStatus_ACU;
  planId: string;
  error?: string;
}

export interface CommitPreparedV2RecoveryOptions_ACU {
  confirmOrphanDataReplace?: boolean;
}

export interface V2RecoverySummary_ACU {
  planId?: string;
  status: V2RecoveryStatus_ACU;
  isolationKey: string;
  sourceMessageIndex?: number;
  affectedSheetKeys?: string[];
  compatibilityRepairs?: TableReplayCompatibilityRepairV2_ACU[];
  requiresConfirmation: boolean;
  message: string;
}
export interface V2IsolationDiagnostic_ACU extends V2RecoverySummary_ACU {
  isCurrentIsolation: boolean;
}
interface V2RecoveryDiagnosis_ACU {
  summary: V2RecoverySummary_ACU;
  plan?: Omit<RecoveryPlan_ACU, 'planId'>;
}
interface RecoveryPlan_ACU extends V2RecoverySummary_ACU {
  kind: RecoveryKind_ACU;
  chat: any[];
  chatKey: string;
  sourceFrameFingerprint: string;
  candidateData: TableDataObject_ACU;
}
const plans_ACU = new Map<string, RecoveryPlan_ACU>();
function clone_ACU<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function buildPlanId_ACU(): string { return `v2_recovery_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function getErrorMessage_ACU(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}
function getFrameFingerprint_ACU(frame: TableStorageFrameV2_ACU): string {
  return JSON.stringify(frame);
}
function currentScopeMatches_ACU(plan: RecoveryPlan_ACU): boolean {
  return getChatArray_ACU() === plan.chat
    && String(currentChatFileIdentifier_ACU || '').trim() === plan.chatKey
    && getCurrentIsolationKey_ACU() === plan.isolationKey;
}
function getFrames_ACU(chat: any[], isolationKey: string): Array<{ messageIndex: number; frame: TableStorageFrameV2_ACU }> {
  const frames: Array<{ messageIndex: number; frame: TableStorageFrameV2_ACU }> = [];
  for (let messageIndex = 0; messageIndex < chat.length; messageIndex += 1) {
    const message = chat[messageIndex];
    if (!message || message.is_user) continue;
    const tagData = readIsolatedTagData_ACU(message, isolationKey);
    if (isV2TagData_ACU(tagData)) frames.push({ messageIndex, frame: tagData.storageFrame });
  }
  return frames;
}
function hasReplayArtifactsAfterCheckpoint_ACU(frame: TableStorageFrameV2_ACU): boolean {
  return (frame.logEntries?.length || 0) > 0
    || Object.keys(frame.perSheetCheckpoints || {}).length > 0
    || !!frame.manualRefillProgress;
}
function hasAnyReplayArtifacts_ACU(frame: TableStorageFrameV2_ACU): boolean {
  return !!frame.checkpoint || hasReplayArtifactsAfterCheckpoint_ACU(frame);
}
function isIsolatedDataReplaceFrame_ACU(frame: TableStorageFrameV2_ACU): boolean {
  if (Object.keys(frame.perSheetCheckpoints || {}).length > 0 || frame.manualRefillProgress) return false;
  if ((frame.logEntries?.length || 0) !== 1) return false;
  const entry = frame.logEntries[0];
  return !entry?.patches?.length
    && Array.isArray(entry.operations)
    && entry.operations.length === 1
    && entry.operations[0]?.kind === 'data_replace';
}
function hasLaterReplayArtifacts_ACU(
  frames: Array<{ messageIndex: number; frame: TableStorageFrameV2_ACU }>,
  sourceMessageIndex: number,
): boolean {
  return frames.some(item => item.messageIndex > sourceMessageIndex && hasAnyReplayArtifacts_ACU(item.frame));
}

function canonicalRowId_ACU(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const rowId = String(value).trim();
  return rowId || null;
}
function buildRemappedRowIdKeys_ACU(idRemap: UpgradeIdRemap_ACU[]): Set<string> {
  const keys = new Set<string>();
  for (const remap of idRemap) {
    const rowId = canonicalRowId_ACU(remap.previousRowId);
    if (rowId) keys.add(`${remap.sheetKey}\u0000${rowId}`);
  }
  return keys;
}
function operationReferencesRemappedRowId_ACU(
  operation: TableMutationOperationV2_ACU | TablePatchV2_ACU,
  remappedRowIdKeys: Set<string>,
): string | null {
  if (operation.kind === 'row_upsert' || operation.kind === 'row_delete') {
    const rowId = canonicalRowId_ACU(operation.rowId);
    return rowId && remappedRowIdKeys.has(`${operation.sheetKey}\u0000${rowId}`) ? rowId : null;
  }
  const referencesBoundRemappedRowId = (statements: string[], params: unknown[][] | undefined, sheetKey?: string): string | null => {
    for (let index = 0; index < statements.length; index += 1) {
      if (!/\brow_id\b/i.test(statements[index] || '')) continue;
      for (const value of params?.[index] || []) {
        const rowId = canonicalRowId_ACU(value);
        if (!rowId) continue;
        if (sheetKey) {
          if (remappedRowIdKeys.has(`${sheetKey}\u0000${rowId}`)) return rowId;
        } else if ([...remappedRowIdKeys].some(key => key.endsWith(`\u0000${rowId}`))) {
          return rowId;
        }
      }
    }
    return null;
  };
  if (operation.kind === 'sql_sheet_batch') {
    return referencesBoundRemappedRowId(operation.statements, operation.params, operation.sheetKey);
  }
  if (operation.kind === 'sql_batch') {
    return referencesBoundRemappedRowId(operation.statements, operation.params);
  }
  return null;
}
function findAmbiguousRowIdReference_ACU(
  frames: Array<{ messageIndex: number; frame: TableStorageFrameV2_ACU }>,
  sourceMessageIndex: number,
  idRemap: UpgradeIdRemap_ACU[],
): string | null {
  const remappedRowIdKeys = buildRemappedRowIdKeys_ACU(idRemap);
  if (remappedRowIdKeys.size === 0) return null;
  for (const item of frames) {
    if (item.messageIndex < sourceMessageIndex) continue;
    for (const entry of item.frame.logEntries || []) {
      for (const operation of [...(entry.operations || []), ...(entry.patches || [])]) {
        const rowId = operationReferencesRemappedRowId_ACU(operation, remappedRowIdKeys);
        if (rowId) return `messageIndex=${item.messageIndex}、seq=${entry.seq} 的 ${operation.kind} 引用了重映射前的 row_id=${rowId}`;
      }
    }
  }
  return null;
}

function hasSamePlanScope_ACU(left: RecoveryPlan_ACU, right: RecoveryPlan_ACU): boolean {
  return left.chat === right.chat
    && left.chatKey === right.chatKey
    && left.isolationKey === right.isolationKey;
}

function createPlan_ACU(plan: Omit<RecoveryPlan_ACU, 'planId'>): V2RecoverySummary_ACU {
  for (const [existingPlanId, existingPlan] of plans_ACU) {
    if (hasSamePlanScope_ACU(existingPlan, plan as RecoveryPlan_ACU)) plans_ACU.delete(existingPlanId);
  }
  const planId = buildPlanId_ACU();
  plans_ACU.set(planId, { ...plan, planId });
  return {
    planId,
    status: plan.status,
    isolationKey: plan.isolationKey,
    sourceMessageIndex: plan.sourceMessageIndex,
    ...(plan.affectedSheetKeys?.length ? { affectedSheetKeys: clone_ACU(plan.affectedSheetKeys) } : {}),
    ...(plan.compatibilityRepairs?.length ? { compatibilityRepairs: clone_ACU(plan.compatibilityRepairs) } : {}),
    requiresConfirmation: plan.requiresConfirmation,
    message: plan.message,
  };
}
function getPlanSourceFrame_ACU(plan: RecoveryPlan_ACU): TableStorageFrameV2_ACU | null {
  if (!Number.isInteger(plan.sourceMessageIndex)) return null;
  const message = plan.chat[plan.sourceMessageIndex as number];
  const tagData = readIsolatedTagData_ACU(message, plan.isolationKey);
  return isV2TagData_ACU(tagData) ? tagData.storageFrame : null;
}
function buildRecoveredCandidateChat_ACU(plan: RecoveryPlan_ACU): any[] {
  const sourceMessageIndex = plan.sourceMessageIndex;
  if (!Number.isInteger(sourceMessageIndex)) throw new Error('恢复计划缺少 sourceMessageIndex。');
  const candidateChat = clone_ACU(plan.chat);
  const sourceMessage = candidateChat[sourceMessageIndex as number];
  const sourceTagData = readIsolatedTagData_ACU(sourceMessage, plan.isolationKey);
  if (!isV2TagData_ACU(sourceTagData)) throw new Error('恢复源消息不再包含 V2 storage frame。');

  const checkpointBuild = buildCanonicalFullCheckpoint_ACU({
    createdAt: Date.now(),
    reason: 'integrity_repair',
    data: plan.candidateData,
  });
  if (!checkpointBuild.checkpoint) throw new Error(checkpointBuild.error);

  const recoveryBackup: TableV2RecoveryBackup_ACU = {
    version: 1,
    createdAt: Date.now(),
    recoveryKind: plan.kind,
    sourceMessageIndex,
    failedMessageIndex: sourceMessageIndex,
    storageFrame: clone_ACU(sourceTagData.storageFrame),
  };
  const isolatedData = cloneIsolatedData_ACU(sourceMessage);
  const recoveredFrame: TableStorageFrameV2_ACU = { version: 2, checkpoint: checkpointBuild.checkpoint, logEntries: [] };
  const nextTagData = {
    ...isolatedData[plan.isolationKey],
    _acu_storage_version: 2 as const,
    storageFrame: recoveredFrame,
    recoveryBackup,
  };
  isolatedData[plan.isolationKey] = nextTagData;
  sourceMessage.TavernDB_ACU_IsolatedData = isolatedData;
  return candidateChat;
}
async function validateRecoveredCandidateReplay_ACU(plan: RecoveryPlan_ACU, candidateChat: any[]): Promise<void> {
  const replay = await loadTableStateFromFramesV2Detailed_ACU(candidateChat, plan.isolationKey, {
    updateRuntimeState: false,
    compatibilityMode: 'disabled',
  });
  if (!replay) throw new Error('恢复候选未产生可回放表数据。');
  if (replay.requiresCheckpointConvergence || replay.compatibilityRepairs?.length) throw new Error('恢复候选仍依赖临时 Sheet 补锚。');
  if (getTableDataFingerprint_ACU(replay.data) !== getTableDataFingerprint_ACU(plan.candidateData)) {
    throw new Error('恢复候选 replay 结果与修复数据不一致。');
  }
}
function repairCandidate_ACU(data: unknown): { candidateData: TableDataObject_ACU | null; idRemap: UpgradeIdRemap_ACU[]; status: 'clean' | 'repairable' | 'requires_confirmation' | 'unrecoverable' } {
  const audit = auditTableDataForUpgrade_ACU(data);
  if (audit.status !== 'repairable') return { candidateData: null, idRemap: [], status: audit.status };
  const repair = repairTableDataFromAudit_ACU(audit);
  return {
    candidateData: repair.requiresConfirmation ? null : repair.candidateData as TableDataObject_ACU,
    idRemap: repair.idRemap,
    status: audit.status,
  };
}
function findOrphanDataReplace_ACU(frame: TableStorageFrameV2_ACU): TableDataObject_ACU | null {
  let candidate: TableDataObject_ACU | null = null;
  for (const entry of frame.logEntries || []) for (const operation of entry?.operations || []) {
    if (operation?.kind === 'data_replace') candidate = operation.data;
  }
  return candidate;
}
async function diagnoseV2Recovery_ACU(chat: any[], isolationKey: string): Promise<V2RecoveryDiagnosis_ACU> {
  const frames = getFrames_ACU(chat, isolationKey);
  if (frames.length === 0) return { summary: { status: 'unrecoverable_no_base', isolationKey, requiresConfirmation: false, message: '当前隔离标识不存在 V2 storage frame。' } };
  const latestFull = [...frames].reverse().find(item => item.frame.checkpoint?.kind === 'full');
  if (latestFull?.frame.checkpoint) {
    const repair = repairCandidate_ACU(latestFull.frame.checkpoint.data);
    if (repair.status === 'clean') {
      let replay;
      try {
        replay = await loadTableStateFromFramesV2Detailed_ACU(chat, isolationKey, { updateRuntimeState: false });
      } catch (error) {
        return { summary: { status: 'unrecoverable', isolationKey, sourceMessageIndex: latestFull.messageIndex, requiresConfirmation: false, message: `full checkpoint 虽通过静态审计，但完整回放失败：${getErrorMessage_ACU(error)}` } };
      }
      if (replay?.requiresCheckpointConvergence && replay.compatibilityRepairs?.length) {
        const source = frames[frames.length - 1];
        const repairedSheetKeys = [...new Set(replay.compatibilityRepairs.map(item => item.sheetKey))];
        const repairPositions = replay.compatibilityRepairs.map(item => `#${item.messageIndex}/seq=${item.seq}/op=${item.operationIndex}`).join('、');
        const summary: V2RecoverySummary_ACU = {
          status: 'recoverable_temporary_sheet_anchor', isolationKey, sourceMessageIndex: source.messageIndex,
          affectedSheetKeys: repairedSheetKeys,
          compatibilityRepairs: clone_ACU(replay.compatibilityRepairs),
          requiresConfirmation: false,
          message: `检测到历史回放依赖临时 Sheet 补锚（${repairedSheetKeys.join('、')}，位置 ${repairPositions}）；可通过 integrity_repair full checkpoint 自动收敛。`,
        };
        return { summary, plan: {
          ...summary, kind: 'temporary_sheet_anchor_convergence', chat,
          chatKey: String(currentChatFileIdentifier_ACU || '').trim(),
          sourceFrameFingerprint: getFrameFingerprint_ACU(source.frame), candidateData: replay.data,
        } };
      }
      const isTemplateFallbackRoot = latestFull.frame.checkpoint.fallbackProvenance?.kind === 'manual_refill_template_root';
      return {
        summary: {
          status: 'unrecoverable',
          isolationKey,
          sourceMessageIndex: latestFull.messageIndex,
          requiresConfirmation: false,
          message: isTemplateFallbackRoot
            ? '最新 full checkpoint 是可正常回放的手动重填模板临时根；无需完整性恢复，后续边界 compaction 会将其固化为正式 checkpoint。'
            : '最新 full checkpoint 已通过完整性审计，无需恢复。',
        },
      };
    }
    if (!repair.candidateData) return { summary: { status: 'unrecoverable', isolationKey, sourceMessageIndex: latestFull.messageIndex, requiresConfirmation: false, message: '最新 full checkpoint 不可无损自动修复；请先导出原始 frame。' } };
    if (hasReplayArtifactsAfterCheckpoint_ACU(latestFull.frame) || hasLaterReplayArtifacts_ACU(frames, latestFull.messageIndex)) {
      const ambiguity = findAmbiguousRowIdReference_ACU(frames, latestFull.messageIndex, repair.idRemap);
      const message = ambiguity
        ? `重复 row_id 修复会改变后续引用的语义：${ambiguity}；拒绝猜测。`
        : '坏 full checkpoint 之后仍存在 V2 replay artifact；无法证明替换不会截断数据，拒绝自动恢复。';
      return { summary: { status: 'unrecoverable', isolationKey, sourceMessageIndex: latestFull.messageIndex, requiresConfirmation: false, message } };
    }
    const summary: V2RecoverySummary_ACU = { status: 'recoverable_repaired_checkpoint', isolationKey, sourceMessageIndex: latestFull.messageIndex, requiresConfirmation: false, message: '已生成 full 修复候选。' };
    return { summary, plan: { ...summary, kind: 'repaired_full_checkpoint', chat, chatKey: String(currentChatFileIdentifier_ACU || '').trim(), sourceFrameFingerprint: getFrameFingerprint_ACU(latestFull.frame), candidateData: repair.candidateData } };
  }
  for (const item of [...frames].reverse()) {
    if (!isIsolatedDataReplaceFrame_ACU(item.frame)) continue;
    if (hasLaterReplayArtifacts_ACU(frames, item.messageIndex)) return { summary: { status: 'unrecoverable', isolationKey, sourceMessageIndex: item.messageIndex, requiresConfirmation: false, message: '无锚点 data_replace 之后仍存在 V2 replay artifact；无法证明替换不会截断数据，拒绝自动恢复。' } };
    const candidateData = findOrphanDataReplace_ACU(item.frame);
    if (!candidateData) continue;
    const repair = repairCandidate_ACU(candidateData);
    if (repair.status !== 'clean' && !repair.candidateData) return { summary: { status: 'unrecoverable', isolationKey, sourceMessageIndex: item.messageIndex, requiresConfirmation: false, message: '无锚点 data_replace 不满足无损自动修复条件。' } };
    const summary: V2RecoverySummary_ACU = { status: 'recoverable_orphan_data_replace', isolationKey, sourceMessageIndex: item.messageIndex, requiresConfirmation: true, message: '检测到无锚点 data_replace；必须明确确认后才会提升为 full checkpoint。' };
    return { summary, plan: { ...summary, kind: 'confirmed_orphan_data_replace', chat, chatKey: String(currentChatFileIdentifier_ACU || '').trim(), sourceFrameFingerprint: getFrameFingerprint_ACU(item.frame), candidateData: repair.candidateData || candidateData } };
  }
  return { summary: { status: 'unrecoverable_no_base', isolationKey, requiresConfirmation: false, message: '仅检测到无 base 的 V2 日志；无法编造恢复数据。' } };
}
export async function scanV2IsolationDiagnostics_ACU(chat: any[] = getChatArray_ACU()): Promise<V2IsolationDiagnostic_ACU[]> {
  const isolationKeys = new Set<string>();
  for (const message of chat) {
    if (message?.is_user) continue;
    const isolatedData = message?.TavernDB_ACU_IsolatedData;
    if (!isolatedData || typeof isolatedData !== 'object' || Array.isArray(isolatedData)) continue;
    for (const isolationKey of Object.keys(isolatedData)) {
      if (isV2TagData_ACU(isolatedData[isolationKey])) isolationKeys.add(isolationKey);
    }
  }
  const currentIsolationKey = getCurrentIsolationKey_ACU();
  const diagnostics = await Promise.all([...isolationKeys].map(async isolationKey => ({
    ...(await diagnoseV2Recovery_ACU(chat, isolationKey)).summary,
    isCurrentIsolation: isolationKey === currentIsolationKey,
  })));
  return diagnostics;
}
export async function prepareV2Recovery_ACU(options: { chat?: any[]; isolationKey?: string } = {}): Promise<V2RecoverySummary_ACU> {
  const chat = options.chat || getChatArray_ACU();
  const isolationKey = options.isolationKey ?? getCurrentIsolationKey_ACU();
  const diagnosis = await diagnoseV2Recovery_ACU(chat, isolationKey);
  return diagnosis.plan ? createPlan_ACU(diagnosis.plan) : diagnosis.summary;
}

export async function commitPreparedV2Recovery_ACU(
  planId: string,
  options: CommitPreparedV2RecoveryOptions_ACU = {},
): Promise<V2RecoveryCommitResult_ACU> {
  const plan = plans_ACU.get(planId);
  const failure = (error: string): V2RecoveryCommitResult_ACU => ({ status: 'commit_failed_rolled_back', planId, error });
  if (!plan) return failure('恢复计划不存在或已失效，请重新诊断。');
  if (plan.requiresConfirmation && options.confirmOrphanDataReplace !== true) {
    return failure('无锚点 data_replace 恢复必须显式确认。');
  }
  if (!currentScopeMatches_ACU(plan)) {
    plans_ACU.delete(planId);
    return failure('恢复计划作用域已变化，请重新诊断。');
  }
  const currentSourceFrame = getPlanSourceFrame_ACU(plan);
  if (!currentSourceFrame || getFrameFingerprint_ACU(currentSourceFrame) !== plan.sourceFrameFingerprint) {
    plans_ACU.delete(planId);
    return failure('恢复源 frame 已变化，请重新诊断。');
  }

  let candidateChat: any[];
  try {
    candidateChat = buildRecoveredCandidateChat_ACU(plan);
  } catch (error) {
    return failure(`恢复候选构造失败：${getErrorMessage_ACU(error)}`);
  }
  try {
    await validateRecoveredCandidateReplay_ACU(plan, candidateChat);
  } catch (error) {
    return failure(`恢复候选 replay 校验失败，未保存任何更改：${getErrorMessage_ACU(error)}`);
  }

  const commitResult = await runTableWriteTransaction_ACU<V2RecoveryCommitResult_ACU>({
    source: 'system',
    reason: 'v2_integrity_recovery',
    isolationKey: plan.isolationKey,
    writeSet: [{ kind: 'all' }],
    maintenanceMode: 'exclusive',
  }, async (ctx) => {
    try {
      return await ctx.runCommit(async () => {
        if (!currentScopeMatches_ACU(plan)) {
          plans_ACU.delete(planId);
          return failure('恢复计划作用域已变化，请重新诊断。');
        }
        const frameBeforeCommit = getPlanSourceFrame_ACU(plan);
        if (!frameBeforeCommit || getFrameFingerprint_ACU(frameBeforeCommit) !== plan.sourceFrameFingerprint) {
          plans_ACU.delete(planId);
          return failure('恢复源 frame 已变化，请重新诊断。');
        }

        const beforeChat = clone_ACU(plan.chat);
        plan.chat.splice(0, plan.chat.length, ...candidateChat);
        try {
          await saveChatToHostStrict_ACU();
        } catch (error) {
          plan.chat.splice(0, plan.chat.length, ...beforeChat);
          return failure(`宿主保存失败，已恢复内存聊天：${getErrorMessage_ACU(error)}`);
        }

        plans_ACU.delete(planId);
        if (!currentScopeMatches_ACU(plan)) {
          return failure('宿主保存后恢复计划作用域已变化。');
        }
        return { status: 'committed', planId };
      });
    } catch (error) {
      return failure(getErrorMessage_ACU(error));
    }
  });
  if (commitResult.status !== 'committed') return commitResult;

  const expectedStorageMode = getCurrentStorageMode();
  try {
    if (expectedStorageMode === 'sqlite') {
      await reloadStorageProvider();
      if (didSqliteFallbackAfterReload_ACU(expectedStorageMode)) {
        throw new Error('SQLite 运行时重载后已静默回退到 native provider。');
      }
    }
    if (!currentScopeMatches_ACU(plan)) throw new Error('宿主保存后运行时重载期间恢复计划作用域已变化。');
    return commitResult;
  } catch (error) {
    return { status: 'committed_postcondition_failed', planId, error: getErrorMessage_ACU(error) };
  }
}
