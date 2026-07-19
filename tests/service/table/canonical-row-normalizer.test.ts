import { describe, expect, it } from 'vitest';
import {
  formatCanonicalRowIssues_ACU,
  isEmptyCanonicalRowId_ACU,
  normalizeCanonicalTableRows_ACU,
} from '../../../src/shared/canonical-row-normalizer';

describe('canonical-row-normalizer', () => {
  it('识别 null、undefined 与空白 row_id，但保留字符串 null/undefined', () => {
    expect(isEmptyCanonicalRowId_ACU(null)).toBe(true);
    expect(isEmptyCanonicalRowId_ACU(undefined)).toBe(true);
    expect(isEmptyCanonicalRowId_ACU('  ')).toBe(true);
    expect(isEmptyCanonicalRowId_ACU('null')).toBe(false);
    expect(isEmptyCanonicalRowId_ACU('undefined')).toBe(false);
  });

  it('同时规范化 content 与 seedRows，并只删除空 row_id 行', () => {
    const data: any = {
      sheet_0: {
        content: [[null, '名称'], [null, '坏行1'], [undefined, '坏行2'], ['  ', '坏行3'], [' null ', '保留']],
        seedRows: [[null, '坏种子'], ['undefined', '保留种子']],
      },
    };

    const result = normalizeCanonicalTableRows_ACU(data);

    expect(data.sheet_0.content).toEqual([['row_id', '名称'], ['null', '保留']]);
    expect(data.sheet_0.seedRows).toEqual([['undefined', '保留种子']]);
    expect(result.changedSheetKeys).toEqual(['sheet_0']);
    expect(result.removedRows).toHaveLength(4);
    expect(result.errors).toEqual([]);
  });

  it('表头已经是 row_id 时仍扫描数据行', () => {
    const data: any = { sheet_0: { content: [['row_id', '名称'], ['', '坏行'], ['1', '好行']] } };
    const result = normalizeCanonicalTableRows_ACU(data);
    expect(data.sheet_0.content).toEqual([['row_id', '名称'], ['1', '好行']]);
    expect(result.removedRows).toEqual([{ sheetKey: 'sheet_0', rowIndex: 1, reason: 'empty_row_id' }]);
  });

  it('重复 row_id 与非数组行作为错误保留拒绝证据，不静默选择赢家', () => {
    const invalidRow = { secret: '不得进入错误文本' };
    const data: any = { sheet_0: { content: [['row_id', '名称'], ['1', '甲'], ['1', '乙'], invalidRow] } };
    const result = normalizeCanonicalTableRows_ACU(data);

    expect(data.sheet_0.content).toEqual([['row_id', '名称'], ['1', '甲'], ['1', '乙']]);
    expect(result.errors).toEqual([
      { sheetKey: 'sheet_0', rowIndex: 2, reason: 'duplicate_row_id' },
      { sheetKey: 'sheet_0', rowIndex: 3, reason: 'invalid_row' },
    ]);
    expect(formatCanonicalRowIssues_ACU(result.errors)).toBe('sheet_0 第 2 行：duplicate_row_id；sheet_0 第 3 行：invalid_row');
    expect(formatCanonicalRowIssues_ACU(result.errors)).not.toContain('不得进入错误文本');
  });
});
