import { describe, expect, it } from 'vitest';
import {
  validateCanonicalCheckpoint_ACU,
  validateCanonicalCheckpointData_ACU,
} from '../../src/shared/canonical-checkpoint-validator';

function fullCheckpoint(data: any) {
  return { kind: 'full', createdAt: 1, reason: 'init', data };
}

function sheet(name = '背包', content: any[][] = [['row_id', '名称'], ['1', name]]) {
  return { uid: 'inventory', name, content, sourceData: {}, updateConfig: {}, exportConfig: {}, orderNo: 0 };
}

describe('canonical-checkpoint-validator', () => {
  it('接受 header-only full 与 sheet_full checkpoint，并保留定位上下文', () => {
    const full = fullCheckpoint({ sheet_0: sheet('空表', [['row_id', '名称']]) });
    const fullResult = validateCanonicalCheckpoint_ACU(full, { messageIndex: 12, aiFloor: 8, isolationKey: 'tag-a' });
    const sheetResult = validateCanonicalCheckpoint_ACU({
      kind: 'sheet_full', createdAt: 2, reason: 'manual', sheetKey: 'sheet_0', data: sheet(),
    });

    expect(fullResult).toEqual({ valid: true, issues: [] });
    expect(sheetResult).toEqual({ valid: true, issues: [] });
  });

  it('只读报告 canonical duplicate、空 ID、非数组行和行宽错误，不修改历史 snapshot', () => {
    const data = {
      sheet_0: sheet('背包', [
        ['row_id', '名称'],
        ['1', '铁剑'],
        [' 1 ', '冒名副本'],
        [' ', '空身份'],
        { secret: '不得泄漏' },
        ['2'],
      ]),
    };
    const before = JSON.parse(JSON.stringify(data));

    const result = validateCanonicalCheckpointData_ACU(data, { messageIndex: 7, aiFloor: 4, isolationKey: 'tag-a', reason: 'migration' });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ checkpointKind: 'data', type: 'duplicate_row_id', sheetKey: 'sheet_0', rowIndex: 2, rowId: '1' }),
      expect.objectContaining({ checkpointKind: 'data', type: 'empty_row_id', sheetKey: 'sheet_0', rowIndex: 3 }),
      expect.objectContaining({ checkpointKind: 'data', type: 'invalid_row', sheetKey: 'sheet_0', rowIndex: 4 }),
      expect.objectContaining({ checkpointKind: 'data', type: 'row_width_mismatch', sheetKey: 'sheet_0', rowIndex: 5, rowId: '2' }),
    ]);
    expect(result.issues.every(issue => !Object.prototype.hasOwnProperty.call(issue, 'cells'))).toBe(true);
    expect(JSON.stringify(data)).toBe(JSON.stringify(before));
  });

  it('分别报告坏 checkpoint 外壳、坏表头与 sheet_full key 不匹配', () => {
    const invalidFull = validateCanonicalCheckpoint_ACU({ kind: 'full', createdAt: -1, reason: '', data: {} });
    const invalidSheet = validateCanonicalCheckpoint_ACU({
      kind: 'sheet_full', createdAt: 1, reason: 'manual', sheetKey: 'inventory', data: sheet(),
    });
    const invalidHeader = validateCanonicalCheckpoint_ACU(fullCheckpoint({
      sheet_0: sheet('坏表', [['id', '名称'], ['1', '铁剑']]),
    }));

    expect(invalidFull.issues.map(issue => issue.type)).toEqual(['invalid_created_at', 'invalid_reason', 'missing_sheet']);
    expect(invalidSheet.issues.map(issue => issue.type)).toEqual(['sheet_key_mismatch']);
    expect(invalidHeader.issues).toEqual([
      expect.objectContaining({ checkpointKind: 'full', type: 'invalid_header', sheetKey: 'sheet_0', rowIndex: 0 }),
    ]);
  });
});
