/**
 * tests/service/template/template-preset-service.test.ts
 * 模板预设业务逻辑 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStore, mockSettings } = vi.hoisted(() => {
  const mockStore: any = {};
  return {
    mockStore,
    mockSettings: { templatePresetName: '', dataIsolationEnabled: false } as any,
  };
});

vi.mock('../../../src/shared/data-constants', () => ({
  STORAGE_KEY_TEMPLATE_PRESETS_ACU: 'template_presets',
}));

vi.mock('../../../src/shared/defaults-json.js', () => ({
  DEFAULT_TABLE_TEMPLATE_ACU: '{"sheet_0":{"name":"默认表"}}',
  TABLE_TEMPLATE_ACU: '{"sheet_0":{"name":"当前表"}}',
  _set_TABLE_TEMPLATE_ACU: vi.fn(),
}));

vi.mock('../../../src/shared/template-preset-utils', () => ({
  DEFAULT_TEMPLATE_PRESET_OPTION_VALUE_ACU: '__default__',
  getCurrentTemplatePresetName_ACU: vi.fn(() => ''),
  isDefaultTemplatePresetSelection_ACU: vi.fn((v: string) => !v || v === '__default__'),
  normalizeTemplatePresetSelectionValue_ACU: vi.fn((v: string) => (v === '__default__' ? '' : (v || '').trim())),
}));

vi.mock('../../../src/data/storage/tavern-storage', () => ({
  getConfigStorage_ACU: vi.fn(() => ({
    getItem: (key: string) => mockStore[key] || null,
    setItem: (key: string, value: string) => { mockStore[key] = value; },
  })),
}));

vi.mock('../../../src/data/repositories/profile-repo', () => ({
  saveCurrentProfileTemplate_ACU: vi.fn(),
}));

vi.mock('../../../src/service/settings/settings-service', () => ({
  persistCurrentTemplatePresetName_ACU: vi.fn(),
  saveSettings_ACU: vi.fn(),
  applyTemplateScopeForCurrentChat_ACU: vi.fn(),
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  getCurrentIsolationKey_ACU: vi.fn(() => ''),
  settings_ACU: mockSettings,
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  saveChatToHost_ACU: vi.fn(),
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  activateChatTemplatePresetSelection_ACU: vi.fn(),
  buildChatSheetGuideDataFromTemplateObj_ACU: vi.fn(),
  buildChatTemplatePresetLinkState_ACU: vi.fn(),
  buildChatTemplateScopeStateFromCurrent_ACU: vi.fn(),
  clearChatSheetGuideDataForIsolationKey_ACU: vi.fn(),
  getCurrentChatTemplateScopeState_ACU: vi.fn(() => null),
  getGlobalTemplateSnapshotForCurrentProfile_ACU: vi.fn(() => null),
  listChatTemplatePresetEntries_ACU: vi.fn(() => []),
  migrateLegacyTemplateScopeForCurrentChat_ACU: vi.fn(() => null),
  normalizeTemplateScopeIsolationKey_ACU: vi.fn((k: string) => k),
  normalizeTemplateScopeMode_ACU: vi.fn(() => 'inherit'),
  sanitizeChatSheetsObject_ACU: vi.fn((obj: any) => obj),
  sanitizeTemplateSnapshotForChat_ACU: vi.fn((obj: any) => obj ? { templateStr: JSON.stringify(obj) } : null),
  setCurrentChatTemplateScopeState_ACU: vi.fn(),
  upsertChatTemplatePresetEntry_ACU: vi.fn(),
}));

vi.mock('../../../src/service/worldbook/pipeline', () => ({
  refreshMergedDataAndNotify_ACU: vi.fn(),
}));

vi.mock('../../../src/shared/json-helpers', () => ({
  safeJsonParse_ACU: vi.fn((str: string, fb: any) => { try { return JSON.parse(str); } catch { return fb; } }),
  safeJsonStringify_ACU: vi.fn((obj: any, fb: string) => { try { return JSON.stringify(obj); } catch { return fb; } }),
}));

vi.mock('../../../src/shared/utils', () => ({
  logWarn_ACU: vi.fn(),
  logDebug_ACU: vi.fn(),
  ensureSheetOrderNumbers_ACU: vi.fn(),
  parseTableTemplateJson_ACU: vi.fn(() => ({ sheet_0: { name: '测试表' } })),
}));

vi.mock('../../../src/service/worldbook/injection-engine', () => ({
  buildDefaultExportConfig_ACU: vi.fn(() => ({})),
  ensureExportConfigDefaults_ACU: vi.fn((c: any) => c),
}));

import {
  listTemplatePresetNames_ACU,
  getTemplatePreset_ACU,
  upsertTemplatePreset_ACU,
  deleteTemplatePreset_ACU,
  getTemplatePresetDisplayName_ACU,
  ensureUniqueTemplatePresetName_ACU,
  normalizeTemplateOperationScope_ACU,
  resolveActiveTemplatePresetName_ACU,
  getActiveTemplatePresetMeta_ACU,
  normalizeTemplateForPresetSave_ACU,
  getDefaultTemplateSnapshot_ACU,
  parseImportedTemplateData_ACU,
  persistTemplateScopeSelectionState_ACU,
  applyTemplateSnapshotToScope_ACU,
  applyTemplatePresetToCurrent_ACU,
  resolveTemplateForExport_ACU,
} from '../../../src/service/template/template-preset-service';

import { saveSettings_ACU } from '../../../src/service/settings/settings-service';
import { getCurrentChatTemplateScopeState_ACU, sanitizeTemplateSnapshotForChat_ACU, getGlobalTemplateSnapshotForCurrentProfile_ACU, activateChatTemplatePresetSelection_ACU } from '../../../src/service/template/chat-scope';
import { getCurrentTemplatePresetName_ACU } from '../../../src/shared/template-preset-utils';
import { parseTableTemplateJson_ACU } from '../../../src/shared/utils';

beforeEach(() => {
  // 清空 mockStore
  Object.keys(mockStore).forEach(k => delete mockStore[k]);
});

// ═══ CRUD ═══
describe('listTemplatePresetNames_ACU', () => {
  it('无预设返回空数组', () => {
    expect(listTemplatePresetNames_ACU()).toEqual([]);
  });
  it('有预设返回排序后的名称', () => {
    mockStore.template_presets = JSON.stringify({
      version: 1,
      presets: { '预设B': { templateStr: '{}' }, '预设A': { templateStr: '{}' } },
    });
    const names = listTemplatePresetNames_ACU();
    expect(names).toEqual(['预设A', '预设B']);
  });
});

describe('getTemplatePreset_ACU', () => {
  it('找到预设返回对象', () => {
    mockStore.template_presets = JSON.stringify({
      version: 1,
      presets: { '预设A': { templateStr: '{"sheet_0":{}}', updatedAt: 1000 } },
    });
    const preset = getTemplatePreset_ACU('预设A');
    expect(preset).not.toBeNull();
    expect(preset!.templateStr).toContain('sheet_0');
  });
  it('未找到返回 null', () => {
    expect(getTemplatePreset_ACU('不存在')).toBeNull();
  });
  it('空名称返回 null', () => {
    expect(getTemplatePreset_ACU('')).toBeNull();
  });
});

describe('upsertTemplatePreset_ACU', () => {
  it('创建新预设', () => {
    const result = upsertTemplatePreset_ACU('新预设', '{"sheet_0":{}}');
    expect(result).toBe(true);
    const stored = JSON.parse(mockStore.template_presets);
    expect(stored.presets['新预设']).not.toBeUndefined();
    expect(stored.presets['新预设'].templateStr).toBe('{"sheet_0":{}}');
  });
  it('更新已有预设', () => {
    upsertTemplatePreset_ACU('预设A', '旧内容');
    upsertTemplatePreset_ACU('预设A', '新内容');
    const stored = JSON.parse(mockStore.template_presets);
    expect(stored.presets['预设A'].templateStr).toBe('新内容');
  });
  it('空名称返回 false', () => {
    expect(upsertTemplatePreset_ACU('', '{}')).toBe(false);
  });
});

describe('deleteTemplatePreset_ACU', () => {
  it('删除已有预设', () => {
    upsertTemplatePreset_ACU('预设A', '{}');
    const result = deleteTemplatePreset_ACU('预设A');
    expect(result).toBe(true);
    expect(getTemplatePreset_ACU('预设A')).toBeNull();
  });
  it('删除不存在的预设返回 false', () => {
    expect(deleteTemplatePreset_ACU('不存在')).toBe(false);
  });
  it('空名称返回 false', () => {
    expect(deleteTemplatePreset_ACU('')).toBe(false);
  });
});

// ═══ 纯逻辑工具函数 ═══
describe('getTemplatePresetDisplayName_ACU', () => {
  it('有名称返回名称', () => {
    expect(getTemplatePresetDisplayName_ACU('预设A')).toBe('预设A');
  });
  it('空名称返回默认预设', () => {
    expect(getTemplatePresetDisplayName_ACU('')).toBe('默认预设');
  });
  it('默认值标记返回默认预设', () => {
    expect(getTemplatePresetDisplayName_ACU('__default__')).toBe('默认预设');
  });
});

describe('ensureUniqueTemplatePresetName_ACU', () => {
  it('名称不冲突时原样返回', () => {
    expect(ensureUniqueTemplatePresetName_ACU('新预设')).toBe('新预设');
  });
  it('名称冲突时添加序号', () => {
    upsertTemplatePreset_ACU('预设A', '{}');
    const unique = ensureUniqueTemplatePresetName_ACU('预设A');
    expect(unique).toBe('预设A (2)');
  });
  it('空名称返回空字符串', () => {
    expect(ensureUniqueTemplatePresetName_ACU('')).toBe('');
  });
});

describe('normalizeTemplateOperationScope_ACU', () => {
  it('chat 返回 chat', () => {
    expect(normalizeTemplateOperationScope_ACU('chat')).toBe('chat');
  });
  it('其他值返回 global', () => {
    expect(normalizeTemplateOperationScope_ACU('global')).toBe('global');
    expect(normalizeTemplateOperationScope_ACU('')).toBe('global');
    expect(normalizeTemplateOperationScope_ACU('unknown')).toBe('global');
  });
});

// ═══ resolveActiveTemplatePresetName_ACU ═══
describe('resolveActiveTemplatePresetName_ACU', () => {
  it('无 chatScope 时回退到全局', () => {
    vi.mocked(getCurrentTemplatePresetName_ACU).mockReturnValueOnce('全局预设');
    expect(resolveActiveTemplatePresetName_ACU()).toBe('全局预设');
  });
  it('有 chatScope 时使用 chatScope 的 presetName', () => {
    vi.mocked(getCurrentChatTemplateScopeState_ACU).mockReturnValueOnce({ presetName: '聊天预设' } as any);
    expect(resolveActiveTemplatePresetName_ACU()).toBe('聊天预设');
  });
  it('fallbackToGlobal=false 且无 chatScope 时返回空', () => {
    expect(resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: false })).toBe('');
  });
});

// ═══ getActiveTemplatePresetMeta_ACU ═══
describe('getActiveTemplatePresetMeta_ACU', () => {
  it('返回包含 presetName 和 scope 的元数据', () => {
    const meta = getActiveTemplatePresetMeta_ACU();
    expect(meta).toHaveProperty('presetName');
    expect(meta).toHaveProperty('scope');
    expect(meta).toHaveProperty('displayName');
    expect(meta).toHaveProperty('mode');
    expect(meta).toHaveProperty('scopeLabel');
  });
  it('无 chatScope 时 scope 为 global', () => {
    const meta = getActiveTemplatePresetMeta_ACU();
    expect(meta.scope).toBe('global');
  });
});

// ═══ normalizeTemplateForPresetSave_ACU ═══
describe('normalizeTemplateForPresetSave_ACU', () => {
  it('正常模板返回 templateObj 和 templateStr', () => {
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValueOnce({ sheet_0: { name: '表' }, mate: { type: 'chatSheets' } });
    const result = normalizeTemplateForPresetSave_ACU();
    expect(result).not.toBeNull();
    expect(result!.templateObj).not.toBeNull();
    expect(result!.templateObj).toHaveProperty('sheet_0');
    expect(result!.templateStr).toContain('sheet_0');
  });
  it('parseTableTemplateJson 返回 null 时返回 null', () => {
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValueOnce(null);
    expect(normalizeTemplateForPresetSave_ACU()).toBeNull();
  });
});

// ═══ getDefaultTemplateSnapshot_ACU ═══
describe('getDefaultTemplateSnapshot_ACU', () => {
  it('返回默认模板快照', () => {
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValueOnce({ templateStr: '{"sheet_0":{}}', templateObj: { sheet_0: {} } } as any);
    const result = getDefaultTemplateSnapshot_ACU();
    expect(result).not.toBeNull();
    expect(result!.templateStr).toBe('{"sheet_0":{}}');
  });
});

// ═══ parseImportedTemplateData_ACU ═══
describe('parseImportedTemplateData_ACU', () => {
  it('有效 JSON 字符串解析成功', () => {
    const validTemplate = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_0: { name: '表1', content: [[]], sourceData: {} },
    };
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValueOnce({
      templateStr: JSON.stringify(validTemplate),
      templateObj: validTemplate,
    } as any);
    const result = parseImportedTemplateData_ACU(JSON.stringify(validTemplate));
    expect(result).toHaveProperty('snapshot');
    expect(result).toHaveProperty('templateObj');
    expect(result).toHaveProperty('templateStr');
  });
  it('无效 JSON 抛出错误', () => {
    expect(() => parseImportedTemplateData_ACU('not json')).toThrow('JSON解析错误');
  });
  it('缺少 mate 抛出错误', () => {
    expect(() => parseImportedTemplateData_ACU('{"sheet_0":{}}')).toThrow('mate');
  });
  it('缺少 sheet 抛出错误', () => {
    expect(() => parseImportedTemplateData_ACU('{"mate":{"type":"chatSheets"}}')).toThrow('未找到任何表格');
  });
  it('sheet 结构不完整抛出错误', () => {
    const data = { mate: { type: 'chatSheets' }, sheet_0: { name: '表' } };
    expect(() => parseImportedTemplateData_ACU(data)).toThrow('结构不完整');
  });
  it('非字符串非对象抛出错误', () => {
    expect(() => parseImportedTemplateData_ACU(123)).toThrow('无效的模板数据');
  });
});

// ═══ persistTemplateScopeSelectionState_ACU ═══
describe('persistTemplateScopeSelectionState_ACU', () => {
  it('updateGlobal=true 时调用 saveSettings', () => {
    persistTemplateScopeSelectionState_ACU('预设A', { updateGlobal: true, save: true });
    expect(saveSettings_ACU).toHaveBeenCalled();
  });
  it('save=false 时不调用 saveSettings', () => {
    vi.mocked(saveSettings_ACU).mockClear();
    persistTemplateScopeSelectionState_ACU('预设A', { save: false });
    expect(saveSettings_ACU).not.toHaveBeenCalled();
  });
  it('返回规范化的预设名', () => {
    const result = persistTemplateScopeSelectionState_ACU('  预设B  ');
    expect(result).toBe('预设B');
  });
});

// ═══ applyTemplateSnapshotToScope_ACU ═══
describe('applyTemplateSnapshotToScope_ACU', () => {
  it('有效快照应用成功', async () => {
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValueOnce({
      templateStr: '{"sheet_0":{}}',
      templateObj: { sheet_0: {} },
    } as any);
    const result = await applyTemplateSnapshotToScope_ACU('{"sheet_0":{}}', { scope: 'global' });
    expect(result).toBeTruthy();
  });
  it('无效快照返回 false', async () => {
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValueOnce(null);
    const result = await applyTemplateSnapshotToScope_ACU(null);
    expect(result).toBe(false);
  });
});

// ═══ applyTemplatePresetToCurrent_ACU ═══
describe('applyTemplatePresetToCurrent_ACU', () => {
  it('默认预设应用成功', async () => {
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValue({
      templateStr: '{"sheet_0":{}}',
      templateObj: { sheet_0: {} },
    } as any);
    const result = await applyTemplatePresetToCurrent_ACU('', { updateGlobal: true });
    expect(result).toBeTruthy();
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockRestore();
  });
  it('不存在的预设返回 false', async () => {
    const result = await applyTemplatePresetToCurrent_ACU('不存在的预设', { updateGlobal: true });
    expect(result).toBe(false);
  });
  it('updateGlobal=false 时走 chat 路径', async () => {
    vi.mocked(activateChatTemplatePresetSelection_ACU).mockResolvedValueOnce({ presetName: 'A' } as any);
    const result = await applyTemplatePresetToCurrent_ACU('预设A', { updateGlobal: false });
    expect(result).toBeTruthy();
    expect(activateChatTemplatePresetSelection_ACU).toHaveBeenCalled();
  });

  it('聊天选择全局预设时物化为 chat_override 快照而不是 preset_link', async () => {
    vi.mocked(activateChatTemplatePresetSelection_ACU).mockClear();
    upsertTemplatePreset_ACU('预设A', '{"sheet_0":{"name":"全局表"}}');
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValue({
      templateStr: '{"sheet_0":{"name":"全局表"}}',
      templateObj: { sheet_0: { name: '全局表' } },
    } as any);

    const result = await applyTemplatePresetToCurrent_ACU('预设A', {
      updateGlobal: false,
      chatSelectionSource: 'global',
    });

    expect(result).toMatchObject({ mode: 'chat_override', fromGlobalPreset: true });
    expect(activateChatTemplatePresetSelection_ACU).not.toHaveBeenCalled();
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockRestore();
  });
});

// ═══ resolveTemplateForExport_ACU ═══
describe('resolveTemplateForExport_ACU', () => {
  it('global scope 有选中预设时从预设加载', () => {
    upsertTemplatePreset_ACU('导出预设', '{"sheet_0":{"name":"导出表"}}');
    const result = resolveTemplateForExport_ACU('global', '导出预设');
    expect(result).not.toBeNull();
    expect(result!.fromPresetName).toBe('导出预设');
  });
  it('global scope 无预设时回退到全局快照', () => {
    vi.mocked(getGlobalTemplateSnapshotForCurrentProfile_ACU).mockReturnValueOnce({
      templateObj: { sheet_0: { name: '全局表' } },
      templateStr: '{}',
    } as any);
    const result = resolveTemplateForExport_ACU('global');
    expect(result).not.toBeNull();
    expect(result!.jsonData).toHaveProperty('sheet_0');
  });
  it('chat scope 返回聊天级模板', () => {
    vi.mocked(getCurrentChatTemplateScopeState_ACU).mockReturnValueOnce({
      mode: 'chat_override',
      templateStr: '{"sheet_0":{"name":"聊天表"}}',
      presetName: '聊天预设',
    } as any);
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValueOnce({
      templateObj: { sheet_0: { name: '聊天表' } },
      templateStr: '{}',
    } as any);
    const result = resolveTemplateForExport_ACU('chat');
    expect(result).not.toBeNull();
  });
  it('所有来源都无数据时返回 null', () => {
    vi.mocked(getGlobalTemplateSnapshotForCurrentProfile_ACU).mockReturnValueOnce(null);
    vi.mocked(sanitizeTemplateSnapshotForChat_ACU).mockReturnValueOnce(null);
    vi.mocked(getGlobalTemplateSnapshotForCurrentProfile_ACU).mockReturnValueOnce(null);
    const result = resolveTemplateForExport_ACU('global');
    expect(result).toBeNull();
  });
});
