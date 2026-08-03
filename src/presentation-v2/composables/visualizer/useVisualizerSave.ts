import { TABLE_ORDER_FIELD_ACU } from '../../../shared/constants';
import { topLevelWindow_ACU } from '../../../shared/env';
import {
  applySheetOrderNumbers_ACU,
  ensureSheetOrderNumbers_ACU,
  isSummaryOrOutlineTable_ACU,
  logDebug_ACU,
  logWarn_ACU,
  parseTableTemplateJson_ACU,
} from '../../../shared/utils';
import {
  isDefaultTemplatePresetSelection_ACU,
  normalizeTemplatePresetSelectionValue_ACU,
} from '../../../shared/template-preset-utils';
import { getChatArray_ACU } from '../../../service/chat/chat-service';
import {
  currentJsonTableData_ACU,
  getCurrentIsolationKey_ACU,
  settings_ACU,
  _set_currentJsonTableData_ACU,
} from '../../../service/runtime/state-manager';
import {
  applySummaryIndexSequenceToTable_ACU,
  deleteTableLocksForSheet_ACU,
  getSummaryIndexColumnIndex_ACU,
  saveTableLocksForSheet_ACU,
  setSpecialIndexLockEnabled_ACU,
} from '../../../service/runtime/helpers-remaining';
import { getCurrentWorldbookConfig_ACU } from '../../../service/settings/settings-readers';
import { runTableUpdateCommit_ACU } from '../../../service/table/table-update-commit';
import {
  getLatestAiMessageIndexFromChat_ACU,
  resolveTableHistoryStateFromChat_ACU,
} from '../../../service/table/table-history';
import { isSqliteMode } from '../../../service/table/storage-mode';
import { commitCurrentFloorTemplateChanges_ACU } from '../../../service/table/storage-frame-v2-persist';
import { captureTableRuntimeRevisionForWriteSet_ACU } from '../../../service/table/table-write-transaction';
import { preflightSchemaMigrations_ACU } from '../../../service/table/schema-migration-preflight';
import { normalizeCanonicalTableRows_ACU } from '../../../shared/canonical-row-normalizer';
import { reloadStorageProvider } from '../../../service/table/table-storage-strategy';
import { applyTemplateScopeForCurrentChat_ACU } from '../../../service/settings/settings-service';
import {
  buildChatSheetGuideDataFromData_ACU,
  getChatSheetGuideDataForIsolationKey_ACU,
  getGlobalTemplateSnapshotForCurrentProfile_ACU,
  getSortedSheetKeys_ACU,
  sanitizeTemplateSnapshotForChat_ACU,
} from '../../../service/template/chat-scope';
import { generateDDL, validateDDLTextAgainstHeaders_ACU } from '../../../data/sqlite/schema-mapper';
import {
  applyTemplatePresetToCurrent_ACU,
  resolveActiveTemplatePresetName_ACU,
  upsertTemplatePreset_ACU,
} from '../../../service/template/template-preset-service';
import {
  getGlobalInjectionConfigFromData_ACU,
  purgeSheetKeysFromChatHistoryHard_ACU,
} from '../../../service/worldbook/injection-engine';
import { refreshMergedDataAndNotify_ACU, updateReadableLorebookEntry_ACU } from '../../../service/worldbook/pipeline';
import { enqueueSummaryVectorIndexFlush_ACU } from '../../../service/vector/summary-vector-index-flush-queue';
import { deleteCurrentSummaryVectorIndexFromChat_ACU } from '../../../service/vector/summary-vector-index-chat-service';
import {
  applyVisualizerPendingDataOps_ACU,
  hasVisualizerPendingDataOps_ACU,
  replaceVisualizerTemporaryRowIds_ACU,
} from '../../../service/visualizer/visualizer-data-ops';
import { useToastStore } from '../../stores/toast-store';
import { useVisualizerStore, type VisualizerLockDraft, type VisualizerSaveTarget } from '../../stores/visualizer-store';

export interface VisualizerSaveInteractions {
  requestGlobalPresetName?: (defaultName: string) => string | null | Promise<string | null>;
  confirmOverwriteGlobalPreset?: (presetName: string) => boolean | Promise<boolean>;
  confirmDestructiveSchemaChange?: (summary: VisualizerDestructiveSchemaChangeSummary) => boolean | Promise<boolean>;
  requestSchemaMigrationChoice?: (summary: VisualizerSchemaMigrationChoiceSummary) => string | null | Promise<string | null>;
}

export interface VisualizerSchemaMigrationChoiceSummary { sheetKey: string; message: string; choices: Array<{ id: string; label: string }> }

export interface VisualizerDestructiveSchemaChangeSummary {
  sheets: Array<{
    sheetKey: string;
    tableName: string;
    droppedColumns: Array<{ physicalName: string; displayHeader: string; index: number }>;
    affectedRowCount: number;
  }>;
}

type GlobalTemplateSaveResult =
  | { status: 'saved'; presetName: string }
  | { status: 'unchanged' }
  | { status: 'cancelled' };

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function applySpecialIndexSequenceFromDrafts(
  data: Record<string, any>,
  lockDrafts: Record<string, VisualizerLockDraft>,
): void {
  Object.keys(data || {}).forEach(sheetKey => {
    if (!sheetKey.startsWith('sheet_')) return;
    const table = data[sheetKey];
    if (!table || !isSummaryOrOutlineTable_ACU(String(table.name || ''))) return;
    if (lockDrafts[sheetKey]?.specialIndexLocked === false) return;
    const colIndex = getSummaryIndexColumnIndex_ACU(table);
    if (colIndex < 0) return;
    applySummaryIndexSequenceToTable_ACU(table, colIndex);
  });
}

function buildOrderedData(
  tempData: Record<string, any> | null,
  sheetOrder: string[],
  lockDrafts: Record<string, VisualizerLockDraft>,
  options: {
    /** When false, preserve existing orderNo values (sparse holes allowed). Default true. */
    renumberOrder?: boolean;
    /** When false, skip summary special-index rewrite that mutates content. Default true. */
    applySpecialIndex?: boolean;
  } = {},
): Record<string, any> {
  const source = tempData || { mate: { type: 'chatSheets', version: 1 } };
  const orderedData: Record<string, any> = {};
  Object.keys(source).forEach(key => {
    if (!key.startsWith('sheet_')) orderedData[key] = cloneData(source[key]);
  });
  sheetOrder.forEach(key => {
    if (source[key]) orderedData[key] = cloneData(source[key]);
  });
  const renumberOrder = options.renumberOrder !== false;
  const applySpecialIndex = options.applySpecialIndex !== false;
  if (renumberOrder) applySheetOrderNumbers_ACU(orderedData, sheetOrder);
  if (applySpecialIndex) applySpecialIndexSequenceFromDrafts(orderedData, lockDrafts);
  return orderedData;
}

function saveLockDrafts(drafts: Record<string, VisualizerLockDraft>): void {
  Object.entries(drafts || {}).forEach(([sheetKey, draft]) => {
    if (!sheetKey) return;
    saveTableLocksForSheet_ACU(sheetKey, {
      rows: new Set(draft.rows || []),
      cols: new Set(draft.cols || []),
      cells: new Set(draft.cells || []),
    });
    setSpecialIndexLockEnabled_ACU(sheetKey, draft.specialIndexLocked !== false);
  });
}

type VisualizerTemplateChanges_ACU = {
  addedSheetKeys: string[];
  schemaChangedSheetKeys: string[];
  metadataChangedSheetKeys: string[];
  deletedSheetKeys: string[];
};

function sortForComparison_ACU(value: any): any {
  if (Array.isArray(value)) return value.map(sortForComparison_ACU);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce<Record<string, any>>((result, key) => {
    result[key] = sortForComparison_ACU(value[key]);
    return result;
  }, {});
}

function sameTemplateValue_ACU(left: any, right: any): boolean {
  return JSON.stringify(sortForComparison_ACU(left)) === JSON.stringify(sortForComparison_ACU(right));
}

function projectSheetSchema_ACU(sheet: any): Record<string, any> {
  return {
    uid: sheet?.uid,
    headers: Array.isArray(sheet?.content?.[0]) ? cloneData(sheet.content[0]) : [],
    ddl: sheet?.sourceData?.ddl || '',
  };
}

function projectSheetPersistentMetadata_ACU(sheet: any): Record<string, any> {
  const sourceData = cloneData(sheet?.sourceData || {});
  delete sourceData.ddl;
  const metadata: Record<string, any> = { sourceData };
  if (sheet?.name !== undefined) metadata.name = sheet.name;
  if (sheet?.orderNo !== undefined) metadata.orderNo = sheet.orderNo;
  if (sheet?.updateConfig !== undefined) metadata.updateConfig = cloneData(sheet.updateConfig);
  if (sheet?.exportConfig !== undefined) metadata.exportConfig = cloneData(sheet.exportConfig);
  return metadata;
}

function classifyVisualizerTemplateChanges_ACU(
  baseData: Record<string, any> | null,
  nextData: Record<string, any>,
): VisualizerTemplateChanges_ACU {
  const baseKeys = Object.keys(baseData || {}).filter(key => key.startsWith('sheet_'));
  const nextKeys = Object.keys(nextData || {}).filter(key => key.startsWith('sheet_'));
  const addedSheetKeys = nextKeys.filter(key => !baseKeys.includes(key));
  const deletedSheetKeys = baseKeys.filter(key => !nextKeys.includes(key));
  const schemaChangedSheetKeys = nextKeys.filter(key => baseData?.[key]
    && !sameTemplateValue_ACU(projectSheetSchema_ACU(baseData[key]), projectSheetSchema_ACU(nextData[key])));
  const metadataChangedSheetKeys = nextKeys.filter(key => baseData?.[key]
    && !sameTemplateValue_ACU(projectSheetPersistentMetadata_ACU(baseData[key]), projectSheetPersistentMetadata_ACU(nextData[key])));
  return { addedSheetKeys, schemaChangedSheetKeys, metadataChangedSheetKeys, deletedSheetKeys };
}

function prepareTemplateSheetsForCommit_ACU(
  data: Record<string, any>,
  sheetKeys: string[],
): { removedNullRowCount: number } {
  const scopedData = Object.fromEntries(sheetKeys.map(sheetKey => [sheetKey, data[sheetKey]]));
  const normalization = normalizeCanonicalTableRows_ACU(scopedData);
  if (normalization.errors.length > 0) {
    throw new Error(`模板保存被拒绝：存在无法自动合并的 row_id 问题。`);
  }
  for (const sheetKey of sheetKeys) {
    const sheet = data[sheetKey];
    const headers = sheet?.content?.[0];
    if (!sheet || !Array.isArray(headers) || headers[0] !== 'row_id') {
      throw new Error(`模板保存被拒绝：${sheetKey} 缺少 row_id 表头。`);
    }
    if (!sheet.sourceData || typeof sheet.sourceData !== 'object') sheet.sourceData = {};
    if (!String(sheet.sourceData.ddl || '').trim()) sheet.sourceData.ddl = generateDDL(sheet, sheet.uid || sheetKey);
    const ddlValidation = validateDDLTextAgainstHeaders_ACU(sheet.sourceData.ddl, headers);
    if (!ddlValidation.valid) throw new Error(`模板保存被拒绝：${sheetKey} 的 DDL 无法 strict hydrate：${ddlValidation.message}`);
  }
  return { removedNullRowCount: normalization.removedRows.length };
}

async function saveGlobalTemplateSnapshot(
  orderedData: Record<string, any>,
  interactions: VisualizerSaveInteractions,
): Promise<GlobalTemplateSaveResult> {
  const templateObj: Record<string, any> = {};
  Object.keys(orderedData || {}).forEach(key => {
    if (!key.startsWith('sheet_')) templateObj[key] = cloneData(orderedData[key]);
  });
  if (!templateObj.mate || typeof templateObj.mate !== 'object') {
    templateObj.mate = { type: 'chatSheets', version: 1 };
  }
  if (!templateObj.mate.type) templateObj.mate.type = 'chatSheets';
  if (!Number.isFinite(templateObj.mate.version)) templateObj.mate.version = 1;
  templateObj.mate.globalInjectionConfig = getGlobalInjectionConfigFromData_ACU(orderedData, {
    ensureWriteBack: true,
  });

  const orderedSheetKeys = getSortedSheetKeys_ACU(orderedData, { ignoreChatGuide: true });
  orderedSheetKeys.forEach(key => {
    const currentTable = orderedData?.[key];
    if (!currentTable || typeof currentTable !== 'object') return;
    const templateTable = cloneData(currentTable);
    if (Array.isArray(templateTable.content) && templateTable.content.length > 1) {
      templateTable.content = [templateTable.content[0]];
    }
    templateTable[TABLE_ORDER_FIELD_ACU] = currentTable[TABLE_ORDER_FIELD_ACU];
    templateObj[key] = templateTable;
  });

  ensureSheetOrderNumbers_ACU(templateObj, {
    baseOrderKeys: orderedSheetKeys,
    forceRebuild: false,
  });

  const currentGlobalSnapshot = getGlobalTemplateSnapshotForCurrentProfile_ACU();
  const currentGlobalStr = currentGlobalSnapshot?.templateStr || '';

  const isolationKey = getCurrentIsolationKey_ACU();
  const activePresetName = normalizeTemplatePresetSelectionValue_ACU(
    resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true, isolationKey }),
  );
  let finalGlobalPresetName = activePresetName;
  if (isDefaultTemplatePresetSelection_ACU(finalGlobalPresetName)) {
    const promptedName = interactions.requestGlobalPresetName
      ? await interactions.requestGlobalPresetName('新模板预设')
      : null;
    if (!promptedName) return { status: 'cancelled' };
    finalGlobalPresetName = normalizeTemplatePresetSelectionValue_ACU(String(promptedName).trim());
  } else {
    const confirmed = interactions.confirmOverwriteGlobalPreset
      ? await interactions.confirmOverwriteGlobalPreset(finalGlobalPresetName)
      : false;
    if (!confirmed) return { status: 'cancelled' };
  }
  if (!finalGlobalPresetName) return { status: 'cancelled' };

  const preparedSnapshot = sanitizeTemplateSnapshotForChat_ACU(templateObj);
  if (!preparedSnapshot?.templateStr) {
    throw new Error('无法生成模板快照。');
  }
  if (currentGlobalStr && preparedSnapshot.templateStr === currentGlobalStr) return { status: 'unchanged' };
  const presetSaved = upsertTemplatePreset_ACU(finalGlobalPresetName, preparedSnapshot.templateStr);
  if (!presetSaved) throw new Error('无法写入全局预设库。');

  const applied = await applyTemplatePresetToCurrent_ACU(finalGlobalPresetName, {
    source: 'visualizer_v2_save_to_global',
    updateGlobal: true,
    save: true,
    persistChatScope: false,
  });
  if (!applied) throw new Error('模板快照应用失败。');
  return { status: 'saved', presetName: finalGlobalPresetName };
}

async function saveCurrentDataToChat(
  sheetKeysToSave: string[],
  deletedSheetKeys: string[],
): Promise<'memory-only' | 'saved'> {
  const chat = getChatArray_ACU();
  if (!chat.length) return 'memory-only';

  const isolationKey = getCurrentIsolationKey_ACU();
  const allSheetKeys = sheetKeysToSave.filter(key => !!currentJsonTableData_ACU?.[key]);
  const latestAiIndex = getLatestAiMessageIndexFromChat_ACU(chat);
  const bucketByIndex: Record<number, string[]> = {};

  allSheetKeys.forEach(key => {
    const table = currentJsonTableData_ACU?.[key];
    const history = resolveTableHistoryStateFromChat_ACU(chat, {
      sheetKey: key,
      isSummaryTable: table ? isSummaryOrOutlineTable_ACU(table.name) : false,
      isolationKey,
      settings: settings_ACU,
    });
    const idx = history.latestDataMessageIndex !== -1
      ? history.latestDataMessageIndex
      : latestAiIndex;
    if (idx === -1) return;
    if (!bucketByIndex[idx]) bucketByIndex[idx] = [];
    bucketByIndex[idx].push(key);
  });

  if (Object.keys(bucketByIndex).length === 0 && latestAiIndex !== -1) {
    bucketByIndex[latestAiIndex] = [...allSheetKeys];
  }
  if (Object.keys(bucketByIndex).length === 0) return 'memory-only';

  for (const [indexStr, keys] of Object.entries(bucketByIndex)) {
    const idx = Number.parseInt(indexStr, 10);
    if (Number.isNaN(idx)) continue;
    const writeSet = keys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }));
    const commitResult = await runTableUpdateCommit_ACU<null>({
      source: 'manual_crud',
      reason: 'visualizer_v2_save',
      isolationKey,
      writeSet,
      revisionWriteSet: writeSet,
      initialData: currentJsonTableData_ACU as any,
      targetMessageIndex: idx,
      targetSheetKeys: keys,
      updateGroupKeys: null,
      trackingSheetKeys: [],
      trackAsUpdate: false,
      operations: keys
        .filter(sheetKey => Boolean((currentJsonTableData_ACU as any)?.[sheetKey]))
        .map(sheetKey => ({ kind: 'sheet_replace' as const, sheetKey, sheet: (currentJsonTableData_ACU as any)[sheetKey], reason: 'manual_crud' as const })),
    }, () => ({
      success: true,
      value: null,
      tableData: currentJsonTableData_ACU as any,
      mutationResult: { changes: keys.length, errors: [] },
    }));
    if (!commitResult.success) {
      logWarn_ACU('[ACU-V2 Visualizer] save commit failed:', commitResult.error);
    }
  }

  if (deletedSheetKeys.length > 0) {
    const result = await purgeSheetKeysFromChatHistoryHard_ACU(deletedSheetKeys);
    if (result?.changed && isSqliteMode()) {
      try {
        await reloadStorageProvider();
      } catch (error) {
        logWarn_ACU('[ACU-V2 Visualizer] reloadStorageProvider failed:', error);
      }
    }
  }

  await refreshMergedDataAndNotify_ACU();

  const shouldSyncSummaryVectorIndex = allSheetKeys.some(sheetKey => {
    const table = currentJsonTableData_ACU?.[sheetKey];
    return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
  });
  if (shouldSyncSummaryVectorIndex && getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
    try {
      await enqueueSummaryVectorIndexFlush_ACU({
        targetMessageIndex: latestAiIndex !== -1 ? latestAiIndex : undefined,
        mode: 'sync',
        reason: 'visualizer_v2_save',
      });
    } catch (error) {
      logWarn_ACU('[ACU-V2 Visualizer] summary vector index queue failed:', error);
    }
  }

  try {
    (topLevelWindow_ACU as any).AutoCardUpdaterAPI?._notifyTableUpdate?.();
  } catch (error) {
    logDebug_ACU('[ACU-V2 Visualizer] table update notification skipped:', error);
  }

  return 'saved';
}

export function useVisualizerSave(interactions: VisualizerSaveInteractions = {}) {
  const visualizer = useVisualizerStore();
  const toastStore = useToastStore();

  async function runSaving(task: () => Promise<boolean>): Promise<boolean> {
    if (visualizer.isSaving) return false;
    visualizer.setSaving(true);
    try {
      return await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败，请查看控制台日志。';
      logWarn_ACU('[ACU-V2 Visualizer] save failed:', error);
      toastStore.error(message, { muteable: false });
      return false;
    } finally {
      visualizer.setSaving(false);
    }
  }

  async function saveDataToCurrentMessage(): Promise<boolean> {
    return runSaving(async () => {
      const deletedSheetKeys = [...new Set((visualizer.deletedSheetKeys || [])
        .filter(key => typeof key === 'string' && key.startsWith('sheet_')),
      )];
      const hasDataChanges = hasVisualizerPendingDataOps_ACU(visualizer);
      if (hasDataChanges && deletedSheetKeys.length > 0) {
        toastStore.error('行数据增量与整表删除无法原子提交；请分别保存行数据和删表操作。', { muteable: false });
        return false;
      }
      const hasLockChanges = visualizer.lockDirty;
      const result = hasDataChanges
        ? await applyVisualizerPendingDataOps_ACU(visualizer)
        : { success: true, changed: false };
      if (!result.success) {
        toastStore.error(result.error || '数据保存失败。', { muteable: false });
        return false;
      }
      if (!result.changed && deletedSheetKeys.length === 0 && !hasLockChanges) {
        toastStore.info('没有需要保存的数据、锁或删表增量。', { muteable: false });
        return false;
      }
      if (deletedSheetKeys.length > 0) {
        const purgeResult = await purgeSheetKeysFromChatHistoryHard_ACU(deletedSheetKeys);
        if (purgeResult?.changed && isSqliteMode()) {
          try {
            await reloadStorageProvider();
          } catch (error) {
            logWarn_ACU('[ACU-V2 Visualizer] reloadStorageProvider failed after sheet purge:', error);
          }
        }
      }
      if (hasLockChanges) saveLockDrafts(visualizer.tableLockDrafts);
      try {
        await refreshMergedDataAndNotify_ACU();
      } catch (error: any) {
        if (visualizer.pendingDataOps?.committed) {
          throw new Error(`数据已持久化，但本地运行时刷新失败：${error?.message || String(error)}`);
        }
        throw error;
      }
      replaceVisualizerTemporaryRowIds_ACU(visualizer, result.insertedRowIds || {});
      try {
        (topLevelWindow_ACU as any).AutoCardUpdaterAPI?._notifyTableUpdate?.();
      } catch {}
      visualizer.markSaved('data');
      toastStore.success(
        deletedSheetKeys.length > 0 ? '数据增量、锁设置与删表清理已保存到当前消息。'
          : result.changed && hasLockChanges ? '数据增量与锁设置已保存到当前消息。'
            : result.changed ? '数据增量已保存到当前消息。'
            : '表格锁设置已保存。',
        { muteable: false },
      );
      return true;
    });
  }

  async function saveTemplateToCurrentChat(): Promise<boolean> {
    return runSaving(async () => {
      if (hasVisualizerPendingDataOps_ACU(visualizer)) {
        toastStore.error('存在未保存的数据增量；本次是模板保存，已阻止混合提交。', { muteable: false });
        return false;
      }
      const orderedData = buildOrderedData(visualizer.tempData, visualizer.sheetOrder, visualizer.tableLockDrafts, {
        renumberOrder: false,
        applySpecialIndex: false,
      });
      const changes = classifyVisualizerTemplateChanges_ACU(
        visualizer.templateBaseData,
        orderedData,
      );
      const changedSheetKeys = [...new Set([
        ...changes.addedSheetKeys,
        ...changes.schemaChangedSheetKeys,
        ...changes.metadataChangedSheetKeys,
      ])];
      const deletedSheetKeys = [...changes.deletedSheetKeys];
      const deletedSummarySheetKeys = deletedSheetKeys.filter(sheetKey => {
        const table = visualizer.templateBaseData?.[sheetKey];
        return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name));
      });
      const hasRemainingSummarySheet = Object.keys(orderedData).some(sheetKey => sheetKey.startsWith('sheet_')
        && !!orderedData[sheetKey]?.name && isSummaryOrOutlineTable_ACU(String(orderedData[sheetKey].name)));
      if (changedSheetKeys.length === 0 && deletedSheetKeys.length === 0) {
        if (visualizer.pendingLockChanges.length > 0 || visualizer.lockDirty) {
          saveLockDrafts(visualizer.tableLockDrafts);
          visualizer.markSaved('template-chat');
          toastStore.success('表格锁定设置已保存。', { muteable: false });
          return true;
        }
        toastStore.info('模板结构没有变化。', { muteable: false });
        return false;
      }
      const guideIsolationKey = getCurrentIsolationKey_ACU();
      const baseRevision = captureTableRuntimeRevisionForWriteSet_ACU(
        [...new Set([...changedSheetKeys, ...deletedSheetKeys])]
          .map(sheetKey => ({ kind: 'schema' as const, sheetKey })),
        { isolationKey: guideIsolationKey },
      );
      let schemaOperations: any[] = [];
      if (changes.schemaChangedSheetKeys.length > 0 && visualizer.templateBaseData) {
        const preflightSnapshot = {
          tempData: cloneData(visualizer.tempData),
          sheetOrder: [...visualizer.sheetOrder],
          templateBaseData: cloneData(visualizer.templateBaseData),
          templateBaseSheetOrder: [...visualizer.templateBaseSheetOrder],
          deletedSheetKeys: [...visualizer.deletedSheetKeys],
          tableLockDrafts: cloneData(visualizer.tableLockDrafts),
          pendingLockChanges: cloneData(visualizer.pendingLockChanges),
          lockDirty: visualizer.lockDirty,
        };
        const schemaMigrationIntents: Record<string, any> = {};
        let preflight = await preflightSchemaMigrations_ACU({
          baselineData: visualizer.templateBaseData as any,
          candidateData: orderedData as any,
          destructiveChangeConfirmed: false,
        });
        const choiceDecisions = () => (preflight.decisions || []).filter(decision => decision.status === 'needs_choice');
        if (preflight.blockers.length > 0 && choiceDecisions().length > 0) {
          const decisions = choiceDecisions();
          const onlyChoiceBlockers = decisions.length === preflight.blockers.length
            && decisions.every(decision => Array.isArray(decision.choices) && decision.choices.length > 0);
          if (onlyChoiceBlockers && interactions.requestSchemaMigrationChoice) {
            for (const decision of decisions) {
              const selectedId = await interactions.requestSchemaMigrationChoice({
                sheetKey: decision.sheetKey,
                message: decision.message || '请选择该 Sheet 的历史列映射。',
                choices: (decision.choices || []).map(choice => ({ id: choice.id, label: choice.label })),
              });
              if (!selectedId) return false;
              const selected = (decision.choices || []).find(choice => choice.id === selectedId);
              if (!selected) {
                toastStore.error(`schema migration 返回了无效选择：${decision.sheetKey}。`, { muteable: false });
                return false;
              }
              schemaMigrationIntents[decision.sheetKey] = cloneData(selected.intent);
            }
            const currentChoiceSnapshot = {
              tempData: cloneData(visualizer.tempData), sheetOrder: [...visualizer.sheetOrder],
              templateBaseData: cloneData(visualizer.templateBaseData), templateBaseSheetOrder: [...visualizer.templateBaseSheetOrder],
              deletedSheetKeys: [...visualizer.deletedSheetKeys], tableLockDrafts: cloneData(visualizer.tableLockDrafts),
              pendingLockChanges: cloneData(visualizer.pendingLockChanges), lockDirty: visualizer.lockDirty,
            };
            if (!sameTemplateValue_ACU(preflightSnapshot, currentChoiceSnapshot)) {
              toastStore.warning('模板结构在 schema migration 选择期间已变化；请重新保存。', { muteable: false });
              return false;
            }
            preflight = await preflightSchemaMigrations_ACU({
              baselineData: visualizer.templateBaseData as any, candidateData: orderedData as any,
              intents: schemaMigrationIntents, destructiveChangeConfirmed: false,
            });
          }
        }
        if (preflight.blockers.length > 0) {
          const confirmationIssues = preflight.issues || [];
          const onlyDestructiveDropConfirmation = confirmationIssues.length > 0
            && confirmationIssues.length === preflight.blockers.length
            && confirmationIssues.every(issue => issue.code === 'DESTRUCTIVE_COLUMN_DROP_CONFIRMATION_REQUIRED');
          if (!onlyDestructiveDropConfirmation) {
            toastStore.error(`模板结构未通过 schema migration preflight：${preflight.blockers.join('；')}`, { muteable: false });
            return false;
          }
          const confirmed = interactions.confirmDestructiveSchemaChange
            ? await interactions.confirmDestructiveSchemaChange({
              sheets: confirmationIssues.map(issue => ({
                sheetKey: issue.sheetKey,
                tableName: issue.tableName,
                droppedColumns: issue.droppedColumns.map(column => ({ ...column })),
                affectedRowCount: issue.affectedRowCount,
              })),
            })
            : false;
          if (!confirmed) return false;
          const currentConfirmationSnapshot = {
            tempData: cloneData(visualizer.tempData),
            sheetOrder: [...visualizer.sheetOrder],
            templateBaseData: cloneData(visualizer.templateBaseData),
            templateBaseSheetOrder: [...visualizer.templateBaseSheetOrder],
            deletedSheetKeys: [...visualizer.deletedSheetKeys],
            tableLockDrafts: cloneData(visualizer.tableLockDrafts),
            pendingLockChanges: cloneData(visualizer.pendingLockChanges),
            lockDirty: visualizer.lockDirty,
          };
          if (!sameTemplateValue_ACU(preflightSnapshot, currentConfirmationSnapshot)) {
            toastStore.warning('模板结构在危险确认期间已变化；请重新保存。', { muteable: false });
            return false;
          }
          preflight = await preflightSchemaMigrations_ACU({
            baselineData: visualizer.templateBaseData as any,
            candidateData: orderedData as any,
            intents: schemaMigrationIntents,
            destructiveChangeConfirmed: true,
          });
          if (preflight.blockers.length > 0) {
            toastStore.error(`模板结构未通过已确认 schema migration preflight：${preflight.blockers.join('；')}`, { muteable: false });
            return false;
          }
        }
        const operationKeys = preflight.operations.map(operation => String(operation?.sheetKey || ''));
        const preflightChangedKeys = [...preflight.changedSheetKeys].sort();
        const expectedSchemaKeys = [...changes.schemaChangedSheetKeys].sort();
        if (
          !sameTemplateValue_ACU(preflightChangedKeys, expectedSchemaKeys)
          || operationKeys.length !== expectedSchemaKeys.length
          || new Set(operationKeys).size !== operationKeys.length
          || operationKeys.some(sheetKey => !expectedSchemaKeys.includes(sheetKey))
        ) {
          toastStore.error('模板结构预检未返回与变更 Sheet 一一对应的 migration operation，已拒绝保存。', { muteable: false });
          return false;
        }
        schemaOperations = preflight.operations.map(operation => cloneData(operation));
        const currentPreflightSnapshot = {
          tempData: cloneData(visualizer.tempData),
          sheetOrder: [...visualizer.sheetOrder],
          templateBaseData: cloneData(visualizer.templateBaseData),
          templateBaseSheetOrder: [...visualizer.templateBaseSheetOrder],
          deletedSheetKeys: [...visualizer.deletedSheetKeys],
          tableLockDrafts: cloneData(visualizer.tableLockDrafts),
          pendingLockChanges: cloneData(visualizer.pendingLockChanges),
          lockDirty: visualizer.lockDirty,
        };
        if (!sameTemplateValue_ACU(preflightSnapshot, currentPreflightSnapshot)) {
          toastStore.warning('模板结构在 schema migration preflight 期间已变化；请重新保存。', { muteable: false });
          return false;
        }
      }
      const existingGuide = getChatSheetGuideDataForIsolationKey_ACU(guideIsolationKey);
      const guideData = buildChatSheetGuideDataFromData_ACU(orderedData, {
        preserveSeedRowsFromGuideData: existingGuide,
        seedRowsFromTemplateObj: parseTableTemplateJson_ACU({ stripSeedRows: false }),
        orderedKeys: [...visualizer.sheetOrder],
      });
      if (!guideData || !Object.keys(guideData).some(key => key.startsWith('sheet_'))) {
        throw new Error('无法为当前模板结构生成聊天指导表。');
      }
      const preparation = prepareTemplateSheetsForCommit_ACU(orderedData, changedSheetKeys);
      const templateScopeSource = cloneData(orderedData);
      const schemaOperationBySheetKey = new Map(schemaOperations.map(operation => [operation.sheetKey, operation]));
      const sheetChanges = changedSheetKeys.map(sheetKey => {
        if (changes.addedSheetKeys.includes(sheetKey)) {
          return { kind: 'introduction' as const, sheetKey, sheetData: orderedData[sheetKey] };
        }
        const operations: any[] = [];
        const schemaOperation = schemaOperationBySheetKey.get(sheetKey);
        if (schemaOperation) operations.push(schemaOperation);
        if (changes.metadataChangedSheetKeys.includes(sheetKey)) {
          operations.push({
            kind: 'meta_update' as const,
            sheetKey,
            meta: projectSheetPersistentMetadata_ACU(orderedData[sheetKey]),
          });
        }
        if (operations.length === 0) {
          throw new Error(`模板保存缺少可持久化的变更 operation：${sheetKey}。`);
        }
        return {
          kind: 'operations' as const,
          sheetKey,
          targetSheetData: orderedData[sheetKey],
          operations,
        };
      });
      const commitResult = await commitCurrentFloorTemplateChanges_ACU({
        isolationKey: guideIsolationKey,
        sheetChanges,
        deletedSheetKeys,
        guideData,
        syncTemplateScope: true,
        templateSource: templateScopeSource,
        presetName: resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true, isolationKey: guideIsolationKey }),
        source: 'visualizer_v2_save',
        reason: 'visualizer_v2_schema_change',
        baseRevision,
      });
      if (!commitResult.saved) {
        toastStore.error(commitResult.error || '模板/结构保存失败。', { muteable: false });
        return false;
      }
      try {
        applyTemplateScopeForCurrentChat_ACU();
      } catch (error) {
        logWarn_ACU('[ACU-V2 Visualizer] template commit saved but applyTemplateScopeForCurrentChat failed:', error);
        toastStore.warning('模板已保存，但模板作用域运行时同步失败；请重新载入当前聊天后重试。', { muteable: false });
      }
      try {
        _set_currentJsonTableData_ACU(cloneData(orderedData));
      } catch (error) {
        logWarn_ACU('[ACU-V2 Visualizer] template commit saved but runtime data synchronization failed:', error);
        toastStore.warning('模板已保存，但运行时数据同步失败；请重新载入当前聊天后重试。', { muteable: false });
      }
      for (const sheetKey of deletedSheetKeys) {
        delete visualizer.tableLockDrafts[sheetKey];
      }
      visualizer.pendingLockChanges = visualizer.pendingLockChanges.filter(change => !deletedSheetKeys.includes(String(change?.sheetKey || '')));
      try {
        for (const sheetKey of deletedSheetKeys) deleteTableLocksForSheet_ACU(sheetKey);
      } catch (error) {
        logWarn_ACU('[ACU-V2 Visualizer] template commit saved but deleted-sheet lock cleanup failed:', error);
        toastStore.warning('模板已保存，但已删除表的锁定状态清理失败；请重新载入当前聊天后重试。', { muteable: false });
      }
      let lockSaveFailed = false;
      const hasPendingLocks = visualizer.lockDirty || visualizer.pendingLockChanges.length > 0;
      if (hasPendingLocks) try {
        saveLockDrafts(visualizer.tableLockDrafts);
      } catch (error) {
        lockSaveFailed = true;
        logWarn_ACU('[ACU-V2 Visualizer] template commit saved but lock drafts failed:', error);
        toastStore.warning('模板已保存，但表格锁定设置未保存；请重试保存。', { muteable: false });
      }
      if (isSqliteMode()) {
        try {
          await reloadStorageProvider();
        } catch (error) {
          logWarn_ACU('[ACU-V2 Visualizer] template commit saved but reloadStorageProvider failed:', error);
          toastStore.warning('模板已保存，但 SQLite 运行时刷新失败；请重新载入当前聊天后重试。', { muteable: false });
        }
      }
      if (deletedSummarySheetKeys.length > 0) {
        try {
          if (hasRemainingSummarySheet && getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
            await enqueueSummaryVectorIndexFlush_ACU({ mode: 'sync', reason: 'visualizer_v2_template_sheet_delete' });
          } else if (!hasRemainingSummarySheet) {
            await deleteCurrentSummaryVectorIndexFromChat_ACU();
          }
        } catch (error) {
          logWarn_ACU('[ACU-V2 Visualizer] template commit saved but summary vector index cleanup failed:', error);
          toastStore.warning('模板已保存，但摘要向量索引清理失败；请重新载入当前聊天后重试。', { muteable: false });
        }
      }
      try {
        await refreshMergedDataAndNotify_ACU();
      } catch (error) {
        logWarn_ACU('[ACU-V2 Visualizer] template commit saved but refreshMergedDataAndNotify failed:', error);
        toastStore.warning('模板已保存，但合并数据刷新失败；请重新载入当前聊天后重试。', { muteable: false });
      }
      try {
        (topLevelWindow_ACU as any).AutoCardUpdaterAPI?._notifyTableUpdate?.();
      } catch {}
      if (lockSaveFailed && (visualizer.lockDirty || visualizer.pendingLockChanges.length > 0)) {
        visualizer.markTemplateSavedWithPendingLocks();
      } else {
        visualizer.markSaved('template-chat');
      }
      const removedCount = preparation.removedNullRowCount + (commitResult.removedNullRowCount || 0);
      toastStore.success(
        removedCount > 0
          ? `模板/结构已保存到当前聊天，已删除 ${deletedSheetKeys.length} 张表并移除 ${removedCount} 条缺少 row_id 的数据行。`
          : deletedSheetKeys.length > 0 ? `模板/结构已保存到当前聊天，已删除 ${deletedSheetKeys.length} 张表。` : '模板/结构已保存到当前聊天。',
        { muteable: false });
      return true;
    });
  }

  async function saveTemplateToGlobal(): Promise<boolean> {
    return runSaving(async () => {
      if (hasVisualizerPendingDataOps_ACU(visualizer)) {
        toastStore.error('存在未保存的数据增量；本次是模板保存，已阻止混合提交。', { muteable: false });
        return false;
      }
      const orderedData = buildOrderedData(visualizer.tempData, visualizer.sheetOrder, visualizer.tableLockDrafts, {
        renumberOrder: false,
        applySpecialIndex: false,
      });
      const globalTemplateResult = await saveGlobalTemplateSnapshot(orderedData, interactions);
      if (globalTemplateResult.status === 'cancelled') return false;
      saveLockDrafts(visualizer.tableLockDrafts);
      if (isSqliteMode()) await reloadStorageProvider();
      await refreshMergedDataAndNotify_ACU();
      visualizer.recordGlobalTemplateSaved();
      if (globalTemplateResult.status === 'saved') {
        toastStore.success(`模板/结构已保存到全局预设：${globalTemplateResult.presetName}。`, { muteable: false });
      } else {
        toastStore.info('全局模板无变化。', { muteable: false });
      }
      return true;
    });
  }

  return {
    saveDataToCurrentMessage,
    saveTemplateToCurrentChat,
    saveTemplateToGlobal,
    saveToChat: saveDataToCurrentMessage,
    saveToGlobal: saveTemplateToGlobal,
  };
}
