import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOpenVisualizer, mockHandleTxtImportAndSplit, mockImportTxtTextAndSplitCore, mockInjectImportedSelectedCore, mockDeleteImportedEntriesCore } = vi.hoisted(() => ({
  mockOpenVisualizer: vi.fn(),
  mockHandleTxtImportAndSplit: vi.fn(),
  mockImportTxtTextAndSplitCore: vi.fn(),
  mockInjectImportedSelectedCore: vi.fn(),
  mockDeleteImportedEntriesCore: vi.fn(),
}));

vi.mock('../../src/presentation/triggers/data-admin-ui', () => ({
  exportCurrentJsonData_ACU: vi.fn(),
  exportTableTemplate_ACU: vi.fn(),
  importTableTemplate_ACU: vi.fn(),
  overrideLatestLayerWithTemplate_ACU: vi.fn(),
  resetAllToDefaults_ACU: vi.fn(),
  resetTableTemplate_ACU: vi.fn(),
}));

vi.mock('../../src/presentation/triggers/admin-ui', () => ({
  importCombinedSettings_ACU: vi.fn(),
}));

vi.mock('../../src/presentation/triggers/update-trigger', () => ({
  exportCombinedSettings_ACU: vi.fn(),
  handleManualMergeSummary_ACU: vi.fn(),
}));

vi.mock('../../src/presentation/triggers/import-process', () => ({
  clearImportLocalStorage_ACU: vi.fn(),
  clearImportedEntries_ACU: vi.fn(),
  deleteImportedEntries_ACU: vi.fn(),
  handleInjectImportedTxtSelected_ACU: vi.fn(),
}));

vi.mock('../../src/presentation/components/import-status-ui', () => ({
  handleTxtImportAndSplit_ACU: mockHandleTxtImportAndSplit,
  handleInjectSplitEntriesFull_ACU: vi.fn(),
  handleInjectSplitEntriesStandard_ACU: vi.fn(),
  handleInjectSplitEntriesSummary_ACU: vi.fn(),
}));

vi.mock('../../src/service/import/import-executor', () => ({
  importTxtTextAndSplitCore_ACU: mockImportTxtTextAndSplitCore,
  injectImportedSelectedCore_ACU: mockInjectImportedSelectedCore,
  deleteImportedEntriesCore_ACU: mockDeleteImportedEntriesCore,
}));

vi.mock('../../src/presentation/pages/visualizer', () => ({
  openNewVisualizer_ACU: mockOpenVisualizer,
}));

import { createDataAdminApi } from '../../src/presentation/bootstrap/api-groups/data-admin-api';

describe('createDataAdminApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenVisualizer.mockResolvedValue(undefined);
    mockHandleTxtImportAndSplit.mockResolvedValue(true);
    mockImportTxtTextAndSplitCore.mockResolvedValue({ success: true, chunksCount: 1, splitSize: 10000 });
    mockInjectImportedSelectedCore.mockResolvedValue({ success: true, processedChunks: 1 });
    mockDeleteImportedEntriesCore.mockResolvedValue(2);
  });

  it('暴露 openVisualizer 并调用 visualizer 入口', async () => {
    const api = createDataAdminApi({} as any);

    expect(typeof api.openVisualizer).toBe('function');
    await api.openVisualizer();

    expect(mockOpenVisualizer).toHaveBeenCalledTimes(1);
  });

  it('保留旧 importTxtAndSplit UI 文件选择行为', async () => {
    const api = createDataAdminApi({} as any);

    const result = await api.importTxtAndSplit();

    expect(result).toBe(true);
    expect(mockHandleTxtImportAndSplit).toHaveBeenCalledTimes(1);
    expect(mockImportTxtTextAndSplitCore).not.toHaveBeenCalled();
  });

  it('importTxtTextAndSplit 调用 headless core 并规范化 splitSize 字符串', async () => {
    const api = createDataAdminApi({} as any);

    const result = await api.importTxtTextAndSplit('abcdef', { splitSize: ' 3 ', clearPrevious: false });

    expect(result).toEqual({ success: true, chunksCount: 1, splitSize: 10000 });
    expect(mockImportTxtTextAndSplitCore).toHaveBeenCalledWith('abcdef', { splitSize: 3, clearPrevious: false });
  });

  it('importTxtTextAndSplit 拒绝非字符串文本且不调用 core', async () => {
    const api = createDataAdminApi({} as any);

    const result = await api.importTxtTextAndSplit({ text: 'abcdef' }, { splitSize: 3 });

   expect(result.success).toBe(false);
    expect(result.error).toContain('字符串');
    expect(mockImportTxtTextAndSplitCore).not.toHaveBeenCalled();
  });

  it('importTxtTextAndSplit 捕获 core 异常并返回结构化错误', async () => {
    mockImportTxtTextAndSplitCore.mockRejectedValue(new Error('split failed'));
    const api = createDataAdminApi({} as any);

    const result = await api.importTxtTextAndSplit('abcdef');

    expect(result).toEqual({ success: false, error: 'split failed' });
  });

  it('injectImportedSelected 调用 headless core 并规范化 target 与 selectedSheetKeys', async () => {
    const api = createDataAdminApi({} as any);

    const result = await api.injectImportedSelected({
      targetWorldbook: '  BookA  ',
      selectedSheetKeys: [' sheet_0 ', 'sheet_0', '', 7, 'sheet_1'],
      maxRetries: '2',
      requestOptions: { preset: 'fast' },
    });

    expect(result).toEqual({ success: true, processedChunks: 1 });
    expect(mockInjectImportedSelectedCore).toHaveBeenCalledWith({
      targetWorldbook: 'BookA',
      selectedSheetKeys: ['sheet_0', 'sheet_1'],
      maxRetries: 2,
      requestOptions: { preset: 'fast' },
    });
  });

  it('injectImportedSelected 保留显式空 selectedSheetKeys 让 core 返回空选择错误', async () => {
    const api = createDataAdminApi({} as any);

    await api.injectImportedSelected({ targetWorldbook: 'BookA', selectedSheetKeys: [] });

    expect(mockInjectImportedSelectedCore).toHaveBeenCalledWith({ targetWorldbook: 'BookA', selectedSheetKeys: [] });
  });

  it('injectImportedSelected 忽略 selectedSheetKeys=undefined 以保留 core fallback', async () => {
    const api = createDataAdminApi({} as any);

    await api.injectImportedSelected({ targetWorldbook: ' BookA ', selectedSheetKeys: undefined });

    expect(mockInjectImportedSelectedCore).toHaveBeenCalledWith({ targetWorldbook: 'BookA' });
  });

  it('injectImportedSelected 拒绝非数组 selectedSheetKeys 且不调用 core', async () => {
    const api = createDataAdminApi({} as any);

    const result = await api.injectImportedSelected({ selectedSheetKeys: 'sheet_0' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('字符串数组');
    expect(mockInjectImportedSelectedCore).not.toHaveBeenCalled();
  });

  it('injectImportedSelected 捕获 core 异常并返回结构化错误', async () => {
    mockInjectImportedSelectedCore.mockRejectedValue(new Error('inject failed'));
    const api = createDataAdminApi({} as any);

    const result = await api.injectImportedSelected({ targetWorldbook: 'BookA' });

    expect(result).toEqual({ success: false, error: 'inject failed' });
  });

  it('clearImportedLorebookEntries 删除指定世界书里的外部导入注入条目并返回删除数量', async () => {
    const api = createDataAdminApi({} as any);

    const result = await api.clearImportedLorebookEntries({ targetWorldbook: '  BookA  ' });

    expect(result).toEqual({ success: true, deletedCount: 2, targetWorldbook: 'BookA' });
    expect(mockDeleteImportedEntriesCore).toHaveBeenCalledWith('BookA');
  });

  it('clearImportedLorebookEntries 拒绝缺失目标世界书且不调用 core', async () => {
    const api = createDataAdminApi({} as any);

    const result = await api.clearImportedLorebookEntries({ targetWorldbook: '   ' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('targetWorldbook');
    expect(mockDeleteImportedEntriesCore).not.toHaveBeenCalled();
  });

  it('clearImportedLorebookEntries 捕获 core 异常并返回结构化错误', async () => {
    mockDeleteImportedEntriesCore.mockRejectedValue(new Error('delete failed'));
    const api = createDataAdminApi({} as any);

    const result = await api.clearImportedLorebookEntries({ targetWorldbook: 'BookA' });

    expect(result).toEqual({ success: false, error: 'delete failed' });
  });
});
