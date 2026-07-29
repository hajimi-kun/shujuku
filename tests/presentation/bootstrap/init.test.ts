// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  chatChanged: undefined as undefined | ((name: string) => Promise<void>),
  currentChatKey: '',
  api: { chat: [] as any[], chatId: '', eventTypes: { CHAT_CHANGED: 'chat' }, eventSource: { on: vi.fn(), makeLast: vi.fn(), emit: vi.fn() } } as any,
  gate: { lastUserMessageId: 7 as any, lastUserMessageText: 'stale', lastUserMessageAt: 1, lastUserSendIntentAt: 2, lastGeneration: { stale: true } as any },
  resetTakeover: vi.fn(), dispose: vi.fn(), setData: vi.fn(), setTables: vi.fn(), setMessages: vi.fn(), setTotal: vi.fn(), setChat: vi.fn(),
  notify: vi.fn(), resetScript: vi.fn(), loadPreset: vi.fn(), loadMessages: vi.fn(), refresh: vi.fn(),
  preload: vi.fn(), shouldRebuild: vi.fn(), rebuild: vi.fn(), restoreFlush: vi.fn(),
}));

vi.mock('../../../src/shared/host-api', () => ({ SillyTavern_API_ACU: m.api }));
vi.mock('../../../src/shared/env', () => ({ topLevelWindow_ACU: { AutoCardUpdaterAPI: { _notifyTableUpdate: m.notify } } }));
vi.mock('../../../src/presentation/bootstrap/startup', () => ({ addAutoCardMenuItem_ACU: vi.fn() }));
vi.mock('../../../src/presentation/theme/toast', () => ({ showToastr_ACU: vi.fn() }));
vi.mock('../../../src/presentation/triggers/settings-ui-sync', () => ({ attemptToLoadCoreApis_ACU: vi.fn(() => true), handleNewMessageDebounced_ACU: vi.fn() }));
vi.mock('../../../src/service/runtime/helpers-remaining', () => ({ ensureInitialSeedCheckpoint_ACU: vi.fn(), handleChatCompletionReady_ACU: vi.fn(), loadPresetAndCleanCharacterData_ACU: m.loadPreset }));
vi.mock('../../../src/service/runtime/state-manager', () => ({
  newMessageDebounceTimer_ACU: null, _set_newMessageDebounceTimer_ACU: vi.fn(), generationGate_ACU: m.gate,
  get currentChatFileIdentifier_ACU() { return m.currentChatKey; }, markUserSendIntent_ACU: vi.fn(), isProcessing_Plot_ACU: false, isQuietLikeGeneration_ACU: vi.fn(), isRecentUserSendIntent_ACU: vi.fn(), loopState_ACU: { isLooping: false }, recordGenerationContext_ACU: vi.fn(), recordLastUserSend_ACU: vi.fn(), settings_ACU: { plotSettings: {} }, shouldProcessAutoTableUpdateForGenerationEnded_ACU: vi.fn(), shouldProcessPlotForGeneration_ACU: vi.fn(), shouldProcessSummaryVectorIndexForGeneration_ACU: vi.fn(),
  _set_allChatMessages_ACU: m.setMessages, _set_currentChatFileIdentifier_ACU: (value: string) => { m.currentChatKey = value; m.setChat(value); }, _set_currentJsonTableData_ACU: m.setData, _set_independentTableStates_ACU: m.setTables, _set_isProcessing_Plot_ACU: vi.fn(), _set_lastTotalAiMessages_ACU: m.setTotal,
}));
vi.mock('../../../src/service/settings/settings-service', () => ({ applyTemplateScopeForCurrentChat_ACU: vi.fn(), loadSettings_ACU: vi.fn() }));
vi.mock('../../../src/service/worldbook/injection-engine', () => ({ resetScriptStateForNewChat_ACU: m.resetScript }));
vi.mock('../../../src/service/agent/agent-worldbook-takeover', () => ({ resetPlotAgentWorldbookSessionSnapshot_ACU: m.resetTakeover }));
vi.mock('../../../src/service/table/table-storage-strategy', () => ({ reloadStorageProvider: vi.fn(), disposeStorageProvider: m.dispose }));
vi.mock('../../../src/service/table/storage-mode', () => ({ isSqliteMode: vi.fn(() => false) }));
vi.mock('../../../src/service/worldbook/pipeline', () => ({ loadAllChatMessages_ACU: m.loadMessages }));
vi.mock('../../../src/presentation/components/pipeline-ui-helpers', () => ({ refreshMergedDataAndNotifyWithUI_ACU: m.refresh }));

vi.mock('../../../src/shared/defaults-json.js', () => ({ DEFAULT_PLOT_SETTINGS_ACU: { loopSettings: {} } }));
vi.mock('../../../src/shared/utils', () => ({ cleanChatName_ACU: vi.fn((name: string) => name), logDebug_ACU: vi.fn(), logError_ACU: vi.fn(), logWarn_ACU: vi.fn() }));
vi.mock('../../../src/service/plot/plot-logic', () => ({ shouldSkipPlotIntercept_ACU: vi.fn() }));
vi.mock('../../../src/service/plot/plot-orchestrator', () => ({ orchestrateTavernHelperHook_ACU: vi.fn(), orchestrateAfterCommandsStrategy1_ACU: vi.fn(), orchestrateAfterCommandsStrategy2_ACU: vi.fn() }));
vi.mock('../../../src/presentation/components/status-display', () => ({ getSendTextareaValue_ACU: vi.fn(), setSendTextareaValue_ACU: vi.fn() }));
vi.mock('../../../src/presentation/components/update-status-display', () => ({ updateCardUpdateStatusDisplay_ACU: vi.fn() }));
vi.mock('../../../src/presentation/triggers/auto-loop', () => ({ enterLoopRetryFlow_ACU: vi.fn(), onLoopGenerationEnded_ACU: vi.fn(), stopAutoLoop_ACU: vi.fn() }));
vi.mock('../../../src/presentation/components/plot-planning-ui', () => ({ runOptimizationLogicWithUI_ACU: vi.fn() }));
vi.mock('../../../src/presentation/components/summary-vector-index-ui', () => ({ processSummaryVectorIndexBeforeGenerationWithUI_ACU: vi.fn(), shouldRebuildSummaryVectorIndexWithUI_ACU: (...args: any[]) => m.shouldRebuild(...args), rebuildCurrentSummaryVectorIndexWithUI_ACU: (...args: any[]) => m.rebuild(...args) }));
vi.mock('../../../src/service/vector/summary-vector-index-cache-service', () => ({ preloadSummaryVectorIndexCacheForCurrentChat_ACU: (...args: any[]) => m.preload(...args) }));
vi.mock('../../../src/service/vector/summary-vector-index-flush-queue', () => ({ restoreSummaryVectorIndexFlushQueueForCurrentChat_ACU: (...args: any[]) => m.restoreFlush(...args) }));
vi.mock('../../../src/service/vector/summary-vector-index-realign-state', () => ({ markSummaryVectorIndexDirtyForRealign_ACU: vi.fn() }));

beforeAll(async () => {
  document.body.innerHTML = '<button id="send_but"></button><textarea id="send_textarea"></textarea>';
  vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);
  m.api.eventSource.on.mockImplementation((event: string, callback: any) => {
    if (event === 'chat') m.chatChanged = callback;
  });
  const { mainInitialize_ACU } = await import('../../../src/presentation/bootstrap/init');
  mainInitialize_ACU();
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  m.api.chat = [];
  m.currentChatKey = '';
  m.preload.mockResolvedValue({ success: true, skipped: true, reason: 'no_manifest', chunkCount: 0 });
  m.shouldRebuild.mockReturnValue(false);
  m.rebuild.mockResolvedValue(undefined);
  m.restoreFlush.mockResolvedValue(0);
  Object.assign(m.gate, { lastUserMessageId: 7, lastUserMessageText: 'stale', lastUserMessageAt: 1, lastUserSendIntentAt: 2, lastGeneration: { stale: true } });
});

describe('mainInitialize_ACU CHAT_CHANGED 无活动聊天早退', () => {
  it('无效聊天名且无消息时清理运行时，并阻止后续聊天加载', async () => {
    expect(m.chatChanged).toBeTypeOf('function');
    await m.chatChanged!('');

    expect(m.resetTakeover).toHaveBeenCalledOnce();
    expect(m.dispose).toHaveBeenCalledOnce();
    expect(m.setData).toHaveBeenCalledWith(null);
    expect(m.setTables).toHaveBeenCalledWith({});
    expect(m.setMessages).toHaveBeenCalledWith([]);
    expect(m.setTotal).toHaveBeenCalledWith(0);
    expect(m.setChat).toHaveBeenCalledWith('');
    expect(m.notify).toHaveBeenCalledOnce();
    expect(m.resetScript).not.toHaveBeenCalled();
    expect(m.loadPreset).not.toHaveBeenCalled();
    expect(m.loadMessages).not.toHaveBeenCalled();
    expect(m.refresh).not.toHaveBeenCalled();
    expect(m.gate).toEqual({ lastUserMessageId: null, lastUserMessageText: '', lastUserMessageAt: 0, lastUserSendIntentAt: 0, lastGeneration: null });
  });

  it('无效聊天名但仍有消息时不误清理运行时', async () => {
    m.api.chat = [{ mes: 'still active' }];
    await m.chatChanged!('');

    expect(m.resetTakeover).not.toHaveBeenCalled();
    expect(m.dispose).not.toHaveBeenCalled();
    expect(m.resetScript).toHaveBeenCalledWith('');
    expect(m.loadPreset).toHaveBeenCalledOnce();
  });
});

describe('mainInitialize_ACU CHAT_CHANGED 向量 flush 恢复编排', () => {
  it('missing-file 指示普通重建时按 preload→rebuild 顺序执行且不恢复旧 flush task', async () => {
    vi.useFakeTimers();
    m.api.chat = [{ mes: 'active' }];
    m.resetScript.mockImplementation(async (chatKey: string) => { m.currentChatKey = chatKey; });
    m.preload.mockResolvedValue({ success: true, skipped: true, reason: 'external_files_missing_state_cleared_rebuild_required', chunkCount: 0, chatStateCleared: true });
    m.shouldRebuild.mockReturnValue(true);
    const order: string[] = [];
    m.preload.mockImplementation(async () => { order.push('preload'); return { success: true, skipped: true, reason: 'external_files_missing_state_cleared_rebuild_required', chunkCount: 0, chatStateCleared: true }; });
    m.rebuild.mockImplementation(async () => { order.push('rebuild'); });
    m.restoreFlush.mockImplementation(async () => { order.push('restore'); return 0; });

    await m.chatChanged!('chat-a');
    await vi.advanceTimersByTimeAsync(1200);

    expect(order).toEqual(['preload', 'rebuild']);
    expect(m.restoreFlush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('state-clear-failed 时不恢复持久化旧 flush task', async () => {
    vi.useFakeTimers();
    m.api.chat = [{ mes: 'active' }];
    m.resetScript.mockImplementation(async (chatKey: string) => { m.currentChatKey = chatKey; });
    m.preload.mockResolvedValue({ success: false, skipped: true, reason: 'external_files_missing_state_clear_save_failed', chunkCount: 0, chatStateCleared: false });

    await m.chatChanged!('chat-a');
    await vi.advanceTimersByTimeAsync(1200);

    expect(m.rebuild).not.toHaveBeenCalled();
    expect(m.restoreFlush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
