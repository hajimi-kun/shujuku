/**
 * service/template/chat-scope/index.ts — 统一 re-export
 * 保持外部 import { xxx } from '.../chat-scope' 路径不变
 */

// 共享基础函数
export { normalizeChatScopedConfigSource_ACU, normalizeGuideData_ACU } from './chat-scope-base';

// A 组：Plot Scope 管理
export {
    sanitizePlotSettingsSnapshotForChat_ACU,
    getCurrentChatPlotScopeState_ACU,
    buildChatPlotScopeStateFromSettings_ACU,
    setCurrentChatPlotScopeState_ACU,
    clearCurrentChatPlotScopeState_ACU,
} from './chat-scope-plot';

// B+C 组：Template Scope 管理 + Global Template
export {
    normalizeTemplateScopeMode_ACU,
    normalizeTemplateScopeIsolationKey_ACU,
    sanitizeTemplateSnapshotForChat_ACU,
    listChatTemplatePresetEntries_ACU,
    listChatTemplateArchiveEntries_ACU,
    getChatTemplateArchiveOptionLabel_ACU,
    upsertChatTemplatePresetEntry_ACU,
    restoreChatTemplateArchiveEntry_ACU,
    buildChatTemplatePresetLinkState_ACU,
    activateChatTemplatePresetSelection_ACU,
    clearCurrentChatTemplateSnapshots_ACU,
    getCurrentChatTemplateScopeState_ACU,
    buildChatTemplateScopeStateFromCurrent_ACU,
    setCurrentChatTemplateScopeState_ACU,
    getGlobalTemplateSnapshotForCurrentProfile_ACU,
} from './chat-scope-template';

// D 组：Sheet Guide 数据操作
export {
    materializeDataFromSheetGuide_ACU,
    migrateLegacyTemplateScopeForCurrentChat_ACU,
    clearChatSheetGuideDataForIsolationKey_ACU,
    getChatSheetGuideDataForIsolationKey_ACU,
    setChatSheetGuideDataForIsolationKey_ACU,
    ensureChatSheetGuideSeeded_ACU,
    getEffectiveSeedRowsForSheet_ACU,
    ensureStableRowIdsForSeedRows_ACU,
    ensureStableRowIdsForSheetContent_ACU,
    shouldUseInitialSeedRows_ACU,
    shouldUseOpeningSeedRows_ACU,
    attachSeedRowsToCurrentDataFromGuide_ACU,
    buildChatSheetGuideDataFromData_ACU,
    buildChatSheetGuideDataFromTemplateObj_ACU,
    overwriteChatSheetGuideFromTemplate_ACU,
} from './chat-scope-guide';

// E 组：Sheet 排序和清洗
export {
    getSortedSheetKeys_ACU,
    buildGuidedBaseDataFromSheetGuide_ACU,
    reorderDataBySheetKeys_ACU,
    sanitizeSheetForStorage_ACU,
    sanitizeChatSheetsObject_ACU,
    getTemplateSheetKeys_ACU,
} from './chat-scope-sheet';
