/**
 * service/table/table-storage-strategy.ts — 表格存储策略选择器
 *
 * 根据用户设置选择 native 或 sqlite 模式的 Provider。
 * 提供全局单例访问点，是上层代码获取 Provider 的唯一入口。
 */

import type { ITableStorageProvider, StorageMode } from '../../shared/table-storage-provider';
import { getCurrentStorageMode } from './storage-mode';
import { NativeTableServiceAdapter } from './native-table-service-adapter';
import { SqlTableService } from './sql-table-service';
import { logDebug_ACU, logError_ACU } from '../../shared/utils';
import { loadOrCreateJsonTableFromChatHistory_ACU } from './table-service';
import { invalidateTableRuntimeRevision_ACU, runTableWriteTransaction_ACU } from './table-write-transaction';

/** 当前活跃的 Provider 实例 */
let currentProvider: ITableStorageProvider | null = null;

export type StorageRuntimeStatus_ACU = 'idle' | 'loading' | 'ready' | 'degraded' | 'failed' | 'disposed';

export interface StorageRuntimeHealth_ACU {
  status: StorageRuntimeStatus_ACU;
  expectedMode: StorageMode;
  activeMode: StorageMode | null;
  loadToken: number;
  source?: 'merged' | 'initialized' | 'empty';
  failureCode?: 'provider_fallback' | 'provider_load_failed' | 'provider_init_failed' | 'stale_load_discarded';
  error?: string;
}

export interface StorageRuntimeLoadResult_ACU {
  ok: boolean;
  degraded: boolean;
  source?: 'merged' | 'initialized' | 'empty';
  failureCode?: StorageRuntimeHealth_ACU['failureCode'];
  error?: string;
}

let runtimeHealth: StorageRuntimeHealth_ACU = {
  status: 'idle',
  expectedMode: 'native',
  activeMode: null,
  loadToken: 0,
};
let activeInitialization: { mode: StorageMode; promise: Promise<StorageRuntimeLoadResult_ACU> } | null = null;
let initializationEpoch_ACU = 0;
let activeReload_ACU: Promise<StorageRuntimeLoadResult_ACU> | null = null;
let runtimeLifecycleEpoch_ACU = 0;

function setRuntimeHealth_ACU(next: Omit<StorageRuntimeHealth_ACU, 'loadToken'>): void {
  runtimeHealth = { ...next, loadToken: runtimeHealth.loadToken + 1 };
}

/** 只读健康快照；绝不触发 provider 懒初始化。 */
export function getStorageRuntimeHealth_ACU(): StorageRuntimeHealth_ACU {
  return { ...runtimeHealth };
}

/** 同步读路径门禁。模板渲染不能在这里异步 hydrate 或创建裸 SQLite provider。 */
export function isStorageRuntimeReadyForSyncRead_ACU(): boolean {
  const expectedMode = getCurrentStorageMode();
  return runtimeHealth.status === 'ready'
    && runtimeHealth.expectedMode === expectedMode
    && currentProvider?.mode === expectedMode
    && currentProvider.isReady();
}

/**
 * 获取当前存储提供者
 * 如果尚未初始化，会根据当前设置自动创建
 */
export function getStorageProvider(): ITableStorageProvider {
  const mode = getCurrentStorageMode();
  if (!currentProvider || currentProvider.mode !== mode) {
    if (currentProvider) {
      logDebug_ACU(`[StorageStrategy] Provider 模式变化，重建: ${currentProvider.mode} → ${mode}`);
      currentProvider.dispose();
    }
    // 懒初始化：根据当前模式创建 Provider
    currentProvider = createProvider(mode);
    logDebug_ACU(`[StorageStrategy] 懒初始化 Provider: ${mode}`);
  }
  return currentProvider;
}

/**
 * 获取当前已激活的 Provider，不会按设置懒初始化或重建实例。
 * 用于需要观察 SQLite fallback 后实际运行时状态的恢复与诊断流程。
 */
export function getActiveStorageProvider(): ITableStorageProvider | null {
  return currentProvider;
}

export async function ensureStorageProviderReady_ACU(): Promise<ITableStorageProvider> {
  const expectedMode = getCurrentStorageMode();
  const activeProvider = getActiveStorageProvider();
  if (activeProvider?.mode === expectedMode && activeProvider.isReady() && runtimeHealth.status === 'ready') return activeProvider;
  const loadResult = await initStorageProvider();
  const initializedProvider = getActiveStorageProvider();
  if (!initializedProvider || initializedProvider.mode !== expectedMode || !initializedProvider.isReady()) {
    const reason = loadResult.failureCode || runtimeHealth.failureCode || 'unknown';
    throw new Error(`[StorageStrategy] ${expectedMode} 存储运行时未就绪（${reason}），已阻止 SQL 写入。`);
  }
  return initializedProvider;
}

/**
 * 初始化存储提供者（应用启动时调用）
 * 根据当前设置创建 Provider 并执行 loadFromChat
 */
export async function initStorageProvider(options: { forceNewFlight?: boolean } = {}): Promise<StorageRuntimeLoadResult_ACU> {
  const mode = getCurrentStorageMode();
  if (!options.forceNewFlight && activeInitialization?.mode === mode) return activeInitialization.promise;

  const epoch = ++initializationEpoch_ACU;
  const promise = initializeStorageProvider_ACU(mode, epoch);
  activeInitialization = { mode, promise };
  try {
    return await promise;
  } finally {
    if (activeInitialization?.promise === promise) activeInitialization = null;
  }
}

async function initializeStorageProvider_ACU(mode: StorageMode, epoch: number): Promise<StorageRuntimeLoadResult_ACU> {
  setRuntimeHealth_ACU({ status: 'loading', expectedMode: mode, activeMode: currentProvider?.mode ?? null });
  logDebug_ACU(`[StorageStrategy] 初始化 Provider: ${mode}`);

  let nextProvider: ITableStorageProvider | null = null;
  try {
    nextProvider = createProvider(mode);
    const result = await loadProviderForCurrentChat_ACU(nextProvider, mode);
    logDebug_ACU(`[StorageStrategy] 数据加载完成: loaded=${result.loaded}, source=${result.source}`);

    if (epoch !== initializationEpoch_ACU) {
      nextProvider.dispose();
      return { ok: false, degraded: false, source: result.source, failureCode: 'stale_load_discarded' };
    }

    // 设置在 hydrate 期间被切换时，旧候选不得覆盖新的运行时。
    if (getCurrentStorageMode() !== mode) {
      nextProvider.dispose();
      setRuntimeHealth_ACU({
        status: 'idle', expectedMode: getCurrentStorageMode(), activeMode: currentProvider?.mode ?? null,
        failureCode: 'stale_load_discarded', error: '存储模式在初始化期间发生变化，已丢弃旧候选运行时。',
      });
      return { ok: false, degraded: false, source: result.source, failureCode: 'stale_load_discarded' };
    }

    if (mode === 'sqlite' && !result.loaded && result.error) {
      logError_ACU(`[StorageStrategy] SQLite 加载失败，自动 fallback 到原生模式: ${result.error}`);
      nextProvider.dispose();
      replaceActiveProvider_ACU(createProvider('native'));
      setRuntimeHealth_ACU({
        status: 'degraded', expectedMode: mode, activeMode: 'native', source: result.source,
        failureCode: 'provider_fallback', error: result.error,
      });
      return { ok: false, degraded: true, source: result.source, failureCode: 'provider_fallback', error: result.error };
    }
    replaceActiveProvider_ACU(nextProvider);
    setRuntimeHealth_ACU({ status: 'ready', expectedMode: mode, activeMode: mode, source: result.source });
    return { ok: true, degraded: false, source: result.source };
  } catch (e: any) {
    const error = e?.message || String(e);
    if (epoch !== initializationEpoch_ACU) {
      nextProvider?.dispose();
      return { ok: false, degraded: false, failureCode: 'stale_load_discarded' };
    }
    logError_ACU(`[StorageStrategy] 初始化失败: ${error}`);
    if (mode === 'sqlite') {
      logError_ACU('[StorageStrategy] SQLite 初始化异常，fallback 到原生模式');
      // 未被提交为 active 的候选必须销毁：它可能已持有全局 NameMapper 发布权，
      // 不释放会让 fallback 后的映射仍归属一个不再存在的 SQLite runtime。
      nextProvider?.dispose();
      replaceActiveProvider_ACU(createProvider('native'));
      setRuntimeHealth_ACU({ status: 'degraded', expectedMode: mode, activeMode: 'native', failureCode: 'provider_fallback', error });
      return { ok: false, degraded: true, failureCode: 'provider_fallback', error };
    }
    setRuntimeHealth_ACU({ status: 'failed', expectedMode: mode, activeMode: currentProvider?.mode ?? null, failureCode: 'provider_init_failed', error });
    throw e;
  }
}

/**
 * 切换存储模式（用户在设置中切换时调用）
 * 1. 销毁旧 Provider
 * 2. 创建新 Provider
 * 3. 重新加载数据
 *
 * @param mode 目标模式
 */
export async function switchStorageMode(mode: StorageMode): Promise<void> {
  const currentMode = currentProvider?.mode;
  if (currentMode === mode) {
    logDebug_ACU(`[StorageStrategy] 已经是 ${mode} 模式，无需切换`);
    return;
  }

  logDebug_ACU(`[StorageStrategy] 切换模式: ${currentMode || 'none'} → ${mode}`);

  try {
    const nextProvider = createProvider(mode);
    const result = await loadProviderForCurrentChat_ACU(nextProvider, mode);
    logDebug_ACU(`[StorageStrategy] 切换完成: loaded=${result.loaded}, source=${result.source}`);

    if (mode === 'sqlite' && !result.loaded && result.error) {
      logError_ACU(`[StorageStrategy] SQLite 切换失败，fallback 到原生模式: ${result.error}`);
      nextProvider.dispose();
      replaceActiveProvider_ACU(createProvider('native'));
      throw new Error(`SQLite 模式切换失败: ${result.error}。已自动回退到原生模式。`);
    }
    replaceActiveProvider_ACU(nextProvider);
  } catch (e: any) {
    if (e.message?.includes('已自动回退')) throw e;

    logError_ACU(`[StorageStrategy] 切换异常: ${e?.message}`);
    if (mode === 'sqlite') {
      replaceActiveProvider_ACU(createProvider('native'));
    }
    throw e;
  }
}

/**
 * 立即销毁当前 Provider 实例，释放内存数据库资源
 * 用于换卡/换聊天时在状态重置之前立即清理旧数据库，
 * 避免 1200ms 延迟窗口内的数据不一致问题。
 *
 * 销毁后 getStorageProvider() 会触发懒初始化创建新实例。
 * 调用方应在适当时机调用 reloadStorageProvider() 重建并加载数据。
 */
export function disposeStorageProvider(): void {
  // chat 切换可能发生在候选 hydrate 未完成时；旧候选绝不能在 dispose 后重新发布。
  invalidateInFlightInitialization_ACU();
  runtimeLifecycleEpoch_ACU += 1;
  activeInitialization = null;
  activeReload_ACU = null;
  if (currentProvider) {
    logDebug_ACU(`[StorageStrategy] 销毁当前 Provider: ${currentProvider.mode}`);
    currentProvider.dispose();
    currentProvider = null;
  }
  setRuntimeHealth_ACU({ status: 'disposed', expectedMode: getCurrentStorageMode(), activeMode: null });
}

/** 让已在锁外启动的初始化候选失去发布资格，避免其覆盖排队中的受控重载。 */
function invalidateInFlightInitialization_ACU(): void {
  initializationEpoch_ACU += 1;
}

/**
 * 重新加载数据（楼层删除、回滚等场景）
 * 不切换模式，只重新从聊天消息加载。
 *
 * 进入当前 chat/isolation 的排他维护锁，避免 hydrate 候选与并发写事务互相覆盖。
 * 持有表写事务的调用方必须在其事务释放后再调用本函数，禁止嵌套获取同一维护锁。
 */
export async function reloadStorageProvider(): Promise<StorageRuntimeLoadResult_ACU> {
  // 多个重载请求描述同一个当前 chat/isolation 的目标状态；合并它们，不能让后到请求废弃已持锁航班。
  if (activeReload_ACU) return activeReload_ACU;
  const lifecycleEpoch = runtimeLifecycleEpoch_ACU;

  // 排他锁可能需要等待已有写事务。先废弃锁外航班，禁止它在等待窗口发布并置换活跃 provider。
  invalidateInFlightInitialization_ACU();
  const promise = runTableWriteTransaction_ACU({
    source: 'system_reload',
    reason: 'reloadStorageProvider',
    writeSet: [{ kind: 'all' }],
    maintenanceMode: 'exclusive',
  }, async () => {
    if (lifecycleEpoch !== runtimeLifecycleEpoch_ACU) {
      return { ok: false, degraded: false, failureCode: 'stale_load_discarded' as const };
    }
    invalidateTableRuntimeRevision_ACU({ reason: 'reloadStorageProvider' });
    const mode = getCurrentStorageMode();
    logDebug_ACU(`[StorageStrategy] 重新加载数据: ${mode}`);
    return initStorageProvider({ forceNewFlight: true });
  });
  activeReload_ACU = promise;
  try {
    return await promise;
  } finally {
    if (activeReload_ACU === promise) activeReload_ACU = null;
  }
}

/**
 * 获取当前 Provider 的模式
 * 如果未初始化返回 null
 */
export function getCurrentProviderMode(): StorageMode | null {
  return currentProvider?.mode ?? null;
}

/**
 * Reports a completed SQLite reload that silently degraded to the native runtime.
 * A concurrent settings change to native is intentional and must not be reported.
 */
export function didSqliteFallbackAfterReload_ACU(expectedModeBeforeReload: StorageMode): boolean {
  return expectedModeBeforeReload === 'sqlite'
    && getCurrentStorageMode() === 'sqlite'
    && getCurrentProviderMode() === 'native';
}

// ═══════════════════════════════════════════════════════════════
// 内部工具函数
// ═══════════════════════════════════════════════════════════════

/** 根据模式创建 Provider 实例 */
function createProvider(mode: StorageMode): ITableStorageProvider {
  switch (mode) {
    case 'sqlite':
      return new SqlTableService();
    case 'native':
    default:
      return new NativeTableServiceAdapter();
  }
}

async function loadProviderForCurrentChat_ACU(
  provider: ITableStorageProvider,
  mode: StorageMode,
): Promise<{ loaded: boolean; source: 'merged' | 'initialized' | 'empty'; error?: string }> {
  if (mode !== 'sqlite') return provider.loadFromChat();

  const replay = await loadOrCreateJsonTableFromChatHistory_ACU();
  if (typeof provider.loadFromData !== 'function') {
    throw new Error('[StorageStrategy] SQLite provider 未实现 canonical snapshot hydrate。');
  }
  return provider.loadFromData(replay.data || null);
}

function replaceActiveProvider_ACU(nextProvider: ITableStorageProvider): void {
  const previousProvider = currentProvider;
  currentProvider = nextProvider;
  previousProvider?.dispose();
}
