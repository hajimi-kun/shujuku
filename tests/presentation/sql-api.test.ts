/**
 * tests/presentation/sql-api.test.ts
 * 原生 SQL 对外 API 单元测试
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshMergedDataAndNotifyWithUI: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn(() => ({ columns: ['id'], values: [[1]], rowCount: 1 })),
  executeMutation: vi.fn(() => ({ changes: 1, errors: [] })),
  applyEdits: vi.fn(() => ({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 2 })),
  saveToChat: vi.fn().mockResolvedValue({ saved: true, messageIndex: 3 }),
  persistTablesToChatMessage: vi.fn().mockResolvedValue({ saved: true, messageIndex: 3 }),
  getCurrentData: vi.fn(() => ({ mate: { type: 'acu', version: 1 }, sheet_0: { name: 'T', content: [['row_id'], ['1']] } })),
  runTableUpdateApplyWithScopeLock: vi.fn(async (_scopeKey: string, task: () => Promise<unknown>) => task()),
  reloadStorageProvider: vi.fn().mockResolvedValue(undefined),
  ensureStorageProviderReady: vi.fn().mockResolvedValue({
    executeQuery: vi.fn(() => ({ columns: ['id'], values: [[1]], rowCount: 1 })),
    executeMutation: vi.fn(() => ({ changes: 1, errors: [] })),
    applyEdits: vi.fn(() => ({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 2 })),
    saveToChat: vi.fn().mockResolvedValue({ saved: true, messageIndex: 3 }),
    getCurrentData: vi.fn(() => ({ mate: { type: 'acu', version: 1 }, sheet_0: { name: 'T', content: [['row_id'], ['1']] } })),
  }),
  getChatArray: vi.fn(() => []),
  getLatestHeadRevision: vi.fn(() => 'rev-head'),
  captureTableRuntimeRevision: vi.fn(() => 'runtime-rev-head'),
  runTableWriteTransaction: vi.fn(async (_options: any, task: (ctx: any) => Promise<unknown>) => task({
    transactionId: 'tx-test',
    chatKey: 'chat-a',
    isolationKey: 'iso-a',
    source: _options.source,
    baseRevision: null,
    writeSet: _options.writeSet,
    runCommit: async (commitTask: any) => commitTask(),
  })),
}));

vi.mock('../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
}));

vi.mock('../../src/presentation/components/pipeline-ui-helpers', () => ({
  refreshMergedDataAndNotifyWithUI_ACU: mocks.refreshMergedDataAndNotifyWithUI,
}));

vi.mock('../../src/service/table/table-storage-strategy', () => ({
  getStorageProvider: vi.fn(() => ({
    executeQuery: mocks.executeQuery,
    executeMutation: mocks.executeMutation,
    applyEdits: mocks.applyEdits,
    saveToChat: mocks.saveToChat,
    getCurrentData: mocks.getCurrentData,
  })),
  reloadStorageProvider: mocks.reloadStorageProvider,
  ensureStorageProviderReady_ACU: mocks.ensureStorageProviderReady,
}));

vi.mock('../../src/service/chat/chat-service', () => ({
  getChatArray_ACU: mocks.getChatArray,
}));

vi.mock('../../src/service/table/storage-frame-v2-persist', () => ({
  getLatestTableStorageHeadRevisionV2_ACU: mocks.getLatestHeadRevision,
}));

vi.mock('../../src/service/table/table-service', () => ({
  ensureLegacyStorageMigratedBeforeWrite_ACU: vi.fn().mockResolvedValue({ success: true, migrated: false }),
  persistTablesToChatMessage_ACU: mocks.persistTablesToChatMessage,
}));

vi.mock('../../src/service/runtime/state-manager', () => ({
  currentChatFileIdentifier_ACU: 'chat-a',
  currentJsonTableData_ACU: { mate: { type: 'acu', version: 1 }, sheet_0: { name: 'T', content: [['row_id'], ['1']] } },
  getCurrentIsolationKey_ACU: vi.fn(() => 'iso-a'),
  _set_currentJsonTableData_ACU: vi.fn(),
}));

vi.mock('../../src/service/runtime/template-vars/name-mapper', () => ({
  getNameMapper: vi.fn(() => ({
    resolveColumnName: (_tableName: string, columnName: string) => columnName,
    getChineseColumnName: (_tableName: string, columnName: string) => columnName,
    getChineseTableName: (tableName: string) => tableName,
  })),
}));

vi.mock('../../src/service/table/table-update-queue', () => ({
  buildTableUpdateApplyScopeKey_ACU: vi.fn((parts: any) => `${parts.chatKey}::${parts.isolationKey}::${parts.targetMessageIndex}`),
  runTableUpdateApplyWithScopeLock_ACU: mocks.runTableUpdateApplyWithScopeLock,
}));

vi.mock('../../src/service/table/table-write-transaction', () => ({
  captureTableRuntimeRevisionForWriteSet_ACU: mocks.captureTableRuntimeRevision,
  runTableWriteTransaction_ACU: mocks.runTableWriteTransaction,
}));

import { createSqlApi, isSqlReadStatement_ACU } from '../../src/presentation/bootstrap/api-groups/sql-api';

describe('isSqlReadStatement_ACU', () => {
  it('识别查询类 SQL', () => {
    expect(isSqlReadStatement_ACU('SELECT * FROM t')).toBe(true);
    expect(isSqlReadStatement_ACU(' pragma table_info(t)')).toBe(true);
    expect(isSqlReadStatement_ACU('EXPLAIN QUERY PLAN SELECT 1')).toBe(true);
    expect(isSqlReadStatement_ACU('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true);
  });

  it('识别写入类 SQL', () => {
    expect(isSqlReadStatement_ACU('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isSqlReadStatement_ACU('UPDATE t SET x = 1')).toBe(false);
    expect(isSqlReadStatement_ACU('DELETE FROM t')).toBe(false);
  });

  it('拒绝多语句和 WITH 包裹写入，避免查询 API 绕过写事务', () => {
    expect(isSqlReadStatement_ACU('SELECT 1; UPDATE t SET x = 1')).toBe(false);
    expect(isSqlReadStatement_ACU('WITH cte AS (SELECT 1) DELETE FROM t')).toBe(false);
    expect(isSqlReadStatement_ACU("WITH cte AS (SELECT 'UPDATE text') SELECT * FROM cte")).toBe(true);
  });
});

describe('createSqlApi', () => {
  let api: Record<string, Function>;
  const ctx: any = { getApi: () => ({ _notifyTableUpdate: vi.fn() }) };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeQuery.mockReturnValue({ columns: ['id'], values: [[1]], rowCount: 1 });
    mocks.executeMutation.mockReturnValue({ changes: 1, errors: [] });
    mocks.applyEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 2 });
    mocks.saveToChat.mockResolvedValue({ saved: true, messageIndex: 3 });
    mocks.persistTablesToChatMessage.mockResolvedValue({ saved: true, messageIndex: 3 });
    mocks.getCurrentData.mockReturnValue({ mate: { type: 'acu', version: 1 }, sheet_0: { name: 'T', content: [['row_id'], ['1']] } });
    mocks.ensureStorageProviderReady.mockResolvedValue({
      executeQuery: mocks.executeQuery,
      executeMutation: mocks.executeMutation,
      applyEdits: mocks.applyEdits,
      saveToChat: mocks.saveToChat,
      getCurrentData: mocks.getCurrentData,
    });
    mocks.reloadStorageProvider.mockResolvedValue(undefined);
    mocks.getChatArray.mockReturnValue([]);
    mocks.getLatestHeadRevision.mockReturnValue('rev-head');
    mocks.captureTableRuntimeRevision.mockReturnValue('runtime-rev-head');
    mocks.runTableUpdateApplyWithScopeLock.mockImplementation(async (_scopeKey: string, task: () => Promise<unknown>) => task());
    mocks.runTableWriteTransaction.mockImplementation(async (_options: any, task: (ctx: any) => Promise<unknown>) => task({
      transactionId: 'tx-test',
      chatKey: 'chat-a',
      isolationKey: 'iso-a',
      source: _options.source,
      baseRevision: null,
      writeSet: _options.writeSet,
      runCommit: async (commitTask: any) => commitTask(),
    }));
    api = createSqlApi(ctx);
  });

  it('executeSqlQuery 调用 provider.executeQuery 并返回对象行', () => {
    const result = api.executeSqlQuery('SELECT * FROM inventory WHERE row_id = ?', [1]);

    expect(mocks.executeQuery).toHaveBeenCalledWith('SELECT * FROM inventory WHERE row_id = ?', [1]);
    expect(result).toEqual({ columns: ['id'], values: [[1]], rowCount: 1, rows: [{ id: 1 }], sql: 'SELECT * FROM inventory WHERE row_id = ?', offset: 0 });
  });

  it('executeSqlQuery 支持对象参数和 limit/offset 包装', () => {
    api.executeSqlQuery({ sql: 'SELECT * FROM t WHERE name = ?', params: ['铁剑'], limit: 10, offset: 5 });

    expect(mocks.executeQuery).toHaveBeenCalledWith('SELECT * FROM (SELECT * FROM t WHERE name = ?) AS acu_query LIMIT ? OFFSET ?', ['铁剑', 10, 5]);
  });

  it('queryTableRows 支持声明式分页查询', () => {
    api.queryTableRows({ tableName: 'T', columns: ['row_id'], where: { row_id: '1' }, limit: 20, offset: 10 });

    expect(mocks.executeQuery).toHaveBeenCalledWith('SELECT `row_id` FROM `T` WHERE `row_id` = ? LIMIT ? OFFSET ?', ['1', 20, 10]);
  });

  it('querySql 拒绝写语句', () => {
    const result = api.querySql('UPDATE t SET name = 1');

    expect(result).toBeNull();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it('querySql 拒绝 SELECT 后拼接写语句', () => {
    const result = api.querySql('SELECT 1; DELETE FROM t');

    expect(result).toBeNull();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it('executeSqlMutation 支持参数化单条写入并默认保存通知', async () => {
    const result = await api.executeSqlMutation('INSERT INTO inventory(name) VALUES (?)', ['铁剑']);

    expect(mocks.executeMutation).toHaveBeenCalledWith('INSERT INTO inventory(name) VALUES (?)', ['铁剑']);
    expect(mocks.persistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'raw_sql_mutation',
      targetSheetKeys: null,
      trackingSheetKeys: [],
      operations: [{ kind: 'sql_batch', statements: ['INSERT INTO inventory(name) VALUES (?)'], params: [['铁剑']] }],
    }));
    expect(mocks.refreshMergedDataAndNotifyWithUI).toHaveBeenCalledWith({ skipNotify: false });
    expect(result).toEqual({ changes: 1, errors: [], saved: true, messageIndex: 3 });
  });

  it('executeSqlMutation 在同 scope 锁内执行 SQL 和分层写回', async () => {
    await api.executeSqlMutation('UPDATE inventory SET name = ?', ['钢剑']);

    expect(mocks.runTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'raw_sql_mutation',
      writeSet: [{ kind: 'all' }],
    }), expect.any(Function));
    expect(mocks.persistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({ source: 'raw_sql_mutation', targetSheetKeys: null, trackingSheetKeys: [] }));
  });

  it('executeSqlMutation 未声明 targetSheetKeys 时按 SQL 表名推断 sheet 级 writeSet', async () => {
    await api.executeSqlMutation('UPDATE T SET name = ?', ['钢剑']);

    expect(mocks.runTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'raw_sql_mutation',
      writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
    }), expect.any(Function));
    expect(mocks.persistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({ source: 'raw_sql_mutation', targetSheetKeys: ['sheet_0'], trackingSheetKeys: [] }));
  });

  it('executeSqlMutation 写入失败时不保存不通知', async () => {
    mocks.executeMutation.mockReturnValue({ changes: 0, errors: ['SQL error'] });

    const result = await api.executeSqlMutation('BAD SQL');

    expect(result).toEqual({ changes: 0, errors: ['SQL error'] });
    expect(mocks.persistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mocks.refreshMergedDataAndNotifyWithUI).not.toHaveBeenCalled();
  });

  it('executeSqlMutation 运行时未就绪时拒绝写入', async () => {
    mocks.ensureStorageProviderReady.mockRejectedValueOnce(new Error('[StorageStrategy] sqlite 存储运行时未就绪，已阻止 SQL 写入。'));

    const result = await api.executeSqlMutation('UPDATE inventory SET name = ?', ['钢剑']);

    expect(result).toEqual({ changes: 0, errors: ['[StorageStrategy] sqlite 存储运行时未就绪，已阻止 SQL 写入。'] });
    expect(mocks.executeMutation).not.toHaveBeenCalled();
    expect(mocks.persistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('executeSqlMutation 支持跳过保存和通知', async () => {
    const result = await api.executeSqlMutation({
      sql: 'UPDATE inventory SET name = ?',
      params: ['钢剑'],
      skipChatSave: true,
      skipNotify: true,
    });

    expect(result).toEqual({ changes: 1, errors: [] });
    expect(mocks.persistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mocks.refreshMergedDataAndNotifyWithUI).not.toHaveBeenCalled();
  });

  it('executeSqlMutation 支持指定分层写回范围和附加追踪范围', async () => {
    await api.executeSqlMutation({
      sql: 'UPDATE inventory SET name = ?',
      params: ['钢剑'],
      targetSheetKeys: ['sheet_0'],
      updateGroupKeys: ['sheet_0'],
      trackingSheetKeys: [],
    });

    expect(mocks.persistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({ source: 'raw_sql_mutation', targetSheetKeys: ['sheet_0'], updateGroupKeys: ['sheet_0'], trackingSheetKeys: [] }));
  });

  it('executeSqlMutation 将 targetSheetKeys 转成 sheet 级 writeSet 并贯通 transactionContext', async () => {
    const txCtx = {
      transactionId: 'tx-sheet-0',
      chatKey: 'chat-a',
      isolationKey: 'iso-a',
      source: 'raw_sql_mutation',
      baseRevision: 'rev-base',
      writeSet: [{ kind: 'sheet' as const, sheetKey: 'sheet_0' }],
      runCommit: async (commitTask: any) => commitTask(),
    };
    mocks.runTableWriteTransaction.mockImplementationOnce(async (_options: any, task: (ctx: any) => Promise<unknown>) => task(txCtx));

    await api.executeSqlMutation({
      sql: 'UPDATE inventory SET name = ?',
      params: ['钢剑'],
      targetSheetKeys: ['sheet_0'],
    });

    expect(mocks.runTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'raw_sql_mutation',
      writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
    }), expect.any(Function));
    const saveOptions = mocks.persistTablesToChatMessage.mock.calls[0][0];
    expect(saveOptions.transactionContext).toBe(txCtx);
    expect(saveOptions.assumeCommitLock).toBe(true);
  });

  it('executeSqlBatch 通过 applyEdits 执行多语句事务并保存受影响表', async () => {
    const sql = "INSERT INTO T VALUES (1, 'a'); UPDATE T SET name = 'b' WHERE row_id = 1;";

    const result = await api.executeSqlBatch(sql);

    expect(mocks.applyEdits).toHaveBeenCalledWith(sql, 'raw_sql_api');
    expect(mocks.runTableWriteTransaction).toHaveBeenCalledWith(expect.objectContaining({
      source: 'raw_sql_batch',
      writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
    }), expect.any(Function));
    expect(mocks.persistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'raw_sql_batch',
      targetSheetKeys: ['sheet_0'],
      trackingSheetKeys: [],
      operations: [{ kind: 'sql_batch', statements: ["INSERT INTO T VALUES (1, 'a')", "UPDATE T SET name = 'b' WHERE row_id = 1"] }],
    }));
    expect(mocks.refreshMergedDataAndNotifyWithUI).toHaveBeenCalledWith({ skipNotify: false });
    expect(result).toEqual({
      success: true,
      modifiedKeys: ['sheet_0'],
      appliedEdits: 2,
      changes: 2,
      errors: [],
      saved: true,
      messageIndex: 3,
    });
  });

  it('executeSqlBatch 支持覆盖 applyEdits 推断的写回范围', async () => {
    await api.executeSqlBatch({
      sql: "INSERT INTO inventory VALUES (1, 'a');",
      targetSheetKeys: ['sheet_2'],
      updateGroupKeys: ['sheet_2'],
      trackingSheetKeys: ['sheet_2'],
    });

    expect(mocks.persistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'raw_sql_batch',
      targetSheetKeys: ['sheet_2'],
      updateGroupKeys: ['sheet_2'],
      trackingSheetKeys: ['sheet_2'],
    }));
  });

  it('executeSqlBatch 失败时返回错误且不保存', async () => {
    mocks.applyEdits.mockImplementation(() => { throw new Error('rollback'); });

    const result = await api.executeSqlBatch('INSERT INTO missing VALUES (1);');

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(['rollback']);
    expect(mocks.persistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('executeSqlBatch 运行时未就绪时拒绝写入', async () => {
    mocks.ensureStorageProviderReady.mockRejectedValueOnce(new Error('[StorageStrategy] sqlite 存储运行时未就绪，已阻止 SQL 写入。'));

    const result = await api.executeSqlBatch('UPDATE inventory SET name = \'钢剑\';');

    expect(result).toEqual({ success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, errors: ['[StorageStrategy] sqlite 存储运行时未就绪，已阻止 SQL 写入。'] });
    expect(mocks.applyEdits).not.toHaveBeenCalled();
    expect(mocks.persistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('executeSqlMutation 保存失败时由公共提交模型返回错误', async () => {
    mocks.persistTablesToChatMessage.mockResolvedValueOnce({ saved: false, error: 'conflict' });

    const result = await api.executeSqlMutation('UPDATE T SET name = ?', ['钢剑']);

    expect(result).toEqual({ changes: 0, errors: ['conflict'] });
    expect(mocks.persistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({ source: 'raw_sql_mutation', targetSheetKeys: ['sheet_0'], trackingSheetKeys: [] }));
  });

  it('executeSql 自动分派查询', async () => {
    const result = await api.executeSql('SELECT 1');

    expect(result).toEqual({ type: 'query', result: { columns: ['id'], values: [[1]], rowCount: 1, rows: [{ id: 1 }], sql: 'SELECT 1' } });
    expect(mocks.executeMutation).not.toHaveBeenCalled();
  });

  it('executeSql 自动分派写入', async () => {
    const result = await api.executeSql('UPDATE inventory SET name = ?', ['钢剑']);

    expect(result.type).toBe('mutation');
    expect(mocks.executeMutation).toHaveBeenCalledWith('UPDATE inventory SET name = ?', ['钢剑']);
  });
});
