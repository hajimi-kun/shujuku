/**
 * tests/data/sqlite/sync-bridge.test.ts
 * SyncBridge 组合测试 — 使用真实 SqliteEngine + schema-mapper
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteEngine } from '../../../src/data/sqlite/sqlite-engine';
import { SyncBridge } from '../../../src/data/sqlite/sync-bridge';
import type { TableDataObject_ACU, Sheet_ACU, Mate_ACU } from '../../../src/shared/models/table-data';

// ═══════════════════════════════════════════════════════════════
// 辅助：构造测试数据
// ═══════════════════════════════════════════════════════════════
function makeMate(): Mate_ACU {
  return {
    type: 'acu_table_data',
    version: 3,
    updateConfigUiSentinel: 0,
    globalInjectionConfig: {
      readableEntryPlacement: { position: 'before_char', depth: 4, order: 100 },
      wrapperPlacement: { position: 'before_char', depth: 4, order: 100 },
    },
  };
}

function makeSheet(overrides: Partial<Sheet_ACU> = {}): Sheet_ACU {
  return {
    uid: 'inventory',
    name: '背包物品表',
    sourceData: {
      note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
      ddl: `CREATE TABLE inventory ( -- 背包物品表
  row_id INTEGER PRIMARY KEY, -- 行号
  item_name TEXT NOT NULL, -- 物品名称
  quantity INTEGER DEFAULT 1, -- 数量
  description TEXT -- 描述
);`,
    },
    content: [
      ['row_id', '物品名称', '数量', '描述'],
      ['1', '铁剑', '3', '普通的铁剑'],
      ['2', '治疗药水', '5', '恢复少量HP'],
    ],
    updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
    exportConfig: {} as any,
    orderNo: 0,
    ...overrides,
  };
}

function makeTableData(sheets: Record<string, Sheet_ACU> = {}): TableDataObject_ACU {
  const data: TableDataObject_ACU = { mate: makeMate() };
  for (const [key, sheet] of Object.entries(sheets)) {
    data[key] = sheet;
  }
  return data;
}

describe('SyncBridge', () => {
  let engine: SqliteEngine;
  let bridge: SyncBridge;

  beforeEach(async () => {
    engine = new SqliteEngine();
    await engine.init();
    bridge = new SyncBridge(engine);
  });

  afterEach(() => {
    engine.dispose();
  });

  // ═══════════════════════════════════════════════════════════════
  // loadFromTableData
  // ═══════════════════════════════════════════════════════════════
  describe('loadFromTableData', () => {
    it('加载单张表到 SQLite', () => {
      const data = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(data);

      // 验证表已创建
      const tableNames = engine.getTableNames();
      expect(tableNames).toContain('inventory');

      // 验证数据已灌入
      const result = engine.query('SELECT * FROM inventory;');
      expect(result.values).toHaveLength(2);
      expect(result.values[0][1]).toBe('铁剑');
      expect(result.values[1][1]).toBe('治疗药水');
    });

    it('加载多张表', () => {
      const sheet2 = makeSheet({
        uid: 'characters',
        name: '重要人物表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE characters ( -- 重要人物表
  row_id INTEGER PRIMARY KEY, -- 行号
  char_name TEXT NOT NULL, -- 姓名
  status TEXT DEFAULT '存活' -- 状态
);`,
        },
        content: [
          ['row_id', '姓名', '状态'],
          ['1', '角色A', '存活'],
        ],
      });

      const data = makeTableData({
        sheet_0: makeSheet(),
        sheet_1: sheet2,
      });
      bridge.loadFromTableData(data);

      expect(engine.getTableNames()).toContain('inventory');
      expect(engine.getTableNames()).toContain('characters');
    });

    it('null 或空对象不报错', () => {
      expect(() => bridge.loadFromTableData(null as any)).not.toThrow();
      expect(() => bridge.loadFromTableData({} as any)).not.toThrow();
    });

    it('引擎未初始化时抛出错误', () => {
      engine.dispose();
      const data = makeTableData({ sheet_0: makeSheet() });
      expect(() => bridge.loadFromTableData(data)).toThrow('未初始化');
    });

    it('加载快照时保留 NOT NULL 字段中的空字符串', () => {
      const characterSheet = makeSheet({
        uid: 'characters',
        name: '角色表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE characters ( -- 角色表
  row_id INTEGER PRIMARY KEY, -- 行号
  name TEXT NOT NULL, -- 姓名
  note TEXT NOT NULL DEFAULT '' -- 备注
);`,
        },
        content: [
          ['row_id', '姓名', '备注'],
          ['1', '角色A', ''],
        ],
      });
      const data = makeTableData({ sheet_0: characterSheet });

      expect(() => bridge.loadFromTableData(data, { strict: true })).not.toThrow();

      const result = engine.query('SELECT note FROM characters WHERE name = ?;', ['角色A']);
      expect(result.values[0][0]).toBe('');
    });

    it('旧 chronicle 表头错序时按 DDL 注释写入正确物理列并保持 round-trip', () => {
      const chronicleSheet = makeSheet({
        uid: 'chronicle',
        name: '纪要表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE chronicle ( -- 纪要表
  row_id INTEGER PRIMARY KEY, -- 行号
  code_index TEXT, -- 编码索引
  time_span TEXT, -- 时间跨度
  summary TEXT, -- 概览
  chronicle_text TEXT, -- 纪要
  key_dialogue TEXT -- 重要对话
);`,
        },
        content: [
          ['row_id', '纪要', '编码索引', '时间跨度', '概览', '重要对话'],
          ['1', '完整纪要正文', 'AM0001', '2026-10-15 14:30 ~ 2026-10-15 15:00', '摘要', null],
        ],
      });

      bridge.loadFromTableData(makeTableData({ sheet_chronicle: chronicleSheet }), { strict: true });

      expect(engine.query(
        'SELECT code_index, time_span, summary, chronicle_text, key_dialogue FROM chronicle WHERE row_id = 1;'
      ).values).toEqual([
        ['AM0001', '2026-10-15 14:30 ~ 2026-10-15 15:00', '摘要', '完整纪要正文', null],
      ]);

      const exported = bridge.exportToTableData(makeMate()).sheet_chronicle as Sheet_ACU;
      expect(exported.content).toEqual([
        ['row_id', '编码索引', '时间跨度', '概览', '纪要', '重要对话'],
        ['1', 'AM0001', '2026-10-15 14:30 ~ 2026-10-15 15:00', '摘要', '完整纪要正文', null],
      ]);
    });

    it('非 strict 模式下必需值缺失时不留下半建表状态', () => {
      const invalidSheet = makeSheet({
        uid: 'required_value',
        name: '必填值表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE required_value (
  row_id INTEGER PRIMARY KEY, -- 行号
  name TEXT NOT NULL -- 名称
);`,
        },
        content: [
          ['row_id', '名称'],
          ['1', null],
        ],
      });

      expect(() => bridge.loadFromTableData(makeTableData({ sheet_invalid: invalidSheet }))).not.toThrow();
      expect(engine.getTableNames()).not.toContain('required_value');
    });

    it('非 strict 模式下失败表不写 meta，后续合法表仍完整加载', () => {
      const invalidSheet = makeSheet({
        uid: 'required_value',
        name: '必填值表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE required_value (
  row_id INTEGER PRIMARY KEY, -- 行号
  name TEXT NOT NULL -- 名称
);`,
        },
        content: [
          ['row_id', '名称'],
          ['1', null],
        ],
      });

      bridge.loadFromTableData(makeTableData({ sheet_invalid: invalidSheet, sheet_valid: makeSheet() }));

      expect(engine.getTableNames()).not.toContain('required_value');
      expect(engine.query("SELECT sheet_key FROM _acu_sheet_meta WHERE sheet_key = 'sheet_invalid';").values).toEqual([]);
      expect(engine.getTableNames()).toContain('inventory');
      expect(engine.query('SELECT item_name FROM inventory ORDER BY row_id;').values).toEqual([
        ['铁剑'],
        ['治疗药水'],
      ]);
    });

    it('非 strict 模式下 INSERT 约束失败会回滚用户表和 meta，后续表继续加载', () => {
      const invalidSheet = makeSheet({
        uid: 'checked_value',
        name: '受约束表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE checked_value (
  row_id INTEGER PRIMARY KEY, -- 行号
  name TEXT NOT NULL CHECK(length(name) >= 3) -- 名称
);`,
        },
        content: [
          ['row_id', '名称'],
          ['1', '短'],
        ],
      });

      bridge.loadFromTableData(makeTableData({ sheet_invalid: invalidSheet, sheet_valid: makeSheet() }));

      expect(engine.getTableNames()).not.toContain('checked_value');
      expect(engine.query("SELECT sheet_key FROM _acu_sheet_meta WHERE sheet_key = 'sheet_invalid';").values).toEqual([]);
      expect(engine.getTableNames()).toContain('inventory');
      expect(engine.query('SELECT item_name FROM inventory ORDER BY row_id;').values).toEqual([
        ['铁剑'],
        ['治疗药水'],
      ]);
    });

    it('单张表加载失败不影响其他表', () => {
      // 第一张表 DDL 有语法错误
      const badSheet = makeSheet({
        uid: 'bad_table',
        name: '坏表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: 'CREATE TABLE bad_table ( INVALID SYNTAX;',
        },
      });

      const data = makeTableData({
        sheet_0: badSheet,
        sheet_1: makeSheet(),
      });

      // 不应该抛出错误（内部 try-catch 隔离）
      expect(() => bridge.loadFromTableData(data)).not.toThrow();

      // 好的表应该正常加载
      expect(engine.getTableNames()).toContain('inventory');
    });

    it('同一快照内重复 row_id 时保留最后一行且不让整表从导出结果消失', () => {
      const duplicatedRowSheet = makeSheet({
        content: [
          ['row_id', '物品名称', '数量', '描述'],
          ['1', '旧种子行', '1', '模板 seedRows'],
          ['1', '新快照行', '9', '后续消息覆盖'],
        ],
      });

      expect(() => bridge.loadFromTableData(makeTableData({ sheet_0: duplicatedRowSheet }))).not.toThrow();
      expect(engine.query('SELECT item_name, quantity, description FROM inventory ORDER BY row_id;').values).toEqual([
        ['新快照行', 9, '后续消息覆盖'],
      ]);

      const exported = bridge.exportToTableData(makeMate());
      expect(Object.keys(exported).filter(k => k.startsWith('sheet_'))).toEqual(['sheet_0']);
      expect((exported.sheet_0 as Sheet_ACU).content).toEqual([
        ['row_id', '物品名称', '数量', '描述'],
        ['1', '新快照行', '9', '后续消息覆盖'],
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // exportToTableData
  // ═══════════════════════════════════════════════════════════════
  describe('exportToTableData', () => {
    it('从 SQLite 导出为 TableDataObject', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      expect(exported.mate).toBeDefined();

      // 找到导出的 sheet
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      expect(sheetKeys).toHaveLength(1);

      const sheet = exported[sheetKeys[0]] as Sheet_ACU;
      expect(sheet.name).toBe('背包物品表');
      expect(sheet.content).toHaveLength(3); // 表头 + 2 行数据
      expect(sheet.content[0]).toContain('物品名称'); // 中文表头还原
    });

    it('导出后数据与原始数据一致', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      const sheet = exported[sheetKeys[0]] as Sheet_ACU;

      // 数据行数一致
      expect(sheet.content.length).toBe(3);
      // 第一行数据的物品名称
      expect(sheet.content[1]).toContain('铁剑');
      expect(sheet.content[2]).toContain('治疗药水');
    });

    it('空表导出时从 DDL 恢复完整表头，避免只剩 row_id', () => {
      const emptySheet = makeSheet({
        uid: 'tdoll_construction',
        name: '人形建造表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE tdoll_construction ( -- 人形建造表
  row_id INTEGER PRIMARY KEY, -- 行号
  start_time TEXT NOT NULL, -- 开始时间
  construction_time TEXT NOT NULL, -- 建造时间
  cost_manpower INTEGER NOT NULL CHECK(cost_manpower >= 0), -- 消耗人力
  cost_ammo INTEGER NOT NULL CHECK(cost_ammo >= 0), -- 消耗弹药
  cost_ration INTEGER NOT NULL CHECK(cost_ration >= 0), -- 消耗口粮
  cost_parts INTEGER NOT NULL CHECK(cost_parts >= 0) -- 消耗零件
);`,
        },
        content: [['行号', '开始时间', '建造时间', '消耗人力', '消耗弹药', '消耗口粮', '消耗零件']],
      });
      const originalData = makeTableData({ sheet_empty: emptySheet });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      const sheet = exported.sheet_empty as Sheet_ACU;

      expect(sheet.content).toHaveLength(1);
      expect(sheet.content[0]).toEqual(['row_id', '开始时间', '建造时间', '消耗人力', '消耗弹药', '消耗口粮', '消耗零件']);
    });

    it('引擎未初始化时抛出错误', () => {
      engine.dispose();
      expect(() => bridge.exportToTableData(makeMate())).toThrow('未初始化');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // syncToJson
  // ═══════════════════════════════════════════════════════════════
  describe('syncToJson', () => {
    it('同步 SQLite 数据到 JSON 视图', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      // 在 SQLite 中修改数据
      engine.run("UPDATE inventory SET quantity = 10 WHERE item_name = '铁剑';");

      // 同步到 JSON
      const synced = bridge.syncToJson(originalData);
      const sheetKeys = Object.keys(synced).filter(k => k.startsWith('sheet_'));
      const sheet = synced[sheetKeys[0]] as Sheet_ACU;

      // 验证修改已同步
      // 找到铁剑那行，检查数量
      const ironSwordRow = sheet.content.find(row => row.includes('铁剑'));
      expect(ironSwordRow).toBeDefined();
      // quantity 列的值应该是 '10'（content 中全是 string）
      expect(ironSwordRow).toContain('10');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 元数据保存与恢复
  // ═══════════════════════════════════════════════════════════════
  describe('元数据保存与恢复', () => {
    it('sourceData 在导出后保留', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      const sheet = exported[sheetKeys[0]] as Sheet_ACU;

      expect(sheet.sourceData).toBeDefined();
      expect(sheet.sourceData.ddl).toContain('CREATE TABLE inventory');
    });

    it('uid 和 name 在导出后保留', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      const sheet = exported[sheetKeys[0]] as Sheet_ACU;

      expect(sheet.uid).toBe('inventory');
      expect(sheet.name).toBe('背包物品表');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 无 DDL 的 fallback 模式
  // ═══════════════════════════════════════════════════════════════
  describe('无 DDL 的 fallback 模式', () => {
    it('无 DDL 时自动生成全 TEXT DDL', () => {
      const sheet = makeSheet({
        sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '' },
        content: [
          ['row_id', 'name', 'value'],
          ['1', 'test', '100'],
        ],
      });
      const data = makeTableData({ sheet_0: sheet });
      bridge.loadFromTableData(data);

      // 表应该被创建（使用 uid 作为表名）
      const tableNames = engine.getTableNames();
      expect(tableNames.length).toBeGreaterThan(0);

      // 数据应该被灌入
      const tableName = tableNames[0];
      const result = engine.query(`SELECT * FROM ${tableName};`);
      expect(result.values).toHaveLength(1);
    });
  });
});
