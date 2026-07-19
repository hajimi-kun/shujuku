/**
 * service/table/update-orchestrator.ts — 表格更新编排（service 层：纯业务逻辑）
 * 从 presentation/triggers/update-process.ts 提取。
 * service 层不驱动 UI，只返回结果/状态，presentation 层根据返回值自行决定 UI 操作。
 */

import { isAutoUpdatingCard_ACU, pendingFinalGenerationGreenlights_ACU, wasStoppedByUser_ACU, _set_isAutoUpdatingCard_ACU, _set_manualExtraHint_ACU, _set_wasStoppedByUser_ACU } from '../runtime/state-manager';
import { callCustomOpenAI_ACU } from '../ai/prompt-builder';
import { captureManualRefillSessionSnapshot_ACU, clearManualRefillSheetDataInRange_ACU, commitManualRefillSheetSnapshotInRangeAtomic_ACU, ensureManualRefillInitialBaseline_ACU, ensureV2BoundaryCheckpointForRetainedBuffer_ACU, getChatArray_ACU, restoreManualRefillSessionSnapshotAtomic_ACU, shouldRotateV2BoundaryCheckpointForRetainedBuffer_ACU } from '../chat/chat-service';
import { coreApisAreReady_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU, _set_currentJsonTableData_ACU } from '../runtime/state-manager';
import { checkAutoMergeTrigger_ACU, prepareAutoMergeBatches_ACU, executeAutoMergeBatch_ACU, finalizeAutoMerge_ACU } from '../summary/merge-logic';
import { ensureStableRowIdsForSheetContent_ACU, getChatSheetGuideDataForIsolationKey_ACU, getEffectiveSeedRowsForSheet_ACU, shouldUseInitialSeedRows_ACU } from '../template/chat-scope';
import { loadAllChatMessages_ACU, updateReadableLorebookEntry_ACU } from '../worldbook/pipeline';
import { enqueueSummaryVectorIndexFlush_ACU } from '../vector/summary-vector-index-flush-queue';
import { getCurrentWorldbookConfig_ACU } from '../settings/settings-readers';
import { resolveTableHistoryStateFromChat_ACU } from './table-history';
import { planManualCatchUpWaves_ACU, type ManualCatchUpPlan_ACU } from './manual-fill-planner';
import type { ManualRefillProgressV2_ACU } from './storage-frame-v2-types';

import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';

import { applyTableDelta_ACU, isDeltaTagData_ACU } from './table-delta';
/**
 * 表名标准化：trim 后空串视为无效键
 */
function normalizeTableNameForPresetLookup_ACU(name: any): string {
    const trimmed = String(name ?? '').trim();
    return trimmed;
}

/**
 * 根据起始表的名称，查找表级 API 预设覆盖
 * @returns 预设名称，空字符串表示使用全局 tableApiPreset
 */
function resolveTableApiPresetOverride_ACU(tableName: any): string {
    const normalizedName = normalizeTableNameForPresetLookup_ACU(tableName);
    if (!normalizedName) return '';
    const overrides = settings_ACU.tableApiPresetOverridesByName;
    if (!overrides || typeof overrides !== 'object') return '';
    const preset = overrides[normalizedName];
    return (typeof preset === 'string' && preset.trim()) ? preset.trim() : '';
}
import { checkIfFirstTimeInit_ACU, ensureLegacyStorageMigratedBeforeWrite_ACU } from './table-service';
import { parseAndApplyTableEditsToData_ACU, prepareAIInput_ACU } from '../ai/prompt-builder';
import { extractStrictJsonTableFillResponse_ACU } from '../ai/prompt-builder/strict-json-table-fill';
import { isSqlContent } from '../ai/prompt-builder/table-edit-parser';
import { buildGuidedBaseDataFromSheetGuide_ACU, getSortedSheetKeys_ACU } from '../template/chat-scope';
import { isSqliteMode } from './storage-mode';
import type { TableMutationOperationV2_ACU } from './storage-frame-v2-types';
import { applySqlEditsToTableDataSnapshot_ACU, buildSqlSheetBatchOperations_ACU, extractTableNamesFromStatements, mapSqlTableNamesToSheetKeys_ACU, normalizeSqlStatementsForRuntimeLog_ACU } from './sql-table-service';
import { loadTableStateFromFramesV2_ACU } from './storage-frame-v2-replay';
import { ensureStorageProviderReady_ACU, getStorageProvider, reloadStorageProvider } from './table-storage-strategy';
import { applySpecialIndexSequenceToSummaryTables_ACU } from '../runtime/helpers-remaining';
import { captureTableRuntimeRevisionForWriteSet_ACU } from './table-write-transaction';
import { runTableUpdateCommit_ACU } from './table-update-commit';
import { isV2TagData_ACU, resolveTableStorageStrategy_ACU } from './storage-strategy-resolver';

// ============================================================
// 类型定义：返回值 + 进度事件（service 层不驱动 UI）
// ============================================================

/** 卡片更新进度事件阶段 */
export type CardUpdatePhase =
    | 'preparing'        // 准备 AI 输入
    | 'calling_ai'       // 调用 AI（含重试信息）
    | 'parsing'          // 解析 AI 返回
    | 'saving'           // 保存到聊天记录
    | 'chunk_done'       // 分块处理成功（import 模式）
    | 'complete'         // 完成
    | 'retry'            // 重试中
    | 'error';           // 出错

/** 卡片更新进度事件 */
export interface CardUpdateProgressEvent {
    phase: CardUpdatePhase;
    attempt?: number;
    maxRetries?: number;
    message?: string;
    currentBatch?: number;
    totalBatches?: number;
}

/** 批处理进度上下文 */
export interface BatchUpdateProgressContext {
    currentBatch: number;
    totalBatches: number;
    batchBaseSnapshot?: Record<string, any>;
}

/** executeCardUpdateCore 的返回值 */
export interface CardUpdateResult {
    success: boolean;
    modifiedKeys: string[];
    tableData?: Record<string, any>;
    error?: string;
    aborted?: boolean;
}

/** processUpdatesBatch 的返回值 */
export interface BatchUpdateResult {
    success: boolean;
    failedBatch?: number;
    error?: string;
}

type ManualRefillBoundaryErrorCode_ACU = 'no_full_checkpoint_replayable' | 'isolation_mismatch' | 'replay_failed';

export interface ManualRefillRequiresUserConfirmation_ACU {
    reason: 'manual_refill_replace_sheet_baseline';
    replayErrorCode: ManualRefillBoundaryErrorCode_ACU;
    message: string;
    contextScopeIndices: number[];
    targetSheetKeys: string[];
}

/** orchestrateManualUpdate 的返回值 */
export interface ManualUpdateResult {
    success: boolean;
    error?: string;
    requiresUserConfirmation?: ManualRefillRequiresUserConfirmation_ACU;
    /** 是否触发了自动合并 */
    autoMergeTriggered?: boolean;
    autoMergeSuccess?: boolean;
    checkpointWarning?: string;
    outcome?: 'complete' | 'no_work' | 'stopped' | 'sync_pending';
    committedBucketCount?: number;
    catchUpPlan?: ManualCatchUpPlan_ACU;
}

export interface ManualCatchUpPlanningResult_ACU {
    success: boolean;
    error?: string;
    plan?: ManualCatchUpPlan_ACU;
}

export interface GroupFillJob_ACU {
    groupKey: string;
    groupId: number;
    batchNumber: number;
    targetSheetKeys: string[] | null;
    messagesForContext: any[];
    saveTargetIndex: number;
    updateMode: string;
    requestOptions: Record<string, any> | null;
    baseSnapshot: Record<string, any>;
    baseRevision?: string | null;
    isImportMode?: boolean;
}

export interface GroupFillResponse_ACU {
    success: boolean;
    attempt: number;
    job: GroupFillJob_ACU;
    aiResponse?: string;
    tableEditText?: string;
    error?: string;
    rawError?: string;
    aborted?: boolean;
}

export interface UnifiedApplyAttempt_ACU {
    saveTargetIndex: number;
    responseCount: number;
    attempt: number;
    error?: string;
}

interface ManualRuntimeUpdateGroup_ACU {
    indices: number[];
    batchSize: number;
    groupId: number;
    sheetKeys: string[];
    requestOptions: Record<string, any> | null;
}

export interface GroupedRuntimeUpdateGroup_ACU {
    key: string;
    groupId: number;
    indices: number[];
    batchSize: number;
    sheetKeys: string[];
    requestOptions: Record<string, any> | null;
    mergeBaseMaxMessageIndex?: number;
    useLatestRuntimeMergeBase?: boolean;
}

interface PlannedGroupedRuntimeJob_ACU {
    group: GroupedRuntimeUpdateGroup_ACU;
    batchNumber: number;
    firstMessageIndexOfBatch: number;
    lastMessageIndexOfBatch: number;
    messageIndices: number[];
    saveTargetIndex: number;
    updateMode: string;
}

const SQL_ERROR_MARKER_ACU = '\n\n<!-- SQL_ERROR_FEEDBACK -->\n';
const UNIFIED_GROUP_ERROR_MARKER_ACU = '\n\n<!-- UNIFIED_GROUP_ERROR_FEEDBACK -->\n';

// ============================================================
// 核心业务函数
// ============================================================

/**
 * 加载批次基础数据：从聊天记录中为每个表格查找最新数据
 * 纯业务逻辑，不涉及任何 UI 操作
 */
/**
 * [辅助] 从聊天记录加载旧数据覆盖 sheet 后，恢复指导表基底中的关键结构字段。
 *
 * 背景：loadBatchBaseData_ACU 从聊天记录中加载旧数据时，会整体覆盖 mergedBatchData[sheetKey]。
 * 但指导表基底中可能包含用户在可视化编辑器中修改过的 sourceData.ddl 和表头（content[0]），
 * 这些结构信息不应该被聊天记录中的旧数据覆盖。
 *
 * 只恢复 sourceData（含 DDL）和表头（content[0]），其他字段（name/uid/updateConfig/exportConfig）
 * 保留聊天记录中的值，因为它们可能在聊天过程中被合法修改。
 */
function restoreGuideStructure(mergedSheet: any, guideSheet: any): void {
    if (!guideSheet || typeof guideSheet !== 'object') return;
    if (!mergedSheet || typeof mergedSheet !== 'object') return;

    // 恢复 sourceData（包含 DDL、note 等用户在可视化编辑器中修改的关键配置）
    if (guideSheet.sourceData) mergedSheet.sourceData = JSON.parse(JSON.stringify(guideSheet.sourceData));

    // 恢复表头（content[0]）——指导表中的表头是用户最新编辑的
    if (Array.isArray(guideSheet.content) && guideSheet.content.length > 0 &&
        Array.isArray(mergedSheet.content) && mergedSheet.content.length > 0) {
        mergedSheet.content[0] = JSON.parse(JSON.stringify(guideSheet.content[0]));
    }
}

export function loadBatchBaseData_ACU(
    chatHistory: any[],
    firstMessageIndexOfBatch: number,
    batchIsolationKey: string,
    batchSheetKeys: string[],
    mergedBatchData: Record<string, any>
): { foundCount: number; totalCount: number } {
    const batchFoundSheets: Record<string, boolean> = {};
    batchSheetKeys.forEach(k => batchFoundSheets[k] = false);

    // 收集 delta 楼层的增量数据（逆序收集，后续正序叠加）
    const pendingDeltas: { msgIndex: number; incrementalData: Record<string, any> }[] = [];

    // [修复] 保存指导表基底中每个 sheet 的结构快照（sourceData/DDL/表头/表名等），
    // 以便从聊天记录加载旧数据覆盖后恢复。防止旧数据中的旧 DDL/旧表头覆盖用户在可视化编辑器中的修改。
    const guideSnapshots: Record<string, any> = {};
    batchSheetKeys.forEach(k => {
        if (mergedBatchData[k] && typeof mergedBatchData[k] === 'object') {
            guideSnapshots[k] = mergedBatchData[k];
        }
    });

    for (let j = firstMessageIndexOfBatch - 1; j >= 0; j--) {
        const msg = chatHistory[j];
        if (msg.is_user) continue;

        // [优先级1] 新版按标签分组存储
        if (msg.TavernDB_ACU_IsolatedData && msg.TavernDB_ACU_IsolatedData[batchIsolationKey]) {
            const tagData = msg.TavernDB_ACU_IsolatedData[batchIsolationKey];

            // delta 楼层：收集增量，不做整表覆盖
            if (isDeltaTagData_ACU(tagData)) {
                if (tagData.incrementalData) {
                    pendingDeltas.push({ msgIndex: j, incrementalData: tagData.incrementalData });
                }
                continue;
            }

            // checkpoint / legacy 楼层：原 first-write-wins 逻辑
            const independentData = tagData.independentData || {};
            Object.keys(independentData).forEach(storedSheetKey => {
                if (batchFoundSheets[storedSheetKey] === false && mergedBatchData[storedSheetKey]) {
                    mergedBatchData[storedSheetKey] = JSON.parse(JSON.stringify(independentData[storedSheetKey]));
                    restoreGuideStructure(mergedBatchData[storedSheetKey], guideSnapshots[storedSheetKey]);
                    batchFoundSheets[storedSheetKey] = true;
                }
            });
        }

        // [优先级2] 兼容旧版存储格式
        const msgIdentity = msg.TavernDB_ACU_Identity;
        let isLegacyMatch = false;
        if (settings_ACU.dataIsolationEnabled) {
            isLegacyMatch = (msgIdentity === settings_ACU.dataIsolationCode);
        } else {
            isLegacyMatch = !msgIdentity;
        }

        if (isLegacyMatch) {
            if (msg.TavernDB_ACU_IndependentData) {
                const independentData = msg.TavernDB_ACU_IndependentData;
                Object.keys(independentData).forEach(storedSheetKey => {
                    if (batchFoundSheets[storedSheetKey] === false && mergedBatchData[storedSheetKey]) {
                        mergedBatchData[storedSheetKey] = JSON.parse(JSON.stringify(independentData[storedSheetKey]));
                        restoreGuideStructure(mergedBatchData[storedSheetKey], guideSnapshots[storedSheetKey]);
                        batchFoundSheets[storedSheetKey] = true;
                    }
                });
            }

            if (msg.TavernDB_ACU_Data) {
                const standardData = msg.TavernDB_ACU_Data;
                Object.keys(standardData).forEach(k => {
                    if (k.startsWith('sheet_') && batchFoundSheets[k] === false && mergedBatchData[k]) {
                        mergedBatchData[k] = JSON.parse(JSON.stringify(standardData[k]));
                        restoreGuideStructure(mergedBatchData[k], guideSnapshots[k]);
                        batchFoundSheets[k] = true;
                    }
                });
            }

            if (msg.TavernDB_ACU_SummaryData) {
                const summaryData = msg.TavernDB_ACU_SummaryData;
                Object.keys(summaryData).forEach(k => {
                    if (k.startsWith('sheet_') && batchFoundSheets[k] === false && mergedBatchData[k]) {
                        mergedBatchData[k] = JSON.parse(JSON.stringify(summaryData[k]));
                        restoreGuideStructure(mergedBatchData[k], guideSnapshots[k]);
                        batchFoundSheets[k] = true;
                    }
                });
            }
        }

        if (Object.values(batchFoundSheets).every(v => v === true)) {
            break;
        }
    }

    // 正序叠加 delta 增量到已找到的 base 数据上
    if (pendingDeltas.length > 0) {
        pendingDeltas.reverse(); // 逆序收集 → 正序叠加
        for (const { incrementalData } of pendingDeltas) {
            for (const sheetKey of Object.keys(incrementalData)) {
                if (!mergedBatchData[sheetKey] || batchFoundSheets[sheetKey] === undefined) continue;
                try {
                    mergedBatchData[sheetKey] = applyTableDelta_ACU(mergedBatchData[sheetKey], incrementalData[sheetKey], sheetKey);
                    restoreGuideStructure(mergedBatchData[sheetKey], guideSnapshots[sheetKey]);
                    if (Array.isArray(mergedBatchData[sheetKey]?.content)) {
                        mergedBatchData[sheetKey].content = ensureStableRowIdsForSheetContent_ACU(mergedBatchData[sheetKey].content);
                    }
                    batchFoundSheets[sheetKey] = true;
                } catch (e: any) {
                    logWarn_ACU(`[表格增量] loadBatchBaseData: 叠加 delta 失败 (sheet=${sheetKey}): ${e?.message || e}`);
                }
            }
        }
    }

    const foundCount = Object.values(batchFoundSheets).filter(v => v === true).length;
    const totalCount = batchSheetKeys.length;
    return { foundCount, totalCount };
}

/**
 * 构建批次合并基底数据
 * 纯业务逻辑，不涉及任何 UI 操作
 */
function cloneTableDataSnapshot_ACU(data: Record<string, any> | null | undefined): Record<string, any> | null {
    if (!data || typeof data !== 'object') return null;
    return JSON.parse(JSON.stringify(data));
}

function hasUsableRuntimeTableData_ACU(data: Record<string, any> | null): boolean {
    if (!data || typeof data !== 'object') return false;
    return Object.keys(data).some(k => k.startsWith('sheet_') && Array.isArray(data[k]?.content));
}

function buildWriteSetForSheetKeys_ACU(sheetKeys: string[] | null | undefined, fallbackData?: Record<string, any> | null) {
    const keys = Array.isArray(sheetKeys) && sheetKeys.length > 0
        ? sheetKeys
        : getSortedSheetKeys_ACU(fallbackData || currentJsonTableData_ACU || {});
    const normalized = [...new Set(keys.filter(sheetKey => typeof sheetKey === 'string' && sheetKey.startsWith('sheet_')))].sort();
    return normalized.length > 0
        ? normalized.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }))
        : [{ kind: 'all' as const }];
}


function hasSheetContentRows_ACU(sheet: any): boolean {
    return Array.isArray(sheet?.content) && sheet.content.length > 1;
}


function buildSqlSheetBatchOperationsFromText_ACU(
    sqlText: string,
    tableData: Record<string, any>,
    targetSheetKeys: string[] | null | undefined,
): { success: true; operations: TableMutationOperationV2_ACU[] } | { success: false; error: string } {
    const statements = normalizeSqlStatementsForRuntimeLog_ACU(sqlText);
    if (statements.length === 0) return { success: true, operations: [] };
    const buildResult = buildSqlSheetBatchOperations_ACU(statements, tableData as any, {
        fallbackTargetSheetKeys: Array.isArray(targetSheetKeys) ? targetSheetKeys : [],
        allowSingleTargetFallback: true,
        keepLegacyForUnclassified: false,
        reason: 'system',
    });
    const hasUnclassified = buildResult.unknownStatements.length > 0
        || buildResult.ambiguousStatements.length > 0
        || buildResult.operations.some(operation => operation.kind === 'sql_batch');
    if (hasUnclassified) {
        return { success: false, error: 'SQL 语句无法归属到单表日志，拒绝写入不可预清理的 SQL 增量。' };
    }
    return { success: true, operations: buildResult.operations };
}

function buildSheetReplaceOperationsFromData_ACU(
    afterData: Record<string, any> | null | undefined,
    sheetKeys: string[] | null | undefined,
    reason: 'manual_crud' | 'import' | 'system',
): TableMutationOperationV2_ACU[] {
    if (!afterData || typeof afterData !== 'object' || !Array.isArray(sheetKeys) || sheetKeys.length === 0) return [];
    const seen = new Set<string>();
    const operations: TableMutationOperationV2_ACU[] = [];
    sheetKeys.forEach(sheetKey => {
        if (typeof sheetKey !== 'string' || !sheetKey.startsWith('sheet_') || seen.has(sheetKey)) return;
        const sheet = afterData[sheetKey];
        if (!sheet || typeof sheet !== 'object') return;
        seen.add(sheetKey);
        operations.push({ kind: 'sheet_replace', sheetKey, sheet: JSON.parse(JSON.stringify(sheet)), reason });
    });
    return operations;
}

function getTouchedSheetKeysFromSqlText_ACU(sqlText: string, tableData: Record<string, any>): string[] {
    const statements = normalizeSqlStatementsForRuntimeLog_ACU(sqlText);
    if (statements.length === 0) return [];
    const tableNames = extractTableNamesFromStatements(statements);
    return mapSqlTableNamesToSheetKeys_ACU(tableData as any, tableNames);
}

function findSqlFailureGroupKey_ACU(sqlTexts: string[], responses: GroupFillResponse_ACU[], errorMessage: string): string | null {
    const match = String(errorMessage || '').match(/第\s*(\d+)\s*条语句失败/);
    const failedIndex = match ? Number.parseInt(match[1], 10) : NaN;
    if (!Number.isFinite(failedIndex) || failedIndex <= 0) return null;

    let cursor = 0;
    for (let i = 0; i < sqlTexts.length; i += 1) {
        const count = normalizeSqlStatementsForRuntimeLog_ACU(sqlTexts[i]).length;
        if (failedIndex > cursor && failedIndex <= cursor + count) {
            return responses[i]?.job?.groupKey || null;
        }
        cursor += count;
    }
    return null;
}

function getRuntimeTableDataSnapshot_ACU(fallbackData: Record<string, any> | null = null): Record<string, any> | null {
    const explicitFallback = cloneTableDataSnapshot_ACU(fallbackData || null);
    if (hasUsableRuntimeTableData_ACU(explicitFallback)) return explicitFallback;

    try {
        const providerData = getStorageProvider().getCurrentData();
        const cloned = cloneTableDataSnapshot_ACU(providerData as any);
        if (hasUsableRuntimeTableData_ACU(cloned)) return cloned;
    } catch (error) {
        logWarn_ACU('[RuntimeSnapshot] 无法从运行时存储导出当前表格快照，改用内存快照兜底。', error);
    }

    const fallback = cloneTableDataSnapshot_ACU(currentJsonTableData_ACU || null);
    if (hasUsableRuntimeTableData_ACU(fallback)) return fallback;
    return null;
}


function mergeGuideStructureIntoBaseData_ACU(data: Record<string, any>): Record<string, any> {
    const base = cloneTableDataSnapshot_ACU(data) || {};
    const batchIsoKey = getCurrentIsolationKey_ACU();
    const sheetGuideForBatch = getChatSheetGuideDataForIsolationKey_ACU(batchIsoKey);
    if (!sheetGuideForBatch || typeof sheetGuideForBatch !== 'object' || !Object.keys(sheetGuideForBatch).some(k => k.startsWith('sheet_'))) {
        return base;
    }

    const guideBase = buildGuidedBaseDataFromSheetGuide_ACU(sheetGuideForBatch);
    if (!base.mate && guideBase?.mate) base.mate = JSON.parse(JSON.stringify(guideBase.mate));
    Object.keys(guideBase || {}).forEach(sheetKey => {
        if (!sheetKey.startsWith('sheet_')) return;
        if (base[sheetKey]) {
            restoreGuideStructure(base[sheetKey], guideBase[sheetKey]);
        } else {
            base[sheetKey] = JSON.parse(JSON.stringify(guideBase[sheetKey]));
        }
    });
    return base;
}

async function loadV2ReplayMergeBase_ACU(
    batchNumber: number,
    options: { maxMessageIndex?: number } = {},
): Promise<{ data: Record<string, any> | null; attempted: boolean }> {
    const chat = getChatArray_ACU();
    if (!Array.isArray(chat) || chat.length === 0) return { data: null, attempted: false };

    const isolationKey = getCurrentIsolationKey_ACU();
    const strategy = resolveTableStorageStrategy_ACU(chat, isolationKey, {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
    });
    if (strategy.mode !== 'v2') return { data: null, attempted: false };

    try {
        const replayedData = await loadTableStateFromFramesV2_ACU(chat, isolationKey, options);
        const cloned = cloneTableDataSnapshot_ACU(replayedData as any);
        if (!hasUsableRuntimeTableData_ACU(cloned)) return { data: null, attempted: true };
        const mergedData = mergeGuideStructureIntoBaseData_ACU(cloned as Record<string, any>);
        _set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(mergedData)));
        const scope = Number.isInteger(options.maxMessageIndex) ? `<=${options.maxMessageIndex}` : 'latest';
        logDebug_ACU(`[Batch ${batchNumber}] Using V2 replay state as merge base (${scope}).`);
        return { data: mergedData, attempted: true };
    } catch (error) {
        logWarn_ACU(`[Batch ${batchNumber}] V2 replay merge base failed; fallback guarded by scope.`, error);
        return { data: null, attempted: true };
    }
}

function scanManualRefillV2ReplayBoundary_ACU(
    chat: any[],
    currentIsolationKey: string,
    maxMessageIndex: number,
): { hasCurrentIsolationV2: boolean; otherIsolationKeys: string[] } {
    if (!Array.isArray(chat) || maxMessageIndex < 0) {
        return { hasCurrentIsolationV2: false, otherIsolationKeys: [] };
    }

    const otherIsolationKeys = new Set<string>();
    const boundary = Math.min(maxMessageIndex, chat.length - 1);
    let hasCurrentIsolationV2 = false;

    for (let i = 0; i <= boundary; i += 1) {
        const message = chat[i];
        if (!message || message.is_user) continue;
        const isolatedData = message.TavernDB_ACU_IsolatedData;
        if (!isolatedData || typeof isolatedData !== 'object' || Array.isArray(isolatedData)) continue;

        for (const [isolationKey, tagData] of Object.entries(isolatedData)) {
            if (!isV2TagData_ACU(tagData)) continue;
            if (isolationKey === currentIsolationKey) {
                hasCurrentIsolationV2 = true;
            } else {
                otherIsolationKeys.add(isolationKey);
            }
        }
    }

    return { hasCurrentIsolationV2, otherIsolationKeys: [...otherIsolationKeys] };
}

function collectManualRefillRollbackMessageIndices_ACU(
    chat: any[],
    currentIsolationKey: string,
    contextScopeIndices: number[],
): number[] {
    const indices = new Set(contextScopeIndices);
    for (let i = 0; i < chat.length; i += 1) {
        const message = chat[i];
        if (!message || message.is_user) continue;
        const tagData = message.TavernDB_ACU_IsolatedData?.[currentIsolationKey];
        if (!isV2TagData_ACU(tagData)) continue;
        if (tagData.storageFrame.checkpoint?.kind === 'full') indices.add(i);
    }
    return [...indices].sort((a, b) => a - b);
}

async function ensureManualRefillV2ReplayBoundary_ACU(
    chat: any[],
    currentIsolationKey: string,
    maxMessageIndex: number,
): Promise<{ success: true } | { success: false; code: ManualRefillBoundaryErrorCode_ACU; error: string }> {
    const boundary = scanManualRefillV2ReplayBoundary_ACU(chat, currentIsolationKey, maxMessageIndex);
    if (!boundary.hasCurrentIsolationV2) {
        if (boundary.otherIsolationKeys.length > 0) {
            return { success: false, code: 'isolation_mismatch', error: `手动重填中止：目标前存在其他 isolationKey 的 V2 数据（${boundary.otherIsolationKeys.join(', ')}），当前 isolationKey 不匹配。` };
        }
        return { success: true };
    }

    try {
        const replayedData = await loadTableStateFromFramesV2_ACU(chat, currentIsolationKey, { maxMessageIndex });
        if (replayedData) return { success: true };
        return { success: false, code: 'no_full_checkpoint_replayable', error: '手动重填中止：找不到可用 full checkpoint，无法安全回放到重填起点前。' };
    } catch (error: any) {
        return { success: false, code: 'replay_failed', error: error?.message || '手动重填中止：V2 数据回放失败，无法安全回放到重填起点前。' };
    }
}

function buildGuideOrTemplateMergeBase_ACU(batchNumber: number): { data: Record<string, any> | null; error: string | null } {
    const batchIsoKey = getCurrentIsolationKey_ACU();
    const sheetGuideForBatch = getChatSheetGuideDataForIsolationKey_ACU(batchIsoKey);
    if (sheetGuideForBatch && typeof sheetGuideForBatch === 'object' && Object.keys(sheetGuideForBatch).some(k => k.startsWith('sheet_'))) {
        const data = buildGuidedBaseDataFromSheetGuide_ACU(sheetGuideForBatch);
        logDebug_ACU(`[Batch ${batchNumber}] Using chat sheet guide as merge base.`);
        return { data, error: null };
    }
    const data = parseTableTemplateJson_ACU({ stripSeedRows: true });
    logDebug_ACU(`[Batch ${batchNumber}] No chat sheet guide found, using template as merge base.`);
    return { data, error: null };
}

export async function buildBatchMergeBase_ACU(
    batchNumber: number,
    options: { maxMessageIndex?: number } = {},
): Promise<{ data: Record<string, any> | null; error: string | null }> {
    try {
        const hasBoundedScope = Number.isInteger(options.maxMessageIndex);
        if (hasBoundedScope) {
            const v2ReplayResult = await loadV2ReplayMergeBase_ACU(batchNumber, options);
            if (v2ReplayResult.data) return { data: v2ReplayResult.data, error: null };
            // 有历史边界时不能让 SQLite latest runtime 越过 maxMessageIndex；
            // 若当前聊天已进入 V2 replay 语义但边界内无可用基底，同样不能退回最新 runtime，
            // 否则会把目标范围之后的未来表格状态带回 prompt。只有非 SQLite 且未命中 V2 replay
            // 的旧路径才允许沿用 runtime fallback，以保留连续 bucket 的既有行为。
            if (isSqliteMode() || v2ReplayResult.attempted) {
                return buildGuideOrTemplateMergeBase_ACU(batchNumber);
            }
        }

        const runtimeData = getRuntimeTableDataSnapshot_ACU();
        if (runtimeData && isSqliteMode()) {
            logDebug_ACU(`[Batch ${batchNumber}] Using SQLite runtime storage snapshot as merge base.`);
            return { data: mergeGuideStructureIntoBaseData_ACU(runtimeData), error: null };
        }

        const v2ReplayResult = await loadV2ReplayMergeBase_ACU(batchNumber, options);
        if (v2ReplayResult.data) return { data: v2ReplayResult.data, error: null };

        // 指定了历史边界时，若当前聊天是 V2 但边界前没有可重放 checkpoint，不能退回“最新运行时快照”，
        // 否则会把目标楼之后的表格数据喂给本批次；此时应按空指导表/模板从零开始。
        if (!isSqliteMode() && v2ReplayResult.attempted && hasBoundedScope) {
            return buildGuideOrTemplateMergeBase_ACU(batchNumber);
        }

        if (runtimeData) {
            logDebug_ACU(`[Batch ${batchNumber}] Using runtime storage snapshot as merge base.`);
            return { data: mergeGuideStructureIntoBaseData_ACU(runtimeData), error: null };
        }

        return buildGuideOrTemplateMergeBase_ACU(batchNumber);
    } catch (e) {
        logError_ACU(`[Batch ${batchNumber}] Failed to build merge base from guide/template.`, e);
        return { data: null, error: '无法构建合并基底，操作已终止。' };
    }
}


/**
 * 确定更新模式
 * 纯业务逻辑
 */
export function resolveUpdateMode_ACU(mode: string): string {
    if (mode === 'auto_unified' || mode === 'manual_unified' || mode === 'full') {
        return mode;
    } else if (mode === 'auto_summary_silent') {
        return 'auto_summary_silent';
    } else if (mode && mode.startsWith('manual')) {
        if (mode.includes('summary')) return 'manual_summary';
        else if (mode === 'manual_independent') return 'manual_independent';
        else return 'manual_standard';
    } else {
        if (mode && mode.includes('summary')) return 'auto_summary';
        else return 'auto_standard';
    }
}

export async function collectGroupFillResponse_ACU(
    job: GroupFillJob_ACU,
    feedback?: { lastSqlError?: string | null; lastUnifiedError?: string | null },
    abortController: AbortController | null = new AbortController(),
    options: {
        onProgress?: (event: CardUpdateProgressEvent) => void;
        maxRetriesOverride?: number;
        respectGlobalStop?: boolean;
    } = {}
): Promise<GroupFillResponse_ACU> {
    const effectiveAbortController = abortController || new AbortController();
    const isStopped = () => effectiveAbortController.signal.aborted || (options.respectGlobalStop !== false && wasStoppedByUser_ACU);
    options.onProgress?.({ phase: 'preparing' });

    const dynamicContent = await prepareAIInput_ACU(job.messagesForContext, job.updateMode, job.targetSheetKeys, {
        tableData: job.baseSnapshot,
        excludeImportTaggedWorldbookEntries: job.isImportMode === true && settings_ACU.importPromptExcludeImportedWorldbookEntries !== false,
        agentGreenlights: Array.isArray(pendingFinalGenerationGreenlights_ACU) ? [...pendingFinalGenerationGreenlights_ACU] : [],
    });
    if (!dynamicContent) {
        return {
            job,
            success: false,
            attempt: 0,
            error: '无法准备AI输入，数据库未加载。',
            rawError: '无法准备AI输入，数据库未加载。',
        };
    }

    const maxRetries = options.maxRetriesOverride || settings_ACU.tableMaxRetries || 3;
    let lastErrorMessage = 'AI响应中未找到完整有效的 <tableEdit> 标签';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (isStopped()) {
            return { job, success: false, attempt, aborted: true };
        }

        options.onProgress?.({ phase: 'calling_ai', attempt, maxRetries });

        if (feedback?.lastSqlError && isSqliteMode()) {
            const markerIndex = dynamicContent.tableDataText.indexOf(SQL_ERROR_MARKER_ACU);
            if (markerIndex !== -1) {
                dynamicContent.tableDataText = dynamicContent.tableDataText.substring(0, markerIndex);
            }
            dynamicContent.tableDataText += `${SQL_ERROR_MARKER_ACU}[SQL执行错误，请修正后重新输出]\n错误信息: ${feedback.lastSqlError}`;
        }
        if (feedback?.lastUnifiedError) {
            const markerIndex = dynamicContent.tableDataText.indexOf(UNIFIED_GROUP_ERROR_MARKER_ACU);
            if (markerIndex !== -1) {
                dynamicContent.tableDataText = dynamicContent.tableDataText.substring(0, markerIndex);
            }
            dynamicContent.tableDataText += `${UNIFIED_GROUP_ERROR_MARKER_ACU}[统一提交失败，请修正后重新输出]\n错误信息: ${feedback.lastUnifiedError}`;
        }

        try {
            const aiResponse = await callCustomOpenAI_ACU(dynamicContent, effectiveAbortController, {
                ...(job.requestOptions || {}),
                tableData: job.baseSnapshot,
                targetSheetKeys: job.targetSheetKeys,
            });
            if (isStopped()) {
                return { job, success: false, attempt, aborted: true };
            }

            const minReplyLength = settings_ACU.autoUpdateTokenThreshold || 0;
            if (aiResponse && minReplyLength > 0 && aiResponse.length < minReplyLength) {
                throw new Error(`AI回复过短 (${aiResponse.length} 字符)，低于阈值 (${minReplyLength} 字符)`);
            }
            let normalizedAiResponse = aiResponse;
            let tableEditText = '';
            if (settings_ACU.strictJsonTableFillEnabled === true) {
                const extracted = extractStrictJsonTableFillResponse_ACU(aiResponse, {
                    sqlite: isSqliteMode(),
                    tableData: job.baseSnapshot,
                    targetSheetKeys: job.targetSheetKeys,
                });
                if (!extracted.ok) {
                    throw new Error(extracted.retryHint || extracted.error || '严格 JSON 填表响应格式无效');
                }
                normalizedAiResponse = extracted.normalizedResponse || aiResponse;
                tableEditText = (extracted.tableEditText || '').trim();
            } else {
                if (!aiResponse || !aiResponse.includes('<tableEdit>') || !aiResponse.includes('</tableEdit>')) {
                    throw new Error('AI响应中未找到完整有效的 <tableEdit> 标签');
                }
                tableEditText = (aiResponse.match(/<tableEdit>([\s\S]*?)<\/tableEdit>/i)?.[1] || '').trim();
            }

            return { job, success: true, attempt, aiResponse: normalizedAiResponse, tableEditText };
        } catch (error: any) {
            lastErrorMessage = error?.message || '未知错误';
            logWarn_ACU(`第 ${attempt} 次尝试失败: ${lastErrorMessage}`);
            if (error?.name === 'AbortError' || String(lastErrorMessage).toLowerCase().includes('aborted') || isStopped()) {
                return { job, success: false, attempt, aborted: true };
            }
            if (attempt < maxRetries) {
                options.onProgress?.({ phase: 'retry', attempt, maxRetries, message: String(lastErrorMessage).substring(0, 50) });
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    return { job, success: false, attempt: maxRetries, error: `填表在 ${maxRetries} 次尝试后仍失败: ${lastErrorMessage}`, rawError: lastErrorMessage };
}

function buildSqlInitializationBase_ACU(baseSnapshot: Record<string, any>, targetSheetKeys: string[]) {
    const workingTableData = JSON.parse(JSON.stringify(baseSnapshot || {}));
    const initializedSheetKeys = new Set<string>();

    let templateData: Record<string, any> | null = null;
    let guideData: Record<string, any> | null = null;
    let guidedBaseData: Record<string, any> | null = null;

    try {
        templateData = parseTableTemplateJson_ACU({ stripSeedRows: false }) as Record<string, any> | null;
    } catch (error) {
        logWarn_ACU('[SQL Init] parseTableTemplateJson_ACU failed, fallback to baseSnapshot only.', error);
    }
    try {
        guideData = getChatSheetGuideDataForIsolationKey_ACU(getCurrentIsolationKey_ACU());
        guidedBaseData = guideData ? buildGuidedBaseDataFromSheetGuide_ACU(guideData) : null;
    } catch (error) {
        logWarn_ACU('[SQL Init] getChatSheetGuideDataForIsolationKey_ACU failed, fallback to template/baseSnapshot only.', error);
    }

    if (!workingTableData.mate && templateData?.mate) {
        workingTableData.mate = JSON.parse(JSON.stringify(templateData.mate));
    }

    for (const sheetKey of Array.isArray(targetSheetKeys) ? targetSheetKeys : []) {
        if (!sheetKey || !String(sheetKey).startsWith('sheet_')) continue;

        const templateSheet = templateData?.[sheetKey];
        const guidedSheet = guidedBaseData?.[sheetKey];
        const existingSheet = workingTableData?.[sheetKey];
        const sourceSheet = guidedSheet || templateSheet;
        if ((!existingSheet || typeof existingSheet !== 'object') && (!sourceSheet || typeof sourceSheet !== 'object')) continue;

        let sheetChanged = false;
        if (!existingSheet || typeof existingSheet !== 'object') {
            workingTableData[sheetKey] = {};
            sheetChanged = true;
        }

        const targetSheet = workingTableData[sheetKey];
        const fallbackUid = guidedSheet?.uid || templateSheet?.uid;
        const fallbackName = guidedSheet?.name || templateSheet?.name;
        const fallbackSourceData = guidedSheet?.sourceData && typeof guidedSheet.sourceData === 'object'
            ? guidedSheet.sourceData
            : (templateSheet?.sourceData && typeof templateSheet.sourceData === 'object' ? templateSheet.sourceData : null);
        const fallbackUpdateConfig = guidedSheet?.updateConfig && typeof guidedSheet.updateConfig === 'object'
            ? guidedSheet.updateConfig
            : (templateSheet?.updateConfig && typeof templateSheet.updateConfig === 'object' ? templateSheet.updateConfig : null);
        const fallbackExportConfig = guidedSheet?.exportConfig && typeof guidedSheet.exportConfig === 'object'
            ? guidedSheet.exportConfig
            : (templateSheet?.exportConfig && typeof templateSheet.exportConfig === 'object' ? templateSheet.exportConfig : null);
        const fallbackOrderNo = guidedSheet?.orderNo !== undefined ? guidedSheet.orderNo : templateSheet?.orderNo;
        const headerRow = Array.isArray(targetSheet?.content?.[0])
            ? targetSheet.content[0]
            : (Array.isArray(guidedSheet?.content?.[0])
                ? guidedSheet.content[0]
                : (Array.isArray(templateSheet?.content?.[0]) ? templateSheet.content[0] : null));

        if (!targetSheet.uid && fallbackUid) { targetSheet.uid = fallbackUid; sheetChanged = true; }
        if (!targetSheet.name && fallbackName) { targetSheet.name = fallbackName; sheetChanged = true; }
        if ((!targetSheet.sourceData || typeof targetSheet.sourceData !== 'object') && fallbackSourceData) {
            targetSheet.sourceData = JSON.parse(JSON.stringify(fallbackSourceData));
            sheetChanged = true;
        } else if (!targetSheet?.sourceData?.ddl && fallbackSourceData?.ddl) {
            targetSheet.sourceData = { ...(targetSheet.sourceData || {}), ddl: fallbackSourceData.ddl };
            sheetChanged = true;
        }
        if ((!targetSheet.updateConfig || typeof targetSheet.updateConfig !== 'object') && fallbackUpdateConfig) {
            targetSheet.updateConfig = JSON.parse(JSON.stringify(fallbackUpdateConfig));
            sheetChanged = true;
        }
        if ((!targetSheet.exportConfig || typeof targetSheet.exportConfig !== 'object') && fallbackExportConfig) {
            targetSheet.exportConfig = JSON.parse(JSON.stringify(fallbackExportConfig));
            sheetChanged = true;
        }
        if ((targetSheet.orderNo === undefined || targetSheet.orderNo === null) && fallbackOrderNo !== undefined) {
            targetSheet.orderNo = fallbackOrderNo;
            sheetChanged = true;
        }

        if (!Array.isArray(targetSheet.content)) {
            targetSheet.content = headerRow ? [JSON.parse(JSON.stringify(headerRow))] : [];
            sheetChanged = true;
        } else if (targetSheet.content.length === 0 && headerRow) {
            targetSheet.content = [JSON.parse(JSON.stringify(headerRow))];
            sheetChanged = true;
        } else if (!Array.isArray(targetSheet.content[0]) && headerRow) {
            targetSheet.content[0] = JSON.parse(JSON.stringify(headerRow));
            sheetChanged = true;
        }

        if (shouldUseInitialSeedRows_ACU() && Array.isArray(targetSheet.content) && targetSheet.content.length <= 1) {
            let seedRows = getEffectiveSeedRowsForSheet_ACU(sheetKey, { guideData, allowTemplateFallback: true });
            if ((!Array.isArray(seedRows) || seedRows.length === 0) && Array.isArray(sourceSheet?.content) && sourceSheet.content.length > 1) {
                seedRows = JSON.parse(JSON.stringify(sourceSheet.content.slice(1)));
            }
            if (Array.isArray(seedRows) && seedRows.length > 0) {
                targetSheet.content = [targetSheet.content[0] || [], ...JSON.parse(JSON.stringify(seedRows))];
                targetSheet.content = ensureStableRowIdsForSheetContent_ACU(targetSheet.content);
                sheetChanged = true;
            }
        }

        if (sheetChanged) initializedSheetKeys.add(sheetKey);
    }

    return { workingTableData, initializedSheetKeys };
}

function sortGroupFillResponses_ACU(responses: GroupFillResponse_ACU[]): GroupFillResponse_ACU[] {
    return [...responses].sort((a, b) => {
        const jobA = a.job;
        const jobB = b.job;
        return (jobA?.saveTargetIndex || 0) - (jobB?.saveTargetIndex || 0)
            || (jobA?.batchNumber || 0) - (jobB?.batchNumber || 0)
            || (jobA?.groupId || 0) - (jobB?.groupId || 0)
            || String(jobA?.groupKey || '').localeCompare(String(jobB?.groupKey || ''));
    });
}

function isGroupFillSqlResponse_ACU(response: GroupFillResponse_ACU): boolean {
    return typeof response.tableEditText === 'string' && isSqlContent(response.tableEditText);
}

function getMixedSqliteNonSqlResponses_ACU(responses: GroupFillResponse_ACU[]): GroupFillResponse_ACU[] {
    if (!isSqliteMode()) return [];
    const hasSql = responses.some(isGroupFillSqlResponse_ACU);
    if (!hasSql) return [];
    return responses.filter(response => !isGroupFillSqlResponse_ACU(response));
}

function buildMixedSqliteFormatError_ACU(nonSqlResponses: GroupFillResponse_ACU[]): string {
    const groupKeys = nonSqlResponses.map(response => response.job?.groupKey || 'unknown').join(', ');
    return `SQLite 严格模式下同一批分组填表禁止混合 SQL/非 SQL 输出；以下 group 未返回 SQL tableEdit：${groupKeys}。请只重试这些 group，并输出 SQL。`;
}

export async function applyUnifiedGroupFillResponses_ACU(
    responses: GroupFillResponse_ACU[],
    baseSnapshot: Record<string, any>,
    options: {
        saveTargetIndex: number;
        updateMode: string;
        isImportMode: boolean;
        replaceExistingIncremental?: { targetMessageIndices: number[]; targetSheetKeys: string[] };
        manualRefillProgress?: ManualRefillProgressV2_ACU;
        syncAfterCommit?: boolean;
        baseRevision?: string | null;
    }
): Promise<CardUpdateResult> {
    if (!Array.isArray(responses) || responses.length === 0) {
        return { success: false, modifiedKeys: [], error: '统一提交失败：responses 为空。' };
    }
    if (!baseSnapshot || typeof baseSnapshot !== 'object') {
        return { success: false, modifiedKeys: [], error: '统一提交失败：baseSnapshot 无效。' };
    }

    const sortedResponses = sortGroupFillResponses_ACU(responses);

    const seenTargetSheetKeys = new Set<string>();
    const allTargetSheetKeySet = new Set<string>();
    for (const response of sortedResponses) {
        if (!response.success || !response.aiResponse || response.tableEditText === undefined || response.tableEditText === null || !response.job) {
            return { success: false, modifiedKeys: [], error: '统一提交失败：存在未完成或无效的 group 响应。' };
        }
        for (const sheetKey of response.job.targetSheetKeys || []) {
            if (seenTargetSheetKeys.has(sheetKey)) {
                return { success: false, modifiedKeys: [], error: `统一提交失败：targetSheetKeys 存在重叠冲突 (${sheetKey})。` };
            }
            seenTargetSheetKeys.add(sheetKey);
            allTargetSheetKeySet.add(sheetKey);
        }
    }

    const hasSqlResponse = isSqliteMode() && sortedResponses.some(isGroupFillSqlResponse_ACU);
    const nonSqlResponsesInMixedSqlite = getMixedSqliteNonSqlResponses_ACU(sortedResponses);
    if (hasSqlResponse && nonSqlResponsesInMixedSqlite.length > 0) {
        return {
            success: false,
            modifiedKeys: [],
            error: buildMixedSqliteFormatError_ACU(nonSqlResponsesInMixedSqlite),
        };
    }

    const allResponsesAreRuntimeSql = isSqliteMode()
        && sortedResponses.length > 0
        && sortedResponses.every(isGroupFillSqlResponse_ACU);

    if (hasSqlResponse && !allResponsesAreRuntimeSql) {
        return {
            success: false,
            modifiedKeys: [],
            error: 'SQLite 严格模式下 SQL 填表禁止退化为快照写入；请使用 live SQLite runtime 提交或重试本组。',
        };
    }

    if (allResponsesAreRuntimeSql) {
        const operations: TableMutationOperationV2_ACU[] = [];
        const sqlTexts: string[] = [];

        for (const response of sortedResponses) {
            const sqlText = response.tableEditText || '';
            const touchedKeys = getTouchedSheetKeysFromSqlText_ACU(sqlText, baseSnapshot);
            if (Array.isArray(response.job.targetSheetKeys) && response.job.targetSheetKeys.length > 0) {
                const allowedSheetKeys = new Set(response.job.targetSheetKeys);
                const unauthorizedKeys = touchedKeys.filter((sheetKey: string) => !allowedSheetKeys.has(sheetKey));
                if (unauthorizedKeys.length > 0) {
                    return {
                        success: false,
                        modifiedKeys: [],
                        error: `统一提交失败：group ${response.job.groupKey} 越权修改了非目标表 (${unauthorizedKeys.join(', ')})。`,
                    };
                }
            }
            sqlTexts.push(sqlText);
        }

        const commitResult = await runTableUpdateCommit_ACU<{ modifiedKeys: string[] }>({
            source: 'group_fill',
            reason: 'applyUnifiedGroupFillResponses:runtime_sql',
            isolationKey: getCurrentIsolationKey_ACU(),
            writeSet: buildWriteSetForSheetKeys_ACU([...allTargetSheetKeySet], baseSnapshot),
            baseRevision: options.baseRevision,
            initialData: baseSnapshot as any,
            targetMessageIndex: options.saveTargetIndex,
            targetSheetKeys: null,
            updateGroupKeys: null,
            trackingSheetKeys: null,
            trackAsUpdate: true,
            replaceExistingIncremental: options.replaceExistingIncremental,
            manualRefillProgress: options.manualRefillProgress,
            skipChatSave: options.isImportMode,
        }, async () => {
            const provider = await ensureStorageProviderReady_ACU();
            let parseResult: any;
            try {
                parseResult = typeof provider.applyEditsBatch === 'function'
                    ? provider.applyEditsBatch(sqlTexts, options.updateMode)
                    : provider.applyEdits(sqlTexts.join('\n'), options.updateMode);
            } catch (error: any) {
                const rawErrorMessage = error?.message || String(error);
                const failedGroupKey = findSqlFailureGroupKey_ACU(sqlTexts, sortedResponses, rawErrorMessage);
                return {
                    success: false,
                    error: failedGroupKey
                        ? `统一提交失败：group ${failedGroupKey} SQL 执行失败。${rawErrorMessage}`
                        : `统一提交失败：SQL 执行失败。${rawErrorMessage}`,
                };
            }
            if (!parseResult?.success) {
                return {
                    success: false,
                    error: parseResult?.error ? `统一提交失败：SQL 执行失败。${parseResult.error}` : '统一提交失败：SQL 执行失败。',
                };
            }

            const runtimeData = provider.getCurrentData() || currentJsonTableData_ACU || baseSnapshot;
            operations.length = 0;
            sortedResponses.forEach((response, index) => {
                const operationBuild = buildSqlSheetBatchOperationsFromText_ACU(sqlTexts[index] || '', runtimeData, response.job.targetSheetKeys);
                if (operationBuild.success === false) {
                    throw new Error(`统一提交失败：group ${response.job.groupKey} ${operationBuild.error}`);
                }
                operations.push(...operationBuild.operations);
            });
            const parsedModifiedKeys: string[] = Array.isArray(parseResult.modifiedKeys)
                ? parseResult.modifiedKeys.filter((key: unknown): key is string => typeof key === 'string')
                : [];
            const modifiedKeys: string[] = Array.from(new Set<string>(parsedModifiedKeys)).sort();
            const isFirstTimeInit = await checkIfFirstTimeInit_ACU();
            const allRuntimeSheetKeys: string[] = getSortedSheetKeys_ACU(runtimeData);
            const initializedKeys = [...allTargetSheetKeySet]
                .filter(sheetKey => Boolean((runtimeData as any)?.[sheetKey]) && !Boolean((baseSnapshot as any)?.[sheetKey]))
                .sort();
            const keysToSave = isFirstTimeInit
                ? allRuntimeSheetKeys
                : [...new Set([...modifiedKeys, ...initializedKeys])].sort();
            const keysToTrack = [...new Set([...modifiedKeys, ...initializedKeys])].sort();
            const fillAttemptKeys = [...allTargetSheetKeySet]
                .filter(sheetKey => Boolean((runtimeData as any)?.[sheetKey]))
                .sort();
            const revisionWriteSet = modifiedKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));

            return {
                success: true,
                value: { modifiedKeys },
                tableData: runtimeData as any,
                mutationResult: { changes: parseResult.appliedEdits || 0, errors: [] },
                persist: {
                    targetSheetKeys: keysToSave,
                    updateGroupKeys: fillAttemptKeys,
                    trackingSheetKeys: keysToTrack,
                    trackAsUpdate: true,
                    operations,
                    revisionWriteSet,
                },
            };
        });

        if (!commitResult.success || !commitResult.value) {
            _set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(baseSnapshot || {})) as any);
            return { success: false, modifiedKeys: [], error: commitResult.error || '统一提交失败。' };
        }
        if (!options.isImportMode && options.syncAfterCommit !== false && commitResult.tableData) {
            await updateReadableLorebookEntry_ACU(true, false, null, commitResult.tableData);
        }
        return { success: true, modifiedKeys: commitResult.value.modifiedKeys, tableData: commitResult.tableData as any };
    }

    const sqlInitialization = isSqliteMode()
        ? buildSqlInitializationBase_ACU(baseSnapshot, [...allTargetSheetKeySet])
        : { workingTableData: JSON.parse(JSON.stringify(baseSnapshot)), initializedSheetKeys: new Set<string>() };

    let workingTableData = sqlInitialization.workingTableData;
    const initializedSheetKeys = sqlInitialization.initializedSheetKeys;
    const modifiedKeySet = new Set<string>();
    const operations: TableMutationOperationV2_ACU[] = [];

    for (const response of sortedResponses) {
        let parseResult: any;
        if (isSqliteMode() && typeof response.tableEditText === 'string' && isSqlContent(response.tableEditText)) {
            parseResult = await applySqlEditsToTableDataSnapshot_ACU(
                response.tableEditText,
                workingTableData,
                options.updateMode,
                {
                    targetSheetKeys: response.job.targetSheetKeys,
                    requireSheetScopedOperations: true,
                    allowSingleTargetFallback: true,
                },
            );
            if (parseResult?.success && parseResult.workingData) {
                workingTableData = parseResult.workingData;
                if (Array.isArray(parseResult.operations)) operations.push(...parseResult.operations);
            }
        } else {
            parseResult = parseAndApplyTableEditsToData_ACU(response.aiResponse!, workingTableData, options.updateMode, options.isImportMode);
        }
        const parseResultObject = typeof parseResult === 'object' && parseResult !== null ? parseResult : null;
        const parseSuccess = parseResultObject ? parseResultObject.success : !!parseResult;
        const parsedKeys = parseResultObject ? (parseResultObject.modifiedKeys || []) : (response.job?.targetSheetKeys || []);
        const appliedEdits = parseResultObject && typeof parseResultObject.appliedEdits === 'number'
            ? parseResultObject.appliedEdits
            : (Array.isArray(parsedKeys) ? parsedKeys.length : 0);
        const parseError = parseResultObject && typeof parseResultObject.error === 'string'
            ? parseResultObject.error.trim()
            : '';
        if (!parseSuccess) {
            return {
                success: false,
                modifiedKeys: [],
                error: parseError
                    ? `统一提交失败：group ${response.job.groupKey} 解析或应用失败。${parseError}`
                    : `统一提交失败：group ${response.job.groupKey} 解析或应用失败。`,
            };
        }
        if (Array.isArray(response.job.targetSheetKeys) && response.job.targetSheetKeys.length > 0) {
            const allowedSheetKeys = new Set(response.job.targetSheetKeys);
            const unauthorizedKeys = parsedKeys.filter((sheetKey: string) => !allowedSheetKeys.has(sheetKey));
            if (unauthorizedKeys.length > 0) {
                return {
                    success: false,
                    modifiedKeys: [],
                    error: `统一提交失败：group ${response.job.groupKey} 越权修改了非目标表 (${unauthorizedKeys.join(', ')})。`,
                };
            }
        }
        parsedKeys.forEach((sheetKey: string) => modifiedKeySet.add(sheetKey));
    }

    applySpecialIndexSequenceToSummaryTables_ACU(workingTableData);

    const modifiedKeys = [...modifiedKeySet].sort();
    if (!options.isImportMode) {
        const isFirstTimeInit = await checkIfFirstTimeInit_ACU();
        const allUnifiedSheetKeys = getSortedSheetKeys_ACU(workingTableData);
        const initializedKeys = [...initializedSheetKeys].sort();
        const keysToSave = isFirstTimeInit
            ? allUnifiedSheetKeys
            : [...new Set([...modifiedKeys, ...initializedKeys])].sort();
        const keysToTrack = [...new Set([...modifiedKeys, ...initializedKeys])].sort();
        const fillAttemptKeys = [...allTargetSheetKeySet]
            .filter(sheetKey => Boolean((workingTableData as any)?.[sheetKey]))
            .sort();
        const snapshotOperations = buildSheetReplaceOperationsFromData_ACU(workingTableData, keysToSave, 'system');
        const revisionWriteSet = modifiedKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
        const commitResult = await runTableUpdateCommit_ACU<{ modifiedKeys: string[] }>({
            source: 'group_fill',
            reason: 'applyUnifiedGroupFillResponses:snapshot',
            isolationKey: getCurrentIsolationKey_ACU(),
            writeSet: buildWriteSetForSheetKeys_ACU([...allTargetSheetKeySet], baseSnapshot),
            revisionWriteSet,
            baseRevision: options.baseRevision,
            initialData: baseSnapshot as any,
            targetMessageIndex: options.saveTargetIndex,
            targetSheetKeys: keysToSave,
            updateGroupKeys: fillAttemptKeys,
            trackingSheetKeys: keysToTrack,
            trackAsUpdate: true,
            operations: [...operations, ...snapshotOperations],
            replaceExistingIncremental: options.replaceExistingIncremental,
            manualRefillProgress: options.manualRefillProgress,
        }, () => ({
            success: true,
            value: { modifiedKeys },
            tableData: workingTableData as any,
        }));
        if (!commitResult.success) {
            return { success: false, modifiedKeys, error: commitResult.error || '统一提交失败：保存聊天记录失败。' };
        }

        if (options.syncAfterCommit !== false) {
            await updateReadableLorebookEntry_ACU(true, false, null, workingTableData);
            if (getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
                await enqueueSummaryVectorIndexFlush_ACU({ targetMessageIndex: options.saveTargetIndex, mode: 'sync', reason: 'unified_group_fill_complete' });
            }
        }
    }

    return { success: true, modifiedKeys, tableData: workingTableData as any };
}

export async function processGroupedRuntimeChunk_ACU(
    groups: GroupedRuntimeUpdateGroup_ACU[],
    mode: string,
    options: {
        isImportMode?: boolean;
        abortController?: AbortController;
        replaceExistingIncremental?: boolean;
        buildManualRefillProgress?: (bucket: {
            saveTargetIndex: number;
            messageIndices: number[];
            sheetKeys: string[];
            committedBucketCount: number;
        }) => ManualRefillProgressV2_ACU;
        onBucketCommitted?: (bucket: {
            saveTargetIndex: number;
            messageIndices: number[];
            sheetKeys: string[];
            committedBucketCount: number;
        }) => void;
        syncAfterCommit?: boolean;
        onProgress?: (event: CardUpdateProgressEvent) => void;
        respectGlobalStop?: boolean;
    } = {}
): Promise<{ success: boolean; failedGroups: string[]; error?: string; aborted?: boolean; committedBucketCount: number }> {
    if (!Array.isArray(groups) || groups.length === 0) {
        return { success: true, failedGroups: [], committedBucketCount: 0 };
    }

    const migration = await ensureLegacyStorageMigratedBeforeWrite_ACU('processGroupedRuntimeChunk');
    if (!migration.success) {
        return { success: false, failedGroups: groups.map(group => group.key), error: migration.error || '旧存储迁移失败，已阻止本次填表。', committedBucketCount: 0 };
    }
    if (migration.migrated) {
        await reloadStorageProvider();
    }

    const templateForLookup = parseTableTemplateJson_ACU({ stripSeedRows: true });
    const failedGroups = new Set<string>();
    let firstError: string | undefined;
    const transactionBuckets = new Map<string, {
        saveTargetIndex: number;
        batchNumber: number;
        updateMode: string;
        plannedJobs: PlannedGroupedRuntimeJob_ACU[];
    }>();

    for (const group of groups) {
        const batchSize = Math.max(1, Number(group.batchSize) || Number(settings_ACU.updateBatchSize) || 2);
        const groupBatches: number[][] = [];
        for (let i = 0; i < group.indices.length; i += batchSize) {
            groupBatches.push(group.indices.slice(i, i + batchSize));
        }

        for (let i = 0; i < groupBatches.length; i++) {
            const batchIndices = groupBatches[i];
            const batchNumber = i + 1;
            const firstMessageIndexOfBatch = batchIndices[0];
            const lastMessageIndexOfBatch = batchIndices[batchIndices.length - 1];
            const finalSaveTargetIndex = lastMessageIndexOfBatch;

            const updateMode = resolveUpdateMode_ACU(mode);
            const bucketKey = `${finalSaveTargetIndex}|${batchNumber}|${updateMode}|${options.isImportMode === true ? 1 : 0}`;
            const plannedJob: PlannedGroupedRuntimeJob_ACU = {
                group,
                batchNumber,
                firstMessageIndexOfBatch,
                lastMessageIndexOfBatch,
                messageIndices: [...batchIndices],
                saveTargetIndex: finalSaveTargetIndex,
                updateMode,
            };
            const existingBucket = transactionBuckets.get(bucketKey);
            if (existingBucket) {
                existingBucket.plannedJobs.push(plannedJob);
            } else {
                transactionBuckets.set(bucketKey, {
                    saveTargetIndex: finalSaveTargetIndex,
                    batchNumber,
                    updateMode,
                    plannedJobs: [plannedJob],
                });
            }
        }
    }

    const orderedBuckets = [...transactionBuckets.values()].sort((a, b) => a.saveTargetIndex - b.saveTargetIndex || a.batchNumber - b.batchNumber);
    const emitBucketProgress = (bucketIndex: number, event: CardUpdateProgressEvent): void => {
        options.onProgress?.({
            ...event,
            currentBatch: bucketIndex + 1,
            totalBatches: orderedBuckets.length,
        });
    };
    const isStopped = () => options.abortController?.signal.aborted === true || (options.respectGlobalStop !== false && wasStoppedByUser_ACU);
    let committedBucketCount = 0;
    let aborted = false;
    for (let bucketIndex = 0; bucketIndex < orderedBuckets.length; bucketIndex++) {
        if (isStopped()) {
            aborted = true;
            break;
        }
        const bucket = orderedBuckets[bucketIndex];
        const maxBucketRetries = Math.max(1, Number(settings_ACU.tableMaxRetries) || 3);
        let retryUnifiedError: string | null = null;
        let bucketSucceeded = false;

        for (let bucketAttempt = 1; bucketAttempt <= maxBucketRetries; bucketAttempt++) {
            if (isStopped()) {
                aborted = true;
                break;
            }
            const chatHistory = getChatArray_ACU();
            const bucketFirstMessageIndex = Math.min(...bucket.plannedJobs.map(job => job.firstMessageIndexOfBatch));
            const explicitMergeBaseBounds = [...new Set(
                bucket.plannedJobs
                    .map(job => job.group.mergeBaseMaxMessageIndex)
                    .filter((value): value is number => Number.isInteger(value)),
            )];
            if (explicitMergeBaseBounds.length > 1) {
                bucket.plannedJobs.forEach(job => failedGroups.add(job.group.key));
                firstError = firstError || '同一提交批次包含不一致的表格基底边界，已中止以避免重填数据污染。';
                break;
            }
            const latestRuntimeBaseRequested = bucket.plannedJobs.some(job => job.group.useLatestRuntimeMergeBase === true);
            if (latestRuntimeBaseRequested && explicitMergeBaseBounds.length > 0) {
                bucket.plannedJobs.forEach(job => failedGroups.add(job.group.key));
                firstError = firstError || '同一提交批次同时要求最新运行时基底与历史边界基底，已中止以避免重填数据污染。';
                break;
            }
            const allJobsUseLatestRuntimeBase = latestRuntimeBaseRequested
                && bucket.plannedJobs.every(job => job.group.useLatestRuntimeMergeBase === true);
            if (latestRuntimeBaseRequested && !allJobsUseLatestRuntimeBase) {
                bucket.plannedJobs.forEach(job => failedGroups.add(job.group.key));
                firstError = firstError || '同一提交批次混用了最新运行时基底与默认历史边界基底，已中止以避免重填数据污染。';
                break;
            }
            const mergeBaseMaxMessageIndex = explicitMergeBaseBounds.length === 1 ? explicitMergeBaseBounds[0] : bucketFirstMessageIndex - 1;
            const baseResult: { data: Record<string, any> | null; error: string | null } = allJobsUseLatestRuntimeBase
                ? await buildBatchMergeBase_ACU(bucket.batchNumber)
                : await buildBatchMergeBase_ACU(bucket.batchNumber, { maxMessageIndex: mergeBaseMaxMessageIndex });
            if (!baseResult.data) {
                bucket.plannedJobs.forEach(job => failedGroups.add(job.group.key));
                firstError = firstError || baseResult.error || '无法构建合并基底，操作已终止。';
                break;
            }

            const mergedBatchData = baseResult.data;
            _set_currentJsonTableData_ACU(mergedBatchData);
            const baseSnapshot = JSON.parse(JSON.stringify(mergedBatchData));
            const bucketSheetKeys = [...new Set(bucket.plannedJobs.flatMap(job => job.group.sheetKeys || []))].sort();
            const baseRevision = captureTableRuntimeRevisionForWriteSet_ACU(buildWriteSetForSheetKeys_ACU(bucketSheetKeys, baseSnapshot));

            const jobs: GroupFillJob_ACU[] = [];
            for (const plannedJob of bucket.plannedJobs) {
                const isAutoUpdateMode = mode && mode.startsWith('auto');
                const lastAiMessageInBatch = chatHistory[plannedJob.lastMessageIndexOfBatch];
                const lastAiMessageContent = lastAiMessageInBatch?.mes || lastAiMessageInBatch?.message || '';
                const lastAiMessageLength = lastAiMessageContent.length;
                const minReplyLength = settings_ACU.autoUpdateTokenThreshold || 0;
                if (isAutoUpdateMode && lastAiMessageLength < minReplyLength) {
                    continue;
                }

                let sliceStartIndex = plannedJob.firstMessageIndexOfBatch;
                if (sliceStartIndex > 0 && chatHistory[sliceStartIndex - 1]?.is_user) {
                    sliceStartIndex--;
                }
                const messagesForContext = chatHistory.slice(sliceStartIndex, plannedJob.lastMessageIndexOfBatch + 1);
                let effectiveRequestOptions = plannedJob.group.requestOptions || null;
                if (!effectiveRequestOptions?.tableApiPreset && Array.isArray(plannedJob.group.sheetKeys) && plannedJob.group.sheetKeys.length > 0) {
                    const firstTableName = templateForLookup?.[plannedJob.group.sheetKeys[0]]?.name || '';
                    const resolvedPreset = resolveTableApiPresetOverride_ACU(firstTableName);
                    if (resolvedPreset) {
                        effectiveRequestOptions = { ...(effectiveRequestOptions || {}), tableApiPreset: resolvedPreset };
                    }
                }

                jobs.push({
                    groupKey: plannedJob.group.key,
                    groupId: plannedJob.group.groupId,
                    batchNumber: plannedJob.batchNumber,
                    targetSheetKeys: plannedJob.group.sheetKeys,
                    messagesForContext,
                    saveTargetIndex: plannedJob.saveTargetIndex,
                    updateMode: plannedJob.updateMode,
                    requestOptions: effectiveRequestOptions,
                    baseSnapshot,
                    baseRevision,
                    isImportMode: options.isImportMode === true,
                });
            }

            if (jobs.length === 0) {
                bucketSucceeded = true;
                break;
            }

            const collectFeedback = retryUnifiedError ? { lastUnifiedError: retryUnifiedError } : undefined;
            const settledResponses = await Promise.allSettled(jobs.map(job => collectGroupFillResponse_ACU(
                job,
                collectFeedback,
                options.abortController,
                {
                    onProgress: event => emitBucketProgress(bucketIndex, event),
                    respectGlobalStop: options.respectGlobalStop,
                },
            )));
            let responses: GroupFillResponse_ACU[] = [];
            let collectFailed = false;
            let collectError: string | undefined;

            for (let i = 0; i < settledResponses.length; i++) {
                const settledResponse = settledResponses[i];
                if (settledResponse.status === 'rejected') {
                    collectFailed = true;
                    collectError = collectError || (settledResponse.reason instanceof Error ? settledResponse.reason.message : String(settledResponse.reason || 'AI响应收集失败'));
                    continue;
                }
                if (!settledResponse.value.success || settledResponse.value.aborted || !settledResponse.value.aiResponse) {
                    collectFailed = true;
                    collectError = collectError || settledResponse.value.error || settledResponse.value.rawError || 'AI响应收集失败';
                    continue;
                }
                responses.push(settledResponse.value);
            }

            if (collectFailed) {
                jobs.forEach(job => failedGroups.add(job.groupKey));
                firstError = firstError || collectError || 'AI响应收集失败';
                break;
            }

            if (isSqliteMode()) {
                const responseByGroupKey = new Map<string, GroupFillResponse_ACU>();
                responses.forEach(response => responseByGroupKey.set(response.job.groupKey, response));
                let nonSqlResponses = getMixedSqliteNonSqlResponses_ACU(responses);
                let formatError = nonSqlResponses.length > 0 ? buildMixedSqliteFormatError_ACU(nonSqlResponses) : '';
                for (let formatAttempt = 1; nonSqlResponses.length > 0 && formatAttempt < maxBucketRetries; formatAttempt += 1) {
                    emitBucketProgress(bucketIndex, {
                        phase: 'retry',
                        attempt: formatAttempt,
                        maxRetries: maxBucketRetries,
                        message: formatError.substring(0, 50),
                    });
                    const retryJobs = nonSqlResponses.map(response => response.job);
                    const retrySettled = await Promise.allSettled(retryJobs.map(job => collectGroupFillResponse_ACU(
                        job,
                        { lastUnifiedError: formatError },
                        options.abortController,
                        {
                            onProgress: event => emitBucketProgress(bucketIndex, event),
                            respectGlobalStop: options.respectGlobalStop,
                        },
                    )));
                    for (let i = 0; i < retrySettled.length; i++) {
                        const settledResponse = retrySettled[i];
                        if (settledResponse.status === 'fulfilled' && settledResponse.value.success && !settledResponse.value.aborted && settledResponse.value.aiResponse) {
                            responseByGroupKey.set(settledResponse.value.job.groupKey, settledResponse.value);
                        }
                    }
                    responses = jobs
                        .map(job => responseByGroupKey.get(job.groupKey))
                        .filter((response): response is GroupFillResponse_ACU => Boolean(response));
                    nonSqlResponses = getMixedSqliteNonSqlResponses_ACU(responses);
                    formatError = nonSqlResponses.length > 0 ? buildMixedSqliteFormatError_ACU(nonSqlResponses) : '';
                }
                if (nonSqlResponses.length > 0) {
                    nonSqlResponses.forEach(response => failedGroups.add(response.job.groupKey));
                    firstError = firstError || formatError;
                    break;
                }
            }

            if (isStopped()) {
                aborted = true;
                break;
            }
            emitBucketProgress(bucketIndex, { phase: 'saving' });
            const replacementMessageIndices = [...new Set(bucket.plannedJobs.flatMap(job => job.messageIndices))].sort((left, right) => left - right);
            const replacementSheetKeys = [...new Set(bucket.plannedJobs.flatMap(job => job.group.sheetKeys || []))].sort();
            const applyResult = await applyUnifiedGroupFillResponses_ACU(responses, baseSnapshot, {
                saveTargetIndex: bucket.saveTargetIndex,
                updateMode: bucket.updateMode,
                isImportMode: options.isImportMode === true,
                ...(options.replaceExistingIncremental === true ? {
                    replaceExistingIncremental: {
                        targetMessageIndices: replacementMessageIndices,
                        targetSheetKeys: replacementSheetKeys,
                    },
                } : {}),
                ...(options.buildManualRefillProgress ? {
                    manualRefillProgress: options.buildManualRefillProgress({
                        saveTargetIndex: bucket.saveTargetIndex,
                        messageIndices: replacementMessageIndices,
                        sheetKeys: replacementSheetKeys,
                        committedBucketCount,
                    }),
                } : {}),
                syncAfterCommit: options.syncAfterCommit,
                baseRevision,
            });
            if (applyResult.success) {
                const nextCommittedBucketCount = committedBucketCount + 1;
                options.onBucketCommitted?.({
                    saveTargetIndex: bucket.saveTargetIndex,
                    messageIndices: replacementMessageIndices,
                    sheetKeys: replacementSheetKeys,
                    committedBucketCount: nextCommittedBucketCount,
                });
                emitBucketProgress(bucketIndex, { phase: 'complete' });
                bucketSucceeded = true;
                committedBucketCount = nextCommittedBucketCount;
                break;
            }

            retryUnifiedError = applyResult.error || '统一提交失败。';
            if (bucketAttempt >= maxBucketRetries) {
                jobs.forEach(job => failedGroups.add(job.groupKey));
                firstError = firstError || `统一提交在 ${maxBucketRetries} 次尝试后仍失败: ${retryUnifiedError}`;
            } else {
                emitBucketProgress(bucketIndex, {
                    phase: 'retry',
                    attempt: bucketAttempt,
                    maxRetries: maxBucketRetries,
                    message: retryUnifiedError.substring(0, 50),
                });
            }
        }

        if (aborted || (!bucketSucceeded && isStopped())) {
            aborted = true;
            break;
        }
        if (!bucketSucceeded) {
            // 连续前沿模型不允许跨过失败 bucket 继续提交，否则会制造无法自动追平的内部空洞。
            break;
        }
    }

    if (aborted) {
        return { success: false, failedGroups: [...failedGroups], error: '手动更新已终止。', aborted: true, committedBucketCount };
    }
    return failedGroups.size > 0
        ? { success: false, failedGroups: [...failedGroups], error: firstError || '统一提交失败。', committedBucketCount }
        : { success: true, failedGroups: [], committedBucketCount };
}

/**
 * 执行单次卡片更新的核心逻辑（AI调用 + 重试 + 解析 + 保存）
 * 纯业务逻辑，不驱动 UI。通过可选的 onProgress 回调传递纯数据进度事件。
 * presentation 层根据返回值和进度事件自行决定 UI 操作。
 */
export async function executeCardUpdateCore_ACU(
    messagesToUse: any[],
    saveTargetIndex: number,
    isImportMode: boolean,
    updateMode: string,
    isSilentMode: boolean,
    targetSheetKeys: string[] | null,
    requestOptions: Record<string, any> | null,
    abortController: AbortController | null = new AbortController(),
    progressContext: BatchUpdateProgressContext | null = null,
    onProgress?: (event: CardUpdateProgressEvent) => void
): Promise<CardUpdateResult> {
    // 向后兼容：历史调用可能把 onProgress 作为第9参传入
    if (typeof progressContext === 'function' && !onProgress) {
        onProgress = progressContext as unknown as (event: CardUpdateProgressEvent) => void;
        progressContext = null;
    }
    // 兜底保护：若误传了非对象 progressContext，避免读取属性报错
    if (progressContext && typeof progressContext !== 'object') {
        progressContext = null;
    }
    const effectiveAbortController = abortController || new AbortController();

    const emitProgress = (event: CardUpdateProgressEvent): void => {
        onProgress?.({
            ...event,
            ...(progressContext
                ? {
                    currentBatch: progressContext.currentBatch,
                    totalBatches: progressContext.totalBatches,
                }
                : {}),
        });
    };
    let success = false;
    let modifiedKeys: string[] = [];
    const maxRetries = settings_ACU.tableMaxRetries || 3;

    try {
        let lastSqlError: string | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const rawBaseSnapshot = getRuntimeTableDataSnapshot_ACU(progressContext?.batchBaseSnapshot || null) || {};
                const baseRevision = captureTableRuntimeRevisionForWriteSet_ACU(buildWriteSetForSheetKeys_ACU(targetSheetKeys, rawBaseSnapshot));
                const collectResult = await collectGroupFillResponse_ACU({
                    groupKey: `legacy_execute_${saveTargetIndex}`,
                    groupId: 0,
                    batchNumber: progressContext?.currentBatch || 1,
                    targetSheetKeys,
                    messagesForContext: messagesToUse,
                    saveTargetIndex,
                    updateMode,
                    requestOptions,
                    baseSnapshot: rawBaseSnapshot,
                    baseRevision,
                    isImportMode,
                }, { lastSqlError }, effectiveAbortController, { onProgress: emitProgress, maxRetriesOverride: 1 });

                if (collectResult.aborted) {
                    return { success: false, modifiedKeys: [], aborted: true };
                }
                if (!collectResult.success || !collectResult.aiResponse) {
                    throw new Error(collectResult.rawError || collectResult.error || 'AI响应收集失败');
                }

                emitProgress({ phase: 'parsing' });
                const aiResponse = collectResult.aiResponse;

                const isSqlTableEdit = isSqliteMode() && typeof collectResult.tableEditText === 'string' && isSqlContent(collectResult.tableEditText);

                if (isSqlTableEdit) {
                    const writeSet = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0
                        ? targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }))
                        : [{ kind: 'all' as const }];
                    const commitResult = await runTableUpdateCommit_ACU<CardUpdateResult>({
                        source: 'group_fill',
                        reason: 'executeCardUpdateCore',
                        isolationKey: getCurrentIsolationKey_ACU(),
                        writeSet,
                        baseRevision,
                        initialData: rawBaseSnapshot as any,
                        targetMessageIndex: saveTargetIndex,
                        targetSheetKeys: null,
                        updateGroupKeys: null,
                        trackingSheetKeys: null,
                        trackAsUpdate: true,
                        skipChatSave: isImportMode,
                    }, async () => {
                        const provider = await ensureStorageProviderReady_ACU();
                        let parseResult: any;
                        try {
                            parseResult = provider.applyEdits(collectResult.tableEditText || '', updateMode);
                        } catch (error: any) {
                            return { success: false, error: error?.message || String(error) };
                        }
                        const parseSuccess = !!parseResult?.success;
                        const parsedKeys: string[] = Array.isArray(parseResult?.modifiedKeys) ? parseResult.modifiedKeys : [];
                        if (!parseSuccess) {
                            return { success: false, error: parseResult?.error || '解析或应用AI更新时出错' };
                        }

                        const runtimeData = (provider.getCurrentData() || currentJsonTableData_ACU || rawBaseSnapshot) as Record<string, any>;
                        const operationBuild = buildSqlSheetBatchOperationsFromText_ACU(collectResult.tableEditText || '', runtimeData, targetSheetKeys);
                        if (operationBuild.success === false) {
                            return { success: false, error: operationBuild.error };
                        }
                        const operations = operationBuild.operations;
                        applySpecialIndexSequenceToSummaryTables_ACU(runtimeData);

                        if (isImportMode) {
                            emitProgress({ phase: 'chunk_done' });
                            logDebug_ACU('Import mode: skipping save to chat history for this chunk.');
                            return {
                                success: true,
                                value: { success: true, modifiedKeys: parsedKeys },
                                tableData: runtimeData as any,
                                mutationResult: { changes: parseResult.appliedEdits || 0, errors: [] },
                                persist: { revisionWriteSet: parsedKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey })) },
                            };
                        }

                        emitProgress({ phase: 'saving' });
                        let keysToPersist = parsedKeys;
                        if (targetSheetKeys && Array.isArray(targetSheetKeys)) {
                            keysToPersist = keysToPersist.filter((k: string) => targetSheetKeys.includes(k));
                        }

                        const isFirstTimeInit = await checkIfFirstTimeInit_ACU();
                        const hasTargetSheetTracking = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0;
                        const allSheetKeys = getSortedSheetKeys_ACU(runtimeData);
                        const targetTrackingKeys = hasTargetSheetTracking
                            ? targetSheetKeys.filter((sheetKey: string) => Boolean(runtimeData?.[sheetKey]))
                            : [];
                        let keysToActuallySave = keysToPersist;
                        if (isFirstTimeInit) {
                            keysToActuallySave = allSheetKeys;
                            const fullTemplate = parseTableTemplateJson_ACU({ stripSeedRows: false });
                            if (fullTemplate) {
                                allSheetKeys.forEach(sheetKey => {
                                    if (!keysToPersist.includes(sheetKey) && fullTemplate[sheetKey]) {
                                        runtimeData[sheetKey] = JSON.parse(JSON.stringify(fullTemplate[sheetKey]));
                                        logDebug_ACU(`[Init] Table ${sheetKey} not modified by AI, using template data (may include seed rows).`);
                                    }
                                });
                            }
                            logDebug_ACU('[Init] First time initialization detected. Saving complete template structure with all tables.');
                        }
                        const keysToTrackAsUpdated = hasTargetSheetTracking
                            ? keysToPersist.filter((sheetKey: string) => targetTrackingKeys.includes(sheetKey))
                            : keysToPersist.filter((sheetKey: string) => keysToActuallySave.includes(sheetKey));
                        const fillAttemptKeys = hasTargetSheetTracking
                            ? targetTrackingKeys
                            : keysToPersist;
                        const updateGroupKeysToUse = Array.isArray(fillAttemptKeys)
                            ? fillAttemptKeys.filter(sheetKey => {
                                const table = runtimeData?.[sheetKey];
                                if (!table || !isSummaryOrOutlineTable_ACU(table.name)) return true;
                                return keysToTrackAsUpdated.includes(sheetKey);
                            })
                            : fillAttemptKeys;
                        const revisionWriteSet = parsedKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));

                        return {
                            success: true,
                            value: { success: true, modifiedKeys: parsedKeys },
                            tableData: runtimeData as any,
                            mutationResult: { changes: parseResult.appliedEdits || 0, errors: [] },
                            persist: {
                                targetSheetKeys: keysToActuallySave,
                                updateGroupKeys: updateGroupKeysToUse,
                                trackingSheetKeys: keysToTrackAsUpdated,
                                trackAsUpdate: true,
                                operations,
                                revisionWriteSet,
                            },
                        };
                    });

                    if (!commitResult.success || !commitResult.value) {
                        throw new Error(commitResult.error || '解析或应用AI更新时出错');
                    }
                    modifiedKeys = commitResult.value.modifiedKeys;
                    if (!isImportMode && commitResult.tableData) {
                        await updateReadableLorebookEntry_ACU(true, false, null, commitResult.tableData);
                    }
                    success = true;
                    break;
                }

                const writeSet = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0
                    ? targetSheetKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }))
                    : [{ kind: 'all' as const }];
                const updateOutcome = await runTableUpdateCommit_ACU<CardUpdateResult>({
                    source: 'group_fill',
                    reason: 'executeCardUpdateCore:snapshot',
                    isolationKey: getCurrentIsolationKey_ACU(),
                    writeSet,
                    baseRevision,
                    initialData: rawBaseSnapshot as any,
                    targetMessageIndex: saveTargetIndex,
                    targetSheetKeys: null,
                    updateGroupKeys: null,
                    trackingSheetKeys: null,
                    trackAsUpdate: true,
                    skipChatSave: isImportMode,
                }, async ({ workingData }) => {
                    let workingTableData = (workingData || {}) as Record<string, any>;
                    const parseResult: any = parseAndApplyTableEditsToData_ACU(aiResponse, workingTableData, updateMode, isImportMode);

                    let parseSuccess = false;
                    let parsedKeys: string[] = [];

                    if (typeof parseResult === 'object' && parseResult !== null) {
                        parseSuccess = parseResult.success;
                        parsedKeys = parseResult.modifiedKeys || [];
                    } else {
                        parseSuccess = !!parseResult;
                        parsedKeys = targetSheetKeys || [];
                    }

                    if (!parseSuccess) {
                        return { success: false, error: parseResult?.error || '解析或应用AI更新时出错' };
                    }

                    applySpecialIndexSequenceToSummaryTables_ACU(workingTableData);
                    const revisionWriteSet = parsedKeys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
                    if (isImportMode) {
                        emitProgress({ phase: 'chunk_done' });
                        logDebug_ACU("Import mode: skipping save to chat history for this chunk.");
                        return {
                            success: true,
                            value: { success: true, modifiedKeys: parsedKeys },
                            tableData: workingTableData as any,
                            persist: { revisionWriteSet },
                        };
                    }

                    emitProgress({ phase: 'saving' });

                    let keysToPersist = parsedKeys;
                    if (targetSheetKeys && Array.isArray(targetSheetKeys)) {
                        keysToPersist = keysToPersist.filter((k: string) => targetSheetKeys.includes(k));
                    }

                    const isFirstTimeInit = await checkIfFirstTimeInit_ACU();
                    const hasTargetSheetTracking = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0;
                    const allSheetKeys = getSortedSheetKeys_ACU(workingTableData);
                    const targetTrackingKeys = hasTargetSheetTracking
                        ? targetSheetKeys.filter((sheetKey: string) => Boolean(workingTableData?.[sheetKey]))
                        : [];
                    let keysToActuallySave = keysToPersist;
                    if (isFirstTimeInit) {
                        keysToActuallySave = allSheetKeys;

                        const fullTemplate = parseTableTemplateJson_ACU({ stripSeedRows: false });
                        if (fullTemplate) {
                            allSheetKeys.forEach(sheetKey => {
                                if (!keysToPersist.includes(sheetKey) && fullTemplate[sheetKey]) {
                                    workingTableData[sheetKey] = JSON.parse(JSON.stringify(fullTemplate[sheetKey]));
                                    logDebug_ACU(`[Init] Table ${sheetKey} not modified by AI, using template data (may include seed rows).`);
                                }
                            });
                        }

                        logDebug_ACU('[Init] First time initialization detected. Saving complete template structure with all tables.');
                    }

                    if (keysToPersist.length === 0 && !isFirstTimeInit && !hasTargetSheetTracking) {
                        logDebug_ACU("No tables were modified by AI and no target sheets are known; committing runtime view without chat persistence.");
                        return {
                            success: true,
                            value: { success: true, modifiedKeys: parsedKeys },
                            tableData: workingTableData as any,
                            persist: { targetSheetKeys: [], updateGroupKeys: [], trackingSheetKeys: [], trackAsUpdate: false, operations: [], revisionWriteSet },
                        };
                    }

                    const keysToTrackAsUpdated = hasTargetSheetTracking
                        ? keysToPersist.filter((sheetKey: string) => targetTrackingKeys.includes(sheetKey))
                        : keysToPersist.filter((sheetKey: string) => keysToActuallySave.includes(sheetKey));
                    const fillAttemptKeys = hasTargetSheetTracking
                        ? targetTrackingKeys
                        : keysToPersist;
                    const updateGroupKeysToUse = Array.isArray(fillAttemptKeys)
                        ? fillAttemptKeys.filter(sheetKey => {
                            const table = workingTableData?.[sheetKey];
                            if (!table || !isSummaryOrOutlineTable_ACU(table.name)) return true;
                            return keysToTrackAsUpdated.includes(sheetKey);
                        })
                        : fillAttemptKeys;
                    const operations = buildSheetReplaceOperationsFromData_ACU(workingTableData, keysToActuallySave, 'system');

                    return {
                        success: true,
                        value: { success: true, modifiedKeys: parsedKeys },
                        tableData: workingTableData as any,
                        persist: {
                            targetSheetKeys: keysToActuallySave,
                            updateGroupKeys: updateGroupKeysToUse,
                            trackingSheetKeys: keysToTrackAsUpdated,
                            trackAsUpdate: true,
                            operations,
                            revisionWriteSet,
                        },
                    };
                });

                if (!updateOutcome.success || !updateOutcome.value) {
                    return { success: false, modifiedKeys: [], error: updateOutcome.error || '无法将更新后的数据库保存到聊天记录。' };
                }
                modifiedKeys = updateOutcome.value.modifiedKeys;
                if (!isImportMode && updateOutcome.tableData) {
                    await updateReadableLorebookEntry_ACU(true, false, null, updateOutcome.tableData);
                }

                success = true;
                break;

            } catch (error: any) {
                logWarn_ACU(`第 ${attempt} 次尝试失败: ${error.message}`);

                if (isSqliteMode() && error.message) {
                    lastSqlError = error.message;
                }

                if (error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('aborted') || wasStoppedByUser_ACU) {
                    return { success: false, modifiedKeys: [], aborted: true };
                }

                if (attempt < maxRetries) {
                    const waitTime = 5000;
                    logDebug_ACU(`等待 ${waitTime}ms 后重试...`);
                    emitProgress({ phase: 'retry', attempt, maxRetries, message: error.message?.substring(0, 50) });
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                } else {
                    return { success: false, modifiedKeys: [], error: `填表在 ${maxRetries} 次尝试后仍失败: ${error.message}` };
                }
            }
        }

        if (success) {

            emitProgress({ phase: 'complete' });

            if (!isImportMode) {
                try {
                    await loadAllChatMessages_ACU();
                    const boundaryCheckpoint = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'auto_update', save: true });
                    if (!boundaryCheckpoint.success) {
                        logWarn_ACU(`[Auto Update] 自动更新完成，但 AI 楼层边界 checkpoint 建立失败: ${boundaryCheckpoint.error || '未知错误'}`);
                    }
                } catch (checkpointError: any) {
                    logWarn_ACU(
                        `[Auto Update] 自动更新完成，但 AI 楼层边界 checkpoint 建立异常: ${checkpointError?.message || checkpointError}`,
                        checkpointError,
                    );
                }
            }

            // [spv3.6.6] 填表完成后异步触发交火向量索引防抖归档
            // 将 embedding + 归档写入从 saving 阶段移到 complete 之后，
            // 避免 embedding API 调用阻塞"正在保存"提示框。
            // 使用 flush queue 替代直接调用，由防抖定时器统一调度。
            // [spv3.6.9] 增加诊断日志，记录入队结果（queued/skipped）
            if (!isImportMode && success && getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
                enqueueSummaryVectorIndexFlush_ACU({
                    targetMessageIndex: saveTargetIndex,
                    mode: 'sync',
                    reason: 'table_fill_complete',
                }).then(result => {
                    if (result.skipped) {
                        logWarn_ACU(`[交火模式纪要索引] 填表完成后防抖归档被跳过：${result.reason || 'unknown'}, scopeKey=${result.scopeKey || ''}`);
                    } else if (result.queued) {
                        logDebug_ACU(`[交火模式纪要索引] 填表完成后已入队防抖归档, scopeKey=${result.scopeKey}, debounceUntil=${result.debounceUntil}`);
                    }
                }).catch(err => {
                    logWarn_ACU('[交火模式纪要索引] 填表完成后防抖归档入队异常:', err);
                });
            }

        }
        return { success, modifiedKeys };

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logDebug_ACU('Fetch request was aborted by the user.');
            return { success: false, modifiedKeys: [], aborted: true };
        } else {
            logError_ACU(`数据库增量更新流程失败: ${error.message}`);
            return { success: false, modifiedKeys: [], error: error.message };
        }
    }
}

/**
 * 批处理更新编排（纯业务逻辑）
 * 从 processUpdates_ACU 提取。不驱动 UI，只返回结果。
 */
export async function processUpdatesBatch_ACU(
    indicesToUpdate: number[],
    mode: string,
    options: any,
    executeUpdate: (
        messagesToUse: any[],
        saveTargetIndex: number,
        updateMode: string,
        isSilentMode: boolean,
        targetSheetKeys: string[] | null,
        requestOptions: Record<string, any> | null,
        progressContext: BatchUpdateProgressContext
    ) => Promise<CardUpdateResult>
): Promise<BatchUpdateResult> {
    if (!indicesToUpdate || indicesToUpdate.length === 0) {
        return { success: true };
    }

    const { targetSheetKeys, batchSize: specificBatchSize, requestOptions } = options;

    const migration = await ensureLegacyStorageMigratedBeforeWrite_ACU('processUpdatesBatch');
    if (!migration.success) {
        return { success: false, error: migration.error || '旧存储迁移失败，已阻止本次填表。' };
    }
    if (migration.migrated) {
        await reloadStorageProvider();
    }

    _set_wasStoppedByUser_ACU(false);
    _set_isAutoUpdatingCard_ACU(true);

    try {
        const isSummaryMode = (mode && (mode.includes('summary') || mode === 'manual_summary')) || false;
        const batchSize = specificBatchSize || (settings_ACU.updateBatchSize || 2);

        const batches: number[][] = [];
        for (let i = 0; i < indicesToUpdate.length; i += batchSize) {
            batches.push(indicesToUpdate.slice(i, i + batchSize));
        }

        logDebug_ACU(`[${mode}] Processing ${indicesToUpdate.length} updates in ${batches.length} batches of size ${batchSize} (${isSummaryMode ? '总结表模式' : '标准表模式'}). Target Sheets: ${targetSheetKeys ? targetSheetKeys.length : 'All'}`);

        const chatHistory = getChatArray_ACU();
        const isAutoUpdateMode = mode && mode.startsWith('auto');
        const isSilentMode = !!(isAutoUpdateMode && settings_ACU.toastMuteEnabled);

        for (let i = 0; i < batches.length; i++) {
            const batchIndices = batches[i];
            const batchNumber = i + 1;
            const firstMessageIndexOfBatch = batchIndices[0];
            const lastMessageIndexOfBatch = batchIndices[batchIndices.length - 1];
            const finalSaveTargetIndex = lastMessageIndexOfBatch;

            // 构建合并基底
            const baseResult = await buildBatchMergeBase_ACU(batchNumber, { maxMessageIndex: firstMessageIndexOfBatch - 1 });
            if (!baseResult.data) {
                return { success: false, failedBatch: batchNumber, error: baseResult.error || '无法构建合并基底，操作已终止。' };
            }
            const mergedBatchData = baseResult.data;

            const batchSheetKeys = getSortedSheetKeys_ACU(mergedBatchData);
            const batchIsolationKey = getCurrentIsolationKey_ACU();

            // 加载历史数据
            const loadResult = loadBatchBaseData_ACU(chatHistory, firstMessageIndexOfBatch, batchIsolationKey, batchSheetKeys, mergedBatchData);
            _set_currentJsonTableData_ACU(mergedBatchData);
            logDebug_ACU(`[Batch ${batchNumber}] Loaded ${loadResult.foundCount}/${loadResult.totalCount} tables from history before index ${firstMessageIndexOfBatch}. Missing tables will use template structure (header-only).`);

            // 计算上下文范围
            let sliceStartIndex = firstMessageIndexOfBatch;
            if (sliceStartIndex > 0 && chatHistory[sliceStartIndex - 1]?.is_user) {
                sliceStartIndex--;
                logDebug_ACU(`[Batch ${batchNumber}] Adjusted slice start to ${sliceStartIndex} to include preceding user message.`);
            }
            const messagesForContext = chatHistory.slice(sliceStartIndex, lastMessageIndexOfBatch + 1);

            // 检查最新AI回复长度阈值
            const lastAiMessageInBatch = chatHistory[lastMessageIndexOfBatch];
            const lastAiMessageContent = lastAiMessageInBatch?.mes || lastAiMessageInBatch?.message || '';
            const lastAiMessageLength = lastAiMessageContent.length;
            const minReplyLength = settings_ACU.autoUpdateTokenThreshold || 0;

            if (isAutoUpdateMode && lastAiMessageLength < minReplyLength) {
                logDebug_ACU(`[Auto] Batch ${batchNumber}/${batches.length} skipped: Last AI reply length (${lastAiMessageLength}) is below threshold (${minReplyLength}).`);
                continue;
            }

            // 确定更新模式
            const updateMode = resolveUpdateMode_ACU(mode);

            // 决议 effective API preset：如果调用方未指定 tableApiPreset，
            // 则以 targetSheetKeys 中第一个表名为准查覆盖映射
            let effectiveRequestOptions = requestOptions;
            if (!effectiveRequestOptions?.tableApiPreset && targetSheetKeys && targetSheetKeys.length > 0) {
                const templateForLookup = parseTableTemplateJson_ACU({ stripSeedRows: true });
                const firstTableName = templateForLookup?.[targetSheetKeys[0]]?.name || '';
                const resolvedPreset = resolveTableApiPresetOverride_ACU(firstTableName);
                if (resolvedPreset) {
                    effectiveRequestOptions = { ...(effectiveRequestOptions || {}), tableApiPreset: resolvedPreset };
                }
            }

            const result = await executeUpdate(
                messagesForContext,
                finalSaveTargetIndex,
                updateMode,
                isSilentMode,
                targetSheetKeys,
                effectiveRequestOptions,
                {
                    currentBatch: batchNumber,
                    totalBatches: batches.length,
                    batchBaseSnapshot: JSON.parse(JSON.stringify(mergedBatchData)),
                }
            );

            if (!result.success) {
                return { success: false, failedBatch: batchNumber, error: result.error || `批处理在第 ${batchNumber} 批时失败或被终止。` };
            }
        }

        return { success: true };
    } finally {
        _set_isAutoUpdatingCard_ACU(false);
        _set_wasStoppedByUser_ACU(false);
    }
}

function collectEffectiveAiMessageIndices_ACU(chat: any[]): number[] {
    const allAiMessageIndices = chat
        .map((message: any, index: number) => !message?.is_user ? index : -1)
        .filter((index: number) => index >= 0);
    const skipped = Math.max(0, Math.trunc(Number(settings_ACU.skipUpdateFloors) || 0));
    return skipped > 0 ? allAiMessageIndices.slice(0, -skipped) : allAiMessageIndices;
}

function createManualCatchUpRunId_ACU(): string {
    return `manual-catch-up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function countCatchUpChunkBuckets_ACU(groups: ManualCatchUpPlan_ACU['waves'][number]['groups'], messageIndices: number[]): number {
    const bucketKeys = new Set<string>();
    groups.forEach(group => {
        const batchSize = Math.max(1, Math.trunc(Number(group.batchSize) || 1));
        for (let offset = 0, batchNumber = 1; offset < messageIndices.length; offset += batchSize, batchNumber += 1) {
            const batchIndices = messageIndices.slice(offset, offset + batchSize);
            const saveTargetIndex = batchIndices[batchIndices.length - 1];
            bucketKeys.add(`${saveTargetIndex}|${batchNumber}|${group.updateMode}`);
        }
    });
    return bucketKeys.size;
}

/**
 * 从聊天中的已提交事实生成 catch-up 计划，不调用 AI、不写入数据。
 * 调用方可用于确认展示；真正执行时必须重新规划，以吸收确认期间的提交变化。
 */
export async function prepareManualCatchUpPlan_ACU(targetKeys: string[]): Promise<ManualCatchUpPlanningResult_ACU> {
    if (!Array.isArray(targetKeys) || targetKeys.length === 0) {
        return { success: false, error: '未选择需要追平的表格。' };
    }

    await loadAllChatMessages_ACU();
    const chat = getChatArray_ACU();
    if (!Array.isArray(chat) || chat.length === 0) {
        return { success: false, error: '聊天记录为空，无法执行追平。' };
    }

    const templateData = parseTableTemplateJson_ACU({ stripSeedRows: true }) || {};
    const selectedSheetKeys = [...new Set(targetKeys.filter(key =>
        typeof key === 'string'
        && key.startsWith('sheet_')
        && Boolean(templateData[key] || currentJsonTableData_ACU?.[key])
    ))].sort();
    if (selectedSheetKeys.length === 0) {
        return { success: false, error: '未找到可追平的已选表格。' };
    }

    const effectiveAiMessageIndices = collectEffectiveAiMessageIndices_ACU(chat);
    const isolationKey = getCurrentIsolationKey_ACU();
    const plan = planManualCatchUpWaves_ACU(effectiveAiMessageIndices, selectedSheetKeys.map(sheetKey => {
        const sheet = templateData[sheetKey] || currentJsonTableData_ACU?.[sheetKey] || {};
        const history = resolveTableHistoryStateFromChat_ACU(chat, {
            sheetKey,
            isSummaryTable: isSummaryOrOutlineTable_ACU(String(sheet.name || '')),
            isolationKey,
            settings: settings_ACU,
        });
        const updateConfig = sheet.updateConfig || {};
        const groupId = Number.isFinite(updateConfig.groupId) ? Math.trunc(updateConfig.groupId) : -1;
        const preset = resolveTableApiPresetOverride_ACU(sheet.name);
        return {
            sheetKey,
            lastCompletedAiFloor: history.lastTrackedUpdateAiFloor,
            groupId,
            batchSize: Math.max(1, Math.trunc(Number(settings_ACU.updateBatchSize) || 1)),
            requestOptions: preset ? { tableApiPreset: preset } : null,
            updateMode: 'manual_independent',
            executionKind: isSqliteMode() ? 'sql' as const : 'standard' as const,
        };
    }));

    return { success: true, plan };
}

/**
 * 按聊天中已提交的 scheduleSummary/事件事实规划并执行所选表的后缀追平。
 * 不扫描或声称修复历史内部空洞；一期只处理每表连续前沿后的缺口。
 */
export async function orchestrateManualCatchUp_ACU(
    targetKeys: string[],
    refreshData: () => Promise<{ degraded?: boolean } | void>,
    options: {
        abortController?: AbortController;
        onProgress?: (event: CardUpdateProgressEvent) => void;
    } = {},
): Promise<ManualUpdateResult> {
    if (isAutoUpdatingCard_ACU) {
        return { success: false, error: '数据库更新正在进行中，请稍候。' };
    }
    if (!coreApisAreReady_ACU) {
        return { success: false, error: 'API未就绪。' };
    }
    const planningResult = await prepareManualCatchUpPlan_ACU(targetKeys);
    if (!planningResult.success || !planningResult.plan) {
        return { success: false, error: planningResult.error || '无法生成手动追平计划。' };
    }
    const plan = planningResult.plan;
    const selectedSheetKeys = [...new Set(plan.waves.flatMap(wave => wave.sheetKeys))].sort();

    if (plan.waves.length === 0) {
        return { success: true, outcome: 'no_work', catchUpPlan: plan, committedBucketCount: 0 };
    }

    const maxConcurrentGroups = Math.max(1, Math.trunc(Number(settings_ACU.maxConcurrentGroups) || 1));
    const totalBuckets = plan.waves.reduce((count, wave) => {
        let waveBuckets = 0;
        for (let start = 0; start < wave.groups.length; start += maxConcurrentGroups) {
            waveBuckets += countCatchUpChunkBuckets_ACU(wave.groups.slice(start, start + maxConcurrentGroups), wave.messageIndices);
        }
        return count + waveBuckets;
    }, 0);
    const runId = createManualCatchUpRunId_ACU();
    let committedBucketCount = 0;
    let activeWaveIndex = 0;
    const completedSheetMessageIndexByKey: Record<string, number> = {};
    const allContextMessageIndices = [...new Set(plan.waves.flatMap(wave => wave.messageIndices))].sort((left, right) => left - right);
    const originalStartMessageIndex = plan.waves[0]?.messageIndices[0] ?? plan.targetMessageIndex ?? 0;
    const terminalTargetMessageIndex = plan.targetMessageIndex ?? allContextMessageIndices[allContextMessageIndices.length - 1] ?? 0;
    const catchUpBatchSize = Math.max(1, ...plan.waves.flatMap(wave => wave.groups.map(group => group.batchSize)));
    const buildCatchUpProgress = (
        status: ManualRefillProgressV2_ACU['status'],
        lastError?: string,
    ): ManualRefillProgressV2_ACU => {
        const completedMessageIndices = Object.values(completedSheetMessageIndexByKey);
        return {
            kind: 'manual_refill',
            version: 2,
            status,
            selectedSheetKeys,
            contextMessageIndices: allContextMessageIndices,
            originalStartMessageIndex,
            targetMessageIndex: terminalTargetMessageIndex,
            batchSize: catchUpBatchSize,
            completedUntilMessageIndex: completedMessageIndices.length > 0
                ? Math.max(...completedMessageIndices)
                : Math.max(0, originalStartMessageIndex - 1),
            completedSheetMessageIndexByKey: { ...completedSheetMessageIndexByKey },
            runId,
            mode: 'catch_up',
            targetAiFloor: plan.targetAiFloor,
            planSignature: plan.planSignature,
            waveIndex: Math.min(activeWaveIndex, Math.max(0, plan.waves.length - 1)),
            bucketIndex: Math.max(0, committedBucketCount - 1),
            totalWaves: plan.waves.length,
            totalBuckets,
            ...(lastError ? { lastError } : {}),
            updatedAt: Date.now(),
        };
    };
    const persistCatchUpTerminalProgress = async (
        status: 'complete' | 'stopped' | 'failed' | 'sync_pending',
        lastError?: string,
    ): Promise<string | undefined> => {
        try {
            const progress = buildCatchUpProgress(status, lastError);
            const commitResult = await runTableUpdateCommit_ACU({
                source: 'manual_fill',
                reason: `orchestrateManualCatchUp:terminal:${status}`,
                isolationKey: getCurrentIsolationKey_ACU(),
                writeSet: buildWriteSetForSheetKeys_ACU(selectedSheetKeys, currentJsonTableData_ACU),
                revisionWriteSet: [],
                initialData: currentJsonTableData_ACU,
                targetMessageIndex: terminalTargetMessageIndex,
                targetSheetKeys: [],
                updateGroupKeys: [],
                trackingSheetKeys: [],
                trackAsUpdate: false,
                operations: [],
                manualRefillProgress: progress,
                strictSave: true,
            }, ({ workingData }) => ({
                success: true,
                tableData: workingData || currentJsonTableData_ACU,
            }));
            return commitResult.success ? undefined : (commitResult.error || `手动追平终态 ${status} 保存失败。`);
        } catch (error: any) {
            return error?.message || String(error || `手动追平终态 ${status} 保存异常。`);
        }
    };
    const refreshCommittedDataBeforeExit = async (): Promise<void> => {
        if (committedBucketCount <= 0) return;
        try {
            await refreshData();
        } catch (error) {
            logWarn_ACU('[手动追平] 已提交 bucket 保留成功，但失败/终止后的最终刷新未完成。', error);
        }
    };
    _set_isAutoUpdatingCard_ACU(true);

    try {
        for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
            activeWaveIndex = waveIndex;
            if (options.abortController?.signal.aborted) {
                const terminalError = await persistCatchUpTerminalProgress('stopped', '手动追平已终止。');
                await refreshCommittedDataBeforeExit();
                return {
                    success: false, outcome: 'stopped',
                    error: terminalError ? `手动追平已终止；终态进度保存失败：${terminalError}` : '手动追平已终止。',
                    committedBucketCount, catchUpPlan: plan,
                };
            }
            const wave = plan.waves[waveIndex];
            for (let groupStart = 0; groupStart < wave.groups.length; groupStart += maxConcurrentGroups) {
                if (options.abortController?.signal.aborted) {
                    const terminalError = await persistCatchUpTerminalProgress('stopped', '手动追平已终止。');
                    await refreshCommittedDataBeforeExit();
                    return {
                        success: false, outcome: 'stopped',
                        error: terminalError ? `手动追平已终止；终态进度保存失败：${terminalError}` : '手动追平已终止。',
                        committedBucketCount, catchUpPlan: plan,
                    };
                }
                const groupChunk = wave.groups.slice(groupStart, groupStart + maxConcurrentGroups);
                const groups: GroupedRuntimeUpdateGroup_ACU[] = groupChunk.map(group => ({
                    key: group.key,
                    groupId: group.groupId,
                    indices: [...wave.messageIndices],
                    batchSize: group.batchSize,
                    sheetKeys: [...group.sheetKeys],
                    requestOptions: group.requestOptions,
                    mergeBaseMaxMessageIndex: wave.messageIndices[0] - 1,
                }));
                const result = await processGroupedRuntimeChunk_ACU(groups, 'manual_independent', {
                    abortController: options.abortController,
                    respectGlobalStop: false,
                    replaceExistingIncremental: true,
                    syncAfterCommit: false,
                    onProgress: event => options.onProgress?.({
                        ...event,
                        currentBatch: committedBucketCount + (event.currentBatch || 1),
                        totalBatches: totalBuckets,
                    }),
                    buildManualRefillProgress: bucket => {
                        const nextCompletedSheetMessageIndexByKey = { ...completedSheetMessageIndexByKey };
                        bucket.sheetKeys.forEach(sheetKey => {
                            nextCompletedSheetMessageIndexByKey[sheetKey] = bucket.saveTargetIndex;
                        });
                        return {
                            kind: 'manual_refill',
                            version: 2,
                            status: 'committed',
                            selectedSheetKeys,
                            contextMessageIndices: [...wave.messageIndices],
                            originalStartMessageIndex: wave.messageIndices[0],
                            targetMessageIndex: plan.targetMessageIndex ?? bucket.saveTargetIndex,
                            batchSize: Math.max(...wave.groups.map(group => group.batchSize)),
                            completedUntilMessageIndex: bucket.saveTargetIndex,
                            completedSheetMessageIndexByKey: nextCompletedSheetMessageIndexByKey,
                            runId,
                            mode: 'catch_up',
                            targetAiFloor: plan.targetAiFloor,
                            planSignature: plan.planSignature,
                            waveIndex,
                            bucketIndex: committedBucketCount + bucket.committedBucketCount,
                            totalWaves: plan.waves.length,
                            totalBuckets,
                            updatedAt: Date.now(),
                        };
                    },
                    onBucketCommitted: bucket => {
                        bucket.sheetKeys.forEach(sheetKey => {
                            completedSheetMessageIndexByKey[sheetKey] = bucket.saveTargetIndex;
                        });
                    },
                });
                committedBucketCount += result.committedBucketCount;
                if (!result.success) {
                    const outcome = result.aborted ? 'stopped' : undefined;
                    const primaryError = result.error || (result.aborted ? '手动追平已终止。' : '手动追平失败。');
                    const terminalError = await persistCatchUpTerminalProgress(result.aborted ? 'stopped' : 'failed', primaryError);
                    await refreshCommittedDataBeforeExit();
                    return {
                        success: false,
                        outcome,
                        error: terminalError ? `${primaryError}；终态进度保存失败：${terminalError}` : primaryError,
                        committedBucketCount,
                        catchUpPlan: plan,
                    };
                }
            }
            await loadAllChatMessages_ACU();
        }

        const refreshResult = await refreshData();
        if (refreshResult && refreshResult.degraded === true) {
            const terminalError = await persistCatchUpTerminalProgress('sync_pending');
            if (terminalError) {
                return {
                    success: false,
                    error: `手动追平数据已提交且世界书同步待重试，但终态进度保存失败：${terminalError}`,
                    committedBucketCount,
                    catchUpPlan: plan,
                };
            }
            return {
                success: true,
                outcome: 'sync_pending',
                committedBucketCount,
                catchUpPlan: plan,
            };
        }
        const terminalError = await persistCatchUpTerminalProgress('complete');
        if (terminalError) {
            return {
                success: false,
                error: `手动追平数据与世界书同步已完成，但终态进度保存失败：${terminalError}`,
                committedBucketCount,
                catchUpPlan: plan,
            };
        }
        return { success: true, outcome: 'complete', committedBucketCount, catchUpPlan: plan };
    } catch (error: any) {
        const primaryError = error?.message || String(error || '手动追平执行异常。');
        const terminalError = await persistCatchUpTerminalProgress('failed', primaryError);
        await refreshCommittedDataBeforeExit();
        return {
            success: false,
            error: terminalError ? `${primaryError}；终态进度保存失败：${terminalError}` : primaryError,
            committedBucketCount,
            catchUpPlan: plan,
        };
    } finally {
        _set_isAutoUpdatingCard_ACU(false);
    }
}

/**
 * 手动更新编排（纯业务逻辑）
 * 从 handleManualUpdate_ACU 提取。不驱动 UI，只返回结果。
 * presentation 层负责：收集 manualSelection、设置 manualExtraHint、刷新 UI、显示 toast、弹出确认框。
 *
 * @param targetKeys 手动选择的目标表格键列表
 * @param processBatch 批处理执行回调
 * @param refreshData 数据刷新回调
 * @param options 可选参数：
 *   - clearBeforeUpdate: 兼容旧调用名；启用事务式手动重填。普通可回放路径按 bucket 原子替换历史增量；仅跨 checkpoint 特例会预清理并等待最终 snapshot。
 */
export async function orchestrateManualUpdate_ACU(
    targetKeys: string[],
    processBatch: (indices: number[], mode: string, options: any) => Promise<BatchUpdateResult>,
    refreshData: () => Promise<void>,
    options: {
        clearBeforeUpdate?: boolean;
        confirmBoundaryReset?: boolean;
        onProgress?: (event: CardUpdateProgressEvent) => void;
    } = {},
): Promise<ManualUpdateResult> {
    let manualRefillSessionSnapshot: ReturnType<typeof captureManualRefillSessionSnapshot_ACU> | null = null;
    let manualRefillRollbackAttempted = false;
    let manualRefillRequiresFinalSnapshot = false;
    let committedBucketCount = 0;
    const rollbackManualRefillSession = async (): Promise<string | undefined> => {
        if (!manualRefillRequiresFinalSnapshot && committedBucketCount > 0) return undefined;
        if (!manualRefillSessionSnapshot || manualRefillRollbackAttempted) return undefined;
        manualRefillRollbackAttempted = true;
        try {
            await restoreManualRefillSessionSnapshotAtomic_ACU(
                manualRefillSessionSnapshot,
                getCurrentIsolationKey_ACU(),
                targetKeys,
            );
            await loadAllChatMessages_ACU();
            await refreshData();
            return undefined;
        } catch (error: any) {
            const rollbackError = error?.message || String(error || '未知回滚错误');
            logError_ACU('[Manual Refill] 手动重填会话回滚失败:', error);
            return rollbackError;
        }
    };
    const failManualRefillSession = async (failureError: string): Promise<ManualUpdateResult> => {
        const rollbackError = await rollbackManualRefillSession();
        if (!rollbackError && (!manualRefillRequiresFinalSnapshot && committedBucketCount > 0)) {
            try {
                await loadAllChatMessages_ACU();
                await refreshData();
            } catch (refreshError) {
                logWarn_ACU('[Manual Refill] 已提交 bucket 后刷新运行时数据失败:', refreshError);
            }
        }
        return {
            success: false,
            error: rollbackError ? `${failureError}；回滚失败：${rollbackError}` : failureError,
        };
    };
    try {
        if (isAutoUpdatingCard_ACU) {
            return { success: false, error: '数据库更新正在进行中，请稍候...' };
        }

        if (!coreApisAreReady_ACU) {
            return { success: false, error: 'API未就绪。' };
        }

        const apiIsConfigured = (settings_ACU.apiMode === 'custom' && (settings_ACU.apiConfig.useMainApi || (settings_ACU.apiConfig.url && settings_ACU.apiConfig.model))) || (settings_ACU.apiMode === 'tavern' && settings_ACU.tavernProfile);
        if (!apiIsConfigured) {
            return { success: false, error: 'API未配置，无法更新数据库。' };
        }

        await loadAllChatMessages_ACU();
        await refreshData();

        if (!currentJsonTableData_ACU) {
            return { success: false, error: '数据库未加载。' };
        }
        const liveChat = getChatArray_ACU();
        if (!liveChat || liveChat.length === 0) {
            return { success: false, error: '聊天记录为空，无法更新。' };
        }

        const allAiMessageIndices = liveChat
            .map((msg: any, index: number) => !msg.is_user ? index : -1)
            .filter((index: number) => index !== -1);

        if (allAiMessageIndices.length === 0) {
            return { success: false, error: '尚未检测到AI回复，无法执行手动更新。' };
        }

        if (!targetKeys.length) {
            return { success: false, error: '未选择需要更新的表格。' };
        }

        const uiThreshold = settings_ACU.autoUpdateThreshold || 3;
        const uiBatchSize = settings_ACU.updateBatchSize || 3;
        const uiSkip = settings_ACU.skipUpdateFloors || 0;

        const effectiveAiIndices = uiSkip > 0 ? allAiMessageIndices.slice(0, -uiSkip) : allAiMessageIndices.slice();
        const contextScopeIndices = uiThreshold > 0 ? effectiveAiIndices.slice(-uiThreshold) : effectiveAiIndices;

        if (!contextScopeIndices.length) {
            return { success: false, error: '未找到可用的上下文进行手动更新，请检查阈值或跳过楼层设置。' };
        }

        const templateData = parseTableTemplateJson_ACU({ stripSeedRows: true }) || {};
        const updateGroups: Record<string, ManualRuntimeUpdateGroup_ACU> = {};
        targetKeys.forEach((sheetKey: string) => {
            const tableConfig = templateData?.[sheetKey]?.updateConfig || {};
            const tableName = templateData?.[sheetKey]?.name || currentJsonTableData_ACU?.[sheetKey]?.name || '';
            const resolvedPreset = resolveTableApiPresetOverride_ACU(tableName);
            const requestOptions = resolvedPreset ? { tableApiPreset: resolvedPreset } : null;
            const tableGroupId = Number.isFinite(tableConfig?.groupId)
                ? Math.trunc(tableConfig.groupId)
                : -1;
            // updateFrequency/contextDepth/skipFloors 属于自动更新调度参数，不进入手动路径；
            // API preset 属于请求执行契约，不同 preset 必须拆组，禁止静默采用第一张表配置。
            const groupKey = `${tableGroupId}|${contextScopeIndices.join(',')}|${uiBatchSize}|${JSON.stringify(requestOptions)}`;
            if (!updateGroups[groupKey]) {
                updateGroups[groupKey] = {
                    indices: contextScopeIndices,
                    batchSize: uiBatchSize,
                    groupId: tableGroupId,
                    sheetKeys: [],
                    requestOptions,
                };
            }
            updateGroups[groupKey].sheetKeys.push(sheetKey);
        });
        const groupKeys = Object.keys(updateGroups);

        const manualRefillEnabled = options.clearBeforeUpdate === true;
        const lastEffectiveAiIndex = effectiveAiIndices[effectiveAiIndices.length - 1];
        const manualRefillUsesLatestRuntimeBase = manualRefillEnabled && uiSkip === 0 && contextScopeIndices[contextScopeIndices.length - 1] === lastEffectiveAiIndex;
        const manualRefillMergeBaseMaxMessageIndex = manualRefillEnabled && !manualRefillUsesLatestRuntimeBase ? contextScopeIndices[0] - 1 : undefined;
        if (manualRefillEnabled) {
            const currentIsolationKey = getCurrentIsolationKey_ACU();
            const rollbackMessageIndices = collectManualRefillRollbackMessageIndices_ACU(liveChat, currentIsolationKey, contextScopeIndices);
            manualRefillSessionSnapshot = captureManualRefillSessionSnapshot_ACU(rollbackMessageIndices);

            const initialBaseline = buildGuideOrTemplateMergeBase_ACU(0);
            if (!initialBaseline.data) {
                return await failManualRefillSession(initialBaseline.error || '手动重填无法从当前表格指导或模板构造临时基底。');
            }
            const baselineResult = await ensureManualRefillInitialBaseline_ACU({
                isolationKey: currentIsolationKey,
                targetMessageIndex: contextScopeIndices[0],
                data: initialBaseline.data,
                save: true,
            });
            if (!baselineResult.success) {
                return await failManualRefillSession(baselineResult.error || '手动重填临时基底建立失败。');
            }
            if (baselineResult.changed) {
                logDebug_ACU(`[Manual Refill] 已将 initial baseline 从 AI 楼层 #${baselineResult.movedFromMessageIndex} 前移到重填边界 #${baselineResult.targetMessageIndex}。`);
            }

            const replayBoundaryCheck = await ensureManualRefillV2ReplayBoundary_ACU(liveChat, currentIsolationKey, contextScopeIndices[0]);
            if (replayBoundaryCheck.success === false) {
                if (replayBoundaryCheck.code !== 'no_full_checkpoint_replayable') {
                    return await failManualRefillSession(replayBoundaryCheck.error);
                }

                if (options.confirmBoundaryReset !== true) {
                    const rollbackError = await rollbackManualRefillSession();
                    if (rollbackError) {
                        return { success: false, error: `${replayBoundaryCheck.error}；临时基底回滚失败：${rollbackError}` };
                    }
                    return {
                        success: false,
                        requiresUserConfirmation: {
                            reason: 'manual_refill_replace_sheet_baseline',
                            replayErrorCode: replayBoundaryCheck.code,
                            message: replayBoundaryCheck.error,
                            contextScopeIndices: [...contextScopeIndices],
                            targetSheetKeys: [...targetKeys],
                        },
                    };
                }

                try {
                    // 重填起点之前没有可回放的目标表基底时，bounded merge base 只能是指导表/模板。
                    // 模板只能服务本轮 prompt，绝不能提前写成 sheet_full；它会在重入时整表覆盖历史。
                    await clearManualRefillSheetDataInRange_ACU(contextScopeIndices, targetKeys);
                } catch (error: any) {
                    logError_ACU('[Manual Refill] 确认后清理选中表旧数据失败:', error);
                    const rollbackError = await rollbackManualRefillSession();
                    const failureError = error?.message || '手动重填确认后清理选中表旧数据失败。';
                    return { success: false, error: rollbackError ? `${failureError}；回滚失败：${rollbackError}` : failureError };
                }
                manualRefillRequiresFinalSnapshot = true;
                logWarn_ACU(`[Manual Refill] ${replayBoundaryCheck.error} 用户已确认手动重填，已清理本次范围内选中表旧数据；将在全部重填成功后提交完整单表 checkpoint。`);
            } else {
                logDebug_ACU('[Manual Refill] 可回放重填不再预清理完整范围；每个 bucket 将在自身严格提交中替换对应历史增量。');
            }

            if (manualRefillRequiresFinalSnapshot) {
                try {
                    await reloadStorageProvider();
                } catch (error: any) {
                    logError_ACU('[Manual Refill] 清理后刷新运行时快照失败:', error);
                    const rollbackError = await rollbackManualRefillSession();
                    const failureError = error?.message || '手动重填清理后刷新运行时快照失败。';
                    return { success: false, error: rollbackError ? `${failureError}；回滚失败：${rollbackError}` : failureError };
                }
            }
            if (!manualRefillUsesLatestRuntimeBase) {
                logDebug_ACU(`[Manual Refill] 当前重填范围不是有效 AI 尾部，将使用 <=${manualRefillMergeBaseMaxMessageIndex} 的 bounded replay 基底，避免未来楼层污染 prompt。`);
            }
        }

        _set_isAutoUpdatingCard_ACU(true);
        const maxConcurrentGroups = Math.max(1, Number(settings_ACU.maxConcurrentGroups) || 1);
        const totalChunks = Math.max(1, Math.ceil(groupKeys.length / maxConcurrentGroups));
        const failedGroups: Array<{ key: string; error?: string }> = [];

        logDebug_ACU(`[Manual Update] 分组计划：选中 ${targetKeys.length} 张表，生成 ${groupKeys.length} 个组，最大并发组数 ${maxConcurrentGroups}。`);

        for (let start = 0; start < groupKeys.length; start += maxConcurrentGroups) {
            const chunkIndex = Math.floor(start / maxConcurrentGroups) + 1;
            const chunkKeys = groupKeys.slice(start, start + maxConcurrentGroups);
            const groupedChunk: GroupedRuntimeUpdateGroup_ACU[] = chunkKeys.map((gKey): GroupedRuntimeUpdateGroup_ACU => {
                const group = updateGroups[gKey];
                return {
                    key: gKey,
                    groupId: group.groupId,
                    indices: group.indices,
                    batchSize: group.batchSize,
                    sheetKeys: group.sheetKeys,
                    requestOptions: group.requestOptions,
                    mergeBaseMaxMessageIndex: manualRefillMergeBaseMaxMessageIndex,
                    useLatestRuntimeMergeBase: manualRefillUsesLatestRuntimeBase,
                };
            });
            logDebug_ACU(`[Manual Update] 并发处理第 ${chunkIndex}/${totalChunks} 批，当前 ${groupedChunk.length} 组：${groupedChunk.map(group => `${group.key}(${group.sheetKeys.join(',')})`).join('; ')}`);
            options.onProgress?.({
                phase: 'preparing',
                message: `并发处理第 ${chunkIndex}/${totalChunks} 批，当前 ${groupedChunk.length} 组。`,
            });
            try {
                await loadAllChatMessages_ACU();
                if (!manualRefillEnabled && shouldRotateV2BoundaryCheckpointForRetainedBuffer_ACU()) {
                    const boundaryCheckpoint = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });
                    if (!boundaryCheckpoint.success) {
                        failedGroups.push({
                            key: chunkKeys[0] || 'manual_boundary_checkpoint',
                            error: boundaryCheckpoint.error || 'AI 楼层边界 checkpoint 建立失败，已停止手动更新以避免跳楼推进。',
                        });
                        break;
                    }
                }
            } catch (checkpointError: any) {
                logError_ACU('[Manual Update] 继续下一批前同步聊天并建立 AI 楼层边界 checkpoint 异常详情:', checkpointError);
                failedGroups.push({
                    key: chunkKeys[0] || 'manual_boundary_checkpoint',
                    error: checkpointError?.message || 'AI 楼层边界 checkpoint 建立异常，已停止手动更新以避免跳楼推进。',
                });
                break;
            }
            try {
                const chunkResult = await processGroupedRuntimeChunk_ACU(groupedChunk, 'manual_independent', {
                    onProgress: options.onProgress,
                    replaceExistingIncremental: manualRefillEnabled && !manualRefillRequiresFinalSnapshot,
                });
                committedBucketCount += chunkResult.committedBucketCount;
                if (!chunkResult.success) {
                    chunkResult.failedGroups.forEach(key => {
                        failedGroups.push({ key, error: chunkResult.error || '手动更新失败或被终止。' });
                    });
                    if (chunkResult.failedGroups.length === 0) {
                        failedGroups.push({ key: chunkKeys[0] || 'manual_refill', error: chunkResult.error || '手动更新已终止。' });
                    }
                }

                // 并发组内禁止每组单独刷新；填表保存后 currentJsonTableData_ACU 已由本轮 workingTableData 更新。
                // 这里只同步聊天数组，避免刚保存完又通过 refreshData 触发历史回放/重建。
                await loadAllChatMessages_ACU();
            } catch (error: any) {
                const failureError = error?.message || String(error || '手动重填分组执行异常。');
                logError_ACU('[Manual Refill] 分组执行或同步聊天失败:', error);
                return await failManualRefillSession(failureError);
            }

            if (failedGroups.length > 0) {
                break;
            }
        }

        _set_isAutoUpdatingCard_ACU(false);

        if (failedGroups.length > 0) {
            const firstFailure = failedGroups[0];
            const failureError = firstFailure.error || '手动更新失败或被终止。';
            return await failManualRefillSession(failureError);
        }

        if (wasStoppedByUser_ACU) {
            return await failManualRefillSession('手动更新已终止。');
        }

        if (manualRefillRequiresFinalSnapshot) {
            const completedData = getRuntimeTableDataSnapshot_ACU();
            if (!completedData) {
                const rollbackError = await rollbackManualRefillSession();
                const failureError = '手动重填已完成，但无法从运行时导出完整恢复快照；已拒绝写入不完整 checkpoint。';
                return { success: false, error: rollbackError ? `${failureError}；回滚失败：${rollbackError}` : failureError };
            }
            try {
                const snapshotResult = await commitManualRefillSheetSnapshotInRangeAtomic_ACU({
                    isolationKey: getCurrentIsolationKey_ACU(),
                    targetMessageIndices: contextScopeIndices,
                    targetSheetKeys: targetKeys,
                    snapshotData: completedData,
                });
                if (!snapshotResult.success) {
                    logError_ACU('[Manual Refill] 重填完成后提交完整单表 checkpoint 失败:', snapshotResult.error);
                    return await failManualRefillSession(snapshotResult.error || '手动重填完成后提交完整单表 checkpoint 失败。');
                }
            } catch (error: any) {
                const failureError = error?.message || String(error || '手动重填完成后提交完整单表 checkpoint 异常。');
                logError_ACU('[Manual Refill] 重填完成后提交完整单表 checkpoint 异常:', error);
                return await failManualRefillSession(failureError);
            }
        }

        let checkpointWarning: string | undefined;
        try {
            await loadAllChatMessages_ACU();
            const boundaryCheckpoint = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });
            if (!boundaryCheckpoint.success) {
                checkpointWarning = boundaryCheckpoint.error || '边界 checkpoint 建立失败。';
                logWarn_ACU(`[Manual Update] 手动填表完成，但边界 checkpoint 建立失败: ${checkpointWarning}`);
            }
        } catch (error: any) {
            checkpointWarning = error?.message || String(error || '边界 checkpoint 建立异常。');
            logWarn_ACU(`[Manual Update] 手动填表完成，但边界 checkpoint 建立异常: ${checkpointWarning}`);
            logError_ACU('[Manual Update] 边界 checkpoint 建立异常详情:', error);
        }

        // 手动更新完成后检测自动合并总结
        let autoMergeTriggered = false;
        let autoMergeSuccess = false;
        try {
            const trigger = checkAutoMergeTrigger_ACU();
            if (trigger.shouldTrigger) {
                autoMergeTriggered = true;
                const prepared = prepareAutoMergeBatches_ACU({
                    startIndex: 0, endIndex: trigger.mergeCount, targetCount: 1,
                    batchSize: 5, promptTemplate: '', isAutoMode: true,
                });
                let acc: any[] = [];
                for (let i = 0; i < prepared.batches.length; i++) {
                    const batchResult = await executeAutoMergeBatch_ACU(prepared, prepared.batches[i], acc);
                    acc = batchResult.accumulatedSummary;
                }
                await finalizeAutoMerge_ACU(prepared, acc);
                autoMergeSuccess = true;
            }
        } catch (e) {
            logWarn_ACU('自动合并总结检测失败:', e);
        }

        return { success: true, autoMergeTriggered, autoMergeSuccess, checkpointWarning };
    } catch (error: any) {
        if (!manualRefillSessionSnapshot) {
            throw error;
        }
        const failureError = error?.message || String(error || '手动更新执行异常。');
        logError_ACU('[Manual Update] 执行过程中发生未处理异常:', error);
        return await failManualRefillSession(failureError);
    } finally {
        _set_manualExtraHint_ACU('');
        _set_isAutoUpdatingCard_ACU(false);
    }
}
