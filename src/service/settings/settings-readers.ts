/**
 * service/settings/settings-readers.ts — 设置读取器（纯读取，无持久化副作用）
 *
 * 从 settings-service.ts 提取。这些函数只读取/规范化 settings 中的数据，
 * 不执行保存操作。其他子模块应优先从此文件 import，而非 settings-service.ts。
 */

import { currentChatFileIdentifier_ACU, settings_ACU } from '../runtime/state-manager';
import { globalMeta_ACU } from '../../data/repositories/profile-repo';
import { defaultWorldbookConfig_ACU } from '../../shared/defaults';
import { deepMerge_ACU, logDebug_ACU } from '../../shared/utils';

/**
 * 获取当前角色的专属设置。
 * 业务逻辑：读 settings → deep merge 默认值 → 写回（确保字段完整）。
 * 注意：此函数有"规范化写回"的副作用（补全缺失字段），但不触发持久化。
 */
export function getCurrentCharSettings_ACU() {
    const charId = currentChatFileIdentifier_ACU || 'default';
    if (!settings_ACU.characterSettings) {
        settings_ACU.characterSettings = {};
    }
    const globalZeroTkDefault =
        (typeof globalMeta_ACU?.zeroTkOccupyModeGlobal === 'boolean')
            ? (globalMeta_ACU.zeroTkOccupyModeGlobal === true)
            : (settings_ACU?.zeroTkOccupyModeDefault === true);
    if (!settings_ACU.characterSettings[charId]) {
        const worldbookConfigForNewChat = JSON.parse(JSON.stringify(defaultWorldbookConfig_ACU));
        worldbookConfigForNewChat.zeroTkOccupyMode = globalZeroTkDefault;
        worldbookConfigForNewChat.outlineEntryEnabled = !globalZeroTkDefault;
        worldbookConfigForNewChat.summaryVectorIndexModeEnabled = globalMeta_ACU?.summaryVectorIndexModeGlobal === true;
        settings_ACU.characterSettings[charId] = {
            worldbookConfig: worldbookConfigForNewChat,
        };
        logDebug_ACU(`Created new character settings for: ${charId}`);
    }
    try {
        const existingCfg = settings_ACU.characterSettings[charId].worldbookConfig || {};
        const mergedCfg = deepMerge_ACU(
            JSON.parse(JSON.stringify(defaultWorldbookConfig_ACU)),
            existingCfg,
        );
        const globalSummaryVectorIndexEnabled = globalMeta_ACU?.summaryVectorIndexModeGlobal === true;
        mergedCfg.summaryVectorIndexModeEnabled = globalSummaryVectorIndexEnabled;
        mergedCfg.zeroTkOccupyMode = globalZeroTkDefault;
        mergedCfg.outlineEntryEnabled = !mergedCfg.zeroTkOccupyMode;
        settings_ACU.characterSettings[charId].worldbookConfig = mergedCfg;
    } catch (e) {
        // ignore
    }
    return settings_ACU.characterSettings[charId];
}

/** 获取当前角色的世界书配置 */
export function getCurrentWorldbookConfig_ACU() {
    return getCurrentCharSettings_ACU().worldbookConfig;
}
