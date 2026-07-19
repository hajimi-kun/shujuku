import type { TableDataObject_ACU, Sheet_ACU } from '../../shared/models/table-data';
import type { TableSheetSchemaMigrateOperation_ACU, TableSheetSchemaMigrateOperationV2Contract_ACU } from './storage-frame-v2-types';
import {
  buildSheetSchemaMigrationOperation_ACU,
  buildSheetSchemaMigrationOperationV2_ACU,
} from './table-schema-migration';
import { hydrateTableDataStrict_ACU } from './sqlite-template-validation';

export type SchemaMigrationPreflightIntent_ACU = Omit<
  TableSheetSchemaMigrateOperationV2Contract_ACU,
  'kind' | 'contractVersion' | 'sheetKey' | 'beforeSchema' | 'targetSchema'
  | 'beforeSchemaDigest' | 'targetSchemaDigest' | 'dryRun'
>;

export interface SchemaMigrationPreflightResult_ACU {
  changedSheetKeys: string[];
  blockers: string[];
  operations: TableSheetSchemaMigrateOperation_ACU[];
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

/**
 * Read-only validation for editor candidates. It never creates a frame entry or
 * mutates either input. V1-compatible changes remain V1 contracts; changes
 * outside that subset require the caller to supply an explicit V2 intent.
 */
export async function preflightSchemaMigrations_ACU(input: {
  baselineData: TableDataObject_ACU;
  candidateData: TableDataObject_ACU;
  intents?: Record<string, SchemaMigrationPreflightIntent_ACU | undefined>;
}): Promise<SchemaMigrationPreflightResult_ACU> {
  const changedSheetKeys = Object.keys(input.candidateData || {}).filter(sheetKey => {
    if (!sheetKey.startsWith('sheet_')) return false;
    const before = input.baselineData?.[sheetKey];
    const after = input.candidateData?.[sheetKey];
    return isSheet_ACU(before) && isSheet_ACU(after) && schemaProjection_ACU(before) !== schemaProjection_ACU(after);
  });
  if (changedSheetKeys.length === 0) return { changedSheetKeys, blockers: [], operations: [] };

  const blockers: string[] = [];
  const operations: SchemaMigrationPreflightResult_ACU['operations'] = [];
  for (const sheetKey of changedSheetKeys) {
    const before = input.baselineData[sheetKey] as Sheet_ACU;
    const after = input.candidateData[sheetKey] as Sheet_ACU;
    try {
      operations.push(await buildSheetSchemaMigrationOperation_ACU(sheetKey, before, after));
      continue;
    } catch (v1Error: any) {
      const intent = input.intents?.[sheetKey];
      if (!intent) {
        blockers.push(`${sheetKey}: ${v1Error?.message || 'schema migration 缺少显式 V2 intent。'}`);
        continue;
      }
      try {
        operations.push(await buildSheetSchemaMigrationOperationV2_ACU(sheetKey, before, after, intent));
      } catch (v2Error: any) {
        blockers.push(`${sheetKey}: ${v2Error?.message || 'schema migration V2 preflight 失败。'}`);
      }
    }
  }
  if (blockers.length > 0) return { changedSheetKeys, blockers, operations: [] };
  try {
    await hydrateTableDataStrict_ACU(input.candidateData);
  } catch (error: any) {
    return { changedSheetKeys, operations: [], blockers: [`完整 candidate SQLite hydrate 失败: ${error?.message || String(error)}`] };
  }
  return { changedSheetKeys, blockers: [], operations };
}
