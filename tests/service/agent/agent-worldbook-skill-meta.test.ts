import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEntriesByBook, mockGetLorebookEntriesStrict, mockSetLorebookEntries, mockCreateLorebookEntries } = vi.hoisted(() => ({
  mockEntriesByBook: new Map<string, any[]>(),
  mockGetLorebookEntriesStrict: vi.fn(),
  mockSetLorebookEntries: vi.fn(async (bookName: string, patches: any[]) => {
    const patchByUid = new Map((patches || []).map(patch => [String(patch.uid), patch]));
    const entries = mockEntriesByBook.get(bookName) || [];
    mockEntriesByBook.set(bookName, entries.map(entry => {
      const patch = patchByUid.get(String(entry.uid));
      return patch ? { ...entry, ...patch } : entry;
    }));
  }),
  mockCreateLorebookEntries: vi.fn(async (bookName: string, entries: any[]) => {
    const current = mockEntriesByBook.get(bookName) || [];
    const nextUid = current.reduce((max, entry) => Math.max(max, Number(entry.uid) || 0), 0) + 1;
    mockEntriesByBook.set(bookName, [...current, ...(entries || []).map((entry, index) => ({ ...entry, uid: nextUid + index }))]);
  }),
}));

vi.mock('../../../src/data/gateways/worldbook-gateway', () => ({
  getLorebookEntries_ACU: vi.fn(async (bookName: string) => mockEntriesByBook.get(bookName) || []),
  setLorebookEntries_ACU: mockSetLorebookEntries,
  createLorebookEntries_ACU: mockCreateLorebookEntries,
}));

vi.mock('../../../src/service/worldbook/pipeline', () => ({
  getLorebookEntriesStrict_ACU: mockGetLorebookEntriesStrict,
}));

vi.mock('../../../src/service/agent/agent-worldbook-config-meta', () => ({
  readAgentWorldbookControlFromWorldbooks_ACU: vi.fn(),
  resolveAgentWorldbookScopeBookNames_ACU: vi.fn(),
}));

import {
  readAgentWorldbookControlFromWorldbooks_ACU,
  resolveAgentWorldbookScopeBookNames_ACU,
} from '../../../src/service/agent/agent-worldbook-config-meta';
import {
  clearWorldbookSkillMetaBlocks_ACU,
  listWorldbookSkillMetas_ACU,
  saveWorldbookEntrySkillMeta_ACU,
  hasUsableWorldbookSkillMeta_ACU,
  resolveAgentWorldbookFilterAvailability_ACU,
} from '../../../src/service/agent/agent-worldbook-skill-meta';

const skillBlock = '<!-- ACU_SKILL_META_START\n{"version":1,"description":"描述","triggerWhen":"触发","tk":12,"updatedAt":1,"updatedBy":"agent-skillify"}\nACU_SKILL_META_END -->';
const takeoverBlock = '<!-- ACU_AGENT_WORLDBOOK_TAKEOVER_META_START\n{"previousEnabled":true}\nACU_AGENT_WORLDBOOK_TAKEOVER_META_END -->';

describe('hasUsableWorldbookSkillMeta_ACU', () => {
  it('accepts skill meta when description, triggerWhen, or tk is usable', () => {
    expect(hasUsableWorldbookSkillMeta_ACU(skillBlock)).toBe(true);
    expect(hasUsableWorldbookSkillMeta_ACU('<!-- ACU_SKILL_META_START\n{"version":1,"description":"仅描述","triggerWhen":"","tk":0,"updatedAt":1,"updatedBy":"manual"}\nACU_SKILL_META_END -->')).toBe(true);
    expect(hasUsableWorldbookSkillMeta_ACU('<!-- ACU_SKILL_META_START\n{"version":1,"description":"","triggerWhen":"仅触发","tk":0,"updatedAt":1,"updatedBy":"manual"}\nACU_SKILL_META_END -->')).toBe(true);
    expect(hasUsableWorldbookSkillMeta_ACU('<!-- ACU_SKILL_META_START\n{"version":1,"description":"","triggerWhen":"","tk":3,"updatedAt":1,"updatedBy":"manual"}\nACU_SKILL_META_END -->')).toBe(true);
  });

  it('rejects missing, invalid, or empty skill meta blocks', () => {
    expect(hasUsableWorldbookSkillMeta_ACU('普通条目')).toBe(false);
    expect(hasUsableWorldbookSkillMeta_ACU('<!-- ACU_SKILL_META_START\n{"version":2,"description":"描述","triggerWhen":"触发","tk":12}\nACU_SKILL_META_END -->')).toBe(false);
    expect(hasUsableWorldbookSkillMeta_ACU('<!-- ACU_SKILL_META_START\n{"version":1,"description":"","triggerWhen":"","tk":0,"updatedAt":1,"updatedBy":"manual"}\nACU_SKILL_META_END -->')).toBe(false);
    expect(hasUsableWorldbookSkillMeta_ACU('<!-- ACU_SKILL_META_START\nnot-json\nACU_SKILL_META_END -->')).toBe(false);
  });
});

describe('clearWorldbookSkillMetaBlocks_ACU', () => {
  beforeEach(() => {
    mockEntriesByBook.clear();
    mockSetLorebookEntries.mockClear();
    mockCreateLorebookEntries.mockClear();
    vi.mocked(readAgentWorldbookControlFromWorldbooks_ACU).mockReset();
    vi.mocked(resolveAgentWorldbookScopeBookNames_ACU).mockReset();
  });

  it('clears only ACU skill meta blocks and keeps config/takeover comments untouched', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, comment: `普通条目\n${skillBlock}\n${takeoverBlock}` },
      { uid: 2, comment: 'TavernDB-ACU-AgentWorldbookConfig' },
      { uid: 3, comment: `仅接管\n${takeoverBlock}` },
    ]);

    const result = await clearWorldbookSkillMetaBlocks_ACU(['角色A世界书']);

    expect(result).toMatchObject({ total: 1, cleared: 1, skipped: 0, failed: 0, errors: [] });
    expect(mockSetLorebookEntries).toHaveBeenCalledTimes(1);
    const entries = mockEntriesByBook.get('角色A世界书') || [];
    expect(entries[0].comment).not.toContain('ACU_SKILL_META_START');
    expect(entries[0].comment).toContain('ACU_AGENT_WORLDBOOK_TAKEOVER_META_START');
    expect(entries[1].comment).toBe('TavernDB-ACU-AgentWorldbookConfig');
    expect(entries[2].comment).toContain('ACU_AGENT_WORLDBOOK_TAKEOVER_META_START');
  });

  it('does not scan or write when book names are empty', async () => {
    const result = await clearWorldbookSkillMetaBlocks_ACU();

    expect(result).toMatchObject({ total: 0, cleared: 0, skipped: 0, failed: 0, errors: [] });
    expect(mockSetLorebookEntries).not.toHaveBeenCalled();
  });
});

describe('worldbook Skill registry persistence', () => {
  beforeEach(() => {
    mockEntriesByBook.clear();
    mockSetLorebookEntries.mockClear();
    mockCreateLorebookEntries.mockClear();
  });

  it('首次读取会把旧 comment Skill 块迁移到隐藏注册表并恢复原条目名', async () => {
    mockEntriesByBook.set('数据库世界书', [
      { uid: 7, comment: `各阵营科技映射\n\n${skillBlock}`, enabled: false, keys: ['科技'] },
    ]);

    const metas = await listWorldbookSkillMetas_ACU(['数据库世界书']);

    expect(metas).toEqual([expect.objectContaining({ bookName: '数据库世界书', uid: 7, label: '各阵营科技映射' })]);
    const entries = mockEntriesByBook.get('数据库世界书') || [];
    expect(entries.find(entry => entry.uid === 7)?.comment).toBe('各阵营科技映射');
    const registry = entries.find(entry => entry.comment === 'TavernDB-ACU-AgentWorldbookSkillRegistry');
    expect(JSON.parse(registry.content).skills).toEqual([
      expect.objectContaining({ uid: 7, comment: '各阵营科技映射', meta: expect.objectContaining({ description: '描述' }) }),
    ]);
  });

  it('数据库重建导致 uid 变化后仍按稳定条目名找回 Skill', async () => {
    mockEntriesByBook.set('数据库世界书', [
      { uid: 99, comment: '各阵营科技映射', enabled: true, keys: ['科技'] },
      {
        uid: 100,
        comment: 'TavernDB-ACU-AgentWorldbookSkillRegistry',
        content: JSON.stringify({
          version: 1,
          kind: 'agent_worldbook_skill_registry',
          updatedAt: 1,
          skills: [{ uid: 7, comment: '各阵营科技映射', meta: { version: 1, description: '描述', triggerWhen: '触发', tk: 12, updatedAt: 1, updatedBy: 'agent-skillify' } }],
        }),
      },
    ]);

    const metas = await listWorldbookSkillMetas_ACU(['数据库世界书']);

    expect(metas).toEqual([expect.objectContaining({ uid: 99, label: '各阵营科技映射', skillMeta: expect.objectContaining({ description: '描述' }) })]);
  });

  it('并发保存多个 Skill 时合并注册表且不修改原条目名', async () => {
    mockEntriesByBook.set('数据库世界书', [
      { uid: 1, comment: '人物条目', enabled: true },
      { uid: 2, comment: '科技条目', enabled: true },
    ]);

    await Promise.all([
      saveWorldbookEntrySkillMeta_ACU('数据库世界书', 1, { description: '人物描述', triggerWhen: '人物出现' }, 'agent-skillify'),
      saveWorldbookEntrySkillMeta_ACU('数据库世界书', 2, { description: '科技描述', triggerWhen: '科技讨论' }, 'agent-skillify'),
    ]);

    const entries = mockEntriesByBook.get('数据库世界书') || [];
    expect(entries.find(entry => entry.uid === 1)?.comment).toBe('人物条目');
    expect(entries.find(entry => entry.uid === 2)?.comment).toBe('科技条目');
    const registry = entries.find(entry => entry.comment === 'TavernDB-ACU-AgentWorldbookSkillRegistry');
    expect(JSON.parse(registry.content).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ uid: 1, comment: '人物条目' }),
      expect.objectContaining({ uid: 2, comment: '科技条目' }),
    ]));
  });
});

describe('resolveAgentWorldbookFilterAvailability_ACU', () => {
  beforeEach(() => {
    mockEntriesByBook.clear();
    mockSetLorebookEntries.mockClear();
    vi.mocked(readAgentWorldbookControlFromWorldbooks_ACU).mockReset();
    vi.mocked(resolveAgentWorldbookScopeBookNames_ACU).mockReset();
    mockGetLorebookEntriesStrict.mockReset();
  });

  it('agent 模式且世界书范围非空时 skillMetas 为空仍可用', async () => {
    vi.mocked(readAgentWorldbookControlFromWorldbooks_ACU).mockResolvedValue({
      control: { mode: 'agent' },
      source: 'worldbook',
      bookName: '角色A世界书',
      duplicateCount: 0,
      writableBookName: '角色A世界书',
    } as any);
    vi.mocked(resolveAgentWorldbookScopeBookNames_ACU).mockResolvedValue(['角色A世界书']);
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, comment: '没有 Skill 元数据的普通条目', enabled: true, keys: ['钥匙A'] },
    ]);

    const result = await resolveAgentWorldbookFilterAvailability_ACU();

    expect(result.available).toBe(true);
    expect(result.reason).toBe('available');
    expect(result.skillCount).toBe(0);
    expect(result.skillMetas).toEqual([]);
    expect(result.bookNames).toEqual(['角色A世界书']);
  });

  it('通过 request context 读取 Skill metadata，避免直接宿主读取', async () => {
    vi.mocked(readAgentWorldbookControlFromWorldbooks_ACU).mockResolvedValue({
      control: { mode: 'agent' }, source: 'worldbook', bookName: '角色A世界书', duplicateCount: 0, writableBookName: '角色A世界书',
    } as any);
    vi.mocked(resolveAgentWorldbookScopeBookNames_ACU).mockResolvedValue(['角色A世界书']);
    mockGetLorebookEntriesStrict.mockResolvedValue({
      status: 'success',
      entriesByBook: {
        角色A世界书: [{ uid: 1, comment: `条目\n${skillBlock}`, enabled: true }],
      },
      invalidBookNames: [],
      failedBookNames: [],
    });
    const readContext = { runId: 'plot-agent-meta-test', bookEntriesPromises: new Map() };

    const result = await resolveAgentWorldbookFilterAvailability_ACU(readContext);

    expect(result.skillCount).toBe(1);
    expect(mockGetLorebookEntriesStrict).toHaveBeenCalledWith(['角色A世界书'], expect.objectContaining({
      source: 'agent_runtime', validationPolicy: 'trusted_direct', runId: 'plot-agent-meta-test', context: readContext,
    }));
  });
});
