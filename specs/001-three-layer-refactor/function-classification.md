# 函数分类表：`src/core/04_shared_helpers.js`（8459 行）

> 生成日期：2026-04-12
> 分类标准：🟢纯工具 / 🟡数据操作 / 🔴业务逻辑 / 🔵DOM操作
> 同时记录函数间调用依赖（满足 spec 边界情况 3）

---

## 统计摘要

| 分类 | 函数数 | 占比 |
|------|--------|------|
| 🟢纯工具 | ~45 | ~25% |
| 🟡数据操作 | ~40 | ~22% |
| 🔴业务逻辑 | ~75 | ~42% |
| 🔵DOM操作 | ~20 | ~11% |

---

## 第一部分：第 1~4200 行

| 函数名 | 行号 | 分类 | 依赖全局变量 | 调用的其他函数 |
|--------|------|------|-------------|---------------|
| `cleanChatName_ACU` | 1~9 | 🟢纯工具 | — | — |
| `deepMerge_ACU` | 12~28 | 🟢纯工具 | — | `deepMerge_ACU`(递归) |
| `stripSeedRowsFromTemplate_ACU` | 32~43 | 🟢纯工具 | — | — |
| `parseTableTemplateJson_ACU` | 45~169 | 🟡数据操作 | `TABLE_TEMPLATE_ACU` | `logDebug_ACU`, `logError_ACU`, `safeJsonParse_ACU`, `stripSeedRowsFromTemplate_ACU` |
| (内部) `escapeStringForJson_ACU` | 62~71 | 🟢纯工具 | — | — |
| `applySheetOrderNumbers_ACU` | 172~185 | 🟡数据操作 | `TABLE_ORDER_FIELD_ACU` | — |
| `ensureSheetOrderNumbers_ACU` | 188~208 | 🟡数据操作 | `TABLE_ORDER_FIELD_ACU` | `applySheetOrderNumbers_ACU` |
| `getTemplateSheetKeys_ACU` | 211~263 | 🔴业务逻辑 | `TABLE_TEMPLATE_ACU`, `TABLE_ORDER_FIELD_ACU` | `parseTableTemplateJson_ACU`, `ensureSheetOrderNumbers_ACU`, `getCurrentChatTemplateScopeState_ACU`, `migrateLegacyTemplateScopeForCurrentChat_ACU`, `buildChatSheetGuideDataFromTemplateObj_ACU`, `buildChatTemplateScopeStateFromCurrent_ACU`, `setCurrentChatTemplateScopeState_ACU`, `saveCurrentProfileTemplate_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `getChatFirstLayerMessage_ACU` | 284~287 | 🟢纯工具 | — | — |
| `cloneScopedConfigData_ACU` | 289~296 | 🟢纯工具 | — | — |
| `getChatScopedConfigContainer_ACU` | 298~305 | 🟡数据操作 | `CHAT_SCOPED_CONFIG_FIELD_ACU` | `getChatFirstLayerMessage_ACU`, `safeJsonParse_ACU` |
| `normalizeChatScopedConfigContainer_ACU` | 307~314 | 🟢纯工具 | `CHAT_SCOPED_CONFIG_VERSION_ACU` | `cloneScopedConfigData_ACU` |
| `normalizePlotScopeMode_ACU` | 316~318 | 🟢纯工具 | — | — |
| `normalizeChatScopedConfigSource_ACU` | 320~324 | 🟢纯工具 | — | — |
| `sanitizePlotSettingsSnapshotForChat_ACU` | 326~341 | 🟡数据操作 | — | `cloneScopedConfigData_ACU`, `ensurePlotPromptsArray_ACU`, `ensureLoopPromptsArray_ACU`, `ensurePlotTasksCompat_ACU`, `getPlotFinalDirectiveFromSource_ACU`, `setPlotPromptContentByIdForSettings_ACU` |
| `normalizeChatPlotScopeState_ACU` | 343~355 | 🟢纯工具 | — | `normalizePlotScopeMode_ACU`, `normalizePlotPresetSelectionValue_ACU`, `sanitizePlotSettingsSnapshotForChat_ACU`, `normalizeChatScopedConfigSource_ACU` |
| `getCurrentChatPlotScopeState_ACU` | 357~367 | 🟡数据操作 | `SillyTavern_API_ACU` | `getChatScopedConfigContainer_ACU`, `normalizeChatPlotScopeState_ACU` |
| `buildChatPlotScopeStateFromSettings_ACU` | 369~382 | 🟢纯工具 | — | `sanitizePlotSettingsSnapshotForChat_ACU`, `normalizeChatPlotScopeState_ACU` |
| `setCurrentChatPlotScopeState_ACU` | 384~409 | 🟡数据操作 | `SillyTavern_API_ACU`, `CHAT_SCOPED_CONFIG_FIELD_ACU` | `getChatFirstLayerMessage_ACU`, `normalizeChatScopedConfigContainer_ACU`, `getChatScopedConfigContainer_ACU`, `normalizeChatPlotScopeState_ACU`, `getCurrentChatPlotScopeState_ACU` |
| `clearCurrentChatPlotScopeState_ACU` | 411~413 | 🟡数据操作 | — | `setCurrentChatPlotScopeState_ACU` |
| `normalizeTemplateScopeMode_ACU` | 415~419 | 🟢纯工具 | — | — |
| `normalizeTemplateScopeIsolationKey_ACU` | 421~423 | 🟢纯工具 | — | `getCurrentIsolationKey_ACU` |
| `sanitizeTemplateSnapshotForChat_ACU` | 425~448 | 🟡数据操作 | — | `safeJsonParse_ACU`, `cloneScopedConfigData_ACU`, `ensureSheetOrderNumbers_ACU`, `sanitizeChatSheetsObject_ACU`, `safeJsonStringify_ACU` |
| `normalizeChatTemplateScopeState_ACU` | 450~465 | 🟢纯工具 | — | `normalizeTemplateScopeMode_ACU`, `normalizeTemplateScopeIsolationKey_ACU`, `normalizeTemplatePresetSelectionValue_ACU`, `sanitizeTemplateSnapshotForChat_ACU`, `normalizeGuideData_ACU`, `normalizeChatScopedConfigSource_ACU`, `getCurrentIsolationKey_ACU` |
| `buildChatTemplatePresetSlotKey_ACU` | 467~469 | 🟢纯工具 | `DEFAULT_TEMPLATE_PRESET_OPTION_VALUE_ACU` | `normalizeTemplatePresetSelectionValue_ACU` |
| `listChatTemplatePresetEntries_ACU` | 471~488 | 🟡数据操作 | `SillyTavern_API_ACU` | `normalizeTemplateScopeIsolationKey_ACU`, `getChatTemplateArchiveEntries_ACU`, `buildChatTemplatePresetSlotKey_ACU` |
| `findChatTemplatePresetEntry_ACU` | 490~493 | 🟡数据操作 | — | `buildChatTemplatePresetSlotKey_ACU`, `listChatTemplatePresetEntries_ACU` |
| `upsertChatTemplatePresetEntry_ACU` | 495~513 | 🟡数据操作 | — | `normalizeChatTemplateScopeState_ACU`, `buildChatTemplatePresetSlotKey_ACU`, `getChatTemplateArchiveEntries_ACU`, `setChatTemplateArchiveEntries_ACU`, `findChatTemplatePresetEntry_ACU` |
| `ensureCurrentChatTemplatePresetEntry_ACU` | 515~528 | 🔴业务逻辑 | — | `getCurrentChatTemplateScopeState_ACU`, `migrateLegacyTemplateScopeForCurrentChat_ACU`, `normalizeChatTemplateScopeState_ACU`, `findChatTemplatePresetEntry_ACU`, `buildChatTemplateArchiveFingerprint_ACU`, `upsertChatTemplatePresetEntry_ACU` |
| `buildChatTemplatePresetLinkState_ACU` | 530~541 | 🟢纯工具 | — | `normalizeTemplateScopeIsolationKey_ACU`, `normalizeChatTemplateScopeState_ACU` |
| `activateChatTemplatePresetSelection_ACU` | 543~600 | 🔴业务逻辑 | `$popupInstance_ACU`, `SillyTavern_API_ACU` | `normalizeTemplateScopeIsolationKey_ACU`, `getCurrentIsolationKey_ACU`, `normalizeTemplatePresetSelectionValue_ACU`, `findChatTemplatePresetEntry_ACU`, `getTemplatePreset_ACU`, `ensureCurrentChatTemplatePresetEntry_ACU`, `persistTemplateScopeSelectionState_ACU`, `buildChatTemplatePresetLinkState_ACU`, `setCurrentChatTemplateScopeState_ACU`, `clearChatSheetGuideDataForIsolationKey_ACU`, `applyTemplateScopeForCurrentChat_ACU`, `loadTemplatePresetSelect_ACU`, `refreshMergedDataAndNotify_ACU`, `logWarn_ACU` |
| `buildChatTemplateArchiveFingerprint_ACU` | 602~612 | 🟢纯工具 | — | `normalizeChatTemplateScopeState_ACU`, `safeJsonStringify_ACU`, `normalizeGuideData_ACU`, `hashUserInput_ACU` |
| `getChatTemplateArchiveBaseLabel_ACU` | 614~621 | 🟢纯工具 | — | `normalizeChatTemplateScopeState_ACU`, `normalizeTemplatePresetSelectionValue_ACU`, `getTemplatePresetDisplayName_ACU` |
| `normalizeChatTemplateArchiveEntry_ACU` | 623~641 | 🟢纯工具 | — | `normalizeChatTemplateScopeState_ACU`, `buildChatTemplateArchiveFingerprint_ACU` |
| `getChatTemplateArchiveEntries_ACU` | 643~653 | 🟡数据操作 | `SillyTavern_API_ACU` | `getChatScopedConfigContainer_ACU`, `normalizeTemplateScopeIsolationKey_ACU`, `normalizeChatTemplateArchiveEntry_ACU` |
| `setChatTemplateArchiveEntries_ACU` | 655~684 | 🟡数据操作 | `CHAT_SCOPED_CONFIG_FIELD_ACU` | `getChatFirstLayerMessage_ACU`, `normalizeTemplateScopeIsolationKey_ACU`, `normalizeChatScopedConfigContainer_ACU`, `getChatScopedConfigContainer_ACU`, `normalizeChatTemplateArchiveEntry_ACU`, `getChatTemplateArchiveEntries_ACU` |
| `archiveCurrentChatTemplateScopeState_ACU` | 686~716 | 🔴业务逻辑 | — | `normalizeTemplateScopeIsolationKey_ACU`, `getCurrentChatTemplateScopeState_ACU`, `migrateLegacyTemplateScopeForCurrentChat_ACU`, `normalizeChatTemplateScopeState_ACU`, `buildChatTemplateArchiveFingerprint_ACU`, `getChatTemplateArchiveEntries_ACU`, `setChatTemplateArchiveEntries_ACU` |
| `buildChatTemplateArchiveOptionValue_ACU` | 718~721 | 🟢纯工具 | `CHAT_TEMPLATE_ARCHIVE_OPTION_PREFIX_ACU` | — |
| `isChatTemplateArchiveOptionValue_ACU` | 723~725 | 🟢纯工具 | `CHAT_TEMPLATE_ARCHIVE_OPTION_PREFIX_ACU` | — |
| `parseChatTemplateArchiveOptionValue_ACU` | 727~731 | 🟢纯工具 | `CHAT_TEMPLATE_ARCHIVE_OPTION_PREFIX_ACU` | `isChatTemplateArchiveOptionValue_ACU` |
| `getChatTemplateArchiveOptionLabel_ACU` | 733~741 | 🟢纯工具 | — | `normalizeChatTemplateArchiveEntry_ACU`, `getChatTemplateArchiveBaseLabel_ACU`, `formatPlotScopeUpdatedAt_ACU` |
| `restoreChatTemplateArchiveEntry_ACU` | 743~771 | 🔴业务逻辑 | `$popupInstance_ACU` | `normalizeTemplateScopeIsolationKey_ACU`, `getChatTemplateArchiveEntries_ACU`, `persistTemplateScopeSelectionState_ACU`, `applyTemplateScopeForCurrentChat_ACU`, `loadTemplatePresetSelect_ACU`, `refreshMergedDataAndNotify_ACU` |
| `getCurrentChatTemplateScopeState_ACU` | 773~790 | 🟡数据操作 | `SillyTavern_API_ACU` | `getChatScopedConfigContainer_ACU`, `normalizeTemplateScopeIsolationKey_ACU`, `normalizeChatTemplateScopeState_ACU` |
| `buildChatTemplateScopeStateFromCurrent_ACU` | 792~809 | 🟡数据操作 | `TABLE_TEMPLATE_ACU` | `normalizeTemplateScopeIsolationKey_ACU`, `sanitizeTemplateSnapshotForChat_ACU`, `normalizeGuideData_ACU`, `getChatSheetGuideDataForIsolationKey_ACU`, `normalizeChatTemplateScopeState_ACU` |
| `setCurrentChatTemplateScopeState_ACU` | 811~851 | 🟡数据操作 | `SillyTavern_API_ACU`, `CHAT_SCOPED_CONFIG_FIELD_ACU` | `getChatFirstLayerMessage_ACU`, `normalizeTemplateScopeIsolationKey_ACU`, `normalizeChatScopedConfigContainer_ACU`, `getChatScopedConfigContainer_ACU`, `normalizeChatTemplateScopeState_ACU`, `getCurrentChatTemplateScopeState_ACU` |
| `clearCurrentChatTemplateScopeState_ACU` | 853~870 | 🔴业务逻辑 | — | `normalizeTemplateScopeIsolationKey_ACU`, `archiveCurrentChatTemplateScopeState_ACU`, `setCurrentChatTemplateScopeState_ACU`, `clearChatSheetGuideDataForIsolationKey_ACU` |
| `getGlobalTemplateSnapshotForCurrentProfile_ACU` | 872~892 | 🟡数据操作 | `TABLE_TEMPLATE_ACU`, `DEFAULT_TABLE_TEMPLATE_ACU`, `settings_ACU` | `normalizeIsolationCode_ACU`, `readProfileTemplateFromStorage_ACU`, `sanitizeTemplateSnapshotForChat_ACU`, `parseTableTemplateJson_ACU` |
| `applyTemplateScopeForCurrentChat_ACU` | 894~940 | 🔴业务逻辑 | `TABLE_TEMPLATE_ACU` | `normalizeTemplateScopeIsolationKey_ACU`, `migrateLegacyTemplateScopeForCurrentChat_ACU`, `getCurrentChatTemplateScopeState_ACU`, `normalizeTemplatePresetSelectionValue_ACU`, `sanitizeTemplateSnapshotForChat_ACU`, `getTemplatePreset_ACU`, `getDefaultTemplateSnapshot_ACU`, `getGlobalTemplateSnapshotForCurrentProfile_ACU`, `getCurrentTemplatePresetName_ACU`, `logDebug_ACU` |
| `getChatSheetGuideContainer_ACU` | 942~949 | 🟡数据操作 | `CHAT_SHEET_GUIDE_FIELD_ACU` | `getChatFirstLayerMessage_ACU`, `safeJsonParse_ACU` |
| `normalizeGuideData_ACU` | 953~990 | 🟡数据操作 | `CHAT_SHEET_GUIDE_VERSION_ACU`, `TABLE_ORDER_FIELD_ACU` | `ensureExportConfigDefaults_ACU` |
| `materializeDataFromSheetGuide_ACU` | 992~1010 | 🟢纯工具 | — | `normalizeGuideData_ACU` |
| `getLegacyHeaderGuideDataForIsolationKey_ACU` | 1012~1047 | 🟡数据操作 | `SillyTavern_API_ACU`, `LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU` | `getChatFirstLayerMessage_ACU`, `safeJsonParse_ACU`, `parseTableTemplateJson_ACU`, `normalizeGuideData_ACU` |
| `getHistoricalTemplateGuideDataForIsolationKey_ACU` | 1049~1115 | 🔴业务逻辑 | `settings_ACU`, `TABLE_ORDER_FIELD_ACU` | `normalizeTemplateScopeIsolationKey_ACU`, `safeJsonParse_ACU`, `isSummaryOrOutlineTable_ACU`, `applySheetOrderNumbers_ACU`, `buildChatSheetGuideDataFromData_ACU` |
| `getLegacyTemplateSnapshotLabel_ACU` | 1117~1121 | 🟢纯工具 | — | — |
| `buildChatTemplateScopeStateFromGuideData_ACU` | 1123~1137 | 🟡数据操作 | — | `normalizeGuideData_ACU`, `materializeDataFromSheetGuide_ACU`, `buildChatTemplateScopeStateFromCurrent_ACU` |
| `migrateLegacyTemplateScopeForCurrentChat_ACU` | 1139~1192 | 🔴业务逻辑 | `SillyTavern_API_ACU` | `normalizeTemplateScopeIsolationKey_ACU`, `getCurrentChatTemplateScopeState_ACU`, `getChatSheetGuideContainer_ACU`, `normalizeTemplateScopeMode_ACU`, `normalizeGuideData_ACU`, `buildChatTemplateScopeStateFromGuideData_ACU`, `setCurrentChatTemplateScopeState_ACU`, `getHistoricalTemplateGuideDataForIsolationKey_ACU`, `getLegacyHeaderGuideDataForIsolationKey_ACU`, `getLegacyTemplateSnapshotLabel_ACU` |
| `clearChatSheetGuideDataForIsolationKey_ACU` | 1194~1215 | 🟡数据操作 | `SillyTavern_API_ACU`, `CHAT_SHEET_GUIDE_FIELD_ACU`, `CHAT_SHEET_GUIDE_VERSION_ACU` | `getChatFirstLayerMessage_ACU`, `getChatSheetGuideContainer_ACU`, `cloneScopedConfigData_ACU` |
| `getChatSheetGuideDataForIsolationKey_ACU` | 1217~1263 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `TABLE_TEMPLATE_ACU` | `getCurrentChatTemplateScopeState_ACU`, `migrateLegacyTemplateScopeForCurrentChat_ACU`, `normalizeGuideData_ACU`, `sanitizeTemplateSnapshotForChat_ACU`, `buildChatSheetGuideDataFromTemplateObj_ACU`, `normalizeTemplatePresetSelectionValue_ACU`, `getTemplatePreset_ACU`, `getDefaultTemplateSnapshot_ACU`, `getGlobalTemplateSnapshotForCurrentProfile_ACU` |
| `setChatSheetGuideDataForIsolationKey_ACU` | 1265~1323 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `CHAT_SHEET_GUIDE_FIELD_ACU`, `CHAT_SHEET_GUIDE_VERSION_ACU` | `getChatFirstLayerMessage_ACU`, `normalizeGuideData_ACU`, `getCurrentChatTemplateScopeState_ACU`, `normalizeTemplateScopeMode_ACU`, `getChatSheetGuideContainer_ACU`, `buildChatTemplateScopeStateFromCurrent_ACU`, `normalizeChatScopedConfigSource_ACU`, `normalizeTemplatePresetSelectionValue_ACU`, `getCurrentTemplatePresetName_ACU`, `setCurrentChatTemplateScopeState_ACU`, `upsertChatTemplatePresetEntry_ACU` |
| `getTemplateObjForSeedRows_ACU` | 1335~1345 | 🟡数据操作 | `_seedRowsTemplateCacheStr_ACU`, `_seedRowsTemplateCacheObj_ACU`, `TABLE_TEMPLATE_ACU` | `parseTableTemplateJson_ACU` |
| `ensureChatSheetGuideSeeded_ACU` | 1347~1373 | 🔴业务逻辑 | `SillyTavern_API_ACU` | `getCurrentIsolationKey_ACU`, `getChatSheetGuideDataForIsolationKey_ACU`, `getTemplateObjForSeedRows_ACU`, `buildChatSheetGuideDataFromTemplateObj_ACU`, `setChatSheetGuideDataForIsolationKey_ACU`, `logDebug_ACU` |
| `pickAnyGuideSeedRowsSlot_ACU` | 1375~1412 | 🟡数据操作 | `SillyTavern_API_ACU` | `getChatScopedConfigContainer_ACU`, `normalizeChatTemplateScopeState_ACU`, `normalizeGuideData_ACU`, `getChatSheetGuideContainer_ACU` |
| `getEffectiveSeedRowsForSheet_ACU` | 1414~1438 | 🔴业务逻辑 | `currentJsonTableData_ACU` | `getCurrentIsolationKey_ACU`, `getChatSheetGuideDataForIsolationKey_ACU`, `pickAnyGuideSeedRowsSlot_ACU`, `getTemplateObjForSeedRows_ACU` |
| `attachSeedRowsToCurrentDataFromGuide_ACU` | 1440~1462 | 🟡数据操作 | `currentJsonTableData_ACU` | `normalizeGuideData_ACU` |
| `buildChatSheetGuideDataFromData_ACU` | 1465~1505 | 🟡数据操作 | `CHAT_SHEET_GUIDE_VERSION_ACU`, `TABLE_ORDER_FIELD_ACU` | `getSortedSheetKeys_ACU`, `ensureExportConfigDefaults_ACU`, `ensureGlobalInjectionConfigDefaults_ACU`, `normalizeGuideData_ACU` |
| `buildChatSheetGuideDataFromTemplateObj_ACU` | 1508~1539 | 🟡数据操作 | `CHAT_SHEET_GUIDE_VERSION_ACU`, `TABLE_ORDER_FIELD_ACU` | `ensureSheetOrderNumbers_ACU`, `ensureGlobalInjectionConfigDefaults_ACU`, `normalizeGuideData_ACU` |
| `overwriteChatSheetGuideFromTemplate_ACU` | 1542~1572 | 🔴业务逻辑 | `SillyTavern_API_ACU` | `buildChatSheetGuideDataFromTemplateObj_ACU`, `getCurrentIsolationKey_ACU`, `sanitizeTemplateSnapshotForChat_ACU`, `deriveTemplatePresetNameForImport_ACU`, `upsertTemplatePreset_ACU`, `setChatSheetGuideDataForIsolationKey_ACU`, `applyTemplateScopeForCurrentChat_ACU`, `refreshMergedDataAndNotify_ACU`, `logWarn_ACU` |
| `getSortedSheetKeys_ACU` | 1577~1636 | 🔴业务逻辑 | `TABLE_ORDER_FIELD_ACU` | `getCurrentIsolationKey_ACU`, `getChatSheetGuideDataForIsolationKey_ACU`, `parseTableTemplateJson_ACU`, `ensureSheetOrderNumbers_ACU` |
| `buildGuidedBaseDataFromSheetGuide_ACU` | 1639~1643 | 🟢纯工具 | — | `normalizeGuideData_ACU` |
| `reorderDataBySheetKeys_ACU` | 1646~1659 | 🟢纯工具 | — | `getSortedSheetKeys_ACU` |
| `sanitizeSheetForStorage_ACU` | 1678~1690 | 🟢纯工具 | `SHEET_KEEP_KEYS_ACU` | `ensureExportConfigDefaults_ACU` |
| `sanitizeChatSheetsObject_ACU` | 1692~1711 | 🟢纯工具 | — | `sanitizeSheetForStorage_ACU` |
| `lightenDarkenColor_ACU` | 1713~1730 | 🟢纯工具 | — | — |
| `getContrastYIQ_ACU` | 1731~1738 | 🟢纯工具 | — | — |
| `extractContextTags_ACU` | 1742~1766 | 🟢纯工具 | — | `extractTagsFromLine` |
| `extractTagsFromLine` | 1769~1789 | 🟢纯工具 | — | `extractLastTagContent` |
| `extractLastTagContent` | 1792~1807 | 🟢纯工具 | — | — |
| `parseTagList_ACU` | 1810~1817 | 🟢纯工具 | — | — |
| `buildBoundaryRulesFromLegacyTags_ACU` | 1820~1823 | 🟢纯工具 | — | `parseTagList_ACU` |
| `normalizeExcludeRules_ACU` | 1826~1864 | 🟢纯工具 | — | `buildBoundaryRulesFromLegacyTags_ACU` |
| `normalizeExtractRules_ACU` | 1867~1869 | 🟢纯工具 | — | `normalizeExcludeRules_ACU` |
| `getDefaultPlotContextExtractRules_ACU` | 1871~1876 | 🟡数据操作 | `DEFAULT_PLOT_SETTINGS_ACU` | `normalizeExtractRules_ACU` |
| `getDefaultPlotContextExcludeRules_ACU` | 1878~1883 | 🟡数据操作 | `DEFAULT_PLOT_SETTINGS_ACU` | `normalizeExcludeRules_ACU` |
| `removeLastMatchedBoundary_ACU` | 1886~1906 | 🟢纯工具 | — | — |
| `applyExcludeRulesToText_ACU` | 1909~1919 | 🟢纯工具 | — | `normalizeExcludeRules_ACU`, `removeLastMatchedBoundary_ACU` |
| `extractLastMatchedBoundary_ACU` | 1922~1940 | 🟢纯工具 | — | — |
| `applyExtractRulesToText_ACU` | 1943~1955 | 🟢纯工具 | — | `normalizeExtractRules_ACU`, `extractLastMatchedBoundary_ACU` |
| `applyContextTagFilters_ACU` | 1958~1963 | 🟢纯工具 | — | `applyExtractRulesToText_ACU`, `applyExcludeRulesToText_ACU` |
| `isSummaryOrOutlineTable_ACU` | 1966~1970 | 🟢纯工具 | — | — |
| `isStandardTable_ACU` | 1973~1975 | 🟢纯工具 | — | `isSummaryOrOutlineTable_ACU` |
| `getTableLockScopeKey_ACU` | 1980~1984 | 🟡数据操作 | `currentChatFileIdentifier_ACU` | `getCurrentIsolationKey_ACU` |
| `ensureTableLockStore_ACU` | 1986~1993 | 🟡数据操作 | `settings_ACU` | — |
| `getTableLocksForSheet_ACU` | 1995~2003 | 🟡数据操作 | `settings_ACU` | `getTableLockScopeKey_ACU` |
| `saveTableLocksForSheet_ACU` | 2005~2016 | 🟡数据操作 | `settings_ACU` | `ensureTableLockStore_ACU`, `getTableLockScopeKey_ACU`, `saveSettings_ACU` |
| `toggleRowLock_ACU` | 2018~2023 | 🟡数据操作 | — | `getTableLocksForSheet_ACU`, `saveTableLocksForSheet_ACU` |
| `toggleColLock_ACU` | 2025~2030 | 🟡数据操作 | — | `getTableLocksForSheet_ACU`, `saveTableLocksForSheet_ACU` |
| `toggleCellLock_ACU` | 2032~2038 | 🟡数据操作 | — | `getTableLocksForSheet_ACU`, `saveTableLocksForSheet_ACU` |
| `isSpecialIndexLockEnabled_ACU` | 2040~2045 | 🟡数据操作 | `settings_ACU` | `getTableLockScopeKey_ACU` |
| `setSpecialIndexLockEnabled_ACU` | 2047~2054 | 🟡数据操作 | `settings_ACU` | `ensureTableLockStore_ACU`, `getTableLockScopeKey_ACU`, `saveSettings_ACU` |
| `getSummaryIndexColumnIndex_ACU` | 2056~2070 | 🟢纯工具 | — | — |
| `formatSummaryIndexCode_ACU` | 2072~2075 | 🟢纯工具 | — | — |
| `applySummaryIndexSequenceToTable_ACU` | 2077~2084 | 🟡数据操作 | — | `formatSummaryIndexCode_ACU` |
| `applySpecialIndexSequenceToSummaryTables_ACU` | 2086~2097 | 🟡数据操作 | — | `isSummaryOrOutlineTable_ACU`, `isSpecialIndexLockEnabled_ACU`, `getSummaryIndexColumnIndex_ACU`, `applySummaryIndexSequenceToTable_ACU` |
| `mergeAllIndependentTables_ACU` | 2101~2356 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `settings_ACU`, `currentJsonTableData_ACU`, `independentTableStates_ACU`, `TABLE_ORDER_FIELD_ACU` | `getCurrentIsolationKey_ACU`, `getChatSheetGuideDataForIsolationKey_ACU`, `getTemplateSheetKeys_ACU`, `safeJsonParse_ACU`, `materializeDataFromSheetGuide_ACU`, `getSortedSheetKeys_ACU`, `reorderDataBySheetKeys_ACU`, `logDebug_ACU` |
| `refreshMergedDataAndNotify_ACU` | 2359~2468 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `currentJsonTableData_ACU`, `$popupInstance_ACU`, `$manualTableSelector_ACU`, `$importTableSelector_ACU`, `topLevelWindow_ACU` | `loadAllChatMessages_ACU`, `mergeAllIndependentTables_ACU`, `getChatSheetGuideDataForIsolationKey_ACU`, `getCurrentIsolationKey_ACU`, `materializeDataFromSheetGuide_ACU`, `parseTableTemplateJson_ACU`, `getSortedSheetKeys_ACU`, `reorderDataBySheetKeys_ACU`, `renderManualTableSelector_ACU`, `renderImportTableSelector_ACU`, `updateReadableLorebookEntry_ACU`, `updateCardUpdateStatusDisplay_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `formatJsonToReadable_ACU` | 2470~2524 | 🟢纯工具 | — | `getSortedSheetKeys_ACU` |
| `isNewChatGreetingStage_ACU` | 2533~2539 | 🟢纯工具 | — | — |
| `isSingleAiNoUserChat_ACU` | 2542~2547 | 🟢纯工具 | — | — |
| `shouldSuppressWorldbookInjection_ACU` | 2549~2553 | 🟢纯工具 | — | — |
| `maybeLiftWorldbookSuppression_ACU` | 2555~2564 | 🟡数据操作 | `suppressWorldbookInjectionInGreeting_ACU`, `SillyTavern_API_ACU` | `logDebug_ACU` |
| `buildTemplateBaseStateDataForLocalStorage_ACU` | 2566~2575 | 🟢纯工具 | — | — |
| `seedGreetingLocalDataFromTemplate_ACU` | 2577~2661 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `currentJsonTableData_ACU`, `suppressWorldbookInjectionInGreeting_ACU`, `topLevelWindow_ACU` | `isNewChatGreetingStage_ACU`, `parseTableTemplateJson_ACU`, `ensureSheetOrderNumbers_ACU`, `buildTemplateBaseStateDataForLocalStorage_ACU`, `getCurrentIsolationKey_ACU`, `deleteAllGeneratedEntries_ACU`, `reorderDataBySheetKeys_ACU`, `getSortedSheetKeys_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `fillFirstLayerWithTemplateData_ACU` | 2665~2768 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `currentJsonTableData_ACU`, `topLevelWindow_ACU` | `getCurrentIsolationKey_ACU`, `ensureSheetOrderNumbers_ACU`, `sanitizeTemplateSnapshotForChat_ACU`, `deriveTemplatePresetNameForImport_ACU`, `upsertTemplatePreset_ACU`, `buildChatSheetGuideDataFromTemplateObj_ACU`, `setChatSheetGuideDataForIsolationKey_ACU`, `applyTemplateScopeForCurrentChat_ACU`, `reorderDataBySheetKeys_ACU`, `getSortedSheetKeys_ACU`, `logDebug_ACU`, `logWarn_ACU`, `logError_ACU` |
| `parseReadableToJson_ACU` | 2770~2831 | 🟡数据操作 | `currentJsonTableData_ACU` | `getSortedSheetKeys_ACU`, `logWarn_ACU`, `logError_ACU` |
| `getEffectiveAutoUpdateThreshold_ACU` | 2833~2859 | 🟡数据操作 | `settings_ACU` | — |
| `saveSettings_ACU` | 2861~2894 | 🟡数据操作 | `settings_ACU`, `globalMeta_ACU` | `getConfigStorage_ACU`, `normalizeIsolationCode_ACU`, `addDataIsolationHistory_ACU`, `normalizeDataIsolationHistory_ACU`, `saveGlobalMeta_ACU`, `sanitizeSettingsForProfileSave_ACU`, `getProfileSettingsKey_ACU`, `isIndexedDbAvailable_ACU`, `showToastr_ACU`, `initTavernSettingsBridge_ACU`, `logDebug_ACU`, `logError_ACU` |
| `callApi_ACU` | 2901~2969 | 🔴业务逻辑 | `settings_ACU`, `SillyTavern_API_ACU`, `TavernHelper_API_ACU` | `getApiConfigByPreset_ACU`, `logDebug_ACU`, `handleApiResponse_ACU` |
| `formatTableDataForLLM_ACU` | 2976~3013 | 🟢纯工具 | — | — |
| `getSummaryIndexContentForPlot_ACU` | 3016~3056 | 🔴业务逻辑 | `TavernHelper_API_ACU` | `getIsolationPrefix_ACU`, `logDebug_ACU`, `logError_ACU` |
| `formatOutlineTableForPlot_ACU` | 3059~3097 | 🟢纯工具 | — | — |
| `formatSummaryIndexForPlot_ACU` | 3102~3162 | 🟢纯工具 | — | `logDebug_ACU`, `logWarn_ACU`, `logError_ACU` |
| `parseRandomTags_ACU` | 3191~3242 | 🟡数据操作 | `randomVariables_ACU` | `logWarn_ACU`, `logDebug_ACU` |
| `replaceRandomVariables_ACU` | 3249~3262 | 🟡数据操作 | `randomVariables_ACU` | `logWarn_ACU` |
| `getRandomVariable_ACU` | 3269~3274 | 🟡数据操作 | `randomVariables_ACU` | — |
| `parseCalcExpressionValue_ACU` | 3289~3362 | 🔴业务逻辑 | `calcVariables_ACU`, `maxVariables_ACU`, `minVariables_ACU` | `getCellValue_ACU`, `getRandomVariable_ACU`, `getCalcVariable_ACU`, `getMaxVariable_ACU`, `getMinVariable_ACU` |
| `evaluateCalcExpression_ACU` | 3370~3453 | 🔴业务逻辑 | `calcVariables_ACU`, `maxVariables_ACU`, `minVariables_ACU` | `getCellValue_ACU`, `getRandomVariable_ACU` |
| `parseCalcTags_ACU` | 3461~3495 | 🟡数据操作 | `calcVariables_ACU` | `evaluateCalcExpression_ACU`, `logWarn_ACU`, `logDebug_ACU` |
| `parseMaxTags_ACU` | 3503~3549 | 🟡数据操作 | `maxVariables_ACU` | `parseCalcExpressionValue_ACU`, `logWarn_ACU`, `logDebug_ACU` |
| `parseMinTags_ACU` | 3557~3603 | 🟡数据操作 | `minVariables_ACU` | `parseCalcExpressionValue_ACU`, `logWarn_ACU`, `logDebug_ACU` |
| `replaceCalcVariables_ACU` | 3610~3622 | 🟡数据操作 | `calcVariables_ACU` | `logWarn_ACU` |
| `replaceMaxVariables_ACU` | 3629~3641 | 🟡数据操作 | `maxVariables_ACU` | `logWarn_ACU` |
| `replaceMinVariables_ACU` | 3648~3660 | 🟡数据操作 | `minVariables_ACU` | `logWarn_ACU` |
| `getCalcVariable_ACU` | 3667~3672 | 🟡数据操作 | `calcVariables_ACU` | — |
| `getMaxVariable_ACU` | 3679~3684 | 🟡数据操作 | `maxVariables_ACU` | — |
| `getMinVariable_ACU` | 3691~3696 | 🟡数据操作 | `minVariables_ACU` | — |
| `evaluateSeedExpression_ACU` | 3718~3808 | 🔴业务逻辑 | — | — |
| `getCellValue_ACU` | 3825~3883 | 🟢纯工具 | — | `logError_ACU` |
| `normalizeOperators_ACU` | 3891~3901 | 🟢纯工具 | — | — |
| `compareValue_ACU` | 3910~3939 | 🟢纯工具 | — | — |
| `evaluateCellExpression_ACU` | 3951~4080 | 🔴业务逻辑 | — | `normalizeOperators_ACU`, `getCellValue_ACU`, `compareValue_ACU`, `logWarn_ACU`, `logDebug_ACU` |
| `evaluateSubCondition_ACU` | 4097~4155 | 🔴业务逻辑 | — | `evaluateSeedExpression_ACU`, `evaluateCellExpression_ACU`, `evaluateRandomExpression_ACU`, `evaluateCalcCondition_ACU`, `evaluateMaxCondition_ACU`, `evaluateMinCondition_ACU`, `logWarn_ACU` |
| `evaluateCalcCondition_ACU` | 4163~4208 | 🔴业务逻辑 | — | `normalizeOperators_ACU`, `getCalcVariable_ACU`, `compareValue_ACU`, `logWarn_ACU` |

---

## 第二部分：第 4201~8459 行

| 函数名 | 行号 | 分类 | 依赖全局变量 | 调用的其他函数 |
|--------|------|------|-------------|---------------|
| `evaluateMaxCondition_ACU` | 4216~4257 | 🔴业务逻辑 | — | `normalizeOperators_ACU`, `getMaxVariable_ACU`, `compareValue_ACU`, `logWarn_ACU` |
| `evaluateMinCondition_ACU` | 4265~4306 | 🔴业务逻辑 | — | `normalizeOperators_ACU`, `getMinVariable_ACU`, `compareValue_ACU`, `logWarn_ACU` |
| `evaluateRandomExpression_ACU` | 4316~4376 | 🔴业务逻辑 | — | `normalizeOperators_ACU`, `getRandomVariable_ACU`, `compareValue_ACU`, `logWarn_ACU`, `logDebug_ACU` |
| `evaluateCondExpression_ACU` | 4385~4492 | 🔴业务逻辑 | — | `evaluateSubCondition_ACU`, `logError_ACU` |
| `parseConditionalTemplate_ACU` | 4506~4568 | 🔴业务逻辑 | — | `evaluateSeedExpression_ACU`, `evaluateCellExpression_ACU`, `evaluateCondExpression_ACU` |
| `parseIfBlockRecursive_ACU` | 4578~4595 | 🔴业务逻辑 | `settings_ACU` | `parseIfBlocksInContent_ACU`, `logWarn_ACU` |
| `parseIfBlocksInContent_ACU` | 4604~4647 | 🔴业务逻辑 | — | `parseSingleIfBlock_ACU` |
| `parseSingleIfBlock_ACU` | 4659~4749 | 🔴业务逻辑 | — | `evaluateSeedExpression_ACU`, `evaluateCellExpression_ACU`, `evaluateCondExpression_ACU`, `parseIfBlocksInContent_ACU` |
| `getTableDataForPrompt_ACU` | 4755~4757 | 🟡数据操作 | `currentJsonTableData_ACU` | — |
| `getLatestAIMessageContent_ACU` | 4763~4777 | 🟡数据操作 | `SillyTavern_API_ACU` | — |
| `handleChatCompletionReady_ACU` | 4783~4860 | 🔴业务逻辑 | `settings_ACU` | `logDebug_ACU`, `getPlotFromHistory_ACU`, `getLatestAIMessageContent_ACU`, `getTableDataForPrompt_ACU`, `parseRandomTags_ACU`, `replaceRandomVariables_ACU`, `parseCalcTags_ACU`, `parseMaxTags_ACU`, `parseMinTags_ACU`, `replaceCalcVariables_ACU`, `replaceMaxVariables_ACU`, `replaceMinVariables_ACU`, `parseIfBlockRecursive_ACU` |
| `escapeRegExp_ACU` | 4867~4869 | 🟢纯工具 | — | — |
| `getNormalizedPlotMessageRole_ACU` | 4871~4877 | 🟢纯工具 | — | — |
| `tryRenderPlotTemplateWithEjs_ACU` | 4879~4901 | 🔴业务逻辑 | `window.EjsTemplate`, `window.Mvu` | `logWarn_ACU` |
| `clonePlotTemplateVariableMap_ACU` | 4903~4905 | 🟢纯工具 | — | — |
| `capturePlotTemplateVariables_ACU` | 4907~4914 | 🟡数据操作 | `randomVariables_ACU`, `calcVariables_ACU`, `maxVariables_ACU`, `minVariables_ACU` | `clonePlotTemplateVariableMap_ACU` |
| `restorePlotTemplateVariables_ACU` | 4916~4921 | 🟡数据操作 | `randomVariables_ACU`, `calcVariables_ACU`, `maxVariables_ACU`, `minVariables_ACU` | `clonePlotTemplateVariableMap_ACU` |
| `runWithIsolatedPlotTemplateVariables_ACU` | 4923~4931 | 🔴业务逻辑 | — | `capturePlotTemplateVariables_ACU`, `restorePlotTemplateVariables_ACU` |
| `renderPlotTaskContentWithIsolatedVariables_ACU` | 4933~4953 | 🔴业务逻辑 | — | `runWithIsolatedPlotTemplateVariables_ACU`, 模板处理管线全套 |
| `extractLastTagContent_ACU` | 4955~4972 | 🟢纯工具 | — | — |
| `extractPlotTagsFromResponse_ACU` | 4974~4996 | 🟢纯工具 | — | `extractLastTagContent_ACU` |
| `extractAllTagContents_ACU` | 4998~5021 | 🟢纯工具 | — | — |
| `getPlotPlaceholderTagNames_ACU` | 5023~5034 | 🟢纯工具 | — | — |
| `buildPlotTagMapFromText_ACU` | 5036~5061 | 🟢纯工具 | — | `extractAllTagContents_ACU` |
| `buildPlotTagBlock_ACU` | 5063~5069 | 🟢纯工具 | — | — |
| `replacePlotTagPlaceholders_ACU` | 5071~5080 | 🟢纯工具 | — | `buildPlotTagBlock_ACU` |
| `sortPlotTaskResults_ACU` | 5082~5086 | 🟢纯工具 | — | `normalizePositiveInteger_ACU` |
| `aggregatePlotTaskTags_ACU` | 5088~5101 | 🟢纯工具 | — | `sortPlotTaskResults_ACU` |
| `buildAggregatedPlotTagBlocks_ACU` | 5103~5111 | 🟢纯工具 | — | `buildPlotTagBlock_ACU` |
| `buildPlotRawFallbackText_ACU` | 5113~5125 | 🟢纯工具 | — | `sortPlotTaskResults_ACU` |
| `buildPlotSaveContentFromTaskResults_ACU` | 5127~5129 | 🟢纯工具 | — | `buildPlotRawFallbackText_ACU` |
| `buildFinalPlotInjectionMessage_ACU` | 5131~5176 | 🔴业务逻辑 | — | `buildPlotRawFallbackText_ACU`, `buildAggregatedPlotTagBlocks_ACU` |
| `checkPlotAbortRequested_ACU` | 5178~5182 | 🟡数据操作 | `abortController_ACU` | — |
| `willPlotUseMainApiGenerateRaw_ACU` | 5184~5193 | 🟡数据操作 | `settings_ACU` | `getApiConfigByPreset_ACU` |
| `sortPlotTasksForRuntime_ACU` | 5195~5199 | 🟢纯工具 | — | `normalizePositiveInteger_ACU` |
| `groupPlotTasksByStage_ACU` | 5201~5213 | 🟢纯工具 | — | `sortPlotTasksForRuntime_ACU`, `normalizePositiveInteger_ACU` |
| `getEnabledPlotTasks_ACU` | 5215~5220 | 🟡数据操作 | — | `sortPlotTasksForRuntime_ACU`, `normalizePlotTasks_ACU` |
| `buildPlotSharedContext_ACU` | 5222~5426 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `currentJsonTableData_ACU`, `settings_ACU`, `TavernHelper_API_ACU` | `normalizeExtractRules_ACU`, `normalizeExcludeRules_ACU`, `applyContextTagFilters_ACU`, `hashUserInput_ACU`, `getPlotFromHistory_ACU`, `getWorldbookContentForPlot_ACU`, `mergeAllIndependentTables_ACU`, `formatSummaryIndexForPlot_ACU`, `formatOutlineTableForPlot_ACU`, `applyExcludeRulesToText_ACU`, `getLatestAIMessageContent_ACU`, `tryRenderPlotTemplateWithEjs_ACU`, `parseRandomTags_ACU`, `replaceRandomVariables_ACU`, `escapeRegExp_ACU`, `getPlotPromptContentByIdFromSettings_ACU`, `getCurrentRuntimePlotPresetName_ACU`, `logDebug_ACU`, `logWarn_ACU`, `logError_ACU` |
| `renderPlotTaskMessages_ACU` | 5428~5448 | 🔴业务逻辑 | — | `tryRenderPlotTemplateWithEjs_ACU`, `buildPlotTagMapFromText_ACU`, `getPlotPlaceholderTagNames_ACU`, `replacePlotTagPlaceholders_ACU`, `renderPlotTaskContentWithIsolatedVariables_ACU`, `getNormalizedPlotMessageRole_ACU` |
| `executeSinglePlotTask_ACU` | 5450~5566 | 🔴业务逻辑 | `planningGuard_ACU`, `abortController_ACU`, `settings_ACU` | `normalizePlotTask_ACU`, `normalizePositiveInteger_ACU`, `normalizeNonNegativeInteger_ACU`, `checkPlotAbortRequested_ACU`, `renderPlotTaskMessages_ACU`, `callApi_ACU`, `extractPlotTagsFromResponse_ACU`, `logDebug_ACU`, `logWarn_ACU`, `logError_ACU` |
| `runPlotTasksRuntime_ACU` | 5568~5685 | 🔴业务逻辑 | `tempPlotToSave_ACU` | `ensurePlotTasksCompat_ACU`, `getEnabledPlotTasks_ACU`, `groupPlotTasksByStage_ACU`, `buildPlotSharedContext_ACU`, `checkPlotAbortRequested_ACU`, `executeSinglePlotTask_ACU`, `aggregatePlotTaskTags_ACU`, `buildPlotSaveContentFromTaskResults_ACU`, `hashUserInput_ACU`, `buildFinalPlotInjectionMessage_ACU`, `savePlotToLatestMessage_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `loadPresetAndCleanCharacterData_ACU` | 5691~5802 | 🔴业务逻辑 | `settings_ACU`, `currentChatFileIdentifier_ACU`, `currentPlotTaskEditorId_ACU`, `$popupInstance_ACU` | `ensurePlotTasksCompat_ACU`, `ensurePlotPresetBindingsStore_ACU`, `getCurrentChatPlotScopeState_ACU`, `replaceCurrentPlotSettingsWithSnapshot_ACU`, `syncCurrentEditablePlotPresetState_ACU`, `clearPlotPresetBindingForChat_ACU`, `saveSettings_ACU`, `loadPlotSettingsToUI_ACU`, `normalizePlotPresetSelectionValue_ACU`, `findPlotPresetByName_ACU`, `getPlotPresetBindingForChat_ACU`, `isDefaultPlotPresetSelection_ACU`, `applyPlotPresetToSettings_ACU`, `resetPlotSettingsToDefault_ACU`, `buildChatPlotScopeStateFromSettings_ACU`, `getPlotGlobalRevision_ACU`, `setCurrentChatPlotScopeState_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `startAutoLoop_ACU` | 5807~5864 | 🔴业务逻辑 | `settings_ACU`, `loopState_ACU` | `ensureLoopPromptsArray_ACU`, `showToastr_ACU`, `stopAutoLoop_ACU`, `updateLoopUIStatus_ACU`, `updateLoopTimerDisplay_ACU`, `triggerLoopGeneration_ACU`, `logDebug_ACU` |
| `updateLoopUIStatus_ACU` | 5869~5887 | 🔵DOM操作 | `$popupInstance_ACU`, `SCRIPT_ID_PREFIX_ACU` | — |
| `updateLoopTimerDisplay_ACU` | 5892~5895 | 🔵DOM操作 | `$popupInstance_ACU`, `SCRIPT_ID_PREFIX_ACU` | — |
| `stopAutoLoop_ACU` | 5900~5915 | 🔴业务逻辑 | `loopState_ACU` | `updateLoopUIStatus_ACU`, `logDebug_ACU` |
| `triggerLoopGeneration_ACU` | 5920~5961 | 🔴业务逻辑 | `loopState_ACU`, `settings_ACU`, `jQuery_API_ACU` | `ensureLoopPromptsArray_ACU`, `stopAutoLoop_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `validateLoopTags_ACU` | 5969~5982 | 🟢纯工具 | — | `logDebug_ACU` |
| `triggerDirectRegenerateForLoop_ACU` | 5984~5998 | 🔴业务逻辑 | `loopState_ACU`, `window.TavernHelper` | — |
| `enterLoopRetryFlow_ACU` | 6000~6051 | 🔴业务逻辑 | `loopState_ACU` | `logDebug_ACU`, `showToastr_ACU`, `stopAutoLoop_ACU`, `triggerDirectRegenerateForLoop_ACU`, `logError_ACU` |
| `onLoopGenerationEnded_ACU` | 6056~6134 | 🔴业务逻辑 | `loopState_ACU`, `planningGuard_ACU`, `settings_ACU`, `SillyTavern_API_ACU` | `validateLoopTags_ACU`, `triggerLoopGeneration_ACU`, `enterLoopRetryFlow_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `findPlotHistoryAnchorIndex_ACU` | 6144~6166 | 🟢纯工具 | — | `hashUserInput_ACU` |
| `getPlotHistorySearchUpperBound_ACU` | 6168~6181 | 🟢纯工具 | — | `findPlotHistoryAnchorIndex_ACU` |
| `getPlotFromHistory_ACU` | 6183~6247 | 🟡数据操作 | `SillyTavern_API_ACU` | `getCurrentRuntimePlotPresetName_ACU`, `getPlotHistorySearchUpperBound_ACU`, `logDebug_ACU` |
| `hashUserInput_ACU` | 6253~6264 | 🟢纯工具 | — | — |
| `savePlotToLatestMessage_ACU` | 6270~6410 | 🔴业务逻辑 | `planningGuard_ACU`, `tempPlotToSave_ACU`, `SillyTavern_API_ACU` | `getCurrentRuntimePlotPresetName_ACU`, `hashUserInput_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `runOptimizationLogic_ACU` | 6419~6595 | 🔴业务逻辑 | `loopState_ACU`, `planningGuard_ACU`, `abortController_ACU`, `settings_ACU`, `isProcessing_Plot_ACU`, `jQuery_API_ACU`, `toastr_API_ACU` | `runPlotTasksRuntime_ACU`, `showToastr_ACU`, `logDebug_ACU`, `logError_ACU` |
| `getWorldbookContentForPlot_ACU` | 6600~6697 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `TavernHelper_API_ACU` | `buildCombinedWorldbookContentByStrategy_ACU`, `isEntryBlocked_ACU`, `logDebug_ACU`, `logWarn_ACU`, `logError_ACU` |
| `loadTemplateFromStorage_ACU` | 6699~6791 | 🔴业务逻辑 | `TABLE_TEMPLATE_ACU`, `DEFAULT_TABLE_TEMPLATE_ACU`, `settings_ACU`, `globalMeta_ACU` | `normalizeIsolationCode_ACU`, `readProfileTemplateFromStorage_ACU`, `safeJsonParse_ACU`, `ensureSheetOrderNumbers_ACU`, `sanitizeChatSheetsObject_ACU`, `writeProfileTemplateToStorage_ACU`, `logDebug_ACU` |
| `buildDefaultSettings_ACU` | 6793~6876 | 🟢纯工具 | `DEFAULT_*` 常量 | `buildDefaultContentOptimizationPromptGroup_ACU` |
| `loadSettings_ACU` | 6878~7191 | 🔴业务逻辑 + 🔵DOM操作 | `settings_ACU`, `globalMeta_ACU`, `$popupInstance_ACU` 和 ~30 个 jQuery 变量 | `initTavernSettingsBridge_ACU`, `ensureConfigIdbCacheLoaded_ACU`, `migrateKeyToTavernStorageIfNeeded_ACU`, `loadGlobalMeta_ACU`, `getConfigStorage_ACU`, `safeJsonParse_ACU`, `normalizeIsolationCode_ACU`, `readProfileSettingsFromStorage_ACU`, `deepMerge_ACU`, `buildDefaultSettings_ACU`, `saveSettings_ACU`, `loadTemplateFromStorage_ACU`, `getCurrentCharSettings_ACU`, 大量 UI 渲染函数 |
| `updateApiModeView_ACU` | 7195~7208 | 🔵DOM操作 | `$popupInstance_ACU`, `SCRIPT_ID_PREFIX_ACU` | `loadTavernApiProfiles_ACU` |
| `updateCustomApiInputsState_ACU` | 7210~7221 | 🔵DOM操作 | `$popupInstance_ACU`, `settings_ACU`, `SCRIPT_ID_PREFIX_ACU` | — |
| `loadTavernApiProfiles_ACU` | 7223~7260 | 🔵DOM操作 | `$popupInstance_ACU`, `settings_ACU`, `SillyTavern_API_ACU`, `SCRIPT_ID_PREFIX_ACU` | `logError_ACU`, `showToastr_ACU` |
| `saveApiConfig_ACU` | 7262~7297 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$customApiUrlInput_ACU` 等 jQuery 变量 | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `escapeHtml_ACU`, `logError_ACU` |
| `clearApiConfig_ACU` | 7299~7304 | 🟡数据操作 | `settings_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU` |
| `saveApiPreset_ACU` | 7307~7334 | 🟡数据操作 | `settings_ACU` | `saveSettings_ACU`, `refreshApiPresetSelectors_ACU`, `showToastr_ACU` |
| `loadApiPreset_ACU` | 7336~7351 | 🟡数据操作 | `settings_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU` |
| `deleteApiPreset_ACU` | 7353~7374 | 🟡数据操作 | `settings_ACU` | `saveSettings_ACU`, `refreshApiPresetSelectors_ACU`, `showToastr_ACU` |
| `refreshApiPresetSelectors_ACU` | 7376~7419 | 🔵DOM操作 | `$popupInstance_ACU`, `settings_ACU`, `SCRIPT_ID_PREFIX_ACU` | — |
| `getApiConfigByPreset_ACU` | 7426~7452 | 🟡数据操作 | `settings_ACU` | `logWarn_ACU` |
| `saveCustomCharCardPrompt_ACU` | 7454~7490 | 🔴业务逻辑 + 🔵DOM操作 | `settings_ACU`, `$popupInstance_ACU` | `getCharCardPromptFromUI_ACU`, `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `resetDefaultCharCardPrompt_ACU` | 7492~7498 | 🟡数据操作 | `settings_ACU`, `DEFAULT_CHAR_CARD_PROMPT_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU` |
| `loadCharCardPromptFromJson_ACU` | 7500~7562 | 🔵DOM操作 | — | `renderPromptSegments_ACU`, `showToastr_ACU`, `logError_ACU`, `logDebug_ACU` |
| `exportCharCardPromptToJson_ACU` | 7565~7595 | 🔵DOM操作 | — | `getCharCardPromptFromUI_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveAutoUpdateThreshold_ACU` | 7596~7616 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$autoUpdateThresholdInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveAutoUpdateTokenThreshold_ACU` | 7618~7635 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$autoUpdateTokenThresholdInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveTableMaxRetries_ACU` | 7638~7655 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$tableMaxRetriesInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveAutoUpdateFrequency_ACU` | 7657~7674 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$autoUpdateFrequencyInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveUpdateBatchSize_ACU` | 7678~7695 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$updateBatchSizeInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveMaxConcurrentGroups_ACU` | 7698~7715 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$maxConcurrentGroupsInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveSkipUpdateFloors_ACU` | 7718~7735 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$skipUpdateFloorsInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `saveRetainRecentLayers_ACU` | 7738~7758 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$retainRecentLayersInput_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `purgeOldLayerData_ACU` | 7764~7854 | 🔴业务逻辑 | `settings_ACU`, `SillyTavern_API_ACU` | `logDebug_ACU`, `logError_ACU` |
| `saveImportSplitSize_ACU` | 7856~7875 | 🟡数据操作 + 🔵DOM操作 | `settings_ACU`, `$popupInstance_ACU` | `saveSettings_ACU`, `loadSettings_ACU`, `showToastr_ACU`, `logError_ACU` |
| `fetchModelsAndConnect_ACU` | 7877~7973 | 🔴业务逻辑 + 🔵DOM操作 | `$popupInstance_ACU`, `$customApiUrlInput_ACU`, `$customApiKeyInput_ACU`, `$customApiModelSelect_ACU`, `$apiStatusDisplay_ACU`, `settings_ACU` | `showToastr_ACU`, `escapeHtml_ACU`, `updateApiStatusDisplay_ACU`, `logDebug_ACU`, `logError_ACU` |
| `updateApiStatusDisplay_ACU` | 7974~7987 | 🔵DOM操作 | `$popupInstance_ACU`, `$apiStatusDisplay_ACU`, `settings_ACU` | `escapeHtml_ACU` |
| `attemptToLoadCoreApis_ACU` | 7988~8008 | 🔴业务逻辑 | `SillyTavern_API_ACU`, `TavernHelper_API_ACU`, `jQuery_API_ACU`, `toastr_API_ACU`, `coreApisAreReady_ACU` | `logWarn_ACU`, `logDebug_ACU`, `logError_ACU` |
| `handleNewMessageDebounced_ACU` | 8010~8088 | 🔴业务逻辑 | `newMessageDebounceTimer_ACU`, `wasStoppedByUser_ACU`, `isAutoUpdatingCard_ACU`, `coreApisAreReady_ACU`, `SillyTavern_API_ACU`, `settings_ACU` | `maybeLiftWorldbookSuppression_ACU`, `loadAllChatMessages_ACU`, `executeContentOptimization_ACU`, `triggerAutomaticUpdateIfNeeded_ACU`, `logDebug_ACU` |
| `triggerAutomaticUpdateIfNeeded_ACU` | 8091~8429 | 🔴业务逻辑 | `settings_ACU`, `coreApisAreReady_ACU`, `isAutoUpdatingCard_ACU`, `currentJsonTableData_ACU`, `allChatMessages_ACU`, `SillyTavern_API_ACU`, `lastTotalAiMessages_ACU`, `independentTableStates_ACU` | `getSortedSheetKeys_ACU`, `isSummaryOrOutlineTable_ACU`, `getCurrentIsolationKey_ACU`, `processUpdates_ACU`, `loadAllChatMessages_ACU`, `refreshMergedDataAndNotify_ACU`, `checkAndTriggerAutoMergeSummary_ACU`, `purgeOldLayerData_ACU`, `showToastr_ACU`, `logDebug_ACU`, `logWarn_ACU` |
| `collectManualExtraHint_ACU` | 8432~8442 | 🔵DOM操作 | `manualExtraHint_ACU`, `$manualExtraHintCheckbox_ACU` | — |
| `getSelectedManualSheetKeys_ACU` | 8445~8457 | 🟡数据操作 | `currentJsonTableData_ACU`, `settings_ACU` | `getSortedSheetKeys_ACU` |

---

## 常量定义（顶级 const / let）

| 变量名 | 行号 | 说明 |
|--------|------|------|
| `CHAT_SHEET_GUIDE_FIELD_ACU` | 274 | 聊天指导表存储字段名 |
| `CHAT_SHEET_GUIDE_VERSION_ACU` | 276 | 指导表版本号 |
| `LEGACY_CHAT_TABLE_HEADER_GUIDE_FIELD_ACU` | 278 | 旧版表头指导字段 |
| `CHAT_SCOPED_CONFIG_FIELD_ACU` | 279 | 聊天级配置字段名 |
| `CHAT_SCOPED_CONFIG_VERSION_ACU` | 280 | 聊天级配置版本号 |
| `CHAT_TEMPLATE_ARCHIVE_OPTION_PREFIX_ACU` | 281 | 模板归档选项前缀 |
| `MAX_CHAT_TEMPLATE_ARCHIVES_PER_TAG_ACU` | 282 | 每标签最大归档数 |
| `CHAT_SHEET_GUIDE_SEED_ROWS_FIELD_ACU` | 951 | seedRows 字段名 |
| `SHEET_KEEP_KEYS_ACU` | 1667 | 清洗时保留的字段集合 |
| `GREETING_LOCAL_BASE_STATE_MARKER_ACU` | 2531 | 开场白本地状态标记 |
| `_seedRowsTemplateCacheStr_ACU` | 1332 | seedRows 模板缓存（let） |
| `_seedRowsTemplateCacheObj_ACU` | 1333 | seedRows 模板缓存对象（let） |
| `randomVariables_ACU` | 3172 | 随机数变量存储（let） |
| `calcVariables_ACU` | 3175 | 计算变量存储（let） |
| `maxVariables_ACU` | 3178 | 最大值变量存储（let） |
| `minVariables_ACU` | 3181 | 最小值变量存储（let） |
