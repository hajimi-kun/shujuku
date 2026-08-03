import type { Sheet_ACU } from '../../shared/models/table-data';
import { parseDDLColumnInfos_ACU, parseDDLSafeDefaultLiteral_ACU } from '../../shared/ddl-utils';
import type { TableSheetSchemaMigrateOperationV2Contract_ACU } from './storage-frame-v2-types';
import { getSheetSchemaDescriptorV2Contract_ACU } from './table-schema-migration';

export type SchemaMigrationPlannerIntent_ACU = Omit<
  TableSheetSchemaMigrateOperationV2Contract_ACU,
  'kind' | 'contractVersion' | 'sheetKey' | 'beforeSchema' | 'targetSchema'
  | 'beforeSchemaDigest' | 'targetSchemaDigest' | 'dryRun'
>;

export interface SchemaMigrationPlannerChoice_ACU {
  id: string;
  label: string;
  intent: SchemaMigrationPlannerIntent_ACU;
}

export type SchemaMigrationPlanDecision_ACU =
  | { status: 'auto_apply'; code: 'UNIQUE_V2_INTENT'; intent: SchemaMigrationPlannerIntent_ACU }
  | { status: 'needs_choice'; code: 'AMBIGUOUS_COLUMN_IDENTITY'; message: string; choices: SchemaMigrationPlannerChoice_ACU[] }
  | { status: 'invalid'; code: 'INVALID_SCHEMA' | 'UNSUPPORTED_SCHEMA_CHANGE'; message: string };

function semanticDefinition_ACU(column: { physicalName: string; normalizedDefinition: string }): string {
  return column.normalizedDefinition.slice(column.physicalName.length).trim();
}

function withoutNotNull_ACU(definition: string): string {
  return definition.replace(/\bNOT\s+NULL\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function planSheetSchemaMigration_ACU(before: Sheet_ACU, after: Sheet_ACU): SchemaMigrationPlanDecision_ACU {
  let beforeSchema: ReturnType<typeof getSheetSchemaDescriptorV2Contract_ACU>;
  let targetSchema: ReturnType<typeof getSheetSchemaDescriptorV2Contract_ACU>;
  try {
    beforeSchema = getSheetSchemaDescriptorV2Contract_ACU(before);
    targetSchema = getSheetSchemaDescriptorV2Contract_ACU(after);
  } catch (error: any) {
    return { status: 'invalid', code: 'INVALID_SCHEMA', message: error?.message || String(error) };
  }
  if (beforeSchema.uid !== targetSchema.uid) return { status: 'invalid', code: 'INVALID_SCHEMA', message: 'sheet uid 发生变化。' };
  if (JSON.stringify(beforeSchema.tableConstraints) !== JSON.stringify(targetSchema.tableConstraints)) {
    return { status: 'invalid', code: 'UNSUPPORTED_SCHEMA_CHANGE', message: '表级 constraint 变更需要独立语义判定。' };
  }
  if (beforeSchema.tableSuffix !== targetSchema.tableSuffix) {
    return { status: 'invalid', code: 'UNSUPPORTED_SCHEMA_CHANGE', message: 'CREATE TABLE suffix 变更需要独立语义判定。' };
  }

  const beforeByPhysical = new Map(beforeSchema.columns.map(column => [column.physicalName, column]));
  const targetByPhysical = new Map(targetSchema.columns.map(column => [column.physicalName, column]));
  const beforeInfoByPhysical = new Map(parseDDLColumnInfos_ACU(String(before.sourceData?.ddl || '')).map(column => [column.sqlName, column]));
  const targetInfoByPhysical = new Map(parseDDLColumnInfos_ACU(String(after.sourceData?.ddl || '')).map(column => [column.sqlName, column]));
  const removed = beforeSchema.columns.slice(1).filter(column => !targetByPhysical.has(column.physicalName));
  const added = targetSchema.columns.slice(1).filter(column => !beforeByPhysical.has(column.physicalName));
  const conversions: SchemaMigrationPlannerIntent_ACU['conversions'] = [];
  for (const source of beforeSchema.columns.filter(column => targetByPhysical.has(column.physicalName))) {
    const target = targetByPhysical.get(source.physicalName)!;
    const sourceDefinition = semanticDefinition_ACU(source);
    const targetDefinition = semanticDefinition_ACU(target);
    if (sourceDefinition === targetDefinition) continue;
    const sourceInfo = beforeInfoByPhysical.get(source.physicalName);
    const targetInfo = targetInfoByPhysical.get(target.physicalName);
    const removesOnlyNotNull = sourceInfo?.isNotNull === true
      && targetInfo?.isNotNull === false
      && sourceInfo.declaredType === targetInfo.declaredType
      && sourceInfo.defaultExpression === targetInfo.defaultExpression
      && withoutNotNull_ACU(sourceDefinition) === withoutNotNull_ACU(targetDefinition);
    if (removesOnlyNotNull) {
      conversions.push({
        fromPhysicalName: source.physicalName,
        toPhysicalName: target.physicalName,
        policy: { kind: 'identity' },
      });
      continue;
    }
    return { status: 'invalid', code: 'UNSUPPORTED_SCHEMA_CHANGE', message: `列「${source.displayHeader}」definition/constraint 变更需要独立 conversion 判定。` };
  }

  const mappings: SchemaMigrationPlannerIntent_ACU['physicalColumnMappings'] = [];
  const unmatchedRemoved = new Set(removed.map(column => column.physicalName));
  const unmatchedAdded = new Set(added.map(column => column.physicalName));
  for (const target of added) {
    const candidates = removed.filter(source => (
      unmatchedRemoved.has(source.physicalName)
      && source.displayHeader === target.displayHeader
      && semanticDefinition_ACU(source) === semanticDefinition_ACU(target)
    ));
    if (candidates.length > 1) {
      return {
        status: 'needs_choice',
        code: 'AMBIGUOUS_COLUMN_IDENTITY',
        message: `目标列「${target.displayHeader}」存在多个合法历史来源，需要确认列身份。`,
        choices: candidates.map((source): SchemaMigrationPlannerChoice_ACU => ({
          id: `map:${source.physicalName}->${target.physicalName}`,
          label: `${source.displayHeader}（${source.physicalName}）→ ${target.displayHeader}（${target.physicalName}）`,
          intent: {
            physicalColumnMappings: [{ fromPhysicalName: source.physicalName, toPhysicalName: target.physicalName }],
            fills: {},
            conversions: [],
            migrationPolicy: { destructiveChangeConfirmed: false, lossyConversionConfirmed: false },
          },
        })),
      };
    }
    if (candidates.length !== 1) continue;
    const source = candidates[0];
    mappings.push({ fromPhysicalName: source.physicalName, toPhysicalName: target.physicalName });
    unmatchedRemoved.delete(source.physicalName);
    unmatchedAdded.delete(target.physicalName);
  }
  if (unmatchedRemoved.size > 0) {
    const remainingRemoved = removed.filter(column => unmatchedRemoved.has(column.physicalName));
    const remainingAdded = added.filter(column => unmatchedAdded.has(column.physicalName));
    const source = remainingRemoved[0];
    const target = remainingAdded[0];
    const canOfferIdentityMapping = remainingRemoved.length === 1 && remainingAdded.length === 1
      && semanticDefinition_ACU(source) === semanticDefinition_ACU(target);
    const choices: SchemaMigrationPlannerChoice_ACU[] = canOfferIdentityMapping
      ? [{
        id: `map:${source.physicalName}->${target.physicalName}`,
        label: `${source.displayHeader}（${source.physicalName}）→ ${target.displayHeader}（${target.physicalName}）`,
        intent: {
          physicalColumnMappings: [{ fromPhysicalName: source.physicalName, toPhysicalName: target.physicalName }],
          fills: {},
          conversions: [],
          migrationPolicy: { destructiveChangeConfirmed: false, lossyConversionConfirmed: false },
        },
      }]
      : [];
    return {
      status: 'needs_choice',
      code: 'AMBIGUOUS_COLUMN_IDENTITY',
      message: 'physical add/drop 无法唯一推导列身份，需要确认列身份。',
      choices,
    };
  }

  const fills: SchemaMigrationPlannerIntent_ACU['fills'] = {};
  for (const physicalName of unmatchedAdded) {
    const target = targetByPhysical.get(physicalName)!;
    const literal = parseDDLSafeDefaultLiteral_ACU(target.defaultExpression);
    if (!literal) {
      return { status: 'invalid', code: 'UNSUPPORTED_SCHEMA_CHANGE', message: `新增列「${target.displayHeader}」缺少可安全静态求值的 literal DEFAULT。` };
    }
    fills[physicalName] = { kind: 'ddl_literal_default', literal };
  }

  const beforeRetainedOrder = beforeSchema.columns
    .filter(column => targetByPhysical.has(column.physicalName))
    .map(column => column.physicalName);
  const targetRetainedOrder = targetSchema.columns
    .filter(column => beforeByPhysical.has(column.physicalName))
    .map(column => column.physicalName);
  const isPureReorder = removed.length === 0
    && added.length === 0
    && JSON.stringify(beforeRetainedOrder) !== JSON.stringify(targetRetainedOrder);
  if (mappings.length === 0 && Object.keys(fills).length === 0 && conversions.length === 0 && !isPureReorder) {
    return { status: 'invalid', code: 'UNSUPPORTED_SCHEMA_CHANGE', message: '该变更不属于当前可自动推导的 V2 安全子集。' };
  }

  return {
    status: 'auto_apply',
    code: 'UNIQUE_V2_INTENT',
    intent: {
      physicalColumnMappings: mappings,
      fills,
      conversions,
      migrationPolicy: { destructiveChangeConfirmed: false, lossyConversionConfirmed: false },
    },
  };
}