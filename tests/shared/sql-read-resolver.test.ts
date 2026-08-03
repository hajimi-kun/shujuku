import { describe, expect, it } from 'vitest';
import {
  rebindSheetKeysThroughTableAliases_ACU,
  resolveHistoricalSheetKeyMigrations_ACU,
  resolveReadQuerySql_ACU,
  SheetTableAliasResolutionError_ACU,
} from '../../src/shared/sql-read-resolver';

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
    expect(resolveReadQuerySql_ACU('SELECT 内容 FROM (SELECT 1 AS 内容) AS derived_values ORDER BY 内容', null, translate).sql)
      .toBe('SELECT 内容 FROM (SELECT 1 AS 内容) AS derived_values ORDER BY 内容');
    expect(resolveReadQuerySql_ACU('SELECT derived_values."内容" FROM (SELECT 1 AS "内容") AS derived_values', null, translate).sql)
      .toBe('SELECT derived_values."内容" FROM (SELECT 1 AS "内容") AS derived_values');
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

  it('保留派生表输出别名的外层引用，即使它命中实体显示列映射', () => {
    const tableData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        uid: 'sheet_0',
        name: 'People',
        sourceData: { ddl: 'CREATE TABLE people (row_id INTEGER PRIMARY KEY, name TEXT -- 姓名);' },
        content: [['row_id', '姓名'], ['1', 'Ada']],
      },
    } as any;
    const translate = (sql: string) => sql.replaceAll('姓名', 'name');

    expect(resolveReadQuerySql_ACU(
      'SELECT 姓名 FROM (SELECT name AS 姓名 FROM people) AS derived_people ORDER BY 姓名',
      tableData,
      translate,
    ).sql).toBe(
      'SELECT 姓名 FROM (SELECT name AS 姓名 FROM people) AS derived_people ORDER BY 姓名',
    );
  });

  it('保护 CTE 显式列清单和 UNION 第一分支导出的显示列', () => {
    const tableData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        uid: 'sheet_0',
        name: 'People',
        sourceData: { ddl: 'CREATE TABLE people (row_id INTEGER PRIMARY KEY, name TEXT -- 姓名);' },
        content: [['row_id', '姓名'], ['1', 'Ada']],
      },
    } as any;
    const translate = (sql: string) => sql.replaceAll('姓名', 'name').replaceAll('别名', 'alias');

    expect(resolveReadQuerySql_ACU(
      'WITH people_view(姓名) AS (SELECT name FROM people) SELECT 姓名 FROM people_view ORDER BY 姓名',
      tableData,
      translate,
    ).sql).toBe(
      'WITH people_view(姓名) AS (SELECT name FROM people) SELECT 姓名 FROM people_view ORDER BY 姓名',
    );
    expect(resolveReadQuerySql_ACU(
      'SELECT derived_people.姓名 FROM (SELECT name AS 姓名 FROM people UNION ALL SELECT name AS 别名 FROM people) AS derived_people ORDER BY derived_people.姓名',
      tableData,
      translate,
    ).sql).toBe(
      'SELECT derived_people.姓名 FROM (SELECT name AS 姓名 FROM people UNION ALL SELECT name AS 别名 FROM people) AS derived_people ORDER BY derived_people.姓名',
    );
  });

  it('跨快照目标表复用 SQL 读写共享别名，可接受旧 key、uid、显示名、拼音名和作者 DDL 名', () => {
    const scheduled = {
      mate: { type: 'acu' },
      sheet_in05z9vz: {
        uid: 'legacy_inventory_uid',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item TEXT);' },
      },
    } as any;
    const replayBase = {
      mate: { type: 'acu' },
      sheet_bei_bao_wu_pin_biao: {
        uid: 'stable_inventory_uid',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item TEXT);' },
      },
    } as any;

    for (const selector of [
      'sheet_in05z9vz',
      'legacy_inventory_uid',
      '背包物品表',
      'beibaowupinbiao',
      'inventory',
    ]) {
      expect(rebindSheetKeysThroughTableAliases_ACU([selector], scheduled, replayBase))
        .toEqual(['sheet_bei_bao_wu_pin_biao']);
    }
  });

  it('目标快照的稳定 key、uid、显示名、拼音名和作者 DDL 名可直接解析', () => {
    const target = {
      mate: { type: 'acu' },
      sheet_bei_bao_wu_pin_biao: {
        uid: 'stable_inventory_uid',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item TEXT);' },
      },
    } as any;

    for (const selector of [
      'sheet_bei_bao_wu_pin_biao',
      'stable_inventory_uid',
      '背包物品表',
      'beibaowupinbiao',
      'inventory',
    ]) {
      expect(rebindSheetKeysThroughTableAliases_ACU([selector], null, target))
        .toEqual(['sheet_bei_bao_wu_pin_biao']);
    }
  });

  it('显式表级别名经 NFKC、空白与大小写归一后仍唯一路由到权威 sheetKey', () => {
    const tableData = {
      mate: { type: 'acu' },
      sheet_zhu_jue_xin_xi: {
        uid: 'protagonist_uid',
        name: '主角信息表',
        sourceData: {
          tableAliases: ['主角信息', ' Ｐｒｏｔａｇｏｎｉｓｔ＿Ｉｎｆｏ '],
          ddl: 'CREATE TABLE protagonist_info (row_id INTEGER PRIMARY KEY);',
        },
      },
    } as any;

    for (const selector of [
      'sheet_zhu_jue_xin_xi', 'protagonist_uid', '主角信息表', '主角信息',
      ' Ｐｒｏｔａｇｏｎｉｓｔ＿Ｉｎｆｏ ', 'protagonist_info', 'zhujuexinxibiao',
    ]) {
      expect(rebindSheetKeysThroughTableAliases_ACU([selector], null, tableData))
        .toEqual(['sheet_zhu_jue_xin_xi']);
    }
  });

  it('两个表声明同一显式别名时标记歧义，而不猜测路由目标', () => {
    const tableData = {
      mate: { type: 'acu' },
      sheet_alpha: {
        uid: 'alpha_uid', name: '甲表',
        sourceData: { tableAliases: ['共享名称'], ddl: 'CREATE TABLE alpha_table (row_id INTEGER PRIMARY KEY);' },
      },
      sheet_beta: {
        uid: 'beta_uid', name: '乙表',
        sourceData: { tableAliases: [' 共享名称 '], ddl: 'CREATE TABLE beta_table (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;

    expect(() => rebindSheetKeysThroughTableAliases_ACU(['共享名称'], null, tableData))
      .toThrow(/歧义/);
  });

  it('跨快照通过显式表级历史名称将旧 key 重绑定为权威 key', () => {
    const scheduled = {
      sheet_DpKcVGqg: {
        uid: 'legacy_protagonist_uid', name: '旧主角表',
        sourceData: { tableAliases: ['主角信息'], ddl: 'CREATE TABLE protagonist_info (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;
    const target = {
      sheet_zhu_jue_xin_xi: {
        uid: 'protagonist_uid', name: '主角信息表',
        sourceData: { tableAliases: ['主角信息'], ddl: 'CREATE TABLE protagonist_info (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;

    expect(rebindSheetKeysThroughTableAliases_ACU(['sheet_DpKcVGqg'], scheduled, target))
      .toEqual(['sheet_zhu_jue_xin_xi']);
  });

  it('同一源表的多个别名不会被误判为多对一折叠', () => {
    const scheduled = {
      sheet_legacy: {
        uid: 'legacy_uid',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;
    const target = {
      sheet_stable: {
        uid: 'stable_uid',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;

    expect(rebindSheetKeysThroughTableAliases_ACU(
      ['sheet_legacy', 'legacy_uid', 'inventory'],
      scheduled,
      target,
    )).toEqual(['sheet_stable']);
  });

  it('两个不同源表折叠到同一个目标表时 fail closed', () => {
    const scheduled = {
      sheet_old_a: { uid: 'old_a', name: '旧表甲', sourceData: { ddl: 'CREATE TABLE shared_a (row_id INTEGER PRIMARY KEY);' } },
      sheet_old_b: { uid: 'old_b', name: '旧表乙', sourceData: { ddl: 'CREATE TABLE shared_b (row_id INTEGER PRIMARY KEY);' } },
    } as any;
    const target = {
      sheet_stable: {
        uid: 'stable_uid',
        name: '新表',
        sourceData: { ddl: 'CREATE TABLE shared_a (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;
    target.sheet_stable.uid = 'old_b';

    expect(() => rebindSheetKeysThroughTableAliases_ACU(
      ['sheet_old_a', 'sheet_old_b'],
      scheduled,
      target,
    )).toThrow(/多对一冲突/);
  });

  it('跨快照别名一对多时 fail closed，不扩大目标授权', () => {
    const scheduled = {
      sheet_in05z9vz: {
        uid: 'legacy_inventory_uid',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;
    const ambiguousTarget = {
      sheet_inventory_a: {
        uid: 'inventory_a',
        name: '旧背包',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
      sheet_inventory_b: {
        uid: 'inventory_b',
        name: '新背包',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;

    expect(() => rebindSheetKeysThroughTableAliases_ACU(
      ['sheet_in05z9vz'],
      scheduled,
      ambiguousTarget,
    )).toThrow(SheetTableAliasResolutionError_ACU);
  });

  it('无法从共享别名证明跨快照身份时 fail closed', () => {
    const scheduled = {
      sheet_old: { uid: 'old_uid', name: '旧表', sourceData: { ddl: 'CREATE TABLE old_table (row_id INTEGER PRIMARY KEY);' } },
    } as any;
    const target = {
      sheet_new: { uid: 'new_uid', name: '新表', sourceData: { ddl: 'CREATE TABLE new_table (row_id INTEGER PRIMARY KEY);' } },
    } as any;

    expect(() => rebindSheetKeysThroughTableAliases_ACU(['sheet_old'], scheduled, target))
      .toThrow(/无法证明/);
  });

  it('仅在物理名与作者 DDL 表名同时一致时迁移历史随机 key', () => {
    const source = {
      sheet_in05z9vz: {
        uid: 'sheet_in05z9vz',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
      sheet_3NoMc1wI: {
        uid: 'sheet_3NoMc1wI',
        name: '纪要表',
        sourceData: { ddl: 'CREATE TABLE chronicle (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;
    const target = {
      sheet_bei_bao_wu_pin_biao: {
        uid: 'sheet_bei_bao_wu_pin_biao',
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
      sheet_ji_yao_biao: {
        uid: 'sheet_ji_yao_biao',
        name: '纪要表',
        sourceData: { ddl: 'CREATE TABLE chronicle (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;

    expect([...resolveHistoricalSheetKeyMigrations_ACU(source, target)]).toEqual([
      ['sheet_3NoMc1wI', 'sheet_ji_yao_biao'],
      ['sheet_in05z9vz', 'sheet_bei_bao_wu_pin_biao'],
    ]);
  });

  it('同物理名但作者 DDL 表名不同或缺失时拒绝历史 key 迁移', () => {
    const source = {
      sheet_legacy: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE legacy_inventory (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;
    const target = {
      sheet_stable: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;

    expect(() => resolveHistoricalSheetKeyMigrations_ACU(source, target))
      .toThrow(/作者 DDL 表名不一致或缺失/);

    source.sheet_legacy.sourceData.ddl = '';
    expect(() => resolveHistoricalSheetKeyMigrations_ACU(source, target))
      .toThrow(/作者 DDL 表名不一致或缺失/);
  });

  it('运行时已同时存在历史 key 与稳定 key 时拒绝覆盖稳定 key', () => {
    const source = {
      sheet_legacy: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
      sheet_stable: {
        name: '其他表',
        sourceData: { ddl: 'CREATE TABLE other_table (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;
    const target = {
      sheet_stable: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY);' },
      },
    } as any;

    expect(() => resolveHistoricalSheetKeyMigrations_ACU(source, target))
      .toThrow(/运行时基底已存在目标 key/);
  });
});
