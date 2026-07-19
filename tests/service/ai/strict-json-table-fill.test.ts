import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/service/template/chat-scope', () => ({
  getSortedSheetKeys_ACU: vi.fn((data: any) => Object.keys(data || {}).filter((key) => key.startsWith('sheet_'))),
}));

import { buildStrictJsonTableFillResponseFormatForData_ACU, extractStrictJsonTableFillResponse_ACU } from '../../../src/service/ai/prompt-builder/strict-json-table-fill';
import { DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU, DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU } from '../../../src/shared/defaults-json.js';

function tableData() {
  return {
    sheet_status: {
      uid: 'sheet_status',
      name: '角色状态',
      content: [
        ['row_id', '姓名', '状态', '位置'],
        ['1', '小玉', '正常', '客厅'],
      ],
    },
    sheet_relation: {
      uid: 'sheet_relation',
      name: '关系记录',
      content: [
        ['row_id', '姓名', '好感'],
        ['1', '小玉', '普通'],
      ],
    },
    sheet_dupe: {
      uid: 'sheet_dupe',
      name: '重复记录',
      content: [
        ['row_id', '姓名', '状态'],
        ['1', '小玉', '正常'],
        ['2', '小玉', '疲惫'],
      ],
    },
  };
}

describe('strict-json-table-fill', () => {
  it('keeps native default prompt details and only replaces output protocol', () => {
    const mainPrompt = DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU.find((segment: any) => segment.mainSlot === 'A')?.content || '';
    expect(mainPrompt).toContain('必须逐表阅读每个表格的note部分');
    expect(mainPrompt).toContain('可能还存在某些存放特殊填表规则的表格');
    expect(mainPrompt).toContain('日志与纪要语气校准');
    expect(mainPrompt).toContain('正常恋爱互动');
    expect(mainPrompt).toContain('"format":"table_edit_ops_v1"');
    expect(mainPrompt).toContain('where');
    expect(mainPrompt).not.toContain('insertRow(表格ID');
    expect(mainPrompt).not.toContain('updateRow(表格ID');
    expect(mainPrompt).not.toContain('deleteRow(表格ID');
  });

  it('keeps sqlite default prompt SQL rules and only wraps SQL in JSON protocol', () => {
    const mainPrompt = DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU.find((segment: any) => segment.mainSlot === 'A')?.content || '';
    expect(mainPrompt).toContain('必须逐表阅读每个表格的 DDL 注释和 Note 部分');
    expect(mainPrompt).toContain('WHERE 条件选择原则');
    expect(mainPrompt).toContain('CASE 条件更新');
    expect(mainPrompt).toContain('禁止使用 DROP TABLE / ALTER TABLE / CREATE TABLE 等结构变更语句');
    expect(mainPrompt).toContain('"format":"table_edit_sql_v1"');
    expect(mainPrompt).toContain('"sql":""');
    expect(mainPrompt).not.toContain('<tableEdit>\nINSERT INTO');
  });

  it('converts native insert/update/delete ops to legacy internal DSL', () => {
    const response = JSON.stringify({
      format: 'table_edit_ops_v1',
      ops: [
        { op: 'insert', sheet: '角色状态', row: { 姓名: '小玉', 状态: '疲惫', 位置: '卧室' } },
        { op: 'update', sheet: '关系记录', where: { 姓名: '小玉' }, set: { 好感: '升高' } },
        { op: 'delete', sheet: '角色状态', where: { 姓名: '小玉' } },
      ],
    });
    const result = extractStrictJsonTableFillResponse_ACU(response, { tableData: tableData() });
    expect(result.ok).toBe(true);
    expect(result.tableEditText).toContain('insertRow(0');
    expect(result.tableEditText).toContain('updateRow(1, 0');
    expect(result.tableEditText).toContain('deleteRow(0, 0)');
  });

  it('rejects unknown sheet', () => {
    const result = extractStrictJsonTableFillResponse_ACU(JSON.stringify({
      format: 'table_edit_ops_v1',
      ops: [{ op: 'insert', sheet: '不存在', row: { 姓名: '小玉' } }],
    }), { tableData: tableData() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sheet 未匹配');
  });

  it('rejects unknown field', () => {
    const result = extractStrictJsonTableFillResponse_ACU(JSON.stringify({
      format: 'table_edit_ops_v1',
      ops: [{ op: 'insert', sheet: '角色状态', row: { 未知: '值' } }],
    }), { tableData: tableData() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('字段名不存在');
  });

  it('rejects extra tableId field', () => {
    const result = extractStrictJsonTableFillResponse_ACU(JSON.stringify({
      format: 'table_edit_ops_v1',
      ops: [{ op: 'insert', sheet: '角色状态', tableId: 0, row: { 姓名: '小玉' } }],
    }), { tableData: tableData() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不允许的字段');
  });

  it('rejects extra rowIndex field', () => {
    const result = extractStrictJsonTableFillResponse_ACU(JSON.stringify({
      format: 'table_edit_ops_v1',
      ops: [{ op: 'update', sheet: '角色状态', rowIndex: 0, where: { 姓名: '小玉' }, set: { 状态: '疲惫' } }],
    }), { tableData: tableData() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不允许的字段');
  });

  it('rejects where matching no rows', () => {
    const result = extractStrictJsonTableFillResponse_ACU(JSON.stringify({
      format: 'table_edit_ops_v1',
      ops: [{ op: 'update', sheet: '角色状态', where: { 姓名: '不存在' }, set: { 状态: '疲惫' } }],
    }), { tableData: tableData() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('where 未匹配');
  });

  it('rejects where matching multiple rows', () => {
    const result = extractStrictJsonTableFillResponse_ACU(JSON.stringify({
      format: 'table_edit_ops_v1',
      ops: [{ op: 'update', sheet: '重复记录', where: { 姓名: '小玉' }, set: { 状态: '休息' } }],
    }), { tableData: tableData() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('where 匹配到多行');
  });

  it('extracts sqlite sql string without rewriting row_id WHERE', () => {
    const sql = 'UPDATE character_status SET status=\'tired\' WHERE row_id = 1;';
    const result = extractStrictJsonTableFillResponse_ACU(JSON.stringify({
      format: 'table_edit_sql_v1',
      sql,
    }), { sqlite: true, tableData: tableData() });
    expect(result.ok).toBe(true);
    expect(result.tableEditText).toBe(sql);
    expect(result.normalizedResponse).toContain(sql);
  });

  it('recovers json wrapped by markdown code fence', () => {
    const result = extractStrictJsonTableFillResponse_ACU('```json\n{"format":"table_edit_sql_v1","sql":""}\n```', { sqlite: true });
    expect(result.ok).toBe(true);
    expect(result.tableEditText).toBe('');
  });

  it('rejects legacy naked table edit in strict mode', () => {
    const result = extractStrictJsonTableFillResponse_ACU('<tableEdit>insertRow(0,{"0":"x"})</tableEdit>', { tableData: tableData() });
    expect(result.ok).toBe(false);
  });

  it('builds strong schema for small native table sets', () => {
    const result = buildStrictJsonTableFillResponseFormatForData_ACU(false, tableData(), ['sheet_status']);
    expect(result.wide).toBe(false);
    expect(result.stats?.sheetCount).toBe(1);
    expect(result.stats?.oneOfBranchCount).toBe(3);
    const items = result.responseFormat.json_schema.schema.properties.ops.items;
    expect(items.oneOf).toHaveLength(3);
  });

  it('falls back to wide schema when sheet threshold is exceeded', () => {
    const data: any = {};
    for (let i = 0; i < 9; i += 1) {
      data[`sheet_${i}`] = { uid: `sheet_${i}`, name: `表${i}`, content: [['row_id', 'name']] };
    }
    const result = buildStrictJsonTableFillResponseFormatForData_ACU(false, data);
    expect(result.wide).toBe(true);
    expect(result.stats?.sheetCount).toBe(9);
    expect(result.responseFormat.json_schema.schema.properties.ops.items.oneOf).toBeUndefined();
  });
});
