// admin-ui.ts — 导入合并配置（presentation 层：涉及 DOM 操作和 UI 刷新）
// 从 01_data_admin.js 迁入

import { getCurrentTemplatePresetName_ACU, normalizeTemplatePresetSelectionValue_ACU } from '../../shared/template-preset-utils';
import { renderPromptSegments_ACU } from '../components/plot-editors';
import { showToastr_ACU } from '../theme/toast';
import { settings_ACU } from '../../service/runtime/state-manager';
import { saveSettingsAndNotify_ACU } from '../components/settings-ui-helpers';
import { sanitizeChatSheetsObject_ACU } from '../../service/template/chat-scope';
import { ensureSheetOrderNumbers_ACU, logDebug_ACU, logError_ACU } from '../../shared/utils';
import { syncMergeSettingsToUI_ACU } from '../components/status-display';
import { applyTemplateSnapshotToScope_ACU } from '../../service/template/template-preset-service';
import { refreshPresetUIAfterSwitch_ACU } from '../components/pipeline-ui-helpers';

export   function importCombinedSettings_ACU() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = e => {
        const file = (e.target as any).files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (readerEvent) => {
            const content = readerEvent.target.result;
            let combinedData;

            try {
                combinedData = JSON.parse(content as string);
            } catch (error) {
                logError_ACU('导入合并配置失败：JSON解析错误。', error);
                showToastr_ACU('error', '文件不是有效的JSON格式。', { timeOut: 5000 });
                return;
            }
            
            try {
                // Validation
                if (!combinedData.prompt || !combinedData.template) {
                    throw new Error('JSON文件缺少 "prompt" 或 "template" 键。');
                }
                if (!Array.isArray(combinedData.prompt)) {
                    throw new Error('"prompt" 的值必须是一个数组。');
                }
                if (typeof combinedData.template !== 'object' || combinedData.template === null) {
                    throw new Error('"template" 的值必须是一个对象。');
                }

                // 1. Apply and save prompt
                settings_ACU.charCardPrompt = combinedData.prompt;
                saveSettingsAndNotify_ACU();
                renderPromptSegments_ACU(combinedData.prompt);
                showToastr_ACU('success', '提示词预设已成功导入并保存！');

                // [新增] 导入合并提示词 (如果存在)
                if (combinedData.mergeSummaryPrompt) {
                    settings_ACU.mergeSummaryPrompt = combinedData.mergeSummaryPrompt;
                    saveSettingsAndNotify_ACU();
                    if (typeof syncMergeSettingsToUI_ACU === 'function') syncMergeSettingsToUI_ACU(settings_ACU);
                    logDebug_ACU('Merge summary prompt imported.');
                }

                // [新增] 导入所有合并设置 (如果存在)
                if (typeof combinedData.mergeSummaryPrompt !== 'undefined' ||
                    typeof combinedData.autoMergeEnabled !== 'undefined') {

                    // 导入合并提示词
                    if (combinedData.mergeSummaryPrompt) {
                        settings_ACU.mergeSummaryPrompt = combinedData.mergeSummaryPrompt;
                    }

                    // 导入手动合并设置
                    settings_ACU.mergeTargetCount = combinedData.mergeTargetCount || 1;
                    settings_ACU.mergeBatchSize = combinedData.mergeBatchSize || 5;
                    settings_ACU.mergeStartIndex = combinedData.mergeStartIndex || 1;
                    settings_ACU.mergeEndIndex = combinedData.mergeEndIndex || null;

                    // 导入自动合并设置
                    settings_ACU.autoMergeEnabled = combinedData.autoMergeEnabled || false;
                    settings_ACU.autoMergeThreshold = combinedData.autoMergeThreshold || 20;
                    settings_ACU.autoMergeReserve = combinedData.autoMergeReserve || 0;

                    // 导入删除楼层范围设置
                    settings_ACU.deleteStartFloor = combinedData.deleteStartFloor || null;
                    settings_ACU.deleteEndFloor = combinedData.deleteEndFloor || null;

                    saveSettingsAndNotify_ACU();

                    // UI 回填交给 presentation 层
                    if (typeof syncMergeSettingsToUI_ACU === 'function') syncMergeSettingsToUI_ACU(settings_ACU);

                    logDebug_ACU('All merge settings imported.');
                }
                
                // 2. Apply and save template
                // [瘦身] 导入时清洗模板并回写（兼容旧模板带冗余字段）
                const sheetKeys = Object.keys(combinedData.template).filter(k => k.startsWith('sheet_'));
                ensureSheetOrderNumbers_ACU(combinedData.template, { baseOrderKeys: sheetKeys, forceRebuild: false });
                const sanitizedTemplate = sanitizeChatSheetsObject_ACU(combinedData.template, { ensureMate: true });
                const appliedTemplate = await applyTemplateSnapshotToScope_ACU(sanitizedTemplate, {
                    scope: 'global',
                    source: 'import_combined',
                    presetName: normalizeTemplatePresetSelectionValue_ACU(getCurrentTemplatePresetName_ACU(settings_ACU, { requireExisting: false })),
                    save: true,
                    persistChatScope: false,
                });
                if (!appliedTemplate) {
                    throw new Error('合并配置中的表格模板已解析，但应用到全局模板失败。');
                }

                showToastr_ACU('success', '表格模板已成功导入！模板已更新，但不会影响当前聊天记录的本地数据。');

                // 刷新模板预设下拉 UI，确保预设列表与状态文案同步
                refreshPresetUIAfterSwitch_ACU();

                // [优化] 不再触发表格数据初始化，仅修改当前插件模板
                // 只有在新开卡或之前没有用过插件的聊天记录里才会使用新的通用模板作为基底
                showToastr_ACU('success', '合并配置已成功导入！');

            } catch (error) {
                logError_ACU('导入合并配置失败：结构验证失败。', error);
                showToastr_ACU('error', `导入失败: ${error.message}`, { timeOut: 10000 });
            }
        };
        reader.readAsText(file, 'UTF-8');
    };
    input.click();
  }
