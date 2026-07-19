/**
 * summary-vector-index-chat-service — 当前聊天交火索引删除
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('deleteCurrentSummaryVectorIndexFromChat_ACU', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('清理当前聊天索引层，并按 scope 清热缓存、flush 队列和可回收外置文件', async () => {
    const manifest = {
      status: 'ready',
      indexId: 'idx-current',
      chatKey: 'chat-data',
      isolationKey: 'alpha',
      sourceTableKey: 'sheet_summary',
    } as any;
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        alpha: {
          summaryVectorIndexManifest: manifest,
          summaryVectorIndexState: {
            manifest,
            rows: [{ rowKey: 'r1', status: 'active' }],
            chunks: [],
          },
        },
        beta: {
          summaryVectorIndexState: { indexId: 'idx-beta', rows: [{ rowKey: 'r2' }] },
        },
      },
    }];
    const saveChat = vi.fn(async () => undefined);
    const deleteHotByScope = vi.fn(async () => undefined);
    const clearFlushByScope = vi.fn(async () => undefined);
    const cleanupUnreachable = vi.fn(async () => ({
      scannedRegisteredFileCount: 1,
      reachableFileCount: 0,
      deletedPaths: ['vector-file.json'],
      retainedPaths: [],
      blockedByReachability: [],
      failedDeletes: [],
    }));

    vi.doMock('../../../src/service/chat/chat-service', () => ({
      getChatArray_ACU: () => chat,
      saveChatToHost_ACU: saveChat,
    }));
    vi.doMock('../../../src/service/runtime/state-manager', () => ({
      currentChatFileIdentifier_ACU: 'chat-data',
      currentJsonTableData_ACU: {
        sheet_summary: { name: '纪要表' },
      },
      getCurrentIsolationKey_ACU: () => 'alpha',
    }));
    vi.doMock('../../../src/service/vector/summary-vector-index-state-service', () => ({
      getAggregatedSummaryVectorIndexSnapshot_ACU: () => ({
        summaryVectorIndexState: {
          manifest,
          rows: [{ rowKey: 'r1', status: 'active' }],
          chunks: [],
        },
        layers: [{
          messageIndex: 0,
          isolationKey: 'alpha',
          summaryVectorIndexState: {
            manifest,
            rows: [{ rowKey: 'r1', status: 'active' }],
            chunks: [],
          },
          tagData: chat[0].TavernDB_ACU_IsolatedData.alpha,
        }],
        rowOwners: new Map(),
      }),
      assignSummaryVectorIndexStateToTagData_ACU: vi.fn((tagData: any, state: any) => {
        if (!state) {
          delete tagData.summaryVectorIndexState;
          delete tagData.summaryVectorIndexManifest;
        }
      }),
    }));
    vi.doMock('../../../src/data/storage/vector-index-hot-cache', () => ({
      deleteSummaryVectorHotCacheByScope_ACU: deleteHotByScope,
      clearSummaryVectorFlushTasksByScope_ACU: clearFlushByScope,
    }));
    vi.doMock('../../../src/service/vector/summary-vector-index-storage-service', () => ({
      cleanupUnreachableSummaryVectorIndexFiles_ACU: cleanupUnreachable,
    }));

    const { deleteCurrentSummaryVectorIndexFromChat_ACU } = await import('../../../src/service/vector/summary-vector-index-chat-service');
    const changed = await deleteCurrentSummaryVectorIndexFromChat_ACU();

    const expectedScope = {
      chatKey: 'chat-data',
      isolationKey: 'alpha',
      sourceTableKey: 'sheet_summary',
    };
    expect(changed).toBe(true);
    expect(saveChat).toHaveBeenCalledTimes(1);
    expect(chat[0].TavernDB_ACU_IsolatedData.alpha.summaryVectorIndexState).toBeUndefined();
    expect(chat[0].TavernDB_ACU_IsolatedData.alpha.summaryVectorIndexManifest).toBeUndefined();
    expect(chat[0].TavernDB_ACU_IsolatedData.beta.summaryVectorIndexState.indexId).toBe('idx-beta');
    expect(deleteHotByScope).toHaveBeenCalledWith(expectedScope);
    expect(clearFlushByScope).toHaveBeenCalledWith(expectedScope);
    expect(cleanupUnreachable).toHaveBeenCalledWith({ scopeHints: [expectedScope] });
  });
});
