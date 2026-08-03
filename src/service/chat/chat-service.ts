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
import { settings_ACU, currentChatFileIdentifier_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU } from '../runtime/state-manager';
import { sanitizeSheetForStorage_ACU } from '../template/chat-scope';
import { clearTableFieldsForIsolation_ACU, collectSqlTargetTableNamesFromStorageFrameV2_ACU, purgeManualRefillIncrementalSheetKeysFromMessage_ACU, purgeSheetKeysFromMessage_ACU, purgeSheetKeysFromMessageForIsolation_ACU, readIsolatedDataContainer_ACU, readIsolatedTagData_ACU, writeMessageIdentity_ACU } from '../../data/repositories/chat-message-data-repo';
import { MAX_CHECKPOINT_RISK_DETAILS_ACU, scanTargetKeysResidue_ACU } from '../../data/repositories/target-keys-diagnostics';
import { LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU } from '../../data/storage/chat-history';
import { normalizeSummaryVectorIsolationKey_ACU } from '../../shared/summary-vector-index-scope';
import { runTableUpdateCommit_ACU } from '../table/table-update-commit';
import { getLatestAiMessageIndexFromChat_ACU, resolveTableHistoryStateFromChat_ACU } from '../table/table-history';
import { cleanupUnreachableSummaryVectorIndexFiles_ACU, deleteSummaryVectorIndexExternal_ACU } from '../vector/summary-vector-index-storage-service';
import { assignSummaryVectorIndexStateToTagData_ACU, readSummaryVectorIndexStateFromTagData_ACU } from '../vector/summary-vector-index-state-service';
import type { ChatSummaryVectorIndexManifest_ACU, ChatSummaryVectorIndexState_ACU, SummaryVectorIndexSafeGcScopeHint_ACU } from '../vector/summary-vector-index-types';
import { isV2TagData_ACU, resolveTableStorageStrategy_ACU } from '../table/storage-strategy-resolver';
import { collectScheduleSummaryFromFramesV2_ACU, loadTableStateFromFramesV2Detailed_ACU } from '../table/storage-frame-v2-replay';
import { runTableWriteTransaction_ACU } from '../table/table-write-transaction';
import type { TableMutationLogEntryV2_ACU, TableMutationOperationV2_ACU, TableStorageFrameV2_ACU } from '../table/storage-frame-v2-types';
import type { Sheet_ACU, TableDataObject_ACU } from '../../shared/models/table-data';
import { validateCanonicalCheckpoint_ACU } from '../../shared/canonical-checkpoint-validator';
import { buildCanonicalFullCheckpoint_ACU, buildCanonicalSheetCheckpoint_ACU } from '../table/canonical-checkpoint-builder';
import { getTableDataFingerprint_ACU } from '../table/table-data-upgrade-audit';

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
    failedIsolationKey?: string;
    skipped?: boolean;
    error?: string;
    anchorIndex?: number;
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
    /** 仅供已有正式根的调用方显式指定；缺根 fallback 不依赖它。 */
    targetMessageIndex?: number;
    /** 当前聊天作用域已冻结的完整模板；只在全局缺少 full checkpoint 时使用。 */
    templateData?: Record<string, any>;
}

export interface ManualRefillSessionSnapshot_ACU {
    targetMessageIndices: number[];
    messageFields: Array<{
        index: number;
        hadIsolatedData: boolean;
        originalIsolatedData: any;
        isolatedData: any;
        hadIdentity: boolean;
        originalIdentity: any;
        identity: any;
        originals: WeakMap<object, any>;
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

function collectVectorIndexGcScopesFromMessage_ACU(
    msg: any,
    scopeHints: Map<string, SummaryVectorIndexSafeGcScopeHint_ACU>,
): number {
    if (!msg || typeof msg !== 'object') return 0;
    const isolatedData = readIsolatedDataContainer_ACU(msg);
    if (!isolatedData) return 0;

    let manifestCount = 0;
    for (const [tagSlotIsolationKey, tagData] of Object.entries(isolatedData)) {
        const state = readSummaryVectorIndexStateFromTagData_ACU(tagData);
        const manifest = state?.manifest || null;
        if (!manifest) continue;
        const isolationKey = normalizeSummaryVectorIsolationKey_ACU(manifest.isolationKey || tagSlotIsolationKey);
        const sourceTableKey = String(manifest.sourceTableKey || state?.sourceTableKey || '').trim();
        if (!sourceTableKey) {
            logWarn_ACU(`[数据清理] 交火向量 manifest 缺少 sourceTableKey，已跳过自动物理清理：indexId=${manifest.indexId || ''}`);
            continue;
        }
        const hint = {
            chatKey: String(manifest.chatKey || currentChatFileIdentifier_ACU || '').trim(),
            isolationKey,
            sourceTableKey,
        };
        scopeHints.set(`${hint.chatKey}\n${hint.isolationKey}\n${hint.sourceTableKey}`, hint);
        manifestCount += 1;
    }
    return manifestCount;
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
            const isTemplateFallbackRoot = checkpoint?.fallbackProvenance?.kind === 'manual_refill_template_root';
            // compaction 已在新边界固化真实 replay 结果。模板临时根也必须随之降级，
            // 否则同一 isolationKey 会遗留两个 full checkpoint，后续手动重填会 fail closed。
            if (checkpoint?.kind !== 'full' || (checkpoint.reason !== 'init' && !isTemplateFallbackRoot)) {
                continue;
            }
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
        const snapshots = new Map<number, ReturnType<typeof messageFieldSnapshot_ACU>>();
        chat.forEach((message, messageIndex) => {
            const isolatedData = message?.TavernDB_ACU_IsolatedData;
            const hasV2Frame = isolatedData
                && typeof isolatedData === 'object'
                && !Array.isArray(isolatedData)
                && Object.values(isolatedData).some(tagData => isV2TagData_ACU(tagData));
            if (messageIndex === anchorIndex || hasV2Frame) {
                snapshots.set(messageIndex, messageFieldSnapshot_ACU(message));
            }
        });
        try {
            const changed = await writeV2BoundaryCheckpointBeforePurge_ACU(chat, anchorIndex);
            const downgradedCount = downgradeCoveredV2FullCheckpointsAfterAnchor_ACU(chat, anchorIndex);
            const obsoleteInitDowngradedCount = downgradeObsoleteInitialV2FullCheckpointsBeforeCompaction_ACU(chat, anchorIndex);
            if ((changed || downgradedCount > 0 || obsoleteInitDowngradedCount > 0) && options.save !== false) {
                await saveChatToHostStrict_ACU();
            }
            return { success: true, changed: changed || downgradedCount > 0 || obsoleteInitDowngradedCount > 0, anchorIndex };
        } catch (error: any) {
            snapshots.forEach((snapshot, messageIndex) => restoreMessageFieldSnapshot_ACU(chat[messageIndex], snapshot));
            return {
                success: false,
                changed: false,
                error: error?.message || String(error || '边界 checkpoint 写入失败。'),
                ...(typeof error?.failedIsolationKey === 'string' ? { failedIsolationKey: error.failedIsolationKey } : {}),
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


interface BoundaryVectorPointerCandidate_ACU {
    messageIndex: number;
    state: ChatSummaryVectorIndexState_ACU;
    manifest: ChatSummaryVectorIndexManifest_ACU;
}

function getBoundaryVectorPointerRevision_ACU(manifest: ChatSummaryVectorIndexManifest_ACU): number {
    const storageRevision = Number(manifest.storageIdentity?.revision || 0);
    const snapshotRevision = Number(manifest.snapshot?.revision || 0);
    if (storageRevision > 0 && snapshotRevision > 0 && storageRevision !== snapshotRevision) {
        throw new Error(`边界向量指针身份不一致：indexId=${manifest.indexId}, storageRevision=${storageRevision}, snapshotRevision=${snapshotRevision}`);
    }
    return Math.max(storageRevision, snapshotRevision, 0);
}

function compareBoundaryVectorPointerCandidate_ACU(
    left: BoundaryVectorPointerCandidate_ACU,
    right: BoundaryVectorPointerCandidate_ACU,
): number {
    const revisionDiff = getBoundaryVectorPointerRevision_ACU(left.manifest) - getBoundaryVectorPointerRevision_ACU(right.manifest);
    if (revisionDiff !== 0) return revisionDiff;
    const leftTime = Date.parse(String(left.manifest.updatedAt || left.manifest.indexedAt || ''));
    const rightTime = Date.parse(String(right.manifest.updatedAt || right.manifest.indexedAt || ''));
    const timeDiff = (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
    if (timeDiff !== 0) return timeDiff;
    return left.messageIndex - right.messageIndex;
}

function relocateLatestSummaryVectorPointerToBoundary_ACU(
    chat: any[],
    boundaryAnchorIndex: number,
    isolationKey: string,
): boolean {
    const candidatesBySourceTable = new Map<string, BoundaryVectorPointerCandidate_ACU[]>();
    const canonicalIsolationKey = normalizeSummaryVectorIsolationKey_ACU(isolationKey);
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex += 1) {
        const message = chat[messageIndex];
        if (!message || message.is_user) continue;
        const tagData = readIsolatedTagData_ACU(message, isolationKey);
        const state = readSummaryVectorIndexStateFromTagData_ACU(tagData);
        const manifests = [state?.manifest, tagData?.summaryVectorIndexManifest]
            .filter((manifest): manifest is ChatSummaryVectorIndexManifest_ACU => !!manifest);
        const seenManifestIdentities = new Set<string>();
        for (const manifest of manifests) {
            const identityKey = JSON.stringify([
                manifest.indexId,
                manifest.manifestFile,
                manifest.storageIdentity?.writeGeneration,
                manifest.storageIdentity?.revision ?? manifest.snapshot?.revision,
            ]);
            if (seenManifestIdentities.has(identityKey)) continue;
            seenManifestIdentities.add(identityKey);
            if (!state) continue;
            if (manifest.status !== 'ready') {
                if (messageIndex < boundaryAnchorIndex) {
                    throw new Error(`边界向量指针不可迁移：indexId=${manifest.indexId}, status=${manifest.status}`);
                }
                continue;
            }
            if (normalizeSummaryVectorIsolationKey_ACU(manifest.isolationKey) !== canonicalIsolationKey) {
                throw new Error(`边界向量指针 scope 不匹配：tagSlot=${isolationKey || '(default)'}, manifestIsolation=${manifest.isolationKey || '(empty)'}, indexId=${manifest.indexId}`);
            }
            getBoundaryVectorPointerRevision_ACU(manifest);
            const sourceTableKey = String(manifest.sourceTableKey || state.sourceTableKey || '').trim();
            if (!sourceTableKey) throw new Error(`边界向量指针缺少 sourceTableKey：indexId=${manifest.indexId}`);
            const candidates = candidatesBySourceTable.get(sourceTableKey) || [];
            candidates.push({ messageIndex, state: { ...state, manifest }, manifest });
            candidatesBySourceTable.set(sourceTableKey, candidates);
        }
    }

    const relocations = Array.from(candidatesBySourceTable.values())
        .map((candidates) => {
            const highestRevision = Math.max(...candidates.map((candidate) => getBoundaryVectorPointerRevision_ACU(candidate.manifest)));
            const newestCandidates = candidates.filter((candidate) => getBoundaryVectorPointerRevision_ACU(candidate.manifest) === highestRevision);
            const v2IdentityKeys = new Set(newestCandidates
                .filter((candidate) => !!candidate.manifest.storageIdentity)
                .map((candidate) => JSON.stringify([
                    candidate.manifest.indexId,
                    candidate.manifest.manifestFile,
                    candidate.manifest.storageIdentity?.writeGeneration,
                ])));
            if (v2IdentityKeys.size > 1) {
                throw new Error(`边界向量指针存在同 scope 同 revision 的多个 immutable generation，拒绝猜测迁移：sourceTableKey=${newestCandidates[0].manifest.sourceTableKey}, revision=${highestRevision}`);
            }
            return newestCandidates.reduce((latest, candidate) => (
                compareBoundaryVectorPointerCandidate_ACU(candidate, latest) > 0 ? candidate : latest
            ));
        })
        .filter((candidate) => candidate.messageIndex < boundaryAnchorIndex);
    if (relocations.length === 0) return false;
    if (relocations.length > 1) {
        throw new Error(`边界向量指针存在多个待迁移 sourceTableKey，单一 tag slot 无法安全承载：isolationKey=${isolationKey || '(default)'}`);
    }

    const candidate = relocations[0];
    const anchorMessage = chat[boundaryAnchorIndex];
    const anchorContainer = readIsolatedDataContainer_ACU(anchorMessage);
    const anchorTagData = anchorContainer?.[isolationKey];
    if (!anchorTagData || typeof anchorTagData !== 'object') {
        throw new Error(`边界向量指针迁移失败：anchor 缺少 isolationKey=[${isolationKey || '无标签'}] 的 tag slot`);
    }
    const anchorState = readSummaryVectorIndexStateFromTagData_ACU(anchorTagData);
    if (anchorState?.manifest && anchorState.manifest.sourceTableKey !== candidate.manifest.sourceTableKey) {
        throw new Error(`边界向量指针迁移会覆盖其他 sourceTableKey：anchor=${anchorState.manifest.sourceTableKey}, candidate=${candidate.manifest.sourceTableKey}`);
    }
    assignSummaryVectorIndexStateToTagData_ACU(anchorTagData, candidate.state, candidate.manifest);
    logDebug_ACU(`[V2 Compaction] 已将交火向量 immutable pointer 迁移到边界楼层 #${boundaryAnchorIndex}：isolationKey=[${isolationKey || '无标签'}], indexId=${candidate.manifest.indexId}`);
    return true;
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

        const pointerRelocated = relocateLatestSummaryVectorPointerToBoundary_ACU(chat, boundaryAnchorIndex, isolationKey);
        if (pointerRelocated) changed = true;
        if (hasV2CompactionCheckpointAtIndex_ACU(chat, isolationKey, boundaryAnchorIndex)) {
            logDebug_ACU(`[V2 Compaction] AI 保留边界楼层 #${boundaryAnchorIndex} 已存在 isolationKey=[${isolationKey || '无标签'}] 的 compaction full checkpoint，跳过 frame 重建。`);
            continue;
        }

        let replay: Awaited<ReturnType<typeof loadTableStateFromFramesV2Detailed_ACU>>;
        try {
            replay = await loadTableStateFromFramesV2Detailed_ACU(chat, isolationKey, { maxMessageIndex: boundaryAnchorIndex });
        } catch (error: unknown) {
            const replayError = new Error(error instanceof Error ? error.message : String(error ?? '未知 replay 错误。')) as Error & { cause?: unknown; failedIsolationKey?: string };
            replayError.cause = error;
            replayError.failedIsolationKey = isolationKey;
            throw replayError;
        }
        if (!replay) {
            const error = new Error(`边界 checkpoint 写入失败：无法在 boundaryAnchorIndex=${boundaryAnchorIndex} 前恢复 isolationKey=[${isolationKey || '无标签'}] 的 V2 数据。`) as Error & { failedIsolationKey?: string };
            error.failedIsolationKey = isolationKey;
            throw error;
        }
        const data = replay.data;

        const anchorMsg = chat[boundaryAnchorIndex];
        if (!anchorMsg.TavernDB_ACU_IsolatedData || typeof anchorMsg.TavernDB_ACU_IsolatedData !== 'object' || Array.isArray(anchorMsg.TavernDB_ACU_IsolatedData)) {
            anchorMsg.TavernDB_ACU_IsolatedData = {};
        }

        const existingTagData = anchorMsg.TavernDB_ACU_IsolatedData[isolationKey];
        const checkpoint = {
            kind: 'full' as const,
            createdAt: Date.now(),
            reason: 'compaction' as const,
            data,
            scheduleSummary: collectScheduleSummaryFromFramesV2_ACU(chat, isolationKey, { maxMessageIndex: boundaryAnchorIndex }),
        };
        const validation = validateCanonicalCheckpoint_ACU(checkpoint, {
            messageIndex: boundaryAnchorIndex,
            isolationKey,
            reason: 'compaction',
        });
        if (!validation.valid) {
            const issueSummary = validation.issues
                .slice(0, MAX_CHECKPOINT_RISK_DETAILS_ACU)
                .map(issue => `${issue.sheetKey || 'root'}:${issue.rowIndex ?? '-'}:${issue.type}`)
                .join(', ');
            const error = new Error(`边界 checkpoint 写入失败：replay 结果未满足 canonical 契约（${issueSummary}）。`) as Error & { failedIsolationKey?: string };
            error.failedIsolationKey = isolationKey;
            throw error;
        }
        const frame: TableStorageFrameV2_ACU = {
            version: 2,
            checkpoint,
            logEntries: [],
        };

        if (replay.requiresCheckpointConvergence || replay.compatibilityRepairs?.length) {
            const candidateChat = structuredClone(chat);
            const candidateAnchor = candidateChat[boundaryAnchorIndex];
            const candidateExistingTagData = candidateAnchor?.TavernDB_ACU_IsolatedData?.[isolationKey];
            candidateAnchor.TavernDB_ACU_IsolatedData = {
                ...(candidateAnchor.TavernDB_ACU_IsolatedData || {}),
                [isolationKey]: {
                    ...(candidateExistingTagData || {}),
                    storageFrame: frame,
                    _acu_storage_version: 2,
                },
            };
            const strictReplay = await loadTableStateFromFramesV2Detailed_ACU(candidateChat, isolationKey, {
                maxMessageIndex: boundaryAnchorIndex,
                updateRuntimeState: false,
                compatibilityMode: 'disabled',
            });
            if (!strictReplay
                || strictReplay.requiresCheckpointConvergence
                || strictReplay.compatibilityRepairs?.length
                || getTableDataFingerprint_ACU(strictReplay.data) !== getTableDataFingerprint_ACU(data)) {
                const error = new Error(`边界 checkpoint 写入失败：兼容回放结果无法收敛为严格可回放 checkpoint（isolationKey=[${isolationKey || '无标签'}]）。`) as Error & { failedIsolationKey?: string };
                error.failedIsolationKey = isolationKey;
                throw error;
            }
        }

        anchorMsg.TavernDB_ACU_IsolatedData[isolationKey] = {
            ...(existingTagData || {}),
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
            const anchorSnapshot = messageFieldSnapshot_ACU(anchorMsg);

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

            // 兜底数据必须先严格持久化；失败时不能继续破坏性删除旧楼层。
            try {
                await saveChatToHostStrict_ACU();
                logDebug_ACU(`[数据清理] 已将 ${totalSheets} 张表（${orphanedData.size} 个隔离标签）的兜底数据写入楼层 #${anchorIndex}，聊天已严格保存。`);
            } catch (e) {
                restoreMessageFieldSnapshot_ACU(anchorMsg, anchorSnapshot);
                logError_ACU('[数据清理] 兜底数据严格保存失败，已回滚并中止清理:', e);
                return;
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

    const purgeSnapshots = new Map<number, ReturnType<typeof messageFieldSnapshot_ACU>>();
    const purgedFieldDescriptors = new Map<number, Map<string, PropertyDescriptor | undefined>>();
    const vectorGcScopes = new Map<string, SummaryVectorIndexSafeGcScopeHint_ACU>();
    let purgedVectorManifestCount = 0;
    for (const idx of indicesToPurge) {
        const msg = chat[idx];
        if (!msg) continue;
        purgeSnapshots.set(idx, messageFieldSnapshot_ACU(msg));
        purgedFieldDescriptors.set(idx, new Map(keysToDelete.map((key) => [
            key,
            Object.getOwnPropertyDescriptor(msg, key),
        ])));
        purgedVectorManifestCount += collectVectorIndexGcScopesFromMessage_ACU(msg, vectorGcScopes);

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
            await saveChatToHostStrict_ACU();
            logDebug_ACU(`[数据清理] 已严格保存 ${purgedCount} 层消息的本地数据清理，已移除 ${purgedVectorManifestCount} 组交火向量索引引用。`);
        } catch (e) {
            purgeSnapshots.forEach((snapshot, messageIndex) => {
                restoreMessageFieldSnapshot_ACU(chat[messageIndex], snapshot);
                purgedFieldDescriptors.get(messageIndex)?.forEach((descriptor, key) => {
                    if (descriptor) {
                        Object.defineProperty(chat[messageIndex], key, descriptor);
                    } else {
                        delete chat[messageIndex][key];
                    }
                });
            });
            logError_ACU('[数据清理] 清理后的严格保存失败，已回滚且不执行外置向量 GC:', e);
            return;
        }
        if (vectorGcScopes.size > 0) {
            try {
                const gcResult = await cleanupUnreachableSummaryVectorIndexFiles_ACU({
                    scopeHints: Array.from(vectorGcScopes.values()),
                });
                if (gcResult.failedDeletes.length > 0) {
                    logWarn_ACU(`[数据清理] 交火向量 GC 有 ${gcResult.failedDeletes.length} 个删除失败；聊天引用已提交，将在后续清理重试。`);
                }
                logDebug_ACU(`[数据清理] 交火向量 GC 完成：deleted=${gcResult.deletedPaths.length}, retained=${gcResult.retainedPaths.length}, manifests=${purgedVectorManifestCount}`);
            } catch (error) {
                // 聊天引用已经 durable，不能为 best-effort GC 回滚已提交的删除。
                logWarn_ACU('[数据清理] 交火向量 GC 执行异常；聊天引用已提交，将在后续清理重试:', error);
            }
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
 * 清理旧版“表头清单”（TavernDB_ACU_TableHeaderGuide）。
 *
 * 该字段固定挂在 chat[0]，按隔离键分组存储，与 AI 楼层无关，
 * 因此不会被“按楼层遍历 AI 消息”的删除逻辑覆盖到。
 *
 * mode='all' 整个字段删除；mode='current' 只删当前隔离键，
 * 所有隔离键都清空后再删整个字段。
 */
function clearLegacyTableHeaderGuide_ACU(chat: any[], mode: 'current' | 'all', isolationKey: string): boolean {
    const first = Array.isArray(chat) && chat.length > 0 ? chat[0] : null;
    if (!first) return false;
    const raw = first[LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU];
    if (raw === undefined || raw === null || raw === '') return false;

    if (mode === 'all') {
        delete first[LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU];
        logDebug_ACU('[数据删除] 已清理旧版表头清单（全部隔离标识）。');
        return true;
    }

    let legacyObj: any = null;
    if (typeof raw === 'string') {
        try { legacyObj = JSON.parse(raw); } catch { legacyObj = null; }
    } else {
        legacyObj = raw;
    }
    // 无法解析或不含 tags 分组时不做部分删除，避免误删其他隔离标识的数据。
    if (!legacyObj || typeof legacyObj !== 'object' || Array.isArray(legacyObj)) return false;
    const tags = legacyObj.tags;
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return false;
    if (!Object.prototype.hasOwnProperty.call(tags, isolationKey)) return false;

    delete tags[isolationKey];
    if (Object.keys(tags).length === 0) {
        delete first[LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU];
    } else {
        legacyObj.tags = tags;
        first[LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU] = typeof raw === 'string'
            ? JSON.stringify(legacyObj)
            : legacyObj;
    }
    logDebug_ACU(`[数据删除] 已清理旧版表头清单（隔离标识: ${isolationKey || '无标签'}）。`);
    return true;
}

type PreservedInitialCheckpointSlot_ACU = {
    messageIndex: number;
    isolationKey: string;
    tagData: Record<string, any>;
};

export type ManualCatchUpAnchorPreflightResult_ACU =
    | { status: 'ready'; checkpointMessageIndex: number | null }
    | { status: 'repaired'; checkpointMessageIndex: number }
    | { status: 'blocked'; error: string };

function isEmptyResetEvent_ACU(event: any): boolean {
    return !!event && Array.isArray(event.filledSheetKeys) && event.filledSheetKeys.length === 0
        && Array.isArray(event.changedSheetKeys) && event.changedSheetKeys.length === 0
        && Array.isArray(event.groupKeys) && event.groupKeys.length === 0;
}

function isSafeHeaderOnlyResetCheckpoint_ACU(frame: any): boolean {
    const checkpoint = frame?.checkpoint;
    if (checkpoint?.kind !== 'full' || checkpoint.reason !== 'init' || !checkpoint.data || typeof checkpoint.data !== 'object') return false;
    if (!isEmptyResetEvent_ACU(checkpoint.event)) return false;
    if (checkpoint.scheduleSummary !== undefined || checkpoint.manualRefillProgress !== undefined) return false;
    if ((frame.logEntries || []).length > 0 || frame.manualRefillProgress !== undefined || frame.headRevision !== undefined) return false;
    if (frame.perSheetCheckpoints !== undefined && Object.keys(frame.perSheetCheckpoints || {}).length > 0) return false;
    const sheetKeys = Object.keys(checkpoint.data).filter(key => key.startsWith('sheet_'));
    return sheetKeys.length > 0 && sheetKeys.every(sheetKey => Array.isArray(checkpoint.data[sheetKey]?.content) && checkpoint.data[sheetKey].content.length === 1);
}

/**
 * 兼容旧版“全范围删除后仍把 reset checkpoint 留在较晚楼层”的聊天。
 *
 * 只移动可证明是 header-only reset 的唯一 init checkpoint；任何真实数据、未知增量或
 * 多 checkpoint 都 fail-closed。调用方必须在发起 AI 请求前调用，避免付出请求成本后才
 * 因 checkpoint 位于追平范围之后而失败。
 */
export async function ensureManualCatchUpAnchorBeforeTarget_ACU(
    targetMessageIndex: number,
    isolationKey = getCurrentIsolationKey_ACU(),
): Promise<ManualCatchUpAnchorPreflightResult_ACU> {
    return runTableWriteTransaction_ACU({
        source: 'system_cleanup',
        reason: 'ensureManualCatchUpAnchorBeforeTarget',
        isolationKey,
        writeSet: [{ kind: 'all' }],
        maintenanceMode: 'exclusive',
    }, async () => {
        const chat = getChatArray_ACU();
        if (!Array.isArray(chat) || chat.length === 0) return { status: 'blocked', error: '聊天记录为空，无法验证手动追平锚点。' };
        const aiMessageIndices = chat.map((message, index) => !message?.is_user ? index : -1).filter(index => index >= 0);
        if (!Number.isInteger(targetMessageIndex) || targetMessageIndex < 0 || !chat[targetMessageIndex] || chat[targetMessageIndex].is_user) {
            return { status: 'blocked', error: '手动追平目标楼层无效，无法验证 V2 锚点。' };
        }
        const checkpoints = aiMessageIndices.filter(index => {
            const tagData = readIsolatedTagData_ACU(chat[index], isolationKey) as any;
            return isV2TagData_ACU(tagData) && tagData.storageFrame.checkpoint?.kind === 'full';
        });
        if (checkpoints.length === 0) return { status: 'ready', checkpointMessageIndex: null };
        const checkpointMessageIndex = checkpoints[checkpoints.length - 1];
        if (checkpointMessageIndex <= targetMessageIndex) return { status: 'ready', checkpointMessageIndex };
        if (checkpoints.length !== 1) {
            return { status: 'blocked', error: '手动追平目标早于多个 V2 full checkpoint；无法安全自动重排历史，请先执行 V2 恢复诊断。' };
        }

        const unsafeArtifactIndex = aiMessageIndices.find(index => {
            if (index === checkpointMessageIndex) return false;
            const tagData = readIsolatedTagData_ACU(chat[index], isolationKey) as any;
            if (!isV2TagData_ACU(tagData)) return false;
            const frame = tagData.storageFrame;
            return (frame.logEntries || []).length > 0
                || Object.keys(frame.perSheetCheckpoints || {}).length > 0
                || frame.manualRefillProgress !== undefined
                || (frame.headRevision !== undefined && frame.headRevision !== null);
        });
        if (unsafeArtifactIndex !== undefined) {
            return { status: 'blocked', error: `手动追平目标之前存在无法安全重排的 V2 增量 artifact（messageIndex=${unsafeArtifactIndex}）；请先执行 V2 恢复诊断。` };
        }

        const sourceMessage = chat[checkpointMessageIndex];
        const sourceTagData = readIsolatedTagData_ACU(sourceMessage, isolationKey) as any;
        if (!isV2TagData_ACU(sourceTagData) || !isSafeHeaderOnlyResetCheckpoint_ACU(sourceTagData.storageFrame)) {
            return { status: 'blocked', error: '手动追平目标早于包含真实数据或未知历史的 V2 checkpoint；已在调用 AI 前阻止写入，请先执行 V2 恢复诊断。' };
        }

        const anchorMessageIndex = aiMessageIndices[0];
        const anchorMessage = chat[anchorMessageIndex];
        const affectedMessages = [...new Set([anchorMessageIndex, checkpointMessageIndex])].map(index => ({
            message: chat[index],
            hadIsolatedData: Object.prototype.hasOwnProperty.call(chat[index], 'TavernDB_ACU_IsolatedData'),
            isolatedData: chat[index].TavernDB_ACU_IsolatedData,
            hadIdentity: Object.prototype.hasOwnProperty.call(chat[index], 'TavernDB_ACU_Identity'),
            identity: chat[index].TavernDB_ACU_Identity,
        }));
        try {
            const sourceContainer = readIsolatedDataContainer_ACU(sourceMessage) || {};
            delete sourceContainer[isolationKey];
            if (Object.keys(sourceContainer).length === 0) delete sourceMessage.TavernDB_ACU_IsolatedData;
            else sourceMessage.TavernDB_ACU_IsolatedData = sourceContainer;

            const anchorContainer = readIsolatedDataContainer_ACU(anchorMessage) || {};
            anchorContainer[isolationKey] = JSON.parse(JSON.stringify(sourceTagData));
            anchorMessage.TavernDB_ACU_IsolatedData = anchorContainer;
            writeMessageIdentity_ACU(anchorMessage, { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode });
            await saveChatToHostStrict_ACU();
        } catch (error: any) {
            for (const state of affectedMessages) {
                if (state.hadIsolatedData) state.message.TavernDB_ACU_IsolatedData = state.isolatedData;
                else delete state.message.TavernDB_ACU_IsolatedData;
                if (state.hadIdentity) state.message.TavernDB_ACU_Identity = state.identity;
                else delete state.message.TavernDB_ACU_Identity;
            }
            return { status: 'blocked', error: `手动追平 reset checkpoint 前移保存失败：${error?.message || String(error)}` };
        }
        logDebug_ACU(`[手动追平] 已将 header-only reset checkpoint 从 #${checkpointMessageIndex} 前移到 #${anchorMessageIndex}。`);
        return { status: 'repaired', checkpointMessageIndex: anchorMessageIndex };
    });
}

/**
 * 全范围清空时保留每个隔离域最早的 init checkpoint 结构锚点。
 *
 * 行数据、增量、调度状态和后续 frame 仍会被删除；这里只留下 header-only full checkpoint，
 * 避免后续模板切换把老聊天误判为 pristine，并在最新楼层重新创建“初始基线”。
 */
function collectInitialCheckpointSlotsForFullDeletion_ACU(
    chat: any[],
    mode: 'current' | 'all',
    currentIsolationKey: string,
): PreservedInitialCheckpointSlot_ACU[] {
    const preservedByIsolationKey = new Map<string, PreservedInitialCheckpointSlot_ACU>();
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex += 1) {
        const message = chat[messageIndex];
        if (!message || message.is_user) continue;
        const isolatedData = readIsolatedDataContainer_ACU(message);
        if (!isolatedData) continue;

        for (const [isolationKey, tagData] of Object.entries(isolatedData)) {
            if (mode === 'current' && isolationKey !== currentIsolationKey) continue;
            if (preservedByIsolationKey.has(isolationKey) || !isV2TagData_ACU(tagData)) continue;
            const checkpoint = tagData.storageFrame.checkpoint;
            if (checkpoint?.kind !== 'full' || checkpoint.reason !== 'init' || !checkpoint.data || typeof checkpoint.data !== 'object') continue;

            const checkpointData = JSON.parse(JSON.stringify(checkpoint.data));
            const sheetKeys = Object.keys(checkpointData).filter(key => key.startsWith('sheet_'));
            if (sheetKeys.length === 0) continue;
            for (const sheetKey of sheetKeys) {
                const sanitizedSheet = sanitizeSheetForStorage_ACU(checkpointData[sheetKey]);
                if (!sanitizedSheet || typeof sanitizedSheet !== 'object' || !Array.isArray(sanitizedSheet.content?.[0])) {
                    delete checkpointData[sheetKey];
                    continue;
                }
                sanitizedSheet.content = [JSON.parse(JSON.stringify(sanitizedSheet.content[0]))];
                // sanitizeSheetForStorage_ACU 已按持久化白名单剥离 seedRows 等运行时载荷。
                checkpointData[sheetKey] = sanitizedSheet;
            }
            if (!Object.keys(checkpointData).some(key => key.startsWith('sheet_'))) continue;

            const preservedCheckpoint = {
                kind: 'full' as const,
                createdAt: checkpoint.createdAt,
                reason: 'init' as const,
                data: checkpointData,
                event: { filledSheetKeys: [] as string[], changedSheetKeys: [] as string[], groupKeys: [] as string[] },
            };
            if (!validateCanonicalCheckpoint_ACU(preservedCheckpoint, {
                messageIndex,
                isolationKey,
                reason: 'deleteLocalDataInChat',
            }).valid) continue;

            preservedByIsolationKey.set(isolationKey, {
                messageIndex,
                isolationKey,
                tagData: {
                    _acu_storage_version: 2,
                    storageFrame: {
                        version: 2,
                        checkpoint: preservedCheckpoint,
                        logEntries: [],
                    },
                },
            });
        }
    }
    return [...preservedByIsolationKey.values()];
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
    const isFullRangeDeletion = (startFloor === null || startFloor <= 1)
        && (endFloor === null || endFloor >= aiMessageIndices.length);
    const preservedInitialCheckpoints = isFullRangeDeletion
        ? collectInitialCheckpointSlotsForFullDeletion_ACU(chat, mode, currentIsolationKey) : [];

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

    // “删除全部数据”清空行数据和增量历史，但保留 init 的 header-only 锚点。
    //
    // 锚点必须落在最早 AI 楼层，而不能留在它原先出现的较晚楼层：一键追平可以
    // 因 skipUpdateFloors 写入该旧锚点之前的消息；V2 replay 只从目标边界内最后一个
    // full checkpoint 开始，那些写入会变成不可回放的伪提交。
    const latestAiMessageIndex = aiMessageIndices[aiMessageIndices.length - 1];
    const resetAnchorMessageIndex = aiMessageIndices[0];
    for (const preserved of preservedInitialCheckpoints) {
        const anchorMessage = chat[resetAnchorMessageIndex];
        if (!anchorMessage || anchorMessage.is_user) continue;
        const anchorIsolatedData = readIsolatedDataContainer_ACU(anchorMessage) || {};
        anchorIsolatedData[preserved.isolationKey] = preserved.tagData as any;
        anchorMessage.TavernDB_ACU_IsolatedData = anchorIsolatedData;

        // 既有 checkpoint 分支要求当前最新 AI 楼层有合法 V2 frame，模板 rebase/introduction
        // 也必须落在该数据边界。清空后补一个无日志空 frame，不携带任何表数据。
        const boundaryMessage = chat[latestAiMessageIndex];
        if (boundaryMessage && !boundaryMessage.is_user && latestAiMessageIndex !== resetAnchorMessageIndex) {
            const boundaryIsolatedData = readIsolatedDataContainer_ACU(boundaryMessage) || {};
            boundaryIsolatedData[preserved.isolationKey] = {
                _acu_storage_version: 2,
                storageFrame: { version: 2, logEntries: [] },
            } as any;
            boundaryMessage.TavernDB_ACU_IsolatedData = boundaryIsolatedData;
        }
        if (mode === 'current') {
            writeMessageIdentity_ACU(anchorMessage, {
                enabled: settings_ACU.dataIsolationEnabled,
                code: settings_ACU.dataIsolationCode,
            });
            if (boundaryMessage && latestAiMessageIndex !== resetAnchorMessageIndex) {
                writeMessageIdentity_ACU(boundaryMessage, {
                    enabled: settings_ACU.dataIsolationEnabled,
                    code: settings_ACU.dataIsolationCode,
                });
            }
        }
    }

    // 旧版“表头清单”固定挂在 chat[0]，与楼层范围无关，因此只在删除覆盖完整范围时清理，
    // 避免局部删除误删仍被其他楼层依赖的兼容指导数据。
    if (isFullRangeDeletion && clearLegacyTableHeaderGuide_ACU(chat, mode, currentIsolationKey)) {
        deletedCount++;
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

function cloneMessageFieldValue_ACU<T>(value: T, seen = new WeakMap<object, any>(), originals = new WeakMap<object, any>()): T {
    if (value === null || typeof value !== 'object') return value;
    const existing = seen.get(value);
    if (existing) return existing;
    if (value instanceof Date) {
        const clone = new Date(value.getTime());
        seen.set(value, clone);
        originals.set(clone, value);
        return clone as T;
    }
    if (value instanceof RegExp) {
        const clone = new RegExp(value.source, value.flags);
        seen.set(value, clone);
        originals.set(clone, value);
        return clone as T;
    }

    if (value instanceof Map) {
        const clone = new Map();
        seen.set(value, clone);
        originals.set(clone, value);
        value.forEach((mapValue, mapKey) => clone.set(cloneMessageFieldValue_ACU(mapKey, seen, originals), cloneMessageFieldValue_ACU(mapValue, seen, originals)));
        return clone as T;
    }
    if (value instanceof Set) {
        const clone = new Set();
        seen.set(value, clone);
        originals.set(clone, value);
        value.forEach(setValue => clone.add(cloneMessageFieldValue_ACU(setValue, seen, originals)));
        return clone as T;
    }
    const clone: any = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(value, clone);
    originals.set(clone, value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        if ('value' in descriptor) descriptor.value = cloneMessageFieldValue_ACU(descriptor.value, seen, originals);
        Object.defineProperty(clone, key, descriptor);
    }
    return clone;
}

function getV2FrameForIsolation_ACU(msg: any, isolationKey: string): TableStorageFrameV2_ACU | null {
    const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
    return isV2TagData_ACU(tagData) ? tagData.storageFrame : null;
}

interface ManualRefillReplayAnchor_ACU {
    fullCheckpointIndices: number[];
    fallbackRootIndex: number;
}

function resolveManualRefillReplayAnchor_ACU(chat: any[], isolationKey: string, targetMessageIndices: number[]): ManualRefillReplayAnchor_ACU {
    const fullCheckpointIndices: number[] = [];
    let earliestV2FrameIndex = -1;
    for (let index = 0; index < chat.length; index += 1) {
        const message = chat[index];
        if (!message || message.is_user) continue;
        const frame = getV2FrameForIsolation_ACU(message, isolationKey);
        if (!frame) continue;
        if (earliestV2FrameIndex < 0) earliestV2FrameIndex = index;
        if (frame.checkpoint?.kind === 'full') fullCheckpointIndices.push(index);
    }

    const firstTargetAiIndex = [...new Set(targetMessageIndices)]
        .filter((index): index is number => Number.isInteger(index) && index >= 0 && index < chat.length && !chat[index]?.is_user)
        .sort((left, right) => left - right)[0] ?? -1;
    return { fullCheckpointIndices, fallbackRootIndex: earliestV2FrameIndex >= 0 ? earliestV2FrameIndex : firstTargetAiIndex };
}

function findManualRefillSheetBaselineTargetIndex_ACU(chat: any[], isolationKey: string, targetMessageIndices: number[], requestedTargetMessageIndex?: number): number {
    const anchor = resolveManualRefillReplayAnchor_ACU(chat, isolationKey, targetMessageIndices);
    if (anchor.fullCheckpointIndices.length !== 1) return -1;
    const targetMessageIndex = anchor.fullCheckpointIndices[0];
    if (requestedTargetMessageIndex !== undefined && requestedTargetMessageIndex !== targetMessageIndex) return -1;
    return targetMessageIndex;
}

function getMaxFrameSequence_ACU(frame: TableStorageFrameV2_ACU): number {
    if (!Array.isArray(frame.logEntries)) return 0;
    return frame.logEntries.reduce((max, entry: any) => Number.isInteger(entry?.seq) && entry.seq >= 0 ? Math.max(max, entry.seq) : max, 0);
}

function cloneCandidateChat_ACU(chat: any[]): any[] {
    return JSON.parse(JSON.stringify(chat));
}

function applyCandidateMessageFields_ACU(liveMessage: any, candidateMessage: any): void {
    if (Object.prototype.hasOwnProperty.call(candidateMessage, 'TavernDB_ACU_IsolatedData')) {
        liveMessage.TavernDB_ACU_IsolatedData = candidateMessage.TavernDB_ACU_IsolatedData;
    } else {
        delete liveMessage.TavernDB_ACU_IsolatedData;
    }
    if (Object.prototype.hasOwnProperty.call(candidateMessage, 'TavernDB_ACU_Identity')) {
        liveMessage.TavernDB_ACU_Identity = candidateMessage.TavernDB_ACU_Identity;
    } else {
        delete liveMessage.TavernDB_ACU_Identity;
    }
}

function messageFieldSnapshot_ACU(msg: any): {
    hadIsolatedData: boolean;
    originalIsolatedData: any;
    isolatedData: any;
    hadIdentity: boolean;
    originalIdentity: any;
    identity: any;
    originals: WeakMap<object, any>;
} {
    const originals = new WeakMap<object, any>();
    return {
        hadIsolatedData: Object.prototype.hasOwnProperty.call(msg, 'TavernDB_ACU_IsolatedData'),
        originalIsolatedData: msg?.TavernDB_ACU_IsolatedData,
        isolatedData: cloneMessageFieldValue_ACU(msg?.TavernDB_ACU_IsolatedData, new WeakMap<object, any>(), originals),
        hadIdentity: Object.prototype.hasOwnProperty.call(msg, 'TavernDB_ACU_Identity'),
        originalIdentity: msg?.TavernDB_ACU_Identity,
        identity: cloneMessageFieldValue_ACU(msg?.TavernDB_ACU_Identity, new WeakMap<object, any>(), originals),
        originals,
    };
}

function restoreMessageFieldValueInPlace_ACU(target: any, snapshot: any, originals: WeakMap<object, any>, seen = new WeakMap<object, any>()): any {
    if (target === null || snapshot === null || typeof target !== 'object' || typeof snapshot !== 'object') return snapshot;
    const restored = seen.get(snapshot);
    if (restored) return restored;
    const original = originals.get(snapshot);
    const restoreTarget = original && typeof original === 'object' ? original : target;
    seen.set(snapshot, restoreTarget);

    const snapshotKeys = Reflect.ownKeys(snapshot);
    const snapshotKeySet = new Set(snapshotKeys);
    for (const key of Reflect.ownKeys(restoreTarget)) {
        if (key !== 'length' && !snapshotKeySet.has(key)) delete restoreTarget[key];
    }

    const restoreKey = (key: PropertyKey): void => {
        const snapshotDescriptor = Object.getOwnPropertyDescriptor(snapshot, key);
        if (!snapshotDescriptor) return;
        const targetDescriptor = Object.getOwnPropertyDescriptor(restoreTarget, key);
        if (
            'value' in snapshotDescriptor
            && snapshotDescriptor.value !== null
            && typeof snapshotDescriptor.value === 'object'
        ) {
            const originalValue = originals.get(snapshotDescriptor.value);
            const currentValue = 'value' in (targetDescriptor || {}) ? targetDescriptor.value : undefined;
            if (originalValue && typeof originalValue === 'object') {
                snapshotDescriptor.value = restoreMessageFieldValueInPlace_ACU(originalValue, snapshotDescriptor.value, originals, seen);
            } else if (currentValue !== null && typeof currentValue === 'object') {
                snapshotDescriptor.value = restoreMessageFieldValueInPlace_ACU(currentValue, snapshotDescriptor.value, originals, seen);
            }
        }
        Object.defineProperty(restoreTarget, key, snapshotDescriptor);
    };

    snapshotKeys.filter(key => key !== 'length').forEach(restoreKey);
    if (Array.isArray(snapshot)) Object.defineProperty(restoreTarget, 'length', Object.getOwnPropertyDescriptor(snapshot, 'length')!);
    return restoreTarget;
}

function restoreMessageFieldSnapshot_ACU(msg: any, snapshot: ReturnType<typeof messageFieldSnapshot_ACU>): void {
    if (!msg) return;
    if (snapshot.hadIsolatedData) {
        msg.TavernDB_ACU_IsolatedData = snapshot.originalIsolatedData;
        restoreMessageFieldValueInPlace_ACU(snapshot.originalIsolatedData, snapshot.isolatedData, snapshot.originals);
    } else {
        delete msg.TavernDB_ACU_IsolatedData;
    }
    if (snapshot.hadIdentity) {
        msg.TavernDB_ACU_Identity = snapshot.originalIdentity;
        restoreMessageFieldValueInPlace_ACU(snapshot.originalIdentity, snapshot.identity, snapshot.originals);
    } else {
        delete msg.TavernDB_ACU_Identity;
    }
}

/**
 * 在手动重填全部成功后，用完整目标表快照替换范围内的旧数据。
 *
 * 该提交不裁剪历史操作；data_replace 与混合 SQL 均保持其整库语义，目标表以范围末端
 * sheet_rebase 覆盖。全局缺失 full checkpoint 时，在最早 V2 frame 补模板临时根。
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
        const completedMessageIndex = [...normalizedIndices].reverse().find(idx => !chat[idx]?.is_user);
        if (completedMessageIndex === undefined) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '手动重填最终快照提交失败：目标消息范围不含 AI 回复楼层。' };
        }
        const completedAiFloor = chat.slice(0, completedMessageIndex + 1).filter(msg => msg && !msg.is_user).length;
        const anchor = resolveManualRefillReplayAnchor_ACU(chat, options.isolationKey, normalizedIndices);
        if (anchor.fullCheckpointIndices.length > 1) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: `手动重填最终快照提交失败：isolationKey ${options.isolationKey} 存在多个整库 full checkpoint（${anchor.fullCheckpointIndices.join(', ')}），必须先完成完整性修复。` };
        }
        const fallbackRequired = anchor.fullCheckpointIndices.length === 0;
        const rootMessageIndex = fallbackRequired ? anchor.fallbackRootIndex : anchor.fullCheckpointIndices[0];
        if (rootMessageIndex < 0 || chat[rootMessageIndex]?.is_user) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: '手动重填最终快照提交失败：找不到可承载回放根的 AI 楼层。' };
        }
        if (options.targetMessageIndex !== undefined && options.targetMessageIndex !== rootMessageIndex) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex: rootMessageIndex, error: `手动重填最终快照提交失败：指定 anchor #${options.targetMessageIndex} 不等于唯一回放根 #${rootMessageIndex}。` };
        }
        if (fallbackRequired && (!options.templateData || typeof options.templateData !== 'object' || Array.isArray(options.templateData))) {
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex: rootMessageIndex, error: '手动重填最终快照提交失败：全局缺少整库 full checkpoint，且未提供有效的冻结模板。' };
        }
        const templateFingerprint = options.templateData && typeof options.templateData === 'object' && !Array.isArray(options.templateData)
            ? getTableDataFingerprint_ACU(options.templateData)
            : null;
        const fallbackRunId = templateFingerprint
            ? `manual-refill:${options.isolationKey}:${normalizedIndices.join(',')}:${templateFingerprint}`
            : null;
        if (fallbackRequired) {
            const missingTemplateSheet = options.targetSheetKeys.find(sheetKey => !options.templateData?.[sheetKey] || typeof options.templateData[sheetKey] !== 'object');
            if (!options.templateData?.mate || typeof options.templateData.mate !== 'object' || missingTemplateSheet) {
                return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex: rootMessageIndex, error: missingTemplateSheet
                    ? `手动重填最终快照提交失败：冻结模板缺少目标表 ${missingTemplateSheet}。`
                    : '手动重填最终快照提交失败：冻结模板缺少有效 mate 根元数据。' };
            }
        }

        // strict save 的结果不确定时，宿主可能已经落盘而调用方会重试。相同 runId 与
        // 相同末端快照必须成为幂等 no-op，不能仅因 createdAt 改变就再次改写根或 rebase。
        const existingRootFrame = getV2FrameForIsolation_ACU(chat[rootMessageIndex], options.isolationKey);
        const existingFinalFrame = getV2FrameForIsolation_ACU(chat[completedMessageIndex], options.isolationKey);
        const existingFallbackRunId = existingRootFrame?.checkpoint?.fallbackProvenance?.runId;
        const hasEquivalentTerminalRebases = options.targetSheetKeys.every(sheetKey => {
            const checkpoint = existingFinalFrame?.perSheetCheckpoints?.[sheetKey];
            return checkpoint?.kind === 'sheet_full'
                && checkpoint?.timeline?.kind === 'sheet_rebase'
                && checkpoint.timeline.activateAtMessageIndex === completedMessageIndex
                && checkpoint.timeline.afterSeq === getMaxFrameSequence_ACU(existingFinalFrame!)
                && getTableDataFingerprint_ACU(checkpoint.data) === getTableDataFingerprint_ACU(options.snapshotData[sheetKey]);
        });
        if (fallbackRunId && existingFallbackRunId === fallbackRunId && hasEquivalentTerminalRebases) {
            return {
                success: true,
                changed: false,
                clearedCount: 0,
                checkpointCount: options.targetSheetKeys.length,
                targetMessageIndex: rootMessageIndex,
            };
        }

        const snapshotIndices = [...new Set([rootMessageIndex, completedMessageIndex])];
        const snapshots = new Map<number, ReturnType<typeof messageFieldSnapshot_ACU>>();
        snapshotIndices.forEach(idx => snapshots.set(idx, messageFieldSnapshot_ACU(chat[idx])));

        try {
            const candidateChat = cloneCandidateChat_ACU(chat);
            const createdAt = Date.now();
            const rootMessage = candidateChat[rootMessageIndex];
            rootMessage.TavernDB_ACU_IsolatedData = rootMessage.TavernDB_ACU_IsolatedData && typeof rootMessage.TavernDB_ACU_IsolatedData === 'object' && !Array.isArray(rootMessage.TavernDB_ACU_IsolatedData)
                ? rootMessage.TavernDB_ACU_IsolatedData : {};
            const rootTagData = rootMessage.TavernDB_ACU_IsolatedData[options.isolationKey];
            const rootFrame: TableStorageFrameV2_ACU = isV2TagData_ACU(rootTagData)
                ? rootTagData.storageFrame
                : { version: 2, logEntries: [] };
            if (!isV2TagData_ACU(rootTagData)) {
                rootMessage.TavernDB_ACU_IsolatedData[options.isolationKey] = { ...(rootTagData && typeof rootTagData === 'object' ? rootTagData : {}), _acu_storage_version: 2, storageFrame: rootFrame };
            }
            if (fallbackRequired) {
                const checkpointBuild = buildCanonicalFullCheckpoint_ACU({
                    createdAt,
                    reason: 'manual',
                    data: options.templateData as TableDataObject_ACU,
                    fallbackProvenance: {
                        version: 1,
                        kind: 'manual_refill_template_root',
                        runId: fallbackRunId!,
                        isolationKey: options.isolationKey,
                        targetSheetKeys: [...new Set(options.targetSheetKeys)].sort(),
                        rangeStartMessageIndex: normalizedIndices[0],
                        rangeEndMessageIndex: normalizedIndices[normalizedIndices.length - 1],
                        templateFingerprint,
                        createdAt,
                    },
                    context: { messageIndex: rootMessageIndex, isolationKey: options.isolationKey, reason: 'manual' },
                });
                if (!checkpointBuild.checkpoint) throw new Error(`手动重填最终快照提交失败：${checkpointBuild.error}`);
                rootFrame.checkpoint = checkpointBuild.checkpoint;
            }

            const finalMessage = candidateChat[completedMessageIndex];
            finalMessage.TavernDB_ACU_IsolatedData = finalMessage.TavernDB_ACU_IsolatedData && typeof finalMessage.TavernDB_ACU_IsolatedData === 'object' && !Array.isArray(finalMessage.TavernDB_ACU_IsolatedData)
                ? finalMessage.TavernDB_ACU_IsolatedData : {};
            const finalTagData = finalMessage.TavernDB_ACU_IsolatedData[options.isolationKey];
            const finalFrame: TableStorageFrameV2_ACU = isV2TagData_ACU(finalTagData)
                ? finalTagData.storageFrame
                : { version: 2, logEntries: [] };
            if (!isV2TagData_ACU(finalTagData)) {
                finalMessage.TavernDB_ACU_IsolatedData[options.isolationKey] = { ...(finalTagData && typeof finalTagData === 'object' ? finalTagData : {}), _acu_storage_version: 2, storageFrame: finalFrame };
            }
            const perSheetCheckpoints = { ...(finalFrame.perSheetCheckpoints || {}) };
            const afterSeq = getMaxFrameSequence_ACU(finalFrame);
            for (const sheetKey of options.targetSheetKeys) {
                const checkpointBuild = buildCanonicalSheetCheckpoint_ACU({
                    createdAt,
                    reason: 'manual',
                    sheetKey,
                    data: cloneMessageFieldValue_ACU(options.snapshotData[sheetKey]) as Sheet_ACU,
                    scheduleSummary: { lastFilledAiFloor: completedAiFloor },
                    context: { messageIndex: completedMessageIndex, aiFloor: completedAiFloor, isolationKey: options.isolationKey, reason: 'manual' },
                });
                if (!checkpointBuild.checkpoint) {
                    throw new Error(`手动重填最终快照提交失败：${checkpointBuild.error}`);
                }
                perSheetCheckpoints[sheetKey] = {
                    ...checkpointBuild.checkpoint,
                    timeline: { kind: 'sheet_rebase', activateAtMessageIndex: completedMessageIndex, afterSeq },
                };
            }
            finalFrame.perSheetCheckpoints = perSheetCheckpoints;
            writeMessageIdentity_ACU(rootMessage, { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode });
            writeMessageIdentity_ACU(finalMessage, { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode });

            const replayed = await loadTableStateFromFramesV2Detailed_ACU(candidateChat, options.isolationKey, {
                updateRuntimeState: false,
                compatibilityMode: 'disabled',
            });
            if (!replayed || replayed.baseKind !== 'full_checkpoint') throw new Error('手动重填最终快照提交失败：候选聊天未能建立持久化 full checkpoint 回放基底。');
            if (replayed.requiresCheckpointConvergence || replayed.compatibilityRepairs?.length) {
                throw new Error('手动重填最终快照提交失败：候选聊天仍依赖临时 Sheet 补锚，必须先完成恢复收敛。');
            }
            for (const sheetKey of options.targetSheetKeys) {
                if (getTableDataFingerprint_ACU(replayed.data[sheetKey]) !== getTableDataFingerprint_ACU(options.snapshotData[sheetKey])) {
                    throw new Error(`手动重填最终快照提交失败：候选回放后的目标表 ${sheetKey} 与最终快照不一致。`);
                }
            }
            snapshotIndices.forEach(index => applyCandidateMessageFields_ACU(chat[index], candidateChat[index]));
            await saveChatToHostStrict_ACU();
            logDebug_ACU(`[手动重填最终快照] 已在 AI 楼层 #${completedMessageIndex} 为 ${options.targetSheetKeys.join(', ')} 写入末端 rebase${fallbackRequired ? '，并建立模板临时根' : ''}。`);
            return { success: true, changed: true, clearedCount: 0, checkpointCount: options.targetSheetKeys.length, targetMessageIndex: rootMessageIndex };
        } catch (error: any) {
            snapshots.forEach((snapshot, idx) => restoreMessageFieldSnapshot_ACU(chat[idx], snapshot));
            return { success: false, changed: false, clearedCount: 0, checkpointCount: 0, targetMessageIndex: rootMessageIndex, error: error?.message || String(error || '手动重填最终快照提交失败。') };
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
                const sheetData = cloneMessageFieldValue_ACU(options.baselineData[sheetKey]) as Sheet_ACU;
                perSheetCheckpoints[sheetKey] = {
                    kind: 'sheet_full',
                    createdAt,
                    reason: 'manual',
                    sheetKey,
                    data: sheetData,
                    ...(scheduleSummary[sheetKey] ? { scheduleSummary: cloneMessageFieldValue_ACU(scheduleSummary[sheetKey]) } : {}),
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
