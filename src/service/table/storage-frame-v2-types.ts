import type { Sheet_ACU, TableDataObject_ACU } from '../../shared/models/table-data';

export type TableMutationSourceV2_ACU =
  | 'auto_fill'
  | 'manual_fill'
  | 'group_fill'
  | 'manual_crud'
  | 'raw_sql_mutation'
  | 'raw_sql_batch'
  | 'import'
  | 'merge_summary'
  | 'template_assistant'
  | 'system';

export interface TableMutationEventV2_ACU {
  filledSheetKeys: string[];
  changedSheetKeys: string[];
  groupKeys?: string[];
  requestId?: string;
  batchId?: string;
  error?: string;
}

export interface TableCheckpointScheduleSummaryV2_ACU {
  lastFilledAiFloor?: number;
  lastChangedAiFloor?: number;
}

export type ManualRefillProgressStatusV2_ACU =
  | 'in_progress'
  | 'complete'
  | 'planned'
  | 'collecting'
  | 'committing'
  | 'committed'
  | 'stopped'
  | 'failed'
  | 'sync_pending';

export interface ManualRefillProgressV2_ACU {
  kind: 'manual_refill';
  /** 未带 version 的历史进度继续按旧契约读取。 */
  version?: 2;
  status: ManualRefillProgressStatusV2_ACU;
  selectedSheetKeys: string[];
  contextMessageIndices: number[];
  originalStartMessageIndex: number;
  targetMessageIndex: number;
  batchSize: number;
  completedUntilMessageIndex: number;
  completedSheetMessageIndexByKey?: Record<string, number>;
  runId?: string;
  mode?: 'refill' | 'catch_up';
  targetAiFloor?: number;
  planSignature?: string;
  waveIndex?: number;
  bucketIndex?: number;
  totalWaves?: number;
  totalBuckets?: number;
  lastError?: string;
  updatedAt: number;
}

export interface TableCheckpointV2_ACU {
  kind: 'full';
  createdAt: number;
  reason: 'init' | 'periodic' | 'manual' | 'schema_change' | 'compaction' | 'import' | 'migration' | 'integrity_repair';
  data: TableDataObject_ACU;
  scheduleSummary?: Record<string, TableCheckpointScheduleSummaryV2_ACU>;
  event?: TableMutationEventV2_ACU;
  manualRefillProgress?: ManualRefillProgressV2_ACU;
}

/** 同一 V2 frame 内的单表恢复基底；不承担 mate 或其他根级元数据。 */
export interface TableSheetIntroductionTimelineV2_ACU {
  kind: 'sheet_introduction';
  /** introduction shard 所在的 AI message index。 */
  activateAtMessageIndex: number;
  /** 同一 frame 中在该 seq 之后才将新表加入 replay state。 */
  afterSeq: number;
}

export interface TableSheetCheckpointV2_ACU {
  kind: 'sheet_full';
  createdAt: number;
  reason: TableCheckpointV2_ACU['reason'];
  sheetKey: string;
  data: Sheet_ACU;
  scheduleSummary?: TableCheckpointScheduleSummaryV2_ACU;
  event?: TableMutationEventV2_ACU;
  manualRefillProgress?: ManualRefillProgressV2_ACU;
  baseRevision?: string | null;
  timeline?: TableSheetIntroductionTimelineV2_ACU;
}

export type TableMutationOperationV2_ACU =
  | TableSqlBatchOperationV2_ACU
  | TableSqlSheetBatchOperationV2_ACU
  | TableEditDslOperationV2_ACU
  | TableRowUpsertPatchV2_ACU
  | TableRowDeletePatchV2_ACU
  | TableMetaPatchV2_ACU
  | TableSheetSchemaMigrateOperation_ACU
  | TableSheetReplaceOperationV2_ACU
  | TableDataReplaceOperationV2_ACU;

export type TableSqlBindValueV2_ACU = string | number | null;

/** 旧整批 SQL 结构：用于历史兼容和 raw/cross-table SQL；新填表写入应优先使用 sql_sheet_batch。 */
export interface TableSqlBatchOperationV2_ACU {
  kind: 'sql_batch';
  statements: string[];
  /** 与 statements 同索引的参数绑定；无参数语句可省略对应项或传空数组。 */
  params?: TableSqlBindValueV2_ACU[][];
}

/** 新单表 SQL 结构：保留 SQL replay 语义，同时提供可按 sheetKey 清理的结构化归属。 */
export interface TableSqlSheetBatchOperationV2_ACU {
  kind: 'sql_sheet_batch';
  sheetKey: string;
  statements: string[];
  /** 与 statements 同索引的参数绑定；无参数语句可省略对应项或传空数组。 */
  params?: TableSqlBindValueV2_ACU[][];
  tableName?: string;
  reason?: 'manual_crud' | 'import' | 'system';
}

export interface TableEditDslOperationV2_ACU {
  kind: 'table_edit_dsl';
  text: string;
  updateMode?: string;
}

export interface TableSheetReplaceOperationV2_ACU {
  kind: 'sheet_replace';
  sheetKey: string;
  sheet: Sheet_ACU;
  reason: 'manual_crud' | 'import' | 'system';
}

export interface TableDataReplaceOperationV2_ACU {
  kind: 'data_replace';
  data: TableDataObject_ACU;
  reason: 'checkpoint_fallback' | 'manual_crud' | 'import' | 'system';
}

// 旧 patch 结构仅用于兼容历史 V2 数据；新 V2 日志不再写 patches。
export type TablePatchV2_ACU =
  | TableRowUpsertPatchV2_ACU
  | TableRowDeletePatchV2_ACU
  | TableSheetReplacePatchV2_ACU
  | TableMetaPatchV2_ACU;

export interface TableRowUpsertPatchV2_ACU {
  kind: 'row_upsert';
  sheetKey: string;
  rowId: string;
  cells: (string | null)[];
}

export interface TableRowDeletePatchV2_ACU {
  kind: 'row_delete';
  sheetKey: string;
  rowId: string;
}

export interface TableSheetReplacePatchV2_ACU {
  kind: 'sheet_replace';
  sheetKey: string;
  sheet: Sheet_ACU;
  reason: 'schema_change' | 'unstable_row_id' | 'raw_sql_export' | 'import' | 'fallback';
}

export interface TableMetaPatchV2_ACU {
  kind: 'meta_update';
  sheetKey: string;
  /** 仅限非结构元数据；content、uid 与 sourceData.ddl 不得通过此 operation 修改。 */
  meta: Partial<Pick<Sheet_ACU, 'name' | 'orderNo' | 'updateConfig' | 'exportConfig'>>
    & { sourceData?: Partial<Omit<Sheet_ACU['sourceData'], 'ddl'>> };
}

export type TableSchemaColumnChangeV2_ACU =
  | { kind: 'rename_display'; physicalName: string; fromHeader: string; toHeader: string }
  | { kind: 'add'; physicalName: string; header: string; index: number }
  | { kind: 'drop'; physicalName: string; header: string; index: number };

/**
 * V1 reader contract uses the normalized original column definition as its
 * semantic boundary. P2 may decompose definitions for conversion, but V1
 * must reject any definition change rather than pretend to understand it.
 */
export interface TableSchemaColumnDescriptorV2_ACU {
  index: number;
  physicalName: string;
  displayHeader: string;
  normalizedDefinition: string;
}

export interface TableSheetSchemaDescriptorV2_ACU {
  descriptorVersion: 1;
  uid: string;
  tableName: string;
  headers: (string | null)[];
  ddl: string;
  normalizedSql: string;
  columns: TableSchemaColumnDescriptorV2_ACU[];
  tableConstraints: string[];
  tableSuffix: string;
}

/** P2 descriptor is deliberately separate from descriptorVersion: 1 because
 * both descriptor bodies are hashed as persisted replay contracts. */
export interface TableSchemaColumnDescriptorV2Contract_ACU {
  index: number;
  physicalName: string;
  displayHeader: string;
  normalizedDefinition: string;
  defaultExpression: string | null;
}

export interface TableSheetSchemaDescriptorV2Contract_ACU {
  descriptorVersion: 2;
  uid: string;
  tableName: string;
  headers: (string | null)[];
  ddl: string;
  normalizedSql: string;
  columns: TableSchemaColumnDescriptorV2Contract_ACU[];
  tableConstraints: string[];
  tableSuffix: string;
}

export type TableSchemaDefaultLiteralV2_ACU =
  | { kind: 'null'; sql: 'NULL'; value: null }
  | { kind: 'integer'; sql: string; value: number }
  | { kind: 'real'; sql: string; value: number }
  | { kind: 'string'; sql: string; value: string }
  | { kind: 'blob'; sql: string; value: string }
  | { kind: 'boolean'; sql: 'TRUE' | 'FALSE'; value: boolean };

export type TableSchemaFillStrategyV2_ACU =
  | { kind: 'literal'; literal: TableSchemaDefaultLiteralV2_ACU }
  | { kind: 'ddl_literal_default'; literal: TableSchemaDefaultLiteralV2_ACU };

export interface TableSchemaPhysicalColumnMappingV2_ACU {
  fromPhysicalName: string;
  toPhysicalName: string;
}

/** Deliberately finite: persisted migrations must never execute arbitrary code. */
export type TableSchemaConversionPolicyV2_ACU =
  | { kind: 'identity' }
  | { kind: 'stringify' }
  | { kind: 'integer_strict' }
  | { kind: 'real_strict' };

export interface TableSchemaColumnConversionV2_ACU {
  fromPhysicalName: string;
  toPhysicalName: string;
  policy: TableSchemaConversionPolicyV2_ACU;
}

export interface TableSchemaDryRunSummaryV2_ACU {
  convertedRowCount: number;
  failedRowCount: number;
  lossyRowCount: number;
}

export interface TableSchemaMigrationPolicyV2Contract_ACU {
  destructiveChangeConfirmed: boolean;
  lossyConversionConfirmed: boolean;
}

export interface TableSchemaMigrationPolicyV2_ACU {
  /** V1 中 drop 是唯一允许的破坏性变更，且必须显式确认。 */
  destructiveChangeConfirmed: boolean;
}

export interface TableSheetSchemaMigrateOperationV1_ACU {
  kind: 'sheet_schema_migrate';
  contractVersion: 1;
  sheetKey: string;
  beforeSchemaDigest: string;
  targetSchemaDigest: string;
  beforeSchema: TableSheetSchemaDescriptorV2_ACU;
  targetSchema: TableSheetSchemaDescriptorV2_ACU;
  columnChanges: TableSchemaColumnChangeV2_ACU[];
  migrationPolicy: TableSchemaMigrationPolicyV2_ACU;
}

export interface TableSheetSchemaMigrateOperationV2Contract_ACU {
  kind: 'sheet_schema_migrate';
  contractVersion: 2;
  sheetKey: string;
  beforeSchemaDigest: string;
  targetSchemaDigest: string;
  beforeSchema: TableSheetSchemaDescriptorV2Contract_ACU;
  targetSchema: TableSheetSchemaDescriptorV2Contract_ACU;
  physicalColumnMappings: TableSchemaPhysicalColumnMappingV2_ACU[];
  fills: Record<string, TableSchemaFillStrategyV2_ACU>;
  conversions: TableSchemaColumnConversionV2_ACU[];
  dryRun: TableSchemaDryRunSummaryV2_ACU;
  migrationPolicy: TableSchemaMigrationPolicyV2Contract_ACU;
}

/** Historical exported name is retained for the contractVersion: 1 reader. */
export type TableSheetSchemaMigrateOperationV2_ACU = TableSheetSchemaMigrateOperationV1_ACU;

export type TableSheetSchemaMigrateOperation_ACU =
  | TableSheetSchemaMigrateOperationV1_ACU
  | TableSheetSchemaMigrateOperationV2Contract_ACU;

export type TableWriteConflictUnitV2_ACU =
  | { kind: 'sheet'; sheetKey: string }
  | { kind: 'row'; sheetKey: string; rowId: string }
  | { kind: 'cell'; sheetKey: string; rowId: string; columnKey: string }
  | { kind: 'schema'; sheetKey: string }
  | { kind: 'all' };

export type TableMutationWriteSetV2_ACU = TableWriteConflictUnitV2_ACU[];

export interface TableMutationLogEntryV2_ACU extends TableMutationEventV2_ACU {
  seq: number;
  entryId: string;
  createdAt: number;
  source: TableMutationSourceV2_ACU;
  targetMessageIndex: number;
  aiFloor: number;
  operations: TableMutationOperationV2_ACU[];
  /** 兼容旧 V2 derived patch log；新写入不再使用。 */
  patches?: TablePatchV2_ACU[];
  baseRevision?: string | null;
  parentRevision?: string | null;
  commitRevision?: string;
  writeSet?: TableMutationWriteSetV2_ACU;
}

export interface TableStorageFrameV2_ACU {
  version: 2;
  headRevision?: string | null;
  checkpoint?: TableCheckpointV2_ACU;
  perSheetCheckpoints?: Record<string, TableSheetCheckpointV2_ACU>;
  manualRefillProgress?: ManualRefillProgressV2_ACU;
  logEntries: TableMutationLogEntryV2_ACU[];
}
