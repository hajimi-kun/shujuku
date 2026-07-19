/**
 * presentation/bootstrap/api-groups/template-preset-api.ts
 * 模板预设 API — 模板预设的列表/切换/导入
 */

import { deriveTemplatePresetNameForImport_ACU, normalizeTemplatePresetSelectionValue_ACU } from '../../../shared/template-preset-utils';
import { logDebug_ACU, logError_ACU } from '../../../shared/utils';
import {
    applyTemplatePresetToCurrent_ACU,
    applyTemplateSnapshotToScope_ACU,
    listTemplatePresetNames_ACU,
    normalizeTemplateOperationScope_ACU,
    parseImportedTemplateData_ACU,
    resolveTemplateForExport_ACU,
    upsertTemplatePreset_ACU,
} from '../../../service/template/template-preset-service';
import { refreshTemplatePresetSelectInUI_ACU } from '../../components/template-preset-ui';
import { refreshPresetUIAfterSwitch_ACU } from '../../components/pipeline-ui-helpers';
import type { ApiGroupContext } from './callback-api';

export function createTemplatePresetApi(ctx: ApiGroupContext): Record<string, Function> {
    return {
        getTemplatePresetNames: function() {
            try {
                return listTemplatePresetNames_ACU();
            } catch (e) {
                logError_ACU('getTemplatePresetNames failed:', e);
                return [];
            }
        },

        switchTemplatePreset: async function(presetName: any, options: any = {}) {
            try {
                const { scope = 'global' } = options || {};
                const normalizedScope = normalizeTemplateOperationScope_ACU(scope);
                const name = normalizeTemplatePresetSelectionValue_ACU(presetName);
                const displayName = name || '默认预设';
                const result = await applyTemplatePresetToCurrent_ACU(name, {
                    source: 'api',
                    updateGlobal: normalizedScope === 'global',
                    save: true,
                    persistChatScope: normalizedScope === 'chat',
                });
                if (result) {
                    refreshPresetUIAfterSwitch_ACU({
                        templateGlobalSelectName: normalizedScope === 'global' ? name : null,
                        keepTemplateGlobalValue: normalizedScope !== 'global',
                    });
                    return {
                        success: true,
                        scope: normalizedScope,
                        message: `${normalizedScope === 'global' ? '全局模板预设' : '当前聊天模板预设'}已切换：${displayName}`,
                    };
                }
                return {
                    success: false,
                    scope: normalizedScope,
                    message: `${normalizedScope === 'global' ? '全局模板预设' : '当前聊天模板预设'}切换失败：${displayName}`,
                };
            } catch (e) {
                logError_ACU('switchTemplatePreset failed:', e);
                return { success: false, message: `模板预设切换失败：${e.message}` };
            }
        },

        injectTemplatePresetToCurrentChat: async function(presetName: any) {
            try {
                return await ctx.getApi().switchTemplatePreset(presetName, { scope: 'chat' });
            } catch (e) {
                logError_ACU('injectTemplatePresetToCurrentChat failed:', e);
                return { success: false, message: `当前聊天模板预设切换失败：${e.message}` };
            }
        },

        importTemplateFromData: async function(templateData: any, options: any = {}) {
            try {
                const { scope = 'global', presetName = '' } = options || {};
                const normalizedScope = normalizeTemplateOperationScope_ACU(scope);
                const normalizedPresetName = deriveTemplatePresetNameForImport_ACU({
                    presetName,
                    fallbackLabel: normalizedScope === 'global'
                        ? `导入模板_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
                        : '',
                });
                const prepared = parseImportedTemplateData_ACU(templateData);

                if (normalizedScope === 'global') {
                    // ═══ 全局导入：仅保存到预设库，不自动切换当前生效模板 ═══
                    if (normalizedPresetName) {
                        const savePresetOk = upsertTemplatePreset_ACU(normalizedPresetName, prepared.templateStr);
                        if (!savePresetOk) {
                            return {
                                success: false,
                                scope: normalizedScope,
                                message: `模板已解析，但保存全局模板预设失败：${normalizedPresetName}`,
                            };
                        }
                    }

                    // 刷新 UI 让新预设立即出现在下拉列表中，但保持当前选中值不变
                    refreshPresetUIAfterSwitch_ACU({ keepTemplateGlobalValue: true });

                    logDebug_ACU(`[API] importTemplateFromData: 模板已保存到全局预设库：${normalizedPresetName}。`);
                    return {
                        success: true,
                        scope: normalizedScope,
                        message: normalizedPresetName
                            ? `模板已保存为全局预设：${normalizedPresetName}。你可以在"全局模板预设"下拉中手动切换到它。`
                            : '模板已解析，但未指定预设名称，未保存到预设库。',
                        presetName: normalizedPresetName || undefined,
                    };
                }

                // ═══ 聊天导入：应用到当前聊天作用域 ═══
                const applied = await applyTemplateSnapshotToScope_ACU(prepared.templateStr, {
                    scope: 'chat',
                    source: 'api_import_template_chat',
                    presetName: normalizedPresetName,
                    save: true,
                    persistChatScope: true,
                });
                if (!applied) {
                    return {
                        success: false,
                        scope: normalizedScope,
                        message: '模板导入失败：无法应用到当前聊天。',
                    };
                }

                logDebug_ACU(`[API] importTemplateFromData: 模板已成功导入到当前聊天。`);
                refreshPresetUIAfterSwitch_ACU({ keepTemplateGlobalValue: true });
                return {
                    success: true,
                    scope: normalizedScope,
                    message: `模板已成功导入到当前聊天${normalizedPresetName ? `（预设名：${normalizedPresetName}）` : ''}！`,
                    presetName: normalizedPresetName || undefined,
                };

            } catch (e) {
                logError_ACU('importTemplateFromData failed:', e);
                return { success: false, message: `导入失败: ${e.message}` };
            }
        },

        getTableTemplate: function(options: any = {}) {
            try {
                const scope = normalizeTemplateOperationScope_ACU(options?.scope || 'chat');
                const resolved = resolveTemplateForExport_ACU(scope, options?.presetName);
                if (resolved?.jsonData) return resolved.jsonData;
                if (scope !== 'global') {
                    const fallbackGlobal = resolveTemplateForExport_ACU('global', options?.presetName);
                    if (fallbackGlobal?.jsonData) return fallbackGlobal.jsonData;
                }
                return null;
            } catch (e) {
                logError_ACU('getTableTemplate failed:', e);
                return null;
            }
        },
    };
}
