/**
 * tests/service/runtime/plot-runtime/plot-history-preset.test.ts
 * 剧情推进预设加载/历史记录读写 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, mockGetChatArray, mockSaveChatToHost, mockSaveSettings, mockGetCurrentChatPlotScopeState, mockSetCurrentChatPlotScopeState, mockBuildChatPlotScopeState, mockGetCurrentRuntimePresetName, mockFindPresetByName, mockNormalizePresetSelection, mockIsDefaultPresetSelection, mockGetPresetBinding, mockSetPresetBinding, mockClearPresetBinding, mockEnsurePresetBindingsStore, mockEnsurePlotTasksCompat, mockApplyPresetToSettings, mockResetPlotSettingsToDefault, mockSyncEditableState, mockReplaceWithSnapshot, mockGetGlobalRevision, mockTempPlotToSave, mockSetTempPlotToSave, mockPlanningGuard, mockCurrentChatFileIdentifier } = vi.hoisted(() => ({
  mockSettings: { plotSettings: { enabled: true, lastUsedPresetName: '', promptPresets: [] } } as any,
  mockGetChatArray: vi.fn(() => []),
  mockSaveChatToHost: vi.fn(),
  mockSaveSettings: vi.fn(),
  mockGetCurrentChatPlotScopeState: vi.fn(() => null),
  mockSetCurrentChatPlotScopeState: vi.fn(),
  mockBuildChatPlotScopeState: vi.fn(() => null),
  mockGetCurrentRuntimePresetName: vi.fn(() => ''),
  mockFindPresetByName: vi.fn(() => null),
  mockNormalizePresetSelection: vi.fn((v: string) => v || ''),
  mockIsDefaultPresetSelection: vi.fn((v: string) => !v),
  mockGetPresetBinding: vi.fn(() => null),
  mockSetPresetBinding: vi.fn(),
  mockClearPresetBinding: vi.fn(() => false),
  mockEnsurePresetBindingsStore: vi.fn(),
  mockEnsurePlotTasksCompat: vi.fn(),
  mockApplyPresetToSettings: vi.fn(),
  mockResetPlotSettingsToDefault: vi.fn(),
  mockSyncEditableState: vi.fn(),
  mockReplaceWithSnapshot: vi.fn(),
  mockGetGlobalRevision: vi.fn(() => 0),
  mockTempPlotToSave: null as any,
  mockSetTempPlotToSave: vi.fn(),
  mockPlanningGuard: { inProgress: false, ignoreNextGenerationEndedCount: 0 } as any,
  mockCurrentChatFileIdentifier: 'test-chat',
}));

vi.mock('../../../../src/service/plot/plot-state', () => ({
  currentPlotTaskEditorId_ACU: '',
  _set_currentPlotTaskEditorId_ACU: vi.fn(),
}));

vi.mock('../../../../src/service/runtime/state-manager', () => ({
  settings_ACU: mockSettings,
  currentChatFileIdentifier_ACU: mockCurrentChatFileIdentifier,
  planningGuard_ACU: mockPlanningGuard,
  tempPlotToSave_ACU: mockTempPlotToSave,
  _set_tempPlotToSave_ACU: mockSetTempPlotToSave,
}));

vi.mock('../../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: mockGetChatArray,
  saveChatToHost_ACU: mockSaveChatToHost,
}));

vi.mock('../../../../src/service/settings/settings-service', () => ({
  saveSettings_ACU: mockSaveSettings,
}));

vi.mock('../../../../src/service/template/chat-scope', () => ({
  buildChatPlotScopeStateFromSettings_ACU: mockBuildChatPlotScopeState,
  getCurrentChatPlotScopeState_ACU: mockGetCurrentChatPlotScopeState,
  setCurrentChatPlotScopeState_ACU: mockSetCurrentChatPlotScopeState,
}));

vi.mock('../../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  hashUserInput_ACU: vi.fn((text: string) => `hash_${text}`),
}));

vi.mock('../../../../src/service/plot/plot-logic', () => ({
  applyPlotPresetToSettings_ACU: mockApplyPresetToSettings,
  clearPlotPresetBindingForChat_ACU: mockClearPresetBinding,
  ensurePlotPresetBindingsStore_ACU: mockEnsurePresetBindingsStore,
  ensurePlotTasksCompat_ACU: mockEnsurePlotTasksCompat,
  findPlotPresetByName_ACU: mockFindPresetByName,
  getCurrentRuntimePlotPresetName_ACU: mockGetCurrentRuntimePresetName,
  getPlotGlobalRevision_ACU: mockGetGlobalRevision,
  getPlotPresetBindingForChat_ACU: mockGetPresetBinding,
  isDefaultPlotPresetSelection_ACU: mockIsDefaultPresetSelection,
  setPlotPresetBindingForChat_ACU: mockSetPresetBinding,
  normalizePlotPresetSelectionValue_ACU: mockNormalizePresetSelection,
  replaceCurrentPlotSettingsWithSnapshot_ACU: mockReplaceWithSnapshot,
  resetPlotSettingsToDefault_ACU: mockResetPlotSettingsToDefault,
  syncCurrentEditablePlotPresetState_ACU: mockSyncEditableState,
}));

import {
  loadPresetAndCleanCharacterData_ACU,
  getPlotFromHistory_ACU,
  savePlotToLatestMessage_ACU,
} from '../../../../src/service/runtime/plot-runtime/plot-history-preset';

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.plotSettings = { enabled: true, lastUsedPresetName: '', promptPresets: [] };
  mockPlanningGuard.inProgress = false;
  mockPlanningGuard.ignoreNextGenerationEndedCount = 0;
  mockGetCurrentChatPlotScopeState.mockReturnValue(null);
  mockGetPresetBinding.mockReturnValue(null);
  mockFindPresetByName.mockReturnValue(null);
});

// ═══ loadPresetAndCleanCharacterData_ACU ═══
describe('loadPresetAndCleanCharacterData_ACU', () => {
  it('无 plotSettings 时直接返回', async () => {
    mockSettings.plotSettings = null;
    await loadPresetAndCleanCharacterData_ACU();
    expect(mockEnsurePlotTasksCompat).not.toHaveBeenCalled();
  });

  it('有 chatScopeState 快照时应用快照', async () => {
    mockGetCurrentChatPlotScopeState.mockReturnValue({ snapshot: { prompts: [] } });
    await loadPresetAndCleanCharacterData_ACU();
    expect(mockReplaceWithSnapshot).toHaveBeenCalled();
    expect(mockSaveSettings).toHaveBeenCalled();
  });

  it('有全局预设时应用全局预设', async () => {
    mockSettings.plotSettings.lastUsedPresetName = '预设A';
    mockNormalizePresetSelection.mockReturnValue('预设A');
    mockFindPresetByName.mockReturnValue({ name: '预设A', prompts: [] });
    await loadPresetAndCleanCharacterData_ACU();
    expect(mockApplyPresetToSettings).toHaveBeenCalled();
    expect(mockSyncEditableState).toHaveBeenCalled();
  });

  it('全局预设不存在时回退到默认', async () => {
    mockSettings.plotSettings.lastUsedPresetName = '不存在的预设';
    mockNormalizePresetSelection.mockReturnValue('不存在的预设');
    mockFindPresetByName.mockReturnValue(null);
    await loadPresetAndCleanCharacterData_ACU();
    expect(mockResetPlotSettingsToDefault).toHaveBeenCalled();
  });

  it('有旧绑定且可迁移时写回聊天预设绑定', async () => {
    mockSettings.plotSettings.lastUsedPresetName = '预设A';
    // normalizePresetSelection 第一次调用返回全局预设名，第二次返回绑定预设名
    mockNormalizePresetSelection.mockImplementation((v: string) => v || '');
    mockGetPresetBinding.mockReturnValue({ presetName: '预设B', isExplicit: true, source: 'user' });
    // findPlotPresetByName: 全局预设A不存在，绑定预设B存在
    mockFindPresetByName.mockImplementation((name: string) => {
      if (name === '预设B') return { name: '预设B', prompts: [] };
      return null;
    });
    mockBuildChatPlotScopeState.mockReturnValue({ snapshot: {} });
    await loadPresetAndCleanCharacterData_ACU();
    expect(mockApplyPresetToSettings).toHaveBeenCalled();
    expect(mockSetPresetBinding).toHaveBeenCalledWith('test-chat', '预设B', {
      source: 'user',
      isExplicit: true,
    });
    expect(mockClearPresetBinding).not.toHaveBeenCalled();
  });
});

// ═══ getPlotFromHistory_ACU ═══
describe('getPlotFromHistory_ACU', () => {
  it('空聊天记录返回空字符串', () => {
    mockGetChatArray.mockReturnValue([]);
    expect(getPlotFromHistory_ACU()).toBe('');
  });

  it('找到匹配预设的 plot 数据', () => {
    mockGetCurrentRuntimePresetName.mockReturnValue('预设A');
    mockGetChatArray.mockReturnValue([
      { is_user: true, qrf_plot: '剧情数据', qrf_plot_preset: '预设A' },
    ]);
    expect(getPlotFromHistory_ACU()).toBe('剧情数据');
  });

  it('无匹配预设时回退到无标签数据', () => {
    mockGetCurrentRuntimePresetName.mockReturnValue('预设A');
    mockGetChatArray.mockReturnValue([
      { is_user: true, qrf_plot: '旧数据', qrf_plot_preset: '' },
    ]);
    expect(getPlotFromHistory_ACU()).toBe('旧数据');
  });

  it('无预设模式下找到任意 plot 数据', () => {
    mockGetCurrentRuntimePresetName.mockReturnValue('');
    mockGetChatArray.mockReturnValue([
      { is_user: true, qrf_plot: '任意数据', qrf_plot_preset: '预设X' },
    ]);
    expect(getPlotFromHistory_ACU()).toBe('任意数据');
  });

  it('无 plot 数据返回空字符串', () => {
    mockGetChatArray.mockReturnValue([
      { is_user: true, mes: '你好' },
      { is_user: false, mes: 'AI回复' },
    ]);
    expect(getPlotFromHistory_ACU()).toBe('');
  });

  it('使用 beforeIndex 限制搜索范围', () => {
    mockGetChatArray.mockReturnValue([
      { is_user: true, qrf_plot: '旧数据' },
      { is_user: true, qrf_plot: '新数据' },
    ]);
    expect(getPlotFromHistory_ACU({ beforeIndex: 1 })).toBe('旧数据');
  });
});

// ═══ savePlotToLatestMessage_ACU ═══
describe('savePlotToLatestMessage_ACU', () => {
  it('planningGuard 进行中时不保存', async () => {
    mockPlanningGuard.inProgress = true;
    mockSetTempPlotToSave.mockClear();
    await savePlotToLatestMessage_ACU();
    expect(mockSetTempPlotToSave).not.toHaveBeenCalled();
  });
  it('ignoreNextGenerationEndedCount > 0 时递减并返回', async () => {
    mockPlanningGuard.inProgress = false;
    mockPlanningGuard.ignoreNextGenerationEndedCount = 2;
    await savePlotToLatestMessage_ACU();
    expect(mockPlanningGuard.ignoreNextGenerationEndedCount).toBe(1);
  });
  it('tempPlotToSave 为空时不保存', async () => {
    mockPlanningGuard.inProgress = false;
    mockPlanningGuard.ignoreNextGenerationEndedCount = 0;
    // tempPlotToSave_ACU 是 null
    await savePlotToLatestMessage_ACU();
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
  });
  it('force=true 时即使 planningGuard 进行中也保存', async () => {
    mockPlanningGuard.inProgress = true;
    mockPlanningGuard.ignoreNextGenerationEndedCount = 0;
    // tempPlotToSave 为 null，所以不会实际保存，但不会因 planningGuard 提前返回
    await savePlotToLatestMessage_ACU(true);
    // 不会因 planningGuard 提前返回，而是因 tempPlotToSave 为空返回
    expect(mockSetTempPlotToSave).not.toHaveBeenCalled();
  });
});
