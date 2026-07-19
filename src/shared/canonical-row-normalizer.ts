export interface CanonicalRowIssue_ACU {
  sheetKey: string;
  rowIndex: number;
  reason: 'empty_row_id' | 'invalid_row' | 'duplicate_row_id';
}

export interface CanonicalRowNormalizationResult_ACU {
  changedSheetKeys: string[];
  removedRows: CanonicalRowIssue_ACU[];
  errors: CanonicalRowIssue_ACU[];
}

export function isEmptyCanonicalRowId_ACU(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export function formatCanonicalRowIssues_ACU(issues: CanonicalRowIssue_ACU[]): string {
  return issues
    .map(issue => `${issue.sheetKey} 第 ${issue.rowIndex} 行：${issue.reason}`)
    .join('；');
}

function normalizeRows_ACU(
  rows: unknown[],
  sheetKey: string,
  startIndex: number,
  result: CanonicalRowNormalizationResult_ACU,
): { rows: unknown[]; changed: boolean } {
  const usedRowIds = new Set<string>();
  const nextRows: unknown[] = [];
  let changed = false;
  rows.forEach((row, offset) => {
    const rowIndex = startIndex + offset;
    if (!Array.isArray(row)) {
      result.errors.push({ sheetKey, rowIndex, reason: 'invalid_row' });
      changed = true;
      return;
    }
    if (isEmptyCanonicalRowId_ACU(row[0])) {
      result.removedRows.push({ sheetKey, rowIndex, reason: 'empty_row_id' });
      changed = true;
      return;
    }
    const rowId = String(row[0]).trim();
    if (usedRowIds.has(rowId)) {
      result.errors.push({ sheetKey, rowIndex, reason: 'duplicate_row_id' });
    } else {
      usedRowIds.add(rowId);
    }
    if (row[0] !== rowId) {
      row[0] = rowId;
      changed = true;
    }
    nextRows.push(row);
  });
  return { rows: nextRows, changed };
}

/**
 * Canonical table data must never retain a row without an identity.
 * Empty row_id means that row has been deleted; duplicate IDs remain an
 * explicit error because choosing a winner would silently lose data.
 */
export function normalizeCanonicalTableRows_ACU(data: Record<string, any> | null | undefined): CanonicalRowNormalizationResult_ACU {
  const result: CanonicalRowNormalizationResult_ACU = { changedSheetKeys: [], removedRows: [], errors: [] };
  if (!data || typeof data !== 'object') return result;

  Object.entries(data).forEach(([sheetKey, sheet]) => {
    if (!sheetKey.startsWith('sheet_') || !sheet || typeof sheet !== 'object') return;
    const content = (sheet as any).content;
    if (!Array.isArray(content) || content.length === 0 || !Array.isArray(content[0])) return;
    let changed = false;
    if (content[0][0] === null) {
      content[0][0] = 'row_id';
      changed = true;
    }
    const normalizedContent = normalizeRows_ACU(content.slice(1), sheetKey, 1, result);
    if (normalizedContent.changed) changed = true;
    content.splice(1, content.length - 1, ...normalizedContent.rows);

    if (Array.isArray((sheet as any).seedRows)) {
      const normalizedSeedRows = normalizeRows_ACU((sheet as any).seedRows, sheetKey, 0, result);
      if (normalizedSeedRows.changed) changed = true;
      (sheet as any).seedRows = normalizedSeedRows.rows;
    }
    if (changed) result.changedSheetKeys.push(sheetKey);
  });
  return result;
}
