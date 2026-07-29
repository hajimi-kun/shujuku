import { describe, expect, it } from 'vitest';
import { resolveReadQuerySql_ACU } from '../../src/shared/sql-read-resolver';

describe('sql read resolver', () => {
  it('把原始 DDL 表名和显示列名重绑定到运行时物理标识符', () => {
    const result = resolveReadQuerySql_ACU(
      'SELECT 内容 FROM chronicle WHERE 内容 = ?',
      {
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'sheet_0',
          name: '纪要表',
          sourceData: { ddl: 'CREATE TABLE chronicle (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  content TEXT -- 内容\n);' },
          content: [['row_id', '内容'], ['1', '记录']],
        },
      } as any,
      sql => sql,
    );

    expect(result).toMatchObject({
      sql: 'SELECT content FROM jiyaobiao WHERE content = ?',
      tableRebindCount: 1,
      columnRebindCount: 2,
      conflicts: [],
    });
  });

  it('token 重绑定后仍执行安全全文翻译，且不改写别名或注释', () => {
    const result = resolveReadQuerySql_ACU(
      'SELECT 内容, 旧兼容列 AS 内容 FROM chronicle -- 内容',
      {
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'sheet_0',
          name: '纪要表',
          sourceData: { ddl: 'CREATE TABLE chronicle (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  content TEXT -- 内容\n);' },
          content: [['row_id', '内容'], ['1', '记录']],
        },
      } as any,
      sql => sql.replaceAll('内容', 'content').replaceAll('旧兼容列', 'legacy_compatible_column'),
    );

    expect(result).toMatchObject({
      sql: 'SELECT content, legacy_compatible_column AS 内容 FROM jiyaobiao -- 内容',
      tableRebindCount: 1,
      columnRebindCount: 1,
    });
  });

  it('PRAGMA 参数原样透传，不交给全文翻译', () => {
    const result = resolveReadQuerySql_ACU('PRAGMA table_info(纪要表)', null, sql => sql.replaceAll('纪要表', 'jiyaobiao'));

    expect(result).toEqual({ sql: 'PRAGMA table_info(纪要表)', tableRebindCount: 0, columnRebindCount: 0 });
  });

  it('零 token 命中时仍保护输出别名、字面量与注释', () => {
    const translate = (sql: string) => sql.replaceAll('内容', 'content');

    expect(resolveReadQuerySql_ACU('SELECT 1 AS 内容 -- 内容', null, translate).sql)
      .toBe('SELECT 1 AS 内容 -- 内容');
    expect(resolveReadQuerySql_ACU("SELECT '内容' AS 内容 /* 内容 */", null, translate).sql)
      .toBe("SELECT '内容' AS 内容 /* 内容 */");
    expect(resolveReadQuerySql_ACU('SELECT 1 内容', null, translate).sql)
      .toBe('SELECT 1 内容');
  });

  it('零 token 命中时保护复杂投影表达式的隐式输出别名', () => {
    const translate = (sql: string) => sql
      .replaceAll('内容', 'content')
      .replaceAll('数量', 'quantity')
      .replaceAll('总数', 'total')
      .replaceAll('状态值', 'status_value');

    expect(resolveReadQuerySql_ACU('SELECT count(内容) 总数', null, translate).sql)
      .toBe('SELECT count(content) 总数');
    expect(resolveReadQuerySql_ACU('SELECT 内容 + 1 数量', null, translate).sql)
      .toBe('SELECT content + 1 数量');
    expect(resolveReadQuerySql_ACU('SELECT CASE WHEN 内容 THEN 1 ELSE 0 END 状态值', null, translate).sql)
      .toBe('SELECT CASE WHEN content THEN 1 ELSE 0 END 状态值');
    expect(resolveReadQuerySql_ACU('SELECT coalesce(内容, 0) 数量, count(内容) 总数 FROM missing_table', null, translate).sql)
      .toBe('SELECT coalesce(content, 0) 数量, count(content) 总数 FROM missing_table');
  });

  it('fallback 原始 DDL 列名竞争同一表头时不重绑定任一列', () => {
    const result = resolveReadQuerySql_ACU(
      'SELECT old_name_a, old_name_b FROM legacy',
      {
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'sheet_0',
          name: '回退表',
          sourceData: { ddl: 'CREATE TABLE legacy (old_name_a TEXT, -- 名称\nold_name_b TEXT -- 名称\n);' },
          content: [['row_id', '名称'], ['1', '值']],
        },
      } as any,
      sql => sql,
    );

    expect(result).toMatchObject({
      sql: 'SELECT old_name_a, old_name_b FROM huituibiao',
      tableRebindCount: 1,
      columnRebindCount: 0,
    });
    expect(result.columnConflicts).toEqual(expect.arrayContaining(['old_name_a', 'old_name_b']));
    expect(result.conflicts).toEqual(expect.arrayContaining(['old_name_a', 'old_name_b']));
  });

  it('仅报告本次查询实际引用的表别名冲突', () => {
    const tableData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        uid: 'sheet_0',
        name: 'Alpha',
        sourceData: { ddl: 'CREATE TABLE legacy (row_id INTEGER PRIMARY KEY);' },
        content: [['row_id'], ['1']],
      },
      sheet_1: {
        uid: 'sheet_1',
        name: 'Legacy',
        sourceData: { ddl: 'CREATE TABLE other (row_id INTEGER PRIMARY KEY);' },
        content: [['row_id'], ['1']],
      },
    } as any;

    expect(resolveReadQuerySql_ACU('SELECT * FROM missing_table', tableData, sql => sql)).toMatchObject({
      sql: 'SELECT * FROM missing_table',
      conflicts: [],
    });
    expect(resolveReadQuerySql_ACU('SELECT * FROM legacy', tableData, sql => sql)).toMatchObject({
      sql: 'SELECT * FROM legacy',
      tableRebindCount: 0,
      conflicts: ['legacy'],
    });
  });
});
