// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importTrigger() {
  vi.resetModules();
  const showCustomConfirm_ACU = vi.fn();
  const showToastr_ACU = vi.fn(() => ({ find: vi.fn(() => ({ text: vi.fn() })) }));
  const orchestrateManualUpdate_ACU = vi.fn();
  const resetManualUpdateButton_ACU = vi.fn();
  const clear = vi.fn();

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: { manualUpdateContextDepth: 3, skipUpdateFloors: 0 },
    currentJsonTableData_ACU: { sheet_0: { name: '物品表' } },
    getCurrentIsolationKey_ACU: vi.fn(() => ''),
    _set_wasStoppedByUser_ACU: vi.fn(),
    _set_isAutoUpdatingCard_ACU: vi.fn(),
    abortAllActiveRequests_ACU: vi.fn(),
  }));
  vi.doMock('../../../src/service/chat/chat-service', () => ({
    getChatArray_ACU: vi.fn(() => [{ is_user: false, mes: 'AI 1' }]),
    saveCurrentDataForTable_ACU: vi.fn(),
  }));
  vi.doMock('../../../src/presentation/components/table-selector', () => ({
    getManualSelectionFromUI_ACU: vi.fn(() => ['sheet_0']),
  }));
  vi.doMock('../../../src/presentation/theme/toast', () => ({ showToastr_ACU }));
  vi.doMock('../../../src/presentation/theme/custom-confirm', () => ({ showCustomConfirm_ACU }));
  vi.doMock('../../../src/shared/constants', () => ({ ACU_TOAST_CATEGORY_ACU: { MANUAL_TABLE: 'manual' } }));
  vi.doMock('../../../src/shared/utils', () => ({ logDebug_ACU: vi.fn(), logError_ACU: vi.fn(), logWarn_ACU: vi.fn() }));
  vi.doMock('../../../src/shared/host-api', () => ({ toastr_API_ACU: { clear } }));
  vi.doMock('../../../src/presentation/state/ui-refs', () => ({ $statusMessageSpan_ACU: null }));
  vi.doMock('../../../src/shared/env', () => ({ topLevelWindow_ACU: { AutoCardUpdaterAPI: { _notifyTableFillStart: vi.fn(), _notifyTableUpdate: vi.fn() } } }));
  vi.doMock('../../../src/shared/html-helpers', () => ({ renderStopButton_ACU: vi.fn(() => '<button>stop</button>') }));
  vi.doMock('../../../src/presentation/components/status-display', () => ({
    bindTableFillStopButton_ACU: vi.fn(),
    resetManualUpdateButton_ACU,
    shouldShowVectorMemoryManualUpdateWarning_ACU: vi.fn(() => false),
    syncManualUpdateButtonAvailability_ACU: vi.fn(),
  }));
  vi.doMock('../../../src/presentation/components/update-status-display', () => ({ updateCardUpdateStatusDisplay_ACU: vi.fn() }));

  vi.doMock('../../../src/presentation/triggers/settings-ui-sync', () => ({ collectManualExtraHint_ACU: vi.fn() }));
  vi.doMock('../../../src/presentation/components/pipeline-ui-helpers', () => ({ refreshMergedDataAndNotifyWithUI_ACU: vi.fn(async () => undefined) }));
  vi.doMock('../../../src/service/table/update-orchestrator', () => ({
    processUpdatesBatch_ACU: vi.fn(),
    executeCardUpdateCore_ACU: vi.fn(),
    orchestrateManualUpdate_ACU,
  }));
  vi.doMock('../../../src/service/table/table-history', () => ({
    collectV2CheckpointFloorsFromChat_ACU: vi.fn(() => [{ messageIndex: 0, aiFloor: 1, reason: 'init' }]),
  }));

  const { handleManualUpdate_ACU } = await import('../../../src/presentation/triggers/update-process');
  return { handleManualUpdate_ACU, showCustomConfirm_ACU, showToastr_ACU, orchestrateManualUpdate_ACU, clear, resetManualUpdateButton_ACU };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('handleManualUpdate_ACU destructive boundary confirmation', () => {
  const requiresConfirmation = {
    success: false,
    requiresUserConfirmation: {
      reason: 'manual_refill_replace_sheet_baseline',
      replayErrorCode: 'no_full_checkpoint_replayable',
      message: '重填起点前没有可回放 checkpoint。',
      contextScopeIndices: [0],
      targetSheetKeys: ['sheet_0'],
    },
  };

  it('首次确认文案只说明边界检查，不承诺空基底或立即替换 checkpoint', async () => {
    const { handleManualUpdate_ACU, showCustomConfirm_ACU } = await importTrigger();
    showCustomConfirm_ACU.mockResolvedValueOnce(false);

    await handleManualUpdate_ACU();

    expect(showCustomConfirm_ACU).toHaveBeenCalledTimes(1);
    expect(showCustomConfirm_ACU.mock.calls[0][0]).toBe('手动填表确认');
    const message = showCustomConfirm_ACU.mock.calls[0][1];
    expect(message).toContain('先在 service 层做重填边界检查');
    expect(message).toContain('第二次破坏性确认');
    expect(message).not.toContain('从表头空基底开始');
    expect(message).not.toContain('若清理后诊断日志仍提示 checkpoint 风险');
  });

  it('用户取消二次确认时不第二次调用 orchestrator，且不展示 error toast', async () => {
    const { handleManualUpdate_ACU, showCustomConfirm_ACU, showToastr_ACU, orchestrateManualUpdate_ACU } = await importTrigger();
    showCustomConfirm_ACU.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    orchestrateManualUpdate_ACU.mockResolvedValueOnce(requiresConfirmation);

    await handleManualUpdate_ACU();

    expect(orchestrateManualUpdate_ACU).toHaveBeenCalledTimes(1);
    expect(showCustomConfirm_ACU).toHaveBeenCalledTimes(2);
    expect(showCustomConfirm_ACU.mock.calls[1][0]).toBe('破坏性手动重填确认');
    const dangerMessage = showCustomConfirm_ACU.mock.calls[1][1];
    expect(dangerMessage).toContain('高风险操作：确认后会在一次提交中删除本次重填范围内选中表的旧表基底');
    expect(dangerMessage).toContain('写入新的单表 checkpoint');
    expect(dangerMessage).toContain('范围外 checkpoint、范围外聊天记录表格数据和未选中的表不会被删除');
    expect(dangerMessage).toContain('此操作不可撤销');
    expect(dangerMessage).toContain('取消将不会执行基底替换，不会写入新的单表 checkpoint');
    expect(showToastr_ACU).toHaveBeenCalledWith('info', '已取消破坏性基底替换。');
    expect(showToastr_ACU.mock.calls.some(call => call[0] === 'error')).toBe(false);
  });

  it('用户确认二次确认时第二次调用传入 confirmBoundaryReset=true', async () => {
    const { handleManualUpdate_ACU, showCustomConfirm_ACU, orchestrateManualUpdate_ACU } = await importTrigger();
    showCustomConfirm_ACU.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    orchestrateManualUpdate_ACU
      .mockResolvedValueOnce(requiresConfirmation)
      .mockResolvedValueOnce({ success: true });

    await handleManualUpdate_ACU();

    expect(orchestrateManualUpdate_ACU).toHaveBeenCalledTimes(2);
    expect(orchestrateManualUpdate_ACU.mock.calls[0][0]).toEqual(['sheet_0']);
    expect(orchestrateManualUpdate_ACU.mock.calls[0][3]).toEqual(expect.objectContaining({ clearBeforeUpdate: true }));
    expect(orchestrateManualUpdate_ACU.mock.calls[0][3]).not.toHaveProperty('confirmBoundaryReset');
    expect(orchestrateManualUpdate_ACU.mock.calls[1][0]).toEqual(['sheet_0']);
    expect(orchestrateManualUpdate_ACU.mock.calls[1][3]).toEqual(expect.objectContaining({ clearBeforeUpdate: true, confirmBoundaryReset: true }));
  });

  it('二次确认后的 orchestrator 失败时展示 error toast', async () => {
    const { handleManualUpdate_ACU, showCustomConfirm_ACU, showToastr_ACU, orchestrateManualUpdate_ACU } = await importTrigger();
    showCustomConfirm_ACU.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    orchestrateManualUpdate_ACU
      .mockResolvedValueOnce(requiresConfirmation)
      .mockResolvedValueOnce({ success: false, error: '确认后替换失败' });

    await handleManualUpdate_ACU();

    expect(showToastr_ACU).toHaveBeenCalledWith('error', '确认后替换失败');
  });
});
