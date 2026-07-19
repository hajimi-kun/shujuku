/**
 * tests/service/ai/prompt-prepare-sql-mode.test.ts
 * prepareAIInput_ACU 在 SQL 模式下的行为测试
 *
 * 策略：mock 所有外部依赖，验证 SQL 模式下的表格格式化和 SQL 编辑格式说明追加
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

const mockGetEffectiveSeedRows = vi.fn(() => []);
vi.mock('../../../src/service/template/chat-scope', () => ({
  getEffectiveSeedRowsForSheet_ACU: (...args: any[]) => mockGetEffectiveSeedRows(...args),
  ensureChatSheetGuideSeeded_ACU: vi.fn().mockResolvedValue(null),
  attachSeedRowsToCurrentDataFromGuide_ACU: vi.fn(),
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

let mockCurrentJsonTableData: any = null;
let mockSettings: any = {};

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
}));

vi.mock('../../../src/service/runtime/helpers-remaining', () => ({
  applyContextTagFilters_ACU: vi.fn((c: string) => c),
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

import { prepareAIInput_ACU } from '../../../src/service/ai/prompt-builder/prompt-prepare';

// ═══════════════════════════════════════════════════════════════
// prepareAIInput_ACU — SQL 模式
// ═══════════════════════════════════════════════════════════════
describe('prepareAIInput_ACU — SQL 模式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveSeedRows.mockReturnValue([]);
    mockRuntimeProvider.mode = 'sqlite';
    mockRuntimeProvider.getCurrentData.mockImplementation(() => mockCurrentJsonTableData);
    mockIsSqliteMode = true;
    mockSettings = {
      tableContextExtractTags: '',
      tableContextExcludeTags: '',
      tableContextExtractRules: '',
      tableContextExcludeRules: '',
    };
  });

  it('currentJsonTableData 为 null 时返回 null', async () => {
    mockCurrentJsonTableData = null;
    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).toBeNull();
  });

  it('有 DDL 的表走 SQL 格式化路径', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: {
          ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT, quantity INTEGER);',
          note: '记录角色背包中的物品',
          insertNode: '获得新物品时插入',
          updateNode: '',
          deleteNode: '',
        },
        content: [['row_id', 'item_name', 'quantity'], ['1', '铁剑', '3']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    // SQL 模式下应输出 DDL
    expect(result!.tableDataText).toContain('CREATE TABLE inventory');
    // 应输出 Note 注释
    expect(result!.tableDataText).toContain('-- Note: 记录角色背包中的物品');
    // 应输出当前数据（注释格式）
    expect(result!.tableDataText).toContain('-- 当前数据');
  });

  it('无 DDL 的表走原生格式化路径', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: {
          note: '记录角色背包中的物品',
        },
        content: [['row_id', 'item_name', 'quantity'], ['1', '铁剑', '3']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    // 无 DDL 时走原生格式化，输出 [tableIndex:tableName] 格式
    expect(result!.tableDataText).toContain('[0:背包物品表]');
    expect(result!.tableDataText).toContain('Columns:');
  });

  it('SQL 模式下 $0 不直接从模板 seedRows 兜底，数据必须来自运行时 DB', async () => {
    mockGetEffectiveSeedRows.mockReturnValue([['1', '格里芬临时基地-指挥室', '2062-07-18 14:35', 1]]);
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '当前位置',
        sourceData: {
          ddl: 'CREATE TABLE global_state (row_id INTEGER PRIMARY KEY, current_location TEXT, cur_time TEXT, day_count INTEGER);',
          note: '记录当前位置。',
        },
        content: [['row_id', '当前位置', '当前时间', '天数']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');

    expect(result).not.toBeNull();
    expect(result!.tableDataText).toContain('-- (该表格为空，请进行初始化。)');
    expect(result!.tableDataText).not.toContain('格里芬临时基地-指挥室');
  });

  it('SQL 编辑格式说明被追加到 tableDataText 末尾', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: {
          ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);',
        },
        content: [['row_id'], ['1']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    expect(result!.tableDataText).toContain('SQL 编辑格式说明');
    expect(result!.tableDataText).toContain('INSERT INTO');
    expect(result!.tableDataText).toContain('UNIQUE 约束');
    expect(result!.tableDataText).toContain('表达式更新');
  });

  it('非 SQL 模式下不追加 SQL 编辑格式说明', async () => {
    mockIsSqliteMode = false;
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: {
          note: '记录角色背包中的物品',
        },
        content: [['row_id', 'item_name'], ['1', '铁剑']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    expect(result!.tableDataText).not.toContain('SQL 编辑格式说明');
  });

  it('混合表格：有 DDL 和无 DDL 的表共存', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: {
          ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);',
          note: '背包',
        },
        content: [['row_id', 'item_name'], ['1', '铁剑']],
        updateConfig: {},
      },
      sheet_1: {
        name: '角色表',
        sourceData: {
          note: '角色信息',
          // 无 DDL
        },
        content: [['row_id', 'name'], ['1', '角色A']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    // 有 DDL 的表走 SQL 格式化
    expect(result!.tableDataText).toContain('CREATE TABLE inventory');
    // 无 DDL 的表走原生格式化
    expect(result!.tableDataText).toContain('[1:角色表]');
  });

  it('SQL 模式下忽略显式 tableData，优先使用运行时 DB 数据', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '运行时表',
        sourceData: {
          ddl: 'CREATE TABLE runtime_table (row_id INTEGER PRIMARY KEY, value TEXT);',
        },
        content: [['row_id', 'value'], ['1', '运行时值']],
        updateConfig: {},
      },
    };
    const explicitTableData = {
      sheet_0: {
        name: '显式快照表',
        sourceData: {
          ddl: 'CREATE TABLE explicit_table (row_id INTEGER PRIMARY KEY, value TEXT);',
        },
        content: [['row_id', 'value'], ['1', '显式快照值']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard', null, { tableData: explicitTableData });

    expect(result).not.toBeNull();
    expect(result!.tableDataText).toContain('CREATE TABLE runtime_table');
    expect(result!.tableDataText).toContain('运行时值');
    expect(result!.tableDataText).not.toContain('explicit_table');
    expect(result!.tableDataText).not.toContain('显式快照值');
  });

  it('targetSheetKeys 过滤只输出指定表', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: {
          ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);',
        },
        content: [['row_id'], ['1']],
        updateConfig: {},
      },
      sheet_1: {
        name: '角色表',
        sourceData: {
          ddl: 'CREATE TABLE characters (row_id INTEGER PRIMARY KEY);',
        },
        content: [['row_id'], ['1']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard', ['sheet_1']);
    expect(result).not.toBeNull();
    // 只输出 sheet_1
    expect(result!.tableDataText).toContain('CREATE TABLE characters');
    expect(result!.tableDataText).not.toContain('CREATE TABLE inventory');
  });

  it('对话消息被正确格式化', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
        content: [['row_id'], ['1']],
        updateConfig: {},
      },
    };

    const messages = [
      { is_user: true, mes: '你好' },
      { is_user: false, name: '角色', mes: '你好啊' },
    ];

    const result = await prepareAIInput_ACU(messages, 'standard');
    expect(result).not.toBeNull();
    expect(result!.messagesText).toContain('用户: 你好');
    expect(result!.messagesText).toContain('角色: 你好啊');
  });

  it('空消息数组时输出无最新对话内容', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
        content: [['row_id'], ['1']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    expect(result!.messagesText).toContain('无最新对话内容');
  });
});
