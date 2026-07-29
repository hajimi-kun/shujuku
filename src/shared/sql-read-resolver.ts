import type { TableDataObject_ACU } from './models/table-data';
import { parseDDLColumnInfos_ACU, parseDDLTableName } from './ddl-utils';
import { getPhysicalTableNameForSheet_ACU, resolvePhysicalTableNames_ACU } from './sheet-identity';
import { resolveEffectiveDDL } from '../data/sqlite/schema-mapper';
import { rebindSqlReadIdentifiers_ACU } from './sql-mutation-table-rebind';

export interface SheetColumnAliasMapResult_ACU {
  aliases: Map<string, Map<string, string>>;
  conflicts: Map<string, Set<string>>;
}

export interface SheetAliasMapResult_ACU {
  aliases: Map<string, string>;
  conflicts: Set<string>;
}

export interface ReadQueryResolveResult_ACU {
  sql: string;
  tableRebindCount: number;
  columnRebindCount: number;
  tableConflicts?: string[];
  columnConflicts?: string[];
  conflicts?: string[];
}

function addAlias_ACU(aliases: Map<string, string>, conflicts: Set<string>, alias: unknown, physicalName: string): void {
  const key = String(alias || '').trim().toLowerCase();
  if (!key || conflicts.has(key)) return;
  const existing = aliases.get(key);
  if (existing && existing !== physicalName) {
    aliases.delete(key);
    conflicts.add(key);
    return;
  }
  aliases.set(key, physicalName);
}

/** Builds the shared, conflict-safe table alias registry used by SQL readers and writers. */
export function buildSheetTableAliasMap_ACU(
  sources: Iterable<TableDataObject_ACU | Record<string, unknown> | null | undefined>,
  options: { includeExtendedAliases?: boolean; skipInvalidSources?: boolean } = {},
): SheetAliasMapResult_ACU {
  const aliases = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    let physicalNames: Map<string, string>;
    try {
      physicalNames = resolvePhysicalTableNames_ACU(source);
    } catch (error) {
      if (options.skipInvalidSources) continue;
      throw error;
    }
    for (const [sheetKey, physicalName] of physicalNames) {
      const sheet = (source as Record<string, any>)[sheetKey];
      const sourceAliases = [parseDDLTableName(String(sheet?.sourceData?.ddl || '')), physicalName];
      if (options.includeExtendedAliases !== false) {
        sourceAliases.push(sheetKey, sheet?.uid, sheet?.name);
      }
      sourceAliases.forEach(alias => addAlias_ACU(aliases, conflicts, alias, physicalName));
    }
  }
  return { aliases, conflicts };
}

/** Builds table-scoped column aliases without guessing ambiguous fallback DDL columns. */
export function buildSheetColumnAliasMap_ACU(
  sources: Iterable<TableDataObject_ACU | Record<string, unknown> | null | undefined>,
): SheetColumnAliasMapResult_ACU {
  const aliases = new Map<string, Map<string, string>>();
  const conflicts = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [sheetKey, value] of Object.entries(source)) {
      if (!sheetKey.startsWith('sheet_') || !value || typeof value !== 'object') continue;
      const sheet = value as any;
      const physicalName = getPhysicalTableNameForSheet_ACU(source as TableDataObject_ACU, sheetKey);
      const columns = aliases.get(physicalName) || new Map<string, string>();
      const resolved = resolveEffectiveDDL(sheet, sheet.uid || sheetKey, physicalName);
      const columnConflicts = conflicts.get(physicalName) || new Set<string>();
      for (const mapping of resolved.columnMap.mappings) {
        columns.set(String(mapping.sqlName).toLowerCase(), mapping.sqlName);
        columns.set(String(mapping.displayName).toLowerCase(), mapping.sqlName);
      }
      if (resolved.source !== 'explicit' && resolved.originalDDL) {
        const claimedTargets = new Map<string, string>();
        const rejectedTargets = new Set<string>();
        const fallbackAliases = new Map<string, string>();
        for (const column of parseDDLColumnInfos_ACU(resolved.originalDDL)) {
          const sourceKey = column.sqlName.toLowerCase();
          const matched = resolved.columnMap.mappings.filter(mapping => (
            mapping.displayName === column.sqlName || mapping.displayName === column.comment
          ));
          if (matched.length !== 1) {
            columnConflicts.add(sourceKey);
            continue;
          }
          const target = matched[0].sqlName;
          const targetKey = target.toLowerCase();
          if (rejectedTargets.has(targetKey)) {
            columnConflicts.add(sourceKey);
            continue;
          }
          const claimedSource = claimedTargets.get(targetKey);
          if (!claimedSource || claimedSource === sourceKey) {
            claimedTargets.set(targetKey, sourceKey);
            fallbackAliases.set(sourceKey, target);
            continue;
          }
          fallbackAliases.delete(claimedSource);
          fallbackAliases.delete(sourceKey);
          columnConflicts.add(claimedSource);
          columnConflicts.add(sourceKey);
          claimedTargets.delete(targetKey);
          rejectedTargets.add(targetKey);
        }
        for (const [source, target] of fallbackAliases) columns.set(source, target);
      }
      aliases.set(physicalName, columns);
      if (columnConflicts.size > 0) conflicts.set(physicalName, columnConflicts);
    }
  }
  return { aliases, conflicts };
}

function isSqlWordStart_ACU(char: string): boolean {
  return /^[A-Za-z_\u0080-\uFFFF]$/.test(char);
}

function isSqlWordPart_ACU(char: string): boolean {
  return /^[A-Za-z0-9_$\u0080-\uFFFF]$/.test(char);
}

function protectImplicitSelectAliases_ACU(masked: string, mask: (value: string) => string): string {
  const selectScopes: Array<{ start: number; depth: number }> = [];
  let depth = 0;
  for (let index = 0; index < masked.length;) {
    if (masked[index] === '(') { depth += 1; index += 1; continue; }
    if (masked[index] === ')') { depth = Math.max(0, depth - 1); index += 1; continue; }
    if (!isSqlWordStart_ACU(masked[index])) { index += 1; continue; }
    const start = index;
    index += 1;
    while (index < masked.length && isSqlWordPart_ACU(masked[index])) index += 1;
    if (masked.slice(start, index).toUpperCase() === 'SELECT') selectScopes.push({ start: index, depth });
  }

  const aliases = new Map<number, number>();
  const stopWords = new Set(['END', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'COLLATE']);
  const projectionTerminators = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT']);
  const projectionModifiers = new Set(['DISTINCT', 'ALL']);
  const operandPrefixes = /(?:\b(?:AND|OR|IN|IS|LIKE|GLOB|MATCH|REGEXP|BETWEEN|ESCAPE|COLLATE)\s*|[+*/%<>=|&~-]\s*)$/i;
  const recordProjectionAlias = (start: number, end: number): void => {
    while (end > start && /\s/.test(masked[end - 1])) end -= 1;
    let aliasStart = end;
    while (aliasStart > start && isSqlWordPart_ACU(masked[aliasStart - 1])) aliasStart -= 1;
    if (aliasStart === end || !isSqlWordStart_ACU(masked[aliasStart]) || aliasStart === start || !/\s/.test(masked[aliasStart - 1])) return;
    const alias = masked.slice(aliasStart, end);
    if (stopWords.has(alias.toUpperCase()) || /^__ACU_SQL_PROTECTED_\d+__$/.test(alias)) return;
    const expression = masked.slice(start, aliasStart).trim();
    const expressionWithoutModifiers = expression.replace(/^(?:DISTINCT|ALL)\s+/i, '').trim();
    if (!expressionWithoutModifiers || projectionModifiers.has(expression.toUpperCase()) || operandPrefixes.test(expressionWithoutModifiers)) return;
    aliases.set(aliasStart, end);
  };

  for (const scope of selectScopes) {
    let projectionStart = scope.start;
    let currentDepth = scope.depth;
    let projectionClosed = false;
    for (let index = scope.start; index < masked.length;) {
      const char = masked[index];
      if (char === '(') { currentDepth += 1; index += 1; continue; }
      if (char === ')') {
        if (currentDepth === scope.depth) {
          recordProjectionAlias(projectionStart, index);
          projectionClosed = true;
          break;
        }
        if (currentDepth < scope.depth) break;
        currentDepth = Math.max(0, currentDepth - 1);
        index += 1;
        continue;
      }
      if (currentDepth === scope.depth && char === ',') {
        recordProjectionAlias(projectionStart, index);
        projectionStart = index + 1;
        index += 1;
        continue;
      }
      if (!isSqlWordStart_ACU(char)) { index += 1; continue; }
      const start = index;
      index += 1;
      while (index < masked.length && isSqlWordPart_ACU(masked[index])) index += 1;
      if (currentDepth === scope.depth && projectionTerminators.has(masked.slice(start, index).toUpperCase())) {
        recordProjectionAlias(projectionStart, start);
        projectionClosed = true;
        break;
      }
    }
    if (!projectionClosed) recordProjectionAlias(projectionStart, masked.length);
  }
  let result = masked;
  for (const [start, end] of [...aliases.entries()].sort(([left], [right]) => right - left)) {
    result = `${result.slice(0, start)}${mask(result.slice(start, end))}${result.slice(end)}`;
  }
  return result;
}

function translateLegacyReadSqlSafely_ACU(sql: string, translateSql: (sql: string) => string): string {
  const protectedParts: string[] = [];
  let masked = '';
  let index = 0;
  const mask = (value: string): string => {
    const marker = `__ACU_SQL_PROTECTED_${protectedParts.length}__`;
    protectedParts.push(value);
    return marker;
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const lineFeed = sql.indexOf('\n', index + 2);
      const carriageReturn = sql.indexOf('\r', index + 2);
      const stop = [lineFeed, carriageReturn].filter(value => value >= 0).sort((left, right) => left - right)[0] ?? sql.length;
      masked += mask(sql.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end < 0 ? sql.length : end + 2;
      masked += mask(sql.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] !== close) cursor += 1;
        else if (sql[cursor + 1] === close) cursor += 2;
        else { cursor += 1; break; }
      }
      masked += mask(sql.slice(index, cursor));
      index = cursor;
      continue;
    }
    masked += char;
    index += 1;
  }
  // NameMapper predates token rebind and performs broad replacement. Protect
  // output aliases before invoking it so a presentation-only name cannot turn
  // into a physical column merely because no table/column token was rebound.
  const identifier = '[A-Za-z_\\u0080-\\uFFFF][A-Za-z0-9_$\\u0080-\\uFFFF]*';
  const protectedAliases = masked
    .replace(new RegExp(`(\\bAS\\s+)(${identifier})`, 'gi'), (_match, prefix, alias) => `${prefix}${mask(alias)}`)
    ;
  const protectedOutputAliases = protectImplicitSelectAliases_ACU(protectedAliases, mask);
  const translated = translateSql(protectedOutputAliases);
  return translated.replace(/__ACU_SQL_PROTECTED_(\d+)__/g, (_match, value) => protectedParts[Number(value)] || '');
}

export function resolveReadQuerySql_ACU(
  sql: string,
  tableData: TableDataObject_ACU | null | undefined,
  translateSql: (sql: string) => string,
): ReadQueryResolveResult_ACU {
  // PRAGMA arguments are SQLite grammar rather than SELECT identifiers.
  // Do not run a broad legacy translation over them.
  if (/^\s*PRAGMA\b/i.test(sql)) return { sql, tableRebindCount: 0, columnRebindCount: 0 };
  if (!tableData) return { sql: translateLegacyReadSqlSafely_ACU(sql, translateSql), tableRebindCount: 0, columnRebindCount: 0 };
  const { aliases: tableAliases, conflicts: tableConflicts } = buildSheetTableAliasMap_ACU([tableData]);
  const { aliases: columnAliases, conflicts: columnConflicts } = buildSheetColumnAliasMap_ACU([tableData]);

  const referencedTableAliases = new Set<string>();
  const referencedColumnConflicts = new Set<string>();
  const rebound = rebindSqlReadIdentifiers_ACU(sql, tableAliases, columnAliases, {
    lenient: true,
    onTableReference: alias => referencedTableAliases.add(alias),
    onColumnReference: (alias, tableNames) => {
      if (tableNames.some(tableName => columnConflicts.get(tableName)?.has(alias))) referencedColumnConflicts.add(alias);
    },
  });
  const referencedTableConflicts = [...tableConflicts].filter(conflict => referencedTableAliases.has(conflict));
  return {
    ...rebound,
    sql: translateLegacyReadSqlSafely_ACU(rebound.sql, translateSql),
    tableConflicts: referencedTableConflicts,
    columnConflicts: [...referencedColumnConflicts],
    conflicts: [...referencedTableConflicts, ...referencedColumnConflicts],
  };
}
