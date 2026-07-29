// ═══════════════════════════════════════════════════════════════
// service/table/table-service.ts — 表格数据操作 service 层
// 从 data/repositories/table-repo.ts 迁入（消除 data 层越权）
// ═══════════════════════════════════════════════════════════════

import { getChatArray_ACU, saveChatToHost_ACU } from '../../data/gateways/chat-gateway';
import { logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU, _set_currentJsonTableData_ACU } from '../runtime/state-manager';
import { applyTemplateScopeForCurrentChat_ACU } from '../settings/settings-service';
import {
  attachSeedRowsToCurrentDataFromGuide_ACU,
  buildChatSheetGuideDataFromData_ACU,
  ensureStableRowIdsForSheetContent_ACU,
  ensureChatSheetGuideSeeded_ACU,
  getChatSheetGuideDataForIsolationKey_ACU,
  getSortedSheetKeys_ACU,
  sanitizeSheetForStorage_ACU,
  setChatSheetGuideDataForIsolationKey_ACU,
} from '../template/chat-scope';
import { deleteAllGeneratedEntries_ACU } from '../worldbook/pipeline';
import { mergeAllIndependentTables_ACU, mergeAllIndependentTablesLegacyV1_ACU } from '../runtime/helpers-remaining';
import { cloneIsolatedData_ACU, writeIsolatedTagData_ACU, writeMessageIdentity_ACU, readIsolatedTagData_ACU, readLegacyIndependentData_ACU, isLegacyMatchForIsolation_ACU } from '../../data/repositories/chat-message-data-repo';
import { applyTableDelta_ACU, buildTableDelta_ACU, isDeltaTagData_ACU } from './table-delta';
import { isV2TagData_ACU, resolveTableStorageStrategy_ACU } from './storage-strategy-resolver';
import { persistTableMutationLogV2_ACU, type ReplaceExistingIncrementalOptions_ACU } from './storage-frame-v2-persist';
import { migrateLegacyStorageToV2OnLoad_ACU } from './storage-v2-migration';
import type { ManualRefillProgressV2_ACU, TableCheckpointV2_ACU, TableMutationOperationV2_ACU, TableMutationSourceV2_ACU, TableWriteConflictUnitV2_ACU } from './storage-frame-v2-types';
import type { TableWriteTransactionContext_ACU } from './table-write-transaction';
import type { TableDataObject_ACU } from '../../shared/models/table-data';

export interface TableChatPersistOptions_ACU {
  targetMessageIndex?: number;
  targetSheetKeys?: string[] | null;
  updateGroupKeys?: string[] | null;
  /**
   * 只把这些 sheet 记录为“本轮已更新”。
   * targetSheetKeys 决定保存哪些表；trackingSheetKeys 决定哪些表推进自动更新门禁。
   * 未传时沿用 targetSheetKeys，保持旧调用兼容。
   */
  trackingSheetKeys?: string[] | null;
  /**
   * 显式声明本次实际物化并完成填充的表。传入时优先于
   * trackAsUpdate/updateGroupKeys，避免把结构或元数据变更伪造为 filled。
   */
  filledSheetKeys?: string[] | null;
  tableData?: TableDataObject_ACU | null;
  trackAsUpdate?: boolean;
  source?: TableMutationSourceV2_ACU;
  requestId?: string;
  batchId?: string;
  operations?: TableMutationOperationV2_ACU[];
  baseRevision?: string | null;
  revisionWriteSet?: TableWriteConflictUnitV2_ACU[];
  forceCheckpoint?: boolean;
  checkpointReason?: TableCheckpointV2_ACU['reason'];
  manualRefillProgress?: ManualRefillProgressV2_ACU;
  /** 在本次 V2 entry 写入前替换指定 bucket 的历史增量。 */
  replaceExistingIncremental?: ReplaceExistingIncrementalOptions_ACU;
  /** 调用方已处于 transactionContext.runCommit 临界区内时使用，避免嵌套 commit 锁。 */
  assumeCommitLock?: boolean;
  /** 对破坏性复合写入要求宿主真实保存；默认保持历史宽松保存语义。 */
  strictSave?: boolean;
  transactionContext?: TableWriteTransactionContext_ACU;
}

const TABLE_PERSIST_COMMIT_MODEL_REQUIRED_ACU = 'Table persistence requires table update commit model; direct unsafe writes are not allowed.';

export async function ensureLegacyStorageMigratedBeforeWrite_ACU(reason = 'table_write'): Promise<{
  success: boolean;
  migrated?: boolean;
  data?: TableDataObject_ACU | null;
  error?: string;
}> {
  const chat = getChatArray_ACU();
  if (!Array.isArray(chat) || chat.length === 0) return { success: true, migrated: false };

  const isolationKey = getCurrentIsolationKey_ACU();
  const isolationConfig = {
    enabled: settings_ACU.dataIsolationEnabled,
    code: settings_ACU.dataIsolationCode,
  };
  const strategy = resolveTableStorageStrategy_ACU(chat, isolationKey, isolationConfig);
  if (strategy.mode !== 'legacy-v1') return { success: true, migrated: false };

  logWarn_ACU(`[LegacyMigrationGate] ${reason}: detected legacy-v1 before write, migrating first. reason=${strategy.reason}${strategy.warning ? `; warning=${strategy.warning}` : ''}`);
  const mergedLegacyData = await mergeAllIndependentTablesLegacyV1_ACU();
  if (!mergedLegacyData || !Object.keys(mergedLegacyData).some(k => k.startsWith('sheet_'))) {
    return { success: false, error: '旧存储迁移失败：无法从 legacy-v1 合并出有效表格数据。' };
  }

  const migrationResult = await migrateLegacyStorageToV2OnLoad_ACU({
    data: mergedLegacyData,
    isolationKey,
    isolationConfig,
    skipUpdateFloors: settings_ACU.skipUpdateFloors,
  });
  if (!migrationResult.migrated) {
    return { success: false, error: `旧存储迁移到 V2 失败: ${migrationResult.error || '未执行迁移'}` };
  }
  if (!migrationResult.data) {
    return { success: false, error: '旧存储迁移到 V2 失败: 迁移成功结果缺少修复后的表格数据。' };
  }

  const postStrategy = resolveTableStorageStrategy_ACU(chat, isolationKey, isolationConfig);
  if (postStrategy.mode === 'legacy-v1') {
    return { success: false, error: `旧存储迁移后仍检测到 legacy-v1: ${postStrategy.reason}` };
  }

  const migratedData = migrationResult.data;
  _set_currentJsonTableData_ACU(JSON.parse(JSON.stringify(migratedData)) as TableDataObject_ACU);
  return { success: true, migrated: true, data: migratedData };
}

export async function persistTablesToChatMessage_ACU(
  options: TableChatPersistOptions_ACU = {},
): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
  if (!options.transactionContext || options.assumeCommitLock !== true) {
    logError_ACU(TABLE_PERSIST_COMMIT_MODEL_REQUIRED_ACU);
    return { saved: false, error: TABLE_PERSIST_COMMIT_MODEL_REQUIRED_ACU };
  }
  return persistTablesToChatMessageWithLockOption_ACU(options);
}

async function persistTablesToChatMessageWithLockOption_ACU(
  options: TableChatPersistOptions_ACU = {},
): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
  const {
    targetMessageIndex = -1,
    targetSheetKeys = null,
    updateGroupKeys = null,
    trackingSheetKeys,
    filledSheetKeys: explicitFilledSheetKeys,
    tableData: explicitTableData,
    trackAsUpdate = true,
    source,
    requestId,
    batchId,
    operations,
    revisionWriteSet,
    forceCheckpoint,
    checkpointReason,
    manualRefillProgress,
    replaceExistingIncremental,
    assumeCommitLock,
    strictSave,
    transactionContext,
  } = options;

  const effectiveTableData = explicitTableData !== undefined ? explicitTableData : currentJsonTableData_ACU;
  if (!effectiveTableData) {
    logError_ACU('Save aborted: currentJsonTableData_ACU is null.');
    return { saved: false, error: 'currentJsonTableData is null' };
  }

  const currentIsolationKey = getCurrentIsolationKey_ACU();

  const persistCore = async () => {
    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) {
      logError_ACU('Save failed: Chat history is empty.');
      return { saved: false, error: 'chat history is empty' };
    }

    let strategy = resolveTableStorageStrategy_ACU(chat, currentIsolationKey, {
      enabled: settings_ACU.dataIsolationEnabled,
      code: settings_ACU.dataIsolationCode,
    });

    if (strategy.mode === 'legacy-v1') {
      const migration = await ensureLegacyStorageMigratedBeforeWrite_ACU('persistTablesToChatMessage');
      if (!migration.success) {
        const message = migration.error || 'legacy-v1 table storage migration failed before write.';
        logError_ACU(message);
        return { saved: false, error: message };
      }
      strategy = resolveTableStorageStrategy_ACU(chat, currentIsolationKey, {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
      });
      if (strategy.mode === 'legacy-v1') {
        const message = `legacy-v1 table storage still detected after migration: ${strategy.reason}`;
        logError_ACU(message);
        return { saved: false, error: message };
      }
    }

    let keysToSave: string[] = Array.isArray(targetSheetKeys)
      ? targetSheetKeys.filter((sheetKey): sheetKey is string => typeof sheetKey === 'string' && sheetKey.length > 0)
      : getSortedSheetKeys_ACU(effectiveTableData);
    keysToSave = [...new Set(keysToSave.filter(sheetKey => Boolean(effectiveTableData[sheetKey])))];

    const changedCandidateKeys = Array.isArray(trackingSheetKeys)
      ? trackingSheetKeys.filter((sheetKey): sheetKey is string => typeof sheetKey === 'string' && sheetKey.length > 0)
      : keysToSave;
    const trackingKeySet = new Set(
      changedCandidateKeys.filter(sheetKey => Boolean(effectiveTableData[sheetKey]))
    );
    const metadataOnlyUpdateGroupKeys = Array.isArray(updateGroupKeys)
      ? [...new Set(updateGroupKeys.filter(sheetKey => typeof sheetKey === 'string' && Boolean(effectiveTableData[sheetKey])))]
      : [];
    const filledSheetKeys = explicitFilledSheetKeys !== undefined
      ? [...new Set((explicitFilledSheetKeys || []).filter(sheetKey => typeof sheetKey === 'string' && Boolean(effectiveTableData[sheetKey])))]
      : (trackAsUpdate ? metadataOnlyUpdateGroupKeys : []);

    try {
      const existingGuide = getChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey);
      if (!existingGuide || !Object.keys(existingGuide).some(k => k.startsWith('sheet_'))) {
        const templateObjForSeed = parseTableTemplateJson_ACU({ stripSeedRows: false });
        const guideData = buildChatSheetGuideDataFromData_ACU(effectiveTableData, {
          preserveSeedRowsFromGuideData: null,
          seedRowsFromTemplateObj: templateObjForSeed,
        });
        if (guideData && Object.keys(guideData).some(k => k.startsWith('sheet_'))) {
          setChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey, guideData, { reason: 'first_fill' });
          logDebug_ACU(`[SheetGuide] Created chat sheet guide for tag [${currentIsolationKey || '无标签'}] (tables=${Object.keys(guideData).filter(k => k.startsWith('sheet_')).length}).`);
        }
      }
    } catch (e) {
      logWarn_ACU('[SheetGuide] Failed to create sheet guide on first fill:', e);
    }

    const persistedOperations = strategy.mode === 'empty' ? [] : operations;
    const persistV2InTransaction = async (transactionContext: TableWriteTransactionContext_ACU) => {
      const result = await persistTableMutationLogV2_ACU({
        targetMessageIndex,
        source: source || (metadataOnlyUpdateGroupKeys.length > 0 ? 'group_fill' : 'system'),
        afterData: effectiveTableData,
        operations: persistedOperations,
        filledSheetKeys,
        candidateChangedSheetKeys: [...trackingKeySet],
        groupKeys: metadataOnlyUpdateGroupKeys,
        requestId,
        batchId,
        forceCheckpoint: forceCheckpoint === true || strategy.mode === 'empty',
        checkpointReason: checkpointReason || (strategy.mode === 'empty' ? 'init' : undefined),
        manualRefillProgress,
        replaceExistingIncremental,
        isolationKey: currentIsolationKey,
        revisionWriteSet,
        assumeCommitLock,
        strictSave,
        transactionContext,
      });

      return { saved: result.saved, messageIndex: result.messageIndex, error: result.error };
    };

    if (!transactionContext || assumeCommitLock !== true) {
      logError_ACU(TABLE_PERSIST_COMMIT_MODEL_REQUIRED_ACU);
      return { saved: false, error: TABLE_PERSIST_COMMIT_MODEL_REQUIRED_ACU };
    }

    transactionContext.assertFresh?.('persistTablesToChatMessage:before_v2_persist');

    return persistV2InTransaction(transactionContext);
  };

  return persistCore();
}

async function persistTablesToChatMessageLegacyV1WithLockOption_ACU(
  options: TableChatPersistOptions_ACU = {},
): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
  const {
    targetMessageIndex = -1,
    targetSheetKeys = null,
    updateGroupKeys = null,
    trackingSheetKeys = targetSheetKeys,
    tableData: explicitTableData,
    trackAsUpdate = true,
  } = options;

/**
 * 保存独立表格数据到聊天记录。
 * 返回 { saved: boolean, messageIndex?: number, error?: string }
 * 注意：不再内部调用 refreshMergedDataAndNotify，调用方按需自行刷新。
 */
  const _skipPostRefresh = false;
  const effectiveTableData = explicitTableData !== undefined ? explicitTableData : currentJsonTableData_ACU;
  if (!effectiveTableData) {
    logError_ACU('Save aborted: currentJsonTableData_ACU is null.');
    return { saved: false, error: 'currentJsonTableData is null' };
  }

  const currentIsolationKey = getCurrentIsolationKey_ACU();

  const persistCore = async () => {
    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) {
      logError_ACU('Save failed: Chat history is empty.');
      return { saved: false, error: 'chat history is empty' };
    }

    let targetMessage: any = null;
    let finalIndex = -1;

    if (targetMessageIndex !== -1 && chat[targetMessageIndex] && !chat[targetMessageIndex].is_user) {
      targetMessage = chat[targetMessageIndex];
      finalIndex = targetMessageIndex;
    } else {
      for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) {
          targetMessage = chat[i];
          finalIndex = i;
          break;
        }
      }
    }

    if (!targetMessage) {
      logWarn_ACU('Save failed: No AI message found.');
      return { saved: false, error: 'no AI message found' };
    }

    const transactionContext = options.transactionContext;
    transactionContext?.assertFresh?.('persistTablesToChatMessage:before_legacy_persist');
    if (finalIndex < 0 || !chat[finalIndex] || chat[finalIndex] !== targetMessage || targetMessage.is_user) {
      return { saved: false, error: 'target AI message changed before legacy persist; abort stale table write.' };
    }

    // 查找上一个 AI 楼层的 tagData 作为 delta 的 base
    let prevTagData: import('../../data/models/chat-message-data').IsolationTagData_ACU | null = null;
    for (let i = finalIndex - 1; i >= 0; i--) {
      if (!chat[i].is_user) {
        const td = readIsolatedTagData_ACU(chat[i], currentIsolationKey);
        if (td && td.independentData && Object.keys(td.independentData).some(k => k.startsWith('sheet_'))) {
          prevTagData = td;
        }
        break;
      }
    }

    try {
      const existingGuide = getChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey);
      if (!existingGuide || !Object.keys(existingGuide).some(k => k.startsWith('sheet_'))) {
        const templateObjForSeed = parseTableTemplateJson_ACU({ stripSeedRows: false });
        const guideData = buildChatSheetGuideDataFromData_ACU(effectiveTableData, {
          preserveSeedRowsFromGuideData: null,
          seedRowsFromTemplateObj: templateObjForSeed,
        });
        if (guideData && Object.keys(guideData).some(k => k.startsWith('sheet_'))) {
          setChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey, guideData, { reason: 'first_fill' });
          logDebug_ACU(`[SheetGuide] Created chat sheet guide for tag [${currentIsolationKey || '无标签'}] (tables=${Object.keys(guideData).filter(k => k.startsWith('sheet_')).length}).`);
        }
      }
    } catch (e) {
      logWarn_ACU('[SheetGuide] Failed to create sheet guide on first fill:', e);
    }

    const isolatedData = cloneIsolatedData_ACU(targetMessage);

    if (!isolatedData[currentIsolationKey]) {
      isolatedData[currentIsolationKey] = {
        independentData: {},
        modifiedKeys: [],
        updateGroupKeys: [],
      };
    }

    const currentTagData = isolatedData[currentIsolationKey];
    let independentData: Record<string, any> = {};

    if (isDeltaTagData_ACU(currentTagData) && currentTagData.incrementalData) {
      independentData = prevTagData?.independentData
        ? JSON.parse(JSON.stringify(prevTagData.independentData))
        : JSON.parse(JSON.stringify(currentTagData.independentData || {}));
      const existingCheckpointData = JSON.parse(JSON.stringify(currentTagData.independentData || {}));
      for (const [sheetKey, delta] of Object.entries(currentTagData.incrementalData)) {
        const baseSheet = independentData[sheetKey] || existingCheckpointData[sheetKey];
        if (!baseSheet) {
          logWarn_ACU(`[表格增量] 楼层 #${finalIndex} 既有 delta 表 ${sheetKey} 缺少 base，回退保留当前楼层已存快照`);
          if (existingCheckpointData[sheetKey]) {
            independentData[sheetKey] = existingCheckpointData[sheetKey];
          }
          continue;
        }
        const normalizedBaseSheet = JSON.parse(JSON.stringify(baseSheet));
        if (Array.isArray(normalizedBaseSheet.content)) {
          normalizedBaseSheet.content = ensureStableRowIdsForSheetContent_ACU(normalizedBaseSheet.content);
        }
        independentData[sheetKey] = applyTableDelta_ACU(normalizedBaseSheet, delta, sheetKey);
      }
    } else {
      independentData = JSON.parse(JSON.stringify(currentTagData.independentData || {}));
    }

    let keysToSave: string[] = Array.isArray(targetSheetKeys)
      ? targetSheetKeys.filter((sheetKey): sheetKey is string => typeof sheetKey === 'string' && sheetKey.length > 0)
      : getSortedSheetKeys_ACU(effectiveTableData);

    keysToSave = [...new Set(keysToSave.filter(sheetKey => Boolean(effectiveTableData[sheetKey])))];

    const trackingCandidateKeys = [
      ...keysToSave,
      ...(Array.isArray(trackingSheetKeys)
        ? trackingSheetKeys.filter((sheetKey): sheetKey is string => typeof sheetKey === 'string' && sheetKey.length > 0)
        : []),
    ];
    const trackingKeySet = new Set(
      trackingCandidateKeys.filter(sheetKey => Boolean(effectiveTableData[sheetKey]))
    );
    const actuallyModifiedKeys = [...trackingKeySet];
    const metadataOnlyUpdateGroupKeys = Array.isArray(updateGroupKeys)
      ? [...new Set(updateGroupKeys.filter(sheetKey => trackingKeySet.has(sheetKey) && Boolean(effectiveTableData[sheetKey])))]
      : [];

    if (keysToSave.length === 0 && trackAsUpdate && actuallyModifiedKeys.length > 0) {
      const existingModifiedKeys = currentTagData.modifiedKeys || [];
      currentTagData.modifiedKeys = [...new Set([...existingModifiedKeys, ...actuallyModifiedKeys])];

      if (metadataOnlyUpdateGroupKeys.length > 0) {
        const existingGroupKeys = currentTagData.updateGroupKeys || [];
        currentTagData.updateGroupKeys = [...new Set([...existingGroupKeys, ...metadataOnlyUpdateGroupKeys])];
      }

      writeIsolatedTagData_ACU(targetMessage, currentIsolationKey, currentTagData);
      writeMessageIdentity_ACU(targetMessage, {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
      });

      await saveChatToHost_ACU();
      return { saved: true, messageIndex: finalIndex };
    }

    keysToSave.forEach(sheetKey => {
      const table = effectiveTableData[sheetKey];
      if (table) {
        const normalizedTable = JSON.parse(JSON.stringify(table));
        if (Array.isArray(normalizedTable.content)) {
          normalizedTable.content = ensureStableRowIdsForSheetContent_ACU(normalizedTable.content);
        }
        independentData[sheetKey] = sanitizeSheetForStorage_ACU(normalizedTable);
      }
    });

    currentTagData.independentData = independentData;

    // ── 增量/checkpoint 模式判定 ──
    let persistedChangedKeySet = new Set<string>();

    if (prevTagData && prevTagData.independentData) {
      // 尝试对目标楼层已合并后的表构建 delta。
      // 同一楼层可能由多个更新组分批写入，必须保留此前组已写入的 incrementalData。
      const incrementalData: Record<string, import('../../data/models/chat-message-data').TableIncrementalUpdate_ACU> = {};
      let anyDegraded = false;

      for (const sheetKey of Object.keys(independentData).filter(k => k.startsWith('sheet_'))) {
        const nextSheet = independentData[sheetKey];
        if (!nextSheet) continue;
        const normalizedBaseSheet = JSON.parse(JSON.stringify(prevTagData.independentData[sheetKey] || null));
        if (normalizedBaseSheet && Array.isArray(normalizedBaseSheet.content)) {
          normalizedBaseSheet.content = ensureStableRowIdsForSheetContent_ACU(normalizedBaseSheet.content);
        }
        const result = buildTableDelta_ACU(normalizedBaseSheet, nextSheet, sheetKey);
        if (result.degraded) {
          anyDegraded = true;
          logDebug_ACU(`[表格增量] ${sheetKey} 退化: ${result.degradeReason}，本楼层将使用 checkpoint 模式`);
          break;
        }
        if (result.delta && (result.delta.rowDeltas.length > 0 || result.delta.metaChanged)) {
          incrementalData[sheetKey] = result.delta;
        }
      }

      if (!anyDegraded) {
        // delta 模式：写入增量数据，independentData 清空以节省存储空间
        currentTagData.incrementalData = incrementalData;
        currentTagData.independentData = {};
        currentTagData._acu_storage_mode = 'delta';
        currentTagData._acu_storage_version = 1;
        persistedChangedKeySet = new Set(Object.keys(incrementalData));
        logDebug_ACU(`[表格增量] 楼层 #${finalIndex} 使用 delta 模式，${Object.keys(incrementalData).length} 张表有变更`);
      } else {
        // checkpoint 模式：退化，写完整快照
        delete currentTagData.incrementalData;
        currentTagData._acu_storage_mode = 'checkpoint';
        currentTagData._acu_storage_version = 1;
        persistedChangedKeySet = new Set(actuallyModifiedKeys.filter(sheetKey => Boolean(independentData[sheetKey])));
        logDebug_ACU(`[表格Checkpoint] 楼层 #${finalIndex} 使用 checkpoint 模式`);
      }
    } else {
      // 无上一楼层 base → checkpoint 模式（首楼层或首次出现该标签）
      delete currentTagData.incrementalData;
      currentTagData._acu_storage_mode = 'checkpoint';
      currentTagData._acu_storage_version = 1;
      persistedChangedKeySet = new Set(actuallyModifiedKeys.filter(sheetKey => Boolean(independentData[sheetKey])));
      logDebug_ACU(`[表格Checkpoint] 楼层 #${finalIndex} 无 base，使用 checkpoint 模式`);
    }

    const trackingModifiedKeys = actuallyModifiedKeys;
    const trackingUpdateGroupKeys = metadataOnlyUpdateGroupKeys;

    if (trackAsUpdate && trackingModifiedKeys.length > 0) {
      const existingModifiedKeys = currentTagData.modifiedKeys || [];
      currentTagData.modifiedKeys = [...new Set([...existingModifiedKeys, ...trackingModifiedKeys])];
      logDebug_ACU(`[Tracking] Recorded modified keys for tag [${currentIsolationKey || '无标签'}] at index ${finalIndex}: ${currentTagData.modifiedKeys.join(', ')}`);
    }

    if (trackAsUpdate && trackingUpdateGroupKeys.length > 0 && trackingModifiedKeys.length > 0) {
      const existingGroupKeys = currentTagData.updateGroupKeys || [];
      currentTagData.updateGroupKeys = [...new Set([...existingGroupKeys, ...trackingUpdateGroupKeys])];
      logDebug_ACU(`[Merge Update Success] Group keys for tag [${currentIsolationKey || '无标签'}] recorded at index ${finalIndex}: ${currentTagData.updateGroupKeys.join(', ')}`);
    } else if (trackAsUpdate && updateGroupKeys && updateGroupKeys.length > 0 && actuallyModifiedKeys.length === 0) {
      logDebug_ACU(`[Merge Update Failed] No tables were modified for tag [${currentIsolationKey || '无标签'}]. Group keys NOT recorded: ${updateGroupKeys.join(', ')}`);
    } else if (trackAsUpdate && updateGroupKeys && updateGroupKeys.length > 0 && trackingUpdateGroupKeys.length === 0) {
      logDebug_ACU(`[Merge Update Skipped] No tracked group keys intersected for tag [${currentIsolationKey || '无标签'}]. Group keys NOT recorded: ${updateGroupKeys.join(', ')}`);
    }

    writeIsolatedTagData_ACU(targetMessage, currentIsolationKey, currentTagData);

    writeMessageIdentity_ACU(targetMessage, {
      enabled: settings_ACU.dataIsolationEnabled,
      code: settings_ACU.dataIsolationCode,
    });

    logDebug_ACU(`Saved ${keysToSave.length} tables for tag [${currentIsolationKey || '无标签'}] to message at index ${finalIndex}. Actually modified: ${actuallyModifiedKeys.length} tables.`);

    await saveChatToHost_ACU();

    return { saved: true, messageIndex: finalIndex };
  };

  return persistCore();
}

/**
 * @deprecated 旧兼容写入口已收口禁用。所有表格写入必须走 runTableUpdateCommit_ACU。
 */
export async function saveIndependentTableToChatHistory_ACU(
  _targetMessageIndex = -1,
  _targetSheetKeys: string[] | null = null,
  _updateGroupKeys: string[] | null = null,
  _skipPostRefresh = false,
  _trackingSheetKeys: string[] | null = _targetSheetKeys,
  _source?: TableMutationSourceV2_ACU,
  _requestId?: string,
  _batchId?: string,
  _transactionContext?: TableWriteTransactionContext_ACU,
  _operations?: TableMutationOperationV2_ACU[],
  _revisionWriteSet?: TableWriteConflictUnitV2_ACU[],
): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
  logError_ACU(TABLE_PERSIST_COMMIT_MODEL_REQUIRED_ACU);
  return { saved: false, error: TABLE_PERSIST_COMMIT_MODEL_REQUIRED_ACU };
}

/**
 * 检查当前聊天是否为首次初始化（无任何已有表格数据）。
 */
export async function checkIfFirstTimeInit_ACU(): Promise<boolean> {
  const chat = getChatArray_ACU();
  if (!chat || chat.length === 0) return true;

  const currentIsolationKey = getCurrentIsolationKey_ACU();

  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i];
    if (message.is_user) continue;

    const tagData = readIsolatedTagData_ACU(message, currentIsolationKey) as any;
    if (isV2TagData_ACU(tagData)) {
      const checkpointData = tagData.storageFrame?.checkpoint?.data;
      if (checkpointData && Object.keys(checkpointData).some(k => k.startsWith('sheet_'))) {
        return false;
      }
      const hasV2SheetOperation = (tagData.storageFrame?.logEntries || []).some((entry: any) =>
        Array.isArray(entry?.operations) && entry.operations.some((operation: any) => {
          if (operation?.kind === 'sheet_replace') return typeof operation.sheetKey === 'string' && operation.sheetKey.startsWith('sheet_');
          if (operation?.kind === 'sheet_schema_migrate') return typeof operation.sheetKey === 'string' && operation.sheetKey.startsWith('sheet_');
          if (operation?.kind === 'row_upsert' || operation?.kind === 'row_delete' || operation?.kind === 'meta_update') return typeof operation.sheetKey === 'string' && operation.sheetKey.startsWith('sheet_');
          if (operation?.kind === 'data_replace') return operation.data && Object.keys(operation.data).some((k: string) => k.startsWith('sheet_'));
          if (operation?.kind === 'sql_sheet_batch') return typeof operation.sheetKey === 'string' && operation.sheetKey.startsWith('sheet_') && Array.isArray(operation.statements) && operation.statements.length > 0;
          if (operation?.kind === 'sql_batch') return Array.isArray(operation.statements) && operation.statements.length > 0;
          return false;
        })
      );
      if (hasV2SheetOperation) return false;
    }
    if (tagData?.independentData && Object.keys(tagData.independentData).some(k => k.startsWith('sheet_'))) {
      return false;
    }

    const isolationConfig = { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode };
    if (isLegacyMatchForIsolation_ACU(message, isolationConfig)) {
      const legacyIndep = readLegacyIndependentData_ACU(message);
      if (legacyIndep && Object.keys(legacyIndep).some(k => k.startsWith('sheet_'))) {
        return false;
      }
    }
  }

  return true;
}

/**
 * 从模板初始化数据库到内存（不写聊天记录）。
 * 返回 { initialized: boolean, error?: string }
 */
async function initializeJsonTableInChatHistory_ACU(): Promise<{ initialized: boolean; error?: string }> {
  logDebug_ACU('No database found in chat history. Initializing a new one from template.');

  try {
    _set_currentJsonTableData_ACU(parseTableTemplateJson_ACU({ stripSeedRows: true }));
    logDebug_ACU('Successfully initialized database in memory.');
  } catch (error) {
    logError_ACU('Failed to parse template and initialize database in memory:', error);
    _set_currentJsonTableData_ACU(null);
    return { initialized: false, error: '从模板解析数据库失败，请检查模板格式。' };
  }
  if (!currentJsonTableData_ACU) {
    return { initialized: false, error: '从模板解析数据库失败，请检查模板格式。' };
  }

  logDebug_ACU('Database initialized in memory. It will be saved to chat history on the first update.');

  try {
    const guideData = await ensureChatSheetGuideSeeded_ACU({ reason: 'init_chat_seedrows' });
    if (guideData) {
      attachSeedRowsToCurrentDataFromGuide_ACU(guideData);
    }
  } catch (e) {
    logWarn_ACU('[SheetGuide] Failed to ensure sheet guide during initialization:', e);
  }

  try {
    await deleteAllGeneratedEntries_ACU();
    logDebug_ACU('Deleted all generated lorebook entries during initialization.');
  } catch (deleteError) {
    logWarn_ACU('Failed to delete generated lorebook entries during initialization:', deleteError);
  }

  return { initialized: true };
}

/**
 * 从聊天记录加载或创建表格数据到内存。
 * 返回 { loaded: boolean, source: 'merged'|'initialized'|'empty', error?: string }
 * 注意：不再内部调用 refreshMergedDataAndNotify，调用方按需自行刷新。
 */
export async function loadOrCreateJsonTableFromChatHistory_ACU(): Promise<{
  loaded: boolean;
  source: 'merged' | 'initialized' | 'empty';
  error?: string;
  /** 本轮当前聊天回放得到的 canonical 快照，供 SQLite hydrate 显式使用。 */
  data?: TableDataObject_ACU | null;
}> {
  _set_currentJsonTableData_ACU(null);
  logDebug_ACU('Attempting to load database from chat history...');

  const chat = getChatArray_ACU();
  applyTemplateScopeForCurrentChat_ACU();
  if (!chat || chat.length === 0) {
    logDebug_ACU('Chat history is empty. Initializing new database.');
    const initResult = await initializeJsonTableInChatHistory_ACU();
    return {
      loaded: initResult.initialized,
      source: 'initialized',
      error: initResult.error,
      data: currentJsonTableData_ACU as TableDataObject_ACU | null,
    };
  }

  const mergedData = await mergeAllIndependentTables_ACU();

  if (mergedData) {
    const canonicalData = JSON.parse(JSON.stringify(mergedData)) as TableDataObject_ACU;
    _set_currentJsonTableData_ACU(canonicalData);
    logDebug_ACU('Database content successfully merged (tag-aware) and loaded into memory.');
    return { loaded: true, source: 'merged', data: canonicalData };
  }

  logDebug_ACU('No database found for current tag in chat history. Initializing a new one.');
  const initResult = await initializeJsonTableInChatHistory_ACU();
  return {
    loaded: initResult.initialized,
    source: 'initialized',
    error: initResult.error,
    data: currentJsonTableData_ACU as TableDataObject_ACU | null,
  };
}
