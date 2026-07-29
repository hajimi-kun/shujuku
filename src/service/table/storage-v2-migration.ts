import { getChatArray_ACU, saveChatToHostStrict_ACU } from '../../data/gateways/chat-gateway';
import type { IsolationConfig_ACU } from '../../data/models/chat-message-data';
import { cloneIsolatedData_ACU, isLegacyMatchForIsolation_ACU, readIsolatedTagData_ACU, readLegacyIndependentData_ACU, readLegacyStandardData_ACU, readLegacySummaryData_ACU, readModifiedKeys_ACU, readUpdateGroupKeys_ACU, writeMessageIdentity_ACU } from '../../data/repositories/chat-message-data-repo';
import { currentChatFileIdentifier_ACU, getCurrentIsolationKey_ACU } from '../runtime/state-manager';
import type { TableDataObject_ACU } from '../../shared/models/table-data';
import { validateMigrationProvenanceV1_ACU } from '../../shared/canonical-checkpoint-validator';
import { logDebug_ACU } from '../../shared/utils';
import { isV2TagData_ACU, resolveTableStorageStrategy_ACU } from './storage-strategy-resolver';
import type { TableCheckpointScheduleSummaryV2_ACU, TableMigrationProvenanceV1_ACU, TableStorageFrameV2_ACU } from './storage-frame-v2-types';
import { commitMixedStorageDecision_ACU } from './mixed-storage-commit';
import { evaluateMixedStorageDecision_ACU, type MixedStorageDecision_ACU } from './mixed-storage-decision';
import { registerMixedStorageDecision_ACU } from './mixed-storage-decision-registry';
import { buildCanonicalFullCheckpoint_ACU } from './canonical-checkpoint-builder';
import { auditTableDataForUpgrade_ACU, getTableDataFingerprint_ACU } from './table-data-upgrade-audit';
import { repairTableDataFromAudit_ACU } from './table-data-repair';

export interface LegacyToV2MigrationOptions_ACU {
  data: Record<string, any> | null;
  isolationKey: string;
  isolationConfig: IsolationConfig_ACU;
  skipUpdateFloors?: number;
}

export interface LegacyToV2MigrationResult_ACU {
  migrated: boolean;
  messageIndex?: number;
  data?: TableDataObject_ACU;
  error?: string;
  mixedDecision?: MixedStorageDecision_ACU;
}

type LegacyScheduleSummary_ACU = Record<string, TableCheckpointScheduleSummaryV2_ACU>;

function deepClone_ACU<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function sheetKeysOfData_ACU(data: Record<string, any> | null | undefined): string[] {
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data).filter(key => key.startsWith('sheet_') && Boolean((data as any)[key]));
}

function countAiFloor_ACU(chat: any[], messageIndex: number): number {
  let count = 0;
  for (let i = 0; i <= messageIndex && i < chat.length; i += 1) {
    if (chat[i] && !chat[i].is_user) count += 1;
  }
  return count;
}

function normalizeSkipUpdateFloors_ACU(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

function resolveMigrationSkipUpdateFloors_ACU(data: Record<string, any> | null | undefined, inheritedSkip: unknown): number {
  let maxSkip = normalizeSkipUpdateFloors_ACU(inheritedSkip);
  for (const sheetKey of sheetKeysOfData_ACU(data)) {
    const rawSkip = (data as any)?.[sheetKey]?.updateConfig?.skipFloors;
    if (Number.isFinite(rawSkip) && rawSkip >= 0) {
      maxSkip = Math.max(maxSkip, normalizeSkipUpdateFloors_ACU(rawSkip));
    }
  }
  return maxSkip;
}

function findMigrationTargetAiMessage_ACU(chat: any[], skipUpdateFloors: number): { message: any; index: number } | null {
  const aiMessages: { message: any; index: number }[] = [];
  for (let i = 0; i < chat.length; i += 1) {
    if (chat[i] && !chat[i].is_user) aiMessages.push({ message: chat[i], index: i });
  }
  if (aiMessages.length === 0) return null;

  const normalizedSkip = normalizeSkipUpdateFloors_ACU(skipUpdateFloors);
  const targetAiIndex = Math.max(0, aiMessages.length - 1 - normalizedSkip);
  return aiMessages[targetAiIndex];
}

function noteFilled_ACU(summary: LegacyScheduleSummary_ACU, sheetKey: string, aiFloor: number): void {
  if (!summary[sheetKey]) summary[sheetKey] = {};
  summary[sheetKey].lastFilledAiFloor = Math.max(summary[sheetKey].lastFilledAiFloor || 0, aiFloor);
}

function noteChanged_ACU(summary: LegacyScheduleSummary_ACU, sheetKey: string, aiFloor: number): void {
  if (!summary[sheetKey]) summary[sheetKey] = {};
  summary[sheetKey].lastChangedAiFloor = Math.max(summary[sheetKey].lastChangedAiFloor || 0, aiFloor);
}

function noteFilledAndChanged_ACU(summary: LegacyScheduleSummary_ACU, sheetKey: string, aiFloor: number): void {
  noteFilled_ACU(summary, sheetKey, aiFloor);
  noteChanged_ACU(summary, sheetKey, aiFloor);
}

function normalizeSheetKeys_ACU(value: unknown, allowedSheetKeys: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && allowedSheetKeys.has(item)))];
}

function collectContainerSheetKeys_ACU(container: unknown, allowedSheetKeys: Set<string>): string[] {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return [];
  return Object.keys(container as Record<string, unknown>).filter(key => allowedSheetKeys.has(key));
}

function applyLegacyTracking_ACU(
  summary: LegacyScheduleSummary_ACU,
  aiFloor: number,
  allowedSheetKeys: Set<string>,
  options: {
    dataKeys?: string[];
    deltaKeys?: string[];
    modifiedKeys?: string[];
    updateGroupKeys?: string[];
  },
): void {
  const dataKeys = normalizeSheetKeys_ACU(options.dataKeys || [], allowedSheetKeys);
  const deltaKeys = normalizeSheetKeys_ACU(options.deltaKeys || [], allowedSheetKeys);
  const modifiedKeys = normalizeSheetKeys_ACU(options.modifiedKeys || [], allowedSheetKeys);
  const updateGroupKeys = normalizeSheetKeys_ACU(options.updateGroupKeys || [], allowedSheetKeys);

  updateGroupKeys.forEach(sheetKey => noteFilled_ACU(summary, sheetKey, aiFloor));
  modifiedKeys.forEach(sheetKey => noteFilledAndChanged_ACU(summary, sheetKey, aiFloor));
  deltaKeys.forEach(sheetKey => noteFilledAndChanged_ACU(summary, sheetKey, aiFloor));

  if (updateGroupKeys.length === 0 && modifiedKeys.length === 0 && deltaKeys.length === 0) {
    dataKeys.forEach(sheetKey => noteFilledAndChanged_ACU(summary, sheetKey, aiFloor));
  }
}

interface LegacyMigrationSourceEvidence_ACU {
  scheduleSummary: LegacyScheduleSummary_ACU;
  sourceMessageIndices: number[];
  sourceAiFloors: number[];
}

export function collectLegacyScheduleSummaryForMigration_ACU(
  chat: any[] | null | undefined,
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
  data: Record<string, any> | null,
  options: { maxMessageIndex?: number } = {},
): LegacyScheduleSummary_ACU {
  return collectLegacyMigrationSourceEvidence_ACU(chat, isolationKey, isolationConfig, data, options).scheduleSummary;
}

function collectLegacyMigrationSourceEvidence_ACU(
  chat: any[] | null | undefined,
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
  data: Record<string, any> | null,
  options: { maxMessageIndex?: number } = {},
): LegacyMigrationSourceEvidence_ACU {
  if (!Array.isArray(chat) || chat.length === 0) return { scheduleSummary: {}, sourceMessageIndices: [], sourceAiFloors: [] };
  const allowedSheetKeys = new Set(sheetKeysOfData_ACU(data));
  if (allowedSheetKeys.size === 0) return { scheduleSummary: {}, sourceMessageIndices: [], sourceAiFloors: [] };

  const maxMessageIndex = Number.isInteger(options.maxMessageIndex)
    ? Math.max(0, Math.min(chat.length - 1, options.maxMessageIndex as number))
    : chat.length - 1;
  const summary: LegacyScheduleSummary_ACU = {};
  const sourceMessageIndices: number[] = [];
  const sourceAiFloors: number[] = [];
  for (let i = 0; i <= maxMessageIndex; i += 1) {
    const message = chat[i];
    if (!message || message.is_user) continue;
    const aiFloor = countAiFloor_ACU(chat, i);
    let hasLegacySource = false;

    const tagData = readIsolatedTagData_ACU(message, isolationKey) as any;
    if (tagData && !isV2TagData_ACU(tagData)) {
      const dataKeys = collectContainerSheetKeys_ACU(tagData.independentData, allowedSheetKeys);
      const deltaKeys = collectContainerSheetKeys_ACU(tagData.incrementalData, allowedSheetKeys);
      const modifiedKeys = normalizeSheetKeys_ACU(tagData.modifiedKeys, allowedSheetKeys);
      const updateGroupKeys = normalizeSheetKeys_ACU(tagData.updateGroupKeys, allowedSheetKeys);
      hasLegacySource = hasLegacySource || dataKeys.length > 0 || deltaKeys.length > 0 || modifiedKeys.length > 0 || updateGroupKeys.length > 0;
      applyLegacyTracking_ACU(summary, aiFloor, allowedSheetKeys, {
        dataKeys,
        deltaKeys,
        modifiedKeys,
        updateGroupKeys,
      });
    }

    if (isLegacyMatchForIsolation_ACU(message, isolationConfig)) {
      const dataKeys = [
        ...collectContainerSheetKeys_ACU(readLegacyIndependentData_ACU(message), allowedSheetKeys),
        ...collectContainerSheetKeys_ACU(readLegacyStandardData_ACU(message), allowedSheetKeys),
        ...collectContainerSheetKeys_ACU(readLegacySummaryData_ACU(message), allowedSheetKeys),
      ];
      const modifiedKeys = normalizeSheetKeys_ACU(readModifiedKeys_ACU(message), allowedSheetKeys);
      const updateGroupKeys = normalizeSheetKeys_ACU(readUpdateGroupKeys_ACU(message), allowedSheetKeys);
      hasLegacySource = hasLegacySource || dataKeys.length > 0 || modifiedKeys.length > 0 || updateGroupKeys.length > 0;
      applyLegacyTracking_ACU(summary, aiFloor, allowedSheetKeys, {
        dataKeys,
        modifiedKeys,
        updateGroupKeys,
      });
    }
    if (hasLegacySource) {
      sourceMessageIndices.push(i);
      sourceAiFloors.push(aiFloor);
    }
  }

  return { scheduleSummary: summary, sourceMessageIndices, sourceAiFloors };
}

function removeLegacyIsolatedSlot_ACU(message: any, isolationKey: string): void {
  const isolatedData = cloneIsolatedData_ACU(message) as Record<string, any>;
  if (!isolatedData || typeof isolatedData !== 'object' || !Object.prototype.hasOwnProperty.call(isolatedData, isolationKey)) return;

  if (isV2TagData_ACU(isolatedData[isolationKey])) {
    message.TavernDB_ACU_IsolatedData = isolatedData;
    return;
  }

  delete isolatedData[isolationKey];
  if (Object.keys(isolatedData).length === 0) {
    delete message.TavernDB_ACU_IsolatedData;
  } else {
    message.TavernDB_ACU_IsolatedData = isolatedData;
  }
}

function removeLegacyTopLevelFields_ACU(message: any, isolationConfig: IsolationConfig_ACU): void {
  if (!isLegacyMatchForIsolation_ACU(message, isolationConfig)) return;
  delete message.TavernDB_ACU_IndependentData;
  delete message.TavernDB_ACU_Data;
  delete message.TavernDB_ACU_SummaryData;
  delete message.TavernDB_ACU_ModifiedKeys;
  delete message.TavernDB_ACU_UpdateGroupKeys;
  delete message.TavernDB_ACU_Identity;
}

function cleanupLegacyFieldsAfterV2Write_ACU(chat: any[], isolationKey: string, isolationConfig: IsolationConfig_ACU): void {
  for (const message of chat) {
    if (!message) continue;
    removeLegacyIsolatedSlot_ACU(message, isolationKey);
    removeLegacyTopLevelFields_ACU(message, isolationConfig);
  }
}

function buildMigrationRevision_ACU(): string {
  return `checkpoint:migration:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

interface LegacyMigrationScopeSnapshot_ACU {
  chat: any[];
  chatKey: string;
  activeIsolationKey: string;
}

function captureLegacyMigrationScope_ACU(chat: any[]): LegacyMigrationScopeSnapshot_ACU {
  return {
    chat,
    chatKey: String(currentChatFileIdentifier_ACU || '').trim(),
    activeIsolationKey: getCurrentIsolationKey_ACU(),
  };
}

function getLegacyMigrationScopeChangeError_ACU(snapshot: LegacyMigrationScopeSnapshot_ACU): string | null {
  if (getChatArray_ACU() !== snapshot.chat) {
    return 'legacy migration aborted: active chat changed before commit';
  }
  if (String(currentChatFileIdentifier_ACU || '').trim() !== snapshot.chatKey) {
    return 'legacy migration aborted: active chat identifier changed before commit';
  }
  if (getCurrentIsolationKey_ACU() !== snapshot.activeIsolationKey) {
    return 'legacy migration aborted: active isolation changed before commit';
  }
  return null;
}

export async function migrateLegacyStorageToV2OnLoad_ACU(
  options: LegacyToV2MigrationOptions_ACU,
): Promise<LegacyToV2MigrationResult_ACU> {
  const chat = getChatArray_ACU();
  if (!Array.isArray(chat) || chat.length === 0) {
    return { migrated: false, error: 'chat history is empty' };
  }
  const scopeSnapshot = captureLegacyMigrationScope_ACU(chat);

  const sheetKeys = sheetKeysOfData_ACU(options.data);
  if (sheetKeys.length === 0) {
    return { migrated: false, error: 'legacy migration requires non-empty merged table data' };
  }

  const strategy = resolveTableStorageStrategy_ACU(chat, options.isolationKey, options.isolationConfig);
  if (strategy.mode !== 'legacy-v1') {
    return { migrated: false };
  }

  const skipUpdateFloors = resolveMigrationSkipUpdateFloors_ACU(options.data, options.skipUpdateFloors);
  const target = findMigrationTargetAiMessage_ACU(chat, skipUpdateFloors);
  if (!target) {
    return { migrated: false, error: 'no AI message found for legacy migration' };
  }

  const audit = auditTableDataForUpgrade_ACU(options.data);
  if (audit.status === 'unrecoverable') {
    return { migrated: false, error: `legacy migration audit failed: ${audit.issues.map(issue => issue.code).join(', ')}` };
  }
  const repair = repairTableDataFromAudit_ACU(audit);
  if (repair.requiresConfirmation) {
    return { migrated: false, error: `legacy migration requires confirmation: ${audit.issues.map(issue => issue.code).join(', ')}` };
  }
  const candidateData = repair.candidateData as TableDataObject_ACU;
  const hasV2Data = chat.some(message => !message?.is_user
    && isV2TagData_ACU(readIsolatedTagData_ACU(message, options.isolationKey)));
  if (hasV2Data) {
    const mixedDecision = await evaluateMixedStorageDecision_ACU({
      chat,
      isolationKey: options.isolationKey,
      isolationConfig: options.isolationConfig,
      legacyData: candidateData,
    });
    if (mixedDecision.kind !== 'equivalent_provenance_verified' && mixedDecision.kind !== 'v2_successor_verified') {
      registerMixedStorageDecision_ACU(mixedDecision, options.isolationConfig);
      return {
        migrated: false,
        mixedDecision,
        error: `mixed legacy-v1 and V2 data detected: ${mixedDecision.kind}; automatic migration remains blocked`,
      };
    }
    const commit = await commitMixedStorageDecision_ACU({
      decision: mixedDecision,
      action: 'keep_v2',
      isolationConfig: options.isolationConfig,
    });
    if (commit.status !== 'committed') {
      return {
        migrated: false,
        mixedDecision,
        error: `mixed legacy-v1 and V2 verified cleanup failed: ${commit.error || commit.status}`,
      };
    }
    const data = mixedDecision.evidence.v2.replay.data || candidateData;
    return { migrated: true, data, mixedDecision };
  }
  const candidateChat = deepClone_ACU(chat);
  const candidateTarget = candidateChat[target.index];
  const existingTargetTagData = readIsolatedTagData_ACU(candidateTarget, options.isolationKey) as any;
  const legacyEvidence = collectLegacyMigrationSourceEvidence_ACU(
    candidateChat,
    options.isolationKey,
    options.isolationConfig,
    candidateData,
    { maxMessageIndex: target.index },
  );
  const migratedAt = Date.now();
  const targetAiFloor = countAiFloor_ACU(candidateChat, target.index);
  const migrationProvenance: TableMigrationProvenanceV1_ACU = {
    version: 1,
    legacyDataFingerprint: getTableDataFingerprint_ACU(candidateData),
    legacySourceMessageIndices: legacyEvidence.sourceMessageIndices,
    legacySourceAiFloors: legacyEvidence.sourceAiFloors,
    legacyLastChangedAiFloorBySheet: Object.fromEntries(
      Object.entries(legacyEvidence.scheduleSummary)
        .filter(([, summary]) => Number.isInteger(summary.lastChangedAiFloor) && Number(summary.lastChangedAiFloor) >= 0)
        .map(([sheetKey, summary]) => [sheetKey, Number(summary.lastChangedAiFloor)]),
    ),
    targetMessageIndex: target.index,
    targetAiFloor,
    isolationKey: options.isolationKey,
    migratedAt,
  };
  const provenanceValidation = validateMigrationProvenanceV1_ACU(migrationProvenance);
  if (!provenanceValidation.valid) {
    return { migrated: false, error: `legacy migration provenance is invalid: ${provenanceValidation.issues.join(', ')}` };
  }
  const checkpointResult = buildCanonicalFullCheckpoint_ACU({
    createdAt: migratedAt,
    reason: 'migration',
    data: candidateData,
    scheduleSummary: legacyEvidence.scheduleSummary,
    migrationProvenance,
    context: {
      messageIndex: target.index,
      aiFloor: targetAiFloor,
      isolationKey: options.isolationKey,
    },
  });
  if (!checkpointResult.checkpoint) {
    return { migrated: false, error: checkpointResult.error };
  }
  const revision = buildMigrationRevision_ACU();
  const frame: TableStorageFrameV2_ACU = {
    version: 2,
    headRevision: revision,
    checkpoint: checkpointResult.checkpoint,
    logEntries: [],
  };

  const isolatedData = cloneIsolatedData_ACU(candidateTarget) as Record<string, any>;
  isolatedData[options.isolationKey] = {
    ...(existingTargetTagData?.summaryVectorIndexState !== undefined ? { summaryVectorIndexState: existingTargetTagData.summaryVectorIndexState } : {}),
    ...(existingTargetTagData?.summaryVectorIndexManifest !== undefined ? { summaryVectorIndexManifest: existingTargetTagData.summaryVectorIndexManifest } : {}),
    storageFrame: frame,
    _acu_storage_version: 2,
  };
  candidateTarget.TavernDB_ACU_IsolatedData = isolatedData;
  cleanupLegacyFieldsAfterV2Write_ACU(candidateChat, options.isolationKey, options.isolationConfig);

  const scopeChangeError = getLegacyMigrationScopeChangeError_ACU(scopeSnapshot);
  if (scopeChangeError) {
    return { migrated: false, error: scopeChangeError };
  }

  const originalChat = deepClone_ACU(chat);
  chat.splice(0, chat.length, ...candidateChat);
  try {
    await saveChatToHostStrict_ACU();
  } catch (error) {
    chat.splice(0, chat.length, ...originalChat);
    return { migrated: false, error: `legacy migration save failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  logDebug_ACU(`[V2 Migration] legacy-v1 migrated to V2 checkpoint: messageIndex=${target.index}, skipUpdateFloors=${skipUpdateFloors}, isolationKey=[${options.isolationKey || '无标签'}], sheets=${sheetKeys.length}`);

  return { migrated: true, messageIndex: target.index, data: candidateData };
}
