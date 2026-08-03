import type { TableDataObject_ACU } from '../../shared/models/table-data';
import type { SqlMutationResult } from '../../shared/table-storage-provider';
import { logError_ACU, logWarn_ACU } from '../../shared/utils';
import { currentChatFileIdentifier_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU, _set_currentJsonTableData_ACU } from '../runtime/state-manager';
import { ensureLegacyStorageMigratedBeforeWrite_ACU, persistTablesToChatMessage_ACU } from './table-service';
import { ensureStorageProviderReady_ACU, reloadStorageProvider } from './table-storage-strategy';
import { runTableWriteTransaction_ACU, type TableWriteTransactionContext_ACU } from './table-write-transaction';
import type { ReplaceExistingIncrementalOptions_ACU } from './storage-frame-v2-persist';
import type { ManualRefillProgressV2_ACU, TableCheckpointV2_ACU, TableMutationOperationV2_ACU, TableMutationSourceV2_ACU, TableWriteConflictUnitV2_ACU } from './storage-frame-v2-types';
import { buildSqlSheetBatchOperations_ACU, rebindSqlMutationTableIdentifiers_ACU } from './sql-table-service';

export interface TableUpdateCommitApplyContext_ACU {
  transactionContext: TableWriteTransactionContext_ACU;
  workingData: TableDataObject_ACU | null;
}

export interface TableUpdateCommitPersistOverride_ACU {
  targetMessageIndex?: number;
  targetSheetKeys?: string[] | null;
  updateGroupKeys?: string[] | null;
  trackingSheetKeys?: string[] | null;
  trackAsUpdate?: boolean;
  operations?: TableMutationOperationV2_ACU[];
  revisionWriteSet?: TableWriteConflictUnitV2_ACU[];
  forceCheckpoint?: boolean;
  checkpointReason?: TableCheckpointV2_ACU['reason'];
  manualRefillProgress?: ManualRefillProgressV2_ACU;
  replaceExistingIncremental?: ReplaceExistingIncrementalOptions_ACU;
  strictSave?: boolean;
}

export type TableUpdateCommitErrorCategory_ACU = 'model' | 'infrastructure' | 'precondition';

export interface TableUpdateCommitApplyResult_ACU<T> {
  success: boolean;
  value?: T;
  tableData?: TableDataObject_ACU;
  mutationResult?: SqlMutationResult;
  persist?: TableUpdateCommitPersistOverride_ACU;
  error?: string;
  errorCategory?: TableUpdateCommitErrorCategory_ACU;
}

export interface RunTableUpdateCommitOptions_ACU {
  source: TableMutationSourceV2_ACU;
  reason: string;
  chatKey?: string;
  writeSet: TableWriteConflictUnitV2_ACU[];
  revisionWriteSet?: TableWriteConflictUnitV2_ACU[];
  isolationKey?: string;
  baseRevision?: string | null;
  /** apply 已在事务外构建结果且不读取 workingData 时，可跳过事务工作副本克隆。 */
  workingDataMode?: 'clone' | 'none';
  initialData?: TableDataObject_ACU | null;
  targetMessageIndex: number;
  targetSheetKeys: string[] | null;
  updateGroupKeys?: string[] | null;
  trackingSheetKeys?: string[] | null;
  trackAsUpdate?: boolean;
  operations?: TableMutationOperationV2_ACU[];
  manualRefillProgress?: ManualRefillProgressV2_ACU;
  replaceExistingIncremental?: ReplaceExistingIncrementalOptions_ACU;
  strictSave?: boolean;
  performanceRunId?: string;
  performanceParentSpanId?: string;
  skipChatSave?: boolean;
}

export interface RunTableUpdateCommitResult_ACU<T> {
  success: boolean;
  value?: T;
  tableData?: TableDataObject_ACU;
  mutationResult?: SqlMutationResult;
  saved?: boolean;
  messageIndex?: number;
  error?: string;
  errorCategory?: TableUpdateCommitErrorCategory_ACU;
}

class TableUpdateCommitError_ACU extends Error {
  constructor(message: string, readonly category: TableUpdateCommitErrorCategory_ACU) {
    super(message);
    this.name = 'TableUpdateCommitError';
  }
}

function cloneTableData_ACU(data: TableDataObject_ACU): TableDataObject_ACU {
  return JSON.parse(JSON.stringify(data));
}

function normalizeSqlBindParams_ACU(params: (string | number | null)[] | undefined): (string | number | null)[][] | undefined {
  return Array.isArray(params) && params.length > 0 ? [params.map(value => value ?? null)] : undefined;
}

/**
 * Final persistence boundary: reject malformed row identities without repairing
 * data. Identity allocation belongs to the row creation path; repairing here
 * would hide the origin of a corrupt row and could change persisted semantics.
 */
function assertPersistableRowIdentities_ACU(
  data: TableDataObject_ACU,
  reason: string,
  targetSheetKeys?: string[] | null,
): void {
  const scopedKeys = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0 ? new Set(targetSheetKeys) : null;
  for (const [sheetKey, sheet] of Object.entries(data)) {
    if (!sheetKey.startsWith('sheet_')) continue;
    if (scopedKeys && !scopedKeys.has(sheetKey)) continue;
    const content = (sheet as any)?.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const headers = content[0];
    if (!Array.isArray(headers) || String(headers[0] ?? '') !== 'row_id') {
      throw new Error(`[TableUpdateCommit] ${reason}: sheetKey=${sheetKey} 缺少 row_id 首列表头。`);
    }
    const rowIds = new Set<string>();
    for (let rowIndex = 1; rowIndex < content.length; rowIndex += 1) {
      const row = content[rowIndex];
      if (!Array.isArray(row)) {
        throw new Error(`[TableUpdateCommit] ${reason}: sheetKey=${sheetKey}, rowIndex=${rowIndex} 不是数组行。`);
      }
      const rowId = String(row[0] ?? '').trim();
      if (!rowId) {
        throw new Error(`[TableUpdateCommit] ${reason}: sheetKey=${sheetKey}, rowIndex=${rowIndex} 的 row_id 为空。`);
      }
      if (rowIds.has(rowId)) {
        throw new Error(`[TableUpdateCommit] ${reason}: sheetKey=${sheetKey}, rowIndex=${rowIndex} 的 row_id 重复：${rowId}。`);
      }
      rowIds.add(rowId);
    }
  }
}

function assertExpectedCommitScope_ACU(options: RunTableUpdateCommitOptions_ACU, phase: string): void {
  if (options.chatKey === undefined && options.isolationKey === undefined) return;
  const currentChatKey = String(currentChatFileIdentifier_ACU || 'current-chat');
  const expectedChatKey = String(options.chatKey ?? currentChatKey);
  const currentIsolationKey = String(getCurrentIsolationKey_ACU() || '');
  const expectedIsolationKey = String(options.isolationKey ?? currentIsolationKey);
  if (currentChatKey !== expectedChatKey || currentIsolationKey !== expectedIsolationKey) {
    throw new TableUpdateCommitError_ACU(
      `[TableUpdateCommit] ${options.reason}: ${phase} 检测到聊天或隔离标识已切换，已拒绝提交。请在当前聊天重新执行填表。`,
      'precondition',
    );
  }
}

export async function runTableUpdateCommit_ACU<T>(
  options: RunTableUpdateCommitOptions_ACU,
  apply: (context: TableUpdateCommitApplyContext_ACU) => Promise<TableUpdateCommitApplyResult_ACU<T>> | TableUpdateCommitApplyResult_ACU<T>,
): Promise<RunTableUpdateCommitResult_ACU<T>> {
  let requiresRuntimeReload = false;
  try {
    assertExpectedCommitScope_ACU(options, '提交前');
    const migration = await ensureLegacyStorageMigratedBeforeWrite_ACU(options.reason);
    if (!migration.success) {
      return {
        success: false,
        error: migration.error || '旧存储迁移失败，已阻止本次写入。',
        errorCategory: 'infrastructure',
      };
    }
    if (migration.migrated) {
      await reloadStorageProvider();
    }
    assertExpectedCommitScope_ACU(options, '迁移后');

    return await runTableWriteTransaction_ACU({
      source: options.source,
      reason: options.reason,
      chatKey: options.chatKey,
      isolationKey: options.isolationKey ?? getCurrentIsolationKey_ACU(),
      writeSet: options.writeSet,
      baseRevision: options.baseRevision,
      workingDataMode: options.workingDataMode,
      initialData: options.initialData !== undefined ? options.initialData : currentJsonTableData_ACU,
    }, async (transactionContext, workingData) => {
      let commitRevisionWriteSet = options.revisionWriteSet;
      return transactionContext.runCommit(async () => {
        assertExpectedCommitScope_ACU(options, '应用前');
        const applied = await apply({ transactionContext, workingData });
        if (!applied.success || !applied.tableData) {
          throw new TableUpdateCommitError_ACU(applied.error || `${options.reason}: update apply failed`, applied.errorCategory || 'infrastructure');
        }

        let saved = true;
        let messageIndex: number | undefined;
        const persistOptions = applied.persist || {};
        const revisionWriteSet = persistOptions.revisionWriteSet ?? options.revisionWriteSet;
        const targetSheetKeys = persistOptions.targetSheetKeys !== undefined ? persistOptions.targetSheetKeys : options.targetSheetKeys;
        const operations = persistOptions.operations ?? options.operations;
        commitRevisionWriteSet = revisionWriteSet;
        if (!options.skipChatSave) {
          assertExpectedCommitScope_ACU(options, '持久化前');
          assertPersistableRowIdentities_ACU(applied.tableData, options.reason, targetSheetKeys);
          const saveResult = await persistTablesToChatMessage_ACU({
            targetMessageIndex: persistOptions.targetMessageIndex ?? options.targetMessageIndex,
            targetSheetKeys,
            updateGroupKeys: persistOptions.updateGroupKeys !== undefined ? persistOptions.updateGroupKeys : (options.updateGroupKeys ?? null),
            trackingSheetKeys: persistOptions.trackingSheetKeys !== undefined ? persistOptions.trackingSheetKeys : (options.trackingSheetKeys ?? []),
            tableData: applied.tableData,
            trackAsUpdate: persistOptions.trackAsUpdate ?? options.trackAsUpdate ?? false,
            source: options.source,
            operations,
            revisionWriteSet,
            forceCheckpoint: persistOptions.forceCheckpoint,
            checkpointReason: persistOptions.checkpointReason,
            manualRefillProgress: persistOptions.manualRefillProgress ?? options.manualRefillProgress,
            replaceExistingIncremental: persistOptions.replaceExistingIncremental ?? options.replaceExistingIncremental,
            strictSave: persistOptions.strictSave ?? options.strictSave,
            performanceRunId: options.performanceRunId,
            performanceParentSpanId: options.performanceParentSpanId,
            assumeCommitLock: true,
            transactionContext,
          });
          saved = saveResult.saved;
          messageIndex = saveResult.messageIndex;
          if (!saveResult.saved) {
            logWarn_ACU(`[TableUpdateCommit] persist failed after runtime update; reload after releasing transaction locks: ${saveResult.error || 'unknown error'}`);
            requiresRuntimeReload = true;
            throw new TableUpdateCommitError_ACU(saveResult.error || `${options.reason}: persist failed`, 'infrastructure');
          }
        }

        _set_currentJsonTableData_ACU(cloneTableData_ACU(applied.tableData));
        return {
          success: true,
          value: applied.value,
          tableData: applied.tableData,
          mutationResult: applied.mutationResult,
          saved,
          messageIndex,
        };
      }, () => commitRevisionWriteSet);
    });
  } catch (error: any) {
    if (requiresRuntimeReload) {
      try {
        await reloadStorageProvider();
      } catch (reloadError) {
        logError_ACU(`[TableUpdateCommit] ${options.reason} failed to reload runtime after persistence failure:`, reloadError);
      }
    }
    const message = error?.message || String(error);
    const errorCategory: TableUpdateCommitErrorCategory_ACU = error instanceof TableUpdateCommitError_ACU
      ? error.category
      : 'infrastructure';
    logError_ACU(`[TableUpdateCommit] ${options.reason} failed:`, error);
    return {
      success: false,
      error: message,
      errorCategory,
    };
  }
}

export interface RunSqliteRuntimeMutationCommitOptions_ACU<T> extends RunTableUpdateCommitOptions_ACU {
  sql: string;
  params?: (string | number | null)[];
  validate?: (input: { mutationResult: SqlMutationResult; tableData: TableDataObject_ACU }) => string | null;
  mapValue: (input: { mutationResult: SqlMutationResult; tableData: TableDataObject_ACU }) => T;
}

export async function runSqliteRuntimeMutationCommit_ACU<T>(
  options: RunSqliteRuntimeMutationCommitOptions_ACU<T>,
): Promise<RunTableUpdateCommitResult_ACU<T>> {
  const operations = options.operations ?? [{
    kind: 'sql_batch' as const,
    statements: [options.sql],
    ...(normalizeSqlBindParams_ACU(options.params) ? { params: normalizeSqlBindParams_ACU(options.params) } : {}),
  }];
  return runTableUpdateCommit_ACU({ ...options, operations }, async ({ workingData }) => {
    const provider = await ensureStorageProviderReady_ACU();
    const runtimeData = (workingData || currentJsonTableData_ACU) as TableDataObject_ACU | null;
    const runtimeSql = runtimeData
      ? rebindSqlMutationTableIdentifiers_ACU([options.sql], runtimeData)[0]
      : options.sql;
    const mutationResult = provider.executeMutation(runtimeSql, options.params);
    if (mutationResult.errors?.length) {
      return { success: false, error: mutationResult.errors.join(', '), mutationResult };
    }
    const tableData = provider.getCurrentData();
    if (!tableData) {
      return { success: false, error: 'SQLite runtime data export failed', mutationResult };
    }
    const validationError = options.validate?.({ mutationResult, tableData: tableData as TableDataObject_ACU });
    if (validationError) {
      return { success: false, error: validationError, mutationResult, tableData: tableData as TableDataObject_ACU };
    }
    const runtimeOperations = options.operations ? undefined : buildSqlSheetBatchOperations_ACU(
      [runtimeSql],
      tableData as TableDataObject_ACU,
      {
        params: normalizeSqlBindParams_ACU(options.params),
        fallbackTargetSheetKeys: options.targetSheetKeys || undefined,
        allowSingleTargetFallback: true,
        keepLegacyForUnclassified: true,
        reason: 'manual_crud',
      },
    ).operations;
    return {
      success: true,
      value: options.mapValue({ mutationResult, tableData: tableData as TableDataObject_ACU }),
      tableData: tableData as TableDataObject_ACU,
      mutationResult,
      ...(runtimeOperations ? { persist: { operations: runtimeOperations } } : {}),
    };
  });
}
