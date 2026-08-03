import type { TableDataObject_ACU, Sheet_ACU } from '../../shared/models/table-data';
import { parseDDLColumnInfos_ACU } from '../../shared/ddl-utils';
import type { TableSheetSchemaMigrateOperation_ACU, TableSheetSchemaMigrateOperationV2Contract_ACU } from './storage-frame-v2-types';
import {
  buildSheetSchemaMigrationOperation_ACU,
  buildSheetSchemaMigrationOperationV2_ACU,
  applySheetSchemaMigrationOperation_ACU,
} from './table-schema-migration';
import { planSheetSchemaMigration_ACU, type SchemaMigrationPlannerChoice_ACU } from './schema-migration-planner';
import { hydrateTableDataStrict_ACU } from './sqlite-template-validation';

export type SchemaMigrationPreflightIntent_ACU = Omit<
  TableSheetSchemaMigrateOperationV2Contract_ACU,
  'kind' | 'contractVersion' | 'sheetKey' | 'beforeSchema' | 'targetSchema'
  | 'beforeSchemaDigest' | 'targetSchemaDigest' | 'dryRun'
>;

export const DESTRUCTIVE_COLUMN_DROP_CONFIRMATION_REQUIRED_ACU = 'DESTRUCTIVE_COLUMN_DROP_CONFIRMATION_REQUIRED';

export interface SchemaMigrationPreflightIssue_ACU {
  code: typeof DESTRUCTIVE_COLUMN_DROP_CONFIRMATION_REQUIRED_ACU;
  sheetKey: string;
  tableName: string;
  droppedColumns: Array<{
    physicalName: string;
    displayHeader: string;
    index: number;
  }>;
  affectedRowCount: number;
  message: string;
}

export interface SchemaMigrationPreflightDecision_ACU {
  sheetKey: string;
  status: 'auto_apply' | 'needs_choice' | 'needs_confirmation' | 'invalid';
  code: string;
  message?: string;
  choices?: SchemaMigrationPlannerChoice_ACU[];
}

export interface SchemaMigrationPreflightResult_ACU {
  changedSheetKeys: string[];
  blockers: string[];
  issues: SchemaMigrationPreflightIssue_ACU[];
  operations: TableSheetSchemaMigrateOperation_ACU[];
  decisions: SchemaMigrationPreflightDecision_ACU[];
}

function isSheet_ACU(value: unknown): value is Sheet_ACU {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function schemaProjection_ACU(sheet: Sheet_ACU): string {
  return JSON.stringify({
    uid: sheet.uid,
    headers: Array.isArray(sheet.content?.[0]) ? sheet.content[0] : [],
    ddl: sheet.sourceData?.ddl || '',
  });
}

function getDestructiveDropIssue_ACU(sheetKey: string, before: Sheet_ACU, after: Sheet_ACU): SchemaMigrationPreflightIssue_ACU | null {
  const beforeColumns = parseDDLColumnInfos_ACU(String(before.sourceData?.ddl || ''));
  const afterNames = new Set(parseDDLColumnInfos_ACU(String(after.sourceData?.ddl || '')).map(column => column.sqlName));
  const headers = Array.isArray(before.content?.[0]) ? before.content[0] : [];
  const droppedColumns = beforeColumns
    .filter(column => column.sqlName.toLowerCase() !== 'row_id' && !afterNames.has(column.sqlName))
    .map(column => ({
      physicalName: column.sqlName,
      displayHeader: String(headers[column.index] ?? column.comment ?? column.sqlName),
      index: column.index,
    }));
  if (droppedColumns.length === 0) return null;
  const tableName = String(before.name || before.uid || sheetKey);
  return {
    code: DESTRUCTIVE_COLUMN_DROP_CONFIRMATION_REQUIRED_ACU,
    sheetKey,
    tableName,
    droppedColumns,
    affectedRowCount: Math.max(0, (Array.isArray(before.content) ? before.content.length : 0) - 1),
    message: `表「${tableName}」删除 ${droppedColumns.map(column => `「${column.displayHeader}」`).join('、')}需要显式确认。`,
  };
}

/**
 * Read-only validation for editor candidates. It never creates a frame entry or
 * mutates either input. V1-compatible changes remain V1 contracts; changes
 * outside that subset may use the semantic planner's uniquely provable V2
 * intent; ambiguous or unsupported changes remain blocked until explicitly resolved.
 */
export async function preflightSchemaMigrations_ACU(input: {
  baselineData: TableDataObject_ACU;
  candidateData: TableDataObject_ACU;
  intents?: Record<string, SchemaMigrationPreflightIntent_ACU | undefined>;
  /** These sheets require their explicit V2 contract even when V1 would accept the diff. */
  forceV2SheetKeys?: readonly string[];
  /** Authorizes only this preflight invocation to construct destructive drop operations. */
  destructiveChangeConfirmed?: boolean;
}): Promise<SchemaMigrationPreflightResult_ACU> {
  const changedSheetKeys = Object.keys(input.candidateData || {}).filter(sheetKey => {
    if (!sheetKey.startsWith('sheet_')) return false;
    const before = input.baselineData?.[sheetKey];
    const after = input.candidateData?.[sheetKey];
    return isSheet_ACU(before) && isSheet_ACU(after) && schemaProjection_ACU(before) !== schemaProjection_ACU(after);
  });
  if (changedSheetKeys.length === 0) return { changedSheetKeys, blockers: [], issues: [], operations: [], decisions: [] };

  const blockers: string[] = [];
  const issues: SchemaMigrationPreflightIssue_ACU[] = [];
  const operations: SchemaMigrationPreflightResult_ACU['operations'] = [];
  const decisions: SchemaMigrationPreflightDecision_ACU[] = [];
  const forceV2SheetKeys = new Set(input.forceV2SheetKeys || []);
  for (const sheetKey of changedSheetKeys) {
    const before = input.baselineData[sheetKey] as Sheet_ACU;
    const after = input.candidateData[sheetKey] as Sheet_ACU;
    try {
      if (forceV2SheetKeys.has(sheetKey)) throw new Error('schema migration requires explicit V2 intent。');
      operations.push(await buildSheetSchemaMigrationOperation_ACU(sheetKey, before, after, {
        destructiveChangeConfirmed: input.destructiveChangeConfirmed === true,
      }));
      decisions.push({ sheetKey, status: 'auto_apply', code: 'V1_SAFE_SUBSET' });
      continue;
    } catch (v1Error: any) {
      const explicitIntent = input.intents?.[sheetKey];
      const planned = explicitIntent || forceV2SheetKeys.has(sheetKey)
        ? null
        : planSheetSchemaMigration_ACU(before, after);
      const inferredIntent = planned?.status === 'auto_apply' ? planned.intent : undefined;
      const inferredReason = planned && planned.status !== 'auto_apply' ? planned.message : undefined;
      const intent = explicitIntent || inferredIntent;
      if (!intent) {
        const issue = input.destructiveChangeConfirmed === true ? null : getDestructiveDropIssue_ACU(sheetKey, before, after);
        if (issue && String(v1Error?.message || '').includes('删除列需要显式确认')) {
          issues.push(issue);
          decisions.push({ sheetKey, status: 'needs_confirmation', code: issue.code, message: issue.message });
          blockers.push(`${sheetKey}: ${issue.message}`);
        } else {
          decisions.push({
            sheetKey,
            status: planned?.status === 'needs_choice' ? 'needs_choice' : 'invalid',
            code: planned?.code || 'V1_AND_V2_UNRESOLVED',
            message: inferredReason || v1Error?.message,
            choices: planned?.status === 'needs_choice' ? planned.choices : undefined,
          });
          blockers.push(`${sheetKey}: ${inferredReason || v1Error?.message || 'schema migration 缺少显式 V2 intent。'}`);
        }
        continue;
      }
      try {
        const hasDestructiveDrop = getDestructiveDropIssue_ACU(sheetKey, before, after) !== null;
        const v2Intent: SchemaMigrationPreflightIntent_ACU = {
          ...intent,
          migrationPolicy: {
            ...intent.migrationPolicy,
            destructiveChangeConfirmed: input.destructiveChangeConfirmed === true && hasDestructiveDrop
              ? true
              : intent.migrationPolicy.destructiveChangeConfirmed,
          },
        };
        operations.push(await buildSheetSchemaMigrationOperationV2_ACU(sheetKey, before, after, v2Intent));
        decisions.push({ sheetKey, status: 'auto_apply', code: explicitIntent ? 'EXPLICIT_V2_INTENT' : 'UNIQUE_V2_INTENT' });
      } catch (v2Error: any) {
        const issue = input.destructiveChangeConfirmed === true ? null : getDestructiveDropIssue_ACU(sheetKey, before, after);
        if (issue && String(v2Error?.message || '').includes('destructiveChangeConfirmed')) {
          issues.push(issue);
          decisions.push({ sheetKey, status: 'needs_confirmation', code: issue.code, message: issue.message });
          blockers.push(`${sheetKey}: ${issue.message}`);
        } else {
          decisions.push({ sheetKey, status: 'invalid', code: 'V2_CONTRACT_INVALID', message: v2Error?.message || 'schema migration V2 preflight 失败。' });
          blockers.push(`${sheetKey}: ${v2Error?.message || 'schema migration V2 preflight 失败。'}`);
        }
      }
    }
  }
  if (blockers.length > 0) return { changedSheetKeys, blockers, issues, operations: [], decisions };
  try {
    let appliedState = input.baselineData;
    for (const operation of operations) {
      appliedState = await applySheetSchemaMigrationOperation_ACU(appliedState, operation);
    }
    for (const sheetKey of changedSheetKeys) {
      const applied = appliedState[sheetKey] as Sheet_ACU | undefined;
      const candidate = input.candidateData[sheetKey] as Sheet_ACU | undefined;
      const appliedProjection = applied ? JSON.stringify({
        uid: applied.uid, content: applied.content, ddl: applied.sourceData?.ddl || '',
      }) : '';
      const candidateProjection = candidate ? JSON.stringify({
        uid: candidate.uid, content: candidate.content, ddl: candidate.sourceData?.ddl || '',
      }) : '';
      if (appliedProjection !== candidateProjection) {
        throw new Error(`${sheetKey}: migration operation 应用结果与 candidate 不一致。`);
      }
    }
  } catch (error: any) {
    return { changedSheetKeys, operations: [], issues: [], blockers: [error?.message || String(error)], decisions: decisions.map(decision => ({ ...decision, status: 'invalid', code: 'OPERATION_CANDIDATE_MISMATCH', message: error?.message || String(error) })) };
  }
  try {
    await hydrateTableDataStrict_ACU(input.candidateData);
  } catch (error: any) {
    return { changedSheetKeys, operations: [], issues: [], blockers: [`完整 candidate SQLite hydrate 失败: ${error?.message || String(error)}`], decisions: decisions.map(decision => ({ ...decision, status: 'invalid', code: 'CANDIDATE_SQLITE_HYDRATE_FAILED', message: error?.message || String(error) })) };
  }
  return { changedSheetKeys, blockers: [], issues: [], operations, decisions };
}
