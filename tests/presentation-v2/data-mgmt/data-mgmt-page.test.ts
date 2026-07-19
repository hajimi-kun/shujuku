/**
 * DataMgmtPage 集成 — 数据管理页结构与关键动作
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MERGE_SUMMARY_PROMPT_ACU } from '../../../src/shared/defaults-json.js';

const STORAGE_KEY = 'acu_v2_ui_state';
const capturedDownloads: string[] = [];

function createSettings() {
  return {
    storageMode: 'native',
    dataIsolationEnabled: true,
    dataIsolationCode: 'alpha',
    deleteStartFloor: 1,
    deleteEndFloor: null,
    charCardPrompt: [{ role: 'system', content: 'prompt' }],
    mergeSummaryPrompt: 'merge prompt',
    mergeTargetCount: 1,
    mergeBatchSize: 5,
    mergeStartIndex: 1,
    mergeEndIndex: null,
    autoMergeEnabled: false,
    autoMergeThreshold: 20,
    autoMergeReserve: 0,
    apiPresets: [],
    defaultApiPresetName: '',
    apiPresetBindingsByChat: {},
    contentOptimizationSettings: { apiPreset: '' },
    tableApiPresetOverridesByName: {},
    plotSettings: {
      enabled: true,
      promptPresets: [
        { name: '全局推进', prompts: [], plotTasks: [], contextExtractRules: [], contextExcludeRules: [] },
      ],
      lastUsedPresetName: '全局推进',
      globalRevision: 1,
      loopSettings: { quickReplyContent: [], currentPromptIndex: 0, maxRetries: 3 },
      prompts: [],
      plotTasks: [],
    },
    plotPresetBindings: {
      'chat-data': { presetName: '聊天推进', source: 'ui', isExplicit: true, updatedAt: 1000 },
      'other-chat': { presetName: '其他推进', source: 'ui', isExplicit: true, updatedAt: 1000 },
    },
    retainRecentLayers: 100,
    tableKeyOrder: ['sheet_b', 'sheet_a'],
    manualSelectedTables: ['sheet_a'],
    hasManualSelection: true,
    importSelectedTables: ['sheet_b'],
    hasImportTableSelection: true,
    tableUpdateLocks: {
      'chat-data::alpha': { sheet_a: { rows: [1], cols: [], cells: [] } },
      'other-chat::alpha': { sheet_a: { rows: [2], cols: [], cells: [] } },
    },
    specialIndexLocks: {
      'chat-data::alpha': { sheet_a: false },
      'chat-data::beta': { sheet_a: false },
    },
  } as any;
}

async function mountDataMgmtPage(chatFileIdentifier = 'chat-data') {
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ router: { activePageId: 'data-mgmt' } }));

  const settings = createSettings();
  const isolationHistory = ['alpha', 'beta'];
  const saveSettings = vi.fn(() => ({ saved: true, storageType: 'memory' }));
  const applyTemplateScope = vi.fn(() => ({
    mode: 'chat_override',
    isolationKey: settings.dataIsolationCode,
    presetName: 'chat-template',
  }));
  const switchIsolation = vi.fn(async (code: string) => {
    settings.dataIsolationCode = code;
    settings.dataIsolationEnabled = !!code;
    if (code && !isolationHistory.includes(code)) isolationHistory.unshift(code);
  });
  const removeHistory = vi.fn((code: string) => {
    const index = isolationHistory.indexOf(code);
    if (index >= 0) isolationHistory.splice(index, 1);
  });
  const deleteGenerated = vi.fn(async () => undefined);
  const deleteLocalData = vi.fn(async () => 2);
  const cleanupWorldbook = vi.fn(async () => 1);
  const overrideLatest = vi.fn(async () => 3);
  const loadOrCreate = vi.fn(async () => ({ ok: true }));
  const refreshMerged = vi.fn(async () => ({ ok: true }));
  const applyTemplate = vi.fn(async () => ({ templateStr: '{}', templateObj: {} }));
  const saveChatToHost = vi.fn(async () => undefined);
  const buildCheckpoint = vi.fn(() => ({ format: 'acu-table-checkpoint' }));
  const parseCheckpoint = vi.fn(() => ({ success: true, checkpoint: { format: 'acu-table-checkpoint', source: { storageMode: 'native' } } }));
  const restoreCheckpoint = vi.fn(async () => ({ success: true, restoredMessageIndex: 1 }));
  const chat = [
    {
      is_user: true,
      mes: 'u',
      TavernDB_ACU_ScopedConfig: {
        version: 1,
        plot: {
          mode: 'chat_override',
          presetName: '聊天推进',
          snapshot: {
            prompts: [],
            plotTasks: [],
            loopSettings: { quickReplyContent: [], currentPromptIndex: 0, maxRetries: 3 },
          },
          source: 'ui_import',
          updatedAt: 1000,
        },
        template: {
          alpha: { mode: 'chat_override', templateStr: '{"sheet_a":{}}' },
          beta: { mode: 'chat_override', templateStr: '{"sheet_b":{}}' },
        },
        templateArchives: {
          alpha: [
            { archiveKey: 'alpha-a', mode: 'chat_override', templateStr: '{"sheet_a":{}}' },
          ],
          beta: [
            { archiveKey: 'beta-a', mode: 'chat_override', templateStr: '{"sheet_b":{}}' },
          ],
        },
      },
      TavernDB_ACU_InternalSheetGuide: {
        version: 2,
        tags: {
          alpha: { data: { mate: { type: 'chatSheets' }, sheet_a: { name: 'A', content: [['h']] } } },
          beta: { data: { mate: { type: 'chatSheets' }, sheet_b: { name: 'B', content: [['h']] } } },
        },
      },
      TavernDB_ACU_TableHeaderGuide: {
        version: 1,
        tags: {
          alpha: { headers: [{ uid: 'sheet_a' }] },
          beta: { headers: [{ uid: 'sheet_b' }] },
        },
      },
    },
    { is_user: false, TavernDB_ACU_IsolatedData: { alpha: {} } },
    { is_user: false, TavernDB_ACU_IsolatedData: { alpha: {} } },
  ] as any[];

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:acu-test'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) {
    capturedDownloads.push(this.download);
  });

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
    currentChatFileIdentifier_ACU: chatFileIdentifier,
    currentJsonTableData_ACU: {
      mate: { type: 'chatSheets' },
      sheet_a: { name: 'A', content: [['h']], sourceData: {} },
      sheet_b: { name: 'B', content: [['h']], sourceData: {} },
    },
    getCurrentIsolationKey_ACU: () => settings.dataIsolationCode || '',
    coreApisAreReady_ACU: true,
  }));
  vi.doMock('../../../src/data/gateways/chat-gateway', async () => {
    const actual = await vi.importActual<any>('../../../src/data/gateways/chat-gateway');
    return {
      ...actual,
      getChatArray_ACU: () => chat,
      getChatLength_ACU: () => chat.length,
      getLastMessageIndex_ACU: () => Math.max(0, chat.length - 1),
      saveChatToHost_ACU: saveChatToHost,
    };
  });
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    applyTemplateScopeForCurrentChat_ACU: applyTemplateScope,
    getDataIsolationHistory_ACU: () => [...isolationHistory],
    removeDataIsolationHistory_ACU: removeHistory,
    saveSettings_ACU: saveSettings,
    switchIsolationProfile_ACU: switchIsolation,
    applyCombinedSettingsImport_ACU: vi.fn(() => ['charCardPrompt']),
  }));
  vi.doMock('../../../src/service/chat/chat-service', () => ({
    getChatArray_ACU: () => chat,
    deleteLocalDataInChatCore_ACU: deleteLocalData,
    overrideLatestLayerWithTemplateCore_ACU: overrideLatest,
  }));
  vi.doMock('../../../src/service/table/table-service', () => ({
    loadOrCreateJsonTableFromChatHistory_ACU: loadOrCreate,
  }));
  vi.doMock('../../../src/service/worldbook/worldbook-cleanup', () => ({
    cleanupWorldbookEntriesAfterDataDeletion_ACU: cleanupWorldbook,
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    deleteAllGeneratedEntries_ACU: deleteGenerated,
    refreshMergedDataAndNotify_ACU: refreshMerged,
  }));
  vi.doMock('../../../src/service/template/template-preset-service', () => ({
    applyTemplateSnapshotToScope_ACU: applyTemplate,
    getDefaultTemplateSnapshot_ACU: () => ({
      templateStr: JSON.stringify({
        mate: { type: 'chatSheets' },
        sheet_a: { name: 'A', content: [['h']], sourceData: {} },
      }),
      templateObj: {
        mate: { type: 'chatSheets' },
        sheet_a: { name: 'A', content: [['h']], sourceData: {} },
      },
    }),
  }));
  vi.doMock('../../../src/service/table/storage-mode', () => ({
    isSqliteMode: () => false,
    getCurrentStorageMode: () => settings.storageMode,
  }));
  vi.doMock('../../../src/service/table/table-checkpoint-transfer', () => ({
    buildCurrentTableCheckpoint_ACU: buildCheckpoint,
    parseTableCheckpointFile_ACU: parseCheckpoint,
    restoreTableCheckpointToLatestAi_ACU: restoreCheckpoint,
  }));

  const mount = await import('../../../src/presentation-v2/bootstrap/mount');
  await mount.openAcuV2App();
  await new Promise(r => setTimeout(r, 0));

  return {
    mount,
    settings,
    applyTemplateScope,
    saveSettings,
    switchIsolation,
    removeHistory,
    deleteGenerated,
    deleteLocalData,
    cleanupWorldbook,
    overrideLatest,
    loadOrCreate,
    refreshMerged,
    applyTemplate,
    saveChatToHost,
    chat,
    buildCheckpoint,
    parseCheckpoint,
    restoreCheckpoint,
  };
}

beforeEach(() => {
  localStorage.clear();
  capturedDownloads.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function clickDialogButton(label: string): Promise<void> {
  await Promise.resolve();
  const layer = document.querySelector<HTMLElement>('.acu-dialog-layer');
  expect(layer).not.toBeNull();
  const button = Array.from(layer!.querySelectorAll<HTMLButtonElement>('button'))
    .find(item => item.textContent?.includes(label));
  expect(button).not.toBeUndefined();
  button!.click();
  await new Promise(r => setTimeout(r, 0));
}

async function clickDialogCheckbox(label: string): Promise<void> {
  await Promise.resolve();
  const layer = document.querySelector<HTMLElement>('.acu-dialog-layer');
  expect(layer).not.toBeNull();
  const checkbox = Array.from(layer!.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]'))
    .find(item => item.textContent?.includes(label));
  expect(checkbox).not.toBeUndefined();
  checkbox!.click();
  await Promise.resolve();
}

describe('DataMgmtPage', () => {
  it('渲染数据管理页三个面板，不包含交火模式索引管理', async () => {
    const { mount } = await mountDataMgmtPage();

    const page = document.querySelector('.acu-v2-data-mgmt-page');
    expect(page).not.toBeNull();
    const text = page!.textContent || '';
    expect(document.querySelector('.acu-v2-app__page-title')?.textContent?.trim()).toBe('数据管理');
    expect(text).toContain('数据隔离');
    expect(text).toContain('备份与恢复');
    expect(text).toContain('删除与清理');
    expect(text).toContain('删除当前标识注入条目');
    expect(text).not.toContain('交火模式索引管理');
    expect(text).not.toContain('删除当前交火索引');
    expect(text).not.toContain('清空临时缓存');

    mount.__resetAcuV2MountForTests();
  });

  it('数据隔离面板承载标识应用和当前标识注入条目清理', async () => {
    const { mount } = await mountDataMgmtPage();

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const labels = Array.from(isolationPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__actions button'))
      .map(button => button.textContent?.trim() || '');

    expect(labels).toEqual(['删除当前标识注入条目', '保存并应用']);

    mount.__resetAcuV2MountForTests();
  });

  it('每个面板都渲染常驻说明信息条', async () => {
    const { mount } = await mountDataMgmtPage();

    const panels = document.querySelectorAll('.acu-v2-data-mgmt-page .acu-panel');
    expect(panels.length).toBe(3);
    panels.forEach(panel => {
      expect(panel.querySelector('.acu-panel__description-region .acu-info-banner')).not.toBeNull();
      expect(panel.querySelector('.acu-panel__header .acu-info-banner')).toBeNull();
    });

    mount.__resetAcuV2MountForTests();
  });

  it('左列放数据隔离和备份恢复，右列放删除清理', async () => {
    const { mount } = await mountDataMgmtPage();

    const columns = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page__panel-stack'));
    expect(columns).toHaveLength(2);

    const leftTitles = Array.from(columns[0].querySelectorAll<HTMLElement>('.acu-panel__title'))
      .map(title => title.textContent?.trim() || '');
    const rightTitles = Array.from(columns[1].querySelectorAll<HTMLElement>('.acu-panel__title'))
      .map(title => title.textContent?.trim() || '');

    expect(leftTitles).toEqual(['数据隔离', '备份与恢复']);
    expect(rightTitles).toEqual(['删除与清理']);

    mount.__resetAcuV2MountForTests();
  });

  it('删除与清理面板分为自动清理和手动删除', async () => {
    const { mount } = await mountDataMgmtPage();

    const cleanupPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'))!;
    const sectionTitles = Array.from(cleanupPanel.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page__section-title'))
      .map(title => title.textContent?.trim() || '');

    expect(sectionTitles).toEqual(['自动清理', '手动删除']);
    expect(cleanupPanel.textContent || '').toContain('保留数据层数');
    expect(cleanupPanel.textContent || '').toContain('删除当前标识本地数据');
    expect(cleanupPanel.textContent || '').toContain('恢复默认配置');

    mount.__resetAcuV2MountForTests();
  });

  it('数据隔离面板不再使用统计列表，历史标识收进折叠列表', async () => {
    const { mount } = await mountDataMgmtPage();

    const panels = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'));
    const isolationPanel = panels.find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'));
    const backupPanel = panels.find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('备份与恢复'));
    const cleanupPanel = panels.find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'));

    expect(isolationPanel?.querySelector('.acu-stats')).toBeNull();
    expect(isolationPanel?.querySelector('.acu-v2-data-mgmt-page__history')).not.toBeNull();
    expect(isolationPanel?.textContent || '').toContain('当前正在使用：alpha');
    expect(backupPanel?.querySelector('.acu-stats')).toBeNull();
    expect(cleanupPanel?.querySelector('.acu-stats')).toBeNull();
    expect(backupPanel?.querySelector('.acu-v2-data-mgmt-page__meta')).toBeNull();
    expect(cleanupPanel?.querySelector('.acu-v2-data-mgmt-page__meta')?.textContent).toContain('当前聊天 2 个 AI 楼层');

    mount.__resetAcuV2MountForTests();
  });

  it('全局 header 展示当前页标题，页面内不再渲染重复 header', async () => {
    const { mount } = await mountDataMgmtPage();

    expect(document.querySelector('.acu-v2-data-mgmt-page .acu-page-header')).toBeNull();
    const globalTitle = document.querySelector('.acu-v2-app__page-title');
    expect(globalTitle?.textContent?.trim()).toBe('数据管理');

    mount.__resetAcuV2MountForTests();
  });

  it('历史标识选择后保存并应用会切换隔离 profile', async () => {
    const { mount, switchIsolation } = await mountDataMgmtPage();

    const historyToggle = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page .acu-disclosure-group__header'))
      .find(button => button.textContent?.includes('历史标识'))!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));
    const beta = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__history-fill'))
      .find(item => item.textContent?.includes('beta'));
    expect(beta).not.toBeUndefined();
    beta!.click();
    await new Promise(r => setTimeout(r, 0));

    const applyButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('保存并应用'));
    expect(applyButton).not.toBeUndefined();
    applyButton!.click();
    await new Promise(r => setTimeout(r, 0));

    expect(switchIsolation).toHaveBeenCalledWith('beta');

    mount.__resetAcuV2MountForTests();
  });

  it('输入任意新标识后保存会刷新当前标识和历史列表', async () => {
    const { mount, switchIsolation } = await mountDataMgmtPage();
    const newCode = 'custom-profile';

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const codeInput = isolationPanel.querySelector<HTMLInputElement>('input[type="text"]')!;
    codeInput.value = newCode;
    codeInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    const applyButton = Array.from(isolationPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__actions button'))
      .find(button => button.textContent?.includes('保存并应用'))!;
    applyButton.click();
    await new Promise(r => setTimeout(r, 0));

    expect(switchIsolation).toHaveBeenCalledWith(newCode);
    expect(document.body.textContent || '').toContain(`已切换到 ${newCode}。`);
    expect(isolationPanel.textContent || '').toContain(`当前正在使用：${newCode}`);

    const historyToggle = isolationPanel.querySelector<HTMLButtonElement>('.acu-disclosure-group__header')!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));
    const options = Array.from(isolationPanel.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page__history-fill'))
      .map(item => item.textContent?.trim() || '');
    expect(options.some(item => item.includes(newCode))).toBe(true);

    mount.__resetAcuV2MountForTests();
  });

  it('历史标识行内可以删除选中的历史记录', async () => {
    const { mount, removeHistory } = await mountDataMgmtPage();

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const historyToggle = isolationPanel.querySelector<HTMLButtonElement>('.acu-disclosure-group__header')!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));

    const removeButton = isolationPanel.querySelector<HTMLButtonElement>('button[aria-label="删除历史标识：beta"]');
    expect(removeButton).not.toBeNull();
    expect(removeButton!.disabled).toBe(false);
    removeButton!.click();
    await new Promise(r => setTimeout(r, 0));

    expect(removeHistory).toHaveBeenCalledWith('beta');
    expect(document.body.textContent || '').toContain('已从历史记录移除标识：beta');

    mount.__resetAcuV2MountForTests();
  });

  it('删除当前正在使用的历史标识会先切回默认再移除历史', async () => {
    const { mount, switchIsolation, removeHistory } = await mountDataMgmtPage();

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const historyToggle = isolationPanel.querySelector<HTMLButtonElement>('.acu-disclosure-group__header')!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));

    const removeButton = isolationPanel.querySelector<HTMLButtonElement>('button[aria-label="删除历史标识：alpha"]')!;
    removeButton.click();
    await new Promise(r => setTimeout(r, 0));

    expect(switchIsolation).toHaveBeenCalledWith('');
    expect(removeHistory).toHaveBeenCalledWith('alpha');
    expect(document.body.textContent || '').toContain('已从历史记录移除标识：alpha；当前已切换到默认数据（未隔离）。');
    expect(isolationPanel.textContent || '').toContain('当前正在使用：默认数据（未隔离）');

    mount.__resetAcuV2MountForTests();
  });

  it('删除当前标识本地数据会保存范围并调用清理链路', async () => {
    const { mount, deleteLocalData, cleanupWorldbook, loadOrCreate, refreshMerged, saveSettings } = await mountDataMgmtPage();

    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('删除当前标识本地数据'));
    expect(deleteButton).not.toBeUndefined();
    deleteButton!.click();
    await clickDialogButton('删除数据');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(saveSettings).toHaveBeenCalled();
    expect(deleteLocalData).toHaveBeenCalledWith('current', 1, null);
    expect(loadOrCreate).toHaveBeenCalled();
    expect(refreshMerged).toHaveBeenCalled();
    expect(cleanupWorldbook).toHaveBeenCalled();
    expect(document.body.textContent || '').toContain('已删除 2 条消息中的本地数据');

    mount.__resetAcuV2MountForTests();
  });

  it('删除当前标识注入条目会调用世界书注入条目删除链路', async () => {
    const { mount, deleteGenerated } = await mountDataMgmtPage();

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const cleanupPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'))!;
    const isolationButtons = Array.from(isolationPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__actions button'));
    const localDataButtons = Array.from(cleanupPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__command-grid--cleanup button'));
    expect(localDataButtons.map(button => button.textContent?.trim() || '')).toEqual([
      '删除当前标识本地数据',
      '删除所有本地数据',
      '恢复默认配置',
    ]);
    const button = isolationButtons
      .find(item => item.textContent?.includes('删除当前标识注入条目'));
    expect(button).not.toBeUndefined();
    button!.click();
    await clickDialogButton('删除注入条目');
    await new Promise(r => setTimeout(r, 0));

    expect(deleteGenerated).toHaveBeenCalled();
    expect(document.body.textContent || '').toContain('已删除当前标识对应的数据库注入条目。');

    mount.__resetAcuV2MountForTests();
  });

  it('删除与清理面板可以保存自动保留本地数据层数', async () => {
    const { mount, settings, saveSettings } = await mountDataMgmtPage();

    const cleanupPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'))!;
    const retentionRow = Array.from(cleanupPanel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('保留数据层数'))!;
    const input = retentionRow.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.value = '30';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    expect(settings.retainRecentLayers).toBe(30);
    expect(saveSettings).toHaveBeenCalled();
    expect(document.body.textContent || '').not.toContain('自动清理策略已保存：保留最近 30 层本地数据。');

    mount.__resetAcuV2MountForTests();
  });

  it('恢复默认配置会恢复模板提示词并清理当前聊天快照、剧情预设和锁', async () => {
    const {
      mount,
      settings,
      chat,
      applyTemplate,
      saveSettings,
      saveChatToHost,
      loadOrCreate,
      refreshMerged,
    } = await mountDataMgmtPage();

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(item => item.textContent?.includes('恢复默认配置'));
    expect(button).not.toBeUndefined();
    button!.click();
    await Promise.resolve();

    const dialogText = document.querySelector('.acu-dialog-layer')?.textContent || '';
    expect(dialogText).toContain('默认表格模板与提示词');
    expect(dialogText).toContain('合并总结提示词');
    expect(dialogText).toContain('当前聊天表格模板快照');
    expect(dialogText).toContain('当前聊天剧情推进预设快照');
    expect(dialogText).toContain('当前聊天表格锁');
    expect(dialogText).not.toContain('表格选择状态');
    expect(dialogText).not.toContain('手动填表选择状态');
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]'))
      .every(item => item.getAttribute('aria-checked') === 'true')).toBe(true);

    await clickDialogButton('按所选项目恢复');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(applyTemplate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      scope: 'global',
      source: 'v2_reset_all_defaults',
      presetName: '',
      persistChatScope: false,
    }));
    expect(saveSettings).toHaveBeenCalled();
    expect(saveChatToHost).toHaveBeenCalled();
    expect(loadOrCreate).toHaveBeenCalled();
    expect(refreshMerged).toHaveBeenCalled();

    expect(settings.tableKeyOrder).toEqual([]);
    expect(settings.manualSelectedTables).toEqual(['sheet_a']);
    expect(settings.hasManualSelection).toBe(true);
    expect(settings.importSelectedTables).toEqual(['sheet_b']);
    expect(settings.hasImportTableSelection).toBe(true);
    expect(settings.mergeSummaryPrompt).toBe(DEFAULT_MERGE_SUMMARY_PROMPT_ACU);
    expect(settings.tableUpdateLocks['chat-data::alpha']).toBeUndefined();
    expect(settings.tableUpdateLocks['other-chat::alpha']).toBeDefined();
    expect(settings.specialIndexLocks['chat-data::alpha']).toBeUndefined();
    expect(settings.specialIndexLocks['chat-data::beta']).toBeDefined();
    expect(settings.plotPresetBindings['chat-data']).toBeUndefined();
    expect(settings.plotPresetBindings['other-chat']).toBeDefined();
    expect(settings.plotSettings.promptPresets.map((preset: any) => preset.name)).toContain('全局推进');

    const first = chat[0];
    expect(first.TavernDB_ACU_ScopedConfig.plot).toBeUndefined();
    expect(first.TavernDB_ACU_ScopedConfig.template.alpha).toBeUndefined();
    expect(first.TavernDB_ACU_ScopedConfig.template.beta).toBeDefined();
    expect(first.TavernDB_ACU_ScopedConfig.templateArchives.alpha).toBeUndefined();
    expect(first.TavernDB_ACU_ScopedConfig.templateArchives.beta).toBeDefined();
    expect(first.TavernDB_ACU_InternalSheetGuide.tags.alpha).toBeUndefined();
    expect(first.TavernDB_ACU_InternalSheetGuide.tags.beta).toBeDefined();
    expect(first.TavernDB_ACU_TableHeaderGuide.tags.alpha).toBeUndefined();
    expect(first.TavernDB_ACU_TableHeaderGuide.tags.beta).toBeDefined();
    expect(document.body.textContent || '').toContain('已按所选项目恢复默认配置。');

    mount.__resetAcuV2MountForTests();
  });

  it('恢复默认配置多选弹窗取消部分项目后会保留对应状态', async () => {
    const {
      mount,
      settings,
      chat,
      applyTemplate,
      saveChatToHost,
    } = await mountDataMgmtPage();

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(item => item.textContent?.includes('恢复默认配置'));
    expect(button).not.toBeUndefined();
    button!.click();
    await Promise.resolve();
    await clickDialogCheckbox('当前聊天表格锁');
    await clickDialogButton('按所选项目恢复');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(applyTemplate).toHaveBeenCalled();
    expect(saveChatToHost).toHaveBeenCalled();
    expect(settings.manualSelectedTables).toEqual(['sheet_a']);
    expect(settings.hasManualSelection).toBe(true);
    expect(settings.importSelectedTables).toEqual(['sheet_b']);
    expect(settings.hasImportTableSelection).toBe(true);
    expect(settings.tableUpdateLocks['chat-data::alpha']).toBeDefined();
    expect(settings.specialIndexLocks['chat-data::alpha']).toBeDefined();
    expect(settings.tableKeyOrder).toEqual([]);
    expect(settings.plotPresetBindings['chat-data']).toBeUndefined();

    const first = chat[0];
    expect(first.TavernDB_ACU_ScopedConfig.plot).toBeUndefined();
    expect(first.TavernDB_ACU_ScopedConfig.template.alpha).toBeUndefined();

    mount.__resetAcuV2MountForTests();
  });

  it('模板覆盖最新层数据会先同步当前聊天生效模板再执行覆盖链路', async () => {
    const { mount, applyTemplateScope, overrideLatest, loadOrCreate, refreshMerged } = await mountDataMgmtPage();

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(item => item.textContent?.includes('模板覆盖最新层数据'));
    expect(button).not.toBeUndefined();
    button!.click();
    await clickDialogButton('覆盖数据');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(applyTemplateScope).toHaveBeenCalledTimes(1);
    expect(overrideLatest).toHaveBeenCalledTimes(1);
    expect(applyTemplateScope.mock.invocationCallOrder[0]).toBeLessThan(overrideLatest.mock.invocationCallOrder[0]);
    expect(loadOrCreate).toHaveBeenCalled();
    expect(refreshMerged).toHaveBeenCalled();
    expect(document.body.textContent || '').toContain('已使用当前生效模板覆盖最新 AI 楼层的 3 个表格。');

    mount.__resetAcuV2MountForTests();
  });

  it('备份与恢复面板导出合并配置和 JSON 数据使用普通按钮', async () => {
    const { mount } = await mountDataMgmtPage();

    const panel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('备份与恢复'));
    expect(panel).not.toBeUndefined();

    const commandGrid = panel!.querySelector('.acu-v2-data-mgmt-page__command-grid');
    expect(commandGrid).not.toBeNull();
    const buttons = Array.from(commandGrid!.querySelectorAll<HTMLButtonElement>('button'));
    const labels = buttons.map(button => button.textContent?.trim() || '').filter(Boolean);
    expect(labels).toEqual([
      '合并导入（模板+指令）',
      '合并导出（模板+指令）',
      '特殊导出',
      '模板覆盖最新层数据',
    ]);
    expect(buttons.find(button => button.textContent?.includes('特殊导出'))?.classList.contains('acu-btn--default')).toBe(true);
    expect(buttons.find(button => button.textContent?.includes('模板覆盖最新层数据'))?.classList.contains('acu-btn--default')).toBe(true);
    expect(buttons.find(button => button.textContent?.includes('合并导入（模板+指令）'))?.classList.contains('acu-btn--block')).toBe(true);

    const checkpointSection = panel!.querySelector('.acu-v2-data-mgmt-page__checkpoint-section');
    expect(checkpointSection).not.toBeNull();
    expect(checkpointSection?.textContent).toContain('导出 Checkpoint');
    expect(checkpointSection?.textContent).toContain('导入 Checkpoint');
    expect(checkpointSection?.textContent).toContain('全部 AI 楼层、所有隔离标识');
    expect(checkpointSection?.textContent).toContain('当前激活隔离键的最新 AI 楼层');
    expect(checkpointSection?.textContent).toContain('后续更新将使用该模板');
    expect(checkpointSection?.textContent).toContain('全局模板和聊天正文不变');

    mount.__resetAcuV2MountForTests();
  });

  it('导出 Checkpoint 文件名清洗非法字符并附加固定时间戳', async () => {
    const { mount, buildCheckpoint } = await mountDataMgmtPage('alpha/beta:*?gamma');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 12, 21, 18, 41));
    const panel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('备份与恢复'));
    const checkpointSection = panel!.querySelector('.acu-v2-data-mgmt-page__checkpoint-section');
    const exportButton = Array.from(checkpointSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('导出 Checkpoint'));

    exportButton!.click();

    expect(buildCheckpoint).toHaveBeenCalledTimes(1);
    expect(capturedDownloads).toEqual(['TavernDB_checkpoint_alpha_beta_gamma_20260712-211841.json']);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:acu-test');

    vi.useRealTimers();
    mount.__resetAcuV2MountForTests();
  });

  it('导入 Checkpoint 在危险确认前不会触发恢复', async () => {
    const { mount, parseCheckpoint, restoreCheckpoint } = await mountDataMgmtPage();
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('.acu-v2-data-mgmt-page__checkpoint-section input[type="file"]'))[0];
    expect(input).toBeDefined();
    const file = new File(['{}'], 'checkpoint.json', { type: 'application/json' });
    Object.defineProperty(input!, 'files', { configurable: true, value: [file] });
    Object.defineProperty(FileReader.prototype, 'readAsText', {
      configurable: true,
      value: function(this: FileReader) {
        Object.defineProperty(this, 'result', { configurable: true, value: '{}' });
        this.onload?.(new ProgressEvent('load'));
      },
    });
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    expect(parseCheckpoint).toHaveBeenCalledWith('{}');
    expect(document.querySelector('.acu-dialog-layer')?.textContent).toContain('恢复当前聊天 Checkpoint');
    expect(document.querySelector('.acu-dialog-layer')?.textContent).toContain('来源模式：native；目标模式：native');
    expect(document.querySelector('.acu-dialog-layer')?.textContent).toContain('全部 AI 楼层、所有隔离标识');
    expect(document.querySelector('.acu-dialog-layer')?.textContent).toContain('当前激活隔离键的最新 AI 楼层');
    expect(document.querySelector('.acu-dialog-layer')?.textContent).toContain('后续更新将使用该模板');
    expect(document.querySelector('.acu-dialog-layer')?.textContent).toContain('全局模板和聊天正文不变');
    expect(restoreCheckpoint).not.toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('恢复 Checkpoint 按完整成功、部分成功和失败反馈真实状态', async () => {
    const { mount, restoreCheckpoint, settings } = await mountDataMgmtPage();
    const file = new File(['{}'], 'checkpoint.json', { type: 'application/json' });
    Object.defineProperty(FileReader.prototype, 'readAsText', {
      configurable: true,
      value: function(this: FileReader) {
        Object.defineProperty(this, 'result', { configurable: true, value: '{}' });
        this.onload?.(new ProgressEvent('load'));
      },
    });

    restoreCheckpoint.mockResolvedValueOnce({
      success: true, restoredMessageIndex: 1,
      postCondition: { runtimeMatches: true, scopeIsChatOverride: true, templateMatches: true, guideMatches: true, providerMode: 'native' },
    });
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('.acu-v2-data-mgmt-page__checkpoint-section input[type="file"]'))[0];
    Object.defineProperty(input!, 'files', { configurable: true, value: [file] });
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    await clickDialogButton('恢复 Checkpoint');
    expect(document.querySelector('.acu-v2-toast--success')?.textContent).toContain('实际存储：native');

    restoreCheckpoint.mockResolvedValueOnce({
      success: true, restoredMessageIndex: 1, derivedRefreshWarnings: ['世界书刷新失败'], cleanupWarnings: ['向量 manifest 清理失败'],
      postCondition: { runtimeMatches: false, scopeIsChatOverride: true, templateMatches: false, guideMatches: true, providerMode: 'native' },
    });
    const partialInput = Array.from(document.querySelectorAll<HTMLInputElement>('.acu-v2-data-mgmt-page__checkpoint-section input[type="file"]'))[0];
    Object.defineProperty(partialInput!, 'files', { configurable: true, value: [file] });
    partialInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    await clickDialogButton('恢复 Checkpoint');
    expect(document.querySelector('.acu-v2-toast--warning')?.textContent).toContain('部分成功');
    expect(document.querySelector('.acu-v2-toast--warning')?.textContent).toContain('运行时数据不一致');
    expect(document.querySelector('.acu-v2-toast--warning')?.textContent).toContain('聊天模板快照不一致');
    expect(document.querySelector('.acu-v2-toast--warning')?.textContent).toContain('派生刷新：世界书刷新失败');
    expect(document.querySelector('.acu-v2-toast--warning')?.textContent).toContain('清理：向量 manifest 清理失败');

    settings.storageMode = 'sqlite';
    restoreCheckpoint.mockResolvedValueOnce({
      success: true, restoredMessageIndex: 1,
      postCondition: { runtimeMatches: true, scopeIsChatOverride: true, templateMatches: true, guideMatches: true, providerMode: 'native' },
    });
    const fallbackInput = Array.from(document.querySelectorAll<HTMLInputElement>('.acu-v2-data-mgmt-page__checkpoint-section input[type="file"]'))[0];
    Object.defineProperty(fallbackInput!, 'files', { configurable: true, value: [file] });
    fallbackInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    await clickDialogButton('恢复 Checkpoint');
    const warningToasts = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-toast--warning'));
    expect(warningToasts.at(-1)?.textContent).toContain('目标设置为 SQLite，实际存储 fallback 为 native');

    restoreCheckpoint.mockResolvedValueOnce({ success: true, restoredMessageIndex: 1 });
    const missingConditionInput = Array.from(document.querySelectorAll<HTMLInputElement>('.acu-v2-data-mgmt-page__checkpoint-section input[type="file"]'))[0];
    Object.defineProperty(missingConditionInput!, 'files', { configurable: true, value: [file] });
    missingConditionInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    await clickDialogButton('恢复 Checkpoint');
    const finalWarningToasts = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-toast--warning'));
    expect(finalWarningToasts.at(-1)?.textContent).toContain('恢复后置条件缺失');

    restoreCheckpoint.mockResolvedValueOnce({ success: false, error: 'strict failed' });
    const failedInput = Array.from(document.querySelectorAll<HTMLInputElement>('.acu-v2-data-mgmt-page__checkpoint-section input[type="file"]'))[0];
    Object.defineProperty(failedInput!, 'files', { configurable: true, value: [file] });
    failedInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    await clickDialogButton('恢复 Checkpoint');
    expect(document.querySelector('.acu-v2-toast--error')?.textContent).toContain('恢复 Checkpoint 失败：strict failed');

    mount.__resetAcuV2MountForTests();
  });

  it('全页只保留删除所有本地数据为红色危险按钮', async () => {
    const { mount } = await mountDataMgmtPage();

    const dangerButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page button.acu-btn--danger'));
    expect(dangerButtons.map(button => button.textContent?.trim())).toEqual(['删除所有本地数据']);

    mount.__resetAcuV2MountForTests();
  });
});
