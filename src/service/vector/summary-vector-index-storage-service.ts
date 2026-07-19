import { getCurrentIsolationKey_ACU, currentChatFileIdentifier_ACU } from '../runtime/state-manager';
import { hashUserInput_ACU, logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import { getCurrentCharacterCardName_ACU } from '../../shared/template-preset-utils';
import {
    buildVectorIndexFileName_ACU,
    buildVectorIndexSingleSnapshotFilePath_ACU,
    buildVectorIndexSnapshotFilePath_ACU,
    buildVectorIndexStableDirectory_ACU,
    buildVectorIndexStableFilePath_ACU,
    deleteRegisteredVectorIndexFilesWhere_ACU,
    deleteVectorIndexFile_ACU,
    loadVectorIndexRegistry_ACU,
    readVectorIndexJsonFile_ACU,
    registerVectorIndexFiles_ACU,
    sha256Text_ACU,
    unregisterVectorIndexFiles_ACU,
    uploadVectorIndexJsonFile_ACU,
} from '../../data/storage/vector-index-st-files-storage';
import {
    deleteVectorIndexCacheByIndex_ACU,
    estimateVectorIndexTempCache_ACU,
    getVectorIndexCachedShard_ACU,
    putVectorIndexCachedShard_ACU,
} from '../../data/storage/vector-index-temp-cache';
import {
    deleteSummaryVectorHotCacheByIndex_ACU,
    estimateSummaryVectorFlushTasks_ACU,
    estimateSummaryVectorHotCache_ACU,
    getSummaryVectorHotCacheChunks_ACU,
    putSummaryVectorHotCacheChunks_ACU,
} from '../../data/storage/vector-index-hot-cache';
import type {
    ChatSummaryVectorIndexChunk_ACU,
    ChatSummaryVectorIndexManifest_ACU,
    ChatSummaryVectorIndexRow_ACU,
    ChatSummaryVectorIndexState_ACU,
    SummaryVectorIndexBatchRef_ACU,
    SummaryVectorIndexChunkRef_ACU,
    SummaryVectorIndexExternalFileRef_ACU,
    SummaryVectorIndexHealthReport_ACU,
    SummaryVectorIndexPackRef_ACU,
    SummaryVectorIndexReachabilityReport_ACU,
    SummaryVectorIndexReachableFile_ACU,
    SummaryVectorIndexRowIndex_ACU,
    SummaryVectorIndexRowIndexEntry_ACU,
    SummaryVectorIndexSafeGcOptions_ACU,
    SummaryVectorIndexSafeGcResult_ACU,
    SummaryVectorIndexShard_ACU,
    SummaryVectorIndexStats_ACU,
    SummaryVectorIndexTombstone_ACU,
} from './summary-vector-index-types';
import { SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU } from './summary-vector-index-types';
import { getAggregatedSummaryVectorIndexSnapshot_ACU } from './summary-vector-index-state-service';
import { getEffectiveSummaryVectorIndexConfig_ACU } from './vector-memory-config';

const DEFAULT_SHARD_CHUNK_LIMIT_ACU = 128;
const SUMMARY_VECTOR_INDEX_PACK_CHUNK_LIMIT_ACU = 64;
// 第一版保守止血：不再按 retention 删除历史快照，避免回退到旧楼层时找不到外置文件。
const SUMMARY_VECTOR_INDEX_SNAPSHOT_RETENTION_LIMIT_ACU = 0;

export interface PersistSummaryVectorIndexExternalOptions_ACU {
    chatKey?: string;
    isolationKey?: string;
    previousManifest?: ChatSummaryVectorIndexManifest_ACU | null;
    rows: ChatSummaryVectorIndexRow_ACU[];
    chunks: ChatSummaryVectorIndexChunk_ACU[];
    snapshotMessageId: string;
    sourceTableKey: string;
    sourceTableName: string;
    indexedAt: string;
    skippedRowCount: number;
    embeddingModel: string;
    shardChunkLimit?: number;
}

export interface PersistSummaryVectorIndexSnapshotOptions_ACU extends PersistSummaryVectorIndexExternalOptions_ACU {
    activeRowKeys?: string[];
    activeChunkIds?: string[];
    removedRowKeys?: string[];
    replacedRowKeys?: string[];
    parentIndexIds?: string[];
    snapshotRevision?: number;
    sourceMessageIndex?: number;
}

export interface PersistSummaryVectorIndexExternalResult_ACU {
    state: ChatSummaryVectorIndexState_ACU;
    manifest: ChatSummaryVectorIndexManifest_ACU;
    uploadedFiles: SummaryVectorIndexExternalFileRef_ACU[];
}

export interface LoadSummaryVectorIndexChunksOptions_ACU {
    preferExternalFiles?: boolean;
    shardReadConcurrency?: number;
}

function normalizeChatKey_ACU(chatKey?: string): string {
    const raw = String(chatKey || currentChatFileIdentifier_ACU || 'current-chat').trim();
    return raw || 'current-chat';
}

function normalizeVectorFileNamePart_ACU(value: string): string {
    return String(value || 'default')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 96) || 'default';
}

function buildVectorIndexScopePrefix_ACU(chatKey: string, isolationKey: string): string {
    return `TavernDB_ACU_vector_${normalizeVectorFileNamePart_ACU(chatKey)}_${normalizeVectorFileNamePart_ACU(isolationKey || 'default')}_`;
}

function buildVectorIndexStableScopePrefix_ACU(chatKey: string, isolationKey: string, sourceTableKey: string): string {
    return `${buildVectorIndexStableDirectory_ACU({ chatKey, isolationKey, sourceTableKey })}_`;
}

function buildLegacyVectorIndexStableScopePrefix_ACU(chatKey: string, isolationKey: string, sourceTableKey: string): string {
    return [
        'TavernDB_ACU_vector',
        normalizeVectorFileNamePart_ACU(chatKey),
        normalizeVectorFileNamePart_ACU(isolationKey || 'default'),
        normalizeVectorFileNamePart_ACU(sourceTableKey || 'summary'),
    ].join('/');
}

function buildIndexId_ACU(params: { chatKey: string; isolationKey: string; sourceTableKey: string; snapshotMessageId: string; indexedAt: string }): string {
    return `idx_${hashUserInput_ACU(`${params.chatKey}\n${params.isolationKey}\n${params.sourceTableKey}\n${params.snapshotMessageId}\n${params.indexedAt}`)}`;
}

function buildVersionedSnapshotIndexId_ACU(params: { chatKey: string; isolationKey: string; sourceTableKey: string; snapshotRevision: number }): string {
    const revision = Math.max(1, Math.floor(Number(params.snapshotRevision) || 0));
    return `snap_${hashUserInput_ACU(`${params.chatKey}\n${params.isolationKey}\n${params.sourceTableKey}\n${revision}`)}`;
}

function buildVersionedSnapshotScopePrefix_ACU(chatKey: string, isolationKey: string, sourceTableKey: string): string {
    return `${buildVectorIndexStableDirectory_ACU({ chatKey, isolationKey, sourceTableKey })}_`;
}

function extractVersionedSnapshotIndexIdFromPath_ACU(path: string, scopePrefix: string): string | null {
    const normalizedPath = String(path || '');
    if (!normalizedPath.startsWith(scopePrefix)) return null;
    const remainder = normalizedPath.slice(scopePrefix.length);
    const match = remainder.match(/^(snap_[^_]+)_/);
    return match?.[1] || null;
}

function getVectorIndexFileTimestamp_ACU(file: SummaryVectorIndexExternalFileRef_ACU | null | undefined): string {
    return String(file?.updatedAt || file?.createdAt || '');
}

function sumUniqueVectorIndexFileBytes_ACU(files: Array<SummaryVectorIndexExternalFileRef_ACU | null | undefined>): number {
    const byPath = new Map<string, SummaryVectorIndexExternalFileRef_ACU>();
    files.forEach((file) => {
        const path = String(file?.path || '').trim();
        if (!path) return;
        byPath.set(path, file as SummaryVectorIndexExternalFileRef_ACU);
    });
    return Array.from(byPath.values()).reduce((sum, file) => sum + Math.max(0, Number(file.byteSize) || 0), 0);
}

function normalizeRows_ACU(rows: ChatSummaryVectorIndexRow_ACU[]): ChatSummaryVectorIndexRow_ACU[] {
    return (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.rowKey && Array.isArray(row.chunkIds) && row.chunkIds.length > 0)
        .map((row): ChatSummaryVectorIndexRow_ACU => {
            const status: ChatSummaryVectorIndexRow_ACU['status'] = row.status === 'removed' || row.status === 'replaced'
                ? row.status
                : 'active';
            const chunkKeys = Array.isArray(row.chunkKeys) ? row.chunkKeys.map((item) => String(item)).filter(Boolean) : undefined;
            return {
                ...row,
                chunkIds: row.chunkIds.filter(Boolean),
                ...(chunkKeys && chunkKeys.length > 0 ? { chunkKeys } : {}),
                status,
                updatedAt: row.updatedAt || new Date().toISOString(),
            };
        })
        .sort((left, right) => left.rowOrder - right.rowOrder || left.rowKey.localeCompare(right.rowKey));
}

function normalizeChunks_ACU(chunks: ChatSummaryVectorIndexChunk_ACU[]): ChatSummaryVectorIndexChunk_ACU[] {
    return (Array.isArray(chunks) ? chunks : [])
        .filter((chunk) => chunk?.chunkId && chunk?.rowKey && chunk?.text && Array.isArray(chunk.vector) && chunk.vector.length > 0)
        .map((chunk, index) => ({ ...chunk, sequence: index }));
}

const VECTOR_ENCODING_F32B64_ACU = 'f32b64' as const;

type StoredVectorIndexChunk_ACU = Omit<ChatSummaryVectorIndexChunk_ACU, 'vector'> & {
    vector: number[] | string;
    vectorEncoding?: typeof VECTOR_ENCODING_F32B64_ACU;
};

type StoredVectorIndexChunkBlob_ACU = Omit<VectorIndexChunkBlob_ACU, 'vector'> & {
    vector: number[] | string;
    vectorEncoding?: typeof VECTOR_ENCODING_F32B64_ACU;
};

function encodeVectorToF32B64_ACU(vector: number[]): string {
    if (!Array.isArray(vector)) return '';
    const bytes = new Uint8Array(vector.length * 4);
    const view = new DataView(bytes.buffer);
    vector.forEach((value, index) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            throw new Error(`交火向量包含非有限数值，拒绝编码: index=${index}`);
        }
        view.setFloat32(index * 4, numeric, true);
    });
    let binary = '';
    const blockSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
        const block = bytes.subarray(offset, offset + blockSize);
        for (let i = 0; i < block.length; i += 1) binary += String.fromCharCode(block[i]);
    }
    const encoder = globalThis.btoa;
    if (typeof encoder !== 'function') throw new Error('当前环境缺少 btoa，无法编码交火向量。');
    return encoder(binary);
}

function decodeF32B64ToVector_ACU(encoded: string): number[] {
    const decoder = globalThis.atob;
    if (typeof decoder !== 'function') throw new Error('当前环境缺少 atob，无法解码交火向量。');
    const binary = decoder(String(encoded || ''));
    if (binary.length % 4 !== 0) {
        throw new Error(`交火向量 f32b64 字节长度非法: bytes=${binary.length}`);
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    const view = new DataView(bytes.buffer);
    const vector: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4) vector.push(view.getFloat32(offset, true));
    return vector;
}

function encodeChunkVectorForStorage_ACU<T extends ChatSummaryVectorIndexChunk_ACU>(chunk: T): Omit<T, 'vector'> & { vector: string; vectorEncoding: typeof VECTOR_ENCODING_F32B64_ACU } {
    return { ...chunk, vector: encodeVectorToF32B64_ACU(chunk.vector), vectorEncoding: VECTOR_ENCODING_F32B64_ACU };
}

function decodeChunkVectorInPlace_ACU(chunk: StoredVectorIndexChunk_ACU): ChatSummaryVectorIndexChunk_ACU {
    if (chunk.vectorEncoding === VECTOR_ENCODING_F32B64_ACU || typeof chunk.vector === 'string') {
        chunk.vector = decodeF32B64ToVector_ACU(String(chunk.vector || ''));
        delete chunk.vectorEncoding;
    } else if (Array.isArray(chunk.vector)) {
        chunk.vector = chunk.vector.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    }
    return chunk as ChatSummaryVectorIndexChunk_ACU;
}

function decodeChunkVectorsInPlace_ACU(chunks: StoredVectorIndexChunk_ACU[]): ChatSummaryVectorIndexChunk_ACU[] {
    return (Array.isArray(chunks) ? chunks : []).map((chunk) => decodeChunkVectorInPlace_ACU(chunk));
}

interface VectorIndexChunkBlob_ACU {
    version: number;
    chunkKey: string;
    chunkId: string;
    rowKey: string;
    rowOrder: number;
    text: string;
    vector: number[];
    vectorEncoding?: typeof VECTOR_ENCODING_F32B64_ACU;
    sequence: number;
    embeddingModel: string;
    dimension: number;
    sourceFingerprint?: string;
    textHash?: string;
    createdAt: string;
    updatedAt: string;
}

interface VectorIndexPackBlob_ACU {
    version: number;
    packKey: string;
    indexId: string;
    embeddingModel: string;
    dimension: number;
    chunkKeys: string[];
    chunks: VectorIndexChunkBlob_ACU[];
    createdAt: string;
    updatedAt: string;
}

interface VectorIndexSingleSnapshotBlob_ACU {
    version: number;
    schema: 'single_file_snapshot';
    indexId: string;
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    sourceTableName: string;
    snapshotMessageId: string;
    embeddingModel: string;
    dimension: number;
    indexedAt: string;
    updatedAt: string;
    manifest: ChatSummaryVectorIndexManifest_ACU;
    rows: ChatSummaryVectorIndexRow_ACU[];
    chunks: StoredVectorIndexChunk_ACU[];
    tombstone: SummaryVectorIndexTombstone_ACU;
}

interface PreparedVectorChunkBlob_ACU {
    chunk: ChatSummaryVectorIndexChunk_ACU;
    blob: VectorIndexChunkBlob_ACU;
    chunkKey: string;
    chunkChecksum: string;
    chunkByteSize: number;
    rowKey: string;
    chunkId: string;
    sourceFingerprint?: string;
    textHash?: string;
}

function buildVectorChunkKey_ACU(params: {
    embeddingModel: string;
    dimension: number;
    rowKey: string;
    sourceFingerprint?: string;
    text: string;
}): string {
    return `chunk_${hashUserInput_ACU([
        params.embeddingModel,
        String(Math.max(0, Math.floor(Number(params.dimension) || 0))),
        params.rowKey,
        params.sourceFingerprint || '',
        params.text,
    ].join('\n'))}`;
}

function buildVectorChunkPath_ACU(parts: {
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    chunkKey: string;
}): string {
    return buildVectorIndexSnapshotFilePath_ACU({
        chatKey: parts.chatKey,
        isolationKey: parts.isolationKey,
        sourceTableKey: parts.sourceTableKey,
        indexId: parts.chunkKey,
        role: 'vector_chunk',
    });
}

function buildVectorPackKey_ACU(params: {
    indexId: string;
    embeddingModel: string;
    dimension: number;
    chunkKeys: string[];
}): string {
    return `pack_${hashUserInput_ACU([
        params.indexId,
        params.embeddingModel,
        String(Math.max(0, Math.floor(Number(params.dimension) || 0))),
        ...params.chunkKeys.slice().sort(),
    ].join('\n'))}`;
}

function buildVectorPackPath_ACU(parts: {
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    indexId: string;
    packKey: string;
}): string {
    return buildVectorIndexSnapshotFilePath_ACU({
        chatKey: parts.chatKey,
        isolationKey: parts.isolationKey,
        sourceTableKey: parts.sourceTableKey,
        indexId: parts.indexId,
        role: 'vector_pack',
        shardId: parts.packKey,
    });
}

function buildVectorChunkBlob_ACU(chunk: ChatSummaryVectorIndexChunk_ACU, options: {
    chunkKey: string;
    embeddingModel: string;
    dimension: number;
    sourceFingerprint?: string;
}): VectorIndexChunkBlob_ACU {
    const now = new Date().toISOString();
    return {
        version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
        chunkKey: options.chunkKey,
        chunkId: chunk.chunkId,
        rowKey: chunk.rowKey,
        rowOrder: Number.isFinite(Number((chunk as any).rowOrder)) ? Number((chunk as any).rowOrder) : 0,
        text: chunk.text,
        vector: Array.isArray(chunk.vector) ? chunk.vector.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [],
        sequence: Number.isFinite(Number(chunk.sequence)) ? Number(chunk.sequence) : 0,
        embeddingModel: options.embeddingModel,
        dimension: Math.max(0, Math.floor(Number(options.dimension) || 0)),
        sourceFingerprint: options.sourceFingerprint,
        textHash: hashUserInput_ACU(chunk.text),
        createdAt: now,
        updatedAt: now,
    };
}

async function prepareVectorChunkBlob_ACU(chunk: ChatSummaryVectorIndexChunk_ACU, options: {
    embeddingModel: string;
    dimension: number;
    sourceFingerprint?: string;
}): Promise<PreparedVectorChunkBlob_ACU> {
    const chunkKey = buildVectorChunkKey_ACU({
        embeddingModel: options.embeddingModel,
        dimension: options.dimension,
        rowKey: chunk.rowKey,
        sourceFingerprint: options.sourceFingerprint,
        text: chunk.text,
    });
    const blob = buildVectorChunkBlob_ACU(chunk, {
        chunkKey,
        embeddingModel: options.embeddingModel,
        dimension: options.dimension,
        sourceFingerprint: options.sourceFingerprint,
    });
    const chunkJson = JSON.stringify(blob);
    return {
        chunk,
        blob,
        chunkKey,
        chunkChecksum: await sha256Text_ACU(chunkJson),
        chunkByteSize: new Blob([chunkJson]).size,
        rowKey: chunk.rowKey,
        chunkId: chunk.chunkId,
        sourceFingerprint: options.sourceFingerprint,
        textHash: blob.textHash,
    };
}

function chunkArray_ACU<T>(items: T[], limit: number): T[][] {
    const size = Math.max(1, Math.floor(Number(limit) || DEFAULT_SHARD_CHUNK_LIMIT_ACU));
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

function dedupeByPath_ACU<T extends { path?: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of Array.isArray(items) ? items : []) {
        const path = String(item?.path || '').trim();
        if (!path || seen.has(path)) continue;
        seen.add(path);
        result.push(item);
    }
    return result;
}

function dedupeChunkRefs_ACU<T extends { chunkKey?: string; chunkId?: string; rowKey?: string; path?: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of Array.isArray(items) ? items : []) {
        const chunkKey = String(item?.chunkKey || '').trim();
        const chunkId = String(item?.chunkId || '').trim();
        const rowKey = String(item?.rowKey || '').trim();
        const path = String(item?.path || '').trim();
        if (!chunkKey || !path) continue;
        const key = `${chunkKey}::${chunkId}::${rowKey}::${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function buildRowIndex_ACU(indexId: string, rows: ChatSummaryVectorIndexRow_ACU[], shardIdsByChunkId: Map<string, string>, updatedAt: string): SummaryVectorIndexRowIndex_ACU {
    const entries: Record<string, SummaryVectorIndexRowIndexEntry_ACU> = {};
    rows.forEach((row) => {
        const shardIds = Array.from(new Set(row.chunkIds.map((chunkId) => shardIdsByChunkId.get(chunkId)).filter((value): value is string => !!value)));
        entries[row.rowKey] = {
            rowKey: row.rowKey,
            rowId: row.rowId,
            rowOrder: row.rowOrder,
            summaryKey: row.rowKey,
            sourceFingerprint: row.sourceFingerprint || hashUserInput_ACU([row.rowId, row.rowOrder, row.timeSpan, row.location, row.summary, row.indexCode, row.vectorSourceText].join('\n')),
            indexCode: row.indexCode,
            chunkIds: [...row.chunkIds],
            shardIds,
            status: row.status === 'removed' || row.status === 'replaced' ? row.status : 'active',
            updatedAt,
        };
    });
    return { version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU, indexId, updatedAt, rows: entries };
}

function buildTombstone_ACU(indexId: string, previousManifest: ChatSummaryVectorIndexManifest_ACU | null | undefined, updatedAt: string): SummaryVectorIndexTombstone_ACU {
    return {
        version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
        indexId,
        updatedAt,
        removedRows: {},
        removedChunks: {},
        ...(previousManifest?.indexId ? { previousIndexId: previousManifest.indexId } as any : {}),
    };
}

async function cleanupPreviousManifest_ACU(previousManifest: ChatSummaryVectorIndexManifest_ACU | null | undefined): Promise<void> {
    if (!previousManifest?.files?.length) return;
    const paths = previousManifest.files.map((file) => file.path).filter(Boolean);
    for (const path of paths) {
        const result = await deleteVectorIndexFile_ACU(path);
        if (!result.ok) {
            logWarn_ACU('[交火向量索引] 清理旧外置文件失败:', path, result.error);
        }
    }
    await unregisterVectorIndexFiles_ACU(paths);
    await deleteVectorIndexCacheByIndex_ACU(previousManifest.indexId);
}

export function normalizeSummaryVectorIndexManifestForRead_ACU(
    manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined,
): ChatSummaryVectorIndexManifest_ACU | null {
    if (!manifest || typeof manifest !== 'object') return null;
    const files = Array.isArray(manifest.files)
        ? manifest.files.filter((file) => file && typeof file === 'object' && String(file.path || '').trim())
        : [];
    const batchRefs = Array.isArray(manifest.batchRefs)
        ? manifest.batchRefs.map((batch) => ({
            ...batch,
            files: Array.isArray(batch?.files)
                ? batch.files.filter((file) => file && typeof file === 'object' && String(file.path || '').trim())
                : [],
            rowKeys: Array.isArray(batch?.rowKeys) ? batch.rowKeys.map((item) => String(item || '')).filter(Boolean) : [],
            chunkIds: Array.isArray(batch?.chunkIds) ? batch.chunkIds.map((item) => String(item || '')).filter(Boolean) : [],
            status: batch?.status || 'ready',
        }))
        : [];
    const contentAddressed = manifest.contentAddressed && typeof manifest.contentAddressed === 'object'
        ? {
            ...manifest.contentAddressed,
            mode: manifest.contentAddressed.packRefs?.length ? 'content_addressed_packs' : (manifest.contentAddressed.mode || 'content_addressed_chunks'),
            chunkRefs: Array.isArray(manifest.contentAddressed.chunkRefs)
                ? dedupeChunkRefs_ACU(manifest.contentAddressed.chunkRefs.filter((ref) => ref && String(ref.path || '').trim() && String(ref.chunkKey || '').trim()).map((ref) => ({
                    ...ref,
                    path: String(ref.path || '').trim(),
                    packKey: String((ref as any).packKey || '').trim() || undefined,
                    packPath: String((ref as any).packPath || '').trim() || undefined,
                })))
                : [],
            activeChunkKeys: Array.isArray(manifest.contentAddressed.activeChunkKeys)
                ? manifest.contentAddressed.activeChunkKeys.map((item) => String(item || '')).filter(Boolean)
                : [],
            packRefs: Array.isArray(manifest.contentAddressed.packRefs)
                ? dedupeByPath_ACU(manifest.contentAddressed.packRefs.filter((ref) => ref && String(ref.path || '').trim() && String(ref.packKey || '').trim()).map((ref) => ({
                    ...ref,
                    path: String(ref.path || '').trim(),
                    chunkKeys: Array.isArray(ref.chunkKeys) ? Array.from(new Set(ref.chunkKeys.map((item) => String(item || '')).filter(Boolean))) : [],
                })))
                : [],
        }
        : undefined;
    const activeRowKeys = Array.isArray(manifest.snapshot?.activeRowKeys)
        ? manifest.snapshot!.activeRowKeys.map((item) => String(item || '')).filter(Boolean)
        : [];
    const activeChunkIds = Array.isArray(manifest.snapshot?.activeChunkIds)
        ? manifest.snapshot!.activeChunkIds.map((item) => String(item || '')).filter(Boolean)
        : undefined;
    const removedRowKeys = Array.isArray(manifest.snapshot?.removedRowKeys)
        ? manifest.snapshot!.removedRowKeys.map((item) => String(item || '')).filter(Boolean)
        : [];
    const replacedRowKeys = Array.isArray(manifest.snapshot?.replacedRowKeys)
        ? manifest.snapshot!.replacedRowKeys.map((item) => String(item || '')).filter(Boolean)
        : [];
    const batchIds = Array.isArray(manifest.snapshot?.batchIds)
        ? manifest.snapshot!.batchIds.map((item) => String(item || '')).filter(Boolean)
        : batchRefs.map((batch) => String(batch.batchId || '')).filter(Boolean);
    const normalized: ChatSummaryVectorIndexManifest_ACU = {
        ...manifest,
        version: Number.isFinite(Number(manifest.version)) ? Number(manifest.version) : 1,
        backend: 'st-files',
        status: manifest.status || 'ready',
        indexId: String(manifest.indexId || ''),
        chatKey: String(manifest.chatKey || currentChatFileIdentifier_ACU || 'current-chat'),
        isolationKey: String(manifest.isolationKey || getCurrentIsolationKey_ACU() || 'default'),
        snapshotMessageId: String(manifest.snapshotMessageId || ''),
        sourceTableKey: String(manifest.sourceTableKey || 'summary'),
        sourceTableName: String(manifest.sourceTableName || '纪要表'),
        indexedAt: String(manifest.indexedAt || manifest.updatedAt || new Date().toISOString()),
        updatedAt: String(manifest.updatedAt || manifest.indexedAt || new Date().toISOString()),
        rowCount: Math.max(0, Math.floor(Number(manifest.rowCount) || 0)),
        chunkCount: Math.max(0, Math.floor(Number(manifest.chunkCount) || 0)),
        skippedRowCount: Math.max(0, Math.floor(Number(manifest.skippedRowCount) || 0)),
        embeddingModel: String(manifest.embeddingModel || ''),
        dimension: Math.max(0, Math.floor(Number(manifest.dimension) || 0)),
        rowsFile: String(manifest.rowsFile || ''),
        tombstoneFile: String(manifest.tombstoneFile || ''),
        manifestFile: String(manifest.manifestFile || ''),
        files,
        baseShardCount: Math.max(0, Math.floor(Number(manifest.baseShardCount) || files.filter((file) => file.role === 'base_shard').length)),
        deltaShardCount: Math.max(0, Math.floor(Number(manifest.deltaShardCount) || files.filter((file) => file.role === 'delta_shard').length)),
        tombstoneRowCount: Math.max(0, Math.floor(Number(manifest.tombstoneRowCount) || 0)),
        tombstoneChunkCount: Math.max(0, Math.floor(Number(manifest.tombstoneChunkCount) || 0)),
        externalTotalBytes: Math.max(0, Math.floor(Number(manifest.externalTotalBytes) || sumUniqueVectorIndexFileBytes_ACU(files))),
        snapshot: manifest.snapshot ? {
            revision: Math.max(1, Math.floor(Number(manifest.snapshot.revision) || 1)),
            mode: manifest.snapshot.mode === 'single_file_snapshot'
                ? 'single_file_snapshot'
                : manifest.snapshot.mode === 'base_rolling_delta'
                    ? 'base_rolling_delta'
                    : 'snapshot',
            parentIndexIds: Array.isArray(manifest.snapshot.parentIndexIds) ? manifest.snapshot.parentIndexIds.map((item) => String(item || '')).filter(Boolean) : [],
            activeRowKeys,
            activeChunkIds,
            removedRowKeys,
            replacedRowKeys,
            batchIds,
        } : undefined,
        batchRefs,
        ...(contentAddressed ? { contentAddressed } : {}),
    };
    return normalized.indexId ? normalized : null;
}

function collectManifestFilePaths_ACU(manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined): Set<string> {
    manifest = normalizeSummaryVectorIndexManifestForRead_ACU(manifest);
    const paths = new Set<string>();
    const addPath = (path: any): void => {
        const normalizedPath = String(path || '').trim();
        if (normalizedPath) paths.add(normalizedPath);
    };
    const addFile = (file: SummaryVectorIndexExternalFileRef_ACU | null | undefined): void => {
        addPath(file?.path);
    };
    addPath(manifest?.manifestFile);
    addPath(manifest?.rowsFile);
    addPath(manifest?.tombstoneFile);
    (manifest?.files || []).forEach(addFile);
    (manifest?.batchRefs || []).forEach((batch) => (batch.files || []).forEach(addFile));
    (manifest?.contentAddressed?.chunkRefs || []).forEach((ref) => addPath(ref.path));
    (manifest?.contentAddressed?.packRefs || []).forEach((ref) => addPath(ref.path));
    return paths;
}

async function cleanupManifestFilesExcept_ACU(
    previousManifest: ChatSummaryVectorIndexManifest_ACU | null | undefined,
    retainedPaths: Set<string>,
): Promise<void> {
    const previousPaths = collectManifestFilePaths_ACU(previousManifest);
    if (previousPaths.size === 0) return;
    const removablePaths = Array.from(previousPaths).filter((path) => path && !retainedPaths.has(path));
    const deletedPaths: string[] = [];
    for (const path of removablePaths) {
        const result = await deleteVectorIndexFile_ACU(path);
        if (result.ok) {
            deletedPaths.push(result.path || path);
        } else {
            logWarn_ACU('[交火向量索引] 清理未复用外置文件失败:', path, result.error);
        }
    }
    await unregisterVectorIndexFiles_ACU(deletedPaths);
    if (previousManifest.indexId && !Array.from(retainedPaths).some((path) => path.includes(previousManifest.indexId))) {
        await deleteVectorIndexCacheByIndex_ACU(previousManifest.indexId);
    }
}

function isSameChatIsolationSourceTableVectorFile_ACU(path: string, manifest: ChatSummaryVectorIndexManifest_ACU): boolean {
    const normalizedPath = String(path || '');
    if (!normalizedPath.startsWith('TavernDB_ACU_vector_')) return false;
    const chatPart = normalizeVectorFileNamePart_ACU(manifest.chatKey || 'current-chat');
    const isolationPart = normalizeVectorFileNamePart_ACU(manifest.isolationKey || 'default');
    const sourceTablePart = normalizeVectorFileNamePart_ACU(manifest.sourceTableKey || 'summary');
    return normalizedPath.startsWith(`TavernDB_ACU_vector_${chatPart}_${isolationPart}_${sourceTablePart}_`);
}

async function cleanupSnapshotScopeFilesExcept_ACU(
    manifest: ChatSummaryVectorIndexManifest_ACU,
    retainedPaths: Set<string>,
    options: { includeSameSourceTableFallback?: boolean } = {},
): Promise<void> {
    const legacyScopePrefix = buildVectorIndexScopePrefix_ACU(manifest.chatKey, manifest.isolationKey);
    const stableScopePrefix = buildVectorIndexStableScopePrefix_ACU(manifest.chatKey, manifest.isolationKey, manifest.sourceTableKey);
    const legacyStableScopePrefix = buildLegacyVectorIndexStableScopePrefix_ACU(manifest.chatKey, manifest.isolationKey, manifest.sourceTableKey);
    const removedPaths = await deleteRegisteredVectorIndexFilesWhere_ACU((file) => {
        const path = String(file?.path || '');
        const inSameScope = path.startsWith(legacyScopePrefix)
            || path.startsWith(stableScopePrefix)
            || path.startsWith(legacyStableScopePrefix)
            || (options.includeSameSourceTableFallback === true && isSameChatIsolationSourceTableVectorFile_ACU(path, manifest));
        return inSameScope && !retainedPaths.has(path);
    });
    if (removedPaths.length > 0) {
        logDebug_ACU(`[交火向量索引] 已清理最新快照未引用的同作用域外置文件: count=${removedPaths.length}`);
    }
}

function collectManifestReachableFiles_ACU(
    rawManifest: ChatSummaryVectorIndexManifest_ACU,
    context: { messageIndex: number; isolationKey: string },
): SummaryVectorIndexReachableFile_ACU[] {
    const manifest = normalizeSummaryVectorIndexManifestForRead_ACU(rawManifest);
    if (!manifest) return [];
    const reachableFiles: SummaryVectorIndexReachableFile_ACU[] = [];
    const seen = new Set<string>();
    const pushFile = (file: Partial<SummaryVectorIndexReachableFile_ACU> & { path?: string }): void => {
        const path = String(file.path || '').trim();
        if (!path || seen.has(path)) return;
        seen.add(path);
        reachableFiles.push({
            path,
            role: file.role,
            indexId: file.indexId || manifest.indexId,
            messageIndex: context.messageIndex,
            isolationKey: context.isolationKey,
            sourceTableKey: manifest.sourceTableKey,
            manifestKey: manifest.indexId,
            checksum: file.checksum,
            chunkKey: file.chunkKey,
            chunkId: file.chunkId,
            rowKey: file.rowKey,
        });
    };

    pushFile({ path: manifest.manifestFile, role: 'manifest' });
    pushFile({ path: manifest.rowsFile, role: 'row_index' });
    pushFile({ path: manifest.tombstoneFile, role: 'tombstone' });
    (manifest.files || []).forEach((file) => pushFile({ ...file, indexId: manifest.indexId }));
    (manifest.batchRefs || []).forEach((batch) => (batch.files || []).forEach((file) => pushFile({ ...file, indexId: batch.indexId || manifest.indexId })));
    const contentInfo = manifest.contentAddressed;
    if (contentInfo?.mode === 'content_addressed_packs' && Array.isArray(contentInfo.packRefs) && contentInfo.packRefs.length > 0) {
        contentInfo.packRefs.forEach((ref) => pushFile({
            path: ref.path,
            role: 'vector_pack',
            indexId: manifest.indexId,
            checksum: ref.checksum,
        }));
    } else {
        (contentInfo?.chunkRefs || []).forEach((ref) => pushFile({
            path: ref.path,
            role: 'vector_chunk',
            indexId: manifest.indexId,
            checksum: ref.checksum,
            chunkKey: ref.chunkKey,
            chunkId: ref.chunkId,
            rowKey: ref.rowKey,
        }));
    }
    return reachableFiles;
}

export async function collectSummaryVectorIndexReachability_ACU(): Promise<SummaryVectorIndexReachabilityReport_ACU> {
    const snapshot = await (async () => getAggregatedSummaryVectorIndexSnapshot_ACU())();
    const chatKey = normalizeChatKey_ACU();
    const reachabilityByPath = new Map<string, SummaryVectorIndexReachableFile_ACU>();
    let manifestCount = 0;
    if (snapshot?.layers?.length) {
        snapshot.layers.forEach((layer) => {
            const manifest = layer.summaryVectorIndexState?.manifest || layer.tagData?.summaryVectorIndexManifest || null;
            if (!manifest) return;
            manifestCount += 1;
            collectManifestReachableFiles_ACU(manifest, {
                messageIndex: layer.messageIndex,
                isolationKey: layer.isolationKey,
            }).forEach((file) => reachabilityByPath.set(file.path, file));
        });
    }
    return {
        chatKey,
        reachablePaths: Array.from(reachabilityByPath.keys()),
        reachableFiles: Array.from(reachabilityByPath.values()),
        manifestCount,
    };
}

export async function cleanupUnreachableSummaryVectorIndexFiles_ACU(options: SummaryVectorIndexSafeGcOptions_ACU = {}): Promise<SummaryVectorIndexSafeGcResult_ACU> {
    const reachability = await collectSummaryVectorIndexReachability_ACU();
    const registry = await loadVectorIndexRegistry_ACU();
    const reachablePathSet = new Set(reachability.reachablePaths);
    const scopePrefixes = new Set<string>();
    const scopeHints = Array.isArray(options.scopeHints) ? options.scopeHints : [];
    scopeHints.forEach((hint) => {
        scopePrefixes.add(buildVectorIndexStableDirectory_ACU({
            chatKey: String(hint.chatKey || reachability.chatKey),
            isolationKey: hint.isolationKey,
            sourceTableKey: hint.sourceTableKey,
        }));
    });
    reachability.reachableFiles.forEach((file) => {
        scopePrefixes.add(buildVectorIndexStableDirectory_ACU({
            chatKey: reachability.chatKey,
            isolationKey: file.isolationKey,
            sourceTableKey: file.sourceTableKey,
        }));
    });
    const deletedPaths: string[] = [];
    const retainedPaths: string[] = [];
    const blockedByReachability: string[] = [];
    const failedDeletes: Array<{ path: string; error: string }> = [];
    const scannedRegisteredFileCount = registry.files.length;
    let reachableFileCount = 0;
    for (const file of registry.files) {
        const path = String(file?.path || '').trim();
        if (!path) continue;
        const inScope = scopePrefixes.size > 0 && Array.from(scopePrefixes).some((prefix) => path.startsWith(prefix));
        if (!inScope) {
            retainedPaths.push(path);
            continue;
        }
        if (reachablePathSet.has(path)) {
            reachableFileCount += 1;
            retainedPaths.push(path);
            blockedByReachability.push(path);
            continue;
        }
        const result = await deleteVectorIndexFile_ACU(path);
        if (result.ok) {
            deletedPaths.push(result.path);
        } else {
            failedDeletes.push({ path, error: result.error || '删除失败' });
        }
    }
    if (deletedPaths.length > 0) {
        await unregisterVectorIndexFiles_ACU(deletedPaths);
    }
    return {
        scannedRegisteredFileCount,
        reachableFileCount,
        deletedPaths,
        retainedPaths,
        blockedByReachability,
        failedDeletes,
    };
}

async function cleanupVersionedSnapshotRetention_ACU(manifest: ChatSummaryVectorIndexManifest_ACU): Promise<number> {
    const scopePrefix = buildVersionedSnapshotScopePrefix_ACU(manifest.chatKey, manifest.isolationKey, manifest.sourceTableKey);
    if (SUMMARY_VECTOR_INDEX_SNAPSHOT_RETENTION_LIMIT_ACU <= 0) {
        logDebug_ACU(`[纪要向量索引] 已跳过版本化快照 retention 清理，保留可回退楼层引用: scope=${scopePrefix}, indexId=${manifest.indexId}`);
        return 0;
    }
    return 0;
}

export async function deleteSummaryVectorIndexExternalByScope_ACU(options: {
    chatKey?: string;
    isolationKey?: string;
    sourceTableKey?: string;
} = {}): Promise<string[]> {
    const chatKey = normalizeChatKey_ACU(options.chatKey);
    const isolationKey = options.isolationKey || getCurrentIsolationKey_ACU();
    const sourceTableKey = options.sourceTableKey || 'summary';
    const legacyScopePrefix = buildVectorIndexScopePrefix_ACU(chatKey, isolationKey);
    const stableScopePrefix = buildVectorIndexStableScopePrefix_ACU(chatKey, isolationKey, sourceTableKey);
    const legacyStableScopePrefix = buildLegacyVectorIndexStableScopePrefix_ACU(chatKey, isolationKey, sourceTableKey);
    const chatPart = normalizeVectorFileNamePart_ACU(chatKey || 'current-chat');
    const isolationPart = normalizeVectorFileNamePart_ACU(isolationKey || 'default');
    const sourceTablePart = normalizeVectorFileNamePart_ACU(sourceTableKey || 'summary');
    const strictFlatScopePrefix = `TavernDB_ACU_vector_${chatPart}_${isolationPart}_${sourceTablePart}_`;
    const removedPaths = await deleteRegisteredVectorIndexFilesWhere_ACU((file) => {
        const path = String(file?.path || '');
        if (!path.startsWith('TavernDB_ACU_vector_')) return false;
        return path.startsWith(legacyScopePrefix)
            || path.startsWith(stableScopePrefix)
            || path.startsWith(legacyStableScopePrefix)
            || path.startsWith(strictFlatScopePrefix);
    });
    if (removedPaths.length > 0) {
        logDebug_ACU(`[交火向量索引] 已按当前作用域清理外置文件: count=${removedPaths.length}`);
    }
    return removedPaths;
}

function buildBatchRef_ACU(params: {
    batchId: string;
    indexId: string;
    createdAt: string;
    updatedAt: string;
    rows: ChatSummaryVectorIndexRow_ACU[];
    chunks: ChatSummaryVectorIndexChunk_ACU[];
    files: SummaryVectorIndexExternalFileRef_ACU[];
    sourceMessageIndex?: number;
    sourceSnapshotMessageId?: string;
}): SummaryVectorIndexBatchRef_ACU {
    return {
        batchId: params.batchId,
        indexId: params.indexId,
        createdAt: params.createdAt,
        updatedAt: params.updatedAt,
        rowKeys: Array.from(new Set(params.rows.map((row) => row.rowKey).filter(Boolean))),
        chunkIds: Array.from(new Set(params.chunks.map((chunk) => chunk.chunkId).filter(Boolean))),
        files: [...params.files],
        rowCount: params.rows.length,
        chunkCount: params.chunks.length,
        sourceMessageIndex: params.sourceMessageIndex,
        sourceSnapshotMessageId: params.sourceSnapshotMessageId,
        status: 'ready',
    };
}

async function rollbackUploadedFiles_ACU(files: SummaryVectorIndexExternalFileRef_ACU[]): Promise<void> {
    const paths = files.map((file) => file.path).filter(Boolean);
    for (const path of paths) {
        await deleteVectorIndexFile_ACU(path);
    }
    await unregisterVectorIndexFiles_ACU(paths);
}

function getReusableRollingBaseBatch_ACU(manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined): SummaryVectorIndexBatchRef_ACU | null {
    if (manifest?.snapshot?.mode !== 'base_rolling_delta' || !Array.isArray(manifest.batchRefs)) return null;
    return manifest.batchRefs.find((batch) => (
        batch?.role === 'base'
        && (batch.files || []).some((file) => file.role === 'base_shard')
        && Array.isArray(batch.chunkIds) && batch.chunkIds.length > 0
    )) || null;
}

function collectRollingDeltaChangedRowKeys_ACU(params: {
    rows: ChatSummaryVectorIndexRow_ACU[];
    activeRowKeys: string[];
    removedRowKeys: string[];
    replacedRowKeys: string[];
    previousManifest?: ChatSummaryVectorIndexManifest_ACU | null;
}): Set<string> {
    const changedRowKeys = new Set<string>([...params.removedRowKeys, ...params.replacedRowKeys].filter(Boolean));
    const previousActiveRowKeys = new Set(params.previousManifest?.snapshot?.activeRowKeys || []);
    const previousActiveChunkIds = new Set(params.previousManifest?.snapshot?.activeChunkIds || []);
    const activeRowKeySet = new Set(params.activeRowKeys);
    params.rows.forEach((row) => {
        if (!activeRowKeySet.has(row.rowKey)) return;
        if (!previousActiveRowKeys.has(row.rowKey)) {
            changedRowKeys.add(row.rowKey);
            return;
        }
        const rowChunkIds = (row.chunkIds || []).filter(Boolean);
        if (rowChunkIds.some((chunkId) => !previousActiveChunkIds.has(chunkId))) {
            changedRowKeys.add(row.rowKey);
        }
    });
    return changedRowKeys;
}

async function persistSummaryVectorIndexSnapshotAsRollingDelta_ACU(params: {
    options: PersistSummaryVectorIndexSnapshotOptions_ACU;
    chatKey: string;
    isolationKey: string;
    indexedAt: string;
    snapshotRevision: number;
    indexId: string;
    rows: ChatSummaryVectorIndexRow_ACU[];
    chunks: ChatSummaryVectorIndexChunk_ACU[];
    activeRowKeys: string[];
    activeChunkIds: string[];
    dimension: number;
    foldThreshold: number;
}): Promise<PersistSummaryVectorIndexExternalResult_ACU> {
    const { options, chatKey, isolationKey, indexedAt, snapshotRevision, indexId, rows, chunks, activeRowKeys, activeChunkIds, dimension } = params;
    const uploadedFiles: SummaryVectorIndexExternalFileRef_ACU[] = [];
    try {
        const rowsByKey = new Map(rows.map((row) => [row.rowKey, row]));
        const chunkKeysByChunkId = new Map<string, string>();
        for (const chunk of chunks) {
            const row = rowsByKey.get(chunk.rowKey);
            const prepared = await prepareVectorChunkBlob_ACU(chunk, {
                embeddingModel: options.embeddingModel,
                dimension,
                sourceFingerprint: row?.sourceFingerprint,
            });
            chunkKeysByChunkId.set(chunk.chunkId, prepared.chunkKey);
        }

        const removedRowKeys = Array.from(new Set(options.removedRowKeys || []));
        const replacedRowKeys = Array.from(new Set(options.replacedRowKeys || []));
        const reusableBaseBatch = getReusableRollingBaseBatch_ACU(options.previousManifest);
        const changedRowKeys = collectRollingDeltaChangedRowKeys_ACU({
            rows,
            activeRowKeys,
            removedRowKeys,
            replacedRowKeys,
            previousManifest: options.previousManifest,
        });
        const reusableBaseChunkIds = new Set(reusableBaseBatch?.chunkIds || []);
        const foldThreshold = Math.max(1, Math.floor(Number(params.foldThreshold) || 1));
        const shouldFold = !reusableBaseBatch || reusableBaseChunkIds.size === 0 || changedRowKeys.size >= foldThreshold;
        const activeRowKeySet = new Set(activeRowKeys);
        const changedActiveRowKeys = new Set(Array.from(changedRowKeys).filter((rowKey) => activeRowKeySet.has(rowKey)));
        const baseChunks = shouldFold ? chunks : [];
        const deltaChunks = shouldFold ? [] : chunks.filter((chunk) => !reusableBaseChunkIds.has(chunk.chunkId) || changedActiveRowKeys.has(chunk.rowKey));
        const baseRows = shouldFold ? rows.filter((row) => activeRowKeySet.has(row.rowKey)) : [];
        const deltaRowKeys = new Set(deltaChunks.map((chunk) => chunk.rowKey).filter(Boolean));
        changedActiveRowKeys.forEach((rowKey) => deltaRowKeys.add(rowKey));
        const deltaRows = shouldFold ? [] : rows.filter((row) => activeRowKeySet.has(row.rowKey) && deltaRowKeys.has(row.rowKey));
        const shardIdsByChunkId = new Map<string, string>();

        const writeShard = async (role: 'base' | 'delta', shardId: string, shardChunks: ChatSummaryVectorIndexChunk_ACU[]): Promise<SummaryVectorIndexExternalFileRef_ACU | null> => {
            if (shardChunks.length === 0) return null;
            const chunksWithShard = shardChunks.map((chunk) => ({
                ...chunk,
                shardId,
                shardRole: role,
                chunkKeys: chunkKeysByChunkId.get(chunk.chunkId) ? [chunkKeysByChunkId.get(chunk.chunkId)!] : chunk.chunkKeys,
            }));
            chunksWithShard.forEach((chunk) => shardIdsByChunkId.set(chunk.chunkId, shardId));
            const cacheShard: SummaryVectorIndexShard_ACU = {
                version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
                indexId,
                shardId,
                role,
                createdAt: indexedAt,
                updatedAt: indexedAt,
                chunks: chunksWithShard,
            };
            const storedShard = {
                ...cacheShard,
                chunks: chunksWithShard.map((chunk) => encodeChunkVectorForStorage_ACU({ ...chunk })),
            };
            const path = buildVectorIndexFileName_ACU({ chatKey, isolationKey, indexId, role: role === 'base' ? 'base_shard' : 'delta_shard', shardId });
            const written = await uploadVectorIndexJsonFile_ACU({
                path,
                role: role === 'base' ? 'base_shard' : 'delta_shard',
                shardId,
                data: storedShard,
                chunkCount: chunksWithShard.length,
                status: 'ready',
            });
            if (!written.ok || !written.ref) throw new Error(written.error || `${role === 'base' ? 'base' : 'delta'} 分片 ${shardId} 上传失败`);
            uploadedFiles.push(written.ref);
            await putVectorIndexCachedShard_ACU(indexId, shardId, cacheShard, written.ref.checksum);
            return written.ref;
        };

        const baseShardRef = shouldFold ? await writeShard('base', 'base_0001', baseChunks) : null;
        const deltaShardRef = await writeShard('delta', 'delta_0001', deltaChunks);
        const baseBatch: SummaryVectorIndexBatchRef_ACU = shouldFold
            ? {
                ...buildBatchRef_ACU({
                    batchId: `base_${snapshotRevision}`,
                    indexId,
                    createdAt: indexedAt,
                    updatedAt: indexedAt,
                    rows: baseRows,
                    chunks: baseChunks,
                    files: baseShardRef ? [baseShardRef] : [],
                    sourceMessageIndex: options.sourceMessageIndex,
                    sourceSnapshotMessageId: options.snapshotMessageId,
                }),
                role: 'base',
            }
            : { ...reusableBaseBatch!, role: 'base' };
        const deltaBatch: SummaryVectorIndexBatchRef_ACU = {
            ...buildBatchRef_ACU({
                batchId: `delta_${snapshotRevision}`,
                indexId,
                createdAt: indexedAt,
                updatedAt: indexedAt,
                rows: deltaRows,
                chunks: deltaChunks,
                files: deltaShardRef ? [deltaShardRef] : [],
                sourceMessageIndex: options.sourceMessageIndex,
                sourceSnapshotMessageId: options.snapshotMessageId,
            }),
            role: 'delta',
            baseChunkIds: [...baseBatch.chunkIds],
        };
        const batchRefs = deltaBatch.files.length > 0 || removedRowKeys.length > 0 || replacedRowKeys.length > 0
            ? [baseBatch, deltaBatch]
            : [baseBatch];
        const parentIndexIds = Array.from(new Set([...(options.parentIndexIds || []), ...(options.previousManifest?.indexId ? [options.previousManifest.indexId] : [])].filter(Boolean)));
        const tombstone = buildTombstone_ACU(indexId, options.previousManifest, indexedAt);
        removedRowKeys.forEach((rowKey) => {
            tombstone.removedRows[rowKey] = { rowKey, chunkIds: [], reason: 'row_deleted', removedAt: indexedAt };
        });
        const manifestPath = buildVectorIndexFileName_ACU({ chatKey, isolationKey, indexId, role: 'manifest' });
        const baseShardIdsByChunkId = new Map<string, string[]>();
        if (!shouldFold && reusableBaseBatch) {
            const baseShardIds = Array.from(new Set((reusableBaseBatch.files || []).map((file) => file.shardId).filter((value): value is string => !!value)));
            reusableBaseChunkIds.forEach((chunkId) => baseShardIdsByChunkId.set(chunkId, baseShardIds));
        }
        const rowsWithShardIds = rows.map((row) => ({
            ...row,
            shardIds: Array.from(new Set(row.chunkIds.flatMap((chunkId) => [
                ...(baseShardIdsByChunkId.get(chunkId) || []),
                ...(shardIdsByChunkId.get(chunkId) ? [shardIdsByChunkId.get(chunkId)!] : []),
            ]))),
            chunkKeys: Array.from(new Set(row.chunkIds.map((chunkId) => chunkKeysByChunkId.get(chunkId)).filter((value): value is string => !!value))),
        }));
        const checkpoint = {
            version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
            checkpointId: `checkpoint_${hashUserInput_ACU(`${indexId}\n${options.snapshotMessageId}\n${indexedAt}`)}`,
            manifestKey: indexId,
            sourceTableKey: options.sourceTableKey,
            snapshotMessageId: options.snapshotMessageId,
            rowCount: rowsWithShardIds.length,
            chunkCount: chunks.length,
            activeRowKeys,
            createdAt: indexedAt,
        };
        const manifestDraft: ChatSummaryVectorIndexManifest_ACU = {
            version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
            backend: 'st-files',
            status: 'ready',
            indexId,
            chatKey,
            isolationKey,
            snapshotMessageId: options.snapshotMessageId,
            sourceTableKey: options.sourceTableKey,
            sourceTableName: options.sourceTableName,
            indexedAt,
            updatedAt: indexedAt,
            rowCount: rowsWithShardIds.length,
            chunkCount: chunks.length,
            skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
            embeddingModel: options.embeddingModel,
            dimension,
            rowsFile: manifestPath,
            tombstoneFile: manifestPath,
            manifestFile: manifestPath,
            files: [],
            baseShardCount: baseBatch.files.filter((file) => file.role === 'base_shard').length,
            deltaShardCount: deltaBatch.files.filter((file) => file.role === 'delta_shard').length,
            tombstoneRowCount: removedRowKeys.length,
            tombstoneChunkCount: 0,
            externalTotalBytes: uploadedFiles.reduce((sum, file) => sum + Math.max(0, Number(file.byteSize) || 0), 0),
            snapshot: {
                revision: snapshotRevision,
                mode: 'base_rolling_delta',
                parentIndexIds,
                activeRowKeys,
                activeChunkIds: chunks.map((chunk) => chunk.chunkId),
                removedRowKeys,
                replacedRowKeys,
                batchIds: batchRefs.map((batch) => batch.batchId),
            },
            batchRefs,
            checkpoint,
        };
        const manifestWritten = await uploadVectorIndexJsonFile_ACU({ path: manifestPath, role: 'manifest', data: manifestDraft, rowCount: rowsWithShardIds.length, chunkCount: chunks.length, status: 'ready' });
        if (!manifestWritten.ok || !manifestWritten.ref) throw new Error(manifestWritten.error || 'rolling delta manifest 上传失败');
        uploadedFiles.push(manifestWritten.ref);
        const finalManifest: ChatSummaryVectorIndexManifest_ACU = {
            ...manifestDraft,
            files: [manifestWritten.ref, ...uploadedFiles.filter((file) => file.path !== manifestWritten.ref!.path)],
            externalTotalBytes: sumUniqueVectorIndexFileBytes_ACU([
                manifestWritten.ref,
                ...batchRefs.flatMap((batch) => batch.files || []),
            ]),
        };
        const state: ChatSummaryVectorIndexState_ACU = {
            version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
            backend: 'st-files',
            status: 'ready',
            indexId,
            snapshotMessageId: options.snapshotMessageId,
            sourceTableKey: options.sourceTableKey,
            sourceTableName: options.sourceTableName,
            indexedAt,
            rowCount: rowsWithShardIds.length,
            chunkCount: chunks.length,
            skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
            rows: rowsWithShardIds,
            manifest: finalManifest,
        };
        await putSummaryVectorHotCacheChunks_ACU({ manifest: finalManifest, chunks });
        await registerVectorIndexFiles_ACU(uploadedFiles);
        const retainedPaths = collectManifestFilePaths_ACU(finalManifest);
        try {
            await cleanupManifestFilesExcept_ACU(options.previousManifest, retainedPaths);
            await cleanupSnapshotScopeFilesExcept_ACU(finalManifest, retainedPaths, { includeSameSourceTableFallback: true });
        } catch (error) {
            logWarn_ACU('[纪要向量索引] rolling delta 旧分片清理失败，保留当前快照继续运行:', error);
        }
        logDebug_ACU(`[交火向量索引] 已写入 rolling delta 快照：fold=${shouldFold ? 'yes' : 'no'} changedRows=${changedRowKeys.size}`);
        return { state, manifest: finalManifest, uploadedFiles };
    } catch (error) {
        await rollbackUploadedFiles_ACU(uploadedFiles);
        throw error;
    }
}

export async function persistSummaryVectorIndexExternal_ACU(
    options: PersistSummaryVectorIndexExternalOptions_ACU,
): Promise<PersistSummaryVectorIndexExternalResult_ACU> {
    const chatKey = normalizeChatKey_ACU(options.chatKey);
    const isolationKey = options.isolationKey || getCurrentIsolationKey_ACU();
    const indexedAt = options.indexedAt || new Date().toISOString();
    const indexId = buildIndexId_ACU({ chatKey, isolationKey, sourceTableKey: options.sourceTableKey, snapshotMessageId: options.snapshotMessageId, indexedAt });
    const rows = normalizeRows_ACU(options.rows);
    const chunks = normalizeChunks_ACU(options.chunks);
    if (rows.length === 0 || chunks.length === 0) {
        throw new Error('交火向量索引为空，拒绝写入外置文件。');
    }
    const dimension = chunks[0]?.vector?.length || 0;
    if (dimension <= 0) {
        throw new Error('交火向量索引缺少有效向量维度。');
    }
    const uploadedFiles: SummaryVectorIndexExternalFileRef_ACU[] = [];
    try {
        const shardIdsByChunkId = new Map<string, string>();
        const shardRefs: SummaryVectorIndexExternalFileRef_ACU[] = [];
        const shardGroups = chunkArray_ACU(chunks, options.shardChunkLimit || DEFAULT_SHARD_CHUNK_LIMIT_ACU);
        for (let shardIndex = 0; shardIndex < shardGroups.length; shardIndex += 1) {
            const shardId = `base_${String(shardIndex + 1).padStart(4, '0')}`;
            const shardChunks = shardGroups[shardIndex].map((chunk) => ({ ...chunk, shardId, shardRole: 'base' as const }));
            shardChunks.forEach((chunk) => shardIdsByChunkId.set(chunk.chunkId, shardId));
            const shard: SummaryVectorIndexShard_ACU = {
                version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
                indexId,
                shardId,
                role: 'base',
                createdAt: indexedAt,
                updatedAt: indexedAt,
                chunks: shardChunks,
            };
            const path = buildVectorIndexFileName_ACU({ chatKey, isolationKey, indexId, role: 'base_shard', shardId });
            const written = await uploadVectorIndexJsonFile_ACU({ path, role: 'base_shard', shardId, data: shard, chunkCount: shardChunks.length, status: 'ready' });
            if (!written.ok || !written.ref) throw new Error(written.error || `分片 ${shardId} 上传失败`);
            uploadedFiles.push(written.ref);
            shardRefs.push(written.ref);
            await putVectorIndexCachedShard_ACU(indexId, shardId, shard, written.ref.checksum);
        }

        const rowIndex = buildRowIndex_ACU(indexId, rows.map((row) => ({
            ...row,
            shardIds: Array.from(new Set(row.chunkIds.map((chunkId) => shardIdsByChunkId.get(chunkId)).filter((value): value is string => !!value))),
        })), shardIdsByChunkId, indexedAt);
        const tombstone = buildTombstone_ACU(indexId, options.previousManifest, indexedAt);
        const rowIndexPath = buildVectorIndexFileName_ACU({ chatKey, isolationKey, indexId, role: 'row_index' });
        const rowIndexWritten = await uploadVectorIndexJsonFile_ACU({ path: rowIndexPath, role: 'row_index', data: rowIndex, rowCount: rows.length, status: 'ready' });
        if (!rowIndexWritten.ok || !rowIndexWritten.ref) throw new Error(rowIndexWritten.error || 'rowIndex 上传失败');
        uploadedFiles.push(rowIndexWritten.ref);

        const tombstonePath = buildVectorIndexFileName_ACU({ chatKey, isolationKey, indexId, role: 'tombstone' });
        const tombstoneWritten = await uploadVectorIndexJsonFile_ACU({ path: tombstonePath, role: 'tombstone', data: tombstone, status: 'ready' });
        if (!tombstoneWritten.ok || !tombstoneWritten.ref) throw new Error(tombstoneWritten.error || 'tombstone 上传失败');
        uploadedFiles.push(tombstoneWritten.ref);

        const manifestPath = buildVectorIndexFileName_ACU({ chatKey, isolationKey, indexId, role: 'manifest' });
        const externalTotalBytesWithoutManifest = uploadedFiles.reduce((sum, file) => sum + Math.max(0, Number(file.byteSize) || 0), 0);
        const manifestDraft: ChatSummaryVectorIndexManifest_ACU = {
            version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
            backend: 'st-files',
            status: 'ready',
            indexId,
            chatKey,
            isolationKey,
            snapshotMessageId: options.snapshotMessageId,
            sourceTableKey: options.sourceTableKey,
            sourceTableName: options.sourceTableName,
            indexedAt,
            updatedAt: indexedAt,
            rowCount: rows.length,
            chunkCount: chunks.length,
            skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
            embeddingModel: options.embeddingModel,
            dimension,
            rowsFile: rowIndexPath,
            tombstoneFile: tombstonePath,
            manifestFile: manifestPath,
            files: [],
            baseShardCount: shardRefs.length,
            deltaShardCount: 0,
            tombstoneRowCount: 0,
            tombstoneChunkCount: 0,
            externalTotalBytes: externalTotalBytesWithoutManifest,
        };
        const manifestWritten = await uploadVectorIndexJsonFile_ACU({ path: manifestPath, role: 'manifest', data: { ...manifestDraft, files: uploadedFiles }, status: 'ready' });
        if (!manifestWritten.ok || !manifestWritten.ref) throw new Error(manifestWritten.error || 'manifest 上传失败');
        uploadedFiles.push(manifestWritten.ref);
        const manifest: ChatSummaryVectorIndexManifest_ACU = {
            ...manifestDraft,
            files: [...uploadedFiles],
            externalTotalBytes: uploadedFiles.reduce((sum, file) => sum + Math.max(0, Number(file.byteSize) || 0), 0),
        };
        await registerVectorIndexFiles_ACU(uploadedFiles);
        await cleanupPreviousManifest_ACU(options.previousManifest);
        const lightweightRows = rows.map((row) => ({
            ...row,
            shardIds: Array.from(new Set(row.chunkIds.map((chunkId) => shardIdsByChunkId.get(chunkId)).filter((value): value is string => !!value))),
        }));
        const state: ChatSummaryVectorIndexState_ACU = {
            version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
            backend: 'st-files',
            status: 'ready',
            indexId,
            snapshotMessageId: options.snapshotMessageId,
            sourceTableKey: options.sourceTableKey,
            sourceTableName: options.sourceTableName,
            indexedAt,
            rowCount: rows.length,
            chunkCount: chunks.length,
            skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
            rows: lightweightRows,
            manifest,
        };
        return { state, manifest, uploadedFiles };
    } catch (error) {
        await rollbackUploadedFiles_ACU(uploadedFiles);
        throw error;
    }
}

export async function persistSummaryVectorIndexSnapshot_ACU(
    options: PersistSummaryVectorIndexSnapshotOptions_ACU,
): Promise<PersistSummaryVectorIndexExternalResult_ACU> {
    const chatKey = normalizeChatKey_ACU(options.chatKey);
    const isolationKey = options.isolationKey || getCurrentIsolationKey_ACU();
    const indexedAt = options.indexedAt || new Date().toISOString();
    const snapshotRevision = Math.max(1, Math.floor(Number(options.snapshotRevision) || 0) + 1);
    const indexId = buildVersionedSnapshotIndexId_ACU({ chatKey, isolationKey, sourceTableKey: options.sourceTableKey, snapshotRevision });
    const rows = normalizeRows_ACU(options.rows);
    const allChunks = normalizeChunks_ACU(options.chunks);
    const activeRowKeys = Array.from(new Set(options.activeRowKeys?.length ? options.activeRowKeys : rows.map((row) => row.rowKey)));
    const activeChunkIds = Array.from(new Set(options.activeChunkIds?.length ? options.activeChunkIds : rows.flatMap((row) => row.chunkIds || [])));
    const activeRowKeySet = new Set(activeRowKeys);
    const activeChunkIdSet = new Set(activeChunkIds);
    const chunks = allChunks.filter((chunk) => activeRowKeySet.has(chunk.rowKey) && activeChunkIdSet.has(chunk.chunkId));
    if (rows.length === 0 || chunks.length === 0 || activeChunkIds.length === 0) {
        throw new Error('交火向量快照索引为空，拒绝写入外置文件。');
    }
    const dimension = chunks[0]?.vector?.length || 0;
    if (dimension <= 0) {
        throw new Error('交火向量快照索引缺少有效向量维度。');
    }
    const summaryVectorIndexConfig = getEffectiveSummaryVectorIndexConfig_ACU();
    if (summaryVectorIndexConfig.summaryIndexRollingDeltaEnabled) {
        return persistSummaryVectorIndexSnapshotAsRollingDelta_ACU({
            options,
            chatKey,
            isolationKey,
            indexedAt,
            snapshotRevision,
            indexId,
            rows,
            chunks,
            activeRowKeys,
            activeChunkIds,
            dimension,
            foldThreshold: summaryVectorIndexConfig.summaryIndexRollingDeltaFoldThreshold,
        });
    }

    const rowsByKey = new Map(rows.map((row) => [row.rowKey, row]));
    const chunkKeysByChunkId = new Map<string, string>();
    for (const chunk of chunks) {
        const row = rowsByKey.get(chunk.rowKey);
        const prepared = await prepareVectorChunkBlob_ACU(chunk, {
            embeddingModel: options.embeddingModel,
            dimension,
            sourceFingerprint: row?.sourceFingerprint,
        });
        chunkKeysByChunkId.set(chunk.chunkId, prepared.chunkKey);
    }

    const rowsWithShardIds = rows.map((row) => ({
        ...row,
        shardIds: [] as string[],
        chunkKeys: Array.from(new Set(row.chunkIds.map((chunkId) => chunkKeysByChunkId.get(chunkId)).filter((value): value is string => !!value))),
    }));
    const tombstone = buildTombstone_ACU(indexId, options.previousManifest, indexedAt);
    const removedRowKeys = Array.from(new Set(options.removedRowKeys || []));
    removedRowKeys.forEach((rowKey) => {
        tombstone.removedRows[rowKey] = {
            rowKey,
            chunkIds: [],
            reason: 'row_deleted',
            removedAt: indexedAt,
        };
    });
    const replacedRowKeys = Array.from(new Set(options.replacedRowKeys || []));
    const parentIndexIds = Array.from(new Set([...(options.parentIndexIds || []), ...(options.previousManifest?.indexId ? [options.previousManifest.indexId] : [])].filter(Boolean)));
    // [spv3.6.8] 传入角色名，使外置快照文件名包含可识别的角色名前缀
    const chatName = getCurrentCharacterCardName_ACU();
    const snapshotPath = buildVectorIndexSingleSnapshotFilePath_ACU({ chatKey, isolationKey, sourceTableKey: options.sourceTableKey, chatName });
    const checkpoint = {
        version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
        checkpointId: `checkpoint_${hashUserInput_ACU(`${indexId}\n${options.snapshotMessageId}\n${indexedAt}`)}`,
        manifestKey: indexId,
        sourceTableKey: options.sourceTableKey,
        snapshotMessageId: options.snapshotMessageId,
        rowCount: rowsWithShardIds.length,
        chunkCount: chunks.length,
        activeRowKeys,
        createdAt: indexedAt,
    };
    const manifestDraft: ChatSummaryVectorIndexManifest_ACU = {
        version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
        backend: 'st-files',
        status: 'ready',
        indexId,
        chatKey,
        isolationKey,
        snapshotMessageId: options.snapshotMessageId,
        sourceTableKey: options.sourceTableKey,
        sourceTableName: options.sourceTableName,
        indexedAt,
        updatedAt: indexedAt,
        rowCount: rowsWithShardIds.length,
        chunkCount: chunks.length,
        skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
        embeddingModel: options.embeddingModel,
        dimension,
        rowsFile: snapshotPath,
        tombstoneFile: snapshotPath,
        manifestFile: snapshotPath,
        files: [],
        baseShardCount: 0,
        deltaShardCount: 0,
        tombstoneRowCount: removedRowKeys.length,
        tombstoneChunkCount: 0,
        externalTotalBytes: 0,
        snapshot: {
            revision: snapshotRevision,
            mode: 'single_file_snapshot',
            parentIndexIds,
            activeRowKeys,
            activeChunkIds: chunks.map((chunk) => chunk.chunkId),
            removedRowKeys,
            replacedRowKeys,
            batchIds: [],
        },
        batchRefs: [],
        checkpoint,
    };
    const snapshotBlob: VectorIndexSingleSnapshotBlob_ACU = {
        version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
        schema: 'single_file_snapshot',
        indexId,
        chatKey,
        isolationKey,
        sourceTableKey: options.sourceTableKey,
        sourceTableName: options.sourceTableName,
        snapshotMessageId: options.snapshotMessageId,
        embeddingModel: options.embeddingModel,
        dimension,
        indexedAt,
        updatedAt: indexedAt,
        manifest: manifestDraft,
        rows: rowsWithShardIds,
        chunks: chunks.map((chunk) => encodeChunkVectorForStorage_ACU({ ...chunk, chunkKeys: chunkKeysByChunkId.get(chunk.chunkId) ? [chunkKeysByChunkId.get(chunk.chunkId)!] : chunk.chunkKeys })),
        tombstone,
    };
    const written = await uploadVectorIndexJsonFile_ACU({
        path: snapshotPath,
        role: 'manifest',
        data: snapshotBlob,
        chunkCount: chunks.length,
        rowCount: rowsWithShardIds.length,
        status: 'ready',
    });
    if (!written.ok || !written.ref) throw new Error(written.error || '单文件交火向量快照写入失败');

    const finalManifest: ChatSummaryVectorIndexManifest_ACU = {
        ...manifestDraft,
        files: [written.ref],
        externalTotalBytes: written.ref.byteSize,
    };
    const state: ChatSummaryVectorIndexState_ACU = {
        version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
        backend: 'st-files',
        status: 'ready',
        indexId,
        snapshotMessageId: options.snapshotMessageId,
        sourceTableKey: options.sourceTableKey,
        sourceTableName: options.sourceTableName,
        indexedAt,
        rowCount: rowsWithShardIds.length,
        chunkCount: chunks.length,
        skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
        rows: rowsWithShardIds,
        manifest: finalManifest,
    };
    await putSummaryVectorHotCacheChunks_ACU({ manifest: finalManifest, chunks });
    await registerVectorIndexFiles_ACU([written.ref]);
    const retainedPaths = new Set<string>([snapshotPath]);
    try {
        await cleanupManifestFilesExcept_ACU(options.previousManifest, retainedPaths);
        await cleanupSnapshotScopeFilesExcept_ACU(finalManifest, retainedPaths, { includeSameSourceTableFallback: true });
    } catch (error) {
        logWarn_ACU('[纪要向量索引] 单文件快照旧分片清理失败，保留当前快照继续运行:', error);
    }
    return { state, manifest: finalManifest, uploadedFiles: [written.ref] };
}

async function loadOneShardChunks_ACU(
    indexId: string,
    ref: SummaryVectorIndexExternalFileRef_ACU,
    options: LoadSummaryVectorIndexChunksOptions_ACU = {},
): Promise<ChatSummaryVectorIndexChunk_ACU[]> {
    if (!ref.shardId) return [];
    let shard: SummaryVectorIndexShard_ACU | null = null;
    if (options.preferExternalFiles !== true) {
        shard = await getVectorIndexCachedShard_ACU(indexId, ref.shardId, ref.checksum || '');
    }
    if (!shard) {
        const loaded = await readVectorIndexJsonFile_ACU<SummaryVectorIndexShard_ACU>(ref.path);
        if (!loaded.ok || !loaded.data) {
            throw new Error(`交火向量索引分片读取失败: ${ref.path} ${loaded.error || ''}`.trim());
        }
        const loadedShard = loaded.data;
        const loadedShardId = String(loadedShard?.shardId || '');
        const loadedIndexId = String(loadedShard?.indexId || '');
        const shardMatchesManifest = loadedIndexId === indexId && loadedShardId === ref.shardId;
        if (!shardMatchesManifest) {
            throw new Error(`交火向量索引分片身份不匹配: ${ref.path} expectedIndex=${indexId} actualIndex=${loadedIndexId || 'empty'} expectedShard=${ref.shardId} actualShard=${loadedShardId || 'empty'}`);
        }
        const json = JSON.stringify(loadedShard);
        const checksum = await sha256Text_ACU(json);
        if (ref.checksum && checksum !== ref.checksum) {
            throw new Error(`交火向量索引分片校验失败: ${ref.path} expected=${ref.checksum} actual=${checksum}`);
        }
        shard = {
            ...loadedShard,
            chunks: decodeChunkVectorsInPlace_ACU((loadedShard.chunks || []).map((chunk) => ({ ...chunk }) as StoredVectorIndexChunk_ACU)),
        };
        await putVectorIndexCachedShard_ACU(indexId, ref.shardId, shard, checksum || ref.checksum);
    }
    return (shard.chunks || [])
        .map((chunk) => ({ ...chunk, vector: Array.isArray(chunk.vector) ? [...chunk.vector] : chunk.vector } as StoredVectorIndexChunk_ACU))
        .map((chunk) => decodeChunkVectorInPlace_ACU(chunk))
        .filter((chunk) => Array.isArray(chunk.vector) && chunk.vector.length > 0);
}

async function loadChunksFromShardRefs_ACU(
    indexId: string,
    shardRefs: SummaryVectorIndexExternalFileRef_ACU[],
    options: LoadSummaryVectorIndexChunksOptions_ACU = {},
): Promise<ChatSummaryVectorIndexChunk_ACU[]> {
    const refs = (Array.isArray(shardRefs) ? shardRefs : []).filter((ref) => !!ref?.shardId);
    if (refs.length === 0) return [];
    const concurrency = Math.max(1, Math.min(24, Math.floor(Number(options.shardReadConcurrency) || 6)));
    const orderedResults: ChatSummaryVectorIndexChunk_ACU[][] = Array.from({ length: refs.length }, (): ChatSummaryVectorIndexChunk_ACU[] => []);
    for (let offset = 0; offset < refs.length; offset += concurrency) {
        const batch = refs.slice(offset, offset + concurrency);
        await Promise.all(batch.map(async (ref, batchIndex) => {
            orderedResults[offset + batchIndex] = await loadOneShardChunks_ACU(indexId, ref, options);
        }));
    }
    return orderedResults.flat();
}

async function loadChunksFromContentAddressedRefs_ACU(
    manifest: ChatSummaryVectorIndexManifest_ACU,
    options: LoadSummaryVectorIndexChunksOptions_ACU = {},
): Promise<ChatSummaryVectorIndexChunk_ACU[]> {
    const info = manifest.contentAddressed;
    if (!info?.chunkRefs?.length) return [];
    const activeChunkKeys = new Set((info.activeChunkKeys || []).map((item) => String(item)));
    const chunks: ChatSummaryVectorIndexChunk_ACU[] = [];

    const decodeContentAddressedChunkBlob_ACU = (
        blob: VectorIndexChunkBlob_ACU,
        ref: SummaryVectorIndexChunkRef_ACU,
        sourcePath: string,
    ): ChatSummaryVectorIndexChunk_ACU => {
        let decoded: ChatSummaryVectorIndexChunk_ACU;
        try {
            decoded = decodeChunkVectorInPlace_ACU({
                ...blob,
                chunkId: String(blob.chunkId || ref.chunkId),
                rowKey: String(blob.rowKey || ref.rowKey),
                rowOrder: Number(blob.rowOrder || 0),
                text: String(blob.text || ''),
                sequence: Number(blob.sequence || 0),
                sourceFingerprint: blob.sourceFingerprint || ref.sourceFingerprint,
                textHash: blob.textHash || ref.textHash,
                shardId: undefined,
                shardRole: undefined,
                chunkKeys: [ref.chunkKey],
            } as StoredVectorIndexChunk_ACU);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error || '未知错误');
            throw new Error(`交火向量索引内容块校验失败: ${sourcePath} chunk=${ref.chunkKey} ${message}`.trim());
        }
        if (!Array.isArray(decoded.vector) || decoded.vector.length === 0) {
            throw new Error(`交火向量索引内容块校验失败: ${sourcePath} chunk=${ref.chunkKey} vector_empty`);
        }
        return decoded;
    };

    if (info.mode === 'content_addressed_packs' && Array.isArray(info.packRefs) && info.packRefs.length > 0) {
        const packRefsByKey = new Map<string, SummaryVectorIndexPackRef_ACU>();
        info.packRefs.forEach((packRef) => {
            const packKey = String(packRef.packKey || '').trim();
            if (packKey && packRef.path) packRefsByKey.set(packKey, packRef);
        });
        const chunkRefsByPackKey = new Map<string, typeof info.chunkRefs>();
        for (const ref of info.chunkRefs) {
            if (activeChunkKeys.size > 0 && !activeChunkKeys.has(ref.chunkKey)) continue;
            const packKey = String(ref.packKey || '').trim();
            if (!packKey) throw new Error(`交火向量索引内容包引用缺少 packKey: ${ref.path}`);
            const refs = chunkRefsByPackKey.get(packKey) || [];
            refs.push(ref);
            chunkRefsByPackKey.set(packKey, refs);
        }
        for (const [packKey, refs] of chunkRefsByPackKey.entries()) {
            const packRef = packRefsByKey.get(packKey);
            if (!packRef) throw new Error(`交火向量索引内容包缺少 manifest 引用: packKey=${packKey}`);
            const loaded = await readVectorIndexJsonFile_ACU<VectorIndexPackBlob_ACU>(packRef.path);
            if (!loaded.ok || !loaded.data) {
                throw new Error(`交火向量索引内容包读取失败: ${packRef.path} ${loaded.error || ''}`.trim());
            }
            const packBlob = loaded.data;
            if (String(packBlob.packKey || '') !== packKey || String(packBlob.indexId || '') !== manifest.indexId) {
                throw new Error(`交火向量索引内容包身份不匹配: ${packRef.path} expectedPack=${packKey} actualPack=${String(packBlob.packKey || 'empty')} expectedIndex=${manifest.indexId} actualIndex=${String(packBlob.indexId || 'empty')}`);
            }
            const packChecksum = await sha256Text_ACU(JSON.stringify(packBlob));
            if (packRef.checksum && packChecksum !== packRef.checksum) {
                throw new Error(`交火向量索引内容包校验失败: ${packRef.path} expected=${packRef.checksum} actual=${packChecksum}`);
            }
            const blobsByChunkKey = new Map<string, VectorIndexChunkBlob_ACU>();
            (packBlob.chunks || []).forEach((blob) => {
                const chunkKey = String(blob?.chunkKey || '').trim();
                if (chunkKey && !blobsByChunkKey.has(chunkKey)) blobsByChunkKey.set(chunkKey, blob);
            });
            for (const ref of refs) {
                const blob = blobsByChunkKey.get(ref.chunkKey);
                if (!blob) throw new Error(`交火向量索引内容包缺少 chunk: pack=${packKey} chunk=${ref.chunkKey}`);
                if (String(blob.chunkKey || '') !== ref.chunkKey || String(blob.chunkId || '') !== ref.chunkId || String(blob.rowKey || '') !== ref.rowKey) {
                    throw new Error(`交火向量索引内容块身份不匹配: ${packRef.path} expectedChunk=${ref.chunkKey} actualChunk=${String(blob.chunkKey || 'empty')} expectedRow=${ref.rowKey} actualRow=${String(blob.rowKey || 'empty')}`);
                }
                const chunkChecksum = await sha256Text_ACU(JSON.stringify(blob));
                if (ref.checksum && chunkChecksum !== ref.checksum) {
                    throw new Error(`交火向量索引内容块校验失败: ${packRef.path} expected=${ref.checksum} actual=${chunkChecksum}`);
                }
                chunks.push(decodeContentAddressedChunkBlob_ACU(blob, ref, packRef.path));
            }
        }
        return chunks.sort((left, right) => left.sequence - right.sequence || left.chunkId.localeCompare(right.chunkId));
    }

    for (const ref of info.chunkRefs) {
        if (activeChunkKeys.size > 0 && !activeChunkKeys.has(ref.chunkKey)) continue;
        const loaded = await readVectorIndexJsonFile_ACU<VectorIndexChunkBlob_ACU>(ref.path);
        if (!loaded.ok || !loaded.data) {
            throw new Error(`交火向量索引内容块读取失败: ${ref.path} ${loaded.error || ''}`.trim());
        }
        const blob = loaded.data;
        if (String(blob.chunkKey || '') !== ref.chunkKey || String(blob.chunkId || '') !== ref.chunkId || String(blob.rowKey || '') !== ref.rowKey) {
            throw new Error(`交火向量索引内容块身份不匹配: ${ref.path} expectedChunk=${ref.chunkKey} actualChunk=${String(blob.chunkKey || 'empty')} expectedRow=${ref.rowKey} actualRow=${String(blob.rowKey || 'empty')}`);
        }
        const checksum = await sha256Text_ACU(JSON.stringify(blob));
        if (ref.checksum && checksum !== ref.checksum) {
            throw new Error(`交火向量索引内容块校验失败: ${ref.path} expected=${ref.checksum} actual=${checksum}`);
        }
        chunks.push(decodeContentAddressedChunkBlob_ACU(blob, ref, ref.path));
    }
    return chunks.sort((left, right) => left.sequence - right.sequence || left.chunkId.localeCompare(right.chunkId));
}

function sortAndDedupeVectorChunks_ACU(chunks: ChatSummaryVectorIndexChunk_ACU[]): ChatSummaryVectorIndexChunk_ACU[] {
    const byChunkId = new Map<string, ChatSummaryVectorIndexChunk_ACU>();
    (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
        if (!chunk?.chunkId || !chunk.rowKey || !Array.isArray(chunk.vector) || chunk.vector.length === 0) return;
        byChunkId.set(chunk.chunkId, { ...chunk });
    });
    // batchRefs 按 base -> delta 读取；相同 chunkId 必须让后出现的 delta 覆盖 base。
    return Array.from(byChunkId.values()).sort((left, right) => left.sequence - right.sequence || left.chunkId.localeCompare(right.chunkId));
}

function isSingleFileSnapshotManifest_ACU(manifest: ChatSummaryVectorIndexManifest_ACU): boolean {
    const explicitMode = manifest.snapshot?.mode;
    if (explicitMode) return explicitMode === 'single_file_snapshot';
    const manifestPath = String(manifest.manifestFile || '').trim();
    return !!manifestPath && manifest.rowsFile === manifestPath && manifest.tombstoneFile === manifestPath;
}

async function loadChunksFromSingleFileSnapshot_ACU(
    manifest: ChatSummaryVectorIndexManifest_ACU,
): Promise<ChatSummaryVectorIndexChunk_ACU[]> {
    const snapshotPath = String(manifest.manifestFile || manifest.files?.[0]?.path || '').trim();
    if (!snapshotPath) throw new Error('交火向量单文件快照缺少 manifestFile 路径。');
    const loaded = await readVectorIndexJsonFile_ACU<VectorIndexSingleSnapshotBlob_ACU>(snapshotPath);
    if (!loaded.ok || !loaded.data) {
        throw new Error(`交火向量单文件快照读取失败: ${snapshotPath} ${loaded.error || ''}`.trim());
    }
    const blob = loaded.data;
    if (blob.schema !== 'single_file_snapshot') {
        throw new Error(`交火向量单文件快照协议不匹配: ${snapshotPath}`);
    }
    if (String(blob.indexId || '') !== String(manifest.indexId || '')) {
        throw new Error(`交火向量单文件快照身份不匹配: ${snapshotPath} expectedIndex=${manifest.indexId} actualIndex=${String(blob.indexId || 'empty')}`);
    }
    if (String(blob.sourceTableKey || '') !== String(manifest.sourceTableKey || '')) {
        throw new Error(`交火向量单文件快照表标识不匹配: ${snapshotPath} expectedTable=${manifest.sourceTableKey} actualTable=${String(blob.sourceTableKey || 'empty')}`);
    }
    const decodedChunks = decodeChunkVectorsInPlace_ACU(Array.isArray(blob.chunks) ? blob.chunks : []);
    const chunks = sortAndDedupeVectorChunks_ACU(decodedChunks);
    if (manifest.chunkCount > 0 && chunks.length === 0) {
        throw new Error(`交火向量单文件快照缺少有效 chunks: ${snapshotPath}`);
    }
    return chunks;
}

export function isLegacySummaryVectorIndexManifest_ACU(manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined): boolean {
    const normalized = normalizeSummaryVectorIndexManifestForRead_ACU(manifest);
    if (!normalized) return false;
    if (normalized.contentAddressed?.chunkRefs?.length) return false;
    return normalized.files.some((file) => file.role === 'base_shard' || file.role === 'delta_shard')
        || normalized.batchRefs.some((batch) => (batch.files || []).some((file) => file.role === 'base_shard' || file.role === 'delta_shard'));
}

export async function loadSummaryVectorIndexChunksFromManifest_ACU(
    manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined,
    options: LoadSummaryVectorIndexChunksOptions_ACU = {},
): Promise<ChatSummaryVectorIndexChunk_ACU[]> {
    manifest = normalizeSummaryVectorIndexManifestForRead_ACU(manifest);
    if (!manifest) return [];
    if (isSingleFileSnapshotManifest_ACU(manifest)) {
        if (options.preferExternalFiles !== true) {
            const cachedChunks = await getSummaryVectorHotCacheChunks_ACU({ manifest });
            if (cachedChunks?.length) {
                logDebug_ACU('[交火向量索引] 已从 IndexedDB 热缓存加载单文件快照向量块。');
                return cachedChunks;
            }
        }
        const chunks = await loadChunksFromSingleFileSnapshot_ACU(manifest);
        await putSummaryVectorHotCacheChunks_ACU({ manifest, chunks });
        logDebug_ACU('[交火向量索引] 已按单文件快照加载向量块并回填热缓存。');
        return chunks;
    }
    if (manifest.contentAddressed?.chunkRefs?.length) {
        if (options.preferExternalFiles !== true) {
            const cachedChunks = await getSummaryVectorHotCacheChunks_ACU({ manifest });
            if (cachedChunks?.length) {
                logDebug_ACU('[交火向量索引] 已从 IndexedDB 热缓存加载内容寻址向量块。');
                return cachedChunks;
            }
        }
        const chunks = await loadChunksFromContentAddressedRefs_ACU(manifest, options);
        await putSummaryVectorHotCacheChunks_ACU({ manifest, chunks });
        logDebug_ACU('[交火向量索引] 已按内容寻址 manifest 加载向量块并回填热缓存。');
        return chunks;
    }
    if (Array.isArray(manifest.batchRefs) && manifest.batchRefs.length > 0) {
        const activeRowKeys = new Set(manifest.snapshot?.activeRowKeys || []);
        const activeChunkIds = new Set(manifest.snapshot?.activeChunkIds || []);
        const removedRowKeys = new Set(manifest.snapshot?.removedRowKeys || []);
        const chunks: ChatSummaryVectorIndexChunk_ACU[] = [];
        for (const batch of manifest.batchRefs) {
            const shardRefs = (batch.files || []).filter((file) => file.role === 'base_shard' || file.role === 'delta_shard');
            const batchChunks = await loadChunksFromShardRefs_ACU(batch.indexId || manifest.indexId, shardRefs, options);
            batchChunks.forEach((chunk) => {
                if (removedRowKeys.has(chunk.rowKey)) return;
                if (activeRowKeys.size > 0 && !activeRowKeys.has(chunk.rowKey)) return;
                if (activeChunkIds.size > 0 && !activeChunkIds.has(chunk.chunkId)) return;
                chunks.push(chunk);
            });
        }
        logDebug_ACU('[交火向量索引] 已按最新快照 manifest 拼接批次向量库。');
        return sortAndDedupeVectorChunks_ACU(chunks);
    }
    if (!manifest.files?.length) return [];
    const shardRefs = manifest.files.filter((file) => file.role === 'base_shard' || file.role === 'delta_shard');
    return sortAndDedupeVectorChunks_ACU(await loadChunksFromShardRefs_ACU(manifest.indexId, shardRefs, options));
}

export async function deleteSummaryVectorIndexExternal_ACU(manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined): Promise<void> {
    if (!manifest) return;
    const retainedPaths = new Set<string>();
    await cleanupManifestFilesExcept_ACU(manifest, retainedPaths);
    if (manifest.indexId) {
        await deleteVectorIndexCacheByIndex_ACU(manifest.indexId);
        await deleteSummaryVectorHotCacheByIndex_ACU(manifest.indexId);
    }
}

function collectManifestRowsForRepair_ACU(manifest: ChatSummaryVectorIndexManifest_ACU): Map<string, string[]> {
    const rowsByChunkKey = new Map<string, string[]>();
    (manifest.contentAddressed?.chunkRefs || []).forEach((ref) => {
        if (!ref.chunkKey || !ref.rowKey) return;
        const rowKeys = rowsByChunkKey.get(ref.chunkKey) || [];
        rowKeys.push(ref.rowKey);
        rowsByChunkKey.set(ref.chunkKey, rowKeys);
    });
    return rowsByChunkKey;
}

export async function inspectSummaryVectorIndexHealth_ACU(): Promise<SummaryVectorIndexHealthReport_ACU> {
    const checkedAt = new Date().toISOString();
    const reachability = await collectSummaryVectorIndexReachability_ACU();
    const registry = await loadVectorIndexRegistry_ACU();
    const flushTasks = await estimateSummaryVectorFlushTasks_ACU();
    const reachablePathSet = new Set(reachability.reachablePaths);
    const issues: SummaryVectorIndexHealthReport_ACU['issues'] = [];
    const repairableRowKeys = new Set<string>();
    const seenLegacyManifestIndexes = new Set<string>();

    for (const file of reachability.reachableFiles) {
        const loaded = await readVectorIndexJsonFile_ACU<any>(file.path);
        if (!loaded.ok || !loaded.data) {
            issues.push({
                severity: 'error',
                code: 'missing_file',
                path: file.path,
                role: file.role,
                messageIndex: file.messageIndex,
                isolationKey: file.isolationKey,
                message: loaded.error || '外置文件不存在或无法读取',
            });
            continue;
        }
        const json = JSON.stringify(loaded.data);
        const checksum = await sha256Text_ACU(json);
        const registryRef = registry.files.find((item) => item.path === file.path);
        if (registryRef?.checksum && registryRef.checksum !== checksum) {
            issues.push({
                severity: 'error',
                code: 'checksum_mismatch',
                path: file.path,
                role: file.role,
                messageIndex: file.messageIndex,
                isolationKey: file.isolationKey,
                expected: registryRef.checksum,
                actual: checksum,
                message: 'registry checksum 与实际文件内容不一致',
            });
        }
        if (file.role === 'vector_pack') {
            const pack = loaded.data as VectorIndexPackBlob_ACU;
            const chunks = Array.isArray(pack.chunks) ? pack.chunks : [];
            const chunksByKey = new Map(chunks.map((chunk) => [String(chunk?.chunkKey || ''), chunk]));
            const vectorPackIdentityMismatch = !pack.packKey
                || String(pack.indexId || '') !== String(file.indexId || '')
                || chunks.length === 0
                || chunks.some((chunk) => !chunk?.chunkKey || !chunk.chunkId || !chunk.rowKey || !Array.isArray(chunk.vector) || chunk.vector.length === 0);
            if (vectorPackIdentityMismatch) {
                issues.push({
                    severity: 'error',
                    code: 'identity_mismatch',
                    path: file.path,
                    role: file.role,
                    messageIndex: file.messageIndex,
                    isolationKey: file.isolationKey,
                    expected: String(file.indexId || ''),
                    actual: `${String(pack.indexId || '')}/${String(pack.packKey || '')}`,
                    message: '内容寻址向量包身份与 manifest 引用不一致，或包内缺少有效向量',
                });
            }
            const chunkRefsForPack = reachability.reachableFiles.filter((item) => item.path === file.path && item.role === 'vector_chunk');
            for (const ref of chunkRefsForPack) {
                const chunk = chunksByKey.get(String(ref.chunkKey || ''));
                if (!chunk) {
                    issues.push({
                        severity: 'error',
                        code: 'pack_chunk_missing',
                        path: file.path,
                        role: 'vector_pack',
                        messageIndex: ref.messageIndex,
                        isolationKey: ref.isolationKey,
                        chunkKey: ref.chunkKey,
                        chunkId: ref.chunkId,
                        rowKey: ref.rowKey,
                        expected: String(ref.chunkKey || ''),
                        actual: 'missing_in_pack',
                        message: 'manifest chunkRef 指向的内容块在 vector_pack 内不存在',
                    });
                    if (ref.rowKey) repairableRowKeys.add(ref.rowKey);
                    continue;
                }
                const chunkIdentityMismatch = String(chunk.chunkId || '') !== String(ref.chunkId || '')
                    || String(chunk.rowKey || '') !== String(ref.rowKey || '')
                    || !Array.isArray(chunk.vector)
                    || chunk.vector.length === 0;
                if (chunkIdentityMismatch) {
                    issues.push({
                        severity: 'error',
                        code: 'identity_mismatch',
                        path: file.path,
                        role: 'vector_pack',
                        messageIndex: ref.messageIndex,
                        isolationKey: ref.isolationKey,
                        chunkKey: ref.chunkKey,
                        chunkId: ref.chunkId,
                        rowKey: ref.rowKey,
                        expected: `${ref.chunkKey || ''}/${ref.chunkId || ''}/${ref.rowKey || ''}`,
                        actual: `${String(chunk.chunkKey || '')}/${String(chunk.chunkId || '')}/${String(chunk.rowKey || '')}`,
                        message: 'vector_pack 内 chunk 身份与 manifest chunkRef 不一致',
                    });
                    if (ref.rowKey) repairableRowKeys.add(ref.rowKey);
                }
                if (ref.checksum) {
                    const chunkChecksum = await sha256Text_ACU(JSON.stringify(chunk));
                    if (chunkChecksum !== ref.checksum) {
                        issues.push({
                            severity: 'error',
                            code: 'checksum_mismatch',
                            path: file.path,
                            role: 'vector_pack',
                            messageIndex: ref.messageIndex,
                            isolationKey: ref.isolationKey,
                            chunkKey: ref.chunkKey,
                            chunkId: ref.chunkId,
                            rowKey: ref.rowKey,
                            expected: ref.checksum,
                            actual: chunkChecksum,
                            message: 'vector_pack 内 chunk checksum 与 manifest chunkRef 不一致',
                        });
                        if (ref.rowKey) repairableRowKeys.add(ref.rowKey);
                    }
                }
            }
            if (file.checksum && checksum !== file.checksum) {
                issues.push({
                    severity: 'error',
                    code: 'checksum_mismatch',
                    path: file.path,
                    role: file.role,
                    messageIndex: file.messageIndex,
                    isolationKey: file.isolationKey,
                    expected: file.checksum,
                    actual: checksum,
                    message: 'manifest packRef checksum 与实际内容不一致',
                });
            }
        } else if (file.role === 'vector_chunk') {
            const blob = loaded.data as VectorIndexChunkBlob_ACU;
            let decodedChunk: ChatSummaryVectorIndexChunk_ACU | null = null;
            try {
                decodedChunk = decodeChunkVectorInPlace_ACU({
                    ...blob,
                    chunkId: String(blob.chunkId || ''),
                    rowKey: String(blob.rowKey || ''),
                    rowOrder: Number(blob.rowOrder || 0),
                    text: String(blob.text || ''),
                    sequence: Number(blob.sequence || 0),
                } as StoredVectorIndexChunk_ACU);
            } catch {
                decodedChunk = null;
            }
            const identityMismatch = !blob.chunkKey
                || !blob.chunkId
                || !blob.rowKey
                || !decodedChunk?.vector?.length
                || String(blob.chunkKey || '') !== String(file.chunkKey || '')
                || String(blob.chunkId || '') !== String(file.chunkId || '')
                || String(blob.rowKey || '') !== String(file.rowKey || '');
            if (identityMismatch) {
                issues.push({
                    severity: 'error',
                    code: 'identity_mismatch',
                    path: file.path,
                    role: file.role,
                    messageIndex: file.messageIndex,
                    isolationKey: file.isolationKey,
                    chunkKey: file.chunkKey || blob.chunkKey,
                    chunkId: file.chunkId || blob.chunkId,
                    rowKey: file.rowKey || blob.rowKey,
                    expected: `${file.chunkKey || ''}/${file.chunkId || ''}/${file.rowKey || ''}`,
                    actual: `${String(blob.chunkKey || '')}/${String(blob.chunkId || '')}/${String(blob.rowKey || '')}`,
                    message: '内容寻址向量块身份与 manifest 引用不一致，或缺少有效向量',
                });
                if (file.rowKey || blob.rowKey) repairableRowKeys.add(String(file.rowKey || blob.rowKey));
            }
            if (file.checksum && checksum !== file.checksum) {
                issues.push({
                    severity: 'error',
                    code: 'checksum_mismatch',
                    path: file.path,
                    role: file.role,
                    messageIndex: file.messageIndex,
                    isolationKey: file.isolationKey,
                    chunkKey: file.chunkKey,
                    chunkId: file.chunkId,
                    rowKey: file.rowKey,
                    expected: file.checksum,
                    actual: checksum,
                    message: 'manifest chunkRef checksum 与实际内容不一致',
                });
                if (file.rowKey) repairableRowKeys.add(file.rowKey);
            }
        } else if ((file.role === 'base_shard' || file.role === 'delta_shard') && !seenLegacyManifestIndexes.has(file.indexId || file.manifestKey)) {
            seenLegacyManifestIndexes.add(file.indexId || file.manifestKey);
            issues.push({
                severity: 'warning',
                code: 'legacy_manifest',
                path: file.path,
                role: file.role,
                messageIndex: file.messageIndex,
                isolationKey: file.isolationKey,
                message: '旧 shard 协议仍可读，但建议迁移到内容寻址 chunk 协议',
            });
        }
    }

    registry.files.forEach((file) => {
        const path = String(file?.path || '').trim();
        if (!path || reachablePathSet.has(path) || path === 'TavernDB_ACU_vector_registry') return;
        issues.push({
            severity: 'warning',
            code: 'unreachable_registered_file',
            path,
            role: file.role,
            message: 'registry 中存在当前聊天快照不可达的外置文件，可由安全 GC 清理',
        });
    });

    const missingFileCount = issues.filter((issue) => issue.code === 'missing_file').length;
    const checksumMismatchCount = issues.filter((issue) => issue.code === 'checksum_mismatch').length;
    const identityMismatchCount = issues.filter((issue) => issue.code === 'identity_mismatch').length;
    const legacyManifestCount = issues.filter((issue) => issue.code === 'legacy_manifest').length;
    const unreachableRegisteredFileCount = issues.filter((issue) => issue.code === 'unreachable_registered_file').length;
    const status: SummaryVectorIndexHealthReport_ACU['status'] = reachability.manifestCount === 0
        ? 'empty'
        : missingFileCount > 0 || checksumMismatchCount > 0 || identityMismatchCount > 0
            ? 'missing'
            : issues.length > 0
                ? 'degraded'
                : 'healthy';

    return {
        status,
        checkedAt,
        manifestCount: reachability.manifestCount,
        reachableFileCount: reachability.reachableFiles.length,
        registeredFileCount: registry.files.length,
        missingFileCount,
        checksumMismatchCount,
        identityMismatchCount,
        legacyManifestCount,
        unreachableRegisteredFileCount,
        flushTaskTotalCount: flushTasks.total,
        flushTaskDirtyCount: flushTasks.dirty,
        flushTaskQueuedCount: flushTasks.queued,
        flushTaskFlushingCount: flushTasks.flushing,
        flushTaskFailedCount: flushTasks.failedRetryable + flushTasks.failedTerminal,
        flushTaskLastError: flushTasks.lastError,
        repairableRowKeys: Array.from(repairableRowKeys),
        issues,
    };
}

export async function getSummaryVectorIndexStats_ACU(manifest: ChatSummaryVectorIndexManifest_ACU | null | undefined): Promise<SummaryVectorIndexStats_ACU> {
    manifest = normalizeSummaryVectorIndexManifestForRead_ACU(manifest);
    const tempCache = await estimateVectorIndexTempCache_ACU(manifest?.indexId);
    const hotCache = await estimateSummaryVectorHotCache_ACU(manifest?.indexId);
    const flushTasks = await estimateSummaryVectorFlushTasks_ACU(manifest ? {
        chatKey: manifest.chatKey,
        isolationKey: manifest.isolationKey,
        sourceTableKey: manifest.sourceTableKey,
    } : undefined);
    const cacheTotalBytes = tempCache.bytes + hotCache.bytes;
    const flushTaskFields = {
        flushTaskTotalCount: flushTasks.total,
        flushTaskDirtyCount: flushTasks.dirty,
        flushTaskQueuedCount: flushTasks.queued,
        flushTaskFlushingCount: flushTasks.flushing,
        flushTaskFailedCount: flushTasks.failedRetryable + flushTasks.failedTerminal,
        flushTaskLastError: flushTasks.lastError,
    };
    if (!manifest) {
        return {
            status: 'none',
            indexId: '',
            backend: 'none',
            rowCount: 0,
            chunkCount: 0,
            baseShardCount: 0,
            deltaShardCount: 0,
            tombstoneRowCount: 0,
            tombstoneChunkCount: 0,
            externalTotalBytes: 0,
            cacheTotalBytes,
            tempCacheBytes: tempCache.bytes,
            tempCacheCount: tempCache.count,
            hotCacheBytes: hotCache.bytes,
            hotCacheCount: hotCache.count,
            ...flushTaskFields,
            updatedAt: '',
        };
    }
    return {
        status: manifest.status,
        indexId: manifest.indexId,
        backend: manifest.backend,
        rowCount: manifest.rowCount,
        chunkCount: manifest.chunkCount,
        baseShardCount: manifest.baseShardCount,
        deltaShardCount: manifest.deltaShardCount,
        tombstoneRowCount: manifest.tombstoneRowCount,
        tombstoneChunkCount: manifest.tombstoneChunkCount,
        externalTotalBytes: manifest.externalTotalBytes,
        cacheTotalBytes,
        tempCacheBytes: tempCache.bytes,
        tempCacheCount: tempCache.count,
        hotCacheBytes: hotCache.bytes,
        hotCacheCount: hotCache.count,
        ...flushTaskFields,
        updatedAt: manifest.updatedAt,
        error: manifest.error,
    };
}
