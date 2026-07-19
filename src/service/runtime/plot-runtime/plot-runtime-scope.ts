import { getCurrentCharacterId_ACU } from '../../../data/gateways/host-state-gateway';
import { currentChatFileIdentifier_ACU, getCurrentIsolationKey_ACU } from '../state-manager';

export interface PlotRuntimeScope_ACU {
  chatId: string | null;
  characterId: string | null;
  isolationKey: string;
  reliable: boolean;
}

function normalizeRequiredScopePart_ACU(value: unknown): string | null {
  const normalized = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return normalized && normalized !== 'unknown_chat_init' ? normalized : null;
}

export function capturePlotRuntimeScope_ACU(): PlotRuntimeScope_ACU {
  const chatId = normalizeRequiredScopePart_ACU(currentChatFileIdentifier_ACU);
  const characterId = normalizeRequiredScopePart_ACU(getCurrentCharacterId_ACU());
  return {
    chatId,
    characterId,
    isolationKey: String(getCurrentIsolationKey_ACU() ?? ''),
    reliable: !!chatId && !!characterId,
  };
}

export function isSamePlotRuntimeScope_ACU(before: PlotRuntimeScope_ACU, after: PlotRuntimeScope_ACU): boolean {
  return before.reliable
    && after.reliable
    && before.chatId === after.chatId
    && before.characterId === after.characterId
    && before.isolationKey === after.isolationKey;
}

export function normalizeLorebookNames_ACU(raw: any): string[] {
  const candidates = [raw?.primary, ...(Array.isArray(raw?.additional) ? raw.additional : [])];
  const seen = new Set<string>();
  return candidates.reduce<string[]>((names, candidate) => {
    if (typeof candidate !== 'string') return names;
    const name = candidate.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    return names;
  }, []);
}

export function isTransientLorebookNotFoundError_ACU(error: any): boolean {
  if (!error || error?.name === 'AbortError') return false;
  const message = String(error?.message || error).toLowerCase();
  return /(?:未能找到|找不到|不存在).{0,24}(?:世界书|worldbook|lorebook)|(?:worldbook|lorebook).{0,24}(?:not found|does not exist|missing)/i.test(message);
}

export function summarizePlotRuntimeScope_ACU(scope: PlotRuntimeScope_ACU) {
  return {
    chatId: scope.chatId,
    characterId: scope.characterId,
    isolationKey: scope.isolationKey,
    reliable: scope.reliable,
  };
}

export function summarizePlotRuntimeError_ACU(error: any) {
  let category = 'unknown';
  if (error?.name === 'AbortError') {
    category = 'aborted';
  } else if (isTransientLorebookNotFoundError_ACU(error)) {
    category = 'lorebook_not_found';
  }

  return {
    category,
  };
}
