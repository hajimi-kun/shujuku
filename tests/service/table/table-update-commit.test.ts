import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  migration: vi.fn(),
  reload: vi.fn(),
  transaction: vi.fn(),
  persist: vi.fn(),
  ensureProvider: vi.fn(),
  setCurrentData: vi.fn(),
  currentChatKey: 'chat-a',
  currentIsolationKey: 'scope-a',
}));

vi.mock('../../../src/shared/utils', () => ({
  logError_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
}));
vi.mock('../../../src/service/runtime/state-manager', () => ({
  get currentChatFileIdentifier_ACU() { return mocks.currentChatKey; },
  currentJsonTableData_ACU: null,
  getCurrentIsolationKey_ACU: () => mocks.currentIsolationKey,
  _set_currentJsonTableData_ACU: mocks.setCurrentData,
}));
vi.mock('../../../src/service/table/table-service', () => ({
  ensureLegacyStorageMigratedBeforeWrite_ACU: mocks.migration,
  persistTablesToChatMessage_ACU: mocks.persist,
}));
vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  ensureStorageProviderReady_ACU: mocks.ensureProvider,
  reloadStorageProvider: mocks.reload,
}));
vi.mock('../../../src/service/table/table-write-transaction', () => ({
  runTableWriteTransaction_ACU: mocks.transaction,
}));

import { runSqliteRuntimeMutationCommit_ACU, runTableUpdateCommit_ACU } from '../../../src/service/table/table-update-commit';

function options(reason: string) {
  return {
    source: 'system' as const,
    reason,
    writeSet: [{ kind: 'all' as const }],
    targetMessageIndex: -1,
    targetSheetKeys: null,
  };
}

describe('runTableUpdateCommit_ACU migration gate', () => {
  beforeEach(() => {
    mocks.currentChatKey = 'chat-a';
    mocks.currentIsolationKey = 'scope-a';
    mocks.migration.mockReset().mockResolvedValue({ success: false, error: 'mixed storage evidence insufficient' });
    mocks.reload.mockReset();
    mocks.transaction.mockReset();
    mocks.persist.mockReset();
    mocks.ensureProvider.mockReset();
    mocks.setCurrentData.mockReset();
  });

  it('mixed/legacy 迁移失败时不执行 apply、事务或持久化', async () => {
    const apply = vi.fn();

    const result = await runTableUpdateCommit_ACU(options('test_mixed_gate'), apply);

    expect(result).toEqual({
      success: false,
      error: 'mixed storage evidence insufficient',
      errorCategory: 'infrastructure',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setCurrentData).not.toHaveBeenCalled();
  });

  it('SQLite mutation 同样在 provider 写入前被 migration gate 拦截', async () => {
    const result = await runSqliteRuntimeMutationCommit_ACU({
      ...options('test_sqlite_mixed_gate'),
      sql: 'UPDATE sheet_0 SET value = ?',
      params: ['changed'],
      mapValue: () => 'unreachable',
    });

    expect(result).toEqual({
      success: false,
      error: 'mixed storage evidence insufficient',
      errorCategory: 'infrastructure',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('AI 等待期间切换聊天后 fail-loud，禁止进入事务与 apply', async () => {
    const apply = vi.fn();
    mocks.migration.mockImplementation(async () => {
      mocks.currentChatKey = 'chat-b';
      mocks.currentIsolationKey = 'scope-b';
      return { success: true, migrated: false };
    });

    const result = await runTableUpdateCommit_ACU({
      ...options('test_scope_switch_guard'),
      chatKey: 'chat-a',
      isolationKey: 'scope-a',
    }, apply);

    expect(result).toMatchObject({
      success: false,
      errorCategory: 'precondition',
      error: expect.stringContaining('聊天或隔离标识已切换'),
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setCurrentData).not.toHaveBeenCalled();
  });

  it('persist 前只读拒绝空 row_id，且不会调用持久化或修复数据', async () => {
    const invalidData: any = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        uid: 'sheet_0',
        name: '损坏表',
        content: [['row_id', '名称'], ['', '未分配身份']],
      },
    };
    mocks.migration.mockResolvedValue({ success: true, migrated: false });
    mocks.transaction.mockImplementation(async (_options: any, task: any) => task({
      runCommit: async (commitTask: any) => commitTask(),
    }, null));

    const result = await runTableUpdateCommit_ACU(options('test_row_identity_guard'), async () => ({
      success: true,
      tableData: invalidData,
      value: 'unreachable',
    }));

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('sheetKey=sheet_0, rowIndex=1 的 row_id 为空') });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(invalidData.sheet_0.content[1][0]).toBe('');
  });

  it('persist 前拒绝重复 row_id，并提供可定位的行号', async () => {
    const invalidData: any = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        uid: 'sheet_0',
        name: '损坏表',
        content: [['row_id', '名称'], ['stable', '第一行'], ['stable', '第二行']],
      },
    };
    mocks.migration.mockResolvedValue({ success: true, migrated: false });
    mocks.transaction.mockImplementation(async (_options: any, task: any) => task({
      runCommit: async (commitTask: any) => commitTask(),
    }, null));

    const result = await runTableUpdateCommit_ACU(options('test_duplicate_row_identity_guard'), async () => ({
      success: true,
      tableData: invalidData,
    }));

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('sheetKey=sheet_0, rowIndex=2 的 row_id 重复：stable') });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
