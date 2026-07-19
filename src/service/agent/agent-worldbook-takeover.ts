import type {
  AgentWorldbookControlSnapshot_ACU,
  AgentWorldbookControlSnapshotEntry_ACU,
} from '../../shared/models/agent-worldbook-model';
import {
  deleteLorebookEntries_ACU,
  getLorebookEntries_ACU,
  setLorebookEntries_ACU,
} from '../../data/gateways/worldbook-gateway';
import { persistTavernSettings_ACU } from '../../data/storage/tavern-storage';
import { hashUserInput_ACU, logWarn_ACU } from '../../shared/utils';
import { buildAgentWorldbookSnapshotSelectionSignature_ACU } from '../../shared/agent-worldbook-snapshot';
import {
  getAgentWorldbookSnapshotRevision_ACU,
  getAgentWorldbookSnapshotState_ACU,
  setAgentWorldbookSnapshotState_ACU,
  setAgentWorldbookSnapshotStateIfRevision_ACU,
} from './agent-worldbook-snapshot-state';
import { settings_ACU } from '../runtime/state-manager';
import {
  getWorldbookEntryKeywordsForSkillify_ACU,
  isWorldbookEntrySkillifyCandidate_ACU,
} from './agent-skillify-service';
import {
  hasUsableWorldbookSkillMeta_ACU,
  resolveAgentWorldbookFilterAvailability_ACU,
  stripWorldbookSkillMetaBlock_ACU,
} from './agent-worldbook-skill-meta';
import {
  deleteAgentWorldbookStateEntry_ACU,
  readAgentWorldbookStateFromWorldbooks_ACU,
  resolveAgentWorldbookScopeBookNames_ACU,
  writeAgentWorldbookStateToWorldbook_ACU,
} from './agent-worldbook-config-meta';

export interface AgentWorldbookTakeoverEntryUpdate_ACU {
  bookName: string;
  uid: string | number;
}

export interface AgentWorldbookFinalGreenlightRef_ACU {
  bookName: string;
  uid: string | number;
  reason?: string;
}

export interface AgentWorldbookTakeoverResult_ACU {
  updated: boolean;
  reason?: string;
  bookNames: string[];
  selectionSignature: string;
  totalCandidates: number;
  disabled: number;
  failed: number;
  snapshot: AgentWorldbookControlSnapshot_ACU;
  updates: AgentWorldbookTakeoverEntryUpdate_ACU[];
}

export interface AgentWorldbookRestoreResult_ACU {
  updated: boolean;
  reason?: string;
  bookNames: string[];
  selectionSignature: string;
  restored: number;
  skipped: number;
  failed: number;
  updates: AgentWorldbookTakeoverEntryUpdate_ACU[];
}


export const AGENT_WORLDBOOK_SNAPSHOT_COMMENT_ACU = 'TavernDB-ACU-AgentWorldbookSnapshot';
export const AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU = 'TavernDB-ACU-AgentFinalGenerationGreenlights';
const AGENT_TAKEOVER_META_START_ACU = 'ACU_AGENT_WORLDBOOK_TAKEOVER_META_START';
const AGENT_TAKEOVER_META_END_ACU = 'ACU_AGENT_WORLDBOOK_TAKEOVER_META_END';
const AGENT_TAKEOVER_META_PATTERN_ACU = /\n?<!--\s*ACU_AGENT_WORLDBOOK_TAKEOVER_META_START\s*\n([\s\S]*?)\nACU_AGENT_WORLDBOOK_TAKEOVER_META_END\s*-->\n?/g;

interface AgentWorldbookTakeoverMeta_ACU {
  version: 1;
  kind: 'agent_worldbook_takeover';
  selectionSignature: string;
  createdAt: number;
  previousEnabled: boolean;
  previousKeys?: string[];
  previousType?: string;
  commentHash?: string;
}

function normalizeBookNamesForTakeover_ACU(bookNames: unknown): string[] {
  if (!Array.isArray(bookNames)) return [];
  return [...new Set(bookNames.map(name => String(name || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeCommentText_ACU(comment: unknown): string {
  return typeof comment === 'string' ? comment : '';
}

function hasValidWorldbookUid_ACU(uid: unknown): uid is string | number {
  return uid !== null && uid !== undefined && String(uid).trim() !== '';
}

async function deleteInternalEntryByComment_ACU(bookName: string, comment: string): Promise<boolean> {
  const entries = await getLorebookEntries_ACU(bookName);
  const matched = (entries || []).filter(entry => String(entry?.comment || '').trim() === comment && hasValidWorldbookUid_ACU(entry?.uid));
  if (matched.length === 0) return false;
  await deleteLorebookEntries_ACU(bookName, matched.map(entry => entry.uid));
  return true;
}

async function deleteInternalEntriesByComment_ACU(bookNames: string[], comment: string): Promise<number> {
  let deleted = 0;
  for (const bookName of normalizeBookNamesForTakeover_ACU(bookNames)) {
    if (await deleteInternalEntryByComment_ACU(bookName, comment)) deleted += 1;
  }
  return deleted;
}

function normalizeAgentWorldbookRefs_ACU(greenlights: unknown): AgentWorldbookFinalGreenlightRef_ACU[] {
  if (!Array.isArray(greenlights)) return [];
  const normalized: AgentWorldbookFinalGreenlightRef_ACU[] = [];
  const seen = new Set<string>();

  for (const ref of greenlights) {
    if (!ref || typeof ref !== 'object') continue;
    const bookName = String((ref as any).bookName || '').trim();
    const uid = (ref as any).uid;
    if (!bookName || !hasValidWorldbookUid_ACU(uid)) continue;
    const key = `${bookName}\u0000${String(uid).trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = String((ref as any).reason || '').trim();
    normalized.push(reason ? { bookName, uid, reason } : { bookName, uid });
  }

  return normalized;
}

function buildSnapshotUidSetByBook_ACU(snapshot: AgentWorldbookControlSnapshot_ACU): Map<string, Set<string>> {
  const uidSetByBook = new Map<string, Set<string>>();
  if (snapshot.active !== true) return uidSetByBook;

  for (const [bookName, entries] of Object.entries(snapshot.books || {})) {
    const normalizedBookName = String(bookName || '').trim();
    if (!normalizedBookName || !Array.isArray(entries)) continue;
    const uidSet = new Set<string>();
    for (const entry of entries) {
      if (!hasValidWorldbookUid_ACU(entry?.uid)) continue;
      uidSet.add(String(entry.uid));
    }
    if (uidSet.size > 0) uidSetByBook.set(normalizedBookName, uidSet);
  }

  return uidSetByBook;
}

function buildAllowedFinalGreenlightKeySet_ACU(greenlights: AgentWorldbookFinalGreenlightRef_ACU[], snapshotUidSetByBook: Map<string, Set<string>>): Set<string> {
  const allowed = new Set<string>();
  for (const ref of greenlights) {
    const bookName = String(ref.bookName || '').trim();
    const uid = String(ref.uid).trim();
    if (!snapshotUidSetByBook.get(bookName)?.has(uid)) continue;
    allowed.add(`${bookName}\u0000${uid}`);
  }
  return allowed;
}

function getSnapshotEntryForBookAndUid_ACU(
  snapshot: AgentWorldbookControlSnapshot_ACU,
  bookName: string,
  uid: unknown,
): AgentWorldbookControlSnapshotEntry_ACU | undefined {
  return (snapshot.books?.[bookName] || []).find(entry => String(entry?.uid) === String(uid));
}

function isFinalGenerationBlueLightEntry_ACU(entry: Record<string, any>): boolean {
  // SillyTavern constant worldbook entries are blue lights whenever enabled; keys do not affect triggering.
  return entry?.enabled !== false
    && String(entry?.type || '').trim().toLowerCase() === 'constant';
}

function buildFinalGreenlightKey_ACU(bookName: string, uid: unknown): string {
  return `${String(bookName || '').trim()}\u0000${String(uid ?? '').trim()}`;
}

async function patchSnapshotEntries_ACU(snapshotUidSetByBook: Map<string, Set<string>>, buildPatch: (bookName: string, entry: Record<string, any>) => Record<string, any> | null): Promise<number> {
  let patched = 0;
  for (const [bookName, uidSet] of snapshotUidSetByBook.entries()) {
    const entries = await getLorebookEntries_ACU(bookName);
    const patches = (entries || [])
      .filter(entry => uidSet.has(String(entry?.uid)))
      .map(entry => buildPatch(bookName, entry))
      .filter(Boolean) as Record<string, any>[];
    if (patches.length === 0) continue;
    await setLorebookEntries_ACU(bookName, patches);
    patched += patches.length;
  }
  return patched;
}

export function buildWorldbookSelectionSignature_ACU(bookNames: string[]): string {
  return buildAgentWorldbookSnapshotSelectionSignature_ACU(bookNames);
}

function buildActiveSnapshot_ACU(selectionSignature: string, books: Record<string, AgentWorldbookControlSnapshotEntry_ACU[]>): AgentWorldbookControlSnapshot_ACU {
  return { active: true, selectionSignature, createdAt: Date.now(), books };
}

function buildInactiveSnapshot_ACU(selectionSignature = ''): AgentWorldbookControlSnapshot_ACU {
  return { active: false, selectionSignature, createdAt: 0, books: {} };
}

function stripTakeoverMetaBlock_ACU(comment: unknown): string {
  return normalizeCommentText_ACU(comment)
    .replace(AGENT_TAKEOVER_META_PATTERN_ACU, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTakeoverComparableComment_ACU(comment: unknown): string {
  return stripWorldbookSkillMetaBlock_ACU(stripTakeoverMetaBlock_ACU(comment));
}

function doesTakeoverSnapshotCommentHashMatch_ACU(snapshotCommentHash: string | undefined, currentComment: string): boolean {
  if (!snapshotCommentHash) return true;
  const strippedComment = stripTakeoverMetaBlock_ACU(currentComment);
  const comparableComment = stripWorldbookSkillMetaBlock_ACU(strippedComment);

  return hashUserInput_ACU(comparableComment) === snapshotCommentHash
    // Legacy snapshots created before Skill metadata was excluded from the comparable comment stored hashes that kept Skill metadata.
    || hashUserInput_ACU(strippedComment) === snapshotCommentHash;
}

function parseTakeoverMetaFromComment_ACU(comment: unknown): AgentWorldbookTakeoverMeta_ACU | null {
  const text = normalizeCommentText_ACU(comment);
  const pattern = new RegExp(AGENT_TAKEOVER_META_PATTERN_ACU.source, 'g');
  const match = pattern.exec(text);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1].trim()) as Record<string, unknown>;
    if (raw.version !== 1 || raw.kind !== 'agent_worldbook_takeover') return null;
    const selectionSignature = String(raw.selectionSignature || '').trim();
    if (!selectionSignature) return null;
    const previousKeys = Array.isArray(raw.previousKeys) ? raw.previousKeys.map(key => String(key || '').trim()).filter(Boolean) : [];
    const previousType = raw.previousType === undefined || raw.previousType === null ? undefined : String(raw.previousType);
    const commentHash = String(raw.commentHash || '').trim();
    return {
      version: 1,
      kind: 'agent_worldbook_takeover',
      selectionSignature,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
      previousEnabled: raw.previousEnabled !== false,
      previousKeys,
      previousType,
      commentHash: commentHash || undefined,
    };
  } catch {
    return null;
  }
}

function buildTakeoverMetaComment_ACU(comment: unknown, selectionSignature: string, createdAt: number, snapshotEntry: AgentWorldbookControlSnapshotEntry_ACU): string {
  const baseComment = stripTakeoverMetaBlock_ACU(comment);
  const meta: AgentWorldbookTakeoverMeta_ACU = {
    version: 1,
    kind: 'agent_worldbook_takeover',
    selectionSignature,
    createdAt,
    previousEnabled: snapshotEntry.previousEnabled !== false,
    previousKeys: Array.isArray(snapshotEntry.previousKeys) ? snapshotEntry.previousKeys : [],
    previousType: snapshotEntry.previousType,
    commentHash: snapshotEntry.commentHash,
  };
  const metaBlock = `<!-- ${AGENT_TAKEOVER_META_START_ACU}\n${JSON.stringify(meta)}\n${AGENT_TAKEOVER_META_END_ACU} -->`;
  return [baseComment, metaBlock].filter(Boolean).join('\n\n');
}

function getLegacyPlotAgentWorldbookSnapshot_ACU(): AgentWorldbookControlSnapshot_ACU {
  const snapshot = (settings_ACU.plotSettings as any)?.agentWorldbookControlSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return buildInactiveSnapshot_ACU();
  return {
    active: snapshot.active === true,
    selectionSignature: String(snapshot.selectionSignature || ''),
    createdAt: Number(snapshot.createdAt || 0),
    books: snapshot.books && typeof snapshot.books === 'object' ? snapshot.books : {},
  };
}

function clearLegacyPlotAgentWorldbookSnapshot_ACU(): boolean {
  if (!settings_ACU.plotSettings || typeof settings_ACU.plotSettings !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(settings_ACU.plotSettings, 'agentWorldbookControlSnapshot')) return false;
  delete (settings_ACU.plotSettings as any).agentWorldbookControlSnapshot;
  persistTavernSettings_ACU();
  return true;
}

export function getPlotAgentWorldbookSnapshot_ACU(): AgentWorldbookControlSnapshot_ACU {
  return getAgentWorldbookSnapshotState_ACU();
}

export function setPlotAgentWorldbookSnapshot_ACU(snapshot: AgentWorldbookControlSnapshot_ACU): void {
  setAgentWorldbookSnapshotState_ACU(snapshot);
}

export interface PreTakeoverWorldbookSnapshotResolution_ACU {
  snapshot: AgentWorldbookControlSnapshot_ACU;
  expectedSignature: string;
}

const preTakeoverSnapshotResolutionPromisesBySignature_ACU = new Map<string, Promise<PreTakeoverWorldbookSnapshotResolution_ACU>>();

async function readAndMaybeCachePlotAgentWorldbookSnapshot_ACU(
  resolvedBookNames: string[],
  selectionSignature: string,
  initialRevision: number,
): Promise<AgentWorldbookControlSnapshot_ACU> {
  const snapshot = await readPlotAgentWorldbookSnapshotFromStateOrLegacy_ACU(resolvedBookNames, selectionSignature);
  setAgentWorldbookSnapshotStateIfRevision_ACU(initialRevision, snapshot);
  return snapshot;
}

export async function refreshPlotAgentWorldbookSnapshotFromWorldbooks_ACU(): Promise<AgentWorldbookControlSnapshot_ACU> {
  const initialRevision = getAgentWorldbookSnapshotRevision_ACU();
  const resolvedBookNames = await resolveTakeoverBookNames_ACU();
  const selectionSignature = buildWorldbookSelectionSignature_ACU(resolvedBookNames);
  return readAndMaybeCachePlotAgentWorldbookSnapshot_ACU(resolvedBookNames, selectionSignature, initialRevision);
}

/** 为普通剧情与填表读取解析持久化接管前视图；expectedSignature 独立于返回快照，防止快照自签名。 */
export async function resolvePreTakeoverWorldbookSnapshot_ACU(): Promise<PreTakeoverWorldbookSnapshotResolution_ACU> {
  const initialRevision = getAgentWorldbookSnapshotRevision_ACU();
  const resolvedBookNames = await resolveTakeoverBookNames_ACU();
  const expectedSignature = buildWorldbookSelectionSignature_ACU(resolvedBookNames);
  const existingPromise = preTakeoverSnapshotResolutionPromisesBySignature_ACU.get(expectedSignature);
  if (existingPromise) return existingPromise;

  const resolutionPromise = readAndMaybeCachePlotAgentWorldbookSnapshot_ACU(
    resolvedBookNames,
    expectedSignature,
    initialRevision,
  ).then(snapshot => ({ snapshot, expectedSignature }));
  preTakeoverSnapshotResolutionPromisesBySignature_ACU.set(expectedSignature, resolutionPromise);
  const clearResolutionPromise = () => {
    if (preTakeoverSnapshotResolutionPromisesBySignature_ACU.get(expectedSignature) === resolutionPromise) {
      preTakeoverSnapshotResolutionPromisesBySignature_ACU.delete(expectedSignature);
    }
  };
  void resolutionPromise.then(
    clearResolutionPromise,
    clearResolutionPromise,
  );
  return resolutionPromise;
}

async function readPlotAgentWorldbookSnapshotFromStateOrLegacy_ACU(resolvedBookNames: string[], selectionSignature: string): Promise<AgentWorldbookControlSnapshot_ACU> {
  const state = await readAgentWorldbookStateFromWorldbooks_ACU();
  if (state.snapshot.active === true && state.snapshot.selectionSignature === selectionSignature) {
    return state.snapshot;
  }

  const snapshotBooks: Record<string, AgentWorldbookControlSnapshotEntry_ACU[]> = {};
  let createdAt = 0;
  for (const bookName of resolvedBookNames) {
    const entries = await getLorebookEntries_ACU(bookName);
    const bookSnapshot: AgentWorldbookControlSnapshotEntry_ACU[] = [];
    for (const entry of entries || []) {
      if (!hasValidWorldbookUid_ACU(entry?.uid)) continue;
      const meta = parseTakeoverMetaFromComment_ACU(entry?.comment);
      if (!meta || meta.selectionSignature !== selectionSignature) continue;
      bookSnapshot.push({
        uid: entry.uid,
        previousEnabled: meta.previousEnabled !== false,
        previousKeys: Array.isArray(meta.previousKeys) ? meta.previousKeys : [],
        previousType: meta.previousType,
        commentHash: meta.commentHash,
      });
      createdAt = Math.max(createdAt, meta.createdAt || 0);
    }
    if (bookSnapshot.length > 0) snapshotBooks[bookName] = bookSnapshot;
  }

  if (Object.keys(snapshotBooks).length > 0) {
    const migratedSnapshot = { active: true, selectionSignature, createdAt: createdAt || Date.now(), books: snapshotBooks };
    try {
      await writeAgentWorldbookStateToWorldbook_ACU({ snapshot: migratedSnapshot });
    } catch (error) {
      logWarn_ACU('[Agent世界书] 迁移旧接管快照到独立状态条目失败。', error);
    }
    return migratedSnapshot;
  }

  const legacySnapshot = getLegacyPlotAgentWorldbookSnapshot_ACU();
  const snapshot = legacySnapshot.active === true && legacySnapshot.selectionSignature === selectionSignature
    ? legacySnapshot
    : buildInactiveSnapshot_ACU(selectionSignature);
  return snapshot;
}

async function readPlotAgentWorldbookStateSnapshotOnly_ACU(selectionSignature: string): Promise<AgentWorldbookControlSnapshot_ACU> {
  const state = await readAgentWorldbookStateFromWorldbooks_ACU();
  return state.snapshot.active === true && state.snapshot.selectionSignature === selectionSignature ? state.snapshot : buildInactiveSnapshot_ACU(selectionSignature);
}

export function isWorldbookTakeoverActive_ACU(): boolean {
  return getPlotAgentWorldbookSnapshot_ACU().active === true;
}

async function resolveTakeoverBookNames_ACU(): Promise<string[]> {
  return normalizeBookNamesForTakeover_ACU(await resolveAgentWorldbookScopeBookNames_ACU());
}

function buildSnapshotEntry_ACU(entry: Record<string, any>): AgentWorldbookControlSnapshotEntry_ACU | null {
  if (!hasValidWorldbookUid_ACU(entry?.uid)) return null;
  const previousType = entry?.type === undefined || entry?.type === null ? undefined : String(entry.type);
  const comment = normalizeTakeoverComparableComment_ACU(entry?.comment);
  return {
    uid: entry.uid,
    previousEnabled: entry.enabled !== false,
    previousKeys: getWorldbookEntryKeywordsForSkillify_ACU(entry),
    previousType,
    commentHash: hashUserInput_ACU(comment),
  };
}

async function collectTakeoverCandidates_ACU(bookNames: string[]): Promise<{
  snapshotBooks: Record<string, AgentWorldbookControlSnapshotEntry_ACU[]>;
  updates: AgentWorldbookTakeoverEntryUpdate_ACU[];
}> {
  const snapshotBooks: Record<string, AgentWorldbookControlSnapshotEntry_ACU[]> = {};
  const updates: AgentWorldbookTakeoverEntryUpdate_ACU[] = [];

  for (const bookName of bookNames) {
    const entries = await getLorebookEntries_ACU(bookName);
    const bookSnapshot: AgentWorldbookControlSnapshotEntry_ACU[] = [];
    for (const entry of entries || []) {
      if (!isWorldbookEntrySkillifyCandidate_ACU(entry)) continue;
      if (!hasUsableWorldbookSkillMeta_ACU(entry?.comment)) continue;
      const snapshotEntry = buildSnapshotEntry_ACU(entry);
      if (!snapshotEntry) continue;
      bookSnapshot.push(snapshotEntry);
      updates.push({ bookName, uid: snapshotEntry.uid });
    }
    if (bookSnapshot.length > 0) snapshotBooks[bookName] = bookSnapshot;
  }

  return { snapshotBooks, updates };
}

async function reconcileExistingTakeoverSnapshotWithSkillMeta_ACU(
  existingSnapshot: AgentWorldbookControlSnapshot_ACU,
  selectionSignature: string,
): Promise<{
  snapshot: AgentWorldbookControlSnapshot_ACU;
  restored: number;
  skipped: number;
  failed: number;
  pruned: number;
}> {
  const keptBooks: Record<string, AgentWorldbookControlSnapshotEntry_ACU[]> = {};
  const staleBooks: Record<string, AgentWorldbookControlSnapshotEntry_ACU[]> = {};
  let pruned = 0;

  for (const [bookName, snapshotEntries] of Object.entries(existingSnapshot.books || {})) {
    const normalizedBookName = String(bookName || '').trim();
    const entriesToCheck = Array.isArray(snapshotEntries) ? snapshotEntries : [];
    if (!normalizedBookName || entriesToCheck.length === 0) continue;
    const currentEntries = await getLorebookEntries_ACU(normalizedBookName);
    const currentByUid = new Map((currentEntries || []).map(entry => [String(entry?.uid), entry]));
    for (const snapshotEntry of entriesToCheck) {
      if (!hasValidWorldbookUid_ACU(snapshotEntry?.uid)) continue;
      const currentEntry = currentByUid.get(String(snapshotEntry.uid));
      const stillHasSkillMeta = currentEntry ? hasUsableWorldbookSkillMeta_ACU(currentEntry?.comment) : false;
      if (stillHasSkillMeta) {
        if (!keptBooks[normalizedBookName]) keptBooks[normalizedBookName] = [];
        keptBooks[normalizedBookName].push(snapshotEntry);
        continue;
      }
      if (!staleBooks[normalizedBookName]) staleBooks[normalizedBookName] = [];
      staleBooks[normalizedBookName].push(snapshotEntry);
      pruned += 1;
    }
  }

  const staleSnapshot = pruned > 0
    ? buildActiveSnapshot_ACU(selectionSignature, staleBooks)
    : buildInactiveSnapshot_ACU(selectionSignature);
  const restoreResult = pruned > 0
    ? await restoreSnapshotEntries_ACU(staleSnapshot)
    : { restored: 0, skipped: 0, failed: 0 };
  const hasKeptEntries = Object.values(keptBooks).some(entries => Array.isArray(entries) && entries.length > 0);
  return {
    snapshot: hasKeptEntries ? buildActiveSnapshot_ACU(selectionSignature, keptBooks) : buildInactiveSnapshot_ACU(selectionSignature),
    restored: restoreResult.restored,
    skipped: restoreResult.skipped,
    failed: restoreResult.failed,
    pruned,
  };
}

async function disableTakeoverCandidates_ACU(
  snapshotBooks: Record<string, AgentWorldbookControlSnapshotEntry_ACU[]>,
): Promise<{ disabled: number; failed: number }> {
  const updatesByBook = new Map<string, Set<string>>();
  for (const [bookName, snapshotEntries] of Object.entries(snapshotBooks || {})) {
    if (!bookName) continue;
    const uidSet = new Set<string>();
    for (const snapshotEntry of Array.isArray(snapshotEntries) ? snapshotEntries : []) {
      if (!hasValidWorldbookUid_ACU(snapshotEntry?.uid)) continue;
      uidSet.add(String(snapshotEntry.uid));
    }
    if (uidSet.size === 0) continue;
    if (!updatesByBook.has(bookName)) updatesByBook.set(bookName, new Set());
    for (const uid of uidSet.keys()) updatesByBook.get(bookName)!.add(uid);
  }

  let disabled = 0;
  let failed = 0;
  for (const [bookName, uidSet] of updatesByBook.entries()) {
    try {
      const entries = await getLorebookEntries_ACU(bookName);
      const patchEntries = (entries || [])
        .filter(entry => uidSet.has(String(entry?.uid)))
        .map(entry => ({ uid: entry.uid, enabled: false }));
      if (patchEntries.length === 0) continue;
      await setLorebookEntries_ACU(bookName, patchEntries);
      disabled += patchEntries.length;
    } catch (error) {
      failed += uidSet.size;
    }
  }
  return { disabled, failed };
}

async function restoreSnapshotEntries_ACU(snapshot: AgentWorldbookControlSnapshot_ACU): Promise<{ restored: number; skipped: number; failed: number }> {
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  for (const [bookName, snapshotEntries] of Object.entries(snapshot.books || {})) {
    const normalizedBookName = String(bookName || '').trim();
    const entriesToRestore = Array.isArray(snapshotEntries) ? snapshotEntries : [];
    if (!normalizedBookName || entriesToRestore.length === 0) continue;
    try {
      const currentEntries = await getLorebookEntries_ACU(normalizedBookName);
      const currentByUid = new Map((currentEntries || []).map(entry => [String(entry?.uid), entry]));
      const patches: any[] = [];
      let restoredInBook = 0;
      for (const snapshotEntry of entriesToRestore) {
        if (!hasValidWorldbookUid_ACU(snapshotEntry?.uid)) {
          logWarn_ACU(
            `[Agent世界书] 跳过恢复世界书条目：${normalizedBookName} 中存在无效 uid。`,
            snapshotEntry?.uid,
          );
          skipped += 1;
          continue;
        }
        const currentEntry = currentByUid.get(String(snapshotEntry.uid));
        if (!currentEntry) {
          logWarn_ACU(`[Agent世界书] 跳过恢复世界书条目：${normalizedBookName}#${snapshotEntry.uid} 当前条目不存在。`);
          skipped += 1;
          continue;
        }
        const currentComment = typeof currentEntry.comment === 'string' ? currentEntry.comment : '';
        const strippedComment = stripTakeoverMetaBlock_ACU(currentComment);
        if (!doesTakeoverSnapshotCommentHashMatch_ACU(snapshotEntry.commentHash, currentComment)) {
          logWarn_ACU(
            `[Agent世界书] 跳过恢复世界书条目：${normalizedBookName}#${snapshotEntry.uid} comment 已变化，避免覆盖用户修改。`,
          );
          if (strippedComment !== currentComment) patches.push({ uid: snapshotEntry.uid, comment: strippedComment });
          skipped += 1;
          continue;
        }
        patches.push({
          uid: snapshotEntry.uid,
          comment: strippedComment,
          enabled: snapshotEntry.previousEnabled !== false,
          keys: Array.isArray(snapshotEntry.previousKeys) ? snapshotEntry.previousKeys : [],
          type: snapshotEntry.previousType,
        });
        restoredInBook += 1;
      }
      if (patches.length > 0) {
        await setLorebookEntries_ACU(normalizedBookName, patches);
        restored += restoredInBook;
      }
    } catch (error) {
      logWarn_ACU(`[Agent世界书] 恢复世界书条目失败：${normalizedBookName}`, error);
      failed += entriesToRestore.length;
    }
  }

  return { restored, skipped, failed };
}

export async function writeFinalGenerationGreenlights_ACU(greenlights: unknown): Promise<boolean> {
  const snapshot = getPlotAgentWorldbookSnapshot_ACU();
  const snapshotUidSetByBook = buildSnapshotUidSetByBook_ACU(snapshot);
  if (snapshotUidSetByBook.size === 0) return false;

  const normalizedGreenlights = normalizeAgentWorldbookRefs_ACU(greenlights);
  const allowedKeySet = buildAllowedFinalGreenlightKeySet_ACU(normalizedGreenlights, snapshotUidSetByBook);

  const patched = await patchSnapshotEntries_ACU(snapshotUidSetByBook, (bookName, entry) => {
    if (!hasValidWorldbookUid_ACU(entry?.uid)) return null;
    const isAllowed = allowedKeySet.has(buildFinalGreenlightKey_ACU(bookName, entry.uid));
    if (isAllowed) {
      const snapshotEntry = getSnapshotEntryForBookAndUid_ACU(snapshot, bookName, entry.uid);
      const liveKeys = getWorldbookEntryKeywordsForSkillify_ACU(entry);
      const previousKeys = Array.isArray(snapshotEntry?.previousKeys) ? snapshotEntry.previousKeys : [];
      const shouldRestoreLegacyClearedKeys = liveKeys.length === 0
        && previousKeys.length > 0
        && !!snapshotEntry?.commentHash
        && doesTakeoverSnapshotCommentHashMatch_ACU(snapshotEntry.commentHash, String(entry?.comment || ''));
      if (isFinalGenerationBlueLightEntry_ACU(entry) && !shouldRestoreLegacyClearedKeys) return null;
      return {
        uid: entry.uid,
        ...(isFinalGenerationBlueLightEntry_ACU(entry) ? {} : { enabled: true, type: 'constant' }),
        ...(shouldRestoreLegacyClearedKeys ? { keys: [...previousKeys] } : {}),
      };
    }
    if (entry.enabled === false) return null;
    return { uid: entry.uid, enabled: false };
  });

  return patched > 0;
}

export async function readFinalGenerationGreenlights_ACU(): Promise<AgentWorldbookFinalGreenlightRef_ACU[]> {
  const snapshot = getPlotAgentWorldbookSnapshot_ACU();
  const snapshotUidSetByBook = buildSnapshotUidSetByBook_ACU(snapshot);
  const greenlights: AgentWorldbookFinalGreenlightRef_ACU[] = [];
  const seen = new Set<string>();

  for (const [bookName, uidSet] of snapshotUidSetByBook.entries()) {
    const entries = await getLorebookEntries_ACU(bookName);
    for (const entry of entries || []) {
      if (!hasValidWorldbookUid_ACU(entry?.uid) || !uidSet.has(String(entry.uid)) || !isFinalGenerationBlueLightEntry_ACU(entry)) continue;
      const key = buildFinalGreenlightKey_ACU(bookName, entry.uid);
      if (seen.has(key)) continue;
      seen.add(key);
      greenlights.push({ bookName, uid: entry.uid });
    }
  }

  return greenlights;
}

export async function clearFinalGenerationGreenlights_ACU(): Promise<number> {
  const snapshot = await refreshPlotAgentWorldbookSnapshotFromWorldbooks_ACU();
  const snapshotUidSetByBook = buildSnapshotUidSetByBook_ACU(snapshot);
  const patched = await patchSnapshotEntries_ACU(snapshotUidSetByBook, (_bookName, entry) => {
    if (!isFinalGenerationBlueLightEntry_ACU(entry)) return null;
    return { uid: entry.uid, enabled: false };
  });
  const resolvedBookNames = await resolveTakeoverBookNames_ACU();
  const deletedLegacyEntries = await deleteInternalEntriesByComment_ACU(resolvedBookNames, AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU);
  return patched + deletedLegacyEntries;
}

export async function takeoverWorldbookGreenlights_ACU(): Promise<AgentWorldbookTakeoverResult_ACU> {
  const availability = await resolveAgentWorldbookFilterAvailability_ACU();
  const resolvedBookNames = availability.bookNames;
  const selectionSignature = buildWorldbookSelectionSignature_ACU(resolvedBookNames);

  if (!availability.available) {
    const snapshot = buildInactiveSnapshot_ACU(selectionSignature);
    setPlotAgentWorldbookSnapshot_ACU(snapshot);
    return {
      updated: false,
      reason: availability.reason,
      bookNames: resolvedBookNames,
      selectionSignature,
      totalCandidates: 0,
      disabled: 0,
      failed: 0,
      snapshot,
      updates: [],
    };
  }

  const { snapshotBooks, updates } = await collectTakeoverCandidates_ACU(resolvedBookNames);
  const totalCandidates = updates.length || Object.values(snapshotBooks || {}).reduce((sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0), 0);
  const existingSnapshot = getPlotAgentWorldbookSnapshot_ACU();
  const shouldKeepExistingActiveSnapshot = totalCandidates === 0 && existingSnapshot.active === true && existingSnapshot.selectionSignature === selectionSignature;
  const reconciledExistingSnapshot = shouldKeepExistingActiveSnapshot
    ? await reconcileExistingTakeoverSnapshotWithSkillMeta_ACU(existingSnapshot, selectionSignature)
    : { snapshot: buildInactiveSnapshot_ACU(selectionSignature), restored: 0, skipped: 0, failed: 0, pruned: 0 };
  const snapshot = totalCandidates > 0
    ? buildActiveSnapshot_ACU(selectionSignature, snapshotBooks)
    : (shouldKeepExistingActiveSnapshot ? reconciledExistingSnapshot.snapshot : buildInactiveSnapshot_ACU(selectionSignature));

  let stateWriteFailed = 0;
  if (snapshot.active === true || reconciledExistingSnapshot.pruned > 0) {
    try {
      const stateWriteResult = await writeAgentWorldbookStateToWorldbook_ACU({ snapshot });
      if (!stateWriteResult.updated) stateWriteFailed = totalCandidates > 0 ? totalCandidates : reconciledExistingSnapshot.pruned;
    } catch (error) {
      logWarn_ACU('[Agent世界书] 写入独立接管快照失败，已阻止本次物理禁用以避免无法恢复。', error);
      stateWriteFailed = totalCandidates > 0 ? totalCandidates : reconciledExistingSnapshot.pruned;
    }
  }

  const { disabled, failed } = totalCandidates > 0 && stateWriteFailed === 0
    ? await disableTakeoverCandidates_ACU(snapshotBooks)
    : { disabled: 0, failed: 0 };
  setPlotAgentWorldbookSnapshot_ACU(stateWriteFailed > 0
    ? buildInactiveSnapshot_ACU(selectionSignature)
    : snapshot);
  const totalFailed = failed + stateWriteFailed + reconciledExistingSnapshot.failed;
  const reconciledChanged = reconciledExistingSnapshot.restored > 0 || reconciledExistingSnapshot.skipped > 0 || reconciledExistingSnapshot.failed > 0 || reconciledExistingSnapshot.pruned > 0;

  return {
    updated: disabled > 0 || totalFailed > 0 || reconciledChanged,
    reason: stateWriteFailed > 0
      ? 'snapshot_state_write_failed'
      : (totalCandidates > 0
        ? 'native_worldbook_trigger_disabled'
        : (reconciledExistingSnapshot.pruned > 0
          ? 'native_worldbook_trigger_snapshot_reconciled'
          : (shouldKeepExistingActiveSnapshot
          ? 'native_worldbook_trigger_already_disabled'
          : 'empty_candidates'))),
    bookNames: resolvedBookNames,
    selectionSignature,
    totalCandidates,
    disabled,
    failed: totalFailed,
    snapshot,
    updates,
  };
}

export async function restoreWorldbookGreenlights_ACU(options: {
  cleanupMode?: 'full' | 'restore_only';
} = {}): Promise<AgentWorldbookRestoreResult_ACU> {
  const cleanupMode = options.cleanupMode || 'full';
  const resolvedBookNames = await resolveTakeoverBookNames_ACU();
  const selectionSignature = buildWorldbookSelectionSignature_ACU(resolvedBookNames);
  const stateSnapshot = await readPlotAgentWorldbookStateSnapshotOnly_ACU(selectionSignature);
  const worldbookSnapshot = stateSnapshot.active === true ? stateSnapshot : await readPlotAgentWorldbookSnapshotFromStateOrLegacy_ACU(resolvedBookNames, selectionSignature);
  const legacySnapshot = getLegacyPlotAgentWorldbookSnapshot_ACU();
  const shouldUseWorldbookSnapshot = stateSnapshot.active === true && stateSnapshot.selectionSignature === selectionSignature;
  const shouldUseLegacySnapshot = !shouldUseWorldbookSnapshot && legacySnapshot.active === true && legacySnapshot.selectionSignature === selectionSignature;
  const snapshot = shouldUseWorldbookSnapshot
    ? stateSnapshot
    : (shouldUseLegacySnapshot ? legacySnapshot : worldbookSnapshot);
  const shouldRestoreSnapshot = snapshot.active === true && snapshot.selectionSignature === selectionSignature;
  const restoreResult = shouldRestoreSnapshot
    ? await restoreSnapshotEntries_ACU(snapshot)
    : { restored: 0, skipped: 0, failed: 0 };
  const canCleanupPersistentSnapshot = cleanupMode === 'full' && shouldRestoreSnapshot && restoreResult.skipped === 0 && restoreResult.failed === 0;
  const canClearLegacySnapshot = cleanupMode === 'full' && shouldUseLegacySnapshot && restoreResult.skipped === 0 && restoreResult.failed === 0;
  const deletedFinalGreenlights = await deleteInternalEntriesByComment_ACU(resolvedBookNames, AGENT_FINAL_GENERATION_GREENLIGHT_COMMENT_ACU);
  const deletedSnapshots = cleanupMode === 'full' ? await deleteInternalEntriesByComment_ACU(resolvedBookNames, AGENT_WORLDBOOK_SNAPSHOT_COMMENT_ACU) : 0;
  const deletedStateEntries = canCleanupPersistentSnapshot ? await deleteAgentWorldbookStateEntry_ACU() : 0;
  const legacySnapshotCleared = canClearLegacySnapshot && clearLegacyPlotAgentWorldbookSnapshot_ACU() ? 1 : 0;
  const cleaned = deletedFinalGreenlights + deletedSnapshots + deletedStateEntries + legacySnapshotCleared;
  const changed = restoreResult.restored + restoreResult.failed + cleaned;
  const shouldKeepSnapshotCache = shouldRestoreSnapshot && (cleanupMode === 'restore_only' || restoreResult.skipped > 0 || restoreResult.failed > 0);
  setPlotAgentWorldbookSnapshot_ACU(shouldKeepSnapshotCache
    ? snapshot
    : buildInactiveSnapshot_ACU(selectionSignature));

  return {
    updated: changed > 0,
    reason: restoreResult.restored > 0
      ? 'native_worldbook_trigger_restored'
      : (restoreResult.failed > 0
        ? 'native_worldbook_trigger_restore_failed'
      : (restoreResult.skipped > 0
        ? 'native_worldbook_trigger_restore_skipped'
        : (cleaned > 0 ? 'legacy_artifacts_cleaned' : 'no_active_snapshot'))),
    bookNames: resolvedBookNames,
    selectionSignature,
    restored: restoreResult.restored,
    skipped: restoreResult.skipped,
    failed: restoreResult.failed,
    updates: [],
  };
}
