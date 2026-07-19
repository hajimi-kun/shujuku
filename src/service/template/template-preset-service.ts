/**
 * service/template/template-preset-service.ts — 模板预设业务逻辑
 *
 * 从 presentation/components/template-preset-ui.ts 真正搬入的纯数据/逻辑函数。
 * 不操作 DOM，不引用 $popupInstance_ACU / jQuery_API_ACU 等 UI 对象。
 */

import { STORAGE_KEY_TEMPLATE_PRESETS_ACU } from '../../shared/data-constants';
import { DEFAULT_TABLE_TEMPLATE_ACU, TABLE_TEMPLATE_ACU, _set_TABLE_TEMPLATE_ACU } from '../../shared/defaults-json.js';
import { DEFAULT_TEMPLATE_PRESET_OPTION_VALUE_ACU, getCurrentTemplatePresetName_ACU, isDefaultTemplatePresetSelection_ACU, normalizeTemplatePresetSelectionValue_ACU } from '../../shared/template-preset-utils';
import { getConfigStorage_ACU } from '../../data/storage/tavern-storage';
import { saveCurrentProfileTemplate_ACU } from '../../data/repositories/profile-repo';
import { persistCurrentTemplatePresetName_ACU, saveSettings_ACU } from '../settings/settings-service';
import { applyTemplateScopeForCurrentChat_ACU } from '../settings/settings-service';
import { getCurrentIsolationKey_ACU, settings_ACU } from '../runtime/state-manager';
import { saveChatToHost_ACU } from '../../data/gateways/chat-gateway';
import { activateChatTemplatePresetSelection_ACU, buildChatSheetGuideDataFromTemplateObj_ACU, buildChatTemplateScopeStateFromCurrent_ACU, clearChatSheetGuideDataForIsolationKey_ACU, getCurrentChatTemplateScopeState_ACU, getGlobalTemplateSnapshotForCurrentProfile_ACU, listChatTemplatePresetEntries_ACU, migrateLegacyTemplateScopeForCurrentChat_ACU, normalizeTemplateScopeIsolationKey_ACU, normalizeTemplateScopeMode_ACU, sanitizeChatSheetsObject_ACU, sanitizeTemplateSnapshotForChat_ACU, setCurrentChatTemplateScopeState_ACU } from '../template/chat-scope';
import { refreshMergedDataAndNotify_ACU } from '../worldbook/pipeline';
import { safeJsonParse_ACU, safeJsonStringify_ACU } from '../../shared/json-helpers';
import { ensureSheetOrderNumbers_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';
import { buildDefaultExportConfig_ACU, ensureExportConfigDefaults_ACU } from '../worldbook/injection-engine';

// ═══ 预设存储 CRUD（内部辅助） ═══

function buildDefaultTemplatePresetsStore_ACU() {
    return { version: 1, presets: {} };
}

function loadTemplatePresetsStore_ACU() {
    const store = getConfigStorage_ACU();
    const raw = store?.getItem?.(STORAGE_KEY_TEMPLATE_PRESETS_ACU);
    const parsed = raw ? safeJsonParse_ACU(raw, null) : null;
    const base = buildDefaultTemplatePresetsStore_ACU();
    if (!parsed || typeof parsed !== 'object') return base;
    const out = { ...base, ...parsed };
    if (!out.presets || typeof out.presets !== 'object') out.presets = {};
    return out;
}

function saveTemplatePresetsStore_ACU(obj: any) {
    try {
        const store = getConfigStorage_ACU();
        store?.setItem?.(STORAGE_KEY_TEMPLATE_PRESETS_ACU, safeJsonStringify_ACU(obj, '{}'));
        return true;
    } catch (e) {
        logWarn_ACU('[TemplatePresets] Failed to save:', e);
        return false;
    }
}

// ═══ 预设 CRUD 导出函数 ═══

export function listTemplatePresetNames_ACU() {
    const s = loadTemplatePresetsStore_ACU();
    return Object.keys(s.presets || {}).sort((a, b) => String(a).localeCompare(String(b)));
}

export function getTemplatePreset_ACU(name: string) {
    const s = loadTemplatePresetsStore_ACU();
    const p = s?.presets?.[String(name || '')];
    return p && typeof p === 'object' ? p : null;
}

export function upsertTemplatePreset_ACU(nameRaw: string, templateStr: string) {
    const name = String(nameRaw || '').trim();
    if (!name) return false;
    const s = loadTemplatePresetsStore_ACU();
    s.presets = s.presets && typeof s.presets === 'object' ? s.presets : {};
    s.presets[name] = { templateStr: String(templateStr || ''), updatedAt: Date.now() };
    return saveTemplatePresetsStore_ACU(s);
}

export function deleteTemplatePreset_ACU(nameRaw: string) {
    const name = String(nameRaw || '').trim();
    if (!name) return false;
    const s = loadTemplatePresetsStore_ACU();
    if (!s.presets || typeof s.presets !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(s.presets, name)) return false;
    delete s.presets[name];
    return saveTemplatePresetsStore_ACU(s);
}

// ═══ 纯逻辑工具函数 ═══

export function getTemplatePresetDisplayName_ACU(presetName: string) {
    const normalizedName = normalizeTemplatePresetSelectionValue_ACU(presetName);
    return normalizedName || '默认预设';
}

export function resolveActiveTemplatePresetName_ACU({ fallbackToGlobal = true, isolationKey = getCurrentIsolationKey_ACU() } = {}) {
    const normalizedKey = String(isolationKey ?? '');
    const chatScopeState = getCurrentChatTemplateScopeState_ACU({ isolationKey: normalizedKey }) || migrateLegacyTemplateScopeForCurrentChat_ACU({ isolationKey: normalizedKey });
    const chatPresetName = normalizeTemplatePresetSelectionValue_ACU(chatScopeState?.presetName || '');
    if (chatPresetName) return chatPresetName;
    if (!fallbackToGlobal) return '';
    return getCurrentTemplatePresetName_ACU(settings_ACU, { requireExisting: false });
}

export function getActiveTemplatePresetMeta_ACU({ isolationKey = getCurrentIsolationKey_ACU() } = {}) {
    const normalizedKey = String(isolationKey ?? '');
    const chatScopeState = getCurrentChatTemplateScopeState_ACU({ isolationKey: normalizedKey }) || migrateLegacyTemplateScopeForCurrentChat_ACU({ isolationKey: normalizedKey });
    const normalizedMode = normalizeTemplateScopeMode_ACU(chatScopeState?.mode);
    const effectivePresetName = normalizeTemplatePresetSelectionValue_ACU(
        resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true, isolationKey: normalizedKey }),
    );
    const scope = (normalizedMode === 'chat_override' || normalizedMode === 'preset_link') ? 'chat' : 'global';
    return {
        presetName: effectivePresetName,
        displayName: getTemplatePresetDisplayName_ACU(effectivePresetName),
        mode: normalizedMode,
        scope,
        scopeLabel: scope === 'chat' ? '当前聊天' : '全局',
    };
}

export function ensureUniqueTemplatePresetName_ACU(baseNameRaw: string) {
    const baseName = String(baseNameRaw || '').trim();
    if (!baseName) return '';
    const names = new Set(listTemplatePresetNames_ACU().map(n => String(n)));
    if (!names.has(baseName)) return baseName;
    for (let i = 2; i <= 99; i++) {
        const candidate = `${baseName} (${i})`;
        if (!names.has(candidate)) return candidate;
    }
    return `${baseName} (${Date.now()})`;
}

export function normalizeTemplateOperationScope_ACU(scope: string) {
    return scope === 'chat' ? 'chat' : 'global';
}

export function normalizeTemplateForPresetSave_ACU() {
    const obj = parseTableTemplateJson_ACU({ stripSeedRows: false });
    if (!obj || typeof obj !== 'object') return null;
    try {
        const sheetKeys = Object.keys(obj).filter(k => k.startsWith('sheet_'));
        ensureSheetOrderNumbers_ACU(obj, { baseOrderKeys: sheetKeys, forceRebuild: false });
    } catch (e) { logWarn_ACU('[模板预设] normalizeTemplateForPresetSave: 排序号处理失败:', e); }
    const sanitized = sanitizeChatSheetsObject_ACU(obj, { ensureMate: true });
    const str = safeJsonStringify_ACU(sanitized, '');
    if (!str) return null;
    return { templateObj: sanitized, templateStr: str };
}

export function getDefaultTemplateSnapshot_ACU() {
    const previousTemplate = TABLE_TEMPLATE_ACU;
    let snapshot = sanitizeTemplateSnapshotForChat_ACU(DEFAULT_TABLE_TEMPLATE_ACU);
    if (snapshot?.templateStr) {
        return snapshot;
    }

    try {
        _set_TABLE_TEMPLATE_ACU(DEFAULT_TABLE_TEMPLATE_ACU);
        const parsedTemplate = parseTableTemplateJson_ACU({ stripSeedRows: false });
        snapshot = sanitizeTemplateSnapshotForChat_ACU(parsedTemplate);
    } catch (e) {
        snapshot = null;
    } finally {
        _set_TABLE_TEMPLATE_ACU(previousTemplate);
    }

    return snapshot || sanitizeTemplateSnapshotForChat_ACU(previousTemplate);
}

export function parseImportedTemplateData_ACU(templateData: any) {
    let jsonData;

    if (typeof templateData === 'string') {
        try {
            jsonData = JSON.parse(templateData);
        } catch (parseError) {
            throw new Error(`JSON解析错误: ${parseError.message}`);
        }
    } else if (typeof templateData === 'object' && templateData !== null) {
        jsonData = JSON.parse(JSON.stringify(templateData));
    } else {
        throw new Error('无效的模板数据：必须是 JSON 对象或 JSON 字符串');
    }

    if (!jsonData.mate || !jsonData.mate.type || jsonData.mate.type !== 'chatSheets') {
        throw new Error('缺少 "mate" 对象或 "type" 属性不正确。模板必须包含 `"mate": {"type": "chatSheets", ...}`。');
    }

    const sheetKeys = Object.keys(jsonData).filter(k => k.startsWith('sheet_'));
    if (sheetKeys.length === 0) {
        throw new Error('模板中未找到任何表格数据 (缺少 "sheet_..." 键)。');
    }

    for (const key of sheetKeys) {
        const sheet = jsonData[key];
        if (!sheet.name || !sheet.content || !sheet.sourceData || !Array.isArray(sheet.content)) {
            throw new Error(`表格 "${key}" 结构不完整，缺少 "name"、"content" 或 "sourceData" 关键属性。`);
        }
    }

    try {
        if (!jsonData.mate || typeof jsonData.mate !== 'object') jsonData.mate = { type: 'chatSheets', version: 1 };
        if (jsonData.mate.updateConfigUiSentinel !== -1) {
            const sheetKeys2 = Object.keys(jsonData).filter(k => k.startsWith('sheet_'));
            for (const k of sheetKeys2) {
                const s = jsonData[k];
                const uc = s && typeof s === 'object' ? s.updateConfig : null;
                if (!uc || typeof uc !== 'object') continue;
                if (uc.uiSentinel !== -1) uc.uiSentinel = -1;
                for (const field of ['contextDepth', 'updateFrequency', 'batchSize', 'skipFloors']) {
                    if (Object.prototype.hasOwnProperty.call(uc, field) && uc[field] === 0) uc[field] = -1;
                }
            }
            jsonData.mate.updateConfigUiSentinel = -1;
        }
    } catch (e) { logWarn_ACU('[模板预设] applyTemplatePreset: updateConfig 迁移失败:', e); }

    ensureSheetOrderNumbers_ACU(jsonData, { baseOrderKeys: sheetKeys, forceRebuild: false });
    const sanitized = sanitizeChatSheetsObject_ACU(jsonData, { ensureMate: true });
    const snapshot = sanitizeTemplateSnapshotForChat_ACU(sanitized);
    if (!snapshot?.templateStr || !snapshot?.templateObj) {
        throw new Error('模板结构无效，无法生成模板快照。');
    }

    return {
        snapshot,
        templateObj: snapshot.templateObj,
        templateStr: snapshot.templateStr,
    };
}

// ═══ 模板作用域持久化（纯数据操作） ═══

export function persistTemplateScopeSelectionState_ACU(presetName: string, { source = 'ui', updateGlobal = false, save = true, persistChatScope = undefined as boolean | undefined, templateSource = null as any, guideData = null as any, archivePreviousChatScope = false, scopeMode = undefined as string | undefined, registerChatPresetEntry = undefined as boolean | undefined } = {}) {
    const _persistChatScope = persistChatScope ?? !updateGlobal;
    const _scopeMode = scopeMode ?? (_persistChatScope ? 'chat_override' : 'inherit_global');
    void archivePreviousChatScope;
    void registerChatPresetEntry;
    const normalizedPresetName = normalizeTemplatePresetSelectionValue_ACU(presetName);
    let shouldSaveSettings = false;
    let shouldSaveChat = false;

    if (updateGlobal) {
        persistCurrentTemplatePresetName_ACU(settings_ACU, normalizedPresetName, { save: false });
        shouldSaveSettings = true;
    } else if (_persistChatScope) {
        const normalizedKey = normalizeTemplateScopeIsolationKey_ACU(getCurrentIsolationKey_ACU());
        const normalizedScopeMode = normalizeTemplateScopeMode_ACU(_scopeMode);
        let templateState = null;

        if (normalizedScopeMode === 'chat_override' || normalizedScopeMode === 'preset_link') {
            const presetSnapshot = normalizedPresetName
                ? sanitizeTemplateSnapshotForChat_ACU(getTemplatePreset_ACU(normalizedPresetName)?.templateStr || null)
                : getDefaultTemplateSnapshot_ACU();
            const resolvedTemplateSource = templateSource || presetSnapshot?.templateStr || getGlobalTemplateSnapshotForCurrentProfile_ACU()?.templateStr || DEFAULT_TABLE_TEMPLATE_ACU;
            templateState = buildChatTemplateScopeStateFromCurrent_ACU({
                isolationKey: normalizedKey,
                presetName: normalizedPresetName,
                source,
                originGlobalName: getCurrentTemplatePresetName_ACU(settings_ACU, { requireExisting: false }),
                originGlobalRevision: 0,
                updatedAt: Date.now(),
                templateSource: resolvedTemplateSource,
                guideData,
            });
        } else {
            templateState = { mode: 'inherit_global' };
        }

        if (templateState) {
            setCurrentChatTemplateScopeState_ACU(templateState, {
                isolationKey: normalizedKey,
                reason: `template_scope_${source}`,
            });
            try {
                clearChatSheetGuideDataForIsolationKey_ACU({ isolationKey: normalizedKey });
            } catch (e) {}
            shouldSaveChat = true;
        }
    }

    if (save) {
        if (shouldSaveSettings) {
            saveSettings_ACU();
        }
        if (shouldSaveChat) {
            Promise.resolve()
                .then(() => saveChatToHost_ACU())
                .catch(error => logWarn_ACU('[TemplateScope] 保存聊天级模板状态失败:', error));
        }
    }

    return normalizedPresetName;
}

// ═══ 模板应用（纯业务逻辑，不做 UI 刷新） ═══

export async function applyTemplateSnapshotToScope_ACU(templateSource: any, { scope = 'global', source = 'ui', presetName = '', save = true, persistChatScope = null as boolean | null, registerChatPresetEntry = null as boolean | null } = {}) {
    const normalizedScope = normalizeTemplateOperationScope_ACU(scope);
    const snapshot = sanitizeTemplateSnapshotForChat_ACU(templateSource);
    if (!snapshot?.templateStr || !snapshot?.templateObj) return false;

    const normalizedPresetName = normalizeTemplatePresetSelectionValue_ACU(presetName);
    const updateGlobal = normalizedScope === 'global';
    const effectivePersistChatScope = persistChatScope === null ? !updateGlobal : !!persistChatScope;
    void registerChatPresetEntry;
    _set_TABLE_TEMPLATE_ACU(snapshot.templateStr);
    if (updateGlobal) {
        saveCurrentProfileTemplate_ACU(TABLE_TEMPLATE_ACU, settings_ACU);
    }

    const guideData = buildChatSheetGuideDataFromTemplateObj_ACU(snapshot.templateObj, { stripSeedRows: false });
    persistTemplateScopeSelectionState_ACU(normalizedPresetName, {
        source,
        updateGlobal,
        save,
        persistChatScope: effectivePersistChatScope,
        templateSource: snapshot.templateStr,
        guideData,
        scopeMode: effectivePersistChatScope ? 'chat_override' : 'inherit_global',
        registerChatPresetEntry: false,
    });
    applyTemplateScopeForCurrentChat_ACU();

    try { await refreshMergedDataAndNotify_ACU(); } catch (e) {}
    return {
        scope: normalizedScope,
        presetName: normalizedPresetName,
        templateStr: snapshot.templateStr,
        templateObj: snapshot.templateObj,
    };
}

export async function applyTemplatePresetToCurrent_ACU(presetName: string, { source = 'ui', updateGlobal = true, save = true, persistChatScope = undefined as boolean | undefined, chatSelectionSource = 'auto' as 'auto' | 'snapshot' | 'global' } = {}) {
    const _persistChatScope = persistChatScope ?? !updateGlobal;
    const name = normalizeTemplatePresetSelectionValue_ACU(presetName);
    const isDefaultPreset = isDefaultTemplatePresetSelection_ACU(name);

    if (!updateGlobal) {
        if (chatSelectionSource === 'global') {
            if (!isDefaultPreset && !getTemplatePreset_ACU(name)?.templateStr) return false;
            const snapshot = isDefaultPreset
                ? getDefaultTemplateSnapshot_ACU()
                : sanitizeTemplateSnapshotForChat_ACU(getTemplatePreset_ACU(name)?.templateStr || null);
            if (!snapshot?.templateStr) return false;
            const applied = await applyTemplateSnapshotToScope_ACU(snapshot.templateStr, {
                scope: 'chat',
                source,
                save,
                persistChatScope: true,
                presetName: name,
                registerChatPresetEntry: false,
            });
            if (!applied) return false;
            applyTemplateScopeForCurrentChat_ACU();
            try { await refreshMergedDataAndNotify_ACU(); } catch (e) {}
            return { presetName: name, mode: 'chat_override', fromGlobalPreset: true, isDefault: isDefaultPreset };
        }

        const activated = await activateChatTemplatePresetSelection_ACU(name, {
            source,
            save,
        });
        if (!activated) return false;
        return { ...activated, isDefault: isDefaultPreset };
    }

    let snapshot = null;
    if (isDefaultPreset) {
        snapshot = getDefaultTemplateSnapshot_ACU();
    } else {
        const preset = getTemplatePreset_ACU(name);
        const raw = preset?.templateStr;
        if (!raw) return false;
        snapshot = sanitizeTemplateSnapshotForChat_ACU(raw);
    }

    const applied = await applyTemplateSnapshotToScope_ACU(snapshot?.templateStr, {
        scope: 'global',
        source,
        presetName: name,
        save,
        persistChatScope: _persistChatScope,
    });
    if (!applied) return false;

    return { ...applied, isDefault: isDefaultPreset };
}

/**
 * 解析指定 scope 的模板数据用于导出
 * 纯业务逻辑：不涉及 UI（文件下载由 presentation 层负责）
 * 
 * @param scope - 'global' | 'chat'
 * @param selectedPresetName - 当前选中的预设名（由 UI 层传入）
 * @returns { jsonData, fromPresetName } 或 null（解析失败）
 */
export function resolveTemplateForExport_ACU(
    scope: string,
    selectedPresetName?: string
): { jsonData: Record<string, any>; fromPresetName: string } | null {
    const normalizedScope = normalizeTemplateOperationScope_ACU(scope);
    let fromPresetName = '';
    let jsonData: Record<string, any> | null = null;

    if (normalizedScope === 'global') {
        // 优先从选中的预设加载
        if (selectedPresetName) {
            try {
                const selected = normalizeTemplatePresetSelectionValue_ACU(selectedPresetName);
                if (selected) {
                    const preset = getTemplatePreset_ACU(selected);
                    const obj = preset?.templateStr ? safeJsonParse_ACU(preset.templateStr, null) : null;
                    if (obj && typeof obj === 'object') {
                        jsonData = JSON.parse(JSON.stringify(obj));
                        fromPresetName = selected;
                    }
                }
            } catch (e) { logWarn_ACU('[模板预设] resolveTemplateData: 从预设加载模板失败:', e); }
        }

        if (!jsonData || typeof jsonData !== 'object') {
            if (selectedPresetName) return null;
            const globalSnapshot = getGlobalTemplateSnapshotForCurrentProfile_ACU();
            if (globalSnapshot?.templateObj && typeof globalSnapshot.templateObj === 'object') {
                jsonData = JSON.parse(JSON.stringify(globalSnapshot.templateObj));
                fromPresetName = normalizeTemplatePresetSelectionValue_ACU(getCurrentTemplatePresetName_ACU(settings_ACU, { requireExisting: false }));
            }
        }
    } else {
        // chat scope
        const chatScopeState = getCurrentChatTemplateScopeState_ACU() || migrateLegacyTemplateScopeForCurrentChat_ACU();
        const effectivePresetName = normalizeTemplatePresetSelectionValue_ACU(resolveActiveTemplatePresetName_ACU({ fallbackToGlobal: true }));
        let chatSnapshot = null as ReturnType<typeof sanitizeTemplateSnapshotForChat_ACU> | null;
        if (chatScopeState?.mode === 'chat_override' && chatScopeState?.templateStr) {
            chatSnapshot = sanitizeTemplateSnapshotForChat_ACU(chatScopeState.templateStr);
        } else if (chatScopeState?.mode === 'preset_link') {
            const linkedPresetName = normalizeTemplatePresetSelectionValue_ACU(chatScopeState.presetName || '');
            chatSnapshot = linkedPresetName
                ? sanitizeTemplateSnapshotForChat_ACU(getTemplatePreset_ACU(linkedPresetName)?.templateStr || null)
                : getDefaultTemplateSnapshot_ACU();
        } else {
            chatSnapshot = getGlobalTemplateSnapshotForCurrentProfile_ACU();
        }
        if (chatSnapshot?.templateObj && typeof chatSnapshot.templateObj === 'object') {
            jsonData = JSON.parse(JSON.stringify(chatSnapshot.templateObj));
            fromPresetName = normalizeTemplatePresetSelectionValue_ACU(chatScopeState?.presetName || effectivePresetName);
        }
    }

    if (!jsonData || typeof jsonData !== 'object') {
        return null;
    }

    // 确保顺序编号
    const sheetKeys0 = Object.keys(jsonData).filter(k => k.startsWith('sheet_'));
    ensureSheetOrderNumbers_ACU(jsonData, { baseOrderKeys: sheetKeys0, forceRebuild: false });

    // 确保每个 sheet 都有 exportConfig
    const sheetKeysForExport = Object.keys(jsonData).filter(k => k.startsWith('sheet_'));
    sheetKeysForExport.forEach(key => {
        const sheet = jsonData[key];
        if (!sheet) return;
        if (!sheet.exportConfig) {
            sheet.exportConfig = buildDefaultExportConfig_ACU(sheet.name);
        } else {
            sheet.exportConfig = ensureExportConfigDefaults_ACU(sheet.exportConfig, sheet.name);
        }
    });

    return { jsonData, fromPresetName };
}
