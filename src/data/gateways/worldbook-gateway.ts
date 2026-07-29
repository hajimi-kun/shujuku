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

const LOREBOOK_NAME_IGNORABLE_CHARS_ACU = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * 仅用于世界书名称比对，不可替代宿主保存的原始名称。
 * 兼容复制粘贴常见的全角字符、组合字符、不可见控制字符与异常空白。
 */
export function normalizeLorebookNameForMatch_ACU(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(LOREBOOK_NAME_IGNORABLE_CHARS_ACU, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getLorebookListItemName_ACU(item: unknown): string {
    if (item && typeof item === 'object') return String((item as any).name ?? '').trim();
    return String(item ?? '').trim();
}

/**
 * 将配置/绑定中的名称解析为宿主列表里的真实名称。
 * 多个名称归一化后冲突时拒绝猜测，避免读写到错误世界书。
 */
export function resolveLorebookNameFromList_ACU(requestedName: unknown, bookList: unknown): string | null {
    const requested = String(requestedName ?? '').trim();
    if (!requested || !Array.isArray(bookList)) return null;
    const availableNames = bookList.map(getLorebookListItemName_ACU).filter(Boolean);
    const exactMatch = availableNames.find(name => name === requested);
    if (exactMatch) return exactMatch;

    const matchKey = normalizeLorebookNameForMatch_ACU(requested);
    if (!matchKey) return null;
    const normalizedMatches = availableNames.filter(name => normalizeLorebookNameForMatch_ACU(name) === matchKey);
    return normalizedMatches.length === 1 ? normalizedMatches[0] : null;
}

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
    try {
        return await TavernHelper_API_ACU.getLorebookEntries(bookName);
    } catch (error) {
        if (!isLorebookNotFoundError_ACU(error)) throw error;
        let resolvedName: string | null = null;
        try {
            resolvedName = resolveLorebookNameFromList_ACU(bookName, await listLorebooks_ACU());
        } catch {
            // 名称恢复是补救路径；列表读取失败时必须保留原始宿主错误。
        }
        if (!resolvedName || resolvedName === bookName) throw error;
        logWarn_ACU('[WorldbookGateway] 世界书名称存在 Unicode 或不可见字符差异，使用宿主真实名称重试读取。', {
            phase: 'resolve_lorebook_name',
            requestedName: bookName,
            resolvedName,
        });
        try {
            return await TavernHelper_API_ACU.getLorebookEntries(resolvedName);
        } catch (retryError) {
            // 保留第一次宿主 not-found 错误的分类与堆栈，同时附带恢复失败证据。
            // 直接抛 retryError 会让调用方误以为首次故障就是网络/权限问题。
            try {
                Object.defineProperties(error as object, {
                    lorebookResolvedName: { value: resolvedName, configurable: true },
                    lorebookRetryError: { value: retryError, configurable: true },
                });
            } catch {
                // 极少数不可扩展错误对象无法附加诊断；输出脱敏结构化日志并保留原始错误。
                logWarn_ACU('[WorldbookGateway] 世界书真实名称重试失败，原始错误对象不可扩展。', {
                    phase: 'retry_resolved_lorebook_name',
                    requestedName: bookName,
                    resolvedName,
                    error: { category: 'read_failed' },
                });
            }
            throw error;
        }
    }
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
