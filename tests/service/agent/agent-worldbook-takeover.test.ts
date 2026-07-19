import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEntriesByBook,
  mockPersistSettings,
  mockResolveBookNames,
  mockHashUserInput,
  mockSetLorebookEntries,
  mockReadAgentWorldbookState,
  mockWriteAgentWorldbookState,
  mockDeleteAgentWorldbookState,
  mockStateSnapshot,
} = vi.hoisted(() => ({
  mockEntriesByBook: new Map<string, any[]>(),
  mockPersistSettings: vi.fn(),
  mockResolveBookNames: vi.fn(async () => ['角色A世界书']),
  mockHashUserInput: vi.fn((value: string) => `hash:${value}`),
  mockSetLorebookEntries: vi.fn(),
  mockReadAgentWorldbookState: vi.fn(),
  mockWriteAgentWorldbookState: vi.fn(),
  mockDeleteAgentWorldbookState: vi.fn(),
  mockStateSnapshot: { current: { active: false, selectionSignature: '', createdAt: 0, books: {} } as any },
}));

vi.mock('../../../src/data/gateways/worldbook-gateway', () => ({
  getLorebookEntries_ACU: vi.fn(async (bookName: string) => mockEntriesByBook.get(bookName) || []),
  deleteLorebookEntries_ACU: vi.fn(async (bookName: string, uids: any[]) => {
    const uidSet = new Set((uids || []).map(uid => String(uid)));
    const entries = mockEntriesByBook.get(bookName) || [];
    mockEntriesByBook.set(bookName, entries.filter(entry => !uidSet.has(String(entry.uid))));
  }),
  setLorebookEntries_ACU: mockSetLorebookEntries,
}));

vi.mock('../../../src/data/storage/tavern-storage', () => ({
  persistTavernSettings_ACU: mockPersistSettings,
}));

vi.mock('../../../src/shared/utils', () => ({
  hashUserInput_ACU: mockHashUserInput,
  logWarn_ACU: vi.fn(),
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  settings_ACU: { plotSettings: {} },
}));

vi.mock('../../../src/service/agent/agent-skillify-service', () => ({
  isWorldbookEntrySkillifyCandidate_ACU: vi.fn((entry: any) => {
    const comment = String(entry?.comment || entry?.name || '').trim();
    if (entry?.enabled === false) return false;
    if (String(entry?.type || '').toLowerCase() === 'constant') return false;
    if (comment.startsWith('TavernDB-ACU-AgentWorldbookConfig')) return false;
    if (comment.startsWith('TavernDB-ACU-AgentWorldbookSnapshot')) return false;
    if (comment.startsWith('TavernDB-ACU-AgentFinalGenerationGreenlights')) return false;
    if (comment.startsWith('TavernDB-ACU-') && !comment.startsWith('TavernDB-ACU-AgentGreenlight')) return false;
    return true;
  }),
  getWorldbookEntryKeywordsForSkillify_ACU: vi.fn((entry: any) => entry?.keys || []),
}));

vi.mock('../../../src/service/agent/agent-worldbook-skill-meta', () => ({
  resolveAgentWorldbookFilterAvailability_ACU: vi.fn(async () => {
    const bookNames = await mockResolveBookNames();
    return bookNames.length === 0
      ? { available: false, reason: 'empty_scope', bookNames, skillMetas: [] }
      : { available: true, reason: 'available', bookNames, skillMetas: bookNames.flatMap((bookName: string) => (mockEntriesByBook.get(bookName) || []).filter(entry => entry?.uid !== undefined).map(entry => ({ bookName, uid: entry.uid, skillMeta: {} }))) };
  }),
  stripWorldbookSkillMetaBlock_ACU: vi.fn((comment: unknown) => String(comment || '')
    .replace(/<!--\s*ACU_SKILL_META_START[\s\S]*?ACU_SKILL_META_END\s*-->/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  ),
  hasUsableWorldbookSkillMeta_ACU: vi.fn((comment: unknown) => {
    const match = /<!--\s*ACU_SKILL_META_START\s*\n([\s\S]*?)\nACU_SKILL_META_END\s*-->/.exec(String(comment || ''));
    if (!match) return false;
    try {
      const meta = JSON.parse(match[1].trim());
      if (meta.version !== 1) return false;
      return !!String(meta.description || '').trim() || !!String(meta.triggerWhen || '').trim() || Number(meta.tk) > 0;
    } catch {
      return false;
    }
  }),
}));

vi.mock('../../../src/service/agent/agent-worldbook-config-meta', () => ({
  readAgentWorldbookStateFromWorldbooks_ACU: mockReadAgentWorldbookState,
  writeAgentWorldbookStateToWorldbook_ACU: mockWriteAgentWorldbookState,
  deleteAgentWorldbookStateEntry_ACU: mockDeleteAgentWorldbookState,
  resolveAgentWorldbookScopeBookNames_ACU: mockResolveBookNames,
}));

import { settings_ACU } from '../../../src/service/runtime/state-manager';
import {
  AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU,
  AGENT_WORLDBOOK_SNAPSHOT_COMMENT_ACU,
  buildWorldbookSelectionSignature_ACU,
  clearFinalGenerationGreenlights_ACU,
  getPlotAgentWorldbookSnapshot_ACU,
  readFinalGenerationGreenlights_ACU,
  resolvePreTakeoverWorldbookSnapshot_ACU,
  refreshPlotAgentWorldbookSnapshotFromWorldbooks_ACU,
  restoreWorldbookGreenlights_ACU,
  setPlotAgentWorldbookSnapshot_ACU,
  takeoverWorldbookGreenlights_ACU,
  writeFinalGenerationGreenlights_ACU,
} from '../../../src/service/agent/agent-worldbook-takeover';

function snapshotEntry(bookName = '角色A世界书'): any {
  return (mockEntriesByBook.get(bookName) || []).find(entry => entry.comment === AGENT_WORLDBOOK_SNAPSHOT_COMMENT_ACU);
}

function finalGenerationGreenlightEntry(bookName = '角色A世界书'): any {
  return (mockEntriesByBook.get(bookName) || []).find(entry => entry.comment === AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU);
}

const skillMetaBlock_ACU = '<!-- ACU_SKILL_META_START\n{"version":1,"description":"描述","triggerWhen":"触发","tk":12,"updatedAt":1,"updatedBy":"agent-skillify"}\nACU_SKILL_META_END -->';
const skillComment_ACU = `普通条目A\n\n${skillMetaBlock_ACU}`;
const skillCommentB_ACU = `普通条目B\n\n${skillMetaBlock_ACU}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockEntriesByBook.clear();
  mockResolveBookNames.mockResolvedValue(['角色A世界书']);
  mockSetLorebookEntries.mockImplementation(async (bookName: string, patches: any[]) => {
    const patchByUid = new Map((patches || []).map(patch => [String(patch.uid), patch]));
    const entries = mockEntriesByBook.get(bookName) || [];
    mockEntriesByBook.set(bookName, entries.map(entry => {
      const patch = patchByUid.get(String(entry.uid));
      if (!patch) return entry;
      return { ...entry, ...patch };
    }));
  });
  mockStateSnapshot.current = { active: false, selectionSignature: '', createdAt: 0, books: {} };
  mockReadAgentWorldbookState.mockImplementation(async () => ({
    control: {},
    snapshot: mockStateSnapshot.current,
    source: 'default',
    bookName: '',
    duplicateCount: 0,
    writableBookName: '角色A世界书',
  }));
  mockWriteAgentWorldbookState.mockImplementation(async (patch: any) => {
    if (patch?.snapshot) mockStateSnapshot.current = patch.snapshot;
    return { updated: true, bookName: '角色A世界书', snapshot: mockStateSnapshot.current, control: {} };
  });
  mockDeleteAgentWorldbookState.mockImplementation(async () => { mockStateSnapshot.current = { active: false, selectionSignature: '', createdAt: 0, books: {} }; return 1; });
  setPlotAgentWorldbookSnapshot_ACU({ active: false, selectionSignature: '', createdAt: 0, books: {} });
  (settings_ACU as any).plotSettings = {};
  mockEntriesByBook.set('角色A世界书', [
    { uid: 1, enabled: true, keys: ['钥匙A'], comment: skillComment_ACU, content: '内容A' },
  ]);
});

describe('agent worldbook takeover native trigger suppression', () => {
  it('接管会保存 active snapshot 并禁用原世界书条目，避免最终正文被正常世界书机制重复触发', async () => {
    const result = await takeoverWorldbookGreenlights_ACU();

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('native_worldbook_trigger_disabled');
    expect(result.totalCandidates).toBe(1);
    expect(result.disabled).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.snapshot.active).toBe(true);
    expect(result.snapshot.books['角色A世界书']).toEqual([
      expect.objectContaining({
        uid: 1,
        previousEnabled: true,
        previousKeys: ['钥匙A'],
        commentHash: 'hash:普通条目A',
      }),
    ]);
    expect(result.updates).toEqual([{ bookName: '角色A世界书', uid: 1 }]);
    const patchedEntry = mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1);
    expect(patchedEntry?.enabled).toBe(false);
    expect(patchedEntry?.comment).toBe(skillComment_ACU);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(true);
    expect(mockWriteAgentWorldbookState).toHaveBeenCalledWith({ snapshot: expect.objectContaining({ active: true, selectionSignature: 'hash:{"scope":"agent-worldbook-takeover","books":["角色A世界书"]}' }) });
    expect(snapshotEntry()).toBeUndefined();
    expect(finalGenerationGreenlightEntry()).toBeUndefined();
  });

  it('接管写入 state snapshot 抛错时不污染 active cache、不禁用原条目且阻止后续正文绿灯误写', async () => {
    mockWriteAgentWorldbookState.mockRejectedValueOnce(new Error('state write failed'));

    const result = await takeoverWorldbookGreenlights_ACU();
    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '正文需要' }]);

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('snapshot_state_write_failed');
    expect(result.totalCandidates).toBe(1);
    expect(result.disabled).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.snapshot.active).toBe(true);
    expect(getPlotAgentWorldbookSnapshot_ACU()).toMatchObject({
      active: false,
      selectionSignature: 'hash:{"scope":"agent-worldbook-takeover","books":["角色A世界书"]}',
      books: {},
    });
    expect(mockStateSnapshot.current.active).toBe(false);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: true,
      keys: ['钥匙A'],
    });
    expect(written).toBe(false);
    expect(finalGenerationGreenlightEntry()).toBeUndefined();
  });

  it('接管写入 state snapshot 返回 updated false 时不污染 active cache、不禁用原条目且阻止后续正文绿灯误写', async () => {
    mockWriteAgentWorldbookState.mockResolvedValueOnce({ updated: false, bookName: '角色A世界书', snapshot: mockStateSnapshot.current, control: {} });

    const result = await takeoverWorldbookGreenlights_ACU();
    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '正文需要' }]);

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('snapshot_state_write_failed');
    expect(result.totalCandidates).toBe(1);
    expect(result.disabled).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.snapshot.active).toBe(true);
    expect(getPlotAgentWorldbookSnapshot_ACU()).toMatchObject({
      active: false,
      selectionSignature: 'hash:{"scope":"agent-worldbook-takeover","books":["角色A世界书"]}',
      books: {},
    });
    expect(mockStateSnapshot.current.active).toBe(false);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: true,
      keys: ['钥匙A'],
    });
    expect(written).toBe(false);
    expect(finalGenerationGreenlightEntry()).toBeUndefined();
  });

  it('重复接管时如果候选已被禁用，不覆盖既有 active snapshot，保证后续仍可恢复', async () => {
    const first = await takeoverWorldbookGreenlights_ACU();
    expect(first.reason).toBe('native_worldbook_trigger_disabled');

    const second = await takeoverWorldbookGreenlights_ACU();

    expect(second.updated).toBe(false);
    expect(second.reason).toBe('native_worldbook_trigger_already_disabled');
    expect(second.totalCandidates).toBe(0);
    expect(second.disabled).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.snapshot.active).toBe(true);
    expect(second.snapshot.books['角色A世界书']).toEqual([
      expect.objectContaining({
        uid: 1,
        previousEnabled: true,
        previousKeys: ['钥匙A'],
      }),
    ]);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(true);
  });

  it('重复接管时会恢复并剔除已失去 Skill meta 的旧 active snapshot 条目', async () => {
    const first = await takeoverWorldbookGreenlights_ACU();
    expect(first.reason).toBe('native_worldbook_trigger_disabled');
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], type: 'selective', comment: '普通条目A', content: '内容A' },
    ]);

    const second = await takeoverWorldbookGreenlights_ACU();

    expect(second.updated).toBe(true);
    expect(second.reason).toBe('native_worldbook_trigger_snapshot_reconciled');
    expect(second.totalCandidates).toBe(0);
    expect(second.snapshot.active).toBe(false);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: true, keys: ['钥匙A'] });
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(false);
  });

  it('世界书范围为空时不启用运行时过滤', async () => {
    mockResolveBookNames.mockResolvedValue([]);

    const result = await takeoverWorldbookGreenlights_ACU();

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('empty_scope');
    expect(result.totalCandidates).toBe(0);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(false);
  });

  it('无 Skill meta 时不写入 active snapshot 且不禁用原生世界书条目', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: '普通条目A', content: '内容A' },
      { uid: 2, enabled: true, keys: ['常量'], type: 'constant', comment: '常量条目', content: '内容B' },
      { uid: 3, enabled: true, keys: ['内部'], type: 'selective', comment: 'TavernDB-ACU-AgentWorldbookConfig', content: '{}' },
      { uid: 4, enabled: true, keys: ['数据库'], type: 'selective', comment: 'TavernDB-ACU-自动生成条目', content: '内容D' },
    ]);

    const result = await takeoverWorldbookGreenlights_ACU();

    expect(result.reason).toBe('empty_candidates');
    expect(result.totalCandidates).toBe(0);
    expect(result.snapshot.active).toBe(false);
    expect(result.updates).toEqual([]);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: true });
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 2)).toMatchObject({ enabled: true, type: 'constant' });
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 3)).toMatchObject({ enabled: true });
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 4)).toMatchObject({ enabled: true });
  });

  it('有 Skill meta 的 enabled selective 条目会进入 snapshot 并被禁用', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);

    const result = await takeoverWorldbookGreenlights_ACU();

    expect(result.reason).toBe('native_worldbook_trigger_disabled');
    expect(result.totalCandidates).toBe(1);
    expect(result.snapshot.active).toBe(true);
    expect(result.snapshot.books['角色A世界书']).toEqual([
      expect.objectContaining({ uid: 1, previousKeys: ['钥匙A'], previousType: 'selective' }),
    ]);
    expect(result.updates).toEqual([{ bookName: '角色A世界书', uid: 1 }]);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: false });
  });

  it('disabled 且有 Skill meta 的条目不进入 snapshot 且不被启用或禁用', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);

    const result = await takeoverWorldbookGreenlights_ACU();

    expect(result.reason).toBe('empty_candidates');
    expect(result.totalCandidates).toBe(0);
    expect(result.snapshot.active).toBe(false);
    expect(result.updates).toEqual([]);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: false });
  });

  it('刷新快照时保留当前 selection 的 active snapshot，确保 takeover 后 UI refresh 不破坏 restore', async () => {
    const takeoverResult = await takeoverWorldbookGreenlights_ACU();
    expect(takeoverResult.reason).toBe('native_worldbook_trigger_disabled');
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)?.enabled).toBe(false);

    const snapshot = await refreshPlotAgentWorldbookSnapshotFromWorldbooks_ACU();
    expect(snapshot.active).toBe(true);
    expect(snapshot.books['角色A世界书']).toEqual([
      expect.objectContaining({ uid: 1, previousEnabled: true, previousKeys: ['钥匙A'] }),
    ]);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(true);

    const restoreResult = await restoreWorldbookGreenlights_ACU();
    expect(restoreResult.reason).toBe('native_worldbook_trigger_restored');
    expect(restoreResult.restored).toBe(1);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)?.enabled).toBe(true);
    expect(mockDeleteAgentWorldbookState).toHaveBeenCalledTimes(1);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(false);
  });

  it('冷 cache 会从持久化状态 hydration active snapshot', async () => {
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    const persistedSnapshot = {
      active: true,
      selectionSignature,
      createdAt: 10,
      books: {
        角色A世界书: [{ uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], previousType: 'selective' }],
      },
    };
    mockStateSnapshot.current = persistedSnapshot;
    setPlotAgentWorldbookSnapshot_ACU({ active: false, selectionSignature: '', createdAt: 0, books: {} });

    const resolved = await resolvePreTakeoverWorldbookSnapshot_ACU();

    expect(resolved.snapshot).toBe(persistedSnapshot);
    expect(resolved.expectedSignature).toBe(selectionSignature);
    expect(getPlotAgentWorldbookSnapshot_ACU()).toBe(persistedSnapshot);
  });

  it('并发 pre_takeover hydration 共享同一次持久化读取', async () => {
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    const persistedSnapshot = {
      active: true,
      selectionSignature,
      createdAt: 10,
      books: {
        角色A世界书: [{ uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], previousType: 'selective' }],
      },
    };
    mockStateSnapshot.current = persistedSnapshot;

    const [first, second] = await Promise.all([
      resolvePreTakeoverWorldbookSnapshot_ACU(),
      resolvePreTakeoverWorldbookSnapshot_ACU(),
    ]);

    expect(first).toEqual({ snapshot: persistedSnapshot, expectedSignature: selectionSignature });
    expect(second).toEqual({ snapshot: persistedSnapshot, expectedSignature: selectionSignature });
    expect(mockReadAgentWorldbookState).toHaveBeenCalledTimes(1);
  });

  it('pre_takeover hydration 失败后会释放 single-flight 并允许下一次重试', async () => {
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    const persistedSnapshot = {
      active: true,
      selectionSignature,
      createdAt: 10,
      books: {
        角色A世界书: [{ uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], previousType: 'selective' }],
      },
    };
    mockReadAgentWorldbookState
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce({ control: {}, snapshot: persistedSnapshot, source: 'worldbook', bookName: '角色A世界书', duplicateCount: 0, writableBookName: '角色A世界书' });

    await expect(resolvePreTakeoverWorldbookSnapshot_ACU()).rejects.toThrow('temporary read failure');
    await expect(resolvePreTakeoverWorldbookSnapshot_ACU()).resolves.toEqual({ snapshot: persistedSnapshot, expectedSignature: selectionSignature });
    expect(mockReadAgentWorldbookState).toHaveBeenCalledTimes(2);
  });

  it('hydration 期间 cache 被新状态更新时，旧读取结果不得覆盖新状态', async () => {
    let releaseRead!: (value: any) => void;
    mockReadAgentWorldbookState.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }));
    const hydrationPromise = refreshPlotAgentWorldbookSnapshotFromWorldbooks_ACU();
    await vi.waitFor(() => expect(mockReadAgentWorldbookState).toHaveBeenCalledTimes(1));

    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    const originalSnapshot = {
      active: true,
      selectionSignature,
      createdAt: 10,
      books: { 角色A世界书: [{ uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], previousType: 'selective' }] },
    };
    const newerSnapshot = {
      active: true,
      selectionSignature: 'newer-signature',
      createdAt: 20,
      books: { 新范围: [{ uid: 9, previousEnabled: true, previousKeys: ['新'], previousType: 'selective' }] },
    };
    setPlotAgentWorldbookSnapshot_ACU(newerSnapshot);
    releaseRead({
      control: {},
      snapshot: originalSnapshot,
      source: 'worldbook',
      bookName: '角色A世界书',
      duplicateCount: 0,
      writableBookName: '角色A世界书',
    });

    await expect(hydrationPromise).resolves.toBe(originalSnapshot);
    expect(getPlotAgentWorldbookSnapshot_ACU()).toBe(newerSnapshot);
  });


  it('不同 selection signature 的并发 hydration 不共享结果', async () => {
    const signatureA = buildWorldbookSelectionSignature_ACU(['书A']);
    const signatureB = buildWorldbookSelectionSignature_ACU(['书B']);
    let releaseA!: (value: any) => void;
    mockResolveBookNames.mockResolvedValueOnce(['书A']).mockResolvedValueOnce(['书B']);
    mockReadAgentWorldbookState
      .mockImplementationOnce(() => new Promise(resolve => { releaseA = resolve; }))
      .mockResolvedValueOnce({
        control: {},
        snapshot: { active: true, selectionSignature: signatureB, createdAt: 2, books: { 书B: [{ uid: 2, previousEnabled: true }] } },
        source: 'worldbook', bookName: '书B', duplicateCount: 0, writableBookName: '书B',
      });

    const promiseA = resolvePreTakeoverWorldbookSnapshot_ACU();
    await vi.waitFor(() => expect(mockReadAgentWorldbookState).toHaveBeenCalledTimes(1));
    const promiseB = resolvePreTakeoverWorldbookSnapshot_ACU();
    await vi.waitFor(() => expect(mockReadAgentWorldbookState).toHaveBeenCalledTimes(2));
    releaseA({
      control: {},
      snapshot: { active: true, selectionSignature: signatureA, createdAt: 1, books: { 书A: [{ uid: 1, previousEnabled: true }] } },
      source: 'worldbook', bookName: '书A', duplicateCount: 0, writableBookName: '书A',
    });

    await expect(promiseA).resolves.toEqual(expect.objectContaining({ expectedSignature: signatureA }));
    await expect(promiseB).resolves.toEqual(expect.objectContaining({ expectedSignature: signatureB }));
    expect(mockReadAgentWorldbookState).toHaveBeenCalledTimes(2);
  });

  it('刷新快照时会清空 selection 不匹配的过期 active snapshot', async () => {
    (settings_ACU as any).plotSettings.agentWorldbookControlSnapshot = {
      active: true,
      selectionSignature: 'stale',
      createdAt: 1,
      books: { stale: [{ uid: 9, previousEnabled: true }] },
    };

    const snapshot = await refreshPlotAgentWorldbookSnapshotFromWorldbooks_ACU();

    expect(snapshot.active).toBe(false);
    expect(snapshot.books).toEqual({});
    expect(getPlotAgentWorldbookSnapshot_ACU()).toMatchObject({ active: false, books: {} });
  });

  it('正文绿灯写入会把 active snapshot 内放行条目改为保留关键词的常量蓝灯并可读回', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], comment: skillComment_ACU, content: '内容A' },
      { uid: 'final-state', enabled: false, type: 'constant', keys: [], comment: AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU, content: '{}' },
    ]);
    await takeoverWorldbookGreenlights_ACU();

    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '正文需要' }]);
    const readBack = await readFinalGenerationGreenlights_ACU();
    const patchedEntry = mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1);

    expect(written).toBe(true);
    expect(readBack).toEqual([{ bookName: '角色A世界书', uid: 1 }]);
    expect(patchedEntry).toMatchObject({ enabled: true, type: 'constant', keys: ['钥匙A'] });
    expect(finalGenerationGreenlightEntry()).toBeDefined();
  });

  it('正文绿灯写入会用可信快照修复旧版本清空的关键词', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);
    await takeoverWorldbookGreenlights_ACU();
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: [], type: 'constant', comment: skillComment_ACU, content: '内容A' },
    ]);

    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '修复旧绿灯' }]);

    expect(written).toBe(true);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: true,
      type: 'constant',
      keys: ['钥匙A'],
    });
  });

  it('正文绿灯写入不会用快照覆盖用户修改 comment 后主动清空的关键词', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);
    await takeoverWorldbookGreenlights_ACU();
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: [], type: 'constant', comment: `用户已修改条目\n\n${skillMetaBlock_ACU}`, content: '内容A' },
    ]);

    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '不得覆盖用户修改' }]);

    expect(written).toBe(false);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: true,
      type: 'constant',
      keys: [],
    });
  });

  it('正文绿灯写入在快照缺少 commentHash 时不推断恢复旧空关键词', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);
    await takeoverWorldbookGreenlights_ACU();
    mockSetLorebookEntries.mockClear();
    const snapshot = getPlotAgentWorldbookSnapshot_ACU();
    snapshot.books['角色A世界书'][0].commentHash = undefined;
    setPlotAgentWorldbookSnapshot_ACU(snapshot);
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: [], type: 'constant', comment: skillComment_ACU, content: '内容A' },
    ]);

    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '缺少编辑指纹' }]);

    expect(written).toBe(false);
    expect(mockSetLorebookEntries).not.toHaveBeenCalled();
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: true,
      type: 'constant',
      keys: [],
    });
  });

  it('正文绿灯写入遇到已启用 constant 且 keys 非空的受控条目时不重复 patch 或清空 keys', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);
    await takeoverWorldbookGreenlights_ACU();
    mockSetLorebookEntries.mockClear();
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['仍有关键词'], type: 'constant', comment: skillComment_ACU, content: '内容A' },
    ]);

    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '正文需要' }]);

    expect(written).toBe(false);
    expect(mockSetLorebookEntries).not.toHaveBeenCalled();
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: true, type: 'constant', keys: ['仍有关键词'] });
    expect(await readFinalGenerationGreenlights_ACU()).toEqual([{ bookName: '角色A世界书', uid: 1 }]);
  });

  it('正文绿灯覆盖写入会关闭上一轮放行条目并只开启本轮 allowlist', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
      { uid: 2, enabled: true, keys: ['钥匙B'], type: 'selective', comment: skillCommentB_ACU, content: '内容B' },
    ]);
    await takeoverWorldbookGreenlights_ACU();

    await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '第一轮正文需要' }]);
    await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 2, reason: '第二轮正文需要' }]);
    const entries = mockEntriesByBook.get('角色A世界书') || [];

    expect(entries.find(entry => entry.uid === 1)).toMatchObject({ enabled: false });
    expect(entries.find(entry => entry.uid === 2)).toMatchObject({ enabled: true, type: 'constant', keys: ['钥匙B'] });
    expect(await readFinalGenerationGreenlights_ACU()).toEqual([{ bookName: '角色A世界书', uid: 2 }]);
  });

  it('清理正文绿灯只关闭当前蓝灯条目并清理旧版本隐藏状态条目', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
      { uid: 'final-state', enabled: false, type: 'constant', keys: [], comment: AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU, content: '{}' },
    ]);
    await takeoverWorldbookGreenlights_ACU();
    await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '正文需要' }]);

    const cleared = await clearFinalGenerationGreenlights_ACU();

    expect(cleared).toBe(2);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: false, type: 'constant', keys: ['钥匙A'] });
    expect(finalGenerationGreenlightEntry()).toBeUndefined();
    expect(await readFinalGenerationGreenlights_ACU()).toEqual([]);
  });


  it('constant 且 keys 非空的受控条目同样视为正文蓝灯并可被 clear 关闭', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);
    await takeoverWorldbookGreenlights_ACU();
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['仍有关键词'], type: 'constant', comment: skillComment_ACU, content: '内容A' },
    ]);

    const readBack = await readFinalGenerationGreenlights_ACU();
    const cleared = await clearFinalGenerationGreenlights_ACU();

    expect(readBack).toEqual([{ bookName: '角色A世界书', uid: 1 }]);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: false,
      type: 'constant',
      keys: ['仍有关键词'],
    });
    expect(await readFinalGenerationGreenlights_ACU()).toEqual([]);
  });

  it('没有 active snapshot 时正文绿灯写入返回 false 且不修改真实条目', async () => {
    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 1, reason: '正文需要' }]);

    expect(written).toBe(false);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: true, keys: ['钥匙A'] });
    expect(await readFinalGenerationGreenlights_ACU()).toEqual([]);
  });

  it('正文绿灯写入会忽略 active snapshot 之外的 uid，避免 Agent 任意修改世界书', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: true, keys: ['钥匙A'], type: 'selective', comment: skillComment_ACU, content: '内容A' },
    ]);
    await takeoverWorldbookGreenlights_ACU();
    mockEntriesByBook.set('角色A世界书', [
      ...(mockEntriesByBook.get('角色A世界书') || []),
      { uid: 100, enabled: true, keys: ['接管后新增'], type: 'selective', comment: '接管后新增条目', content: '新增内容' },
    ]);

    const written = await writeFinalGenerationGreenlights_ACU([{ bookName: '角色A世界书', uid: 100, reason: '越界正文需要' }]);

    expect(written).toBe(false);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 100)).toMatchObject({ enabled: true, type: 'selective', keys: ['接管后新增'] });
    expect(await readFinalGenerationGreenlights_ACU()).toEqual([]);
  });

  it('恢复会按 active snapshot 恢复原世界书条目状态并清理旧版本内部隐藏条目', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['钥匙A'], comment: '普通条目A', content: '内容A' },
      { uid: 'final-state', enabled: false, type: 'constant', keys: [], comment: AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU, content: '{}' },
      { uid: 'snapshot-state', enabled: false, type: 'constant', keys: [], comment: AGENT_WORLDBOOK_SNAPSHOT_COMMENT_ACU, content: '{}' },
    ]);
    (settings_ACU as any).plotSettings.agentWorldbookControlSnapshot = {
      active: true,
      selectionSignature: 'hash:{"scope":"agent-worldbook-takeover","books":["角色A世界书"]}',
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: 'hash:普通条目A' },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU();

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('native_worldbook_trigger_restored');
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)?.enabled).toBe(true);
    expect(finalGenerationGreenlightEntry()).toBeUndefined();
    expect(snapshotEntry()).toBeUndefined();
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(false);
  });

  it('显式清理并初始化在 state snapshot 恢复成功后删除 state 条目', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: '普通条目A', content: '内容A' },
    ]);
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    mockStateSnapshot.current = {
      active: true,
      selectionSignature,
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: 'hash:普通条目A' },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU({ cleanupMode: 'full' });

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('native_worldbook_trigger_restored');
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockDeleteAgentWorldbookState).toHaveBeenCalledTimes(1);
    expect(mockStateSnapshot.current.active).toBe(false);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(false);
  });

  it('restore_only 恢复受控条目但保留 state 与 snapshot 条目', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: '普通条目A', content: '内容A' },
      { uid: 'final-state', enabled: false, type: 'constant', keys: [], comment: AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU, content: '{}' },
      { uid: 'snapshot-state', enabled: false, type: 'constant', keys: [], comment: AGENT_WORLDBOOK_SNAPSHOT_COMMENT_ACU, content: '{}' },
    ]);
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    mockStateSnapshot.current = {
      active: true,
      selectionSignature,
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: 'hash:普通条目A' },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU({ cleanupMode: 'restore_only' });

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('native_worldbook_trigger_restored');
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({ enabled: true, keys: ['钥匙A'] });
    expect(finalGenerationGreenlightEntry()).toBeUndefined();
    expect(snapshotEntry()).toBeDefined();
    expect(mockDeleteAgentWorldbookState).not.toHaveBeenCalled();
    expect(mockStateSnapshot.current.active).toBe(true);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(true);
  });

  it('显式清理并初始化在恢复写回失败时保留 state 条目和 active snapshot', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: '普通条目A', content: '内容A' },
    ]);
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    mockStateSnapshot.current = {
      active: true,
      selectionSignature,
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: 'hash:普通条目A' },
        ],
      },
    };
    mockSetLorebookEntries.mockRejectedValueOnce(new Error('write failed'));

    const result = await restoreWorldbookGreenlights_ACU({ cleanupMode: 'full' });

    expect(result.updated).toBe(true);
    expect(result.reason).toBe('native_worldbook_trigger_restore_failed');
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockDeleteAgentWorldbookState).not.toHaveBeenCalled();
    expect(mockStateSnapshot.current.active).toBe(true);
    expect(getPlotAgentWorldbookSnapshot_ACU().active).toBe(true);
  });

  it('显式清理并初始化在没有 active snapshot 时不删除 state 条目', async () => {
    mockStateSnapshot.current = {
      active: false,
      selectionSignature: buildWorldbookSelectionSignature_ACU(['角色A世界书']),
      createdAt: 1,
      books: {},
    };

    const result = await restoreWorldbookGreenlights_ACU({ cleanupMode: 'full' });

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('no_active_snapshot');
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockDeleteAgentWorldbookState).not.toHaveBeenCalled();
  });

  it('恢复 state snapshot 时忽略 Skill 元数据块变化但保留该元数据，避免一键 Skill 化后清除并初始化误跳过', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: `普通条目A\n\n${skillMetaBlock_ACU}`, content: '内容A' },
    ]);
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    mockStateSnapshot.current = {
      active: true,
      selectionSignature,
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: 'hash:普通条目A' },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU({ cleanupMode: 'full' });

    expect(result.reason).toBe('native_worldbook_trigger_restored');
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockDeleteAgentWorldbookState).toHaveBeenCalledTimes(1);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: true,
      keys: ['钥匙A'],
      comment: `普通条目A\n\n${skillMetaBlock_ACU}`,
    });
  });

  it('恢复 state snapshot 时兼容旧 commentHash 口径包含 Skill 元数据块的条目', async () => {
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    const takeoverMetaBlock = `<!-- ACU_AGENT_WORLDBOOK_TAKEOVER_META_START\n${JSON.stringify({
      version: 1,
      kind: 'agent_worldbook_takeover',
      selectionSignature,
      createdAt: 1,
      previousEnabled: true,
      previousKeys: ['钥匙A'],
      commentHash: `hash:普通条目A\n\n${skillMetaBlock_ACU}`,
    })}\nACU_AGENT_WORLDBOOK_TAKEOVER_META_END -->`;
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: `普通条目A\n\n${skillMetaBlock_ACU}\n\n${takeoverMetaBlock}`, content: '内容A' },
    ]);
    mockStateSnapshot.current = {
      active: true,
      selectionSignature,
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: `hash:普通条目A\n\n${skillMetaBlock_ACU}` },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU({ cleanupMode: 'full' });

    expect(result.reason).toBe('native_worldbook_trigger_restored');
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockDeleteAgentWorldbookState).toHaveBeenCalledTimes(1);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: true,
      keys: ['钥匙A'],
      comment: `普通条目A\n\n${skillMetaBlock_ACU}`,
    });
  });

  it('恢复 state snapshot 时旧 commentHash 口径包含 Skill 元数据但用户已改 comment 仍跳过并保留 state', async () => {
    const selectionSignature = buildWorldbookSelectionSignature_ACU(['角色A世界书']);
    const takeoverMetaBlock = `<!-- ACU_AGENT_WORLDBOOK_TAKEOVER_META_START\n${JSON.stringify({
      version: 1,
      kind: 'agent_worldbook_takeover',
      selectionSignature,
      createdAt: 1,
      previousEnabled: true,
      previousKeys: ['钥匙A'],
      commentHash: `hash:普通条目A\n\n${skillMetaBlock_ACU}`,
    })}\nACU_AGENT_WORLDBOOK_TAKEOVER_META_END -->`;
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: `用户已改名\n\n${skillMetaBlock_ACU}\n\n${takeoverMetaBlock}`, content: '内容A' },
    ]);
    mockStateSnapshot.current = {
      active: true,
      selectionSignature,
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: `hash:普通条目A\n\n${skillMetaBlock_ACU}` },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU({ cleanupMode: 'full' });

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('native_worldbook_trigger_restore_skipped');
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDeleteAgentWorldbookState).not.toHaveBeenCalled();
    expect(mockStateSnapshot.current.active).toBe(true);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: false,
      keys: ['新钥匙'],
      comment: `用户已改名\n\n${skillMetaBlock_ACU}`,
    });
  });

  it('恢复时如果 comment 已变化则跳过该条目，避免误恢复用户已改写的世界书条目', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: '用户已改名', content: '内容A' },
    ]);
    (settings_ACU as any).plotSettings.agentWorldbookControlSnapshot = {
      active: true,
      selectionSignature: 'hash:{"scope":"agent-worldbook-takeover","books":["角色A世界书"]}',
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: 'hash:普通条目A' },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU();

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('native_worldbook_trigger_restore_skipped');
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)).toMatchObject({
      enabled: false,
      keys: ['新钥匙'],
      comment: '用户已改名',
    });
  });

  it('恢复 state snapshot 时如果 comment 已变化则保留 state 条目，避免丢失手动恢复依据', async () => {
    mockEntriesByBook.set('角色A世界书', [
      { uid: 1, enabled: false, keys: ['新钥匙'], comment: '用户已改名', content: '内容A' },
    ]);
    mockStateSnapshot.current = {
      active: true,
      selectionSignature: 'hash:{"scope":"agent-worldbook-takeover","books":["角色A世界书"]}',
      createdAt: 1,
      books: {
        '角色A世界书': [
          { uid: 1, previousEnabled: true, previousKeys: ['钥匙A'], commentHash: 'hash:普通条目A' },
        ],
      },
    };

    const result = await restoreWorldbookGreenlights_ACU();

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('native_worldbook_trigger_restore_skipped');
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockDeleteAgentWorldbookState).not.toHaveBeenCalled();
    expect(mockStateSnapshot.current.active).toBe(true);
  });

  it('没有 active snapshot 或遗留内部条目时恢复返回空操作结果', async () => {
    const result = await restoreWorldbookGreenlights_ACU();

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('no_active_snapshot');
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockEntriesByBook.get('角色A世界书')?.find(entry => entry.uid === 1)?.enabled).toBe(true);
    expect(snapshotEntry()).toBeUndefined();
    expect(finalGenerationGreenlightEntry()).toBeUndefined();
  });
});
