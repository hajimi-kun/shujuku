/**
 * service/runtime/message-handler.ts — 新消息处理核心逻辑
 * 从 presentation/triggers/settings-ui-sync/settings-ui-connect.ts 的 handleNewMessageDebounced_ACU 中提取
 * 
 * 只负责「验证新消息是否应该触发更新 + 决定执行模式」，不涉及 UI（toast/防抖定时器）。
 */

import { logDebug_ACU } from '../../shared/utils';
import { getCurrentCharacterFallback_ACU } from '../host/host-state-service';

export type MessageAction = 'skip' | 'update_only' | 'optimize_parallel' | 'optimize_then_update' | 'optimize_manual';

export interface MessageActionResult {
    action: MessageAction;
    reason: string;
    lastMessageIndex?: number;
}

/**
 * 评估新消息事件，决定应该执行什么操作
 * 
 * @param liveChat - 当前聊天记录数组
 * @param isAutoUpdating - 是否正在自动更新
 * @param coreApisReady - 核心 API 是否就绪
 * @param wasStoppedByUser - 是否被用户终止
 * @param contentOptimizationSettings - 正文优化设置
 * @returns MessageActionResult 包含 action 和 reason
 */
export function evaluateNewMessageAction_ACU(
    liveChat: any[],
    isAutoUpdating: boolean,
    coreApisReady: boolean,
    wasStoppedByUser: boolean,
    contentOptimizationSettings: any
): MessageActionResult {
    if (wasStoppedByUser) {
        return { action: 'skip', reason: 'Skipping update check after user abort' };
    }

    if (isAutoUpdating) {
        return { action: 'skip', reason: 'Auto-update already in progress' };
    }

    if (!coreApisReady) {
        return { action: 'skip', reason: 'Core APIs not ready' };
    }

    if (!liveChat || liveChat.length === 0) {
        return { action: 'skip', reason: 'No chat data available' };
    }

    const lastMessage = liveChat[liveChat.length - 1];
    const lastMessageIndex = liveChat.length - 1;

    // 如果最新消息不是AI回复，跳过
    if (!lastMessage || lastMessage.is_user) {
        return { action: 'skip', reason: 'Last message is not an AI reply' };
    }

    // 检查是否来自当前角色
    const activeChar = getCurrentCharacterFallback_ACU();
    const activeCharName = activeChar?.name;
    if (activeCharName && lastMessage.name && lastMessage.name !== activeCharName) {
        return { action: 'skip', reason: `AI reply from different character (${lastMessage.name} != ${activeCharName})` };
    }

    // 决定执行模式
    const config = contentOptimizationSettings || {};
    if (config.enabled) {
        if (config.parallelMode) {
            return { action: 'optimize_parallel', reason: 'Parallel mode enabled', lastMessageIndex };
        } else if (!config.autoApply && !config.seamlessMode) {
            return { action: 'optimize_manual', reason: 'Manual confirmation mode', lastMessageIndex };
        } else {
            return { action: 'optimize_then_update', reason: 'Sequential mode', lastMessageIndex };
        }
    }

    return { action: 'update_only', reason: 'No content optimization configured', lastMessageIndex };
}
