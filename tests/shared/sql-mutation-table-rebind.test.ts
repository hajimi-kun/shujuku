import { describe, expect, it } from 'vitest';
import { decodeSqlIdentifier_ACU, rebindSqlMutationTableReferences_ACU, rebindSqlReadIdentifiers_ACU } from '../../src/shared/sql-mutation-table-rebind';

describe('sql mutation table rebind', () => {
  it('只重绑定表引用，保持字符串和注释原样', () => {
    const [result] = rebindSqlMutationTableReferences_ACU([
      "UPDATE global_state SET note = 'global_state literal' /* global_state comment */ WHERE row_id = 1",
    ], new Map([['global_state', 'quanjushujubiao']]));

    expect(result).toBe("UPDATE quanjushujubiao SET note = 'global_state literal' /* global_state comment */ WHERE row_id = 1");
  });

  it('不会把普通、递归、列名列表或多 CTE 名称重绑定为表', () => {
    const aliases = new Map([['global_state', 'runtime_global'], ['sheet_global', 'runtime_global'], ['old_target', 'runtime_target']]);
    const [recursive] = rebindSqlMutationTableReferences_ACU([
      'WITH RECURSIVE global_state(row_id) AS (SELECT 1) UPDATE sheet_global SET row_id = row_id WHERE row_id IN (SELECT row_id FROM global_state)',
    ], aliases);
    const [multiple] = rebindSqlMutationTableReferences_ACU([
      'WITH global_state AS (SELECT 1 AS row_id), sheet_global AS (SELECT row_id FROM global_state) UPDATE old_target SET row_id = row_id WHERE row_id IN (SELECT row_id FROM sheet_global)',
    ], aliases);

    expect(recursive).toContain('FROM global_state');
    expect(recursive).toContain('UPDATE runtime_global');
    expect(multiple).toContain('FROM global_state');
    expect(multiple).toContain('FROM sheet_global');
    expect(multiple).toContain('UPDATE runtime_target');
  });

  it('不会把嵌套 WITH 作用域内与 alias 同名的 CTE 引用重绑定为物理表', () => {
    const [result] = rebindSqlMutationTableReferences_ACU([
      'UPDATE old_table SET value = 1 WHERE EXISTS (WITH RECURSIVE old_table(row_id) AS (SELECT 1) SELECT 1 FROM old_table WHERE row_id = 1)',
    ], new Map([['old_table', 'runtime_table']]));

    expect(result).toBe(
      'UPDATE runtime_table SET value = 1 WHERE EXISTS (WITH RECURSIVE old_table(row_id) AS (SELECT 1) SELECT 1 FROM old_table WHERE row_id = 1)',
    );
  });

  it('重绑定 target、self-reference、JOIN 与 FROM 多表中的已知表，未知引用保持原文', () => {
    const aliases = new Map([
      ['old_global', 'runtime_global'],
      ['old_auxiliary', 'runtime_auxiliary'],
    ]);
    const [insert] = rebindSqlMutationTableReferences_ACU([
      'INSERT INTO old_global (row_id) SELECT source.row_id FROM old_global AS source JOIN old_auxiliary AS auxiliary ON source.row_id = auxiliary.row_id',
    ], aliases);
    const [unknown] = rebindSqlMutationTableReferences_ACU([
      'UPDATE old_global SET row_id = row_id WHERE EXISTS (SELECT 1 FROM missing_table)',
    ], aliases);

    expect(insert).toBe('INSERT INTO runtime_global (row_id) SELECT source.row_id FROM runtime_global AS source JOIN runtime_auxiliary AS auxiliary ON source.row_id = auxiliary.row_id');
    expect(unknown).toContain('UPDATE runtime_global');
    expect(unknown).toContain('FROM missing_table');
  });

  it('解码 DDL 引号标识符，并在 SQL 中保留原始引号风格', () => {
    expect(decodeSqlIdentifier_ACU('"global_state"')).toBe('global_state');
    expect(decodeSqlIdentifier_ACU('`global_state`')).toBe('global_state');
    expect(decodeSqlIdentifier_ACU('[global_state]')).toBe('global_state');
    const [result] = rebindSqlMutationTableReferences_ACU([
      'INSERT INTO [global_state] (row_id) SELECT row_id FROM `global_state`',
    ], new Map([['"global_state"', 'runtime_global']]));

    expect(result).toBe('INSERT INTO [runtime_global] (row_id) SELECT row_id FROM `runtime_global`');
  });

  it('目标表未知时原样返回，宽松模式也不接管 SQLite 语法错误', () => {
    const [result] = rebindSqlMutationTableReferences_ACU(['INSERT INTO missing_table VALUES (1)'], new Map([['known', 'runtime_known']]), { lenient: true });
    expect(result).toBe('INSERT INTO missing_table VALUES (1)');
  });

  it('只读查询重绑定表和单表列名，且不触碰字面量与注释', () => {
    const result = rebindSqlReadIdentifiers_ACU(
      "SELECT item_name, inventory_count, 'inventory' /* inventory */ FROM inventory WHERE item_name = '铁剑' -- inventory",
      new Map([['inventory', 'beibaowupinbiao']]),
      new Map([['beibaowupinbiao', new Map([['item_name', 'wupinmingcheng']])]]),
    );

    expect(result).toEqual({
      sql: "SELECT wupinmingcheng, inventory_count, 'inventory' /* inventory */ FROM beibaowupinbiao WHERE wupinmingcheng = '铁剑' -- inventory",
      tableRebindCount: 1,
      columnRebindCount: 2,
    });
  });

  it('保留 SELECT AS 输出别名', () => {
    const result = rebindSqlReadIdentifiers_ACU(
      'SELECT item_name AS item_name FROM inventory',
      new Map([['inventory', 'beibaowupinbiao']]),
      new Map([['beibaowupinbiao', new Map([['item_name', 'wupinmingcheng']])]]),
    );

    expect(result.sql).toBe('SELECT wupinmingcheng AS item_name FROM beibaowupinbiao');
  });

  it('只读查询在多表中遇到歧义列时不猜测', () => {
    const result = rebindSqlReadIdentifiers_ACU(
      'SELECT name FROM old_a JOIN old_b ON old_a.row_id = old_b.row_id',
      new Map([['old_a', 'runtime_a'], ['old_b', 'runtime_b']]),
      new Map([
        ['runtime_a', new Map([['name', 'name_a']])],
        ['runtime_b', new Map([['name', 'name_b']])],
      ]),
    );

    expect(result.sql).toBe('SELECT name FROM runtime_a JOIN runtime_b ON runtime_a.row_id = runtime_b.row_id');
    expect(result.columnRebindCount).toBe(0);
  });

  it('使用 JOIN 别名确定限定列归属，且不重写别名', () => {
    const result = rebindSqlReadIdentifiers_ACU(
      'SELECT a.name, b.name FROM old_a AS a JOIN old_b AS b ON a.row_id = b.row_id',
      new Map([['old_a', 'runtime_a'], ['old_b', 'runtime_b']]),
      new Map([
        ['runtime_a', new Map([['name', 'name_a']])],
        ['runtime_b', new Map([['name', 'name_b']])],
      ]),
    );

    expect(result.sql).toBe('SELECT a.name_a, b.name_b FROM runtime_a AS a JOIN runtime_b AS b ON a.row_id = b.row_id');
    expect(result.columnRebindCount).toBe(2);
  });

  it('隔离 CTE 与派生表作用域，保留它们的输出别名', () => {
    const aliases = new Map([['inventory', 'runtime_inventory'], ['other', 'runtime_other']]);
    const columns = new Map([
      ['runtime_inventory', new Map([['item_name', 'physical_item']])],
      ['runtime_other', new Map([['item_name', 'other_item']])],
    ]);
    const cte = rebindSqlReadIdentifiers_ACU(
      'WITH items AS (SELECT item_name AS item_name FROM inventory) SELECT item_name FROM items',
      aliases,
      columns,
    );
    const derived = rebindSqlReadIdentifiers_ACU(
      'SELECT sub.item_name FROM other JOIN (SELECT item_name AS item_name FROM inventory) AS sub ON 1 = 1',
      aliases,
      columns,
    );

    expect(cte.sql).toBe('WITH items AS (SELECT physical_item AS item_name FROM runtime_inventory) SELECT item_name FROM items');
    expect(derived.sql).toBe('SELECT sub.item_name FROM runtime_other JOIN (SELECT physical_item AS item_name FROM runtime_inventory) AS sub ON 1 = 1');
  });

  it('不将函数名视为列标识符', () => {
    const result = rebindSqlReadIdentifiers_ACU(
      'SELECT count(*) FROM inventory',
      new Map([['inventory', 'runtime_inventory']]),
      new Map([['runtime_inventory', new Map([['count', 'physical_count']])]]),
    );

    expect(result.sql).toBe('SELECT count(*) FROM runtime_inventory');
  });

});
