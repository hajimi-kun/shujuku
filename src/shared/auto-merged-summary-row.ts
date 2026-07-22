export const LEGACY_AUTO_MERGED_MARKER_ACU = 'auto_merged';

export function hasLegacyAutoMergedSummaryCode_ACU(row: unknown): boolean {
  return Array.isArray(row)
    && typeof row[1] === 'string'
    && row[1].trim().toUpperCase().startsWith('AM');
}

export function hasLegacyAutoMergedMarker_ACU(row: unknown): boolean {
  return Array.isArray(row) && row[row.length - 1] === LEGACY_AUTO_MERGED_MARKER_ACU;
}

export function isAutoMergedSummaryRow_ACU(
  row: unknown,
  knownRowIds: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (!Array.isArray(row)) return false;
  const rowId = row[0] === null || row[0] === undefined ? '' : String(row[0]).trim();
  return hasLegacyAutoMergedMarker_ACU(row)
    || hasLegacyAutoMergedSummaryCode_ACU(row)
    || (rowId !== '' && knownRowIds.has(rowId));
}

export function stripLegacyAutoMergedMarker_ACU(row: unknown, headerWidth: number): boolean {
  if (!Array.isArray(row)
    || row.length !== headerWidth + 1
    || !hasLegacyAutoMergedMarker_ACU(row)) {
    return false;
  }
  row.pop();
  return true;
}
