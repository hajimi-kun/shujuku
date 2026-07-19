/**
 * tests/service/table/update-orchestrator.test.ts
 * 表格更新编排器单元测试
 *
 * 策略：
 * - resolveUpdateMode_ACU / loadBatchBaseData_ACU / buildBatchMergeBase_ACU 是纯/浅依赖函数，直接测试
 * - processUpdatesBatch_ACU / executeCardUpdateCore_ACU / orchestrateManualUpdate_ACU 通过 mock 回调测试编排逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureStableRowIdsForSheetContent_ACU } from '../../../src/service/template/chat-scope';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
  parseTableTemplateJson_ACU: vi.fn(() => ({
    mate: { type: 'acu' },
    sheet_0: { name: '测试表', updateConfig: { groupId: 0 } },
  })),
}));

vi.mock('../../../src/shared/env', () => ({
  topLevelWindow_ACU: {},
}));

let mockSettings: any = {
  autoUpdateEnabled: true,
  apiMode: 'custom',
  apiConfig: { useMainApi: true, url: '', model: '' },
  tavernProfile: '',
  autoUpdateThreshold: 3,
  updateBatchSize: 2,
  skipUpdateFloors: 0,
  tableMaxRetries: 3,
  autoUpdateTokenThreshold: 0,
  toastMuteEnabled: false,
  dataIsolationEnabled: false,
  dataIsolationCode: '',
  tableApiPresetOverridesByName: {},
};

let mockCurrentJsonTableData: any = null;
let mockIsAutoUpdating = false;
let mockWasStopped = false;
let mockCoreApisReady = true;
let mockPendingFinalGenerationGreenlights: any[] = [];

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get settings_ACU() { return mockSettings; },
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData; },
  get currentChatFileIdentifier_ACU() { return 'test-chat'; },
  get isAutoUpdatingCard_ACU() { return mockIsAutoUpdating; },
  get wasStoppedByUser_ACU() { return mockWasStopped; },
  get coreApisAreReady_ACU() { return mockCoreApisReady; },
  get pendingFinalGenerationGreenlights_ACU() { return mockPendingFinalGenerationGreenlights; },
  independentTableStates_ACU: mockIndependentTableStates,
  _set_isAutoUpdatingCard_ACU: vi.fn((v: any) => { mockIsAutoUpdating = v; }),
  _set_wasStoppedByUser_ACU: vi.fn(),
  _set_manualExtraHint_ACU: vi.fn(),
  _set_currentJsonTableData_ACU: vi.fn((v: any) => { mockCurrentJsonTableData = v; }),
  abortAllActiveRequests_ACU: vi.fn(),
  getCurrentIsolationKey_ACU: vi.fn(() => ''),
}));

const mockCallCustomOpenAI = vi.fn();
const mockParseAndApplyTableEdits = vi.fn();
const mockParseAndApplyTableEditsToData = vi.fn();
const mockApplySqlEditsToTableDataSnapshot = vi.fn();
const mockPrepareAIInput = vi.fn();
const mockReloadStorageProvider = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/service/ai/prompt-builder', () => ({
  callCustomOpenAI_ACU: (...args: any[]) => mockCallCustomOpenAI(...args),
  parseAndApplyTableEdits_ACU: (...args: any[]) => mockParseAndApplyTableEdits(...args),
  parseAndApplyTableEditsToData_ACU: (...args: any[]) => {
    const impl = mockParseAndApplyTableEditsToData.getMockImplementation();
    return impl ? mockParseAndApplyTableEditsToData(...args) : mockParseAndApplyTableEdits(...args);
  },
  prepareAIInput_ACU: (...args: any[]) => mockPrepareAIInput(...args),
}));

const { mockChatArrayForSeedStage, mockIndependentTableStates, mockGetChatArray_ACU, mockCaptureManualRefillSessionSnapshot, mockClearManualRefillIncrementalDataInRange, mockClearManualRefillSheetDataInRange, mockCommitManualRefillSheetSnapshot, mockRestoreManualRefillSessionSnapshot, mockEnsureManualRefillInitialBaseline, mockEnsureBoundaryCheckpoint, mockShouldRotateBoundaryCheckpoint, mockPurgeSheetKeysFromChatHistoryHard } = vi.hoisted(() => {
  const chatArray: any[] = [];
  const independentTableStates: Record<string, any> = {};
  return {
    mockChatArrayForSeedStage: chatArray,
    mockIndependentTableStates: independentTableStates,
    mockGetChatArray_ACU: vi.fn(() => chatArray),
    mockCaptureManualRefillSessionSnapshot: vi.fn(() => ({ targetMessageIndices: [], messageFields: [] })),
    mockClearManualRefillIncrementalDataInRange: vi.fn().mockResolvedValue(0),
    mockClearManualRefillSheetDataInRange: vi.fn().mockResolvedValue(0),
    mockCommitManualRefillSheetSnapshot: vi.fn().mockResolvedValue({ success: true, changed: true, clearedCount: 1, checkpointCount: 1, targetMessageIndex: 0 }),
    mockRestoreManualRefillSessionSnapshot: vi.fn().mockResolvedValue(undefined),
    mockEnsureManualRefillInitialBaseline: vi.fn().mockResolvedValue({ success: true, changed: false, skipped: true, targetMessageIndex: 0 }),
    mockEnsureBoundaryCheckpoint: vi.fn().mockResolvedValue({ success: true, changed: false, skipped: true }),
    mockShouldRotateBoundaryCheckpoint: vi.fn(() => false),
    mockPurgeSheetKeysFromChatHistoryHard: vi.fn().mockResolvedValue({ changed: true, changedCount: 1 }),
  };
});
vi.mock('../../../src/service/chat/chat-service', () => ({
  getChatArray_ACU: mockGetChatArray_ACU,
  captureManualRefillSessionSnapshot_ACU: mockCaptureManualRefillSessionSnapshot,
  clearTableDataAtFloors_ACU: vi.fn().mockResolvedValue(0),
  clearManualRefillIncrementalDataInRange_ACU: mockClearManualRefillIncrementalDataInRange,
  clearManualRefillSheetDataInRange_ACU: mockClearManualRefillSheetDataInRange,
  commitManualRefillSheetSnapshotInRangeAtomic_ACU: mockCommitManualRefillSheetSnapshot,
  ensureManualRefillInitialBaseline_ACU: mockEnsureManualRefillInitialBaseline,
  restoreManualRefillSessionSnapshotAtomic_ACU: mockRestoreManualRefillSessionSnapshot,
  ensureV2BoundaryCheckpointForRetainedBuffer_ACU: mockEnsureBoundaryCheckpoint,
  shouldRotateV2BoundaryCheckpointForRetainedBuffer_ACU: mockShouldRotateBoundaryCheckpoint,
}));

vi.mock('../../../src/service/summary/merge-logic', () => ({
  checkAutoMergeTrigger_ACU: vi.fn(() => ({ shouldTrigger: false })),
  prepareAutoMergeBatches_ACU: vi.fn(),
  executeAutoMergeBatch_ACU: vi.fn(),
  finalizeAutoMerge_ACU: vi.fn(),
}));

vi.mock('../../../src/service/worldbook/injection-engine-state', () => ({
  purgeSheetKeysFromChatHistoryHard_ACU: (...args: any[]) => mockPurgeSheetKeysFromChatHistoryHard(...args),
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getChatSheetGuideDataForIsolationKey_ACU: vi.fn(() => null),
  getEffectiveSeedRowsForSheet_ACU: vi.fn(() => []),
  shouldUseInitialSeedRows_ACU: vi.fn(() => {
    const chat = mockGetChatArray_ACU();
    return Array.isArray(chat) && chat.filter((m: any) => m && m.is_user).length === 1 && !chat.some((m: any) => m && !m.is_user && m.mes !== '开场白');
  }),
  ensureStableRowIdsForSheetContent_ACU: vi.fn((content: any) => {
    if (!Array.isArray(content) || content.length === 0) return [];
    const header = Array.isArray(content[0]) ? [...content[0]] : ['row_id'];
    const rows = content.slice(1).map((row: any) => Array.isArray(row) ? [...row] : []);
    const seen = new Set<string>();
    let nextId = 1;
    return [header, ...rows.map((row: any) => {
      let value = row[0] == null || String(row[0]).trim() === '' || seen.has(String(row[0]).trim()) ? '' : String(row[0]).trim();
      if (!value) {
        while (seen.has(String(nextId))) nextId += 1;
        value = String(nextId++);
      }
      seen.add(value);
      row[0] = value;
      return row;
    })];
  }),
  getSortedSheetKeys_ACU: vi.fn((data: any) => data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')) : []),
  buildGuidedBaseDataFromSheetGuide_ACU: vi.fn(),
}));

const mockUpdateReadableLorebookEntry = vi.fn();
vi.mock('../../../src/service/worldbook/pipeline', () => ({
  loadAllChatMessages_ACU: vi.fn(),
  updateReadableLorebookEntry_ACU: (...args: any[]) => mockUpdateReadableLorebookEntry(...args),
}));

const mockCheckIfFirstTimeInit = vi.fn().mockResolvedValue(false);
const mockSaveIndependentTable = vi.fn().mockResolvedValue({ saved: true });
const mockPersistTablesToChatMessage = vi.fn().mockResolvedValue({ saved: true, messageIndex: 0 });

vi.mock('../../../src/service/table/table-service', () => ({
  loadOrCreateJsonTableFromChatHistory_ACU: vi.fn(async () => {
    const data = mockCurrentJsonTableData
      ? JSON.parse(JSON.stringify(mockCurrentJsonTableData))
      : null;
    return {
      loaded: Boolean(data),
      source: data ? 'merged' : 'empty',
      data,
    };
  }),
  checkIfFirstTimeInit_ACU: (...args: any[]) => mockCheckIfFirstTimeInit(...args),
  ensureLegacyStorageMigratedBeforeWrite_ACU: vi.fn().mockResolvedValue({ success: true, migrated: false }),
  persistTablesToChatMessage_ACU: (...args: any[]) => mockPersistTablesToChatMessage(...args),
  saveIndependentTableToChatHistory_ACU: (...args: any[]) => mockSaveIndependentTable(...args),
}));

vi.mock('../../../src/service/table/storage-mode', () => {
  const isSqliteMode = vi.fn(() => false);
  return {
    isSqliteMode,
    getCurrentStorageMode: vi.fn(() => isSqliteMode() ? 'sqlite' : 'native'),
  };
});

vi.mock('../../../src/service/table/table-storage-strategy', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    reloadStorageProvider: (...args: any[]) => mockReloadStorageProvider(...args),
  };
});

vi.mock('../../../src/service/table/sql-table-service', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    applySqlEditsToTableDataSnapshot_ACU: (...args: any[]) => {
      const impl = mockApplySqlEditsToTableDataSnapshot.getMockImplementation();
      return impl ? mockApplySqlEditsToTableDataSnapshot(...args) : actual.applySqlEditsToTableDataSnapshot_ACU(...args);
    },
  };
});

const mockRunTableUpdateApplyWithScopeLock = vi.fn(async (_scopeKey: string, fn: any) => await fn());
const mockBuildTableUpdateApplyScopeKey = vi.fn(() => 'test-scope');
vi.mock('../../../src/service/table/table-update-queue', () => ({
  runTableUpdateApplyWithScopeLock_ACU: (...args: any[]) => mockRunTableUpdateApplyWithScopeLock(...args),
  buildTableUpdateApplyScopeKey_ACU: (...args: any[]) => mockBuildTableUpdateApplyScopeKey(...args),
}));

const mockRunTableWriteTransaction = vi.fn(async (options: any, task: any) => task({
  transactionId: 'tx-test',
  chatKey: 'test-chat',
  isolationKey: '',
  source: options.source,
  baseRevision: null,
  writeSet: options.writeSet,
  runCommit: async (commitTask: any) => commitTask(),
}, options.initialData ? JSON.parse(JSON.stringify(options.initialData)) : mockCurrentJsonTableData));
vi.mock('../../../src/service/table/table-write-transaction', () => ({
  captureTableRuntimeRevisionForWriteSet_ACU: vi.fn(() => 'runtime-test-revision'),
  invalidateTableRuntimeRevision_ACU: vi.fn(() => 'runtime-test-invalidated'),
  runTableWriteTransaction_ACU: (...args: any[]) => mockRunTableWriteTransaction(...args),
}));

const mockEnqueueSummaryVectorIndexFlush = vi.fn().mockResolvedValue({ queued: true, scopeKey: 'test-scope' });
vi.mock('../../../src/service/vector/summary-vector-index-flush-queue', () => ({ enqueueSummaryVectorIndexFlush_ACU: (...args: any[]) => mockEnqueueSummaryVectorIndexFlush(...args) }));

vi.mock('../../../src/service/settings/settings-readers', () => ({
  getCurrentWorldbookConfig_ACU: vi.fn(() => ({ summaryVectorIndexModeEnabled: true })),
}));

vi.mock('../../../src/service/settings/settings-service', () => ({
  applyTemplateScopeForCurrentChat_ACU: vi.fn(),
}));

import {
  resolveUpdateMode_ACU,
  loadBatchBaseData_ACU,
  buildBatchMergeBase_ACU,
  processUpdatesBatch_ACU,
  executeCardUpdateCore_ACU,
  orchestrateManualUpdate_ACU,
  orchestrateManualCatchUp_ACU,
  collectGroupFillResponse_ACU,
  applyUnifiedGroupFillResponses_ACU,
  processGroupedRuntimeChunk_ACU,
  type CardUpdateResult,
  type CardUpdateProgressEvent,
} from '../../../src/service/table/update-orchestrator';

beforeEach(() => {
  mockChatArrayForSeedStage.length = 0;
  Object.keys(mockIndependentTableStates).forEach(key => delete mockIndependentTableStates[key]);
  mockGetChatArray_ACU.mockImplementation(() => mockChatArrayForSeedStage);
  mockClearManualRefillIncrementalDataInRange.mockResolvedValue(0);
  mockCommitManualRefillSheetSnapshot.mockResolvedValue({ success: true, changed: true, clearedCount: 1, checkpointCount: 1, targetMessageIndex: 0 });
  mockEnsureManualRefillInitialBaseline.mockResolvedValue({ success: true, changed: false, skipped: true, targetMessageIndex: 0 });
  mockEnsureBoundaryCheckpoint.mockResolvedValue({ success: true, changed: false, skipped: true });
  mockPurgeSheetKeysFromChatHistoryHard.mockResolvedValue({ changed: true, changedCount: 1 });
  mockReloadStorageProvider.mockResolvedValue(undefined);
});

// ═══════════════════════════════════════════════════════════════
// resolveUpdateMode_ACU
// ═══════════════════════════════════════════════════════════════
describe('resolveUpdateMode_ACU', () => {
  it('auto_unified 直接返回', () => {
    expect(resolveUpdateMode_ACU('auto_unified')).toBe('auto_unified');
  });

  it('manual_unified 直接返回', () => {
    expect(resolveUpdateMode_ACU('manual_unified')).toBe('manual_unified');
  });

  it('full 直接返回', () => {
    expect(resolveUpdateMode_ACU('full')).toBe('full');
  });

  it('auto_summary_silent 直接返回', () => {
    expect(resolveUpdateMode_ACU('auto_summary_silent')).toBe('auto_summary_silent');
  });

  it('manual_summary 返回 manual_summary', () => {
    expect(resolveUpdateMode_ACU('manual_summary')).toBe('manual_summary');
  });

  it('manual_independent 返回 manual_independent', () => {
    expect(resolveUpdateMode_ACU('manual_independent')).toBe('manual_independent');
  });

  it('manual 前缀默认返回 manual_standard', () => {
    expect(resolveUpdateMode_ACU('manual')).toBe('manual_standard');
    expect(resolveUpdateMode_ACU('manual_other')).toBe('manual_standard');
  });

  it('auto 模式带 summary 返回 auto_summary', () => {
    expect(resolveUpdateMode_ACU('auto_summary')).toBe('auto_summary');
    expect(resolveUpdateMode_ACU('summary')).toBe('auto_summary');
  });

  it('auto 模式默认返回 auto_standard', () => {
    expect(resolveUpdateMode_ACU('auto')).toBe('auto_standard');
    expect(resolveUpdateMode_ACU('auto_standard')).toBe('auto_standard');
  });

  it('空字符串返回 auto_standard', () => {
    expect(resolveUpdateMode_ACU('')).toBe('auto_standard');
  });

  it('未知模式返回 auto_standard', () => {
    expect(resolveUpdateMode_ACU('unknown')).toBe('auto_standard');
  });
});

// ═══════════════════════════════════════════════════════════════
// loadBatchBaseData_ACU
// ═══════════════════════════════════════════════════════════════
describe('loadBatchBaseData_ACU', () => {
  it('从新版存储格式加载数据', () => {
    const chatHistory = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: {
              sheet_0: { name: '测试表', content: [['row_id'], ['1']] },
            },
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: [],
          },
        },
      },
      { is_user: true },
      { is_user: false }, // 当前批次的第一条消息
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表', content: [['row_id']] },
    };

    const result = loadBatchBaseData_ACU(chatHistory, 3, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(mergedBatchData.sheet_0.content).toEqual([['row_id'], ['1']]);
  });

  it('从旧版存储格式加载数据', () => {
    const chatHistory = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: { name: '测试表', content: [['row_id'], ['1']] },
        },
      },
      { is_user: true },
      { is_user: false },
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表', content: [['row_id']] },
    };

    const result = loadBatchBaseData_ACU(chatHistory, 3, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(1);
  });

  it('空聊天记录返回全部未找到', () => {
    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表' },
    };
    const result = loadBatchBaseData_ACU([], 0, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(0);
    expect(result.totalCount).toBe(1);
  });

  it('跳过 user 消息', () => {
    const chatHistory = [
      { is_user: true, TavernDB_ACU_IndependentData: { sheet_0: { name: '不应该被读取' } } },
      { is_user: false },
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表' },
    };

    const result = loadBatchBaseData_ACU(chatHistory, 1, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(0);
  });

  it('找到所有表后提前退出（从后往前搜索，取最近的）', () => {
    const chatHistory = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: { sheet_0: { name: '更旧的表0' } },
            modifiedKeys: [],
            updateGroupKeys: [],
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: { sheet_0: { name: '较新的表0' } },
            modifiedKeys: [],
            updateGroupKeys: [],
          },
        },
      },
      { is_user: false }, // 当前批次的第一条消息
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表' },
    };

    loadBatchBaseData_ACU(chatHistory, 2, '', ['sheet_0'], mergedBatchData);
    expect(mergedBatchData.sheet_0.name).toBe('较新的表0');
  });

  it('隔离标签匹配', () => {
    const chatHistory = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          'tag_A': {
            independentData: { sheet_0: { name: '标签A的数据' } },
            modifiedKeys: [],
            updateGroupKeys: [],
          },
          'tag_B': {
            independentData: { sheet_0: { name: '标签B的数据' } },
            modifiedKeys: [],
            updateGroupKeys: [],
          },
        },
      },
      { is_user: false },
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表' },
    };

    loadBatchBaseData_ACU(chatHistory, 1, 'tag_A', ['sheet_0'], mergedBatchData);
    expect(mergedBatchData.sheet_0.name).toBe('标签A的数据');
  });

  it('叠加历史 delta 后会稳定化 mergedBatchData 的 row_id', () => {
    const chatHistory = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: {
              sheet_0: { name: 'checkpoint表', content: [['row_id', '名称'], ['base', '旧苹果']] },
            },
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: [],
            _acu_storage_mode: 'checkpoint',
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: {},
            incrementalData: {
              sheet_0: { sheetUid: 'sheet_0', rowDeltas: [{ row_id: '', op: 'upsert', cells: ['', '坏行'] }] },
            },
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: [],
            _acu_storage_mode: 'delta',
          },
        },
      },
      { is_user: false },
    ];
    const mergedBatchData: Record<string, any> = { sheet_0: { name: '空表', content: [['row_id', '名称']] } };
    loadBatchBaseData_ACU(chatHistory, 2, '', ['sheet_0'], mergedBatchData);
    expect(vi.mocked(ensureStableRowIdsForSheetContent_ACU)).toHaveBeenCalled();
    expect(mergedBatchData.sheet_0.content).toEqual([['row_id', '名称'], ['base', '旧苹果'], ['1', '坏行']]);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildBatchMergeBase_ACU
// ═══════════════════════════════════════════════════════════════
describe('buildBatchMergeBase_ACU', () => {
  it('无 guide 时使用模板', async () => {
    const result = await buildBatchMergeBase_ACU(1);
    expect(result.data).not.toBeNull();
    expect(result.error).toBeNull();
  });

  it('有 guide 时使用 guide', async () => {
    const { getChatSheetGuideDataForIsolationKey_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue({
      sheet_0: { name: '引导数据' },
    });
    const { buildGuidedBaseDataFromSheetGuide_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue({
      sheet_0: { name: '从引导构建的数据' },
    });

    const result = await buildBatchMergeBase_ACU(1);
    expect(result.data).not.toBeNull();
    expect(result.error).toBeNull();
  });

  it('SQLite 有界基底缺少可回放 V2 数据时不退回最新 runtime snapshot', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, buildGuidedBaseDataFromSheetGuide_ACU } = await import('../../../src/service/template/chat-scope');
    try {
      vi.mocked(isSqliteMode).mockReturnValue(true);
      vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
      vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue(undefined as any);
      vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: false, mes: 'AI without v2 frame' }]);
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu' },
        sheet_0: { name: '测试表', content: [['row_id', '值']] },
      } as any);
      mockCurrentJsonTableData = {
        mate: { type: 'acu' },
        sheet_0: { name: '测试表', content: [['row_id', '值'], ['27', '未来旧行']] },
      };

      const result = await buildBatchMergeBase_ACU(1, { maxMessageIndex: 0 });

      expect(result.error).toBeNull();
      expect(result.data?.sheet_0.content).toEqual([['row_id', '值']]);
      expect(result.data?.sheet_0.content.some((row: any[]) => row[0] === '27')).toBe(false);
    } finally {
      vi.mocked(isSqliteMode).mockReturnValue(false);
      vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
      vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue(undefined as any);
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu' },
        sheet_0: { name: '测试表', updateConfig: { groupId: 0 } },
      } as any);
      mockCurrentJsonTableData = null;
    }
  });

  it('非 SQLite 有界基底且未进入 V2 replay 时保留 runtime snapshot fallback', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, buildGuidedBaseDataFromSheetGuide_ACU } = await import('../../../src/service/template/chat-scope');
    try {
      vi.mocked(isSqliteMode).mockReturnValue(false);
      vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
      vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue(undefined as any);
      vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: false, mes: 'AI without v2 frame' }]);
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu' },
        sheet_0: { name: '模板表', content: [['row_id', '值']] },
      } as any);
      mockCurrentJsonTableData = {
        mate: { type: 'acu' },
        sheet_0: { name: '运行时表', content: [['row_id', '值'], ['1', 'runtime-base']] },
      };

      const result = await buildBatchMergeBase_ACU(1, { maxMessageIndex: 0 });

      expect(result.error).toBeNull();
      expect(result.data?.sheet_0.content).toEqual([['row_id', '值'], ['1', 'runtime-base']]);
    } finally {
      vi.mocked(isSqliteMode).mockReturnValue(false);
      vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
      vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue(undefined as any);
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu' },
        sheet_0: { name: '测试表', updateConfig: { groupId: 0 } },
      } as any);
      mockCurrentJsonTableData = null;
    }
  });

  it('非 SQLite 有界基底已进入 V2 replay 但无可用数据时不退回未来 runtime snapshot', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, buildGuidedBaseDataFromSheetGuide_ACU } = await import('../../../src/service/template/chat-scope');
    try {
      vi.mocked(isSqliteMode).mockReturnValue(false);
      vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
      vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue(undefined as any);
      vi.mocked(getChatArray_ACU).mockReturnValue([{
        is_user: false,
        mes: 'AI v2 log without checkpoint',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [{ seq: 1, operations: [] }],
            },
          },
        },
      }]);
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu' },
        sheet_0: { name: '模板表', content: [['row_id', '值']] },
      } as any);
      mockCurrentJsonTableData = {
        mate: { type: 'acu' },
        sheet_0: { name: '运行时表', content: [['row_id', '值'], ['27', '未来旧行']] },
      };

      const result = await buildBatchMergeBase_ACU(1, { maxMessageIndex: 0 });

      expect(result.error).toBeNull();
      expect(result.data?.sheet_0.content).toEqual([['row_id', '值']]);
      expect(result.data?.sheet_0.content.some((row: any[]) => row[0] === '27')).toBe(false);
    } finally {
      vi.mocked(isSqliteMode).mockReturnValue(false);
      vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
      vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue(undefined as any);
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu' },
        sheet_0: { name: '测试表', updateConfig: { groupId: 0 } },
      } as any);
      mockCurrentJsonTableData = null;
    }
  });


});

// ═══════════════════════════════════════════════════════════════
// processUpdatesBatch_ACU（适配新返回值类型）
// ═══════════════════════════════════════════════════════════════
describe('processUpdatesBatch_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAutoUpdating = false;
    mockSettings = {
      ...mockSettings,
      autoUpdateThreshold: 3,
      updateBatchSize: 2,
      autoUpdateTokenThreshold: 0,
      toastMuteEnabled: false,
    };
  });

  it('空索引列表返回 success: true', async () => {
    const result = await processUpdatesBatch_ACU([], 'auto_standard', {}, vi.fn());
    expect(result.success).toBe(true);
  });

  it('执行更新回调成功时返回 success: true', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: ['sheet_0'] } as CardUpdateResult);
    mockCurrentJsonTableData = { sheet_0: { name: '测试' } };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '这是AI回复' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalled();
  });

  it('更新失败时返回 success: false 和 error', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ success: false, modifiedKeys: [], error: '更新失败' } as CardUpdateResult);
    mockCurrentJsonTableData = { sheet_0: { name: '测试' } };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '这是AI回复' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(false);
    expect(result.failedBatch).toBe(1);
  });

  it('AI 回复过短时跳过（auto 模式）', async () => {
    mockSettings.autoUpdateTokenThreshold = 1000;
    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: [] } as CardUpdateResult);
    mockCurrentJsonTableData = { sheet_0: { name: '测试' } };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '短' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('构建合并基底失败时返回 error', async () => {
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU } = await import('../../../src/service/template/chat-scope');
    // 确保走 template 分支（guide 返回 null），然后 template 解析抛异常
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(parseTableTemplateJson_ACU).mockImplementationOnce(() => { throw new Error('模板解析失败'); });

    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: [] });
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '这是AI回复' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('执行更新时传入基于批次历史数据的 batchBaseSnapshot 深拷贝', async () => {
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValueOnce({
      sheet_0: { name: '背包物品表', content: [['row_id', '物品名']] },
      sheet_1: { name: '纪要表', content: [['row_id', '事件']] },
    });
    mockCurrentJsonTableData = {
      sheet_0: { name: '背包物品表', content: [['row_id', '物品名']] },
      sheet_1: { name: '纪要表', content: [['row_id', '事件']] },
    };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户0' },
      {
        is_user: false,
        mes: 'AI0',
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: {
              sheet_0: { name: '背包物品表', content: [['row_id', '物品名'], ['1', '铁剑']] },
              sheet_1: { name: '纪要表', content: [['row_id', '事件'], ['1', '旧事件']] },
            },
          },
        },
      },
      { is_user: true, mes: '用户1' },
      { is_user: false, mes: '这是AI回复' },
    ]);
    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: ['sheet_1'] } as CardUpdateResult);

    const result = await processUpdatesBatch_ACU([3], 'auto_standard', { targetSheetKeys: ['sheet_1'], requestOptions: { tableApiPreset: 'preset' } }, mockExecute);

    expect(result.success).toBe(true);
    const progressContext = mockExecute.mock.calls[0][6];
    expect(progressContext.batchBaseSnapshot.sheet_0.content[1][1]).toBe('铁剑');
    expect(progressContext.batchBaseSnapshot.sheet_1.content[1][1]).toBe('旧事件');
    expect(progressContext.batchBaseSnapshot).not.toBe(mockCurrentJsonTableData);
  });
});

// ═══════════════════════════════════════════════════════════════
// executeCardUpdateCore_ACU
// ═══════════════════════════════════════════════════════════════
describe('executeCardUpdateCore_ACU', () => {
  beforeEach(async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { disposeStorageProvider } = await import('../../../src/service/table/table-storage-strategy');
    vi.mocked(isSqliteMode).mockReturnValue(false);
    disposeStorageProvider();
    vi.clearAllMocks();
    mockParseAndApplyTableEdits.mockReset();
    mockParseAndApplyTableEditsToData.mockReset();
    mockApplySqlEditsToTableDataSnapshot.mockReset();
    mockWasStopped = false;
    mockSettings = {
      ...mockSettings,
      tableMaxRetries: 3,
      autoUpdateTokenThreshold: 0,
      importPromptExcludeImportedWorldbookEntries: true,
    };
    mockCurrentJsonTableData = { sheet_0: { name: '测试表', content: [['row_id'], ['1']] } };
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 0 });
    mockEnsureBoundaryCheckpoint.mockResolvedValue({ success: true, changed: false, skipped: true });
    mockShouldRotateBoundaryCheckpoint.mockReturnValue(false);
  });

  it('正常流程：AI 返回有效响应，解析成功，保存成功', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    const abortController = new AbortController();
    const progressEvents: CardUpdateProgressEvent[] = [];

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, abortController,
      (event) => progressEvents.push(event)
    );

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0']);
    expect(result.aborted).toBeUndefined();
    // 验证进度事件序列
    const phases = progressEvents.map(e => e.phase);
    expect(phases).toContain('preparing');
    expect(phases).toContain('calling_ai');
    expect(phases).toContain('parsing');
    expect(phases).toContain('saving');
    expect(phases).toContain('complete');
  });

  it('将目标表转换为 sheet 级 writeSet，并把 transactionContext 传给持久化', async () => {
    const txCtx = {
      transactionId: 'tx-ai-sheet-1',
      chatKey: 'test-chat',
      isolationKey: '',
      source: 'group_fill',
      baseRevision: 'rev-base',
      writeSet: [{ kind: 'sheet' as const, sheetKey: 'sheet_1' }],
      runCommit: async (commitTask: any) => commitTask(),
    };
    mockCurrentJsonTableData = {
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', '旧A']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', '旧B']] },
    };
    mockRunTableWriteTransaction.mockImplementationOnce(async (options: any, task: any) => {
      expect(options.writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_1' }]);
      return task(txCtx, JSON.parse(JSON.stringify(options.initialData)));
    });
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEditsToData.mockImplementation((_aiResponse: string, tableData: any) => {
      tableData.sheet_1.content.push(['2', '新B']);
      return { success: true, modifiedKeys: ['sheet_1'] };
    });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_1'], null, new AbortController()
    );

    expect(result.success).toBe(true);
    expect(mockRunTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'group_fill',
      writeSet: [{ kind: 'sheet', sheetKey: 'sheet_1' }],
    }), expect.any(Function));
    const persistOptions = mockPersistTablesToChatMessage.mock.calls[0][0];
    expect(persistOptions.transactionContext).toBe(txCtx);
    expect(persistOptions.tableData.sheet_1.content).toContainEqual(['2', '新B']);
    expect(persistOptions.operations).toEqual([
      { kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: expect.objectContaining({
        content: [['row_id', '值'], ['1', '旧B'], ['2', '新B']],
      }), reason: 'system' },
    ]);
    expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id', '值'], ['1', '旧A']]);
  });

  it('AI 返回后在同 scope 锁内恢复 batchBaseSnapshot，避免保存被其他组污染', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockImplementation(async () => {
      mockCurrentJsonTableData = {
        mate: { type: 'acu', version: 1 },
          sheet_0: { name: '背包物品表', content: [['row_id', '物品名'], ['1', '被污染的铁剑']] },
        sheet_1: { name: '纪要表', content: [['row_id', '事件'], ['1', '被其他组污染']] },
      };
      return '<tableEdit>有效内容</tableEdit>';
    });
    mockParseAndApplyTableEditsToData.mockImplementation((_aiResponse: string, tableData: any) => {
      expect(tableData.sheet_0.content[1][1]).toBe('铁剑');
      expect(tableData.sheet_1.content[1][1]).toBe('旧事件');
      tableData.sheet_1 = { name: '纪要表', content: [['row_id', '事件'], ['1', '本组新事件']] };
      return { success: true, modifiedKeys: ['sheet_1'] };
    });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);

    let savedSnapshot: any = null;
    mockPersistTablesToChatMessage.mockImplementation(async (options: any) => {
      savedSnapshot = JSON.parse(JSON.stringify(options.tableData));
      return { saved: true, messageIndex: 0 };
    });

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_1'], null, new AbortController(),
      {
        batchBaseSnapshot: {
          mate: { type: 'acu', version: 1 },
          sheet_0: { name: '背包物品表', content: [['row_id', '物品名'], ['1', '铁剑']] },
          sheet_1: { name: '纪要表', content: [['row_id', '事件'], ['1', '旧事件']] },
        },
      }
    );

    expect(result.success).toBe(true);
    expect(savedSnapshot.sheet_0.content[1][1]).toBe('铁剑');
    expect(savedSnapshot.sheet_1.content[1][1]).toBe('本组新事件');
  });


  it('prepareAIInput 返回 null 时返回错误', async () => {
    mockPrepareAIInput.mockResolvedValue(null);

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('无法准备AI输入');
  });

  it('AI 响应无 tableEdit 标签时重试并最终失败', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('无效的AI响应，没有标签');
    mockSettings.tableMaxRetries = 1; // 只重试1次，加快测试

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('1 次尝试后仍失败');
  });

  it('AI 回复过短时重试并最终失败', async () => {
    mockSettings.autoUpdateTokenThreshold = 100;
    mockSettings.tableMaxRetries = 1;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('短');

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('AI回复过短');
  });

  it('用户中止时返回 aborted', async () => {
    mockWasStopped = true;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it('AbortError 时返回 aborted', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it('保存失败时返回错误', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: false, error: 'save failed' });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('save failed');
  });

  it('无实质数据改动但 targetSheetKeys 非空时记录填表尝试但不推进 changed tracking', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>   </tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: [] });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: [],
      updateGroupKeys: ['sheet_0'],
      trackingSheetKeys: [],
      source: 'group_fill',
    }));
  });

  it('目标表参与本轮但仅部分表有实质修改时，只按实质修改表推进 tracking', async () => {
    mockCurrentJsonTableData = {
      sheet_0: { name: '表A', content: [['row_id'], ['1']] },
      sheet_1: { name: '表B', content: [['row_id'], ['1']] },
    };
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>部分更新</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0', 'sheet_1'], null, new AbortController()
    );

    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_0'],
      updateGroupKeys: ['sheet_0', 'sheet_1'],
      trackingSheetKeys: ['sheet_0'],
      source: 'group_fill',
    }));
  });

  it('import 模式不保存到聊天记录', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });

    const progressEvents: CardUpdateProgressEvent[] = [];

    const result = await executeCardUpdateCore_ACU(
      [], 0, true, 'auto_standard', false,
      null, null, new AbortController(),
      (event) => progressEvents.push(event)
    );

    expect(result.success).toBe(true);
    expect(mockSaveIndependentTable).not.toHaveBeenCalled();
    expect(progressEvents.map(e => e.phase)).toContain('chunk_done');
  });

  it('无 onProgress 回调时不报错', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
      // 不传 onProgress
    );

    expect(result.success).toBe(true);
  });

  it('解析失败时重试并最终失败', async () => {
    mockSettings.tableMaxRetries = 1;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: false, modifiedKeys: [] });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('解析或应用AI更新时出错');
  });

  it('首次初始化时保存所有表，但只追踪实质修改表', async () => {
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', content: [['row_id'], ['1']] },
      sheet_1: { name: '测试表B', content: [['row_id'], ['1']] },
    };

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
    mockCheckIfFirstTimeInit.mockResolvedValue(true);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValueOnce({
      sheet_0: { name: '测试表A', content: [['row_id'], ['种子行A']] },
      sheet_1: { name: '测试表B', content: [['row_id'], ['种子行B']] },
    });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_0', 'sheet_1'],
      updateGroupKeys: ['sheet_0'],
      trackingSheetKeys: ['sheet_0'],
      source: 'group_fill',
    }));
  });

  it('自动更新成功后建立 AI 楼层边界 checkpoint', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });
    mockEnsureBoundaryCheckpoint.mockResolvedValueOnce({ success: true, changed: true, anchorIndex: 23 });

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    expect(result.success).toBe(true);
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledWith({ reason: 'auto_update', save: true });
  });

  it('自动更新成功后 boundary checkpoint 失败时不回滚主更新', async () => {
    const { logWarn_ACU } = await import('../../../src/shared/utils');
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });
    mockEnsureBoundaryCheckpoint.mockResolvedValueOnce({ success: false, changed: false, error: '边界 checkpoint 写入失败' });

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    expect(result.success).toBe(true);
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledWith({ reason: 'auto_update', save: true });
    expect(logWarn_ACU).toHaveBeenCalledWith(expect.stringContaining('边界 checkpoint 建立失败'));
  });
});

// ═══════════════════════════════════════════════════════════════
// orchestrateManualUpdate_ACU
// ═══════════════════════════════════════════════════════════════
describe('orchestrateManualUpdate_ACU', () => {
  const mockProcessBatch = vi.fn();
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { loadAllChatMessages_ACU } = await import('../../../src/service/worldbook/pipeline');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表', updateConfig: { groupId: 0 }, content: [['row_id', '值']] },
    });

    vi.mocked(loadAllChatMessages_ACU).mockReset();
    vi.mocked(loadAllChatMessages_ACU).mockResolvedValue(undefined);

    vi.mocked(isSqliteMode).mockReturnValue(false);
    mockIsAutoUpdating = false;
    mockCoreApisReady = true;
    mockCurrentJsonTableData = { sheet_0: { name: '测试表', updateConfig: {}, content: [['row_id', '值']] } };
    mockSettings = {
      ...mockSettings,
      apiMode: 'custom',
      apiConfig: { useMainApi: true, url: '', model: '' },
      autoUpdateThreshold: 3,
      updateBatchSize: 3,
      skipUpdateFloors: 0,
    };
    mockWasStopped = false;
    mockCaptureManualRefillSessionSnapshot.mockReset();
    mockCaptureManualRefillSessionSnapshot.mockReturnValue({ targetMessageIndices: [], messageFields: [] });
    mockClearManualRefillSheetDataInRange.mockReset();
    mockClearManualRefillSheetDataInRange.mockResolvedValue(0);
    mockRestoreManualRefillSessionSnapshot.mockReset();
    mockRestoreManualRefillSessionSnapshot.mockResolvedValue(undefined);
    mockCommitManualRefillSheetSnapshot.mockReset();
    mockCommitManualRefillSheetSnapshot.mockResolvedValue({ success: true, changed: true, clearedCount: 1, checkpointCount: 1, targetMessageIndex: 0 });
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockUpdateReadableLorebookEntry.mockResolvedValue(undefined);
    mockEnsureBoundaryCheckpoint.mockResolvedValue({ success: true, changed: false, skipped: true });
    mockShouldRotateBoundaryCheckpoint.mockReturnValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 3 });
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('sheet_0')) {
        if (tableData.sheet_0) tableData.sheet_0.content.push(['2', '来自A']);
        return { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 };
      }
      if (aiResponse.includes('sheet_1')) {
        if (tableData.sheet_1) tableData.sheet_1.content.push(['2', '来自B']);
        return { success: true, modifiedKeys: ['sheet_1'], appliedEdits: 1 };
      }
      return { success: false, modifiedKeys: [], appliedEdits: 0 };
    });
  });

  it('正在更新中时返回错误', async () => {
    mockIsAutoUpdating = true;
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('正在进行中');
  });

  it('API 未就绪时返回错误', async () => {
    mockCoreApisReady = false;
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('API未就绪');
  });

  it('API 未配置时返回错误', async () => {
    mockSettings.apiMode = 'custom';
    mockSettings.apiConfig = { useMainApi: false, url: '', model: '' };
    mockSettings.tavernProfile = '';
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('API未配置');
  });

  it('数据库未加载时返回错误', async () => {
    mockCurrentJsonTableData = null;
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('数据库未加载');
  });

  it('聊天记录为空时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([]);

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('聊天记录为空');
  });

  it('无 AI 回复时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: true },
    ]);

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('尚未检测到AI回复');
  });

  it('未选择表格时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false },
    ]);

    const result = await orchestrateManualUpdate_ACU([], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('未选择');
  });

  it('正常流程：processBatch 成功，返回 success', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);

    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);
    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
  });

  it('可回放手动重填启动前不预清理重填范围内选中表历史数据', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, clearManualRefillSheetDataInRange_ACU, clearTableDataAtFloors_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {} },
      sheet_1: { name: '测试表B', updateConfig: {} },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });
    expect(result.success).toBe(true);
    expect(clearManualRefillIncrementalDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearManualRefillSheetDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearTableDataAtFloors_ACU).not.toHaveBeenCalled();
    expect(mockPurgeSheetKeysFromChatHistoryHard).not.toHaveBeenCalled();
  });

  it('可回放手动重填不在启动期刷新 SQLite 运行时快照', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, clearManualRefillSheetDataInRange_ACU } = await import('../../../src/service/chat/chat-service');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '纪要表', updateConfig: {}, content: [['row_id', '事件'], ['old', '清理前旧 chronicle']] },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(true);
    expect(clearManualRefillIncrementalDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearManualRefillSheetDataInRange_ACU).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
    expect(mockPrepareAIInput).toHaveBeenCalled();
  });

  it('重填起点早于最早 init checkpoint 时先用模板建立临时基底但不预清理或刷新', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, ensureManualRefillInitialBaseline_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { uid: 'sheet_0', name: 'chronicle', updateConfig: {}, content: [['row_id', 'code_index']] },
      sheet_1: { uid: 'sheet_1', name: 'quest_log', updateConfig: {}, content: [['row_id', 'status']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复3' },
      { is_user: true },
      {
        is_user: false,
        mes: 'AI回复5',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: { kind: 'full', reason: 'init', createdAt: 1, data: { mate: { type: 'acu' }, sheet_0: { name: 'chronicle', content: [['row_id', 'code_index']] } } },
              logEntries: [],
            },
          },
        },
      },
    ]);
    mockSettings.autoUpdateThreshold = 2;
    mockCurrentJsonTableData = { sheet_0: { name: 'chronicle', updateConfig: {}, content: [['row_id', 'code_index'], ['old', '1']] } };
    mockEnsureManualRefillInitialBaseline.mockResolvedValueOnce({ success: true, changed: true, targetMessageIndex: 3, movedFromMessageIndex: 5, downgradedCount: 1 });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(true);
    expect(ensureManualRefillInitialBaseline_ACU).toHaveBeenCalledWith(expect.objectContaining({
      isolationKey: '',
      targetMessageIndex: 3,
      data: expect.objectContaining({ sheet_0: expect.objectContaining({ name: 'chronicle' }), sheet_1: expect.objectContaining({ name: 'quest_log' }) }),
      save: true,
    }));
    expect(mockCaptureManualRefillSessionSnapshot).toHaveBeenCalledWith([3, 5]);
    expect(mockClearManualRefillIncrementalDataInRange).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
  });

  it('临时 initial baseline 建立失败时回滚并拒绝清理或刷新', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: false, mes: 'AI回复1' }]);
    mockCurrentJsonTableData = { sheet_0: { name: 'chronicle', updateConfig: {}, content: [['row_id', 'code_index']] } };
    mockEnsureManualRefillInitialBaseline.mockResolvedValueOnce({ success: false, changed: false, error: '目标楼层已有 V2 logEntries' });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('目标楼层已有 V2 logEntries');
    expect(mockRestoreManualRefillSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(mockClearManualRefillIncrementalDataInRange).not.toHaveBeenCalled();
    expect(mockClearManualRefillSheetDataInRange).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
  });

  it('普通手动更新的进度回调异常保持 rejection 契约且不触发 refill 回滚', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A']] },
    };
    const processBatch = vi.fn().mockResolvedValue({ success: true });
    const onProgress = vi.fn(() => {
      throw new Error('ordinary progress observer failed');
    });

    await expect(orchestrateManualUpdate_ACU(['sheet_0'], processBatch, mockRefreshData, { onProgress }))
      .rejects.toThrow('ordinary progress observer failed');

    expect(mockRestoreManualRefillSessionSnapshot).not.toHaveBeenCalled();
    expect(processBatch).not.toHaveBeenCalled();
  });

  it('临时 initial baseline 建立直接 reject 时统一回滚且返回硬失败', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: false, mes: 'AI回复1' }]);
    mockCurrentJsonTableData = { sheet_0: { name: 'chronicle', updateConfig: {}, content: [['row_id', 'code_index']] } };
    mockEnsureManualRefillInitialBaseline.mockRejectedValueOnce(new Error('baseline transaction rejected'));

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('baseline transaction rejected');
    expect(mockRestoreManualRefillSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(mockClearManualRefillIncrementalDataInRange).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
  });

  it('临时 baseline 落盘后 preparing 进度回调抛错时统一回滚', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: 'chronicle', updateConfig: {}, content: [['row_id', 'code_index'], ['old', '1']] },
    };
    const processBatch = vi.fn().mockResolvedValue({ success: true });
    const onProgress = vi.fn(() => {
      throw new Error('progress observer failed');
    });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], processBatch, mockRefreshData, {
      clearBeforeUpdate: true,
      onProgress,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('progress observer failed');
    expect(mockRestoreManualRefillSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
    expect(processBatch).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('可回放手动重填忽略旧的整段增量清理 mock，直接按 bucket 执行', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, clearManualRefillSheetDataInRange_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
      sheet_1: { name: '测试表B', updateConfig: {}, content: [['row_id', '值B'], ['1', '旧B']] },
    };
    vi.mocked(clearManualRefillIncrementalDataInRange_ACU).mockRejectedValueOnce(new Error('purge failed'));

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(true);
    expect(clearManualRefillIncrementalDataInRange_ACU).not.toHaveBeenCalled();
    expect(mockRestoreManualRefillSessionSnapshot).not.toHaveBeenCalled();
    expect(clearManualRefillSheetDataInRange_ACU).not.toHaveBeenCalled();
    expect(mockPurgeSheetKeysFromChatHistoryHard).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
  });

  it('可回放手动重填不触发启动期运行时快照刷新', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, clearManualRefillSheetDataInRange_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
    };

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(true);
    expect(mockRestoreManualRefillSessionSnapshot).not.toHaveBeenCalled();
    expect(clearManualRefillIncrementalDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearManualRefillSheetDataInRange_ACU).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
    expect(mockPrepareAIInput).toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
  });

  it('可回放手动重填不预清理范围内或范围外历史基底，保护 V2 replay 初始数据', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, clearManualRefillSheetDataInRange_ACU, clearTableDataAtFloors_ACU } = await import('../../../src/service/chat/chat-service');
    const chat = [
      { is_user: true, mes: '用户0' },
      {
        is_user: false,
        mes: 'AI回复1',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [],
              checkpoint: {
                kind: 'full',
                reason: 'compaction',
                createdAt: 1,
                data: {
                  mate: { type: 'acu' },
                  sheet_0: { name: '测试表A', content: [['row_id', '值A'], ['base', '范围外基底']] },
                },
              },
            },
          },
        },
      },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
      { is_user: true, mes: '用户4' },
      { is_user: false, mes: 'AI回复5' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(chat as any);
    mockSettings.autoUpdateThreshold = 2;
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(true);
    expect(clearManualRefillIncrementalDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearManualRefillSheetDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearTableDataAtFloors_ACU).not.toHaveBeenCalled();
    expect(mockPurgeSheetKeysFromChatHistoryHard).not.toHaveBeenCalled();
    expect((chat[1] as any).TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0.content).toEqual([['row_id', '值A'], ['base', '范围外基底']]);
  });

  it('可回放手动重填不预清理 chat[0] sheet guide，避免 V2 replay 回退链路断裂', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, clearManualRefillSheetDataInRange_ACU, clearTableDataAtFloors_ACU } = await import('../../../src/service/chat/chat-service');
    const chat = [
      { is_user: true, mes: '用户0', TavernDB_ACU_SheetGuide: { '': { sheet_0: { latestMessageIndex: 1 } } } },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(chat as any);
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(true);
    expect(clearManualRefillIncrementalDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearManualRefillSheetDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearTableDataAtFloors_ACU).not.toHaveBeenCalled();
    expect(mockPurgeSheetKeysFromChatHistoryHard).not.toHaveBeenCalled();
    expect((chat[0] as any).TavernDB_ACU_SheetGuide).toEqual({ '': { sheet_0: { latestMessageIndex: 1 } } });
  });


  it('已有 V2 增量但无 full checkpoint 时首次返回确认信号且不写入', async () => {
    const { getChatArray_ACU, commitManualRefillSheetSnapshotInRangeAtomic_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表A', updateConfig: { groupId: 0 }, content: [['row_id', '值A']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        mes: 'AI回复1',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: undefined,
              logEntries: [{
                seq: 1,
                entryId: 'log-only-without-checkpoint',
                createdAt: 1,
                source: 'auto_fill',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_0'],
                changedSheetKeys: ['sheet_0'],
                groupKeys: [],
                operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: ['1', '孤立增量'] }],
              }],
            },
          },
        },
      },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
    ]);
    mockSettings.maxConcurrentGroups = 1;
    mockSettings.autoUpdateThreshold = 0;
    mockSettings.updateBatchSize = 1;
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });

    const processBatch = vi.fn().mockResolvedValue({ success: true });
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], processBatch, mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(false);
    expect(result.requiresUserConfirmation).toEqual(expect.objectContaining({
      reason: 'manual_refill_replace_sheet_baseline',
      replayErrorCode: 'no_full_checkpoint_replayable',
      contextScopeIndices: [0, 2],
      targetSheetKeys: ['sheet_0'],
    }));
    expect(mockRestoreManualRefillSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(commitManualRefillSheetSnapshotInRangeAtomic_ACU).not.toHaveBeenCalled();
    expect(mockClearManualRefillIncrementalDataInRange).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(processBatch).not.toHaveBeenCalled();
  });

  it('无 full checkpoint 且确认前回滚失败时返回硬错误而不是确认对象', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表A', updateConfig: { groupId: 0 }, content: [['row_id', '值A']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        mes: 'AI回复1',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: undefined,
              logEntries: [{
                seq: 1,
                entryId: 'log-only-rollback-failure',
                createdAt: 1,
                source: 'auto_fill',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_0'],
                changedSheetKeys: ['sheet_0'],
                groupKeys: [],
                operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: ['1', '孤立增量'] }],
              }],
            },
          },
        },
      },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
    ]);
    mockSettings.maxConcurrentGroups = 1;
    mockSettings.autoUpdateThreshold = 0;
    mockSettings.updateBatchSize = 1;
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
    };
    mockRestoreManualRefillSessionSnapshot.mockRejectedValueOnce(new Error('restore transaction failed'));
    const processBatch = vi.fn().mockResolvedValue({ success: true });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], processBatch, mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('临时基底回滚失败：restore transaction failed');
    expect(result.requiresUserConfirmation).toBeUndefined();
    expect(mockRestoreManualRefillSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(mockClearManualRefillIncrementalDataInRange).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).not.toHaveBeenCalled();
    expect(processBatch).not.toHaveBeenCalled();
  });

  it('无可回放 full checkpoint 且 confirmBoundaryReset=true 时仅预清理，并在成功后提交完整快照', async () => {
    const { getChatArray_ACU, commitManualRefillSheetSnapshotInRangeAtomic_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表A', updateConfig: { groupId: 0 }, content: [['row_id', '值A']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        mes: 'AI回复1',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: undefined,
              logEntries: [{
                seq: 1,
                entryId: 'fallback-without-full',
                createdAt: 1,
                source: 'manual_refill_baseline',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_0'],
                changedSheetKeys: ['sheet_0'],
                groupKeys: [],
                operations: [{
                  kind: 'data_replace',
                  reason: 'checkpoint_fallback',
                  data: { sheet_0: { name: '测试表A', content: [['row_id', '值A'], ['fallback', '不允许恢复']] } },
                }],
              }],
            },
          },
        },
      },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
      { is_user: true, mes: '用户4' },
      {
        is_user: false,
        mes: 'AI回复5',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', reason: 'init', createdAt: 2, data: { sheet_0: { name: '测试表A', content: [['row_id', '值A'], ['later', '目标层基底']] } } } },
          },
        },
      },
    ]);
    mockSettings.maxConcurrentGroups = 1;
    mockSettings.autoUpdateThreshold = 0;
    mockSettings.updateBatchSize = 1;
    mockCurrentJsonTableData = { sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] } };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });

    const processBatch = vi.fn().mockResolvedValue({ success: true });
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], processBatch, mockRefreshData, { clearBeforeUpdate: true, confirmBoundaryReset: true });

    expect(result.success).toBe(true);
    expect(mockClearManualRefillSheetDataInRange).toHaveBeenCalledWith([0, 2, 4], ['sheet_0']);
    expect(commitManualRefillSheetSnapshotInRangeAtomic_ACU).toHaveBeenCalledWith(expect.objectContaining({
      isolationKey: '',
      targetMessageIndices: [0, 2, 4],
      targetSheetKeys: ['sheet_0'],
      snapshotData: expect.objectContaining({ sheet_0: expect.any(Object) }),
    }));
    expect(mockClearManualRefillIncrementalDataInRange).not.toHaveBeenCalled();
    expect(mockReloadStorageProvider).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(3);
  });

  it('跨 checkpoint 重填的最终快照提交失败时恢复整个重填会话快照', async () => {
    const { getChatArray_ACU, captureManualRefillSessionSnapshot_ACU, commitManualRefillSheetSnapshotInRangeAtomic_ACU, restoreManualRefillSessionSnapshotAtomic_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [{ seq: 1, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: ['1', '旧数据'] }], filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [] }],
            },
          },
        },
      },
      { is_user: true },
      { is_user: false },
    ]);
    const sessionSnapshot = { targetMessageIndices: [0, 2], messageFields: [{ index: 0 }, { index: 2 }] } as any;
    vi.mocked(captureManualRefillSessionSnapshot_ACU).mockReturnValue(sessionSnapshot);
    vi.mocked(commitManualRefillSheetSnapshotInRangeAtomic_ACU).mockResolvedValue({ success: false, changed: false, clearedCount: 0, checkpointCount: 0, error: 'strict save failed' });
    mockSettings.autoUpdateThreshold = 0;
    mockSettings.updateBatchSize = 1;
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true, confirmBoundaryReset: true });

    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('strict save failed') }));
    expect(captureManualRefillSessionSnapshot_ACU).toHaveBeenCalledWith([0, 2]);
    expect(restoreManualRefillSessionSnapshotAtomic_ACU).toHaveBeenCalledWith(sessionSnapshot, '', ['sheet_0']);
    expect(mockEnsureBoundaryCheckpoint).not.toHaveBeenCalled();
  });

  it('跨 checkpoint 重填在用户停止后恢复整个重填会话快照', async () => {
    const { getChatArray_ACU, captureManualRefillSessionSnapshot_ACU, commitManualRefillSheetSnapshotInRangeAtomic_ACU, restoreManualRefillSessionSnapshotAtomic_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [{ seq: 1, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: ['1', '旧数据'] }], filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [] }],
            },
          },
        },
      },
      { is_user: true },
      { is_user: false },
    ]);
    const sessionSnapshot = { targetMessageIndices: [0, 2], messageFields: [{ index: 0 }, { index: 2 }] } as any;
    vi.mocked(captureManualRefillSessionSnapshot_ACU).mockReturnValue(sessionSnapshot);
    mockSettings.autoUpdateThreshold = 0;
    mockSettings.updateBatchSize = 1;
    mockPersistTablesToChatMessage.mockImplementationOnce(async () => {
      mockWasStopped = true;
      return { saved: true, messageIndex: 2 };
    });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true, confirmBoundaryReset: true });

    expect(result.success).toBe(false);
    expect(restoreManualRefillSessionSnapshotAtomic_ACU).toHaveBeenCalledWith(sessionSnapshot, '', ['sheet_0']);
    expect(commitManualRefillSheetSnapshotInRangeAtomic_ACU).not.toHaveBeenCalled();
    expect(mockEnsureBoundaryCheckpoint).not.toHaveBeenCalled();
  });

  it('跨 checkpoint 重填在分组后同步聊天失败时恢复整个重填会话快照', async () => {
    const { getChatArray_ACU, captureManualRefillSessionSnapshot_ACU, commitManualRefillSheetSnapshotInRangeAtomic_ACU, restoreManualRefillSessionSnapshotAtomic_ACU } = await import('../../../src/service/chat/chat-service');
    const { loadAllChatMessages_ACU } = await import('../../../src/service/worldbook/pipeline');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [{ seq: 1, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: ['1', '旧数据'] }], filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [] }],
            },
          },
        },
      },
      { is_user: true },
      { is_user: false },
    ]);
    const sessionSnapshot = { targetMessageIndices: [0, 2], messageFields: [{ index: 0 }, { index: 2 }] } as any;
    vi.mocked(captureManualRefillSessionSnapshot_ACU).mockReturnValue(sessionSnapshot);
    mockSettings.autoUpdateThreshold = 0;
    mockSettings.updateBatchSize = 1;
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });

    let loadCallCount = 0;
    vi.mocked(loadAllChatMessages_ACU).mockImplementation(async () => {
      loadCallCount += 1;
      if (loadCallCount === 3) {
        throw new Error('分组后聊天同步失败');
      }
    });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true, confirmBoundaryReset: true });

    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining('分组后聊天同步失败') }));
    expect(loadAllChatMessages_ACU).toHaveBeenCalledTimes(4);
    expect(loadCallCount).toBe(4);
    expect(restoreManualRefillSessionSnapshotAtomic_ACU).toHaveBeenCalledWith(sessionSnapshot, '', ['sheet_0']);
    expect(mockRefreshData).toHaveBeenCalledTimes(2);
    expect(mockRefreshData.mock.invocationCallOrder[0]).toBeLessThan(
      restoreManualRefillSessionSnapshotAtomic_ACU.mock.invocationCallOrder[0],
    );
    expect(restoreManualRefillSessionSnapshotAtomic_ACU.mock.invocationCallOrder[0]).toBeLessThan(
      mockRefreshData.mock.invocationCallOrder[1],
    );
    expect(commitManualRefillSheetSnapshotInRangeAtomic_ACU).not.toHaveBeenCalled();
    expect(mockEnsureBoundaryCheckpoint).not.toHaveBeenCalled();
  });

  it('存在其他 isolationKey 的 V2 checkpoint 时手动重填中止，避免把隔离键不匹配误判为空表', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表A', updateConfig: { groupId: 0 }, content: [['row_id', '值A']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        mes: 'AI回复1',
        TavernDB_ACU_IsolatedData: {
          other: {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [],
              checkpoint: { kind: 'full', reason: 'init', createdAt: 1, data: { sheet_0: { name: '测试表A', content: [['row_id', '值A'], ['1', '其他隔离数据']] } } },
            },
          },
        },
      },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
    ]);
    mockSettings.maxConcurrentGroups = 1;
    mockSettings.autoUpdateThreshold = 0;
    mockSettings.updateBatchSize = 1;
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
    };

    const processBatch = vi.fn().mockResolvedValue({ success: true });
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], processBatch, mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('isolationKey 不匹配');
    expect(processBatch).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });



  it('processBatch 失败时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);

    mockSettings.tableMaxRetries = 1;
    mockCallCustomOpenAI.mockResolvedValue('无效响应');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('尝试后仍失败');
  });

  it('自动合并触发成功时返回 autoMergeTriggered', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);

    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const { checkAutoMergeTrigger_ACU, prepareAutoMergeBatches_ACU, executeAutoMergeBatch_ACU, finalizeAutoMerge_ACU } = await import('../../../src/service/summary/merge-logic');
    vi.mocked(checkAutoMergeTrigger_ACU).mockReturnValue({ shouldTrigger: true, mergeCount: 5 });
    vi.mocked(prepareAutoMergeBatches_ACU).mockReturnValue({ batches: [{ startIndex: 0, endIndex: 5 }] } as any);
    vi.mocked(executeAutoMergeBatch_ACU).mockResolvedValue({ accumulatedSummary: ['合并结果'] } as any);
    vi.mocked(finalizeAutoMerge_ACU).mockResolvedValue(undefined);

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(true);
    expect(result.autoMergeTriggered).toBe(true);
    expect(result.autoMergeSuccess).toBe(true);
  });

  it('finally 块中清理 manualExtraHint 和 isAutoUpdating', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);

    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    const { _set_manualExtraHint_ACU, _set_isAutoUpdatingCard_ACU } = await import('../../../src/service/runtime/state-manager');
    expect(_set_manualExtraHint_ACU).toHaveBeenCalledWith('');
    expect(_set_isAutoUpdatingCard_ACU).toHaveBeenCalledWith(false);
  });

  it('可回放手动重填跳过写入前 retained buffer boundary checkpoint，避免 bucket 提交前被维护性 checkpoint 中断', async () => {
    const { getChatArray_ACU, clearManualRefillIncrementalDataInRange_ACU, clearManualRefillSheetDataInRange_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {}, content: [['row_id', '值A'], ['1', '旧A']] },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockShouldRotateBoundaryCheckpoint.mockReturnValue(true);
    mockEnsureBoundaryCheckpoint.mockResolvedValue({ success: false, error: 'boundary checkpoint failed' });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { clearBeforeUpdate: true });

    expect(result.success).toBe(true);
    expect(result.checkpointWarning).toContain('boundary checkpoint failed');
    expect(clearManualRefillIncrementalDataInRange_ACU).not.toHaveBeenCalled();
    expect(clearManualRefillSheetDataInRange_ACU).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledWith({ reason: 'manual_refill', save: true });
  });

  it('手动更新整体成功后建立 retained buffer boundary checkpoint', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(true);
    expect(result.checkpointWarning).toBeUndefined();
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledWith({ reason: 'manual_refill', save: true });
  });

  it('用户在最后一批成功后终止时不建立完成态 boundary checkpoint', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockPersistTablesToChatMessage.mockImplementationOnce(async () => {
      mockWasStopped = true;
      return { saved: true, messageIndex: 3 };
    });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('终止');
    expect(mockEnsureBoundaryCheckpoint).not.toHaveBeenCalled();
  });

  it('boundary checkpoint 建立失败时保留成功结果并返回 checkpointWarning', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockEnsureBoundaryCheckpoint.mockResolvedValueOnce({ success: false, changed: false, error: '边界 checkpoint 写入失败' });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(true);
    expect(result.checkpointWarning).toContain('边界 checkpoint 写入失败');
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('boundary checkpoint 建立抛异常时保留成功结果、返回 checkpointWarning 并记录异常详情', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { logError_ACU } = await import('../../../src/shared/utils');
    const checkpointError = new Error('checkpoint boom');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockEnsureBoundaryCheckpoint.mockRejectedValueOnce(checkpointError);

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(true);
    expect(result.checkpointWarning).toContain('checkpoint boom');
    expect(logError_ACU).toHaveBeenCalledWith('[Manual Update] 边界 checkpoint 建立异常详情:', checkpointError);
  });

  it('手动更新失败时不建立完成态 boundary checkpoint', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockSettings.tableMaxRetries = 1;
    mockCallCustomOpenAI.mockResolvedValue('无效响应');

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(false);
    expect(mockEnsureBoundaryCheckpoint).not.toHaveBeenCalled();
  });

  it('不同 groupId 的手动表格按 maxConcurrentGroups 分块并输出可观测进度', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU, logDebug_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', updateConfig: { groupId: 0 }, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: { groupId: 1 }, content: [['row_id', '值B']] },
      sheet_2: { name: '表C', updateConfig: { groupId: 2 }, content: [['row_id', '值C']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockSettings.maxConcurrentGroups = 2;
    mockCurrentJsonTableData = {
      sheet_0: { name: '表A', updateConfig: {}, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: {}, content: [['row_id', '值B']] },
      sheet_2: { name: '表C', updateConfig: {}, content: [['row_id', '值C']] },
    };
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      const match = aiResponse.match(/sheet_[0-2]/)?.[0];
      if (!match || !tableData[match]) return { success: false, modifiedKeys: [], appliedEdits: 0 };
      tableData[match].content.push(['2', `来自${match}`]);
      return { success: true, modifiedKeys: [match], appliedEdits: 1 };
    });
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>sheet_0</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>sheet_1</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>sheet_2</tableEdit>');
    const onProgress = vi.fn();

    const result = await orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1', 'sheet_2'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData, { onProgress });

    expect(result.success).toBe(true);
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logDebug_ACU).mock.calls.some(call => String(call[0]).includes('分组计划：选中 3 张表，生成 3 个组，最大并发组数 2'))).toBe(true);
    expect(vi.mocked(logDebug_ACU).mock.calls.some(call => String(call[0]).includes('并发处理第 1/2 批，当前 2 组'))).toBe(true);
    expect(vi.mocked(logDebug_ACU).mock.calls.some(call => String(call[0]).includes('并发处理第 2/2 批，当前 1 组'))).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'preparing', message: '并发处理第 1/2 批，当前 2 组。' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'preparing', message: '并发处理第 2/2 批，当前 1 组。' }));
  });

  it('手动分组 chunk 建立边界 checkpoint 前先同步聊天再判断是否需要滚动', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { loadAllChatMessages_ACU } = await import('../../../src/service/worldbook/pipeline');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', updateConfig: { groupId: 0 }, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: { groupId: 1 }, content: [['row_id', '值B']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockSettings.maxConcurrentGroups = 1;
    mockCurrentJsonTableData = {
      sheet_0: { name: '表A', updateConfig: {}, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: {}, content: [['row_id', '值B']] },
    };
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      const match = aiResponse.match(/sheet_[0-1]/)?.[0];
      if (!match || !tableData[match]) return { success: false, modifiedKeys: [], appliedEdits: 0 };
      tableData[match].content.push(['2', `来自${match}`]);
      return { success: true, modifiedKeys: [match], appliedEdits: 1 };
    });
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>sheet_0</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>sheet_1</tableEdit>');
    mockShouldRotateBoundaryCheckpoint.mockReturnValue(true);

    const result = await orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(true);
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(2);
    expect(mockShouldRotateBoundaryCheckpoint).toHaveBeenCalledTimes(2);
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenCalledTimes(3);
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenNthCalledWith(1, { reason: 'manual_refill', save: true });
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenNthCalledWith(2, { reason: 'manual_refill', save: true });
    expect(mockEnsureBoundaryCheckpoint).toHaveBeenNthCalledWith(3, { reason: 'manual_refill', save: true });
    expect(vi.mocked(loadAllChatMessages_ACU).mock.invocationCallOrder[0]).toBeLessThan(mockShouldRotateBoundaryCheckpoint.mock.invocationCallOrder[0]);
    expect(mockShouldRotateBoundaryCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(mockEnsureBoundaryCheckpoint.mock.invocationCallOrder[0]);
    // load[1] 是第一个 chunk 处理完成后的聊天同步；第二个 chunk 的前置边界判断必须使用下一次同步后的状态。
    // 因此这里用 load[2] 锁定第二个 chunk 的 load -> shouldRotate -> ensure 顺序。
    expect(vi.mocked(loadAllChatMessages_ACU).mock.invocationCallOrder[2]).toBeLessThan(mockShouldRotateBoundaryCheckpoint.mock.invocationCallOrder[1]);
    expect(mockShouldRotateBoundaryCheckpoint.mock.invocationCallOrder[1]).toBeLessThan(mockEnsureBoundaryCheckpoint.mock.invocationCallOrder[1]);
  });

  it('手动分组 chunk 内在第一个响应完成前并发发起同批 group 请求', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', updateConfig: { groupId: 0 }, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: { groupId: 1 }, content: [['row_id', '值B']] },
      sheet_2: { name: '表C', updateConfig: { groupId: 2 }, content: [['row_id', '值C']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockSettings.maxConcurrentGroups = 2;
    mockCurrentJsonTableData = {
      sheet_0: { name: '表A', updateConfig: {}, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: {}, content: [['row_id', '值B']] },
      sheet_2: { name: '表C', updateConfig: {}, content: [['row_id', '值C']] },
    };
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      const match = aiResponse.match(/sheet_[0-2]/)?.[0];
      if (!match || !tableData[match]) return { success: false, modifiedKeys: [], appliedEdits: 0 };
      tableData[match].content.push(['2', `来自${match}`]);
      return { success: true, modifiedKeys: [match], appliedEdits: 1 };
    });
    const resolvers: Array<(value: string) => void> = [];
    mockCallCustomOpenAI.mockImplementation(() => new Promise<string>(resolve => {
      resolvers.push(resolve);
    }));
    const waitForAiCallCount = async (count: number) => {
      for (let i = 0; i < 20 && mockCallCustomOpenAI.mock.calls.length < count; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(count);
    };

    const resultPromise = orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1', 'sheet_2'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);
    await waitForAiCallCount(2);
    expect(resolvers).toHaveLength(2);

    resolvers[0]('<tableEdit>sheet_0</tableEdit>');
    await waitForAiCallCount(2);

    resolvers[1]('<tableEdit>sheet_1</tableEdit>');
    await waitForAiCallCount(3);
    expect(resolvers).toHaveLength(3);

    resolvers[2]('<tableEdit>sheet_2</tableEdit>');
    const result = await resultPromise;
    expect(result.success).toBe(true);
  });

  it('相同 groupId 的手动表格聚合到同一 group，而不是另起调度链', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU, logDebug_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', updateConfig: { groupId: 7 }, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: { groupId: 7 }, content: [['row_id', '值B']] },
    });
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '表A', updateConfig: {}, content: [['row_id', '值A']] },
      sheet_1: { name: '表B', updateConfig: {}, content: [['row_id', '值B']] },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0 sheet_1</tableEdit>');
    mockParseAndApplyTableEditsToData.mockImplementation((_aiResponse: string, tableData: any) => {
      tableData.sheet_0.content.push(['2', '来自聚合组A']);
      tableData.sheet_1.content.push(['2', '来自聚合组B']);
      return { success: true, modifiedKeys: ['sheet_0', 'sheet_1'], appliedEdits: 2 };
    });

    const result = await orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(true);
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logDebug_ACU).mock.calls.some(call => String(call[0]).includes('分组计划：选中 2 张表，生成 1 个组'))).toBe(true);
    const groupedPersistCall = mockPersistTablesToChatMessage.mock.calls.find(call => call[0]?.targetSheetKeys?.includes('sheet_1'));
    expect(groupedPersistCall?.[0].targetSheetKeys).toEqual(['sheet_0', 'sheet_1']);
  });
});

// ═══════════════════════════════════════════════════════════════
// executeCardUpdateCore_ACU — SQL 错误反馈重试逻辑
// ═══════════════════════════════════════════════════════════════
describe('executeCardUpdateCore_ACU — SQL 错误反馈重试', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { disposeStorageProvider } = await import('../../../src/service/table/table-storage-strategy');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(isSqliteMode).mockReturnValue(false);
    disposeStorageProvider();
    vi.clearAllMocks();
    mockParseAndApplyTableEdits.mockReset();
    mockParseAndApplyTableEditsToData.mockReset();
    mockApplySqlEditsToTableDataSnapshot.mockReset();
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: any) => { callback(); return 0 as any; });
    mockWasStopped = false;
    mockSettings = {
      ...mockSettings,
      tableMaxRetries: 3,
      autoUpdateTokenThreshold: 0,
      importPromptExcludeImportedWorldbookEntries: true,
    };
    mockCurrentJsonTableData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'test', name: '测试表', sourceData: { ddl: 'CREATE TABLE test (row_id INTEGER PRIMARY KEY);' }, content: [['row_id']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    };
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 0 });
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'test', name: '测试表', sourceData: { ddl: 'CREATE TABLE test (row_id INTEGER PRIMARY KEY);' }, updateConfig: { groupId: 0 }, content: [['row_id']] },
    });
  });

  afterEach(() => {
    mockApplySqlEditsToTableDataSnapshot.mockReset();
    setTimeoutSpy.mockRestore();
  });

  it('SQL 模式下 parseAndApplyTableEdits 抛错时，错误信息注入到 tableDataText', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '原始数据' });
    mockCurrentJsonTableData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'test', name: '测试表', sourceData: { ddl: 'CREATE TABLE test (row_id INTEGER PRIMARY KEY);' }, content: [['row_id']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    };

    let callCount = 0;
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      callCount++;
      if (callCount === 1) {
        return '<tableEdit>INSERT INTO invalid_table VALUES (1);</tableEdit>';
      }
      if (callCount === 2) {
        expect(dynamicContent.tableDataText).toContain('SQL_ERROR_FEEDBACK');
        expect(dynamicContent.tableDataText).toContain('no such table');
        expect(dynamicContent.tableDataText).toContain('SQL执行错误，请修正后重新输出');
        return '<tableEdit>INSERT INTO test VALUES (1);</tableEdit>';
      }
      return '<tableEdit>ok</tableEdit>';
    });

    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    // 启动但不 await，让 fake timer 推进
    const resultPromise = executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    const result = await resultPromise;

    expect(result.success, result.error).toBe(true);
    expect(callCount).toBe(2);

    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('非 SQL 模式下错误不注入 SQL_ERROR_FEEDBACK', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(false);

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '原始数据' });

    let capturedTableDataText = '';
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      capturedTableDataText = dynamicContent.tableDataText;
      return '<tableEdit>有效内容</tableEdit>';
    });

    mockParseAndApplyTableEdits
      .mockImplementationOnce(() => { throw new Error('解析错误'); })
      .mockReturnValueOnce({ success: true, modifiedKeys: ['sheet_0'] });

    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    const resultPromise = executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(capturedTableDataText).not.toContain('SQL_ERROR_FEEDBACK');
  });

  it('SQL 模式下多次重试时错误信息被替换（不累积）', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    mockSettings.tableMaxRetries = 3;

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '原始数据' });
    mockCurrentJsonTableData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 't', name: '测试表', sourceData: { ddl: 'CREATE TABLE t (row_id INTEGER PRIMARY KEY);' }, content: [['row_id']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    };
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 't', name: '测试表', sourceData: { ddl: 'CREATE TABLE t (row_id INTEGER PRIMARY KEY);' }, updateConfig: { groupId: 0 }, content: [['row_id']] },
    } as any);

    let callCount = 0;
    const capturedTableDataTexts: string[] = [];
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      callCount++;
      capturedTableDataTexts.push(dynamicContent.tableDataText);
      if (callCount === 1) return '<tableEdit>INSERT INTO missing VALUES (1);</tableEdit>';
      if (callCount === 2) return '<tableEdit>INSERT INTO t (missing_col) VALUES (1);</tableEdit>';
      return '<tableEdit>INSERT INTO t VALUES (1);</tableEdit>';
    });

    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockSaveIndependentTable.mockResolvedValue({ saved: true });

    const resultPromise = executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    const result = await resultPromise;

    expect(result.success, result.error).toBe(true);
    expect(callCount).toBe(3);

    // 第二次调用时应包含第一次的错误信息
    expect(capturedTableDataTexts[1]).toContain('no such table');
    // 第三次调用时应包含第二次的错误信息（替换了第一次的）
    expect(capturedTableDataTexts[2]).toContain('missing_col');
    // 第三次不应包含第一次的错误信息（被替换了）
    expect(capturedTableDataTexts[2]).not.toContain('no such table');

    vi.mocked(isSqliteMode).mockReturnValue(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 表级 API 预设覆盖决议（orchestrateManualUpdate_ACU）
// ═══════════════════════════════════════════════════════════════
describe('orchestrateManualUpdate_ACU — 表级 API 预设覆盖', () => {
  const mockProcessBatch = vi.fn();
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表', updateConfig: { groupId: 0 }, content: [['row_id', '值']] },
    });

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockUpdateReadableLorebookEntry.mockResolvedValue(undefined);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 3 });
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('sheet_0')) {
        if (tableData.sheet_0) tableData.sheet_0.content.push(['2', '来自A']);
        return { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 };
      }
      if (aiResponse.includes('sheet_1')) {
        if (tableData.sheet_1) tableData.sheet_1.content.push(['2', '来自B']);
        return { success: true, modifiedKeys: ['sheet_1'], appliedEdits: 1 };
      }
      return { success: false, modifiedKeys: [], appliedEdits: 0 };
    });
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(false);
    mockIsAutoUpdating = false;
    mockCoreApisReady = true;
    mockCurrentJsonTableData = { sheet_0: { name: '纪要表', updateConfig: {}, content: [['row_id', '值']] } };
    mockSettings = {
      ...mockSettings,
      apiMode: 'custom',
      apiConfig: { useMainApi: true, url: '', model: '' },
      autoUpdateThreshold: 3,
      updateBatchSize: 3,
      skipUpdateFloors: 0,
      tableApiPresetOverridesByName: {},
    };
  });

  it('表有覆盖预设时，requestOptions 携带 tableApiPreset', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    // parseTableTemplateJson_ACU mock 返回 { sheet_0: { name: '测试表' } }
    mockSettings.tableApiPresetOverridesByName = { '测试表': 'special-preset' };

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);
    expect(result.success).toBe(true);

    // 验证 callCustomOpenAI 被调用时携带了 requestOptions.tableApiPreset
    const openAICall = mockCallCustomOpenAI.mock.calls[0];
    const requestOptions = openAICall[2]; // 第三参 = requestOptions
    expect(requestOptions).toBeDefined();
    expect(requestOptions.tableApiPreset).toBe('special-preset');
  });

  it('表无覆盖预设时，requestOptions 不携带 tableApiPreset', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    mockSettings.tableApiPresetOverridesByName = {};

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);
    expect(result.success).toBe(true);

    const openAICall = mockCallCustomOpenAI.mock.calls[0];
    const requestOptions = openAICall[2];
    expect(requestOptions?.tableApiPreset).toBeUndefined();
  });

  it('表名为空时忽略覆盖', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockCurrentJsonTableData = { sheet_0: { name: '', updateConfig: {} } };

    mockSettings.tableApiPresetOverridesByName = { '': 'should-not-apply' };

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);
    expect(result.success).toBe(true);

    const openAICall = mockCallCustomOpenAI.mock.calls[0];
    const requestOptions = openAICall[2];
    expect(requestOptions?.tableApiPreset).toBeUndefined();
  });

  it('表名有空格时进行标准化匹配', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    // parseTableTemplateJson_ACU mock 返回 { sheet_0: { name: '测试表' } }
    // 设置 mockCurrentJsonTableData 的 name 带空格并不影响决议，
    // 因为决议用的是 parseTableTemplateJson_ACU 的返回值
    mockSettings.tableApiPresetOverridesByName = { '测试表': 'trimmed-preset' };

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);
    expect(result.success).toBe(true);

    const openAICall = mockCallCustomOpenAI.mock.calls[0];
    const requestOptions = openAICall[2];
    expect(requestOptions.tableApiPreset).toBe('trimmed-preset');
  });

  it('同组多表配置不同 API preset 时拆组并分别调用对应 preset', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表A', updateConfig: { groupId: 7 }, content: [['row_id', '值']] },
      sheet_1: { name: '测试表B', updateConfig: { groupId: 7 }, content: [['row_id', '值']] },
    } as any);
    mockCurrentJsonTableData = {
      mate: { type: 'acu' },
      sheet_0: { name: '测试表A', updateConfig: { groupId: 7 }, content: [['row_id', '值']] },
      sheet_1: { name: '测试表B', updateConfig: { groupId: 7 }, content: [['row_id', '值']] },
    };
    mockSettings.maxConcurrentGroups = 2;
    mockSettings.tableApiPresetOverridesByName = {
      '测试表A': 'preset-a',
      '测试表B': 'preset-b',
    };
    mockCallCustomOpenAI.mockImplementation(async (_input: any, _controller: AbortController, options: any) =>
      `<tableEdit>${options.targetSheetKeys.join(' ')}</tableEdit>`
    );

    const result = await orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1'], vi.fn().mockResolvedValue({ success: true }), mockRefreshData);

    expect(result.success).toBe(true);
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(2);
    expect(mockCallCustomOpenAI.mock.calls.map(call => call[2].tableApiPreset).sort()).toEqual(['preset-a', 'preset-b']);
    expect(mockCallCustomOpenAI.mock.calls.map(call => call[2].targetSheetKeys).sort()).toEqual([['sheet_0'], ['sheet_1']]);
  });
});

describe('collectGroupFillResponse_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWasStopped = false;
    mockSettings = {
      ...mockSettings,
      tableMaxRetries: 2,
      autoUpdateTokenThreshold: 0,
      importPromptExcludeImportedWorldbookEntries: true,
    };
    mockCurrentJsonTableData = {
      sheet_0: { name: '全局表', content: [['row_id'], ['global']] },
    };
    mockPendingFinalGenerationGreenlights = [];
  });

  const createJob = () => ({
    groupKey: 'g0',
    groupId: 0,
    batchNumber: 1,
    targetSheetKeys: ['sheet_0'],
    messagesForContext: [{ is_user: false, mes: 'AI回复' }],
    saveTargetIndex: 0,
    updateMode: 'auto_standard',
    isImportMode: false,
    requestOptions: null,
    baseSnapshot: {
      sheet_0: { name: '快照表', content: [['row_id'], ['snapshot']] },
    },
  });

  it('显式 baseSnapshot 传给 prepareAIInput_ACU，且 collect 阶段不触发 parse/save', async () => {
    const job = createJob();
    const pendingGreenlights = [{ bookName: '角色A世界书', uid: 1, reason: '填表需要' }];
    mockPendingFinalGenerationGreenlights = pendingGreenlights;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>insertRow(0,{"0":"x"})</tableEdit>');

    const result = await collectGroupFillResponse_ACU(job);

    expect(result.success).toBe(true);
    expect(result.job).toBe(job);
    expect(mockPrepareAIInput).toHaveBeenCalledWith(
      job.messagesForContext,
      job.updateMode,
      job.targetSheetKeys,
      expect.objectContaining({
        tableData: job.baseSnapshot,
        excludeImportTaggedWorldbookEntries: false,
        agentGreenlights: pendingGreenlights,
      })
    );
    const prepareOptions = mockPrepareAIInput.mock.calls[0][3];
    expect(prepareOptions).toHaveProperty('agentGreenlights');
    expect(prepareOptions.agentGreenlights).toEqual(pendingGreenlights);
    expect(prepareOptions.agentGreenlights).not.toBe(pendingGreenlights);
    expect(mockParseAndApplyTableEdits).not.toHaveBeenCalled();
    expect(mockSaveIndependentTable).not.toHaveBeenCalled();
    expect(mockRunTableUpdateApplyWithScopeLock).not.toHaveBeenCalled();
    expect(mockEnqueueSummaryVectorIndexFlush).not.toHaveBeenCalled();
  });

  it('AI 响应缺少完整 tableEdit 标签时按重试次数失败', async () => {
    const job = createJob();
    mockSettings.tableMaxRetries = 1;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('无效响应');

    const result = await collectGroupFillResponse_ACU(job);

    expect(result.success).toBe(false);
    expect(result.error).toContain('1 次尝试后仍失败');
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(1);
    expect(mockParseAndApplyTableEdits).not.toHaveBeenCalled();
    expect(mockSaveIndependentTable).not.toHaveBeenCalled();
  });

  it('SQL 模式下携带上轮错误反馈时，将 SQL_ERROR_FEEDBACK 注入到 prompt', async () => {
    const job = createJob();
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '原始数据' });
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      expect(dynamicContent.tableDataText).toContain('SQL_ERROR_FEEDBACK');
      expect(dynamicContent.tableDataText).toContain('no such table');
      return '<tableEdit>INSERT INTO test VALUES (1);</tableEdit>';
    });

    const result = await collectGroupFillResponse_ACU(job, { lastSqlError: 'no such table' });

    expect(result.success).toBe(true);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('prepareAIInput 返回 null 时直接失败', async () => {
    const job = createJob();
    mockPrepareAIInput.mockResolvedValue(null);

    const result = await collectGroupFillResponse_ACU(job);

    expect(result.success).toBe(false);
    expect(result.error).toContain('无法准备AI输入');
    expect(mockCallCustomOpenAI).not.toHaveBeenCalled();
  });
});

describe('applyUnifiedGroupFillResponses_ACU', () => {
  beforeEach(async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { disposeStorageProvider } = await import('../../../src/service/table/table-storage-strategy');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, getEffectiveSeedRowsForSheet_ACU } = await import('../../../src/service/template/chat-scope');
    disposeStorageProvider();
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    vi.mocked(isSqliteMode).mockReturnValue(false);
    vi.clearAllMocks();
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表', updateConfig: { groupId: 0 } },
    } as any);
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(getEffectiveSeedRowsForSheet_ACU).mockReturnValue([] as any);
    mockSettings = {
      ...mockSettings,
      summaryVectorIndexModeEnabled: true,
    };
    mockCurrentJsonTableData = {
      sheet_0: { name: '全局污染表', content: [['row_id', '值'], ['1', 'global']] },
      sheet_1: { name: '全局污染表2', content: [['row_id', '值'], ['1', 'global-2']] },
    };
    mockUpdateReadableLorebookEntry.mockResolvedValue(undefined);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 3 });
    mockGetChatArray_ACU.mockImplementation(() => mockChatArrayForSeedStage);
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('sheet_0')) {
        tableData.sheet_0.content.push(['2', '来自A']);
        return { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 };
      }
      if (aiResponse.includes('sheet_1')) {
        tableData.sheet_1.content.push(['2', '来自B']);
        return { success: true, modifiedKeys: ['sheet_1'], appliedEdits: 1 };
      }
      return { success: false, modifiedKeys: [], appliedEdits: 0 };
    });
  });

  it('按稳定顺序基于 baseSnapshot 合并响应，仅显式保存一次并触发一次 flush', async () => {
    const baseSnapshot = {
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    };
    const responses = [
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_1</tableEdit>', tableEditText: 'sheet_1', job: { groupKey: 'b', groupId: 2, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_0</tableEdit>', tableEditText: 'sheet_0', job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    expect(result.modifiedKeys.sort()).toEqual(['sheet_0', 'sheet_1']);
    expect(mockParseAndApplyTableEditsToData.mock.calls.map(call => call[0])).toEqual(['<tableEdit>sheet_0</tableEdit>', '<tableEdit>sheet_1</tableEdit>']);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 3,
      targetSheetKeys: ['sheet_0', 'sheet_1'],
      updateGroupKeys: ['sheet_0', 'sheet_1'],
      trackingSheetKeys: ['sheet_0', 'sheet_1'],
      tableData: expect.objectContaining({
        sheet_0: expect.objectContaining({ content: [['row_id', '值'], ['1', 'base-a'], ['2', '来自A']] }),
        sheet_1: expect.objectContaining({ content: [['row_id', '值'], ['1', 'base-b'], ['2', '来自B']] }),
      }),
    }));
    const savePayload = mockPersistTablesToChatMessage.mock.calls[0][0];
    expect(savePayload.operations).toEqual([
      { kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: expect.objectContaining({
        content: [['row_id', '值'], ['1', 'base-a'], ['2', '来自A']],
      }), reason: 'system' },
      { kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: expect.objectContaining({
        content: [['row_id', '值'], ['1', 'base-b'], ['2', '来自B']],
      }), reason: 'system' },
    ]);
    expect(savePayload.operations.some((operation: any) => operation.kind === 'data_replace')).toBe(false);
    expect(mockSaveIndependentTable).not.toHaveBeenCalled();
    expect(mockRunTableUpdateApplyWithScopeLock).not.toHaveBeenCalled();
    expect(mockEnqueueSummaryVectorIndexFlush).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSummaryVectorIndexFlush).toHaveBeenCalledWith(expect.objectContaining({ targetMessageIndex: 3, mode: 'sync', reason: 'unified_group_fill_complete' }));
    expect(mockUpdateReadableLorebookEntry).toHaveBeenCalledTimes(1);
    expect(baseSnapshot.sheet_0.content).toEqual([['row_id', '值'], ['1', 'base-a']]);
    expect(baseSnapshot.sheet_1.content).toEqual([['row_id', '值'], ['1', 'base-b']]);
  });

  it('首次填表时 unified 路径保存全量表，但只追踪实质修改表', async () => {
    mockCheckIfFirstTimeInit.mockResolvedValue(true);
    const baseSnapshot = {
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    };
    const responses = [
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_0</tableEdit>', tableEditText: 'sheet_0', job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0']);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSheetKeys: ['sheet_0', 'sheet_1'],
      updateGroupKeys: ['sheet_0'],
      trackingSheetKeys: ['sheet_0'],
      tableData: expect.objectContaining({
        sheet_0: expect.objectContaining({ content: [['row_id', '值'], ['1', 'base-a'], ['2', '来自A']] }),
        sheet_1: expect.objectContaining({ content: [['row_id', '值'], ['1', 'base-b']] }),
      }),
    }));
    const savePayload = mockPersistTablesToChatMessage.mock.calls[0][0];
    expect(savePayload.operations).toEqual([
      { kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: expect.objectContaining({
        content: [['row_id', '值'], ['1', 'base-a'], ['2', '来自A']],
      }), reason: 'system' },
      { kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: expect.objectContaining({ content: [['row_id', '值'], ['1', 'base-b']] }), reason: 'system' },
    ]);
    expect(savePayload.operations.some((operation: any) => operation.kind === 'data_replace')).toBe(false);
  });

  it('unified 中存在 no-op group 时仍整体成功但只追踪实质修改表', async () => {
    const baseSnapshot = {
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    };
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('sheet_0')) {
        tableData.sheet_0.content.push(['2', '来自A']);
        return { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 };
      }
      return { success: true, modifiedKeys: [], appliedEdits: 0 };
    });
    const responses = [
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_0</tableEdit>', tableEditText: 'sheet_0', job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_1</tableEdit>', tableEditText: 'sheet_1', job: { groupKey: 'b', groupId: 2, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0']);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSheetKeys: ['sheet_0'],
      updateGroupKeys: ['sheet_0', 'sheet_1'],
      trackingSheetKeys: ['sheet_0'],
    }));
  });

  it('SQL 模式下基于显式 baseSnapshot 顺序统一提交，不污染全局 currentJsonTableData', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    const inventoryDDL = `CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    const questDDL = `CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    const baseSnapshot = {
      mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: inventoryDDL }, content: [['row_id', 'value'], ['1', 'base-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: questDDL }, content: [['row_id', 'value'], ['1', 'base-b']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO quest_log VALUES (2, 'sql-b');</tableEdit>", tableEditText: "INSERT INTO quest_log VALUES (2, 'sql-b');", job: { groupKey: 'b', groupId: 2, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>", tableEditText: "INSERT INTO inventory VALUES (2, 'sql-a');", job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    const savedData = mockPersistTablesToChatMessage.mock.calls[0][0].tableData;
    expect(savedData.sheet_0.content).toEqual([['row_id', 'value'], ['1', 'base-a'], ['2', 'sql-a']]);
    expect(savedData.sheet_1.content).toEqual([['row_id', 'value'], ['1', 'base-b'], ['2', 'sql-b']]);
    expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id', 'value'], ['1', 'base-a'], ['2', 'sql-a']]);
    expect(mockCurrentJsonTableData.sheet_1.content).toEqual([['row_id', 'value'], ['1', 'base-b'], ['2', 'sql-b']]);
    expect(mockPersistTablesToChatMessage.mock.calls[0][0].operations).toEqual([
      { kind: 'sql_sheet_batch', sheetKey: 'sheet_0', statements: ["INSERT INTO inventory VALUES (2, 'sql-a')"], tableName: 'inventory', reason: 'system' },
      { kind: 'sql_sheet_batch', sheetKey: 'sheet_1', statements: ["INSERT INTO quest_log VALUES (2, 'sql-b')"], tableName: 'quest_log', reason: 'system' },
    ]);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式下混合 SQL/非 SQL 响应直接失败，不退化为快照写入', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    const inventoryDDL = `CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    const questDDL = `CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    const baseSnapshot = {
      mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: inventoryDDL }, content: [['row_id', 'value'], ['1', 'base-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: questDDL }, content: [['row_id', 'value'], ['1', 'base-b']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>", tableEditText: "INSERT INTO inventory VALUES (2, 'sql-a');", job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
      { success: true, attempt: 1, aiResponse: '<tableEdit>insertRow(1,{"0":"dsl-b"})</tableEdit>', tableEditText: 'insertRow(1,{"0":"dsl-b"})', job: { groupKey: 'b', groupId: 2, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('禁止混合 SQL/非 SQL');
    expect(result.error).toContain('b');
    expect(mockApplySqlEditsToTableDataSnapshot).not.toHaveBeenCalled();
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式统一提交失败时返回 SQL 错误且不保存', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    const inventoryDDL = `CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    const baseSnapshot = {
      mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: inventoryDDL }, content: [['row_id', 'value'], ['1', 'base-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: '<tableEdit>UPDATE inventory SET missing_col = 1 WHERE row_id = 1;</tableEdit>', tableEditText: 'UPDATE inventory SET missing_col = 1 WHERE row_id = 1;', job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('group a SQL 执行失败');
    expect(result.error).toContain('missing_col');
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mockUpdateReadableLorebookEntry).not.toHaveBeenCalled();
    expect(mockEnqueueSummaryVectorIndexFlush).not.toHaveBeenCalled();
    expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id', 'value'], ['1', 'base-a']]);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式下模板基础数据与 AI INSERT 主键冲突时返回真实 SQL 错误且不保存', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, getEffectiveSeedRowsForSheet_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    mockChatArrayForSeedStage.push({ is_user: false, mes: '开场白' }, { is_user: true, mes: '第一条用户消息' });
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value'], ['1', 'tpl-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any);
    vi.mocked(getEffectiveSeedRowsForSheet_ACU).mockReturnValue([['1', 'tpl-a']] as any);

    const baseSnapshot = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO inventory VALUES (1, 'sql-conflict');</tableEdit>", tableEditText: "INSERT INTO inventory VALUES (1, 'sql-conflict');", job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(false);
    const normalizedError = String(result.error).toLowerCase();
    expect(normalizedError).toContain('group a');
    expect(normalizedError).toMatch(/unique|constraint|primary/);
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mockUpdateReadableLorebookEntry).not.toHaveBeenCalled();
    expect(mockEnqueueSummaryVectorIndexFlush).not.toHaveBeenCalled();
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('parser 返回越权 modifiedKeys 时直接失败且不保存', async () => {
    const baseSnapshot = {
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    };
    mockParseAndApplyTableEditsToData.mockImplementationOnce((_aiResponse: string, tableData: any) => {
      tableData.sheet_1.content.push(['2', '越权写入']);
      return { success: true, modifiedKeys: ['sheet_1'], appliedEdits: 1 };
    });

    const responses = [
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_0</tableEdit>', tableEditText: 'sheet_0', job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('越权修改');
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mockEnqueueSummaryVectorIndexFlush).not.toHaveBeenCalled();
    expect(mockUpdateReadableLorebookEntry).not.toHaveBeenCalled();
  });

  it('使用真实 native DSL parser 时，统一提交基于显式 baseSnapshot 而不是全局污染数据', async () => {
    const actualParser = await vi.importActual<typeof import('../../../src/service/ai/prompt-builder/table-edit-parser')>('../../../src/service/ai/prompt-builder/table-edit-parser');
    mockParseAndApplyTableEditsToData.mockImplementation((...args: any[]) => actualParser.parseAndApplyTableEditsToData_ACU(...args));
    const baseSnapshot = {
      sheet_0: { uid: 'sheet_0', name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { uid: 'sheet_1', name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    };
    const responses = [
      { success: true, attempt: 1, aiResponse: '<tableEdit>insertRow(0,{"0":"真实A"})</tableEdit>', tableEditText: 'insertRow(0,{"0":"真实A"})', job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
      { success: true, attempt: 1, aiResponse: '<tableEdit>insertRow(1,{"0":"真实B"})</tableEdit>', tableEditText: 'insertRow(1,{"0":"真实B"})', job: { groupKey: 'b', groupId: 2, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    const savedData = mockPersistTablesToChatMessage.mock.calls[0][0].tableData;
    expect(savedData.sheet_0.content[1][1]).toBe('base-a');
    expect(savedData.sheet_0.content[2][1]).toBe('真实A');
    expect(savedData.sheet_1.content[1][1]).toBe('base-b');
    expect(savedData.sheet_1.content[2][1]).toBe('真实B');
    expect(savedData.sheet_0.content[1][1]).not.toBe('global');
    expect(savedData.sheet_1.content[1][1]).not.toBe('global-2');
  });

  it('collect 真实产物可直接进入 unified apply，不需要手工补 job', async () => {
    const actualParser = await vi.importActual<typeof import('../../../src/service/ai/prompt-builder/table-edit-parser')>('../../../src/service/ai/prompt-builder/table-edit-parser');
    mockParseAndApplyTableEditsToData.mockImplementation((...args: any[]) => actualParser.parseAndApplyTableEditsToData_ACU(...args));
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>insertRow(0,{"0":"collectA"})</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>insertRow(1,{"0":"collectB"})</tableEdit>');

    const baseSnapshot = {
      sheet_0: { uid: 'sheet_0', name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { uid: 'sheet_1', name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    };
    const jobA = { groupKey: 'a', groupId: 1, batchNumber: 1, targetSheetKeys: ['sheet_0'], messagesForContext: [{ is_user: false, mes: 'AI回复A' }], saveTargetIndex: 3, updateMode: 'auto_standard', requestOptions: null, baseSnapshot, isImportMode: false };
    const jobB = { groupKey: 'b', groupId: 2, batchNumber: 1, targetSheetKeys: ['sheet_1'], messagesForContext: [{ is_user: false, mes: 'AI回复B' }], saveTargetIndex: 3, updateMode: 'auto_standard', requestOptions: null, baseSnapshot, isImportMode: false };

    const responseA = await collectGroupFillResponse_ACU(jobA);
    const responseB = await collectGroupFillResponse_ACU(jobB);
    const result = await applyUnifiedGroupFillResponses_ACU([responseB, responseA], baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(responseA.job).toBe(jobA);
    expect(responseB.job).toBe(jobB);
    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    const savedData = mockPersistTablesToChatMessage.mock.calls[0][0].tableData;
    expect(savedData.sheet_0.content[2][1]).toBe('collectA');
    expect(savedData.sheet_1.content[2][1]).toBe('collectB');
    expect(savedData.sheet_0.content[1][1]).toBe('base-a');
    expect(savedData.sheet_1.content[1][1]).toBe('base-b');
  });

  it('targetSheetKeys 重叠时直接失败，不解析不保存不触发 flush', async () => {
    const baseSnapshot = {
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
    };
    const responses = [
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_0</tableEdit>', tableEditText: 'sheet_0', job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
      { success: true, attempt: 1, aiResponse: '<tableEdit>sheet_0 again</tableEdit>', tableEditText: 'sheet_0 again', job: { groupKey: 'b', groupId: 2, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('targetSheetKeys');
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mockSaveIndependentTable).not.toHaveBeenCalled();
    expect(mockEnqueueSummaryVectorIndexFlush).not.toHaveBeenCalled();
    expect(mockUpdateReadableLorebookEntry).not.toHaveBeenCalled();
  });

  it('SQL 模式下部分表无反馈时，仍用模板结构与基础数据初始化缺失表', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, getEffectiveSeedRowsForSheet_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    mockChatArrayForSeedStage.push({ is_user: false, mes: '开场白' }, { is_user: true, mes: '第一条用户消息' });
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value'], ['1', 'tpl-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: 'CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value'], ['1', 'tpl-b']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any);
    vi.mocked(getEffectiveSeedRowsForSheet_ACU).mockImplementation((sheetKey: string) => sheetKey === 'sheet_1' ? [['1', 'tpl-b']] : []);

    const baseSnapshot = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>", tableEditText: "INSERT INTO inventory VALUES (2, 'sql-a');", job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0', 'sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0']);
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    const savePayload = mockPersistTablesToChatMessage.mock.calls[0][0];
    expect(savePayload.targetSheetKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(savePayload.tableData.sheet_0.content).toEqual([['row_id', 'value'], ['2', 'sql-a']]);
    expect(savePayload.tableData.sheet_1.content).toEqual([['row_id', 'value'], ['1', 'tpl-b']]);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式下模板无基础数据时，缺失表仍以表头空表落盘', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, getEffectiveSeedRowsForSheet_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: 'CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any);
    vi.mocked(getEffectiveSeedRowsForSheet_ACU).mockReturnValue([] as any);

    const baseSnapshot = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>", tableEditText: "INSERT INTO inventory VALUES (2, 'sql-a');", job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0', 'sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0']);
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    const savePayload = mockPersistTablesToChatMessage.mock.calls[0][0];
    expect(savePayload.targetSheetKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(savePayload.tableData.sheet_1.content).toEqual([['row_id', 'value']]);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式下已有运行数据的表不重复灌入模板基础数据，也不扩大 targetSheetKeys', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, getEffectiveSeedRowsForSheet_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value'], ['1', 'tpl-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: 'CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value'], ['1', 'tpl-b']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any);
    vi.mocked(getEffectiveSeedRowsForSheet_ACU).mockImplementation((sheetKey: string) => sheetKey === 'sheet_1' ? [['1', 'tpl-b']] : []);

    const baseSnapshot = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: 'CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value'], ['9', 'existing-b']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>", tableEditText: "INSERT INTO inventory VALUES (2, 'sql-a');", job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0', 'sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0']);
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    const savePayload = mockPersistTablesToChatMessage.mock.calls[0][0];
    expect(savePayload.targetSheetKeys).toEqual(['sheet_0']);
    expect(savePayload.tableData.sheet_1.content).toEqual([['row_id', 'value'], ['9', 'existing-b']]);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式下缺失表 seedRows 的 row_id 会在首次初始化时稳定化后再落盘', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU, getEffectiveSeedRowsForSheet_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    mockChatArrayForSeedStage.push({ is_user: false, mes: '开场白' }, { is_user: true, mes: '第一条用户消息' });
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value'], ['1', 'tpl-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: 'CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any);
    vi.mocked(getEffectiveSeedRowsForSheet_ACU).mockImplementation((sheetKey: string) => sheetKey === 'sheet_1' ? [[null, 'tpl-b'], ['', 'tpl-c']] as any : []);

    const baseSnapshot = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' }, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any;
    const responses = [
      { success: true, attempt: 1, aiResponse: "<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>", tableEditText: "INSERT INTO inventory VALUES (2, 'sql-a');", job: { groupKey: 'a', groupId: 1, batchNumber: 1, saveTargetIndex: 3, targetSheetKeys: ['sheet_0', 'sheet_1'], updateMode: 'auto_standard', requestOptions: null, messagesForContext: [], baseSnapshot, isImportMode: false } },
    ];

    mockCurrentJsonTableData = JSON.parse(JSON.stringify(baseSnapshot));
    const result = await applyUnifiedGroupFillResponses_ACU(responses as any, baseSnapshot, { saveTargetIndex: 3, updateMode: 'auto_standard', isImportMode: false });

    expect(result.success).toBe(true);
    const savePayload = mockPersistTablesToChatMessage.mock.calls[0][0];
    expect(savePayload.targetSheetKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(savePayload.tableData.sheet_1.content).toEqual([['row_id', 'value'], ['1', 'tpl-b'], ['2', 'tpl-c']]);
    expect(baseSnapshot.sheet_0.content).toEqual([['row_id', 'value']]);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });
});

describe('processGroupedRuntimeChunk_ACU', () => {
  beforeEach(async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    const { disposeStorageProvider } = await import('../../../src/service/table/table-storage-strategy');
    disposeStorageProvider();
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    vi.mocked(isSqliteMode).mockReturnValue(false);
    vi.clearAllMocks();
    // clearAllMocks 只清调用记录，不清 mockResolvedValueOnce 队列；前一用例未消费的响应会污染后续 bucket 测试。
    mockCallCustomOpenAI.mockReset();
    mockPersistTablesToChatMessage.mockReset();
    mockParseAndApplyTableEditsToData.mockReset();
    mockWasStopped = false;
    mockSettings = {
      ...mockSettings,
      autoUpdateTokenThreshold: 0,
      updateBatchSize: 2,
      tableMaxRetries: 1,
      tableApiPresetOverridesByName: {},
    };
    mockCurrentJsonTableData = {
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    };
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockUpdateReadableLorebookEntry.mockResolvedValue(undefined);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 3 });
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('sheet_0')) {
        tableData.sheet_0.content.push(['2', '来自A']);
        return { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 };
      }
      if (aiResponse.includes('sheet_1')) {
        tableData.sheet_1.content.push(['2', '来自B']);
        return { success: true, modifiedKeys: ['sheet_1'], appliedEdits: 1 };
      }
      return { success: false, modifiedKeys: [], appliedEdits: 0 };
    });
  });

  it('空分组直接成功且不调用 AI', async () => {
    const result = await processGroupedRuntimeChunk_ACU([], 'manual_independent');
    expect(result).toEqual({ success: true, failedGroups: [], committedBucketCount: 0 });
    expect(mockPrepareAIInput).not.toHaveBeenCalled();
    expect(mockCallCustomOpenAI).not.toHaveBeenCalled();
  });

  it('同一 bucket 的多组只统一提交一次', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    } as any);
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>sheet_0</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>sheet_1</tableEdit>');

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
      { key: 'group_b', groupId: 1, indices: [1], batchSize: 2, sheetKeys: ['sheet_1'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateReadableLorebookEntry).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSummaryVectorIndexFlush).toHaveBeenCalledTimes(1);
  });

  it('可回放重填只向当前 bucket 的真实 AI 消息和目标表传递 replacement 范围', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户0' },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
    ]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
    } as any);
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>sheet_0</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>sheet_0</tableEdit>');

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1, 3], batchSize: 1, sheetKeys: ['sheet_0'], requestOptions: null },
    ], 'manual_independent', { replaceExistingIncremental: true });

    expect(result).toEqual(expect.objectContaining({ success: true, committedBucketCount: 2 }));
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(2);
    expect(mockPersistTablesToChatMessage.mock.calls[0][0].replaceExistingIncremental).toEqual({
      targetMessageIndices: [1],
      targetSheetKeys: ['sheet_0'],
    });
    expect(mockPersistTablesToChatMessage.mock.calls[1][0].replaceExistingIncremental).toEqual({
      targetMessageIndices: [3],
      targetSheetKeys: ['sheet_0'],
    });
  });

  it('已提交一个 bucket 后用户终止时不启动后续 bucket', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户0' },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复3' },
    ]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');
    mockPersistTablesToChatMessage.mockImplementationOnce(async () => {
      mockWasStopped = true;
      return { saved: true, messageIndex: 1 };
    });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1, 3], batchSize: 1, sheetKeys: ['sheet_0'], requestOptions: null },
    ], 'manual_independent', { replaceExistingIncremental: true });

    expect(result).toEqual(expect.objectContaining({ success: false, aborted: true, committedBucketCount: 1 }));
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(1);
  });

  it('grouped 手动路径会向 onProgress 转发 AI 调用进度', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
    } as any);
    mockCallCustomOpenAI.mockResolvedValueOnce('<tableEdit>sheet_0</tableEdit>');
    const onProgress = vi.fn();

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
    ], 'manual_independent', { onProgress });

    expect(result.success).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'calling_ai',
      attempt: 1,
      maxRetries: 1,
      currentBatch: 1,
      totalBatches: 1,
    }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'saving',
      currentBatch: 1,
      totalBatches: 1,
    }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'complete',
      currentBatch: 1,
      totalBatches: 1,
    }));
  });

  it('连续 bucket 使用运行时快照作为下一次 prompt 基底，不从聊天历史回放', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const chat = [
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: 'a2' },
    ];
    vi.mocked(getChatArray_ACU).mockReturnValue(chat as any);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '纪要表', content: [['row_id', '内容']] },
    } as any);
    const promptBaseRows: any[][][] = [];
    mockPrepareAIInput.mockImplementation(async (_messages: any, _mode: string, _keys: string[] | null, options: any) => {
      promptBaseRows.push(JSON.parse(JSON.stringify(options.tableData.sheet_0.content)));
      return { tableDataText: '模拟数据' };
    });
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>第一层纪要</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>第二层纪要</tableEdit>');
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('第一层纪要')) {
        tableData.sheet_0.content.push(['AM0001', '第一层纪要']);
      } else if (aiResponse.includes('第二层纪要')) {
        tableData.sheet_0.content.push(['AM0002', '第二层纪要']);
      }
      return { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 };
    });
    mockPersistTablesToChatMessage.mockImplementation(async (options: any) => {
      const target = chat[options.targetMessageIndex] as any;
      target.TavernDB_ACU_IsolatedData = {
        '': {
          independentData: JSON.parse(JSON.stringify(options.tableData)),
          modifiedKeys: options.trackingSheetKeys || [],
          updateGroupKeys: options.updateGroupKeys || [],
          _acu_storage_mode: 'checkpoint',
        },
      };
      return { saved: true, messageIndex: options.targetMessageIndex };
    });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'summary', groupId: 0, indices: [1, 3], batchSize: 1, sheetKeys: ['sheet_0'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(promptBaseRows).toHaveLength(2);
    expect(promptBaseRows[0]).toEqual([['row_id', '值'], ['1', 'base-a']]);
    expect(promptBaseRows[1]).toEqual([['row_id', '值'], ['1', 'base-a'], ['AM0001', '第一层纪要']]);
  });


  it('手动重填多 bucket 使用固定 mergeBaseMaxMessageIndex，不把前一 bucket 新写增量带入后续基底', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const chat = Array.from({ length: 31 }, (_, index) => ({ is_user: false, mes: `AI ${index}` })) as any[];
    const makeRows = (count: number) => [
      ['row_id', '值'],
      ...Array.from({ length: count }, (_unused, rowIndex) => [`${rowIndex + 1}`, `第${rowIndex + 1}层旧值`]),
    ];
    chat[20].TavernDB_ACU_IsolatedData = {
      '': {
        _acu_storage_version: 2,
        storageFrame: {
          version: 2,
          checkpoint: {
            kind: 'full',
            createdAt: 20,
            reason: 'compaction',
            data: {
              mate: { type: 'acu' },
              sheet_0: { name: '测试表', content: makeRows(20) },
            },
          },
          logEntries: [],
        },
      },
    };
    for (let index = 21; index <= 30; index += 1) {
      chat[index].TavernDB_ACU_IsolatedData = {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            logEntries: [{
              seq: 1,
              entryId: `old-${index}`,
              createdAt: index,
              source: 'manual_fill',
              targetMessageIndex: index,
              aiFloor: index + 1,
              filledSheetKeys: ['sheet_0'],
              changedSheetKeys: ['sheet_0'],
              groupKeys: ['sheet_0'],
              operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: `${index}`, cells: [`${index}`, `第${index}层旧值`] }],
              writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
            }],
          },
        },
      };
    }
    vi.mocked(getChatArray_ACU).mockReturnValue(chat as any);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表', content: [['row_id', '值']], updateConfig: { groupId: 0 } },
    } as any);
    const promptBaseRows: any[][][] = [];
    mockPrepareAIInput.mockImplementation(async (_messages: any, _mode: string, _keys: string[] | null, options: any) => {
      promptBaseRows.push(JSON.parse(JSON.stringify(options.tableData.sheet_0.content)));
      return { tableDataText: '模拟数据' };
    });
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>第27-28层新值</tableEdit>')
      .mockResolvedValueOnce('<tableEdit>第29-30层新值</tableEdit>');
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('27-28')) tableData.sheet_0.content.push(['27', '第27层新值'], ['28', '第28层新值']);
      if (aiResponse.includes('29-30')) tableData.sheet_0.content.push(['29', '第29层新值'], ['30', '第30层新值']);
      return { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 2 };
    });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'manual_refill', groupId: 0, indices: [27, 28, 29, 30], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null, mergeBaseMaxMessageIndex: 26 },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(promptBaseRows).toHaveLength(2);
    expect(promptBaseRows[0]).toHaveLength(27);
    expect(promptBaseRows[1]).toEqual(promptBaseRows[0]);
    expect(promptBaseRows[1].some(row => row[0] === '27' || row[0] === '28' || row[0] === '29' || row[0] === '30')).toBe(false);
  });

  it('SQL 模式下不再早退，而是完成 grouped 统一提交', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    const inventoryDDL = `CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    const questDDL = `CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: inventoryDDL }, content: [['row_id', 'value'], ['1', 'base-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: questDDL }, content: [['row_id', 'value'], ['1', 'base-b']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any);
    mockCurrentJsonTableData = JSON.parse(JSON.stringify(vi.mocked(parseTableTemplateJson_ACU).getMockImplementation()?.() || {}));
    mockCallCustomOpenAI
      .mockResolvedValueOnce("<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>")
      .mockResolvedValueOnce("<tableEdit>INSERT INTO quest_log VALUES (2, 'sql-b');</tableEdit>");

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
      { key: 'group_b', groupId: 1, indices: [1], batchSize: 2, sheetKeys: ['sheet_1'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(result.failedGroups).toEqual([]);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQLite 分组混合 SQL/非 SQL 时只重试非 SQL 组，成功 SQL 组不重试', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    mockSettings.tableMaxRetries = 2;
    const inventoryDDL = `CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    const questDDL = `CREATE TABLE quest_log (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: inventoryDDL }, content: [['row_id', 'value'], ['1', 'base-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
      sheet_1: { uid: 'quest_log', name: '表B', sourceData: { ddl: questDDL }, content: [['row_id', 'value'], ['1', 'base-b']], updateConfig: {}, exportConfig: {}, orderNo: 1 },
    } as any);
    mockCurrentJsonTableData = JSON.parse(JSON.stringify(vi.mocked(parseTableTemplateJson_ACU).getMockImplementation()?.() || {}));
    const capturedTableDataTexts: string[] = [];
    mockPrepareAIInput.mockImplementation(async () => ({ tableDataText: '模拟数据' }));
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      capturedTableDataTexts.push(dynamicContent.tableDataText);
      if (mockCallCustomOpenAI.mock.calls.length === 1) return "<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>";
      if (mockCallCustomOpenAI.mock.calls.length === 2) return '<tableEdit>insertRow(1,{"0":"dsl-b"})</tableEdit>';
      return "<tableEdit>INSERT INTO quest_log VALUES (2, 'sql-b');</tableEdit>";
    });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
      { key: 'group_b', groupId: 1, indices: [1], batchSize: 2, sheetKeys: ['sheet_1'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(result.failedGroups).toEqual([]);
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(3);
    expect(capturedTableDataTexts[2]).toContain('UNIFIED_GROUP_ERROR_FEEDBACK');
    expect(capturedTableDataTexts[2]).toContain('未返回 SQL tableEdit');
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('当前 bucket 失败后停止调度，后续 bucket 不调用 AI 或写盘', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复1' }, { is_user: true }, { is_user: false, mes: 'AI回复2' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    } as any);
    mockCallCustomOpenAI
      .mockResolvedValueOnce('无效响应')
      .mockResolvedValueOnce('<tableEdit>sheet_1</tableEdit>');

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 1, sheetKeys: ['sheet_0'], requestOptions: null },
      { key: 'group_b', groupId: 1, indices: [3], batchSize: 1, sheetKeys: ['sheet_1'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(false);
    expect(result.failedGroups).toContain('group_a');
    expect(result.failedGroups).not.toContain('group_b');
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('统一提交失败后会把错误反馈注入下一轮 prompt 并重试成功', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
    } as any);
    mockSettings.tableMaxRetries = 2;

    const capturedTableDataTexts: string[] = [];
    mockPrepareAIInput.mockImplementation(async () => ({ tableDataText: '模拟数据' }));
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      capturedTableDataTexts.push(dynamicContent.tableDataText);
      return '<tableEdit>sheet_0</tableEdit>';
    });

    mockPersistTablesToChatMessage
      .mockResolvedValueOnce({ saved: false, error: 'group group_a 解析或应用失败' })
      .mockResolvedValueOnce({ saved: true, messageIndex: 1 });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(capturedTableDataTexts).toHaveLength(2);
    expect(capturedTableDataTexts[1]).toContain('UNIFIED_GROUP_ERROR_FEEDBACK');
    expect(capturedTableDataTexts[1]).toContain('group group_a 解析或应用失败');
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(2);
  });

  it('统一提交持续失败到耗尽重试时整 bucket 失败且不落盘', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    } as any);
    mockSettings.tableMaxRetries = 2;
    mockCallCustomOpenAI
      .mockResolvedValue('<tableEdit>sheet_0</tableEdit>')
      .mockResolvedValue('<tableEdit>sheet_1</tableEdit>');
    mockParseAndApplyTableEditsToData.mockReturnValue({ success: false, modifiedKeys: [], appliedEdits: 0 });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
      { key: 'group_b', groupId: 1, indices: [1], batchSize: 2, sheetKeys: ['sheet_1'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(false);
    expect(result.failedGroups).toEqual(expect.arrayContaining(['group_a', 'group_b']));
    expect(result.error).toContain('统一提交在 2 次尝试后仍失败');
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(4);
  });

  it('空 tableEdit 视为合法无更新且不重试同 bucket 的其他组', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    } as any);
    mockSettings.tableMaxRetries = 2;
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>   </tableEdit>')
      .mockResolvedValueOnce('<tableEdit>sheet_1</tableEdit>');
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      if (aiResponse.includes('sheet_1')) {
        tableData.sheet_1.content.push(['2', '来自B']);
        return { success: true, modifiedKeys: ['sheet_1'], appliedEdits: 1 };
      }
      return { success: true, modifiedKeys: [], appliedEdits: 0 };
    });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
      { key: 'group_b', groupId: 1, indices: [1], batchSize: 2, sheetKeys: ['sheet_1'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(result.failedGroups).toEqual([]);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSheetKeys: ['sheet_1'],
      updateGroupKeys: ['sheet_0', 'sheet_1'],
      trackingSheetKeys: ['sheet_1'],
      targetMessageIndex: 1,
    }));
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(2);
  });


  it('首次初始化时 grouped 主路径全量保存但只追踪实质修改表', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    mockCheckIfFirstTimeInit.mockResolvedValue(true);
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    } as any);
    mockSettings.tableMaxRetries = 2;
    mockCallCustomOpenAI.mockResolvedValueOnce('<tableEdit>sheet_0</tableEdit>');
    mockParseAndApplyTableEditsToData.mockImplementation((aiResponse: string, tableData: any) => {
      tableData.sheet_0.content.push(['2', '来自A']);
      return aiResponse.includes('sheet_0')
        ? { success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 }
        : { success: false, modifiedKeys: [], appliedEdits: 0 };
    });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 1, sheetKeys: ['sheet_0'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSheetKeys: ['sheet_0', 'sheet_1'],
      updateGroupKeys: ['sheet_0'],
      trackingSheetKeys: ['sheet_0'],
    }));
  });

  it('非空 tableEdit 未形成实质性操作时仍视为成功但不登记参与表', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '表A', content: [['row_id', '值'], ['1', 'base-a']] },
      sheet_1: { name: '表B', content: [['row_id', '值'], ['1', 'base-b']] },
    } as any);
    mockSettings.tableMaxRetries = 2;

    const capturedTableDataTexts: string[] = [];
    mockPrepareAIInput.mockImplementation(async () => ({ tableDataText: '模拟数据' }));
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      capturedTableDataTexts.push(dynamicContent.tableDataText);
      return dynamicContent.tableDataText.includes('sheet_1') ? '<tableEdit>sheet_1</tableEdit>' : '<tableEdit>sheet_0</tableEdit>';
    });
    mockParseAndApplyTableEditsToData.mockReturnValue({ success: true, modifiedKeys: [], appliedEdits: 0 });

    const result = await processGroupedRuntimeChunk_ACU([
      { key: 'group_a', groupId: 0, indices: [1], batchSize: 2, sheetKeys: ['sheet_0'], requestOptions: null },
      { key: 'group_b', groupId: 1, indices: [1], batchSize: 2, sheetKeys: ['sheet_1'], requestOptions: null },
    ], 'manual_independent');

    expect(result.success).toBe(true);
    expect(result.failedGroups).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(capturedTableDataTexts).toHaveLength(2);
    expect(capturedTableDataTexts[0]).not.toContain('UNIFIED_GROUP_ERROR_FEEDBACK');
    expect(capturedTableDataTexts[1]).not.toContain('UNIFIED_GROUP_ERROR_FEEDBACK');
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(2);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSheetKeys: [],
      updateGroupKeys: ['sheet_0', 'sheet_1'],
      trackingSheetKeys: [],
    }));
  });


  it('manual native 路径走 grouped helper 而不是 legacy processBatch', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(false);
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>sheet_0</tableEdit>');

    const legacyProcessBatch = vi.fn().mockResolvedValue({ success: true });
    const refreshData = vi.fn().mockResolvedValue(undefined);
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], legacyProcessBatch, refreshData);

    expect(result.success).toBe(true);
    expect(legacyProcessBatch).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
  });

  it('manual native 路径在 grouped helper 失败时返回失败且不落盘', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(false);
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    mockSettings.tableMaxRetries = 1;
    mockCallCustomOpenAI.mockResolvedValue('无效响应');

    const refreshData = vi.fn().mockResolvedValue(undefined);
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], vi.fn().mockResolvedValue({ success: true }), refreshData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('填表在 1 次尝试后仍失败');
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(refreshData).toHaveBeenCalled();
  });

  it('manual SQL 路径走 grouped unified helper 而不是 legacy processBatch', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    const inventoryDDL = `CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    vi.mocked(getChatArray_ACU).mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } },
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: inventoryDDL }, content: [['row_id', 'value'], ['1', 'base-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any);
    mockCurrentJsonTableData = {
      sheet_0: { uid: 'inventory', name: '表A', sourceData: { ddl: inventoryDDL }, content: [['row_id', 'value'], ['1', 'base-a']], updateConfig: {}, exportConfig: {}, orderNo: 0 },
    } as any;
    mockCallCustomOpenAI.mockResolvedValueOnce("<tableEdit>INSERT INTO inventory VALUES (2, 'sql-a');</tableEdit>");

    const legacyProcessBatch = vi.fn().mockResolvedValue({ success: true });
    const refreshData = vi.fn().mockResolvedValue(undefined);

    try {
      const result = await orchestrateManualUpdate_ACU(['sheet_0'], legacyProcessBatch, refreshData);

      expect(result.success).toBe(true);
      expect(legacyProcessBatch).not.toHaveBeenCalled();
      expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
      expect(mockParseAndApplyTableEditsToData).not.toHaveBeenCalled();
      const savedData = mockPersistTablesToChatMessage.mock.calls[0][0].tableData;
      expect(savedData.sheet_0.content).toEqual([['row_id', 'value'], ['1', 'base-a'], ['2', 'sql-a']]);
    } finally {
      vi.mocked(isSqliteMode).mockReturnValue(false);
    }
  });
});

describe('orchestrateManualCatchUp_ACU', () => {
  function createCatchUpChat(lastFilledA: number, lastFilledB: number) {
    return [
      { is_user: true, mes: '用户0' },
      {
        is_user: false,
        mes: 'AI回复1',
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                reason: 'init',
                createdAt: 1,
                data: {
                  mate: { type: 'acu' },
                  sheet_a: { name: '表A', content: [['row_id', '值']] },
                  sheet_b: { name: '表B', content: [['row_id', '值']] },
                },
                scheduleSummary: {
                  sheet_a: { lastFilledAiFloor: lastFilledA },
                  sheet_b: { lastFilledAiFloor: lastFilledB },
                },
              },
              logEntries: [],
            },
          },
        },
      },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复2' },
      { is_user: true, mes: '用户4' },
      { is_user: false, mes: 'AI回复3' },
    ];
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWasStopped = false;
    mockIsAutoUpdating = false;
    mockSettings = {
      ...mockSettings,
      apiMode: 'custom',
      apiConfig: { useMainApi: true, url: '', model: '' },
      skipUpdateFloors: 0,
      updateBatchSize: 1,
      tableMaxRetries: 1,
      tableApiPresetOverridesByName: {},
    };
    mockCurrentJsonTableData = {
      mate: { type: 'acu' },
      sheet_a: { name: '表A', updateConfig: { groupId: 0 }, content: [['row_id', '值']] },
      sheet_b: { name: '表B', updateConfig: { groupId: 0 }, content: [['row_id', '值']] },
    };
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue(JSON.parse(JSON.stringify(mockCurrentJsonTableData)));
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI
      .mockResolvedValueOnce('<tableEdit>sheet_a</tableEdit>')
      .mockResolvedValue('<tableEdit>sheet_a sheet_b</tableEdit>');
    mockParseAndApplyTableEditsToData.mockImplementation((response: string, data: any) => {
      const modifiedKeys = Object.keys(data).filter(
        key => key.startsWith('sheet_') && response.includes(key),
      );
      return {
        success: true,
        modifiedKeys,
        appliedEdits: modifiedKeys.length,
      };
    });
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 5 });
  });

  it('按已提交前沿切成 A 与 A+B 两个 wave，并写入精确 replacement 和 committed progress', async () => {
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(1, 2) as any);
    const refreshData = vi.fn().mockResolvedValue({ degraded: false });

    const result = await orchestrateManualCatchUp_ACU(['sheet_a', 'sheet_b'], refreshData);

    expect(result).toEqual(expect.objectContaining({ success: true, outcome: 'complete', committedBucketCount: 2 }));
    expect(result.catchUpPlan?.waves.map(wave => ({
      start: wave.startAiFloor,
      end: wave.endAiFloor,
      sheets: wave.sheetKeys,
    }))).toEqual([
      { start: 2, end: 2, sheets: ['sheet_a'] },
      { start: 3, end: 3, sheets: ['sheet_a', 'sheet_b'] },
    ]);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(3);
    expect(mockPersistTablesToChatMessage.mock.calls[0][0]).toEqual(expect.objectContaining({
      targetMessageIndex: 3,
      replaceExistingIncremental: { targetMessageIndices: [3], targetSheetKeys: ['sheet_a'] },
      manualRefillProgress: expect.objectContaining({
        version: 2,
        mode: 'catch_up',
        status: 'committed',
        waveIndex: 0,
        bucketIndex: 0,
        totalBuckets: 2,
        completedSheetMessageIndexByKey: { sheet_a: 3 },
      }),
    }));
    expect(mockPersistTablesToChatMessage.mock.calls[1][0]).toEqual(expect.objectContaining({
      targetMessageIndex: 5,
      replaceExistingIncremental: { targetMessageIndices: [5], targetSheetKeys: ['sheet_a', 'sheet_b'] },
      manualRefillProgress: expect.objectContaining({
        version: 2,
        mode: 'catch_up',
        status: 'committed',
        waveIndex: 1,
        bucketIndex: 1,
        totalBuckets: 2,
        completedSheetMessageIndexByKey: { sheet_a: 5, sheet_b: 5 },
      }),
    }));
    const completeProgressCall = mockPersistTablesToChatMessage.mock.calls.find(call => (
      call[0]?.manualRefillProgress?.status === 'complete'
    ));
    expect(completeProgressCall?.[0]).toEqual(expect.objectContaining({
      targetMessageIndex: 5,
      targetSheetKeys: [],
      updateGroupKeys: [],
      trackingSheetKeys: [],
      operations: [],
      strictSave: true,
      manualRefillProgress: expect.objectContaining({
        completedSheetMessageIndexByKey: { sheet_a: 5, sheet_b: 5 },
      }),
    }));
    expect(mockUpdateReadableLorebookEntry).not.toHaveBeenCalled();
    expect(refreshData).toHaveBeenCalledTimes(1);
  });

  it('全部已追平时返回 no_work，且不调用 AI、保存或刷新', async () => {
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(3, 3) as any);
    const refreshData = vi.fn();

    const result = await orchestrateManualCatchUp_ACU(['sheet_a', 'sheet_b'], refreshData);

    expect(result).toEqual(expect.objectContaining({ success: true, outcome: 'no_work', committedBucketCount: 0 }));
    expect(mockCallCustomOpenAI).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(refreshData).not.toHaveBeenCalled();
  });

  it('skipUpdateFloors 排除全部可用楼层时返回 no_work，且不调用 AI、保存或刷新', async () => {
    mockSettings.skipUpdateFloors = 3;
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(0, 0) as any);
    const refreshData = vi.fn();

    const result = await orchestrateManualCatchUp_ACU(['sheet_a', 'sheet_b'], refreshData);

    expect(result).toEqual(expect.objectContaining({ success: true, outcome: 'no_work', committedBucketCount: 0 }));
    expect(mockCallCustomOpenAI).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(refreshData).not.toHaveBeenCalled();
  });

  it('run-scoped catch-up 忽略其他任务的全局停止标志且不清零该标志', async () => {
    mockWasStopped = true;
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(2, 3) as any);
    const refreshData = vi.fn().mockResolvedValue({ degraded: false });

    const result = await orchestrateManualCatchUp_ACU(
      ['sheet_a'],
      refreshData,
      { abortController: new AbortController() },
    );

    expect(result).toEqual(expect.objectContaining({ success: true, outcome: 'complete', committedBucketCount: 1 }));
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(1);
    expect(mockWasStopped).toBe(true);
  });

  it('最终刷新降级时保留已提交数据并返回 sync_pending', async () => {
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(2, 3) as any);

    const result = await orchestrateManualCatchUp_ACU(['sheet_a'], vi.fn().mockResolvedValue({ degraded: true }));

    expect(result).toEqual(expect.objectContaining({ success: true, outcome: 'sync_pending', committedBucketCount: 1 }));
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(2);
    const syncPendingCall = mockPersistTablesToChatMessage.mock.calls.find(call => (
      call[0]?.manualRefillProgress?.status === 'sync_pending'
    ));
    expect(syncPendingCall?.[0]).toEqual(expect.objectContaining({
      operations: [],
      targetSheetKeys: [],
      strictSave: true,
      manualRefillProgress: expect.objectContaining({
        completedSheetMessageIndexByKey: { sheet_a: 5 },
      }),
    }));
  });

  it('首个 wave 提交后终止时不启动下一 wave', async () => {
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(1, 2) as any);
    const abortController = new AbortController();
    const refreshData = vi.fn().mockResolvedValue({ degraded: false });
    mockPersistTablesToChatMessage.mockImplementationOnce(async () => {
      abortController.abort();
      return { saved: true, messageIndex: 3 };
    });

    const result = await orchestrateManualCatchUp_ACU(['sheet_a', 'sheet_b'], refreshData, { abortController });

    expect(result).toEqual(expect.objectContaining({ success: false, outcome: 'stopped', committedBucketCount: 1 }));
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(2);
    const stoppedCall = mockPersistTablesToChatMessage.mock.calls.find(call => (
      call[0]?.manualRefillProgress?.status === 'stopped'
    ));
    expect(stoppedCall?.[0]).toEqual(expect.objectContaining({
      operations: [],
      targetSheetKeys: [],
      strictSave: true,
      manualRefillProgress: expect.objectContaining({
        completedSheetMessageIndexByKey: { sheet_a: 3 },
        lastError: '手动追平已终止。',
      }),
    }));
    expect(mockCallCustomOpenAI).toHaveBeenCalledTimes(1);
    expect(refreshData).toHaveBeenCalledTimes(1);
  });

  it('首个 wave 提交后第二个 wave 保存失败时保留已提交计数并最终刷新', async () => {
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(1, 2) as any);
    mockPersistTablesToChatMessage
      .mockResolvedValueOnce({ saved: true, messageIndex: 3 })
      .mockResolvedValueOnce({ saved: false, error: 'save failed' });
    const refreshData = vi.fn();

    const result = await orchestrateManualCatchUp_ACU(['sheet_a', 'sheet_b'], refreshData);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      committedBucketCount: 1,
      error: expect.stringContaining('save failed'),
    }));
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(3);
    expect(mockPersistTablesToChatMessage.mock.calls[0][0].manualRefillProgress).toEqual(expect.objectContaining({
      bucketIndex: 0,
      completedSheetMessageIndexByKey: { sheet_a: 3 },
    }));
    const failedCall = mockPersistTablesToChatMessage.mock.calls.find(call => (
      call[0]?.manualRefillProgress?.status === 'failed'
    ));
    expect(failedCall?.[0]).toEqual(expect.objectContaining({
      operations: [],
      targetSheetKeys: [],
      strictSave: true,
      manualRefillProgress: expect.objectContaining({
        completedSheetMessageIndexByKey: { sheet_a: 3 },
        lastError: expect.stringContaining('save failed'),
      }),
    }));
    expect(failedCall?.[0].manualRefillProgress.completedSheetMessageIndexByKey).not.toHaveProperty('sheet_b');
    expect(refreshData).toHaveBeenCalledTimes(1);
  });

  it('主执行失败且终态严格保存也失败时返回组合错误并释放运行锁', async () => {
    mockGetChatArray_ACU.mockReturnValue(createCatchUpChat(1, 2) as any);
    mockPersistTablesToChatMessage
      .mockResolvedValueOnce({ saved: true, messageIndex: 3 })
      .mockResolvedValueOnce({ saved: false, error: 'primary save failed' })
      .mockResolvedValueOnce({ saved: false, error: 'terminal strict save failed' });
    const refreshData = vi.fn().mockResolvedValue({ degraded: false });

    const result = await orchestrateManualCatchUp_ACU(['sheet_a', 'sheet_b'], refreshData);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      committedBucketCount: 1,
      error: expect.stringContaining('primary save failed'),
    }));
    expect(result.error).toContain('终态进度保存失败：terminal strict save failed');
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(3);
    expect(mockPersistTablesToChatMessage.mock.calls[2][0]).toEqual(expect.objectContaining({
      strictSave: true,
      operations: [],
      manualRefillProgress: expect.objectContaining({ status: 'failed' }),
    }));
    expect(refreshData).toHaveBeenCalledTimes(1);
    expect(mockIsAutoUpdating).toBe(false);
  });
});
