/**
 * tests/service/vector/summary-vector-index-archive-service.test.ts
 * 纪要向量索引归档 service 单元测试
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockChat,
  mockCurrentJsonTableDataRef,
  mockCreateEmbeddings,
  mockPersistSummaryVectorIndexSnapshot,
  mockReadIsolatedTagData,
  mockWriteIsolatedTagData,
  mockSaveChatToHost,
} = vi.hoisted(() => {
  const mockChat = [{ is_user: false, mes: 'AI回复', id: 'msg-1' }] as any[];
  const mockCurrentJsonTableDataRef = { value: {} as any };
  return {
    mockChat,
    mockCurrentJsonTableDataRef,
    mockCreateEmbeddings: vi.fn(),
    mockPersistSummaryVectorIndexSnapshot: vi.fn(),
    mockReadIsolatedTagData: vi.fn((message: any, isolationKey: string) => message?.TavernDB_ACU_IsolatedData?.[isolationKey || ''] || null),
    mockWriteIsolatedTagData: vi.fn(),
    mockSaveChatToHost: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get currentJsonTableData_ACU() { return mockCurrentJsonTableDataRef.value; },
  currentChatFileIdentifier_ACU: 'test-chat',
  getCurrentIsolationKey_ACU: vi.fn(() => ''),
  settings_ACU: { dataIsolationEnabled: false, dataIsolationCode: '' },
}));

vi.mock('../../../src/service/chat/chat-service', () => ({
  getChatArray_ACU: vi.fn(() => mockChat),
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  saveChatToHost_ACU: mockSaveChatToHost,
}));

vi.mock('../../../src/data/gateways/vector-embedding-gateway', () => ({
  createEmbeddings_ACU: (...args: any[]) => mockCreateEmbeddings(...args),
}));


const persistedChunksByIndexId = new Map<string, any[]>();

vi.mock('../../../src/service/vector/vector-memory-config', () => ({
  getEffectiveSummaryVectorIndexConfig_ACU: vi.fn(() => ({
    embeddingEndpoint: 'https://embedding.test',
    embeddingApiKey: 'test-key',
    embeddingModel: 'test-model',
    summaryIndexChunkSentenceCount: 1,
    summaryIndexArchiveMaxConcurrency: 10,
    threshold: 1,
    archiveTriggerCount: 1,
    archiveBatchSize: 1,
    archiveMaxConcurrency: 1,
    topK: 1,
    minScore: 0,
    recallCandidateLimit: 1,
    summaryPromptGroupId: 'summary',
    entryComment: 'entry',
    entryKey: 'key',
  })),
  validateSummaryVectorIndexConfig_ACU: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('../../../src/service/vector/summary-vector-index-storage-service', () => ({
  loadSummaryVectorIndexChunksFromManifest_ACU: vi.fn(async (manifest: any) => persistedChunksByIndexId.get(manifest.indexId) || []),
  persistSummaryVectorIndexSnapshot_ACU: (...args: any[]) => mockPersistSummaryVectorIndexSnapshot(...args),
  deleteSummaryVectorIndexExternal_ACU: vi.fn(),
  isLegacySummaryVectorIndexManifest_ACU: vi.fn(() => false),
  normalizeSummaryVectorIndexManifestForRead_ACU: vi.fn((manifest: any) => manifest),
}));

vi.mock('../../../src/data/repositories/chat-message-data-repo', () => ({
  cloneIsolatedData_ACU: vi.fn((message: any) => JSON.parse(JSON.stringify(message?.TavernDB_ACU_IsolatedData || {}))),
  readIsolatedTagData_ACU: (...args: any[]) => mockReadIsolatedTagData(...args),
  writeIsolatedTagData_ACU: (...args: any[]) => mockWriteIsolatedTagData(...args),
  writeMessageIdentity_ACU: vi.fn(),
  writeLegacyCompatData_ACU: vi.fn(),
}));

import {
  archiveSummaryVectorIndexNow_ACU,
  flushPendingVectorIndexArchives_ACU,
} from '../../../src/service/vector/summary-vector-index-archive-service';

describe('summary-vector-index-archive-service pending 归档', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistedChunksByIndexId.clear();
    mockChat.length = 0;
    mockChat.push({ is_user: false, mes: 'AI回复', id: 'msg-1' });
    mockCurrentJsonTableDataRef.value = {
      sheet_summary: {
        name: '纪要表',
        content: [
          ['row_id', '时间跨度', '地点', '概要', '编码索引'],
          ['1', '上午', '甲地', '第一次事件。', 'AM-0001'],
        ],
      },
    };
    mockCreateEmbeddings.mockImplementation(async (request: any) => request.input.map((_: string, index: number) => ({ index, embedding: [index + 1, index + 2] })));
    mockPersistSummaryVectorIndexSnapshot.mockImplementation(async (options: any) => {
      const indexId = `idx-${mockPersistSummaryVectorIndexSnapshot.mock.calls.length}`;
      const manifest = {
        indexId,
        status: 'ready',
        snapshotMessageId: options.snapshotMessageId,
        sourceTableKey: options.sourceTableKey,
        sourceTableName: options.sourceTableName,
        rowCount: options.rows.length,
        chunkCount: options.chunks.length,
        skippedRowCount: options.skippedRowCount,
        snapshot: { activeRowKeys: options.activeRowKeys || options.rows.map((row: any) => row.rowKey), revision: options.snapshotRevision + 1 },
      };
      persistedChunksByIndexId.set(indexId, options.chunks.map((chunk: any) => ({ ...chunk })));
      return {
        state: {
          version: 1,
          backend: 'st-files',
          status: 'ready',
          indexId,
          snapshotMessageId: options.snapshotMessageId,
          sourceTableKey: options.sourceTableKey,
          sourceTableName: options.sourceTableName,
          indexedAt: options.indexedAt,
          rowCount: options.rows.length,
          chunkCount: options.chunks.length,
          skippedRowCount: options.skippedRowCount,
          rows: options.rows,
          manifest,
        },
        manifest,
        uploadedFiles: [],
      };
    });
  });


  async function flushPendingAndMicrotasks() {
    flushPendingVectorIndexArchives_ACU();
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  }

  it('两次 pending 归档顺序 flush 时，第二次基于第一次已写入的聚合快照叠加', async () => {
    const firstVectorize = await archiveSummaryVectorIndexNow_ACU({ targetMessageIndex: 0, vectorizeOnly: true, force: true });
    expect(firstVectorize.success).toBe(true);

    await flushPendingAndMicrotasks();
    expect(mockPersistSummaryVectorIndexSnapshot).toHaveBeenCalledTimes(1);
    const firstPersistOptions = mockPersistSummaryVectorIndexSnapshot.mock.calls[0][0];
    expect(firstPersistOptions.rows).toHaveLength(1);
    expect(firstPersistOptions.previousManifest).toBeNull();

    mockCurrentJsonTableDataRef.value = {
      sheet_summary: {
        name: '纪要表',
        content: [
          ['row_id', '时间跨度', '地点', '概要', '编码索引'],
          ['1', '上午', '甲地', '第一次事件。', 'AM-0001'],
          ['2', '下午', '乙地', '第二次事件。', 'PM-0002'],
        ],
      },
    };

    const secondVectorize = await archiveSummaryVectorIndexNow_ACU({ targetMessageIndex: 0, vectorizeOnly: true, force: true });
    expect(secondVectorize.success).toBe(true);

    await flushPendingAndMicrotasks();
    expect(mockPersistSummaryVectorIndexSnapshot).toHaveBeenCalledTimes(2);
    const secondPersistOptions = mockPersistSummaryVectorIndexSnapshot.mock.calls[1][0];
    expect(secondPersistOptions.rows).toHaveLength(2);
    expect(secondPersistOptions.previousManifest?.indexId).toBe('idx-1');
    expect(secondPersistOptions.parentIndexIds).toEqual(['idx-1']);
    expect(secondPersistOptions.snapshotRevision).toBe(1);
  });
});
