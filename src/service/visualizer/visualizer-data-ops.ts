import { getChatArray_ACU } from '../chat/chat-service';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU } from '../runtime/state-manager';
import { getNameMapper } from '../runtime/template-vars/name-mapper';
import { getLatestTableAppendMessageIndexFromChat_ACU } from '../table/table-history';
import { getStorageProvider } from '../table/table-storage-strategy';
import { runTableUpdateCommit_ACU } from '../table/table-update-commit';
import { isSqliteMode } from '../table/storage-mode';
import type { TableMutationOperationV2_ACU, TableWriteConflictUnitV2_ACU } from '../table/storage-frame-v2-types';
import { parseDDLTableName } from '../../shared/ddl-utils';
import { allocateStableRowId_ACU, createStableRowIdReservation_ACU } from '../../shared/stable-row-id-allocator';

const TEMP_ROW_ID_PREFIX_ACU = '__acu_vis_tmp_row_';

type PendingUpdateRow_ACU = {
    kind: 'updateRow';
    sheetKey: string;
    rowId: string;
    data: Record<string, any>;
};

type PendingInsertRow_ACU = {
    kind: 'insertRow';
    sheetKey: string;
    clientRowId: string;
};

type PendingDeleteRow_ACU = {
    kind: 'deleteRow';
    sheetKey: string;
    rowId: string;
};

type PendingVisualizerDataOps_ACU = {
    updatesByRow: Record<string, PendingUpdateRow_ACU>;
    insertsByClientRowId: Record<string, PendingInsertRow_ACU>;
    deletesByRow: Record<string, PendingDeleteRow_ACU>;
};

function ensurePendingOps_ACU(state: any): PendingVisualizerDataOps_ACU {
    if (!state.pendingDataOps || typeof state.pendingDataOps !== 'object') {
        resetVisualizerPendingDataOps_ACU(state);
    }
    state.pendingDataOps.updatesByRow ||= {};
    state.pendingDataOps.insertsByClientRowId ||= {};
    state.pendingDataOps.deletesByRow ||= {};
    return state.pendingDataOps;
}

function quoteIdentifier_ACU(name: string): string {
    return `\`${String(name).replace(/`/g, '``')}\``;
}

function rowKey_ACU(sheetKey: string, rowId: string): string {
    return `${sheetKey}::${rowId}`;
}

function isTempRowId_ACU(rowId: any): boolean {
    return String(rowId || '').startsWith(TEMP_ROW_ID_PREFIX_ACU);
}

function getSheetByKey_ACU(data: any, sheetKey: string): any {
    return data && typeof data === 'object' ? data[sheetKey] : null;
}

function getRuntimeSheet_ACU(sheetKey: string): any {
    return getSheetByKey_ACU(currentJsonTableData_ACU, sheetKey);
}

function getEnglishTableName_ACU(sheet: any): string {
    const ddlName = sheet?.sourceData?.ddl ? parseDDLTableName(sheet.sourceData.ddl) : '';
    return String(ddlName || sheet?.name || '').trim();
}

function resolveColumnForSheet_ACU(englishTableName: string, colName: string): { englishColName: string; chineseColName: string } {
    const mapper = getNameMapper();
    const englishColName = mapper.resolveColumnName(englishTableName, colName);
    const chineseColName = mapper.getChineseColumnName(englishTableName, englishColName);
    return { englishColName, chineseColName };
}

function toSqlValueParam_ACU(value: any): string | number | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return String(value);
}

function buildRowDataFromTemp_ACU(state: any, sheetKey: string, rowId: string): Record<string, any> | null {
    const sheet = getSheetByKey_ACU(state?.tempData, sheetKey);
    const content = Array.isArray(sheet?.content) ? sheet.content : [];
    const headers = Array.isArray(content[0]) ? content[0] : [];
    const row = content.find((item: any[], index: number) => index > 0 && Array.isArray(item) && String(item[0] ?? '') === rowId);
    if (!row) return null;

    const out: Record<string, any> = {};
    for (let col = 1; col < headers.length; col += 1) {
        const columnName = String(headers[col] || '').trim();
        if (!columnName) continue;
        out[columnName] = row[col] === undefined ? '' : row[col];
    }
    return out;
}

export function createVisualizerTempRowId_ACU(): string {
    return `${TEMP_ROW_ID_PREFIX_ACU}${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function resetVisualizerPendingDataOps_ACU(state: any): void {
    state.pendingDataOps = {
        updatesByRow: {},
        insertsByClientRowId: {},
        deletesByRow: {},
    };
}

export function recordVisualizerCellUpdate_ACU(state: any, sheetKey: string, rowId: any, columnName: any, value: any): void {
    const normalizedRowId = String(rowId ?? '').trim();
    const normalizedColumnName = String(columnName ?? '').trim();
    if (!sheetKey || !normalizedRowId || !normalizedColumnName || isTempRowId_ACU(normalizedRowId)) return;

    const pending = ensurePendingOps_ACU(state);
    const key = rowKey_ACU(sheetKey, normalizedRowId);
    if (pending.deletesByRow[key]) return;
    if (!pending.updatesByRow[key]) {
        pending.updatesByRow[key] = { kind: 'updateRow', sheetKey, rowId: normalizedRowId, data: {} };
    }
    pending.updatesByRow[key].data[normalizedColumnName] = value === undefined ? '' : value;
}

export function recordVisualizerRowInsert_ACU(state: any, sheetKey: string, clientRowId: string): void {
    if (!sheetKey || !clientRowId) return;
    const pending = ensurePendingOps_ACU(state);
    pending.insertsByClientRowId[clientRowId] = { kind: 'insertRow', sheetKey, clientRowId };
}

export function recordVisualizerRowDelete_ACU(state: any, sheetKey: string, rowId: any): void {
    const normalizedRowId = String(rowId ?? '').trim();
    if (!sheetKey || !normalizedRowId) return;
    const pending = ensurePendingOps_ACU(state);
    if (isTempRowId_ACU(normalizedRowId)) {
        delete pending.insertsByClientRowId[normalizedRowId];
        return;
    }

    const key = rowKey_ACU(sheetKey, normalizedRowId);
    delete pending.updatesByRow[key];
    pending.deletesByRow[key] = { kind: 'deleteRow', sheetKey, rowId: normalizedRowId };
}

export function recordVisualizerSheetRowsUpdate_ACU(state: any, sheetKey: string): void {
    const sheet = getSheetByKey_ACU(state?.tempData, sheetKey);
    const content = Array.isArray(sheet?.content) ? sheet.content : [];
    const headers = Array.isArray(content[0]) ? content[0] : [];
    for (let rowIndex = 1; rowIndex < content.length; rowIndex += 1) {
        const row = content[rowIndex];
        const rowId = String(row?.[0] ?? '').trim();
        if (!rowId || isTempRowId_ACU(rowId)) continue;
        for (let col = 1; col < headers.length; col += 1) {
            recordVisualizerCellUpdate_ACU(state, sheetKey, rowId, headers[col], row[col] === undefined ? '' : row[col]);
        }
    }
}

export function hasVisualizerPendingDataOps_ACU(state: any): boolean {
    const pending = ensurePendingOps_ACU(state);
    return Object.keys(pending.deletesByRow).length > 0
        || Object.keys(pending.updatesByRow).length > 0
        || Object.keys(pending.insertsByClientRowId).length > 0;
}

function addWriteSet_ACU(writeSet: TableWriteConflictUnitV2_ACU[], unit: TableWriteConflictUnitV2_ACU): void {
    const key = JSON.stringify(unit);
    if (!writeSet.some(item => JSON.stringify(item) === key)) writeSet.push(unit);
}

function pushDeleteSql_ACU(statements: string[], paramsList: (string | number | null)[][], writeSet: TableWriteConflictUnitV2_ACU[], op: PendingDeleteRow_ACU): string | null {
    const sheet = getRuntimeSheet_ACU(op.sheetKey);
    const englishTableName = getEnglishTableName_ACU(sheet);
    if (!sheet || !englishTableName) return `删除行失败：表 ${op.sheetKey} 在运行时不存在。`;
    statements.push(`DELETE FROM ${quoteIdentifier_ACU(englishTableName)} WHERE ${quoteIdentifier_ACU('row_id')} = ?;`);
    paramsList.push([toSqlValueParam_ACU(op.rowId)]);
    addWriteSet_ACU(writeSet, { kind: 'row', sheetKey: op.sheetKey, rowId: op.rowId });
    return null;
}

function pushUpdateSql_ACU(statements: string[], paramsList: (string | number | null)[][], writeSet: TableWriteConflictUnitV2_ACU[], op: PendingUpdateRow_ACU): string | null {
    const sheet = getRuntimeSheet_ACU(op.sheetKey);
    const englishTableName = getEnglishTableName_ACU(sheet);
    const headers = Array.isArray(sheet?.content?.[0]) ? sheet.content[0] : [];
    if (!sheet || !englishTableName) return `更新行失败：表 ${op.sheetKey} 在运行时不存在。`;

    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    for (const colName in op.data) {
        const { englishColName, chineseColName } = resolveColumnForSheet_ACU(englishTableName, colName);
        if (!headers.includes(chineseColName)) continue;
        setClauses.push(`${quoteIdentifier_ACU(englishColName)} = ?`);
        params.push(toSqlValueParam_ACU(op.data[colName]));
        addWriteSet_ACU(writeSet, { kind: 'cell', sheetKey: op.sheetKey, rowId: op.rowId, columnKey: chineseColName });
    }
    if (setClauses.length === 0) return null;

    params.push(toSqlValueParam_ACU(op.rowId));
    statements.push(`UPDATE ${quoteIdentifier_ACU(englishTableName)} SET ${setClauses.join(', ')} WHERE ${quoteIdentifier_ACU('row_id')} = ?;`);
    paramsList.push(params);
    return null;
}

function pushInsertSql_ACU(statements: string[], paramsList: (string | number | null)[][], writeSet: TableWriteConflictUnitV2_ACU[], state: any, op: PendingInsertRow_ACU): string | null {
    const sheet = getRuntimeSheet_ACU(op.sheetKey);
    const englishTableName = getEnglishTableName_ACU(sheet);
    const headers = Array.isArray(sheet?.content?.[0]) ? sheet.content[0] : [];
    const rowData = buildRowDataFromTemp_ACU(state, op.sheetKey, op.clientRowId);
    if (!sheet || !englishTableName || !rowData) return `新增行失败：表 ${op.sheetKey} 在运行时不存在，或临时行已丢失。`;

    const columnNames: string[] = [];
    const params: (string | number | null)[] = [];
    for (const colName in rowData) {
        const { englishColName, chineseColName } = resolveColumnForSheet_ACU(englishTableName, colName);
        if (englishColName === 'row_id' || colName === 'row_id') continue;
        if (!headers.includes(chineseColName)) continue;
        columnNames.push(quoteIdentifier_ACU(englishColName));
        params.push(toSqlValueParam_ACU(rowData[colName]));
    }

    statements.push(columnNames.length > 0
        ? `INSERT INTO ${quoteIdentifier_ACU(englishTableName)} (${columnNames.join(', ')}) VALUES (${columnNames.map(() => '?').join(', ')});`
        : `INSERT INTO ${quoteIdentifier_ACU(englishTableName)} DEFAULT VALUES;`);
    paramsList.push(params);
    addWriteSet_ACU(writeSet, { kind: 'sheet', sheetKey: op.sheetKey });
    return null;
}

function buildNativeWriteSet_ACU(pending: PendingVisualizerDataOps_ACU): TableWriteConflictUnitV2_ACU[] {
    const writeSet: TableWriteConflictUnitV2_ACU[] = [];
    Object.values(pending.deletesByRow).forEach(op => addWriteSet_ACU(writeSet, { kind: 'row', sheetKey: op.sheetKey, rowId: op.rowId }));
    Object.values(pending.updatesByRow).forEach(op => {
        Object.keys(op.data).forEach(columnKey => addWriteSet_ACU(writeSet, { kind: 'cell', sheetKey: op.sheetKey, rowId: op.rowId, columnKey }));
    });
    Object.values(pending.insertsByClientRowId).forEach(op => addWriteSet_ACU(writeSet, { kind: 'sheet', sheetKey: op.sheetKey }));
    return writeSet;
}

function getTargetSheetKeysFromWriteSet_ACU(writeSet: TableWriteConflictUnitV2_ACU[]): string[] {
    return [...new Set(writeSet.flatMap(unit => 'sheetKey' in unit ? [unit.sheetKey] : []))];
}

function findRowIndexById_ACU(sheet: any, rowId: string): number {
    const content = Array.isArray(sheet?.content) ? sheet.content : [];
    for (let index = 1; index < content.length; index += 1) {
        if (String(content[index]?.[0] ?? '') === rowId) return index;
    }
    return -1;
}

function buildNativeInsertCells_ACU(state: any, sheetKey: string, clientRowId: string, runtimeSheet: any): any[] | null {
    const tempSheet = getSheetByKey_ACU(state?.tempData, sheetKey);
    const tempContent = Array.isArray(tempSheet?.content) ? tempSheet.content : [];
    const tempRow = tempContent.find((row: any[], index: number) => index > 0 && Array.isArray(row) && String(row[0] ?? '') === clientRowId);
    if (!Array.isArray(tempRow)) return null;

    const headers = Array.isArray(runtimeSheet?.content?.[0]) ? runtimeSheet.content[0] : [];
    const cells = headers.map((_: any, index: number) => tempRow[index] ?? '');
    cells[0] = allocateStableRowId_ACU(createStableRowIdReservation_ACU(runtimeSheet?.content?.slice(1)));
    return cells;
}

async function applyNativeVisualizerPendingDataOps_ACU(
    state: any,
    pending: PendingVisualizerDataOps_ACU,
): Promise<{ success: boolean; changed: boolean; error?: string }> {
    const writeSet = buildNativeWriteSet_ACU(pending);
    if (writeSet.length === 0) return { success: true, changed: false };

    const isolationKey = getCurrentIsolationKey_ACU();
    const appendTargetIndex = getLatestTableAppendMessageIndexFromChat_ACU(getChatArray_ACU(), isolationKey, settings_ACU);
    if (appendTargetIndex === -1) {
        return { success: false, changed: false, error: '找不到可写入 V2 增量日志的 AI 楼层，已阻止保存。' };
    }

    const targetSheetKeys = getTargetSheetKeysFromWriteSet_ACU(writeSet);
    const commitResult = await runTableUpdateCommit_ACU<{ changes: number }>({
        source: 'manual_crud',
        reason: 'visualizer_save_native_batch',
        isolationKey,
        writeSet,
        revisionWriteSet: writeSet,
        initialData: currentJsonTableData_ACU,
        targetMessageIndex: appendTargetIndex,
        targetSheetKeys,
        updateGroupKeys: null,
        trackingSheetKeys: [],
        trackAsUpdate: false,
    }, ({ workingData }) => {
        const data = workingData as any;
        const operations: TableMutationOperationV2_ACU[] = [];
        let changes = 0;

        for (const op of Object.values(pending.deletesByRow)) {
            const sheet = data?.[op.sheetKey];
            if (!sheet || !Array.isArray(sheet.content)) return { success: false, error: `删除行失败：表 ${op.sheetKey} 在运行时不存在。` };
            const beforeLength = sheet.content.length;
            sheet.content = sheet.content.filter((row: any[], index: number) => index === 0 || String(row?.[0] ?? '') !== op.rowId);
            if (sheet.content.length === beforeLength) return { success: false, error: `删除行失败：表 ${op.sheetKey} 的行 ${op.rowId} 不存在。` };
            operations.push({ kind: 'row_delete', sheetKey: op.sheetKey, rowId: op.rowId });
            changes += 1;
        }

        for (const op of Object.values(pending.updatesByRow)) {
            const sheet = data?.[op.sheetKey];
            if (!sheet || !Array.isArray(sheet.content)) return { success: false, error: `更新行失败：表 ${op.sheetKey} 在运行时不存在。` };
            const rowIndex = findRowIndexById_ACU(sheet, op.rowId);
            if (rowIndex < 1) return { success: false, error: `更新行失败：表 ${op.sheetKey} 的行 ${op.rowId} 不存在。` };
            const headers = Array.isArray(sheet.content[0]) ? sheet.content[0] : [];
            const row = sheet.content[rowIndex];
            let updated = 0;
            Object.keys(op.data).forEach(columnName => {
                const colIndex = headers.indexOf(columnName);
                if (colIndex < 1) return;
                row[colIndex] = op.data[columnName];
                updated += 1;
            });
            if (updated > 0) {
                operations.push({ kind: 'row_upsert', sheetKey: op.sheetKey, rowId: op.rowId, cells: [...row] });
                changes += 1;
            }
        }

        for (const op of Object.values(pending.insertsByClientRowId)) {
            const sheet = data?.[op.sheetKey];
            if (!sheet || !Array.isArray(sheet.content)) return { success: false, error: `新增行失败：表 ${op.sheetKey} 在运行时不存在。` };
            const cells = buildNativeInsertCells_ACU(state, op.sheetKey, op.clientRowId, sheet);
            if (!cells) return { success: false, error: `新增行失败：表 ${op.sheetKey} 的临时行已丢失。` };
            sheet.content.push(cells);
            operations.push({ kind: 'row_upsert', sheetKey: op.sheetKey, rowId: String(cells[0] ?? ''), cells: [...cells] });
            changes += 1;
        }

        return {
            success: true,
            value: { changes },
            tableData: data,
            mutationResult: { changes, errors: [] },
            persist: { operations },
        };
    });

    if (!commitResult.success) {
        return { success: false, changed: false, error: commitResult.error || '可视化编辑器原生模式增量保存失败。' };
    }

    resetVisualizerPendingDataOps_ACU(state);
    return { success: true, changed: true };
}

export async function applyVisualizerPendingDataOps_ACU(state: any): Promise<{ success: boolean; changed: boolean; error?: string }> {
    const pending = ensurePendingOps_ACU(state);
    if (!hasVisualizerPendingDataOps_ACU(state)) return { success: true, changed: false };
    if (!isSqliteMode()) return applyNativeVisualizerPendingDataOps_ACU(state, pending);

    const statements: string[] = [];
    const paramsList: (string | number | null)[][] = [];
    const writeSet: TableWriteConflictUnitV2_ACU[] = [];

    for (const op of Object.values(pending.deletesByRow)) {
        const error = pushDeleteSql_ACU(statements, paramsList, writeSet, op);
        if (error) return { success: false, changed: false, error };
    }
    for (const op of Object.values(pending.updatesByRow)) {
        const error = pushUpdateSql_ACU(statements, paramsList, writeSet, op);
        if (error) return { success: false, changed: false, error };
    }
    for (const op of Object.values(pending.insertsByClientRowId)) {
        const error = pushInsertSql_ACU(statements, paramsList, writeSet, state, op);
        if (error) return { success: false, changed: false, error };
    }

    if (statements.length === 0) return { success: true, changed: false };

    const provider = getStorageProvider();
    if (typeof provider.applyEditsBatch !== 'function') {
        return { success: false, changed: false, error: '当前运行时不支持批量 SQL 保存，已阻止可视化编辑器数据写入。' };
    }

    const isolationKey = getCurrentIsolationKey_ACU();
    const appendTargetIndex = getLatestTableAppendMessageIndexFromChat_ACU(getChatArray_ACU(), isolationKey, settings_ACU);
    if (appendTargetIndex === -1) {
        return { success: false, changed: false, error: '找不到可写入 V2 增量日志的 AI 楼层，已阻止保存。' };
    }

    const targetSheetKeys = [...new Set(writeSet.flatMap(unit => 'sheetKey' in unit ? [unit.sheetKey] : []))];
    const commitResult = await runTableUpdateCommit_ACU<{ appliedEdits: number; changes: number }>({
        source: 'manual_crud',
        reason: 'visualizer_save_sql_batch',
        isolationKey,
        writeSet: writeSet.length > 0 ? writeSet : [{ kind: 'all' }],
        revisionWriteSet: writeSet.length > 0 ? writeSet : [{ kind: 'all' }],
        initialData: currentJsonTableData_ACU,
        targetMessageIndex: appendTargetIndex,
        targetSheetKeys,
        updateGroupKeys: null,
        trackingSheetKeys: [],
        trackAsUpdate: false,
        operations: [{ kind: 'sql_batch', statements, params: paramsList }],
    }, () => {
        const batchResult = provider.applyEditsBatch!(statements, 'visualizer_save', paramsList);
        if (!batchResult.success) {
            return { success: false, error: batchResult.error || 'visualizer_save_sql_batch failed' };
        }
        const tableData = provider.getCurrentData();
        if (!tableData) return { success: false, error: 'SQLite runtime data export failed' };
        return {
            success: true,
            value: { appliedEdits: batchResult.appliedEdits, changes: batchResult.appliedEdits },
            tableData,
            mutationResult: { changes: batchResult.appliedEdits, errors: [] },
        };
    });

    if (!commitResult.success) {
        return { success: false, changed: false, error: commitResult.error || '可视化编辑器批量 SQL 保存失败。' };
    }

    resetVisualizerPendingDataOps_ACU(state);
    return { success: true, changed: true };
}
