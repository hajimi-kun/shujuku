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
  mockSaveChatToHostStrict,
  mockAbortSummaryVectorIndexSnapshotPublication,
  mockFinalizeSummaryVectorIndexSnapshotPublication,
  mockAssertFlushGeneration,
  MockGenerationInvalidatedError,
  mockDeleteSummaryVectorIndexExternal,
  mockIsLegacySummaryVectorIndexManifest,
  mockLogSummaryVectorIndexIdentityEvent,
  mockIsolationKeyRef,
} = vi.hoisted(() => {
  const mockChat = [{ is_user: false, mes: 'AI回复', id: 'msg-1' }] as any[];
  const mockCurrentJsonTableDataRef = { value: {} as any };
  const mockIsolationKeyRef = { value: 'runtime-isolation' };
  return {
    mockChat,
    mockCurrentJsonTableDataRef,
    mockCreateEmbeddings: vi.fn(),
    mockPersistSummaryVectorIndexSnapshot: vi.fn(),
    mockReadIsolatedTagData: vi.fn((message: any, isolationKey: string) => message?.TavernDB_ACU_IsolatedData?.[isolationKey || ''] || null),
    mockWriteIsolatedTagData: vi.fn(),
    mockSaveChatToHost: vi.fn().mockResolvedValue(undefined),
    mockSaveChatToHostStrict: vi.fn().mockResolvedValue(undefined),
    mockAbortSummaryVectorIndexSnapshotPublication: vi.fn(),
    mockFinalizeSummaryVectorIndexSnapshotPublication: vi.fn(),
    mockAssertFlushGeneration: vi.fn(),
    MockGenerationInvalidatedError: class SummaryVectorFlushGenerationInvalidatedError_ACU extends Error {},
    mockDeleteSummaryVectorIndexExternal: vi.fn(),
    mockIsLegacySummaryVectorIndexManifest: vi.fn(() => false),
    mockLogSummaryVectorIndexIdentityEvent: vi.fn(),
    mockIsolationKeyRef,
  };
});

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get currentJsonTableData_ACU() { return mockCurrentJsonTableDataRef.value; },
  currentChatFileIdentifier_ACU: 'test-chat',
  getCurrentIsolationKey_ACU: vi.fn(() => mockIsolationKeyRef.value),
  settings_ACU: { dataIsolationEnabled: false, dataIsolationCode: '' },
}));

vi.mock('../../../src/service/chat/chat-service', () => ({
  getChatArray_ACU: vi.fn(() => mockChat),
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  saveChatToHost_ACU: mockSaveChatToHost,
  saveChatToHostStrict_ACU: mockSaveChatToHostStrict,
}));

vi.mock('../../../src/data/gateways/vector-embedding-gateway', () => ({
  createEmbeddings_ACU: (...args: any[]) => mockCreateEmbeddings(...args),
}));


const persistedChunksByIndexId = new Map<string, any[]>();

vi.mock('../../../src/data/storage/vector-index-hot-cache', () => ({
  assertSummaryVectorFlushGenerationCurrent_ACU: (...args: any[]) => mockAssertFlushGeneration(...args),
  SummaryVectorFlushGenerationInvalidatedError_ACU: MockGenerationInvalidatedError,
}));

vi.mock('../../../src/service/vector/vector-memory-config', () => ({
  getEffectiveSummaryVectorIndexConfig_ACU: vi.fn(() => ({
    embeddingEndpoint: 'https://embedding.test',
    embeddingApiKey: 'test-key',
    embeddingModel: 'test-model',
    summaryIndexChunkSentenceCount: 1,
    summaryIndexArchiveMaxConcurrency: 10,
    summaryIndexV2WriteEnabled: true,
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
  deleteSummaryVectorIndexExternal_ACU: (...args: any[]) => mockDeleteSummaryVectorIndexExternal(...args),
  abortSummaryVectorIndexSnapshotPublication_ACU: (...args: any[]) => mockAbortSummaryVectorIndexSnapshotPublication(...args),
  finalizeSummaryVectorIndexSnapshotPublication_ACU: (...args: any[]) => mockFinalizeSummaryVectorIndexSnapshotPublication(...args),
  isLegacySummaryVectorIndexManifest_ACU: (...args: any[]) => mockIsLegacySummaryVectorIndexManifest(...args),
  logSummaryVectorIndexIdentityEvent_ACU: (...args: any[]) => mockLogSummaryVectorIndexIdentityEvent(...args),
  normalizeSummaryVectorIndexManifestForRead_ACU: vi.fn((manifest: any) => manifest),
}));

vi.mock('../../../src/data/repositories/chat-message-data-repo', () => ({
  cloneIsolatedData_ACU: vi.fn((message: any) => JSON.parse(JSON.stringify(message?.TavernDB_ACU_IsolatedData || {}))),
  readIsolatedTagData_ACU: (...args: any[]) => mockReadIsolatedTagData(...args),
  writeIsolatedTagData_ACU: (...args: any[]) => mockWriteIsolatedTagData(...args),
  writeMessageIdentity_ACU: vi.fn((message: any, isolationConfig: any) => {
    if (!message) return;
    if (isolationConfig?.enabled) message.TavernDB_ACU_Identity = isolationConfig.code;
    else delete message.TavernDB_ACU_Identity;
  }),
  writeLegacyCompatData_ACU: vi.fn((message: any, independentData: any, modifiedKeys: any, updateGroupKeys: any, options: any) => {
    if (!message || options?.legacyConfirmed !== true) return;
    message.TavernDB_ACU_IndependentData = independentData;
    message.TavernDB_ACU_ModifiedKeys = modifiedKeys;
    message.TavernDB_ACU_UpdateGroupKeys = updateGroupKeys;
  }),
}));

import {
  archiveSummaryVectorIndexNow_ACU,
  buildSummaryVectorIndexArchiveScopeKey_ACU,
  flushPendingVectorIndexArchives_ACU,
  migrateLegacySummaryVectorIndexToContentAddressed_ACU,
} from '../../../src/service/vector/summary-vector-index-archive-service';

describe('summary-vector-index-archive-service pending 归档', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistedChunksByIndexId.clear();
    mockChat.length = 0;
    mockChat.push({ is_user: false, mes: 'AI回复', id: 'msg-1' });
    mockIsLegacySummaryVectorIndexManifest.mockReturnValue(false);
    mockIsolationKeyRef.value = 'runtime-isolation';
    mockDeleteSummaryVectorIndexExternal.mockResolvedValue(undefined);
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
        uploadedFiles: [{ role: 'manifest', path: `v2-path-${indexId}`, byteSize: 1, checksum: 'checksum', createdAt: '', updatedAt: '', status: 'ready' }],
      };
    });
    mockAssertFlushGeneration.mockResolvedValue(undefined);
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

  it('清理空纪要表时沿用当前 active isolation，而不是重新推导其他 scope', async () => {
    mockCurrentJsonTableDataRef.value = {
      sheet_summary: {
        name: '纪要表',
        content: [['row_id', '时间跨度', '地点', '概要', '编码索引']],
      },
    };
    mockChat[0].TavernDB_ACU_IsolatedData = {
      'runtime-isolation': { independentData: {}, modifiedKeys: [], updateGroupKeys: [] },
    };

    const result = await archiveSummaryVectorIndexNow_ACU({
      targetMessageIndex: 0,
      isolationKey: 'runtime-isolation',
      sourceTableKey: 'sheet_summary',
    });

    expect(result.reason).toBe('no_effective_rows');
    expect(mockReadIsolatedTagData).toHaveBeenCalledWith(mockChat[0], 'runtime-isolation');
  });

  it('默认 tag 槽为空时，持久化 identity 使用 default 但不迁移聊天容器槽位', async () => {
    mockIsolationKeyRef.value = '';
    mockChat[0].TavernDB_ACU_IsolatedData = {
      '': { independentData: {}, modifiedKeys: [], updateGroupKeys: [] },
    };

    const result = await archiveSummaryVectorIndexNow_ACU({ targetMessageIndex: 0, force: true });

    expect(result.success).toBe(true);
    expect(mockPersistSummaryVectorIndexSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      isolationKey: 'default',
      sourceTableKey: 'sheet_summary',
    }));
    expect(mockReadIsolatedTagData).toHaveBeenCalledWith(mockChat[0], '');
    expect(mockWriteIsolatedTagData).toHaveBeenCalledWith(mockChat[0], '', expect.any(Object));
  });

  it('拒绝未激活 isolation 的归档，不能将当前表数据写入其他 scope', async () => {
    const result = await archiveSummaryVectorIndexNow_ACU({
      targetMessageIndex: 0,
      isolationKey: 'queued-isolation',
      sourceTableKey: 'sheet_summary',
    });
    expect(result).toMatchObject({ success: false, reason: 'archive_scope_not_active' });
    expect(mockPersistSummaryVectorIndexSnapshot).not.toHaveBeenCalled();
  });

  it('scope key 对分隔符输入保持无歧义', () => {
    expect(buildSummaryVectorIndexArchiveScopeKey_ACU({ chatKey: 'a::b', isolationKey: 'c', sourceTableKey: 'd' }))
      .not.toBe(buildSummaryVectorIndexArchiveScopeKey_ACU({ chatKey: 'a', isolationKey: 'b::c', sourceTableKey: 'd' }));
  });

  it('聊天 pointer 成功 durable 保存后才 finalize 新上传快照', async () => {
    const result = await archiveSummaryVectorIndexNow_ACU({ targetMessageIndex: 0, force: true });

    expect(result.success).toBe(true);
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'v2-path-idx-1' }),
    ]);
    expect(mockSaveChatToHostStrict.mock.invocationCallOrder[0])
      .toBeLessThan(mockFinalizeSummaryVectorIndexSnapshotPublication.mock.invocationCallOrder[0]);
  });

  it('flush generation 在 durable publish 前失效时回滚 pending 快照且不保存聊天 pointer', async () => {
    mockAssertFlushGeneration.mockRejectedValueOnce(new MockGenerationInvalidatedError('invalidated'));

    const result = await archiveSummaryVectorIndexNow_ACU({
      targetMessageIndex: 0,
      force: true,
      expectedFlushScopeKey: 'flush-scope',
      expectedFlushGeneration: 7,
    });

    expect(result).toMatchObject({ success: false, skipped: true, reason: 'flush_scope_invalidated', errors: [] });
    expect(mockAssertFlushGeneration).toHaveBeenCalledWith('flush-scope', 7);
    expect(mockSaveChatToHostStrict).not.toHaveBeenCalled();
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockAbortSummaryVectorIndexSnapshotPublication).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'v2-path-idx-1' }),
    ]);
  });

  it('flush generation 在同一 scope publish 临界区内只在 durable save 前校验，避免 save 后伪回滚 durable pointer', async () => {
    const result = await archiveSummaryVectorIndexNow_ACU({
      targetMessageIndex: 0,
      force: true,
      expectedFlushScopeKey: 'flush-scope',
      expectedFlushGeneration: 7,
    });

    expect(result).toMatchObject({ success: true, skipped: false });
    expect(mockAssertFlushGeneration).toHaveBeenCalledTimes(1);
    expect(mockAssertFlushGeneration).toHaveBeenCalledWith('flush-scope', 7);
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'v2-path-idx-1' }),
    ]);
    expect(mockAbortSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
  });

  it('聊天保存失败时不 finalize，保持 pending-publish 保护', async () => {
    const originalState = {
      'runtime-isolation': { independentData: { before: { name: '旧表' } }, modifiedKeys: ['before'], updateGroupKeys: [], summaryVectorIndexManifest: { indexId: 'old-index' } },
    };
    const originalMessageFields = {
      TavernDB_ACU_IsolatedData: structuredClone(originalState),
      TavernDB_ACU_Identity: 'previous-identity',
      TavernDB_ACU_IndependentData: { previous: { name: '旧兼容表' } },
      TavernDB_ACU_ModifiedKeys: ['previous-key'],
      TavernDB_ACU_UpdateGroupKeys: ['previous-group'],
      _acu_remote_memory_snapshot_anchor: { anchor: '', messageIndex: 99, role: 'system', createdAt: '2024-01-01T00:00:00.000Z' },
    };
    Object.assign(mockChat[0], structuredClone(originalMessageFields));
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('host save failed'));

    const result = await archiveSummaryVectorIndexNow_ACU({ targetMessageIndex: 0, force: true });

    expect(result).toMatchObject({ success: false, reason: 'summary_vector_index_archive_failed' });
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockAbortSummaryVectorIndexSnapshotPublication).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'v2-path-idx-1' }),
    ]);
    expect(mockChat[0].TavernDB_ACU_IsolatedData).toEqual(originalState);
    expect(mockChat[0].TavernDB_ACU_Identity).toBe(originalMessageFields.TavernDB_ACU_Identity);
    expect(mockChat[0].TavernDB_ACU_IndependentData).toEqual(originalMessageFields.TavernDB_ACU_IndependentData);
    expect(mockChat[0].TavernDB_ACU_ModifiedKeys).toEqual(originalMessageFields.TavernDB_ACU_ModifiedKeys);
    expect(mockChat[0].TavernDB_ACU_UpdateGroupKeys).toEqual(originalMessageFields.TavernDB_ACU_UpdateGroupKeys);
    expect(mockChat[0]._acu_remote_memory_snapshot_anchor).toEqual(originalMessageFields._acu_remote_memory_snapshot_anchor);
  });

  it('legacy single-file manifest 迁移成功后仅在 durable 保存后 finalize 新快照，旧对象不参与删除', async () => {
    const legacyManifest = {
      indexId: 'legacy-index', chatKey: 'test-chat', isolationKey: 'runtime-isolation',
      sourceTableKey: 'sheet_summary', sourceTableName: '纪要表', snapshotMessageId: 'legacy-message',
      embeddingModel: 'test-model', dimension: 2, rowCount: 1, chunkCount: 1, skippedRowCount: 0,
      snapshot: { revision: 1, activeRowKeys: ['legacy-row'], activeChunkIds: ['legacy-chunk'] },
    };
    mockChat[0].TavernDB_ACU_IsolatedData = {
      'runtime-isolation': {
        independentData: { sheet_legacy: { name: '旧表', content: [] } },
        modifiedKeys: ['legacy-key'],
        updateGroupKeys: ['legacy-group'],
        summaryVectorIndexManifest: legacyManifest,
        summaryVectorIndexState: {
          version: 1, backend: 'st-files', status: 'ready', indexId: legacyManifest.indexId,
          snapshotMessageId: legacyManifest.snapshotMessageId, sourceTableKey: legacyManifest.sourceTableKey,
          sourceTableName: legacyManifest.sourceTableName, indexedAt: '2020-01-01T00:00:00.000Z',
          rowCount: 1, chunkCount: 1, skippedRowCount: 0,
          rows: [{ rowKey: 'legacy-row', rowId: '1', rowOrder: 0, summary: '旧纪要', indexCode: 'L-1', vectorSourceText: '旧纪要', chunkIds: ['legacy-chunk'] }],
          chunks: [{ chunkId: 'legacy-chunk', rowKey: 'legacy-row', rowOrder: 0, sequence: 0, text: '旧纪要', vector: [1, 2] }],
          manifest: legacyManifest,
        },
      },
    };
    persistedChunksByIndexId.set(legacyManifest.indexId, [
      { chunkId: 'legacy-chunk', rowKey: 'legacy-row', rowOrder: 0, sequence: 0, text: '旧纪要', vector: [1, 2] },
    ]);
    mockIsLegacySummaryVectorIndexManifest.mockReturnValue(true);

    const result = await migrateLegacySummaryVectorIndexToContentAddressed_ACU();

    expect(result).toMatchObject({ success: true, skipped: false, reason: 'legacy_manifest_migrated_non_destructive' });
    expect(mockPersistSummaryVectorIndexSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      chatKey: 'test-chat',
      isolationKey: 'runtime-isolation',
      sourceTableKey: 'sheet_summary',
      previousManifest: legacyManifest,
      parentIndexIds: ['legacy-index'],
      snapshotRevision: 1,
      activeRowKeys: ['legacy-row'],
      activeChunkIds: ['legacy-chunk'],
    }));
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'v2-path-idx-1' }),
    ]);
    expect(mockSaveChatToHostStrict.mock.invocationCallOrder[0])
      .toBeLessThan(mockFinalizeSummaryVectorIndexSnapshotPublication.mock.invocationCallOrder[0]);
    expect(mockAbortSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
    expect(mockChat[0].TavernDB_ACU_IsolatedData['runtime-isolation'].summaryVectorIndexManifest.indexId).toBe('idx-1');
  });

  it('legacy migration 保留默认空 tag 槽，同时将 V2 持久化 identity 写为 canonical default', async () => {
    mockIsolationKeyRef.value = '';
    const legacyManifest = {
      indexId: 'legacy-index', chatKey: 'test-chat', isolationKey: '',
      sourceTableKey: 'sheet_summary', sourceTableName: '纪要表', snapshotMessageId: 'legacy-message',
      embeddingModel: 'test-model', dimension: 2, rowCount: 1, chunkCount: 1, skippedRowCount: 0,
      snapshot: { revision: 1, activeRowKeys: ['legacy-row'], activeChunkIds: ['legacy-chunk'] },
    };
    mockChat[0].TavernDB_ACU_IsolatedData = {
      '': {
        independentData: {}, modifiedKeys: [], updateGroupKeys: [], summaryVectorIndexManifest: legacyManifest,
        summaryVectorIndexState: {
          version: 1, backend: 'st-files', status: 'ready', indexId: legacyManifest.indexId,
          snapshotMessageId: legacyManifest.snapshotMessageId, sourceTableKey: legacyManifest.sourceTableKey,
          sourceTableName: legacyManifest.sourceTableName, indexedAt: '2020-01-01T00:00:00.000Z',
          rowCount: 1, chunkCount: 1, skippedRowCount: 0,
          rows: [{ rowKey: 'legacy-row', rowId: '1', rowOrder: 0, summary: '旧纪要', indexCode: 'L-1', vectorSourceText: '旧纪要', chunkIds: ['legacy-chunk'] }],
          chunks: [{ chunkId: 'legacy-chunk', rowKey: 'legacy-row', rowOrder: 0, sequence: 0, text: '旧纪要', vector: [1, 2] }],
          manifest: legacyManifest,
        },
      },
    };
    persistedChunksByIndexId.set(legacyManifest.indexId, [{ chunkId: 'legacy-chunk', rowKey: 'legacy-row', rowOrder: 0, sequence: 0, text: '旧纪要', vector: [1, 2] }]);
    mockIsLegacySummaryVectorIndexManifest.mockReturnValue(true);

    await expect(migrateLegacySummaryVectorIndexToContentAddressed_ACU()).resolves.toMatchObject({ success: true });

    expect(mockPersistSummaryVectorIndexSnapshot).toHaveBeenCalledWith(expect.objectContaining({ isolationKey: 'default' }));
    expect(mockReadIsolatedTagData).toHaveBeenCalledWith(mockChat[0], '');
    expect(mockWriteIsolatedTagData).toHaveBeenCalledWith(mockChat[0], '', expect.any(Object));
    expect(mockChat[0].TavernDB_ACU_IsolatedData[''].summaryVectorIndexManifest.indexId).toBe('idx-1');
    expect(mockChat[0].TavernDB_ACU_IsolatedData.default).toBeUndefined();
  });

  it('legacy migration 在没有可迁移 rows 或 chunks 时拒绝，且不改 pointer 或删除旧对象', async () => {
    const legacyManifest = {
      indexId: 'legacy-index', chatKey: 'test-chat', isolationKey: 'runtime-isolation',
      sourceTableKey: 'sheet_summary', sourceTableName: '纪要表', snapshotMessageId: 'legacy-message',
      embeddingModel: 'test-model', dimension: 2, rowCount: 1, chunkCount: 1, skippedRowCount: 0,
      snapshot: { revision: 1, activeRowKeys: ['legacy-row'], activeChunkIds: ['legacy-chunk'] },
    };
    const originalIsolatedData = {
      'runtime-isolation': {
        independentData: {}, modifiedKeys: [], updateGroupKeys: [], summaryVectorIndexManifest: legacyManifest,
        summaryVectorIndexState: {
          version: 1, backend: 'st-files', status: 'ready', indexId: legacyManifest.indexId,
          snapshotMessageId: legacyManifest.snapshotMessageId, sourceTableKey: legacyManifest.sourceTableKey,
          sourceTableName: legacyManifest.sourceTableName, indexedAt: '2020-01-01T00:00:00.000Z',
          rowCount: 1, chunkCount: 1, skippedRowCount: 0,
          rows: [{ rowKey: 'legacy-row', rowId: '1', rowOrder: 0, summary: '旧纪要', indexCode: 'L-1', vectorSourceText: '旧纪要', chunkIds: ['legacy-chunk'] }],
          manifest: legacyManifest,
        },
      },
    };
    mockChat[0].TavernDB_ACU_IsolatedData = structuredClone(originalIsolatedData);
    mockIsLegacySummaryVectorIndexManifest.mockReturnValue(true);

    const result = await migrateLegacySummaryVectorIndexToContentAddressed_ACU();

    expect(result).toMatchObject({ success: false, reason: 'legacy_manifest_missing_rows_or_chunks' });
    expect(mockPersistSummaryVectorIndexSnapshot).not.toHaveBeenCalled();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockAbortSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
    expect(mockChat[0].TavernDB_ACU_IsolatedData).toEqual(originalIsolatedData);
  });

  it('legacy migration 的持久化拒绝不会改写旧 pointer 或删除旧对象', async () => {
    const legacyManifest = {
      indexId: 'legacy-index', chatKey: 'test-chat', isolationKey: 'runtime-isolation',
      sourceTableKey: 'sheet_summary', sourceTableName: '纪要表', snapshotMessageId: 'legacy-message',
      embeddingModel: 'test-model', dimension: 2, rowCount: 1, chunkCount: 1, skippedRowCount: 0,
      snapshot: { revision: 1, activeRowKeys: ['legacy-row'], activeChunkIds: ['legacy-chunk'] },
    };
    const originalIsolatedData = {
      'runtime-isolation': {
        independentData: {}, modifiedKeys: [], updateGroupKeys: [], summaryVectorIndexManifest: legacyManifest,
        summaryVectorIndexState: {
          version: 1, backend: 'st-files', status: 'ready', indexId: legacyManifest.indexId,
          snapshotMessageId: legacyManifest.snapshotMessageId, sourceTableKey: legacyManifest.sourceTableKey,
          sourceTableName: legacyManifest.sourceTableName, indexedAt: '2020-01-01T00:00:00.000Z',
          rowCount: 1, chunkCount: 1, skippedRowCount: 0,
          rows: [{ rowKey: 'legacy-row', rowId: '1', rowOrder: 0, summary: '旧纪要', indexCode: 'L-1', vectorSourceText: '旧纪要', chunkIds: ['legacy-chunk'] }],
          manifest: legacyManifest,
        },
      },
    };
    mockChat[0].TavernDB_ACU_IsolatedData = structuredClone(originalIsolatedData);
    persistedChunksByIndexId.set(legacyManifest.indexId, [
      { chunkId: 'legacy-chunk', rowKey: 'legacy-row', rowOrder: 0, sequence: 0, text: '旧纪要', vector: [1, 2] },
    ]);
    mockIsLegacySummaryVectorIndexManifest.mockReturnValue(true);
    mockPersistSummaryVectorIndexSnapshot.mockRejectedValueOnce(new Error('snapshot identity rejected'));

    await expect(migrateLegacySummaryVectorIndexToContentAddressed_ACU()).rejects.toThrow('snapshot identity rejected');

    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockAbortSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
    expect(mockChat[0].TavernDB_ACU_IsolatedData).toEqual(originalIsolatedData);
  });

  it('legacy migration 聊天保存失败时恢复旧 pointer 与全部 message 字段，并 abort prepared 快照', async () => {
    const legacyManifest = {
      indexId: 'legacy-index', chatKey: 'test-chat', isolationKey: 'runtime-isolation',
      sourceTableKey: 'sheet_summary', sourceTableName: '纪要表', snapshotMessageId: 'legacy-message',
      embeddingModel: 'test-model', dimension: 2, rowCount: 1, chunkCount: 1, skippedRowCount: 0,
      snapshot: { revision: 1, activeRowKeys: ['legacy-row'], activeChunkIds: ['legacy-chunk'] },
    };
    const originalMessageFields = {
      TavernDB_ACU_IsolatedData: {
        'runtime-isolation': {
          independentData: { sheet_legacy: { name: '旧表', content: [] } },
          modifiedKeys: ['legacy-key'], updateGroupKeys: ['legacy-group'],
          summaryVectorIndexManifest: legacyManifest,
          summaryVectorIndexState: {
            version: 1, backend: 'st-files', status: 'ready', indexId: legacyManifest.indexId,
            snapshotMessageId: legacyManifest.snapshotMessageId, sourceTableKey: legacyManifest.sourceTableKey,
            sourceTableName: legacyManifest.sourceTableName, indexedAt: '2020-01-01T00:00:00.000Z',
            rowCount: 1, chunkCount: 1, skippedRowCount: 0,
            rows: [{ rowKey: 'legacy-row', rowId: '1', rowOrder: 0, summary: '旧纪要', indexCode: 'L-1', vectorSourceText: '旧纪要', chunkIds: ['legacy-chunk'] }],
            chunks: [{ chunkId: 'legacy-chunk', rowKey: 'legacy-row', rowOrder: 0, sequence: 0, text: '旧纪要', vector: [1, 2] }],
            manifest: legacyManifest,
          },
        },
      },
      TavernDB_ACU_Identity: 'previous-identity',
      TavernDB_ACU_IndependentData: { previous: { name: '旧兼容表' } },
      TavernDB_ACU_ModifiedKeys: ['previous-key'],
      TavernDB_ACU_UpdateGroupKeys: ['previous-group'],
      _acu_remote_memory_snapshot_anchor: { anchor: 'old-anchor', messageIndex: 0, role: 'assistant', createdAt: '2024-01-01T00:00:00.000Z' },
    };
    Object.assign(mockChat[0], structuredClone(originalMessageFields));
    persistedChunksByIndexId.set(legacyManifest.indexId, structuredClone(originalMessageFields.TavernDB_ACU_IsolatedData['runtime-isolation'].summaryVectorIndexState.chunks));
    mockIsLegacySummaryVectorIndexManifest.mockReturnValue(true);
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('host save failed'));

    await expect(migrateLegacySummaryVectorIndexToContentAddressed_ACU()).rejects.toThrow('host save failed');

    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockAbortSummaryVectorIndexSnapshotPublication).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'v2-path-idx-1' }),
    ]);
    expect(mockLogSummaryVectorIndexIdentityEvent).toHaveBeenCalledWith(
      'warn',
      'publish',
      'orphan_retained',
      expect.objectContaining({ manifest: expect.objectContaining({ indexId: 'idx-1' }) }),
    );
    expect(mockChat[0].TavernDB_ACU_IsolatedData).toEqual(originalMessageFields.TavernDB_ACU_IsolatedData);
    expect(mockChat[0].TavernDB_ACU_Identity).toBe(originalMessageFields.TavernDB_ACU_Identity);
    expect(mockChat[0].TavernDB_ACU_IndependentData).toEqual(originalMessageFields.TavernDB_ACU_IndependentData);
    expect(mockChat[0].TavernDB_ACU_ModifiedKeys).toEqual(originalMessageFields.TavernDB_ACU_ModifiedKeys);
    expect(mockChat[0].TavernDB_ACU_UpdateGroupKeys).toEqual(originalMessageFields.TavernDB_ACU_UpdateGroupKeys);
    expect(mockChat[0]._acu_remote_memory_snapshot_anchor).toEqual(originalMessageFields._acu_remote_memory_snapshot_anchor);
  });

  it('拒绝无 publication handle 的延迟保存请求，避免遗留 pending 快照', async () => {
    const result = await archiveSummaryVectorIndexNow_ACU({
      targetMessageIndex: 0,
      force: true,
      saveChatAfterWrite: false,
    });

    expect(result).toMatchObject({
      success: false,
      reason: 'summary_vector_index_delayed_publish_unsupported',
    });
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockFinalizeSummaryVectorIndexSnapshotPublication).not.toHaveBeenCalled();
    expect(mockPersistSummaryVectorIndexSnapshot).not.toHaveBeenCalled();
  });

  it('空纪要表保存失败时不删除仍被已持久化 pointer 引用的外置文件', async () => {
    mockCurrentJsonTableDataRef.value.sheet_summary.content = [['row_id', '时间跨度', '地点', '概要', '编码索引']];
    const manifest = { indexId: 'old-index', files: [{ path: 'old-path' }] };
    mockChat[0].TavernDB_ACU_IsolatedData = {
      'runtime-isolation': { independentData: {}, modifiedKeys: [], updateGroupKeys: [], summaryVectorIndexManifest: manifest },
    };
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('host save failed'));

    await expect(archiveSummaryVectorIndexNow_ACU({ targetMessageIndex: 0 })).resolves.toMatchObject({
      success: false,
      reason: 'summary_vector_index_clear_failed',
    });
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
  });

  it('空纪要表清理同样受 flush generation fence 保护，不允许旧 runner 删除新 pointer', async () => {
    mockCurrentJsonTableDataRef.value.sheet_summary.content = [['row_id', '时间跨度', '地点', '概要', '编码索引']];
    const manifest = { indexId: 'old-index', files: [{ path: 'old-path' }] };
    mockChat[0].TavernDB_ACU_IsolatedData = {
      'runtime-isolation': { independentData: {}, modifiedKeys: [], updateGroupKeys: [], summaryVectorIndexManifest: manifest },
    };
    mockAssertFlushGeneration.mockRejectedValueOnce(new MockGenerationInvalidatedError('generation superseded'));

    await expect(archiveSummaryVectorIndexNow_ACU({
      targetMessageIndex: 0,
      mode: 'sync',
      expectedFlushScopeKey: 'flush-scope',
      expectedFlushGeneration: 7,
    })).resolves.toMatchObject({ success: false, reason: 'summary_vector_index_clear_failed' });

    expect(mockAssertFlushGeneration).toHaveBeenCalledWith('flush-scope', 7);
    expect(mockSaveChatToHostStrict).not.toHaveBeenCalled();
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
  });

  it('空纪要表严格保存能力不可用时回滚 pointer，且不删除旧外置文件', async () => {
    mockCurrentJsonTableDataRef.value.sheet_summary.content = [['row_id', '时间跨度', '地点', '概要', '编码索引']];
    const manifest = { indexId: 'old-index', files: [{ path: 'old-path' }] };
    const before = {
      'runtime-isolation': { independentData: {}, modifiedKeys: [], updateGroupKeys: [], summaryVectorIndexManifest: manifest },
    };
    mockChat[0].TavernDB_ACU_IsolatedData = structuredClone(before);
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('宿主 saveChat 不可用，无法提交破坏性聊天数据变更。'));

    await expect(archiveSummaryVectorIndexNow_ACU({ targetMessageIndex: 0 })).resolves.toMatchObject({
      success: false,
      reason: 'summary_vector_index_clear_failed',
    });

    expect(mockChat[0].TavernDB_ACU_IsolatedData).toEqual(before);
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
  });
});
