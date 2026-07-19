import type { TableDataObject_ACU } from '../../shared/models/table-data';
import type { SqlMutationResult } from '../../shared/table-storage-provider';
import { logError_ACU, logWarn_ACU } from '../../shared/utils';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU, _set_currentJsonTableData_ACU } from '../runtime/state-manager';
import { ensureLegacyStorageMigratedBeforeWrite_ACU, persistTablesToChatMessage_ACU } from './table-service';
import { ensureStorageProviderReady_ACU, reloadStorageProvider } from './table-storage-strategy';
import { runTableWriteTransaction_ACU, type TableWriteTransactionContext_ACU } from './table-write-transaction';
import type { ReplaceExistingIncrementalOptions_ACU } from './storage-frame-v2-persist';
import type { ManualRefillProgressV2_ACU, TableCheckpointV2_ACU, TableMutationOperationV2_ACU, TableMutationSourceV2_ACU, TableWriteConflictUnitV2_ACU } from './storage-frame-v2-types';

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

export interface TableUpdateCommitApplyResult_ACU<T> {
  success: boolean;
  value?: T;
  tableData?: TableDataObject_ACU;
  mutationResult?: SqlMutationResult;
  persist?: TableUpdateCommitPersistOverride_ACU;
  error?: string;
}

export interface RunTableUpdateCommitOptions_ACU {
  source: TableMutationSourceV2_ACU;
  reason: string;
  writeSet: TableWriteConflictUnitV2_ACU[];
  revisionWriteSet?: TableWriteConflictUnitV2_ACU[];
  isolationKey?: string;
  baseRevision?: string | null;
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
}

function cloneTableData_ACU(data: TableDataObject_ACU): TableDataObject_ACU {
  return JSON.parse(JSON.stringify(data));
}

function normalizeSqlBindParams_ACU(params: (string | number | null)[] | undefined): (string | number | null)[][] | undefined {
  return Array.isArray(params) && params.length > 0 ? [params.map(value => value ?? null)] : undefined;
}

export async function runTableUpdateCommit_ACU<T>(
  options: RunTableUpdateCommitOptions_ACU,
  apply: (context: TableUpdateCommitApplyContext_ACU) => Promise<TableUpdateCommitApplyResult_ACU<T>> | TableUpdateCommitApplyResult_ACU<T>,
): Promise<RunTableUpdateCommitResult_ACU<T>> {
  try {
    const migration = await ensureLegacyStorageMigratedBeforeWrite_ACU(options.reason);
    if (!migration.success) {
      return { success: false, error: migration.error || '旧存储迁移失败，已阻止本次写入。' };
    }
    if (migration.migrated) {
      await reloadStorageProvider();
    }

    return await runTableWriteTransaction_ACU({
      source: options.source,
      reason: options.reason,
      isolationKey: options.isolationKey ?? getCurrentIsolationKey_ACU(),
      writeSet: options.writeSet,
      baseRevision: options.baseRevision,
      initialData: options.initialData !== undefined ? options.initialData : currentJsonTableData_ACU,
    }, async (transactionContext, workingData) => {
      let commitRevisionWriteSet = options.revisionWriteSet;
      return transactionContext.runCommit(async () => {
        const applied = await apply({ transactionContext, workingData });
        if (!applied.success || !applied.tableData) {
          throw new Error(applied.error || `${options.reason}: update apply failed`);
        }

        let saved = true;
        let messageIndex: number | undefined;
        const persistOptions = applied.persist || {};
        const revisionWriteSet = persistOptions.revisionWriteSet ?? options.revisionWriteSet;
        const targetSheetKeys = persistOptions.targetSheetKeys !== undefined ? persistOptions.targetSheetKeys : options.targetSheetKeys;
        const operations = persistOptions.operations ?? options.operations;
        commitRevisionWriteSet = revisionWriteSet;
        if (!options.skipChatSave) {
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
            assumeCommitLock: true,
            transactionContext,
          });
          saved = saveResult.saved;
          messageIndex = saveResult.messageIndex;
          if (!saveResult.saved) {
            logWarn_ACU(`[TableUpdateCommit] persist failed after runtime update, reload runtime before releasing lock: ${saveResult.error || 'unknown error'}`);
            await reloadStorageProvider();
            throw new Error(saveResult.error || `${options.reason}: persist failed`);
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
    const message = error?.message || String(error);
    logError_ACU(`[TableUpdateCommit] ${options.reason} failed:`, error);
    return { success: false, error: message };
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
  return runTableUpdateCommit_ACU({ ...options, operations }, async () => {
    const provider = await ensureStorageProviderReady_ACU();
    const mutationResult = provider.executeMutation(options.sql, options.params);
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
    return {
      success: true,
      value: options.mapValue({ mutationResult, tableData: tableData as TableDataObject_ACU }),
      tableData: tableData as TableDataObject_ACU,
      mutationResult,
    };
  });
}
