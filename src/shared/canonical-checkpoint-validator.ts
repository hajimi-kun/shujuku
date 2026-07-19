import { isEmptyCanonicalRowId_ACU } from './canonical-row-normalizer';

export type CanonicalCheckpointKind_ACU = 'full' | 'sheet_full' | 'data';

export type CanonicalCheckpointIssueType_ACU =
  | 'checkpoint_not_object'
  | 'invalid_checkpoint_kind'
  | 'invalid_created_at'
  | 'invalid_reason'
  | 'invalid_data'
  | 'missing_sheet'
  | 'invalid_sheet_key'
  | 'sheet_key_mismatch'
  | 'invalid_sheet'
  | 'invalid_content'
  | 'invalid_header'
  | 'invalid_row'
  | 'row_width_mismatch'
  | 'empty_row_id'
  | 'duplicate_row_id';

export interface CanonicalCheckpointValidationContext_ACU {
  messageIndex?: number;
  aiFloor?: number;
  isolationKey?: string;
  reason?: string;
}

export interface CanonicalCheckpointIssue_ACU extends CanonicalCheckpointValidationContext_ACU {
  checkpointKind: CanonicalCheckpointKind_ACU;
  type: CanonicalCheckpointIssueType_ACU;
  sheetKey?: string;
  rowIndex?: number;
  rowId?: string;
}

export interface CanonicalCheckpointValidationResult_ACU {
  valid: boolean;
  issues: CanonicalCheckpointIssue_ACU[];
}

function isRecord_ACU(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createResult_ACU(): CanonicalCheckpointValidationResult_ACU {
  return { valid: true, issues: [] };
}

function addIssue_ACU(
  result: CanonicalCheckpointValidationResult_ACU,
  checkpointKind: CanonicalCheckpointKind_ACU,
  context: CanonicalCheckpointValidationContext_ACU,
  type: CanonicalCheckpointIssueType_ACU,
  details: Pick<CanonicalCheckpointIssue_ACU, 'sheetKey' | 'rowIndex' | 'rowId'> = {},
): void {
  result.valid = false;
  result.issues.push({ checkpointKind, ...context, type, ...details });
}

export function validateCanonicalCheckpointSheet_ACU(
  sheet: unknown,
  sheetKey: string,
  checkpointKind: CanonicalCheckpointKind_ACU,
  context: CanonicalCheckpointValidationContext_ACU = {},
): CanonicalCheckpointValidationResult_ACU {
  const result = createResult_ACU();
  if (!sheetKey.startsWith('sheet_')) {
    addIssue_ACU(result, checkpointKind, context, 'invalid_sheet_key', { sheetKey });
    return result;
  }
  if (!isRecord_ACU(sheet)) {
    addIssue_ACU(result, checkpointKind, context, 'invalid_sheet', { sheetKey });
    return result;
  }
  const content = sheet.content;
  if (!Array.isArray(content)) {
    addIssue_ACU(result, checkpointKind, context, 'invalid_content', { sheetKey });
    return result;
  }
  const header = content[0];
  if (!Array.isArray(header) || header.length === 0 || header[0] !== 'row_id') {
    addIssue_ACU(result, checkpointKind, context, 'invalid_header', { sheetKey, rowIndex: 0 });
    return result;
  }

  const rowIds = new Set<string>();
  for (let rowIndex = 1; rowIndex < content.length; rowIndex += 1) {
    const row = content[rowIndex];
    if (!Array.isArray(row)) {
      addIssue_ACU(result, checkpointKind, context, 'invalid_row', { sheetKey, rowIndex });
      continue;
    }
    if (isEmptyCanonicalRowId_ACU(row[0])) {
      addIssue_ACU(result, checkpointKind, context, 'empty_row_id', { sheetKey, rowIndex });
      continue;
    }
    const rowId = String(row[0]).trim();
    if (row.length !== header.length) {
      addIssue_ACU(result, checkpointKind, context, 'row_width_mismatch', { sheetKey, rowIndex, rowId });
    }
    if (rowIds.has(rowId)) {
      addIssue_ACU(result, checkpointKind, context, 'duplicate_row_id', { sheetKey, rowIndex, rowId });
      continue;
    }
    rowIds.add(rowId);
  }
  return result;
}

export function validateCanonicalCheckpointData_ACU(
  data: unknown,
  context: CanonicalCheckpointValidationContext_ACU = {},
): CanonicalCheckpointValidationResult_ACU {
  const result = createResult_ACU();
  if (!isRecord_ACU(data)) {
    addIssue_ACU(result, 'data', context, 'invalid_data');
    return result;
  }
  const sheets = Object.entries(data).filter(([key]) => key.startsWith('sheet_'));
  if (sheets.length === 0) {
    addIssue_ACU(result, 'data', context, 'missing_sheet');
    return result;
  }
  for (const [sheetKey, sheet] of sheets) {
    const validation = validateCanonicalCheckpointSheet_ACU(sheet, sheetKey, 'data', context);
    result.valid = result.valid && validation.valid;
    result.issues.push(...validation.issues);
  }
  return result;
}

export function validateCanonicalCheckpoint_ACU(
  checkpoint: unknown,
  context: CanonicalCheckpointValidationContext_ACU = {},
): CanonicalCheckpointValidationResult_ACU {
  const result = createResult_ACU();
  if (!isRecord_ACU(checkpoint)) {
    addIssue_ACU(result, 'full', context, 'checkpoint_not_object');
    return result;
  }
  const kind = checkpoint.kind;
  if (kind !== 'full' && kind !== 'sheet_full') {
    addIssue_ACU(result, 'full', context, 'invalid_checkpoint_kind');
    return result;
  }
  const checkpointKind = kind;
  const issueContext = { ...context, reason: typeof checkpoint.reason === 'string' ? checkpoint.reason : context.reason };
  if (!Number.isFinite(checkpoint.createdAt) || Number(checkpoint.createdAt) < 0) {
    addIssue_ACU(result, checkpointKind, issueContext, 'invalid_created_at');
  }
  if (typeof checkpoint.reason !== 'string' || checkpoint.reason.trim() === '') {
    addIssue_ACU(result, checkpointKind, issueContext, 'invalid_reason');
  }
  if (checkpointKind === 'full') {
    const validation = validateCanonicalCheckpointData_ACU(checkpoint.data, issueContext);
    result.valid = result.valid && validation.valid;
    result.issues.push(...validation.issues.map(issue => ({ ...issue, checkpointKind: 'full' as const })));
    return result;
  }
  const sheetKey = checkpoint.sheetKey;
  if (typeof sheetKey !== 'string' || !sheetKey.startsWith('sheet_')) {
    addIssue_ACU(result, checkpointKind, issueContext, 'sheet_key_mismatch');
    return result;
  }
  const validation = validateCanonicalCheckpointSheet_ACU(checkpoint.data, sheetKey, checkpointKind, issueContext);
  result.valid = result.valid && validation.valid;
  result.issues.push(...validation.issues);
  return result;
}
