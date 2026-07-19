/**
 * tests/service/chat/chat-service.test.ts
 * 聊天数据服务 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, mockCurrentJsonTableData, mockGetChatArray, mockSaveChatToHost, mockSaveChatToHostStrict, mockSetChatMessages, mockEmitMessageUpdated, mockLogDebug, mockGetCurrentIsolationKey, mockGetLastOptimizationBase, mockSetLastOptimizationBase, mockSanitizeSheet, mockPersistTablesToChatMessage, mockRunTableUpdateCommit, mockRunTableWriteTransaction, mockLoadTableStateFromFramesV2, mockCollectScheduleSummaryFromFramesV2, mockDeleteSummaryVectorIndexExternal } = vi.hoisted(() => ({
  mockSettings: {
    retainRecentLayers: 3,
    dataIsolationEnabled: false,
    dataIsolationCode: '',
  } as any,
  mockCurrentJsonTableData: {
    sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] },
    sheet_1: { name: '纪要表', content: [['row_id', '事件'], ['1', '开始']] },
  } as any,
  mockGetChatArray: vi.fn(),
  mockSaveChatToHost: vi.fn(),
  mockSaveChatToHostStrict: vi.fn(),
  mockSetChatMessages: vi.fn(),
  mockEmitMessageUpdated: vi.fn(),
  mockLogDebug: vi.fn(),
  mockGetCurrentIsolationKey: vi.fn(() => ''),
  mockGetLastOptimizationBase: vi.fn(() => null),
  mockSetLastOptimizationBase: vi.fn(),
  mockSanitizeSheet: vi.fn((sheet: any) => sheet),
  mockPersistTablesToChatMessage: vi.fn(),
  mockRunTableUpdateCommit: vi.fn(),
  mockRunTableWriteTransaction: vi.fn(),
  mockLoadTableStateFromFramesV2: vi.fn(),
  mockCollectScheduleSummaryFromFramesV2: vi.fn(() => null),
  mockDeleteSummaryVectorIndexExternal: vi.fn(),
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: mockGetChatArray,
  getChatLength_ACU: vi.fn(() => 0),
  getLastMessageIndex_ACU: vi.fn(() => -1),
  saveChatToHost_ACU: mockSaveChatToHost,
  saveChatToHostStrict_ACU: mockSaveChatToHostStrict,
  stopGeneration_ACU: vi.fn(),
  deleteLastMessage_ACU: vi.fn(),
  setChatMessages_ACU: mockSetChatMessages,
  emitMessageUpdated_ACU: mockEmitMessageUpdated,
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: mockLogDebug,
  logError_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn((name: string) => name.includes('纪要') || name.includes('总结')),
}));

vi.mock('../../../src/service/optimization/content-optimization', () => ({
  getLastOptimizationBase_ACU: mockGetLastOptimizationBase,
  setLastOptimizationBase_ACU: mockSetLastOptimizationBase,
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  settings_ACU: mockSettings,
  currentJsonTableData_ACU: mockCurrentJsonTableData,
  currentChatFileIdentifier_ACU: 'chat-test',
  getCurrentIsolationKey_ACU: mockGetCurrentIsolationKey,
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  sanitizeSheetForStorage_ACU: mockSanitizeSheet,
}));

vi.mock('../../../src/service/table/table-service', () => ({
  persistTablesToChatMessage_ACU: mockPersistTablesToChatMessage,
}));

vi.mock('../../../src/service/table/table-update-commit', () => ({
  runTableUpdateCommit_ACU: mockRunTableUpdateCommit,
}));

vi.mock('../../../src/service/table/table-write-transaction', () => ({
  runTableWriteTransaction_ACU: mockRunTableWriteTransaction,
}));

vi.mock('../../../src/service/table/storage-frame-v2-replay', () => ({
  loadTableStateFromFramesV2_ACU: mockLoadTableStateFromFramesV2,
  collectScheduleSummaryFromFramesV2_ACU: mockCollectScheduleSummaryFromFramesV2,
}));

vi.mock('../../../src/service/vector/summary-vector-index-storage-service', () => ({
  deleteSummaryVectorIndexExternal_ACU: mockDeleteSummaryVectorIndexExternal,
}));

import {
  replaceChatMessage_ACU,
  getOriginalContent_ACU,
  purgeOldLayerData_ACU,
  ensureV2BoundaryCheckpointForRetainedBuffer_ACU,
  shouldRotateV2BoundaryCheckpointForRetainedBuffer_ACU,
  ensureManualRefillInitialBaseline_ACU,
  replaceManualRefillSheetBaselineInRangeAtomic_ACU,
  captureManualRefillSessionSnapshot_ACU,
  commitManualRefillSheetSnapshotInRangeAtomic_ACU,
  restoreManualRefillSessionSnapshotAtomic_ACU,
  clearManualRefillIncrementalDataInRange_ACU,
  clearTableDataAtFloors_ACU,
  deleteLocalDataInChatCore_ACU,
  overrideLatestLayerWithTemplateCore_ACU,
  saveCurrentDataForTable_ACU,
} from '../../../src/service/chat/chat-service';
import { resolveTableHistoryStateFromChat_ACU } from '../../../src/service/table/table-history';

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.retainRecentLayers = 3;
  mockSettings.dataIsolationEnabled = false;
  mockSettings.dataIsolationCode = '';
  mockGetCurrentIsolationKey.mockReturnValue('');
  mockSaveChatToHost.mockResolvedValue(undefined);
  mockSaveChatToHostStrict.mockResolvedValue(undefined);
  mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 0 });
  mockRunTableUpdateCommit.mockImplementation(async (options: any, apply: any) => {
    mockPersistTablesToChatMessage(options);
    const applied = await apply();
    return {
      success: applied?.success !== false,
      value: applied?.value,
      tableData: applied?.tableData,
      saved: true,
    };
  });
  mockRunTableWriteTransaction.mockImplementation(async (_options: any, task: any) => task());
  mockLoadTableStateFromFramesV2.mockResolvedValue({
    sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] },
  });
  mockCollectScheduleSummaryFromFramesV2.mockReturnValue(null);
  mockDeleteSummaryVectorIndexExternal.mockResolvedValue(undefined);
});

// ═══ replaceChatMessage_ACU ═══
describe('replaceChatMessage_ACU', () => {
  it('成功替换消息内容', async () => {
    const chat = [
      { is_user: true, mes: '你好' },
      { is_user: false, mes: '原始内容', message_id: 'msg1', extra: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockSetChatMessages.mockResolvedValue(true);
    const result = await replaceChatMessage_ACU(1, '新内容');
    expect(result).toBe(true);
    expect(mockSetChatMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ message_id: 'msg1', mes: '新内容' })],
      { refresh: 'affected' },
    );
  });

  it('消息不存在返回 false', async () => {
    mockGetChatArray.mockReturnValue([]);
    const result = await replaceChatMessage_ACU(5, '新内容');
    expect(result).toBe(false);
  });

  it('setChatMessages 不可用时使用降级方案', async () => {
    const chat = [
      { is_user: false, mes: '原始内容', message_id: 'msg1', extra: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockSetChatMessages.mockResolvedValue(false);
    const result = await replaceChatMessage_ACU(0, '新内容');
    expect(result).toBe(true);
    expect(chat[0].mes).toBe('新内容');
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('保存原始内容到 extra._acu_original_content', async () => {
    const chat = [
      { is_user: false, mes: '原始内容', message_id: 'msg1', extra: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockSetChatMessages.mockResolvedValue(true);
    await replaceChatMessage_ACU(0, '新内容');
    expect(mockSetChatMessages).toHaveBeenCalledWith(
      [expect.objectContaining({
        extra: expect.objectContaining({ _acu_original_content: '原始内容' }),
      })],
      expect.anything(),
    );
  });
});

// ═══ getOriginalContent_ACU ═══
describe('getOriginalContent_ACU', () => {
  it('从缓存获取原始内容', () => {
    mockGetLastOptimizationBase.mockReturnValue({
      messageIndex: 1,
      messageId: 'msg1',
      baseContent: '原始内容',
    });
    mockGetChatArray.mockReturnValue([
      { is_user: true },
      { is_user: false, message_id: 'msg1' },
    ]);
    expect(getOriginalContent_ACU(1)).toBe('原始内容');
  });

  it('从 extra 获取原始内容', () => {
    mockGetLastOptimizationBase.mockReturnValue(null);
    mockGetChatArray.mockReturnValue([
      { is_user: false, extra: { _acu_original_content: '从extra获取' } },
    ]);
    expect(getOriginalContent_ACU(0)).toBe('从extra获取');
  });

  it('消息不存在返回 null', () => {
    mockGetLastOptimizationBase.mockReturnValue(null);
    mockGetChatArray.mockReturnValue([]);
    expect(getOriginalContent_ACU(5)).toBeNull();
  });
});

// ═══ purgeOldLayerData_ACU ═══
describe('purgeOldLayerData_ACU', () => {
  it('清理超出保留层数的旧数据', async () => {
    mockSettings.retainRecentLayers = 2;
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_Data: { sheet_0: { index } },
    }));
    mockGetChatArray.mockReturnValue(chat);
    await purgeOldLayerData_ACU();
    expect(chat[0].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[1].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[2].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[12].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[22].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[23].TavernDB_ACU_Data).toBeDefined();
    expect(chat[24].TavernDB_ACU_Data).toBeDefined();
    expect(mockSaveChatToHost).toHaveBeenCalled();
  });

  it('chat[0] 只保护指导表字段，不保护普通本地数据', async () => {
    mockSettings.retainRecentLayers = 1;
    const chat = Array.from({ length: 23 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_InternalSheetGuide: index === 0 ? { sheet_0: { name: '指导表' } } : undefined,
      TavernDB_ACU_Data: { sheet_0: { index } },
    }));
    mockGetChatArray.mockReturnValue(chat);

    await purgeOldLayerData_ACU();

    expect(chat[0].TavernDB_ACU_InternalSheetGuide).toEqual({ sheet_0: { name: '指导表' } });
    expect(chat[0].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[1].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[11].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[21].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[22].TavernDB_ACU_Data).toBeDefined();
  });

  it('达到保留数与 20 个 AI 楼层缓冲后，在最新保留 AI 窗口首个 AI 楼层补写 V2 checkpoint', async () => {
    mockSettings.retainRecentLayers = 2;
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            ...(index === 0
              ? {
                  checkpoint: {
                    kind: 'full',
                    createdAt: 1,
                    reason: 'init',
                    data: { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] } },
                  },
                }
              : {}),
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    await purgeOldLayerData_ACU();

    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[22].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0.content[1][1]).toBe('剑');
    expect(chat[24].TavernDB_ACU_IsolatedData).toBeDefined();
  });

  it('boundary checkpoint 写入失败时保留旧 checkpoint 且不清理旧楼层', async () => {
    mockSettings.retainRecentLayers = 2;
    mockLoadTableStateFromFramesV2.mockResolvedValueOnce(null);
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            checkpoint: index === 0
              ? {
                  kind: 'full',
                  createdAt: 1,
                  reason: 'init',
                  data: { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] } },
                }
              : index === 24
                ? {
                    kind: 'full',
                    createdAt: 24,
                    reason: 'manual',
                    data: { sheet_0: { name: '旧手动快照', content: [['row_id', '物品名'], ['1', '盾']] } },
                  }
                : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    await purgeOldLayerData_ACU();

    expect(chat[0].TavernDB_ACU_IsolatedData).toBeDefined();
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toBeUndefined();
    expect(chat[24].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'manual',
    }));
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('anchor 前缺 full checkpoint 时即使保留区已有 compaction checkpoint 也必须中止清理', async () => {
    mockSettings.retainRecentLayers = 2;
    mockLoadTableStateFromFramesV2.mockResolvedValueOnce(null);

    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            ...(index === 24
              ? {
                  checkpoint: {
                    kind: 'full',
                    createdAt: 24,
                    reason: 'compaction',
                    data: { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '盾']] } },
                  },
                }
              : {}),
            logEntries: index === 24
              ? []
              : [{
                  seq: 1,
                  entryId: `v2_log_${index}`,
                  createdAt: index,
                  source: 'auto_fill',
                  targetMessageIndex: index,
                  aiFloor: index + 1,
                  filledSheetKeys: ['sheet_0'],
                  changedSheetKeys: ['sheet_0'],
                  operations: [],
                  writeSet: [{ kind: 'all' }],
                }],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    await purgeOldLayerData_ACU();

    expect(mockLoadTableStateFromFramesV2).toHaveBeenCalledWith(chat, '', { maxMessageIndex: 23 });
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeDefined();
    expect(chat[22].TavernDB_ACU_IsolatedData).toBeDefined();
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toBeUndefined();
    expect(chat[24].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('user 消息不参与 AI 楼层计数，purge anchor 仍落在第 21 个 AI 楼层', async () => {
    mockSettings.retainRecentLayers = 2;
    const chat: any[] = [];
    for (let aiOrdinal = 0; aiOrdinal < 22; aiOrdinal++) {
      if (aiOrdinal === 5 || aiOrdinal === 12 || aiOrdinal === 20) {
        chat.push({ is_user: true, mes: `用户插入 ${aiOrdinal}` });
      }
      chat.push({
        is_user: false,
        mes: `AI ${aiOrdinal}`,
        TavernDB_ACU_IsolatedData: {
          '': {
            storageFrame: {
              version: 2,
              ...(aiOrdinal === 0
                ? {
                    checkpoint: {
                      kind: 'full',
                      createdAt: 1,
                      reason: 'init',
                      data: { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] } },
                    },
                  }
                : {}),
              logEntries: [],
            },
            _acu_storage_version: 2,
          },
        },
      });
    }
    mockGetChatArray.mockReturnValue(chat);

    await purgeOldLayerData_ACU();

    expect(chat).toHaveLength(25);
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[22].is_user).toBe(true);
    expect(chat[23].is_user).toBe(false);
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    expect(chat[24].TavernDB_ACU_IsolatedData).toBeDefined();
  });

  it('retainRecentLayers=0 时跳过', async () => {
    mockSettings.retainRecentLayers = 0;
    mockGetChatArray.mockReturnValue([]);
    await purgeOldLayerData_ACU();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('数据层数不超过保留数时不清理', async () => {
    mockSettings.retainRecentLayers = 10;
    const chat = [
      { is_user: false },
      { is_user: false, TavernDB_ACU_Data: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    await purgeOldLayerData_ACU();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });
});

// ═══ ensureV2BoundaryCheckpointForRetainedBuffer_ACU ═══
describe('ensureV2BoundaryCheckpointForRetainedBuffer_ACU', () => {
  it('手动入口在最新保留 AI 窗口首个 AI 楼层写入 full boundary checkpoint，且不删除旧楼层数据', async () => {
    mockSettings.retainRecentLayers = 2;
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            ...(index === 0
              ? {
                  checkpoint: {
                    kind: 'full',
                    createdAt: 1,
                    reason: 'init',
                    data: { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] } },
                  },
                }
              : {}),
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: true, anchorIndex: 23 }));
    expect(mockRunTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'system_cleanup',
      reason: 'manual_refill_boundary_checkpoint',
      maintenanceMode: 'exclusive',
      writeSet: [{ kind: 'all' }],
    }), expect.any(Function));
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeDefined();
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0.content[1][1]).toBe('剑');
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('retainRecentLayers=100 且 30 个 AI 楼层时不触发边界 rotate', async () => {
    mockSettings.retainRecentLayers = 100;
    const chat = Array.from({ length: 30 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            checkpoint: index === 29
              ? { kind: 'full', createdAt: 30, reason: 'manual', data: { sheet_0: { name: '默认保留', content: [['row_id'], ['30']] } } }
              : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    expect(shouldRotateV2BoundaryCheckpointForRetainedBuffer_ACU()).toBe(false);
    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: false, skipped: true }));
    expect(mockLoadTableStateFromFramesV2).not.toHaveBeenCalled();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(chat[29].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({ kind: 'full', reason: 'manual' }));
  });

  it('已有 anchor compaction full checkpoint 时跳过写入并不保存', async () => {
    mockSettings.retainRecentLayers = 2;
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            checkpoint: index === 23
              ? { kind: 'full', createdAt: 2, reason: 'compaction', data: { sheet_0: { name: '已有', content: [['row_id']] } } }
              : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: false, anchorIndex: 23 }));
    expect(mockLoadTableStateFromFramesV2).not.toHaveBeenCalled();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('retained window 内已有非 compaction full 时仍写 anchor，并将旧 full 降级为 data_replace log', async () => {
    mockSettings.retainRecentLayers = 2;
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            checkpoint: index === 24
              ? {
                  kind: 'full',
                  createdAt: 24,
                  reason: 'manual',
                  data: { sheet_0: { name: '最新旧快照', content: [['row_id', '物品名'], ['1', '盾']] } },
                }
              : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: true, anchorIndex: 23 }));
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    const downgradedFrame = chat[24].TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(downgradedFrame.checkpoint).toBeUndefined();
    expect(downgradedFrame.logEntries[0]).toEqual(expect.objectContaining({
      source: 'system',
      targetMessageIndex: 24,
      operations: [{ kind: 'data_replace', data: { sheet_0: { name: '最新旧快照', content: [['row_id', '物品名'], ['1', '盾']] } }, reason: 'checkpoint_fallback' }],
    }));
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('降级 retained window 内的 full 时保留同 frame 的单表 checkpoint', async () => {
    mockSettings.retainRecentLayers = 2;
    const sheetCheckpoint = {
      kind: 'sheet_full',
      createdAt: 24,
      reason: 'manual',
      sheetKey: 'sheet_aux',
      data: { name: '辅助表', content: [['row_id', '值'], ['1', '保留']] },
    };
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            checkpoint: index === 24
              ? {
                  kind: 'full',
                  createdAt: 24,
                  reason: 'manual',
                  data: { mate: { type: 'acu', version: 1 }, sheet_0: { name: '最新旧快照', content: [['row_id', '物品名'], ['1', '盾']] }, sheet_other: { name: '其他表', content: [['row_id', '值'], ['1', '不变']] } },
                }
              : undefined,
            perSheetCheckpoints: index === 24 ? { sheet_aux: sheetCheckpoint } : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: true, anchorIndex: 23 }));
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    const downgradedFrame = chat[24].TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(downgradedFrame.checkpoint).toBeUndefined();
    expect(downgradedFrame.perSheetCheckpoints).toEqual({ sheet_aux: sheetCheckpoint });
    expect(downgradedFrame.logEntries[0]).toEqual(expect.objectContaining({
      operations: [{
        kind: 'data_replace',
        data: {
          mate: { type: 'acu', version: 1 },
          sheet_0: { name: '最新旧快照', content: [['row_id', '物品名'], ['1', '盾']] },
          sheet_other: { name: '其他表', content: [['row_id', '值'], ['1', '不变']] },
          sheet_aux: sheetCheckpoint.data,
        },
        reason: 'checkpoint_fallback',
      }],
    }));
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('boundary checkpoint 恢复失败时不降级旧 full checkpoint 且不保存', async () => {
    mockSettings.retainRecentLayers = 2;
    mockLoadTableStateFromFramesV2.mockResolvedValueOnce(null);
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            checkpoint: index === 0
              ? {
                  kind: 'full',
                  createdAt: 1,
                  reason: 'init',
                  data: { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] } },
                }
              : index === 24
                ? {
                    kind: 'full',
                    createdAt: 24,
                    reason: 'manual',
                    data: { sheet_0: { name: '旧手动快照', content: [['row_id', '物品名'], ['1', '盾']] } },
                  }
                : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: false, changed: false, anchorIndex: 23 }));
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toBeUndefined();
    expect(chat[24].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'manual',
    }));
    expect(chat[24].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toEqual([]);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('多 isolationKey 写入中途失败时不保存、不降级后续旧 full、不清理旧楼层', async () => {
    mockSettings.retainRecentLayers = 2;
    mockLoadTableStateFromFramesV2
      .mockResolvedValueOnce({ sheet_0: { name: '标签A', content: [['row_id'], ['1']] } })
      .mockResolvedValueOnce(null);
    const chat = Array.from({ length: 25 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        tag_A: {
          storageFrame: {
            version: 2,
            checkpoint: index === 0
              ? { kind: 'full', createdAt: 1, reason: 'init', data: { sheet_0: { name: '标签A旧基线', content: [['row_id']] } } }
              : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
        tag_B: {
          storageFrame: {
            version: 2,
            checkpoint: index === 0
              ? { kind: 'full', createdAt: 1, reason: 'init', data: { sheet_0: { name: '标签B旧基线', content: [['row_id']] } } }
              : index === 24
                ? { kind: 'full', createdAt: 24, reason: 'manual', data: { sheet_0: { name: '标签B手动快照', content: [['row_id'], ['b1']] } } }
                : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    const before = JSON.parse(JSON.stringify(chat));
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: false, changed: false, anchorIndex: 23 }));
    expect(mockLoadTableStateFromFramesV2).toHaveBeenNthCalledWith(1, chat, 'tag_A', { maxMessageIndex: 23 });
    expect(mockLoadTableStateFromFramesV2).toHaveBeenNthCalledWith(2, chat, 'tag_B', { maxMessageIndex: 23 });
    expect(chat).toEqual(before);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('user 消息不参与 AI 楼层计数，ensure anchor 写入第 21 个 AI 楼层对应的实际 chat index', async () => {
    mockSettings.retainRecentLayers = 2;
    const chat: any[] = [];
    for (let aiOrdinal = 0; aiOrdinal < 22; aiOrdinal++) {
      if (aiOrdinal === 5 || aiOrdinal === 12 || aiOrdinal === 20) {
        chat.push({ is_user: true, mes: `用户插入 ${aiOrdinal}` });
      }
      chat.push({
        is_user: false,
        mes: `AI ${aiOrdinal}`,
        TavernDB_ACU_IsolatedData: {
          '': {
            storageFrame: {
              version: 2,
              ...(aiOrdinal === 0
                ? {
                    checkpoint: {
                      kind: 'full',
                      createdAt: 1,
                      reason: 'init',
                      data: { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] } },
                    },
                  }
                : {}),
              logEntries: [],
            },
            _acu_storage_version: 2,
          },
        },
      });
    }
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: true, anchorIndex: 23 }));
    expect(chat).toHaveLength(25);
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeDefined();
    expect(chat[22].is_user).toBe(true);
    expect(chat[23].is_user).toBe(false);
    expect(chat[23].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('retainRecentLayers=10 且 30 个 AI 楼层时在第 21 个 AI 楼层写边界并降级第 30 层 full', async () => {
    mockSettings.retainRecentLayers = 10;
    const fullRefillData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_1: {
        name: '纪要表',
        content: [
          ['row_id', '事件'],
          ...Array.from({ length: 30 }, (_, index) => [`${index + 1}`, `第${index + 1}层事件`]),
        ],
      },
    };
    mockLoadTableStateFromFramesV2.mockResolvedValueOnce({
      mate: { type: 'chatSheets', version: 1 },
      sheet_1: { name: '纪要表', content: [['row_id', '事件'], ['20', '边界旧事件']] },
    });
    const chat = Array.from({ length: 30 }, (_, index) => ({
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            version: 2,
            checkpoint: index === 29
              ? { kind: 'full', createdAt: 30, reason: 'init', data: fullRefillData }
              : undefined,
            logEntries: [],
          },
          _acu_storage_version: 2,
        },
      },
    }));
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureV2BoundaryCheckpointForRetainedBuffer_ACU({ reason: 'manual_refill', save: true });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: true, anchorIndex: 20 }));
    expect(mockLoadTableStateFromFramesV2).toHaveBeenCalledWith(chat, '', { maxMessageIndex: 20 });
    expect(chat[20].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(expect.objectContaining({
      kind: 'full',
      reason: 'compaction',
    }));
    expect(chat[20].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_1.content[1]).toEqual(['20', '边界旧事件']);
    const deletedLaterFrame = chat[29].TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(deletedLaterFrame.checkpoint).toBeUndefined();
    expect(deletedLaterFrame.logEntries[0].operations[0]).toEqual({
      kind: 'data_replace',
      data: fullRefillData,
      reason: 'checkpoint_fallback',
    });
  });
});



// ═══ deleteLocalDataInChatCore_ACU ═══
describe('deleteLocalDataInChatCore_ACU', () => {
  it('mode=all 删除所有数据', async () => {
    const chat = [
      { is_user: true },
      { is_user: false, TavernDB_ACU_Data: { sheet_0: {} }, TavernDB_ACU_SummaryData: {} },
      { is_user: false, TavernDB_ACU_Data: { sheet_0: {} } },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const count = await deleteLocalDataInChatCore_ACU('all');
    expect(count).toBe(2);
    expect(chat[1].TavernDB_ACU_Data).toBeUndefined();
    expect(chat[2].TavernDB_ACU_Data).toBeUndefined();
  });

  it('空聊天记录返回 0', async () => {
    mockGetChatArray.mockReturnValue([]);
    const count = await deleteLocalDataInChatCore_ACU('all');
    expect(count).toBe(0);
  });

  it('mode=current 只删除当前隔离标签的数据', async () => {
    mockSettings.dataIsolationEnabled = true;
    mockSettings.dataIsolationCode = 'tag_A';
    mockGetCurrentIsolationKey.mockReturnValue('tag_A');
    const chat = [
      { is_user: false, TavernDB_ACU_Data: {}, TavernDB_ACU_Identity: 'tag_A', TavernDB_ACU_IsolatedData: { tag_A: { independentData: {} } } },
      { is_user: false, TavernDB_ACU_Data: {}, TavernDB_ACU_Identity: 'tag_B' },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const count = await deleteLocalDataInChatCore_ACU('current');
    expect(count).toBe(1);
  });

  it('mode=current 删除无旧版 Identity 的 V2 当前隔离槽', async () => {
    mockSettings.dataIsolationEnabled = true;
    mockSettings.dataIsolationCode = 'tag_A';
    mockGetCurrentIsolationKey.mockReturnValue('tag_A');
    const chat = [
      { is_user: false, TavernDB_ACU_IsolatedData: { tag_A: { storageFrame: { version: 2, checkpoint: { kind: 'full', data: {} }, logEntries: [] }, _acu_storage_version: 2 }, tag_B: { independentData: {} } } },
      { is_user: false, TavernDB_ACU_IsolatedData: { tag_B: { independentData: {} } } },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await deleteLocalDataInChatCore_ACU('current');

    expect(count).toBe(1);
    expect(chat[0].TavernDB_ACU_IsolatedData.tag_A).toBeUndefined();
    expect(chat[0].TavernDB_ACU_IsolatedData.tag_B).toBeDefined();
    expect(chat[1].TavernDB_ACU_IsolatedData.tag_B).toBeDefined();
  });

  it('指定楼层范围', async () => {
    const chat = [
      { is_user: false, TavernDB_ACU_Data: {} }, // AI楼层1
      { is_user: false, TavernDB_ACU_Data: {} }, // AI楼层2
      { is_user: false, TavernDB_ACU_Data: {} }, // AI楼层3
    ];
    mockGetChatArray.mockReturnValue(chat);
    const count = await deleteLocalDataInChatCore_ACU('all', 1, 2);
    expect(count).toBe(2);
    expect(chat[2].TavernDB_ACU_Data).toBeDefined(); // 第3层不在范围内
  });
});

// ═══ clearTableDataAtFloors_ACU ═══
describe('clearTableDataAtFloors_ACU', () => {
  it('按目标楼层和 selected sheet 精确清理 V2 storageFrame，保留同层其他表和范围外基底', async () => {
    const chat = [
      {
        is_user: false,
        mes: 'AI范围外基底',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'compaction',
                data: {
                  sheet_0: { name: '范围外表', content: [['row_id'], ['base']] },
                },
              },
              logEntries: [],
            },
          },
        },
      },
      { is_user: true, mes: '用户消息跳过' },
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            independentData: {
              sheet_0: { name: '旧目标表' },
              sheet_1: { name: '保留表' },
            },
            modifiedKeys: ['sheet_0', 'sheet_1'],
            updateGroupKeys: ['sheet_0', 'sheet_1'],
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'manual',
                data: {
                  sheet_0: { name: '旧目标表', content: [['row_id'], ['old']] },
                  sheet_1: { name: '保留表', content: [['row_id'], ['keep']] },
                },
                scheduleSummary: {
                  sheet_0: { lastFilledAiFloor: 1 },
                  sheet_1: { lastFilledAiFloor: 1 },
                },
                event: {
                  filledSheetKeys: ['sheet_0', 'sheet_1'],
                  changedSheetKeys: ['sheet_0', 'sheet_1'],
                  groupKeys: ['sheet_0', 'sheet_1'],
                },
              },
              logEntries: [
                {
                  seq: 1,
                  operations: [
                    { kind: 'data_replace', data: { sheet_0: { name: '旧目标表' }, sheet_1: { name: '保留表' } } },
                  ],
                  filledSheetKeys: ['sheet_0', 'sheet_1'],
                  changedSheetKeys: ['sheet_0', 'sheet_1'],
                  groupKeys: ['sheet_0', 'sheet_1'],
                },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearTableDataAtFloors_ACU([1, 2], ['sheet_0']);

    expect(count).toBe(1);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0).toBeDefined();
    expect(chat[1]).toEqual({ is_user: true, mes: '用户消息跳过' });
    const targetTag = chat[2].TavernDB_ACU_IsolatedData[''];
    expect(targetTag.independentData.sheet_0).toBeUndefined();
    expect(targetTag.independentData.sheet_1).toEqual({ name: '保留表' });
    expect(targetTag.modifiedKeys).toEqual(['sheet_1']);
    expect(targetTag.updateGroupKeys).toEqual(['sheet_1']);
    expect(targetTag.storageFrame.checkpoint.data.sheet_0).toBeUndefined();
    expect(targetTag.storageFrame.checkpoint.data.sheet_1.content[1][0]).toBe('keep');
    expect(targetTag.storageFrame.checkpoint.scheduleSummary.sheet_0).toBeUndefined();
    expect(targetTag.storageFrame.checkpoint.scheduleSummary.sheet_1).toEqual({ lastFilledAiFloor: 1 });
    expect(targetTag.storageFrame.checkpoint.event.filledSheetKeys).toEqual(['sheet_1']);
    expect(targetTag.storageFrame.logEntries[0].operations[0].data).toEqual({ sheet_1: { name: '保留表' } });
    expect(targetTag.storageFrame.logEntries[0].filledSheetKeys).toEqual(['sheet_1']);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });
});


describe('clearManualRefillIncrementalDataInRange_ACU', () => {
  it('只清理目标楼层 selected sheet 的 V2 增量数据并保留 checkpoint.data', async () => {
    const chat = [
      {
        is_user: false,
        mes: 'AI范围外基底',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'compaction',
                data: {
                  sheet_0: { name: '范围外表', content: [['row_id'], ['base']] },
                },
              },
              logEntries: [],
            },
          },
        },
      },
      { is_user: true, mes: '用户消息跳过' },
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            independentData: {
              sheet_0: { name: '旧目标表' },
              sheet_1: { name: '保留表' },
            },
            modifiedKeys: ['sheet_0', 'sheet_1'],
            updateGroupKeys: ['sheet_0', 'sheet_1'],
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'manual',
                data: {
                  sheet_0: { name: '旧目标表', content: [['row_id'], ['old']] },
                  sheet_1: { name: '保留表', content: [['row_id'], ['keep']] },
                },
                scheduleSummary: {
                  sheet_0: { lastFilledAiFloor: 1 },
                  sheet_1: { lastFilledAiFloor: 1 },
                },
              },
              manualRefillProgress: {
                kind: 'manual_refill',
                status: 'in_progress',
                selectedSheetKeys: ['sheet_0', 'sheet_1'],
                completedSheetMessageIndexByKey: { sheet_0: 2, sheet_1: 3 },
              },
              logEntries: [
                {
                  seq: 1,
                  operations: [
                    { kind: 'row_upsert', sheetKey: 'sheet_0', rowId: 'old-only', cells: ['old-only'] },
                  ],
                  filledSheetKeys: ['sheet_0'],
                  changedSheetKeys: ['sheet_0'],
                  groupKeys: ['sheet_0'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
                },
                {
                  seq: 2,
                  operations: [
                    { kind: 'data_replace', data: { sheet_0: { name: '旧目标表' }, sheet_1: { name: '保留表' } } },
                  ],
                  filledSheetKeys: ['sheet_0', 'sheet_1'],
                  changedSheetKeys: ['sheet_0', 'sheet_1'],
                  groupKeys: ['sheet_0', 'sheet_1'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }, { kind: 'sheet', sheetKey: 'sheet_1' }],
                },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([1, 2], ['sheet_0']);

    expect(count).toBe(1);
    expect(mockRunTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'system_cleanup',
      reason: 'clearIncrementalOnly',
      maintenanceMode: 'exclusive',
      writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
    }), expect.any(Function));
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0).toBeDefined();
    expect(chat[1]).toEqual({ is_user: true, mes: '用户消息跳过' });
    const targetTag = chat[2].TavernDB_ACU_IsolatedData[''];
    expect(targetTag.independentData.sheet_0).toEqual({ name: '旧目标表' });
    expect(targetTag.modifiedKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(targetTag.updateGroupKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(targetTag.storageFrame.checkpoint.data.sheet_0.content[1][0]).toBe('old');
    expect(targetTag.storageFrame.checkpoint.data.sheet_1.content[1][0]).toBe('keep');
    expect(targetTag.storageFrame.checkpoint.scheduleSummary.sheet_0).toEqual({ lastFilledAiFloor: 1 });
    expect(targetTag.storageFrame.manualRefillProgress.selectedSheetKeys).toEqual(['sheet_1']);
    expect(targetTag.storageFrame.manualRefillProgress.completedSheetMessageIndexByKey).toEqual({ sheet_1: 3 });
    expect(targetTag.storageFrame.logEntries).toHaveLength(1);
    expect(targetTag.storageFrame.logEntries[0].seq).toBe(2);
    expect(targetTag.storageFrame.logEntries[0].operations[0].data).toEqual({ sheet_1: { name: '保留表' } });
    expect(targetTag.storageFrame.logEntries[0].filledSheetKeys).toEqual(['sheet_1']);
    expect(targetTag.storageFrame.logEntries[0].writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_1' }]);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('对 V2 runtime-v1 baseRevision 与 parentRevision 目标 sheet 指纹生效', async () => {
    const baseRevision = `runtime-v1:${JSON.stringify({
      sheets: {
        sheet_target: { name: '旧目标表', content: [['row_id'], ['target-base']] },
        sheet_keep: { name: '保留表', content: [['row_id'], ['keep-base']] },
      },
    })}`;
    const parentRevision = `runtime-v1:${JSON.stringify({
      sheets: {
        sheet_target: { name: '旧目标表', content: [['row_id'], ['target-parent']] },
        sheet_keep: { name: '保留表', content: [['row_id'], ['keep-parent']] },
      },
    })}`;
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 1,
                  baseRevision,
                  parentRevision,
                  operations: [
                    { kind: 'data_replace', data: { sheet_target: { name: '旧目标表' }, sheet_keep: { name: '保留表' } } },
                  ],
                  filledSheetKeys: ['sheet_target', 'sheet_keep'],
                  changedSheetKeys: ['sheet_target', 'sheet_keep'],
                  groupKeys: ['sheet_target', 'sheet_keep'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_target' }, { kind: 'sheet', sheetKey: 'sheet_keep' }],
                },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_target']);

    expect(count).toBe(1);
    const entry = chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries[0];
    expect(entry.filledSheetKeys).toEqual(['sheet_keep']);
    expect(entry.changedSheetKeys).toEqual(['sheet_keep']);
    expect(entry.groupKeys).toEqual(['sheet_keep']);
    expect(entry.writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_keep' }]);
    expect(entry.operations[0].data).toEqual({ sheet_keep: { name: '保留表' } });

    const parsedBaseRevision = JSON.parse(entry.baseRevision.slice('runtime-v1:'.length));
    const parsedParentRevision = JSON.parse(entry.parentRevision.slice('runtime-v1:'.length));
    expect(parsedBaseRevision.sheets).toEqual({
      sheet_keep: { name: '保留表', content: [['row_id'], ['keep-base']] },
    });
    expect(parsedParentRevision.sheets).toEqual({
      sheet_keep: { name: '保留表', content: [['row_id'], ['keep-parent']] },
    });
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('对纯 revision-only 空壳 log entry 触发删除且 saveChatToHost 仍只调用一次', async () => {
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 1,
                  baseRevision: `runtime-v1:${JSON.stringify({
                    sheets: {
                      sheet_target: { name: '旧目标表', content: [['row_id'], ['target']] },
                    },
                  })}`,
                },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_target']);

    expect(count).toBe(1);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toEqual([]);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('保留异常 runtime-v1 与非 runtime-v1 revision 且无实际修改时不保存', async () => {
    const malformedRevision = 'runtime-v1:{bad json';
    const otherPrefixRevision = `other-prefix:${JSON.stringify({ sheets: { sheet_target: { name: '旧目标表' } } })}`;
    const nonObjectSheetsRevision = `runtime-v1:${JSON.stringify({ sheets: null })}`;
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                { seq: 1, baseRevision: malformedRevision },
                { seq: 2, baseRevision: otherPrefixRevision },
                { seq: 3, baseRevision: nonObjectSheetsRevision },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_target']);

    expect(count).toBe(0);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toEqual([
      { seq: 1, baseRevision: malformedRevision },
      { seq: 2, baseRevision: otherPrefixRevision },
      { seq: 3, baseRevision: nonObjectSheetsRevision },
    ]);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('按多个 targetSheetKeys 删除目标集合并保留非目标 sheet revision', async () => {
    const revision = `runtime-v1:${JSON.stringify({
      sheets: {
        sheet_a: { name: '目标表A', content: [['row_id'], ['a']] },
        sheet_b: { name: '保留表B', content: [['row_id'], ['b']] },
        sheet_c: { name: '目标表C', content: [['row_id'], ['c']] },
        sheet_d: { name: '保留表D', content: [['row_id'], ['d']] },
      },
    })}`;
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 1,
                  baseRevision: revision,
                  operations: [
                    {
                      kind: 'data_replace',
                      data: {
                        sheet_a: { name: '目标表A' },
                        sheet_b: { name: '保留表B' },
                        sheet_c: { name: '目标表C' },
                        sheet_d: { name: '保留表D' },
                      },
                    },
                  ],
                  filledSheetKeys: ['sheet_a', 'sheet_b', 'sheet_c', 'sheet_d'],
                  changedSheetKeys: ['sheet_a', 'sheet_b', 'sheet_c', 'sheet_d'],
                  groupKeys: ['sheet_a', 'sheet_b', 'sheet_c', 'sheet_d'],
                  writeSet: [
                    { kind: 'sheet', sheetKey: 'sheet_a' },
                    { kind: 'sheet', sheetKey: 'sheet_b' },
                    { kind: 'sheet', sheetKey: 'sheet_c' },
                    { kind: 'sheet', sheetKey: 'sheet_d' },
                  ],
                },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_a', 'sheet_c']);

    expect(count).toBe(1);
    const entry = chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries[0];
    expect(entry.filledSheetKeys).toEqual(['sheet_b', 'sheet_d']);
    expect(entry.changedSheetKeys).toEqual(['sheet_b', 'sheet_d']);
    expect(entry.groupKeys).toEqual(['sheet_b', 'sheet_d']);
    expect(entry.writeSet).toEqual([
      { kind: 'sheet', sheetKey: 'sheet_b' },
      { kind: 'sheet', sheetKey: 'sheet_d' },
    ]);
    expect(entry.operations[0].data).toEqual({
      sheet_b: { name: '保留表B' },
      sheet_d: { name: '保留表D' },
    });
    expect(JSON.parse(entry.baseRevision.slice('runtime-v1:'.length)).sheets).toEqual({
      sheet_b: { name: '保留表B', content: [['row_id'], ['b']] },
      sheet_d: { name: '保留表D', content: [['row_id'], ['d']] },
    });
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('清理旧版 patches.data_replace 与 entry.manualRefillProgress 中的目标 sheet 残留', async () => {
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 1,
                  patches: [
                    {
                      kind: 'data_replace',
                      data: {
                        sheet_target: { name: '旧目标表' },
                        sheet_keep: { name: '保留表' },
                      },
                    },
                  ],
                  manualRefillProgress: {
                    kind: 'manual_refill',
                    selectedSheetKeys: ['sheet_target', 'sheet_keep'],
                    completedSheetMessageIndexByKey: { sheet_target: 2, sheet_keep: 3 },
                  },
                  filledSheetKeys: ['sheet_target', 'sheet_keep'],
                  changedSheetKeys: ['sheet_target', 'sheet_keep'],
                  groupKeys: ['sheet_target', 'sheet_keep'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_target' }, { kind: 'sheet', sheetKey: 'sheet_keep' }],
                },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_target']);

    expect(count).toBe(1);
    const entry = chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries[0];
    expect(entry.patches).toEqual([
      { kind: 'data_replace', data: { sheet_keep: { name: '保留表' } } },
    ]);
    expect(entry.manualRefillProgress.selectedSheetKeys).toEqual(['sheet_keep']);
    expect(entry.manualRefillProgress.completedSheetMessageIndexByKey).toEqual({ sheet_keep: 3 });
    expect(entry.filledSheetKeys).toEqual(['sheet_keep']);
    expect(entry.changedSheetKeys).toEqual(['sheet_keep']);
    expect(entry.groupKeys).toEqual(['sheet_keep']);
    expect(entry.writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_keep' }]);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });


  it('目标表不存在时不修改消息且不保存', async () => {
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 1,
                  baseRevision: `runtime-v1:${JSON.stringify({ sheets: { sheet_keep: { name: '保留表' } } })}`,
                  filledSheetKeys: ['sheet_keep'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_keep' }],
                },
              ],
            },
          },
        },
      },
    ];
    const before = JSON.parse(JSON.stringify(chat));
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_missing']);

    expect(count).toBe(0);
    expect(chat).toEqual(before);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('非空 isolationKey 只清当前标签且不串改旁路标签', async () => {
    const tagARevision = `runtime-v1:${JSON.stringify({
      sheets: {
        sheet_target: { name: '标签A目标表', content: [['row_id'], ['target-a']] },
        sheet_keep: { name: '标签A保留表', content: [['row_id'], ['keep-a']] },
      },
    })}`;
    const tagBRevision = `runtime-v1:${JSON.stringify({
      sheets: {
        sheet_target: { name: '标签B目标表', content: [['row_id'], ['target-b']] },
        sheet_keep: { name: '标签B保留表', content: [['row_id'], ['keep-b']] },
      },
    })}`;
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          'tag-a': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 1,
                  baseRevision: tagARevision,
                  filledSheetKeys: ['sheet_target', 'sheet_keep'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_target' }, { kind: 'sheet', sheetKey: 'sheet_keep' }],
                },
              ],
            },
          },
          'tag-b': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 1,
                  baseRevision: tagBRevision,
                  filledSheetKeys: ['sheet_target', 'sheet_keep'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_target' }, { kind: 'sheet', sheetKey: 'sheet_keep' }],
                },
              ],
            },
          },
        },
      },
    ];
    const tagBBefore = JSON.parse(JSON.stringify(chat[0].TavernDB_ACU_IsolatedData['tag-b']));
    mockGetCurrentIsolationKey.mockReturnValue('tag-a');
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_target']);

    expect(count).toBe(1);
    const tagAEntry = chat[0].TavernDB_ACU_IsolatedData['tag-a'].storageFrame.logEntries[0];
    expect(tagAEntry.filledSheetKeys).toEqual(['sheet_keep']);
    expect(tagAEntry.writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_keep' }]);
    expect(JSON.parse(tagAEntry.baseRevision.slice('runtime-v1:'.length)).sheets).toEqual({
      sheet_keep: { name: '标签A保留表', content: [['row_id'], ['keep-a']] },
    });
    expect(chat[0].TavernDB_ACU_IsolatedData['tag-b']).toEqual(tagBBefore);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('清理后输出 targetKeys 残留诊断摘要且不增加保存次数', async () => {
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'manual',
                data: {
                  sheet_target: { name: 'checkpoint目标表' },
                  sheet_keep: { name: 'checkpoint保留表' },
                },
                scheduleSummary: {
                  sheet_target: { lastFilledAiFloor: 3 },
                },
              },
              logEntries: [
                {
                  seq: 1,
                  baseRevision: `runtime-v1:${JSON.stringify({
                    sheets: {
                      sheet_target: { name: '旧目标表' },
                      sheet_keep: { name: '保留表' },
                    },
                  })}`,
                  filledSheetKeys: ['sheet_target', 'sheet_keep'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_target' }, { kind: 'sheet', sheetKey: 'sheet_keep' }],
                },
              ],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], ['sheet_target']);

    expect(count).toBe(1);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
    expect(mockLogDebug).toHaveBeenCalledWith('[手动重填诊断] 选中表清理后残留摘要', expect.objectContaining({
      clearedCount: 1,
      targetKeys: ['sheet_target'],
      fields: ['event', 'operations', 'patches', 'writeSet', 'revision', 'progress'],
      residue: {
        exactHits: 0,
        runtimeV1Hits: 0,
        substringOnlyPathCount: 0,
        checkpointDataRiskCount: 1,
        scheduleSummaryRiskCount: 1,
        checkpointDataRiskDetailCount: 1,
        checkpointDataRiskDetails: [
          {
            messageIndex: 0,
            tagKey: '',
            targetKey: 'sheet_target',
            reason: 'manual',
          },
        ],
      },
    }));
  });

  it('仅 checkpoint.data 残留目标表时输出风险诊断但不保存且不泄漏表内容', async () => {
    const targetKeys = Array.from({ length: 10 }, (_, index) => `sheet_target_${index + 1}`);
    const checkpointData = Object.fromEntries(targetKeys.map((key, index) => [key, { name: `checkpoint目标表${index + 1}`, content: [['row_id'], [`secret-${index + 1}`]] }]));
    const scheduleSummary = Object.fromEntries(targetKeys.map(key => [key, { lastFilledAiFloor: 3 }]));
    const chat = [
      {
        is_user: false,
        mes: 'AI目标层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'manual',
                createdAt: 123456,
                data: checkpointData,
                scheduleSummary,
              },
              logEntries: [
                {
                  seq: 1,
                  filledSheetKeys: ['sheet_keep'],
                  writeSet: [{ kind: 'sheet', sheetKey: 'sheet_keep' }],
                },
              ],
            },
          },
        },
      },
    ];
    const checkpointBefore = JSON.parse(JSON.stringify(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint));
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([0], targetKeys);

    expect(count).toBe(0);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(checkpointBefore);
    const diagnosticCall = mockLogDebug.mock.calls.find(call => call[0] === '[手动重填诊断] 选中表清理后残留摘要');
    expect(diagnosticCall).toBeDefined();
    expect(diagnosticCall![1]).toEqual(expect.objectContaining({
      clearedCount: 0,
      targetKeys,
      residue: expect.objectContaining({
        exactHits: 0,
        runtimeV1Hits: 0,
        substringOnlyPathCount: 0,
        checkpointDataRiskCount: 1,
        scheduleSummaryRiskCount: 1,
        checkpointDataRiskDetailCount: 10,
      }),
    }));
    expect(diagnosticCall![1].residue.checkpointDataRiskDetails).toHaveLength(8);
    expect(diagnosticCall![1].residue.checkpointDataRiskDetails[0]).toEqual({
      messageIndex: 0,
      tagKey: '',
      targetKey: 'sheet_target_1',
      reason: 'manual',
      createdAt: 123456,
    });
    expect(JSON.stringify(diagnosticCall![1])).not.toContain('secret-1');
    expect(JSON.stringify(diagnosticCall![1])).not.toContain('checkpoint目标表1');
  });


  it('使用重填范围之前的 checkpoint 映射清理范围内 log-only sql_batch，避免回放 UPDATE 不存在表', async () => {
    const chat = [
      {
        is_user: false,
        mes: '历史基底',
        TavernDB_ACU_IsolatedData: JSON.stringify({
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'compaction',
                createdAt: 1,
                data: {
                  sheet_0: {
                    uid: 'chronicle',
                    name: '纪要表',
                    sourceData: { ddl: 'CREATE TABLE chronicle (row_id TEXT PRIMARY KEY, code_index TEXT)' },
                  },
                },
              },
              logEntries: [],
            },
          },
        }),
      },
      {
        is_user: false,
        mes: '待重填楼层',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [{
                seq: 1,
                operations: [{
                  kind: 'sql_batch',
                  statements: ["UPDATE 'chronicle' SET 'code_index' = ? WHERE 'row_id' = ?"],
                  params: [['new-index', 'row-1']],
                }],
              }],
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const count = await clearManualRefillIncrementalDataInRange_ACU([1], ['sheet_0']);

    expect(count).toBe(1);
    const historicalTagData = JSON.parse(chat[0].TavernDB_ACU_IsolatedData);
    expect(historicalTagData[''].storageFrame.checkpoint.data.sheet_0.uid).toBe('chronicle');
    expect(chat[1].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toEqual([]);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('未指定目标表时拒绝执行，避免把手动重填增量清理退化成全量清理', async () => {
    await expect(clearManualRefillIncrementalDataInRange_ACU([1], [])).rejects.toThrow('手动重填增量清理必须指定目标表');
    await expect(clearManualRefillIncrementalDataInRange_ACU([1], null)).rejects.toThrow('手动重填增量清理必须指定目标表');
    await expect(clearManualRefillIncrementalDataInRange_ACU([1], undefined as unknown as string[])).rejects.toThrow('手动重填增量清理必须指定目标表');
    expect(mockRunTableWriteTransaction).not.toHaveBeenCalled();
  });
});

// ═══ overrideLatestLayerWithTemplateCore_ACU ═══
describe('overrideLatestLayerWithTemplateCore_ACU', () => {
  it('用模板覆盖最新层', async () => {
    const chat = [
      { is_user: true },
      { is_user: false, TavernDB_ACU_IsolatedData: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const templateData = {
      sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑'], ['2', '盾']] },
    };
    const count = await overrideLatestLayerWithTemplateCore_ACU(templateData);
    expect(count).toBe(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 1,
      targetSheetKeys: ['sheet_0'],
      source: 'system',
    }));
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });

  it('空聊天记录返回 0', async () => {
    mockGetChatArray.mockReturnValue([]);
    const count = await overrideLatestLayerWithTemplateCore_ACU({ sheet_0: { name: '表' } });
    expect(count).toBe(0);
  });

  it('无 AI 消息返回 0', async () => {
    mockGetChatArray.mockReturnValue([{ is_user: true }]);
    const count = await overrideLatestLayerWithTemplateCore_ACU({ sheet_0: { name: '表' } });
    expect(count).toBe(0);
  });

  it('覆盖后只保留表头', async () => {
    const chat = [{ is_user: false }];
    mockGetChatArray.mockReturnValue(chat);
    const templateData = {
      sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑'], ['2', '盾']] },
    };
    await overrideLatestLayerWithTemplateCore_ACU(templateData);
    const call = mockPersistTablesToChatMessage.mock.calls[0]?.[0];
    expect(call.operations[0].kind).toBe('sheet_replace');
    expect(call.operations[0].sheet.content.length).toBe(1); // 只有表头
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
  });
});

// ═══ saveCurrentDataForTable_ACU ═══
describe('saveCurrentDataForTable_ACU', () => {
  beforeEach(() => {
    mockPersistTablesToChatMessage.mockClear();
  });

  it('无数据时不报错', async () => {
    mockCurrentJsonTableData.sheet_0 = undefined;
    await expect(saveCurrentDataForTable_ACU('sheet_0')).resolves.not.toThrow();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });
  it('无聊天记录时不报错', async () => {
    mockGetChatArray.mockReturnValue([]);
    await expect(saveCurrentDataForTable_ACU('sheet_0')).resolves.not.toThrow();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });
  it('聊天记录全为 user 消息时不调用持久化', async () => {
    const chat = [{ is_user: true, mes: '用户消息' }];
    mockGetChatArray.mockReturnValue(chat);
    mockCurrentJsonTableData.sheet_0 = { name: '物品表', content: [] };
    await saveCurrentDataForTable_ACU('sheet_0');
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });
  it('标准表调用 persistTablesToChatMessage_ACU 持久化', async () => {
    const chat = [{ is_user: false, mes: 'AI回复' }];
    mockGetChatArray.mockReturnValue(chat);
    mockCurrentJsonTableData.sheet_0 = { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] };
    await saveCurrentDataForTable_ACU('sheet_0');
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_0'],
      updateGroupKeys: null,
      trackAsUpdate: true
    }));
  });
  it('存在历史数据时 trackAsUpdate 为 false 且指向历史数据楼层', async () => {
    const chat = [
      { is_user: false, mes: '旧AI回复', TavernDB_ACU_IsolatedData: { '': { independentData: { sheet_0: { name: '物品表' } } } } },
      { is_user: true, mes: '用户新消息' },
      { is_user: false, mes: '新AI回复' }
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockCurrentJsonTableData.sheet_0 = { name: '物品表', content: [] };
    await saveCurrentDataForTable_ACU('sheet_0');
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_0'],
      trackAsUpdate: false
    }));
  });
  it('纪要表调用 persistTablesToChatMessage_ACU 持久化', async () => {
    const chat = [{ is_user: false, mes: 'AI回复' }];
    mockGetChatArray.mockReturnValue(chat);
    mockCurrentJsonTableData.sheet_1 = { name: '纪要表', content: [['row_id', '事件'], ['1', '开始']] };
    await saveCurrentDataForTable_ACU('sheet_1');
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_1'],
      updateGroupKeys: null,
      trackAsUpdate: true
    }));
  });
});

// ═══ replaceManualRefillSheetBaselineInRangeAtomic_ACU ═══
describe('replaceManualRefillSheetBaselineInRangeAtomic_ACU', () => {
  const makeFullFrameMessage = (data: any, extraTagData: Record<string, any> = {}) => ({
    is_user: false,
    mes: 'AI full checkpoint',
    TavernDB_ACU_IsolatedData: {
      '': {
        _acu_storage_version: 2,
        independentData: {
          sheet_0: { name: '旧独立表0' },
          sheet_1: { name: '保留独立表1' },
        },
        modifiedKeys: ['sheet_0', 'sheet_1'],
        updateGroupKeys: ['sheet_0', 'sheet_1'],
        storageFrame: {
          version: 2,
          checkpoint: {
            kind: 'full',
            reason: 'init',
            createdAt: 1,
            data,
          },
          logEntries: [],
        },
        ...extraTagData,
      },
    },
  });

  it('在单个 exclusive transaction 内清理目标表旧基底并写入 sheet_full checkpoint', async () => {
    const chat = [
      makeFullFrameMessage({
        sheet_0: { name: '旧表0', content: [['row_id', '值'], ['old', '旧']] },
        sheet_1: { name: '保留表1', content: [['row_id', '值'], ['keep', '保留']] },
      }),
      { is_user: true, mes: '用户消息' },
      {
        is_user: false,
        mes: 'AI incremental',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            independentData: {
              sheet_0: { name: '范围内旧表0' },
              sheet_1: { name: '范围内保留表1' },
            },
            modifiedKeys: ['sheet_0', 'sheet_1'],
            updateGroupKeys: ['sheet_0', 'sheet_1'],
            storageFrame: {
              version: 2,
              checkpoint: undefined,
              logEntries: [{
                seq: 1,
                operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: 'old', cells: ['old', '旧增量'] }],
                filledSheetKeys: ['sheet_0'],
                changedSheetKeys: ['sheet_0'],
                groupKeys: ['sheet_0'],
                writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
              }],
              manualRefillProgress: {
                kind: 'manual_refill',
                status: 'in_progress',
                selectedSheetKeys: ['sheet_0', 'sheet_1'],
                completedSheetMessageIndexByKey: { sheet_0: 2, sheet_1: 2 },
              },
            },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockCollectScheduleSummaryFromFramesV2.mockReturnValue({ sheet_0: { lastFilledAiFloor: 0 } });

    const result = await replaceManualRefillSheetBaselineInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0, 1, 2],
      targetSheetKeys: ['sheet_0'],
      baselineData: {
        sheet_0: { name: '新表0', content: [['row_id', '值'], ['new', '新']] },
      },
    });

    expect(result).toEqual(expect.objectContaining({ success: true, changed: true, clearedCount: 2, checkpointCount: 1, targetMessageIndex: 0 }));
    expect(mockRunTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'system_cleanup',
      reason: 'replaceManualRefillSheetBaselineInRange',
      maintenanceMode: 'exclusive',
      writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
    }), expect.any(Function));
    const targetTag = chat[0].TavernDB_ACU_IsolatedData[''];
    expect(targetTag.storageFrame.checkpoint.kind).toBe('full');
    expect(targetTag.storageFrame.checkpoint.data.sheet_0).toBeUndefined();
    expect(targetTag.storageFrame.checkpoint.data.sheet_1.content[1][0]).toBe('keep');
    expect(targetTag.storageFrame.perSheetCheckpoints.sheet_0).toEqual(expect.objectContaining({
      kind: 'sheet_full',
      reason: 'manual',
      sheetKey: 'sheet_0',
      data: { name: '新表0', content: [['row_id', '值'], ['new', '新']] },
      scheduleSummary: { lastFilledAiFloor: 0 },
    }));
    const incrementalTag = chat[2].TavernDB_ACU_IsolatedData[''];
    expect(incrementalTag.independentData.sheet_0).toBeUndefined();
    expect(incrementalTag.independentData.sheet_1).toEqual({ name: '范围内保留表1' });
    expect(incrementalTag.storageFrame.logEntries).toHaveLength(1);
    expect(incrementalTag.storageFrame.logEntries[0].operations).toEqual([]);
    expect(incrementalTag.storageFrame.logEntries[0].filledSheetKeys).toEqual([]);
    expect(incrementalTag.storageFrame.logEntries[0].changedSheetKeys).toEqual([]);
    expect(incrementalTag.storageFrame.logEntries[0].writeSet).toEqual([]);
    expect(incrementalTag.storageFrame.manualRefillProgress.selectedSheetKeys).toEqual(['sheet_1']);
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
  });

  it('严格宿主保存失败时恢复目标范围内字段，避免内存半状态', async () => {
    const chat = [
      makeFullFrameMessage({
        sheet_0: { name: '旧表0', content: [['row_id'], ['old']] },
        sheet_1: { name: '保留表1', content: [['row_id'], ['keep']] },
      }),
      {
        is_user: false,
        mes: 'AI incremental',
        TavernDB_ACU_Identity: 'old_identity',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            independentData: { sheet_0: { name: '范围内旧表0' }, sheet_1: { name: '保留表1' } },
            modifiedKeys: ['sheet_0', 'sheet_1'],
            updateGroupKeys: ['sheet_0', 'sheet_1'],
            storageFrame: { version: 2, checkpoint: undefined, logEntries: [{ seq: 1, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0' }], filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: ['sheet_0'], writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }] }] },
          },
        },
      },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const before = JSON.parse(JSON.stringify(chat));
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('save failed'));

    const result = await replaceManualRefillSheetBaselineInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0, 1],
      targetSheetKeys: ['sheet_0'],
      baselineData: { sheet_0: { name: '新表0', content: [['row_id'], ['new']] } },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('save failed');
    expect(JSON.parse(JSON.stringify(chat))).toEqual(before);
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
  });

  it('严格宿主保存失败时不删除外置向量索引文件', async () => {
    const manifest = { indexId: 'idx-save-failed', files: [{ path: 'vector-a.json', role: 'base_shard' }] };
    const chat = [
      makeFullFrameMessage({
        sheet_0: { name: '旧表0', content: [['row_id'], ['old']] },
        sheet_1: { name: '旧纪要表', content: [['row_id'], ['summary']] },
      }, {
        summaryVectorIndexManifest: manifest,
        summaryVectorIndexState: { manifest },
      }),
    ];
    mockGetChatArray.mockReturnValue(chat);
    const before = JSON.parse(JSON.stringify(chat));
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('save failed'));

    const result = await replaceManualRefillSheetBaselineInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0],
      targetSheetKeys: ['sheet_1'],
      baselineData: { sheet_1: { name: '新纪要表', content: [['row_id'], ['new']] } },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('save failed');
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(chat))).toEqual(before);
  });

  it('严格宿主保存不可用时回滚聊天字段且不删除外置向量索引文件', async () => {
    const manifest = { indexId: 'idx-host-unavailable', files: [{ path: 'vector-host.json', role: 'base_shard' }] };
    const chat = [
      makeFullFrameMessage({
        sheet_0: { name: '旧表0', content: [['row_id'], ['old']] },
        sheet_1: { name: '旧纪要表', content: [['row_id'], ['summary']] },
      }, {
        summaryVectorIndexManifest: manifest,
        summaryVectorIndexState: { manifest },
      }),
    ];
    mockGetChatArray.mockReturnValue(chat);
    const before = JSON.parse(JSON.stringify(chat));
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('宿主 saveChat 不可用，无法提交破坏性聊天数据变更。'));

    const result = await replaceManualRefillSheetBaselineInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0],
      targetSheetKeys: ['sheet_1'],
      baselineData: { sheet_1: { name: '新纪要表', content: [['row_id'], ['new']] } },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('宿主 saveChat 不可用');
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(chat))).toEqual(before);
  });

  it('替换目标 isolationKey 时不修改旁路 isolationKey 的 checkpoint、增量和向量 manifest', async () => {
    const otherManifest = { indexId: 'idx-other-isolation', files: [{ path: 'vector-other.json', role: 'base_shard' }] };
    const chat = [makeFullFrameMessage({
      sheet_0: { name: '旧表0', content: [['row_id'], ['old']] },
      sheet_1: { name: '保留表1', content: [['row_id'], ['keep']] },
    })];
    chat[0].TavernDB_ACU_IsolatedData.other = {
      _acu_storage_version: 2,
      independentData: { sheet_0: { name: '旁路表0' } },
      storageFrame: {
        version: 2,
        checkpoint: { kind: 'full', reason: 'init', createdAt: 9, data: { sheet_0: { name: '旁路 checkpoint' } } },
        perSheetCheckpoints: { sheet_0: { kind: 'sheet_full', sheetKey: 'sheet_0', data: { name: '旁路 shard' } } },
        logEntries: [{ seq: 2, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0' }] }],
      },
      summaryVectorIndexManifest: otherManifest,
      summaryVectorIndexState: { manifest: otherManifest },
    };
    const otherBefore = JSON.parse(JSON.stringify(chat[0].TavernDB_ACU_IsolatedData.other));
    mockGetChatArray.mockReturnValue(chat);

    const result = await replaceManualRefillSheetBaselineInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0],
      targetSheetKeys: ['sheet_0'],
      baselineData: { sheet_0: { name: '新表0', content: [['row_id'], ['new']] } },
    });

    expect(result.success).toBe(true);
    expect(chat[0].TavernDB_ACU_IsolatedData.other).toEqual(otherBefore);
    expect(mockDeleteSummaryVectorIndexExternal).not.toHaveBeenCalledWith(otherManifest);
  });

  it('外置资源物理删除失败时仍返回成功并暴露清理告警', async () => {
    const manifest = { indexId: 'idx-cleanup-failed', files: [{ path: 'vector-b.json', role: 'base_shard' }] };
    const chat = [
      makeFullFrameMessage({
        sheet_0: { name: '旧表0', content: [['row_id'], ['old']] },
        sheet_1: { name: '旧纪要表', content: [['row_id'], ['summary']] },
      }, {
        summaryVectorIndexManifest: manifest,
        summaryVectorIndexState: { manifest },
      }),
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockDeleteSummaryVectorIndexExternal.mockRejectedValueOnce(new Error('external cleanup failed'));

    const result = await replaceManualRefillSheetBaselineInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0],
      targetSheetKeys: ['sheet_1'],
      baselineData: { sheet_1: { name: '新纪要表', content: [['row_id'], ['new']] } },
    });

    expect(result.success).toBe(true);
    expect(result.cleanupWarnings).toEqual([expect.stringContaining('external cleanup failed')]);
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
    expect(mockDeleteSummaryVectorIndexExternal).toHaveBeenCalledWith(manifest);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].summaryVectorIndexManifest).toBeUndefined();
    expect(chat[0].TavernDB_ACU_IsolatedData[''].summaryVectorIndexState).toBeUndefined();
  });

  it('目标范围内找不到 full checkpoint 时返回错误且不保存', async () => {
    const chat = [
      { is_user: false, TavernDB_ACU_IsolatedData: { '': { _acu_storage_version: 2, storageFrame: { version: 2, checkpoint: undefined, logEntries: [] } } } },
      { is_user: false, TavernDB_ACU_IsolatedData: { '': { _acu_storage_version: 2, storageFrame: { version: 2, checkpoint: undefined, logEntries: [] } } } },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const result = await replaceManualRefillSheetBaselineInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0, 1],
      targetSheetKeys: ['sheet_0'],
      baselineData: { sheet_0: { name: '新表0', content: [['row_id']] } },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('找不到可承载单表 checkpoint 的整库 full checkpoint');
    expect(mockSaveChatToHostStrict).not.toHaveBeenCalled();
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toBeUndefined();
  });
});

describe('commitManualRefillSheetSnapshotInRangeAtomic_ACU', () => {
  const makeFrameMessage = (frame: any) => ({
    is_user: false,
    TavernDB_ACU_IsolatedData: {
      '': { _acu_storage_version: 2, storageFrame: frame },
    },
  });

  it('在既有 full checkpoint 楼层写入完整快照，清理目标表旧数据并保留非目标表', async () => {
    const chat = [
      makeFrameMessage({
        version: 2,
        checkpoint: {
          kind: 'full',
          reason: 'compaction',
          createdAt: 20,
          data: {
            mate: { type: 'acu' },
            sheet_0: { name: '纪要表', content: [['row_id', '事件'], ['20', '旧事件']] },
            sheet_1: { name: '大纲表', content: [['row_id', '大纲'], ['20', '保留']] },
          },
        },
        logEntries: [],
      }),
      { is_user: true },
      makeFrameMessage({
        version: 2,
        logEntries: [{
          seq: 1,
          operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '30', cells: ['30', '旧增量'] }],
          filledSheetKeys: ['sheet_0'],
          changedSheetKeys: ['sheet_0'],
          groupKeys: [],
        }],
      }),
    ];
    mockGetChatArray.mockReturnValue(chat);

    const result = await commitManualRefillSheetSnapshotInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0, 1, 2],
      targetSheetKeys: ['sheet_0'],
      snapshotData: {
        sheet_0: {
          name: '纪要表',
          content: [['row_id', '事件'], ['1', '重填事件'], ['30', '重填末层事件']],
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({ success: true, targetMessageIndex: 0, checkpointCount: 1 }));
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0).toBeUndefined();
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_1.content[1]).toEqual(['20', '保留']);
    for (const entry of chat[2].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries) {
      expect(entry.operations).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ sheetKey: 'sheet_0' }),
      ]));
      expect(entry.filledSheetKeys).not.toContain('sheet_0');
      expect(entry.changedSheetKeys).not.toContain('sheet_0');
    }
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_0).toEqual(expect.objectContaining({
      kind: 'sheet_full',
      data: {
        name: '纪要表',
        content: [['row_id', '事件'], ['1', '重填事件'], ['30', '重填末层事件']],
      },
    }));
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
  });

  it('30层范围内将完整单表快照锚定到第20层既有 full checkpoint，而非末层', async () => {
    const chat = Array.from({ length: 30 }, () => ({ is_user: false } as any));
    chat[20] = makeFrameMessage({
      version: 2,
      checkpoint: {
        kind: 'full',
        reason: 'compaction',
        createdAt: 20,
        data: {
          mate: { type: 'acu' },
          sheet_0: { name: '纪要表', content: [['row_id', '事件'], ['20', '旧边界事件']] },
          sheet_1: { name: '大纲表', content: [['row_id', '大纲'], ['20', '保留']] },
        },
      },
      logEntries: [],
    });
    chat[29] = makeFrameMessage({
      version: 2,
      logEntries: [{
        seq: 1,
        operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '30', cells: ['30', '旧末层事件'] }],
        filledSheetKeys: ['sheet_0'],
        changedSheetKeys: ['sheet_0'],
        groupKeys: [],
      }],
    });
    const refilledSheet = {
      name: '纪要表',
      content: [
        ['row_id', '事件'],
        ...Array.from({ length: 30 }, (_, index) => [`${index + 1}`, `重填第${index + 1}层事件`]),
      ],
    };
    mockGetChatArray.mockReturnValue(chat);

    const result = await commitManualRefillSheetSnapshotInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: Array.from({ length: 30 }, (_, index) => index),
      targetSheetKeys: ['sheet_0'],
      snapshotData: { sheet_0: refilledSheet },
    });

    expect(result).toEqual(expect.objectContaining({ success: true, targetMessageIndex: 20, checkpointCount: 1 }));
    expect(chat[20].TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_0).toEqual(expect.objectContaining({
      kind: 'sheet_full',
      data: refilledSheet,
      scheduleSummary: { lastFilledAiFloor: 30 },
    }));
    expect(chat[20].TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_1).toBeUndefined();
    expect(chat[20].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_1.content[1]).toEqual(['20', '保留']);
    expect(chat[20].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.mate).toEqual({ type: 'acu' });
    expect(chat[29].TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints?.sheet_0).toBeUndefined();

    const reloadedHistory = resolveTableHistoryStateFromChat_ACU(chat, {
      sheetKey: 'sheet_0',
      isSummaryTable: true,
      isolationKey: '',
      settings: mockSettings,
    });
    const untouchedSheetHistory = resolveTableHistoryStateFromChat_ACU(chat, {
      sheetKey: 'sheet_1',
      isSummaryTable: false,
      isolationKey: '',
      settings: mockSettings,
    });
    expect(reloadedHistory).toEqual(expect.objectContaining({ hasAnyData: true, hasTrackedUpdate: true, lastTrackedUpdateAiFloor: 30 }));
    expect(untouchedSheetHistory.hasTrackedUpdate).toBe(false);
  });

  it('严格保存失败时还原本轮范围，避免留下清理后但未提交的快照状态', async () => {
    const chat = [
      makeFrameMessage({
        version: 2,
        checkpoint:{
          kind: 'full',
          reason: 'compaction',
          createdAt: 20,
          data: { sheet_0: { name: '纪要表', content: [['row_id'], ['20']] } },
        },
        logEntries: [],
      }),
      makeFrameMessage({
        version: 2,
        logEntries: [{ seq: 1, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '30', cells: ['30'] }], filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [] }],
      }),
    ];
    mockGetChatArray.mockReturnValue(chat);
    const before = JSON.parse(JSON.stringify(chat));
    mockSaveChatToHostStrict.mockRejectedValueOnce(new Error('save failed'));

    const result = await commitManualRefillSheetSnapshotInRangeAtomic_ACU({
      isolationKey: '',
      targetMessageIndices: [0, 1],
      targetSheetKeys: ['sheet_0'],
      snapshotData: { sheet_0: { name: '纪要表', content: [['row_id'], ['1'], ['30']] } },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('save failed');
    expect(JSON.parse(JSON.stringify(chat))).toEqual(before);
  });

  it('会话快照深拷贝消息字段，并在回滚时严格保存恢复结果', async () => {
    const chat = [
      makeFrameMessage({
        version: 2,
        checkpoint: { kind: 'full', reason: 'compaction', createdAt: 20, data: { sheet_0: { name: '纪要表', content: [['row_id'], ['20']] } } },
        logEntries: [],
      }),
      { is_user: true },
    ];
    mockGetChatArray.mockReturnValue(chat);
    const before = JSON.parse(JSON.stringify(chat));

    const snapshot = captureManualRefillSessionSnapshot_ACU([0, 1]);
    chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0.content.push(['30']);
    chat[0].TavernDB_ACU_Identity = { mutated: true };

    await restoreManualRefillSessionSnapshotAtomic_ACU(snapshot, '', ['sheet_0']);

    expect(JSON.parse(JSON.stringify(chat))).toEqual(before);
    expect(mockSaveChatToHostStrict).toHaveBeenCalledTimes(1);
  });
});

// ═══ ensureManualRefillInitialBaseline_ACU ═══
describe('ensureManualRefillInitialBaseline_ACU', () => {
  const makeV2FullMessage = (reason: string | undefined, data: any, logEntries: any[] = [], createdAt = 1) => ({
    is_user: false,
    TavernDB_ACU_IsolatedData: {
      '': {
        _acu_storage_version: 2,
        storageFrame: {
          version: 2,
          logEntries,
          checkpoint: {
            kind: 'full',
            reason,
            createdAt,
            data,
          },
        },
      },
    },
  });

  it('已有更晚 init checkpoint 时，将手动重填 initial baseline 前移到目标楼层并降级旧 checkpoint', async () => {
    const baselineData = {
      sheet_0: { name: '物品表', content: [['row_id', '物品名']] },
    };
    const laterData = {
      sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] },
    };
    const chat = [
      { is_user: false, TavernDB_ACU_IsolatedData: {} },
      { is_user: true },
      makeV2FullMessage('init', laterData, [], 11),
    ];
    mockGetChatArray.mockReturnValue(chat);
    mockCollectScheduleSummaryFromFramesV2.mockReturnValue({ schedules: ['s1'] });

    const result = await ensureManualRefillInitialBaseline_ACU({
      isolationKey: '',
      targetMessageIndex: 0,
      data: baselineData,
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.targetMessageIndex).toBe(0);
    expect(result.movedFromMessageIndex).toBe(2);
    expect(result.downgradedCount).toBe(1);
    const targetFrame = chat[0].TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(targetFrame.checkpoint.reason).toBe('init');
    expect(targetFrame.checkpoint.data).toEqual(baselineData);
    expect(targetFrame.checkpoint.scheduleSummary).toEqual({ schedules: ['s1'] });
    const oldFrame = chat[2].TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(oldFrame.checkpoint).toBeUndefined();
    expect(oldFrame.logEntries[0].operations[0]).toEqual({ kind: 'data_replace', data: laterData, reason:'checkpoint_fallback' });
    const fullCheckpointCount = chat.filter((msg: any) => (
      msg?.TavernDB_ACU_IsolatedData?.['']?.storageFrame?.checkpoint?.kind === 'full'
    )).length;
    expect(fullCheckpointCount).toBeGreaterThanOrEqual(1);
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('目标楼层已有 V2 logEntries 时拒绝覆盖并返回错误', async () => {
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: { version: 2, logEntries: [{ seq: 1 }], checkpoint: undefined },
          },
        },
      },
      makeV2FullMessage('init', { sheet_0: { name: '物品表', content: [['row_id', '物品名']] } }, [], 12),
    ];
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureManualRefillInitialBaseline_ACU({
      isolationKey: '',
      targetMessageIndex: 0,
      data: { sheet_0: { name: '物品表', content: [['row_id', '物品名']] } },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('已存在 V2 logEntries');
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    const oldFrame = chat[1].TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(oldFrame.checkpoint).toEqual(expect.objectContaining({ kind: 'full', reason: 'init', createdAt: 12 }));
  });

  it('存在 compaction checkpoint 时只降级 compaction 之前的 obsolete init，不前移 baseline', async () => {
    const oldInitData = { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '旧']] } };
    const compactedData = { sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['2', '压缩后']] } };
    const chat = [
      makeV2FullMessage('init', oldInitData, [], 1),
      { is_user: true },
      makeV2FullMessage('compaction', compactedData, [], 2),
      { is_user: false, TavernDB_ACU_IsolatedData: {} },
    ];
    mockGetChatArray.mockReturnValue(chat);

    const result = await ensureManualRefillInitialBaseline_ACU({
      isolationKey: '',
      targetMessageIndex: 3,
      data: { sheet_0: { name: '物品表', content: [['row_id', '物品名']] } },
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.downgradedCount).toBe(1);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toBeUndefined();
    expect(chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries[0].operations[0].data).toEqual(oldInitData);
    expect(chat[2].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.reason).toBe('compaction');
    expect(chat[3].TavernDB_ACU_IsolatedData).toEqual({});
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
  });

  it('存在非 init full checkpoint 时跳过，不破坏恢复链', async () => {
    for (const reason of ['import', 'migration', 'schema_change', 'manual', undefined]) {
      vi.clearAllMocks();
      mockRunTableWriteTransaction.mockImplementation(async (_options: any, task: any) => task());
      const chat = [
        { is_user: false, TavernDB_ACU_IsolatedData: {} },
        makeV2FullMessage(reason, { sheet_0: { name: '物品表', content: [['row_id', '物品名']] } }, [], 30),
      ];
      mockGetChatArray.mockReturnValue(chat);

      const result = await ensureManualRefillInitialBaseline_ACU({
        isolationKey: '',
        targetMessageIndex: 0,
        data: { sheet_0: { name: '物品表', content: [['row_id', '物品名']] } },
      });

      expect(result.success).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.skipped).toBe(true);
      expect(chat[0].TavernDB_ACU_IsolatedData).toEqual({});
      expect(chat[1].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.reason).toBe(reason);
      expect(chat[1].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.createdAt).toBe(30);
      expect(mockSaveChatToHost).not.toHaveBeenCalled();
    }
  });
});
