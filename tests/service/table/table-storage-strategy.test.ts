/**
 * tests/service/table/table-storage-strategy.test.ts
 * 表格存储策略选择器单元测试
 *
 * 策略：通过模块级可变变量控制 mock provider 的 loadFromChat 行为，
 * 验证 initStorageProvider/switchStorageMode/reloadStorageProvider 的编排逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _resetTableWriteTransactionLocksForTest_ACU, captureTableRuntimeRevisionForWriteSet_ACU, runTableWriteTransaction_ACU } from '../../../src/service/table/table-write-transaction';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
}));

// mock storage-mode
let mockStorageMode: string = 'native';
vi.mock('../../../src/service/table/storage-mode', () => ({
  getCurrentStorageMode: vi.fn(() => mockStorageMode),
}));

const mockLoadOrCreateJsonTableFromChatHistory = vi.fn().mockResolvedValue({
  loaded: true,
  source: 'merged',
  data: { mate: {} },
});
vi.mock('../../../src/service/table/table-service', () => ({
  loadOrCreateJsonTableFromChatHistory_ACU: (...args: any[]) => mockLoadOrCreateJsonTableFromChatHistory(...args),
}));

// ═══════════════════════════════════════════════════════════════
// 可变控制变量：控制 SQLite provider 的 loadFromChat 行为
// ═══════════════════════════════════════════════════════════════
let sqliteLoadResult: { loaded: boolean; source: 'merged' | 'initialized' | 'empty'; error?: string } = { loaded: true, source: 'merged' };
let sqliteLoadShouldThrow: Error | null = null;
let nativeReloadGate: Promise<void> | null = null;
let nativeReloadStarted: (() => void) | null = null;

// 记录所有创建的 provider 实例，用于验证 dispose 等调用
let allCreatedProviders: Array<ReturnType<typeof createMockProvider>> = [];

function createMockProvider(mode: 'native' | 'sqlite') {
  let currentData: any = { mate: {} };
  const provider = {
    mode,
    loadFromChat: vi.fn(async () => {
      if (mode === 'sqlite' && sqliteLoadShouldThrow) {
        throw sqliteLoadShouldThrow;
      }
      if (mode === 'sqlite') {
        return { ...sqliteLoadResult };
      }
      if (nativeReloadGate) {
        nativeReloadStarted?.();
        await nativeReloadGate;
      }
      return { loaded: true, source: 'merged' as const };
    }),
    loadFromData: vi.fn(async (data?: any) => {
      if (mode === 'sqlite' && sqliteLoadShouldThrow) {
        throw sqliteLoadShouldThrow;
      }
      currentData = data || null;
      if (mode === 'sqlite') {
        return { ...sqliteLoadResult };
      }
      return { loaded: true, source: 'merged' as const };
    }),
    saveToChat: vi.fn().mockResolvedValue({ saved: true }),
    isReady: vi.fn().mockReturnValue(true),
    getCurrentData: vi.fn(() => currentData),
    applyEdits: vi.fn().mockReturnValue({ success: true, modifiedKeys: [], appliedEdits: 1 }),
    executeQuery: vi.fn(),
    executeMutation: vi.fn(),
    dispose: vi.fn(),
  };
  allCreatedProviders.push(provider);
  return provider;
}

// mock SqlTableService 和 NativeTableServiceAdapter
vi.mock('../../../src/service/table/sql-table-service', () => ({
  SqlTableService: vi.fn(() => createMockProvider('sqlite')),
}));

vi.mock('../../../src/service/table/native-table-service-adapter', () => ({
  NativeTableServiceAdapter: vi.fn(() => createMockProvider('native')),
}));

import {
  getStorageProvider,
  getActiveStorageProvider,
  initStorageProvider,
  ensureStorageProviderReady_ACU,
  switchStorageMode,
  reloadStorageProvider,
  disposeStorageProvider,
  getCurrentProviderMode,
  getStorageRuntimeHealth_ACU,
  didSqliteFallbackAfterReload_ACU,
} from '../../../src/service/table/table-storage-strategy';

function deferred_ACU<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('table-storage-strategy', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetTableWriteTransactionLocksForTest_ACU();
    mockStorageMode = 'native';
    sqliteLoadResult = { loaded: true, source: 'merged' };
    sqliteLoadShouldThrow = null;
    nativeReloadGate = null;
    nativeReloadStarted = null;
    allCreatedProviders = [];
    mockLoadOrCreateJsonTableFromChatHistory.mockResolvedValue({ loaded: true, source: 'merged', data: { mate: {} } });
    // 重置模块内部状态
    await initStorageProvider();
    // 清空记录，让后续测试从干净状态开始
    allCreatedProviders = [];
  });

  // ═══════════════════════════════════════════════════════════════
  // getStorageProvider
  // ═══════════════════════════════════════════════════════════════
  describe('getStorageProvider', () => {
    it('返回当前 Provider', () => {
      const provider = getStorageProvider();
      expect(provider).toBeDefined();
      expect(provider.mode).toBe('native');
    });

    it('懒初始化：未初始化时自动创建', () => {
      const provider = getStorageProvider();
      expect(provider).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getActiveStorageProvider
  // ═══════════════════════════════════════════════════════════════
  describe('getActiveStorageProvider', () => {
    it('返回已初始化实例，且设置变化不会触发重建', () => {
      const provider = getActiveStorageProvider();
      const createdCount = allCreatedProviders.length;

      mockStorageMode = 'sqlite';

      expect(getActiveStorageProvider()).toBe(provider);
      expect(provider?.mode).toBe('native');
      expect(allCreatedProviders).toHaveLength(createdCount);
    });

    it('dispose 后返回 null，不执行惰性初始化', async () => {
      await initStorageProvider();
      const provider = getActiveStorageProvider();

      disposeStorageProvider();

      expect(provider?.dispose).toHaveBeenCalledOnce();
      expect(getActiveStorageProvider()).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // initStorageProvider
  // ═══════════════════════════════════════════════════════════════
  describe('initStorageProvider', () => {
    it('native 模式初始化', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      expect(getCurrentProviderMode()).toBe('native');
    });

    it('sqlite 模式初始化', async () => {
      mockStorageMode = 'sqlite';
      await initStorageProvider();
      expect(getCurrentProviderMode()).toBe('sqlite');
    });

    it('sqlite 初始化使用本轮 canonical 回放快照，而非 provider 自行回放聊天', async () => {
      mockStorageMode = 'sqlite';
      const canonicalData = { mate: {}, sheet_0: { content: [['row_id'], ['1']] } };
      mockLoadOrCreateJsonTableFromChatHistory.mockResolvedValue({ loaded: true, source: 'merged', data: canonicalData });

      await initStorageProvider();

      const provider = getActiveStorageProvider()!;
      expect(provider.mode).toBe('sqlite');
      expect(provider.loadFromData).toHaveBeenCalledWith(canonicalData);
      expect(provider.loadFromChat).not.toHaveBeenCalled();
      expect(mockLoadOrCreateJsonTableFromChatHistory).toHaveBeenCalledOnce();
    });

    it('初始化时调用 loadFromChat', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      const provider = getStorageProvider();
      expect(provider.loadFromChat).toHaveBeenCalled();
    });

    it('SQLite 加载失败时 fallback 到 native', async () => {
      mockStorageMode = 'sqlite';
      sqliteLoadResult = { loaded: false, source: 'empty', error: 'sql.js 加载失败' };

      const result = await initStorageProvider();
      // fallback 后应该是 native 模式
      expect(getCurrentProviderMode()).toBe('native');
      expect(result).toMatchObject({ ok: false, degraded: true, failureCode: 'provider_fallback' });
      expect(getStorageRuntimeHealth_ACU()).toMatchObject({
        status: 'degraded', expectedMode: 'sqlite', activeMode: 'native', failureCode: 'provider_fallback',
      });
    });

    it('同一 SQLite 初始化航班复用单次 canonical replay', async () => {
      mockStorageMode = 'sqlite';
      let releaseReplay: ((value: any) => void) | undefined;
      mockLoadOrCreateJsonTableFromChatHistory.mockImplementationOnce(() => new Promise(resolve => {
        releaseReplay = resolve;
      }));

      const first = initStorageProvider();
      const second = initStorageProvider();

      expect(mockLoadOrCreateJsonTableFromChatHistory).toHaveBeenCalledTimes(1);
      releaseReplay?.({ loaded: true, source: 'merged', data: { mate: {} } });

      await expect(first).resolves.toMatchObject({ ok: true, degraded: false, source: 'merged' });
      await expect(second).resolves.toMatchObject({ ok: true, degraded: false, source: 'merged' });
      expect(allCreatedProviders.filter(provider => provider.mode === 'sqlite')).toHaveLength(1);
    });

    it('设置在候选 SQLite hydrate 期间切换时丢弃陈旧候选', async () => {
      mockStorageMode = 'sqlite';
      let releaseReplay: ((value: any) => void) | undefined;
      mockLoadOrCreateJsonTableFromChatHistory.mockImplementationOnce(() => new Promise(resolve => {
        releaseReplay = resolve;
      }));

      const initialization = initStorageProvider();
      expect(mockLoadOrCreateJsonTableFromChatHistory).toHaveBeenCalledTimes(1);
      mockStorageMode = 'native';
      releaseReplay?.({ loaded: true, source: 'merged', data: { mate: {} } });

      await expect(initialization).resolves.toMatchObject({ ok: false, degraded: false, failureCode: 'stale_load_discarded' });
      expect(getCurrentProviderMode()).toBe('native');
      expect(allCreatedProviders.find(provider => provider.mode === 'sqlite')?.dispose).toHaveBeenCalledOnce();
      expect(getStorageRuntimeHealth_ACU()).toMatchObject({
        status: 'idle', expectedMode: 'native', failureCode: 'stale_load_discarded',
      });
    });

    it('SQLite 初始化异常时 fallback 到 native', async () => {
      mockStorageMode = 'sqlite';
      sqliteLoadShouldThrow = new Error('WASM 加载失败');

      await initStorageProvider();
      expect(getCurrentProviderMode()).toBe('native');
    });

    it('SQLite 初始化异常时销毁未提交的候选，避免其继续持有全局映射发布权', async () => {
      mockStorageMode = 'sqlite';
      sqliteLoadShouldThrow = new Error('WASM 加载失败');

      await initStorageProvider();

      const sqliteCandidate = allCreatedProviders.find(provider => provider.mode === 'sqlite');
      expect(sqliteCandidate).toBeDefined();
      // 恰好一次：候选既不能泄漏，也不能被重复销毁。
      expect(sqliteCandidate!.dispose).toHaveBeenCalledTimes(1);
      expect(getCurrentProviderMode()).toBe('native');
    });

    it('销毁旧实例后创建新实例', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      const oldProvider = getStorageProvider();

      await initStorageProvider();
      // 旧 provider 应该被 dispose
      expect(oldProvider.dispose).toHaveBeenCalled();
    });
  });

  describe('ensureStorageProviderReady_ACU', () => {
    it('SQLite fallback 后不创建裸 SQLite，并明确阻止 SQL 写入', async () => {
      mockStorageMode = 'sqlite';
      sqliteLoadResult = { loaded: false, source: 'empty', error: '旧数据 hydrate 失败' };

      await initStorageProvider();
      const fallbackProvider = getActiveStorageProvider()!;
      const createdCount = allCreatedProviders.length;

      await expect(ensureStorageProviderReady_ACU()).rejects.toThrow('sqlite 存储运行时未就绪');

      const activeProvider = getActiveStorageProvider()!;
      expect(activeProvider).not.toBe(fallbackProvider);
      expect(activeProvider.mode).toBe('native');
      expect(activeProvider.isReady()).toBe(true);
      expect(allCreatedProviders).toHaveLength(createdCount + 2);
      expect(allCreatedProviders.at(-1)?.mode).toBe('native');
      expect(allCreatedProviders.at(-2)?.mode).toBe('sqlite');
      const attemptedSqliteProvider = allCreatedProviders.at(-2)!;
      expect(attemptedSqliteProvider.loadFromData).toHaveBeenCalledOnce();
    });

    it('已 ready 的 SQLite 直接返回原实例，不再次回放或 hydrate', async () => {
      mockStorageMode = 'sqlite';
      await initStorageProvider();
      const provider = getActiveStorageProvider()!;
      const createdCount = allCreatedProviders.length;

      await expect(ensureStorageProviderReady_ACU()).resolves.toBe(provider);

      expect(allCreatedProviders).toHaveLength(createdCount);
      expect(mockLoadOrCreateJsonTableFromChatHistory).toHaveBeenCalledOnce();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // switchStorageMode
  // ═══════════════════════════════════════════════════════════════
  describe('switchStorageMode', () => {
    it('从 native 切换到 sqlite', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      expect(getCurrentProviderMode()).toBe('native');

      await switchStorageMode('sqlite');
      expect(getCurrentProviderMode()).toBe('sqlite');
    });

    it('同模式切换跳过（不重新创建）', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      const provider = getStorageProvider();

      await switchStorageMode('native');
      // 不应该 dispose（因为跳过了）
      expect(provider.dispose).not.toHaveBeenCalled();
    });

    it('切换时销毁旧 Provider', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      const oldProvider = getStorageProvider();

      await switchStorageMode('sqlite');
      expect(oldProvider.dispose).toHaveBeenCalled();
    });

    it('SQLite 切换失败时 fallback 并抛出错误', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();

      // 设置 SQLite 加载失败
      sqliteLoadResult = { loaded: false, source: 'empty', error: 'WASM 错误' };

      await expect(switchStorageMode('sqlite')).rejects.toThrow('已自动回退');
      // fallback 后应该是 native
      expect(getCurrentProviderMode()).toBe('native');
    });

    it('SQLite 切换异常时 fallback', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();

      sqliteLoadShouldThrow = new Error('意外错误');

      await expect(switchStorageMode('sqlite')).rejects.toThrow('意外错误');
      // 应该有可用的 provider
      expect(getCurrentProviderMode()).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // reloadStorageProvider
  // ═══════════════════════════════════════════════════════════════
  describe('reloadStorageProvider', () => {
    it('重载前后 canonical 数据一致时不推进 RuntimeRevision', async () => {
      mockStorageMode = 'sqlite';
      mockLoadOrCreateJsonTableFromChatHistory.mockResolvedValue({ loaded: true, source: 'merged', data: { mate: {}, sheet_0: { content: [['row_id'], ['1']] } } });
      await initStorageProvider();
      const before = captureTableRuntimeRevisionForWriteSet_ACU([{ kind: 'all' }]);

      await reloadStorageProvider();

      const after = captureTableRuntimeRevisionForWriteSet_ACU([{ kind: 'all' }]);
      expect(after).toBe(before);
    });

    it('重载替换了 canonical 数据时只推进一次 RuntimeRevision', async () => {
      mockStorageMode = 'sqlite';
      mockLoadOrCreateJsonTableFromChatHistory.mockResolvedValue({ loaded: true, source: 'merged', data: { mate: {}, sheet_0: { content: [['row_id'], ['1']] } } });
      await initStorageProvider();
      const before = captureTableRuntimeRevisionForWriteSet_ACU([{ kind: 'all' }]);
      mockLoadOrCreateJsonTableFromChatHistory.mockResolvedValue({ loaded: true, source: 'merged', data: { mate: {}, sheet_0: { content: [['row_id'], ['1'], ['2']] } } });

      await reloadStorageProvider();

      const after = captureTableRuntimeRevisionForWriteSet_ACU([{ kind: 'all' }]);
      expect(after).not.toBe(before);
      const afterSecondCapture = captureTableRuntimeRevisionForWriteSet_ACU([{ kind: 'all' }]);
      expect(afterSecondCapture).toBe(after);
    });

    it('native 模式重新加载', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      const provider = getStorageProvider();

      await reloadStorageProvider();
      // native 模式直接调用 loadFromChat
      expect(provider.loadFromChat).toHaveBeenCalled();
    });

    it('sqlite 模式重建数据库', async () => {
      mockStorageMode = 'sqlite';
      await initStorageProvider();
      allCreatedProviders = []; // 清空记录

      const oldProvider = getStorageProvider();

      await reloadStorageProvider();
      // sqlite 模式需要 dispose 旧实例并重建
      expect(oldProvider.dispose).toHaveBeenCalled();
      // 应该创建了新的 provider
      expect(allCreatedProviders.length).toBeGreaterThan(0);
    });

    it('SQLite 重新加载失败时 fallback', async () => {
      mockStorageMode = 'sqlite';
      await initStorageProvider();

      // 设置重新加载时失败
      sqliteLoadShouldThrow = new Error('重新加载失败');

      await reloadStorageProvider();
      // fallback 到 native
      expect(getCurrentProviderMode()).toBe('native');
    });

    it('等待同一作用域的活跃写事务释放后才重建运行时', async () => {
      const releaseWriter = deferred_ACU();
      const writerStarted = deferred_ACU();
      const events: string[] = [];
      const provider = getStorageProvider();
      provider.loadFromChat.mockClear();

      const writer = runTableWriteTransaction_ACU({
        source: 'manual_crud',
        reason: 'concurrent-write',
        writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
      }, async () => {
        events.push('writer:start');
        writerStarted.resolve();
        await releaseWriter.promise;
        events.push('writer:end');
      });
      await writerStarted.promise;

      const reload = reloadStorageProvider().then(() => events.push('reload:end'));
      await Promise.resolve();
      expect(events).toEqual(['writer:start']);
      expect(provider.loadFromChat).not.toHaveBeenCalled();

      releaseWriter.resolve();
      await Promise.all([writer, reload]);
      expect(events).toEqual(['writer:start', 'writer:end', 'reload:end']);
      expect(provider.dispose).toHaveBeenCalledOnce();
      expect(getActiveStorageProvider()?.loadFromChat).toHaveBeenCalledOnce();
    });

    it('重建运行时期间阻塞同一作用域的新写事务', async () => {
      const releaseReload = deferred_ACU();
      const reloadStarted = deferred_ACU();
      const writerStarted = deferred_ACU();
      const events: string[] = [];
      nativeReloadGate = releaseReload.promise;
      nativeReloadStarted = () => reloadStarted.resolve();

      const reload = reloadStorageProvider().then(() => events.push('reload:end'));
      await reloadStarted.promise;

      const writer = runTableWriteTransaction_ACU({
        source: 'manual_crud',
        reason: 'write-during-reload',
        writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
      }, async () => {
        events.push('writer:start');
        writerStarted.resolve();
      });
      await Promise.resolve();
      expect(events).toEqual([]);

      releaseReload.resolve();
      await reload;
      await writerStarted.promise;
      await writer;
      expect(events).toEqual(['reload:end', 'writer:start']);
    });

    it('readiness 请求复用活跃 reload 航班，不基于旧 ready provider 提前放行', async () => {
      const releaseReload = deferred_ACU();
      const reloadStarted = deferred_ACU();
      nativeReloadGate = releaseReload.promise;
      nativeReloadStarted = () => reloadStarted.resolve();

      const oldProvider = getActiveStorageProvider();
      const reload = reloadStorageProvider();
      await reloadStarted.promise;

      let readinessSettled = false;
      const readiness = ensureStorageProviderReady_ACU().then((provider) => {
        readinessSettled = true;
        return provider;
      });
      await Promise.resolve();

      expect(readinessSettled).toBe(false);
      expect(getActiveStorageProvider()).toBe(oldProvider);

      releaseReload.resolve();
      const [loadResult, readyProvider] = await Promise.all([reload, readiness]);
      expect(loadResult).toMatchObject({ ok: true, degraded: false });
      expect(readyProvider).toBe(getActiveStorageProvider());
      expect(readyProvider).not.toBe(oldProvider);
    });

    it('等待活跃 reload readiness 时可取消，且不会取消全局 reload 航班', async () => {
      const releaseReload = deferred_ACU();
      const reloadStarted = deferred_ACU();
      nativeReloadGate = releaseReload.promise;
      nativeReloadStarted = () => reloadStarted.resolve();

      const reload = reloadStorageProvider();
      await reloadStarted.promise;
      const controller = new AbortController();
      const readiness = ensureStorageProviderReady_ACU({ signal: controller.signal });

      controller.abort();
      await expect(readiness).rejects.toMatchObject({ name: 'AbortError' });

      releaseReload.resolve();
      await expect(reload).resolves.toMatchObject({ ok: true, degraded: false });
      expect(getStorageRuntimeHealth_ACU().status).toBe('ready');
    });

    it('排他 reload 不复用锁外初始化航班，并丢弃旧候选', async () => {
      mockStorageMode = 'sqlite';
      const releaseOldReplay = deferred_ACU<any>();
      const writerStarted = deferred_ACU();
      const releaseWriter = deferred_ACU();
      const activeProviderBeforeReload = getActiveStorageProvider()!;
      mockLoadOrCreateJsonTableFromChatHistory
        .mockImplementationOnce(() => releaseOldReplay.promise)
        .mockResolvedValueOnce({ loaded: true, source: 'merged', data: { mate: { generation: 'reload' } } });

      const oldInitialization = initStorageProvider();
      expect(mockLoadOrCreateJsonTableFromChatHistory).toHaveBeenCalledOnce();
      const staleCandidate = allCreatedProviders.find(provider => provider.mode === 'sqlite')!;
      const writer = runTableWriteTransaction_ACU({
        source: 'manual_crud',
        reason: 'write-before-reload',
        writeSet: [{ kind: 'sheet', sheetKey: 'sheet_0' }],
      }, async () => {
        writerStarted.resolve();
        await releaseWriter.promise;
      });
      await writerStarted.promise;

      const reload = reloadStorageProvider();
      releaseOldReplay.resolve({ loaded: true, source: 'merged', data: { mate: { generation: 'old' } } });
      await expect(oldInitialization).resolves.toMatchObject({ failureCode: 'stale_load_discarded' });
      expect(mockLoadOrCreateJsonTableFromChatHistory).toHaveBeenCalledOnce();
      expect(staleCandidate.dispose).toHaveBeenCalledOnce();
      expect(activeProviderBeforeReload.dispose).not.toHaveBeenCalled();
      expect(getActiveStorageProvider()).toBe(activeProviderBeforeReload);

      releaseWriter.resolve();
      await reload;

      expect(mockLoadOrCreateJsonTableFromChatHistory).toHaveBeenCalledTimes(2);
      const reloadedProvider = getActiveStorageProvider()!;
      expect(reloadedProvider.loadFromData).toHaveBeenCalledWith({ mate: { generation: 'reload' } });
      expect(getActiveStorageProvider()).toBe(reloadedProvider);
      await writer;
    });

    it('并发 reload 复用同一排他航班，不会废弃已持锁的 hydrate', async () => {
      const releaseReload = deferred_ACU();
      const reloadStarted = deferred_ACU();
      nativeReloadGate = releaseReload.promise;
      nativeReloadStarted = () => reloadStarted.resolve();

      const first = reloadStorageProvider();
      await reloadStarted.promise;
      const second = reloadStorageProvider();

      releaseReload.resolve();
      await expect(second).resolves.toMatchObject({ ok: true });
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // disposeStorageProvider
  // ═══════════════════════════════════════════════════════════════
  describe('disposeStorageProvider', () => {
    it('销毁后 getCurrentProviderMode 返回 null', async () => {
      mockStorageMode = 'sqlite';
      await initStorageProvider();
      expect(getCurrentProviderMode()).toBe('sqlite');

      disposeStorageProvider();
      expect(getCurrentProviderMode()).toBeNull();
    });

    it('销毁后 getStorageProvider 会懒初始化新实例', async () => {
      mockStorageMode = 'sqlite';
      await initStorageProvider();
      const oldProvider = getStorageProvider();

      disposeStorageProvider();
      expect(oldProvider.dispose).toHaveBeenCalled();

      // 懒初始化会创建新实例
      const newProvider = getStorageProvider();
      expect(newProvider).toBeDefined();
      expect(newProvider).not.toBe(oldProvider);
    });

    it('dispose 会废弃未完成的 SQLite 候选，避免其重新发布', async () => {
      mockStorageMode = 'sqlite';
      const releaseReplay = deferred_ACU<any>();
      mockLoadOrCreateJsonTableFromChatHistory.mockImplementationOnce(() => releaseReplay.promise);

      const initialization = initStorageProvider();
      const staleCandidate = allCreatedProviders.find(provider => provider.mode === 'sqlite')!;
      disposeStorageProvider();
      releaseReplay.resolve({ loaded: true, source: 'merged', data: { mate: { generation: 'old-chat' } } });

      await expect(initialization).resolves.toMatchObject({ failureCode: 'stale_load_discarded' });
      expect(staleCandidate.dispose).toHaveBeenCalledOnce();
      expect(getActiveStorageProvider()).toBeNull();
    });

    it('未初始化时 dispose 不抛错', () => {
      disposeStorageProvider(); // 先清空
      expect(() => disposeStorageProvider()).not.toThrow();
    });

    it('native 模式下 dispose 也能正常工作', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      const provider = getStorageProvider();

      disposeStorageProvider();
      expect(provider.dispose).toHaveBeenCalled();
      expect(getCurrentProviderMode()).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getCurrentProviderMode
  // ═══════════════════════════════════════════════════════════════
  describe('getCurrentProviderMode', () => {
    it('初始化后返回当前模式', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      expect(getCurrentProviderMode()).toBe('native');
    });

    it('切换后返回新模式', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();
      await switchStorageMode('sqlite');
      expect(getCurrentProviderMode()).toBe('sqlite');
    });
  });

  describe('didSqliteFallbackAfterReload_ACU', () => {
    it('SQLite 预期与设置保持不变、provider 已为 native 时报告静默 fallback', async () => {
      mockStorageMode = 'sqlite';
      sqliteLoadResult = { loaded: false, source: 'empty', error: 'sql.js 加载失败' };

      await initStorageProvider();

      expect(getCurrentProviderMode()).toBe('native');
      expect(didSqliteFallbackAfterReload_ACU('sqlite')).toBe(true);
    });

    it('reload 期间设置切到 native 时不把 native provider 误报为 fallback', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();

      expect(getCurrentProviderMode()).toBe('native');
      expect(didSqliteFallbackAfterReload_ACU('sqlite')).toBe(false);
    });

    it('SQLite provider 成功就绪时不报告 fallback', async () => {
      mockStorageMode = 'sqlite';
      await initStorageProvider();

      expect(getCurrentProviderMode()).toBe('sqlite');
      expect(didSqliteFallbackAfterReload_ACU('sqlite')).toBe(false);
    });

    it('reload 前预期为 native 时不报告 fallback', async () => {
      mockStorageMode = 'native';
      await initStorageProvider();

      expect(didSqliteFallbackAfterReload_ACU('native')).toBe(false);
    });
  });
});
