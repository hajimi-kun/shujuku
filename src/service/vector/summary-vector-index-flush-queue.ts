import { currentChatFileIdentifier_ACU } from '../runtime/state-manager';
import { logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import {
    deleteSummaryVectorFlushTask_ACU,
    getSummaryVectorFlushTask_ACU,
    listSummaryVectorFlushTasks_ACU,
    upsertSummaryVectorFlushTask_ACU,
    type SummaryVectorIndexFlushTaskMode_ACU,
    type SummaryVectorIndexFlushTaskRecord_ACU,
} from '../../data/storage/vector-index-hot-cache';
import { archiveSummaryVectorIndexNow_ACU, findSummaryTable_ACU, type SummaryVectorIndexArchiveResult_ACU } from './summary-vector-index-archive-service';
import { clearSummaryVectorIndexDirtyForRealign_ACU } from './summary-vector-index-realign-state';

const SUMMARY_VECTOR_INDEX_FLUSH_DEBOUNCE_MS_ACU = 2500;
const SUMMARY_VECTOR_INDEX_FLUSHING_STALE_MS_ACU = 60_000;
const summaryVectorFlushTimers_ACU = new Map<string, ReturnType<typeof setTimeout>>();
const summaryVectorFlushRunning_ACU = new Set<string>();

export interface SummaryVectorIndexFlushQueueOptions_ACU {
    targetMessageIndex?: number;
    mode?: SummaryVectorIndexFlushTaskMode_ACU;
    debounceMs?: number;
    reason?: string;
}

export interface SummaryVectorIndexFlushQueueResult_ACU {
    queued: boolean;
    skipped?: boolean;
    reason?: string;
    scopeKey?: string;
    debounceUntil?: number;
}

export interface SummaryVectorIndexFlushNowResult_ACU {
    success: boolean;
    skipped?: boolean;
    reason?: string;
    result?: SummaryVectorIndexArchiveResult_ACU;
    error?: string;
}

function normalizeKeyPart_ACU(value: any): string {
    return String(value || '').trim();
}

/** scope key 只用 chatKey，与 spv3.6.7+ 外部快照路径设计一致 */
export function buildSummaryVectorIndexFlushScopeKey_ACU(chatKey: string): string {
    return `flush::${normalizeKeyPart_ACU(chatKey) || 'default'}`;
}

function normalizeErrorMessage_ACU(error: unknown): string {
    if (error instanceof Error) return error.message || error.name || '未知错误';
    if (typeof error === 'string') return error;
    try {
        const text = JSON.stringify(error);
        return text && text !== '{}' ? text : String(error || '未知错误');
    } catch {
        return String(error || '未知错误');
    }
}

function shouldClearSummaryVectorIndexDirtyAfterFlush_ACU(result: SummaryVectorIndexArchiveResult_ACU): boolean {
    if (!result.success) return false;
    if (result.skipped && result.reason === 'summary_table_not_found') {
        return false;
    }
    return true;
}

function clearFlushTimer_ACU(scopeKey: string): void {
    const timer = summaryVectorFlushTimers_ACU.get(scopeKey);
    if (timer) clearTimeout(timer);
    summaryVectorFlushTimers_ACU.delete(scopeKey);
}

async function markFlushTaskFailure_ACU(task: SummaryVectorIndexFlushTaskRecord_ACU, error: string, terminal = false): Promise<void> {
    await upsertSummaryVectorFlushTask_ACU({
        scopeKey: task.scopeKey,
        chatKey: task.chatKey,
        isolationKey: task.isolationKey,
        sourceTableKey: task.sourceTableKey,
        targetMessageIndex: task.targetMessageIndex,
        mode: task.mode,
        status: terminal ? 'failed_terminal' : 'failed_retryable',
        requestedAt: task.requestedAt,
        debounceUntil: Date.now() + SUMMARY_VECTOR_INDEX_FLUSH_DEBOUNCE_MS_ACU,
        lastError: error,
    });
}

function scheduleFlushTaskTimer_ACU(task: SummaryVectorIndexFlushTaskRecord_ACU): void {
    clearFlushTimer_ACU(task.scopeKey);
    const delay = Math.max(0, Math.min(Math.max(0, task.debounceUntil - Date.now()), 2_147_483_647));
    logDebug_ACU(`[交火向量索引] 防抖定时器已设置：scope=${task.scopeKey}, delay=${delay}ms, mode=${task.mode}`);
    const timer = setTimeout(() => {
        logDebug_ACU(`[交火向量索引] 防抖定时器触发：scope=${task.scopeKey}, 开始执行 flush`);
        summaryVectorFlushTimers_ACU.delete(task.scopeKey);
        void flushSummaryVectorIndexTaskNow_ACU(task.scopeKey);
    }, delay);
    summaryVectorFlushTimers_ACU.set(task.scopeKey, timer);
}

export async function enqueueSummaryVectorIndexFlush_ACU(options: SummaryVectorIndexFlushQueueOptions_ACU = {}): Promise<SummaryVectorIndexFlushQueueResult_ACU> {
    const selectedSummary = findSummaryTable_ACU();
    if (!selectedSummary?.summaryKey) {
        return { queued: false, skipped: true, reason: 'summary_table_not_found' };
    }
    const chatKey = normalizeKeyPart_ACU(currentChatFileIdentifier_ACU);
    if (!chatKey) {
        return { queued: false, skipped: true, reason: 'flush_scope_unresolved' };
    }

    const now = Date.now();
    const rawDebounceMs = options.debounceMs == null
        ? SUMMARY_VECTOR_INDEX_FLUSH_DEBOUNCE_MS_ACU
        : Number(options.debounceMs);
    const debounceMs = Number.isFinite(rawDebounceMs)
        ? Math.max(0, rawDebounceMs)
        : SUMMARY_VECTOR_INDEX_FLUSH_DEBOUNCE_MS_ACU;
    const scopeKey = buildSummaryVectorIndexFlushScopeKey_ACU(chatKey);
    const task = await upsertSummaryVectorFlushTask_ACU({
        scopeKey,
        chatKey,
        isolationKey: '',
        sourceTableKey: normalizeKeyPart_ACU(selectedSummary.summaryKey),
        targetMessageIndex: options.targetMessageIndex,
        mode: options.mode === 'append' ? 'append' : 'sync',
        status: 'queued',
        requestedAt: now,
        debounceUntil: now + debounceMs,
    });
    if (!task) {
        return { queued: false, skipped: true, reason: 'flush_task_persist_failed', scopeKey };
    }
    scheduleFlushTaskTimer_ACU(task);
    logDebug_ACU(`[交火向量索引] 已加入防抖 flush 队列：scope=${scopeKey}, mode=${task.mode}, debounceMs=${debounceMs}, reason=${options.reason || ''}`);
    return { queued: true, scopeKey, debounceUntil: task.debounceUntil };
}

export async function flushSummaryVectorIndexTaskNow_ACU(scopeKey: string): Promise<SummaryVectorIndexFlushNowResult_ACU> {
    const task = await getSummaryVectorFlushTask_ACU(scopeKey);
    if (!task) return { success: true, skipped: true, reason: 'flush_task_not_found' };
    if (summaryVectorFlushRunning_ACU.has(task.scopeKey)) {
        return { success: true, skipped: true, reason: 'flush_already_running' };
    }

    const activeChatKey = normalizeKeyPart_ACU(currentChatFileIdentifier_ACU);
    if (task.chatKey !== activeChatKey) {
        const message = `flush scope 与当前聊天上下文不一致：task=${task.chatKey}, active=${activeChatKey}`;
        await markFlushTaskFailure_ACU(task, message, false);
        logWarn_ACU('[交火向量索引] 跳过防抖 flush，当前上下文不匹配:', message);
        return { success: false, reason: 'flush_scope_mismatch', error: message };
    }

    const selectedSummary = findSummaryTable_ACU();
    if (!selectedSummary?.summaryKey || normalizeKeyPart_ACU(selectedSummary.summaryKey) !== task.sourceTableKey) {
        const message = `flush scope 对应纪要表不可用：sourceTableKey=${task.sourceTableKey}`;
        await markFlushTaskFailure_ACU(task, message, false);
        logWarn_ACU('[交火向量索引] 跳过防抖 flush，纪要表不可用:', message);
        return { success: false, reason: 'summary_table_not_found_for_flush', error: message };
    }

    summaryVectorFlushRunning_ACU.add(task.scopeKey);
    clearFlushTimer_ACU(task.scopeKey);
    try {
        await upsertSummaryVectorFlushTask_ACU({
            scopeKey: task.scopeKey,
            chatKey: task.chatKey,
            isolationKey: task.isolationKey,
            sourceTableKey: task.sourceTableKey,
            targetMessageIndex: task.targetMessageIndex,
            mode: task.mode,
            status: 'flushing',
            requestedAt: task.requestedAt,
            debounceUntil: task.debounceUntil,
        });
        // [spv3.6.9] force=true：填表完成后必须强制写入外部文件，跳过"无变更"检测
        // 因为填表后数据已变化，但 fingerprint 比对可能误判为无变更
        const result = await archiveSummaryVectorIndexNow_ACU({
            targetMessageIndex: task.targetMessageIndex,
            mode: task.mode,
            saveChatAfterWrite: true,
            force: true,
        });
        if (result.success) {
            await deleteSummaryVectorFlushTask_ACU(task.scopeKey);
            if (shouldClearSummaryVectorIndexDirtyAfterFlush_ACU(result)) {
                clearSummaryVectorIndexDirtyForRealign_ACU();
            }
            logDebug_ACU(`[交火向量索引] 防抖 flush 完成：scope=${task.scopeKey}, skipped=${result.skipped}, reason=${result.reason || ''}`);
            return { success: true, skipped: result.skipped, reason: result.reason, result };
        }
        const error = result.errors?.join('; ') || result.reason || 'summary_vector_index_flush_failed';
        await markFlushTaskFailure_ACU(task, error, result.reason === 'summary_vector_index_config_invalid' || result.reason === 'target_message_invalid' || result.reason === 'target_message_not_found');
        logWarn_ACU('[交火向量索引] 防抖 flush 失败:', error);
        return { success: false, reason: result.reason, result, error };
    } catch (error) {
        const message = normalizeErrorMessage_ACU(error);
        await markFlushTaskFailure_ACU(task, message, false);
        logWarn_ACU('[交火向量索引] 防抖 flush 异常:', message);
        return { success: false, reason: 'flush_exception', error: message };
    } finally {
        summaryVectorFlushRunning_ACU.delete(task.scopeKey);
    }
}

export async function restoreSummaryVectorIndexFlushQueueForCurrentChat_ACU(): Promise<number> {
    const chatKey = normalizeKeyPart_ACU(currentChatFileIdentifier_ACU);
    if (!chatKey) return 0;
    const tasks = await listSummaryVectorFlushTasks_ACU({ chatKey });
    let restored = 0;
    const now = Date.now();
    for (const task of tasks) {
        if (task.status === 'ready' || task.status === 'failed_terminal') continue;
        if (task.status === 'flushing' && now - task.updatedAt > SUMMARY_VECTOR_INDEX_FLUSHING_STALE_MS_ACU) {
            await markFlushTaskFailure_ACU(task, '上次 flush 在执行中断后超时，已重新排队。', false);
            const refreshed = await getSummaryVectorFlushTask_ACU(task.scopeKey);
            if (refreshed) {
                scheduleFlushTaskTimer_ACU(refreshed);
                restored += 1;
            }
            continue;
        }
        scheduleFlushTaskTimer_ACU(task);
        restored += 1;
    }
    if (restored > 0) {
        logDebug_ACU(`[交火向量索引] 已恢复当前聊天防抖 flush 队列：count=${restored}`);
    }
    return restored;
}
