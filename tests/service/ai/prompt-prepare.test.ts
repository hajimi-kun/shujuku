/**
 * tests/service/ai/prompt-prepare.test.ts
 * formatTableForSqliteMode 纯函数单元测试
 *
 * 策略：mock getEffectiveSeedRowsForSheet_ACU，直接测试格式化输出
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

const mockGetEffectiveSeedRows = vi.fn(() => []);
const mockEnsureChatSheetGuideSeeded = vi.fn().mockResolvedValue(null);
const mockAttachSeedRows = vi.fn();
const mockReplaceDbSqlVariables = vi.fn((content: string) => content);
const mockGetWorldBooks = vi.fn().mockResolvedValue([]);
let mockCurrentJsonTableData: any = null;
let mockSettings: any = {};
const mockResolvePreTakeoverSnapshot = vi.fn(async () => ({
  snapshot: { active: false, selectionSignature: '', createdAt: 0, books: {} },
  expectedSignature: 'signature:["Agent书"]',
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getEffectiveSeedRowsForSheet_ACU: (...args: any[]) => mockGetEffectiveSeedRows(...args),
  ensureChatSheetGuideSeeded_ACU: (...args: any[]) => mockEnsureChatSheetGuideSeeded(...args),
  attachSeedRowsToCurrentDataFromGuide_ACU: (...args: any[]) => mockAttachSeedRows(...args),
  getSortedSheetKeys_ACU: vi.fn((data: any) => data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')) : []),
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
  normalizeExtractRules_ACU: vi.fn(() => []),
  normalizeExcludeRules_ACU: vi.fn(() => []),
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get manualExtraHint_ACU() { return ''; },
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData; },
  get settings_ACU() { return mockSettings; },
}));

vi.mock('../../../src/data/gateways/host-state-gateway', () => ({
  getUserName_ACU: vi.fn(() => '用户'),
}));

vi.mock('../../../src/service/worldbook/pipeline', () => ({
  getCombinedWorldbookContent_ACU: vi.fn().mockResolvedValue(''),
  getWorldBooks_ACU: (...args: any[]) => mockGetWorldBooks(...args),
}));

vi.mock('../../../src/service/agent/agent-worldbook-takeover', () => ({
  resolvePreTakeoverWorldbookSnapshot_ACU: (...args: any[]) => mockResolvePreTakeoverSnapshot(...args),
}));

vi.mock('../../../src/service/runtime/helpers-remaining', () => ({
  applyContextTagFilters_ACU: vi.fn((c: string) => c),
}));

vi.mock('../../../src/service/runtime/template-vars/sql-query-var', () => ({
  replaceDbSqlVariables: (content: string) => mockReplaceDbSqlVariables(content),
}));

let mockIsSqliteMode = true;
vi.mock('../../../src/service/table/storage-mode', () => ({
  isSqliteMode: vi.fn(() => mockIsSqliteMode),
}));

const mockRuntimeProvider = {
  mode: 'sqlite',
  isReady: vi.fn(() => true),
  getCurrentData: vi.fn(() => mockCurrentJsonTableData),
};
vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  ensureStorageProviderReady_ACU: vi.fn(() => Promise.resolve(mockRuntimeProvider)),
}));

import { formatTableForSqliteMode, prepareAIInput_ACU } from '../../../src/service/ai/prompt-builder/prompt-prepare';
import { getCombinedWorldbookContent_ACU } from '../../../src/service/worldbook/pipeline';

describe('formatTableForSqliteMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveSeedRows.mockReturnValue([]);
    mockEnsureChatSheetGuideSeeded.mockResolvedValue(null);
    mockAttachSeedRows.mockReset();
    mockReplaceDbSqlVariables.mockImplementation((content: string) => content);
    mockGetWorldBooks.mockResolvedValue([]);
    mockRuntimeProvider.mode = 'sqlite';
    mockRuntimeProvider.getCurrentData.mockImplementation(() => mockCurrentJsonTableData);
    mockIsSqliteMode = true;
    mockCurrentJsonTableData = null;
    mockResolvePreTakeoverSnapshot.mockResolvedValue({
      snapshot: { active: false, selectionSignature: '', createdAt: 0, books: {} },
      expectedSignature: 'signature:["Agent书"]',
    });
    mockSettings = {
      tableContextExtractTags: '',
      tableContextExcludeTags: '',
      tableContextExtractRules: '',
      tableContextExcludeRules: '',
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // DDL 输出
  // ═══════════════════════════════════════════════════════════════
  it('输出 DDL', () => {
    const table = {
      name: '背包物品表',
      sourceData: {
        ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT, quantity INTEGER);',
        note: '',
        insertNode: '',
        updateNode: '',
        deleteNode: '',
      },
      content: [['row_id', 'item_name', 'quantity'], ['1', '铁剑', '3']],
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('CREATE TABLE inventory');
  });

  // ═══════════════════════════════════════════════════════════════
  // Note 和 Trigger 注释
  // ═══════════════════════════════════════════════════════════════
  it('输出 Note 注释', () => {
    const table = {
      name: '背包物品表',
      sourceData: {
        ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);',
        note: '记录角色背包中的物品',
        insertNode: '',
        updateNode: '',
        deleteNode: '',
      },
      content: [['row_id'], ['1']],
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('-- Note: 记录角色背包中的物品');
  });

  it('输出 INSERT/UPDATE/DELETE Trigger 注释', () => {
    const table = {
      name: '背包物品表',
      sourceData: {
        ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);',
        note: '',
        insertNode: '获得新物品时插入',
        updateNode: '物品数量变化时更新',
        deleteNode: '丢弃物品时删除',
      },
      content: [['row_id'], ['1']],
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('-- INSERT: 获得新物品时插入');
    expect(result).toContain('-- UPDATE: 物品数量变化时更新');
    expect(result).toContain('-- DELETE: 丢弃物品时删除');
  });

  // ═══════════════════════════════════════════════════════════════
  // 数据输出
  // ═══════════════════════════════════════════════════════════════
  it('输出当前数据（注释格式的表格）', () => {
    const table = {
      name: '背包物品表',
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);' },
      content: [['row_id', 'item_name'], ['1', '铁剑'], ['2', '药水']],
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('-- 当前数据 (2 rows)');
    expect(result).toContain('-- | row_id | item_name |');
    expect(result).toContain('-- | 1 | 铁剑 |');
    expect(result).toContain('-- | 2 | 药水 |');
  });

  it('配置填表发送数据模板时只替换当前数据部分并保留 DDL 与规则', () => {
    mockReplaceDbSqlVariables.mockReturnValue('-- | 9 | 自定义行 |');
    const table = {
      name: '背包物品表',
      sourceData: {
        ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);',
        note: '记录背包',
        insertNode: '获得物品时插入',
        updateNode: '数量变化时更新',
        deleteNode: '丢弃时删除',
      },
      content: [['row_id', 'item_name'], ['1', '铁剑'], ['2', '药水']],
      updateConfig: {
        sendRowsSqlTemplate: '{[sql "SELECT row_id, item_name FROM inventory WHERE row_id = 9"]}',
      },
    };

    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);

    expect(mockReplaceDbSqlVariables).toHaveBeenCalledWith('{[sql "SELECT row_id, item_name FROM inventory WHERE row_id = 9"]}');
    expect(result).toContain('CREATE TABLE inventory');
    expect(result).toContain('-- Note: 记录背包');
    expect(result).toContain('-- INSERT: 获得物品时插入');
    expect(result).toContain('-- UPDATE: 数量变化时更新');
    expect(result).toContain('-- DELETE: 丢弃时删除');
    expect(result).toContain('-- 当前数据');
    expect(result).toContain('-- | 9 | 自定义行 |');
    expect(result).not.toContain('-- | 1 | 铁剑 |');
  });

  // ═══════════════════════════════════════════════════════════════
  // 空表
  // ═══════════════════════════════════════════════════════════════
  it('空表输出初始化提示', () => {
    const table = {
      name: '背包物品表',
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      content: [['row_id']],
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('该表格为空，请进行初始化');
  });

  it('空表时输出 INIT 规则', () => {
    const table = {
      name: '全局状态表',
      sourceData: {
        ddl: 'CREATE TABLE global_state (row_id INTEGER PRIMARY KEY, current_location TEXT);',
        initNode: '故事初始化时插入唯一条目。',
        insertNode: '禁止新增。',
        updateNode: '每轮更新地点。',
        deleteNode: '禁止删除。',
      },
      content: [['row_id', 'current_location']],
      updateConfig: {},
    };

    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);

    expect(result).toContain('-- INIT: 故事初始化时插入唯一条目。');
    expect(result).toContain('-- (该表格为空，请进行初始化。)');
  });

  it('非空表时不输出 INIT 规则，避免后续更新误用初始化语义', () => {
    const table = {
      name: '全局状态表',
      sourceData: {
        ddl: 'CREATE TABLE global_state (row_id INTEGER PRIMARY KEY, current_location TEXT);',
        initNode: '故事初始化时插入唯一条目。',
        insertNode: '禁止新增。',
        updateNode: '每轮更新地点。',
        deleteNode: '禁止删除。',
      },
      content: [['row_id', 'current_location'], ['1', '王城']],
      updateConfig: {},
    };

    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);

    expect(result).not.toContain('-- INIT:');
    expect(result).not.toContain('该表格为空，请进行初始化');
    expect(result).toContain('-- 当前数据 (1 rows)');
  });

  // ═══════════════════════════════════════════════════════════════
  // seedRows
  // ═══════════════════════════════════════════════════════════════
  it('使用 seedRows 时输出提示', () => {
    mockGetEffectiveSeedRows.mockReturnValue([['1', '铁剑'], ['2', '药水']]);
    const table = {
      name: '背包物品表',
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);' },
      content: [['row_id', 'item_name']], // 无数据行
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('SeedRows');
    expect(result).toContain('-- 当前数据 (2 rows)');
  });

  // ═══════════════════════════════════════════════════════════════
  // 行数限制
  // ═══════════════════════════════════════════════════════════════
  it('总结表超过10行时只显示最后10行', () => {
    const rows: any[][] = [['row_id', 'content']];
    for (let i = 1; i <= 15; i++) {
      rows.push([String(i), `内容${i}`]);
    }
    const table = {
      name: '总结表',
      sourceData: { ddl: 'CREATE TABLE summary (row_id INTEGER PRIMARY KEY, content TEXT);' },
      content: rows,
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('Showing last 10 of 15');
  });

  it('sendLatestRows 限制行数', () => {
    const rows: any[][] = [['row_id', 'item']];
    for (let i = 1; i <= 20; i++) {
      rows.push([String(i), `物品${i}`]);
    }
    const table = {
      name: '背包物品表',
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item TEXT);' },
      content: rows,
      updateConfig: { sendLatestRows: 5 },
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('Showing last 5 of 20');
  });

  // ═══════════════════════════════════════════════════════════════
  // 多行 Note
  // ═══════════════════════════════════════════════════════════════
  it('多行 Note 正确转为注释', () => {
    const table = {
      name: '背包物品表',
      sourceData: {
        ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);',
        note: '第一行说明\n第二行说明',
      },
      content: [['row_id'], ['1']],
      updateConfig: {},
    };
    const result = formatTableForSqliteMode(table, 0, 'sheet_0', null);
    expect(result).toContain('-- Note: 第一行说明\n-- 第二行说明');
  });
});

describe('prepareAIInput_ACU — 显式 tableData 模式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePreTakeoverSnapshot.mockResolvedValue({
      snapshot: { active: false, selectionSignature: '', createdAt: 0, books: {} },
      expectedSignature: 'signature:["Agent书"]',
    });
    mockGetEffectiveSeedRows.mockReturnValue([]);
    mockEnsureChatSheetGuideSeeded.mockResolvedValue(null);
    mockAttachSeedRows.mockReset();
    mockGetWorldBooks.mockResolvedValue([]);
    mockRuntimeProvider.mode = 'sqlite';
    mockRuntimeProvider.getCurrentData.mockImplementation(() => mockCurrentJsonTableData);
    mockIsSqliteMode = false;
    mockCurrentJsonTableData = null;
    mockSettings = {
      tableContextExtractTags: '',
      tableContextExcludeTags: '',
      tableContextExtractRules: '',
      tableContextExcludeRules: '',
    };
  });

  it('传入显式 tableData 时优先使用显式数据而不是全局数据', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '全局表',
        content: [['row_id', 'name'], ['1', '全局值']],
        updateConfig: {},
      },
    };
    const explicitTableData = {
      sheet_0: {
        uid: 'sheet_0',
        name: '显式表',
        content: [['row_id', 'name'], ['1', '显式值']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard', null, { tableData: explicitTableData });
    expect(result).not.toBeNull();
    expect(result!.tableDataText).toContain('[0:显式表]');
    expect(result!.tableDataText).toContain('显式值');
    expect(result!.tableDataText).not.toContain('全局表');
    expect(result!.tableDataText).not.toContain('全局值');
  });

  it('传入显式 tableData 且存在 guideData 时不调用全局 attach helper，且不污染原始显式对象', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        uid: 'sheet_0',
        name: '全局表',
        content: [['row_id', 'name']],
        updateConfig: {},
      },
    };
    const explicitTableData = {
      sheet_0: {
        uid: 'sheet_0',
        name: '显式表',
        content: [['row_id', 'name']],
        updateConfig: {},
      },
    };
    mockEnsureChatSheetGuideSeeded.mockResolvedValue({ sheet_0: { seedRows: [['1', '模板值']] } });

    await prepareAIInput_ACU([], 'standard', null, { tableData: explicitTableData });

    expect(mockAttachSeedRows).not.toHaveBeenCalled();
    expect(explicitTableData.sheet_0.seedRows).toBeUndefined();
    expect(mockCurrentJsonTableData.sheet_0.seedRows).toBeUndefined();
  });

  it('传入 Agent 绿灯时在同一 pre_takeover 读取视图中收集 $4 与 $9', async () => {
    const explicitTableData = {
      sheet_0: {
        uid: 'sheet_0',
        name: '显式表',
        content: [['row_id', 'name'], ['1', '显式值']],
        updateConfig: {},
      },
    };
    const messages = [
      { is_user: true, mes: '用户触发普通关键词' },
      { is_user: false, mes: '角色回应' },
    ];
    const agentGreenlights = [{ bookName: '书A', uid: 7, reason: '正文需要' }];

    await prepareAIInput_ACU(messages, 'standard', null, {
      tableData: explicitTableData,
      agentGreenlights,
    });

    const calls = vi.mocked(getCombinedWorldbookContent_ACU).mock.calls;
    expect(calls).toHaveLength(2);
    calls.forEach(([, callOptions]) => {
      expect(callOptions).toEqual(expect.objectContaining({
        entryStateView: 'pre_takeover',
        entryStateSnapshot: expect.objectContaining({ active: false }),
        entryStateSnapshotSignature: 'signature:["Agent书"]',
        agentGreenlights,
      }));
    });
    expect(calls[0][1]).not.toHaveProperty('excludeEntry');
    expect(calls[1][1]).toEqual(expect.objectContaining({ excludeEntry: expect.any(Function) }));
  });

  it('返回 $9 世界书内容与请求内表名 resolver', async () => {
    vi.mocked(getCombinedWorldbookContent_ACU)
      .mockResolvedValueOnce('普通世界书')
      .mockResolvedValueOnce('排除内部后的世界书')
      .mockResolvedValueOnce('关系正文');
    mockGetWorldBooks.mockResolvedValue([{
      name: '书A',
      entries: [
        { uid: 7, comment: 'TavernDB-ACU-CustomExport-关系档案', content: '关系正文' },
        { uid: 8, comment: 'TavernDB-ACU-CustomExport-其他档案', content: '其他正文' },
      ],
    }]);
    const result = await prepareAIInput_ACU([], 'standard', null, {
      tableData: {
        sheet_0: {
          uid: 'sheet_0', name: '显式表', content: [['row_id', 'name']], updateConfig: {},
          exportConfig: { enabled: true, entryName: '关系档案' },
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({
      worldbookContent: '普通世界书',
      worldbookDatabaseExcludedContent: '排除内部后的世界书',
      resolveTableWorldbookContent: expect.any(Function),
    }));
    await expect(result!.resolveTableWorldbookContent('显式表')).resolves.toBe('<worldbook_context>\n关系正文\n</worldbook_context>');
    const [, resolverOptions] = vi.mocked(getCombinedWorldbookContent_ACU).mock.calls[2];
    expect(resolverOptions).toEqual(expect.objectContaining({
      includeGeneratedEntries: true,
      entryScope: expect.any(Function),
    }));
    expect(resolverOptions.entryScope({ bookName: '书A', uid: 7 })).toBe(true);
    expect(resolverOptions.entryScope({ bookName: '书A', uid: 8 })).toBe(false);
    await expect(result!.resolveTableWorldbookContent('不存在的表')).resolves.toBeNull();
  });

  it('active snapshot 使用 Agent 独立范围签名，不使用填表世界书范围自证', async () => {
    const explicitTableData = {
      sheet_0: {
        uid: 'sheet_0',
        name: '显式表',
        content: [['row_id', 'name'], ['1', '显式值']],
        updateConfig: {},
      },
    };
    const snapshot = {
      active: true,
      selectionSignature: 'signature:["Agent书"]',
      createdAt: 1,
      books: { Agent书: [{ uid: 1, previousEnabled: true, previousKeys: ['触发'], previousType: 'selective' }] },
    };
    mockResolvePreTakeoverSnapshot.mockResolvedValue({ snapshot, expectedSignature: 'signature:["Agent书"]' });

    await prepareAIInput_ACU([], 'standard', null, { tableData: explicitTableData });

    expect(getCombinedWorldbookContent_ACU).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        entryStateView: 'pre_takeover',
        entryStateSnapshot: snapshot,
        entryStateSnapshotSignature: 'signature:["Agent书"]',
      }),
    );
  });

  it('hydration 失败时继续准备填表输入，并以空签名让管线退化 live', async () => {
    const explicitTableData = {
      sheet_0: {
        uid: 'sheet_0',
        name: '显式表',
        content: [['row_id', 'name'], ['1', '显式值']],
        updateConfig: {},
      },
    };
    mockResolvePreTakeoverSnapshot.mockRejectedValue(new Error('snapshot unavailable'));

    await expect(prepareAIInput_ACU([], 'standard', null, { tableData: explicitTableData })).resolves.toBeTruthy();

    expect(getCombinedWorldbookContent_ACU).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        entryStateView: 'pre_takeover',
        entryStateSnapshot: undefined,
        entryStateSnapshotSignature: '',
      }),
    );
  });
});
