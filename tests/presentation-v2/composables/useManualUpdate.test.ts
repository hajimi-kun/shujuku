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

describe('useManualUpdate destructive refill confirmation', () => {
  it('单次确认文案明示会删除范围内 checkpoint 与增量，并提示不可恢复风险', async () => {
    const { useManualUpdate, dialog, __resetToastStoreForTests } = await importManualUpdate();
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '确认弹窗出现');

    expect(dialog.active?.message).toContain('会先删除本次重填范围内选中表的 checkpoint 与 V2 增量日志');
    expect(dialog.active?.message).toContain('此前楼层的表格数据将无法恢复');
    expect(dialog.active?.message).toContain('范围外的 checkpoint、范围外聊天记录的表格数据和未选中的表不会被删除');
    // 二次确认链路已移除，首次文案不得再承诺它。
    expect(dialog.active?.message).not.toContain('第二次破坏性确认');
    expect(dialog.active?.confirmVariant).toBe('danger');

    dialog.cancelActive();
    await pending;
    __resetToastStoreForTests();
  });

  it('用户取消唯一确认时不调用 orchestrator，且不展示 error toast', async () => {
    const { useManualUpdate, dialog, toast, orchestrateManualUpdate_ACU, __resetToastStoreForTests } = await importManualUpdate();
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '确认弹窗出现');
    dialog.cancelActive();
    await pending;

    expect(orchestrateManualUpdate_ACU).not.toHaveBeenCalled();
    expect(toast.items.some(item => item.kind === 'error')).toBe(false);
    __resetToastStoreForTests();
  });

  it('用户确认后只调用 orchestrator 一次，且不再传 confirmBoundaryReset', async () => {
    const { useManualUpdate, dialog, orchestrateManualUpdate_ACU, __resetToastStoreForTests } = await importManualUpdate();
    orchestrateManualUpdate_ACU.mockResolvedValue({ success: true });
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '确认弹窗出现');
    dialog.submitActive();
    await pending;

    expect(orchestrateManualUpdate_ACU).toHaveBeenCalledTimes(1);
    expect(orchestrateManualUpdate_ACU.mock.calls[0][0]).toEqual(['sheet_0']);
    expect(orchestrateManualUpdate_ACU.mock.calls[0][3]).toEqual(expect.objectContaining({ clearBeforeUpdate: true }));
    expect(orchestrateManualUpdate_ACU.mock.calls[0][3]).not.toHaveProperty('confirmBoundaryReset');
    __resetToastStoreForTests();
  });

  it('orchestrator 失败时展示 error toast', async () => {
    const { useManualUpdate, dialog, toast, orchestrateManualUpdate_ACU, __resetToastStoreForTests } = await importManualUpdate();
    orchestrateManualUpdate_ACU.mockResolvedValue({ success: false, error: '清理后重填失败' });
    const manual = useManualUpdate();

    const pending = manual.runManualUpdate();
    await waitForCondition(() => dialog.active?.title === '执行手动填表', '确认弹窗出现');
    dialog.submitActive();
    await pending;

    expect(toast.items.at(-1)?.kind).toBe('error');
    expect(toast.items.at(-1)?.text).toContain('清理后重填失败');
    __resetToastStoreForTests();
  });
});
