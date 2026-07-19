/**
 * shared/ddl-utils.ts — DDL 纯解析/操作工具函数
 *
 * 这些函数只做字符串解析，不访问数据库、不读写存储、不依赖任何 data 层基础设施。
 * 所有层（data / service / presentation）均可直接 import。
 */

import { logWarn_ACU } from './utils';

// ═══════════════════════════════════════════════════════════════
// DDL 解析
// ═══════════════════════════════════════════════════════════════

/**
 * 从 DDL 中解析英文表名
 * @param ddl CREATE TABLE 语句
 * @returns 表名，解析失败返回 null
 */
export function parseDDLTableName(ddl: string): string | null {
  const bounds = findCreateTableDefinitionBounds_ACU(String(ddl || ''));
  return bounds?.tableName || null;
}

/**
 * 从 DDL 第一行注释中解析中文表名
 * 格式：CREATE TABLE table_name ( -- 中文表名
 * @param ddl CREATE TABLE 语句
 * @returns 中文表名，解析失败返回 null
 */
export function parseDDLChineseName(ddl: string): string | null {
  if (!ddl) return null;
  // 匹配第一行的 -- 注释
  const firstLine = ddl.split('\n')[0];
  const match = firstLine.match(/--\s*(.+?)\s*$/);
  return match ? match[1].trim() : null;
}

/**
 * 从 DDL 中解析所有列名（按顺序）
 * @param ddl CREATE TABLE 语句
 * @returns 列名数组
 */
export function parseDDLColumnNames(ddl: string): string[] {
  if (!ddl) return [];
  const columns: string[] = [];

  const body = getCreateTableDefinitionBody_ACU(ddl);
  if (body === null) return [];
  // 按逗号分割（但要注意括号内和注释内的逗号）
  const lines = splitColumnDefinitions(body);

  for (const line of lines) {
    // 去掉行注释（-- 到行尾），然后取最后一个非注释行的内容
    const withoutComments = line.replace(/--[^\n]*/g, '').trim();
    if (!withoutComments) continue;
    // 跳过表级约束（PRIMARY KEY、FOREIGN KEY、UNIQUE、CHECK、CONSTRAINT）
    if (/^(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(withoutComments)) continue;
    // 提取列名（第一个标识符）
    const colMatch = withoutComments.match(/^([^\s,()]+)/);
    if (colMatch) {
      columns.push(colMatch[1]);
    }
  }

  return columns;
}

/**
 * 从 DDL 中解析列名 → 注释的映射
 * 格式：column_name TYPE ... -- 注释
 * @param ddl CREATE TABLE 语句
 * @returns Map<列名, 注释>
 */
export function parseDDLColumnComments(ddl: string): Map<string, string> {
  const comments = new Map<string, string>();
  if (!ddl) return comments;

  const body = getCreateTableDefinitionBody_ACU(ddl);
  if (body === null) return comments;
  // 按行分割（注释是行级概念，标准 SQL 中 `-- 注释` 到行尾）
  // 而非按 splitColumnDefinitions 分割（逗号在注释之前，会截断注释）
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 匹配 column_name ... -- 注释（行内可能有逗号、CHECK 约束等）
    const match = trimmed.match(/^([^\s,()]+)\s+.*?--\s*(.+?)\s*,?\s*$/);
    if (match) {
      comments.set(match[1], match[2]);
    }
  }

  return comments;
}

/**
 * 构建 DDL 列名 → 中文名的双向映射
 * @param ddl CREATE TABLE 语句
 * @returns { sqlToChinese: Map<英文列名, 中文名>, chineseToSql: Map<中文名, 英文列名> }
 */
export function buildColumnNameMap(ddl: string): {
  sqlToChinese: Map<string, string>;
  chineseToSql: Map<string, string>;
} {
  const comments = parseDDLColumnComments(ddl);
  const sqlToChinese = new Map<string, string>();
  const chineseToSql = new Map<string, string>();

  for (const [colName, comment] of comments) {
    sqlToChinese.set(colName, comment);
    chineseToSql.set(comment, colName);
  }

  return { sqlToChinese, chineseToSql };
}

export type DDLSafeDefaultLiteral_ACU =
  | { kind: 'null'; sql: 'NULL'; value: null }
  | { kind: 'integer'; sql: string; value: number }
  | { kind: 'real'; sql: string; value: number }
  | { kind: 'string'; sql: string; value: string }
  | { kind: 'blob'; sql: string; value: string }
  | { kind: 'boolean'; sql: 'TRUE' | 'FALSE'; value: boolean };

export interface DDLColumnInfo_ACU {
  index: number;
  sqlName: string;
  declaredType: string | null;
  comment: string | null;
  /** 移除注释并压缩空白后的完整列定义，用于 schema contract 比较。 */
  normalizedDefinition: string;
  isPrimaryKey: boolean;
  isNotNull: boolean;
  hasDefault: boolean;
  /** Exact DEFAULT expression, or null when the definition has no DEFAULT. */
  defaultExpression: string | null;
}

export function parseDDLColumnInfos_ACU(ddl: string): DDLColumnInfo_ACU[] {
  const columnNames = parseDDLColumnNames(ddl);
  const comments = parseDDLColumnComments(ddl);
  const body = getCreateTableDefinitionBody_ACU(ddl);
  const definitions = body === null ? [] : splitColumnDefinitions(body);
  const definitionsByName = new Map<string, string>();
  for (const definition of definitions) {
    const withoutComments = stripSqlLineComments_ACU(definition).trim();
    const nameMatch = withoutComments.match(/^([^\s,()]+)/);
    if (nameMatch) definitionsByName.set(nameMatch[1], withoutComments);
  }
  return columnNames.map((sqlName, index) => {
    const rawComment = comments.get(sqlName);
    const comment = typeof rawComment === 'string' && rawComment.trim() ? rawComment.trim() : null;
    const definition = definitionsByName.get(sqlName) || '';
    const tokens = extractTopLevelSqlTokens_ACU(definition);
    const defaultExpression = extractDDLDefaultExpression_ACU(definition);
    return {
      index,
      sqlName,
      declaredType: tokens[1] || null,
      comment,
      normalizedDefinition: definition.replace(/\s+/g, ' ').trim(),
      isPrimaryKey: hasSequentialTokens_ACU(tokens, 'PRIMARY', 'KEY'),
      isNotNull: hasSequentialTokens_ACU(tokens, 'NOT', 'NULL'),
      hasDefault: defaultExpression !== null,
      defaultExpression,
    };
  });
}

/**
 * Parses only literal defaults that can be replayed without evaluating SQL.
 * SQLite expressions, parenthesized values and CURRENT_* are intentionally
 * rejected by returning null.
 */
export function parseDDLSafeDefaultLiteral_ACU(expression: string | null | undefined): DDLSafeDefaultLiteral_ACU | null {
  const value = String(expression || '').trim();
  if (!value) return null;
  if (/^NULL$/i.test(value)) return { kind: 'null', sql: 'NULL', value: null };
  if (/^TRUE$/i.test(value)) return { kind: 'boolean', sql: 'TRUE', value: true };
  if (/^FALSE$/i.test(value)) return { kind: 'boolean', sql: 'FALSE', value: false };
  if (/^X'(?:[0-9A-F]{2})*'$/i.test(value)) return { kind: 'blob', sql: value.toUpperCase(), value: value.slice(2, -1).toUpperCase() };
  if (/^[+-]?\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? { kind: 'integer', sql: value, value: numeric } : null;
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?\d+[eE][+-]?\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? { kind: 'real', sql: value, value: numeric } : null;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    if (!/(^|[^'])'(?!')/.test(inner)) return { kind: 'string', sql: value, value: inner.replace(/''/g, "'") };
  }
  return null;
}

function extractDDLDefaultExpression_ACU(definition: string): string | null {
  const value = stripSqlLineComments_ACU(definition);
  let quote: "'" | '"' | '`' | '[' | null = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === (quote === '[' ? ']' : quote)) {
        if (quote !== '[' && value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') { quote = char; continue; }
    if (char === '(') { depth += 1; continue; }
    if (char === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0 || value.slice(index, index + 7).toUpperCase() !== 'DEFAULT') continue;
    if (/[A-Z0-9_$]/i.test(value[index - 1] || '') || /[A-Z0-9_$]/i.test(value[index + 7] || '')) continue;
    const start = skipSqlTrivia_ACU(value, index + 7);
    const parsed = consumeDefaultLiteralToken_ACU(value, start);
    return parsed?.token || value.slice(start).trim() || null;
  }
  return null;
}

function consumeDefaultLiteralToken_ACU(value: string, start: number): { token: string; end: number } | null {
  if (value[start] === "'") {
    let index = start + 1;
    while (index < value.length) {
      if (value[index] === "'") {
        if (value[index + 1] === "'") { index += 2; continue; }
        return { token: value.slice(start, index + 1), end: index + 1 };
      }
      index += 1;
    }
    return null;
  }
  const blob = value.slice(start).match(/^X'(?:[0-9A-F]{2})*'/i);
  if (blob) return { token: blob[0], end: start + blob[0].length };
  const scalar = value.slice(start).match(/^(?:NULL|TRUE|FALSE|[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/i);
  return scalar ? { token: scalar[0], end: start + scalar[0].length } : null;
}

function hasSequentialTokens_ACU(tokens: string[], first: string, second: string): boolean {
  return tokens.some((token, index) => token === first && tokens[index + 1] === second);
}

/** Removes comments and insignificant whitespace while preserving SQL literals. */
export function normalizeDDLForSchemaDescriptor_ACU(ddl: string): string {
  return stripSqlLineComments_ACU(String(ddl || '')).replace(/\s+/g, ' ').trim();
}

/**
 * Returns normalized table-level constraints without attempting to interpret
 * them. Schema migration V1 compares them verbatim and rejects any change.
 */
export function parseDDLTableConstraints_ACU(ddl: string): string[] {
  const body = getCreateTableDefinitionBody_ACU(ddl);
  if (body === null) return [];
  return splitColumnDefinitions(body)
    .map(definition => stripSqlLineComments_ACU(definition).replace(/\s+/g, ' ').trim())
    .filter(definition => /^(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(definition));
}

/** Returns normalized CREATE TABLE options following the closing definition bracket. */
export function parseDDLTableSuffix_ACU(ddl: string): string {
  const value = String(ddl || '');
  const bounds = findCreateTableDefinitionBounds_ACU(value);
  return bounds
    ? stripSqlLineComments_ACU(value.slice(bounds.closingIndex + 1)).replace(/;\s*$/, '').replace(/\s+/g, ' ').trim()
    : '';
}

function getCreateTableDefinitionBody_ACU(ddl: string): string | null {
  const value = String(ddl || '');
  const bounds = findCreateTableDefinitionBounds_ACU(value);
  return bounds ? value.slice(bounds.openingIndex + 1, bounds.closingIndex) : null;
}

function findCreateTableDefinitionBounds_ACU(value: string): { tableName: string; openingIndex: number; closingIndex: number } | null {
  let index = skipSqlTrivia_ACU(value, 0);
  index = consumeSqlKeyword_ACU(value, index, 'CREATE');
  if (index < 0) return null;
  index = consumeSqlKeyword_ACU(value, skipSqlTrivia_ACU(value, index), 'TABLE');
  if (index < 0) return null;
  index = skipSqlTrivia_ACU(value, index);
  const afterIf = consumeSqlKeyword_ACU(value, index, 'IF');
  if (afterIf >= 0) {
    const afterNot = consumeSqlKeyword_ACU(value, skipSqlTrivia_ACU(value, afterIf), 'NOT');
    const afterExists = afterNot < 0 ? -1 : consumeSqlKeyword_ACU(value, skipSqlTrivia_ACU(value, afterNot), 'EXISTS');
    if (afterExists < 0) return null;
    index = skipSqlTrivia_ACU(value, afterExists);
  }
  const tableNameStart = index;
  const tableNameEnd = skipSqlIdentifier_ACU(value, index);
  if (tableNameEnd <= tableNameStart) return null;
  index = tableNameEnd;
  index = skipSqlTrivia_ACU(value, index);
  if (value[index] !== '(') return null;
  const openingIndex = index;
  let depth = 0;
  let quote: "'" | '"' | '`' | '[' | null = null;
  for (; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (quote === '[') {
        if (char === ']') {
          if (value[index + 1] === ']') index += 1;
          else quote = null;
        }
      } else if (char === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === '-' && value[index + 1] === '-') {
      index = skipSqlTrivia_ACU(value, index);
      index -= 1;
      continue;
    }
    if (char === '/' && value[index + 1] === '*') {
      index = skipSqlTrivia_ACU(value, index);
      index -= 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return { tableName: value.slice(tableNameStart, tableNameEnd), openingIndex, closingIndex: index };
  }
  return null;
}

function skipSqlTrivia_ACU(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    if (/\s/.test(value[index])) { index += 1; continue; }
    if (value[index] === '-' && value[index + 1] === '-') {
      index += 2;
      while (index < value.length && value[index] !== '\n' && value[index] !== '\r') index += 1;
      continue;
    }
    if (value[index] === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end < 0) return value.length;
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function consumeSqlKeyword_ACU(value: string, start: number, keyword: string): number {
  const end = start + keyword.length;
  return value.slice(start, end).toUpperCase() === keyword && !/[A-Z0-9_$]/i.test(value[start - 1] || '') && !/[A-Z0-9_$]/i.test(value[end] || '') ? end : -1;
}

function skipSqlIdentifier_ACU(value: string, start: number): number {
  const quote = value[start];
  if (quote === '"' || quote === '`' || quote === '[') {
    const close = quote === '[' ? ']' : quote;
    let index = start + 1;
    while (index < value.length) {
      if (value[index] === close) {
        if (value[index + 1] === close) { index += 2; continue; }
        return index + 1;
      }
      index += 1;
    }
    return value.length;
  }
  let index = start;
  while (index < value.length && !/\s|\(/.test(value[index])) index += 1;
  return index;
}

function stripSqlLineComments_ACU(value: string): string {
  let result = '';
  let quote: "'" | '"' | '`' | '[' | null = null;
  let inBlockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inBlockComment) {
      if (char === '*' && value[index + 1] === '/') {
        inBlockComment = false;
        index += 1;
      } else if (char === '\n') {
        result += '\n';
      }
      continue;
    }
    if (quote) {
      result += char;
      if (quote === '[' ? char === ']' : char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char;
      result += char;
      continue;
    }
    if (char === '/' && value[index + 1] === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '-' && value[index + 1] === '-') {
      while (index < value.length && value[index] !== '\n') index += 1;
      if (index < value.length) result += '\n';
      continue;
    }
    result += char;
  }
  return result;
}

function extractTopLevelSqlTokens_ACU(definition: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let depth = 0;
  let quote: "'" | '"' | '`' | '[' | null = null;
  let inBlockComment = false;
  const flush = () => {
    if (current) tokens.push(current.toUpperCase());
    current = '';
  };
  for (let index = 0; index < definition.length; index += 1) {
    const char = definition[index];
    if (inBlockComment) {
      if (char === '*' && definition[index + 1] === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (quote === '[' ? char === ']' : char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      flush();
      quote = char;
      continue;
    }
    if (char === '/' && definition[index + 1] === '*') {
      flush();
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '(') {
      flush();
      depth += 1;
      continue;
    }
    if (char === ')') {
      flush();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && /[A-Za-z0-9_]/.test(char)) {
      current += char;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

function isAsciiOnly_ACU(value: string): boolean {
  return /^[\x00-\x7F]+$/.test(String(value || ''));
}

function buildDDLHeaderMismatchMessage_ACU(index: number, ddlColumn: DDLColumnInfo_ACU, header: string): string {
  return ddlColumn.comment
    ? `第 ${index + 1} 列不匹配：DDL 列名为「${ddlColumn.sqlName}」，注释为「${ddlColumn.comment}」，表头为「${header}」`
    : `第 ${index + 1} 列不匹配：DDL 列名为「${ddlColumn.sqlName}」，表头为「${header}」`;
}

export function validateDDLTextAgainstHeaders_ACU(
  ddlText: string,
  tableHeaders: string[],
): { valid: boolean; message: string } {
  const trimmed = String(ddlText || '').trim();
  if (!trimmed) {
    return { valid: false, message: '⚠ DDL 为空' };
  }
  if (!/CREATE\s+TABLE/i.test(trimmed)) {
    return { valid: false, message: '✗ 不是有效的 CREATE TABLE 语句' };
  }

  const columnInfos = parseDDLColumnInfos_ACU(trimmed);
  const firstColumn = columnInfos[0];
  if (!firstColumn || firstColumn.sqlName.toLowerCase() !== 'row_id' || !/row_id\s+INTEGER\s+PRIMARY\s+KEY/i.test(trimmed)) {
    return { valid: false, message: '✗ 缺少 row_id INTEGER PRIMARY KEY 列（必须作为第一列）' };
  }

  const normalizedHeaders = Array.isArray(tableHeaders)
    ? tableHeaders.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
  const firstHeader = normalizedHeaders[0];
  const isRowIdHeader = firstHeader === 'row_id' || firstHeader === '行号';
  const comparableHeaders = isRowIdHeader
    ? normalizedHeaders.slice(1)
    : normalizedHeaders;
  const comparableColumns = columnInfos.filter((item) => item.sqlName.toLowerCase() !== 'row_id');
  const issues: string[] = [];

  if (comparableColumns.length !== comparableHeaders.length) {
    issues.push(`列数不匹配：DDL 有 ${comparableColumns.length} 列，表头有 ${comparableHeaders.length} 列`);
  }

  const compareLength = Math.min(comparableColumns.length, comparableHeaders.length);
  for (let index = 0; index < compareLength; index += 1) {
    const ddlColumn = comparableColumns[index];
    const header = comparableHeaders[index];
    const headerIsAscii = isAsciiOnly_ACU(header);
    const sqlNameIsAscii = isAsciiOnly_ACU(ddlColumn.sqlName);
    const matchesPhysical = ddlColumn.sqlName === header;
    const matchesComment = !!ddlColumn.comment && ddlColumn.comment === header;

    if (headerIsAscii) {
      if (!matchesPhysical) {
        issues.push(buildDDLHeaderMismatchMessage_ACU(index, ddlColumn, header));
      }
      continue;
    }

    if (!matchesComment) {
      issues.push(buildDDLHeaderMismatchMessage_ACU(index, ddlColumn, header));
      continue;
    }

    if (!sqlNameIsAscii) {
      issues.push(
        `第 ${index + 1} 列不匹配：表头为「${header}」时，DDL 物理列名必须使用英文/ASCII，当前 DDL 列名为「${ddlColumn.sqlName}」，注释为「${ddlColumn.comment}」`,
      );
    }
  }

  if (issues.length > 0) {
    return { valid: false, message: `⚠ DDL 列名与表头不完全匹配：${issues.join('；')}` };
  }

  return { valid: true, message: '✓ DDL 格式正确，列名与表头匹配' };
}

/**
 * 根据列在 DDL 中的位置索引获取英文列名
 * 索引从 0 开始，对应 content[0] 中的位置（包含 row_id）
 *
 * @param ddl CREATE TABLE 语句
 * @param index 列索引（对应 content[0] 的位置，0 通常是 row_id）
 * @returns 英文列名，找不到返回 null
 */
export function getDDLColumnNameByIndex(ddl: string, index: number): string | null {
  const columns = parseDDLColumnNames(ddl);
  if (index < 0 || index >= columns.length) return null;
  return columns[index];
}

/**
 * 更新 DDL 中指定列的注释（中文名）
 * 按行扫描 DDL，找到指定列名的行，替换其 `-- 注释` 部分。
 * 如果该行没有注释，则在行尾添加 `-- 新注释`。
 *
 * @param ddl 原始 CREATE TABLE 语句
 * @param columnName 要更新注释的英文列名
 * @param newComment 新的注释内容（中文名）
 * @returns 更新后的 DDL 字符串；如果找不到列名则返回原 DDL
 */
export function updateDDLColumnComment(ddl: string, columnName: string, newComment: string): string {
  if (!ddl || !columnName || !newComment) return ddl;

  const lines = ddl.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // 检查该行是否以目标列名开头（列定义行）
    const colMatch = trimmed.match(/^([^\s,()]+)\s+/);
    if (!colMatch || colMatch[1] !== columnName) continue;

    // 找到目标列，替换或添加注释
    found = true;
    const line = lines[i];

    // 情况 1：行内已有 `-- 注释`，替换注释内容
    const commentMatch = line.match(/^(.*?)(--\s*).+?(,?\s*)$/);
    if (commentMatch) {
      lines[i] = `${commentMatch[1]}-- ${newComment}${commentMatch[3]}`;
      break;
    }

    // 情况 2：行内没有注释，需要添加
    // 先检查行尾是否有逗号
    const trailingCommaMatch = line.match(/^(.*?)(,\s*)$/);
    if (trailingCommaMatch) {
      // 有逗号：在逗号前插入注释 → `  col TEXT, -- 注释`
      // 按照项目约定格式：逗号在注释前 → `  col TEXT, -- 注释`
      lines[i] = `${trailingCommaMatch[1]}, -- ${newComment}`;
    } else {
      // 无逗号（最后一列）：直接在行尾添加注释
      lines[i] = `${line.trimEnd()} -- ${newComment}`;
    }
    break;
  }

  if (!found) {
    logWarn_ACU(`[Schema] updateDDLColumnComment: 未找到列 "${columnName}"，DDL 未修改`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 内部工具函数
// ═══════════════════════════════════════════════════════════════

/**
 * 分割 DDL 括号内的列定义（处理嵌套括号）
 */
function splitColumnDefinitions(body: string): string[] {
  const results: string[] = [];
  let current = '';
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let quote: "'" | '"' | '`' | '[' | null = null;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];

    if (quote) {
      current += char;
      if (quote === '[') {
        if (char === ']') quote = null;
        continue;
      }
      if (char === quote) {
        if (i + 1 < body.length && body[i + 1] === quote) {
          current += body[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === '*' && i + 1 < body.length && body[i + 1] === '/') {
        current += body[i + 1];
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (char === '/' && i + 1 < body.length && body[i + 1] === '*') {
      inBlockComment = true;
      current += char;
      continue;
    }

    // 检测 -- 行注释开始
    if (!inLineComment && char === '-' && i + 1 < body.length && body[i + 1] === '-') {
      inLineComment = true;
      current += char;
      continue;
    }

    // 换行符结束行注释
    if (inLineComment && char === '\n') {
      inLineComment = false;
      current += char;
      continue;
    }

    // 在行注释内，所有字符直接追加（包括逗号）
    if (inLineComment) {
      current += char;
      continue;
    }

    if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      results.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    results.push(current);
  }

  return results;
}
