/**
 * service/runtime/helpers-data-merge.ts — 数据合并/格式化/首楼初始化/阈值
 * 从 helpers-remaining.ts 拆出
 */
import { deriveTemplatePresetNameForImport_ACU } from '../../shared/template-preset-utils';
import { TABLE_ORDER_FIELD_ACU } from '../../shared/constants';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, independentTableStates_ACU, settings_ACU, suppressWorldbookInjectionInGreeting_ACU, _set_suppressWorldbookInjectionInGreeting_ACU, _set_currentJsonTableData_ACU } from './state-manager';
import { isSqliteMode } from '../table/storage-mode';
import { getChatArray_ACU, saveChatToHost_ACU } from '../../data/gateways/chat-gateway';
import { applyTemplateScopeForCurrentChat_ACU, saveSettings_ACU } from '../settings/settings-service';
import { buildChatSheetGuideDataFromTemplateObj_ACU, getChatSheetGuideDataForIsolationKey_ACU, getSortedSheetKeys_ACU, materializeDataFromSheetGuide_ACU, reorderDataBySheetKeys_ACU, sanitizeTemplateSnapshotForChat_ACU, setChatSheetGuideDataForIsolationKey_ACU } from '../template/chat-scope';
import { deleteAllGeneratedEntries_ACU } from '../worldbook/pipeline';
import { ensureSheetOrderNumbers_ACU, isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';
import { getTemplateSheetKeys_ACU } from '../template/chat-scope';
import { upsertTemplatePreset_ACU } from '../template/template-preset-service';
import { readIsolatedTagData_ACU, readLegacyIndependentData_ACU, readLegacyStandardData_ACU, readLegacySummaryData_ACU, readModifiedKeys_ACU, readUpdateGroupKeys_ACU, readMessageIdentity_ACU, isLegacyMatchForIsolation_ACU, initIsolatedTagSlot_ACU, writeLegacyCompatData_ACU } from '../../data/repositories/chat-message-data-repo';
import { applyTableDelta_ACU, isDeltaTagData_ACU, isCheckpointTagData_ACU } from '../table/table-delta';
import { isV2TagData_ACU, resolveTableStorageStrategy_ACU } from '../table/storage-strategy-resolver';
import { loadTableStateFromFramesV2_ACU } from '../table/storage-frame-v2-replay';
import { persistTableMutationLogV2_ACU } from '../table/storage-frame-v2-persist';
import { migrateLegacyStorageToV2OnLoad_ACU } from '../table/storage-v2-migration';
import { runTableWriteTransaction_ACU } from '../table/table-write-transaction';
import { normalizeCanonicalTableRows_ACU } from '../../shared/canonical-row-normalizer';
import { allocateStableRowId_ACU, createStableRowIdReservation_ACU } from '../../shared/stable-row-id-allocator';

/**
 * Legacy entry point retained for callers that need in-place normalization.
 * Empty canonical row_id values mean deletion; they must not be fabricated
 * from array positions because that would create a false row identity.
 */
export function migrateContentNullToRowId(data: Record<string, any> | null): Record<string, any> | null {
    normalizeCanonicalTableRows_ACU(data);
    return data;
}

  function hasUsableSheetGuide_ACU(sheetGuideData: any): boolean {
      return !!(sheetGuideData && typeof sheetGuideData === 'object' && Object.keys(sheetGuideData).some(k => k.startsWith('sheet_')));
  }

  function mergeSheetGuideStructureIntoData_ACU(mergedData: Record<string, any>, sheetGuideData: any): Record<string, any> {
      const guided = materializeDataFromSheetGuide_ACU(sheetGuideData, { includeSeedRows: false });
      const guideKeys = getSortedSheetKeys_ACU(guided, { ignoreChatGuide: true, includeMissingFromGuide: true });
      guideKeys.forEach(k => {
          if (!k || !k.startsWith('sheet_')) return;
          const guideSheet = guided[k];
          const hist = mergedData[k];
          if (hist && typeof hist === 'object') {
              const next = JSON.parse(JSON.stringify(hist));
              next.uid = k;
              if (guideSheet?.name) next.name = guideSheet.name;
              if (guideSheet?.sourceData) next.sourceData = JSON.parse(JSON.stringify(guideSheet.sourceData));
              if (guideSheet?.updateConfig) next.updateConfig = JSON.parse(JSON.stringify(guideSheet.updateConfig));
              if (guideSheet?.exportConfig) next.exportConfig = JSON.parse(JSON.stringify(guideSheet.exportConfig));
              const guideHeader = (guideSheet && Array.isArray(guideSheet.content) && Array.isArray(guideSheet.content[0]))
                  ? JSON.parse(JSON.stringify(guideSheet.content[0]))
                  : null;
              if (!Array.isArray(next.content)) next.content = guideHeader ? [guideHeader] : [['row_id']];
              if (guideHeader) {
                  next.content[0] = guideHeader;
                  const targetLen = guideHeader.length;
                  for (let r = 1; r < next.content.length; r++) {
                      const row = next.content[r];
                      if (!Array.isArray(row)) continue;
                      const hasAutoMergedTag = row.length > 0 && row[row.length - 1] === 'auto_merged';
                      if (row.length < targetLen) {
                          while (row.length < targetLen) row.push('');
                          if (hasAutoMergedTag && row[row.length - 1] !== 'auto_merged') row.push('auto_merged');
                      } else if (row.length > targetLen) {
                          row.splice(targetLen);
                          if (hasAutoMergedTag) row.push('auto_merged');
                      }
                  }
              }
              if (Number.isFinite(guideSheet?.[TABLE_ORDER_FIELD_ACU])) next[TABLE_ORDER_FIELD_ACU] = Math.trunc(guideSheet[TABLE_ORDER_FIELD_ACU]);
              if (Array.isArray(guideSheet?.seedRows)) next.seedRows = JSON.parse(JSON.stringify(guideSheet.seedRows));
              guided[k] = next;
          } else if (Number.isFinite(guideSheet?.[TABLE_ORDER_FIELD_ACU])) {
              guided[k][TABLE_ORDER_FIELD_ACU] = Math.trunc(guideSheet[TABLE_ORDER_FIELD_ACU]);
          }
      });
      return guided;
  }

  export async function mergeAllIndependentTablesLegacyV1_ACU() {
      const chat = getChatArray_ACU();
      if (!chat || chat.length === 0) {
          logDebug_ACU('Cannot merge data: Chat history is empty.');
          return null;
      }

      // [数据隔离核心] 获取当前隔离标签键名
      const currentIsolationKey = getCurrentIsolationKey_ACU();
      logDebug_ACU(`[Merge] Loading data for isolation key: [${currentIsolationKey || '无标签'}]`);

      // [新增] 聊天级"空白指导表"：一旦存在，本聊天合并/显示顺序都按指导表，不再按模板
      // 注意：该指导表按隔离标签分槽，因此切换标识时可拥有不同的"参数/表头/顺序总指导"
      const sheetGuideData = getChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey);
      const hasSheetGuide = hasUsableSheetGuide_ACU(sheetGuideData);

      // [新增] 获取当前模板/指导表的表格键列表，用于过滤非当前模板的数据
      // 优先使用指导表（如果存在），否则使用当前模板
      // 这样可以确保：切换/导入新模板后，只读取当前模板中存在的表格数据
      const templateSheetKeys = (() => {
          if (hasSheetGuide) {
              // 存在指导表：使用指导表的表格键（指导表已在导入/切换模板时更新）
              return Object.keys(sheetGuideData).filter(k => k.startsWith('sheet_'));
          }
          // 不存在指导表：使用当前模板的表格键
          return getTemplateSheetKeys_ACU();
      })();
      const templateSheetKeySet = new Set(templateSheetKeys);
      logDebug_ACU(`[Merge] Template/Guide filter: ${templateSheetKeys.length} tables allowed (${hasSheetGuide ? 'guide' : 'template'})`);

      // 1. [优化] 不使用模板作为基础，动态收集聊天记录中的所有实际数据
      let mergedData: Record<string, any> = {};
      const foundSheets: Record<string, boolean> = {};
      // 收集 delta 楼层的增量数据（逆序收集，后续正序叠加）
      const pendingDeltas: { index: number; tagData: any }[] = [];

      for (let i = chat.length - 1; i >= 0; i--) {
          const message = chat[i];
          if (message.is_user) continue;

          // [优先级1] 检查新版按标签分组存储
          const tagData = readIsolatedTagData_ACU(message, currentIsolationKey);
          if (tagData) {
              // delta 楼层：收集增量数据，稍后正序叠加
              if (isDeltaTagData_ACU(tagData)) {
                  if (tagData.incrementalData && Object.keys(tagData.incrementalData).length > 0) {
                      pendingDeltas.push({ index: i, tagData });
                  }
                  continue;
              }

              // checkpoint / legacy 楼层：使用现有的 first-write-wins 逻辑
              const independentData = tagData.independentData || {};
              const modifiedKeys = tagData.modifiedKeys || [];
              const updateGroupKeys = tagData.updateGroupKeys || [];

              Object.keys(independentData).forEach(storedSheetKey => {
                  // [新增] 只处理当前模板/指导表中存在的表格
                  if (!templateSheetKeySet.has(storedSheetKey)) {
                      logDebug_ACU(`[Merge] Skipping sheet [${storedSheetKey}] - not in current template/guide`);
                      return;
                  }
    if (!foundSheets[storedSheetKey]) {
                      mergedData[storedSheetKey] = JSON.parse(JSON.stringify(independentData[storedSheetKey]));
                      foundSheets[storedSheetKey] = true;

                      // [修复] 如果数据来自基底状态消息（seedGreeting 写入的模板初始数据），
                      // 在 sheet 上标记 _acu_from_base_state，供 SqlTableService.loadFromChat 区分
                      // "基底数据"和"AI 真正填写的数据"，避免因基底数据提前建表
                      if (tagData._acu_base_state === GREETING_LOCAL_BASE_STATE_MARKER_ACU) {
                          mergedData[storedSheetKey]._acu_from_base_state = true;
                      }

                      // 更新表格状态
                      let wasUpdated = false;
                      if (updateGroupKeys.length > 0 && modifiedKeys.length > 0) {
                          wasUpdated = updateGroupKeys.includes(storedSheetKey);
                      } else if (modifiedKeys.length > 0) {
                          wasUpdated = modifiedKeys.includes(storedSheetKey);
                      } else {
                          wasUpdated = true;
                      }

                      if (wasUpdated) {
                          if (!independentTableStates_ACU[storedSheetKey]) {
                              independentTableStates_ACU[storedSheetKey] = {};
                          }
                          const currentAiFloor = chat.slice(0, i + 1).filter(m => !m.is_user).length;
                          independentTableStates_ACU[storedSheetKey].lastUpdatedAiFloor = currentAiFloor;
                      }
                  }
              });
          }

          // [优先级2] 兼容旧版存储格式 - 严格匹配隔离标签
          // [数据隔离核心逻辑] 无标签也是标签的一种，严格隔离不同标签的数据
          const isolationConfig = { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode };
          const isLegacyMatch = isLegacyMatchForIsolation_ACU(message, isolationConfig);

          if (isLegacyMatch) {
              // 检查旧版独立数据格式
              const legacyIndepData = readLegacyIndependentData_ACU(message);
              if (legacyIndepData) {
                  const independentData = legacyIndepData;
                  const modifiedKeys = readModifiedKeys_ACU(message);
                  const updateGroupKeys = readUpdateGroupKeys_ACU(message);

                  Object.keys(independentData).forEach(storedSheetKey => {
                      // [新增] 只处理当前模板/指导表中存在的表格
                      if (!templateSheetKeySet.has(storedSheetKey)) {
                          logDebug_ACU(`[Merge] Skipping sheet [${storedSheetKey}] (legacy) - not in current template/guide`);
                          return;
                      }
                      if (!foundSheets[storedSheetKey]) {
                          mergedData[storedSheetKey] = JSON.parse(JSON.stringify(independentData[storedSheetKey]));
                          foundSheets[storedSheetKey] = true;

                          let wasUpdated = false;
                          if (updateGroupKeys.length > 0 && modifiedKeys.length > 0) {
                              wasUpdated = updateGroupKeys.includes(storedSheetKey);
                          } else if (modifiedKeys.length > 0) {
                              wasUpdated = modifiedKeys.includes(storedSheetKey);
                          } else {
                              wasUpdated = true;
                          }

                          if (wasUpdated) {
                              if (!independentTableStates_ACU[storedSheetKey]) independentTableStates_ACU[storedSheetKey] = {};
                              const currentAiFloor = chat.slice(0, i + 1).filter(m => !m.is_user).length;
                              independentTableStates_ACU[storedSheetKey].lastUpdatedAiFloor = currentAiFloor;
                          }
                      }
                  });
              }

              // 检查旧版标准表/总结表格式
              const legacyStdData = readLegacyStandardData_ACU(message);
              if (legacyStdData) {
                  const standardData: any = legacyStdData;
                  Object.keys(standardData).forEach(k => {
                      // [新增] 只处理当前模板/指导表中存在的表格
                      if (!templateSheetKeySet.has(k)) {
                          return;
                      }
                      if (k.startsWith('sheet_') && !foundSheets[k] && standardData[k].name && !isSummaryOrOutlineTable_ACU(standardData[k].name)) {
                          mergedData[k] = JSON.parse(JSON.stringify(standardData[k]));
                          foundSheets[k] = true;
                          if (!independentTableStates_ACU[k]) independentTableStates_ACU[k] = {};
                          const currentAiFloor = chat.slice(0, i + 1).filter(m => !m.is_user).length;
                          independentTableStates_ACU[k].lastUpdatedAiFloor = currentAiFloor;
                      }
                  });
              }
              const legacySumData = readLegacySummaryData_ACU(message);
              if (legacySumData) {
                  const summaryData: any = legacySumData;
                  Object.keys(summaryData).forEach(k => {
                      // [新增] 只处理当前模板/指导表中存在的表格
                      if (!templateSheetKeySet.has(k)) {
                          return;
                      }
                      if (k.startsWith('sheet_') && !foundSheets[k] && summaryData[k].name && isSummaryOrOutlineTable_ACU(summaryData[k].name)) {
                          mergedData[k] = JSON.parse(JSON.stringify(summaryData[k]));
                          foundSheets[k] = true;
                          if (!independentTableStates_ACU[k]) independentTableStates_ACU[k] = {};
                          const currentAiFloor = chat.slice(0, i + 1).filter(m => !m.is_user).length;
                          independentTableStates_ACU[k].lastUpdatedAiFloor = currentAiFloor;
                      }
                  });
              }
          }
      }

      // ── 正序叠加 delta 楼层的增量数据到已找到的 base 上 ──
      if (pendingDeltas.length > 0 && Object.keys(foundSheets).length > 0) {
          // pendingDeltas 是逆序收集的，需要反转为正序（从旧到新）
          pendingDeltas.reverse();
          logDebug_ACU(`[表格重建] 正序叠加 ${pendingDeltas.length} 个 delta 楼层到 base 上`);

          for (const { index: deltaIndex, tagData: deltaTagData } of pendingDeltas) {
              const incrementalData = deltaTagData.incrementalData || {};
              for (const [sheetKey, delta] of Object.entries(incrementalData)) {
                  if (!templateSheetKeySet.has(sheetKey)) continue;
                  if (!mergedData[sheetKey]) {
                      logWarn_ACU(`[表格重建] delta 楼层 #${deltaIndex} 引用了 sheetKey=${sheetKey}，但 base 中不存在该表，跳过`);
                      continue;
                  }
                  try {
                      mergedData[sheetKey] = applyTableDelta_ACU(mergedData[sheetKey], delta as any, sheetKey);
                      // 更新 lastUpdatedAiFloor 为 delta 楼层（最新变更来源）
                      if (!independentTableStates_ACU[sheetKey]) {
                          independentTableStates_ACU[sheetKey] = {};
                      }
                      const currentAiFloor = chat.slice(0, deltaIndex + 1).filter((m: any) => !m.is_user).length;
                      independentTableStates_ACU[sheetKey].lastUpdatedAiFloor = currentAiFloor;
                  } catch (e) {
                      logError_ACU(`[表格重建] 应用 delta 失败: sheetKey=${sheetKey}, 楼层=#${deltaIndex}`, e);
                  }
              }
          }
      }


      const foundCount = Object.keys(foundSheets).length;
      logDebug_ACU(`[Merge] Found ${foundCount} tables for tag [${currentIsolationKey || '无标签'}] from chat history.`);

      // 如果没有任何数据：
      // - 若存在"空白指导表"：优先返回"指导表物化结构"（表头+参数；seedRows 仅保留字段，不默认展开到 content）
      // - 否则返回 null，让调用方按旧逻辑处理（例如用完整模板结构作为占位符）
      if (foundCount <= 0) {
          if (hasSheetGuide) {
              // 直接物化：仅表头（seedRows 保留在字段中，但不作为"当前对话真实数据行"展示）
              const base = materializeDataFromSheetGuide_ACU(sheetGuideData, { includeSeedRows: false });
              const orderedKeys = getSortedSheetKeys_ACU(base);
              return migrateContentNullToRowId(reorderDataBySheetKeys_ACU(base, orderedKeys));
          }
          return null;
      }

      // [兼容迁移] 旧版：updateConfig 的 0 表示"沿用UI"；新版：-1 表示"沿用UI"
      // 注意：聊天记录里保存的是"单表对象"，没有 mate 标记，因此用 updateConfig.uiSentinel 作为表级标记。
      Object.keys(mergedData).forEach(k => {
          if (!k.startsWith('sheet_')) return;
          const sheet = mergedData[k];
          const uc = (sheet && typeof sheet === 'object') ? sheet.updateConfig : null;
          if (!uc || typeof uc !== 'object') return;
          if (uc.uiSentinel === -1) return; // 已是新语义
          for (const field of ['contextDepth', 'updateFrequency', 'batchSize', 'skipFloors']) {
              if (Object.prototype.hasOwnProperty.call(uc, field) && uc[field] === 0) {
                  uc[field] = -1;
              }
          }
          uc.uiSentinel = -1;
      });

      // [新增] 若存在"空白指导表"，则：
      // 1) 过滤掉不在指导表里的表（UI/填表只以指导表为准，避免旧表复活）
      // 2) 对指导表中缺失的表：使用指导表结构作为初始值（seedRows 仅保留字段，不默认展开到 content）
      // 3) 对于存在历史数据的表：以历史数据为主，但表名/表头/参数/顺序以指导表为准；不把 seedRows 合并进真实数据行
      if (hasSheetGuide) {
          mergedData = mergeSheetGuideStructureIntoData_ACU(mergedData, sheetGuideData);
      }

      // [修复] 合并结果按"用户手动顺序/模板顺序"重排，避免合并过程导致的随机乱序
      const orderedKeys = getSortedSheetKeys_ACU(mergedData);
      mergedData = reorderDataBySheetKeys_ACU(mergedData, orderedKeys);
      return migrateContentNullToRowId(mergedData);
  }

  export async function mergeAllIndependentTables_ACU() {
      const chat = getChatArray_ACU();
      if (!chat || chat.length === 0) {
          logDebug_ACU('Cannot merge data: Chat history is empty.');
          return null;
      }

      const currentIsolationKey = getCurrentIsolationKey_ACU();
      const strategy = resolveTableStorageStrategy_ACU(chat, currentIsolationKey, {
          enabled: settings_ACU.dataIsolationEnabled,
          code: settings_ACU.dataIsolationCode,
      });

      if (strategy.mode === 'v2') {
          let mergedData = await loadTableStateFromFramesV2_ACU(chat, currentIsolationKey) as Record<string, any> | null;
          const sheetGuideData = getChatSheetGuideDataForIsolationKey_ACU(currentIsolationKey);
          if (mergedData && hasUsableSheetGuide_ACU(sheetGuideData)) {
              mergedData = mergeSheetGuideStructureIntoData_ACU(mergedData, sheetGuideData);
              const orderedKeys = getSortedSheetKeys_ACU(mergedData);
              return migrateContentNullToRowId(reorderDataBySheetKeys_ACU(mergedData, orderedKeys));
          }
          return migrateContentNullToRowId(mergedData);
      }

      if (strategy.mode === 'legacy-v1' && strategy.warning) {
          logWarn_ACU(`[TableStorage] ${strategy.warning}; reason=${strategy.reason}`);
      }

      if (strategy.mode === 'legacy-v1') {
          const mergedLegacyData = await mergeAllIndependentTablesLegacyV1_ACU();
          const migrationResult = await migrateLegacyStorageToV2OnLoad_ACU({
              data: mergedLegacyData,
              isolationKey: currentIsolationKey,
              isolationConfig: {
                  enabled: settings_ACU.dataIsolationEnabled,
                  code: settings_ACU.dataIsolationCode,
              },
              skipUpdateFloors: settings_ACU.skipUpdateFloors,
          });
          if (!migrationResult.migrated) {
              throw new Error(`旧存储迁移到 V2 失败: ${migrationResult.error || '未执行迁移'}`);
          }
          const postStrategy = resolveTableStorageStrategy_ACU(chat, currentIsolationKey, {
              enabled: settings_ACU.dataIsolationEnabled,
              code: settings_ACU.dataIsolationCode,
          });
          if (postStrategy.mode !== 'v2') {
              throw new Error(`旧存储迁移后二次校验失败：当前模式=${postStrategy.mode}${postStrategy.mode === 'legacy-v1' ? `，reason=${postStrategy.reason}` : ''}`);
          }
          return migrateContentNullToRowId(mergedLegacyData);
      }

      return migrateContentNullToRowId(await mergeAllIndependentTablesLegacyV1_ACU());
  }

  // [重构] 刷新合并数据并通知前端和更新世界书

  export function formatJsonToReadable_ACU(jsonData: Record<string, any> | null) {
    if (!jsonData) return { readableText: "数据库为空。", importantPersonsTable: null as any, summaryTable: null as any, outlineTable: null as any };

    let readableText = '';
    let importantPersonsTable = null;
    let summaryTable = null;
    let outlineTable = null;
    // No longer need globalDataTable here as it's part of the main text.

    const tableIndexes = getSortedSheetKeys_ACU(jsonData);
    
    tableIndexes.forEach((sheetKey: string, tableIndex: number) => {
        const table = jsonData[sheetKey];
        if (!table || !table.name || !table.content) return;

        // Extract special tables
        switch (table.name.trim()) {
            case '重要人物表':
                importantPersonsTable = table;
                return; // Skip from main output
            case '总结表':
                summaryTable = table;
                return; // Skip from main output
            case '总体大纲':
                outlineTable = table;
                return; // Skip from main output
        }

        // [新增] 检查是否启用了单独注入（Custom Export），如果启用了，则不包含在基础条目中
        // [新增] 检查是否允许注入世界书 (injectIntoWorldbook)，如果为 false，则不包含在基础条目中
        if (table.exportConfig) {
            if (table.exportConfig.enabled) return; // Skip from main output because it will be exported separately
            if (table.exportConfig.injectIntoWorldbook === false) return; // Skip if injection is disabled
        }
        
        const sqlInjectionTemplate = isSqliteMode() && typeof table.exportConfig?.sqlInjectionTemplate === 'string'
            ? table.exportConfig.sqlInjectionTemplate.trim()
            : '';
        if (sqlInjectionTemplate) {
            readableText += `${sqlInjectionTemplate}\n\n`;
            return;
        }

        // All other tables, including '全局数据表', are added to the readable text
        readableText += `# ${table.name}\n\n`;
        const headers = table.content[0] ? table.content[0].slice(1) : [];
        if (headers.length > 0) {
            readableText += `| ${headers.join(' | ')} |\n`;
            readableText += `|${headers.map(() => '---').join('|')}|\n`;
        }
        
        const rows = table.content.slice(1);
        if (rows.length > 0) {
            rows.forEach((row: any[]) => {
                const rowData = row.slice(1);
                readableText += `| ${rowData.join(' | ')} |\n`;
            });
        }
        readableText += '\n';
    });
    
    return { readableText, importantPersonsTable, summaryTable, outlineTable };
  }

  // =========================
  // [新功能] 新建对话：将模板基础状态写入"楼层本地数据"（而非拼接到消息文本）
  // 目标：像填表一样，开场白楼层就拥有一份"当前模板"的数据库基底（模板有数据就带数据，没有就为空表）
  // 注意：此动作不触发世界书注入链路，只做本地数据写入 + 前端显示刷新
  // =========================
  export const GREETING_LOCAL_BASE_STATE_MARKER_ACU = 'ACU_TEMPLATE_BASE_STATE_LOCAL_V1';

  export function isNewChatGreetingStage_ACU(chat: any[]) {
      if (!Array.isArray(chat) || chat.length === 0) return false;
      const hasAnyUserMessage = chat.some(m => m && m.is_user);
      if (hasAnyUserMessage) return false;
      const firstAiIndex = chat.findIndex(m => m && !m.is_user);
      return firstAiIndex !== -1;
  }

  // [健全性] 你要求的监视点：任何"仅单一AI楼层、没有任何User回复"的聊天记录，都不进行世界书注入
  export function isSingleAiNoUserChat_ACU(chat: any[]) {
      if (!Array.isArray(chat) || chat.length === 0) return false;
      const userCount = chat.filter(m => m && m.is_user).length;
      const aiCount = chat.filter(m => m && !m.is_user).length;
      return userCount === 0 && aiCount === 1;
  }

  function messageHasTableDataForCurrentIsolation_ACU(message: any, isolationKey: string) {
      try {
          if (!message || message.is_user) return false;
          const tagData = readIsolatedTagData_ACU(message, isolationKey);
          if (isV2TagData_ACU(tagData) && (tagData.storageFrame.checkpoint?.kind === 'full' || (tagData.storageFrame.logEntries || []).length > 0)) return true;
          if (tagData?.independentData && Object.keys(tagData.independentData).some(k => k.startsWith('sheet_'))) return true;
          if (isLegacyMatchForIsolation_ACU(message, { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode })) {
              const legacyIndependent = readLegacyIndependentData_ACU(message);
              if (legacyIndependent && Object.keys(legacyIndependent).some(k => k.startsWith('sheet_'))) return true;
              const legacyStandard = readLegacyStandardData_ACU(message);
              if (legacyStandard && Object.keys(legacyStandard).some(k => k.startsWith('sheet_'))) return true;
              const legacySummary = readLegacySummaryData_ACU(message);
              if (legacySummary && Object.keys(legacySummary).some(k => k.startsWith('sheet_'))) return true;
          }
      } catch (_) {}
      return false;
  }

  function shouldCreateInitialSeedCheckpoint_ACU(chat: any[], { allowPendingFirstUserMessage = false } = {}) {
      if (!Array.isArray(chat) || chat.length === 0) return false;
      const userCount = chat.filter(m => m && m.is_user).length;
      if (userCount !== 1 && !(allowPendingFirstUserMessage && userCount === 0)) return false;
      const isolationKey = getCurrentIsolationKey_ACU();
      return !chat.some(message => messageHasTableDataForCurrentIsolation_ACU(message, isolationKey));
  }

  function normalizeInitialCheckpointV2Source_ACU(source: string) {
      if (source === 'game_init' || source === 'import') return 'import';
      return 'system';
  }

  export function shouldSuppressWorldbookInjection_ACU() {
      // 用户要求：取消"首楼填表后不注入书"的限制。
      // 是否创建条目，改由各条目更新逻辑自身基于"真实有效数据"判定，避免一刀切拦截整个链路。
      return false;
  }

  export function maybeLiftWorldbookSuppression_ACU() {
      if (!suppressWorldbookInjectionInGreeting_ACU) return;
      const chat = getChatArray_ACU();
      if (!Array.isArray(chat)) return;
      const hasAnyUserMessage = chat.some(m => m && m.is_user);
      if (hasAnyUserMessage) {
          _set_suppressWorldbookInjectionInGreeting_ACU(false);
          logDebug_ACU('[Worldbook] Greeting-stage suppression lifted (user message detected).');
      }
  }

  export function buildTemplateBaseStateDataForLocalStorage_ACU(templateObj: Record<string, any> | null) {
      if (!templateObj || typeof templateObj !== 'object') return null;
      const out: Record<string, any> = { mate: { type: 'chatSheets', version: 1 } };
      const sheetKeys = Object.keys(templateObj).filter(k => k.startsWith('sheet_'));
      if (sheetKeys.length === 0) return null;
      sheetKeys.forEach(k => {
          out[k] = JSON.parse(JSON.stringify(templateObj[k]));
      });
      return out;
  }

  async function writeInitialTemplateCheckpoint_ACU(templateObj: Record<string, any>, {
      reason = 'initial_seed_checkpoint',
      presetName = '',
      source = '',
      registerPreset = false,
      force = false,
      cleanupWorldbook = true,
  } = {}) {
      const chat = getChatArray_ACU();
      if (!chat || !Array.isArray(chat) || chat.length === 0) {
          logWarn_ACU('[InitialCheckpoint] 聊天记录为空，无法写入初始化数据');
          return false;
      }

      const isolationKey = getCurrentIsolationKey_ACU();
      const preStrategy = resolveTableStorageStrategy_ACU(chat, isolationKey, {
          enabled: settings_ACU.dataIsolationEnabled,
          code: settings_ACU.dataIsolationCode,
      });
      if (preStrategy.mode === 'legacy-v1') {
          logWarn_ACU(`[InitialCheckpoint] 检测到旧存储，禁止写入 init checkpoint，等待迁移流程处理。reason=${preStrategy.reason}`);
          return false;
      }

      const firstAiIndex = chat.findIndex(m => m && !m.is_user);
      if (firstAiIndex === -1) {
          logWarn_ACU('[InitialCheckpoint] 找不到第一楼AI消息');
          return false;
      }
      const firstMsg = chat[firstAiIndex];
      if (!force && firstMsg._acu_local_template_base_state_seeded === GREETING_LOCAL_BASE_STATE_MARKER_ACU) return false;

      const sheetKeys = Object.keys(templateObj || {}).filter(k => k.startsWith('sheet_'));
      if (sheetKeys.length === 0) {
          logWarn_ACU('[InitialCheckpoint] 模板中没有表格数据');
          return false;
      }
      ensureSheetOrderNumbers_ACU(templateObj, { baseOrderKeys: sheetKeys, forceRebuild: false });

      const templateSnapshot = sanitizeTemplateSnapshotForChat_ACU(templateObj);
      const normalizedPresetName = deriveTemplatePresetNameForImport_ACU({ presetName });
      const normalizedSource = source || reason;
      if (registerPreset && normalizedPresetName && templateSnapshot?.templateStr) {
          try {
              const savePresetOk = upsertTemplatePreset_ACU(normalizedPresetName, templateSnapshot.templateStr);
              if (!savePresetOk) {
                  logWarn_ACU(`[TemplateScope] 保存模板预设失败：${normalizedPresetName}`);
              }
          } catch (e) {
              logWarn_ACU('[TemplateScope] 保存模板预设失败:', e);
          }
      }

      const baseData = buildTemplateBaseStateDataForLocalStorage_ACU(templateObj);
      if (!baseData) return false;

      const guideData = buildChatSheetGuideDataFromTemplateObj_ACU(templateObj, { stripSeedRows: false });
      if (guideData) {
          const guideUpdated = setChatSheetGuideDataForIsolationKey_ACU(isolationKey, guideData, {
              reason,
              syncTemplateScope: true,
              templateSource: templateSnapshot?.templateStr || templateObj,
              presetName: normalizedPresetName,
              source: normalizedSource,
          });
          if (!guideUpdated) {
              logWarn_ACU('[InitialCheckpoint] 初始化模板 scope 同步失败，已中止 checkpoint 写入。');
              return false;
          }
          applyTemplateScopeForCurrentChat_ACU();
      }

      const strategy = resolveTableStorageStrategy_ACU(chat, isolationKey, {
          enabled: settings_ACU.dataIsolationEnabled,
          code: settings_ACU.dataIsolationCode,
      });

      if (strategy.mode === 'legacy-v1') {
          const tagData = initIsolatedTagSlot_ACU(firstMsg, isolationKey);
          const indep: Record<string, any> = {};
          Object.keys(baseData).forEach(k => {
              if (!k.startsWith('sheet_')) return;
              indep[k] = JSON.parse(JSON.stringify(baseData[k]));
          });
          tagData.independentData = indep;
          tagData.modifiedKeys = [];
          tagData.updateGroupKeys = [];
          tagData._acu_base_state = GREETING_LOCAL_BASE_STATE_MARKER_ACU;
          tagData._acu_storage_mode = 'checkpoint';
          tagData._acu_storage_version = 1;
          writeLegacyCompatData_ACU(firstMsg, JSON.parse(JSON.stringify(indep)), [], [], { legacyConfirmed: true });
          await saveChatToHost_ACU();
      } else {
          const saveResult = await runTableWriteTransaction_ACU({
              source: normalizeInitialCheckpointV2Source_ACU(normalizedSource),
              reason: 'initial_checkpoint_v2',
              isolationKey,
              writeSet: [{ kind: 'all' }],
              initialData: baseData as any,
          }, async (transactionContext) => persistTableMutationLogV2_ACU({
              targetMessageIndex: firstAiIndex,
              source: normalizeInitialCheckpointV2Source_ACU(normalizedSource),
              afterData: baseData as any,
              filledSheetKeys: [],
              candidateChangedSheetKeys: [],
              groupKeys: [],
              forceCheckpoint: true,
              checkpointReason: 'init',
              isolationKey,
              transactionContext,
          }));
          if (!saveResult.saved) {
              logWarn_ACU(`[InitialCheckpoint] V2 checkpoint 写入失败：${saveResult.error || 'unknown error'}`);
              return false;
          }
      }

      firstMsg._acu_local_template_base_state_seeded = GREETING_LOCAL_BASE_STATE_MARKER_ACU;
      _set_suppressWorldbookInjectionInGreeting_ACU(false);

      if (cleanupWorldbook) {
          try {
              await deleteAllGeneratedEntries_ACU();
              logDebug_ACU(`[InitialCheckpoint] Deleted generated entries before first real reply. reason=${reason}`);
          } catch (e) {
              logWarn_ACU('[InitialCheckpoint] Cleanup before first real reply failed:', e);
          }
      }

      _set_currentJsonTableData_ACU(reorderDataBySheetKeys_ACU(JSON.parse(JSON.stringify(baseData)), getSortedSheetKeys_ACU(baseData)));
      logDebug_ACU(`[InitialCheckpoint] 初始化 checkpoint 已写入。reason=${reason}, messageIndex=${firstAiIndex}, sheetCount=${sheetKeys.length}`);
      return { success: true, messageIndex: firstAiIndex, sheetCount: sheetKeys.length };
  }

  export async function ensureInitialSeedCheckpoint_ACU({ reason = 'initial_seed_checkpoint', allowPendingFirstUserMessage = false } = {}) {
      try {
          const chat = getChatArray_ACU();
          if (!shouldCreateInitialSeedCheckpoint_ACU(chat, { allowPendingFirstUserMessage })) return false;

          const templateObj = parseTableTemplateJson_ACU({ stripSeedRows: false });
          if (!templateObj) return false;

          const result = await writeInitialTemplateCheckpoint_ACU(templateObj, {
              reason,
              source: reason,
              registerPreset: false,
              force: false,
              cleanupWorldbook: true,
          });
          if (result && typeof result === 'object' && result.success) {
              return { success: true, messageIndex: result.messageIndex };
          }
          return result;
      } catch (e) {
          logWarn_ACU('[InitialSeed] Failed to persist initial seed checkpoint:', e);
          return { success: false };
      }
  }

  export async function seedGreetingLocalDataFromTemplate_ACU() {
      return ensureInitialSeedCheckpoint_ACU({ reason: 'legacy_seed_greeting_alias' });
  }

  // 用于 initGameSession 场景；与发送前初始化共用同一条 checkpoint 写入链路。
  export async function fillFirstLayerWithTemplateData_ACU(templateObj: Record<string, any>, { reason = 'game_init', presetName = '', source = 'game_init', registerPreset = true } = {}) {
      try {
          return await writeInitialTemplateCheckpoint_ACU(templateObj, {
              reason,
              presetName,
              source,
              registerPreset,
              force: true,
              cleanupWorldbook: true,
          });
      } catch (e) {
          logError_ACU('[FillFirstLayer] 填充第一楼数据失败:', e);
          return { success: false };
      }
  }

  export function parseReadableToJson_ACU(text: string) {
    if (!currentJsonTableData_ACU) {
        logError_ACU("Parsing failed: currentJsonTableData_ACU is not available.");
        return null;
    }

    try {
        // Create a deep clone to safely modify, preserving original metadata.
        const newJsonData = JSON.parse(JSON.stringify(currentJsonTableData_ACU)); 
        const tablesText = text.trim().split('# ').slice(1);

        const parsedSheetContents: Record<string, any[][]> = {};

        for (const tableText of tablesText) {
            const lines = tableText.trim().split('\n');
            const tableName = lines[0].trim();
            
            const sheetKey = getSortedSheetKeys_ACU(newJsonData).find(k => newJsonData[k].name === tableName);
            if (!sheetKey) {
                logWarn_ACU(`Table "${tableName}" from text not found in current JSON structure. Skipping.`);
                continue;
            }

            const originalSheet = newJsonData[sheetKey];
            const originalHeaderRow = originalSheet.content[0];
            const newContent = [originalHeaderRow]; // Start with the original header row.
            const reservedRowIds = createStableRowIdReservation_ACU(originalSheet.content.slice(1));

            // Find all valid markdown table row lines, skipping the format line.
            const dataLines = lines.filter(line => line.trim().startsWith('|') && !line.includes('---'));

            // The first markdown row is the header text, which we ignore since we use the original header.
            for (let i = 1; i < dataLines.length; i++) {
                const line = dataLines[i];
                // Split by '|', remove the first and last empty elements, and trim whitespace.
                const columns = line.split('|').slice(1, -1).map(c => c.trim());
                
                const newRow = [allocateStableRowId_ACU(reservedRowIds), ...columns];
                
                // Pad or truncate the row to match the header's column count for consistency.
                if (newRow.length < originalHeaderRow.length) {
                     while(newRow.length < originalHeaderRow.length) newRow.push('');
                } else if (newRow.length > originalHeaderRow.length) {
                    newRow.splice(originalHeaderRow.length);
                }
                newContent.push(newRow);
            }
            parsedSheetContents[sheetKey] = newContent;
        }

        // Update the cloned JSON object only with sheets that were successfully parsed.
        for (const sheetKey in parsedSheetContents) {
            newJsonData[sheetKey].content = parsedSheetContents[sheetKey];
        }

        return newJsonData;

    } catch (error) {
        logError_ACU("Error parsing readable text back to JSON:", error);
        return null;
    }
  }

  export function getEffectiveAutoUpdateThreshold_ACU(calledFrom = 'system') {
    let threshold = Number(settings_ACU.autoUpdateThreshold); // Start with the in-memory setting, ensure number
    if (isNaN(threshold)) threshold = 3; // Default fallback

    // 移除：不再从 UI 输入框实时获取值
    // 原因：UI 可能处于隐藏状态或者未初始化完成，导致获取到的值为空或过时
    // 我们应完全信任 settings_ACU 中的值，因为 UI 修改后会同步到 settings_ACU
    /*
    if (
      $autoUpdateThresholdInput_ACU &&
      $autoUpdateThresholdInput_ACU.length > 0 &&
      $autoUpdateThresholdInput_ACU.is(':visible')
    ) {
      const uiThresholdVal = $autoUpdateThresholdInput_ACU.val();
      if (uiThresholdVal) {
        const parsedUiInput = parseInt(uiThresholdVal, 10);
        if (!isNaN(parsedUiInput) && parsedUiInput >= 1) {
          threshold = parsedUiInput;
        } 
        // ...
      }
    }
    */
    
    // logDebug_ACU(`getEffectiveAutoUpdateThreshold_ACU (calledFrom: ${calledFrom}): final threshold = ${threshold}`);
    return threshold;
  }


  // --- [剧情推进] 核心函数 ---

  /**
   * 剧情推进统一的API调用函数
   */

  /**
   * 将表格JSON数据转换为更适合LLM读取的文本格式。
   * @param {object} jsonData - 表格数据对象（例如本插件的 currentJsonTableData_ACU）。
   * @returns {string} - 格式化后的文本字符串。
   */
