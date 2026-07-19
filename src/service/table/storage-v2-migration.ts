import { getChatArray_ACU, saveChatToHost_ACU } from '../../data/gateways/chat-gateway';
import type { IsolationConfig_ACU } from '../../data/models/chat-message-data';
import { cloneIsolatedData_ACU, isLegacyMatchForIsolation_ACU, readIsolatedTagData_ACU, readLegacyIndependentData_ACU, readLegacyStandardData_ACU, readLegacySummaryData_ACU, readModifiedKeys_ACU, readUpdateGroupKeys_ACU, writeMessageIdentity_ACU } from '../../data/repositories/chat-message-data-repo';
import type { TableDataObject_ACU } from '../../shared/models/table-data';
import { logDebug_ACU } from '../../shared/utils';
import { isV2TagData_ACU, resolveTableStorageStrategy_ACU } from './storage-strategy-resolver';
import type { TableCheckpointScheduleSummaryV2_ACU, TableStorageFrameV2_ACU } from './storage-frame-v2-types';
import { buildCanonicalFullCheckpoint_ACU } from './canonical-checkpoint-builder';

export interface LegacyToV2MigrationOptions_ACU {
  data: Record<string, any> | null;
  isolationKey: string;
  isolationConfig: IsolationConfig_ACU;
  skipUpdateFloors?: number;
}

export interface LegacyToV2MigrationResult_ACU {
  migrated: boolean;
  messageIndex?: number;
  error?: string;
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

export function collectLegacyScheduleSummaryForMigration_ACU(
  chat: any[] | null | undefined,
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
  data: Record<string, any> | null,
  options: { maxMessageIndex?: number } = {},
): LegacyScheduleSummary_ACU {
  if (!Array.isArray(chat) || chat.length === 0) return {};
  const allowedSheetKeys = new Set(sheetKeysOfData_ACU(data));
  if (allowedSheetKeys.size === 0) return {};

  const maxMessageIndex = Number.isInteger(options.maxMessageIndex)
    ? Math.max(0, Math.min(chat.length - 1, options.maxMessageIndex as number))
    : chat.length - 1;
  const summary: LegacyScheduleSummary_ACU = {};
  for (let i = 0; i <= maxMessageIndex; i += 1) {
    const message = chat[i];
    if (!message || message.is_user) continue;
    const aiFloor = countAiFloor_ACU(chat, i);

    const tagData = readIsolatedTagData_ACU(message, isolationKey) as any;
    if (tagData && !isV2TagData_ACU(tagData)) {
      applyLegacyTracking_ACU(summary, aiFloor, allowedSheetKeys, {
        dataKeys: collectContainerSheetKeys_ACU(tagData.independentData, allowedSheetKeys),
        deltaKeys: collectContainerSheetKeys_ACU(tagData.incrementalData, allowedSheetKeys),
        modifiedKeys: tagData.modifiedKeys,
        updateGroupKeys: tagData.updateGroupKeys,
      });
    }

    if (isLegacyMatchForIsolation_ACU(message, isolationConfig)) {
      applyLegacyTracking_ACU(summary, aiFloor, allowedSheetKeys, {
        dataKeys: [
          ...collectContainerSheetKeys_ACU(readLegacyIndependentData_ACU(message), allowedSheetKeys),
          ...collectContainerSheetKeys_ACU(readLegacyStandardData_ACU(message), allowedSheetKeys),
          ...collectContainerSheetKeys_ACU(readLegacySummaryData_ACU(message), allowedSheetKeys),
        ],
        modifiedKeys: readModifiedKeys_ACU(message),
        updateGroupKeys: readUpdateGroupKeys_ACU(message),
      });
    }
  }

  return summary;
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

export async function migrateLegacyStorageToV2OnLoad_ACU(
  options: LegacyToV2MigrationOptions_ACU,
): Promise<LegacyToV2MigrationResult_ACU> {
  const chat = getChatArray_ACU();
  if (!Array.isArray(chat) || chat.length === 0) {
    return { migrated: false, error: 'chat history is empty' };
  }

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

  const existingTargetTagData = readIsolatedTagData_ACU(target.message, options.isolationKey) as any;
  const scheduleSummary = collectLegacyScheduleSummaryForMigration_ACU(
    chat,
    options.isolationKey,
    options.isolationConfig,
    options.data,
    { maxMessageIndex: target.index },
  );
  const checkpointResult = buildCanonicalFullCheckpoint_ACU({
    createdAt: Date.now(),
    reason: 'migration',
    data: options.data as TableDataObject_ACU,
    scheduleSummary,
    context: {
      messageIndex: target.index,
      aiFloor: countAiFloor_ACU(chat, target.index),
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

  const isolatedData = cloneIsolatedData_ACU(target.message) as Record<string, any>;
  isolatedData[options.isolationKey] = {
    ...(existingTargetTagData?.summaryVectorIndexState !== undefined ? { summaryVectorIndexState: existingTargetTagData.summaryVectorIndexState } : {}),
    ...(existingTargetTagData?.summaryVectorIndexManifest !== undefined ? { summaryVectorIndexManifest: existingTargetTagData.summaryVectorIndexManifest } : {}),
    storageFrame: frame,
    _acu_storage_version: 2,
  };
  target.message.TavernDB_ACU_IsolatedData = isolatedData;

  cleanupLegacyFieldsAfterV2Write_ACU(chat, options.isolationKey, options.isolationConfig);

  await saveChatToHost_ACU();
  logDebug_ACU(`[V2 Migration] legacy-v1 migrated to V2 checkpoint: messageIndex=${target.index}, skipUpdateFloors=${skipUpdateFloors}, isolationKey=[${options.isolationKey || '无标签'}], sheets=${sheetKeys.length}`);

  return { migrated: true, messageIndex: target.index };
}
