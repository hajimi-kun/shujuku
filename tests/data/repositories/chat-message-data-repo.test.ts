/**
 * tests/data/repositories/chat-message-data-repo.test.ts
 * 消息级表格数据 CRUD 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/shared/json-helpers', () => ({
  safeJsonParse_ACU: (json: string, fallback: any) => { try { return JSON.parse(json); } catch { return fallback; } },
  safeJsonStringify_ACU: (obj: any, fallback: string) => { try { return JSON.stringify(obj); } catch { return fallback; } },
}));

import {
  readIsolatedTagData_ACU,
  readLegacyIndependentData_ACU,
  readLegacyStandardData_ACU,
  readLegacySummaryData_ACU,
  readMessageIdentity_ACU,
  readModifiedKeys_ACU,
  readUpdateGroupKeys_ACU,
  isLegacyMatchForIsolation_ACU,
  writeIsolatedTagData_ACU,
  initIsolatedTagSlot_ACU,
  writeLegacyCompatData_ACU,
  writeLegacyStandardAndSummary_ACU,
  writeMessageIdentity_ACU,
  purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU,
  purgeManualRefillIncrementalSheetKeysFromMessage_ACU,
  purgeSheetKeysFromMessage_ACU,
  clearAllTableFields_ACU,
  hasAnyTableData_ACU,
  cloneIsolatedData_ACU,
} from '../../../src/data/repositories/chat-message-data-repo';

// ═══ 读取类 ═══

describe('readIsolatedTagData_ACU', () => {
  it('msg 为 null 返回 null', () => {
    expect(readIsolatedTagData_ACU(null, 'tag1')).toBeNull();
  });

  it('无 IsolatedData 字段返回 null', () => {
    expect(readIsolatedTagData_ACU({}, 'tag1')).toBeNull();
  });

  it('IsolatedData 为 JSON 字符串时正确解析', () => {
    const tagData = { independentData: { sheet_0: { name: '表' } }, modifiedKeys: ['sheet_0'] };
    const msg = { TavernDB_ACU_IsolatedData: JSON.stringify({ tag1: tagData }) };
    const result = readIsolatedTagData_ACU(msg, 'tag1');
    expect(result).not.toBeNull();
    expect(result!.independentData).toBeDefined();
    expect(result!.modifiedKeys).toEqual(['sheet_0']);
  });

  it('IsolatedData 为对象时直接读取', () => {
    const tagData = { independentData: { sheet_0: { name: '表' } } };
    const msg = { TavernDB_ACU_IsolatedData: { tag1: tagData } };
    const result = readIsolatedTagData_ACU(msg, 'tag1');
    expect(result).not.toBeNull();
    expect(result!.independentData.sheet_0.name).toBe('表');
  });

  it('tagKey 不存在返回 null', () => {
    const msg = { TavernDB_ACU_IsolatedData: { tag1: { independentData: {} } } };
    expect(readIsolatedTagData_ACU(msg, 'nonexistent')).toBeNull();
  });

  it('IsolatedData 为数组返回 null', () => {
    const msg = { TavernDB_ACU_IsolatedData: [1, 2, 3] };
    expect(readIsolatedTagData_ACU(msg, 'tag1')).toBeNull();
  });

  it('IsolatedData 为无效 JSON 字符串返回 null', () => {
    const msg = { TavernDB_ACU_IsolatedData: 'not valid json' };
    expect(readIsolatedTagData_ACU(msg, 'tag1')).toBeNull();
  });
});

describe('readLegacyIndependentData_ACU', () => {
  it('msg 为 null 返回 null', () => {
    expect(readLegacyIndependentData_ACU(null)).toBeNull();
  });

  it('无字段返回 null', () => {
    expect(readLegacyIndependentData_ACU({})).toBeNull();
  });

  it('有效对象返回数据', () => {
    const data = { sheet_0: { name: '表', content: [['row_id']] } };
    expect(readLegacyIndependentData_ACU({ TavernDB_ACU_IndependentData: data })).toBe(data);
  });

  it('数组返回 null', () => {
    expect(readLegacyIndependentData_ACU({ TavernDB_ACU_IndependentData: [] })).toBeNull();
  });
});

describe('readLegacyStandardData_ACU', () => {
  it('有效对象返回数据', () => {
    const data = { sheet_0: { name: '标准表' } };
    expect(readLegacyStandardData_ACU({ TavernDB_ACU_Data: data })).toBe(data);
  });

  it('null msg 返回 null', () => {
    expect(readLegacyStandardData_ACU(null)).toBeNull();
  });
});

describe('readLegacySummaryData_ACU', () => {
  it('有效对象返回数据', () => {
    const data = { sheet_0: { name: '摘要表' } };
    expect(readLegacySummaryData_ACU({ TavernDB_ACU_SummaryData: data })).toBe(data);
  });

  it('null msg 返回 null', () => {
    expect(readLegacySummaryData_ACU(null)).toBeNull();
  });
});

describe('readMessageIdentity_ACU', () => {
  it('有 Identity 返回值', () => {
    expect(readMessageIdentity_ACU({ TavernDB_ACU_Identity: 'code_1' })).toBe('code_1');
  });

  it('无 Identity 返回 undefined', () => {
    expect(readMessageIdentity_ACU({})).toBeUndefined();
  });

  it('null msg 返回 undefined', () => {
    expect(readMessageIdentity_ACU(null)).toBeUndefined();
  });
});

describe('readModifiedKeys_ACU', () => {
  it('有数组返回数组', () => {
    expect(readModifiedKeys_ACU({ TavernDB_ACU_ModifiedKeys: ['sheet_0', 'sheet_1'] })).toEqual(['sheet_0', 'sheet_1']);
  });

  it('无字段返回空数组', () => {
    expect(readModifiedKeys_ACU({})).toEqual([]);
  });

  it('非数组返回空数组', () => {
    expect(readModifiedKeys_ACU({ TavernDB_ACU_ModifiedKeys: 'not_array' })).toEqual([]);
  });
});

describe('readUpdateGroupKeys_ACU', () => {
  it('有数组返回数组', () => {
    expect(readUpdateGroupKeys_ACU({ TavernDB_ACU_UpdateGroupKeys: ['sheet_0'] })).toEqual(['sheet_0']);
  });

  it('无字段返回空数组', () => {
    expect(readUpdateGroupKeys_ACU({})).toEqual([]);
  });
});

describe('isLegacyMatchForIsolation_ACU', () => {
  it('隔离开启 + Identity 匹配 → true', () => {
    const msg = { TavernDB_ACU_Identity: 'code_1' };
    expect(isLegacyMatchForIsolation_ACU(msg, { enabled: true, code: 'code_1' })).toBe(true);
  });

  it('隔离开启 + Identity 不匹配 → false', () => {
    const msg = { TavernDB_ACU_Identity: 'code_2' };
    expect(isLegacyMatchForIsolation_ACU(msg, { enabled: true, code: 'code_1' })).toBe(false);
  });

  it('隔离关闭 + 无 Identity → true', () => {
    expect(isLegacyMatchForIsolation_ACU({}, { enabled: false, code: '' })).toBe(true);
  });

  it('隔离关闭 + 有 Identity → false', () => {
    const msg = { TavernDB_ACU_Identity: 'code_1' };
    expect(isLegacyMatchForIsolation_ACU(msg, { enabled: false, code: '' })).toBe(false);
  });
});

// ═══ 写入类 ═══

describe('writeIsolatedTagData_ACU', () => {
  it('null msg 不抛错', () => {
    expect(() => writeIsolatedTagData_ACU(null, 'tag1', { independentData: {} } as any)).not.toThrow();
  });

  it('无 IsolatedData 时自动创建容器', () => {
    const msg: any = {};
    writeIsolatedTagData_ACU(msg, 'tag1', { independentData: { sheet_0: {} } } as any);
    expect(msg.TavernDB_ACU_IsolatedData).toBeDefined();
    expect(msg.TavernDB_ACU_IsolatedData.tag1.independentData.sheet_0).toBeDefined();
  });

  it('已有 IsolatedData 时追加标签', () => {
    const msg: any = { TavernDB_ACU_IsolatedData: { existing: {} } };
    writeIsolatedTagData_ACU(msg, 'tag1', { independentData: {} } as any);
    expect(msg.TavernDB_ACU_IsolatedData.existing).toBeDefined();
    expect(msg.TavernDB_ACU_IsolatedData.tag1).toBeDefined();
  });
});

describe('initIsolatedTagSlot_ACU', () => {
  it('无容器时创建并返回空槽', () => {
    const msg: any = {};
    const slot = initIsolatedTagSlot_ACU(msg, 'tag1');
    expect(slot.independentData).toEqual({});
    expect(slot.modifiedKeys).toEqual([]);
    expect(slot.updateGroupKeys).toEqual([]);
  });

  it('已有槽时不覆盖', () => {
    const existing = { independentData: { sheet_0: { name: '表' } }, modifiedKeys: ['sheet_0'], updateGroupKeys: [] };
    const msg: any = { TavernDB_ACU_IsolatedData: { tag1: existing } };
    const slot = initIsolatedTagSlot_ACU(msg, 'tag1');
    expect(slot.independentData.sheet_0.name).toBe('表');
  });
});

describe('writeLegacyCompatData_ACU', () => {
  it('null msg 不抛错', () => {
    expect(() => writeLegacyCompatData_ACU(null, {}, [], [], { legacyConfirmed: true })).not.toThrow();
  });

  it('未显式确认 legacy-v1 时不写入', () => {
    const msg: any = {};
    const indep = { sheet_0: { name: '表' } } as any;
    writeLegacyCompatData_ACU(msg, indep, ['sheet_0'], ['sheet_0'], {} as any);
    expect(msg.TavernDB_ACU_IndependentData).toBeUndefined();
  });

  it('写入三个旧版字段', () => {
    const msg: any = {};
    const indep = { sheet_0: { name: '表' } } as any;
    writeLegacyCompatData_ACU(msg, indep, ['sheet_0'], ['sheet_0'], { legacyConfirmed: true });
    expect(msg.TavernDB_ACU_IndependentData).toBe(indep);
    expect(msg.TavernDB_ACU_ModifiedKeys).toEqual(['sheet_0']);
    expect(msg.TavernDB_ACU_UpdateGroupKeys).toEqual(['sheet_0']);
  });
});

describe('writeLegacyStandardAndSummary_ACU', () => {
  it('null msg 不抛错', () => {
    expect(() => writeLegacyStandardAndSummary_ACU(null, null, null, { legacyConfirmed: true })).not.toThrow();
  });

  it('未显式确认 legacy-v1 时不写入', () => {
    const msg: any = {};
    const std = { sheet_0: { name: '标准表' } } as any;
    writeLegacyStandardAndSummary_ACU(msg, std, null, {} as any);
    expect(msg.TavernDB_ACU_Data).toBeUndefined();
  });

  it('有 sheet_ 键时写入', () => {
    const msg: any = {};
    const std = { sheet_0: { name: '标准表' } } as any;
    const sum = { sheet_1: { name: '摘要表' } } as any;
    writeLegacyStandardAndSummary_ACU(msg, std, sum, { legacyConfirmed: true });
    expect(msg.TavernDB_ACU_Data).toBe(std);
    expect(msg.TavernDB_ACU_SummaryData).toBe(sum);
  });

  it('无 sheet_ 键时不写入', () => {
    const msg: any = {};
    writeLegacyStandardAndSummary_ACU(msg, { noSheet: true } as any, null, { legacyConfirmed: true });
    expect(msg.TavernDB_ACU_Data).toBeUndefined();
  });
});

describe('writeMessageIdentity_ACU', () => {
  it('隔离启用时设置 Identity', () => {
    const msg: any = {};
    writeMessageIdentity_ACU(msg, { enabled: true, code: 'code_1' });
    expect(msg.TavernDB_ACU_Identity).toBe('code_1');
  });

  it('隔离关闭时删除 Identity', () => {
    const msg: any = { TavernDB_ACU_Identity: 'old_code' };
    writeMessageIdentity_ACU(msg, { enabled: false, code: '' });
    expect(msg.TavernDB_ACU_Identity).toBeUndefined();
  });

  it('null msg 不抛错', () => {
    expect(() => writeMessageIdentity_ACU(null, { enabled: true, code: 'x' })).not.toThrow();
  });
});

// ═══ 删除类 ═══

describe('purgeSheetKeysFromMessage_ACU', () => {
  it('null msg 返回 false', () => {
    expect(purgeSheetKeysFromMessage_ACU(null, ['sheet_0'])).toBe(false);
  });

  it('空 sheetKeys 返回 false', () => {
    expect(purgeSheetKeysFromMessage_ACU({}, [])).toBe(false);
  });

  it('从新版 IsolatedData 中删除 sheet', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: { sheet_0: { name: '表0' }, sheet_1: { name: '表1' } },
          modifiedKeys: ['sheet_0', 'sheet_1'],
          updateGroupKeys: ['sheet_0'],
        },
      },
    };
    const result = purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);
    expect(result).toBe(true);
    const tagData = msg.TavernDB_ACU_IsolatedData.tag1;
    expect(tagData.independentData.sheet_0).toBeUndefined();
    expect(tagData.independentData.sheet_1).toBeDefined();
    expect(tagData.modifiedKeys).toEqual(['sheet_1']);
    expect(tagData.updateGroupKeys).toEqual([]);
  });

  it('从旧版 IndependentData 中删除 sheet', () => {
    const msg: any = {
      TavernDB_ACU_IndependentData: { sheet_0: { name: '表0' }, sheet_1: { name: '表1' } },
    };
    const result = purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);
    expect(result).toBe(true);
    expect(msg.TavernDB_ACU_IndependentData.sheet_0).toBeUndefined();
    expect(msg.TavernDB_ACU_IndependentData.sheet_1).toBeDefined();
  });

  it('旧版 IndependentData 删除后无 sheet 键且无非 sheet 键时删除字段', () => {
    const msg: any = {
      TavernDB_ACU_IndependentData: { sheet_0: { name: '表0' } },
    };
    purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);
    expect(msg.TavernDB_ACU_IndependentData).toBeUndefined();
  });

  it('从旧版 ModifiedKeys/UpdateGroupKeys 中移除', () => {
    const msg: any = {
      TavernDB_ACU_ModifiedKeys: ['sheet_0', 'sheet_1'],
      TavernDB_ACU_UpdateGroupKeys: ['sheet_0'],
    };
    purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);
    expect(msg.TavernDB_ACU_ModifiedKeys).toEqual(['sheet_1']);
    expect(msg.TavernDB_ACU_UpdateGroupKeys).toEqual([]);
  });

  it('从旧版 Data 中删除 sheet', () => {
    const msg: any = {
      TavernDB_ACU_Data: { sheet_0: { name: '标准表' }, sheet_1: { name: '标准表1' } },
    };
    purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);
    expect(msg.TavernDB_ACU_Data.sheet_0).toBeUndefined();
    expect(msg.TavernDB_ACU_Data.sheet_1).toBeDefined();
  });

  it('从旧版 SummaryData 中删除 sheet', () => {
    const msg: any = {
      TavernDB_ACU_SummaryData: { sheet_0: { name: '摘要表' } },
    };
    purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);
    expect(msg.TavernDB_ACU_SummaryData).toBeUndefined();
  });

  it('新版+旧版混合数据全部清理', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: { sheet_0: { name: '新版表' } },
          modifiedKeys: ['sheet_0'],
          updateGroupKeys: [],
        },
      },
      TavernDB_ACU_IndependentData: { sheet_0: { name: '旧版独立表' } },
      TavernDB_ACU_Data: { sheet_0: { name: '旧版标准表' } },
      TavernDB_ACU_SummaryData: { sheet_0: { name: '旧版摘要表' } },
      TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      TavernDB_ACU_UpdateGroupKeys: ['sheet_0'],
    };
    const result = purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);
    expect(result).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.independentData.sheet_0).toBeUndefined();
    expect(msg.TavernDB_ACU_IndependentData).toBeUndefined();
    expect(msg.TavernDB_ACU_Data).toBeUndefined();
    expect(msg.TavernDB_ACU_SummaryData).toBeUndefined();
    expect(msg.TavernDB_ACU_ModifiedKeys).toEqual([]);
    expect(msg.TavernDB_ACU_UpdateGroupKeys).toEqual([]);
  });

  it('从 V2 checkpoint 中只删除目标 sheet 并保留同楼层其他 sheet', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: {},
          modifiedKeys: [],
          updateGroupKeys: [],
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              createdAt: 1,
              reason: 'manual',
              data: {
                sheet_0: { name: '被删表' },
                sheet_1: { name: '保留表' },
              },
              scheduleSummary: {
                sheet_0: { lastFilledAiFloor: 1, lastChangedAiFloor: 2 },
                sheet_1: { lastFilledAiFloor: 3, lastChangedAiFloor: 4 },
              },
              event: {
                filledSheetKeys: ['sheet_0', 'sheet_1'],
                changedSheetKeys: ['sheet_0', 'sheet_1'],
                groupKeys: ['sheet_0', 'sheet_1'],
                requestId: 'req-1',
              },
            },
            logEntries: [],
          },
        },
      },
    };

    const result = purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);

    expect(result).toBe(true);
    const checkpoint = msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.checkpoint;
    expect(checkpoint.data.sheet_0).toBeUndefined();
    expect(checkpoint.data.sheet_1).toEqual({ name: '保留表' });
    expect(checkpoint.scheduleSummary.sheet_0).toBeUndefined();
    expect(checkpoint.scheduleSummary.sheet_1).toEqual({ lastFilledAiFloor: 3, lastChangedAiFloor: 4 });
    expect(checkpoint.event.filledSheetKeys).toEqual(['sheet_1']);
    expect(checkpoint.event.changedSheetKeys).toEqual(['sheet_1']);
    expect(checkpoint.event.groupKeys).toEqual(['sheet_1']);
    expect(checkpoint.event.requestId).toBe('req-1');
  });

  it('从 V2 manualRefillProgress 中移除目标 sheet 但保留其他 sheet 进度', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: {},
          modifiedKeys: [],
          updateGroupKeys: [],
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              createdAt: 1,
              reason: 'manual',
              data: {},
              manualRefillProgress: {
                kind: 'manual_refill',
                status: 'in_progress',
                selectedSheetKeys: ['sheet_0', 'sheet_1'],
                completedSheetMessageIndexByKey: { sheet_0: 2, sheet_1: 3 },
              },
            },
            manualRefillProgress: {
              kind: 'manual_refill',
              status: 'in_progress',
              selectedSheetKeys: ['sheet_0', 'sheet_1'],
              completedSheetMessageIndexByKey: { sheet_0: 4, sheet_1: 5 },
            },
            logEntries: [],
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);

    const frame = msg.TavernDB_ACU_IsolatedData.tag1.storageFrame;
    expect(frame.manualRefillProgress.selectedSheetKeys).toEqual(['sheet_1']);
    expect(frame.manualRefillProgress.completedSheetMessageIndexByKey).toEqual({ sheet_1: 5 });
    expect(frame.checkpoint.manualRefillProgress.selectedSheetKeys).toEqual(['sheet_1']);
    expect(frame.checkpoint.manualRefillProgress.completedSheetMessageIndexByKey).toEqual({ sheet_1: 3 });
  });


  it('删完新版 progress 的目标表后将运行收敛为 complete 并清除错误', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            manualRefillProgress: {
              kind: 'manual_refill', version: 2, status: 'failed', selectedSheetKeys: ['sheet_0'],
              completedSheetMessageIndexByKey: { sheet_0: 2 }, lastError: 'network failed',
            },
            logEntries: [],
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.manualRefillProgress).toEqual(expect.objectContaining({
      status: 'complete', selectedSheetKeys: [], completedSheetMessageIndexByKey: {},
    }));
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.manualRefillProgress.lastError).toBeUndefined();
  });

  it('从 V2 logEntries 中只清理目标 sheet 的结构化 operation、patch 和 writeSet', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: {},
          modifiedKeys: [],
          updateGroupKeys: [],
          storageFrame: {
            version: 2,
            logEntries: [
              {
                seq: 1,
                entryId: 'entry-1',
                createdAt: 1,
                source: 'manual_crud',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_0', 'sheet_1'],
                changedSheetKeys: ['sheet_0', 'sheet_1'],
                groupKeys: ['sheet_0', 'sheet_1'],
                operations: [
                  { kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: '被删表' }, reason: 'manual_crud' },
                  { kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: { name: '保留表' }, reason: 'manual_crud' },
                  { kind: 'row_upsert', sheetKey: 'sheet_0', rowId: 'r0', cells: ['r0'] },
                  { kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] },
                  { kind: 'meta_update', sheetKey: 'sheet_0', meta: { name: '旧名' } },
                  { kind: 'sheet_schema_migrate', sheetKey: 'sheet_0', contractVersion: 1 },
                  { kind: 'table_edit_dsl', text: 'update sheet_0 but text is not structured' },
                ],
                patches: [
                  { kind: 'row_delete', sheetKey: 'sheet_0', rowId: 'r0' },
                  { kind: 'row_delete', sheetKey: 'sheet_1', rowId: 'r1' },
                ],
                writeSet: [
                  { kind: 'sheet', sheetKey: 'sheet_0' },
                  { kind: 'row', sheetKey: 'sheet_0', rowId: 'r0' },
                  { kind: 'sheet', sheetKey: 'sheet_1' },
                  { kind: 'all' },
                ],
              },
            ],
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);

    const entry = msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0];
    expect(entry.filledSheetKeys).toEqual(['sheet_1']);
    expect(entry.changedSheetKeys).toEqual(['sheet_1']);
    expect(entry.groupKeys).toEqual(['sheet_1']);
    expect(entry.operations).toEqual([
      { kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: { name: '保留表' }, reason: 'manual_crud' },
      { kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] },
      { kind: 'table_edit_dsl', text: 'update sheet_0 but text is not structured' },
    ]);
    expect(entry.patches).toEqual([{ kind: 'row_delete', sheetKey: 'sheet_1', rowId: 'r1' }]);
    expect(entry.writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_1' }, { kind: 'all' }]);
  });

  it('完整删除目标表独占 V2 entry 后移除空壳并将 headRevision 回退到保留 entry', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            headRevision: '2:removed',
            checkpoint: { kind: 'full', data: { sheet_0: { name: '删除表' }, sheet_1: {name: '保留表' } } },
            logEntries: [
              {
                seq: 1, commitRevision: '1:keep', filledSheetKeys: ['sheet_1'], changedSheetKeys: ['sheet_1'],
                operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: { name: '保留表' }, reason: 'manual_crud' }],
              },
              {
                seq: 2, commitRevision: '2:removed', filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'],
                operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: '表' }, reason: 'manual_crud' }],
                writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
              },
            ],
            perSheetCheckpoints: { sheet_0: { kind: 'sheet_full', sheetKey: 'sheet_0', data: { name: '删除表' } } },
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);
    const frame = msg.TavernDB_ACU_IsolatedData.tag1.storageFrame;
    expect(frame.checkpoint.data.sheet_0).toBeUndefined();
    expect(frame.perSheetCheckpoints.sheet_0).toBeUndefined();
    expect(frame.logEntries).toHaveLength(1);
    expect(frame.logEntries[0].commitRevision).toBe('1:keep');
    expect(frame.headRevision).toBe('1:keep');
  });

  it('完整删除裁空最后一个 V2 entry 时清除悬挂的 headRevision', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            headRevision: '1:removed',
            logEntries: [{
              seq: 1, commitRevision: '1:removed', filledSheetKeys: ['sheet_0'],
              operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: '删除表' }, reason: 'manual_crud' }],
            }],
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);
    const frame = msg.TavernDB_ACU_IsolatedData.tag1.storageFrame;
    expect(frame.logEntries).toEqual([]);
    expect(frame.headRevision).toBeNull();
  });


  it('局部改写 V2 data_replace 并保留其他 sheet 数据', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: {},
          modifiedKeys: [],
          updateGroupKeys: [],
          storageFrame: {
            version: 2,
            logEntries: [
              {
                operations: [
                  { kind: 'data_replace', data: { sheet_0: { name: '被删表' }, sheet_1: { name: '保留表' } }, reason: 'manual_crud' },
                  { kind: 'sql_batch', statements: ['select * from sheet_0'] },
                ],
              },
            ],
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);

    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([
      { kind: 'data_replace', data: { sheet_1: { name: '保留表' } }, reason: 'manual_crud' },
      { kind: 'sql_batch', statements: ['select * from sheet_0'] },
    ]);
  });

  it('IsolatedData 为 JSON 字符串时也能清理 V2 storageFrame 并按既有约定写回对象', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: JSON.stringify({
        tag1: {
          independentData: {},
          modifiedKeys: [],
          updateGroupKeys: [],
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              createdAt: 1,
              reason: 'manual',
              data: { sheet_0: { name: '被删表' }, sheet_1: { name: '保留表' } },
            },
            logEntries: [],
          },
        },
      }),
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);
    expect(typeof msg.TavernDB_ACU_IsolatedData).toBe('object');
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.checkpoint.data).toEqual({
      sheet_1: { name: '保留表' },
    });
  });

  it('目标 sheet 不存在于 V2 storageFrame 时不触发变更', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: {},
          modifiedKeys: [],
          updateGroupKeys: [],
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              createdAt: 1,
              reason: 'manual',
              data: { sheet_1: { name: '保留表' } },
            },
            logEntries: [{ operations: [{ kind: 'sql_batch', statements: ['select sheet_0'] }] }],
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(false);
  });

  it('完整清理会删除目标 perSheet checkpoint，并保留其他表 shard', () => {
    const keepShard = {
      kind: 'sheet_full', createdAt: 2, reason: 'manual', sheetKey: 'sheet_1',
      data: { name: '保留表' }, scheduleSummary: { lastFilledAiFloor: 3 },
    };
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            perSheetCheckpoints: {
              sheet_0: { kind: 'sheet_full', createdAt: 1, reason: 'manual', sheetKey: 'sheet_0', data: { name: '被删表' } },
              sheet_1: keepShard,
            },
            logEntries: [],
          },
        },
      },
    };

    expect(purgeSheetKeysFromMessage_ACU(msg, ['sheet_0'])).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.perSheetCheckpoints.sheet_0).toBeUndefined();
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.perSheetCheckpoints.sheet_1).toEqual(keepShard);
  });

});


describe('purgeManualRefillIncrementalSheetKeysFromMessage_ACU', () => {
  it('只裁剪 V2 增量日志和重填进度，不动 checkpoint.data、scheduleSummary 与 independentData', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          independentData: { sheet_0: { name: '独立旧表' }, sheet_1: { name: '独立保留表' } },
          modifiedKeys: ['sheet_0', 'sheet_1'],
          updateGroupKeys: ['sheet_0', 'sheet_1'],
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              createdAt: 1,
              reason: 'manual',
              data: {
                sheet_0: { name: 'checkpoint旧表', content: [['row_id'], ['base']] },
                sheet_1: { name: 'checkpoint保留表', content: [['row_id'], ['keep']] },
              },
              scheduleSummary: {
                sheet_0: { lastFilledAiFloor: 1 },
                sheet_1: { lastFilledAiFloor: 2 },
              },
              manualRefillProgress: {
                kind: 'manual_refill',
                status: 'in_progress',
                selectedSheetKeys: ['sheet_0', 'sheet_1'],
                completedSheetMessageIndexByKey: { sheet_0: 2, sheet_1: 3 },
              },
            },
            manualRefillProgress: {
              kind: 'manual_refill',
              status: 'in_progress',
              selectedSheetKeys: ['sheet_0', 'sheet_1'],
              completedSheetMessageIndexByKey: { sheet_0: 4, sheet_1: 5 },
            },
            logEntries: [
              {
                seq: 1,
                entryId: 'entry-1',
                filledSheetKeys: ['sheet_0', 'sheet_1'],
                changedSheetKeys: ['sheet_0', 'sheet_1'],
                groupKeys: ['sheet_0', 'sheet_1'],
                operations: [
                  { kind: 'data_replace', data: { sheet_0: { name: '增量旧表' }, sheet_1: { name: '增量保留表' } }, reason: 'manual_crud' },
                  { kind: 'row_upsert', sheetKey: 'sheet_0', rowId: 'r0', cells: ['r0'] },
                  { kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] },
                  { kind: 'table_edit_dsl', text: 'update sheet_0 but text is not structured' },
                ],
                patches: [
                  { kind: 'row_delete', sheetKey: 'sheet_0', rowId: 'r0' },
                  { kind: 'row_delete', sheetKey: 'sheet_1', rowId: 'r1' },
                ],
                writeSet: [
                  { kind: 'sheet', sheetKey: 'sheet_0' },
                  { kind: 'sheet', sheetKey: 'sheet_1' },
                  { kind: 'all' },
                ],
              },
            ],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);

    const tagData = msg.TavernDB_ACU_IsolatedData.tag1;
    const frame = tagData.storageFrame;
    expect(tagData.independentData.sheet_0).toEqual({ name: '独立旧表' });
    expect(tagData.modifiedKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(tagData.updateGroupKeys).toEqual(['sheet_0', 'sheet_1']);
    expect(frame.checkpoint.data.sheet_0).toEqual({ name: 'checkpoint旧表', content: [['row_id'], ['base']] });
    expect(frame.checkpoint.data.sheet_1).toEqual({ name: 'checkpoint保留表', content: [['row_id'], ['keep']] });
    expect(frame.checkpoint.scheduleSummary.sheet_0).toEqual({ lastFilledAiFloor: 1 });
    expect(frame.checkpoint.scheduleSummary.sheet_1).toEqual({ lastFilledAiFloor: 2 });
    expect(frame.checkpoint.manualRefillProgress.selectedSheetKeys).toEqual(['sheet_1']);
    expect(frame.checkpoint.manualRefillProgress.completedSheetMessageIndexByKey).toEqual({ sheet_1: 3 });
    expect(frame.manualRefillProgress.selectedSheetKeys).toEqual(['sheet_1']);
    expect(frame.manualRefillProgress.completedSheetMessageIndexByKey).toEqual({ sheet_1: 5 });
    expect(frame.logEntries[0].filledSheetKeys).toEqual(['sheet_1']);
    expect(frame.logEntries[0].changedSheetKeys).toEqual(['sheet_1']);
    expect(frame.logEntries[0].groupKeys).toEqual(['sheet_1']);
    expect(frame.logEntries[0].operations).toEqual([
      { kind: 'data_replace', data: { sheet_1: { name: '增量保留表' } }, reason: 'manual_crud' },
      { kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] },
      { kind: 'table_edit_dsl', text: 'update sheet_0 but text is not structured' },
    ]);
    expect(frame.logEntries[0].patches).toEqual([{ kind: 'row_delete', sheetKey: 'sheet_1', rowId: 'r1' }]);
    expect(frame.logEntries[0].writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_1' }, { kind: 'all' }]);
  });

  it('裁剪后将 headRevision 收敛到最后保留 entry，避免后续追加引用已删 revision', () => {
    const frame: any = {
      version: 2,
      headRevision: '2:removed',
      checkpoint: { kind: 'full', data: { sheet_0: { name: 'base' }, sheet_1: { name: 'keep' } } },
      logEntries: [
        {
          seq: 1, commitRevision: '1:keep', filledSheetKeys: ['sheet_1'], changedSheetKeys: ['sheet_1'], groupKeys: ['sheet_1'],
          operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: { name: 'keep' }, reason: 'manual_crud' }],
        },
        {
          seq: 2, commitRevision: '2:removed', filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: ['sheet_0'],
          operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: 'remove' }, reason: 'manual_crud' }],
        },
      ],
    };

    expect(purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU(frame, new Set(['sheet_0']))).toBe(true);
    expect(frame.logEntries).toHaveLength(1);
    expect(frame.logEntries[0].commitRevision).toBe('1:keep');
    expect(frame.headRevision).toBe('1:keep');
  });

  it('裁剪清空全部 entry 时移除指向已删除 entry 的 headRevision', () => {
    const frame: any = {
      version: 2,
      headRevision: '1:removed',
      checkpoint: { kind: 'full', data: { sheet_0: { name: 'base' } } },
      logEntries: [{ seq: 1, commitRevision: '1:removed', filledSheetKeys: ['sheet_0'], operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: 'remove' }, reason: 'manual_crud' }] }],
    };

    expect(purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU(frame, new Set(['sheet_0']))).toBe(true);
    expect(frame.logEntries).toEqual([]);
    expect(frame.headRevision).toBeNull();
  });

  it('目标 sheet 专属 V2 增量日志清理后移除空壳 entry，并保留 checkpoint.data', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: JSON.stringify({
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', data: { sheet_0: { name: 'checkpoint旧表' }, sheet_1: { name: 'checkpoint保留表' } } },
            logEntries: [{ operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: '旧表' }, reason: 'manual_crud' }] }],
          },
        },
      }),
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);
    expect(typeof msg.TavernDB_ACU_IsolatedData).toBe('object');
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.checkpoint.data).toEqual({
      sheet_0: { name: 'checkpoint旧表' },
      sheet_1: { name: 'checkpoint保留表' },
    });
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries).toEqual([]);
  });

  it('清理目标 sheet 专属 entry 时保留同 frame 内非目标 sheet 的混合 entry', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', data: { sheet_0: { name: 'checkpoint旧表' }, sheet_1: { name: 'checkpoint保留表' } } },
            logEntries: [
              {
                seq: 1,
                filledSheetKeys: ['sheet_0'],
                changedSheetKeys: ['sheet_0'],
                groupKeys: ['sheet_0'],
                operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: 'r0', cells: ['r0'] }],
                writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
              },
              {
                seq: 2,
                filledSheetKeys: ['sheet_0', 'sheet_1'],
                changedSheetKeys: ['sheet_0', 'sheet_1'],
                groupKeys: ['sheet_0', 'sheet_1'],
                operations: [
                  { kind: 'row_upsert', sheetKey: 'sheet_0', rowId: 'r0', cells: ['r0'] },
                  { kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] },
                ],
                writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }, { kind: 'sheet', sheetKey: 'sheet_1' }],
              },
            ],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);

    const frame = msg.TavernDB_ACU_IsolatedData.tag1.storageFrame;
    expect(frame.logEntries).toHaveLength(1);
    expect(frame.logEntries[0]).toEqual(expect.objectContaining({
      seq: 2,
      filledSheetKeys: ['sheet_1'],
      changedSheetKeys: ['sheet_1'],
      groupKeys: ['sheet_1'],
      operations: [{ kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] }],
      writeSet: [{ kind: 'sheet', sheetKey: 'sheet_1' }],
    }));
    expect(frame.checkpoint.data.sheet_0).toEqual({ name: 'checkpoint旧表' });
  });


  it('清理 V2 增量日志中的 runtime-v1 baseRevision 与 parentRevision 目标 sheet 指纹', () => {
    const baseSnapshot = {
      scopeKey: 'chat::tag1::runtime',
      all: false,
      global: 28,
      allRevision: 2,
      sheets: { sheet_0: 28, sheet_1: 12 },
    };
    const parentSnapshot = {
      scopeKey: 'chat::tag1::runtime',
      all: false,
      global: 29,
      allRevision: 3,
      sheets: { sheet_0: 29, sheet_2: 8 },
    };
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [
              {
                seq: 1,
                baseRevision: `runtime-v1:${JSON.stringify(baseSnapshot)}`,
                parentRevision: `runtime-v1:${JSON.stringify(parentSnapshot)}`,
                filledSheetKeys: ['sheet_1'],
                changedSheetKeys: ['sheet_1'],
                operations: [{ kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] }],
                writeSet: [{ kind: 'sheet', sheetKey: 'sheet_1' }],
              },
            ],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);

    const entry = msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0];
    const nextBaseSnapshot = JSON.parse(entry.baseRevision.slice('runtime-v1:'.length));
    const nextParentSnapshot = JSON.parse(entry.parentRevision.slice('runtime-v1:'.length));
    expect(nextBaseSnapshot.sheets).toEqual({ sheet_1: 12 });
    expect(nextParentSnapshot.sheets).toEqual({ sheet_2: 8 });
    expect(entry.filledSheetKeys).toEqual(['sheet_1']);
    expect(entry.changedSheetKeys).toEqual(['sheet_1']);
    expect(entry.operations).toEqual([{ kind: 'row_upsert', sheetKey: 'sheet_1', rowId: 'r1', cells: ['r1'] }]);
    expect(entry.writeSet).toEqual([{ kind: 'sheet', sheetKey: 'sheet_1' }]);
  });


  it('清理只剩 runtime-v1 revision 指纹的 V2 空壳 entry 时删除该 entry', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [
              {
                seq: 1,
                baseRevision: `runtime-v1:${JSON.stringify({
                  scopeKey: 'chat::tag1::runtime',
                  all: false,
                  global: 28,
                  allRevision: 2,
                  sheets: { sheet_0: 28, sheet_1: 12 },
                })}`,
              },
            ],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries).toEqual([]);
  });

  it('SQL 模式增量预清理会删除目标表 sql_batch 语句并同步裁剪 params', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              data: {
                sheet_0: { uid: 'inventory', name: '背包表', sourceData: { ddl: 'CREATE TABLE inventory (row_id TEXT)' } },
                sheet_1: { uid: 'quest_log', name: '任务表', sourceData: { ddl: 'CREATE TABLE quest_log (row_id TEXT)' } },
              },
            },
            logEntries: [{
              operations: [{
                kind: 'sql_batch',
                statements: [
                  "INSERT INTO inventory VALUES ('old')",
                  "UPDATE quest_log SET value = 'keep' WHERE row_id = 'q1'",
                  "DELETE FROM inventory WHERE row_id = 'old'",
                ],
                params: [['insert-target'], ['keep-other'], ['delete-target']],
              }],
            }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);

    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements: ["UPDATE quest_log SET value = 'keep' WHERE row_id = 'q1'"],
      params: [['keep-other']],
    }]);
  });

  it('SQL 模式增量预清理在 sql_batch 全部命中目标表时删除 operation 和空壳 entry', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              data: {
                sheet_0: { uid: 'inventory', name: '背包表', sourceData: { ddl: 'CREATE TABLE inventory (row_id TEXT)' } },
              },
            },
            logEntries: [{
              filledSheetKeys: ['sheet_0'],
              changedSheetKeys: ['sheet_0'],
              groupKeys: ['sheet_0'],
              operations: [{
                kind: 'sql_batch',
                statements: [
                  "INSERT INTO inventory VALUES ('old')",
                  "REPLACE INTO inventory VALUES ('new')",
                ],
              }],
              writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
            }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);

    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries).toEqual([]);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.checkpoint.data.sheet_0).toEqual({
      uid: 'inventory',
      name: '背包表',
      sourceData: { ddl: 'CREATE TABLE inventory (row_id TEXT)' },
    });
  });

  it('SQL 模式增量预清理会按 sheetKey 直接删除 sql_sheet_batch 且保留其他表 operation', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              data: {
                sheet_0: { uid: 'inventory', name: '背包表', sourceData: { ddl: 'CREATE TABLE inventory (row_id TEXT)' } },
                sheet_1: { uid: 'quest_log', name: '任务表', sourceData: { ddl: 'CREATE TABLE quest_log (row_id TEXT)' } },
              },
            },
            logEntries: [{
              filledSheetKeys: ['sheet_0', 'sheet_1'],
              changedSheetKeys: ['sheet_0', 'sheet_1'],
              groupKeys: ['sheet_0', 'sheet_1'],
              operations: [
                {
                  kind: 'sql_sheet_batch',
                  sheetKey: 'sheet_0',
                  statements: ["INSERT INTO inventory VALUES ('old')"],
                  tableName: 'inventory',
                  reason: 'system',
                },
                {
                  kind: 'sql_sheet_batch',
                  sheetKey: 'sheet_1',
                  statements: ["INSERT INTO quest_log VALUES ('keep')"],
                  tableName: 'quest_log',
                  reason: 'system',
                },
              ],
            }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);

    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].filledSheetKeys).toEqual(['sheet_1']);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].changedSheetKeys).toEqual(['sheet_1']);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].groupKeys).toEqual(['sheet_1']);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_sheet_batch',
      sheetKey: 'sheet_1',
      statements: ["INSERT INTO quest_log VALUES ('keep')"],
      tableName: 'quest_log',
      reason: 'system',
    }]);
  });

  it('SQL 模式增量预清理遇到无法识别的 sql_batch 语句时保留原 operation', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              data: {
                sheet_0: { uid: 'inventory', name: '背包表', sourceData: { ddl: 'CREATE TABLE inventory (row_id TEXT)' } },
              },
            },
            logEntries: [{
              operations: [{
                kind: 'sql_batch',
                statements: [
                  'SELECT * FROM inventory',
                  'CREATE TABLE inventory_backup (row_id TEXT)',
                ],
              }],
            }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(false);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements: ['SELECT * FROM inventory', 'CREATE TABLE inventory_backup (row_id TEXT)'],
    }]);
  });

  it('目标 sheet 不存在于 V2 增量日志时不触发变更', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', data: { sheet_0: { name: 'checkpoint旧表' } } },
            logEntries: [{ operations: [{ kind: 'sql_batch', statements: ['select sheet_0'] }] }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(false);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.checkpoint.data.sheet_0).toEqual({ name: 'checkpoint旧表' });
  });

  it('只清理指定 isolationKey，不串改其他隔离标签的同名 sheet', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', data: { sheet_0: { name: 'tag1 checkpoint' } } },
            logEntries: [{
              filledSheetKeys: ['sheet_0', 'sheet_1'],
              changedSheetKeys: ['sheet_0', 'sheet_1'],
              operations: [
                { kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: 'tag1 旧表' }, reason: 'manual_crud' },
                { kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: { name: 'tag1 保留表' }, reason: 'manual_crud' },
              ],
            }],
          },
        },
        tag2: {
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', data: { sheet_0: { name: 'tag2 checkpoint' } } },
            logEntries: [{
              filledSheetKeys: ['sheet_0'],
              changedSheetKeys: ['sheet_0'],
              operations: [
                { kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: 'tag2 不应被清理' }, reason: 'manual_crud' },
              ],
            }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);

    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].filledSheetKeys).toEqual(['sheet_1']);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].changedSheetKeys).toEqual(['sheet_1']);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([
      { kind: 'sheet_replace', sheetKey: 'sheet_1', sheet: { name: 'tag1 保留表' }, reason: 'manual_crud' },
    ]);
    expect(msg.TavernDB_ACU_IsolatedData.tag2.storageFrame.logEntries[0].filledSheetKeys).toEqual(['sheet_0']);
    expect(msg.TavernDB_ACU_IsolatedData.tag2.storageFrame.logEntries[0].changedSheetKeys).toEqual(['sheet_0']);
    expect(msg.TavernDB_ACU_IsolatedData.tag2.storageFrame.logEntries[0].operations).toEqual([
      { kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: 'tag2 不应被清理' }, reason: 'manual_crud' },
    ]);
  });

  it('增量预清除保留目标 perSheet checkpoint，只删除目标日志', () => {
    const shard = {
      kind: 'sheet_full',
      createdAt: 1,
      reason: 'manual',
      sheetKey: 'sheet_0',
      data: { name: '新基底' },
      scheduleSummary: { lastFilledAiFloor: 5 },
      event: { filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [] },
    };
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            perSheetCheckpoints: { sheet_0: shard },
            logEntries: [{
              seq: 1,
              filledSheetKeys: ['sheet_0'],
              changedSheetKeys: ['sheet_0'],
              operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: '旧增量' }, reason: 'manual_crud' }],
            }],
          },
        },
      },
    };
    const before = JSON.parse(JSON.stringify(shard));

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.perSheetCheckpoints.sheet_0).toEqual(before);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries).toEqual([]);
  });

  it('会从 perSheet checkpoint 推导 SQL 表名并裁剪旧 sql_batch', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            perSheetCheckpoints: {
              sheet_0: {
                kind: 'sheet_full',
                sheetKey: 'sheet_0',
                createdAt: 1,
                reason: 'manual',
                data: { uid: 'chronicle', name: '纪要表', sourceData: { ddl: 'CREATE TABLE chronicle (row_id TEXT)' } },
              },
            },
            logEntries: [{ operations: [{ kind: 'sql_batch', statements: ["UPDATE chronicle SET code_index = 'x' WHERE row_id = 'r1'"] }] }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'])).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.perSheetCheckpoints.sheet_0.data.uid).toBe('chronicle');
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries).toEqual([]);
  });

  it('使用跨 frame 汇总的 SQL 表名裁剪当前 log-only frame，并保留其他表语句与 params', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [{
              operations: [{
                kind: 'sql_batch',
                statements: [
                  'UPDATE chronicle SET code_index = ? WHERE row_id = ?',
                  'UPDATE quest_log SET value = ? WHERE row_id = ?',
                ],
                params: [['target', 'r1'], ['keep', 'q1']],
              }],
            }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'], new Set(['chronicle']))).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements: ['UPDATE quest_log SET value = ? WHERE row_id = ?'],
      params: [['keep', 'q1']],
    }]);
  });

  it('支持现场单引号表名，并忽略字符串、注释和 CTE 内的伪 mutation', () => {
    const statements = [
      "UPDATE 'chronicle' SET 'code_index' = ? WHERE 'row_id' = ?",
      "WITH source AS (SELECT 'UPDATE chronicle SET code_index = 1' AS note) UPDATE quest_log SET value = ? WHERE row_id = ?",
      '/* UPDATE chronicle SET code_index = 1 */ UPDATE quest_log SET value = ? WHERE row_id = ?',
      '-- DELETE FROM chronicle\nUPDATE quest_log SET value = ? WHERE row_id = ?',
    ];
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [{
              operations: [{
                kind: 'sql_batch',
                statements,
                params: [['target', 'r1'], ['cte', 'q1'], ['block', 'q2'], ['line', 'q3']],
              }],
            }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'], new Set(['chronicle']))).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements: statements.slice(1),
      params: [['cte', 'q1'], ['block', 'q2'], ['line', 'q3']],
    }]);
  });


  it('只在可靠解析时裁剪 SQLite 冲突子句，并保留异常或转义字符串中的伪 mutation', () => {
    const removableStatements = [
      "UPDATE OR REPLACE chronicle SET code_index = 'x' WHERE row_id = 'r1'",
      "UPDATE OR IGNORE 'chronicle' SET code_index = 'y' WHERE row_id = 'r2'",
      "INSERT OR REPLACE INTO chronicle (row_id) VALUES ('r3')",
    ];
    const retainedStatements = [
      "SELECT 'it\\'s UPDATE chronicle SET code_index = 1'",
      "UPDATE [chron]]icle] SET code_index = 'keep' WHERE row_id = 'r4'",
      'UPDATE OR UNKNOWN chronicle SET code_index = 1',
      "SELECT 'UPDATE chronicle SET code_index = 1",
      '/* UPDATE chronicle SET code_index = 1',
      'WITH source AS (SELECT 1 UPDATE chronicle SET code_index = 1',
      "UPDATE quest_log SET value = 'keep' WHERE row_id = 'q1'",
    ];
    const statements = [...removableStatements, ...retainedStatements];
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [{ operations: [{ kind: 'sql_batch', statements }] }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'], new Set(['chronicle']))).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements: retainedStatements,
    }]);
  });

  it('保留定义与包装语句中的 mutation 文本，不误删触发器、视图或 EXPLAIN', () => {
    const statements = [
      'CREATE TRIGGER sync_chronicle AFTER INSERT ON source_table BEGIN UPDATE chronicle SET code_index = NEW.code_index WHERE row_id = NEW.row_id; END',
      'CREATE TRIGGER insert_chronicle AFTER INSERT ON source_table BEGIN INSERT INTO chronicle (row_id) VALUES (NEW.row_id); END',
      'CREATE TRIGGER delete_chronicle AFTER DELETE ON source_table BEGIN DELETE FROM chronicle WHERE row_id = OLD.row_id; END',
      'CREATE VIEW chronicle_view AS SELECT * FROM chronicle',
      "EXPLAIN UPDATE chronicle SET code_index = 'x' WHERE row_id = 'r1'",
    ];
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [{ operations: [{ kind: 'sql_batch', statements }] }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'], new Set(['chronicle']))).toBe(false);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements,
    }]);
  });

  it('裁剪 schema-qualified 目标表写操作，并保留其他限定表', () => {
    const removableStatements = [
      'UPDATE main.chronicle SET code_index = 1',
      'INSERT INTO "main"."chronicle" (row_id) VALUES (1)',
      'REPLACE INTO temp.chronicle (row_id) VALUES (2)',
      'DELETE FROM [main].[chronicle] WHERE row_id = 3',
      'ALTER TABLE main . chronicle ADD COLUMN note TEXT',
    ];
    const retainedStatements = [
      'UPDATE main.quest_log SET value = 1',
      'INSERT INTO "main"."quest_log" (row_id) VALUES (1)',
    ];
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [{ operations: [{ kind: 'sql_batch', statements: [...removableStatements, ...retainedStatements] }] }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'], new Set(['chronicle']))).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements: retainedStatements,
    }]);
  });

  it('ALTER TABLE RENAME TO 同时匹配源表和目标表，但不把列重命名当作表名', () => {
    const retainedStatements = [
      'ALTER TABLE other RENAME TO other2',
      'ALTER TABLE other ADD COLUMN x TEXT',
      'ALTER TABLE other RENAME COLUMN chronicle TO archived',
    ];
    const msg: any = {
      TavernDB_ACU_IsolatedData: {
        tag1: {
          storageFrame: {
            version: 2,
            logEntries: [{ operations: [{
              kind: 'sql_batch',
              statements: ['ALTER TABLE quest_log RENAME TO chronicle', ...retainedStatements],
            }] }],
          },
        },
      },
    };

    expect(purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg, 'tag1', ['sheet_0'], new Set(['chronicle']))).toBe(true);
    expect(msg.TavernDB_ACU_IsolatedData.tag1.storageFrame.logEntries[0].operations).toEqual([{
      kind: 'sql_batch',
      statements: retainedStatements,
    }]);
  });



});

describe('clearAllTableFields_ACU', () => {
  it('null msg 不抛错', () => {
    expect(() => clearAllTableFields_ACU(null)).not.toThrow();
  });

  it('清除所有 TavernDB_ACU_* 字段', () => {
    const msg: any = {
      TavernDB_ACU_IsolatedData: { tag1: {} },
      TavernDB_ACU_IndependentData: { sheet_0: {} },
      TavernDB_ACU_Data: { sheet_0: {} },
      TavernDB_ACU_SummaryData: { sheet_0: {} },
      TavernDB_ACU_Identity: 'code_1',
      TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      TavernDB_ACU_UpdateGroupKeys: ['sheet_0'],
      _acu_local_template_base_state_seeded: true,
      otherField: '保留',
    };
    clearAllTableFields_ACU(msg);
    expect(msg.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(msg.TavernDB_ACU_IndependentData).toBeUndefined();
    expect(msg.TavernDB_ACU_Data).toBeUndefined();
    expect(msg.TavernDB_ACU_SummaryData).toBeUndefined();
    expect(msg.TavernDB_ACU_Identity).toBeUndefined();
    expect(msg.TavernDB_ACU_ModifiedKeys).toBeUndefined();
    expect(msg.TavernDB_ACU_UpdateGroupKeys).toBeUndefined();
    expect(msg._acu_local_template_base_state_seeded).toBeUndefined();
    // 非 ACU 字段保留
    expect(msg.otherField).toBe('保留');
  });
});

// ═══ 辅助类 ═══

describe('hasAnyTableData_ACU', () => {
  it('null msg 返回 false', () => {
    expect(hasAnyTableData_ACU(null)).toBe(false);
  });

  it('指定 isolationKey 检查新版数据', () => {
    const msg = {
      TavernDB_ACU_IsolatedData: {
        tag1: { independentData: { sheet_0: { name: '表' } } },
      },
    };
    expect(hasAnyTableData_ACU(msg, 'tag1')).toBe(true);
    expect(hasAnyTableData_ACU(msg, 'tag2')).toBe(false);
  });

  it('不指定 isolationKey 检查容器是否有内容', () => {
    const msg = { TavernDB_ACU_IsolatedData: { tag1: {} } };
    expect(hasAnyTableData_ACU(msg)).toBe(true);
  });

  it('有旧版 IndependentData 返回 true', () => {
    const msg = { TavernDB_ACU_IndependentData: { sheet_0: {} } };
    expect(hasAnyTableData_ACU(msg)).toBe(true);
  });

  it('有旧版 Data 返回 true', () => {
    const msg = { TavernDB_ACU_Data: { sheet_0: {} } };
    expect(hasAnyTableData_ACU(msg)).toBe(true);
  });

  it('有旧版 SummaryData 返回 true', () => {
    const msg = { TavernDB_ACU_SummaryData: { sheet_0: {} } };
    expect(hasAnyTableData_ACU(msg)).toBe(true);
  });

  it('有 isolationConfig 且不匹配时跳过旧版检查', () => {
    const msg = {
      TavernDB_ACU_Identity: 'code_2',
      TavernDB_ACU_IndependentData: { sheet_0: {} },
    };
    expect(hasAnyTableData_ACU(msg, undefined, { enabled: true, code: 'code_1' })).toBe(false);
  });

  it('空 msg 无任何数据返回 false', () => {
    expect(hasAnyTableData_ACU({})).toBe(false);
  });
});

describe('cloneIsolatedData_ACU', () => {
  it('无 IsolatedData 返回空对象', () => {
    expect(cloneIsolatedData_ACU({})).toEqual({});
  });

  it('有 IsolatedData 返回深拷贝', () => {
    const original = { tag1: { independentData: { sheet_0: { name: '表' } } } };
    const msg = { TavernDB_ACU_IsolatedData: original };
    const cloned = cloneIsolatedData_ACU(msg);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.tag1).not.toBe(original.tag1);
  });

  it('IsolatedData 为 JSON 字符串时正确解析并深拷贝', () => {
    const data = { tag1: { independentData: {} } };
    const msg = { TavernDB_ACU_IsolatedData: JSON.stringify(data) };
    const cloned = cloneIsolatedData_ACU(msg);
    expect(cloned).toEqual(data);
  });
});