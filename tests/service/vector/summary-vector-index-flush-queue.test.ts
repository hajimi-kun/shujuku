import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  GenerationInvalidatedError: class SummaryVectorFlushGenerationInvalidatedError_ACU extends Error {},
  chatKey: 'chat-a',
  isolationKey: 'iso-a',
  summaryKey: 'summary-a',
  task: null as any,
  upsert: vi.fn(),
  get: vi.fn(),
  getStrict: vi.fn(),
  markReadyIfGenerationMatches: vi.fn(),
  list: vi.fn(),
  reconcileLegacy: vi.fn(),
  invalidate: vi.fn(),
  remove: vi.fn(),
  removeStrict: vi.fn(),
  archive: vi.fn(),
  logIdentityEvent: vi.fn(),
  runScopeMutation: vi.fn(),
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get currentChatFileIdentifier_ACU() { return h.chatKey; },
  getCurrentIsolationKey_ACU: () => h.isolationKey,
}));
vi.mock('../../../src/shared/utils', () => ({ logDebug_ACU: vi.fn(), logWarn_ACU: vi.fn() }));
vi.mock('../../../src/data/storage/vector-index-hot-cache', () => ({
  SummaryVectorFlushGenerationInvalidatedError_ACU: h.GenerationInvalidatedError,
  deleteSummaryVectorFlushTask_ACU: (...args: any[]) => h.remove(...args),
  markSummaryVectorFlushTaskReadyIfGenerationMatchesStrict_ACU: (...args: any[]) => h.markReadyIfGenerationMatches(...args),
  deleteSummaryVectorFlushTaskStrict_ACU: (...args: any[]) => h.removeStrict(...args),
  getSummaryVectorFlushTask_ACU: (...args: any[]) => h.get(...args),
  getSummaryVectorFlushTaskStrict_ACU: (...args: any[]) => h.getStrict(...args),
  listSummaryVectorFlushTasks_ACU: (...args: any[]) => h.list(...args),
  reconcileLegacySummaryVectorFlushTaskStrict_ACU: (...args: any[]) => h.reconcileLegacy(...args),
  invalidateSummaryVectorFlushTaskStrict_ACU: (...args: any[]) => h.invalidate(...args),
  upsertSummaryVectorFlushTask_ACU: (...args: any[]) => h.upsert(...args),
}));
vi.mock('../../../src/service/vector/summary-vector-index-archive-service', () => ({
  buildSummaryVectorIndexArchiveScopeKey_ACU: (parts: any) => JSON.stringify([parts.chatKey || 'current-chat', parts.isolationKey || 'default', parts.sourceTableKey || 'summary']),
  findSummaryTable_ACU: () => h.summaryKey ? { summaryKey: h.summaryKey, table: {} } : null,
  archiveSummaryVectorIndexNow_ACU: (...args: any[]) => h.archive(...args),
  runSummaryVectorIndexArchiveScopeMutationExclusive_ACU: (...args: any[]) => h.runScopeMutation(...args),
}));
vi.mock('../../../src/service/vector/summary-vector-index-storage-service', () => ({
  logSummaryVectorIndexIdentityEvent_ACU: (...args: any[]) => h.logIdentityEvent(...args),
}));

import {
  buildSummaryVectorIndexFlushScopeKey_ACU,
  clearSummaryVectorIndexFlushQueueForCurrentScope_ACU,
  enqueueSummaryVectorIndexFlush_ACU,
  flushSummaryVectorIndexTaskNow_ACU,
  restoreSummaryVectorIndexFlushQueueForCurrentChat_ACU,
} from '../../../src/service/vector/summary-vector-index-flush-queue';
import {
  clearSummaryVectorIndexDirtyForRealign_ACU,
  isSummaryVectorIndexDirtyForRealign_ACU,
  markSummaryVectorIndexDirtyForRealign_ACU,
} from '../../../src/service/vector/summary-vector-index-realign-state';

function task(scopeKey: string, overrides: any = {}) {
  return { scopeKey, chatKey: 'chat-a', isolationKey: 'iso-a', sourceTableKey: 'summary-a', targetMessageIndex: 3, mode: 'sync', status: 'queued', requestedAt: 1, debounceUntil: Date.now(), attemptCount: 0, updatedAt: Date.now(), ...overrides };
}

describe('summary-vector-index flush queue scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    h.chatKey = 'chat-a'; h.isolationKey = 'iso-a'; h.summaryKey = 'summary-a';
    h.get.mockImplementation(async () => h.task);
    h.getStrict.mockImplementation(async () => h.task);
    h.upsert.mockImplementation(async (input: any) => ({ ...input, attemptCount: 0, updatedAt: Date.now() }));
    h.list.mockResolvedValue([]); h.remove.mockResolvedValue(undefined); h.markReadyIfGenerationMatches.mockResolvedValue(true); h.removeStrict.mockResolvedValue(undefined);
    h.reconcileLegacy.mockResolvedValue({ outcome: 'migrated', task: null });
    h.invalidate.mockImplementation(async (input: any) => ({ ...task(input.scopeKey), ...input, status: 'invalidated', generation: 1 }));
    h.archive.mockResolvedValue({ success: true, skipped: false, errors: [] });
    h.runScopeMutation.mockImplementation(async (_scopeKey: string, operation: () => Promise<any>) => operation());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('三元 scope 彼此独立，成功 flush 只清理自身 dirty state', async () => {
    const scopeA = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    const scopeB = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-b', 'summary-a');
    expect(scopeA).not.toBe(scopeB);
    markSummaryVectorIndexDirtyForRealign_ACU(scopeA, 'runtime_stale_rows');
    markSummaryVectorIndexDirtyForRealign_ACU(scopeB, 'runtime_stale_rows');
    h.task = task(scopeA);

    await expect(flushSummaryVectorIndexTaskNow_ACU(scopeA)).resolves.toMatchObject({ success: true });
    expect(h.archive).toHaveBeenCalledWith(expect.objectContaining({ isolationKey: 'iso-a', sourceTableKey: 'summary-a' }));
    expect(isSummaryVectorIndexDirtyForRealign_ACU(scopeA)).toBe(false);
    expect(isSummaryVectorIndexDirtyForRealign_ACU(scopeB)).toBe(true);
    clearSummaryVectorIndexDirtyForRealign_ACU(scopeB);
  });

  it('scope key 对分隔符输入无碰撞，防止任务与 dirty state 串扰', () => {
    const scopeA = buildSummaryVectorIndexFlushScopeKey_ACU('a::b', 'c', 'd');
    const scopeB = buildSummaryVectorIndexFlushScopeKey_ACU('a', 'b::c', 'd');
    expect(scopeA).not.toBe(scopeB);
    markSummaryVectorIndexDirtyForRealign_ACU(scopeA, 'runtime_stale_rows');
    markSummaryVectorIndexDirtyForRealign_ACU(scopeB, 'runtime_stale_rows');
    clearSummaryVectorIndexDirtyForRealign_ACU(scopeA);
    expect(isSummaryVectorIndexDirtyForRealign_ACU(scopeB)).toBe(true);
    clearSummaryVectorIndexDirtyForRealign_ACU(scopeB);
  });

  it('默认空槽 legacy task 迁移到 canonical scope 后继续执行，不静默丢失 dirty state', async () => {
    h.isolationKey = '';
    h.task = task('flush::chat-a', { isolationKey: '' });
    const canonicalScope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'default', 'summary-a');
    h.reconcileLegacy.mockResolvedValueOnce({ outcome: 'migrated', task: task(canonicalScope, { isolationKey: 'default' }) });
    h.get.mockImplementation(async (scopeKey: string) => scopeKey === canonicalScope
      ? task(canonicalScope, { isolationKey: 'default' })
      : h.task);
    h.getStrict.mockImplementation(async (scopeKey: string) => scopeKey === canonicalScope ? task(canonicalScope, { isolationKey: 'default' }) : h.task);

    await expect(flushSummaryVectorIndexTaskNow_ACU('flush::chat-a')).resolves.toMatchObject({
      success: true,
    });
    expect(h.reconcileLegacy).toHaveBeenCalledWith(expect.objectContaining({
      legacyScopeKey: 'flush::chat-a',
      canonicalScopeKey: canonicalScope,
      isolationKey: 'default',
    }));
    expect(h.archive).toHaveBeenCalledWith(expect.objectContaining({ isolationKey: 'default' }));
    expect(h.logIdentityEvent).toHaveBeenCalledWith(
      'debug',
      'flush',
      'legacy_scope_migrated',
      expect.objectContaining({ scopeFingerprint: canonicalScope }),
    );
  });

  it('canonical scopeKey 但 isolation 字段为空的 legacy task 原地迁移，保留待归档状态', async () => {
    h.isolationKey = '';
    const canonicalScope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'default', 'summary-a');
    h.task = task(canonicalScope, { isolationKey: '', status: 'queued', generation: 8 });
    let readCount = 0;
    h.get.mockImplementation(async () => {
      readCount += 1;
      return readCount === 1
        ? h.task
        : task(canonicalScope, { isolationKey: 'default', status: 'queued', generation: 8 });
    });
    h.reconcileLegacy.mockResolvedValueOnce({
      outcome: 'migrated',
      task: task(canonicalScope, { isolationKey: 'default', status: 'queued', generation: 8 }),
    });
    h.getStrict.mockImplementation(async () => task(canonicalScope, { isolationKey: 'default', status: 'queued', generation: 8 }));

    await expect(flushSummaryVectorIndexTaskNow_ACU(canonicalScope)).resolves.toMatchObject({ success: true });

    expect(h.reconcileLegacy).toHaveBeenCalledWith(expect.objectContaining({
      legacyScopeKey: canonicalScope,
      canonicalScopeKey: canonicalScope,
      isolationKey: 'default',
    }));
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.archive).toHaveBeenCalledWith(expect.objectContaining({ isolationKey: 'default', expectedFlushGeneration: 8 }));
  });

  it('执行时 active isolation 漂移会拒绝任务，不执行 archive', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-b', 'summary-a');
    h.task = task(scope, { isolationKey: 'iso-b' });
    await expect(flushSummaryVectorIndexTaskNow_ACU(scope)).resolves.toMatchObject({ reason: 'flush_scope_mismatch' });
    expect(h.archive).not.toHaveBeenCalled();
  });

  it('不可恢复的 flush 失败记录 terminal identity event', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.task = task(scope);
    h.archive.mockResolvedValueOnce({ success: false, reason: 'target_message_invalid', errors: ['target invalid'] });

    await expect(flushSummaryVectorIndexTaskNow_ACU(scope)).resolves.toMatchObject({
      success: false,
      reason: 'target_message_invalid',
    });

    expect(h.logIdentityEvent).toHaveBeenCalledWith(
      'warn',
      'flush',
      'failed_terminal',
      expect.objectContaining({ scopeFingerprint: scope, error: 'target invalid' }),
    );
  });

  it('即时重建前持久化当前 scope 的失效墓碑，后续 restore 不会重复调度', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.task = task(scope);
    h.list.mockResolvedValue([]);

    await expect(clearSummaryVectorIndexFlushQueueForCurrentScope_ACU({
      isolationKey: 'iso-a',
      sourceTableKey: 'summary-a',
    })).resolves.toBe(1);

    expect(h.invalidate).toHaveBeenCalledWith({ scopeKey: scope, chatKey: 'chat-a', isolationKey: 'iso-a', sourceTableKey: 'summary-a' });
    await expect(restoreSummaryVectorIndexFlushQueueForCurrentChat_ACU()).resolves.toBe(0);
  });

  it('archive 返回 generation 取消结果时不标记 retryable failure', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.task = task(scope);
    h.archive.mockResolvedValueOnce({ success: false, skipped: true, reason: 'flush_scope_invalidated', errors: [] });

    await expect(flushSummaryVectorIndexTaskNow_ACU(scope)).resolves.toMatchObject({ success: true, skipped: true, reason: 'flush_scope_invalidated' });
    expect(h.archive).toHaveBeenCalledWith(expect.objectContaining({ expectedFlushScopeKey: scope, expectedFlushGeneration: 0 }));
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it('默认 isolation 只失效 canonical default scope，并将 task 字段写为 default', async () => {
    const defaultScope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', '', 'summary-a');
    await clearSummaryVectorIndexFlushQueueForCurrentScope_ACU({ isolationKey: '', sourceTableKey: 'summary-a' });

    expect(h.invalidate).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: defaultScope, isolationKey: 'default' }));
    expect(h.list).not.toHaveBeenCalled();
    expect(h.removeStrict).not.toHaveBeenCalled();
  });

  it('恢复只查询当前 active 三元 scope', async () => {
    await expect(restoreSummaryVectorIndexFlushQueueForCurrentChat_ACU()).resolves.toBe(0);
    expect(h.list).toHaveBeenCalledWith({ chatKey: 'chat-a', isolationKey: 'iso-a', sourceTableKey: 'summary-a' });
  });

  it('restore 遇到 legacy 空槽与 canonical task 并存时按裁决结果只调度一个 canonical task', async () => {
    h.isolationKey = '';
    const canonicalScope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'default', 'summary-a');
    const legacyTask = task('flush::chat-a', { isolationKey: '', generation: 4 });
    const canonicalTask = task(canonicalScope, { isolationKey: 'default', generation: 5 });
    h.list.mockResolvedValue([legacyTask, canonicalTask]);
    h.reconcileLegacy.mockResolvedValueOnce({ outcome: 'canonical_retained', task: canonicalTask });

    await expect(restoreSummaryVectorIndexFlushQueueForCurrentChat_ACU()).resolves.toBe(1);

    expect(h.reconcileLegacy).toHaveBeenCalledWith(expect.objectContaining({
      legacyScopeKey: 'flush::chat-a', canonicalScopeKey: canonicalScope,
    }));
    expect(h.archive).not.toHaveBeenCalled();
  });

  it('双 flushing legacy/canonical 冲突进入 quarantine，不执行任一 archive', async () => {
    h.isolationKey = '';
    const canonicalScope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'default', 'summary-a');
    h.task = task('flush::chat-a', { isolationKey: '', status: 'flushing' });
    h.reconcileLegacy.mockResolvedValueOnce({ outcome: 'quarantined', task: task(canonicalScope, { isolationKey: 'default', status: 'failed_terminal' }) });

    await expect(flushSummaryVectorIndexTaskNow_ACU('flush::chat-a')).resolves.toMatchObject({ reason: 'flush_legacy_scope_quarantined' });
    expect(h.archive).not.toHaveBeenCalled();
  });

  it('新 enqueue 仅以更高 generation 替换墓碑，不能复活旧 runner', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.getStrict.mockResolvedValue(task(scope, { status: 'invalidated', generation: 4 }));
    h.upsert.mockImplementation(async (input: any) => ({ ...task(scope), ...input, generation: input.generation, status: 'queued' }));

    await expect(enqueueSummaryVectorIndexFlush_ACU({ debounceMs: 100, isolationKey: 'iso-a', sourceTableKey: 'summary-a' }))
      .resolves.toMatchObject({ queued: true, scopeKey: scope });

    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: scope, generation: 5, status: 'queued' }));
  });

  it('旧 runner 已进入 flushing 时新 enqueue 使用下一 generation，避免共享收尾归属', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.getStrict.mockResolvedValue(task(scope, { status: 'flushing', generation: 4 }));
    h.upsert.mockImplementation(async (input: any) => ({ ...task(scope), ...input, generation: input.generation, status: 'queued' }));

    await expect(enqueueSummaryVectorIndexFlush_ACU({ debounceMs: 100, isolationKey: 'iso-a', sourceTableKey: 'summary-a' }))
      .resolves.toMatchObject({ queued: true, scopeKey: scope });

    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: scope, generation: 5, status: 'queued' }));
  });

  it('真实 timer 触发后在 archive 发布前校验捕获的 generation', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.task = task(scope, { generation: 0, debounceUntil: Date.now() + 100 });
    h.upsert.mockImplementation(async (input: any) => {
      h.task = { ...h.task, ...input, generation: input.generation ?? h.task?.generation ?? 0, attemptCount: 0, updatedAt: Date.now() };
      return h.task;
    });
    h.get.mockImplementation(async () => h.task);

    await enqueueSummaryVectorIndexFlush_ACU({ debounceMs: 100, isolationKey: 'iso-a', sourceTableKey: 'summary-a' });
    await vi.advanceTimersByTimeAsync(100);

    expect(h.archive).toHaveBeenCalledWith(expect.objectContaining({
      expectedFlushScopeKey: scope,
      expectedFlushGeneration: 0,
    }));
    expect(h.markReadyIfGenerationMatches).toHaveBeenCalledWith(scope, 0);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('旧 runner 成功收尾不会覆盖新 generation 的任务或墓碑', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.task = task(scope, { generation: 0 });
    h.archive.mockResolvedValueOnce({ success: true, skipped: false, errors: [] });
    h.markReadyIfGenerationMatches.mockResolvedValueOnce(false);

    await expect(flushSummaryVectorIndexTaskNow_ACU(scope)).resolves.toMatchObject({ success: true });
    expect(h.markReadyIfGenerationMatches).toHaveBeenCalledWith(scope, 0);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('新 generation timer 在旧 runner 期间命中 running 时，旧 runner 结束后会接力重调度', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    const oldTask = task(scope, { generation: 0, status: 'queued' });
    const nextTask = task(scope, { generation: 1, status: 'queued', debounceUntil: Date.now() });
    h.task = oldTask;
    let releaseOldArchive!: () => void;
    h.archive
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOldArchive = resolve; }))
      .mockResolvedValueOnce({ success: true, skipped: false, errors: [] });
    h.getStrict.mockImplementation(async () => h.task);
    h.upsert.mockImplementation(async (input: any) => {
      if (input.status === 'queued' && input.generation === 1) h.task = { ...nextTask, ...input };
      else if (input.status === 'flushing' && input.generation === 0) h.task = { ...oldTask, ...input };
      return { ...h.task, ...input, attemptCount: 0, updatedAt: Date.now() };
    });
    h.markReadyIfGenerationMatches
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const oldRunner = flushSummaryVectorIndexTaskNow_ACU(scope);
    for (let attempt = 0; attempt < 10 && !releaseOldArchive; attempt += 1) await Promise.resolve();
    expect(releaseOldArchive).toBeTypeOf('function');

    await enqueueSummaryVectorIndexFlush_ACU({ debounceMs: 0, isolationKey: 'iso-a', sourceTableKey: 'summary-a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.archive).toHaveBeenCalledTimes(1);

    releaseOldArchive();
    await oldRunner;
    await vi.advanceTimersByTimeAsync(0);

    expect(h.archive).toHaveBeenCalledTimes(2);
    expect(h.archive.mock.calls[1][0]).toMatchObject({ expectedFlushScopeKey: scope, expectedFlushGeneration: 1 });
    expect(isSummaryVectorIndexDirtyForRealign_ACU(scope)).toBe(false);
  });

  it('timer 已触发后会把捕获 generation 传入 archive 的发布前校验', async () => {
    const scope = buildSummaryVectorIndexFlushScopeKey_ACU('chat-a', 'iso-a', 'summary-a');
    h.task = task(scope, { generation: 0, debounceUntil: Date.now() + 100 });
    h.upsert.mockImplementation(async (input: any) => ({ ...h.task, ...input, generation: 0 }));
    await enqueueSummaryVectorIndexFlush_ACU({ debounceMs: 100, isolationKey: 'iso-a', sourceTableKey: 'summary-a' });
    await vi.advanceTimersByTimeAsync(100);
    await clearSummaryVectorIndexFlushQueueForCurrentScope_ACU({ isolationKey: 'iso-a', sourceTableKey: 'summary-a' });
    expect(h.archive).toHaveBeenCalledWith(expect.objectContaining({ expectedFlushScopeKey: scope, expectedFlushGeneration: 0 }));
  });
});
