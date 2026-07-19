/**
 * presentation/components/optimization-ui/optimization-ui-rules.ts
 * 排除规则 + 循环提示词 UI
 */
import { DEFAULT_PLOT_SETTINGS_ACU } from '../../../shared/defaults-json.js';
import { activePlotEditorSettings_ACU, buildDefaultPlotPromptGroup_ACU, currentEditablePlotPresetState_ACU, currentPlotTaskEditorId_ACU, ensurePlotPromptGroup_ACU , _set_currentEditablePlotPresetState_ACU, _set_activePlotEditorSettings_ACU, _set_currentPlotTaskEditorId_ACU} from '../../../service/plot/plot-state';
import { showToastr_ACU } from '../../theme/toast';
import { getChatArray_ACU, saveChatToHost_ACU, setChatMessages_ACU, emitMessageUpdated_ACU } from '../../../service/chat/chat-service';
import { jQuery_API_ACU } from '../../dom-utils';
import { toastr_API_ACU } from '../../../shared/host-api';
import { currentChatFileIdentifier_ACU, settings_ACU } from '../../../service/runtime/state-manager';
import { $popupInstance_ACU } from '../../state/ui-refs';
import { saveSettingsAndNotify_ACU } from '../settings-ui-helpers';
import { buildChatPlotScopeStateFromSettings_ACU, clearCurrentChatPlotScopeState_ACU, getCurrentChatPlotScopeState_ACU, sanitizePlotSettingsSnapshotForChat_ACU, setCurrentChatPlotScopeState_ACU } from '../../../service/template/chat-scope';
import { SCRIPT_ID_PREFIX_ACU } from '../../../shared/constants';
import { escapeHtml_ACU } from '../../../shared/html-helpers';
import { cleanChatName_ACU, logDebug_ACU, logError_ACU, logWarn_ACU, normalizeExcludeRules_ACU, normalizeExtractRules_ACU, normalizeNonNegativeInteger_ACU, normalizePositiveInteger_ACU } from '../../../shared/utils';
import { triggerAutomaticUpdateIfNeeded_ACU } from '../../triggers/settings-ui-sync';
import { cancelContentOptimization_ACU, contentOptimizationAbortRequested_ACU, ensureOptimizationNotCancelled_ACU, getLastOptimizationBase_ACU, optimizationProgressToast_ACU, performContentOptimization_ACU, setLastOptimizationBase_ACU, _set_optimizationProgressToast_ACU, _set_contentOptimizationAbortRequested_ACU } from '../../../service/optimization/content-optimization';
import { applyContextTagFilters_ACU } from '../../../service/runtime/helpers-remaining';
import { getActivePlotEditorSettings_ACU, getPlotPromptContentByIdFromSettings_ACU, setPlotPromptContentByIdForSettings_ACU, ensureLoopPromptsArray_ACU } from '../../../service/plot/plot-logic';


  function schedulePlotSettingsUiRefresh_ACU(plotSettingsOverride: any = null) {
    if (!$popupInstance_ACU || !$popupInstance_ACU.length) return;
 
    const refreshTarget = plotSettingsOverride || getActivePlotEditorSettings_ACU();
    const $targetPopup = $popupInstance_ACU;
    const runRefresh = () => {
      if (!$popupInstance_ACU || !$popupInstance_ACU.length) return;
      if (!$targetPopup || !$targetPopup.length) return;
      $targetPopup.triggerHandler('acu_plot_settings_refresh', [refreshTarget]);
    };
 
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(runRefresh));
      return;
    }
 
    setTimeout(runRefresh, 0);
  }

  export function renderExcludeRuleRows_ACU(containerSelector: string, rules: any, { startPlaceholder = '开始词', endPlaceholder = '结束词', fallbackRules = [] as any[] } = {}) {
    if (!$popupInstance_ACU) return;
    const $container = $popupInstance_ACU.find(containerSelector);
    if (!$container.length) return;

    let normalized = normalizeExcludeRules_ACU(rules, '');
    if (normalized.length === 0 && Array.isArray(fallbackRules) && fallbackRules.length > 0) {
      normalized = normalizeExcludeRules_ACU(fallbackRules, '');
    }
    $container.empty();

    const appendRow = (rule: any = {}) => {
      const rowHtml = `
        <div class="acu-exclude-rule-row" style="display:flex; gap:8px; margin-bottom:6px; align-items:center;">
          <input type="text" class="text_pole acu-exclude-rule-start" placeholder="${escapeHtml_ACU(startPlaceholder)}" style="flex:1;" value="${escapeHtml_ACU(rule.start || '')}">
          <input type="text" class="text_pole acu-exclude-rule-end" placeholder="${escapeHtml_ACU(endPlaceholder)}" style="flex:1;" value="${escapeHtml_ACU(rule.end || '')}">
          <button type="button" class="button acu-exclude-rule-delete" title="删除规则" style="padding:4px 8px;">删除</button>
        </div>
      `;
      $container.append(rowHtml);
    };

    const rows = normalized.length > 0 ? normalized : [{ start: '', end: '' }];
    rows.forEach(rule => appendRow(rule));
  }

  export function appendExcludeRuleRow_ACU(containerSelector: string, { startPlaceholder = '开始词', endPlaceholder = '结束词' } = {}) {
    if (!$popupInstance_ACU) return;
    const $container = $popupInstance_ACU.find(containerSelector);
    if (!$container.length) return;
    const rowHtml = `
      <div class="acu-exclude-rule-row" style="display:flex; gap:8px; margin-bottom:6px; align-items:center;">
        <input type="text" class="text_pole acu-exclude-rule-start" placeholder="${escapeHtml_ACU(startPlaceholder)}" style="flex:1;" value="">
        <input type="text" class="text_pole acu-exclude-rule-end" placeholder="${escapeHtml_ACU(endPlaceholder)}" style="flex:1;" value="">
        <button type="button" class="button acu-exclude-rule-delete" title="删除规则" style="padding:4px 8px;">删除</button>
      </div>
    `;
    $container.append(rowHtml);
  }

  export function readExcludeRulesFromRows_ACU(containerSelector: string) {
    if (!$popupInstance_ACU) return [];
    const $container = $popupInstance_ACU.find(containerSelector);
    if (!$container.length) return [];
    const collected: any[] = [];
    $container.find('.acu-exclude-rule-row').each(function() {
      const start = String(jQuery_API_ACU(this).find('.acu-exclude-rule-start').val() || '').trim();
      const end = String(jQuery_API_ACU(this).find('.acu-exclude-rule-end').val() || '').trim();
      if (start && end) collected.push({ start, end });
    });
    return normalizeExcludeRules_ACU(collected, '');
  }

  function getPlotPromptContentById_ACU(promptId: string) {
    return getPlotPromptContentByIdFromSettings_ACU(settings_ACU?.plotSettings, promptId);
  }

  function setPlotPromptContentById_ACU(promptId: string, content: string) {
    setPlotPromptContentByIdForSettings_ACU(settings_ACU?.plotSettings, promptId, content);
  }

  // --- [剧情推进] 循环提示词列表渲染和管理 ---
  export function renderLoopPromptsList_ACU(plotSettingsOverride: any = null) {
    const $container = $popupInstance_ACU.find(`#${SCRIPT_ID_PREFIX_ACU}-plot-prompts-container`);
    if (!$container.length) return;

    const plotSettings = plotSettingsOverride || getActivePlotEditorSettings_ACU();
    if (!plotSettings) return;

    ensureLoopPromptsArray_ACU(plotSettings);
    const prompts: any[] = plotSettings.loopSettings.quickReplyContent || [];

    $container.empty();

    if (prompts.length === 0) {
      $container.html('<div style="padding: 20px; text-align: center; color: var(--text_secondary); border: 1px dashed var(--border_color_light); border-radius: 6px;">暂无提示词，点击上方"添加提示词"按钮添加</div>');
      return;
    }

    prompts.forEach((prompt: any, index: number) => {
      const $item = jQuery_API_ACU('<div>', {
        class: 'loop-prompt-item',
        style: 'display: flex; gap: 8px; align-items: flex-start; padding: 10px; background: var(--background_light); border: 1px solid var(--border_color_light); border-radius: 6px;'
      });
      
      const $content = jQuery_API_ACU('<div>', {
        style: 'flex: 1; display: flex; flex-direction: column; gap: 6px;'
      });
      
      $content.append(jQuery_API_ACU('<div>', {
        style: 'display: flex; align-items: center; gap: 8px;'
      }).append(jQuery_API_ACU('<span>', {
        style: 'font-size: 0.85em; color: var(--text_secondary); font-weight: 500;',
        text: `提示词 #${index + 1}`
      })));
      
      const $textarea = jQuery_API_ACU('<textarea>', {
        class: 'loop-prompt-textarea text_pole',
        'data-index': index,
        rows: 2,
        placeholder: '输入循环提示词内容...',
        style: 'resize: vertical; width: 100%;',
        text: prompt || ''
      });
      $content.append($textarea);
      
      const $deleteBtn = jQuery_API_ACU('<button>', {
        type: 'button',
        class: 'loop-prompt-delete-btn button',
        'data-index': index,
        style: 'padding: 6px 10px; color: var(--danger); background: transparent; border: 1px solid var(--danger); border-radius: 4px; cursor: pointer; flex-shrink: 0;',
        title: '删除此提示词',
        html: '<i class="fa-solid fa-trash"></i>'
      });
      
      $item.append($content).append($deleteBtn);
      $container.append($item);
    });
  }

  export function saveLoopPromptsFromUI_ACU() {
    const plotSettings = getActivePlotEditorSettings_ACU();
    if (!plotSettings) return;

    ensureLoopPromptsArray_ACU(plotSettings);
    const prompts: string[] = [];

    $popupInstance_ACU.find('.loop-prompt-textarea').each(function() {
      const content = String(jQuery_API_ACU(this).val() || '').trim();
      if (content) {
        prompts.push(content);
      }
    });

    plotSettings.loopSettings.quickReplyContent = prompts;
    plotSettings.loopSettings.currentPromptIndex = 0; // 重置索引
    saveSettingsAndNotify_ACU();
  }

  // --- [剧情推进] 临时替换"AI指令预设"(settings_ACU.charCardPrompt)，并在生成结束后恢复 ---
  let plotPromptOverrideActive_ACU = false;
  let plotPromptOverrideBackup_ACU: any = null;

  // [剧情推进] 去重锁：避免同一次发送被 TavernHelper.generate 钩子 + GENERATION_AFTER_COMMANDS 双重处理导致重复 toast/误报失败
  function buildPlotModifiedCharCardPrompt_ACU(original: any) {
    const originalArr = Array.isArray(original)
      ? original
      : (typeof original === 'string' ? [{ role: 'USER', content: original }] : []);

    const cloned = JSON.parse(JSON.stringify(originalArr));

    const plotMain = (getPlotPromptContentById_ACU('mainPrompt') || '').trim();
    const plotTask = (getPlotPromptContentById_ACU('systemPrompt') || '').trim();

    if (!plotMain && !plotTask) return cloned;

    const getMainSlot = (seg: any) => {
      if (!seg) return '';
      const slot = String(seg.mainSlot || '').toUpperCase();
      if (slot === 'A' || slot === 'B') return slot;
      if (seg.isMain) return 'A'; // 兼容旧字段
      if (seg.isMain2) return 'B'; // 兼容旧字段（若存在）
      return '';
    };

    // 简化逻辑：只替换内容，不插入、不改role、不改结构
    // 1) 定位主提示词A/B：优先 mainSlot，其次旧 isMain/isMain2
    let mainAIdx = cloned.findIndex((p: any) => getMainSlot(p) === 'A');
    let mainBIdx = cloned.findIndex((p: any) => getMainSlot(p) === 'B');

    if (plotMain && mainAIdx !== -1 && cloned[mainAIdx]) {
      cloned[mainAIdx].content = plotMain;
    }
    if (plotTask && mainBIdx !== -1 && cloned[mainBIdx]) {
      cloned[mainBIdx].content = plotTask;
    }

    return cloned;
  }

  function applyPlotPromptOverride_ACU() {
    if (plotPromptOverrideActive_ACU) return;
    if (!settings_ACU?.plotSettings?.enabled) return;
    const plotMain = (getPlotPromptContentById_ACU('mainPrompt') || '').trim();
    const plotTask = (getPlotPromptContentById_ACU('systemPrompt') || '').trim();
    if (!plotMain && !plotTask) return;

    plotPromptOverrideBackup_ACU = settings_ACU.charCardPrompt;
    settings_ACU.charCardPrompt = buildPlotModifiedCharCardPrompt_ACU(plotPromptOverrideBackup_ACU);
    plotPromptOverrideActive_ACU = true;
    logDebug_ACU('[剧情推进] 已临时替换AI指令预设（charCardPrompt）。');
  }

  function restorePlotPromptOverride_ACU() {
    if (!plotPromptOverrideActive_ACU) return;
    settings_ACU.charCardPrompt = plotPromptOverrideBackup_ACU;
    plotPromptOverrideBackup_ACU = null;
    plotPromptOverrideActive_ACU = false;
    logDebug_ACU('[剧情推进] 已恢复AI指令预设（charCardPrompt）。');
  }

