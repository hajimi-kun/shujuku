import type { ACUMessage } from '../../shared/host-api';
import { hasAnyTableData_ACU, readIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import { isV2TagData_ACU } from './storage-strategy-resolver';

export interface TableHistoryState_ACU {
    latestAiMessageIndex: number;
    latestDataMessageIndex: number;
    lastTrackedUpdateMessageIndex: number;
    latestDataAiFloor: number;
    lastTrackedUpdateAiFloor: number;
    hasAnyData: boolean;
    hasTrackedUpdate: boolean;
}

export interface TableCheckpointFloor_ACU {
    messageIndex: number;
    aiFloor: number;
    reason?: string;
    createdAt?: number;
}

interface ResolveTableHistoryOptions_ACU {
    sheetKey: string;
    isSummaryTable: boolean;
    isolationKey: string;
    settings: any;
}

function isLegacyMatchForMessage_ACU(msg: any, settings: any): boolean {
    const msgIdentity = msg?.TavernDB_ACU_Identity;
    if (settings?.dataIsolationEnabled) {
        return msgIdentity === settings.dataIsolationCode;
    }
    return !msgIdentity;
}

function keyListHasSheet_ACU(value: unknown, sheetKey: string): boolean {
    return Array.isArray(value) && value.includes(sheetKey);
}

function v2EventTouchesSheetData_ACU(event: any, sheetKey: string): boolean {
    return keyListHasSheet_ACU(event?.changedSheetKeys, sheetKey)
        || keyListHasSheet_ACU(event?.filledSheetKeys, sheetKey)
        || keyListHasSheet_ACU(event?.groupKeys, sheetKey);
}

function v2EventTracksFill_ACU(event: any, sheetKey: string): boolean {
    return keyListHasSheet_ACU(event?.filledSheetKeys, sheetKey)
        || keyListHasSheet_ACU(event?.groupKeys, sheetKey);
}

function v2ScheduleFilledFloor_ACU(tagData: any, sheetKey: string): number {
    const fullValue = tagData?.storageFrame?.checkpoint?.scheduleSummary?.[sheetKey]?.lastFilledAiFloor;
    const sheetValue = tagData?.storageFrame?.perSheetCheckpoints?.[sheetKey]?.scheduleSummary?.lastFilledAiFloor;
    const fullFloor = Number.isFinite(fullValue) && fullValue > 0 ? Number(fullValue) : 0;
    const sheetFloor = Number.isFinite(sheetValue) && sheetValue > 0 ? Number(sheetValue) : 0;
    return Math.max(fullFloor, sheetFloor);
}

function v2EntryAiFloor_ACU(entry: any, fallbackAiFloor: number): number {
    const value = Number(entry?.aiFloor);
    return Number.isFinite(value) && value > 0 ? value : fallbackAiFloor;
}

function v2OperationTouchesSheet_ACU(operation: any, sheetKey: string): boolean {
    if (!operation || typeof operation !== 'object') return false;
    if (operation.kind === 'sheet_replace') return operation.sheetKey === sheetKey;
    if (operation.kind === 'sheet_schema_migrate') return operation.sheetKey === sheetKey;
    if (operation.kind === 'row_upsert' || operation.kind === 'row_delete' || operation.kind === 'meta_update') return operation.sheetKey === sheetKey;
    if (operation.kind === 'data_replace') return !!operation.data?.[sheetKey];
    return false;
}

function v2FrameHasSheetData_ACU(tagData: any, sheetKey: string): boolean {
    if (!isV2TagData_ACU(tagData)) return false;
    if (tagData.storageFrame.checkpoint?.kind === 'full' && tagData.storageFrame.checkpoint.data?.[sheetKey]) {
        return true;
    }
    if (tagData.storageFrame.perSheetCheckpoints?.[sheetKey]?.kind === 'sheet_full') {
        return true;
    }
    return (tagData.storageFrame.logEntries || []).some((entry: any) =>
        v2EventTouchesSheetData_ACU(entry, sheetKey)
        || (Array.isArray(entry.operations) && entry.operations.some((operation: any) => v2OperationTouchesSheet_ACU(operation, sheetKey)))
    );
}

function v2FrameTrackedUpdateFloor_ACU(tagData: any, sheetKey: string, messageAiFloor: number): number {
    if (!isV2TagData_ACU(tagData)) return 0;
    let latestFloor = v2ScheduleFilledFloor_ACU(tagData, sheetKey);
    const checkpointEvent = tagData.storageFrame.checkpoint?.event;
    if (v2EventTracksFill_ACU(checkpointEvent, sheetKey)) {
        latestFloor = Math.max(latestFloor, messageAiFloor);
    }
    const sheetCheckpointEvent = tagData.storageFrame.perSheetCheckpoints?.[sheetKey]?.event;
    if (v2EventTracksFill_ACU(sheetCheckpointEvent, sheetKey)) {
        latestFloor = Math.max(latestFloor, messageAiFloor);
    }
    for (const entry of tagData.storageFrame.logEntries || []) {
        if (v2EventTracksFill_ACU(entry, sheetKey)) {
            latestFloor = Math.max(latestFloor, v2EntryAiFloor_ACU(entry, messageAiFloor));
        }
    }
    return latestFloor;
}

function hasTableDataInMessage_ACU(msg: any, options: ResolveTableHistoryOptions_ACU): boolean {
    const { sheetKey, isSummaryTable, isolationKey, settings } = options;
    const tagData = readIsolatedTagData_ACU(msg, isolationKey) as any;

    if (v2FrameHasSheetData_ACU(tagData, sheetKey)) {
        return true;
    }

    if (tagData?.independentData?.[sheetKey]) {
        return true;
    }

    if (!isLegacyMatchForMessage_ACU(msg, settings)) {
        return false;
    }

    return !!(
        msg?.TavernDB_ACU_IndependentData?.[sheetKey]
        || (isSummaryTable
            ? msg?.TavernDB_ACU_SummaryData?.[sheetKey]
            : msg?.TavernDB_ACU_Data?.[sheetKey])
    );
}

function getTrackedUpdateFloorInMessage_ACU(msg: any, options: ResolveTableHistoryOptions_ACU, messageAiFloor: number): number {
    const { sheetKey, isolationKey, settings } = options;
    const tagData = readIsolatedTagData_ACU(msg, isolationKey) as any;

    const v2Floor = v2FrameTrackedUpdateFloor_ACU(tagData, sheetKey, messageAiFloor);
    if (v2Floor > 0) {
        return v2Floor;
    }

    const isolatedModifiedKeys = Array.isArray(tagData?.modifiedKeys) ? tagData.modifiedKeys : [];
    const isolatedUpdateGroupKeys = Array.isArray(tagData?.updateGroupKeys) ? tagData.updateGroupKeys : [];

    if (isolatedUpdateGroupKeys.includes(sheetKey) || isolatedModifiedKeys.includes(sheetKey)) {
        return messageAiFloor;
    }

    if (!isLegacyMatchForMessage_ACU(msg, settings)) {
        return 0;
    }

    const legacyModifiedKeys = Array.isArray(msg?.TavernDB_ACU_ModifiedKeys) ? msg.TavernDB_ACU_ModifiedKeys : [];
    const legacyUpdateGroupKeys = Array.isArray(msg?.TavernDB_ACU_UpdateGroupKeys) ? msg.TavernDB_ACU_UpdateGroupKeys : [];
    return legacyUpdateGroupKeys.includes(sheetKey) || legacyModifiedKeys.includes(sheetKey) ? messageAiFloor : 0;
}

export function getLatestAiMessageIndexFromChat_ACU(chat: ACUMessage[] | any[]): number {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i] && !chat[i].is_user) return i;
    }
    return -1;
}

function hasAppendableTableDataFrame_ACU(msg: any, isolationKey: string, settings: any): boolean {
    const tagData = readIsolatedTagData_ACU(msg, isolationKey) as any;
    if (isV2TagData_ACU(tagData) && tagData.storageFrame) return true;
    return hasAnyTableData_ACU(msg, isolationKey, {
        enabled: !!settings?.dataIsolationEnabled,
        code: String(settings?.dataIsolationCode || ''),
    });
}

export function getLatestTableAppendMessageIndexFromChat_ACU(
    chat: ACUMessage[] | any[],
    isolationKey: string,
    settings: any,
): number {
    if (!Array.isArray(chat)) return -1;
    const latestAiMessageIndex = getLatestAiMessageIndexFromChat_ACU(chat);
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        if (hasAppendableTableDataFrame_ACU(msg, isolationKey, settings)) return i;
    }
    return latestAiMessageIndex;
}

export function countAiMessagesUpToIndex_ACU(chat: ACUMessage[] | any[], messageIndex: number): number {
    if (!Array.isArray(chat) || messageIndex < 0) return 0;
    let count = 0;
    for (let i = 0; i <= messageIndex && i < chat.length; i += 1) {
        if (chat[i] && !chat[i].is_user) count += 1;
    }
    return count;
}

export function collectV2CheckpointFloorsFromChat_ACU(
    chat: ACUMessage[] | any[] | null | undefined,
    isolationKey: string,
): TableCheckpointFloor_ACU[] {
    if (!Array.isArray(chat)) return [];
    const checkpoints: TableCheckpointFloor_ACU[] = [];
    let aiFloor = 0;
    for (let i = 0; i < chat.length; i += 1) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        aiFloor += 1;
        const tagData = readIsolatedTagData_ACU(msg, isolationKey) as any;
        if (!isV2TagData_ACU(tagData)) continue;
        const checkpoint = tagData.storageFrame.checkpoint;
        if (checkpoint?.kind !== 'full') continue;
        checkpoints.push({
            messageIndex: i,
            aiFloor,
            reason: checkpoint.reason,
            createdAt: checkpoint.createdAt,
        });
    }
    return checkpoints;
}

export function resolveTableHistoryStateFromChat_ACU(
    chat: ACUMessage[] | any[],
    options: ResolveTableHistoryOptions_ACU,
): TableHistoryState_ACU {
    const latestAiMessageIndex = getLatestAiMessageIndexFromChat_ACU(chat);
    let latestDataMessageIndex = -1;
    let lastTrackedUpdateMessageIndex = -1;
    let lastTrackedUpdateAiFloor = 0;

    if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0; i -= 1) {
            const msg = chat[i];
            if (!msg || msg.is_user) continue;
            const messageAiFloor = countAiMessagesUpToIndex_ACU(chat, i);

            if (latestDataMessageIndex === -1 && hasTableDataInMessage_ACU(msg, options)) {
                latestDataMessageIndex = i;
            }

            if (lastTrackedUpdateMessageIndex === -1) {
                const trackedFloor = getTrackedUpdateFloorInMessage_ACU(msg, options, messageAiFloor);
                if (trackedFloor > 0) {
                    lastTrackedUpdateMessageIndex = i;
                    lastTrackedUpdateAiFloor = trackedFloor;
                }
            }

            if (latestDataMessageIndex !== -1 && lastTrackedUpdateMessageIndex !== -1) {
                break;
            }
        }
    }

    return {
        latestAiMessageIndex,
        latestDataMessageIndex,
        lastTrackedUpdateMessageIndex,
        latestDataAiFloor: countAiMessagesUpToIndex_ACU(chat, latestDataMessageIndex),
        lastTrackedUpdateAiFloor,
        hasAnyData: latestDataMessageIndex !== -1,
        hasTrackedUpdate: lastTrackedUpdateAiFloor > 0,
    };
}
