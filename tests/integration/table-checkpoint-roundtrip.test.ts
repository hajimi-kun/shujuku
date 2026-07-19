import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableDataObject_ACU } from '../../src/shared/models/table-data';

const h = vi.hoisted(() => ({
  chat: [] as any[],
  data: null as any,
  provider: null as any,
  scope: null as any,
  guide: null as any,
  sqliteMode: false,
  persistedTableData: null as any,
}));

vi.mock('../../src/shared/utils', () => ({ hashUserInput_ACU: () => 'hash', logDebug_ACU: vi.fn(), logError_ACU: vi.fn(), logWarn_ACU: vi.fn(), parseTableTemplateJson_ACU: () => h.data, stripSeedRowsFromTemplate_ACU: (value: any) => value }));
vi.mock('../../src/service/runtime/state-manager', () => ({
  get currentJsonTableData_ACU() { return h.data; },
  _set_currentJsonTableData_ACU: (value: any) => { h.data = value; },
  getCurrentIsolationKey_ACU: () => '',
  settings_ACU: { storageMode: 'native' },
}));
vi.mock('../../src/data/storage/chat-history', () => ({
  getChatScopedConfigContainer_ACU: () => h.scope || {},
  getChatSheetGuideContainer_ACU: () => h.guide || {},
  setChatScopedConfigContainer_ACU: (_chat: any[], value: any) => { h.scope = value; },
  setChatSheetGuideContainer_ACU: (_chat: any[], value: any) => { h.guide = value; },
}));
vi.mock('../../src/data/gateways/chat-gateway', () => ({ saveChatToHostStrict_ACU: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/service/chat/chat-service', () => ({
  getChatArray_ACU: () => h.chat,
  clearAllAiTableDataForCheckpointRestore_ACU: async () => ({ clearedCount: 1, vectorManifestsToDeleteAfterCommit: [] }),
  cleanupCheckpointVectorIndexManifestsAfterCommit_ACU: async () => [],
}));
vi.mock('../../src/service/settings/settings-service', () => ({ applyTemplateScopeForCurrentChat_ACU: vi.fn() }));
vi.mock('../../src/service/worldbook/pipeline', () => ({ deleteAllGeneratedEntries_ACU: vi.fn(), refreshMergedDataAndNotify_ACU: vi.fn() }));
vi.mock('../../src/service/table/storage-mode', () => ({ isSqliteMode: () => h.sqliteMode }));
vi.mock('../../src/service/template/chat-scope', () => ({
  buildChatTemplateScopeStateFromCurrent_ACU: (options: any) => ({ mode: 'chat_override', presetName: options.presetName, templateStr: JSON.stringify(options.templateSource) }),
  getCurrentChatTemplateScopeState_ACU: () => h.scope,
  getChatSheetGuideDataForIsolationKey_ACU: () => h.guide,
  setCurrentChatTemplateScopeState_ACU: (value: any) => { h.scope = value; return true; },
  setChatSheetGuideDataForIsolationKey_ACU: (_key: string, value: any) => { h.guide = value; return true; },
  normalizeGuideData_ACU: (value: any) => value,
  sanitizeChatSheetsObject_ACU: (value: any) => value,
  sanitizeTemplateSnapshotForChat_ACU: (source: any) => source ? { templateObj: typeof source === 'string' ? JSON.parse(source) : JSON.parse(JSON.stringify(source)), templateStr: typeof source === 'string' ? source : JSON.stringify(source) } : null,
  ensureStableRowIdsForSheetContent_ACU: (value: any) => value,
  getEffectiveSeedRowsForSheet_ACU: () => [],
  shouldUseInitialSeedRows_ACU: () => false,
}));
vi.mock('../../src/service/table/table-history', () => ({ getLatestAiMessageIndexFromChat_ACU: (chat: any[]) => chat.length - 1 }));
vi.mock('../../src/service/table/table-write-transaction', () => ({ runTableWriteTransaction_ACU: async (_options: any, task: any) => task({ runCommit: async (work: any) => work() }) }));
vi.mock('../../src/service/table/table-service', () => ({
  persistTablesToChatMessage_ACU: async (options: any) => {
    h.persistedTableData = JSON.parse(JSON.stringify(options.tableData));
    return { saved: true, messageIndex: 1 };
  },
  loadOrCreateJsonTableFromChatHistory_ACU: async () => ({ loaded: false, source: 'empty' }),
  saveIndependentTableToChatHistory_ACU: vi.fn(),
}));
vi.mock('../../src/service/table/table-storage-strategy', () => ({
  getStorageProvider: () => h.provider,
  getActiveStorageProvider: () => h.provider,
  reloadStorageProvider: async () => {
    const provider = new SqlTableService();
    await provider.replaceAllData(h.persistedTableData);
    h.provider = provider;
  },
}));

import { NativeTableServiceAdapter } from '../../src/service/table/native-table-service-adapter';
import { SqlTableService } from '../../src/service/table/sql-table-service';
import { restoreTableCheckpointToLatestAi_ACU } from '../../src/service/table/table-checkpoint-transfer';

describe('cp-07: Checkpoint 真实存储跨模式恢复', () => {
  const tableData: TableDataObject_ACU = { mate: { type: 'acu', version: 1 } as any, sheet_0: { uid: 'inventory', name: '背包', content: [['row_id', 'name'], ['1', '铁剑']], sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT)' }, updateConfig: {}, exportConfig: {}, orderNo: 0 } as any };
  const checkpoint = (sourceStorageMode: 'native' | 'sqlite') => ({ format: 'acu-table-checkpoint', version: 1, createdAt: 1, source: { storageMode: sourceStorageMode }, tableSnapshot: tableData, templateSnapshot: { data: tableData, presetName: '测试预设' }, guideSnapshot: { data: tableData }, integrity: { algorithm: 'fnv1a', payloadHash: 'hash' } } as any);

  beforeEach(() => { h.chat = [{ is_user: true }, { is_user: false }]; h.data = null; h.scope = null; h.guide = null; h.sqliteMode = false; h.persistedTableData = null; h.provider = new NativeTableServiceAdapter(); });

  it('native → native：来源与目标均为原生 provider 时保留完整 Checkpoint 快照', async () => {
    const result = await restoreTableCheckpointToLatestAi_ACU(checkpoint('native'));
    expect(result).toMatchObject({ success: true, postCondition: { runtimeMatches: true, scopeIsChatOverride: true, templateMatches: true, guideMatches: true, providerMode: 'native' } });
    expect(h.provider).toBeInstanceOf(NativeTableServiceAdapter);
    expect(h.provider.getCurrentData()).toEqual(tableData);
  });

  it('native → sqlite：目标 SQLite provider 以真实 sql.js 重建持久化快照', async () => {
    h.sqliteMode = true;
    h.provider = new SqlTableService();
    const result = await restoreTableCheckpointToLatestAi_ACU(checkpoint('native'));
    expect(result).toMatchObject({ success: true, postCondition: { runtimeMatches: true, scopeIsChatOverride: true, templateMatches: true, guideMatches: true, providerMode: 'sqlite' } });
    expect(h.provider).toBeInstanceOf(SqlTableService);
    expect(h.provider.isReady()).toBe(true);
    h.provider.dispose();
  });

  it('sqlite → native：来源元数据不改变真实 native 目标运行时', async () => {
    const result = await restoreTableCheckpointToLatestAi_ACU(checkpoint('sqlite'));
    expect(result).toMatchObject({ success: true, postCondition: { runtimeMatches: true, scopeIsChatOverride: true, templateMatches: true, guideMatches: true, providerMode: 'native' } });
    expect(h.provider).toBeInstanceOf(NativeTableServiceAdapter);
  });

  it('sqlite → sqlite：来源与目标均为 SQLite 时重建真实 SQL runtime', async () => {
    h.sqliteMode = true;
    h.provider = new SqlTableService();
    const result = await restoreTableCheckpointToLatestAi_ACU(checkpoint('sqlite'));
    expect(result).toMatchObject({ success: true, postCondition: { runtimeMatches: true, scopeIsChatOverride: true, templateMatches: true, guideMatches: true, providerMode: 'sqlite' } });
    expect(h.provider).toBeInstanceOf(SqlTableService);
    expect(h.provider.isReady()).toBe(true);
    expect(h.provider.getCurrentData()).toEqual(tableData);
    h.provider.dispose();
  });
});