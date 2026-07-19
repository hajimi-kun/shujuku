import { computed, ref, type ComputedRef, type Ref } from 'vue';
import {
  currentJsonTableData_ACU,
  settings_ACU,
  abortAllActiveRequests_ACU,
  _set_isAutoUpdatingCard_ACU,
  _set_manualExtraHint_ACU,
  _set_wasStoppedByUser_ACU,
  getCurrentIsolationKey_ACU,
} from '../../service/runtime/state-manager';
import { getChatArray_ACU } from '../../service/chat/chat-service';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { getCurrentWorldbookConfig_ACU } from '../../service/settings/settings-readers';
import { getSortedSheetKeys_ACU } from '../../service/template/chat-scope';
import { collectV2CheckpointFloorsFromChat_ACU } from '../../service/table/table-history';
import {
  executeCardUpdateCore_ACU,
  orchestrateManualCatchUp_ACU,
  orchestrateManualUpdate_ACU,
  prepareManualCatchUpPlan_ACU,
  processUpdatesBatch_ACU,
  type BatchUpdateProgressContext,
  type CardUpdateProgressEvent,
} from '../../service/table/update-orchestrator';
import { refreshMergedDataAndNotify_ACU } from '../../service/worldbook/pipeline';
import { topLevelWindow_ACU } from '../../shared/env';
import { useDialogStore } from '../stores/dialog-store';
import { useToastStore } from '../stores/toast-store';

type MessageKind = 'info' | 'success' | 'warning' | 'error';

export interface ManualUpdateState {
  selectedManualTableKeys: Ref<string[]>;
  manualContextDepth: Ref<number>;
  manualBatchSize: Ref<number>;
  manualExtraHint: Ref<string>;
  manualUpdateBusy: Ref<boolean>;
  catchUpBusy: Ref<boolean>;
  sheetKeys: ComputedRef<string[]>;
  sheetNames: ComputedRef<Record<string, string>>;
  selectedSheetSummary: ComputedRef<string>;
  checkpointFloorsLabel: ComputedRef<string>;
  manualRefillRangeLabel: ComputedRef<string>;
  checkpointRiskMessage: ComputedRef<string>;
  vectorIndexWarning: ComputedRef<boolean>;
  refresh: () => void;
  setManualContextDepth: (value: number | string) => void;
  setManualBatchSize: (value: number | string) => void;
  setManualSelectedKeys: (keys: string[]) => void;
  selectAllManualTables: () => void;
  selectNoManualTables: () => void;
  runManualUpdate: () => Promise<void>;
  runManualCatchUp: () => Promise<void>;
}

function currentSheetKeys(): string[] {
  try {
    return getSortedSheetKeys_ACU(currentJsonTableData_ACU || {});
  } catch {
    return [];
  }
}

function resolveManualSelection(keys: string[]): string[] {
  if (!keys.length) return [];
  const saved = Array.isArray(settings_ACU.manualSelectedTables) ? settings_ACU.manualSelectedTables : [];
  if (settings_ACU.hasManualSelection !== true) return keys.slice();
  const valid = new Set(keys);
  return saved.filter((key: string) => valid.has(key));
}

function saveManualSelection(keys: string[]): void {
  const valid = new Set(currentSheetKeys());
  settings_ACU.manualSelectedTables = keys.filter(key => valid.has(key));
  settings_ACU.hasManualSelection = true;
  saveSettings_ACU();
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function resolveManualContextDepth(): number {
  const fallback = normalizeNonNegativeInteger(settings_ACU.autoUpdateThreshold, 3);
  return settings_ACU.manualUpdateContextDepth == null
    ? fallback
    : normalizeNonNegativeInteger(settings_ACU.manualUpdateContextDepth, fallback);
}

function resolveManualBatchSize(): number {
  const fallback = 3;
  return settings_ACU.manualUpdateBatchSize == null
    ? fallback
    : normalizePositiveInteger(settings_ACU.manualUpdateBatchSize, fallback);
}

function applyManualSettingsForOrchestrator(): () => void {
  const previousAutoUpdateThreshold = settings_ACU.autoUpdateThreshold;
  const previousUpdateBatchSize = settings_ACU.updateBatchSize;

  // orchestrateManualUpdate_ACU still reads the legacy automatic settings.
  // Keep the temporary bridge local to this UI action so the independent
  // manual fields do not persist back into automatic update configuration.
  settings_ACU.autoUpdateThreshold = manualDepthForOrchestrator_ACU(
    settings_ACU.manualUpdateContextDepth,
    previousAutoUpdateThreshold,
  );
  settings_ACU.updateBatchSize = normalizePositiveInteger(
    settings_ACU.manualUpdateBatchSize,
    normalizePositiveInteger(previousUpdateBatchSize, 3),
  );

  return () => {
    settings_ACU.autoUpdateThreshold = previousAutoUpdateThreshold;
    settings_ACU.updateBatchSize = previousUpdateBatchSize;
  };
}

function manualDepthForOrchestrator_ACU(
  manualDepth: unknown,
  fallbackDepth: unknown,
): number {
  const fallback = normalizeNonNegativeInteger(fallbackDepth, 3);
  return manualDepth == null
    ? fallback
    : normalizeNonNegativeInteger(manualDepth, fallback);
}

interface ManualRefillRangeSummary {
  indices: number[];
  startAiFloor: number;
  endAiFloor: number;
}

function resolveManualRefillRangeSummary_ACU(manualDepth: number): ManualRefillRangeSummary | null {
  const chat = getChatArray_ACU();
  if (!Array.isArray(chat) || chat.length === 0) return null;
  const aiItems = chat
    .map((msg: any, index: number) => (msg && !msg.is_user ? { index, aiFloor: 0 } : null))
    .filter((item): item is { index: number; aiFloor: number } => item !== null);
  aiItems.forEach((item, idx) => { item.aiFloor = idx + 1; });
  const skip = normalizeNonNegativeInteger(settings_ACU.skipUpdateFloors, 0);
  const effectiveAiItems = skip > 0 ? aiItems.slice(0, -skip) : aiItems.slice();
  const contextItems = manualDepth > 0 ? effectiveAiItems.slice(-manualDepth) : effectiveAiItems;
  if (!contextItems.length) return null;
  return {
    indices: contextItems.map(item => item.index),
    startAiFloor: contextItems[0].aiFloor,
    endAiFloor: contextItems[contextItems.length - 1].aiFloor,
  };
}

function formatAiFloorRange_ACU(startAiFloor: number, endAiFloor: number): string {
  return startAiFloor === endAiFloor
    ? `AI 第 ${startAiFloor} 层`
    : `AI 第 ${startAiFloor}~${endAiFloor} 层`;
}

function progressLabel(event: CardUpdateProgressEvent): string {
  const prefix = event.currentBatch && event.totalBatches
    ? `批次 ${event.currentBatch}/${event.totalBatches} · `
    : '';
  if (event.message && event.phase !== 'retry' && event.phase !== 'error') {
    return `${prefix}${normalizeManualProgressMessage(event.message)}`;
  }
  switch (event.phase) {
    case 'preparing': return `${prefix}准备上下文`;
    case 'calling_ai': return `${prefix}调用 AI${event.attempt ? `（第 ${event.attempt}/${event.maxRetries || '?'} 次尝试）` : ''}`;
    case 'parsing': return `${prefix}解析填表结果`;
    case 'saving': return `${prefix}保存表格数据`;
    case 'retry': return `${prefix}重试中${event.message ? `:${event.message}` : ''}`;
    case 'complete': return `${prefix}完成`;
    case 'chunk_done': return `${prefix}分块完成`;
    case 'error': return `${prefix}出错${event.message ? `:${event.message}` : ''}`;
    default: return prefix || '处理中';
  }
}

function normalizeManualProgressMessage(message: string): string {
  return message
    .split(' AI 响应').join('手动填表结果')
    .split('AI 响应').join('手动填表结果');
}

export function useManualUpdate(): ManualUpdateState {
  const dialogStore = useDialogStore();
  const toast = useToastStore();
  const selectedManualTableKeys = ref<string[]>(resolveManualSelection(currentSheetKeys()));
  const manualContextDepth = ref(resolveManualContextDepth());
  const manualBatchSize = ref(resolveManualBatchSize());
  const manualExtraHint = ref('');
  const manualUpdateBusy = ref(false);
  const catchUpBusy = ref(false);
  const refreshTick = ref(0);
  let progressToastId: string | null = null;
  let abortRequested = false;
  let catchUpAbortController: AbortController | null = null;

  function progressToastOptions(onAbort: () => void = requestAbort) {
    const abortDisabled = onAbort === requestCatchUpAbort
      ? catchUpAbortController?.signal.aborted === true
      : abortRequested;
    return {
      durationMs: 0,
      muteable: false,
      dismissible: false,
      action: abortDisabled
        ? undefined
        : {
            label: '终止',
            variant: 'danger' as const,
            dismissOnClick: false,
            onClick: onAbort,
          },
    };
  }

  function notifyProgress(text: string, onAbort: () => void = requestAbort): void {
    if (progressToastId && toast.update(progressToastId, 'info', text, progressToastOptions(onAbort))) {
      return;
    }
    progressToastId = toast.info(text, progressToastOptions(onAbort));
  }

  function finishToast(kind: MessageKind, text: string): void {
    if (progressToastId) {
      if (toast.update(progressToastId, kind, text, { muteable: false })) {
        progressToastId = null;
        return;
      }
      progressToastId = null;
    }
    toast[kind](text, { muteable: false });
  }

  function requestAbort(): void {
    if (abortRequested) return;
    abortRequested = true;
    _set_wasStoppedByUser_ACU(true);
    abortAllActiveRequests_ACU();
    _set_isAutoUpdatingCard_ACU(false);
    if (progressToastId) {
      toast.update(progressToastId, 'warning', '手动填表已终止，正在停止当前任务与后续批次...', {
        durationMs: 0,
        muteable: false,
        dismissible: false,
      });
    } else {
      toast.warning('手动填表已终止，正在停止当前任务与后续批次...', {
        durationMs: 0,
        muteable: false,
        dismissible: false,
      });
    }
  }

  function requestCatchUpAbort(): void {
    if (!catchUpAbortController || catchUpAbortController.signal.aborted) return;
    catchUpAbortController.abort();
    const text = '手动追平已终止，正在等待当前安全边界收敛...';
    if (progressToastId) {
      toast.update(progressToastId, 'warning', text, { durationMs: 0, muteable: false, dismissible: false });
    } else {
      toast.warning(text, { durationMs: 0, muteable: false, dismissible: false });
    }
  }

  const sheetKeys = computed(() => {
    void refreshTick.value;
    return currentSheetKeys();
  });

  const sheetNames = computed<Record<string, string>>(() => {
    const names: Record<string, string> = {};
    for (const key of sheetKeys.value) {
      names[key] = String(currentJsonTableData_ACU?.[key]?.name || key);
    }
    return names;
  });

  const selectedSheetSummary = computed<string>(() => {
    const keys = selectedManualTableKeys.value;
    if (!keys.length) return '未选择表格';
    const names = sheetNames.value;
    return keys
      .map(key => `${names[key] || key}（${key}）`)
      .join('、');
  });

  const checkpointFloors = computed(() => {
    void refreshTick.value;
    try {
      return collectV2CheckpointFloorsFromChat_ACU(getChatArray_ACU(), getCurrentIsolationKey_ACU());
    } catch {
      return [];
    }
  });

  function formatCheckpointReasonLabel(reason?: string): string {
    switch (reason) {
      case 'init':
        return '初始基线';
      case 'migration':
        return '迁移基线';
      case 'compaction':
        return '保留边界基线';
      case 'manual':
        return '历史手动基线';
      case 'periodic':
        return '历史周期基线';
      default:
        return reason ? `旧基线:${reason}` : '旧基线';
    }
  }

  const checkpointFloorsLabel = computed<string>(() => {
    const checkpoints = checkpointFloors.value;
    return checkpoints.length > 0
      ? checkpoints
        .map(item => `AI 第 ${item.aiFloor} 层（${formatCheckpointReasonLabel(item.reason)}）`)
        .join('、')
      : '当前隔离标签暂无 full checkpoint';
  });

  const manualRefillRange = computed<ManualRefillRangeSummary | null>(() => {
    void refreshTick.value;
    try {
      return resolveManualRefillRangeSummary_ACU(manualContextDepth.value);
    } catch {
      return null;
    }
  });

  const manualRefillRangeLabel = computed<string>(() => {
    const range = manualRefillRange.value;
    return range
      ? formatAiFloorRange_ACU(range.startAiFloor, range.endAiFloor)
      : '暂无可重填 AI 楼层';
  });

  const checkpointRiskMessage = computed<string>(() => {
    const checkpoints = checkpointFloors.value;
    const range = manualRefillRange.value;
    if (checkpoints.length === 0 || !range) return '';
    const checkpointIndexSet = new Set(range.indices);
    const coveredCheckpoints = checkpoints.filter(item => checkpointIndexSet.has(item.messageIndex));
    if (coveredCheckpoints.length !== checkpoints.length) return '';
    const coveredFloors = coveredCheckpoints.map(item => `AI 第 ${item.aiFloor} 层`).join('、');
    return `危险：当前聊天的所有 full checkpoint 都在本次重填范围内（${coveredFloors}）。系统首次执行时只会做边界检查；如果确认缺少重填起点前可回放 checkpoint，会在下一步要求你单独确认是否替换本次范围内选中表的基底。`;
  });

  const vectorIndexWarning = computed<boolean>(() => {
    void refreshTick.value;
    try {
      return getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true;
    } catch {
      return false;
    }
  });

  function refresh(): void {
    selectedManualTableKeys.value = resolveManualSelection(currentSheetKeys());
    manualContextDepth.value = resolveManualContextDepth();
    manualBatchSize.value = resolveManualBatchSize();
    refreshTick.value++;
  }

  function setManualContextDepth(value: number | string): void {
    const normalized = normalizeNonNegativeInteger(value, manualContextDepth.value);
    manualContextDepth.value = normalized;
    settings_ACU.manualUpdateContextDepth = normalized;
    saveSettings_ACU();
  }

  function setManualBatchSize(value: number | string): void {
    const normalized = normalizePositiveInteger(value, manualBatchSize.value);
    manualBatchSize.value = normalized;
    settings_ACU.manualUpdateBatchSize = normalized;
    saveSettings_ACU();
  }

  function setManualSelectedKeys(keys: string[]): void {
    selectedManualTableKeys.value = keys.slice();
    saveManualSelection(selectedManualTableKeys.value);
    refreshTick.value++;
  }

  function selectAllManualTables(): void {
    setManualSelectedKeys(sheetKeys.value);
  }

  function selectNoManualTables(): void {
    setManualSelectedKeys([]);
  }

  async function runManualUpdate(): Promise<void> {
    if (manualUpdateBusy.value || catchUpBusy.value) return;
    if (!selectedManualTableKeys.value.length) {
      toast.warning('未选择需要手动填表的表格。');
      return;
    }

    manualUpdateBusy.value = true;
    const confirmed = await dialogStore.confirm({
      title: '执行手动填表',
      message: `即将执行手动填表。\n\n当前 full checkpoint：${checkpointFloorsLabel.value}\n本次重填范围：${manualRefillRangeLabel.value}\n选中表：${selectedSheetSummary.value}\n\n系统会先在 service 层做重填边界检查，并在内存中按当前上下文和批处理设置准备重填当前选中的表。\n常规路径只会在确认可回放边界后清理本次范围内选中表的 V2 增量日志与 revision 指纹，并在全部成功后写入手动重填进度记录。\n如果边界检查确认重填起点前没有可回放 checkpoint，系统会停止并弹出第二次破坏性确认；只有你在第二次确认中授权后，才会替换本次范围内选中表的旧 checkpoint 基底并写入新的单表 checkpoint。\n\n取消、失败、终止或从中断处继续时，不会清理本次重填范围之外的聊天记录表格数据，也不会在未二次确认时替换 checkpoint 基底。`,
      dangerMessage: checkpointRiskMessage.value || undefined,
      confirmLabel: '确认并继续',
      cancelLabel: '取消',
      confirmVariant: checkpointRiskMessage.value ? 'danger' : undefined,
    });
    if (!confirmed) {
      manualUpdateBusy.value = false;
      return;
    }
    // 兼容沿用 clearBeforeUpdate 参数名；service 层实际执行事务式重填，不会预清空聊天记录。
    const clearBeforeUpdate = true;
    const targetManualTableKeys = selectedManualTableKeys.value.slice();

    progressToastId = null;
    abortRequested = false;
    _set_wasStoppedByUser_ACU(false);
    notifyProgress('手动填表开始。');
    const extra = manualExtraHint.value.trim();
    if (extra) _set_manualExtraHint_ACU(`以下为用户的额外填表要求,请严格遵守:\n${extra}`);
    const handleProgress = (event: CardUpdateProgressEvent) => {
      notifyProgress(progressLabel(event));
      if (event.phase === 'complete') {
        try { (topLevelWindow_ACU as any).AutoCardUpdaterAPI?._notifyTableUpdate?.(); } catch (_) {}
        refreshTick.value++;
      }
    };

    const runProcessBatch = (indices: number[], mode: string, options: any) =>
      processUpdatesBatch_ACU(indices, mode, options, (
        messagesToUse: any[],
        saveTargetIndex: number,
        updateMode: string,
        isSilentMode: boolean,
        targetSheetKeys: string[] | null,
        requestOptions: Record<string, any> | null,
        progressContext: BatchUpdateProgressContext,
      ) => executeCardUpdateCore_ACU(
        messagesToUse,
        saveTargetIndex,
        false,
        updateMode,
        isSilentMode,
        targetSheetKeys,
        requestOptions,
        new AbortController(),
        progressContext,
        handleProgress,
      ));

    try {
      const executeManualUpdate = async (confirmBoundaryReset: boolean) => {
        const restoreAutoUpdateSettings = applyManualSettingsForOrchestrator();
        try {
          return await orchestrateManualUpdate_ACU(
            targetManualTableKeys,
            runProcessBatch,
            async () => { await refreshMergedDataAndNotify_ACU(); },
            { clearBeforeUpdate, confirmBoundaryReset, onProgress: handleProgress },
          );
        } finally {
          restoreAutoUpdateSettings();
        }
      };

      let result: Awaited<ReturnType<typeof orchestrateManualUpdate_ACU>> = await executeManualUpdate(false);
      if (!result.success && result.requiresUserConfirmation){
        const request = result.requiresUserConfirmation;
        const dangerConfirmed = await dialogStore.confirm({
          title: '破坏性手动重填确认',
          message: `${request.message}\n\n高风险操作：确认后会在一次提交中删除本次重填范围内选中表的旧表基底，并写入新的单表 checkpoint，随后才继续本次手动填表。\n目标表：${request.targetSheetKeys.join('、')}\n目标消息索引：${request.contextScopeIndices.join('、')}\n\n范围外 checkpoint、范围外聊天记录表格数据和未选中的表不会被删除。`,
          dangerMessage: '此操作不可撤销。取消将不会执行基底替换，不会写入新的单表 checkpoint，也不会继续本次手动填表。',
          confirmLabel: '我已了解风险，继续执行',
          cancelLabel: '取消',
          confirmVariant: 'danger',
        });
        if (!dangerConfirmed) {
          finishToast('info', '已取消破坏性基底替换。');
          return;
        }
        notifyProgress('已确认破坏性基底替换，继续手动填表。');
        result = await executeManualUpdate(true);
      }
      finishToast(
        result.success ? (result.checkpointWarning ? 'warning' : 'success') : (abortRequested || result.error?.includes('终止') ? 'warning' : 'error'),
        result.success
          ? `${result.autoMergeTriggered
              ? `手动填表完成;自动合并总结${result.autoMergeSuccess ? '已完成' : '未完成'}。`
              : '手动填表完成。'}${result.checkpointWarning
                ? ` 但 AI 楼层保留边界 checkpoint 建立失败：${result.checkpointWarning}`
                : ''}`
          : (abortRequested ? '手动填表任务已由用户终止。' : (result.error || '手动填表失败。')),
      );
    } catch (error: any) {
      finishToast('error', error?.message || '手动填表执行异常。');
    } finally {
      manualUpdateBusy.value = false;
      refresh();
    }
  }

  async function retryCatchUpSyncOnly(): Promise<void> {
    if (manualUpdateBusy.value || catchUpBusy.value) return;
    catchUpBusy.value = true;
    try {
      if (progressToastId) {
        toast.update(progressToastId, 'info', '正在仅重试世界书同步，不会再次调用 AI...', {
          durationMs: 0,
          muteable: false,
          dismissible: false,
        });
      }
      const result = await refreshMergedDataAndNotify_ACU();
      refresh();
      if (result.degraded) {
        showCatchUpSyncPending();
        return;
      }
      finishToast('success', '世界书同步已完成；没有再次调用 AI。');
    } catch (error: any) {
      showCatchUpSyncPending(error?.message || '世界书同步仍未完成。');
    } finally {
      catchUpBusy.value = false;
    }
  }

  function showCatchUpSyncPending(detail?: string): void {
    const text = `追平数据已保存，但世界书同步待重试。${detail ? ` ${detail}` : ''}`;
    const options = {
      durationMs: 0,
      muteable: false,
      dismissible: true,
      action: {
        label: '仅同步重试',
        dismissOnClick: false,
        onClick: retryCatchUpSyncOnly,
      },
    };
    if (progressToastId && toast.update(progressToastId, 'warning', text, options)) return;
    progressToastId = toast.warning(text, options);
  }

  async function runManualCatchUp(): Promise<void> {
    if (manualUpdateBusy.value || catchUpBusy.value) return;
    if (!selectedManualTableKeys.value.length) {
      toast.warning('未选择需要追平的表格。');
      return;
    }

    catchUpBusy.value = true;
    const targetKeys = selectedManualTableKeys.value.slice();
    try {
      const planningResult = await prepareManualCatchUpPlan_ACU(targetKeys);
      if (!planningResult.success || !planningResult.plan) {
        finishToast('error', planningResult.error || '无法生成手动追平计划。');
        return;
      }
      const plan = planningResult.plan;
      if (!plan.waves.length) {
        finishToast('info', '所选表已追平，无需调用 AI 或写入数据。');
        return;
      }
      const totalBuckets = plan.waves.reduce((count, wave) => count + wave.groups.reduce(
        (waveCount, group) => waveCount + Math.ceil(wave.messageIndices.length / group.batchSize),
        0,
      ), 0);
      const waveSummary = plan.waves.map((wave, index) =>
        `Wave ${index + 1}：${formatAiFloorRange_ACU(wave.startAiFloor, wave.endAiFloor)}；${wave.sheetKeys.map(key => sheetNames.value[key] || key).join('、')}`
      ).join('\n');
      const confirmed = await dialogStore.confirm({
        title: '追平所选表未填楼层',
        message: `锁定目标：AI 第 ${plan.targetAiFloor} 层\n预计 ${plan.waves.length} 个 wave、${totalBuckets} 个 bucket。\n跳过最新楼层：${normalizeNonNegativeInteger(settings_ACU.skipUpdateFloors, 0)} 层。\n\n${waveSummary}\n\n本功能只补每张表已提交连续前沿之后的后缀缺口，不扫描或修复历史前沿之前的内部空洞。执行时会重新读取已提交事实并重新规划，避免重复处理确认期间已完成的 bucket。`,
        confirmLabel: '确认追平',
        cancelLabel: '取消',
      });
      if (!confirmed) return;

      progressToastId = null;
      abortRequested = false;
      catchUpAbortController = new AbortController();
      notifyProgress('手动追平开始。', requestCatchUpAbort);
      const result = await orchestrateManualCatchUp_ACU(
        targetKeys,
        refreshMergedDataAndNotify_ACU,
        {
          abortController: catchUpAbortController,
          onProgress: event => notifyProgress(progressLabel(event), requestCatchUpAbort),
        },
      );
      if (result.outcome === 'sync_pending') {
        showCatchUpSyncPending();
      } else if (result.outcome === 'no_work') {
        finishToast('info', '所选表已追平，无需调用 AI 或写入数据。');
      } else if (result.outcome === 'stopped' || catchUpAbortController.signal.aborted) {
        finishToast('warning', `手动追平已终止；已保留 ${result.committedBucketCount || 0} 个已提交 bucket。`);
      } else if (result.success) {
        finishToast('success', `手动追平完成，共提交 ${result.committedBucketCount || 0} 个 bucket。`);
      } else {
        finishToast('error', result.error || '手动追平失败。');
      }
    } catch (error: any) {
      finishToast('error', error?.message || '手动追平执行异常。');
    } finally {
      catchUpAbortController = null;
      catchUpBusy.value = false;
      refresh();
    }
  }

  return {
    selectedManualTableKeys,
    manualContextDepth,
    manualBatchSize,
    manualExtraHint,
    manualUpdateBusy,
    catchUpBusy,
    sheetKeys,
    sheetNames,
    selectedSheetSummary,
    checkpointFloorsLabel,
    manualRefillRangeLabel,
    checkpointRiskMessage,
    vectorIndexWarning,
    refresh,
    setManualContextDepth,
    setManualBatchSize,
    setManualSelectedKeys,
    selectAllManualTables,
    selectNoManualTables,
    runManualUpdate,
    runManualCatchUp,
  };
}
