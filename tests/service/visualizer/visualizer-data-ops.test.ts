import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: [{ is_user: false }] as any[],
  data: null as any,
  replayData: null as any,
  sqlite: false,
  migration: vi.fn(async () => ({ success: true, migrated: false })),
  persist: vi.fn(async () => ({ saved: true, messageIndices: [0] })),
  replay: vi.fn(async () => ({ baseKind: 'full_checkpoint', data: mocks.replayData })),
  reload: vi.fn(async () => undefined),
  transaction: vi.fn(async (options: any, task: any) => task({
    baseRevision: 'test-revision',
    writeSet: options.writeSet,
    assertFresh: vi.fn(),
    runCommit: async (commitTask: any) => commitTask(),
  }, JSON.parse(JSON.stringify(options.initialData)))),
  fullCheckpoint: vi.fn(() => 0),
  sheetReplay: vi.fn(() => -1),
  setCurrentData: vi.fn((data: any) => { mocks.data = data; }),
}));

vi.mock('../../../src/service/chat/chat-service', () => ({ getChatArray_ACU: () => mocks.chat }));
vi.mock('../../../src/service/runtime/state-manager', () => ({
  get currentJsonTableData_ACU() { return mocks.data; },
  getCurrentIsolationKey_ACU: () => 'iso-test',
  _set_currentJsonTableData_ACU: mocks.setCurrentData,
}));
vi.mock('../../../src/service/table/table-history', () => ({
  getLatestV2FullCheckpointMessageIndex_ACU: mocks.fullCheckpoint,
  getLatestV2SheetReplayMessageIndex_ACU: mocks.sheetReplay,
}));
vi.mock('../../../src/service/table/table-service', () => ({ ensureLegacyStorageMigratedBeforeWrite_ACU: mocks.migration }));
vi.mock('../../../src/service/table/storage-frame-v2-persist', () => ({ persistTableMutationLogBatchV2_ACU: mocks.persist }));
vi.mock('../../../src/service/table/storage-frame-v2-replay', () => ({ loadTableStateFromFramesV2Detailed_ACU: mocks.replay }));
vi.mock('../../../src/service/table/table-storage-strategy', () => ({ reloadStorageProvider: mocks.reload }));
vi.mock('../../../src/service/table/table-write-transaction', () => ({ runTableWriteTransaction_ACU: mocks.transaction }));
vi.mock('../../../src/service/table/storage-mode', () => ({ isSqliteMode: () => mocks.sqlite }));

import {
  applyVisualizerPendingDataOps_ACU,
  assertVisualizerDataOpsEditable_ACU,
  recordVisualizerCellUpdate_ACU,
  recordVisualizerRowDelete_ACU,
  recordVisualizerRowInsert_ACU,
  replaceVisualizerTemporaryRowIds_ACU,
} from '../../../src/service/visualizer/visualizer-data-ops';

function data() {
  return {
    mate: { type: 'chatSheets', version: 1 },
    sheet_a: { name: 'A', content: [['row_id', 'value'], ['1', 'old-a']] },
    sheet_b: { name: 'B', content: [['row_id', 'value'], ['1', 'old-b']] },
  };
}

function state() {
  return { tempData: JSON.parse(JSON.stringify(mocks.data)), pendingDataOps: null, isSaving: false };
}

describe('visualizer-data-ops V2 replay save', () => {
  beforeEach(() => {
    mocks.data = data();
    mocks.replayData = data();
    mocks.sqlite = false;
    mocks.migration.mockReset().mockResolvedValue({ success: true, migrated: false });
    mocks.persist.mockReset().mockImplementation(async (options: any) => {
      mocks.replayData = options.afterData;
      return { saved: true, messageIndices: [0] };
    });
    mocks.replay.mockReset().mockImplementation(async () => ({ baseKind: 'full_checkpoint', data: JSON.parse(JSON.stringify(mocks.replayData)) }));
    mocks.reload.mockReset().mockResolvedValue(undefined);
    mocks.transaction.mockClear();
    mocks.fullCheckpoint.mockReset().mockReturnValue(0);
    mocks.sheetReplay.mockReset().mockReturnValue(-1);
    mocks.setCurrentData.mockClear();
  });

  it('只生成 V2 row operation，并按每张表的 replay layer 路由', async () => {
    const draft = state();
    draft.tempData.sheet_b.content.push(['__acu_vis_tmp_row_x', 'new-b']);
    recordVisualizerCellUpdate_ACU(draft, 'sheet_a', '1', 'value', 'new-a');
    recordVisualizerRowDelete_ACU(draft, 'sheet_b', '1');
    recordVisualizerRowInsert_ACU(draft, 'sheet_b', '__acu_vis_tmp_row_x');
    mocks.sheetReplay.mockImplementation((_chat: any, _iso: string, sheetKey: string) => sheetKey === 'sheet_b' ? 3 : -1);

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result).toEqual({ success: true, changed: true, insertedRowIds: { __acu_vis_tmp_row_x: '2' } });
    // First load is the write base; second is post-save runtime refresh.
    expect(mocks.replay).toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.objectContaining({ reason: 'visualizer_save_v2_replay' }), expect.any(Function));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    const persistOptions = mocks.persist.mock.calls[0][0];
    expect(persistOptions.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetMessageIndex: 0, changedSheetKeys: ['sheet_a'], operations: [expect.objectContaining({ kind: 'row_upsert', rowId: '1', cells: ['1', 'new-a'] })] }),
      expect.objectContaining({ targetMessageIndex: 3, changedSheetKeys: ['sheet_b'], operations: expect.arrayContaining([
        expect.objectContaining({ kind: 'row_delete', rowId: '1' }),
        expect.objectContaining({ kind: 'row_upsert', rowId: '2', cells: ['2', 'new-b'] }),
      ]) }),
    ]));
    expect(JSON.stringify(persistOptions.targets)).not.toContain('sql_batch');
  });

  it('新增行使用每表最大稳定身份加一，不复用删除后的空洞', async () => {
    mocks.data.sheet_a.content = [['row_id', 'value'], ['1', 'old-a'], ['3', 'old-c']];
    mocks.replayData = JSON.parse(JSON.stringify(mocks.data));
    const draft = state();
    draft.tempData.sheet_a.content.push(['__acu_vis_tmp_row_x', 'new-a']);
    recordVisualizerRowInsert_ACU(draft, 'sheet_a', '__acu_vis_tmp_row_x');

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result).toEqual({ success: true, changed: true, insertedRowIds: { __acu_vis_tmp_row_x: '4' } });
    expect(mocks.persist.mock.calls[0][0].afterData.sheet_a.content).toEqual([
      ['row_id', 'value'], ['1', 'old-a'], ['3', 'old-c'], ['4', 'new-a'],
    ]);
  });

  it('同一批次向同一表插入多行时连续保留稳定身份', async () => {
    mocks.data.sheet_a.content = [['row_id', 'value'], ['1', 'old-a'], ['3', 'old-c']];
    mocks.replayData = JSON.parse(JSON.stringify(mocks.data));
    const draft = state();
    draft.tempData.sheet_a.content.push(['__acu_vis_tmp_row_x', 'new-a'], ['__acu_vis_tmp_row_y', 'new-b']);
    recordVisualizerRowInsert_ACU(draft, 'sheet_a', '__acu_vis_tmp_row_x');
    recordVisualizerRowInsert_ACU(draft, 'sheet_a', '__acu_vis_tmp_row_y');

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result).toEqual({ success: true, changed: true, insertedRowIds: { __acu_vis_tmp_row_x: '4', __acu_vis_tmp_row_y: '5' } });
    expect(mocks.persist.mock.calls[0][0].afterData.sheet_a.content).toEqual([
      ['row_id', 'value'], ['1', 'old-a'], ['3', 'old-c'], ['4', 'new-a'], ['5', 'new-b'],
    ]);
  });

  it('稳定身份达到安全整数上限时拒绝新增而不持久化', async () => {
    mocks.data.sheet_a.content = [['row_id', 'value'], [String(Number.MAX_SAFE_INTEGER), 'limit']];
    mocks.replayData = JSON.parse(JSON.stringify(mocks.data));
    const draft = state();
    draft.tempData.sheet_a.content.push(['__acu_vis_tmp_row_x', 'new-a']);
    recordVisualizerRowInsert_ACU(draft, 'sheet_a', '__acu_vis_tmp_row_x');

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result).toEqual({ success: false, changed: false, error: expect.stringContaining('正安全整数上限') });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('以 V2 replay 为 afterData 基底，忽略 runtime seedRows 漂移，并把 update cells 回写为持久化形态', async () => {
    mocks.data = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        name: 'A',
        orderNo: 0,
        content: [['row_id', 'value'], ['1', 'old-a']],
        seedRows: [['1', 'seed']],
      },
    };
    mocks.replayData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        name: 'A',
        orderNo: 0,
        content: [['row_id', 'value'], ['1', 'old-a']],
      },
    };
    const draft = state();
    recordVisualizerCellUpdate_ACU(draft, 'sheet_a', '1', 'value', 'new-a');

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result.success).toBe(true);
    const persistOptions = mocks.persist.mock.calls[0][0];
    expect(persistOptions.afterData.sheet_a.content).toEqual([['row_id', 'value'], ['1', 'new-a']]);
    expect(persistOptions.afterData.sheet_a.seedRows).toBeUndefined();
    expect(persistOptions.targets[0].operations[0].cells).toEqual(['1', 'new-a']);
  });

  it('V2 replay 仍依赖临时 Sheet 补锚时阻止保存且不启动事务', async () => {
    const draft = state();
    recordVisualizerCellUpdate_ACU(draft, 'sheet_a', '1', 'value', 'new-a');
    mocks.replay.mockResolvedValueOnce({
      baseKind: 'full_checkpoint',
      data: data(),
      requiresCheckpointConvergence: true,
      compatibilityRepairs: [{
        kind: 'temporary_sheet_anchor',
        sheetKey: 'sheet_a',
        messageIndex: 384,
        seq: 1,
        operationIndex: 0,
        templateFingerprint: 'test-fingerprint',
        reason: 'missing_at_operation',
      }],
    });

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result).toEqual({ success: false, changed: false, error: expect.stringContaining('恢复收敛') });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setCurrentData).not.toHaveBeenCalled();
    expect(draft.pendingDataOps.committed).toBeUndefined();
  });

  it('candidate replay 校验失败时不刷新、不标记 committed', async () => {
    const draft = state();
    recordVisualizerCellUpdate_ACU(draft, 'sheet_a', '1', 'value', 'new-a');
    mocks.persist.mockResolvedValueOnce({ saved: false, error: 'candidate mismatch' });

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result).toEqual({ success: false, changed: false, error: 'candidate mismatch' });
    // Base load may call replay once; post-save runtime refresh must not run on failure.
    expect(mocks.setCurrentData).not.toHaveBeenCalled();
    expect(draft.pendingDataOps.committed).toBeUndefined();
  });

  it('迁移失败时不启动事务或追加 V2 operation log', async () => {
    const draft = state();
    recordVisualizerCellUpdate_ACU(draft, 'sheet_a', '1', 'value', 'new-a');
    mocks.migration.mockResolvedValueOnce({ success: false, error: 'mixed storage evidence insufficient' });

    const result = await applyVisualizerPendingDataOps_ACU(draft);

    expect(result).toEqual({ success: false, changed: false, error: 'mixed storage evidence insufficient' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setCurrentData).not.toHaveBeenCalled();
    expect(draft.pendingDataOps.committed).toBeUndefined();
  });


  it('持久化成功但 replay 刷新失败时仅重试刷新，不重复追加 operation log', async () => {
    const draft = state();
    recordVisualizerCellUpdate_ACU(draft, 'sheet_a', '1', 'value', 'new-a');
    mocks.replay
      .mockImplementationOnce(async () => ({ baseKind: 'full_checkpoint', data: JSON.parse(JSON.stringify(data())) }))
      .mockRejectedValueOnce(new Error('reload replay failed'));

    const first = await applyVisualizerPendingDataOps_ACU(draft);

    expect(first).toEqual({ success: false, changed: false, error: '数据已持久化，但本地运行时刷新失败：reload replay failed' });
    expect(draft.pendingDataOps.committed).toEqual(expect.objectContaining({
      afterData: expect.objectContaining({ sheet_a: expect.any(Object) }),
    }));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(() => assertVisualizerDataOpsEditable_ACU(draft)).toThrow('数据已持久化但本地刷新尚未完成');

    mocks.replay.mockResolvedValueOnce({ baseKind: 'full_checkpoint', data: draft.pendingDataOps.committed.afterData });
    const second = await applyVisualizerPendingDataOps_ACU(draft);

    expect(second).toEqual({ success: true, changed: true });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('仅回填匹配的临时行 ID，跨表与未匹配临时行保持正确状态', () => {
    const draft = {
      tempData: {
        sheet_a: { content: [['row_id'], ['__acu_vis_tmp_row_a'], ['__acu_vis_tmp_row_unmatched']] },
        sheet_b: { content: [['row_id'], ['__acu_vis_tmp_row_b']] },
      },
    };

    replaceVisualizerTemporaryRowIds_ACU(draft, {
      __acu_vis_tmp_row_a: '11',
      __acu_vis_tmp_row_b: '12',
    });

    expect(draft.tempData.sheet_a.content).toEqual([['row_id'], ['11'], ['__acu_vis_tmp_row_unmatched']]);
    expect(draft.tempData.sheet_b.content).toEqual([['row_id'], ['12']]);
  });
});