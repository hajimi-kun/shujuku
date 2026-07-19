/**
 * service/chat/chat-service.ts — 聊天数据服务
 *
 * 中转 data/gateways/chat-gateway 的所有方法。
 * presentation 层通过本模块访问聊天数据，不再直接调用 gateway。
 * 后续可在此层统一添加日志、埋点、缓存等增值逻辑。
 */

export {
    getChatArray_ACU,
    getChatLength_ACU,
    getLastMessageIndex_ACU,
    saveChatToHost_ACU,
    saveChatToHostStrict_ACU,
    stopGeneration_ACU,
    deleteLastMessage_ACU,
    setChatMessages_ACU,
    emitMessageUpdated_ACU,
} from '../../data/gateways/chat-gateway';

import { getChatArray_ACU, saveChatToHost_ACU, saveChatToHostStrict_ACU, setChatMessages_ACU, emitMessageUpdated_ACU } from '../../data/gateways/chat-gateway';
import { logDebug_ACU, logError_ACU, logWarn_ACU, isSummaryOrOutlineTable_ACU } from '../../shared/utils';
import { getLastOptimizationBase_ACU, setLastOptimizationBase_ACU } from '../optimization/content-optimization';
import { settings_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU } from '../runtime/state-manager';
import { sanitizeSheetForStorage_ACU } from '../template/chat-scope';
import { clearTableFieldsForIsolation_ACU, collectSqlTargetTableNamesFromStorageFrameV2_ACU, purgeManualRefillIncrementalSheetKeysFromMessage_ACU, purgeSheetKeysFromMessage_ACU, purgeSheetKeysFromMessageForIsolation_ACU, readIsolatedTagData_ACU, writeMessageIdentity_ACU } from '../../data/repositories/chat-message-data-repo';
import { MAX_CHECKPOINT_RISK_DETAILS_ACU, scanTargetKeysResidue_ACU } from '../../data/repositories/target-keys-diagnostics';
import { runTableUpdateCommit_ACU } from '../table/table-update-commit';
import { getLatestAiMessageIndexFromChat_ACU, resolveTableHistoryStateFromChat_ACU } from '../table/table-history';
import { deleteSummaryVectorIndexExternal_ACU } from '../vector/summary-vector-index-storage-service';
import { assignSummaryVectorIndexStateToTagData_ACU } from '../vector/summary-vector-index-state-service';
import { isV2TagData_ACU, resolveTableStorageStrategy_ACU } from '../table/storage-strategy-resolver';
import { collectScheduleSummaryFromFramesV2_ACU, loadTableStateFromFramesV2_ACU } from '../table/storage-frame-v2-replay';
import { runTableWriteTransaction_ACU } from '../table/table-write-transaction';
import type { TableMutationLogEntryV2_ACU, TableMutationOperationV2_ACU, TableStorageFrameV2_ACU } from '../table/storage-frame-v2-types';
import type { Sheet_ACU } from '../../shared/models/table-data';

// ─── 业务逻辑函数（从 presentation 层搬迁） ───

const RETAIN_RECENT_CHECKPOINT_BUFFER_LAYERS_ACU = 20;

interface RetainedCheckpointBoundary_ACU {
    shouldCompact: boolean;
    shouldRotateCheckpoint: boolean;
    aiMessageIndices: number[];
    dataMessageIndices: number[];
    effectiveRetainCount: number;
    bufferLayers: number;
    cutoffIndex: number;
    indicesToPurge: number[];
    retainedDataIndices: number[];
    retainedAiStartOrdinal?: number;
    retainedAiEndOrdinal?: number;
    bufferAiStartOrdinal?: number;
    bufferAiEndOrdinal?: number;
    checkpointBufferIndices: number[];
    retainedStartIndex?: number;
    retainedEndIndex?: number;
    checkpointBufferStartIndex?: number;
    checkpointBufferEndIndex?: number;
    anchorIndex?: number;
}

export interface BoundaryCheckpointEnsureResult_ACU {
    success: boolean;
    changed: boolean;
    skipped?: boolean;
    error?: string;
    anchorIndex?: number;
}

export interface ManualRefillInitialBaselineEnsureResult_ACU {
    success: boolean;
    changed: boolean;
    skipped?: boolean;
    error?: string;
    targetMessageIndex?: number;
    movedFromMessageIndex?: number;
    downgradedCount?: number;
}

export interface ManualRefillInitialBaselineEnsureOptions_ACU {
    isolationKey: string;
    targetMessageIndex: number;
    data: Record<string, any>;
    save?: boolean;
}

export interface BoundaryCheckpointEnsureOptions_ACU {
    reason?: 'purge' | 'manual_refill' | 'auto_update';
    save?: boolean;
}

export interface ManualRefillSheetBaselineReplaceOptions_ACU {
    isolationKey: string;
    targetMessageIndices: number[];
    targetSheetKeys: string[];
    targetMessageIndex?: number;
    baselineData: Record<string, any>;
}

export interface ManualRefillSheetSnapshotCommitOptions_ACU {
    isolationKey: string;
    targetMessageIndices: number[];
    targetSheetKeys: string[];
    snapshotData: Record<string, any>;
}

export interface ManualRefillSessionSnapshot_ACU {
    targetMessageIndices: number[];
    messageFields: Array<{
        index: number;
        hadIsolatedData: boolean;
        isolatedData: any;
        hadIdentity: boolean;
        identity: any;
    }>;
}

export interface ManualRefillSheetBaselineReplaceResult_ACU {
    success: boolean;
    changed: boolean;
    clearedCount: number;
    checkpointCount: number;
    targetMessageIndex?: number;
    cleanupWarnings?: string[];
    error?: string;
}

async function deleteVectorIndexManifestFromTagData_ACU(
    tagData: any,
    options: { deleteExternal?: boolean; onManifest?: (manifest: any) => void } = {},
): Promise<boolean> {
    if (!tagData || typeof tagData !== 'object') return false;
    const deleteExternal = options.deleteExternal !== false;
    const manifest = tagData.summaryVectorIndexManifest || tagData.summaryVectorIndexState?.manifest || null;
    if (manifest) {
        options.onManifest?.(manifest);
        if (deleteExternal) {
            await deleteSummaryVectorIndexExternal_ACU(manifest);
        }
    }
    const hadState = !!tagData.summaryVectorIndexState || !!tagData.summaryVectorIndexManifest;
    if (hadState) {
        assignSummaryVectorIndexStateToTagData_ACU(tagData, null);
    }
    return hadState || !!manifest;
}

async function cleanupVectorIndexManifestsAfterCommit_ACU(manifests: any[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const manifest of manifests) {
        try {
            await deleteSummaryVectorIndexExternal_ACU(manifest);
        } catch (error: any) {
            const warning = `外置向量索引资源清理失败：${error?.message || String(error || '未知错误')}`;
            warnings.push(warning);
            logWarn_ACU(`[手动重填基底替换] ${warning}`, error);
        }
    }
    return warnings;
}

/**
 * 仅供已持有独占表写事务的复合恢复流程使用。
 * 调用方必须在一次严格聊天保存成功后，再调用 cleanupCheckpointVectorIndexManifestsAfterCommit_ACU。
 */
export async function clearAllAiTableDataForCheckpointRestore_ACU(): Promise<{
    clearedCount: number;
    vectorManifestsToDeleteAfterCommit: any[];
}> {
    const chat = getChatArray_ACU();
    if (!Array.isArray(chat) || chat.length === 0) {
        return { clearedCount: 0, vectorManifestsToDeleteAfterCommit: [] };
    }

    let clearedCount = 0;
    const vectorManifestsToDeleteAfterCommit: any[] = [];
    for (const msg of chat) {
        if (!msg || msg.is_user) continue;
        let changed = false;
        if (msg.TavernDB_ACU_Data) { delete msg.TavernDB_ACU_Data; changed = true; }
        if (msg.TavernDB_ACU_SummaryData) { delete msg.TavernDB_ACU_SummaryData; changed = true; }
        if (msg.TavernDB_ACU_IndependentData) { delete msg.TavernDB_ACU_IndependentData; changed = true; }
        if (msg.TavernDB_ACU_Identity !== undefined) { delete msg.TavernDB_ACU_Identity; changed = true; }
        if (msg.TavernDB_ACU_IsolatedData) {
            const isolatedData = msg.TavernDB_ACU_IsolatedData;
            if (isolatedData && typeof isolatedData === 'object' && !Array.isArray(isolatedData)) {
                for (const key of Object.keys(isolatedData)) {
                    await deleteVectorIndexManifestFromTagData_ACU(isolatedData[key], {
                        deleteExternal: false,
                        onManifest: manifest => vectorManifestsToDeleteAfterCommit.push(manifest),
                    });
                }
            }
            delete msg.TavernDB_ACU_IsolatedData;
            changed = true;
        }
        if (msg.TavernDB_ACU_ModifiedKeys) { delete msg.TavernDB_ACU_ModifiedKeys; changed = true; }
        if (msg.TavernDB_ACU_UpdateGroupKeys) { delete msg.TavernDB_ACU_UpdateGroupKeys; changed = true; }
        if (changed) clearedCount += 1;
    }
    return { clearedCount, vectorManifestsToDeleteAfterCommit };
}

/** 仅供 Checkpoint 严格保存成功后的资源回收调用；失败只返回警告，不撤销已提交聊天数据。 */
export async function cleanupCheckpointVectorIndexManifestsAfterCommit_ACU(manifests: any[]): Promise<string[]> {
    return cleanupVectorIndexManifestsAfterCommit_ACU(manifests);
}

function messageHasLocalLayerData_ACU(msg: any): boolean {
    if (!msg || typeof msg !== 'object') return false;
    return !!(
        msg.TavernDB_ACU_Data ||
        msg.TavernDB_ACU_SummaryData ||
        msg.TavernDB_ACU_IndependentData ||
        msg.TavernDB_ACU_ModifiedKeys ||
        msg.TavernDB_ACU_UpdateGroupKeys ||
        msg.TavernDB_ACU_IsolatedData ||
        msg.TavernDB_ACU_Identity ||
        msg.qrf_plot ||
        msg.qrf_plot_preset ||
        msg.qrf_plot_tasks
    );
}

async function deleteVectorIndexManifestsFromMessage_ACU(msg: any): Promise<number> {
    if (!msg || typeof msg !== 'object') return 0;
    const isolatedData = msg.TavernDB_ACU_IsolatedData;
    if (!isolatedData || typeof isolatedData !== 'object' || Array.isArray(isolatedData)) return 0;

    let deletedCount = 0;
    for (const isolationKey of Object.keys(isolatedData)) {
        try {
            if (await deleteVectorIndexManifestFromTagData_ACU(isolatedData[isolationKey])) {
                deletedCount++;
            }
        } catch (error) {
            logWarn_ACU(`[数据清理] 删除隔离标签 ${isolationKey} 的交火向量索引外置文件失败:`, error);
        }
    }
    return deletedCount;
}

function tableListContainsSummaryOrOutline_ACU(targetSheetKeys: string[]): boolean {
    if (!Array.isArray(targetSheetKeys) || targetSheetKeys.length === 0) return false;
    return targetSheetKeys.some((sheetKey) => {
        const table = currentJsonTableData_ACU?.[sheetKey];
        return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
    });
}

function collectIsolationKeysWithV2Frames_ACU(chat: any[], options: { maxMessageIndex?: number } = {}): string[] {
    const keys = new Set<string>();
    const maxMessageIndex = Number.isInteger(options.maxMessageIndex) ? options.maxMessageIndex as number : Number.POSITIVE_INFINITY;
    for (let i = 0; i < chat.length && i <= maxMessageIndex; i++) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        const isolatedData = msg.TavernDB_ACU_IsolatedData;
        if (!isolatedData || typeof isolatedData !== 'object' || Array.isArray(isolatedData)) continue;
        for (const [isolationKey, tagData] of Object.entries(isolatedData)) {
            if (isV2TagData_ACU(tagData)) {
                keys.add(isolationKey);
            }
        }
    }
    return [...keys];
}

function hasV2CompactionCheckpointAtIndex_ACU(chat: any[], isolationKey: string, messageIndex: number): boolean {
    if (!Array.isArray(chat) || messageIndex < 0 || messageIndex >= chat.length) return false;
    const msg = chat[messageIndex];
    if (!msg || msg.is_user) return false;
    const tagData = msg.TavernDB_ACU_IsolatedData?.[isolationKey];
    return isV2TagData_ACU(tagData)
        && tagData.storageFrame.checkpoint?.kind === 'full'
        && tagData.storageFrame.checkpoint.reason === 'compaction';
}

function resolveRetainedCheckpointBoundary_ACU(chat: any[], retainCount: number): RetainedCheckpointBoundary_ACU {
    const aiMessageIndices: number[] = [];
    const dataMessageIndices: number[] = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (msg && !msg.is_user) {
            aiMessageIndices.push(i);
        }
        if (messageHasLocalLayerData_ACU(msg)) {
            dataMessageIndices.push(i);
        }
    }

    const bufferLayers = RETAIN_RECENT_CHECKPOINT_BUFFER_LAYERS_ACU;
    const effectiveRetainCount = retainCount + bufferLayers;
    const shouldRotateCheckpoint = retainCount > 0 && aiMessageIndices.length >= effectiveRetainCount;
    const shouldCompact = shouldRotateCheckpoint;
    const retainedAiStartOrdinal = shouldRotateCheckpoint ? Math.max(0, aiMessageIndices.length - retainCount) : undefined;
    const retainedAiEndOrdinal = shouldRotateCheckpoint ? aiMessageIndices.length - 1 : undefined;
    const bufferAiStartOrdinal = shouldRotateCheckpoint ? Math.max(0, (retainedAiStartOrdinal as number) - bufferLayers) : undefined;
    const bufferAiEndOrdinal = shouldRotateCheckpoint ? (retainedAiStartOrdinal as number) - 1 : undefined;
    const retainedStartIndex = retainedAiStartOrdinal !== undefined ? aiMessageIndices[retainedAiStartOrdinal] : undefined;
    const retainedEndIndex = retainedAiEndOrdinal !== undefined ? aiMessageIndices[retainedAiEndOrdinal] : undefined;
    const anchorIndex = retainedStartIndex;
    const checkpointBufferIndices = shouldRotateCheckpoint && bufferAiStartOrdinal !== undefined && bufferAiEndOrdinal !== undefined
        ? aiMessageIndices.slice(bufferAiStartOrdinal, bufferAiEndOrdinal + 1)
        : [];
    const checkpointBufferStartIndex = checkpointBufferIndices[0];
    const checkpointBufferEndIndex = checkpointBufferIndices[checkpointBufferIndices.length - 1];
    const indicesToPurge = shouldCompact && anchorIndex !== undefined
        ? dataMessageIndices.filter(index => index < anchorIndex)
        : [];
    const cutoffIndex = indicesToPurge.length;
    const retainedDataIndices = shouldCompact && anchorIndex !== undefined
        ? dataMessageIndices.filter(index => index >= anchorIndex)
        : dataMessageIndices.slice();

    return {
        shouldCompact,
        shouldRotateCheckpoint,
        aiMessageIndices,
        dataMessageIndices,
        effectiveRetainCount,
        bufferLayers,
        cutoffIndex,
        indicesToPurge,
        retainedDataIndices,
        retainedAiStartOrdinal,
        retainedAiEndOrdinal,
        bufferAiStartOrdinal,
        bufferAiEndOrdinal,
        checkpointBufferIndices,
        retainedStartIndex,
        retainedEndIndex,
        checkpointBufferStartIndex,
        checkpointBufferEndIndex,
        anchorIndex,
    };
}

function countAiFloorAtMessage_ACU(chat: any[], messageIndex: number): number {
    let count = 0;
    for (let i = 0; i <= messageIndex && i < chat.length; i += 1) {
        if (chat[i] && !chat[i].is_user) count += 1;
    }
    return count;
}

function downgradeV2FullCheckpointAtIndex_ACU(chat: any[], isolationKey: string, messageIndex: number): boolean {
    const msg = chat?.[messageIndex];
    if (!msg || msg.is_user) return false;
    const tagData = msg.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (!isV2TagData_ACU(tagData)) return false;

    const frame = tagData.storageFrame;
    const checkpoint = frame.checkpoint;
    if (checkpoint?.kind !== 'full') return false;

    const existingEntries = Array.isArray(frame.logEntries) ? frame.logEntries : [];
    const finiteSeqs = existingEntries.map(entry => Number(entry.seq)).filter(Number.isFinite);
    const minSeq = finiteSeqs.length > 0 ? Math.min(...finiteSeqs) : 1;
    const seq = Math.min(0, minSeq - 1);
    const fallbackData = JSON.parse(JSON.stringify(checkpoint.data || {}));
    const sheetCheckpoints = frame.perSheetCheckpoints;
    if (sheetCheckpoints && typeof sheetCheckpoints === 'object' && !Array.isArray(sheetCheckpoints)) {
        for (const [sheetKey, sheetCheckpoint] of Object.entries(sheetCheckpoints)) {
            if (
                !sheetKey.startsWith('sheet_')
                || !sheetCheckpoint
                || sheetCheckpoint.kind !== 'sheet_full'
                || sheetCheckpoint.sheetKey !== sheetKey
                || !sheetCheckpoint.data
                || typeof sheetCheckpoint.data !== 'object'
                || Array.isArray(sheetCheckpoint.data)
            ) continue;
            fallbackData[sheetKey] = JSON.parse(JSON.stringify(sheetCheckpoint.data));
        }
    }
    const sheetKeys = Object.keys(fallbackData).filter(key => key.startsWith('sheet_'));
    const downgradeEntry: TableMutationLogEntryV2_ACU = {
        seq,
        entryId: `downgraded-checkpoint-${messageIndex}-${checkpoint.createdAt || Date.now()}`,
        createdAt: checkpoint.createdAt || Date.now(),
        source: 'system',
        targetMessageIndex: messageIndex,
        aiFloor: countAiFloorAtMessage_ACU(chat, messageIndex),
        filledSheetKeys: sheetKeys,
        changedSheetKeys: sheetKeys,
        groupKeys: [],
        operations: [{ kind: 'data_replace', data: fallbackData, reason: 'checkpoint_fallback' }],
        writeSet: [{ kind: 'all' }],
    };
    frame.logEntries = [downgradeEntry, ...existingEntries];
    delete frame.checkpoint;
    return true;
}


function downgradeCoveredV2FullCheckpointsAfterAnchor_ACU(chat: any[], anchorIndex: number): number {
    if (!Array.isArray(chat) || anchorIndex < 0 || anchorIndex >= chat.length) return 0;

    let downgradedCount = 0;
    const isolationKeys = collectIsolationKeysWithV2Frames_ACU(chat);
    for (const isolationKey of isolationKeys) {
        if (!hasV2CompactionCheckpointAtIndex_ACU(chat, isolationKey, anchorIndex)) continue;

        for (let i = anchorIndex + 1; i < chat.length; i += 1) {
            const msg = chat[i];
            if (!msg || msg.is_user) continue;
            const tagData = msg.TavernDB_ACU_IsolatedData?.[isolationKey];
            if (!isV2TagData_ACU(tagData) || tagData.storageFrame.checkpoint?.kind !== 'full') continue;
            if (downgradeV2FullCheckpointAtIndex_ACU(chat, isolationKey, i)) downgradedCount += 1;
        }
    }

    return downgradedCount;
}

function downgradeObsoleteInitialV2FullCheckpointsBeforeCompaction_ACU(chat: any[], anchorIndex: number): number {
    if (!Array.isArray(chat) || anchorIndex < 0 || anchorIndex >= chat.length) return 0;

    let downgradedCount = 0;
    const isolationKeys = collectIsolationKeysWithV2Frames_ACU(chat);
    for (const isolationKey of isolationKeys) {
        if (!hasV2CompactionCheckpointAtIndex_ACU(chat, isolationKey, anchorIndex)) continue;
        for (let i = 0; i < anchorIndex; i += 1) {
            const tagData = chat[i]?.TavernDB_ACU_IsolatedData?.[isolationKey];
            if (!isV2TagData_ACU(tagData)) continue;
            const checkpoint = tagData.storageFrame.checkpoint;
            if (checkpoint?.kind !== 'full' || checkpoint.reason !== 'init') continue;
            if (downgradeV2FullCheckpointAtIndex_ACU(chat, isolationKey, i)) downgradedCount += 1;
        }
    }
    return downgradedCount;
}

function collectV2FullCheckpointRefsForIsolation_ACU(chat: any[], isolationKey: string): Array<{ messageIndex: number; checkpoint: any }> {
    const refs: Array<{ messageIndex: number; checkpoint: any }> = [];
    if (!Array.isArray(chat)) return refs;
    for (let i = 0; i < chat.length; i += 1) {
        const tagData = chat[i]?.TavernDB_ACU_IsolatedData?.[isolationKey];
        if (!isV2TagData_ACU(tagData)) continue;
        const checkpoint = tagData.storageFrame.checkpoint;
        if (checkpoint?.kind === 'full') refs.push({ messageIndex: i, checkpoint });
    }
    return refs;
}

async function ensureV2BoundaryCheckpointForRetainedBufferCore_ACU(
    chat: any[],
    boundary: RetainedCheckpointBoundary_ACU,
    options: BoundaryCheckpointEnsureOptions_ACU = {},
): Promise<BoundaryCheckpointEnsureResult_ACU> {
    if (!boundary.shouldRotateCheckpoint || boundary.indicesToPurge.length === 0) {
        return { success: true, changed: false, skipped: true };
    }

    const anchorIndex = boundary.anchorIndex;
    if (anchorIndex !== undefined && anchorIndex >= 0 && chat[anchorIndex]) {
        try {
            const changed = await writeV2BoundaryCheckpointBeforePurge_ACU(chat, anchorIndex);
            const downgradedCount = downgradeCoveredV2FullCheckpointsAfterAnchor_ACU(chat, anchorIndex);
            const obsoleteInitDowngradedCount = downgradeObsoleteInitialV2FullCheckpointsBeforeCompaction_ACU(chat, anchorIndex);
            if ((changed || downgradedCount > 0 || obsoleteInitDowngradedCount > 0) && options.save !== false) {
                await saveChatToHost_ACU();
            }
            return { success: true, changed: changed || downgradedCount > 0 || obsoleteInitDowngradedCount > 0, anchorIndex };
        } catch (error: any) {
            return {
                success: false,
                changed: false,
                error: error?.message || String(error || '边界 checkpoint 写入失败。'),
                anchorIndex,
            };
        }
    }

    const purgeEndIndex = boundary.indicesToPurge[boundary.indicesToPurge.length - 1];
    if (collectIsolationKeysWithV2Frames_ACU(chat, { maxMessageIndex: purgeEndIndex }).length > 0) {
        return {
            success: false,
            changed: false,
            error: `最新保留 AI 楼层窗口的边界处找不到可写入 checkpoint 的 AI 楼层（保留 ${boundary.effectiveRetainCount - boundary.bufferLayers} 个 AI 楼层，缓冲 ${boundary.bufferLayers} 个 AI 楼层）。`,
        };
    }

    return { success: true, changed: false, skipped: true };
}

export function shouldRotateV2BoundaryCheckpointForRetainedBuffer_ACU(): boolean {
    const retainCount = settings_ACU.retainRecentLayers || 0;
    if (retainCount <= 0) return false;

    const chat = getChatArray_ACU();
    if (!chat || !Array.isArray(chat) || chat.length === 0) return false;

    const boundary = resolveRetainedCheckpointBoundary_ACU(chat, retainCount);
    return boundary.shouldRotateCheckpoint && boundary.indicesToPurge.length > 0 && boundary.anchorIndex !== undefined;
}

export async function ensureV2BoundaryCheckpointForRetainedBuffer_ACU(
    options: BoundaryCheckpointEnsureOptions_ACU = {},
): Promise<BoundaryCheckpointEnsureResult_ACU> {
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: options.reason === 'manual_refill'
            ? 'manual_refill_boundary_checkpoint'
            : (options.reason === 'auto_update' ? 'auto_update_boundary_checkpoint' : 'ensureRetainedBoundaryCheckpoint'),
        isolationKey: getCurrentIsolationKey_ACU(),
        writeSet: [{ kind: 'all' }],
        maintenanceMode: 'exclusive',
    }, async () => {
        const retainCount = settings_ACU.retainRecentLayers || 0;
        if (retainCount <= 0) {
            logDebug_ACU('[V2 Compaction] retainRecentLayers 为 0 或未设置，跳过边界 checkpoint 建立。');
            return { success: true, changed: false, skipped: true };
        }

        const chat = getChatArray_ACU();
        if (!chat || !Array.isArray(chat) || chat.length === 0) {
            logDebug_ACU('[V2 Compaction] 聊天记录为空，跳过边界 checkpoint 建立。');
            return { success: true, changed: false, skipped: true };
        }

        const boundary = resolveRetainedCheckpointBoundary_ACU(chat, retainCount);
        if (!boundary.shouldRotateCheckpoint) {
            logDebug_ACU(`[V2 Compaction] AI 楼层总数(${boundary.aiMessageIndices.length}) < 滚动触发层数(${boundary.effectiveRetainCount}=保留${retainCount}+缓冲${RETAIN_RECENT_CHECKPOINT_BUFFER_LAYERS_ACU})，无需建立边界 checkpoint。`);
        }
        return ensureV2BoundaryCheckpointForRetainedBufferCore_ACU(chat, boundary, options);
    });
}

export async function ensureManualRefillInitialBaseline_ACU(
    options: ManualRefillInitialBaselineEnsureOptions_ACU,
): Promise<ManualRefillInitialBaselineEnsureResult_ACU> {
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'manual_refill_initial_baseline_move',
        isolationKey: options.isolationKey,
        writeSet: [{ kind: 'all' }],
        maintenanceMode: 'exclusive',
    }, async () => {
        try {
            const chat = getChatArray_ACU();
            if (!Array.isArray(chat) || chat.length === 0) {
                return { success: false, changed: false, error: '聊天记录为空，无法前移手动重填 initial baseline。' };
            }

            const targetIndex = options.targetMessageIndex;
            const targetMsg = chat[targetIndex];
            if (!targetMsg || targetMsg.is_user) {
                return { success: false, changed: false, error: `手动重填 initial baseline 前移失败：targetMessageIndex=${targetIndex} 不是有效 AI 楼层。` };
            }

            const refs = collectV2FullCheckpointRefsForIsolation_ACU(chat, options.isolationKey);
            if (refs.length === 0) {
                return { success: true, changed: false, skipped: true, targetMessageIndex: targetIndex };
            }

            const compactionRefs = refs.filter(ref => ref.checkpoint.reason === 'compaction');
            const initRefs = refs.filter(ref => ref.checkpoint.reason === 'init');
            if (compactionRefs.length > 0) {
                let downgradedCount = 0;
                for (const initRef of initRefs) {
                    if (initRef.messageIndex < Math.min(...compactionRefs.map(ref => ref.messageIndex))) {
                        if (downgradeV2FullCheckpointAtIndex_ACU(chat, options.isolationKey, initRef.messageIndex)) downgradedCount += 1;
                    }
                }
                if (downgradedCount > 0 && options.save !== false) await saveChatToHost_ACU();
                return { success: true, changed: downgradedCount > 0, skipped: downgradedCount === 0, targetMessageIndex: targetIndex, downgradedCount };
            }

            const unsafeRefs = refs.filter(ref => ref.checkpoint.reason !== 'init');
            if (unsafeRefs.length > 0) {
                return { success: true, changed: false, skipped: true, targetMessageIndex: targetIndex };
            }

            const sortedInitRefs = [...initRefs].sort((a, b) => a.messageIndex - b.messageIndex);
            const earliestInit = sortedInitRefs[0];
            if (!earliestInit || earliestInit.messageIndex <= targetIndex) {
                return { success: true, changed: false, skipped: true, targetMessageIndex: targetIndex };
            }

            const existingTargetTagData = targetMsg.TavernDB_ACU_IsolatedData?.[options.isolationKey];
            if (isV2TagData_ACU(existingTargetTagData) && Array.isArray(existingTargetTagData.storageFrame.logEntries) && existingTargetTagData.storageFrame.logEntries.length > 0) {
                return { success: false, changed: false, error: `手动重填 initial baseline 前移失败：目标楼层 #${targetIndex} 已存在 V2 logEntries，拒绝覆盖。`, targetMessageIndex: targetIndex };
            }

            if (!targetMsg.TavernDB_ACU_IsolatedData || typeof targetMsg.TavernDB_ACU_IsolatedData !== 'object' || Array.isArray(targetMsg.TavernDB_ACU_IsolatedData)) {
                targetMsg.TavernDB_ACU_IsolatedData = {};
            }
            const existingTargetTag = targetMsg.TavernDB_ACU_IsolatedData[options.isolationKey];
            const data = JSON.parse(JSON.stringify(options.data || {}));
            targetMsg.TavernDB_ACU_IsolatedData[options.isolationKey] = {
                ...(existingTargetTag?.summaryVectorIndexState !== undefined ? { summaryVectorIndexState: existingTargetTag.summaryVectorIndexState } : {}),
                ...(existingTargetTag?.summaryVectorIndexManifest !== undefined ? { summaryVectorIndexManifest: existingTargetTag.summaryVectorIndexManifest } : {}),
                storageFrame: {
                    version: 2,
                    checkpoint: {
                        kind: 'full',
                        createdAt: Date.now(),
                        reason: 'init',
                        data,
                        scheduleSummary: collectScheduleSummaryFromFramesV2_ACU(chat, options.isolationKey, { maxMessageIndex: targetIndex }),
                    },
                    logEntries: [],
                },
                _acu_storage_version: 2,
            };

            let downgradedCount = 0;
            for (const initRef of sortedInitRefs) {
                if (initRef.messageIndex === targetIndex) continue;
                if (downgradeV2FullCheckpointAtIndex_ACU(chat, options.isolationKey, initRef.messageIndex)) downgradedCount += 1;
            }

            if (options.save !== false) await saveChatToHost_ACU();
            return { success: true, changed: true, targetMessageIndex: targetIndex, movedFromMessageIndex: earliestInit.messageIndex, downgradedCount };
        } catch (error: any) {
            return { success: false, changed: false, error: error?.message || String(error || '手动重填 initial baseline 前移失败。') };
        }
    });
}


async function writeV2BoundaryCheckpointBeforePurge_ACU(
    chat: any[],
    boundaryAnchorIndex: number,
): Promise<boolean> {
    if (boundaryAnchorIndex < 0 || !chat[boundaryAnchorIndex] || chat[boundaryAnchorIndex].is_user) {
        throw new Error(`边界 checkpoint 写入失败：boundaryAnchorIndex=${boundaryAnchorIndex} 不是有效 AI 楼层。`);
    }

    let changed = false;
    const isolationConfig = {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
    };

    const isolationKeys = collectIsolationKeysWithV2Frames_ACU(chat, { maxMessageIndex: boundaryAnchorIndex });
    for (const isolationKey of isolationKeys) {
        const strategy = resolveTableStorageStrategy_ACU(chat, isolationKey, isolationConfig);
        if (strategy.mode !== 'v2') continue;

        if (hasV2CompactionCheckpointAtIndex_ACU(chat, isolationKey, boundaryAnchorIndex)) {
            logDebug_ACU(`[V2 Compaction] AI 保留边界楼层 #${boundaryAnchorIndex} 已存在 isolationKey=[${isolationKey || '无标签'}] 的 compaction full checkpoint，跳过重建。`);
            continue;
        }

        const data = await loadTableStateFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: boundaryAnchorIndex });
        if (!data) {
            throw new Error(`边界 checkpoint 写入失败：无法在 boundaryAnchorIndex=${boundaryAnchorIndex} 前恢复 isolationKey=[${isolationKey || '无标签'}] 的 V2 数据。`);
        }

        const anchorMsg = chat[boundaryAnchorIndex];
        if (!anchorMsg.TavernDB_ACU_IsolatedData || typeof anchorMsg.TavernDB_ACU_IsolatedData !== 'object' || Array.isArray(anchorMsg.TavernDB_ACU_IsolatedData)) {
            anchorMsg.TavernDB_ACU_IsolatedData = {};
        }

        const existingTagData = anchorMsg.TavernDB_ACU_IsolatedData[isolationKey];
        const frame: TableStorageFrameV2_ACU = {
            version: 2,
            checkpoint: {
                kind: 'full',
                createdAt: Date.now(),
                reason: 'compaction',
                data,
                scheduleSummary: collectScheduleSummaryFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: boundaryAnchorIndex }),
            },
            logEntries: [],
        };

        anchorMsg.TavernDB_ACU_IsolatedData[isolationKey] = {
            ...(existingTagData?.summaryVectorIndexState !== undefined ? { summaryVectorIndexState: existingTagData.summaryVectorIndexState } : {}),
            ...(existingTagData?.summaryVectorIndexManifest !== undefined ? { summaryVectorIndexManifest: existingTagData.summaryVectorIndexManifest } : {}),
            storageFrame: frame,
            _acu_storage_version: 2,
        };
        changed = true;
        logDebug_ACU(`[V2 Compaction] 已在 AI 保留边界楼层 #${boundaryAnchorIndex} 写入 isolationKey=[${isolationKey || '无标签'}] 的 full checkpoint。`);
    }

    return changed;
}

/**
 * 替换聊天消息内容（正文优化核心逻辑）
 * 从 presentation/components/optimization-ui/optimization-ui-exec.ts 搬迁
 */
export async function replaceChatMessage_ACU(messageIndex: number, newContent: string, options: any = {}) {
    try {
        logDebug_ACU(`[正文优化] replaceChatMessage_ACU 开始执行, messageIndex=${messageIndex}, newContent长度=${newContent?.length || 0}`);

        const chat = getChatArray_ACU();
        if (!chat || !chat[messageIndex]) {
            logError_ACU('[正文优化] 消息不存在, chat存在=', !!chat, 'messageIndex=', messageIndex);
            throw new Error('消息不存在');
        }

        const oldContent = chat[messageIndex].mes;
        logDebug_ACU(`[正文优化] 原内容长度: ${oldContent?.length || 0}, 新内容长度: ${newContent?.length || 0}`);

        // 保存原始内容到 extra 字段，用于"重新优化"功能
        // 只有当 extra._acu_original_content 不存在时才保存（避免覆盖最初的原始内容）
        const extra = chat[messageIndex].extra || {};
        if (!extra._acu_original_content) {
            extra._acu_original_content = options.originalContent ?? oldContent;
            logDebug_ACU(`[正文优化] 保存原始内容到 extra._acu_original_content，长度: ${extra._acu_original_content?.length || 0}`);
        }
        extra._acu_last_optimized_at = Date.now();
        extra._acu_last_optimized_message_id = chat[messageIndex].message_id;
        setLastOptimizationBase_ACU({
            messageIndex,
            messageId: chat[messageIndex].message_id,
            baseContent: extra._acu_original_content || options.originalContent || oldContent || ''
        });

        // 使用酒馆的 setChatMessages API 来更新消息内容，确保渲染及时生效
        const success = await setChatMessages_ACU(
            [{ message_id: chat[messageIndex].message_id, mes: newContent, extra: extra }],
            { refresh: 'affected' }
        );
        if (success) {
            logDebug_ACU('[正文优化] 消息已通过 setChatMessages API 更新');
        } else {
            // 降级方案：如果 setChatMessages 不可用，使用原有逻辑
            logDebug_ACU('[正文优化] setChatMessages API 不可用，使用降级方案...');

            chat[messageIndex].mes = newContent;
            chat[messageIndex].extra = extra;

            const verifyContent = chat[messageIndex].mes;
            logDebug_ACU(`[正文优化] 修改后验证 - 内容长度: ${verifyContent?.length || 0}, 是否匹配: ${verifyContent === newContent}`);

            await saveChatToHost_ACU();
            logDebug_ACU('[正文优化] 聊天已保存');

            emitMessageUpdated_ACU(messageIndex);
        }

        logDebug_ACU(`[正文优化] 消息 ${messageIndex} 已更新完成`);
        return true;

    } catch (error) {
        logError_ACU('[正文优化] 替换消息失败:', error);
        return false;
    }
}

/**
 * 获取消息的原始内容（用于重新优化）
 * 从 presentation/components/optimization-ui/optimization-ui-exec.ts 搬迁
 */
export function getOriginalContent_ACU(messageIndex: number) {
    const cachedBase = getLastOptimizationBase_ACU();
    if (cachedBase?.baseContent) {
        const chat = getChatArray_ACU();
        if (cachedBase.messageId != null) {
            const matchedIndex = chat.findIndex(msg => msg && !msg.is_user && msg.message_id === cachedBase.messageId);
            if (matchedIndex === messageIndex) {
                return cachedBase.baseContent;
            }
        }
        if (cachedBase.messageIndex === messageIndex) {
            return cachedBase.baseContent;
        }
    }

    const chat = getChatArray_ACU();
    if (!chat || !chat[messageIndex]) {
        return null;
    }
    const extra = chat[messageIndex].extra || {};
    return extra._acu_original_content || null;
}

/**
 * 保存当前表格数据到聊天记录
 * 从 presentation/triggers/update-process.ts 搬迁
 */
export async function saveCurrentDataForTable_ACU(sheetKey: string) {
    try {
        if (!currentJsonTableData_ACU || !currentJsonTableData_ACU[sheetKey]) {
            logWarn_ACU('saveCurrentDataForTable_ACU: No data to save.');
            return;
        }

        const chat = getChatArray_ACU();
        if (!chat || chat.length === 0) {
            logWarn_ACU('saveCurrentDataForTable_ACU: No chat history.');
            return;
        }

        const sheet = currentJsonTableData_ACU[sheetKey];
        const history = resolveTableHistoryStateFromChat_ACU(chat, {
            sheetKey,
            isSummaryTable: isSummaryOrOutlineTable_ACU(sheet.name),
            isolationKey: getCurrentIsolationKey_ACU(),
            settings: settings_ACU,
        });
        const fallbackLatestAiIndex = getLatestAiMessageIndexFromChat_ACU(chat);
        const targetMessageIndex = history.latestDataMessageIndex !== -1
            ? history.latestDataMessageIndex
            : fallbackLatestAiIndex;

        if (targetMessageIndex === -1) {
            logWarn_ACU('saveCurrentDataForTable_ACU: No AI message available for persistence.');
            return;
        }

        const commitResult = await runTableUpdateCommit_ACU<void>({
            source: 'system',
            reason: 'saveCurrentDataForTable',
            isolationKey: getCurrentIsolationKey_ACU(),
            writeSet: [{ kind: 'sheet', sheetKey }],
            revisionWriteSet: [{ kind: 'sheet', sheetKey }],
            initialData: currentJsonTableData_ACU,
            targetMessageIndex,
            targetSheetKeys: [sheetKey],
            updateGroupKeys: null,
            trackingSheetKeys: [sheetKey],
            trackAsUpdate: history.latestDataMessageIndex === -1,
            operations: [{ kind: 'sheet_replace', sheetKey, sheet: (currentJsonTableData_ACU as any)[sheetKey], reason: 'system' }],
        }, () => ({
            success: true,
            tableData: currentJsonTableData_ACU as any,
        }));
        if (!commitResult.success) {
            logWarn_ACU(`saveCurrentDataForTable_ACU: commit failed: ${commitResult.error || 'unknown error'}`);
        }
    } catch (e) {
        logError_ACU('saveCurrentDataForTable_ACU failed:', e);
    }
}

/**
 * 清理超出保留层数的旧本地数据（表格数据 + 剧情推进数据）
 * 从 presentation/triggers/settings-ui-sync/settings-ui-config.ts 搬迁
 * 
 * 按 AI 楼层计数，用户可见语义保留最近 N 个 AI 楼层；额外等待 20 个 AI 楼层缓冲后滚动边界 checkpoint。
 * 仅保护聊天第一层的"空白指导表"（TavernDB_ACU_InternalSheetGuide），不保护整层本地数据。
 */
async function purgeOldLayerDataCore_ACU() {
    const retainCount = settings_ACU.retainRecentLayers || 0;
    if (retainCount <= 0) {
        logDebug_ACU('[数据清理] retainRecentLayers 为 0 或未设置，跳过清理。');
        return;
    }

    const chat = getChatArray_ACU();
    if (!chat || !Array.isArray(chat) || chat.length === 0) {
        logDebug_ACU('[数据清理] 聊天记录为空，跳过清理。');
        return;
    }

    const boundary = resolveRetainedCheckpointBoundary_ACU(chat, retainCount);
    if (!boundary.shouldCompact) {
        logDebug_ACU(`[数据清理] AI 楼层总数(${boundary.aiMessageIndices.length}) < 滚动触发层数(${boundary.effectiveRetainCount}=保留${retainCount}+缓冲${RETAIN_RECENT_CHECKPOINT_BUFFER_LAYERS_ACU})，无需清理。`);
        return;
    }

    const { indicesToPurge, retainedDataIndices, anchorIndex } = boundary;

    if (indicesToPurge.length === 0) {
        logDebug_ACU('[数据清理] 无需清理的楼层。');
        return;
    }

    logDebug_ACU(`[数据清理] 将清理 ${indicesToPurge.length} 层旧消息的本地数据（保留最近 ${retainCount} 个 AI 楼层，缓冲 ${RETAIN_RECENT_CHECKPOINT_BUFFER_LAYERS_ACU} 个 AI 楼层后滚动 checkpoint）...`);

    // ── [V2 边界 checkpoint] 删除旧 frame 前，确保最新保留 AI 窗口首个 AI 楼层有 full checkpoint ──
    const checkpointResult = await ensureV2BoundaryCheckpointForRetainedBufferCore_ACU(chat, boundary, { reason: 'purge', save: true });
    if (!checkpointResult.success) {
        logError_ACU('[V2 Compaction] 写入边界 checkpoint 失败，已中止本次清理以避免恢复链断裂:', checkpointResult.error);
        return;
    }

    // ── [兜底快照] 在删除旧楼层之前，迁移冷表数据到边界保留楼层 ──
    const retainedSet = new Set<number>(retainedDataIndices);

    // 确认边界楼层有效。chat[0] 只保护指导表字段，不再整层保护普通本地数据。
    if (anchorIndex !== undefined && anchorIndex >= 0 && chat[anchorIndex]) {
        const dataIsolationEnabled = settings_ACU.dataIsolationEnabled || false;
        const dataIsolationCode = settings_ACU.dataIsolationCode || null;

        // orphanedData: Map<isolationKey, Map<sheetKey, SheetData>>
        const orphanedData = new Map<string, Map<string, any>>();

        // 按索引从小到大遍历待清理楼层（从旧到新，后面的覆盖前面的 → 取最新版本）
        for (const idx of indicesToPurge) {
            const msg = chat[idx];
            if (!msg || msg.is_user) continue;

            const sheetDataMap = collectAllSheetDataFromMessage_ACU(msg, dataIsolationEnabled, dataIsolationCode);
            if (sheetDataMap.size === 0) continue;

            for (const [isoKey, sheetMap] of sheetDataMap) {
                for (const [sheetKey, sheetData] of sheetMap) {
                    // 检查该表是否在任何保留楼层中已有数据
                    if (isSheetRetainedInAnyFloor_ACU(sheetKey, isoKey, retainedSet, chat, dataIsolationEnabled, dataIsolationCode)) {
                        continue; // 已有保留数据，无需兜底
                    }

                    // 记录到 orphanedData（后面的覆盖前面的，实现取最新版本）
                    if (!orphanedData.has(isoKey)) {
                        orphanedData.set(isoKey, new Map<string, any>());
                    }
                    orphanedData.get(isoKey)!.set(sheetKey, sheetData);
                }
            }
        }

        // 将 orphaned 数据写入边界保留楼层
        if (orphanedData.size > 0) {
            let totalSheets = 0;
            for (const [, sheetMap] of orphanedData) {
                totalSheets += sheetMap.size;
            }

            logDebug_ACU(`[数据清理] 检测到 ${totalSheets} 张表（${orphanedData.size} 个隔离标签）仅存在于待清理楼层，将写入边界保留楼层 #${anchorIndex} 作为兜底...`);

            const anchorMsg = chat[anchorIndex];

            // 初始化 IsolatedData 容器
            if (!anchorMsg.TavernDB_ACU_IsolatedData || typeof anchorMsg.TavernDB_ACU_IsolatedData !== 'object' || Array.isArray(anchorMsg.TavernDB_ACU_IsolatedData)) {
                anchorMsg.TavernDB_ACU_IsolatedData = {};
            }

            for (const [isoKey, sheetMap] of orphanedData) {
                const strategy = resolveTableStorageStrategy_ACU(chat, isoKey, {
                    enabled: settings_ACU.dataIsolationEnabled,
                    code: settings_ACU.dataIsolationCode,
                });
                if (strategy.mode !== 'legacy-v1') {
                    logDebug_ACU(`[数据清理] isolationKey=[${isoKey || '无标签'}] 未确认为 legacy-v1，跳过 V1 兜底快照写入。`);
                    continue;
                }

                // 初始化该 isolationKey 槽（如果不存在）
                if (!anchorMsg.TavernDB_ACU_IsolatedData[isoKey]) {
                    anchorMsg.TavernDB_ACU_IsolatedData[isoKey] = {
                        independentData: {},
                        modifiedKeys: [],
                        updateGroupKeys: [],
                    };
                }

                const anchorTagData = anchorMsg.TavernDB_ACU_IsolatedData[isoKey];
                if (!anchorTagData.independentData || typeof anchorTagData.independentData !== 'object') {
                    anchorTagData.independentData = {};
                }

                // 写入表数据（不修改 modifiedKeys/updateGroupKeys，避免干扰自动更新门禁）
                for (const [sheetKey, sheetData] of sheetMap) {
                    anchorTagData.independentData[sheetKey] = JSON.parse(JSON.stringify(sheetData));
                }
                anchorTagData._acu_storage_mode = 'checkpoint';
                anchorTagData._acu_storage_version = 1;
            }

            // 立即持久化兜底数据，再继续删除循环
            try {
                await saveChatToHost_ACU();
                logDebug_ACU(`[数据清理] 已将 ${totalSheets} 张表（${orphanedData.size} 个隔离标签）的兜底数据写入楼层 #${anchorIndex}，聊天已保存。`);
            } catch (e) {
                logWarn_ACU('[数据清理] 写入兜底数据失败，继续清理流程:', e);
            }
        } else {
            logDebug_ACU('[数据清理] 未检测到需要兜底的表数据。');
        }
    } else {
        logWarn_ACU(`[数据清理] 边界保留楼层索引无效（anchorIndex=${anchorIndex}），跳过兜底快照。`);
    }

    let purgedCount = 0;
    const keysToDelete = [
        'TavernDB_ACU_Data',
        'TavernDB_ACU_SummaryData',
        'TavernDB_ACU_IndependentData',
        'TavernDB_ACU_ModifiedKeys',
        'TavernDB_ACU_UpdateGroupKeys',
        'TavernDB_ACU_IsolatedData',
        'TavernDB_ACU_Identity',
        'qrf_plot',
        'qrf_plot_preset',
        'qrf_plot_tasks'
    ];

    let purgedVectorManifestCount = 0;
    for (const idx of indicesToPurge) {
        const msg = chat[idx];
        if (!msg) continue;

        purgedVectorManifestCount += await deleteVectorIndexManifestsFromMessage_ACU(msg);

        let modified = false;
        for (const key of keysToDelete) {
            if (Object.prototype.hasOwnProperty.call(msg, key)) {
                delete msg[key];
                modified = true;
            }
        }

        if (modified) {
            purgedCount++;
        }
    }

    if (purgedCount > 0) {
        try {
            await saveChatToHost_ACU();
            logDebug_ACU(`[数据清理] 已清理 ${purgedCount} 层消息的本地数据，已删除 ${purgedVectorManifestCount} 组交火向量索引外置文件引用，聊天记录已保存。`);
        } catch (e) {
            logError_ACU('[数据清理] 保存聊天记录失败:', e);
        }
    } else {
        logDebug_ACU('[数据清理] 目标楼层中未发现需要清理的数据字段。');
    }
}

export async function purgeOldLayerData_ACU() {
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'purgeOldLayerData',
        isolationKey: getCurrentIsolationKey_ACU(),
        writeSet: [{ kind: 'all' }],
        maintenanceMode: 'exclusive',
    }, () => purgeOldLayerDataCore_ACU());
}

/**
 * 检查指定表是否在任何保留楼层中存在数据。
 * 同时检查新版 IsolatedData 路径和旧版兼容路径。
 */
function isSheetRetainedInAnyFloor_ACU(
    sheetKey: string,
    isolationKey: string,
    retainedSet: Set<number>,
    chat: any[],
    dataIsolationEnabled: boolean,
    dataIsolationCode: string | null,
): boolean {
    for (const idx of retainedSet) {
        const msg = chat[idx];
        if (!msg || msg.is_user) continue;

        // 新版 IsolatedData 路径
        const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
        if (tagData?.independentData?.[sheetKey]) {
            return true;
        }

        // 旧版兼容路径：仅当 isolationKey 与当前隔离配置匹配时检查
        if (!dataIsolationEnabled) {
            // 无隔离模式：检查旧版字段中是否存在
            const legacyIdentity = msg?.TavernDB_ACU_Identity;
            if (!legacyIdentity && (msg?.TavernDB_ACU_IndependentData?.[sheetKey] || msg?.TavernDB_ACU_Data?.[sheetKey] || msg?.TavernDB_ACU_SummaryData?.[sheetKey])) {
                return true;
            }
        } else {
            // 隔离模式：检查 identity 是否匹配
            if (msg?.TavernDB_ACU_Identity === dataIsolationCode) {
                if (msg?.TavernDB_ACU_IndependentData?.[sheetKey] || msg?.TavernDB_ACU_Data?.[sheetKey] || msg?.TavernDB_ACU_SummaryData?.[sheetKey]) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * 从消息中收集所有表数据（新版 IsolatedData + 旧版兼容路径）。
 * 返回按 isolationKey 分组的 Map。
 *
 * @param msg 聊天消息对象
 * @param dataIsolationEnabled 当前隔离配置
 * @param dataIsolationCode 当前隔离码
 * @returns Map<isolationKey, Map<sheetKey, Sheet_ACU>>
 */
function collectAllSheetDataFromMessage_ACU(
    msg: any,
    dataIsolationEnabled: boolean,
    dataIsolationCode: string | null,
): Map<string, Map<string, any>> {
    const result = new Map<string, Map<string, any>>();

    // 新版 IsolatedData 路径：遍历所有 isolationKey
    const isolatedData = msg?.TavernDB_ACU_IsolatedData;
    if (isolatedData && typeof isolatedData === 'object' && !Array.isArray(isolatedData)) {
        for (const [isoKey, tagData] of Object.entries(isolatedData) as [string, any][]) {
            const independentData = tagData?.independentData;
            if (!independentData || typeof independentData !== 'object') continue;
            const sheetMap = new Map<string, any>();
            for (const [sheetKey, sheetData] of Object.entries(independentData)) {
                if (sheetKey.startsWith('sheet_') && sheetData && typeof sheetData === 'object') {
                    sheetMap.set(sheetKey, sheetData);
                }
            }
            if (sheetMap.size > 0) {
                result.set(isoKey, sheetMap);
            }
        }
    }

    // 旧版兼容路径：归入对应的 isolationKey
    const legacyIsoKey = dataIsolationEnabled ? (dataIsolationCode || '') : '';
    // 判断该消息的旧版数据是否属于当前隔离上下文
    const msgLegacyIdentity = msg?.TavernDB_ACU_Identity;
    let legacyBelongsHere = false;
    if (!dataIsolationEnabled) {
        legacyBelongsHere = !msgLegacyIdentity;
    } else {
        legacyBelongsHere = msgLegacyIdentity === dataIsolationCode;
    }

    if (legacyBelongsHere) {
        const legacySheets = new Map<string, any>();

        const legacyIndependent = msg?.TavernDB_ACU_IndependentData;
        if (legacyIndependent && typeof legacyIndependent === 'object') {
            for (const [sheetKey, sheetData] of Object.entries(legacyIndependent)) {
                if (sheetKey.startsWith('sheet_') && sheetData && typeof sheetData === 'object') {
                    legacySheets.set(sheetKey, sheetData);
                }
            }
        }

        const legacyStandard = msg?.TavernDB_ACU_Data;
        if (legacyStandard && typeof legacyStandard === 'object') {
            for (const [sheetKey, sheetData] of Object.entries(legacyStandard)) {
                if (sheetKey.startsWith('sheet_') && sheetData && typeof sheetData === 'object' && !legacySheets.has(sheetKey)) {
                    legacySheets.set(sheetKey, sheetData);
                }
            }
        }

        const legacySummary = msg?.TavernDB_ACU_SummaryData;
        if (legacySummary && typeof legacySummary === 'object') {
            for (const [sheetKey, sheetData] of Object.entries(legacySummary)) {
                if (sheetKey.startsWith('sheet_') && sheetData && typeof sheetData === 'object' && !legacySheets.has(sheetKey)) {
                    legacySheets.set(sheetKey, sheetData);
                }
            }
        }

        if (legacySheets.size > 0) {
            const existing = result.get(legacyIsoKey);
            if (existing) {
                for (const [k, v] of legacySheets) {
                    existing.set(k, v);
                }
            } else {
                result.set(legacyIsoKey, legacySheets);
            }
        }
    }

    return result;
}

/**
 * 删除聊天记录中的本地数据（核心业务逻辑）
 * 从 presentation/triggers/data-admin-ui.ts 的 deleteLocalDataInChat_ACU 中提取
 * 
 * 只负责数据操作（遍历 chat 删除字段 + saveChatToHost），不涉及 UI（toast/status display）。
 * @returns 删除的消息数量
 */
async function deleteLocalDataInChatCoreInner_ACU(
    mode: 'current' | 'all' = 'current',
    startFloor: number | null = null,
    endFloor: number | null = null
): Promise<number> {
    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) {
        return 0;
    }

    let deletedCount = 0;
    const targetIdentity = settings_ACU.dataIsolationEnabled ? settings_ACU.dataIsolationCode : null;
    const currentIsolationKey = getCurrentIsolationKey_ACU();

    // 计算AI消息索引列表（只计算AI楼层）
    const aiMessageIndices = chat
        .map((msg: any, index: number) => (!msg.is_user) ? index : -1)
        .filter((index: number) => index !== -1);

    if (aiMessageIndices.length === 0) {
        return 0;
    }

    // 转换AI楼层范围为AI消息索引范围
    const startAiIndex = startFloor ? Math.max(0, startFloor - 1) : 0;
    const endAiIndex = endFloor ? Math.min(aiMessageIndices.length - 1, endFloor - 1) : aiMessageIndices.length - 1;

    // 获取要处理的AI消息的物理索引
    const targetIndices = aiMessageIndices.slice(startAiIndex, endAiIndex + 1);

    for (const physicalIndex of targetIndices) {
        const msg = chat[physicalIndex];
        let shouldDelete = false;

        if (mode === 'all') {
            shouldDelete = true;
        } else {
            const isolatedData = msg.TavernDB_ACU_IsolatedData;
            if (isolatedData && typeof isolatedData === 'object' && !Array.isArray(isolatedData) && isolatedData[currentIsolationKey]) {
                shouldDelete = true;
            } else if (settings_ACU.dataIsolationEnabled) {
                if (msg.TavernDB_ACU_Identity === targetIdentity) {
                    shouldDelete = true;
                }
            } else {
                if (msg.TavernDB_ACU_Data || msg.TavernDB_ACU_SummaryData || msg.TavernDB_ACU_IndependentData || msg.TavernDB_ACU_IsolatedData) {
                    shouldDelete = true;
                }
            }
        }

        if (shouldDelete) {
            let modified = false;

            if (msg.TavernDB_ACU_Data) {
                delete msg.TavernDB_ACU_Data;
                modified = true;
            }
            if (msg.TavernDB_ACU_SummaryData) {
                delete msg.TavernDB_ACU_SummaryData;
                modified = true;
            }
            if (msg.TavernDB_ACU_IndependentData) {
                delete msg.TavernDB_ACU_IndependentData;
                modified = true;
            }
            if (msg.TavernDB_ACU_Identity !== undefined) {
                delete msg.TavernDB_ACU_Identity;
                modified = true;
            }
            if (msg.TavernDB_ACU_IsolatedData) {
                if (mode === 'all') {
                    const isolatedData = msg.TavernDB_ACU_IsolatedData;
                    for (const key of Object.keys(isolatedData)) {
                        await deleteVectorIndexManifestFromTagData_ACU(isolatedData[key]);
                    }
                    delete msg.TavernDB_ACU_IsolatedData;
                    modified = true;
                } else {
                    if (msg.TavernDB_ACU_IsolatedData[currentIsolationKey]) {
                        await deleteVectorIndexManifestFromTagData_ACU(msg.TavernDB_ACU_IsolatedData[currentIsolationKey]);
                        delete msg.TavernDB_ACU_IsolatedData[currentIsolationKey];
                        if (Object.keys(msg.TavernDB_ACU_IsolatedData).length === 0) {
                            delete msg.TavernDB_ACU_IsolatedData;
                        }
                        modified = true;
                    }
                }
            }
            if (msg.TavernDB_ACU_ModifiedKeys) {
                delete msg.TavernDB_ACU_ModifiedKeys;
            }
            if (msg.TavernDB_ACU_UpdateGroupKeys) {
                delete msg.TavernDB_ACU_UpdateGroupKeys;
            }

            if (modified) {
                deletedCount++;
            }
        }
    }

    if (deletedCount > 0) {
        await saveChatToHost_ACU();
    }

    return deletedCount;
}

export async function deleteLocalDataInChatCore_ACU(
    mode: 'current' | 'all' = 'current',
    startFloor: number | null = null,
    endFloor: number | null = null
): Promise<number> {
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'deleteLocalDataInChat',
        isolationKey: getCurrentIsolationKey_ACU(),
        writeSet: [{ kind: 'all' }],
        maintenanceMode: 'exclusive',
    }, () => deleteLocalDataInChatCoreInner_ACU(mode, startFloor, endFloor));
}

/**
 * 使用模板覆盖最新层的表格数据（核心业务逻辑）
 * 从 presentation/triggers/data-admin-ui.ts 的 overrideLatestLayerWithTemplate_ACU 中提取
 * 
 * 只负责数据操作（遍历 chat 用模板覆盖 + saveChatToHost），不涉及 UI（confirm/toast）。
 * @param templateData 解析后的模板数据
 * @returns 覆盖的表格数量，0 表示没有修改
 */
export async function overrideLatestLayerWithTemplateCore_ACU(templateData: any): Promise<number> {
    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) {
        return 0;
    }

    const currentIsolationKey = getCurrentIsolationKey_ACU();

    // 找到最新的一条AI消息
    let latestAiIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) {
            latestAiIndex = i;
            break;
        }
    }

    if (latestAiIndex === -1) {
        return 0;
    }

    const overrideSheets: Record<string, any> = {};

    // 遍历模板中的所有表格，使用模板数据覆盖本地数据
    Object.keys(templateData).forEach(sheetKey => {
        if (!sheetKey.startsWith('sheet_')) return;

        const templateTable = templateData[sheetKey];
        if (!templateTable || !templateTable.name) return;

        // 创建覆盖数据：保留表头，清空数据行
        const overrideTable = JSON.parse(JSON.stringify(templateTable));
        if (overrideTable.content && overrideTable.content.length > 1) {
            overrideTable.content = [overrideTable.content[0]]; // 只保留表头
        }

        overrideSheets[sheetKey] = sanitizeSheetForStorage_ACU(overrideTable);
        logDebug_ACU(`Overrode table "${templateTable.name}" (${sheetKey}) in latest layer with template data.`);
    });

    const modifiedSheetKeys = Object.keys(overrideSheets);
    if (modifiedSheetKeys.length === 0) {
        return 0;
    }

    const nextTableData = JSON.parse(JSON.stringify(currentJsonTableData_ACU || {}));
    if (!nextTableData.mate && templateData?.mate) {
        nextTableData.mate = JSON.parse(JSON.stringify(templateData.mate));
    }
    for (const sheetKey of modifiedSheetKeys) {
        nextTableData[sheetKey] = overrideSheets[sheetKey];
    }

    const operations: TableMutationOperationV2_ACU[] = modifiedSheetKeys.map(sheetKey => ({
        kind: 'sheet_replace',
        sheetKey,
        sheet: overrideSheets[sheetKey],
        reason: 'system',
    }));
    const commitResult = await runTableUpdateCommit_ACU<number>({
        source: 'system',
        reason: 'overrideLatestLayerWithTemplate',
        isolationKey: currentIsolationKey,
        writeSet: modifiedSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey })),
        revisionWriteSet: modifiedSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey })),
        initialData: currentJsonTableData_ACU,
        targetMessageIndex: latestAiIndex,
        targetSheetKeys: modifiedSheetKeys,
        updateGroupKeys: modifiedSheetKeys,
        trackingSheetKeys: modifiedSheetKeys,
        trackAsUpdate: true,
        operations,
    }, () => ({
        success: true,
        value: modifiedSheetKeys.length,
        tableData: nextTableData as any,
    }));
    if (!commitResult.success) {
        logWarn_ACU(`[模板覆盖] 公共提交失败：${commitResult.error || 'unknown error'}`);
        return 0;
    }

    return commitResult.value || 0;
}

/**
 * 按消息索引列表清空指定 AI 楼层上的当前隔离标签表格数据，并保存聊天。
 *
 * 用于手动填表前的"预清空"步骤：先清除目标楼层上的旧表格数据，
 * 再执行新的手动填表，防止 SQL 严格填表逻辑因旧数据残留导致写入失败。
 *
 * 清理范围：当前隔离标签下的新版 IsolatedData 槽 + 旧版兼容字段。
 * 不影响同一消息上其他隔离标签的数据。
 * 不删除消息正文或非表格业务字段。
 *
 * @param targetMessageIndices 需要清空的目标 AI 消息物理索引列表（已去重）
 * @returns 实际被清空的消息数量
 */
async function clearTableDataAtFloorsCore_ACU(targetMessageIndices: number[], targetSheetKeys: string[] | null = null): Promise<number> {
    if (!targetMessageIndices || targetMessageIndices.length === 0) return 0;

    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) return 0;

    const isolationKey = getCurrentIsolationKey_ACU();
    const isolationConfig = {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
    };
    const clearsSummaryOrOutline = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0
        ? tableListContainsSummaryOrOutline_ACU(targetSheetKeys)
        : true;

    let clearedCount = 0;

    for (const idx of targetMessageIndices) {
        if (idx < 0 || idx >= chat.length) continue;
        const msg = chat[idx];
        // 只处理 AI 消息（跳过用户消息）
        if (!msg || msg.is_user) continue;

        const changed = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0
            ? purgeTargetSheetKeysFromMessage_ACU(msg, targetSheetKeys)
            : clearTableFieldsForIsolation_ACU(msg, isolationKey, isolationConfig);
        if (clearsSummaryOrOutline) {
            const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
            if (await deleteVectorIndexManifestFromTagData_ACU(tagData)) {
                logDebug_ACU(`[清空楼层] 已删除消息索引 ${idx} 上的交火向量索引外置文件引用。`);
            }
        }
        if (changed) {
            clearedCount++;
            logDebug_ACU(`[清空楼层] 已清空消息索引 ${idx} 上的表格数据 (标签: ${isolationKey || '无'})`);
        }
    }

    if (clearedCount > 0) {
        await saveChatToHost_ACU();
        logDebug_ACU(`[清空楼层] 共清空 ${clearedCount} 条消息的表格数据，聊天已保存。`);
    }

    return clearedCount;
}

export async function clearTableDataAtFloors_ACU(targetMessageIndices: number[], targetSheetKeys: string[] | null = null): Promise<number> {
    const writeSet = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0
        ? targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }))
        : [{ kind: 'all' as const }];
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'clearTableDataAtFloors',
        isolationKey: getCurrentIsolationKey_ACU(),
        writeSet,
        maintenanceMode: 'exclusive',
    }, () => clearTableDataAtFloorsCore_ACU(targetMessageIndices, targetSheetKeys));
}

async function clearManualRefillIncrementalDataInRangeCore_ACU(targetMessageIndices: number[], targetSheetKeys: string[] | null = null): Promise<number> {
    if (!targetMessageIndices || targetMessageIndices.length === 0) return 0;
    if (!Array.isArray(targetSheetKeys) || targetSheetKeys.length === 0) {
        throw new Error('手动重填增量清理必须指定目标表。');
    }

    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) return 0;

    const isolationKey = getCurrentIsolationKey_ACU();
    const targetSheetKeySet = new Set(targetSheetKeys);
    const maxTargetMessageIndex = targetMessageIndices.reduce(
        (max, index) => Number.isInteger(index) ? Math.max(max, index) : max,
        -1,
    );
    const knownSqlTableNames = new Set<string>();
    for (let index = 0; index <= maxTargetMessageIndex && index < chat.length; index++) {
        const msg = chat[index];
        if (!msg || msg.is_user) continue;
        const tagData = readIsolatedTagData_ACU(msg, isolationKey);
        if (!isV2TagData_ACU(tagData)) continue;
        const names = collectSqlTargetTableNamesFromStorageFrameV2_ACU(tagData.storageFrame, targetSheetKeySet);
        names.forEach(name => knownSqlTableNames.add(name));
    }
    const clearsSummaryOrOutline = tableListContainsSummaryOrOutline_ACU(targetSheetKeys);
    let clearedCount = 0;

    for (const idx of targetMessageIndices) {
        if (idx < 0 || idx >= chat.length) continue;
        const msg = chat[idx];
        if (!msg || msg.is_user) continue;

        const changed = purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, isolationKey, targetSheetKeys, knownSqlTableNames);
        if (clearsSummaryOrOutline) {
            const isolatedData = msg?.TavernDB_ACU_IsolatedData;
            const tagData = isolatedData && typeof isolatedData === 'object' && !Array.isArray(isolatedData)
                ? isolatedData[isolationKey]
                : null;
            if (await deleteVectorIndexManifestFromTagData_ACU(tagData)) {
                logDebug_ACU(`[手动重填预清理] 已删除消息索引 ${idx} 上的交火向量索引外置文件引用。`);
            }
        }
        if (changed) {
            clearedCount++;
            logDebug_ACU(`[手动重填预清理] 已清理消息索引 ${idx} 上选中表的增量数据 (标签: ${isolationKey || '无'})`);
        }
    }

    const residueSummary = {
        exactHits: 0,
        runtimeV1Hits: 0,
        substringOnlyPathCount: 0,
        checkpointDataRiskCount: 0,
        scheduleSummaryRiskCount: 0,
        checkpointDataRiskDetailCount: 0,
        checkpointDataRiskDetails: [] as Array<{
            messageIndex: number;
            tagKey: string;
            targetKey: string;
            reason?: string;
            createdAt?: number;
        }>,
    };
    for (const idx of targetMessageIndices) {
        if (idx < 0 || idx >= chat.length) continue;
        const msg = chat[idx];
        if (!msg || msg.is_user) continue;
        const report = scanTargetKeysResidue_ACU(msg, isolationKey, targetSheetKeys, idx);
        residueSummary.exactHits += report.exactHits;
        residueSummary.runtimeV1Hits += report.runtimeV1Hits;
        residueSummary.substringOnlyPathCount += report.substringOnlyPaths.length;
        if (report.checkpointDataRisk) residueSummary.checkpointDataRiskCount++;
        if (report.scheduleSummaryRisk) residueSummary.scheduleSummaryRiskCount++;
        residueSummary.checkpointDataRiskDetailCount += report.checkpointDataRisks.length;
        const remainingDetailSlots = MAX_CHECKPOINT_RISK_DETAILS_ACU - residueSummary.checkpointDataRiskDetails.length;
        if (remainingDetailSlots > 0) {
            residueSummary.checkpointDataRiskDetails.push(...report.checkpointDataRisks.slice(0, remainingDetailSlots));
        }
    }
    const hasResidue = residueSummary.exactHits > 0
        || residueSummary.runtimeV1Hits > 0
        || residueSummary.substringOnlyPathCount > 0
        || residueSummary.checkpointDataRiskCount > 0
        || residueSummary.scheduleSummaryRiskCount > 0;
    if (hasResidue) {
        logDebug_ACU('[手动重填诊断] 选中表清理后残留摘要', {
            clearedCount,
            targetKeys: targetSheetKeys,
            fields: ['event', 'operations', 'patches', 'writeSet', 'revision', 'progress'],
            residue: residueSummary,
        });
    }
    if (clearedCount > 0) {
        await saveChatToHost_ACU();
        logDebug_ACU(`[手动重填预清理] 共清理 ${clearedCount} 条消息的选中表增量数据，聊天已保存。`);
    }

    return clearedCount;
}

export async function clearManualRefillIncrementalDataInRange_ACU(targetMessageIndices: number[], targetSheetKeys: string[] | null = null): Promise<number> {
    if (!Array.isArray(targetSheetKeys) || targetSheetKeys.length === 0) {
        throw new Error('手动重填增量清理必须指定目标表。');
    }
    const writeSet = targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'clearIncrementalOnly',
        isolationKey: getCurrentIsolationKey_ACU(),
        writeSet,
        maintenanceMode: 'exclusive',
    }, () => clearManualRefillIncrementalDataInRangeCore_ACU(targetMessageIndices, targetSheetKeys));
}

function cloneManualRefillJson_ACU<T>(value: T): T {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

function getV2FrameForIsolation_ACU(msg: any, isolationKey: string): TableStorageFrameV2_ACU | null {
    const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
    return isV2TagData_ACU(tagData) ? tagData.storageFrame : null;
}

function findManualRefillSheetBaselineTargetIndex_ACU(chat: any[], isolationKey: string, targetMessageIndices: number[], requestedTargetMessageIndex?: number): number {
    if (Number.isInteger(requestedTargetMessageIndex)) {
        const idx = requestedTargetMessageIndex as number;
        const frame = getV2FrameForIsolation_ACU(chat[idx], isolationKey);
        return frame?.checkpoint?.kind === 'full' ? idx : -1;
    }

    const sorted = [...new Set(targetMessageIndices.filter(Number.isInteger))].sort((a, b) => a - b);
    for (const idx of sorted) {
        const frame = getV2FrameForIsolation_ACU(chat[idx], isolationKey);
        if (frame?.checkpoint?.kind === 'full') return idx;
    }
    return -1;
}

function messageFieldSnapshot_ACU(msg: any): {
    hadIsolatedData: boolean;
    isolatedData: any;
    hadIdentity: boolean;
    identity: any;
} {
    return {
        hadIsolatedData: Object.prototype.hasOwnProperty.call(msg, 'TavernDB_ACU_IsolatedData'),
        isolatedData: cloneManualRefillJson_ACU(msg?.TavernDB_ACU_IsolatedData),
        hadIdentity: Object.prototype.hasOwnProperty.call(msg, 'TavernDB_ACU_Identity'),
        identity: cloneManualRefillJson_ACU(msg?.TavernDB_ACU_Identity),
    };
}

function restoreMessageFieldSnapshot_ACU(msg: any, snapshot: ReturnType<typeof messageFieldSnapshot_ACU>): void {
    if (!msg) return;
    if (snapshot.hadIsolatedData) {
        msg.TavernDB_ACU_IsolatedData = snapshot.isolatedData;
    } else {
        delete msg.TavernDB_ACU_IsolatedData;
    }
    if (snapshot.hadIdentity) {
        msg.TavernDB_ACU_Identity = snapshot.identity;
    } else {
        delete msg.TavernDB_ACU_Identity;
    }
}

/**
 * 在手动重填全部成功后，用完整目标表快照替换范围内的旧数据。
 *
 * 这里刻意不复用 replaceManualRefillSheetBaselineInRangeAtomic_ACU：后者是
 * 启动期的“清理后立刻写基底”操作，若在本轮日志已经落盘后调用，会把本轮
 * 增量一并删除。最终快照必须附着于范围内既有整库 full checkpoint；回放时该
 * 单表快照覆盖同一锚点中的目标表，非目标表和 mate 继续由原 full checkpoint 提供。
 */
export async function commitManualRefillSheetSnapshotInRangeAtomic_ACU(
    options: ManualRefillSheetSnapshotCommitOptions_ACU,
): Promise<ManualRefillSheetBaselineReplaceResult_ACU> {
    if (!Array.isArray(options.targetSheetKeys) || options.targetSheetKeys.length === 0) {
        return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '手动重填最终快照提交必须指定目标表。' };
    }
    if (!Array.isArray(options.targetMessageIndices) || options.targetMessageIndices.length === 0) {
        return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '手动重填最终快照提交必须指定目标消息范围。' };
    }
    const invalidSnapshotSheet = options.targetSheetKeys.find(sheetKey => {
        const sheet = options.snapshotData?.[sheetKey];
        return !sheet || typeof sheet !== 'object' || !Array.isArray(sheet.content);
    });
    if (invalidSnapshotSheet) {
        return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: `手动重填最终快照提交失败：目标表 ${invalidSnapshotSheet} 不是可恢复的完整 Sheet。` };
    }

    const writeSet = options.targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'commitManualRefillSheetSnapshotInRange',
        isolationKey: options.isolationKey,
        writeSet,
        maintenanceMode: 'exclusive',
    }, async () => {
        const chat = getChatArray_ACU();
        if (!Array.isArray(chat) || chat.length === 0) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '聊天记录为空，无法提交手动重填最终快照。' };
        }

        const normalizedIndices = [...new Set(options.targetMessageIndices.filter((idx): idx is number => Number.isInteger(idx) && idx >= 0 && idx < chat.length))].sort((a, b) => a - b);
        const targetMessageIndex = findManualRefillSheetBaselineTargetIndex_ACU(chat, options.isolationKey, normalizedIndices);
        if (targetMessageIndex < 0) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex, error: '手动重填最终快照提交失败：范围内找不到可回放的整库 full checkpoint。' };
        }
        const completedMessageIndex = [...normalizedIndices].reverse().find(idx => !chat[idx]?.is_user);
        if (completedMessageIndex === undefined) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex, error: '手动重填最终快照提交失败：目标消息范围不含 AI 回复楼层。' };
        }
        const completedAiFloor = chat.slice(0, completedMessageIndex + 1).filter(msg => msg && !msg.is_user).length;

        const snapshotIndices = [...new Set([...normalizedIndices, targetMessageIndex])];
        const snapshots = new Map<number, ReturnType<typeof messageFieldSnapshot_ACU>>();
        snapshotIndices.forEach(idx => snapshots.set(idx, messageFieldSnapshot_ACU(chat[idx])));

        try {
            const clearsSummaryOrOutline = tableListContainsSummaryOrOutline_ACU(options.targetSheetKeys);
            const vectorManifestsToDeleteAfterCommit: any[] = [];
            let clearedCount = 0;
            for (const idx of normalizedIndices) {
                const msg = chat[idx];
                if (!msg || msg.is_user) continue;
                if (purgeSheetKeysFromMessageForIsolation_ACU(msg, options.isolationKey, options.targetSheetKeys)) clearedCount += 1;
                if (clearsSummaryOrOutline) {
                    const tagData = msg?.TavernDB_ACU_IsolatedData?.[options.isolationKey];
                    await deleteVectorIndexManifestFromTagData_ACU(tagData, { deleteExternal: false, onManifest: manifest => vectorManifestsToDeleteAfterCommit.push(manifest) });
                }
            }

            const targetMsg = chat[targetMessageIndex];
            if (!targetMsg.TavernDB_ACU_IsolatedData || typeof targetMsg.TavernDB_ACU_IsolatedData !== 'object' || Array.isArray(targetMsg.TavernDB_ACU_IsolatedData)) {
                targetMsg.TavernDB_ACU_IsolatedData = {};
            }
            const existingTagData = targetMsg.TavernDB_ACU_IsolatedData[options.isolationKey];
            const existingFrame = isV2TagData_ACU(existingTagData) ? existingTagData.storageFrame : null;
            if (!existingFrame) {
                throw new Error('手动重填最终快照提交失败：目标 full checkpoint 楼层缺少 V2 存储帧。');
            }

            const createdAt = Date.now();
            const perSheetCheckpoints = { ...(existingFrame.perSheetCheckpoints || {}) };
            for (const sheetKey of options.targetSheetKeys) {
                perSheetCheckpoints[sheetKey] = {
                    kind: 'sheet_full',
                    createdAt,
                    reason: 'manual',
                    sheetKey,
                    data: cloneManualRefillJson_ACU(options.snapshotData[sheetKey]) as Sheet_ACU,
                    scheduleSummary: { lastFilledAiFloor: completedAiFloor },
                };
            }
            existingFrame.perSheetCheckpoints = perSheetCheckpoints;
            writeMessageIdentity_ACU(targetMsg, { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode });

            await saveChatToHostStrict_ACU();
            const cleanupWarnings = await cleanupVectorIndexManifestsAfterCommit_ACU(vectorManifestsToDeleteAfterCommit);
            logDebug_ACU(`[手动重填最终快照] 已在 AI 楼层 #${targetMessageIndex} 为 ${options.targetSheetKeys.join(', ')} 写入完整单表 checkpoint，并替换范围内旧增量。`);
            return { success: true, changed: clearedCount > 0 || options.targetSheetKeys.length > 0, clearedCount, checkpointCount: options.targetSheetKeys.length, targetMessageIndex, ...(cleanupWarnings.length ? { cleanupWarnings } : {}) };
        } catch (error: any) {
            snapshots.forEach((snapshot, idx) => restoreMessageFieldSnapshot_ACU(chat[idx], snapshot));
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex, error: error?.message || String(error || '手动重填最终快照提交失败。') };
        }
    });
}

export function captureManualRefillSessionSnapshot_ACU(targetMessageIndices: number[]): ManualRefillSessionSnapshot_ACU {
    const chat = getChatArray_ACU();
    const normalizedIndices = [...new Set(targetMessageIndices.filter((idx): idx is number => Number.isInteger(idx) && idx >= 0 && idx < chat.length))].sort((a, b) => a - b);
    return {
        targetMessageIndices: normalizedIndices,
        messageFields: normalizedIndices.map(index => ({ index, ...messageFieldSnapshot_ACU(chat[index]) })),
    };
}

export async function restoreManualRefillSessionSnapshotAtomic_ACU(
    snapshot: ManualRefillSessionSnapshot_ACU,
    isolationKey: string,
    targetSheetKeys: string[],
): Promise<void> {
    const writeSet = targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
    await runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'restoreManualRefillSessionSnapshot',
        isolationKey,
        writeSet,
        maintenanceMode: 'exclusive',
    }, async () => {
        const chat = getChatArray_ACU();
        for (const messageField of snapshot.messageFields) {
            if (!chat[messageField.index]) {
                throw new Error(`手动重填回滚失败：消息索引 ${messageField.index} 已不存在。`);
            }
            restoreMessageFieldSnapshot_ACU(chat[messageField.index], messageField);
        }
        await saveChatToHostStrict_ACU();
    });
}

export async function replaceManualRefillSheetBaselineInRangeAtomic_ACU(
    options: ManualRefillSheetBaselineReplaceOptions_ACU,
): Promise<ManualRefillSheetBaselineReplaceResult_ACU> {
    if (!Array.isArray(options.targetSheetKeys) || options.targetSheetKeys.length === 0) {
        return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '手动重填基底替换必须指定目标表。' };
    }
    if (!Array.isArray(options.targetMessageIndices) || options.targetMessageIndices.length === 0) {
        return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '手动重填基底替换必须指定目标消息范围。' };
    }
    const missingBaselineSheet = options.targetSheetKeys.find(sheetKey => !options.baselineData || !options.baselineData[sheetKey] || typeof options.baselineData[sheetKey] !== 'object');
    if (missingBaselineSheet) {
        return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: `手动重填基底替换失败：缺少目标表 ${missingBaselineSheet} 的重建基底。` };
    }

    const writeSet = options.targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'replaceManualRefillSheetBaselineInRange',
        isolationKey: options.isolationKey,
        writeSet,
        maintenanceMode: 'exclusive',
    }, async () => {
        const chat = getChatArray_ACU();
        if (!Array.isArray(chat) || chat.length === 0) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '聊天记录为空，无法替换手动重填基底。' };
        }

        const normalizedIndices = [...new Set(options.targetMessageIndices.filter((idx): idx is number => Number.isInteger(idx) && idx >= 0 && idx < chat.length))].sort((a, b) => a - b);
        const targetMessageIndex = findManualRefillSheetBaselineTargetIndex_ACU(chat, options.isolationKey, normalizedIndices, options.targetMessageIndex);
        if (targetMessageIndex < 0) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '手动重填基底替换失败：本次范围内找不到可承载单表 checkpoint 的整库 full checkpoint。' };
        }

        const targetMsg = chat[targetMessageIndex];
        if (!targetMsg || targetMsg.is_user) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex, error: `手动重填基底替换失败：targetMessageIndex=${targetMessageIndex} 不是有效 AI 楼层。` };
        }

        const snapshotIndices = [...new Set([...normalizedIndices, targetMessageIndex])];
        const snapshots = new Map<number, ReturnType<typeof messageFieldSnapshot_ACU>>();
        snapshotIndices.forEach(idx => snapshots.set(idx, messageFieldSnapshot_ACU(chat[idx])));

        try {
            const clearsSummaryOrOutline = tableListContainsSummaryOrOutline_ACU(options.targetSheetKeys);
            const vectorManifestsToDeleteAfterCommit: any[] = [];
            let clearedCount = 0;
            for (const idx of normalizedIndices) {
                const msg = chat[idx];
                if (!msg || msg.is_user) continue;
                const removedBaseline = purgeSheetKeysFromMessageForIsolation_ACU(msg, options.isolationKey, options.targetSheetKeys);
                const removedIncremental = purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, options.isolationKey, options.targetSheetKeys);
                if (clearsSummaryOrOutline) {
                    const tagData = msg?.TavernDB_ACU_IsolatedData?.[options.isolationKey];
                    await deleteVectorIndexManifestFromTagData_ACU(tagData, { deleteExternal: false, onManifest: manifest => vectorManifestsToDeleteAfterCommit.push(manifest) });
                }
                if (removedBaseline || removedIncremental) clearedCount += 1;
            }

            if (!targetMsg.TavernDB_ACU_IsolatedData || typeof targetMsg.TavernDB_ACU_IsolatedData !== 'object' || Array.isArray(targetMsg.TavernDB_ACU_IsolatedData)) {
                targetMsg.TavernDB_ACU_IsolatedData = {};
            }
            const existingTagData = targetMsg.TavernDB_ACU_IsolatedData[options.isolationKey];
            const existingFrame = isV2TagData_ACU(existingTagData) ? existingTagData.storageFrame : null;
            if (!existingFrame?.checkpoint || existingFrame.checkpoint.kind !== 'full') {
                throw new Error('手动重填基底替换失败：清理后目标楼层不再包含整库 full checkpoint。');
            }

            const createdAt = Date.now();
            const collectedScheduleSummary = collectScheduleSummaryFromFramesV2_ACU(chat, options.isolationKey, { maxMessageIndex: targetMessageIndex });
            const scheduleSummary = collectedScheduleSummary && typeof collectedScheduleSummary === 'object' && !Array.isArray(collectedScheduleSummary) ? collectedScheduleSummary : {};
            const perSheetCheckpoints = { ...(existingFrame.perSheetCheckpoints || {}) };
            for (const sheetKey of options.targetSheetKeys) {
                const sheetData = cloneManualRefillJson_ACU(options.baselineData[sheetKey]) as Sheet_ACU;
                perSheetCheckpoints[sheetKey] = {
                    kind: 'sheet_full',
                    createdAt,
                    reason: 'manual',
                    sheetKey,
                    data: sheetData,
                    ...(scheduleSummary[sheetKey] ? { scheduleSummary: cloneManualRefillJson_ACU(scheduleSummary[sheetKey]) } : {}),
                };
            }
            existingFrame.perSheetCheckpoints = perSheetCheckpoints;
            writeMessageIdentity_ACU(targetMsg, { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode });

            await saveChatToHostStrict_ACU();
            const cleanupWarnings = await cleanupVectorIndexManifestsAfterCommit_ACU(vectorManifestsToDeleteAfterCommit);
            logDebug_ACU(`[手动重填基底替换] 已在 AI 楼层 #${targetMessageIndex} 为 ${options.targetSheetKeys.join(', ')} 写入单表 checkpoint，并原子清理范围旧数据。`);
            return { success: true, changed: clearedCount > 0 || options.targetSheetKeys.length > 0, clearedCount, checkpointCount: options.targetSheetKeys.length, targetMessageIndex, ...(cleanupWarnings.length ? { cleanupWarnings } : {}) };
        } catch (error: any) {
            snapshots.forEach((snapshot, idx) => restoreMessageFieldSnapshot_ACU(chat[idx], snapshot));
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex, error: error?.message || String(error || '手动重填基底替换失败。') };
        }
    });
}

async function clearManualRefillSheetDataInRangeCore_ACU(targetMessageIndices: number[], targetSheetKeys: string[] | null = null): Promise<number> {
    if (!targetMessageIndices || targetMessageIndices.length === 0) return 0;
    if (!Array.isArray(targetSheetKeys) || targetSheetKeys.length === 0) {
        throw new Error('手动重填范围清理必须指定目标表。');
    }

    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) return 0;

    const isolationKey = getCurrentIsolationKey_ACU();
    const clearsSummaryOrOutline = tableListContainsSummaryOrOutline_ACU(targetSheetKeys);
    let clearedCount = 0;

    for (const idx of targetMessageIndices) {
        if (idx < 0 || idx >= chat.length) continue;
        const msg = chat[idx];
        if (!msg || msg.is_user) continue;

        const changed = purgeSheetKeysFromMessageForIsolation_ACU(msg, isolationKey, targetSheetKeys);
        if (clearsSummaryOrOutline) {
            const isolatedData = msg?.TavernDB_ACU_IsolatedData;
            const tagData = isolatedData && typeof isolatedData === 'object' && !Array.isArray(isolatedData)
                ? isolatedData[isolationKey]
                : null;
            if (await deleteVectorIndexManifestFromTagData_ACU(tagData)) {
                logDebug_ACU(`[手动重填预清理] 已删除消息索引 ${idx} 上的交火向量索引外置文件引用。`);
            }
        }
        if (changed) {
            clearedCount++;
            logDebug_ACU(`[手动重填预清理] 已清理消息索引 ${idx} 上选中表的范围内旧数据 (标签: ${isolationKey || '无'})`);
        }
    }

    if (clearedCount > 0) {
        await saveChatToHost_ACU();
        logDebug_ACU(`[手动重填预清理] 共清理 ${clearedCount} 条消息的选中表范围内旧数据，聊天已保存。`);
    }

    return clearedCount;
}

export async function clearManualRefillSheetDataInRange_ACU(targetMessageIndices: number[], targetSheetKeys: string[] | null = null): Promise<number> {
    if (!Array.isArray(targetSheetKeys) || targetSheetKeys.length === 0) {
        throw new Error('手动重填范围清理必须指定目标表。');
    }
    const writeSet = targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'clearManualRefillSheetDataInRange',
        isolationKey: getCurrentIsolationKey_ACU(),
        writeSet,
        maintenanceMode: 'exclusive',
    }, () => clearManualRefillSheetDataInRangeCore_ACU(targetMessageIndices, targetSheetKeys));
}

function purgeTargetSheetKeysFromMessage_ACU(msg: any, targetSheetKeys: string[]): boolean {
    return purgeSheetKeysFromMessage_ACU(msg, targetSheetKeys);
}
