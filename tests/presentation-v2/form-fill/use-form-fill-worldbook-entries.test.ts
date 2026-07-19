/**
 * useFormFillWorldbookEntries 单元测试
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeEntry(uid: number, comment: string, enabled = true, type = 'selective') {
  return { uid, comment, name: comment, enabled, type };
}

function createWorldbookConfig() {
  return {
    source: 'character',
    manualSelection: [],
    enabledEntries: {},
  } as any;
}

let worldbookConfig: ReturnType<typeof createWorldbookConfig>;
const mockSaveSettings = vi.fn();
const mockGetEntries = vi.fn();
const mockGetAgentSnapshot = vi.fn(() => ({ active: false, selectionSignature: '', createdAt: 0, books: {} }));

async function getComposable(presetConfig?: ReturnType<typeof createWorldbookConfig>) {
  vi.resetModules();
  worldbookConfig = presetConfig || createWorldbookConfig();

  vi.doMock('../../../src/service/settings/settings-readers', () => ({
    getCurrentWorldbookConfig_ACU: () => worldbookConfig,
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    saveSettings_ACU: mockSaveSettings,
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    getLorebookEntriesByNames_ACU: mockGetEntries,
  }));
  vi.doMock('../../../src/service/agent/agent-worldbook-takeover', () => ({
    getPlotAgentWorldbookSnapshot_ACU: mockGetAgentSnapshot,
  }));
  vi.doMock('../../../src/service/agent/agent-worldbook-skill-meta', () => ({
    parseWorldbookSkillMetaFromComment_ACU: (comment: unknown) => String(comment || '').includes('ACU_SKILL_META_START')
      ? { description: '已 Skill 化', triggerWhen: '测试触发', tk: 0, updatedBy: 'manual', updatedAt: 1 }
      : null,
    stripWorldbookSkillMetaBlock_ACU: (comment: unknown) => String(comment || '').replace(/\n?<!--\s*ACU_SKILL_META_START\s*\n[\s\S]*?\nACU_SKILL_META_END\s*-->\n?/g, '').trim(),
  }));

  const mod = await import('../../../src/presentation-v2/composables/useFormFillWorldbookEntries');
  return mod.useFormFillWorldbookEntries();
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockSaveSettings.mockClear();
  mockGetEntries.mockClear();
  mockGetAgentSnapshot.mockReturnValue({ active: false, selectionSignature: '', createdAt: 0, books: {} });
});

describe('useFormFillWorldbookEntries', () => {
  it('首次加载默认启用可见条目但分组保持折叠', async () => {
    mockGetEntries.mockResolvedValue({
      'CharBook': [makeEntry(1, '人物'), makeEntry(2, '地点')],
    });

    const c = await getComposable();
    await c.loadEntries(['CharBook']);

    expect(c.groups.value).toHaveLength(1);
    expect(c.groups.value[0].expanded).toBe(false);
    expect(c.groups.value[0].entries.every(entry => entry.checked)).toBe(true);
    expect(worldbookConfig.enabledEntries['CharBook']).toEqual([1, 2]);
    expect(mockSaveSettings).toHaveBeenCalled();
  });

  it('显示并标记 constant 条目，首次加载不默认启用 disabled 条目', async () => {
    mockGetEntries.mockResolvedValue({
      'CharBook': [
        makeEntry(1, '人物'),
        makeEntry(2, '常驻设定', true, ' CONSTANT '),
        makeEntry(3, '关闭常驻', false, 'constant'),
      ],
    });

    const c = await getComposable();
    await c.loadEntries(['CharBook']);

    expect(c.groups.value[0].entries.map(entry => ({
      uid: entry.uid,
      checked: entry.checked,
      disabled: entry.disabled,
      isConstant: entry.isConstant,
    }))).toEqual([
      { uid: 1, checked: true, disabled: false, isConstant: false },
      { uid: 2, checked: true, disabled: false, isConstant: true },
      { uid: 3, checked: false, disabled: true, isConstant: true },
    ]);
    expect(worldbookConfig.enabledEntries.CharBook).toEqual([1, 2]);
  });

  it('已有空选择时按接管前状态展示受控条目，但不重新勾选用户取消的条目', async () => {
    worldbookConfig = createWorldbookConfig();
    worldbookConfig.enabledEntries = { CharBook: [] };
    mockGetAgentSnapshot.mockReturnValue({
      active: true,
      selectionSignature: 'test-selection',
      createdAt: 1,
      books: {
        CharBook: [
          { uid: 1, previousEnabled: true, previousKeys: ['旧关键词'], previousType: 'selective' },
          { uid: 2, previousEnabled: false, previousKeys: ['关闭关键词'], previousType: 'constant' },
        ],
      },
    });
    mockGetEntries.mockResolvedValue({
      CharBook: [
        { uid: 1, comment: '受控条目', name: '受控条目', enabled: false, type: 'selective', keys: [] },
        { uid: 2, comment: '原本关闭的受控条目', name: '原本关闭的受控条目', enabled: false, type: 'selective', keys: [] },
        makeEntry(3, 'TavernDB-ACU-应隐藏'),
        makeEntry(4, '外部导入-TavernDB-ACU-应显示'),
        makeEntry(5, 'ACU-[scope]-外部导入-TavernDB-ACU-应显示'),
        makeEntry(6, '普通规则条目'),
      ],
    });

    const c = await getComposable(worldbookConfig);
    await c.loadEntries(['CharBook']);

    expect(c.groups.value[0].entries.map(entry => ({
      uid: entry.uid,
      disabled: entry.disabled,
      isConstant: entry.isConstant,
      agentTakeoverState: entry.agentTakeoverState,
      checked: entry.checked,
    }))).toEqual([
      { uid: 1, disabled: false, isConstant: false, agentTakeoverState: 'taken_over', checked: false },
      { uid: 2, disabled: true, isConstant: true, agentTakeoverState: 'taken_over', checked: false },
      { uid: 4, disabled: false, isConstant: false, agentTakeoverState: 'native', checked: false },
      { uid: 5, disabled: false, isConstant: false, agentTakeoverState: 'native', checked: false },
    ]);
    expect(worldbookConfig.enabledEntries.CharBook).toEqual([]);
    c.selectAll();
    expect(worldbookConfig.enabledEntries.CharBook).toEqual([1, 4, 5]);
  });
});
