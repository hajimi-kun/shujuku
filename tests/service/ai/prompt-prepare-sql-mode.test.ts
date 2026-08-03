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
  // 模板范围默认「未知」，即不过滤，保持既有用例语义。
  resolveTemplateScope_ACU: vi.fn(() => null),
  filterSheetKeysByTemplateScope_ACU: vi.fn((keys: string[]) => [...keys]),
  projectSheetForTemplateScope_ACU: vi.fn((sheet: any) => sheet),
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  hashUserInput_ACU: vi.fn((text: string) => text ? 'mock-ddl-digest' : ''),
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

const mockEnsureStorageProviderReady = vi.fn();
const mockGetStorageRuntimeHealth = vi.fn(() => ({
  status: 'ready', expectedMode: 'sqlite', activeMode: 'sqlite', loadToken: 1,
}));
const mockRuntimeProvider = {
  mode: 'sqlite',
  isReady: vi.fn(() => true),
  getCurrentData: vi.fn(() => mockCurrentJsonTableData),
};
vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  ensureStorageProviderReady_ACU: (...args: any[]) => mockEnsureStorageProviderReady(...args),
  getStorageRuntimeHealth_ACU: () => mockGetStorageRuntimeHealth(),
}));

import { formatTableForSqliteMode, prepareAIInput_ACU } from '../../../src/service/ai/prompt-builder/prompt-prepare';
import { SqliteEngine } from '../../../src/data/sqlite/sqlite-engine';
import { SyncBridge } from '../../../src/data/sqlite/sync-bridge';

// ═══════════════════════════════════════════════════════════════
// prepareAIInput_ACU — SQL 模式
// ═══════════════════════════════════════════════════════════════
describe('prepareAIInput_ACU — SQL 模式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveSeedRows.mockReturnValue([]);
    mockRuntimeProvider.mode = 'sqlite';
    mockRuntimeProvider.getCurrentData.mockImplementation(() => mockCurrentJsonTableData);
    mockEnsureStorageProviderReady.mockReset().mockResolvedValue(mockRuntimeProvider);
    mockGetStorageRuntimeHealth.mockReturnValue({
      status: 'ready', expectedMode: 'sqlite', activeMode: 'sqlite', loadToken: 1,
    });
    mockIsSqliteMode = true;
    mockSettings = {
      tableContextExtractTags: '',
      tableContextExcludeTags: '',
      tableContextExtractRules: '',
      tableContextExcludeRules: '',
    };
  });

  it('currentJsonTableData 为 null 时返回 runtime_export_null', async () => {
    mockCurrentJsonTableData = null;
    await expect(prepareAIInput_ACU([], 'standard')).resolves.toEqual({
      ok: false,
      failureCode: 'runtime_export_null',
      message: 'SQLite 运行时未导出可用表格数据。',
      retryable: true,
    });
  });

  it('SQLite runtime loading 时返回可操作的 failure code', async () => {
    mockEnsureStorageProviderReady.mockRejectedValueOnce(new Error('runtime pending'));
    mockGetStorageRuntimeHealth.mockReturnValueOnce({
      status: 'loading', expectedMode: 'sqlite', activeMode: null, loadToken: 2,
    });

    await expect(prepareAIInput_ACU([], 'standard')).resolves.toEqual({
      ok: false,
      failureCode: 'runtime_loading',
      message: 'SQLite 运行时正在加载，请等待加载完成后重试。',
      retryable: true,
    });
  });

  it('SQLite fallback 到 native 时返回 provider_fallback 而不是笼统 null', async () => {
    mockEnsureStorageProviderReady.mockRejectedValueOnce(new Error('provider fallback'));
    mockGetStorageRuntimeHealth.mockReturnValueOnce({
      status: 'degraded', expectedMode: 'sqlite', activeMode: 'native', loadToken: 2, failureCode: 'provider_fallback',
    });

    await expect(prepareAIInput_ACU([], 'standard')).resolves.toEqual({
      ok: false,
      failureCode: 'provider_fallback',
      message: 'SQLite 运行时加载失败，当前未使用 SQLite 数据库。',
      retryable: false,
    });
  });

  it('SQLite provider 导出空数据时返回 runtime_export_null', async () => {
    mockCurrentJsonTableData = null;

    await expect(prepareAIInput_ACU([], 'standard')).resolves.toEqual({
      ok: false,
      failureCode: 'runtime_export_null',
      message: 'SQLite 运行时未导出可用表格数据。',
      retryable: true,
    });
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
    expect(result!.tableDataText).toContain('CREATE TABLE inventory');
    expect(result!.tableDataText).not.toContain('CREATE TABLE beibaowupinbiao');
    expect(result!.tableDataText).toContain('SQL 写入必须使用表名 inventory；系统会在执行时映射到内部表。');
    // 应输出 Note 注释
    expect(result!.tableDataText).toContain('-- Note: 记录角色背包中的物品');
    // 应输出当前数据（注释格式）
    expect(result!.tableDataText).toContain('-- 当前数据');
  });

  it('显式 sqlApplyScope 存在时，prompt 使用请求前模板的作者英文名而不是运行时 DDL 名', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        uid: 'inventory',
        name: '切换后模板表',
        sourceData: { ddl: 'CREATE TABLE runtime_table (row_id INTEGER PRIMARY KEY, value TEXT);' },
        content: [['row_id', 'value'], ['1', '运行时数据']],
        updateConfig: {},
      },
    };
    const requestTemplate = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        uid: 'inventory',
        name: '请求前模板表',
        sourceData: { ddl: 'CREATE TABLE request_contract (row_id INTEGER PRIMARY KEY, value TEXT);' },
        content: [['row_id', 'value']],
        updateConfig: {},
        exportConfig: {},
        orderNo: 0,
      },
    } as any;

    const result = await prepareAIInput_ACU([], 'standard', null, {
      templateScope: { sheetKeys: new Set(['sheet_0']), sheets: { sheet_0: requestTemplate.sheet_0 } },
      sqlApplyScope: {
        isolationKey: 'scope-a',
        templateData: requestTemplate,
        templateDataWithRows: requestTemplate,
      },
    });

    expect(result).not.toBeNull();
    expect(result!.tableDataText).toContain('CREATE TABLE request_contract');
    expect(result!.tableDataText).not.toContain('CREATE TABLE runtime_table');
    expect(result!.tableDataText).not.toContain('CREATE TABLE qingqiuqianmubanbiao');
    expect(result!.tableDataText).toContain('运行时数据');
  });

  it('请求模板内作者 DDL 表名冲突时返回结构化失败，不构造可能误写的 AI prompt', async () => {
    mockCurrentJsonTableData = {
      sheet_0: { name: '甲表', sourceData: { ddl: 'CREATE TABLE shared_legacy (row_id INTEGER PRIMARY KEY);' }, content: [['row_id'], ['1']], updateConfig: {} },
      sheet_1: { name: '乙表', sourceData: { ddl: 'CREATE TABLE shared_legacy (row_id INTEGER PRIMARY KEY);' }, content: [['row_id'], ['1']], updateConfig: {} },
    };

    await expect(prepareAIInput_ACU([], 'standard')).resolves.toEqual({
      ok: false,
      failureCode: 'authored_table_name_conflict',
      message: '模板中多个表共用作者 DDL 表名「shared_legacy」，无法安全路由 AI SQL。',
      retryable: false,
    });
  });

  it('无 DDL 的表在 SQLite 模式下使用 effective fallback DDL，且不使用 seedRows', async () => {
    mockGetEffectiveSeedRows.mockReturnValue([['9', '不应出现', '999']]);
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
    expect(result!.tableDataText).toContain('CREATE TABLE beibaowupinbiao');
    expect(result!.tableDataText).toContain('-- WARNING: DDL 缺失，已使用运行时 fallback schema。 原始 DDL 未被改写。');
    expect(result!.tableDataText).toContain('-- | row_id | item_name | quantity |');
    expect(result!.tableDataText).not.toContain('不应出现');
  });

  it('显式 DDL 与遗留错序表头共存时按共享 columnMap 重排列名和行值', () => {
    const text = formatTableForSqliteMode({
      uid: 'chronicle',
      name: '纪要表',
      sourceData: {
        ddl: `CREATE TABLE chronicle (
          row_id INTEGER PRIMARY KEY, -- 行号
          code_index TEXT, -- 编码索引
          chronicle_text TEXT -- 纪要
        );`,
      },
      content: [['row_id', '纪要', '编码索引'], ['1', '完整纪要正文', 'AM0001']],
      updateConfig: {},
    }, 0, 'sheet_chronicle', null, { allowSeedRowsFallback: false });

    expect(text).toContain('-- | row_id | code_index | chronicle_text |');
    expect(text).toContain('-- | 1 | AM0001 | 完整纪要正文 |');
  });

  it('运行时建表失败 fallback 后，prompt 使用已采用的 runtime schema 而非原始 DDL', () => {
    const table: any = {
      uid: 'execution_broken',
      name: '执行失败回退表',
      sourceData: {
        ddl: 'CREATE TABLE execution_broken (row_id INTEGER PRIMARY KEY, item_name TEXT) INVALID_SUFFIX;',
      },
      content: [['row_id', '物品名称'], ['1', '铁剑']],
      updateConfig: {},
    };
    Object.defineProperty(table, '_acu_runtimeEffectiveSchema', {
      enumerable: false,
      value: {
        source: 'fallback_invalid',
        diagnostics: ['显式 DDL 无法在 runtime SQLite 执行，已使用 fallback schema。'],
        effectiveDDL: 'CREATE TABLE execution_broken (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  wu_pin_ming_cheng TEXT -- 物品名称\n);',
        columnMap: {
          mappings: [
            { sourceIndex: 0, displayName: 'row_id', sqlName: 'row_id', required: true },
            { sourceIndex: 1, displayName: '物品名称', sqlName: 'wu_pin_ming_cheng', required: false },
          ],
        },
      },
    });

    const text = formatTableForSqliteMode(table, 0, 'sheet_execution', null, {
      allowSeedRowsFallback: false,
      runtimeTableName: 'zhixinghuibiao',
      authoredTableName: 'execution_broken',
    });

    expect(text).toContain('CREATE TABLE execution_broken');
    expect(text).not.toContain('CREATE TABLE zhixinghuibiao');
    expect(text).toContain('wu_pin_ming_cheng TEXT');
    expect(text).toContain('-- | row_id | wu_pin_ming_cheng |');
    expect(text).not.toContain('INVALID_SUFFIX');
  });

  it('执行期 fallback 经真实 export 和 runtime provider 后，prompt 仍使用实际 schema', async () => {
    const engine = new SqliteEngine();
    const bridge = new SyncBridge(engine);
    const originalDdl = 'CREATE TABLE execution_broken (row_id INTEGER PRIMARY KEY, -- 行号\nitem_name TEXT -- 物品名称\n) INVALID_SUFFIX;';
    try {
      await engine.init();
      bridge.loadFromTableData({
        mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: {} },
        sheet_execution: {
          uid: 'execution_broken',
          name: '执行失败回退表',
          sourceData: { ddl: originalDdl },
          content: [['row_id', '物品名称'], ['1', '铁剑']],
          updateConfig: {},
          exportConfig: {},
          orderNo: 0,
        },
      } as any, { strict: true, allowRuntimeDdlFallback: true });
      mockCurrentJsonTableData = bridge.exportToTableData({
        type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: {},
      } as any);

      const result = await prepareAIInput_ACU([], 'standard');

      expect(result!.tableDataText).toContain('wu_pin_ming_cheng TEXT');
      expect(result!.tableDataText).toContain('-- | row_id | wu_pin_ming_cheng |');
      expect(result!.tableDataText).not.toContain('INVALID_SUFFIX');
      expect((mockCurrentJsonTableData as any).sheet_execution.sourceData.ddl).toBe(originalDdl);
    } finally {
      engine.dispose();
    }
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
    expect(result!.tableDataText).toContain('INSERT OR REPLACE INTO');
    expect(result!.tableDataText).toContain('REPLACE INTO');
    expect(result!.tableDataText).toContain('普通 INSERT 必须显式列出业务列，不得包含 row_id');
    expect(result!.tableDataText).toContain('row_id 由系统在执行前分配稳定身份');
    expect(result!.tableDataText).not.toContain('row_id 值为当前表最大 row_id + 1');
    expect(result!.tableDataText).toContain('UNIQUE 约束');
    expect(result!.tableDataText).toContain('SQL 表名和列名必须严格使用上方 CREATE TABLE 中的英文标识符');
    expect(result!.tableDataText).toContain('<tableEdit> 标签内');
    expect(result!.tableDataText).toContain('表达式更新');
    expect(result!.tableDataText).toContain('按 SQLite 原生整行替换语义执行');
  });

  it('strict JSON 模式沿用同一英文标识符契约', async () => {
    mockSettings.strictJsonTableFillEnabled = true;
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);' },
        content: [['row_id', 'item_name'], ['1', '铁剑']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    expect(result!.tableDataText).toContain('CREATE TABLE inventory');
    expect(result!.tableDataText).not.toContain('CREATE TABLE beibaowupinbiao');
    expect(result!.tableDataText).toContain('响应 JSON 的 sql 字符串中');
    expect(result!.tableDataText).toContain('SQL 表名和列名必须严格使用上方 CREATE TABLE 中的英文标识符');
  });

  it('固定 row_id 约束不再生成专用 REPLACE 许可注释', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '鉴定建议表',
        sourceData: {
          ddl: 'CREATE TABLE advice (row_id INTEGER PRIMARY KEY CHECK (row_id BETWEEN 1 AND 5), advice TEXT);',
        },
        content: [['row_id', 'advice'], ['1', '先鉴定']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    expect(result!.tableDataText).not.toContain('-- REPLACE:');
  });

  it('普通表同样声明 REPLACE 原生语义而不生成专用许可注释', async () => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: {
          ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);',
        },
        content: [['row_id', 'item_name'], ['1', '铁剑']],
        updateConfig: {},
      },
    };

    const result = await prepareAIInput_ACU([], 'standard');
    expect(result).not.toBeNull();
    expect(result!.tableDataText).not.toContain('-- REPLACE:');
    expect(result!.tableDataText).toContain('按 SQLite 原生整行替换语义执行');
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
    // 无 DDL 的表也必须走 SQL effective fallback，避免模型收到无法执行的原生 DSL。
    expect(result!.tableDataText).toContain('CREATE TABLE juesebiao');
    expect(result!.tableDataText).toContain('-- | row_id | name |');
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
