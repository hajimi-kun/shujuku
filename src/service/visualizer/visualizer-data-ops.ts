import { getChatArray_ACU } from '../chat/chat-service';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, _set_currentJsonTableData_ACU } from '../runtime/state-manager';
import { getLatestV2FullCheckpointMessageIndex_ACU, getLatestV2SheetReplayMessageIndex_ACU } from '../table/table-history';
import { ensureLegacyStorageMigratedBeforeWrite_ACU } from '../table/table-service';
import { persistTableMutationLogBatchV2_ACU } from '../table/storage-frame-v2-persist';
import { loadTableStateFromFramesV2_ACU } from '../table/storage-frame-v2-replay';
import { reloadStorageProvider } from '../table/table-storage-strategy';
import { runTableWriteTransaction_ACU } from '../table/table-write-transaction';
import { isSqliteMode } from '../table/storage-mode';
import type { TableMutationOperationV2_ACU, TableWriteConflictUnitV2_ACU } from '../table/storage-frame-v2-types';
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

export type PendingVisualizerDataOps_ACU = {
    updatesByRow: Record<string, PendingUpdateRow_ACU>;
    insertsByClientRowId: Record<string, PendingInsertRow_ACU>;
    deletesByRow: Record<string, PendingDeleteRow_ACU>;
    committed?: {
        afterData: any;
        insertedRowIds: Record<string, string>;
    };
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

export function assertVisualizerDataOpsEditable_ACU(state: { pendingDataOps?: PendingVisualizerDataOps_ACU | null; isSaving?: boolean }): void {
    if (state?.isSaving) {
        throw new Error('保存正在进行中，期间不能继续编辑。');
    }
    if (ensurePendingOps_ACU(state).committed) {
        throw new Error('数据已持久化但本地刷新尚未完成。请先重试保存完成恢复，期间不能继续编辑。');
    }
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
    assertVisualizerDataOpsEditable_ACU(state);
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
    assertVisualizerDataOpsEditable_ACU(state);
    pending.insertsByClientRowId[clientRowId] = { kind: 'insertRow', sheetKey, clientRowId };
}

export function recordVisualizerRowDelete_ACU(state: any, sheetKey: string, rowId: any): void {
    const normalizedRowId = String(rowId ?? '').trim();
    if (!sheetKey || !normalizedRowId) return;
    const pending = ensurePendingOps_ACU(state);
    assertVisualizerDataOpsEditable_ACU(state);
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
    return !!pending.committed
        || Object.keys(pending.deletesByRow).length > 0
        || Object.keys(pending.updatesByRow).length > 0
        || Object.keys(pending.insertsByClientRowId).length > 0;
}

function addWriteSet_ACU(writeSet: TableWriteConflictUnitV2_ACU[], unit: TableWriteConflictUnitV2_ACU): void {
    const key = JSON.stringify(unit);
    if (!writeSet.some(item => JSON.stringify(item) === key)) writeSet.push(unit);
}

function buildVisualizerWriteSet_ACU(pending: PendingVisualizerDataOps_ACU): TableWriteConflictUnitV2_ACU[] {
    const writeSet: TableWriteConflictUnitV2_ACU[] = [];
    Object.values(pending.deletesByRow).forEach(op => addWriteSet_ACU(writeSet, { kind: 'row', sheetKey: op.sheetKey, rowId: op.rowId }));
    Object.values(pending.updatesByRow).forEach(op => {
        Object.keys(op.data).forEach(columnKey => addWriteSet_ACU(writeSet, { kind: 'cell', sheetKey: op.sheetKey, rowId: op.rowId, columnKey }));
    });
    Object.values(pending.insertsByClientRowId).forEach(op => addWriteSet_ACU(writeSet, { kind: 'sheet', sheetKey: op.sheetKey }));
    return writeSet;
}

function findRowIndexById_ACU(sheet: any, rowId: string): number {
    const content = Array.isArray(sheet?.content) ? sheet.content : [];
    let matchedIndex = -1;
    for (let index = 1; index < content.length; index += 1) {
        if (String(content[index]?.[0] ?? '') !== rowId) continue;
        if (matchedIndex >= 0) throw new Error(`行标识 ${rowId} 重复，无法确定要操作的行。`);
        matchedIndex = index;
    }
    return matchedIndex;
}

function assertValidPersistedRowIds_ACU(sheet: any, sheetKey: string, action: string): void {
    const content = Array.isArray(sheet?.content) ? sheet.content : [];
    const rowIds = new Set<string>();
    for (let index = 1; index < content.length; index += 1) {
        const rowId = String(content[index]?.[0] ?? '').trim();
        const numericId = Number(rowId);
        if (!/^[1-9]\d*$/.test(rowId) || !Number.isSafeInteger(numericId) || String(numericId) !== rowId) {
            throw new Error(`${action}失败：表 ${sheetKey} 的行标识 ${rowId || '(空)'} 必须是正安全整数。`);
        }
        if (rowIds.has(rowId)) throw new Error(`${action}失败：表 ${sheetKey} 的行标识 ${rowId} 重复。`);
        rowIds.add(rowId);
    }
}

function getValidatedHeaders_ACU(sheet: any, sheetKey: string, action: string): any[] {
    const headers = Array.isArray(sheet?.content?.[0]) ? sheet.content[0] : null;
    if (!headers || headers.length === 0) throw new Error(`${action}失败：表 ${sheetKey} 的表头无效。`);
    const columnNames = headers.slice(1).map((header: any) => String(header ?? '').trim());
    if (columnNames.some(columnName => !columnName)) throw new Error(`${action}失败：表 ${sheetKey} 存在空列名。`);
    if (new Set(columnNames).size !== columnNames.length) throw new Error(`${action}失败：表 ${sheetKey} 存在重复列名。`);
    return headers;
}

function assertCompleteRow_ACU(row: any, headers: any[], sheetKey: string, rowId: string, action: string): any[] {
    if (!Array.isArray(row) || row.length !== headers.length) {
        throw new Error(`${action}失败：表 ${sheetKey} 的行 ${rowId} 与表头长度不一致。`);
    }
    if (String(row[0] ?? '').trim() !== rowId) {
        throw new Error(`${action}失败：表 ${sheetKey} 的行标识不一致。`);
    }
    return row;
}

function toPersistedCells_ACU(cells: any[]): (string | null)[] {
    return cells.map(value => value === null ? null : String(value ?? ''));
}

function buildInsertCells_ACU(state: any, sheetKey: string, clientRowId: string, runtimeSheet: any, reservedRowIds: Set<string>): (string | null)[] | null {
    const tempSheet = getSheetByKey_ACU(state?.tempData, sheetKey);
    const tempContent = Array.isArray(tempSheet?.content) ? tempSheet.content : [];
    const tempRow = tempContent.find((row: any[], index: number) => index > 0 && Array.isArray(row) && String(row[0] ?? '') === clientRowId);
    if (!Array.isArray(tempRow)) return null;

    const headers = getValidatedHeaders_ACU(runtimeSheet, sheetKey, '新增行');
    assertValidPersistedRowIds_ACU(runtimeSheet, sheetKey, '新增行');
    if (tempRow.length !== headers.length) throw new Error(`新增行失败：表 ${sheetKey} 的临时行与表头长度不一致。`);
    const cells = toPersistedCells_ACU(tempRow);
    cells[0] = allocateStableRowId_ACU(reservedRowIds);
    return cells;
}

export function replaceVisualizerTemporaryRowIds_ACU(state: any, insertedRowIds: Record<string, string>): void {
    Object.entries(insertedRowIds).forEach(([clientRowId, rowId]) => {
        Object.values(state?.tempData || {}).forEach((sheet: any) => {
            if (!Array.isArray(sheet?.content)) return;
            const row = sheet.content.find((candidate: any[], index: number) => index > 0 && String(candidate?.[0] ?? '') === clientRowId);
            if (row) row[0] = rowId;
        });
    });
}

async function refreshVisualizerRuntimeFromReplay_ACU(isolationKey: string): Promise<void> {
    const replayedData = await loadTableStateFromFramesV2_ACU(getChatArray_ACU(), isolationKey);
    if (!replayedData) throw new Error('V2 replay 未产生表格数据，已阻止刷新运行时。');
    _set_currentJsonTableData_ACU(replayedData);
    if (isSqliteMode()) await reloadStorageProvider();
}

export async function applyVisualizerPendingDataOps_ACU(state: any): Promise<{ success: boolean; changed: boolean; insertedRowIds?: Record<string, string>; error?: string }> {
    const pending = ensurePendingOps_ACU(state);
    if (pending.committed) {
        try {
            await refreshVisualizerRuntimeFromReplay_ACU(getCurrentIsolationKey_ACU());
            const insertedRowIds = pending.committed.insertedRowIds;
            return Object.keys(insertedRowIds).length > 0
                ? { success: true, changed: true, insertedRowIds }
                : { success: true, changed: true };
        } catch (error: any) {
            return { success: false, changed: false, error: `数据已持久化，但本地运行时刷新失败：${error?.message || String(error)}` };
        }
    }
    if (!hasVisualizerPendingDataOps_ACU(state)) return { success: true, changed: false };

    const migration = await ensureLegacyStorageMigratedBeforeWrite_ACU('visualizer_save_v2_replay');
    if (!migration.success) return { success: false, changed: false, error: migration.error || '旧存储迁移失败，已阻止可视化编辑器保存。' };
    if (migration.migrated) await reloadStorageProvider();

    const writeSet = buildVisualizerWriteSet_ACU(pending);
    const isolationKey = getCurrentIsolationKey_ACU();
    try {
        const chat = getChatArray_ACU();
        const fullCheckpointIndex = getLatestV2FullCheckpointMessageIndex_ACU(chat, isolationKey);
        if (fullCheckpointIndex < 0) {
            return { success: false, changed: false, error: '找不到 V2 full checkpoint，已阻止写入 log-only 增量。' };
        }
        // afterData must be ops(V2 replay base). Runtime snapshots can carry seedRows /
        // type drift / unrelated fields and falsely fail batch candidate validation.
        const replayBase = await loadTableStateFromFramesV2_ACU(chat, isolationKey, { updateRuntimeState: false });
        if (!replayBase) {
            return { success: false, changed: false, error: 'V2 replay 未产生表格数据，已阻止可视化编辑器保存。' };
        }
        const result = await runTableWriteTransaction_ACU({
            source: 'manual_crud',
            reason: 'visualizer_save_v2_replay',
            isolationKey,
            writeSet,
            initialData: replayBase,
        }, async (transactionContext, workingData) => {
            if (!workingData) throw new Error('运行时表格数据为空，已阻止可视化编辑器保存。');
            const data = workingData as any;
            const operationsBySheet = new Map<string, TableMutationOperationV2_ACU[]>();
            const insertedRowIds: Record<string, string> = {};
            const appendOperation = (sheetKey: string, operation: TableMutationOperationV2_ACU): void => {
                const operations = operationsBySheet.get(sheetKey) || [];
                operations.push(operation);
                operationsBySheet.set(sheetKey, operations);
            };
            const rowIdReservationsBySheet = new Map<string, Set<string>>();
            for (const op of Object.values(pending.insertsByClientRowId)) {
                if (rowIdReservationsBySheet.has(op.sheetKey)) continue;
                const sheet = data[op.sheetKey];
                if (!sheet || !Array.isArray(sheet.content)) throw new Error(`新增行失败：表 ${op.sheetKey} 在运行时不存在。`);
                rowIdReservationsBySheet.set(op.sheetKey, createStableRowIdReservation_ACU(sheet.content.slice(1)));
            }

            for (const op of Object.values(pending.deletesByRow)) {
                const sheet = data[op.sheetKey];
                if (!sheet || !Array.isArray(sheet.content)) throw new Error(`删除行失败：表 ${op.sheetKey} 在运行时不存在。`);
                assertValidPersistedRowIds_ACU(sheet, op.sheetKey, '删除行');
                const rowIndex = findRowIndexById_ACU(sheet, op.rowId);
                if (rowIndex < 1) throw new Error(`删除行失败：表 ${op.sheetKey} 的行 ${op.rowId} 不存在。`);
                const headers = getValidatedHeaders_ACU(sheet, op.sheetKey, '删除行');
                assertCompleteRow_ACU(sheet.content[rowIndex], headers, op.sheetKey, op.rowId, '删除行');
                sheet.content.splice(rowIndex, 1);
                appendOperation(op.sheetKey, { kind: 'row_delete', sheetKey: op.sheetKey, rowId: op.rowId });
            }
            for (const op of Object.values(pending.updatesByRow)) {
                const sheet = data[op.sheetKey];
                if (!sheet || !Array.isArray(sheet.content)) throw new Error(`更新行失败：表 ${op.sheetKey} 在运行时不存在。`);
                assertValidPersistedRowIds_ACU(sheet, op.sheetKey, '更新行');
                const rowIndex = findRowIndexById_ACU(sheet, op.rowId);
                if (rowIndex < 1) throw new Error(`更新行失败：表 ${op.sheetKey} 的行 ${op.rowId} 不存在。`);
                const headers = getValidatedHeaders_ACU(sheet, op.sheetKey, '更新行');
                const row = assertCompleteRow_ACU(sheet.content[rowIndex], headers, op.sheetKey, op.rowId, '更新行');
                for (const [columnName, value] of Object.entries(op.data)) {
                    const columnIndex = headers.indexOf(columnName);
                    if (columnIndex < 1) throw new Error(`更新行失败：表 ${op.sheetKey} 不存在列 ${columnName}。`);
                    row[columnIndex] = value;
                }
                const cells = toPersistedCells_ACU(row);
                cells[0] = op.rowId;
                sheet.content[rowIndex] = cells;
                appendOperation(op.sheetKey, { kind: 'row_upsert', sheetKey: op.sheetKey, rowId: op.rowId, cells });
            }
            for (const op of Object.values(pending.insertsByClientRowId)) {
                const sheet = data[op.sheetKey];
                if (!sheet || !Array.isArray(sheet.content)) throw new Error(`新增行失败：表 ${op.sheetKey} 在运行时不存在。`);
                const reservedRowIds = rowIdReservationsBySheet.get(op.sheetKey);
                if (!reservedRowIds) throw new Error(`新增行失败：表 ${op.sheetKey} 缺少 row_id 分配保留区。`);
                const cells = buildInsertCells_ACU(state, op.sheetKey, op.clientRowId, sheet, reservedRowIds);
                if (!cells) throw new Error(`新增行失败：表 ${op.sheetKey} 的临时行已丢失或表头无效。`);
                sheet.content.push(cells);
                const rowId = String(cells[0]);
                insertedRowIds[op.clientRowId] = rowId;
                appendOperation(op.sheetKey, { kind: 'row_upsert', sheetKey: op.sheetKey, rowId, cells });
            }

            const targets = [...operationsBySheet.entries()].map(([sheetKey, operations]) => {
                const explicitReplayIndex = getLatestV2SheetReplayMessageIndex_ACU(chat, isolationKey, sheetKey);
                return {
                    targetMessageIndex: explicitReplayIndex >= 0 ? explicitReplayIndex : fullCheckpointIndex,
                    changedSheetKeys: [sheetKey],
                    operations,
                };
            });
            const saved = await persistTableMutationLogBatchV2_ACU({
                source: 'manual_crud',
                afterData: data,
                targets,
                isolationKey,
                revisionWriteSet: writeSet,
                transactionContext,
            });
            if (!saved.saved) throw new Error(saved.error || 'V2 行级增量持久化失败。');
            return { afterData: data, insertedRowIds };
        });
        pending.committed = result;
        try {
            await refreshVisualizerRuntimeFromReplay_ACU(isolationKey);
        } catch (error: any) {
            return { success: false, changed: false, error: `数据已持久化，但本地运行时刷新失败：${error?.message || String(error)}` };
        }
        return Object.keys(result.insertedRowIds).length > 0
            ? { success: true, changed: true, insertedRowIds: result.insertedRowIds }
            : { success: true, changed: true };
    } catch (error: any) {
        return { success: false, changed: false, error: error?.message || String(error) };
    }
}
