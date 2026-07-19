import { createEmbeddings_ACU } from '../../data/gateways/vector-embedding-gateway';
import { saveChatToHost_ACU } from '../../data/gateways/chat-gateway';
import { readIsolatedTagData_ACU, writeIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import { readVectorIndexJsonFile_ACU } from '../../data/storage/vector-index-st-files-storage';
import { logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import { getChatArray_ACU } from '../chat/chat-service';
import { callAIWithPreset_ACU } from '../ai/api-call';
import { getCurrentWorldbookConfig_ACU } from '../settings/settings-readers';
import { globalMeta_ACU } from '../../data/repositories/profile-repo';
import { getInjectionTargetLorebook_ACU, getIsolationPrefix_ACU } from '../worldbook/injection-engine';
import {
    createLorebookEntries_ACU,
    getLorebookEntries_ACU,
    isWorldbookApiAvailable_ACU,
    setLorebookEntries_ACU,
} from '../worldbook/worldbook-service';
import { getEffectiveSummaryVectorIndexConfig_ACU, validateSummaryVectorIndexConfig_ACU } from './vector-memory-config';
import {
    assignSummaryVectorIndexStateToTagData_ACU,
    getLatestSummaryVectorIndexSnapshotState_ACU,
} from './summary-vector-index-state-service';
import { loadSummaryVectorIndexChunksFromManifest_ACU } from './summary-vector-index-storage-service';
import {
    clearLatestSummaryVectorIndexStateForInvalidExternalFiles_ACU,
    clearLatestSummaryVectorIndexStateForMissingExternalFiles_ACU,
    isInvalidExternalVectorFileError_ACU,
    isMissingExternalVectorFileError_ACU,
} from './summary-vector-index-cache-service';
import type {
    ChatSummaryVectorIndexChunk_ACU,
    ChatSummaryVectorIndexManifest_ACU,
    ChatSummaryVectorIndexRow_ACU,
    ChatSummaryVectorIndexState_ACU,
    SummaryVectorIndexSnapshotLayer_ACU,
} from './summary-vector-index-types';
import {
    reciprocalRankFusion_ACU,
    sparseSearchBm25_ACU,
    type SummaryHybridCandidate_ACU,
} from './summary-vector-hybrid-retrieval';
import {
    buildPreparedRows_ACU,
    findSummaryTable_ACU,
    type SummaryVectorArchivePreparedRow_ACU,
} from './summary-vector-index-archive-service';
import { enqueueSummaryVectorIndexFlush_ACU } from './summary-vector-index-flush-queue';
import { markSummaryVectorIndexDirtyForRealign_ACU } from './summary-vector-index-realign-state';

interface SummaryVectorIndexRuntimeOptions_ACU {
    userInput?: string;
    source?: string;
}

export interface SummaryVectorIndexRuntimeResult_ACU {
    success: boolean;
    skipped?: boolean;
    reason?: string;
    keywordCount?: number;
    candidateCount?: number;
    injectedCount?: number;
    denseCandidateCount?: number;
    sparseCandidateCount?: number;
    fusionCandidateCount?: number;
}

interface RankedSummaryCandidate_ACU extends SummaryHybridCandidate_ACU {
    chunk: ChatSummaryVectorIndexChunk_ACU;
    row: ChatSummaryVectorIndexRow_ACU;
    score: number;
    rerankScore?: number;
}

let lastRuntimeSignature_ACU = '';
let lastRuntimeAt_ACU = 0;
const SUMMARY_VECTOR_INDEX_RUNTIME_DEDUPE_MS_ACU = 8000;

function normalizeText_ACU(value: any): string {
    return String(value ?? '').trim();
}

function buildRecentContext_ACU(pairCount: number): string {
    const chat = getChatArray_ACU();
    if (!Array.isArray(chat) || chat.length === 0) return '';
    const limit = Math.max(2, Math.min(chat.length, Math.max(1, pairCount) * 2 + 2));
    return chat.slice(Math.max(0, chat.length - limit))
        .map((message: any) => {
            const role = message?.is_user ? '用户' : 'AI';
            const text = normalizeText_ACU(message?.mes).replace(/<[^>]+>/g, '').trim();
            return text ? `${role}: ${text}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

function renderKeywordPromptMessages_ACU(segments: any[], variables: { recentContext: string; userInput: string }): any[] {
    return (Array.isArray(segments) ? segments : [])
        .map((segment) => ({
            role: ['system', 'assistant', 'user'].includes(String(segment?.role || '').toLowerCase())
                ? String(segment.role).toLowerCase()
                : 'user',
            content: normalizeText_ACU(segment?.content)
                .replace(/\$RECENT_CONTEXT/g, variables.recentContext)
                .replace(/\$USER_INPUT/g, variables.userInput),
        }))
        .filter((segment) => segment.content);
}

function extractTaggedContent_ACU(text: string, tagName: string): string {
    const source = String(text || '');
    const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = source.match(pattern);
    return match ? String(match[1] || '').trim() : '';
}

function stripThinkingBlocks_ACU(text: string): string {
    return String(text || '')
        .replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
        .replace(/<\/?(?:thinking|thought)[^>]*>/gi, '')
        .trim();
}

function parseKeywords_ACU(text: string): string[] {
    const normalized = normalizeText_ACU(text);
    // 优先：从 <keywords> 标签提取
    let keywordContent = extractTaggedContent_ACU(normalized, 'keywords');
    // 回退：从 "关键词：" 前缀提取（兼容不遵循 XML 标签的 AI 输出）
    if (!keywordContent) {
        const stripped = stripThinkingBlocks_ACU(normalized);
        const fallbackMatch = stripped.match(/关键词[：:]\s*([\s\S]+?)$/i);
        if (fallbackMatch) {
            keywordContent = fallbackMatch[1].trim();
            logDebug_ACU('[交火模式纪要索引] AI 未使用 <keywords> 标签，已从"关键词："前缀回退提取。');
        }
    }
    if (!keywordContent) {
        logWarn_ACU('[交火模式纪要索引] AI 回复中未找到 <keywords> 标签或"关键词："前缀，跳过关键词提取。');
        return [];
    }
    return Array.from(new Set(keywordContent
        .replace(/<[^>]+>/g, '')
        .split(/[，,、\n;；|]/g)
        .map((item) => item.replace(/^[-*\d.、\s]+/, '').trim())
        .filter((item) => item.length > 0)
        .slice(0, 24)));
}

async function generateKeywords_ACU(config: any, userInput: string): Promise<string[]> {
    const recentContext = buildRecentContext_ACU(config.keywordContextPairCount || 1);
    const messages = renderKeywordPromptMessages_ACU(config.keywordPromptGroup || [], { recentContext, userInput });
    if (messages.length === 0) return [];
    const attempts = Math.max(1, Number(config.keywordGenerationMaxAttempts) || 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await callAIWithPreset_ACU(messages, config.keywordApiPreset || '');
            const keywords = parseKeywords_ACU(response || '');
            if (keywords.length > 0) return keywords;
        } catch (error) {
            logWarn_ACU(`[交火模式纪要索引] 关键词生成失败 ${attempt}/${attempts}:`, error);
        }
    }
    return [];
}

function cosineSimilarity_ACU(left: number[], right: number[]): number {
    const length = Math.min(left.length, right.length);
    if (length <= 0) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < length; index += 1) {
        const a = Number(left[index]) || 0;
        const b = Number(right[index]) || 0;
        dot += a * b;
        leftNorm += a * a;
        rightNorm += b * b;
    }
    if (leftNorm <= 0 || rightNorm <= 0) return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function rerankCandidates_ACU(config: any, query: string, candidates: RankedSummaryCandidate_ACU[]): Promise<RankedSummaryCandidate_ACU[]> {
    const endpoint = normalizeText_ACU(config.rerankEndpoint);
    const model = normalizeText_ACU(config.rerankModel);
    if (!endpoint || !model || candidates.length === 0) return candidates;
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const apiKey = normalizeText_ACU(config.rerankApiKey);
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const instruction = normalizeText_ACU(config.rerankInstruction);
        const body: Record<string, any> = {
            model,
            query,
            documents: candidates.map((candidate) => candidate.chunk.text),
        };
        if (instruction) body.instruction = instruction;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(await response.text().catch(() => response.statusText));
        const payload = await response.json();
        const results = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.data) ? payload.data : [];
        const byIndex = new Map<number, number>();
        results.forEach((item: any, fallbackIndex: number) => {
            const index = Number.isInteger(item?.index) ? Number(item.index) : Number.isInteger(item?.document_index) ? Number(item.document_index) : fallbackIndex;
            const score = Number(item?.relevance_score ?? item?.score ?? item?.rerank_score);
            if (Number.isFinite(index) && Number.isFinite(score)) byIndex.set(index, score);
        });
        return candidates
            .map((candidate, index) => ({ ...candidate, rerankScore: byIndex.get(index) ?? candidate.score }))
            .sort((left, right) => (right.rerankScore ?? right.score) - (left.rerankScore ?? left.score));
    } catch (error) {
        logWarn_ACU('[交火模式纪要索引] Rerank 失败，回退到 Embedding 排序:', error);
        return candidates;
    }
}

function escapeMarkdownTableCell_ACU(value: any): string {
    return normalizeText_ACU(value)
        .replace(/\r?\n+/g, '<br>')
        .replace(/\|/g, '\\|');
}

function buildSummaryIndexOverwriteContent_ACU(candidates: RankedSummaryCandidate_ACU[]): string {
    const selectedRows = (Array.isArray(candidates) ? candidates : [])
        .map((candidate) => candidate.row)
        .filter((row): row is ChatSummaryVectorIndexRow_ACU => !!row)
        .sort((left, right) => (Number(left.rowOrder) || 0) - (Number(right.rowOrder) || 0));

    const lines = [
        '# 纪要索引',
        '',
        '| 时间 | 地点 | 概要 | 编码索引 |',
        '|---|---|---|---|',
    ];

    selectedRows.forEach((row) => {
        lines.push(`| ${escapeMarkdownTableCell_ACU(row.timeSpan)} | ${escapeMarkdownTableCell_ACU(row.location)} | ${escapeMarkdownTableCell_ACU(row.summary)} | ${escapeMarkdownTableCell_ACU(row.indexCode)} |`);
    });

    if (selectedRows.length === 0) {
        lines.push('|  |  | （无命中纪要） |  |');
    }

    return lines.join('\n');
}

async function upsertOriginalSummaryIndexEntry_ACU(content: string): Promise<void> {
    if (!isWorldbookApiAvailable_ACU()) return;
    const targetLorebook = await getInjectionTargetLorebook_ACU();
    if (!targetLorebook) return;

    const worldbookConfig = getCurrentWorldbookConfig_ACU();
    const comment = `${getIsolationPrefix_ACU()}TavernDB-ACU-CustomExport-纪要索引`;
    const entries = await getLorebookEntries_ACU(targetLorebook);
    const existing = entries.find((entry: any) => entry?.comment === comment);
    const enabled = existing?.enabled ?? (worldbookConfig?.zeroTkOccupyMode !== true);
    const nextEntry = {
        ...(existing || {}),
        comment,
        content,
        keys: Array.isArray(existing?.keys) ? existing.keys : [],
        enabled,
        type: 'constant',
        order: Number.isFinite(Number(existing?.order)) ? Number(existing.order) : 10000,
        prevent_recursion: true,
    };

    if (existing?.uid != null) {
        await setLorebookEntries_ACU(targetLorebook, [{ ...nextEntry, uid: existing.uid }]);
    } else {
        await createLorebookEntries_ACU(targetLorebook, [nextEntry]);
    }
}

interface RuntimeSingleSnapshotBlob_ACU {
    schema?: string;
    indexId?: string;
    chatKey?: string;
    isolationKey?: string;
    sourceTableKey?: string;
    sourceTableName?: string;
    snapshotMessageId?: string;
    indexedAt?: string;
    manifest?: ChatSummaryVectorIndexManifest_ACU;
    rows?: ChatSummaryVectorIndexRow_ACU[];
}

interface LiveSummaryVectorRows_ACU {
    summaryKey: string;
    rows: SummaryVectorArchivePreparedRow_ACU[];
    byRowKey: Map<string, SummaryVectorArchivePreparedRow_ACU>;
}

function buildLiveSummaryVectorRows_ACU(): LiveSummaryVectorRows_ACU | null {
    const selected = findSummaryTable_ACU();
    if (!selected?.summaryKey || !selected.table) return null;
    const prepared = buildPreparedRows_ACU(selected.table, selected.summaryKey);
    if (prepared.error) {
        logWarn_ACU('[交火模式纪要索引] 实时纪要表解析失败，跳过发送前对账:', prepared.error);
        return null;
    }
    const rows = Array.isArray(prepared.rows) ? prepared.rows : [];
    return {
        summaryKey: selected.summaryKey,
        rows,
        byRowKey: new Map(rows.map((row) => [row.rowKey, row])),
    };
}

function filterRowsByLiveSummaryTable_ACU(
    rows: ChatSummaryVectorIndexRow_ACU[],
    live: LiveSummaryVectorRows_ACU | null,
): { rows: ChatSummaryVectorIndexRow_ACU[]; changed: boolean } {
    if (!live) return { rows, changed: false };
    const filtered = rows.filter((row) => {
        const liveRow = live.byRowKey.get(row.rowKey);
        if (!liveRow) return false;
        if (row.sourceFingerprint && liveRow.sourceFingerprint && row.sourceFingerprint !== liveRow.sourceFingerprint) return false;
        return true;
    });
    return { rows: filtered, changed: filtered.length !== rows.length };
}

function filterChunksByLiveSummaryTable_ACU(
    chunks: ChatSummaryVectorIndexChunk_ACU[],
    live: LiveSummaryVectorRows_ACU | null,
): { chunks: ChatSummaryVectorIndexChunk_ACU[]; changed: boolean } {
    if (!live) return { chunks, changed: false };
    const filtered = chunks.filter((chunk) => {
        const liveRow = live.byRowKey.get(chunk.rowKey);
        if (!liveRow) return false;
        if (chunk.sourceFingerprint && liveRow.sourceFingerprint && chunk.sourceFingerprint !== liveRow.sourceFingerprint) return false;
        return true;
    });
    return { chunks: filtered, changed: filtered.length !== chunks.length };
}

function isSingleFileSnapshotManifest_ACU(manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined): manifest is ChatSummaryVectorIndexManifest_ACU {
    if (!manifest) return false;
    const explicitMode = manifest.snapshot?.mode;
    if (explicitMode) return explicitMode === 'single_file_snapshot';
    const manifestPath = normalizeText_ACU(manifest.manifestFile);
    return !!manifestPath && manifest.rowsFile === manifestPath && manifest.tombstoneFile === manifestPath;
}

async function enqueueSummaryVectorIndexRebuild_ACU(layer: SummaryVectorIndexSnapshotLayer_ACU | null, reason: string): Promise<void> {
    markSummaryVectorIndexDirtyForRealign_ACU(reason);
    const queued = await enqueueSummaryVectorIndexFlush_ACU({
        targetMessageIndex: layer?.messageIndex,
        mode: 'sync',
        debounceMs: 0,
        reason,
    });
    if (!queued.queued) {
        logWarn_ACU(`[交火模式纪要索引] 已标记索引待重建，但 flush 入队失败：reason=${queued.reason || 'unknown'}`);
    }
}

async function tryRealignSummaryVectorIndexPointerFromDisk_ACU(params: {
    state: ChatSummaryVectorIndexState_ACU;
    latestLayer: SummaryVectorIndexSnapshotLayer_ACU | null;
    liveRows: LiveSummaryVectorRows_ACU | null;
}): Promise<ChatSummaryVectorIndexState_ACU | null> {
    const manifest = params.state.manifest || null;
    if (!manifest || !isSingleFileSnapshotManifest_ACU(manifest)) return null;
    const snapshotPath = normalizeText_ACU(manifest.manifestFile || manifest.files?.[0]?.path);
    if (!snapshotPath) return null;
    const loaded = await readVectorIndexJsonFile_ACU<RuntimeSingleSnapshotBlob_ACU>(snapshotPath);
    if (!loaded.ok || !loaded.data || typeof loaded.data !== 'object') {
        logWarn_ACU('[交火模式纪要索引] single_file_snapshot 指针对齐读取失败:', loaded.error || snapshotPath);
        return null;
    }
    const blob = loaded.data;
    const blobManifest = blob.manifest;
    if (blob.schema !== 'single_file_snapshot' || !blobManifest || blobManifest.snapshot?.mode !== 'single_file_snapshot') return null;
    if (normalizeText_ACU(blob.indexId) !== normalizeText_ACU(blobManifest.indexId)) return null;
    if (normalizeText_ACU(blob.chatKey) !== normalizeText_ACU(blobManifest.chatKey)) return null;
    if (normalizeText_ACU(blob.isolationKey) !== normalizeText_ACU(blobManifest.isolationKey)) return null;
    if (normalizeText_ACU(blob.sourceTableKey) !== normalizeText_ACU(blobManifest.sourceTableKey)) return null;
    if (normalizeText_ACU(blobManifest.sourceTableKey) !== normalizeText_ACU(manifest.sourceTableKey)) return null;
    if (normalizeText_ACU(blobManifest.chatKey) !== normalizeText_ACU(manifest.chatKey)) return null;
    if (params.latestLayer && normalizeText_ACU(blobManifest.isolationKey) !== normalizeText_ACU(params.latestLayer.isolationKey)) return null;
    if (params.liveRows && normalizeText_ACU(blob.sourceTableKey) !== params.liveRows.summaryKey) return null;
    if (blobManifest.status !== 'ready') return null;
    if (normalizeText_ACU(blobManifest.manifestFile) !== snapshotPath) return null;
    if (normalizeText_ACU(blobManifest.rowsFile) !== snapshotPath) return null;
    if (normalizeText_ACU(blobManifest.tombstoneFile) !== snapshotPath) return null;
    const currentRevision = Number(manifest.snapshot?.revision || 0);
    const diskRevision = Number(blobManifest.snapshot?.revision || 0);
    if (diskRevision < currentRevision) return null;
    const activeRowKeys = new Set(blobManifest.snapshot?.activeRowKeys || []);
    const diskRows = (Array.isArray(blob.rows) ? blob.rows : [])
        .filter((row) => row && row.status !== 'removed' && (activeRowKeys.size === 0 || activeRowKeys.has(row.rowKey)));
    const reconciledDiskRows = filterRowsByLiveSummaryTable_ACU(diskRows, params.liveRows);
    const reconciledRows = reconciledDiskRows.rows;
    const alignedManifest: ChatSummaryVectorIndexManifest_ACU = {
        ...blobManifest,
        manifestFile: snapshotPath,
        rowsFile: snapshotPath,
        tombstoneFile: snapshotPath,
        status: 'ready',
    };
    const alignedState: ChatSummaryVectorIndexState_ACU = {
        ...params.state,
        version: params.state.version || 1,
        backend: 'st-files',
        status: 'ready',
        indexId: alignedManifest.indexId,
        snapshotMessageId: alignedManifest.snapshotMessageId || normalizeText_ACU(blob.snapshotMessageId),
        sourceTableKey: alignedManifest.sourceTableKey,
        sourceTableName: alignedManifest.sourceTableName || normalizeText_ACU(blob.sourceTableName),
        indexedAt: alignedManifest.indexedAt || normalizeText_ACU(blob.indexedAt) || new Date().toISOString(),
        rowCount: reconciledRows.length || alignedManifest.rowCount,
        chunkCount: alignedManifest.chunkCount,
        skippedRowCount: alignedManifest.skippedRowCount,
        rows: reconciledRows,
        manifest: alignedManifest,
    };
    delete alignedState.chunks;
    const layer = params.latestLayer;
    const chat = getChatArray_ACU();
    const message = layer ? chat[layer.messageIndex] : null;
    if (!layer || !message) return null;
    const nextTagData = { ...(readIsolatedTagData_ACU(message, layer.isolationKey) || layer.tagData || {}) } as any;
    assignSummaryVectorIndexStateToTagData_ACU(nextTagData, alignedState, alignedManifest);
    writeIsolatedTagData_ACU(message, layer.isolationKey, nextTagData);
    await saveChatToHost_ACU();
    logWarn_ACU(`[交火模式纪要索引] 已从 single_file_snapshot 磁盘文件对齐索引指针：indexId=${alignedManifest.indexId}, revision=${diskRevision}`);
    return alignedState;
}

export async function processSummaryVectorIndexBeforeGeneration_ACU(
    options: SummaryVectorIndexRuntimeOptions_ACU = {},
): Promise<SummaryVectorIndexRuntimeResult_ACU> {
    const worldbookConfig = getCurrentWorldbookConfig_ACU();
    const globalEnabled = globalMeta_ACU?.summaryVectorIndexModeGlobal === true;
    if (!globalEnabled) {
        logDebug_ACU(`[交火模式纪要索引] 全局开关未启用，跳过发送前处理。worldbookProjection=${worldbookConfig.summaryVectorIndexModeEnabled === true}`);
        return { success: false, skipped: true, reason: 'summary_vector_index_disabled' };
    }
    const userInput = normalizeText_ACU(options.userInput);
    if (!userInput) return { success: false, skipped: true, reason: 'empty_user_input' };
    const signature = `${options.source || 'unknown'}:${userInput}`;
    if (signature === lastRuntimeSignature_ACU && Date.now() - lastRuntimeAt_ACU <= SUMMARY_VECTOR_INDEX_RUNTIME_DEDUPE_MS_ACU) {
        return { success: true, skipped: true, reason: 'deduped' };
    }
    lastRuntimeSignature_ACU = signature;
    lastRuntimeAt_ACU = Date.now();

    const config = getEffectiveSummaryVectorIndexConfig_ACU();
    const validation = validateSummaryVectorIndexConfig_ACU(config);
    if (!validation.valid) {
        logWarn_ACU('[交火模式纪要索引] 配置无效，跳过发送前注入:', validation.errors.join('; '));
        return { success: false, skipped: true, reason: 'invalid_config' };
    }

    const snapshot = getLatestSummaryVectorIndexSnapshotState_ACU();
    let state = snapshot?.summaryVectorIndexState || null;
    const latestLayer = snapshot?.layers?.[0] || null;
    if (!state) {
        return { success: false, skipped: true, reason: 'no_index_state' };
    }
    const liveRows = buildLiveSummaryVectorRows_ACU();
    let staleRealignQueued = false;
    const enqueueStaleRealignIfNeeded_ACU = async (): Promise<void> => {
        if (staleRealignQueued) return;
        staleRealignQueued = true;
        await enqueueSummaryVectorIndexRebuild_ACU(latestLayer, 'runtime_stale_rows');
    };
    const activeRowKeys = new Set(state.manifest?.snapshot?.activeRowKeys || []);
    let rows: ChatSummaryVectorIndexRow_ACU[] = Array.isArray(state.rows)
        ? state.rows.filter((row: ChatSummaryVectorIndexRow_ACU) => row.status !== 'removed' && (activeRowKeys.size === 0 || activeRowKeys.has(row.rowKey)))
        : [];
    const reconciledRows = filterRowsByLiveSummaryTable_ACU(rows, liveRows);
    rows = reconciledRows.rows;
    if (reconciledRows.changed) await enqueueStaleRealignIfNeeded_ACU();
    let chunks: ChatSummaryVectorIndexChunk_ACU[] = Array.isArray(state.chunks) ? state.chunks : [];
    if (state.manifest) {
        try {
            chunks = await loadSummaryVectorIndexChunksFromManifest_ACU(state.manifest);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || '未知错误');
            if (isMissingExternalVectorFileError_ACU(message)) {
                if (latestLayer && state.manifest.indexId) {
                    await clearLatestSummaryVectorIndexStateForMissingExternalFiles_ACU({
                        messageIndex: latestLayer.messageIndex,
                        isolationKey: latestLayer.isolationKey,
                        indexId: state.manifest.indexId,
                    });
                }
                logWarn_ACU('[交火模式纪要索引] 外置向量文件缺失，已清空缓存并保留聊天索引指针，跳过本次发送前注入:', message);
                return { success: false, skipped: true, reason: 'external_vector_files_missing' };
            }
            if (isInvalidExternalVectorFileError_ACU(message)) {
                const alignedState = await tryRealignSummaryVectorIndexPointerFromDisk_ACU({ state, latestLayer, liveRows });
                if (alignedState?.manifest) {
                    state = alignedState;
                    rows = Array.isArray(alignedState.rows) ? alignedState.rows : [];
                    try {
                        chunks = await loadSummaryVectorIndexChunksFromManifest_ACU(alignedState.manifest);
                    } catch (realignLoadError) {
                        const realignMessage = realignLoadError instanceof Error ? realignLoadError.message : String(realignLoadError || '未知错误');
                        logWarn_ACU('[交火模式纪要索引] 指针对齐后重新加载外置向量仍失败，转入重建队列:', realignMessage);
                        if (latestLayer && alignedState.manifest.indexId) {
                            await clearLatestSummaryVectorIndexStateForInvalidExternalFiles_ACU({
                                messageIndex: latestLayer.messageIndex,
                                isolationKey: latestLayer.isolationKey,
                                indexId: alignedState.manifest.indexId,
                            });
                        }
                        await enqueueSummaryVectorIndexRebuild_ACU(latestLayer, 'self_heal_identity_mismatch');
                        return { success: false, skipped: true, reason: 'vector_index_realign_reload_failed' };
                    }
                } else {
                    if (latestLayer && state.manifest.indexId) {
                        await clearLatestSummaryVectorIndexStateForInvalidExternalFiles_ACU({
                            messageIndex: latestLayer.messageIndex,
                            isolationKey: latestLayer.isolationKey,
                            indexId: state.manifest.indexId,
                        });
                    }
                    await enqueueSummaryVectorIndexRebuild_ACU(latestLayer, 'self_heal_identity_mismatch');
                    logWarn_ACU('[交火模式纪要索引] 外置向量文件校验失败，指针对齐不可用，已清空缓存并入队重建:', message);
                    return { success: false, skipped: true, reason: 'vector_index_corrupted_rebuild_queued' };
                }
            } else {
                throw error;
            }
        }
    }
    const reconciledChunks = filterChunksByLiveSummaryTable_ACU(chunks, liveRows);
    chunks = reconciledChunks.chunks;
    if (reconciledChunks.changed) await enqueueStaleRealignIfNeeded_ACU();
    if (rows.length < config.summaryIndexKeywordMinRows) {
        return { success: false, skipped: true, reason: 'below_min_rows' };
    }
    if (chunks.length === 0) {
        return { success: false, skipped: true, reason: 'no_chunks' };
    }

    const rowByKey = new Map(rows.map((row) => [row.rowKey, row]));

    // ── 最近 X 条固定注入：按 rowOrder 降序取最近 X 行 ──
    const recentFixedCount = Math.max(0, Math.min(
        config.summaryIndexRecentFixedInjectCount || 0,
        rows.length,
    ));
    const rowsSortedByOrderDesc = [...rows].sort(
        (left, right) => (Number(right.rowOrder) || 0) - (Number(left.rowOrder) || 0),
    );
    const recentFixedRows = rowsSortedByOrderDesc.slice(0, recentFixedCount);
    const recentFixedRowKeys = new Set(recentFixedRows.map((row) => row.rowKey));
    // 较早的行（不参与排序的候选池）
    const olderRows = rows.filter((row) => !recentFixedRowKeys.has(row.rowKey));

    const keywords = await generateKeywords_ACU(config, userInput);
    const queryText = [userInput, keywords.join('，')].filter(Boolean).join('\n关键词：');
    const embeddings = await createEmbeddings_ACU({
        endpoint: config.embeddingEndpoint,
        apiKey: config.embeddingApiKey,
        model: config.embeddingModel,
        input: [queryText],
    });
    const queryVector = embeddings[0]?.embedding || [];
    if (queryVector.length === 0) {
        return { success: false, skipped: true, reason: 'empty_query_embedding' };
    }

    // 只对较早行的 chunks 做向量匹配
    const olderRowKeys = new Set(olderRows.map((row) => row.rowKey));
    const olderChunks = chunks.filter((chunk) => olderRowKeys.has(chunk.rowKey));

    const searchableCandidates: SummaryHybridCandidate_ACU[] = olderChunks
        .map((chunk): RankedSummaryCandidate_ACU | null => {
            const row = rowByKey.get(chunk.rowKey);
            if (!row) return null;
            return { chunk, row, score: 0 };
        })
        .filter((candidate): candidate is RankedSummaryCandidate_ACU => !!candidate);

    const denseCandidates = searchableCandidates
        .map((candidate): RankedSummaryCandidate_ACU | null => {
            const chunk = candidate.chunk;
            if (!Array.isArray(chunk.vector) || chunk.vector.length === 0) return null;
            const score = cosineSimilarity_ACU(queryVector, chunk.vector);
            if (score < config.summaryIndexMinScore) return null;
            return { ...candidate, score, denseScore: score };
        })
        .filter((candidate): candidate is RankedSummaryCandidate_ACU => !!candidate)
        .sort((left, right) => right.score - left.score)
        .slice(0, config.summaryIndexCandidateLimit);

    const sparseCandidates = config.summaryIndexHybridRetrievalEnabled
        ? sparseSearchBm25_ACU(queryText, searchableCandidates, config.summaryIndexBm25CandidateLimit)
        : [];

    const fusionLimit = Math.max(config.summaryIndexCandidateLimit, config.topK);
    const candidates = config.summaryIndexHybridRetrievalEnabled
        ? reciprocalRankFusion_ACU([denseCandidates, sparseCandidates], config.summaryIndexRrfK, fusionLimit) as RankedSummaryCandidate_ACU[]
        : denseCandidates;

    logDebug_ACU(
        `[交火模式纪要索引] 混合召回候选：dense=${denseCandidates.length}, bm25=${sparseCandidates.length}, fusion=${candidates.length}, hybrid=${config.summaryIndexHybridRetrievalEnabled === true}`,
    );

    if (candidates.length === 0 && recentFixedRows.length === 0) {
        return { success: false, skipped: true, reason: 'no_candidates', keywordCount: keywords.length, denseCandidateCount: denseCandidates.length, sparseCandidateCount: sparseCandidates.length, fusionCandidateCount: candidates.length };
    }

    // Rerank 只处理较早行的候选
    const reranked = candidates.length > 0
        ? await rerankCandidates_ACU(config, queryText, candidates)
        : [];
    const selectedByRow = new Map<string, RankedSummaryCandidate_ACU>();
    for (const candidate of reranked) {
        if (!selectedByRow.has(candidate.row.rowKey)) selectedByRow.set(candidate.row.rowKey, candidate);
        if (selectedByRow.size >= config.topK) break;
    }

    // 合并：最近固定行 + TopK 排序行（去重，固定行优先）
    for (const row of recentFixedRows) {
        if (!selectedByRow.has(row.rowKey)) {
            selectedByRow.set(row.rowKey, { chunk: null as any, row, score: 1.0 });
        }
    }
    const selected = Array.from(selectedByRow.values())
        .sort((left, right) => (Number(left.row.rowOrder) || 0) - (Number(right.row.rowOrder) || 0));
    if (selected.length === 0) {
        return { success: false, skipped: true, reason: 'no_selected_rows', keywordCount: keywords.length, candidateCount: candidates.length, denseCandidateCount: denseCandidates.length, sparseCandidateCount: sparseCandidates.length, fusionCandidateCount: candidates.length };
    }

    const content = buildSummaryIndexOverwriteContent_ACU(selected);
    await upsertOriginalSummaryIndexEntry_ACU(content);
    logDebug_ACU(
        `[交火模式纪要索引] 已覆盖原概要索引条目：${selected.length} 条（其中固定注入 ${recentFixedRows.length} 条，排序选取 ${selected.length - recentFixedRows.length} 条），关键词 ${keywords.length} 个，输出顺序按纪要表原 rowOrder。`,
    );
    return { success: true, keywordCount: keywords.length, candidateCount: candidates.length, injectedCount: selected.length, denseCandidateCount: denseCandidates.length, sparseCandidateCount: sparseCandidates.length, fusionCandidateCount: candidates.length };
}
