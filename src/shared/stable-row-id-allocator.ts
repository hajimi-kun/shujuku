function canonicalRowId_ACU(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const rowId = String(value).trim();
  return rowId ? rowId : null;
}

export function createStableRowIdReservation_ACU(rows: unknown[] | null | undefined): Set<string> {
  const reserved = new Set<string>();
  for (const row of rows || []) {
    if (!Array.isArray(row)) continue;
    const rowId = canonicalRowId_ACU(row[0]);
    if (rowId) reserved.add(rowId);
  }
  return reserved;
}

/**
 * Allocates the smallest unused positive integer ID and reserves it immediately.
 * This is only for newly created rows; it must not be used to rewrite persisted IDs.
 */
export function allocateStableRowId_ACU(reserved: Set<string>): string {
  let candidate = 1;
  while (reserved.has(String(candidate))) candidate += 1;
  const rowId = String(candidate);
  reserved.add(rowId);
  return rowId;
}
