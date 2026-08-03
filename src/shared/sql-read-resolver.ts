import type { TableDataObject_ACU } from './models/table-data';
import { parseDDLColumnInfos_ACU, parseDDLTableName } from './ddl-utils';
import { canonicalizeDisplayName_ACU, getPhysicalTableNameForSheet_ACU, resolvePhysicalTableNames_ACU } from './sheet-identity';
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

export class SheetTableAliasResolutionError_ACU extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetTableAliasResolutionError_ACU';
  }
}

export interface ReadQueryResolveResult_ACU {
  sql: string;
  tableRebindCount: number;
  columnRebindCount: number;
  tableConflicts?: string[];
  columnConflicts?: string[];
  conflicts?: string[];
}

function canonicalizeSheetTableAlias_ACU(alias: unknown): string {
  return canonicalizeDisplayName_ACU(alias);
}

function addAlias_ACU(aliases: Map<string, string>, conflicts: Set<string>, alias: unknown, physicalName: string): void {
  const key = canonicalizeSheetTableAlias_ACU(alias);
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
      const declaredAliases = Array.isArray(sheet?.sourceData?.tableAliases) ? sheet.sourceData.tableAliases : [];
      const sourceAliases = [parseDDLTableName(String(sheet?.sourceData?.ddl || '')), physicalName, ...declaredAliases];
      if (options.includeExtendedAliases !== false) {
        sourceAliases.push(sheetKey, sheet?.uid, sheet?.name);
      }
      sourceAliases.forEach(alias => addAlias_ACU(aliases, conflicts, alias, physicalName));
    }
  }
  return { aliases, conflicts };
}

/**
 * Resolves historical runtime sheet keys that may be safely moved to keys from a
 * newer guide/template snapshot. A destructive re-key requires two independent,
 * deterministic identity signals: the runtime physical name and the author DDL
 * table name must both match. Display-name/physical-name equality alone is not
 * sufficient because genuinely distinct sheets may collide after romanization.
 */
export function resolveHistoricalSheetKeyMigrations_ACU(
  sourceData: TableDataObject_ACU | Record<string, unknown> | null | undefined,
  targetData: TableDataObject_ACU | Record<string, unknown> | null | undefined,
): Map<string, string> {
  if (!sourceData || typeof sourceData !== 'object' || !targetData || typeof targetData !== 'object') {
    return new Map();
  }

  const sourcePhysicalNames = resolvePhysicalTableNames_ACU(sourceData);
  const targetPhysicalNames = resolvePhysicalTableNames_ACU(targetData);
  const targetByPhysicalName = new Map<string, { sheetKey: string; ddlTableName: string }>();

  for (const [targetKey, physicalName] of targetPhysicalNames) {
    const targetSheet = (targetData as Record<string, any>)[targetKey];
    const ddlTableName = String(parseDDLTableName(String(targetSheet?.sourceData?.ddl || '')) || '').trim().toLowerCase();
    targetByPhysicalName.set(physicalName.toLowerCase(), { sheetKey: targetKey, ddlTableName });
  }

  const migrations = new Map<string, string>();
  for (const [sourceKey, physicalName] of sourcePhysicalNames) {
    if (targetPhysicalNames.has(sourceKey)) continue;
    const targetIdentity = targetByPhysicalName.get(physicalName.toLowerCase());
    if (!targetIdentity) continue;
    const sourceSheet = (sourceData as Record<string, any>)[sourceKey];
    const ddlTableName = String(parseDDLTableName(String(sourceSheet?.sourceData?.ddl || '')) || '').trim().toLowerCase();
    if (!ddlTableName || !targetIdentity.ddlTableName || ddlTableName !== targetIdentity.ddlTableName) {
      throw new SheetTableAliasResolutionError_ACU(
        `历史表身份迁移无法证明：${sourceKey} 与 ${targetIdentity.sheetKey} 共享物理表名「${physicalName}」，但作者 DDL 表名不一致或缺失。`,
      );
    }
    const targetKey = targetIdentity.sheetKey;
    if (Object.prototype.hasOwnProperty.call(sourceData, targetKey)) {
      throw new SheetTableAliasResolutionError_ACU(
        `历史表身份迁移冲突：${sourceKey} 对应 ${targetKey}，但运行时基底已存在目标 key。`,
      );
    }
    migrations.set(sourceKey, targetKey);
  }
  return migrations;
}

/**
 * Rebinds scheduling-time table selectors to sheet keys in a later snapshot by
 * using the same conflict-safe alias registry as SQL readers and writers.
 * Selectors may be sheet keys, uid values, display names, pinyin physical names,
 * or author DDL table names. Ambiguous and unprovable aliases fail closed.
 */
export function rebindSheetKeysThroughTableAliases_ACU(
  selectors: readonly string[],
  sourceData: TableDataObject_ACU | Record<string, unknown> | null | undefined,
  targetData: TableDataObject_ACU | Record<string, unknown> | null | undefined,
): string[] {
  if (!targetData || typeof targetData !== 'object') {
    throw new SheetTableAliasResolutionError_ACU('表身份重绑定失败：当前基底不可用。');
  }
  const sourcePhysicalNames = sourceData && typeof sourceData === 'object'
    ? resolvePhysicalTableNames_ACU(sourceData)
    : new Map<string, string>();
  const targetPhysicalNames = resolvePhysicalTableNames_ACU(targetData);
  const targetSheetKeyByPhysicalName = new Map<string, string>();
  for (const [sheetKey, physicalName] of targetPhysicalNames) {
    targetSheetKeyByPhysicalName.set(canonicalizeSheetTableAlias_ACU(physicalName), sheetKey);
  }
  const sourceRegistry = buildSheetTableAliasMap_ACU([sourceData], { includeExtendedAliases: true });
  const targetRegistry = buildSheetTableAliasMap_ACU([targetData], { includeExtendedAliases: true });
  const rebound: string[] = [];
  const sourceOwnerByTargetKey = new Map<string, string>();
  for (const rawSelector of selectors || []) {
    const selector = String(rawSelector || '').trim();
    if (!selector) continue;
    const normalized = canonicalizeSheetTableAlias_ACU(selector);
    const sourcePhysicalNameForSelector = sourceRegistry.conflicts.has(normalized)
      ? undefined
      : sourceRegistry.aliases.get(normalized);
    const sourceOwner = sourcePhysicalNameForSelector
      ? ([...sourcePhysicalNames].find(([, physicalName]) => canonicalizeSheetTableAlias_ACU(physicalName) === canonicalizeSheetTableAlias_ACU(sourcePhysicalNameForSelector))?.[0] || normalized)
      : normalized;

    if (targetRegistry.conflicts.has(normalized)) {
      throw new SheetTableAliasResolutionError_ACU(`表身份重绑定存在歧义：别名「${selector}」同时指向多张物理表。`);
    }
    const directTargetPhysicalName = targetRegistry.aliases.get(normalized);
    if (directTargetPhysicalName) {
      const directTargetSheetKey = targetSheetKeyByPhysicalName.get(canonicalizeSheetTableAlias_ACU(directTargetPhysicalName));
      if (!directTargetSheetKey) {
        throw new SheetTableAliasResolutionError_ACU(`表身份重绑定失败：别名「${selector}」对应的物理表不在当前基底中。`);
      }
      const directOwner = sourceOwnerByTargetKey.get(directTargetSheetKey);
      if (directOwner && directOwner !== sourceOwner) {
        throw new SheetTableAliasResolutionError_ACU(`表身份重绑定存在多对一冲突：${directOwner}、${sourceOwner} 同时指向 ${directTargetSheetKey}。`);
      }
      sourceOwnerByTargetKey.set(directTargetSheetKey, sourceOwner);
      if (!rebound.includes(directTargetSheetKey)) rebound.push(directTargetSheetKey);
      continue;
    }

    if (sourceRegistry.conflicts.has(normalized)) {
      throw new SheetTableAliasResolutionError_ACU(`表身份重绑定存在歧义：调度快照中的别名「${selector}」同时指向多张物理表。`);
    }
    const sourcePhysicalName = sourceRegistry.aliases.get(normalized);
    if (!sourcePhysicalName) {
      throw new SheetTableAliasResolutionError_ACU(`表身份重绑定失败：无法解析别名「${selector}」。`);
    }
    const sourceAliases = [...sourceRegistry.aliases.entries()]
      .filter(([, physicalName]) => canonicalizeSheetTableAlias_ACU(physicalName) === canonicalizeSheetTableAlias_ACU(sourcePhysicalName))
      .map(([alias]) => alias);
    const ambiguousAliases = sourceAliases.filter(alias => targetRegistry.conflicts.has(alias));
    if (ambiguousAliases.length > 0) {
      throw new SheetTableAliasResolutionError_ACU(`表身份重绑定存在歧义：别名「${ambiguousAliases[0]}」在当前基底中同时指向多张物理表。`);
    }
    const targetCandidates = new Set(
      sourceAliases
        .map(alias => targetRegistry.aliases.get(alias) && canonicalizeSheetTableAlias_ACU(targetRegistry.aliases.get(alias)))
        .filter((physicalName): physicalName is string => Boolean(physicalName)),
    );
    if (targetCandidates.size !== 1) {
      const reason = targetCandidates.size === 0 ? '无法证明其在当前基底中的对应表' : '多个别名证据指向不同物理表';
      throw new SheetTableAliasResolutionError_ACU(`表身份重绑定失败：别名「${selector}」${reason}。`);
    }
    const targetPhysicalName = [...targetCandidates][0];
    const targetSheetKey = targetSheetKeyByPhysicalName.get(targetPhysicalName);
    if (!targetSheetKey) throw new SheetTableAliasResolutionError_ACU(`表身份重绑定失败：别名「${selector}」对应的物理表不在当前基底中。`);
    const sourceSheetKey = [...sourcePhysicalNames].find(([, physicalName]) => canonicalizeSheetTableAlias_ACU(physicalName) === canonicalizeSheetTableAlias_ACU(sourcePhysicalName))?.[0] || normalized;
    const existingOwner = sourceOwnerByTargetKey.get(targetSheetKey);
    if (existingOwner && existingOwner !== sourceSheetKey) {
      throw new SheetTableAliasResolutionError_ACU(`表身份重绑定存在多对一冲突：${existingOwner}、${sourceSheetKey} 同时指向 ${targetSheetKey}。`);
    }
    sourceOwnerByTargetKey.set(targetSheetKey, sourceSheetKey);
    if (!rebound.includes(targetSheetKey)) rebound.push(targetSheetKey);
  }
  return rebound;
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

function translateLegacyReadSqlSafely_ACU(sql: string, translateSql: (sql: string) => string, protectedIdentifierSpans: ReadonlyArray<{ start: number; end: number }> = []): string {
  const protectedParts: string[] = [];
  let masked = '';
  let index = 0;
  const mask = (value: string): string => {
    const marker = `__ACU_SQL_PROTECTED_${protectedParts.length}__`;
    protectedParts.push(value);
    return marker;
  };
  const protectedByStart = new Map(protectedIdentifierSpans.map(span => [span.start, span]));
  while (index < sql.length) {
    const protectedSpan = protectedByStart.get(index);
    if (protectedSpan && protectedSpan.end > index) {
      masked += mask(sql.slice(index, protectedSpan.end));
      index = protectedSpan.end;
      continue;
    }
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
  let restored = translated;
  // Quoted identifiers are masked before explicit AS aliases are masked. The
  // latter can therefore contain an earlier marker; restore to a fixed point.
  for (let pass = 0; pass < protectedParts.length; pass += 1) {
    const next = restored.replace(/__ACU_SQL_PROTECTED_(\d+)__/g, (_match, value) => protectedParts[Number(value)] || '');
    if (next === restored) break;
    restored = next;
  }
  return restored;
}

export function resolveReadQuerySql_ACU(
  sql: string,
  tableData: TableDataObject_ACU | null | undefined,
  translateSql: (sql: string) => string,
): ReadQueryResolveResult_ACU {
  // PRAGMA arguments are SQLite grammar rather than SELECT identifiers.
  // Do not run a broad legacy translation over them.
  if (/^\s*PRAGMA\b/i.test(sql)) return { sql, tableRebindCount: 0, columnRebindCount: 0 };
  if (!tableData) {
    // Even without runtime table data, the legacy mapper must still respect
    // derived/CTE output scope. Run the structural pass with no aliases solely
    // to collect protected virtual-output spans.
    const rebound = rebindSqlReadIdentifiers_ACU(sql, new Map(), new Map(), { lenient: true });
    return { ...rebound, sql: translateLegacyReadSqlSafely_ACU(rebound.sql, translateSql, rebound.protectedIdentifierSpans) };
  }
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
    sql: translateLegacyReadSqlSafely_ACU(rebound.sql, translateSql, rebound.protectedIdentifierSpans),
    tableConflicts: referencedTableConflicts,
    columnConflicts: [...referencedColumnConflicts],
    conflicts: [...referencedTableConflicts, ...referencedColumnConflicts],
  };
}
