import { describe, expect, it } from 'vitest';
import { normalizeTemplateRowIds_ACU } from '../../../src/service/template/template-row-id-normalizer';

function sheet(name: string, headers: string[], rows: Array<Array<string | null>> = [], extra: Record<string, any> = {}) {
  return { uid: `sheet_${name.toLowerCase()}`, name, content: [headers, ...rows], sourceData: {}, ...extra };
}

function state(sheets: Record<string, any>) {
  return { mate: { type: 'chatSheets', version: 1 }, ...sheets };
}

describe('normalizeTemplateRowIds_ACU', () => {
  it('合法 row_id 首列表头保持不变，空身份被稳定分配', () => {
    const input = state({ sheet_a: sheet('A', ['row_id', '名称'], [['', '铁剑'], ['7', '盾牌']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.templateData.sheet_a.content).toEqual([
      ['row_id', '名称'], ['8', '铁剑'], ['7', '盾牌'],
    ]);
    expect(input.sheet_a.content[1][0]).toBe('');
  });

  it('id 别名改名为 row_id，数据行不右移', () => {
    const input = state({ sheet_a: sheet('A', ['id', '名称'], [['1', '铁剑']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toEqual([]);
    expect(result.templateData.sheet_a.content).toEqual([['row_id', '名称'], ['1', '铁剑']]);
  });

  it('行号 别名改名为 row_id', () => {
    const input = state({ sheet_a: sheet('A', ['行号', '名称'], [['3', '药水']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toEqual([]);
    expect(result.templateData.sheet_a.content).toEqual([['row_id', '名称'], ['3', '药水']]);
  });

  it('缺失整列 row_id 时插入表头并为数据行分配身份', () => {
    const input = state({ sheet_log: sheet('日志', ['时间', '摘要'], [['T1', '事件A'], ['T2', '事件B']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toEqual([]);
    expect(result.templateData.sheet_log.content).toEqual([
      ['row_id', '时间', '摘要'], ['1', 'T1', '事件A'], ['2', 'T2', '事件B'],
    ]);
    expect(result.audits[0].headerAction).toBe('inserted');
    expect(result.audits[0].generatedRowIdCount).toBe(2);
  });

  it('header-only 表只补表头，不造数据行', () => {
    const input = state({ sheet_a: sheet('A', ['名称']) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toEqual([]);
    expect(result.templateData.sheet_a.content).toEqual([['row_id', '名称']]);
  });

  it('seedRows 同步插列，并与 content 共享身份空间', () => {
    const input = state({ sheet_a: sheet('A', ['时间', '名称'], [['T1', 'A']], { seedRows: [['T2', 'B']] }) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toEqual([]);
    expect(result.templateData.sheet_a.content).toEqual([['row_id', '时间', '名称'], ['1', 'T1', 'A']]);
    expect(result.templateData.sheet_a.seedRows).toEqual([['2', 'T2', 'B']]);
  });

  it('保留已有非空 ID，并从最大身份后分配空 ID', () => {
    const input = state({ sheet_a: sheet('A', ['row_id', '名称'], [['5', '甲'], ['', '乙']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.templateData.sheet_a.content).toEqual([['row_id', '名称'], ['5', '甲'], ['6', '乙']]);
  });

  it('重复的非空 row_id 阻断，不静默重写身份', () => {
    const input = state({ sheet_a: sheet('A', ['row_id', '名称'], [['same', '甲'], ['same', '乙']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toEqual([expect.objectContaining({ code: 'duplicate_row_id', sheetKey: 'sheet_a' })]);
    expect(result.changed).toBe(false);
    expect(result.templateData.sheet_a.content).toEqual(input.sheet_a.content);
  });

  it('row_id 不在首列时阻断', () => {
    const input = state({ sheet_a: sheet('A', ['时间', 'row_id', '摘要'], [['T1', '1', 'A']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe('misplaced_row_id');
    expect(result.blockers[0].sheetKey).toBe('sheet_a');
    expect(result.changed).toBe(false);
  });

  it('重复身份表头阻断', () => {
    const input = state({ sheet_a: sheet('A', ['时间', '行号', '摘要'], [['T1', '1', 'A']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers[0].code).toBe('duplicate_row_id_header');
  });

  it('非数组 content 行阻断', () => {
    const input = state({ sheet_a: { uid: 'sheet_a', name: 'A', content: [['名称'], '不是数组'] } });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers[0].code).toBe('invalid_content_row');
  });

  it('非数组 seedRows 阻断', () => {
    const input = state({ sheet_a: sheet('A', ['名称'], [], { seedRows: 'bad' }) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers[0].code).toBe('invalid_seed_rows');
  });

  it('超长行阻断，不静默截断', () => {
    const input = state({ sheet_a: sheet('A', ['名称'], [['T1', 'A', '多余']]) });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers[0].code).toBe('row_width_mismatch');
  });

  it('DDL 已含合法身份列时保持不变', () => {
    const input = state({ sheet_a: sheet('A', ['时间', '摘要'], [['T1', 'A']], {
      sourceData: { ddl: 'CREATE TABLE a (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  time TEXT, -- 时间\n  summary TEXT -- 摘要\n);' },
    }) });
    const result = normalizeTemplateRowIds_ACU(input, { syncDdl: true });
    expect(result.blockers).toEqual([]);
    expect(result.templateData.sheet_a.sourceData.ddl).toContain('row_id INTEGER PRIMARY KEY');
  });

  it('DDL 缺失身份列时安全注入，并校验表头映射', () => {
    const input = state({ sheet_a: sheet('A', ['时间', '摘要'], [['T1', 'A']], {
      sourceData: { ddl: 'CREATE TABLE a (\n  time TEXT, -- 时间\n  summary TEXT -- 摘要\n);' },
    }) });
    const result = normalizeTemplateRowIds_ACU(input, { syncDdl: true });
    expect(result.blockers).toEqual([]);
    expect(result.templateData.sheet_a.sourceData.ddl).toContain('row_id INTEGER PRIMARY KEY');
  });

  it('DDL row_id 类型/主键非法时阻断', () => {
    const input = state({ sheet_a: sheet('A', ['时间', '摘要'], [['T1', 'A']], {
      sourceData: { ddl: 'CREATE TABLE a (\n  time TEXT -- 时间\n, summary TEXT -- 摘要\n, row_id TEXT\n);' },
    }) });
    const result = normalizeTemplateRowIds_ACU(input, { syncDdl: true });
    expect(result.blockers[0].code).toBe('invalid_ddl');
  });

  it('输入对象不被修改', () => {
    const input = state({ sheet_a: sheet('A', ['名称'], [['T1', 'A']]) });
    const snapshot = JSON.stringify(input);
    normalizeTemplateRowIds_ACU(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('第二次规范化幂等', () => {
    const input = state({ sheet_a: sheet('A', ['名称'], [['T1', 'A']]) });
    const first = normalizeTemplateRowIds_ACU(input);
    const second = normalizeTemplateRowIds_ACU(first.templateData);
    expect(second.changed).toBe(false);
    expect(second.blockers).toEqual([]);
    expect(second.templateData).toEqual(first.templateData);
  });

  it('多表错误一次返回全部 blockers', () => {
    const input = state({
      sheet_a: sheet('A', ['时间', 'row_id'], []),
      sheet_b: sheet('B', ['时间', '行号'], []),
    });
    const result = normalizeTemplateRowIds_ACU(input);
    expect(result.blockers.map(b => b.code)).toEqual(['misplaced_row_id', 'duplicate_row_id_header']);
  });
});
