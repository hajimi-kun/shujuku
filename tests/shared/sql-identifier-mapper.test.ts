import { describe, expect, it } from 'vitest';
import {
  mapSqlColumnIdentifiers_ACU,
  toSqlIdentifierBase_ACU,
} from '../../src/shared/sql-identifier-mapper';
import { SqliteEngine } from '../../src/data/sqlite/sqlite-engine';

describe('sql identifier mapper', () => {
  it('固定首列 row_id，并以拼音映射中文和混合列名', () => {
    const result = mapSqlColumnIdentifiers_ACU(['row_id', '物品名称', '角色 Level']);
    expect(result.mappings.map(item => item.sqlName)).toEqual(['row_id', 'wu_pin_ming_cheng', 'jue_se_level']);
    expect(result.diagnostics).toEqual([]);
  });

  it('按 SQLite 大小写不敏感规则使用稳定后缀消除物理列冲突', () => {
    const result = mapSqlColumnIdentifiers_ACU(['row_id', 'Name', 'name', 'NAME']);
    expect(result.mappings.map(item => item.sqlName)).toEqual(['row_id', 'name', 'name_2', 'name_3']);
    const physicalCollision = mapSqlColumnIdentifiers_ACU(['row_id', 'a b', 'a-b', 'name_2']);
    expect(physicalCollision.mappings.map(item => item.sqlName)).toEqual(['row_id', 'a_b', 'a_b_2', 'name_2']);
  });

  it('将纯数字或空 slug 转为安全的 ASCII 标识符', () => {
    expect(toSqlIdentifierBase_ACU('2026')).toBe('col_2026');
    expect(toSqlIdentifierBase_ACU('😀', 4)).toBe('col_5');
  });

  it('报告重复 canonical 显示列和空列，而不静默掩盖输入错误', () => {
    const result = mapSqlColumnIdentifiers_ACU(['row_id', '名称', ' 名称 ', '']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'duplicate_canonical_column_name', index: 2, conflictsWithIndex: 1,
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'empty_column_name', index: 3 }));
  });

  it('row_id 不在首列时 fail closed，不会被误作主键', () => {
    const result = mapSqlColumnIdentifiers_ACU(['名称', 'row_id']);
    expect(result.mappings.map(item => item.sqlName)).toEqual(['ming_cheng', 'col_row_id']);
    expect(result.mappings[1].isRowId).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing_row_id', index: 0 }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'misplaced_row_id', index: 1 }));
  });

  it('将 SQLite 保留字安全地加前缀', () => {
    const result = mapSqlColumnIdentifiers_ACU(['row_id', 'select', 'table', 'index', 'returning']);
    expect(result.mappings.map(item => item.sqlName)).toEqual(['row_id', 'col_select', 'col_table', 'col_index', 'col_returning']);
  });

  it('生成的 fallback 标识符可由真实 SQLite 引擎执行', async () => {
    const engine = new SqliteEngine();
    await engine.init();
    try {
      const { mappings } = mapSqlColumnIdentifiers_ACU(['row_id', 'select', 'returning', 'a b', 'a-b']);
      engine.run(`CREATE TABLE mapper_probe (${mappings.map(mapping => (
        mapping.isRowId ? 'row_id INTEGER PRIMARY KEY' : `${mapping.sqlName} TEXT`
      )).join(', ')});`);
      expect(engine.getTableNames()).toContain('mapper_probe');
    } finally {
      engine.dispose();
    }
  });
});
