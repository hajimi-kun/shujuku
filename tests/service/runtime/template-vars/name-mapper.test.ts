/**
 * tests/service/runtime/template-vars/name-mapper.test.ts
 * NameMapper 单元测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock log 函数（name-mapper 通过 schema-mapper 间接使用，但自身也 import log）
vi.mock('../../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
}));

import { NameMapper } from '../../../../src/service/runtime/template-vars/name-mapper';

// ═══════════════════════════════════════════════════════════════
// 测试用 DDL
// ═══════════════════════════════════════════════════════════════
const INVENTORY_DDL = `CREATE TABLE inventory ( -- 背包物品表
  row_id INTEGER PRIMARY KEY, -- 行号
  item_name TEXT NOT NULL, -- 物品名称
  quantity INTEGER DEFAULT 1, -- 数量
  description TEXT -- 描述
);`;

const CHARACTERS_DDL = `CREATE TABLE characters ( -- 重要人物表
  row_id INTEGER PRIMARY KEY, -- 行号
  char_name TEXT NOT NULL, -- 姓名
  age INTEGER, -- 年龄
  status TEXT DEFAULT '存活' -- 状态
);`;

function buildTestMapper(): NameMapper {
  const ddlMap = new Map<string, string>();
  ddlMap.set('inventory', INVENTORY_DDL);
  ddlMap.set('characters', CHARACTERS_DDL);
  return NameMapper.fromDDLs(ddlMap);
}

describe('NameMapper', () => {
  let mapper: NameMapper;

  beforeEach(() => {
    mapper = buildTestMapper();
  });

  // ═══════════════════════════════════════════════════════════════
  // fromDDLs
  // ═══════════════════════════════════════════════════════════════
  describe('fromDDLs', () => {
    it('正确构建映射器', () => {
      expect(mapper.tableCount).toBe(2);
    });

    it('空 DDL Map 构建空映射器', () => {
      const emptyMapper = NameMapper.fromDDLs(new Map());
      expect(emptyMapper.tableCount).toBe(0);
    });

    it('跳过空 DDL 值', () => {
      const ddlMap = new Map<string, string>();
      ddlMap.set('test', '');
      ddlMap.set('inventory', INVENTORY_DDL);
      const m = NameMapper.fromDDLs(ddlMap);
      expect(m.tableCount).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // resolveTableName
  // ═══════════════════════════════════════════════════════════════
  describe('resolveTableName', () => {
    it('中文表名 → 英文表名', () => {
      expect(mapper.resolveTableName('背包物品表')).toBe('inventory');
      expect(mapper.resolveTableName('重要人物表')).toBe('characters');
    });

    it('英文表名直接透传', () => {
      expect(mapper.resolveTableName('inventory')).toBe('inventory');
      expect(mapper.resolveTableName('characters')).toBe('characters');
    });

    it('未知名称原样返回', () => {
      expect(mapper.resolveTableName('不存在的表')).toBe('不存在的表');
    });

    it('空字符串原样返回', () => {
      expect(mapper.resolveTableName('')).toBe('');
    });

    it('带空格的名称自动 trim', () => {
      expect(mapper.resolveTableName('  背包物品表  ')).toBe('inventory');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // resolveColumnName
  // ═══════════════════════════════════════════════════════════════
  describe('resolveColumnName', () => {
    it('中文列名 → 英文列名', () => {
      expect(mapper.resolveColumnName('inventory', '物品名称')).toBe('item_name');
      expect(mapper.resolveColumnName('inventory', '数量')).toBe('quantity');
      expect(mapper.resolveColumnName('characters', '姓名')).toBe('char_name');
    });

    it('英文列名直接透传', () => {
      expect(mapper.resolveColumnName('inventory', 'item_name')).toBe('item_name');
    });

    it('未知列名原样返回', () => {
      expect(mapper.resolveColumnName('inventory', '不存在的列')).toBe('不存在的列');
    });

    it('row_id 不在映射中（注释为"行号"但不需要映射）', () => {
      // row_id 在 parseDDLColumnComments 中会被解析，但 NameMapper 跳过 row_id
      // 所以 resolveColumnName('inventory', '行号') 应该原样返回
      // 因为 NameMapper.fromDDLs 中 colName !== 'row_id' 的条件过滤了它
      expect(mapper.resolveColumnName('inventory', 'row_id')).toBe('row_id');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getChineseTableName / getChineseColumnName
  // ═══════════════════════════════════════════════════════════════
  describe('反向映射', () => {
    it('英文表名 → 中文表名', () => {
      expect(mapper.getChineseTableName('inventory')).toBe('背包物品表');
      expect(mapper.getChineseTableName('characters')).toBe('重要人物表');
    });

    it('未知英文表名原样返回', () => {
      expect(mapper.getChineseTableName('unknown')).toBe('unknown');
    });

    it('英文列名 → 中文列名', () => {
      expect(mapper.getChineseColumnName('inventory', 'item_name')).toBe('物品名称');
      expect(mapper.getChineseColumnName('characters', 'char_name')).toBe('姓名');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // translateSql
  // ═══════════════════════════════════════════════════════════════
  describe('translateSql', () => {
    it('替换中文表名和列名', () => {
      const sql = 'SELECT 物品名称, 数量 FROM 背包物品表 WHERE 数量 > 3';
      const translated = mapper.translateSql(sql);
      expect(translated).toBe('SELECT item_name, quantity FROM inventory WHERE quantity > 3');
    });

    it('跳过字符串值中的中文', () => {
      const sql = "SELECT item_name FROM inventory WHERE item_name = '背包物品表'";
      const translated = mapper.translateSql(sql);
      // 字符串值中的"背包物品表"不应该被替换
      expect(translated).toContain("'背包物品表'");
      // 但 FROM 后面的表名不在引号中，应该保持不变（已经是英文）
      expect(translated).toContain('FROM inventory');
    });

    it('混合中英文', () => {
      const sql = 'SELECT char_name, 年龄 FROM 重要人物表 WHERE status = \'存活\'';
      const translated = mapper.translateSql(sql);
      expect(translated).toContain('age');
      expect(translated).toContain('characters');
      expect(translated).toContain('char_name');
      // 字符串值中的"存活"不应该被替换
      expect(translated).toContain("'存活'");
    });

    it('空 SQL 原样返回', () => {
      expect(mapper.translateSql('')).toBe('');
    });

    it('无中文的 SQL 原样返回', () => {
      const sql = 'SELECT * FROM inventory WHERE quantity > 5';
      expect(mapper.translateSql(sql)).toBe(sql);
    });

    it('长名称优先替换（避免子串误匹配）', () => {
      // 构造一个有子串关系的映射器
      const ddlMap = new Map<string, string>();
      ddlMap.set('items', `CREATE TABLE items ( -- 物品表
  row_id INTEGER PRIMARY KEY, -- 行号
  name TEXT -- 物品名称
);`);
      ddlMap.set('special_items', `CREATE TABLE special_items ( -- 特殊物品表
  row_id INTEGER PRIMARY KEY, -- 行号
  name TEXT -- 特殊物品名称
);`);
      const m = NameMapper.fromDDLs(ddlMap);

      // "特殊物品表" 应该被完整替换，不应该先替换 "物品表" 部分
      const sql = 'SELECT * FROM 特殊物品表';
      const translated = m.translateSql(sql);
      expect(translated).toBe('SELECT * FROM special_items');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getAllTableNames
  // ═══════════════════════════════════════════════════════════════
  describe('getAllTableNames', () => {
    it('返回所有英文表名', () => {
      const names = mapper.getAllTableNames();
      expect(names).toContain('inventory');
      expect(names).toContain('characters');
    });
  });
});
