/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`等待条件超时：${label}`);
}

async function importManualUpdate() {
  vi.resetModules();
  const settings: any = {
    autoUpdateThreshold: 3,
    updateBatchSize: 2,
    manualUpdateContextDepth: 3,
    manualUpdateBatchSize: 2,
    manualSelectedTables: ['sheet_0'],
    hasManualSelection: true,
  };
  const currentJsonTableData: any = {
    sheet_0: { name: '物品表', content: [['row_id', '名称']] },
  };
  const chat = [{ is_user: false, mes: 'AI 1' }];
  const orchestrateManualUpdate_ACU = vi.fn();
  const refreshMergedDataAndNotify_ACU = vi.fn(async () => undefined);
  const setWasStoppedByUser = vi.fn();

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    currentJsonTableData_ACU: currentJsonTableData,
    settings_ACU: settings,
    abortAllActiveRequests_ACU: vi.fn(),
    _set_isAutoUpdatingCard_ACU: vi.fn(),
    _set_manualExtraHint_ACU: vi.fn(),
    _set_wasStoppedByUser_ACU: setWasStoppedByUser,
    getCurrentIsolationKey_ACU: vi.fn(() => ''),
  }));
  vi.doMock('../../../src/service/chat/chat-service', () => ({
    getChatArray_ACU: vi.fn(() => chat),
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    saveSettings_ACU: vi.fn(),
  }));
  vi.doMock('../../../src/service/settings/settings-readers', () => ({
    getCurrentWorldbookConfig_ACU: vi.fn(() => ({ summaryVectorIndexModeEnabled: false })),
  }));
  vi.doMock('../../../src/service/template/chat-scope', () => ({
    getSortedSheetKeys_ACU: (tables: Record<string, unknown>) => Object.keys(tables),
  }));
  vi.doMock('../../../src/service/table/table-history', () => ({
    collectV2CheckpointFloorsFromChat_ACU: vi.fn(() => [{ messageIndex: 0, aiFloor: 1, reason: 'init' }]),
  }));
  vi.doMock('../../../src/service/table/update-orchestrator', () => ({
    executeCardUpdateCore_ACU: vi.fn(),
    orchestrateManualUpdate_ACU,
    processUpdatesBatch_ACU: vi.fn(),
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    refreshMergedDataAndNotify_ACU,
  }));
  vi.doMock('../../../src/shared/env', () => ({
    topLevelWindow_ACU: { AutoCardUpdaterAPI: { _notifyTableUpdate: vi.fn() } },
  }));

  const { createPinia, setActivePinia } = await import('pinia');
  setActivePinia(createPinia());
  const [{ useManualUpdate }, { useDialogStore }, { useToastStore, __resetToastStoreForTests }] = await Promise.all([
    import('../../../src/presentation-v2/composables/useManualUpdate'),
    import('../../../src/presentation-v2/stores/dialog-store'),
    import('../../../src/presentation-v2/stores/toast-store'),
  ]);
  return {
    useManualUpdate,
    dialog: useDialogStore(),
    toast: useToastStore(),
    __resetToastStoreForTests,
    orchestrateManualUpdate_ACU,
    refreshMergedDataAndNotify_ACU,
    setWasStoppedByUser,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useManualUpdate destructive boundary confirmation', () => {
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
    const { useManualUpdate, dialog, __resetToastStoreForTests } = await importManualUpdate();
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '首次确认弹窗出现');

    expect(dialog.active?.title).toBe('执行手动填表');
    expect(dialog.active?.message).toContain('先在 service 层做重填边界检查');
    expect(dialog.active?.message).toContain('第二次破坏性确认');
    expect(dialog.active?.message).not.toContain('从表头空基底开始');
    expect(dialog.active?.message).not.toContain('执行前会先删除');

    dialog.cancelActive();
    await pending;
    __resetToastStoreForTests();
  });

  it('用户取消二次确认时不第二次调用 orchestrator，且不展示 error toast', async () => {
    const { useManualUpdate, dialog, toast, orchestrateManualUpdate_ACU, __resetToastStoreForTests } = await importManualUpdate();
    orchestrateManualUpdate_ACU.mockResolvedValueOnce(requiresConfirmation);
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '首次确认弹窗出现');
    dialog.submitActive();
    await waitForCondition(() => orchestrateManualUpdate_ACU.mock.calls.length === 1, '首次 orchestrator 调用完成');
    await waitForCondition(() => dialog.active?.title === '破坏性手动重填确认', '破坏性二次确认弹窗出现');
    expect(dialog.active?.title).toBe('破坏性手动重填确认');
    expect(dialog.active?.message).toContain('高风险操作：确认后会在一次提交中删除本次重填范围内选中表的旧表基底');
    expect(dialog.active?.message).toContain('写入新的单表 checkpoint');
    expect(dialog.active?.message).toContain('范围外 checkpoint、范围外聊天记录表格数据和未选中的表不会被删除');
    expect(dialog.active?.dangerMessage).toContain('此操作不可撤销');
    expect(dialog.active?.dangerMessage).toContain('取消将不会执行基底替换');
    expect(dialog.active?.dangerMessage).toContain('不会写入新的单表 checkpoint');

    dialog.cancelActive();
    await pending;

    expect(orchestrateManualUpdate_ACU).toHaveBeenCalledTimes(1);
    expect(toast.items.some(item => item.kind === 'error')).toBe(false);
    expect(toast.items.at(-1)?.kind).toBe('info');
    expect(toast.items.at(-1)?.text).toContain('已取消破坏性基底替换');
    __resetToastStoreForTests();
  });

  it('用户确认二次确认时第二次调用传入 confirmBoundaryReset=true', async () => {
    const { useManualUpdate, dialog, orchestrateManualUpdate_ACU, __resetToastStoreForTests } = await importManualUpdate();
    orchestrateManualUpdate_ACU
      .mockResolvedValueOnce(requiresConfirmation)
      .mockResolvedValueOnce({ success: true });
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '首次确认弹窗出现');
    dialog.submitActive();
    await waitForCondition(() => orchestrateManualUpdate_ACU.mock.calls.length === 1, '首次 orchestrator 调用完成');
    await waitForCondition(() => dialog.active?.title === '破坏性手动重填确认', '破坏性二次确认弹窗出现');
    dialog.submitActive();
    await pending;

    expect(orchestrateManualUpdate_ACU).toHaveBeenCalledTimes(2);
    expect(orchestrateManualUpdate_ACU.mock.calls[0][0]).toEqual(['sheet_0']);
    expect(orchestrateManualUpdate_ACU.mock.calls[0][3]).toEqual(expect.objectContaining({ clearBeforeUpdate: true, confirmBoundaryReset: false }));
    expect(orchestrateManualUpdate_ACU.mock.calls[1][0]).toEqual(['sheet_0']);
    expect(orchestrateManualUpdate_ACU.mock.calls[1][3]).toEqual(expect.objectContaining({ clearBeforeUpdate: true, confirmBoundaryReset: true }));
    __resetToastStoreForTests();
  });

  it('二次确认后的 orchestrator 失败时展示 error toast', async () => {
    const { useManualUpdate, dialog, toast, orchestrateManualUpdate_ACU, __resetToastStoreForTests } = await importManualUpdate();
    orchestrateManualUpdate_ACU
      .mockResolvedValueOnce(requiresConfirmation)
      .mockResolvedValueOnce({ success: false, error: '确认后替换失败' });
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '首次确认弹窗出现');
    dialog.submitActive();
    await waitForCondition(() => orchestrateManualUpdate_ACU.mock.calls.length === 1, '首次 orchestrator 调用完成');
    await waitForCondition(() => dialog.active?.title === '破坏性手动重填确认', '破坏性二次确认弹窗出现');
    dialog.submitActive();
    await pending;

    expect(toast.items.at(-1)?.kind).toBe('error');
    expect(toast.items.at(-1)?.text).toContain('确认后替换失败');
    __resetToastStoreForTests();
  });
});
