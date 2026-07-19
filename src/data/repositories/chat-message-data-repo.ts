/**
 * data/repositories/chat-message-data-repo.ts — 消息级表格数据 CRUD
 *
 * 封装所有对 message.TavernDB_ACU_* 字段的底层读写操作。
 * 纯数据层：不包含业务逻辑（合并策略、优先级判断等在 service/ 层）。
 *
 * 设计决策：
 * 1. 纯函数导出（与 isolation-repo.ts、profile-repo.ts 风格一致）
 * 2. 隔离配置作为参数传入（不引用 service 层的 state-manager）
 * 3. 不包含业务逻辑（不做合并策略、不做优先级判断，只做字段级 CRUD）
 * 4. 统一处理 string/object 格式（IsolatedData 可能是 JSON 字符串）
 */

import { safeJsonParse_ACU } from '../../shared/json-helpers';
import type { Sheet_ACU } from '../../shared/models/table-data';
import type {
    IsolationTagData_ACU,
    IsolatedDataContainer_ACU,
    LegacyTableContainer_ACU,
    IsolationConfig_ACU,
} from '../models/chat-message-data';

// ════════════════════════════════════════════════════════════════
// 内部辅助
// ════════════════════════════════════════════════════════════════

/**
 * 将 IsolatedData 字段解析为对象（处理 string/object 两种格式）。
 * 如果字段不存在或解析失败，返回 null。
 */
function parseIsolatedDataField(msg: any): IsolatedDataContainer_ACU | null {
    const raw = msg?.TavernDB_ACU_IsolatedData;
    if (!raw) return null;
    if (typeof raw === 'string') {
        const parsed = safeJsonParse_ACU(raw, null);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            ? parsed as IsolatedDataContainer_ACU
            : null;
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as IsolatedDataContainer_ACU;
    }
    return null;
}

/**
 * 检查对象中是否还有 sheet_ 开头的键。
 */
function hasAnySheetKey(obj: any): boolean {
    return obj && typeof obj === 'object' && Object.keys(obj).some(k => k.startsWith('sheet_'));
}

/**
 * 安全深拷贝。
 */
function safeClone<T>(obj: T): T {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return obj;
    }
}

/**
 * 从数组中移除指定元素，返回新数组和是否发生变化。
 */
function removeFromArray(arr: string[], key: string): { result: string[]; changed: boolean } {
    if (!Array.isArray(arr) || arr.length === 0) return { result: arr || [], changed: false };
    const next = arr.filter(x => x !== key);
    return { result: next, changed: next.length !== arr.length };
}

function isObjectRecord_ACU(value: any): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deleteSheetKeysFromRecord_ACU(record: any, sheetKeys: Set<string>): boolean {
    if (!isObjectRecord_ACU(record)) return false;
    let changed = false;
    sheetKeys.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
            delete record[key];
            changed = true;
        }
    });
    return changed;
}

function filterSheetKeyArray_ACU(value: any, sheetKeys: Set<string>): { value: any; changed: boolean } {
    if (!Array.isArray(value)) return { value, changed: false };
    const next = value.filter(item => !sheetKeys.has(item));
    return { value: next, changed: next.length !== value.length };
}

function purgeEventSheetKeysV2_ACU(eventLike: any, sheetKeys: Set<string>): boolean {
    if (!isObjectRecord_ACU(eventLike)) return false;
    let changed = false;
    ['filledSheetKeys', 'changedSheetKeys', 'groupKeys'].forEach(field => {
        const result = filterSheetKeyArray_ACU(eventLike[field], sheetKeys);
        if (result.changed) {
            eventLike[field] = result.value;
            changed = true;
        }
    });
    return changed;
}

const RUNTIME_REVISION_SNAPSHOT_PREFIX_V2_ACU = 'runtime-v1:';

function normalizeSqlIdentifierForPurge_ACU(value: any): string {
    return typeof value === 'string' ? value.trim().replace(/^[`'"\[]|[`'"\]]$/g, '').toLowerCase() : '';
}

function parseSqlDDLTableNameForPurge_ACU(ddl: any): string {
    if (typeof ddl !== 'string') return '';
    const match = ddl.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|'([^']+)'|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/i);
    return normalizeSqlIdentifierForPurge_ACU(match?.slice(1).find(Boolean));
}

function collectSqlTableNameCandidatesFromSheetForPurge_ACU(sheetKey: string, sheet: any, targetNames: Set<string>): void {
    const sheetKeyName = normalizeSqlIdentifierForPurge_ACU(sheetKey);
    if (sheetKeyName) targetNames.add(sheetKeyName);
    if (!isObjectRecord_ACU(sheet)) return;
    const uid = normalizeSqlIdentifierForPurge_ACU(sheet.uid);
    const name = normalizeSqlIdentifierForPurge_ACU(sheet.name);
    const ddlName = parseSqlDDLTableNameForPurge_ACU(sheet.sourceData?.ddl);
    if (uid) targetNames.add(uid);
    if (name) targetNames.add(name);
    if (ddlName) targetNames.add(ddlName);
}

function collectSqlTargetTableNamesFromRecordForPurge_ACU(record: any, sheetKeys: Set<string>, targetNames: Set<string>): void {
    if (!isObjectRecord_ACU(record)) return;
    sheetKeys.forEach(sheetKey => {
        if (Object.prototype.hasOwnProperty.call(record, sheetKey)) {
            collectSqlTableNameCandidatesFromSheetForPurge_ACU(sheetKey, record[sheetKey], targetNames);
        }
    });
}

function collectSqlTargetTableNamesFromOperationForPurge_ACU(operation: any, sheetKeys: Set<string>, targetNames: Set<string>): void {
    if (!isObjectRecord_ACU(operation)) return;
    if (operation.kind === 'sheet_replace' && sheetKeys.has(operation.sheetKey)) {
        collectSqlTableNameCandidatesFromSheetForPurge_ACU(operation.sheetKey, operation.sheet, targetNames);
        return;
    }
    if (operation.kind === 'data_replace') {
        collectSqlTargetTableNamesFromRecordForPurge_ACU(operation.data, sheetKeys, targetNames);
    }
}

export function collectSqlTargetTableNamesFromStorageFrameV2_ACU(frame: any, sheetKeys: Set<string>): Set<string> {
    const targetNames = new Set<string>();
    sheetKeys.forEach(sheetKey => {
        const normalizedSheetKey = normalizeSqlIdentifierForPurge_ACU(sheetKey);
        if (normalizedSheetKey) targetNames.add(normalizedSheetKey);
    });
    collectSqlTargetTableNamesFromRecordForPurge_ACU(frame?.checkpoint?.data, sheetKeys, targetNames);
    if (isObjectRecord_ACU(frame?.perSheetCheckpoints)) {
        sheetKeys.forEach(sheetKey => {
            const checkpoint = frame.perSheetCheckpoints[sheetKey];
            if (!isObjectRecord_ACU(checkpoint)) return;
            collectSqlTableNameCandidatesFromSheetForPurge_ACU(sheetKey, checkpoint.data, targetNames);
        });
    }
    if (Array.isArray(frame?.logEntries)) {
        frame.logEntries.forEach((entry: any) => {
            if (!isObjectRecord_ACU(entry)) return;
            if (Array.isArray(entry.operations)) {
                entry.operations.forEach(operation => collectSqlTargetTableNamesFromOperationForPurge_ACU(operation, sheetKeys, targetNames));
            }
            if (Array.isArray(entry.patches)) {
                entry.patches.forEach(patch => collectSqlTargetTableNamesFromOperationForPurge_ACU(patch, sheetKeys, targetNames));
            }
        });
    }
    return targetNames;
}

interface SqlPurgeToken_ACU {
    value: string;
    quoted: boolean;
}

interface SqlPurgeTokenizeResult_ACU {
    tokens: SqlPurgeToken_ACU[];
    reliable: boolean;
}

function tokenizeTopLevelSqlForPurge_ACU(statement: string): SqlPurgeTokenizeResult_ACU {
    const tokens: SqlPurgeToken_ACU[] = [];
    let depth = 0;
    let index = 0;
    let reliable = true;
    while (index < statement.length) {
        const char = statement[index];
        const next = statement[index + 1];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (char === '-' && next === '-') {
            index += 2;
            while (index < statement.length && statement[index] !== '\n' && statement[index] !== '\r') index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            index += 2;
            while (index < statement.length && !(statement[index] === '*' && statement[index + 1] === '/')) index += 1;
            if (index >= statement.length) {
                reliable = false;
                break;
            }
            index += 2;
            continue;
        }
        if (char === '(') {
            depth += 1;
            index += 1;
            continue;
        }
        if (char === ')') {
            if (depth === 0) reliable = false;
            depth = Math.max(0, depth - 1);
            index += 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`' || char === '[') {
            const closing = char === '[' ? ']' : char;
            let value = '';
            let closed = false;
            index += 1;
            while (index < statement.length) {
                const current = statement[index];
                if (current === '\\' && index + 1 < statement.length) {
                    value += statement[index + 1];
                    index += 2;
                    continue;
                }
                if (current === closing) {
                    if (statement[index + 1] === closing) {
                        value += closing;
                        index += 2;
                        continue;
                    }
                    index += 1;
                    closed = true;
                    break;
                }
                value += current;
                index += 1;
            }
            if (!closed) {
                reliable = false;
                break;
            }
            if (depth === 0) tokens.push({ value, quoted: true });
            continue;
        }
        if (char === '.') {
            if (depth === 0) tokens.push({ value: '.', quoted: false });
            index += 1;
            continue;
        }
        if (/[A-Za-z_]/.test(char)) {
            const start = index;
            index += 1;
            while (index < statement.length && /[A-Za-z0-9_]/.test(statement[index])) index += 1;
            if (depth === 0) tokens.push({ value: statement.slice(start, index), quoted: false });
            continue;
        }
        index += 1;
    }
    return { tokens, reliable: reliable && depth === 0 };
}

function findTopLevelSqlKeywordForPurge_ACU(tokens: SqlPurgeToken_ACU[], keyword: string, startIndex = 0): number {
    for (let index = startIndex; index < tokens.length; index++) {
        if (!tokens[index].quoted && tokens[index].value.toUpperCase() === keyword) return index;
    }
    return -1;
}

interface SqlPurgeTableTokenResult_ACU {
    names: string[];
    nextIndex: number;
}

function readSqlTableTokenForPurge_ACU(tokens: SqlPurgeToken_ACU[], index: number): SqlPurgeTableTokenResult_ACU {
    const token = tokens[index];
    if (!token || (!token.quoted && token.value === '.')) return { names: [], nextIndex: index };
    const tableName = normalizeSqlIdentifierForPurge_ACU(token.value);
    if (!tableName) return { names: [], nextIndex: index };

    const separator = tokens[index + 1];
    const qualifiedTableToken = tokens[index + 2];
    if (!separator?.quoted && separator?.value === '.' && qualifiedTableToken
        && (qualifiedTableToken.quoted || qualifiedTableToken.value !== '.')) {
        const qualifiedTableName = normalizeSqlIdentifierForPurge_ACU(qualifiedTableToken.value);
        if (qualifiedTableName) {
            return {
                names: [`${tableName}.${qualifiedTableName}`, qualifiedTableName],
                nextIndex: index + 3,
            };
        }
    }

    return { names: [tableName], nextIndex: index + 1 };
}

function extractMutatedSqlTableNamesForPurge_ACU(statement: any): string[] {
    if (typeof statement !== 'string') return [];
    const tokenized = tokenizeTopLevelSqlForPurge_ACU(statement);
    if (!tokenized.reliable) return [];
    const tokens = tokenized.tokens;
    const conflictActions = new Set(['ROLLBACK', 'ABORT', 'REPLACE', 'FAIL', 'IGNORE']);
    const mutationKeywords = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE', 'ALTER']);
    const firstKeyword = tokens.find(token => !token.quoted)?.value.toUpperCase();
    if (!firstKeyword || (!mutationKeywords.has(firstKeyword) && firstKeyword !== 'WITH')) return [];
    const startIndex = firstKeyword === 'WITH' ? 1 : 0;
    for (let index = startIndex; index < tokens.length; index++) {
        if (tokens[index].quoted) continue;
        const keyword = tokens[index].value.toUpperCase();
        if (!mutationKeywords.has(keyword)) continue;
        if (keyword === 'INSERT') {
            const intoIndex = findTopLevelSqlKeywordForPurge_ACU(tokens, 'INTO', index + 1);
            return intoIndex >= 0 ? readSqlTableTokenForPurge_ACU(tokens, intoIndex + 1).names : [];
        }
        if (keyword === 'REPLACE') {
            const intoIndex = findTopLevelSqlKeywordForPurge_ACU(tokens, 'INTO', index + 1);
            return intoIndex >= 0 ? readSqlTableTokenForPurge_ACU(tokens, intoIndex + 1).names : [];
        }
        if (keyword === 'UPDATE') {
            let tableIndex = index + 1;
            if (!tokens[tableIndex]?.quoted && tokens[tableIndex]?.value.toUpperCase() === 'OR') {
                const action = tokens[tableIndex + 1];
                if (!action || action.quoted || !conflictActions.has(action.value.toUpperCase())) return [];
                tableIndex += 2;
            }
            return readSqlTableTokenForPurge_ACU(tokens, tableIndex).names;
        }
        if (keyword === 'DELETE') {
            const fromIndex = findTopLevelSqlKeywordForPurge_ACU(tokens, 'FROM', index + 1);
            return fromIndex >= 0 ? readSqlTableTokenForPurge_ACU(tokens, fromIndex + 1).names : [];
        }
        if (keyword === 'ALTER') {
            const tableIndex = findTopLevelSqlKeywordForPurge_ACU(tokens, 'TABLE', index + 1);
            if (tableIndex < 0) return [];
            const sourceTable = readSqlTableTokenForPurge_ACU(tokens, tableIndex + 1);
            const renameToken = tokens[sourceTable.nextIndex];
            const toToken = tokens[sourceTable.nextIndex + 1];
            if (!renameToken?.quoted && renameToken?.value.toUpperCase() === 'RENAME'
                && !toToken?.quoted && toToken?.value.toUpperCase() === 'TO') {
                const targetTable = readSqlTableTokenForPurge_ACU(tokens, sourceTable.nextIndex + 2);
                return [...sourceTable.names, ...targetTable.names];
            }
            return sourceTable.names;
        }
    }
    return [];
}

function purgeRuntimeRevisionSnapshotSheetKeysV2_ACU(value: any, sheetKeys: Set<string>): { value: any; changed: boolean } {
    if (typeof value !== 'string' || !value.startsWith(RUNTIME_REVISION_SNAPSHOT_PREFIX_V2_ACU)) {
        return { value, changed: false };
    }

    let snapshot: any;
    try {
        snapshot = JSON.parse(value.slice(RUNTIME_REVISION_SNAPSHOT_PREFIX_V2_ACU.length));
    } catch {
        return { value, changed: false };
    }

    if (!isObjectRecord_ACU(snapshot) || !isObjectRecord_ACU(snapshot.sheets)) {
        return { value, changed: false };
    }

    if (!deleteSheetKeysFromRecord_ACU(snapshot.sheets, sheetKeys)) {
        return { value, changed: false };
    }

    return {
        value: `${RUNTIME_REVISION_SNAPSHOT_PREFIX_V2_ACU}${JSON.stringify(snapshot)}`,
        changed: true,
    };
}

function purgeManualRefillProgressV2_ACU(progress: any, sheetKeys: Set<string>): boolean {
    if (!isObjectRecord_ACU(progress)) return false;
    let changed = false;
    const selected = filterSheetKeyArray_ACU(progress.selectedSheetKeys, sheetKeys);
    if (selected.changed) {
        progress.selectedSheetKeys = selected.value;
        changed = true;
    }
    if (deleteSheetKeysFromRecord_ACU(progress.completedSheetMessageIndexByKey, sheetKeys)) {
        changed = true;
    }
    if (Array.isArray(progress.selectedSheetKeys) && progress.selectedSheetKeys.length === 0) {
        // 不留下无目标表、无法继续或恢复的幽灵运行记录。
        progress.status = 'complete';
        if (typeof progress.lastError === 'string') delete progress.lastError;
        changed = true;
    }
    return changed;
}

function hasRemainingDataReplacePayload_ACU(data: any): boolean {
    return isObjectRecord_ACU(data) && Object.keys(data).length > 0;
}

function purgeSqlBatchOperationV2_ACU(operation: any, targetSqlTableNames: Set<string>): { operation: any | null; changed: boolean } {
    if (!Array.isArray(operation.statements) || targetSqlTableNames.size === 0) {
        return { operation, changed: false };
    }
    const keepIndices: number[] = [];
    operation.statements.forEach((statement: any, index: number) => {
        const mutatedTables = extractMutatedSqlTableNamesForPurge_ACU(statement);
        const touchesTarget = mutatedTables.some(tableName => targetSqlTableNames.has(tableName));
        if (!touchesTarget) keepIndices.push(index);
    });
    if (keepIndices.length === operation.statements.length) return { operation, changed: false };
    if (keepIndices.length === 0) return { operation: null, changed: true };
    const nextOperation: any = {
        ...operation,
        statements: keepIndices.map(index => operation.statements[index]),
    };
    if (Array.isArray(operation.params)) {
        nextOperation.params = keepIndices.map(index => operation.params[index]);
    }
    return { operation: nextOperation, changed: true };
}

function purgeOperationV2_ACU(operation: any, sheetKeys: Set<string>, targetSqlTableNames: Set<string>): { operation: any | null; changed: boolean } {
    if (!isObjectRecord_ACU(operation)) return { operation, changed: false };

    if (
        (operation.kind === 'sheet_replace'
            || operation.kind === 'sheet_schema_migrate'
            || operation.kind === 'row_upsert'
            || operation.kind === 'row_delete'
            || operation.kind === 'meta_update'
            || operation.kind === 'sql_sheet_batch')
        && sheetKeys.has(operation.sheetKey)
    ) {
        return { operation: null, changed: true };
    }

    if (operation.kind === 'data_replace' && isObjectRecord_ACU(operation.data)) {
        const changed = deleteSheetKeysFromRecord_ACU(operation.data, sheetKeys);
        if (!changed) return { operation, changed: false };
        return {
            operation: hasRemainingDataReplacePayload_ACU(operation.data) ? operation : null,
            changed: true,
        };
    }

    if (operation.kind === 'sql_batch') {
        return purgeSqlBatchOperationV2_ACU(operation, targetSqlTableNames);
    }

    return { operation, changed: false };
}

function purgePatchV2_ACU(patch: any, sheetKeys: Set<string>, targetSqlTableNames: Set<string>): { patch: any | null; changed: boolean } {
    if (!isObjectRecord_ACU(patch)) return { patch, changed: false };
    if (
        (patch.kind === 'sheet_replace'
            || patch.kind === 'row_upsert'
            || patch.kind === 'row_delete'
            || patch.kind === 'meta_update'
            || patch.kind === 'sql_sheet_batch')
        && sheetKeys.has(patch.sheetKey)
    ) {
        return { patch: null, changed: true };
    }

    if (patch.kind === 'data_replace' && isObjectRecord_ACU(patch.data)) {
        const changed = deleteSheetKeysFromRecord_ACU(patch.data, sheetKeys);
        if (!changed) return { patch, changed: false };
        return {
            patch: hasRemainingDataReplacePayload_ACU(patch.data) ? patch : null,
            changed: true,
        };
    }

    if (patch.kind === 'sql_batch') {
        const result = purgeSqlBatchOperationV2_ACU(patch, targetSqlTableNames);
        return { patch: result.operation, changed: result.changed };
    }
    return { patch, changed: false };
}

function purgeWriteSetV2_ACU(writeSet: any, sheetKeys: Set<string>): { writeSet: any; changed: boolean } {
    if (!Array.isArray(writeSet)) return { writeSet, changed: false };
    const next = writeSet.filter(unit => {
        if (!isObjectRecord_ACU(unit)) return true;
        if (unit.kind === 'all') return true;
        return !sheetKeys.has(unit.sheetKey);
    });
    return { writeSet: next, changed: next.length !== writeSet.length };
}

function purgeOperationArrayV2_ACU(operations: any, sheetKeys: Set<string>, targetSqlTableNames: Set<string>): { value: any; changed: boolean } {
    if (!Array.isArray(operations)) return { value: operations, changed: false };
    let changed = false;
    const next: any[] = [];
    operations.forEach(operation => {
        const result = purgeOperationV2_ACU(operation, sheetKeys, targetSqlTableNames);
        if (result.changed) changed = true;
        if (result.operation) next.push(result.operation);
    });
    return { value: next, changed };
}

function hasNonEmptyArray_ACU(value: any): boolean {
    return Array.isArray(value) && value.length > 0;
}

function hasMeaningfulManualRefillLogPayloadV2_ACU(entry: any): boolean {
    return hasNonEmptyArray_ACU(entry?.operations) || hasNonEmptyArray_ACU(entry?.patches) || hasNonEmptyArray_ACU(entry?.filledSheetKeys) || hasNonEmptyArray_ACU(entry?.changedSheetKeys) || hasNonEmptyArray_ACU(entry?.groupKeys) || hasNonEmptyArray_ACU(entry?.event?.filledSheetKeys) || hasNonEmptyArray_ACU(entry?.event?.changedSheetKeys) || hasNonEmptyArray_ACU(entry?.event?.groupKeys) || (Array.isArray(entry?.writeSet) && entry.writeSet.some((unit: any) => isObjectRecord_ACU(unit) && unit.kind !== 'all')) || hasNonEmptyArray_ACU(entry?.manualRefillProgress?.selectedSheetKeys) || (isObjectRecord_ACU(entry?.manualRefillProgress?.completedSheetMessageIndexByKey) && Object.keys(entry.manualRefillProgress.completedSheetMessageIndexByKey).length > 0);
}

function purgePatchArrayV2_ACU(patches: any, sheetKeys: Set<string>, targetSqlTableNames: Set<string>): { value: any; changed: boolean } {
    if (!Array.isArray(patches)) return { value: patches, changed: false };
    let changed = false;
    const next: any[] = [];
    patches.forEach(patch => {
        const result = purgePatchV2_ACU(patch, sheetKeys, targetSqlTableNames);
        if (result.changed) changed = true;
        if (result.patch) next.push(result.patch);
    });
    return { value: next, changed };
}

function purgeSheetKeysFromStorageFrameV2_ACU(frame: any, sheetKeys: Set<string>): boolean {
    if (!isObjectRecord_ACU(frame)) return false;
    let changed = false;
    const previousHeadRevision = frame.headRevision;
    const targetSqlTableNames = collectSqlTargetTableNamesFromStorageFrameV2_ACU(frame, sheetKeys);

    const checkpoint = frame.checkpoint;
    if (isObjectRecord_ACU(checkpoint)) {
        if (deleteSheetKeysFromRecord_ACU(checkpoint.data, sheetKeys)) changed = true;
        if (deleteSheetKeysFromRecord_ACU(checkpoint.scheduleSummary, sheetKeys)) changed = true;
        if (purgeEventSheetKeysV2_ACU(checkpoint.event, sheetKeys)) changed = true;
        if (purgeManualRefillProgressV2_ACU(checkpoint.manualRefillProgress, sheetKeys)) changed = true;
    }

    if (purgeEventSheetKeysV2_ACU(frame.event, sheetKeys)) changed = true;

    if (purgeManualRefillProgressV2_ACU(frame.manualRefillProgress, sheetKeys)) changed = true;

    if (isObjectRecord_ACU(frame.perSheetCheckpoints)) {
        sheetKeys.forEach(sheetKey => {
            if (!Object.prototype.hasOwnProperty.call(frame.perSheetCheckpoints, sheetKey)) return;
            delete frame.perSheetCheckpoints[sheetKey];
            changed = true;
        });
    }

    if (Array.isArray(frame.logEntries)) {
        const previousEntryRevisions = new Set(frame.logEntries
            .map((entry: any) => entry?.commitRevision)
            .filter((revision: unknown): revision is string => typeof revision === 'string'));
        const nextEntries: any[] = [];
        frame.logEntries.forEach((entry: any) => {
            if (!isObjectRecord_ACU(entry)) {
                nextEntries.push(entry);
                return;
            }
            let entryChanged = false;
            if (purgeEventSheetKeysV2_ACU(entry, sheetKeys)) entryChanged = true;
            const operations = purgeOperationArrayV2_ACU(entry.operations, sheetKeys, targetSqlTableNames);
            if (operations.changed) {
                entry.operations = operations.value;
                entryChanged = true;
            }
            const patches = purgePatchArrayV2_ACU(entry.patches, sheetKeys, targetSqlTableNames);
            if (patches.changed) {
                entry.patches = patches.value;
                entryChanged = true;
            }
            const writeSet = purgeWriteSetV2_ACU(entry.writeSet, sheetKeys);
            if (writeSet.changed) {
                entry.writeSet = writeSet.writeSet;
                entryChanged = true;
            }
            if (purgeManualRefillProgressV2_ACU(entry.manualRefillProgress, sheetKeys)) entryChanged = true;
            const baseRevision = purgeRuntimeRevisionSnapshotSheetKeysV2_ACU(entry.baseRevision, sheetKeys);
            if (baseRevision.changed) {
                entry.baseRevision = baseRevision.value;
                entryChanged = true;
            }
            const parentRevision = purgeRuntimeRevisionSnapshotSheetKeysV2_ACU(entry.parentRevision, sheetKeys);
            if (parentRevision.changed) {
                entry.parentRevision = parentRevision.value;
                entryChanged = true;
            }
            if (entryChanged) changed = true;
            if (!entryChanged || hasMeaningfulManualRefillLogPayloadV2_ACU(entry)) nextEntries.push(entry);
        });
        if (nextEntries.length !== frame.logEntries.length) changed = true;
        frame.logEntries = nextEntries;
        if (changed) normalizeManualRefillFrameHeadRevisionV2_ACU(frame, previousHeadRevision, previousEntryRevisions);
    }

    return changed;
}

function normalizeManualRefillFrameHeadRevisionV2_ACU(frame: any, previousHeadRevision: unknown, previousEntryRevisions: Set<string>): void {
    const entries = Array.isArray(frame.logEntries) ? frame.logEntries : [];
    const latestEntryRevision = [...entries].reverse().find((entry: any) => typeof entry?.commitRevision === 'string')?.commitRevision;
    frame.headRevision = latestEntryRevision || (typeof previousHeadRevision === 'string' && !previousEntryRevisions.has(previousHeadRevision) ? previousHeadRevision : null);
}

export function purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU(frame: any, sheetKeys: Set<string>, knownSqlTableNames?: Iterable<string>): boolean {
    if (!isObjectRecord_ACU(frame)) return false;
    // 单表 checkpoint 是重放基底；增量预清除只裁剪日志和重填进度，不能删除或改写 shard。
    // 需要替换基底时必须走完整的 purgeSheetKeysFromStorageFrameV2_ACU 流程。
    let changed = false;
    const targetSqlTableNames = collectSqlTargetTableNamesFromStorageFrameV2_ACU(frame, sheetKeys);
    if (knownSqlTableNames) {
        for (const tableName of knownSqlTableNames) {
            const normalized = normalizeSqlIdentifierForPurge_ACU(tableName);
            if (normalized) targetSqlTableNames.add(normalized);
        }
    }

    const checkpoint = frame.checkpoint;
    if (isObjectRecord_ACU(checkpoint)) {
        if (purgeManualRefillProgressV2_ACU(checkpoint.manualRefillProgress, sheetKeys)) changed = true;
    }

    if (purgeEventSheetKeysV2_ACU(frame.event, sheetKeys)) changed = true;

    if (purgeManualRefillProgressV2_ACU(frame.manualRefillProgress, sheetKeys)) changed = true;

    if (Array.isArray(frame.logEntries)) {
        const previousHeadRevision = frame.headRevision;
        const previousEntryRevisions = new Set(frame.logEntries
            .map((entry: any) => entry?.commitRevision)
            .filter((revision: unknown): revision is string => typeof revision === 'string'));
        const nextEntries: any[] = [];
        frame.logEntries.forEach((entry: any) => {
            if (!isObjectRecord_ACU(entry)) {
                nextEntries.push(entry);
                return;
            }
            let entryChanged = false;
            if (purgeEventSheetKeysV2_ACU(entry, sheetKeys)) entryChanged = true;
            if (purgeEventSheetKeysV2_ACU(entry.event, sheetKeys)) entryChanged = true;
            const operations = purgeOperationArrayV2_ACU(entry.operations, sheetKeys, targetSqlTableNames);
            if (operations.changed) {
                entry.operations = operations.value;
                entryChanged = true;
            }
            const patches = purgePatchArrayV2_ACU(entry.patches, sheetKeys, targetSqlTableNames);
            if (patches.changed) {
                entry.patches = patches.value;
                entryChanged = true;
            }
            const writeSet = purgeWriteSetV2_ACU(entry.writeSet, sheetKeys);
            if (writeSet.changed) {
                entry.writeSet = writeSet.writeSet;
                entryChanged = true;
            }
            if (purgeManualRefillProgressV2_ACU(entry.manualRefillProgress, sheetKeys)) entryChanged = true;
            const baseRevision = purgeRuntimeRevisionSnapshotSheetKeysV2_ACU(entry.baseRevision, sheetKeys);
            if (baseRevision.changed) {
                entry.baseRevision = baseRevision.value;
                entryChanged = true;
            }
            const parentRevision = purgeRuntimeRevisionSnapshotSheetKeysV2_ACU(entry.parentRevision, sheetKeys);
            if (parentRevision.changed) {
                entry.parentRevision = parentRevision.value;
                entryChanged = true;
            }
            if (entryChanged) changed = true;
            if (!entryChanged || hasMeaningfulManualRefillLogPayloadV2_ACU(entry)) {
                nextEntries.push(entry);
            }
        });
        if (nextEntries.length !== frame.logEntries.length) changed = true;
        frame.logEntries = nextEntries;
        if (changed) normalizeManualRefillFrameHeadRevisionV2_ACU(frame, previousHeadRevision, previousEntryRevisions);
    }

    return changed;
}

export function purgeManualRefillIncrementalSheetKeysFromMessage_ACU(msg: any, isolationKey: string, sheetKeys: string[], knownSqlTableNames?: Iterable<string>): boolean {
    if (!msg || !Array.isArray(sheetKeys) || sheetKeys.length === 0) return false;

    let msgChanged = false;
    const sheetKeySet = new Set(sheetKeys);
    const isolated = parseIsolatedDataField(msg);
    if (!isolated) return false;

    const nextIsolated = safeClone(isolated);
    const tagData = nextIsolated[isolationKey || ''];
    if (!tagData || typeof tagData !== 'object') return false;
    if (purgeManualRefillIncrementalSheetKeysFromStorageFrameV2_ACU((tagData as any).storageFrame, sheetKeySet, knownSqlTableNames)) {
        msgChanged = true;
    }

    if (msgChanged) {
        msg.TavernDB_ACU_IsolatedData = nextIsolated;
    }
    return msgChanged;
}

export function purgeSheetKeysFromMessageForIsolation_ACU(msg: any, isolationKey: string, sheetKeys: string[]): boolean {
    if (!msg || !Array.isArray(sheetKeys) || sheetKeys.length === 0) return false;

    let msgChanged = false;
    const sheetKeySet = new Set(sheetKeys);
    const isolated = parseIsolatedDataField(msg);
    if (!isolated) return false;

    const nextIsolated = safeClone(isolated);
    const tagKey = isolationKey || '';
    const tagData = nextIsolated[tagKey];
    if (!tagData || typeof tagData !== 'object') return false;

    if ((tagData as any).independentData && typeof (tagData as any).independentData === 'object') {
        sheetKeys.forEach(key => {
            if (Object.prototype.hasOwnProperty.call((tagData as any).independentData, key)) {
                delete (tagData as any).independentData[key];
                msgChanged = true;
            }
        });
    }

    if (Array.isArray((tagData as any).modifiedKeys)) {
        sheetKeys.forEach(key => {
            const result = removeFromArray((tagData as any).modifiedKeys, key);
            if (result.changed) {
                (tagData as any).modifiedKeys = result.result;
                msgChanged = true;
            }
        });
    }

    if (Array.isArray((tagData as any).updateGroupKeys)) {
        sheetKeys.forEach(key => {
            const result = removeFromArray((tagData as any).updateGroupKeys, key);
            if (result.changed) {
                (tagData as any).updateGroupKeys = result.result;
                msgChanged = true;
            }
        });
    }

    if (purgeSheetKeysFromStorageFrameV2_ACU((tagData as any).storageFrame, sheetKeySet)) msgChanged = true;

    if (msgChanged) msg.TavernDB_ACU_IsolatedData = nextIsolated;
    return msgChanged;
}

// ════════════════════════════════════════════════════════════════
// 读取类
// ════════════════════════════════════════════════════════════════

/**
 * 从消息读取指定隔离标签的 IsolationTagData。
 * 统一处理 IsolatedData 字段的 string/object 两种格式。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 隔离标签键名
 * @returns 标签数据，或 null（不存在时）
 */
export function readIsolatedTagData_ACU(msg: any, isolationKey: string): IsolationTagData_ACU | null {
    const container = parseIsolatedDataField(msg);
    if (!container) return null;
    const tagData = container[isolationKey];
    if (!tagData || typeof tagData !== 'object') return null;
    return tagData;
}

/**
 * 从消息读取旧版 IndependentData。
 *
 * @param msg 聊天消息对象
 * @returns 独立表格数据，或 null
 */
export function readLegacyIndependentData_ACU(msg: any): Record<string, Sheet_ACU> | null {
    const data = msg?.TavernDB_ACU_IndependentData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as Record<string, Sheet_ACU>;
}

/**
 * 从消息读取旧版 Data（标准表）。
 *
 * @param msg 聊天消息对象
 * @returns 标准表容器，或 null
 */
export function readLegacyStandardData_ACU(msg: any): LegacyTableContainer_ACU | null {
    const data = msg?.TavernDB_ACU_Data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as LegacyTableContainer_ACU;
}

/**
 * 从消息读取旧版 SummaryData（摘要表）。
 *
 * @param msg 聊天消息对象
 * @returns 摘要表容器，或 null
 */
export function readLegacySummaryData_ACU(msg: any): LegacyTableContainer_ACU | null {
    const data = msg?.TavernDB_ACU_SummaryData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as LegacyTableContainer_ACU;
}

/**
 * 从消息读取 Identity 字段。
 *
 * @param msg 聊天消息对象
 * @returns 隔离标识字符串，或 undefined（未设置时）
 */
export function readMessageIdentity_ACU(msg: any): string | undefined {
    return msg?.TavernDB_ACU_Identity;
}

/**
 * 从消息读取本地消息锚点字段。
 *
 * @param msg 聊天消息对象
 * @returns 本地锚点字符串，或 undefined（未设置时）
 */
export function readLocalMessageAnchor_ACU(msg: any): string | undefined {
    const anchor = String(msg?.TavernDB_ACU_LocalMessageAnchor || '').trim();
    return anchor || undefined;
}

/**
 * 从消息读取 ModifiedKeys。
 *
 * @param msg 聊天消息对象
 * @returns 修改键列表（不存在时返回空数组）
 */
export function readModifiedKeys_ACU(msg: any): string[] {
    const keys = msg?.TavernDB_ACU_ModifiedKeys;
    return Array.isArray(keys) ? keys : [];
}

/**
 * 从消息读取 UpdateGroupKeys。
 *
 * @param msg 聊天消息对象
 * @returns 更新组键列表（不存在时返回空数组）
 */
export function readUpdateGroupKeys_ACU(msg: any): string[] {
    const keys = msg?.TavernDB_ACU_UpdateGroupKeys;
    return Array.isArray(keys) ? keys : [];
}

/**
 * 判断旧版消息是否匹配当前隔离配置。
 * 封装隔离匹配逻辑：
 * - 开启隔离：Identity === code 时匹配
 * - 关闭隔离（无标签模式）：Identity 不存在时匹配
 *
 * @param msg 聊天消息对象
 * @param isolationConfig 隔离配置
 * @returns 是否匹配
 */
export function isLegacyMatchForIsolation_ACU(msg: any, isolationConfig: IsolationConfig_ACU): boolean {
    const msgIdentity = msg?.TavernDB_ACU_Identity;
    if (isolationConfig.enabled) {
        return msgIdentity === isolationConfig.code;
    }
    return !msgIdentity;
}

// ════════════════════════════════════════════════════════════════
// 写入类
// ════════════════════════════════════════════════════════════════

/**
 * 写入指定隔离标签的数据到 IsolatedData 容器。
 * 如果容器不存在会自动创建。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 隔离标签键名
 * @param tagData 要写入的标签数据
 */
export function writeIsolatedTagData_ACU(msg: any, isolationKey: string, tagData: IsolationTagData_ACU): void {
    if (!msg) return;
    if (!msg.TavernDB_ACU_IsolatedData || typeof msg.TavernDB_ACU_IsolatedData !== 'object') {
        msg.TavernDB_ACU_IsolatedData = {};
    }
    msg.TavernDB_ACU_IsolatedData[isolationKey] = tagData;
}

/**
 * 确保 IsolatedData[isolationKey] 存在（初始化空槽）。
 * 如果已存在则不覆盖。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 隔离标签键名
 * @returns 该标签槽的引用
 */
export function initIsolatedTagSlot_ACU(msg: any, isolationKey: string): IsolationTagData_ACU {
    if (!msg.TavernDB_ACU_IsolatedData || typeof msg.TavernDB_ACU_IsolatedData !== 'object') {
        msg.TavernDB_ACU_IsolatedData = {};
    }
    if (!msg.TavernDB_ACU_IsolatedData[isolationKey]) {
        msg.TavernDB_ACU_IsolatedData[isolationKey] = {
            independentData: {},
            modifiedKeys: [],
            updateGroupKeys: [],
        };
    }
    return msg.TavernDB_ACU_IsolatedData[isolationKey];
}

/**
 * 统一的 checkpoint 写入接口。
 * 将完整表格快照写入指定消息的指定隔离标签槽位，并标记 _acu_storage_mode='checkpoint'。
 * 用于播种、导入、模板覆盖、清理边界兆底等场景。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 隔离标签键名
 * @param independentData 完整表格快照
 * @param options 可选配置（modifiedKeys/updateGroupKeys/baseState）
 */
export function writeTableCheckpointToMessage_ACU(
    msg: any,
    isolationKey: string,
    independentData: Record<string, Sheet_ACU>,
    options: {
        legacyConfirmed: true;
        modifiedKeys?: string[];
        updateGroupKeys?: string[];
        baseState?: string;
    },
): void {
    if (!msg || options?.legacyConfirmed !== true) return;
    const tagData = initIsolatedTagSlot_ACU(msg, isolationKey);
    tagData.independentData = independentData;
    tagData.modifiedKeys = options?.modifiedKeys ?? [];
    tagData.updateGroupKeys = options?.updateGroupKeys ?? [];
    tagData._acu_storage_mode = 'checkpoint';
    tagData._acu_storage_version = 1;
    if (options?.baseState !== undefined) {
        tagData._acu_base_state = options.baseState;
    }
}


/**
 * 同步写入旧版兼容字段（IndependentData/ModifiedKeys/UpdateGroupKeys）。
 *
 * @param msg 聊天消息对象
 * @param independentData 独立表格数据
 * @param modifiedKeys 修改键列表
 * @param updateGroupKeys 更新组键列表
 */
export function writeLegacyCompatData_ACU(
    msg: any,
    independentData: Record<string, Sheet_ACU>,
    modifiedKeys: string[],
    updateGroupKeys: string[],
    options: { legacyConfirmed: true },
): void {
    if (!msg || options?.legacyConfirmed !== true) return;
    msg.TavernDB_ACU_IndependentData = independentData;
    msg.TavernDB_ACU_ModifiedKeys = modifiedKeys;
    msg.TavernDB_ACU_UpdateGroupKeys = updateGroupKeys;
}

/**
 * 写入旧版 Data 和 SummaryData 字段。
 *
 * @param msg 聊天消息对象
 * @param standardData 标准表数据（可选，null 则不写入）
 * @param summaryData 摘要表数据（可选，null 则不写入）
 */
export function writeLegacyStandardAndSummary_ACU(
    msg: any,
    standardData: LegacyTableContainer_ACU | null,
    summaryData: LegacyTableContainer_ACU | null,
    options: { legacyConfirmed: true },
): void {
    if (!msg || options?.legacyConfirmed !== true) return;
    if (standardData && hasAnySheetKey(standardData)) {
        msg.TavernDB_ACU_Data = standardData;
    }
    if (summaryData && hasAnySheetKey(summaryData)) {
        msg.TavernDB_ACU_SummaryData = summaryData;
    }
}

/**
 * 根据隔离配置设置或删除 Identity 字段。
 * - 隔离启用：设置 Identity 为隔离代码
 * - 隔离关闭：删除 Identity 字段
 *
 * @param msg 聊天消息对象
 * @param isolationConfig 隔离配置
 */
export function writeMessageIdentity_ACU(msg: any, isolationConfig: IsolationConfig_ACU): void {
    if (!msg) return;
    if (isolationConfig.enabled) {
        msg.TavernDB_ACU_Identity = isolationConfig.code;
    } else {
        delete msg.TavernDB_ACU_Identity;
    }
}

/**
 * 写入或删除本地消息锚点字段。
 *
 * @param msg 聊天消息对象
 * @param anchor 本地锚点；空字符串表示删除
 */
export function writeLocalMessageAnchor_ACU(msg: any, anchor: string): void {
    if (!msg) return;
    const normalizedAnchor = String(anchor || '').trim();
    if (normalizedAnchor) {
        msg.TavernDB_ACU_LocalMessageAnchor = normalizedAnchor;
    } else {
        delete msg.TavernDB_ACU_LocalMessageAnchor;
    }
}

// ════════════════════════════════════════════════════════════════
// 删除类
// ════════════════════════════════════════════════════════════════

/**
 * 从单条消息的所有字段中删除指定 sheetKey 的数据（新版+旧版）。
 * 处理删除后空对象的清理。
 *
 * @param msg 聊天消息对象
 * @param sheetKeys 要删除的 sheetKey 列表
 * @returns 是否发生了变化
 */
export function purgeSheetKeysFromMessage_ACU(msg: any, sheetKeys: string[]): boolean {
    if (!msg || !Array.isArray(sheetKeys) || sheetKeys.length === 0) return false;

    let msgChanged = false;
    const sheetKeySet = new Set(sheetKeys);

    // ── 新版：按标签分组（对该消息内所有标签槽执行删除） ──
    const isolated = parseIsolatedDataField(msg);
    if (isolated) {
        const nextIsolated = safeClone(isolated);
        Object.keys(nextIsolated).forEach(tagKey => {
            const tagData = nextIsolated[tagKey];
            if (!tagData || typeof tagData !== 'object') return;

            // 删除 independentData 中的指定 sheetKey
            if (tagData.independentData && typeof tagData.independentData === 'object') {
                sheetKeys.forEach(k => {
                    if (tagData.independentData[k]) {
                        delete tagData.independentData[k];
                        msgChanged = true;
                    }
                });
            }

            // 从 modifiedKeys 中移除
            if (Array.isArray(tagData.modifiedKeys)) {
                sheetKeys.forEach(k => {
                    const r = removeFromArray(tagData.modifiedKeys, k);
                    if (r.changed) {
                        tagData.modifiedKeys = r.result;
                        msgChanged = true;
                    }
                });
            }

            // 从 updateGroupKeys 中移除
            if (Array.isArray(tagData.updateGroupKeys)) {
                sheetKeys.forEach(k => {
                    const r = removeFromArray(tagData.updateGroupKeys, k);
                    if (r.changed) {
                        tagData.updateGroupKeys = r.result;
                        msgChanged = true;
                    }
                });
            }

            if (purgeSheetKeysFromStorageFrameV2_ACU((tagData as any).storageFrame, sheetKeySet)) {
                msgChanged = true;
            }
        });
        if (msgChanged) {
            msg.TavernDB_ACU_IsolatedData = nextIsolated;
        }
    }

    // ── 旧版：独立数据 ──
    if (msg.TavernDB_ACU_IndependentData && typeof msg.TavernDB_ACU_IndependentData === 'object') {
        const next = safeClone(msg.TavernDB_ACU_IndependentData);
        let indepChanged = false;
        sheetKeys.forEach(k => {
            if (next[k]) {
                delete next[k];
                indepChanged = true;
            }
        });
        if (indepChanged) {
            msgChanged = true;
            if (!hasAnySheetKey(next)) {
                const hasNonSheet = Object.keys(next).some(k => !k.startsWith('sheet_'));
                if (!hasNonSheet) {
                    delete msg.TavernDB_ACU_IndependentData;
                } else {
                    msg.TavernDB_ACU_IndependentData = next;
                }
            } else {
                msg.TavernDB_ACU_IndependentData = next;
            }
        }
    }

    // ── 旧版：ModifiedKeys / UpdateGroupKeys ──
    if (Array.isArray(msg.TavernDB_ACU_ModifiedKeys)) {
        let next = [...msg.TavernDB_ACU_ModifiedKeys];
        let any = false;
        sheetKeys.forEach(k => {
            const r = removeFromArray(next, k);
            if (r.changed) { next = r.result; any = true; }
        });
        if (any) { msg.TavernDB_ACU_ModifiedKeys = next; msgChanged = true; }
    }
    if (Array.isArray(msg.TavernDB_ACU_UpdateGroupKeys)) {
        let next = [...msg.TavernDB_ACU_UpdateGroupKeys];
        let any = false;
        sheetKeys.forEach(k => {
            const r = removeFromArray(next, k);
            if (r.changed) { next = r.result; any = true; }
        });
        if (any) { msg.TavernDB_ACU_UpdateGroupKeys = next; msgChanged = true; }
    }

    // ── 旧版：标准表 ──
    if (msg.TavernDB_ACU_Data && typeof msg.TavernDB_ACU_Data === 'object') {
        const next = safeClone(msg.TavernDB_ACU_Data);
        let dataChanged = false;
        sheetKeys.forEach(k => {
            if (next[k]) { delete next[k]; dataChanged = true; }
        });
        if (dataChanged) {
            msgChanged = true;
            if (!hasAnySheetKey(next)) {
                const hasNonSheet = Object.keys(next).some(k => !k.startsWith('sheet_'));
                if (!hasNonSheet) {
                    delete msg.TavernDB_ACU_Data;
                } else {
                    msg.TavernDB_ACU_Data = next;
                }
            } else {
                msg.TavernDB_ACU_Data = next;
            }
        }
    }

    // ── 旧版：摘要表 ──
    if (msg.TavernDB_ACU_SummaryData && typeof msg.TavernDB_ACU_SummaryData === 'object') {
        const next = safeClone(msg.TavernDB_ACU_SummaryData);
        let summaryChanged = false;
        sheetKeys.forEach(k => {
            if (next[k]) { delete next[k]; summaryChanged = true; }
        });
        if (summaryChanged) {
            msgChanged = true;
            if (!hasAnySheetKey(next)) {
                const hasNonSheet = Object.keys(next).some(k => !k.startsWith('sheet_'));
                if (!hasNonSheet) {
                    delete msg.TavernDB_ACU_SummaryData;
                } else {
                    msg.TavernDB_ACU_SummaryData = next;
                }
            } else {
                msg.TavernDB_ACU_SummaryData = next;
            }
        }
    }

    return msgChanged;
}

/**
 * 清除消息上所有 TavernDB_ACU_* 表格数据字段（用于重置）。
 *
 * @param msg 聊天消息对象
 */
export function clearAllTableFields_ACU(msg: any): void {
    if (!msg) return;
    delete msg.TavernDB_ACU_IsolatedData;
    delete msg.TavernDB_ACU_IndependentData;
    delete msg.TavernDB_ACU_Data;
    delete msg.TavernDB_ACU_SummaryData;
    delete msg.TavernDB_ACU_Identity;
    delete msg.TavernDB_ACU_LocalMessageAnchor;
    delete msg.TavernDB_ACU_ModifiedKeys;
    delete msg.TavernDB_ACU_UpdateGroupKeys;
    delete msg._acu_local_template_base_state_seeded;
}

/**
 * 按隔离标签清空单条消息上的表格数据（精确版 clearAllTableFields）。
 *
 * 与 clearAllTableFields_ACU 的区别：
 * - clearAllTableFields_ACU：无差别删除所有标签的所有字段，会误删同一消息上其他标签的数据。
 * - 本函数：只删除当前隔离标签下的数据；如果消息上还有其他标签的数据则保留。
 *
 * 清理范围：
 * 1. 新版 IsolatedData[isolationKey] 槽 → 删除该标签槽；若容器变空则删除整个 IsolatedData 字段。
 * 2. 旧版兼容字段（IndependentData / Data / SummaryData / ModifiedKeys / UpdateGroupKeys / Identity）
 *    → 仅在 isolationConfig 不启用隔离或该消息的 Identity 匹配当前隔离代码时才删除。
 *    这样可以避免把同一消息上属于其他隔离标签的旧版数据误删。
 * 3. 不删除消息正文（mes）、不删除非表格业务字段。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 当前隔离标签键名
 * @param isolationConfig 隔离配置（用于判断旧版字段是否属于当前标签）
 * @returns 是否有任何字段被修改（用于调用方决定是否 saveChat）
 */
export function clearTableFieldsForIsolation_ACU(
    msg: any,
    isolationKey: string,
    isolationConfig: IsolationConfig_ACU,
): boolean {
    if (!msg) return false;

    let changed = false;

    // ── 新版：删除指定隔离标签的槽 ──
    const container = parseIsolatedDataField(msg);
    if (container && container[isolationKey]) {
        delete container[isolationKey];
        changed = true;
        // 如果容器里已经没有任何标签槽了，删除整个字段
        if (Object.keys(container).length === 0) {
            delete msg.TavernDB_ACU_IsolatedData;
        } else {
            msg.TavernDB_ACU_IsolatedData = container;
        }
    }

    // ── 旧版：仅在消息属于当前隔离标签时才删除 ──
    // 判断条件与 mergeAllIndependentTables_ACU 中的 legacy 兼容逻辑一致：
    // - 隔离启用：msg.TavernDB_ACU_Identity === code 时匹配
    // - 隔离关闭（无标签模式）：msg.TavernDB_ACU_Identity 不存在时匹配
    if (isLegacyMatchForIsolation_ACU(msg, isolationConfig)) {
        if (msg.TavernDB_ACU_IndependentData) {
            delete msg.TavernDB_ACU_IndependentData;
            changed = true;
        }
        if (msg.TavernDB_ACU_Data) {
            delete msg.TavernDB_ACU_Data;
            changed = true;
        }
        if (msg.TavernDB_ACU_SummaryData) {
            delete msg.TavernDB_ACU_SummaryData;
            changed = true;
        }
        if (msg.TavernDB_ACU_Identity !== undefined) {
            delete msg.TavernDB_ACU_Identity;
            changed = true;
        }
        if (msg.TavernDB_ACU_ModifiedKeys) {
            delete msg.TavernDB_ACU_ModifiedKeys;
            changed = true;
        }
        if (msg.TavernDB_ACU_UpdateGroupKeys) {
            delete msg.TavernDB_ACU_UpdateGroupKeys;
            changed = true;
        }
    }

    return changed;
}

// ════════════════════════════════════════════════════════════════
// 辅助类
// ════════════════════════════════════════════════════════════════

/**
 * 检查消息是否包含任何表格数据（新版或旧版）。
 * 可选传入 isolationKey 和 isolationConfig 来限定检查范围。
 *
 * @param msg 聊天消息对象
 * @param isolationKey 可选，指定检查的隔离标签
 * @param isolationConfig 可选，用于旧版数据的隔离匹配
 * @returns 是否包含表格数据
 */
export function hasAnyTableData_ACU(
    msg: any,
    isolationKey?: string,
    isolationConfig?: IsolationConfig_ACU,
): boolean {
    if (!msg) return false;

    // 检查新版 IsolatedData
    if (isolationKey) {
        const tagData = readIsolatedTagData_ACU(msg, isolationKey);
        if (tagData?.independentData && Object.keys(tagData.independentData).some(k => k.startsWith('sheet_'))) {
            return true;
        }
    } else {
        const container = parseIsolatedDataField(msg);
        if (container && Object.keys(container).length > 0) {
            return true;
        }
    }

    // 检查旧版数据（如果提供了隔离配置，先检查匹配）
    if (isolationConfig && !isLegacyMatchForIsolation_ACU(msg, isolationConfig)) {
        return false;
    }

    if (msg.TavernDB_ACU_IndependentData && hasAnySheetKey(msg.TavernDB_ACU_IndependentData)) return true;
    if (msg.TavernDB_ACU_Data && hasAnySheetKey(msg.TavernDB_ACU_Data)) return true;
    if (msg.TavernDB_ACU_SummaryData && hasAnySheetKey(msg.TavernDB_ACU_SummaryData)) return true;

    return false;
}

/**
 * 深拷贝 IsolatedData 容器（安全修改用）。
 * 如果字段不存在或解析失败，返回空对象。
 *
 * @param msg 聊天消息对象
 * @returns 深拷贝后的 IsolatedData 容器
 */
export function cloneIsolatedData_ACU(msg: any): IsolatedDataContainer_ACU {
    const container = parseIsolatedDataField(msg);
    if (!container) return {};
    return safeClone(container);
}
