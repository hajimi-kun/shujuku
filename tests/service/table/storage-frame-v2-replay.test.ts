import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogWarn } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
}));

vi.mock('../../../src/shared/utils', async () => {
  const actual = await vi.importActual<any>('../../../src/shared/utils');
  return { ...actual, logWarn_ACU: mockLogWarn };
});

import { applyTableOperationV2_ACU, applyTablePatchV2_ACU, collectScheduleSummaryFromFramesV2_ACU, loadTableStateFromFramesV2_ACU } from '../../../src/service/table/storage-frame-v2-replay';
import { buildSheetSchemaMigrationOperation_ACU } from '../../../src/service/table/table-schema-migration';
import { _set_independentTableStates_ACU, independentTableStates_ACU } from '../../../src/service/runtime/state-manager';

function makeCheckpointData() {
  return {
    mate: { type: 'acu', version: 1 },
    sheet_0: {
      uid: 'inventory',
      name: '背包',
      content: [
        ['row_id', 'name'],
        ['1', '铁剑'],
      ],
      sourceData: {
        ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT);',
      },
      updateConfig: {},
      exportConfig: {},
      orderNo: 0,
    },
  } as any;
}

function makeDslCheckpointData() {
  return {
    mate: { type: 'acu', version: 1 },
    sheet_a: {
      uid: 'global_state',
      name: '全局数据表',
      content: [['row_id', '地点'], ['1', '起点']],
      sourceData: {},
      updateConfig: {},
      exportConfig: {},
      orderNo: 0,
    },
    sheet_b: {
      uid: 'chronicle',
      name: '纪要表',
      content: [['row_id', '时间跨度', '地点', '纪要', '概要']],
      sourceData: {},
      updateConfig: {},
      exportConfig: {},
      orderNo: 1,
    },
  } as any;
}

describe('loadTableStateFromFramesV2_ACU', () => {
  beforeEach(() => {
    mockLogWarn.mockClear();
  });

  it('从最后 checkpoint 开始，在同一个恢复 runtime 上顺序回放 sql_batch', async () => {
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                createdAt: 1,
                reason: 'init',
                data: makeCheckpointData(),
                event: { filledSheetKeys: [], changedSheetKeys: [], groupKeys: [] },
              },
              logEntries: [
                {
                  seq: 1,
                  entryId: 'v2_sql_1',
                  createdAt: 2,
                  source: 'auto_fill',
                  targetMessageIndex: 0,
                  aiFloor: 1,
                  filledSheetKeys: ['sheet_0'],
                  changedSheetKeys: ['sheet_0'],
                  groupKeys: [],
                  operations: [
                    { kind: 'sql_batch', statements: ["UPDATE inventory SET name = '钢剑' WHERE row_id = 1"] },
                  ],
                },
                {
                  seq: 2,
                  entryId: 'v2_sql_2',
                  createdAt: 3,
                  source: 'auto_fill',
                  targetMessageIndex: 0,
                  aiFloor: 1,
                  filledSheetKeys: ['sheet_0'],
                  changedSheetKeys: ['sheet_0'],
                  groupKeys: [],
                  operations: [
                    { kind: 'sql_batch', statements: ["INSERT INTO inventory VALUES (2, '药水')"] },
                  ],
                },
              ],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_0.content).toEqual([
      ['row_id', 'name'],
      ['1', '钢剑'],
      ['2', '药水'],
    ]);
  });

  it('只读回放保持数据结果但不更新 independentTableStates', async () => {
    const previousIndependentStates = independentTableStates_ACU;
    _set_independentTableStates_ACU({ sheet_existing: { lastUpdatedAiFloor: 99 } });
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full', createdAt: 1, reason: 'init', data: makeCheckpointData(),
              event: { filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [] },
            },
            logEntries: [{
              seq: 1, entryId: 'readonly-replay', createdAt: 2, source: 'auto_fill', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [],
              operations: [{ kind: 'sql_batch', statements: ["UPDATE inventory SET name = '钢剑' WHERE row_id = 1"] }],
            }],
          },
        },
      },
    }];

    try {
      const result = await loadTableStateFromFramesV2_ACU(chat, '', { updateRuntimeState: false });

      expect(result?.sheet_0.content[1]).toEqual(['1', '钢剑']);
      expect(independentTableStates_ACU).toEqual({ sheet_existing: { lastUpdatedAiFloor: 99 } });
    } finally {
      _set_independentTableStates_ACU(previousIndependentStates);
    }
  });

  it('回放带参数绑定的 sql_batch', async () => {
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                createdAt: 1,
                reason: 'init',
                data: makeCheckpointData(),
                event: { filledSheetKeys: [], changedSheetKeys: [], groupKeys: [] },
              },
              logEntries: [{
                seq: 1,
                entryId: 'v2_sql_params_1',
                createdAt: 2,
                source: 'manual_crud',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: [],
                changedSheetKeys: ['sheet_0'],
                groupKeys: [],
                operations: [{
                  kind: 'sql_batch',
                  statements: ['UPDATE inventory SET name = ? WHERE row_id = ?'],
                  params: [['钢剑', 1]],
                }],
              }],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_0.content[1]).toEqual(['1', '钢剑']);
  });

  it('回放带 sheetKey 的 sql_sheet_batch，并保留 SQL runtime 语义', async () => {
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                createdAt: 1,
                reason: 'init',
                data: makeCheckpointData(),
                event: { filledSheetKeys: [], changedSheetKeys: [], groupKeys: [] },
              },
              logEntries: [{
                seq: 1,
                entryId: 'v2_sql_sheet_batch_1',
                createdAt: 2,
                source: 'manual_crud',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_0'],
                changedSheetKeys: ['sheet_0'],
                groupKeys: [],
                operations: [{
                  kind: 'sql_sheet_batch',
                  sheetKey: 'sheet_0',
                  statements: ['UPDATE inventory SET name = ? WHERE row_id = ?', 'INSERT INTO inventory VALUES (?, ?)'],
                  params: [['钢剑', 1], [2, '药水']],
                  tableName: 'inventory',
                  reason: 'system',
                }],
              }],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_0.content).toEqual([
      ['row_id', 'name'],
      ['1', '钢剑'],
      ['2', '药水'],
    ]);
  });

  it('同楼层单表 checkpoint 引入新 DDL/CHECK 后再回放 sql_batch', async () => {
    const oldData = {
      mate: { type: 'acu', version: 1 },
      sheet_MapElements: {
        uid: 'sheet_MapElements',
        name: '地图元素表',
        content: [['row_id', '元素名称', '元素类型'], ['1', '旧点', '地标']],
        sourceData: {
          ddl: `CREATE TABLE map_elements (
            row_id INTEGER PRIMARY KEY,
            element_name TEXT NOT NULL, -- 元素名称
            element_type TEXT NOT NULL CHECK(element_type IN ('地标')) -- 元素类型
          );`,
        },
        updateConfig: {},
        exportConfig: {},
        orderNo: 0,
      },
    } as any;
    const schemaChangeSheet = {
      ...oldData.sheet_MapElements,
      sourceData: {
        ddl: `CREATE TABLE map_elements (
          row_id INTEGER PRIMARY KEY,
          element_name TEXT NOT NULL, -- 元素名称
          element_type TEXT NOT NULL CHECK(element_type IN ('地标','地形')) -- 元素类型
        );`,
      },
    };
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                createdAt: 1,
                reason: 'init',
                data: oldData,
                event: { filledSheetKeys: [], changedSheetKeys: [], groupKeys: [] },
              },
              logEntries: [],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              perSheetCheckpoints: {
                sheet_MapElements: {
                  kind: 'sheet_full',
                  createdAt: 2,
                  reason: 'schema_change',
                  sheetKey: 'sheet_MapElements',
                  data: schemaChangeSheet,
                },
              },
              logEntries: [{
                seq: 1,
                entryId: 'v2_sql_terrain',
                createdAt: 3,
                source: 'manual_crud',
                targetMessageIndex: 1,
                aiFloor: 2,
                filledSheetKeys: [],
                changedSheetKeys: ['sheet_MapElements'],
                groupKeys: [],
                operations: [{
                  kind: 'sql_batch',
                  statements: ["INSERT INTO map_elements (row_id, element_name, element_type) VALUES (2, '废弃集装箱', '地形')"],
                }],
              }],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_MapElements.sourceData.ddl).toContain("'地形'");
    expect(result?.sheet_MapElements.content).toEqual([
      ['row_id', '元素名称', '元素类型'],
      ['1', '旧点', '地标'],
      ['2', '废弃集装箱', '地形'],
    ]);
  });

  it('当前 guide 不改写历史 full checkpoint，也不凭空创建新表', async () => {
    const oldData = makeCheckpointData();
    const chat = [{
      is_user: false,
      TavernDB_ACU_InternalSheetGuide: {
        version: 2,
        tags: {
          '': {
            data: {
              mate: { type: 'chatSheets', version: 2 },
              sheet_0: { ...oldData.sheet_0, content: [['row_id', '未来名称']], sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, future_name TEXT);' } },
              sheet_future: { uid: 'future', name: '未来表', content: [['row_id', '值']], sourceData: {}, updateConfig: {}, exportConfig: {}, orderNo: 1 },
            },
          },
        },
      },
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: oldData },
            logEntries: [],
          },
        },
      },
    }];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_0.content[0]).toEqual(['row_id', 'name']);
    expect(result?.sheet_0.sourceData.ddl).toBe('CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT);');
    expect(result).not.toHaveProperty('sheet_future');
  });

  it('回放无分号分隔且含前置文本的 table_edit_dsl', async () => {
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                createdAt: 1,
                reason: 'init',
                data: makeDslCheckpointData(),
                event: { filledSheetKeys: [], changedSheetKeys: [], groupKeys: [] },
              },
              logEntries: [{
                seq: 1,
                entryId: 'v2_dsl_1',
                createdAt: 2,
                source: 'auto_fill',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_a', 'sheet_b'],
                changedSheetKeys: ['sheet_a', 'sheet_b'],
                groupKeys: [],
                operations: [{
                  kind: 'table_edit_dsl',
                  text: '说明文字 updateRow(0, 0, {"0":"城镇(北区)"}) insertRow(1, {"0":"第一天","1":"城镇(北区)","2":"记录包含括号(测试)，不应破坏命令切分。","3":"抵达城镇"})',
                }],
              }],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_a.content[1]).toEqual(['1', '城镇(北区)']);
    expect(result?.sheet_b.content).toEqual([
      ['row_id', '时间跨度', '地点', '纪要', '概要'],
      ['1', '第一天', '城镇(北区)', '记录包含括号(测试)，不应破坏命令切分。', '抵达城镇'],
    ]);
  });

  it('row_upsert 的空 row_id 删除目标行，身份不一致的 row_upsert 拒绝回放', async () => {
    const makeChat = (cells: any[]) => [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: makeCheckpointData() },
            logEntries: [{
              seq: 1,
              entryId: 'row-upsert',
              createdAt: 2,
              source: 'manual_crud',
              targetMessageIndex: 0,
              aiFloor: 1,
              filledSheetKeys: [],
              changedSheetKeys: ['sheet_0'],
              groupKeys: [],
              operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells }],
            }],
          },
        },
      },
    }];

    const removed = await loadTableStateFromFramesV2_ACU(makeChat([' ', '不会保留']), '');
    expect(removed?.sheet_0.content).toEqual([['row_id', 'name']]);

    await expect(loadTableStateFromFramesV2_ACU(makeChat(['2', '冲突身份']), '')).rejects.toThrow(/row_id|身份|rowId/i);
  });

  it('row_upsert 在身份、行宽或既有重复身份无效时不修改 state', () => {
    const cases = [
      { rowId: '1', cells: ['2', '身份漂移'] },
      { rowId: '1', cells: ['1'] },
    ];

    for (const patch of cases) {
      const state = makeCheckpointData();
      const before = JSON.parse(JSON.stringify(state));
      expect(() => applyTablePatchV2_ACU(state, { kind: 'row_upsert', sheetKey: 'sheet_0', ...patch } as any)).toThrow(/身份|行宽/i);
      expect(state).toEqual(before);
    }

    const duplicateState = makeCheckpointData();
    duplicateState.sheet_0.content.push([' 1 ', '重复行']);
    const duplicateBefore = JSON.parse(JSON.stringify(duplicateState));
    expect(() => applyTablePatchV2_ACU(duplicateState, {
      kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: ['1', '新值'],
    } as any)).toThrow(/重复 row_id/i);
    expect(duplicateState).toEqual(duplicateBefore);
  });

  it('legacy 空身份 row_upsert 删除在目标缺失、坏表头或重复目标时 fail closed', () => {
    const cases = [
      { mutate: (state: any) => { state.sheet_0.content[0][0] = 'id'; }, error: /row_id 表头/i },
      { mutate: (state: any) => { state.sheet_0.content.push([' 1 ', '重复']); }, error: /重复 row_id/i },
    ];
    for (const { mutate, error } of cases) {
      const state = makeCheckpointData();
      mutate(state);
      const before = JSON.parse(JSON.stringify(state));
      expect(() => applyTablePatchV2_ACU(state, {
        kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: [null, '旧兼容删除'],
      } as any)).toThrow(error);
      expect(state).toEqual(before);
    }

    const missingTargetState = makeCheckpointData();
    const missingTargetBefore = JSON.parse(JSON.stringify(missingTargetState));
    expect(() => applyTablePatchV2_ACU(missingTargetState, {
      kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '404', cells: [null, '旧兼容删除'],
    } as any)).toThrow(/目标 row_id 不存在/i);
    expect(missingTargetState).toEqual(missingTargetBefore);

    const missingSheetState = makeCheckpointData();
    delete missingSheetState.sheet_0;
    const missingSheetBefore = JSON.parse(JSON.stringify(missingSheetState));
    expect(() => applyTablePatchV2_ACU(missingSheetState, {
      kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: [null, '旧兼容删除'],
    } as any)).toThrow(/删除目标 Sheet 缺失或 content 非法/i);
    expect(missingSheetState).toEqual(missingSheetBefore);

    const invalidContentState = makeCheckpointData();
    invalidContentState.sheet_0.content = null;
    const invalidContentBefore = JSON.parse(JSON.stringify(invalidContentState));
    expect(() => applyTablePatchV2_ACU(invalidContentState, {
      kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: [null, '旧兼容删除'],
    } as any)).toThrow(/删除目标 Sheet 缺失或 content 非法/i);
    expect(invalidContentState).toEqual(invalidContentBefore);

    const missingIdState = makeCheckpointData();
    const missingIdBefore = JSON.parse(JSON.stringify(missingIdState));
    expect(() => applyTablePatchV2_ACU(missingIdState, {
      kind: 'row_upsert', sheetKey: 'sheet_0', rowId: ' ', cells: [null, '旧兼容删除'],
    } as any)).toThrow(/缺少 row_id/i);
    expect(missingIdState).toEqual(missingIdBefore);
  });

  it('row_upsert 使用 canonical 身份更新现有行', () => {
    const state = makeCheckpointData();

    applyTablePatchV2_ACU(state, { kind: 'row_upsert', sheetKey: 'sheet_0', rowId: ' 1 ', cells: ['1', '钢剑'] } as any);

    expect(state.sheet_0.content).toEqual([['row_id', 'name'], ['1', '钢剑']]);
  });

  it('旧 patches 与 DSL 生成的非法 canonical 行在 replay 边界被清理或拒绝', async () => {
    const legacyPatchChat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: makeCheckpointData() },
            logEntries: [{
              seq: 1,
              entryId: 'legacy-empty-row',
              createdAt: 2,
              source: 'manual_crud',
              targetMessageIndex: 0,
              aiFloor: 1,
              filledSheetKeys: [],
              changedSheetKeys: ['sheet_0'],
              groupKeys: [],
              patches: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '1', cells: [null, '坏行'] }],
            }],
          },
        },
      },
    }];

    const legacyResult = await loadTableStateFromFramesV2_ACU(legacyPatchChat, '');
    expect(legacyResult?.sheet_0.content).toEqual([['row_id', 'name']]);

    const dslChat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: makeCheckpointData() },
            logEntries: [{
              seq: 1,
              entryId: 'dsl-insert',
              createdAt: 2,
              source: 'manual_crud',
              targetMessageIndex: 0,
              aiFloor: 1,
              filledSheetKeys: [],
              changedSheetKeys: ['sheet_0'],
              groupKeys: [],
              operations: [{ kind: 'table_edit_dsl', text: 'insertRow(0, {"0":"药水"})' }],
            }],
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(dslChat, '')).resolves.toMatchObject({
      sheet_0: expect.objectContaining({ content: [['row_id', 'name'], ['1', '铁剑'], ['2', '药水']] }),
    });
  });

  it('DSL 删除中间行后插入使用最小未占用 row_id，且保留 0 和 false', async () => {
    const checkpointData = makeCheckpointData();
    checkpointData.sheet_0.content = [
      ['row_id', 'name', 'enabled'],
      ['1', '铁剑', true],
      ['2', '药水', true],
      ['3', '盾牌', true],
    ];
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: checkpointData },
            logEntries: [{
              seq: 1, entryId: 'dsl-stable-row-id', createdAt: 2, source: 'manual_crud', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: [], changedSheetKeys: ['sheet_0'], groupKeys: [],
              operations: [{ kind: 'table_edit_dsl', text: 'deleteRow(0, 1) insertRow(0, {"0":0,"1":false})' }],
            }],
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).resolves.toMatchObject({
      sheet_0: expect.objectContaining({ content: [['row_id', 'name', 'enabled'], ['1', '铁剑', true], ['3', '盾牌', true], ['2', 0, false]] }),
    });
  });

  it('无 full checkpoint 时拒绝从 data_replace/log-only 恢复不完整数据', async () => {
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [{
                seq: 1,
                entryId: 'v2_import_data_replace',
                createdAt: 1,
                source: 'import',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_a', 'sheet_b'],
                changedSheetKeys: ['sheet_a', 'sheet_b'],
                groupKeys: [],
                operations: [{ kind: 'data_replace', data: makeDslCheckpointData(), reason: 'import' }],
              }],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('无锚点 V2 replay artifacts'));
  });

  it('bounded replay 范围早于首个 V2 frame 时返回空基底但不误报无锚点历史', async () => {
    const chat = [
      { is_user: false, mes: '早期普通 AI 消息' },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: { kind: 'full', createdAt: 2, reason: 'init', data: makeCheckpointData() },
              logEntries: [],
            },
          },
        },
      },
    ];

    await expect(loadTableStateFromFramesV2_ACU(chat, '', { maxMessageIndex: 0 })).resolves.toBeNull();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('只有空 V2 frame 且没有 full checkpoint 时返回空基底但不声称存在 log-only 数据', async () => {
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            logEntries: [],
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).resolves.toBeNull();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it.each([
    ['perSheetCheckpoints', { perSheetCheckpoints: { sheet_0: { kind: 'sheet_full' } } }],
    ['manualRefillProgress', { manualRefillProgress: { kind: 'manual_refill' } }],
    ['headRevision', { headRevision: 'orphan-revision' }],
    ['畸形 null perSheetCheckpoints', { perSheetCheckpoints: null }],
    ['畸形数组 perSheetCheckpoints', { perSheetCheckpoints: [] }],
    ['畸形数字 perSheetCheckpoints', { perSheetCheckpoints: 7 }],
    ['畸形 headRevision', { headRevision: 7 }],
  ])('无 full checkpoint 且仅存在 %s 时保守告警并返回空基底', async (_label, artifact) => {
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            logEntries: [],
            ...artifact,
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).resolves.toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('无锚点 V2 replay artifacts'));
  });

  it('空 perSheetCheckpoints 与空 headRevision 不构成无锚点 replay artifact', async () => {
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': { _acu_storage_version: 2, storageFrame: { version: 2, logEntries: [], perSheetCheckpoints: {}, headRevision: '' } },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).resolves.toBeNull();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('bounded replay 在 anchor 前只有 checkpoint_fallback、full 位于 anchor 后时拒绝越界恢复', async () => {
    const fallbackData = makeCheckpointData();
    fallbackData.sheet_0.content[1][1] = '降级快照';
    const laterFullData = makeCheckpointData();
    laterFullData.sheet_0.content[1][1] = '后方 full';
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [{
                seq: 1, entryId: 'checkpoint-fallback-before-anchor', createdAt: 1, source: 'system', targetMessageIndex: 0, aiFloor: 1,
                filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [],
                operations: [{ kind: 'data_replace', data: fallbackData, reason: 'checkpoint_fallback' }],
              }],
            },
          },
        },
      },
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: { kind: 'full', createdAt: 3, reason: 'compaction', data: laterFullData },
              logEntries: [],
            },
          },
        },
      },
    ];

    await expect(loadTableStateFromFramesV2_ACU(chat, '', { maxMessageIndex: 1 })).resolves.toBeNull();
    await expect(loadTableStateFromFramesV2_ACU(chat, '')).resolves.toMatchObject({
      sheet_0: expect.objectContaining({ content: [['row_id', 'name'], ['1', '后方 full']] }),
    });
  });

  it('按日志顺序混合回放旧 data_replace、新 sheet_replace 与 row_upsert', async () => {
    const checkpointData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        name: '表A',
        content: [['row_id', '值'], ['1', 'checkpoint-a']],
      },
      sheet_1: {
        name: '表B',
        content: [['row_id', '值'], ['1', 'checkpoint-b']],
      },
    } as any;
    const legacyDataReplace = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        name: '表A',
        content: [['row_id', '值'], ['1', 'legacy-a']],
      },
      sheet_1: {
        name: '表B',
        content: [['row_id', '值'], ['1', 'legacy-b']],
      },
    } as any;
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full',
              createdAt: 1,
              reason: 'init',
              data: checkpointData,
            },
            logEntries: [
              {
                seq: 1,
                entryId: 'legacy-data-replace',
                createdAt: 2,
                source: 'group_fill',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_0', 'sheet_1'],
                changedSheetKeys: ['sheet_0', 'sheet_1'],
                groupKeys: [],
                operations: [{ kind: 'data_replace', data: legacyDataReplace, reason: 'system' }],
              },
              {
                seq: 2,
                entryId: 'single-sheet-replace',
                createdAt: 3,
                source: 'group_fill',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_0'],
                changedSheetKeys: ['sheet_0'],
                groupKeys: [],
                operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_0', sheet: { name: '表A', content: [['row_id', '值'], ['1', 'sheet-replace-a']] }, reason: 'system' }],
              },
              {
                seq: 3,
                entryId: 'row-upsert-after-replace',
                createdAt: 4,
                source: 'group_fill',
                targetMessageIndex: 0,
                aiFloor: 1,
                filledSheetKeys: ['sheet_1'],
                changedSheetKeys: ['sheet_1'],
                groupKeys: [],
                operations: [{ kind: 'row_upsert', sheetKey: 'sheet_1', rowId: '2', cells: ['2', 'row-upsert-b'] }],
              },
            ],
          },
        },
      },
    }];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_0.content).toEqual([['row_id', '值'], ['1', 'sheet-replace-a']]);
    expect(result?.sheet_1.content).toEqual([['row_id', '值'], ['1', 'legacy-b'], ['2', 'row-upsert-b']]);
  });

  it('按跨 frame 时间线回放旧 SQL、单表 checkpoint、新 SQL 与后续替换操作', async () => {
    const rootData = {
      mate: { type: 'acu', version: 1 },
      sheet_inventory: {
        uid: 'inventory',
        name: '背包',
        content: [['row_id', 'name'], ['1', '铁剑']],
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT);' },
        updateConfig: {},
        exportConfig: {},
        orderNo: 0,
      },
      sheet_equipment: {
        uid: 'equipment',
        name: '装备',
        content: [['row_id', 'name'], ['1', '布甲']],
        sourceData: { ddl: 'CREATE TABLE equipment (row_id INTEGER PRIMARY KEY, name TEXT);' },
        updateConfig: {},
        exportConfig: {},
        orderNo: 1,
      },
    } as any;
    const shardData = {
      ...rootData.sheet_inventory,
      content: [['row_id', 'name'], ['1', '分片剑']],
    };
    const replacementData = {
      mate: { type: 'acu', version: 1 },
      sheet_inventory: {
        ...rootData.sheet_inventory,
        content: [['row_id', 'name'], ['1', '替换前剑']],
      },
      sheet_equipment: {
        ...rootData.sheet_equipment,
        content: [['row_id', 'name'], ['1', '替换后布甲']],
      },
    } as any;
    const entry = (seq: number, entryId: string, operations: any[]) => ({
      seq,
      entryId,
      createdAt: seq + 1,
      source: 'manual_crud',
      targetMessageIndex: 0,
      aiFloor: 1,
      filledSheetKeys: [],
      changedSheetKeys: [],
      groupKeys: [],
      operations,
    });
    const chat: any[] = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
              logEntries: [entry(1, 'legacy-cross-sheet-sql', [{
                kind: 'sql_batch',
                statements: [
                  "UPDATE inventory SET name = '旧 SQL 剑' WHERE row_id = 1",
                  "UPDATE equipment SET name = '旧 SQL 甲' WHERE row_id = 1",
                ],
              }])],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              perSheetCheckpoints: {
                sheet_inventory: {
                  kind: 'sheet_full',
                  createdAt: 3,
                  reason: 'manual',
                  sheetKey: 'sheet_inventory',
                  data: shardData,
                },
              },
              logEntries: [],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [entry(2, 'sheet-sql-after-shard', [{
                kind: 'sql_sheet_batch',
                sheetKey: 'sheet_inventory',
                tableName: 'inventory',
                statements: ["UPDATE inventory SET name = '分片后 SQL 剑' WHERE row_id = 1"],
                reason: 'manual',
              }])],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [entry(3, 'whole-state-replace', [{
                kind: 'data_replace',
                data: replacementData,
                reason: 'checkpoint_fallback',
              }])],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                entry(4, 'sheet-replace-after-data-replace', [{
                  kind: 'sheet_replace',
                  sheetKey: 'sheet_inventory',
                  sheet: {
                    ...rootData.sheet_inventory,
                    content: [['row_id', 'name'], ['1', 'sheet_replace 剑']],
                  },
                  reason: 'manual',
                }]),
                entry(5, 'row-upsert-after-sheet-replace', [{
                  kind: 'row_upsert',
                  sheetKey: 'sheet_inventory',
                  rowId: '1',
                  cells: ['1', '最终剑'],
                }]),
              ],
            },
          },
        },
      },
    ];

    const afterShardAndSql = await loadTableStateFromFramesV2_ACU(chat.slice(0, 3), '');
    expect(afterShardAndSql?.sheet_inventory.content).toEqual([['row_id', 'name'], ['1', '分片后 SQL 剑']]);
    expect(afterShardAndSql?.sheet_equipment.content).toEqual([['row_id', 'name'], ['1', '旧 SQL 甲']]);

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_inventory.content).toEqual([['row_id', 'name'], ['1', '最终剑']]);
    expect(result?.sheet_equipment.content).toEqual([['row_id', 'name'], ['1', '替换后布甲']]);
  });

  it('从 boundary compaction checkpoint 开始回放降级旧 full 的 data_replace 与后续日志', async () => {
    const boundaryData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        name: '物品表',
        content: [['row_id', '物品名'], ['1', '剑']],
      },
    } as any;
    const downgradedManualSnapshot = {
      mate: { type: 'acu', version: 1 },
      sheet_0: {
        name: '物品表',
        content: [['row_id', '物品名'], ['1', '盾']],
      },
    } as any;
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                createdAt: 1,
                reason: 'init',
                data: {
                  mate: { type: 'acu', version: 1 },
                  sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '旧剑']] },
                },
              },
              logEntries: [],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: {
                kind: 'full',
                createdAt: 2,
                reason: 'compaction',
                data: boundaryData,
              },
              logEntries: [],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              logEntries: [
                {
                  seq: 0,
                  entryId: 'downgraded-checkpoint-2',
                  createdAt: 3,
                  source: 'system',
                  targetMessageIndex: 2,
                  aiFloor: 3,
                  filledSheetKeys: ['sheet_0'],
                  changedSheetKeys: ['sheet_0'],
                  groupKeys: [],
                  operations: [{ kind: 'data_replace', data: downgradedManualSnapshot, reason: 'checkpoint_fallback' }],
                  writeSet: [{ kind: 'all' }],
                },
                {
                  seq: 1,
                  entryId: 'after-downgrade-update',
                  createdAt: 4,
                  source: 'auto_fill',
                  targetMessageIndex: 2,
                  aiFloor: 3,
                  filledSheetKeys: ['sheet_0'],
                  changedSheetKeys: ['sheet_0'],
                  groupKeys: [],
                  operations: [{ kind: 'row_upsert', sheetKey: 'sheet_0', rowId: '2', cells: ['2', '药水'] }],
                },
              ],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_0.content).toEqual([
      ['row_id', '物品名'],
      ['1', '盾'],
      ['2', '药水'],
    ]);
  });

  it('手动重填 retain=10/30 层后删除第 30 层时，可从第 29 层安全 full baseline 恢复纪要表', async () => {
    const staleBoundaryData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_summary: {
        name: '纪要表',
        content: [['row_id', '事件'], ['20', '边界旧事件']],
      },
    } as any;
    const fullRefillData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_summary: {
        name: '纪要表',
        content: [
          ['row_id', '事件'],
          ...Array.from({ length: 30 }, (_, index) => [`${index + 1}`, `第${index + 1}层事件`]),
        ],
      },
      sheet_outline: {
        name: '总体大纲',
        content: [
          ['row_id', '大纲'],
          ...Array.from({ length: 30 }, (_, index) => [`${index + 1}`, `第${index + 1}层大纲`]),
        ],
      },
    } as any;
    const chat = Array.from({ length: 30 }, (_, index) => ({ is_user: false } as any));
    chat[20].TavernDB_ACU_IsolatedData = {
      '': {
        _acu_storage_version: 2,
        storageFrame: {
          version: 2,
          checkpoint: {
            kind: 'full',
            createdAt: 20,
            reason: 'compaction',
            data: staleBoundaryData,
          },
          logEntries: [],
        },
      },
    };
    chat[28].TavernDB_ACU_IsolatedData = {
      '': {
        _acu_storage_version: 2,
        storageFrame: {
          version: 2,
          checkpoint: {
            kind: 'full',
            createdAt: 29,
            reason: 'manual',
            data: fullRefillData,
          },
          logEntries: [],
        },
      },
    };
    chat[29].TavernDB_ACU_IsolatedData = {
      '': {
        _acu_storage_version: 2,
        storageFrame: {
          version: 2,
          logEntries: [{
            seq: 1,
            entryId: 'manual-refill-progress-final',
            createdAt: 30,
            source: 'group_fill',
            targetMessageIndex: 29,
            aiFloor: 30,
            filledSheetKeys: ['sheet_summary', 'sheet_outline'],
            changedSheetKeys: ['sheet_summary', 'sheet_outline'],
            groupKeys: [],
            operations: [{ kind: 'data_replace', data: fullRefillData, reason: 'checkpoint_fallback' }],
          }],
        },
      },
    };
    chat.splice(29, 1);

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_summary.content).toHaveLength(31);
    expect(result?.sheet_summary.content[30]).toEqual(['30', '第30层事件']);
    expect(result?.sheet_outline.content[30]).toEqual(['30', '第30层大纲']);
  });

  it('跨第20层边界重填纪要表1-30后，重入从既有 full checkpoint 的单表快照恢复全部楼层且不污染非目标表', async () => {
    const boundaryData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_summary: {
        name: '纪要表',
        content: [['row_id', '事件'], ['20', '旧边界事件']],
      },
      sheet_outline: {
        name: '总体大纲',
        content: [['row_id', '大纲'], ['20', '保留的大纲']],
      },
    } as any;
    const refilledSummary = {
      name: '纪要表',
      content: [
        ['row_id', '事件'],
        ...Array.from({ length: 30 }, (_, index) => [`${index + 1}`, `重填第${index + 1}层事件`]),
      ],
    } as any;
    const chat = Array.from({ length: 30 }, () => ({ is_user: false } as any));
    chat[20].TavernDB_ACU_IsolatedData = {
      '': {
        _acu_storage_version: 2,
        storageFrame: {
          version: 2,
          checkpoint: {
            kind: 'full',
            createdAt: 20,
            reason: 'compaction',
            data: {
              ...boundaryData,
              sheet_summary: undefined,
            },
          },
          perSheetCheckpoints: {
            sheet_summary: {
              kind: 'sheet_full',
              createdAt: 30,
              reason: 'manual',
              sheetKey: 'sheet_summary',
              data: refilledSummary,
            },
          },
          logEntries: [],
        },
      },
    };

    expect(chat[20].TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_summary).toEqual(expect.objectContaining({ kind: 'sheet_full', data: refilledSummary }));
    expect(chat[29].TavernDB_ACU_IsolatedData).toBeUndefined();
    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_summary.content).toHaveLength(31);
    expect(result?.sheet_summary.content[1]).toEqual(['1', '重填第1层事件']);
    expect(result?.sheet_summary.content[30]).toEqual(['30', '重填第30层事件']);
    expect(result?.sheet_outline).toEqual(boundaryData.sheet_outline);
  });

  it('按消息时间线用单表 checkpoint 覆盖旧 full 中的目标表，同时保留根数据与非目标表', async () => {
    const rootData = makeDslCheckpointData();
    const rebuiltSummarySheet = {
      ...rootData.sheet_b,
      content: [['row_id', '时间跨度', '地点', '纪要', '概要'], ['20', '新 1-20 层纪要']],
    };
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
              logEntries: [],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              perSheetCheckpoints: {
                sheet_b: {
                  kind: 'sheet_full',
                  createdAt: 2,
                  reason: 'manual',
                  sheetKey: 'sheet_b',
                  data: rebuiltSummarySheet,
                },
              },
              logEntries: [],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.mate).toEqual(rootData.mate);
    expect(result?.sheet_a).toEqual(rootData.sheet_a);
    expect(result?.sheet_b).toEqual(rebuiltSummarySheet);
  });

  it('同一 frame 内先应用单表 checkpoint，再按 seq 回放该 frame 的日志', async () => {
    const rootData = makeDslCheckpointData();
    const rebuiltSummarySheet = {
      ...rootData.sheet_b,
      content: [['row_id', '时间跨度', '地点', '纪要', '概要'], ['20', '新 1-20 层纪要']],
    };
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
              logEntries: [],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              perSheetCheckpoints: {
                sheet_b: {
                  kind: 'sheet_full',
                  createdAt: 2,
                  reason: 'manual',
                  sheetKey: 'sheet_b',
                  data: rebuiltSummarySheet,
                },
              },
              logEntries: [{
                seq: 1,
                entryId: 'after-sheet-checkpoint',
                createdAt: 3,
                source: 'manual_fill',
                targetMessageIndex: 1,
                aiFloor: 2,
                filledSheetKeys: ['sheet_b'],
                changedSheetKeys: ['sheet_b'],
                groupKeys: [],
                operations: [{
                  kind: 'row_upsert',
                  sheetKey: 'sheet_b',
                  rowId: '21',
                  cells: ['21', '21-30', '新地点', '新第21层纪要', '新概要'],
                }],
              }],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_b.content).toEqual([
      ['row_id', '时间跨度', '地点', '纪要', '概要'],
      ['20', '新 1-20 层纪要'],
      ['21', '21-30', '新地点', '新第21层纪要', '新概要'],
    ]);
  });

  it('同一 frame 内 data_replace 会整体替换先应用的单表 checkpoint', async () => {
    const rootData = makeDslCheckpointData();
    const shardData = {
      ...rootData.sheet_b,
      content: [['row_id', '时间跨度', '地点', '纪要', '概要'], ['20', '分片纪要']],
    };
    const replacementData = {
      mate: { type: 'acu', version: 2 },
      sheet_a: {
        ...rootData.sheet_a,
        content: [['row_id', '地点'], ['1', '全量替换地点']],
      },
      sheet_b: {
        ...rootData.sheet_b,
        content: [['row_id', '时间跨度', '地点', '纪要', '概要'], ['20', '全量替换纪要']],
      },
    } as any;
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
              logEntries: [],
            },
          },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              perSheetCheckpoints: {
                sheet_b: {
                  kind: 'sheet_full',
                  createdAt: 2,
                  reason: 'manual',
                  sheetKey: 'sheet_b',
                  data: shardData,
                },
              },
              logEntries: [{
                seq: 1,
                entryId: 'same-frame-whole-state-replace',
                createdAt: 3,
                source: 'manual_fill',
                targetMessageIndex: 1,
                aiFloor: 2,
                filledSheetKeys: ['sheet_a', 'sheet_b'],
                changedSheetKeys: ['sheet_a', 'sheet_b'],
                groupKeys: [],
                operations: [{
                  kind: 'data_replace',
                  data: replacementData,
                  reason: 'checkpoint_fallback',
                }],
              }],
            },
          },
        },
      },
    ];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_b.content).toEqual([
      ['row_id', '时间跨度', '地点', '纪要', '概要'],
      ['20', '全量替换纪要'],
    ]);
    expect(result?.sheet_a.content).toEqual([
      ['row_id', '地点'],
      ['1', '全量替换地点'],
    ]);
    expect(result?.sheet_b.content.flat()).not.toContain('分片纪要');
  });

  it('只有单表 checkpoint 而没有整库 full 时拒绝恢复', async () => {
    const rootData = makeDslCheckpointData();
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            perSheetCheckpoints: {
              sheet_b: {
                kind: 'sheet_full',
                createdAt: 1,
                reason: 'manual',
                sheetKey: 'sheet_b',
                data: rootData.sheet_b,
              },
            },
            logEntries: [],
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).resolves.toBeNull();
  });


  it('introduction shard 在 afterSeq 后激活，使同 frame 的旧 data_replace 不会删除新增表', async () => {
    const rootData = makeDslCheckpointData();
    const introducedSheet = {
      uid: 'new_sheet', name: '新增表', content: [['row_id', '值']], sourceData: {}, updateConfig: {}, exportConfig: {}, orderNo: 2,
    } as any;
    const replacementData = {
      ...rootData,
      sheet_a: { ...rootData.sheet_a, content: [['row_id', '地点'], ['1', '已替换']] },
    } as any;
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
            perSheetCheckpoints: {
              sheet_new: {
                kind: 'sheet_full', createdAt: 2, reason: 'schema_change', sheetKey: 'sheet_new', data: introducedSheet,
                timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 1 },
              },
            },
            logEntries: [{
              seq: 1, entryId: 'replace-before-introduction', createdAt: 2, source: 'system', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: [], changedSheetKeys: [], groupKeys: [],
              operations: [{ kind: 'data_replace', data: replacementData, reason: 'system' }],
            }],
          },
        },
      },
    }];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_a.content[1]).toEqual(['1', '已替换']);
    expect(result?.sheet_new).toEqual(introducedSheet);
  });

  it('introduction shard 在激活后仍允许后续 data_replace 保持全局覆盖语义', async () => {
    const rootData = makeDslCheckpointData();
    const introducedSheet = {
      uid: 'new_sheet', name: '新增表', content: [['row_id', '值']], sourceData: {}, updateConfig: {}, exportConfig: {}, orderNo: 2,
    } as any;
    const replacementData = { ...rootData, sheet_new: { ...introducedSheet, content: [['row_id', '值'], ['1', '覆盖值']] } } as any;
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
            perSheetCheckpoints: {
              sheet_new: {
                kind: 'sheet_full', createdAt: 2, reason: 'schema_change', sheetKey: 'sheet_new', data: introducedSheet,
                timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 0 },
              },
            },
            logEntries: [{
              seq: 1, entryId: 'replace-after-introduction', createdAt: 2, source: 'system', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: [], changedSheetKeys: [], groupKeys: [],
              operations: [{ kind: 'data_replace', data: replacementData, reason: 'system' }],
            }],
          },
        },
      },
    }];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_new.content).toEqual([['row_id', '值'], ['1', '覆盖值']]);
  });

  it('introduction 在空日志帧结束后同步应用自身 tracking event 与 schedule summary', async () => {
    const previousIndependentStates = independentTableStates_ACU;
    _set_independentTableStates_ACU({});
    const rootData = makeDslCheckpointData();
    const introducedSheet = {
      uid: 'new_sheet', name: '新增表', content: [['row_id', '值']], sourceData: {}, updateConfig: {}, exportConfig: {}, orderNo: 2,
    } as any;
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
            perSheetCheckpoints: {
              sheet_new: {
                kind: 'sheet_full', createdAt: 2, reason: 'schema_change', sheetKey: 'sheet_new', data: introducedSheet,
                timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 0 },
                event: { filledSheetKeys: ['sheet_new'], changedSheetKeys: ['sheet_new'], groupKeys: [] },
              },
            },
            logEntries: [],
          },
        },
      },
    }];

    try {
      const result = await loadTableStateFromFramesV2_ACU(chat, '');
      const summary = collectScheduleSummaryFromFramesV2_ACU(chat, '');

      expect(result?.sheet_new).toEqual(introducedSheet);
      expect(independentTableStates_ACU.sheet_new?.lastUpdatedAiFloor).toBe(1);
      expect(summary.sheet_new).toEqual({ lastFilledAiFloor: 1, lastChangedAiFloor: 1 });
    } finally {
      _set_independentTableStates_ACU(previousIndependentStates);
    }
  });

  it('多个 introduction 按 afterSeq 在 entry 之间激活，且不改变 data_replace 的全局语义', async () => {
    const rootData = makeDslCheckpointData();
    const sheetEarly = { uid: 'early', name: '早表', content: [['row_id', '值']], sourceData: {}, updateConfig: {}, exportConfig: {}, orderNo: 2 } as any;
    const sheetLate = { uid: 'late', name: '晚表', content: [['row_id', '值']], sourceData: {}, updateConfig: {}, exportConfig: {}, orderNo: 3 } as any;
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
            perSheetCheckpoints: {
              sheet_early: { kind: 'sheet_full', createdAt: 2, reason: 'schema_change', sheetKey: 'sheet_early', data: sheetEarly, timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 0 } },
              sheet_late: { kind: 'sheet_full', createdAt: 3, reason: 'schema_change', sheetKey: 'sheet_late', data: sheetLate, timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 2 } },
            },
            logEntries: [
              { seq: 1, entryId: 'replace-before-late', createdAt: 2, source: 'system', targetMessageIndex: 0, aiFloor: 1, filledSheetKeys: [], changedSheetKeys: [], groupKeys: [], operations: [{ kind: 'data_replace', data: { ...rootData, sheet_early: sheetEarly }, reason: 'system' }] },
              { seq: 3, entryId: 'replace-after-late', createdAt: 3, source: 'system', targetMessageIndex: 0, aiFloor: 1, filledSheetKeys: [], changedSheetKeys: [], groupKeys: [], operations: [{ kind: 'data_replace', data: { ...rootData, sheet_early: sheetEarly, sheet_late: { ...sheetLate, content: [['row_id', '值'], ['1', '已覆盖']] } }, reason: 'system' }] },
            ],
          },
        },
      },
    }];

    const result = await loadTableStateFromFramesV2_ACU(chat, '');

    expect(result?.sheet_early).toEqual(sheetEarly);
    expect(result?.sheet_late.content).toEqual([['row_id', '值'], ['1', '已覆盖']]);
  });

  it.each([
    { label: 'duplicate', entries: [{ seq: 1 }, { seq: 1 }], message: '唯一且严格递增' },
    { label: 'out-of-order', entries: [{ seq: 2 }, { seq: 1 }], message: '唯一且严格递增' },
    { label: 'invalid', entries: [{ seq: -1 }], message: '非法 seq' },
  ])('拒绝 $label frame seq，且 schedule summary 使用同一校验', async ({ entries, message }) => {
    const rootData = makeCheckpointData();
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
            logEntries: entries.map((entry, index) => ({
              ...entry, entryId: `bad-${index}`, createdAt: index + 1, source: 'system', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: [], changedSheetKeys: [], groupKeys: [], operations: [],
            })),
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).rejects.toThrow(message);
    expect(() => collectScheduleSummaryFromFramesV2_ACU(chat, '')).toThrow(message);
  });

  it('introduction messageIndex 损坏时，replay 与 schedule summary 同时拒绝', async () => {
    const rootData = makeCheckpointData();
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: rootData },
            perSheetCheckpoints: {
              sheet_new: {
                kind: 'sheet_full', createdAt: 2, reason: 'schema_change', sheetKey: 'sheet_new', data: rootData.sheet_0,
                timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 1, afterSeq: 0 },
              },
            },
            logEntries: [],
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).rejects.toThrow('introduction shard messageIndex 不匹配');
    expect(() => collectScheduleSummaryFromFramesV2_ACU(chat, '')).toThrow('introduction shard messageIndex 不匹配');
  });

  it('首个 schema operation 即使没有前置 SQL 也必须执行真实 SQLite hydrate', async () => {
    const before = makeCheckpointData().sheet_0;
    const validAfter = {
      ...before,
      content: [['row_id', 'name', 'marker'], ['1', '铁剑', null]],
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT, marker TEXT);' },
    };
    const operation = await buildSheetSchemaMigrationOperation_ACU('sheet_0', before, validAfter);
    const checkpointData = makeCheckpointData();
    checkpointData.sheet_other = {
      uid: 'other', name: '损坏表', orderNo: 1,
      content: [['row_id', 'value'], ['1', null]],
      sourceData: { ddl: 'CREATE TABLE other_table (row_id INTEGER PRIMARY KEY, value TEXT CHECK (value IS NOT NULL));' },
      updateConfig: {}, exportConfig: {},
    };
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: checkpointData },
            logEntries: [{
              seq: 1, entryId: 'schema-without-sql', createdAt: 2, source: 'system', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: [], changedSheetKeys: [], groupKeys: [], operations: [operation],
            }],
          },
        },
      },
    }];

    await expect(loadTableStateFromFramesV2_ACU(chat, '')).rejects.toThrow('SQLite');
    expect(checkpointData.sheet_0.content).toEqual([['row_id', 'name'], ['1', '铁剑']]);
  });

  it('已加载 runtime 导出后 schema contract 失败仍不提交 exported state', async () => {
    const state = makeCheckpointData();
    const original = structuredClone(state);
    const exported = structuredClone(state);
    exported.sheet_0.content[1][1] = '运行时新值';
    const loadedRuntime = {
      loaded: true,
      engine: { dispose: () => undefined },
      syncBridge: {
        exportToTableData: () => exported,
        loadFromTableData: () => undefined,
      },
    };
    const invalidOperation = {
      kind: 'sheet_schema_migrate', contractVersion: 0, sheetKey: 'sheet_0',
    };

    await expect(applyTableOperationV2_ACU(state, invalidOperation as any, loadedRuntime as any)).rejects.toThrow('contractVersion');
    expect(state).toEqual(original);
    expect(loadedRuntime.loaded).toBe(true);
  });

  it('legacy meta_update 携带 sourceData.ddl 时明确拒绝，并且不推进 entry tracking 或提交 state', async () => {
    const previousIndependentStates = independentTableStates_ACU;
    _set_independentTableStates_ACU({});
    const checkpointData = makeCheckpointData();
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: checkpointData },
            logEntries: [{
              seq: 1, entryId: 'legacy-meta-ddl', createdAt: 2, source: 'system', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [],
              operations: [{
                kind: 'meta_update', sheetKey: 'sheet_0',
                meta: { sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT, unsafe TEXT);' } },
              }],
            }],
          },
        },
      },
    }];

    try {
      await expect(loadTableStateFromFramesV2_ACU(chat, '')).rejects.toThrow('迁移为 sheet_schema_migrate 或 sheet_replace');
      expect(checkpointData.sheet_0.sourceData.ddl).toBe('CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT);');
      expect(independentTableStates_ACU.sheet_0).toBeUndefined();
    } finally {
      _set_independentTableStates_ACU(previousIndependentStates);
    }
  });

  it('已加载 runtime 下 legacy meta_update DDL 被拒绝前不导出或提交 runtime state', async () => {
    const state = makeCheckpointData();
    const original = structuredClone(state);
    const exported = structuredClone(state);
    exported.sheet_0.content[1][1] = '运行时未提交值';
    const loadedRuntime = {
      loaded: true,
      engine: { dispose: () => undefined },
      syncBridge: {
        exportToTableData: () => exported,
        loadFromTableData: () => undefined,
      },
    };

    await expect(applyTableOperationV2_ACU(state, {
      kind: 'meta_update', sheetKey: 'sheet_0',
      meta: { sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT, unsafe TEXT);' } },
    } as any, loadedRuntime as any)).rejects.toThrow('迁移为 sheet_schema_migrate 或 sheet_replace');

    expect(state).toEqual(original);
    expect(loadedRuntime.loaded).toBe(true);
  });

  it('不含 DDL 的 meta_update 继续合并非结构 sourceData', async () => {
    const state = makeCheckpointData();

    await applyTableOperationV2_ACU(state, {
      kind: 'meta_update', sheetKey: 'sheet_0', meta: { sourceData: { provider: 'legacy' } },
    } as any);

    expect(state.sheet_0.sourceData).toEqual({
      ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT);',
      provider: 'legacy',
    });
  });

  it('同一 frame 按 introduction 后 migration 再 meta_update 的顺序恢复最终持久化状态', async () => {
    const checkpointData = makeCheckpointData();
    const before = checkpointData.sheet_0;
    const migrated = {
      ...before,
      content: [['row_id', 'name', 'marker'], ['1', '铁剑', null]],
      sourceData: { ...before.sourceData, ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT, marker TEXT);' },
    };
    const migration = await buildSheetSchemaMigrationOperation_ACU('sheet_0', before, migrated);
    const introducedSheet = {
      uid: 'introduced', name: '新增表', orderNo: 2,
      content: [['row_id', 'value']],
      sourceData: { ddl: 'CREATE TABLE introduced (row_id INTEGER PRIMARY KEY, value TEXT);' },
      updateConfig: {}, exportConfig: {},
    };
    const chat = [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: checkpointData },
            perSheetCheckpoints: {
              sheet_new: {
                kind: 'sheet_full', createdAt: 2, reason: 'schema_change', sheetKey: 'sheet_new', data: introducedSheet,
                timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 7 },
              },
            },
            logEntries: [{
              seq: 8, entryId: 'template-migration-meta', createdAt: 3, source: 'template_assistant', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: [], changedSheetKeys: ['sheet_0'], groupKeys: [],
              operations: [
                migration,
                {
                  kind: 'meta_update', sheetKey: 'sheet_0',
                  meta: {
                    name: '新背包', orderNo: 4,
                    sourceData: { provider: 'template' },
                    updateConfig: { mode: 'manual' },
                    exportConfig: { enabled: true },
                  },
                },
              ],
            }],
          },
        },
      },
    }];

    const replayed = await loadTableStateFromFramesV2_ACU(chat, '', { updateRuntimeState: false });

    expect(replayed?.sheet_new).toEqual(introducedSheet);
    expect(replayed?.sheet_0).toEqual({
      ...migrated,
      name: '新背包', orderNo: 4,
      sourceData: { ...migrated.sourceData, provider: 'template' },
      updateConfig: { mode: 'manual' },
      exportConfig: { enabled: true },
    });
    expect(replayed?.sheet_0.content[1][2]).toBeNull();
  });

  it('未知或畸形 operation fail closed，且不返回伪成功 state', async () => {
    const previousIndependentStates = independentTableStates_ACU;
    _set_independentTableStates_ACU({});
    const checkpointData = makeCheckpointData();
    const makeChat = (operation: any) => [{
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: checkpointData },
            logEntries: [{
              seq: 1, entryId: 'invalid-operation', createdAt: 2, source: 'system', targetMessageIndex: 0, aiFloor: 1,
              filledSheetKeys: ['sheet_0'], changedSheetKeys: ['sheet_0'], groupKeys: [], operations: [operation],
            }],
          },
        },
      },
    }];

    try {
      await expect(loadTableStateFromFramesV2_ACU(makeChat({ kind: 'future_unknown_operation' }), '')).rejects.toThrow('不支持的 operation kind');
      await expect(loadTableStateFromFramesV2_ACU(makeChat(null), '')).rejects.toThrow('缺少有效 kind');
      await expect(loadTableStateFromFramesV2_ACU(makeChat({}), '')).rejects.toThrow('缺少有效 kind');
      expect(checkpointData.sheet_0.content).toEqual([['row_id', 'name'], ['1', '铁剑']]);
      expect(independentTableStates_ACU.sheet_0).toBeUndefined();
    } finally {
      _set_independentTableStates_ACU(previousIndependentStates);
    }
  });

});
