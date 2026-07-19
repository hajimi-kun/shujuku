/**
 * data/gateways/worldbook-gateway.ts — 世界书 CRUD 操作网关
 *
 * 封装 TavernHelper_API_ACU / SillyTavern_API_ACU 的世界书相关方法。
 * service 层通过本模块访问世界书，不再直接调用宿主 API。
 *
 * 所有方法内置存在性检查，宿主 API 不可用时返回安全默认值。
 */

import { TavernHelper_API_ACU, SillyTavern_API_ACU } from '../../shared/host-api';
import { getCharLorebooks_ACU, getCurrentCharacterWorldbookBinding_ACU } from './character-gateway';
import { logWarn_ACU } from '../../shared/utils';

// ═══ 可用性检查 ═══

/**
 * 检查 TavernHelper 世界书 API 是否可用
 */
export function isWorldbookApiAvailable_ACU(): boolean {
    return !!(TavernHelper_API_ACU && typeof TavernHelper_API_ACU.getLorebookEntries === 'function');
}

/**
 * 检查 TavernHelper 世界书条目读取与更新 API 是否同时可用。
 */
export function isWorldbookEntryUpdateApiAvailable_ACU(): boolean {
    return !!(TavernHelper_API_ACU && typeof TavernHelper_API_ACU.getLorebookEntries === 'function' && typeof TavernHelper_API_ACU.setLorebookEntries === 'function');
}

// ═══ 条目 CRUD ═══

/**
 * 获取指定世界书的所有条目
 * @param bookName 世界书名称
 * @returns 条目数组，API 不可用时返回 []
 */
export async function getLorebookEntries_ACU(bookName: string): Promise<any[]> {
    if (!TavernHelper_API_ACU || typeof TavernHelper_API_ACU.getLorebookEntries !== 'function') {
        logWarn_ACU('[WorldbookGateway] getLorebookEntries 不可用，返回空数组');
        return [];
    }
    return await TavernHelper_API_ACU.getLorebookEntries(bookName);
}

export function isLorebookNotFoundError_ACU(error: unknown): boolean {
    if (!error || (error as any)?.name === 'AbortError' || (error as any)?.message === 'TaskAbortedByUser') {
        return false;
    }
    const message = String((error as any)?.message || error || '');
    return /\b(?:worldbook|lorebook)\b(?:\s+['"`][^'"`\r\n]+['"`])?\s+(?:not found|does not exist)\b/i.test(message)
        || /\b(?:could not find|cannot find|can't find)\s+(?:the\s+)?(?:worldbook|lorebook)\b/i.test(message)
        || /世界书\s*(?:[“"'`][^”"'`\r\n]+[”"'`])?\s*(?:未能找到|找不到|不存在)/.test(message)
        || /(?:未能找到|找不到)\s*世界书/.test(message);
}

/**
 * 更新指定世界书中的条目
 * @param bookName 世界书名称
 * @param entries 要更新的条目数组（需包含 uid）
 */
export async function setLorebookEntries_ACU(bookName: string, entries: any[]): Promise<void> {
    if (!TavernHelper_API_ACU || typeof TavernHelper_API_ACU.setLorebookEntries !== 'function') {
        logWarn_ACU('[WorldbookGateway] setLorebookEntries 不可用，跳过');
        return;
    }
    await TavernHelper_API_ACU.setLorebookEntries(bookName, entries);
}

/**
 * 在指定世界书中创建新条目
 * @param bookName 世界书名称
 * @param entries 要创建的条目数组
 */
export async function createLorebookEntries_ACU(bookName: string, entries: any[]): Promise<void> {
    if (!TavernHelper_API_ACU || typeof TavernHelper_API_ACU.createLorebookEntries !== 'function') {
        logWarn_ACU('[WorldbookGateway] createLorebookEntries 不可用，跳过');
        return;
    }
    await TavernHelper_API_ACU.createLorebookEntries(bookName, entries);
}

/**
 * 删除指定世界书中的条目
 * @param bookName 世界书名称
 * @param uids 要删除的条目 UID 数组
 */
export async function deleteLorebookEntries_ACU(bookName: string, uids: any[]): Promise<void> {
    if (!TavernHelper_API_ACU || typeof TavernHelper_API_ACU.deleteLorebookEntries !== 'function') {
        logWarn_ACU('[WorldbookGateway] deleteLorebookEntries 不可用，跳过');
        return;
    }
    await TavernHelper_API_ACU.deleteLorebookEntries(bookName, uids);
}

// ═══ 世界书列表 ═══

/**
 * 获取所有可用的世界书列表
 * 优先使用 TavernHelper_API_ACU.getLorebooks()，
 * 降级使用 SillyTavern_API_ACU.getWorldBooks()
 * @returns 世界书名称数组，不可用时返回 []
 */
export async function listLorebooks_ACU(): Promise<string[]> {
    // 优先尝试 TavernHelper
    if (TavernHelper_API_ACU && typeof TavernHelper_API_ACU.getLorebooks === 'function') {
        return await TavernHelper_API_ACU.getLorebooks();
    }
    // 降级到 SillyTavern_API
    if (SillyTavern_API_ACU && typeof SillyTavern_API_ACU.getWorldBooks === 'function') {
        return await SillyTavern_API_ACU.getWorldBooks();
    }
    logWarn_ACU('[WorldbookGateway] listLorebooks 不可用，返回空数组');
    return [];
}

/**
 * 获取所有可用的世界书列表（SillyTavern_API_ACU.getWorldBooks 的直接封装）
 * 用于需要明确调用 SillyTavern 侧 API 的场景
 * @returns 世界书名称数组，不可用时返回 []
 */
export async function getWorldBooks_ACU(): Promise<string[]> {
    if (SillyTavern_API_ACU && typeof SillyTavern_API_ACU.getWorldBooks === 'function') {
        return await SillyTavern_API_ACU.getWorldBooks();
    }
    logWarn_ACU('[WorldbookGateway] getWorldBooks 不可用，返回空数组');
    return [];
}

// ═══ 角色绑定世界书 ═══

/**
 * 获取当前角色的主绑定世界书名称
 * @returns 世界书名称，不可用时返回 null
 */
export async function getCurrentCharPrimaryLorebook_ACU(): Promise<string | null> {
    if (!TavernHelper_API_ACU || typeof TavernHelper_API_ACU.getCurrentCharPrimaryLorebook !== 'function') {
        logWarn_ACU('[WorldbookGateway] getCurrentCharPrimaryLorebook 不可用，返回 null');
        return null;
    }
    return await TavernHelper_API_ACU.getCurrentCharPrimaryLorebook();
}

/**
 * 获取角色关联的世界书列表
 * @param options 查询选项（如 { type: 'all' }）
 * @returns 角色世界书结构，不可用时返回空结构
 */
export { getCharLorebooks_ACU, getCurrentCharacterWorldbookBinding_ACU };
