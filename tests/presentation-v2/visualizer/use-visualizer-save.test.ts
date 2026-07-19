/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const runtimeMock = vi.hoisted(() => {
  let currentData: Record<string, any> = {};
  return {
    get currentJsonTableData_ACU() {
      return currentData;
    },
    getCurrentData: () => currentData,
    resetCurrentData: () => {
      currentData = {};
    },
    _set_currentJsonTableData_ACU: vi.fn((next: Record<string, any>) => {
      currentData = next;
    }),
    getCurrentIsolationKey_ACU: vi.fn(() => 'iso-test'),
    settings_ACU: {},
  };
});

const serviceMock = vi.hoisted(() => ({
  deleteLocalDataInChatCore_ACU: vi.fn(async () => 1),
  getChatArray_ACU: vi.fn(() => [{ mes: 'ai message' }]),
  saveChatToHost_ACU: vi.fn(async () => undefined),
  applySpecialIndexSequenceToSummaryTables_ACU: vi.fn(),
  applySummaryIndexSequenceToTable_ACU: vi.fn(),
  getTableLocksForSheet_ACU: vi.fn(() => ({ rows: new Set<number>(), cols: new Set<number>(), cells: new Set<string>() })),
  deleteTableLocksForSheet_ACU: vi.fn(),
  getSummaryIndexColumnIndex_ACU: vi.fn(() => -1),
  saveTableLocksForSheet_ACU: vi.fn(),
  setSpecialIndexLockEnabled_ACU: vi.fn(),
  getCurrentWorldbookConfig_ACU: vi.fn(() => ({ summaryVectorIndexModeEnabled: false })),
  saveIndependentTableToChatHistory_ACU: vi.fn(async () => undefined),
  runTableUpdateCommit_ACU: vi.fn(async (options: any, apply: any) => {
    const workingData = options.initialData ? JSON.parse(JSON.stringify(options.initialData)) : runtimeMock.getCurrentData();
    const applied = await apply({ transactionContext: { runCommit: async (task: any) => task() }, workingData });
    if (applied.tableData) runtimeMock._set_currentJsonTableData_ACU(applied.tableData);
    return { success: applied.success !== false, value: applied.value, tableData: applied.tableData, saved: true };
  }),
  getLatestAiMessageIndexFromChat_ACU: vi.fn(() => 0),
  getLatestTableAppendMessageIndexFromChat_ACU: vi.fn(() => 0),
  resolveTableHistoryStateFromChat_ACU: vi.fn(() => ({
    latestDataMessageIndex: -1,
    latestAiMessageIndex: 0,
    latestDataAiFloor: 0,
  })),
  isSqliteMode: vi.fn(() => false),
  ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU: vi.fn(async () => ({ success: true, dataWasReset: false })),
  commitCurrentFloorTemplateChanges_ACU: vi.fn(async () => ({ saved: true, mode: 'template_only', messageIndex: 0, checkpoints: [], removedNullRowCount: 0 })),
  reloadStorageProvider: vi.fn(async () => undefined),
  applyTemplateScopeForCurrentChat_ACU: vi.fn(() => ({ mode: 'chat_override' })),
  buildChatSheetGuideDataFromData_ACU: vi.fn((data: Record<string, any>) => data),
  getChatSheetGuideDataForIsolationKey_ACU: vi.fn(() => null),
  getGlobalTemplateSnapshotForCurrentProfile_ACU: vi.fn(() => ({ templateObj: { mate: { type: 'chatSheets', version: 1 } } })),
  getSortedSheetKeys_ACU: vi.fn((data: Record<string, any>) =>
    Object.keys(data || {}).filter(key => key.startsWith('sheet_')),
  ),
  materializeDataFromSheetGuide_ACU: vi.fn((data: Record<string, any>) => data),
  sanitizeTemplateSnapshotForChat_ACU: vi.fn(() => ({ templateStr: '{"mate":{"type":"chatSheets","version":1}}' })),
  setChatSheetGuideDataForIsolationKey_ACU: vi.fn(),
  applyTemplatePresetToCurrent_ACU: vi.fn(async () => true),
  resolveActiveTemplatePresetName_ACU: vi.fn(() => '现有预设'),
  upsertTemplatePreset_ACU: vi.fn(() => true),
  getGlobalInjectionConfigFromData_ACU: vi.fn(() => ({})),
  purgeSheetKeysFromChatHistoryHard_ACU: vi.fn(async () => ({ changed: true })),
  refreshMergedDataAndNotify_ACU: vi.fn(async () => undefined),
  updateReadableLorebookEntry_ACU: vi.fn(async () => undefined),
  enqueueSummaryVectorIndexFlush_ACU: vi.fn(async () => undefined),
  deleteCurrentSummaryVectorIndexFromChat_ACU: vi.fn(async () => false),
  preflightSchemaMigrations_ACU: vi.fn(async () => ({ changedSheetKeys: [], blockers: [], operations: [] })),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/service/runtime/state-manager', () => runtimeMock);
vi.mock('../../../src/service/chat/chat-service', () => ({
  deleteLocalDataInChatCore_ACU: serviceMock.deleteLocalDataInChatCore_ACU,
  getChatArray_ACU: serviceMock.getChatArray_ACU,
  saveChatToHost_ACU: serviceMock.saveChatToHost_ACU,
}));
vi.mock('../../../src/service/runtime/helpers-remaining', () => ({
  applySpecialIndexSequenceToSummaryTables_ACU: serviceMock.applySpecialIndexSequenceToSummaryTables_ACU,
  applySummaryIndexSequenceToTable_ACU: serviceMock.applySummaryIndexSequenceToTable_ACU,
  getTableLocksForSheet_ACU: serviceMock.getTableLocksForSheet_ACU,
  deleteTableLocksForSheet_ACU: serviceMock.deleteTableLocksForSheet_ACU,
  getSummaryIndexColumnIndex_ACU: serviceMock.getSummaryIndexColumnIndex_ACU,
  saveTableLocksForSheet_ACU: serviceMock.saveTableLocksForSheet_ACU,
  setSpecialIndexLockEnabled_ACU: serviceMock.setSpecialIndexLockEnabled_ACU,
}));
vi.mock('../../../src/service/settings/settings-readers', () => ({
  getCurrentWorldbookConfig_ACU: serviceMock.getCurrentWorldbookConfig_ACU,
}));
vi.mock('../../../src/service/table/table-service', () => ({
  saveIndependentTableToChatHistory_ACU: serviceMock.saveIndependentTableToChatHistory_ACU,
}));
vi.mock('../../../src/service/table/table-update-commit', () => ({
  runTableUpdateCommit_ACU: serviceMock.runTableUpdateCommit_ACU,
}));
vi.mock('../../../src/service/table/table-history', () => ({
  getLatestAiMessageIndexFromChat_ACU: serviceMock.getLatestAiMessageIndexFromChat_ACU,
  getLatestTableAppendMessageIndexFromChat_ACU: serviceMock.getLatestTableAppendMessageIndexFromChat_ACU,
  resolveTableHistoryStateFromChat_ACU: serviceMock.resolveTableHistoryStateFromChat_ACU,
}));
vi.mock('../../../src/service/table/storage-mode', () => ({
  isSqliteMode: serviceMock.isSqliteMode,
}));
vi.mock('../../../src/service/table/storage-frame-v2-persist', () => ({
  commitCurrentFloorTemplateChanges_ACU: serviceMock.commitCurrentFloorTemplateChanges_ACU,
}));
vi.mock('../../../src/service/settings/settings-service', () => ({
  applyTemplateScopeForCurrentChat_ACU: serviceMock.applyTemplateScopeForCurrentChat_ACU,
}));
vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  reloadStorageProvider: serviceMock.reloadStorageProvider,
}));
vi.mock('../../../src/service/template/chat-scope', () => ({
  buildChatSheetGuideDataFromData_ACU: serviceMock.buildChatSheetGuideDataFromData_ACU,
  getChatSheetGuideDataForIsolationKey_ACU: serviceMock.getChatSheetGuideDataForIsolationKey_ACU,
  getGlobalTemplateSnapshotForCurrentProfile_ACU: serviceMock.getGlobalTemplateSnapshotForCurrentProfile_ACU,
  getSortedSheetKeys_ACU: serviceMock.getSortedSheetKeys_ACU,
  materializeDataFromSheetGuide_ACU: serviceMock.materializeDataFromSheetGuide_ACU,
  sanitizeTemplateSnapshotForChat_ACU: serviceMock.sanitizeTemplateSnapshotForChat_ACU,
  setChatSheetGuideDataForIsolationKey_ACU: serviceMock.setChatSheetGuideDataForIsolationKey_ACU,
}));
vi.mock('../../../src/service/template/template-preset-service', () => ({
  applyTemplatePresetToCurrent_ACU: serviceMock.applyTemplatePresetToCurrent_ACU,
  resolveActiveTemplatePresetName_ACU: serviceMock.resolveActiveTemplatePresetName_ACU,
  upsertTemplatePreset_ACU: serviceMock.upsertTemplatePreset_ACU,
}));
vi.mock('../../../src/service/worldbook/injection-engine', () => ({
  getGlobalInjectionConfigFromData_ACU: serviceMock.getGlobalInjectionConfigFromData_ACU,
  purgeSheetKeysFromChatHistoryHard_ACU: serviceMock.purgeSheetKeysFromChatHistoryHard_ACU,
}));
vi.mock('../../../src/service/worldbook/pipeline', () => ({
  refreshMergedDataAndNotify_ACU: serviceMock.refreshMergedDataAndNotify_ACU,
}));
vi.mock('../../../src/service/vector/summary-vector-index-flush-queue', () => ({
  enqueueSummaryVectorIndexFlush_ACU: serviceMock.enqueueSummaryVectorIndexFlush_ACU,
}));
vi.mock('../../../src/service/vector/summary-vector-index-chat-service', () => ({
  deleteCurrentSummaryVectorIndexFromChat_ACU: serviceMock.deleteCurrentSummaryVectorIndexFromChat_ACU,
}));
vi.mock('../../../src/service/table/schema-migration-preflight', () => ({
  preflightSchemaMigrations_ACU: serviceMock.preflightSchemaMigrations_ACU,
}));
vi.mock('../../../src/presentation-v2/stores/toast-store', () => ({
  useToastStore: () => toastMock,
}));

function sheet(name = '角色状态') {
  return {
    uid: 'sheet_test_vz2',
    name,
    orderNo: 0,
    content: [['row_id', '姓名', '状态'], ['1', 'A', '平静']],
    sourceData: {
      ddl: `CREATE TABLE sheet_test_vz2 (
  row_id INTEGER PRIMARY KEY, -- 行号
  col_1 TEXT, -- 姓名
  col_2 TEXT -- 状态
);`,
    },
  };
}

describe('useVisualizerSave', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    runtimeMock.resetCurrentData();
    vi.clearAllMocks();
    serviceMock.preflightSchemaMigrations_ACU.mockReset();
    serviceMock.preflightSchemaMigrations_ACU.mockResolvedValue({ changedSheetKeys: [], blockers: [], operations: [] });
  });

  it('保存数据到当前消息会提交数据增量并清理 dirty', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    const initialData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet(),
    };
    store.loadSnapshot(initialData, ['sheet_test_vz2']);
    runtimeMock._set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(initialData)));
    runtimeMock._set_currentJsonTableData_ACU.mockClear();
    store.updateCell(0, 1, '紧张');

    const saved = await useVisualizerSave().saveToChat();

    expect(saved).toBe(true);
    expect(runtimeMock._set_currentJsonTableData_ACU).toHaveBeenCalledTimes(1);
    expect(runtimeMock.getCurrentData().sheet_test_vz2.content[1][2]).toBe('紧张');
    expect(serviceMock.runTableUpdateCommit_ACU).toHaveBeenCalledWith(expect.objectContaining({
      source: 'manual_crud',
      reason: 'visualizer_save_native_batch',
      targetSheetKeys: ['sheet_test_vz2'],
    }), expect.any(Function));
    expect(store.dirty).toBe(false);
    expect(store.lastSavedTarget).toBe('data');
  });

  it('新增行保存时分配最小未占用 row_id，并生成可重放的 row_upsert', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    const initialData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: {
        ...sheet(),
        content: [['row_id', '姓名', '状态'], ['1', 'A', '平静'], ['3', 'B', '紧张']],
      },
    };
    store.loadSnapshot(initialData, ['sheet_test_vz2']);
    runtimeMock._set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(initialData)));
    runtimeMock._set_currentJsonTableData_ACU.mockClear();
    store.addRow();
    store.currentSheet.content[3][1] = 'C';
    store.currentSheet.content[3][2] = '就绪';

    await expect(useVisualizerSave().saveToChat()).resolves.toBe(true);

    expect(runtimeMock.getCurrentData().sheet_test_vz2.content).toEqual([
      ['row_id', '姓名', '状态'], ['1', 'A', '平静'], ['3', 'B', '紧张'], ['2', 'C', '就绪'],
    ]);
  });

  it('保存到全局模板被取消时不写入聊天、不清理 dirty', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('取消测试表'),
    }, ['sheet_test_vz2']);
    store.setDirty(true);

    const saved = await useVisualizerSave({
      confirmOverwriteGlobalPreset: vi.fn(async () => false),
    }).saveToGlobal();

    expect(saved).toBe(false);
    expect(runtimeMock._set_currentJsonTableData_ACU).not.toHaveBeenCalled();
    expect(serviceMock.upsertTemplatePreset_ACU).not.toHaveBeenCalled();
    expect(serviceMock.saveIndependentTableToChatHistory_ACU).not.toHaveBeenCalled();
    expect(store.dirty).toBe(true);
    expect(store.lastSavedTarget).toBeNull();
  });

  it('保存模板到全局确认后会写入当前可视化草稿，不混入旧全局模板', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    serviceMock.getGlobalTemplateSnapshotForCurrentProfile_ACU.mockReturnValueOnce({
      templateStr: '{"mate":{"type":"chatSheets","version":1},"sheet_old":{"name":"旧表","content":[["row_id"]]}}',
      templateObj: { mate: { type: 'chatSheets', version: 1 }, sheet_old: { name: '旧表', content: [['row_id']] } },
    });
    serviceMock.sanitizeTemplateSnapshotForChat_ACU.mockImplementationOnce((value: any) => ({
      templateStr: JSON.stringify(value),
      templateObj: value,
    }));
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('确认测试表'),
    }, ['sheet_test_vz2']);
    store.setDirty(true);

    const saved = await useVisualizerSave({
      confirmOverwriteGlobalPreset: vi.fn(async () => true),
    }).saveToGlobal();

    expect(saved).toBe(true);
    expect(serviceMock.upsertTemplatePreset_ACU).toHaveBeenCalledWith('现有预设', expect.any(String));
    const savedTemplate = JSON.parse(serviceMock.upsertTemplatePreset_ACU.mock.calls[0][1]);
    expect(savedTemplate.sheet_test_vz2.name).toBe('确认测试表');
    expect(savedTemplate.sheet_test_vz2.content).toEqual([['row_id', '姓名', '状态']]);
    expect(savedTemplate.sheet_old).toBeUndefined();
    expect(serviceMock.applyTemplatePresetToCurrent_ACU).toHaveBeenCalledWith('现有预设', expect.objectContaining({
      source: 'visualizer_v2_save_to_global',
      updateGlobal: true,
      save: true,
      persistChatScope: false,
    }));
    expect(serviceMock.runTableUpdateCommit_ACU).not.toHaveBeenCalled();
    expect(store.dirty).toBe(false);
    expect(store.lastSavedTarget).toBe('template-global');
  });

  it('保存独立导出位置时用本次草稿同步聊天指导表', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: {
        ...sheet('独立导出表'),
        exportConfig: {
          enabled: true,
          entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        },
      },
    }, ['sheet_test_vz2']);
    store.currentSheet.exportConfig.entryPlacement = {
      position: 'at_depth_as_system',
      depth: 7,
      order: 12345,
    };
    store.setDirty(true);

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(runtimeMock.getCurrentData().sheet_test_vz2.exportConfig.entryPlacement).toEqual({
      position: 'at_depth_as_system',
      depth: 7,
      order: 12345,
    });
    expect(serviceMock.buildChatSheetGuideDataFromData_ACU).toHaveBeenCalledWith(
      expect.objectContaining({
        sheet_test_vz2: expect.objectContaining({
          exportConfig: expect.objectContaining({
            entryPlacement: { position: 'at_depth_as_system', depth: 7, order: 12345 },
          }),
        }),
      }),
      expect.objectContaining({
        orderedKeys: ['sheet_test_vz2'],
      }),
    );
  });

  it('pristine 模板保存接受 template_only 结果并只提交一次核心请求，不触发历史 recovery guard', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.name = '新表名';
    store.setDirty(true);

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.ensureTemplateRecoveryOrDeleteCurrentIsolationData_ACU).not.toHaveBeenCalled();
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledWith(expect.objectContaining({
      isolationKey: 'iso-test',
      guideData: expect.any(Object),
      syncTemplateScope: true,
      templateSource: expect.objectContaining({
        sheet_test_vz2: expect.objectContaining({ name: '新表名' }),
      }),
      sheetChanges: [expect.objectContaining({
        kind: 'operations',
        sheetKey: 'sheet_test_vz2',
        operations: [expect.objectContaining({
          kind: 'meta_update',
          meta: expect.not.objectContaining({ sourceData: expect.objectContaining({ ddl: expect.anything() }) }),
        })],
      })],
    }));
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(serviceMock.applyTemplateScopeForCurrentChat_ACU).toHaveBeenCalled();
    expect(runtimeMock._set_currentJsonTableData_ACU).toHaveBeenCalledWith(expect.objectContaining({
      sheet_test_vz2: expect.objectContaining({ name: '新表名' }),
    }));
    expect(serviceMock.refreshMergedDataAndNotify_ACU).toHaveBeenCalled();
    expect(store.lastSavedTarget).toBe('template-chat');
  });

  it('新增表保存时只将新增表提交给 V2 当前楼层 writer', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('已有表'),
    }, ['sheet_test_vz2']);
    store.addSheet('sheet_new_vz2', { ...sheet('新增表'), uid: 'sheet_new_vz2' });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    const [[{ sheetChanges }]] = serviceMock.commitCurrentFloorTemplateChanges_ACU.mock.calls;
    expect(sheetChanges).toEqual([expect.objectContaining({
      kind: 'introduction',
      sheetKey: 'sheet_new_vz2',
    })]);
  });

  it('重排已有表时只提交 orderNo 实际变化的表', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_first: { ...sheet('第一张表'), uid: 'sheet_first', orderNo: 0 },
      sheet_second: { ...sheet('第二张表'), uid: 'sheet_second', orderNo: 1 },
      sheet_unchanged: { ...sheet('未变表'), uid: 'sheet_unchanged', orderNo: 2 },
    }, ['sheet_first', 'sheet_second', 'sheet_unchanged']);
    store.moveSheet('sheet_second', 'up');

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    const [[{ sheetChanges }]] = serviceMock.commitCurrentFloorTemplateChanges_ACU.mock.calls;
    expect(sheetChanges).toHaveLength(2);
    expect(sheetChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'operations', sheetKey: 'sheet_first' }),
      expect.objectContaining({ kind: 'operations', sheetKey: 'sheet_second' }),
    ]));
    expect(sheetChanges.map((change: any) => change.sheetKey)).not.toContain('sheet_unchanged');
  });

  it('新增表并修改旧表时只提交新增表和实际修改的旧表', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_changed: { ...sheet('原名称'), uid: 'sheet_changed', orderNo: 0 },
      sheet_unchanged: { ...sheet('未变表'), uid: 'sheet_unchanged', orderNo: 1 },
    }, ['sheet_changed', 'sheet_unchanged']);
    store.currentSheet.name = '更新后的名称';
    store.addSheet('sheet_new_vz2', { ...sheet('新增表'), uid: 'sheet_new_vz2' });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    const [[{ sheetChanges }]] = serviceMock.commitCurrentFloorTemplateChanges_ACU.mock.calls;
    expect(sheetChanges).toHaveLength(2);
    expect(sheetChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'operations', sheetKey: 'sheet_changed' }),
      expect.objectContaining({ kind: 'introduction', sheetKey: 'sheet_new_vz2' }),
    ]));
    expect(sheetChanges.map((change: any) => change.sheetKey)).not.toContain('sheet_unchanged');
  });

  it('已有 Sheet 同时变更 schema 与 metadata 时按 migration 再 meta_update 下传', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.name = '新表名';
    store.currentSheet.content = [['row_id', '姓名', '状态', '职业'], ['1', 'A', '平静', null]];
    store.currentSheet.sourceData.ddl = `CREATE TABLE sheet_test_vz2 (
  row_id INTEGER PRIMARY KEY, -- 行号
  col_1 TEXT, -- 姓名
  col_2 TEXT, -- 状态
  col_3 TEXT -- 职业
);`;
    const migration = { kind: 'sheet_schema_migrate', contractVersion: 1, sheetKey: 'sheet_test_vz2' };
    serviceMock.preflightSchemaMigrations_ACU.mockResolvedValueOnce({
      changedSheetKeys: ['sheet_test_vz2'],
      blockers: [],
      operations: [migration],
    });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    const [[{ sheetChanges }]] = serviceMock.commitCurrentFloorTemplateChanges_ACU.mock.calls;
    expect(sheetChanges).toHaveLength(1);
    expect(sheetChanges[0]).toMatchObject({
      kind: 'operations',
      sheetKey: 'sheet_test_vz2',
      targetSheetData: expect.objectContaining({ name: '新表名' }),
    });
    expect(sheetChanges[0].operations).toEqual([
      migration,
      expect.objectContaining({
        kind: 'meta_update',
        sheetKey: 'sheet_test_vz2',
        meta: expect.objectContaining({ name: '新表名' }),
      }),
    ]);
    expect(sheetChanges[0].operations[1].meta.sourceData).not.toHaveProperty('ddl');
  });

  it.each([
    ['缺少 operation', { changedSheetKeys: ['sheet_test_vz2'], blockers: [], operations: [] }],
    ['重复 operation', {
      changedSheetKeys: ['sheet_test_vz2'], blockers: [],
      operations: [{ sheetKey: 'sheet_test_vz2' }, { sheetKey: 'sheet_test_vz2' }],
    }],
    ['changedSheetKeys 不一致', {
      changedSheetKeys: ['sheet_other'], blockers: [], operations: [{ sheetKey: 'sheet_test_vz2' }],
    }],
  ])('schema migration preflight %s 时 fail closed', async (_label, preflightResult) => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.content = [['row_id', '姓名', '状态', '职业'], ['1', 'A', '平静', null]];
    store.currentSheet.sourceData.ddl = 'CREATE TABLE sheet_test_vz2 (row_id INTEGER PRIMARY KEY, col_1 TEXT, col_2 TEXT, col_3 TEXT);';
    serviceMock.preflightSchemaMigrations_ACU.mockResolvedValueOnce(preflightResult as any);

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(false);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('一一对应'), { muteable: false });
  });

  it('schema migration preflight 阻断时不创建 checkpoint 或推进模板状态', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    const baseDataBeforeSave = JSON.parse(JSON.stringify(store.templateBaseData));
    store.currentSheet.content = [['row_id', '姓名', '状态', '职业'], ['1', 'A', '平静', '战士']];
    store.setDirty(true);
    serviceMock.preflightSchemaMigrations_ACU.mockResolvedValueOnce({
      changedSheetKeys: ['sheet_test_vz2'],
      blockers: ['sheet_test_vz2: 缺少显式 V2 intent'],
      operations: [],
    });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(false);
    expect(serviceMock.preflightSchemaMigrations_ACU).toHaveBeenCalledWith(expect.objectContaining({
      baselineData: store.templateBaseData,
      candidateData: expect.objectContaining({ sheet_test_vz2: expect.any(Object) }),
    }));
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('schema migration preflight'), { muteable: false });
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).not.toHaveBeenCalled();
    expect(serviceMock.applyTemplateScopeForCurrentChat_ACU).not.toHaveBeenCalled();
    expect(runtimeMock._set_currentJsonTableData_ACU).not.toHaveBeenCalled();
    expect(store.templateBaseData).toEqual(baseDataBeforeSave);
    expect(store.lastSavedTarget).toBeNull();
    expect(store.dirty).toBe(true);
    expect(store.isSaving).toBe(false);
  });

  it('schema migration preflight 期间模板变化时不提交陈旧 checkpoint', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.content = [['row_id', '姓名', '状态', '职业'], ['1', 'A', '平静', '战士']];
    store.setDirty(true);
    let resolvePreflight: (value: { changedSheetKeys: string[]; blockers: string[]; operations: any[] }) => void;
    serviceMock.preflightSchemaMigrations_ACU.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePreflight = resolve;
    }));

    const saving = useVisualizerSave().saveTemplateToCurrentChat();
    store.currentSheet.name = 'preflight 期间的新表名';
    store.setDirty(true);
    resolvePreflight!({ changedSheetKeys: ['sheet_test_vz2'], blockers: [], operations: [{ sheetKey: 'sheet_test_vz2' }] });

    await expect(saving).resolves.toBe(false);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).not.toHaveBeenCalled();
    expect(serviceMock.applyTemplateScopeForCurrentChat_ACU).not.toHaveBeenCalled();
    expect(runtimeMock._set_currentJsonTableData_ACU).not.toHaveBeenCalled();
    expect(store.currentSheet.name).toBe('preflight 期间的新表名');
    expect(store.templateBaseData.sheet_test_vz2.name).toBe('旧表名');
    expect(store.lastSavedTarget).toBeNull();
    expect(store.dirty).toBe(true);
    expect(store.isSaving).toBe(false);
    expect(toastMock.warning).toHaveBeenCalledWith('模板结构在 schema migration preflight 期间已变化；请重新保存。', { muteable: false });
  });

  it('当前聊天模板原子提交失败时不推进运行时、基线、scope 或锁草稿', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    const baseDataBeforeSave = JSON.parse(JSON.stringify(store.templateBaseData));
    const baseOrderBeforeSave = [...store.templateBaseSheetOrder];
    store.currentSheet.name = '未提交的新表名';
    store.queueLockChanges([
      {
        sheetKey: 'sheet_test_vz2',
        rows: [{ rowIndex: 0, locked: true }],
        columns: [],
        cells: [],
        specialIndexLocked: false,
      },
    ]);
    serviceMock.commitCurrentFloorTemplateChanges_ACU.mockResolvedValueOnce({
      saved: false,
      error: '提交被业务层拒绝',
    });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(false);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith('提交被业务层拒绝', { muteable: false });
    expect(runtimeMock._set_currentJsonTableData_ACU).not.toHaveBeenCalled();
    expect(serviceMock.applyTemplateScopeForCurrentChat_ACU).not.toHaveBeenCalled();
    expect(serviceMock.saveTableLocksForSheet_ACU).not.toHaveBeenCalled();
    expect(serviceMock.setSpecialIndexLockEnabled_ACU).not.toHaveBeenCalled();
    expect(serviceMock.isSqliteMode).not.toHaveBeenCalled();
    expect(serviceMock.reloadStorageProvider).not.toHaveBeenCalled();
    expect(serviceMock.refreshMergedDataAndNotify_ACU).not.toHaveBeenCalled();
    expect(store.templateBaseData).toEqual(baseDataBeforeSave);
    expect(store.templateBaseSheetOrder).toEqual(baseOrderBeforeSave);
    expect(store.pendingLockChanges).toHaveLength(1);
    expect(store.lastSavedTarget).toBeNull();
    expect(store.dirty).toBe(true);
    expect(store.isSaving).toBe(false);
  });

  it('SQLite 运行时刷新失败不会回滚成功的模板提交或重复提交 checkpoint', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.name = '已提交的新表名';
    store.setDirty(true);
    serviceMock.isSqliteMode.mockReturnValueOnce(true);
    serviceMock.reloadStorageProvider.mockRejectedValueOnce(new Error('reload failed'));

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(serviceMock.reloadStorageProvider).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith(
      '模板已保存，但 SQLite 运行时刷新失败；请重新载入当前聊天后重试。',
      { muteable: false },
    );
    expect(serviceMock.applyTemplateScopeForCurrentChat_ACU).toHaveBeenCalledTimes(1);
    expect(runtimeMock._set_currentJsonTableData_ACU).toHaveBeenCalledWith(expect.objectContaining({
      sheet_test_vz2: expect.objectContaining({ name: '已提交的新表名' }),
    }));
    expect(serviceMock.refreshMergedDataAndNotify_ACU).toHaveBeenCalledTimes(1);
    expect(store.templateBaseData.sheet_test_vz2.name).toBe('已提交的新表名');
    expect(store.lastSavedTarget).toBe('template-chat');
    expect(store.dirty).toBe(false);
    expect(store.isSaving).toBe(false);
  });

  it('合并数据刷新失败不会把成功的模板提交伪装为保存失败', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.name = '已提交但刷新失败的新表名';
    store.setDirty(true);
    serviceMock.refreshMergedDataAndNotify_ACU.mockRejectedValueOnce(new Error('merged refresh failed'));

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith(
      '模板已保存，但合并数据刷新失败；请重新载入当前聊天后重试。',
      { muteable: false },
    );
    expect(store.templateBaseData.sheet_test_vz2.name).toBe('已提交但刷新失败的新表名');
    expect(store.lastSavedTarget).toBe('template-chat');
    expect(store.dirty).toBe(false);
    expect(store.isSaving).toBe(false);
  });

  it('模板作用域运行时同步失败不会回滚成功的模板提交', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.name = '已提交但 scope 同步失败的新表名';
    store.setDirty(true);
    serviceMock.applyTemplateScopeForCurrentChat_ACU.mockImplementationOnce(() => {
      throw new Error('scope sync failed');
    });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith(
      '模板已保存，但模板作用域运行时同步失败；请重新载入当前聊天后重试。',
      { muteable: false },
    );
    expect(runtimeMock._set_currentJsonTableData_ACU).toHaveBeenCalledWith(expect.objectContaining({
      sheet_test_vz2: expect.objectContaining({ name: '已提交但 scope 同步失败的新表名' }),
    }));
    expect(store.templateBaseData.sheet_test_vz2.name).toBe('已提交但 scope 同步失败的新表名');
    expect(store.lastSavedTarget).toBe('template-chat');
    expect(store.dirty).toBe(false);
    expect(store.isSaving).toBe(false);
  });

  it('保存时提交 AI 助手暂存的锁变化并在成功后清空队列', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet(),
    }, ['sheet_test_vz2']);
    store.queueLockChanges([
      {
        sheetKey: 'sheet_test_vz2',
        rows: [{ rowIndex: 0, locked: true }],
        columns: [{ colIndex: 1, locked: true }],
        cells: [{ rowIndex: 0, colIndex: 1, locked: false }],
        specialIndexLocked: false,
      },
    ]);

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.saveTableLocksForSheet_ACU).toHaveBeenCalledTimes(1);
    expect(serviceMock.saveTableLocksForSheet_ACU).toHaveBeenCalledWith(
      'sheet_test_vz2',
      expect.objectContaining({
        rows: expect.any(Set),
        cols: expect.any(Set),
        cells: expect.any(Set),
      }),
    );
    expect(serviceMock.setSpecialIndexLockEnabled_ACU).toHaveBeenCalledWith('sheet_test_vz2', false);
    expect(store.pendingLockChanges).toEqual([]);
  });

  it('运行时数据同步失败时仍保存锁草稿并完成模板提交', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.name = '运行时同步失败的新表名';
    store.queueLockChanges([
      {
        sheetKey: 'sheet_test_vz2',
        rows: [{ rowIndex: 0, locked: true }],
        columns: [],
        cells: [],
        specialIndexLocked: false,
      },
    ]);
    runtimeMock._set_currentJsonTableData_ACU.mockImplementationOnce(() => {
      throw new Error('runtime sync failed');
    });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(serviceMock.saveTableLocksForSheet_ACU).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith(
      '模板已保存，但运行时数据同步失败；请重新载入当前聊天后重试。',
      { muteable: false },
    );
    expect(store.pendingLockChanges).toEqual([]);
    expect(store.lockDraftsDirty).toBe(false);
    expect(store.dirty).toBe(false);
    expect(store.lastSavedTarget).toBe('template-chat');
  });

  it('锁草稿保存失败时保留手动锁改动并在重试时不重复提交 checkpoint', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_test_vz2: sheet('旧表名'),
    }, ['sheet_test_vz2']);
    store.currentSheet.name = '锁保存失败的新表名';
    store.toggleRowLock('sheet_test_vz2', 0);
    serviceMock.saveTableLocksForSheet_ACU.mockImplementationOnce(() => {
      throw new Error('lock save failed');
    });

    const firstSaved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(firstSaved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith(
      '模板已保存，但表格锁定设置未保存；请重试保存。',
      { muteable: false },
    );
    expect(store.templateBaseData.sheet_test_vz2.name).toBe('锁保存失败的新表名');
    expect(store.pendingLockChanges).toEqual([]);
    expect(store.lockDraftsDirty).toBe(true);
    expect(store.isRowLocked('sheet_test_vz2', 0)).toBe(true);
    expect(store.dirty).toBe(true);
    expect(store.lastSavedTarget).toBe('template-chat');

    const retrySaved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(retrySaved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    expect(serviceMock.saveTableLocksForSheet_ACU).toHaveBeenCalledTimes(2);
    expect(store.lockDraftsDirty).toBe(false);
    expect(store.dirty).toBe(false);
  });

  it('当前聊天模板仅删表时将删除意图交给原子模板提交，且不走独立 hard purge', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_keep: { ...sheet('保留表'), uid: 'sheet_keep' },
      sheet_delete: { ...sheet('删除表'), uid: 'sheet_delete' },
    }, ['sheet_keep', 'sheet_delete']);
    store.tableLockDrafts.sheet_delete = { rows: [0], cols: [], cells: [], specialIndexLocked: true };
    store.deleteSheet('sheet_delete');

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledTimes(1);
    const [[options]] = serviceMock.commitCurrentFloorTemplateChanges_ACU.mock.calls;
    expect(options.deletedSheetKeys).toEqual(['sheet_delete']);
    expect(options.sheetChanges).toEqual([]);
    expect(serviceMock.purgeSheetKeysFromChatHistoryHard_ACU).not.toHaveBeenCalled();
    expect(serviceMock.saveTableLocksForSheet_ACU).not.toHaveBeenCalledWith('sheet_delete', expect.anything());
    expect(store.tableLockDrafts.sheet_delete).toBeUndefined();
    expect(store.deletedSheetKeys).toEqual([]);
    expect(store.lastSavedTarget).toBe('template-chat');
  });

  it('删除最后一张摘要表后清除当前聊天摘要向量索引，而不保留陈旧索引', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_keep: { ...sheet('保留表'), uid: 'sheet_keep' },
      sheet_summary: { ...sheet('总结表'), uid: 'sheet_summary' },
    }, ['sheet_keep', 'sheet_summary']);
    serviceMock.getCurrentWorldbookConfig_ACU.mockReturnValueOnce({ summaryVectorIndexModeEnabled: true });
    store.deleteSheet('sheet_summary');

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledWith(expect.objectContaining({
      deletedSheetKeys: ['sheet_summary'],
      sheetChanges: [],
    }));
    expect(serviceMock.deleteCurrentSummaryVectorIndexFromChat_ACU).toHaveBeenCalledTimes(1);
    expect(serviceMock.enqueueSummaryVectorIndexFlush_ACU).not.toHaveBeenCalled();
    expect(store.deletedSheetKeys).toEqual([]);
    expect(store.lastSavedTarget).toBe('template-chat');
  });


  it('删除摘要表但仍保留摘要表时同步索引而不删除当前聊天索引', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_keep: { ...sheet('保留表'), uid: 'sheet_keep' },
      sheet_summary_keep: { ...sheet('总体大纲'), uid: 'sheet_summary_keep' },
      sheet_summary_delete: { ...sheet('总结表'), uid: 'sheet_summary_delete' },
    }, ['sheet_keep', 'sheet_summary_keep', 'sheet_summary_delete']);
    serviceMock.getCurrentWorldbookConfig_ACU.mockReturnValueOnce({ summaryVectorIndexModeEnabled: true });
    store.deleteSheet('sheet_summary_delete');

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    const [[options]] = serviceMock.commitCurrentFloorTemplateChanges_ACU.mock.calls;
    expect(options.deletedSheetKeys).toEqual(['sheet_summary_delete']);
    expect(options.templateSource.sheet_keep).toBeDefined();
    expect(options.templateSource.sheet_summary_keep).toBeDefined();
    expect(options.templateSource.sheet_summary_delete).toBeUndefined();
    expect(options.guideData.sheet_summary_keep).toBeDefined();
    expect(serviceMock.enqueueSummaryVectorIndexFlush_ACU).toHaveBeenCalledWith({
      mode: 'sync',
      reason: 'visualizer_v2_template_sheet_delete',
    });
    expect(serviceMock.deleteCurrentSummaryVectorIndexFromChat_ACU).not.toHaveBeenCalled();
  });


  it('删表与 metadata 变更一起保存时只将存活表生成 sheetChanges', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    store.loadSnapshot({
      mate: { type: 'chatSheets', version: 1 },
      sheet_keep: { ...sheet('保留表'), uid: 'sheet_keep' },
      sheet_delete: { ...sheet('删除表'), uid: 'sheet_delete' },
    }, ['sheet_keep', 'sheet_delete']);
    store.currentSheet.name = '保留表更新';
    store.deleteSheet('sheet_delete');

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(true);
    const [[options]] = serviceMock.commitCurrentFloorTemplateChanges_ACU.mock.calls;
    expect(options.deletedSheetKeys).toEqual(['sheet_delete']);
    expect(options.sheetChanges).toEqual([expect.objectContaining({ kind: 'operations', sheetKey: 'sheet_keep' })]);
    expect(options.sheetChanges.map((change: any) => change.sheetKey)).not.toContain('sheet_delete');
  });

  it('模板删表原子提交失败时保留删除状态、基线和锁草稿供重试', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    const initialData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_keep: { ...sheet('保留表'), uid: 'sheet_keep' },
      sheet_delete: { ...sheet('删除表'), uid: 'sheet_delete' },
    };
    store.loadSnapshot(initialData, ['sheet_keep', 'sheet_delete']);
    store.tableLockDrafts.sheet_delete = { rows: [0], cols: [], cells: [], specialIndexLocked: true };
    const baseDataBeforeSave = JSON.parse(JSON.stringify(store.templateBaseData));
    store.deleteSheet('sheet_delete');
    serviceMock.commitCurrentFloorTemplateChanges_ACU.mockResolvedValueOnce({ saved: false, error: '原子删除失败' });

    const saved = await useVisualizerSave().saveTemplateToCurrentChat();

    expect(saved).toBe(false);
    expect(serviceMock.commitCurrentFloorTemplateChanges_ACU).toHaveBeenCalledWith(expect.objectContaining({ deletedSheetKeys: ['sheet_delete'], sheetChanges: [] }));
    expect(store.deletedSheetKeys).toEqual(['sheet_delete']);
    expect(store.templateBaseData).toEqual(baseDataBeforeSave);
    expect(store.tableLockDrafts.sheet_delete).toEqual({ rows: [0], cols: [], cells: [], specialIndexLocked: true });
    expect(store.dirty).toBe(true);
    expect(toastMock.error).toHaveBeenCalledWith('原子删除失败', { muteable: false });
  });


  it('保存已删除表时只把 deletedSheetKeys 传给硬删除且不把删除表写入 V2 commit', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    const initialData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_keep: { ...sheet('保留表'), uid: 'sheet_keep' },
      sheet_delete: { ...sheet('删除表'), uid: 'sheet_delete' },
    };
    store.loadSnapshot(initialData, ['sheet_keep', 'sheet_delete']);
    runtimeMock._set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(initialData)));
    runtimeMock._set_currentJsonTableData_ACU.mockClear();

    store.deleteSheet('sheet_delete');
    store.updateCell(0, 1, '保留表更新');

    const saved = await useVisualizerSave().saveToChat();

    expect(saved).toBe(true);
    expect(serviceMock.purgeSheetKeysFromChatHistoryHard_ACU).toHaveBeenCalledWith(['sheet_delete']);
    expect(serviceMock.runTableUpdateCommit_ACU).toHaveBeenCalledWith(expect.objectContaining({
      source: 'manual_crud',
      reason: 'visualizer_save_native_batch',
      targetSheetKeys: ['sheet_keep'],
      writeSet: [expect.objectContaining({ kind: 'cell', sheetKey: 'sheet_keep' })],
    }), expect.any(Function));
    const commitOptions = serviceMock.runTableUpdateCommit_ACU.mock.calls[0][0];
    expect(commitOptions.targetSheetKeys).not.toContain('sheet_delete');
    expect(commitOptions.writeSet.map((unit: any) => unit.sheetKey)).not.toContain('sheet_delete');
    expect(runtimeMock.getCurrentData().sheet_keep.content[1][2]).toBe('保留表更新');
    expect(store.deletedSheetKeys).toEqual([]);
  });

  it('只删除整张表且没有行级增量时仍会执行硬删除清理', async () => {
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    const { useVisualizerSave } = await import('../../../src/presentation-v2/composables/visualizer/useVisualizerSave');
    const store = useVisualizerStore();
    const initialData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_keep: { ...sheet('保留表'), uid: 'sheet_keep' },
      sheet_delete: { ...sheet('删除表'), uid: 'sheet_delete' },
    };
    store.loadSnapshot(initialData, ['sheet_keep', 'sheet_delete']);
    runtimeMock._set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(initialData)));
    runtimeMock._set_currentJsonTableData_ACU.mockClear();

    store.deleteSheet('sheet_delete');

    const saved = await useVisualizerSave().saveToChat();

    expect(saved).toBe(true);
    expect(serviceMock.runTableUpdateCommit_ACU).not.toHaveBeenCalled();
    expect(serviceMock.purgeSheetKeysFromChatHistoryHard_ACU).toHaveBeenCalledWith(['sheet_delete']);
    expect(serviceMock.refreshMergedDataAndNotify_ACU).toHaveBeenCalled();
    expect(store.deletedSheetKeys).toEqual([]);
    expect(store.dirty).toBe(false);
    expect(store.lastSavedTarget).toBe('data');
  });
});
