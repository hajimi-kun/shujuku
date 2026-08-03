export type SqlTableAliasMap_ACU = ReadonlyMap<string, string>;
export type SqlColumnAliasMap_ACU = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface SqlReadRebindResult_ACU {
  sql: string;
  tableRebindCount: number;
  columnRebindCount: number;
  /** Internal ranges used by the shared read resolver before legacy translation. */
  protectedIdentifierSpans?: Array<{ start: number; end: number }>;
}

type Quote_ACU = '"' | '`' | '[' | null;
interface Token_ACU { start: number; end: number; value: string; quote: Quote_ACU; depth: number; commaBefore: boolean; }

function wordStart(char: string): boolean { return /^[A-Za-z_\u0080-\uFFFF]$/.test(char); }
function wordPart(char: string): boolean { return /^[A-Za-z0-9_$\u0080-\uFFFF]$/.test(char); }
function keyword(token: Token_ACU | undefined, value: string): boolean {
  return !!token && token.quote === null && token.value.toUpperCase() === value;
}

function tokens(sql: string): Token_ACU[] {
  const result: Token_ACU[] = [];
  let index = 0;
  let depth = 0;
  const commaDepths = new Set<number>();
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') { index += 2; while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1; continue; }
    if (char === '/' && next === '*') { const end = sql.indexOf('*/', index + 2); if (end < 0) throw new Error('unterminated comment'); index = end + 2; continue; }
    if (char === "'") { index += 1; while (index < sql.length) { if (sql[index] !== "'") index += 1; else if (sql[index + 1] === "'") index += 2; else { index += 1; break; } } if (sql[index - 1] !== "'") throw new Error('unterminated string'); continue; }
    if (char === ',') { commaDepths.add(depth); index += 1; continue; }
    if (char === '(') { commaDepths.delete(depth); depth += 1; index += 1; continue; }
    if (char === ')') { depth = Math.max(0, depth - 1); index += 1; continue; }
    if (char === '"' || char === '`' || char === '[') {
      const quote = char as Exclude<Quote_ACU, null>; const close = quote === '[' ? ']' : quote; const start = index; let value = ''; index += 1; let closed = false;
      while (index < sql.length) { if (sql[index] !== close) value += sql[index++]; else if (sql[index + 1] === close) { value += close; index += 2; } else { index += 1; closed = true; break; } }
      if (!closed) throw new Error('unterminated quoted identifier'); result.push({ start, end: index, value, quote, depth, commaBefore: commaDepths.delete(depth) }); continue;
    }
    if (wordStart(char)) { const start = index; index += 1; while (index < sql.length && wordPart(sql[index])) index += 1; result.push({ start, end: index, value: sql.slice(start, index), quote: null, depth, commaBefore: commaDepths.delete(depth) }); continue; }
    index += 1;
  }
  return result;
}

function qualifiedTail(sql: string, values: Token_ACU[], start: number): Token_ACU | undefined {
  let token = values[start];
  if (!token) return undefined;
  let index = start;
  while (values[index + 1] && values[index + 1].depth === token.depth && /^\s*\.\s*$/.test(sql.slice(token.end, values[index + 1].start))) token = values[++index];
  return token;
}

function mutationTarget(sql: string, values: Token_ACU[]): Token_ACU | undefined {
  const first = values[0];
  const actionIndex = keyword(first, 'WITH') ? values.findIndex((token, index) => index > 0 && token.depth === 0 && ['INSERT', 'REPLACE', 'UPDATE', 'DELETE'].includes(token.value.toUpperCase())) : 0;
  const action = values[actionIndex];
  if (!action) return undefined;
  if (keyword(action, 'INSERT') || keyword(action, 'REPLACE')) {
    let index = actionIndex + 1;
    if (keyword(action, 'INSERT') && keyword(values[index], 'OR')) index += 2;
    return keyword(values[index], 'INTO') ? qualifiedTail(sql, values, index + 1) : undefined;
  }
  if (keyword(action, 'UPDATE')) { let index = actionIndex + 1; if (keyword(values[index], 'OR')) index += 2; return qualifiedTail(sql, values, index); }
  return keyword(action, 'DELETE') && keyword(values[actionIndex + 1], 'FROM') ? qualifiedTail(sql, values, actionIndex + 2) : undefined;
}

interface CteScope_ACU { name: string; depth: number; start: number; end: number; }

function cteScopes(values: Token_ACU[]): CteScope_ACU[] {
  const result: CteScope_ACU[] = [];
  for (let withIndex = 0; withIndex < values.length; withIndex += 1) {
    const withToken = values[withIndex];
    if (!keyword(withToken, 'WITH')) continue;
    const depth = withToken.depth;
    let index = withIndex + 1;
    if (keyword(values[index], 'RECURSIVE')) index += 1;
    const names: string[] = [];
    let valid = false;
    while (values[index]) {
      const name = values[index];
      if (!name || name.depth !== depth) break;
      index += 1;
      if (values[index]?.depth === depth + 1) {
        const columnDepth = values[index].depth;
        while (values[index] && values[index].depth >= columnDepth) index += 1;
      }
      if (!keyword(values[index], 'AS')) break;
      names.push(name.value.toLowerCase());
      index += 1;
      if (!values[index] || values[index].depth !== depth + 1) break;
      const definitionDepth = values[index].depth;
      while (values[index] && values[index].depth >= definitionDepth) index += 1;
      valid = true;
      if (!values[index]?.commaBefore || values[index].depth !== depth) break;
    }
    if (!valid) continue;
    const end = values.findIndex((token, tokenIndex) => tokenIndex > index && token.depth < depth);
    for (const name of names) result.push({ name, depth, start: withIndex, end: end < 0 ? values.length : end });
  }
  return result;
}

function isCteReference(values: Token_ACU[], token: Token_ACU, scopes: CteScope_ACU[]): boolean {
  const index = values.indexOf(token);
  return index >= 0 && scopes.some(scope => (
    scope.name === token.value.toLowerCase()
    && index >= scope.start
    && index < scope.end
    && token.depth >= scope.depth
  ));
}

function references(sql: string, values: Token_ACU[], target: Token_ACU): Token_ACU[] {
  const result = new Map<number, Token_ACU>([[target.start, target]]);
  const scopes = cteScopes(values);
  const terminators = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'RETURNING', 'VALUES', 'SET']);
  const fromDepths = new Set<number>();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    const value = token.quote === null ? token.value.toUpperCase() : '';
    if (terminators.has(value)) fromDepths.delete(token.depth);
    if (value === 'FROM') fromDepths.add(token.depth);
    if (value === 'FROM' || value === 'JOIN') {
      const reference = qualifiedTail(sql, values, index + 1);
      if (reference && reference.depth === token.depth && !isCteReference(values, reference, scopes)) result.set(reference.start, reference);
    } else if (token.commaBefore && fromDepths.has(token.depth) && !isCteReference(values, token, scopes)) {
      result.set(token.start, token);
    }
  }
  return [...result.values()];
}

function format(value: string, quote: Quote_ACU): string {
  if (quote === '"') return `"${value.replace(/"/g, '""')}"`;
  if (quote === '`') return `\`${value.replace(/`/g, '``')}\``;
  if (quote === '[') return `[${value.replace(/]/g, ']]')}]`;
  return value;
}

export function decodeSqlIdentifier_ACU(value: unknown): string {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text[0] === '"' && text[text.length - 1] === '"') || (text[0] === '`' && text[text.length - 1] === '`'))) {
    return text.slice(1, -1).split(text[0] + text[0]).join(text[0]);
  }
  if (text.length >= 2 && text[0] === '[' && text[text.length - 1] === ']') return text.slice(1, -1).split(']]').join(']');
  return text;
}

export function rebindSqlMutationTableReferences_ACU(
  statements: string[],
  aliases: SqlTableAliasMap_ACU,
  options: { lenient?: boolean; requireKnownTables?: boolean } = {},
): string[] {
  const resolvedAliases = new Map<string, string>();
  for (const [alias, physicalName] of aliases) resolvedAliases.set(decodeSqlIdentifier_ACU(alias).toLowerCase(), physicalName);
  return statements.map(statement => {
    try {
      const values = tokens(statement);
      const target = mutationTarget(statement, values);
      if (!target) return statement;
      const tableReferences = references(statement, values, target);
      if (options.requireKnownTables) {
        for (const reference of tableReferences) {
          if (!resolvedAliases.has(reference.value.toLowerCase())) {
            const role = reference.start === target.start ? '目标表' : '关联表';
            throw new Error(`SQL 写入包含无法识别的${role}「${reference.value}」。`);
          }
        }
      }
      if (!resolvedAliases.has(target.value.toLowerCase())) return statement;
      const replacements = tableReferences
        .map(token => ({ token, name: resolvedAliases.get(token.value.toLowerCase()) }))
        .filter((item): item is { token: Token_ACU; name: string } => !!item.name);
      let result = statement;
      for (const { token, name } of replacements.sort((left, right) => right.token.start - left.token.start)) {
        result = `${result.slice(0, token.start)}${format(name, token.quote)}${result.slice(token.end)}`;
      }
      return result;
    } catch (error) {
      if (options.lenient) return statement;
      throw error;
    }
  });
}

interface ReadScope_ACU {
  start: number;
  end: number;
  depth: number;
  /** Projection aliases exported by this SELECT scope. */
  outputs: Set<string>;
  /** Derived-table aliases visible to this SELECT scope. */
  derivedSources: Map<string, Set<string>>;
  /** Virtual sources whose exported columns cannot be determined safely. */
  unknownDerivedSources: Set<string>;
  /** Token positions whose names are virtual outputs rather than entity columns. */
  protectedTokens: Set<number>;
  tables: Set<string>;
  aliases: Map<string, string>;
  qualifiers: Map<string, string>;
  tableTokens: Token_ACU[];
}

const READ_SCOPE_TERMINATORS_ACU = new Set(['UNION', 'EXCEPT', 'INTERSECT']);
const READ_FROM_TERMINATORS_ACU = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW']);
const READ_ALIAS_STOP_WORDS_ACU = new Set(['ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW']);
const READ_COLUMN_KEYWORDS_ACU = new Set(['SELECT', 'FROM', 'JOIN', 'AS', 'ON', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WITH', 'RECURSIVE', 'DISTINCT', 'BY', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'COLLATE', 'USING']);

function isFunctionCall_ACU(sql: string, values: Token_ACU[], index: number): boolean {
  const token = values[index];
  return !!token && /^\s*\(/.test(sql.slice(token.end));
}

function findReadScope_ACU(scopes: ReadScope_ACU[], values: Token_ACU[], index: number): ReadScope_ACU | undefined {
  const token = values[index];
  return scopes
    .filter(scope => index >= scope.start && index < scope.end && token.depth >= scope.depth)
    .sort((left, right) => right.depth - left.depth || right.start - left.start)[0];
}

function projectionOutputs_ACU(values: Token_ACU[], scope: ReadScope_ACU): Set<string> {
  const outputs = new Set<string>();
  let projectionEnd = scope.end;
  for (let index = scope.start + 1; index < scope.end; index += 1) {
    const token = values[index];
    if (token.depth === scope.depth && keyword(token, 'FROM')) {
      projectionEnd = index;
      break;
    }
  }
  for (let index = scope.start + 1; index < projectionEnd; index += 1) {
    const token = values[index];
    if (token.depth !== scope.depth || !keyword(token, 'AS')) continue;
    const alias = values[index + 1];
    if (alias?.depth === scope.depth) outputs.add(alias.value.toLowerCase());
  }
  return outputs;
}

function compoundScopeEnd_ACU(values: Token_ACU[], scope: ReadScope_ACU): number {
  for (let index = scope.end; index < values.length; index += 1) {
    if (values[index].depth < scope.depth) return index;
  }
  return values.length;
}

function isOutputAliasReference_ACU(values: Token_ACU[], scope: ReadScope_ACU, tokenIndex: number, key: string): boolean {
  if (!scope.outputs.has(key)) return false;
  let clause = '';
  for (let index = scope.start + 1; index < tokenIndex; index += 1) {
    const token = values[index];
    if (token.depth !== scope.depth) continue;
    if (keyword(token, 'ORDER') || keyword(token, 'GROUP') || keyword(token, 'HAVING')) clause = token.value.toUpperCase();
    else if (READ_FROM_TERMINATORS_ACU.has(token.value.toUpperCase())) clause = token.value.toUpperCase();
  }
  return clause === 'ORDER' || clause === 'GROUP' || clause === 'HAVING';
}

function collectReadScopes_ACU(
  sql: string,
  values: Token_ACU[],
  normalizedTables: ReadonlyMap<string, string>,
  onTableReference?: (alias: string) => void,
): ReadScope_ACU[] {
  const cte = cteScopes(values);
  const scopes: ReadScope_ACU[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const select = values[index];
    if (!keyword(select, 'SELECT')) continue;
    let end = values.length;
    for (let cursor = index + 1; cursor < values.length; cursor += 1) {
      const token = values[cursor];
      if (token.depth < select.depth || (token.depth === select.depth && READ_SCOPE_TERMINATORS_ACU.has(token.value.toUpperCase()))) {
        end = cursor;
        break;
      }
    }
    scopes.push({
      start: index,
      end,
      depth: select.depth,
      outputs: new Set(),
      derivedSources: new Map(),
      unknownDerivedSources: new Set(),
      protectedTokens: new Set(),
      tables: new Set(),
      aliases: new Map(),
      qualifiers: new Map(),
      tableTokens: [],
    });
  }

  for (const scope of scopes) scope.outputs = projectionOutputs_ACU(values, scope);
  const cteOutputs = new Map<string, Set<string>>();
  for (let withIndex = 0; withIndex < values.length; withIndex += 1) {
    const withToken = values[withIndex];
    if (!keyword(withToken, 'WITH')) continue;
    const depth = withToken.depth;
    let cursor = withIndex + 1;
    if (keyword(values[cursor], 'RECURSIVE')) cursor += 1;
    while (values[cursor]?.depth === depth) {
      const name = values[cursor++];
      const explicitOutputs = new Set<string>();
      if (values[cursor]?.depth === depth + 1) {
        const listDepth = values[cursor].depth;
        while (values[cursor]?.depth >= listDepth) {
          if (values[cursor].depth === listDepth) explicitOutputs.add(values[cursor].value.toLowerCase());
          cursor += 1;
        }
      }
      if (!keyword(values[cursor], 'AS')) break;
      cursor += 1;
      const definition = scopes.find(scope => scope.start === cursor && scope.depth === depth + 1);
      if (!definition) break;
      cteOutputs.set(name.value.toLowerCase(), explicitOutputs.size > 0 ? explicitOutputs : definition.outputs);
      while (values[cursor] && values[cursor].depth >= depth + 1) cursor += 1;
      if (!values[cursor]?.commaBefore || values[cursor].depth !== depth) break;
    }
  }

  for (const scope of [...scopes].sort((left, right) => right.depth - left.depth || right.start - left.start)) {
    let inFrom = false;
    const addSource = (sourceIndex: number): void => {
      const source = values[sourceIndex];
      if (source?.depth === scope.depth + 1 && keyword(source, 'SELECT')) {
        const nested = scopes.find(candidate => candidate.start === sourceIndex && candidate.depth === source.depth);
        const aliasIndex = nested ? compoundScopeEnd_ACU(values, nested) : -1;
        const marker = aliasIndex >= 0 ? values[aliasIndex] : undefined;
        const alias = keyword(marker, 'AS') ? values[aliasIndex + 1] : marker;
        if (nested && alias?.depth === scope.depth && !READ_ALIAS_STOP_WORDS_ACU.has(alias.value.toUpperCase())) {
          const aliasKey = alias.value.toLowerCase();
          scope.derivedSources.set(aliasKey, nested.outputs);
          if (nested.outputs.size === 0) scope.unknownDerivedSources.add(aliasKey);
        }
        return;
      }
      if (!source || source.depth !== scope.depth || isFunctionCall_ACU(sql, values, sourceIndex)) return;
      const cteOutput = cteOutputs.get(source.value.toLowerCase());
      if (cteOutput && isCteReference(values, source, cte)) {
        scope.derivedSources.set(source.value.toLowerCase(), cteOutput);
        if (cteOutput.size === 0) scope.unknownDerivedSources.add(source.value.toLowerCase());
        return;
      }
      const tail = qualifiedTail(sql, values, sourceIndex);
      if (!tail || tail.depth !== scope.depth) return;
      onTableReference?.(tail.value.toLowerCase());
      const physicalName = normalizedTables.get(tail.value.toLowerCase());
      if (!physicalName) return;
      scope.tables.add(physicalName);
      scope.tableTokens.push(tail);
      let cursor = values.indexOf(tail) + 1;
      const next = values[cursor];
      let alias: Token_ACU | undefined;
      if (keyword(next, 'AS')) alias = values[cursor + 1]?.depth === scope.depth ? values[cursor + 1] : undefined;
      else if (next?.depth === scope.depth && !READ_ALIAS_STOP_WORDS_ACU.has(next.value.toUpperCase()) && !next.commaBefore) alias = next;
      if (alias) scope.aliases.set(alias.value.toLowerCase(), physicalName);
      else {
        scope.aliases.set(tail.value.toLowerCase(), physicalName);
        scope.qualifiers.set(tail.value.toLowerCase(), physicalName);
      }
    };
    for (let index = scope.start + 1; index < scope.end; index += 1) {
      const token = values[index];
      if (token.depth !== scope.depth) continue;
      const value = token.value.toUpperCase();
      if (READ_FROM_TERMINATORS_ACU.has(value)) inFrom = false;
      if (value === 'FROM') {
        inFrom = true;
        addSource(index + 1);
      } else if (value === 'JOIN') {
        addSource(index + 1);
      } else if (inFrom && token.commaBefore) {
        addSource(index);
      }
    }
  }
  return scopes;
}

/**
 * Rebinds SELECT-family table and unambiguous column identifiers without using
 * broad string replacement. The caller supplies aliases from the active schema.
 */
export function rebindSqlReadIdentifiers_ACU(
  sql: string,
  tableAliases: SqlTableAliasMap_ACU,
  columnAliases: SqlColumnAliasMap_ACU = new Map(),
  options: { lenient?: boolean; onTableReference?: (alias: string) => void; onColumnReference?: (alias: string, tableNames: readonly string[]) => void } = {},
): SqlReadRebindResult_ACU {
  const normalizedTables = new Map<string, string>();
  for (const [alias, physicalName] of tableAliases) {
    normalizedTables.set(decodeSqlIdentifier_ACU(alias).toLowerCase(), physicalName);
  }
  try {
    const values = tokens(sql);
    const scopes = collectReadScopes_ACU(sql, values, normalizedTables, options.onTableReference);
    const replacements = new Map<number, { token: Token_ACU; value: string; kind: 'table' | 'column' }>();
    for (const scope of scopes) {
      for (const token of scope.tableTokens) {
        const value = normalizedTables.get(token.value.toLowerCase());
        if (value) replacements.set(token.start, { token, value, kind: 'table' });
      }
    }
    for (let index = 0; index < values.length - 1; index += 1) {
      const token = values[index];
      const next = values[index + 1];
      if (token.depth !== next.depth || !/^\s*\.\s*$/.test(sql.slice(token.end, next.start))) continue;
      const scope = findReadScope_ACU(scopes, values, index);
      const value = scope?.qualifiers.get(token.value.toLowerCase());
      if (value) replacements.set(token.start, { token, value, kind: 'table' });
    }

    for (let index = 0; index < values.length; index += 1) {
      const token = values[index];
      const previous = values[index - 1];
      const next = values[index + 1];
      if (replacements.has(token.start)
        || (previous && previous.depth === token.depth && keyword(previous, 'AS'))
        || (next && next.depth === token.depth && /^\s*\.\s*$/.test(sql.slice(token.end, next.start)))
        || isFunctionCall_ACU(sql, values, index)
        || token.quote === null && READ_COLUMN_KEYWORDS_ACU.has(token.value.toUpperCase())) continue;
      const scope = findReadScope_ACU(scopes, values, index);
      if (!scope) continue;
      const key = token.value.toLowerCase();
      if (isOutputAliasReference_ACU(values, scope, index, key)) {
        scope.protectedTokens.add(token.start);
        continue;
      }
      const candidates = new Set<string>();
      const qualifier = previous && previous.depth === token.depth && /^\s*\.\s*$/.test(sql.slice(previous.end, token.start))
        ? previous : undefined;
      const qualifierKey = qualifier?.value.toLowerCase();
      const virtualOutputs = qualifierKey ? scope.derivedSources.get(qualifierKey) : undefined;
      if (virtualOutputs || (qualifierKey && scope.unknownDerivedSources.has(qualifierKey))) {
        scope.protectedTokens.add(token.start);
        continue;
      }
      if (!qualifier && (scope.unknownDerivedSources.size > 0 || [...scope.derivedSources.values()].some(outputs => outputs.has(key))) ) {
        scope.protectedTokens.add(token.start);
        continue;
      }
      const tableNames = qualifier
        ? [scope.aliases.get(qualifier.value.toLowerCase())].filter((value): value is string => !!value)
        : [...scope.tables];
      options.onColumnReference?.(key, tableNames);
      for (const tableName of tableNames) {
        const columns = columnAliases.get(tableName);
        const value = columns?.get(key);
        if (value) candidates.add(value);
      }
      if (candidates.size === 1) {
        const [value] = candidates;
        if (value !== token.value) replacements.set(token.start, { token, value, kind: 'column' });
      }
    }

    let result = sql;
    let tableRebindCount = 0;
    let columnRebindCount = 0;
    for (const { token, value, kind } of [...replacements.values()].sort((left, right) => right.token.start - left.token.start)) {
      result = `${result.slice(0, token.start)}${format(value, token.quote)}${result.slice(token.end)}`;
      if (kind === 'table') tableRebindCount += 1;
      else columnRebindCount += 1;
    }
    const protectedTokenStarts = new Set([...scopes].flatMap(scope => [...scope.protectedTokens]));
    // CTE column lists are declarations, not entity-column references. They
    // must be shielded from the legacy broad translator for the same reason as
    // their downstream CTE references.
    for (let withIndex = 0; withIndex < values.length; withIndex += 1) {
      const withToken = values[withIndex];
      if (!keyword(withToken, 'WITH')) continue;
      const depth = withToken.depth;
      let cursor = withIndex + 1;
      if (keyword(values[cursor], 'RECURSIVE')) cursor += 1;
      while (values[cursor]?.depth === depth) {
        cursor += 1; // CTE name
        if (values[cursor]?.depth === depth + 1) {
          const listDepth = values[cursor].depth;
          while (values[cursor]?.depth >= listDepth) {
            if (values[cursor].depth === listDepth) protectedTokenStarts.add(values[cursor].start);
            cursor += 1;
          }
        }
        if (!keyword(values[cursor], 'AS')) break;
        cursor += 1;
        while (values[cursor] && values[cursor].depth >= depth + 1) cursor += 1;
        if (!values[cursor]?.commaBefore || values[cursor].depth !== depth) break;
      }
    }
    const protectedIdentifierSpans = [...protectedTokenStarts]
      .map(start => {
        const token = values.find(value => value.start === start)!;
        const offset = [...replacements.values()]
          .filter(replacement => replacement.token.start < token.start)
          .reduce((total, replacement) => total + replacement.value.length - (replacement.token.end - replacement.token.start), 0);
        return { start: token.start + offset, end: token.end + offset };
      });
    const rebound: SqlReadRebindResult_ACU = { sql: result, tableRebindCount, columnRebindCount };
    Object.defineProperty(rebound, 'protectedIdentifierSpans', {
      value: protectedIdentifierSpans,
      enumerable: false,
    });
    return rebound;
  } catch (error) {
    if (options.lenient) return { sql, tableRebindCount: 0, columnRebindCount: 0 };
    throw error;
  }
}
