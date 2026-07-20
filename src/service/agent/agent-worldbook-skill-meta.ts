import type {
  AgentWorldbookControl_ACU,
  AgentWorldbookControlMode_ACU,
  WorldbookSkillMeta_ACU,
  WorldbookSkillMetaUpdatedBy_ACU,
} from '../../shared/models/agent-worldbook-model';
import { createLorebookEntries_ACU, getLorebookEntries_ACU, setLorebookEntries_ACU } from '../../data/gateways/worldbook-gateway';
import { createStrictLorebookReadError_ACU, getLorebookEntriesStrict_ACU, type StrictLorebookReadContext_ACU } from '../worldbook/pipeline';
export type { WorldbookSkillMeta_ACU, WorldbookSkillMetaUpdatedBy_ACU } from '../../shared/models/agent-worldbook-model';
import {
  readAgentWorldbookControlFromWorldbooks_ACU,
  resolveAgentWorldbookScopeBookNames_ACU,
  type AgentWorldbookConfigSource_ACU,
} from './agent-worldbook-config-meta';

export const ACU_SKILL_META_START_ACU = 'ACU_SKILL_META_START';
export const ACU_SKILL_META_END_ACU = 'ACU_SKILL_META_END';
export const AGENT_WORLDBOOK_SKILL_REGISTRY_COMMENT_ACU = 'TavernDB-ACU-AgentWorldbookSkillRegistry';

const SKILL_META_BLOCK_PATTERN_ACU = /\n?<!--\s*ACU_SKILL_META_START\s*\n([\s\S]*?)\nACU_SKILL_META_END\s*-->\n?/g;

export interface WorldbookSkillMetaSaveResult_ACU {
  updated: boolean;
  reason?: string;
  entry?: Record<string, any>;
}

export interface WorldbookSkillMetaReadResult_ACU {
  bookName: string;
  uid: string | number;
  comment: string;
  label: string;
  skillMeta: WorldbookSkillMeta_ACU;
}

export interface ClearWorldbookSkillMetaBlocksResult_ACU {
  total: number;
  cleared: number;
  skipped: number;
  failed: number;
  errors: Array<{ bookName: string; uid: string | number; reason: string }>;
}

export interface AgentWorldbookFilterAvailability_ACU {
  configuredMode: AgentWorldbookControlMode_ACU;
  control: AgentWorldbookControl_ACU;
  configSource: AgentWorldbookConfigSource_ACU;
  available: boolean;
  skillCount: number;
  bookNames: string[];
  configBookName: string;
  writableBookName: string;
  reason: 'available' | 'empty_scope' | 'no_card_agent_config' | 'not_agent_mode' | 'no_skill_data';
  skillMetas: WorldbookSkillMetaReadResult_ACU[];
}

interface StoredWorldbookSkillMeta_ACU {
  uid: string | number;
  comment: string;
  meta: WorldbookSkillMeta_ACU;
}

interface WorldbookSkillRegistry_ACU {
  version: 1;
  kind: 'agent_worldbook_skill_registry';
  updatedAt: number;
  skills: StoredWorldbookSkillMeta_ACU[];
}

const skillRegistryWriteQueues_ACU = new Map<string, Promise<unknown>>();

function normalizeCommentText_ACU(comment: unknown): string {
  return typeof comment === 'string' ? comment : '';
}

function normalizeSkillMetaText_ACU(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSkillMetaTk_ACU(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.trunc(raw));
}

function isValidUpdatedBy_ACU(value: unknown): value is WorldbookSkillMetaUpdatedBy_ACU {
  return value === 'manual' || value === 'agent-skillify';
}

export function stripWorldbookSkillMetaBlock_ACU(comment: unknown): string {
  return normalizeCommentText_ACU(comment)
    .replace(SKILL_META_BLOCK_PATTERN_ACU, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseWorldbookSkillMetaFromComment_ACU(comment: unknown): WorldbookSkillMeta_ACU | null {
  const text = normalizeCommentText_ACU(comment);
  const pattern = new RegExp(SKILL_META_BLOCK_PATTERN_ACU.source, 'g');
  const match = pattern.exec(text);
  if (!match) return null;

  try {
    const raw = JSON.parse(match[1].trim()) as Record<string, unknown>;
    if (raw.version !== 1) return null;
    const updatedBy = isValidUpdatedBy_ACU(raw.updatedBy) ? raw.updatedBy : 'manual';
    return {
      version: 1,
      description: normalizeSkillMetaText_ACU(raw.description),
      triggerWhen: normalizeSkillMetaText_ACU(raw.triggerWhen),
      tk: normalizeSkillMetaTk_ACU(raw.tk),
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
      updatedBy,
    };
  } catch {
    return null;
  }
}

export function hasUsableWorldbookSkillMeta_ACU(comment: unknown): boolean {
  const meta = parseWorldbookSkillMetaFromComment_ACU(comment);
  if (!meta) return false;
  return !!meta.description || !!meta.triggerWhen || meta.tk > 0;
}

export function normalizeWorldbookSkillMetaDraft_ACU(
  draft: Partial<WorldbookSkillMeta_ACU>,
  updatedBy: WorldbookSkillMetaUpdatedBy_ACU = 'manual',
  now = Date.now(),
): WorldbookSkillMeta_ACU {
  return {
    version: 1,
    description: normalizeSkillMetaText_ACU(draft.description),
    triggerWhen: normalizeSkillMetaText_ACU(draft.triggerWhen),
    tk: normalizeSkillMetaTk_ACU(draft.tk),
    updatedAt: Number.isFinite(Number(draft.updatedAt)) && Number(draft.updatedAt) > 0 ? Number(draft.updatedAt) : now,
    updatedBy: isValidUpdatedBy_ACU(draft.updatedBy) ? draft.updatedBy : updatedBy,
  };
}

function normalizeStoredSkillMeta_ACU(value: unknown): StoredWorldbookSkillMeta_ACU | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.uid === null || source.uid === undefined || String(source.uid).trim() === '') return null;
  const comment = stripWorldbookSkillMetaBlock_ACU(source.comment).trim();
  if (!comment) return null;
  const metaSource = source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)
    ? source.meta as Partial<WorldbookSkillMeta_ACU>
    : {};
  const meta = normalizeWorldbookSkillMetaDraft_ACU(metaSource, isValidUpdatedBy_ACU(metaSource.updatedBy) ? metaSource.updatedBy : 'manual');
  if (!meta.description && !meta.triggerWhen && !meta.tk) return null;
  return { uid: source.uid as string | number, comment, meta };
}

function parseWorldbookSkillRegistry_ACU(entries: Record<string, any>[]): { entry: Record<string, any> | null; skills: StoredWorldbookSkillMeta_ACU[] } {
  const entry = (Array.isArray(entries) ? entries : [])
    .find(item => String(item?.comment || '').trim() === AGENT_WORLDBOOK_SKILL_REGISTRY_COMMENT_ACU) || null;
  if (!entry) return { entry: null, skills: [] };
  try {
    const raw = JSON.parse(String(entry.content || '')) as Record<string, unknown>;
    if (raw.version !== 1 || raw.kind !== 'agent_worldbook_skill_registry' || !Array.isArray(raw.skills)) {
      return { entry, skills: [] };
    }
    const skills = raw.skills.map(normalizeStoredSkillMeta_ACU).filter(Boolean) as StoredWorldbookSkillMeta_ACU[];
    return { entry, skills };
  } catch {
    return { entry, skills: [] };
  }
}

function findStoredSkillMetaForEntry_ACU(entry: Record<string, any>, skills: StoredWorldbookSkillMeta_ACU[]): StoredWorldbookSkillMeta_ACU | null {
  const uid = String(entry?.uid ?? '');
  const comment = stripWorldbookSkillMetaBlock_ACU(entry?.comment || entry?.name).trim();
  return skills.find(skill => String(skill.uid) === uid)
    || skills.find(skill => !!comment && skill.comment === comment)
    || null;
}

export function parseWorldbookSkillMetaFromEntry_ACU(
  entry: Record<string, any>,
  bookEntries: Record<string, any>[] = [],
): WorldbookSkillMeta_ACU | null {
  const legacy = parseWorldbookSkillMetaFromComment_ACU(entry?.comment || entry?.name);
  if (legacy) return legacy;
  const { skills } = parseWorldbookSkillRegistry_ACU(bookEntries);
  return findStoredSkillMetaForEntry_ACU(entry, skills)?.meta || null;
}

export function buildWorldbookSkillMetaMapForEntries_ACU(entries: Record<string, any>[]): Map<string, WorldbookSkillMeta_ACU> {
  const result = new Map<string, WorldbookSkillMeta_ACU>();
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (String(entry?.comment || '').trim() === AGENT_WORLDBOOK_SKILL_REGISTRY_COMMENT_ACU) continue;
    const meta = parseWorldbookSkillMetaFromEntry_ACU(entry, list);
    if (meta && entry?.uid !== null && entry?.uid !== undefined) result.set(String(entry.uid), meta);
  }
  return result;
}

function runWithSkillRegistryWriteLock_ACU<T>(bookName: string, operation: () => Promise<T>): Promise<T> {
  const previous = skillRegistryWriteQueues_ACU.get(bookName) || Promise.resolve();
  const current: Promise<T> = previous.catch((): undefined => undefined).then(() => operation());
  skillRegistryWriteQueues_ACU.set(bookName, current);
  void current.finally((): void => {
    if (skillRegistryWriteQueues_ACU.get(bookName) === current) skillRegistryWriteQueues_ACU.delete(bookName);
  }).catch((): undefined => undefined);
  return current;
}

async function persistWorldbookSkillRegistry_ACU(
  bookName: string,
  registryEntry: Record<string, any> | null,
  skills: StoredWorldbookSkillMeta_ACU[],
): Promise<void> {
  const registry: WorldbookSkillRegistry_ACU = {
    version: 1,
    kind: 'agent_worldbook_skill_registry',
    updatedAt: Date.now(),
    skills,
  };
  const payload: Record<string, any> = {
    comment: AGENT_WORLDBOOK_SKILL_REGISTRY_COMMENT_ACU,
    content: JSON.stringify(registry, null, 2),
    keys: [],
    enabled: false,
    type: 'selective',
    order: Number.isFinite(Number(registryEntry?.order)) ? Number(registryEntry?.order) : 10001,
    prevent_recursion: true,
  };
  if (registryEntry?.uid !== null && registryEntry?.uid !== undefined) {
    await setLorebookEntries_ACU(bookName, [{ ...payload, uid: registryEntry.uid }]);
  } else {
    await createLorebookEntries_ACU(bookName, [payload]);
  }
}

function upsertStoredSkillMeta_ACU(
  skills: StoredWorldbookSkillMeta_ACU[],
  entry: Record<string, any>,
  meta: WorldbookSkillMeta_ACU,
): StoredWorldbookSkillMeta_ACU[] {
  const comment = stripWorldbookSkillMetaBlock_ACU(entry?.comment || entry?.name).trim();
  const next = skills.filter(skill => String(skill.uid) !== String(entry.uid) && skill.comment !== comment);
  next.push({ uid: entry.uid, comment, meta });
  return next;
}

async function migrateLegacyWorldbookSkillMetaBlocks_ACU(bookName: string): Promise<void> {
  await runWithSkillRegistryWriteLock_ACU(bookName, async () => {
    const entries = await getLorebookEntries_ACU(bookName);
    const parsed = parseWorldbookSkillRegistry_ACU(entries);
    let skills = parsed.skills;
    const commentPatches: Record<string, any>[] = [];
    for (const entry of entries) {
      const legacyMeta = parseWorldbookSkillMetaFromComment_ACU(entry?.comment || entry?.name);
      if (!legacyMeta) continue;
      skills = upsertStoredSkillMeta_ACU(skills, entry, legacyMeta);
      commentPatches.push({ uid: entry.uid, comment: stripWorldbookSkillMetaBlock_ACU(entry.comment) });
    }
    if (commentPatches.length === 0) return;
    await persistWorldbookSkillRegistry_ACU(bookName, parsed.entry, skills);
    await setLorebookEntries_ACU(bookName, commentPatches);
  });
}


export function buildWorldbookSkillMetaComment_ACU(comment: unknown, metaDraft: Partial<WorldbookSkillMeta_ACU>): string {
  const meta = normalizeWorldbookSkillMetaDraft_ACU(metaDraft);
  const baseComment = stripWorldbookSkillMetaBlock_ACU(comment);
  if (!meta.description && !meta.triggerWhen) return baseComment;

  const metaJson = JSON.stringify(meta);
  const metaBlock = `<!-- ${ACU_SKILL_META_START_ACU}\n${metaJson}\n${ACU_SKILL_META_END_ACU} -->`;
  return [baseComment, metaBlock].filter(Boolean).join('\n\n');
}

export function findWorldbookEntryByUid_ACU(entries: Record<string, any>[], uid: string | number): Record<string, any> | null {
  return entries.find(entry => entry?.uid === uid || String(entry?.uid) === String(uid)) || null;
}

function validateWorldbookSkillMetaTarget_ACU(bookName: string, uid: string | number | null | undefined): string | null {
  if (!bookName || !bookName.trim()) return '世界书名称为空';
  if (uid === null || uid === undefined || uid === '') return '世界书条目 uid 为空';
  return null;
}

export async function saveWorldbookEntrySkillMeta_ACU(
  bookName: string,
  uid: string | number,
  metaDraft: Partial<WorldbookSkillMeta_ACU>,
  updatedBy: WorldbookSkillMetaUpdatedBy_ACU = 'manual',
): Promise<WorldbookSkillMetaSaveResult_ACU> {
  const targetError = validateWorldbookSkillMetaTarget_ACU(bookName, uid);
  if (targetError) return { updated: false, reason: targetError };
  return runWithSkillRegistryWriteLock_ACU(bookName, async () => {
    const entries = await getLorebookEntries_ACU(bookName);
    const entry = findWorldbookEntryByUid_ACU(entries, uid);
    if (!entry) return { updated: false, reason: '未找到世界书条目' };

    const parsed = parseWorldbookSkillRegistry_ACU(entries);
    const meta = normalizeWorldbookSkillMetaDraft_ACU(metaDraft, updatedBy);
    const existing = parseWorldbookSkillMetaFromEntry_ACU(entry, entries);
    const cleanComment = stripWorldbookSkillMetaBlock_ACU(entry.comment);
    const unchanged = existing
      && existing.description === meta.description
      && existing.triggerWhen === meta.triggerWhen
      && Number(existing.tk || 0) === Number(meta.tk || 0)
      && existing.updatedBy === meta.updatedBy
      && cleanComment === normalizeCommentText_ACU(entry.comment);
    if (unchanged) return { updated: false, reason: '世界书 Skill 元数据未变化', entry };

    const skills = upsertStoredSkillMeta_ACU(parsed.skills, entry, meta);
    await persistWorldbookSkillRegistry_ACU(bookName, parsed.entry, skills);
    if (cleanComment !== normalizeCommentText_ACU(entry.comment)) {
      await setLorebookEntries_ACU(bookName, [{ uid: entry.uid, comment: cleanComment }]);
    }
    return { updated: true, entry: { ...entry, comment: cleanComment } };
  });
}

export async function deleteWorldbookEntrySkillMeta_ACU(
  bookName: string,
  uid: string | number,
): Promise<WorldbookSkillMetaSaveResult_ACU> {
  const targetError = validateWorldbookSkillMetaTarget_ACU(bookName, uid);
  if (targetError) return { updated: false, reason: targetError };

  return runWithSkillRegistryWriteLock_ACU(bookName, async () => {
    const entries = await getLorebookEntries_ACU(bookName);
    const entry = findWorldbookEntryByUid_ACU(entries, uid);
    if (!entry) return { updated: false, reason: '未找到世界书条目' };

    const parsed = parseWorldbookSkillRegistry_ACU(entries);
    const cleanComment = stripWorldbookSkillMetaBlock_ACU(entry.comment);
    const stored = findStoredSkillMetaForEntry_ACU(entry, parsed.skills);
    const hadLegacy = parseWorldbookSkillMetaFromComment_ACU(entry.comment) !== null;
    if (!stored && !hadLegacy) return { updated: false, reason: '世界书条目没有 Skill 元数据', entry };

    const skills = parsed.skills.filter(skill => String(skill.uid) !== String(entry.uid) && skill.comment !== cleanComment);
    if (parsed.entry) await persistWorldbookSkillRegistry_ACU(bookName, parsed.entry, skills);
    if (hadLegacy) await setLorebookEntries_ACU(bookName, [{ uid: entry.uid, comment: cleanComment }]);
    return { updated: true, entry: { ...entry, comment: cleanComment } };
  });
}

function buildWorldbookSkillMetaReadResult_ACU(
  bookName: string,
  entry: Record<string, any>,
  bookEntries: Record<string, any>[] = [],
): WorldbookSkillMetaReadResult_ACU | null {
  const uid = entry?.uid;
  if (uid === null || uid === undefined || String(uid).trim() === '') return null;
  const comment = normalizeCommentText_ACU(entry?.comment || entry?.name);
  const skillMeta = parseWorldbookSkillMetaFromEntry_ACU(entry, bookEntries);
  if (!skillMeta) return null;
  return {
    bookName,
    uid,
    comment,
    label: stripWorldbookSkillMetaBlock_ACU(comment).trim() || `条目 ${uid}`,
    skillMeta,
  };
}

export async function getWorldbookEntrySkillMeta_ACU(
  bookName: string,
  uid: string | number,
): Promise<WorldbookSkillMetaReadResult_ACU | null> {
  const targetError = validateWorldbookSkillMetaTarget_ACU(bookName, uid);
  if (targetError) return null;
  const entries = await getLorebookEntries_ACU(bookName);
  const entry = findWorldbookEntryByUid_ACU(entries, uid);
  if (!entry) return null;
  if (parseWorldbookSkillMetaFromComment_ACU(entry.comment)) {
    await migrateLegacyWorldbookSkillMetaBlocks_ACU(bookName);
    const migratedEntries = await getLorebookEntries_ACU(bookName);
    const migratedEntry = findWorldbookEntryByUid_ACU(migratedEntries, uid);
    return migratedEntry ? buildWorldbookSkillMetaReadResult_ACU(bookName, migratedEntry, migratedEntries) : null;
  }
  return buildWorldbookSkillMetaReadResult_ACU(bookName, entry, entries);
}

async function getAgentRuntimeLorebookEntries_ACU(
  bookName: string,
  readContext?: StrictLorebookReadContext_ACU,
): Promise<any[]> {
  if (!readContext) return getLorebookEntries_ACU(bookName);
  const result = await getLorebookEntriesStrict_ACU([bookName], {
    source: 'agent_runtime',
    validationPolicy: 'trusted_direct',
    runId: readContext.runId,
    context: readContext,
  });
  if (result.status !== 'success') throw createStrictLorebookReadError_ACU(result);
  return result.entriesByBook[bookName] || [];
}

export async function listWorldbookSkillMetas_ACU(
  bookNames: string[] = [],
  readContext?: StrictLorebookReadContext_ACU,
): Promise<WorldbookSkillMetaReadResult_ACU[]> {
  const uniqueBookNames = [...new Set((Array.isArray(bookNames) ? bookNames : [])
    .map(name => String(name || '').trim())
    .filter(Boolean))];
  const results: WorldbookSkillMetaReadResult_ACU[] = [];
  for (const bookName of uniqueBookNames) {
    let entries = await getAgentRuntimeLorebookEntries_ACU(bookName, readContext);
    if (!readContext && entries.some(entry => parseWorldbookSkillMetaFromComment_ACU(entry?.comment || entry?.name))) {
      await migrateLegacyWorldbookSkillMetaBlocks_ACU(bookName);
      entries = await getLorebookEntries_ACU(bookName);
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (String(entry?.comment || '').trim() === AGENT_WORLDBOOK_SKILL_REGISTRY_COMMENT_ACU) continue;
      const item = buildWorldbookSkillMetaReadResult_ACU(bookName, entry, entries);
      if (item) results.push(item);
    }
  }
  return results;
}

export async function clearWorldbookSkillMetaBlocks_ACU(
  bookNames: string[] = [],
): Promise<ClearWorldbookSkillMetaBlocksResult_ACU> {
  const result: ClearWorldbookSkillMetaBlocksResult_ACU = {
    total: 0,
    cleared: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const uniqueBookNames = [...new Set((Array.isArray(bookNames) ? bookNames : []).map(name => String(name || '').trim()).filter(Boolean))];
  for (const bookName of uniqueBookNames) {
    try {
      await runWithSkillRegistryWriteLock_ACU(bookName, async () => {
        const entries = await getLorebookEntries_ACU(bookName);
        const parsed = parseWorldbookSkillRegistry_ACU(entries);
        const legacyEntries = entries.filter(entry => parseWorldbookSkillMetaFromComment_ACU(entry?.comment || entry?.name));
        const targetKeys = new Set([
          ...parsed.skills.map(skill => `${String(skill.uid)}\u0000${skill.comment}`),
          ...legacyEntries.map(entry => `${String(entry.uid)}\u0000${stripWorldbookSkillMetaBlock_ACU(entry.comment)}`),
        ]);
        result.total += targetKeys.size;
        if (parsed.entry) await persistWorldbookSkillRegistry_ACU(bookName, parsed.entry, []);
        if (legacyEntries.length > 0) {
          await setLorebookEntries_ACU(bookName, legacyEntries.map(entry => ({
            uid: entry.uid,
            comment: stripWorldbookSkillMetaBlock_ACU(entry.comment),
          })));
        }
        result.cleared += targetKeys.size;
      });
    } catch (error: any) {
      result.failed += 1;
      result.errors.push({ bookName, uid: '', reason: error?.message || '清除 Skill 元数据失败' });
    }
  }

  return result;
}

export async function resolveAgentWorldbookFilterAvailability_ACU(
  readContext?: StrictLorebookReadContext_ACU,
): Promise<AgentWorldbookFilterAvailability_ACU> {
  const config = await readAgentWorldbookControlFromWorldbooks_ACU();
  const bookNames = await resolveAgentWorldbookScopeBookNames_ACU();
  const skillMetas = bookNames.length > 0 ? await listWorldbookSkillMetas_ACU(bookNames, readContext) : [];
  const base = {
    configuredMode: config.control.mode,
    control: config.control,
    configSource: config.source,
    skillCount: skillMetas.length,
    bookNames,
    configBookName: config.bookName || '',
    writableBookName: config.writableBookName || '',
    skillMetas,
  };

  if (bookNames.length === 0) return { ...base, available: false, reason: 'empty_scope' };
  if (config.source !== 'worldbook') return { ...base, available: false, reason: 'no_card_agent_config' };
  if (config.control.mode !== 'agent') return { ...base, available: false, reason: 'not_agent_mode' };
  return { ...base, available: true, reason: 'available' };
}
