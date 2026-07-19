/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent } from 'vue';

const harness = vi.hoisted(() => ({
  setScope: vi.fn(async () => true),
  toggleScopeBook: vi.fn(async () => true),
  refreshControl: vi.fn(async () => undefined),
  loadEntries: vi.fn(async () => ['AgentBook']),
  refreshWorldbooks: vi.fn(async () => undefined),
  skillifySelected: vi.fn(async () => true),
  deselectAllForSkillify: vi.fn(),
}));

vi.mock('../../../src/presentation-v2/composables/usePlotWorldbookAgentControl', async () => {
  const { ref } = await import('vue');
  return {
    usePlotWorldbookAgentControl: () => ({
      worldbookScope: ref({ source: 'character', manualSelection: [] }),
      refresh: harness.refreshControl,
      setWorldbookScope: harness.setScope,
      toggleWorldbookScopeBook: harness.toggleScopeBook,
      skillifySelected: harness.skillifySelected,
      syncAgentWorldbookTakeoverAfterSkillChange: vi.fn(async () => true),
    }),
  };
});
vi.mock('../../../src/presentation-v2/composables/useAgentWorldbookEntries', async () => {
  const { ref } = await import('vue');
  return {
    useAgentWorldbookEntries: () => ({
      groups: ref([]), status: ref('success'), error: ref(''),
      loadEntries: harness.loadEntries, toggleSkillifyEntry: vi.fn(), toggleGroupExpanded: vi.fn(),
      selectAllForSkillify: vi.fn(), deselectAllForSkillify: harness.deselectAllForSkillify,
      getSelectedSkillifyEntries: () => [{ bookName: 'AgentBook', uid: 1 }],
      saveEntrySkillMeta: vi.fn(), deleteEntrySkillMeta: vi.fn(),
    }),
  };
});
vi.mock('../../../src/presentation-v2/composables/useWorldbookSelector', async () => {
  const { ref } = await import('vue');
  return { useWorldbookSelector: () => ({
    names: ref(['AgentBook']), charPrimary: ref('CharBook'), status: ref('success'), error: ref(''), refresh: harness.refreshWorldbooks,
  }) };
});
vi.mock('../../../src/presentation-v2/composables/useChatChangedListener', async () => {
  const { ref } = await import('vue');
  return { useChatChangedTick: () => ref(0) };
});
vi.mock('../../../src/presentation-v2/components/WorldbookAgentControlBar.vue', () => ({
  default: defineComponent({
    props: { agentControl: { type: Object, required: true } },
    template: '<div />',
  }),
}));

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('AgentPage', () => {
  it('显示独立 Agent Skill 操作，并将范围切换写入 Agent control', async () => {
    const Page = (await import('../../../src/presentation-v2/pages/AgentPage.vue')).default;
    const el = document.createElement('div');
    document.body.appendChild(el);
    const app = createApp(Page);
    app.mount(el);
    await Promise.resolve();

    expect(el.textContent).toContain('Agent 世界书');
    expect(el.textContent).toContain('Skill 全选');
    const toolbarButtons = Array.from(el.querySelectorAll<HTMLButtonElement>('.acu-v2-wb-entry-toolbar .acu-btn'))
      .map(button => button.textContent?.trim());
    expect(toolbarButtons).not.toContain('全选');
    expect(toolbarButtons).not.toContain('全不选');
    expect(toolbarButtons).toContain('Skill 全不选');

    const manual = Array.from(el.querySelectorAll<HTMLButtonElement>('.acu-segmented__item'))
      .find(button => button.textContent?.trim() === '手动选择');
    manual!.click();
    await Promise.resolve();
    expect(harness.setScope).toHaveBeenCalledWith('manual');

    app.unmount();
  });

  it('Skill 化完成后清空选择并立即重新加载当前面板条目', async () => {
    const Page = (await import('../../../src/presentation-v2/pages/AgentPage.vue')).default;
    const el = document.createElement('div');
    document.body.appendChild(el);
    const app = createApp(Page);
    app.mount(el);
    await Promise.resolve();
    await Promise.resolve();
    harness.loadEntries.mockClear();

    const skillifyButton = Array.from(el.querySelectorAll<HTMLButtonElement>('.acu-v2-wb-entry-toolbar .acu-btn'))
      .find(button => button.textContent?.trim() === '对所选 Skill 化');
    skillifyButton!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.skillifySelected).toHaveBeenCalledWith([{ bookName: 'AgentBook', uid: 1 }]);
    expect(harness.deselectAllForSkillify).toHaveBeenCalledTimes(1);
    expect(harness.loadEntries).toHaveBeenCalledTimes(1);

    app.unmount();
  });
});
