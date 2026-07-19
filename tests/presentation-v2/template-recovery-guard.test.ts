/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

async function importGuard() {
  vi.resetModules();
  const validateCurrentChatTableRecovery_ACU = vi.fn(async () => ({ success: true }));

  vi.doMock('../../src/service/table/storage-frame-v2-replay', () => ({
    validateCurrentChatTableRecovery_ACU,
  }));

  setActivePinia(createPinia());
  const [{ ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU }, { useDialogStore }] = await Promise.all([
    import('../../src/presentation-v2/composables/useTemplateRecoveryGuard'),
    import('../../src/presentation-v2/stores/dialog-store'),
  ]);
  return {
    ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU,
    useDialogStore,
    validateCurrentChatTableRecovery_ACU,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useTemplateRecoveryGuard', () => {
  it('当前历史恢复验证通过时不弹窗', async () => {
    const { ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU, useDialogStore, validateCurrentChatTableRecovery_ACU } = await importGuard();

    const result = await ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU({ sheet_1: {} }, 'save-template');

    expect(result).toEqual({ success: true, dataWasReset: false });
    expect(useDialogStore().active).toBeNull();
    expect(validateCurrentChatTableRecovery_ACU).toHaveBeenCalledWith();
  });

  it('恢复验证失败时显示非破坏性提示并保留数据', async () => {
    const {
      ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU,
      useDialogStore,
      validateCurrentChatTableRecovery_ACU,
    } = await importGuard();
    validateCurrentChatTableRecovery_ACU.mockResolvedValueOnce({ success: false, error: 'CHECK constraint failed' });

    const pending = ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU({ sheet_1: {} }, 'save-template');
    await Promise.resolve();
    const dialog = useDialogStore();

    expect(dialog.active?.title).toBe('当前聊天历史恢复失败');
    expect(dialog.active?.message).toContain('已保留当前标识本地数据');
    expect(dialog.active?.message).toContain('CHECK constraint failed');
    expect(dialog.active?.confirmLabel).toBe('知道了');

    dialog.submitActive();
    await expect(pending).resolves.toEqual({ success: false, dataWasReset: false });
  });
});
