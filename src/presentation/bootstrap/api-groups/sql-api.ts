/**
 * presentation/bootstrap/api-groups/sql-api.ts
 * 原生 SQL 对外 API — executeSqlQuery / executeSqlMutation / executeSql
 */

import { refreshMergedDataAndNotifyWithUI_ACU } from '../../components/pipeline-ui-helpers';
import { currentJsonTableData_ACU, getCurrentIsolationKey_ACU } from '../../../service/runtime/state-manager';
import { ensureStorageProviderReady_ACU, getStorageProvider } from '../../../service/table/table-storage-strategy';
import { getNameMapper } from '../../../service/runtime/template-vars/name-mapper';
import { parseDDLTableName } from '../../../shared/ddl-utils';
import { runSqliteRuntimeMutationCommit_ACU, runTableUpdateCommit_ACU } from '../../../service/table/table-update-commit';
import { extractTableNamesFromStatements, mapSqlTableNamesToSheetKeys_ACU, splitSqlStatements } from '../../../service/table/sql-table-service';
import type { TableWriteConflictUnitV2_ACU } from '../../../service/table/storage-frame-v2-types';
import type { SqlMutationResult, SqlQueryResult } from '../../../shared/table-storage-provider';
import { logDebug_ACU, logError_ACU } from '../../../shared/utils';
import type { ApiGroupContext } from './callback-api';

type SqlParam_ACU = string | number | null;

type SqlMutationOptions_ACU = {
    skipChatSave: boolean;
    skipNotify: boolean;
    targetSheetKeys: string[] | null;
    updateGroupKeys: string[] | null;
    trackingSheetKeys: string[] | null | undefined;
};

type ParsedSqlArgs_ACU = SqlMutationOptions_ACU & {
    sql: string;
    params?: SqlParam_ACU[];
};

export type PublicSqlMutationResult_ACU = SqlMutationResult & {
    saved?: boolean;
    messageIndex?: number;
    saveError?: string;
};

export type PublicSqlQueryResult_ACU = SqlQueryResult & {
    rows: Record<string, string | number | Uint8Array | null>[];
    limit?: number;
    offset?: number;
    sql?: string;
};

export type PublicSqlExecutionResult_ACU =
    | { type: 'query'; result: PublicSqlQueryResult_ACU }
    | { type: 'mutation'; result: PublicSqlMutationResult_ACU };

export type PublicSqlBatchResult_ACU = PublicSqlMutationResult_ACU & {
    success: boolean;
    modifiedKeys: string[];
    appliedEdits: number;
};

function isPlainObjectArg_ACU(value: any): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined_ACU<T = any>(...values: T[]): T | undefined {
    for (const value of values) {
        if (value !== undefined) return value;
    }
    return undefined;
}

function toBooleanOption_ACU(value: any): boolean {
    if (value === true) return true;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
    return value === 1;
}

function normalizeSqlParams_ACU(value: any, methodName: string): SqlParam_ACU[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`${methodName}: params must be an array.`);
    }
    return value.map((item) => normalizeSqlValue_ACU(item));
}

function normalizeSqlValue_ACU(value: any): SqlParam_ACU {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return String(value);
}

function normalizeSheetKeys_ACU(value: any, methodName: string, fieldName: string): string[] | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const rawValues = Array.isArray(value) ? value : [value];
    const keys = rawValues
        .map(item => String(item ?? '').trim())
        .filter(Boolean);
    if (!Array.isArray(value) && keys.length === 0) {
        throw new Error(`${methodName}: ${fieldName} must contain at least one sheet key when provided.`);
    }
    return [...new Set(keys)];
}

function parseSqlArgs_ACU(sqlOrOptions: any, params?: any, options?: any, methodName = 'executeSql'): ParsedSqlArgs_ACU {
    const objectArgs = isPlainObjectArg_ACU(sqlOrOptions) ? sqlOrOptions : null;
    const sql = String(objectArgs ? firstDefined_ACU(objectArgs.sql, objectArgs.statement, objectArgs.query) : sqlOrOptions ?? '').trim();
    if (!sql) {
        throw new Error(`${methodName}: sql is required.`);
    }

    const optionSource = objectArgs || (isPlainObjectArg_ACU(options) ? options : null);
    return {
        sql,
        params: normalizeSqlParams_ACU(objectArgs ? objectArgs.params : params, methodName),
        skipChatSave: toBooleanOption_ACU(firstDefined_ACU(
            optionSource?.skipChatSave,
            optionSource?.skipSave,
            optionSource?.isImportMode,
        )),
        skipNotify: toBooleanOption_ACU(firstDefined_ACU(
            optionSource?.skipNotify,
            optionSource?.silent,
            optionSource?.isSilent,
            optionSource?.suppressNotify,
            optionSource?.suppressNotification,
        )),
        targetSheetKeys: normalizeSheetKeys_ACU(firstDefined_ACU(
            optionSource?.targetSheetKeys,
            optionSource?.sheetKeys,
            optionSource?.targetSheets,
        ), methodName, 'targetSheetKeys') ?? null,
        updateGroupKeys: normalizeSheetKeys_ACU(firstDefined_ACU(
            optionSource?.updateGroupKeys,
            optionSource?.groupKeys,
        ), methodName, 'updateGroupKeys') ?? null,
        trackingSheetKeys: normalizeSheetKeys_ACU(firstDefined_ACU(
            optionSource?.trackingSheetKeys,
            optionSource?.trackingKeys,
        ), methodName, 'trackingSheetKeys'),
    };
}

function stripSqlCommentsAndStrings_ACU(sql: string): string {
    let output = '';
    let inString: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < sql.length; i += 1) {
        const char = sql[i];
        const next = sql[i + 1];

        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
                output += ' ';
            }
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
                output += ' ';
            }
            continue;
        }
        if (inString) {
            if (char === inString) {
                if (next === inString) {
                    i += 1;
                } else {
                    inString = null;
                }
            }
            output += ' ';
            continue;
        }

        if (char === '-' && next === '-') {
            inLineComment = true;
            i += 1;
            output += ' ';
            continue;
        }
        if (char === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            output += ' ';
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            inString = char;
            output += ' ';
            continue;
        }
        output += char;
    }
    return output;
}

function splitTopLevelSqlStatements_ACU(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inString: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < sql.length; i += 1) {
        const char = sql[i];
        const next = sql[i + 1];

        if (inLineComment) {
            current += char;
            if (char === '\n') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            current += char;
            if (char === '*' && next === '/') {
                current += next;
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (inString) {
            current += char;
            if (char === inString) {
                if (next === inString) {
                    current += next;
                    i += 1;
                } else {
                    inString = null;
                }
            }
            continue;
        }

        if (char === '-' && next === '-') {
            current += char + next;
            inLineComment = true;
            i += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            current += char + next;
            inBlockComment = true;
            i += 1;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            inString = char;
            current += char;
            continue;
        }
        if (char === ';') {
            const trimmed = current.trim();
            if (trimmed) statements.push(trimmed);
            current = '';
            continue;
        }
        current += char;
    }

    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    return statements;
}

function containsWriteKeyword_ACU(sql: string): boolean {
    const cleaned = stripSqlCommentsAndStrings_ACU(sql);
    return /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE)\b/i.test(cleaned);
}

export function isSqlReadStatement_ACU(sql: string): boolean {
    const statements = splitTopLevelSqlStatements_ACU(sql);
    if (statements.length !== 1) return false;
    const statement = statements[0].trim();
    if (!/^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(statement)) return false;
    if (/^WITH\b/i.test(statement) && containsWriteKeyword_ACU(statement)) return false;
    if (!/^WITH\b/i.test(statement) && /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE)\b/i.test(statement)) return false;
    return true;
}

function quoteIdentifier_ACU(name: string): string {
    return `\`${String(name).replace(/`/g, '``')}\``;
}

function normalizeLimit_ACU(value: any, fallback?: number): number | undefined {
    if (value === undefined || value === null || value === '') return fallback;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return fallback;
    return Math.min(1000, Math.trunc(numeric));
}

function normalizeOffset_ACU(value: any): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function rowsFromSqlResult_ACU(result: SqlQueryResult): Record<string, string | number | Uint8Array | null>[] {
    return result.values.map(row => {
        const obj: Record<string, string | number | Uint8Array | null> = {};
        result.columns.forEach((column, index) => { obj[column] = row[index] ?? null; });
        return obj;
    });
}

function toPublicSqlQueryResult_ACU(result: SqlQueryResult, meta: { sql?: string; limit?: number; offset?: number } = {}): PublicSqlQueryResult_ACU {
    return {
        ...result,
        rows: rowsFromSqlResult_ACU(result),
        ...(meta.sql !== undefined ? { sql: meta.sql } : {}),
        ...(meta.limit !== undefined ? { limit: meta.limit } : {}),
        ...(meta.offset !== undefined ? { offset: meta.offset } : {}),
    };
}

function stripTrailingSqlSemicolon_ACU(sql: string): string {
    return String(sql || '').trim().replace(/;+\s*$/, '');
}

function buildLimitedReadSql_ACU(sql: string, params: SqlParam_ACU[] | undefined, limit?: number, offset = 0): { sql: string; params?: SqlParam_ACU[] } {
    if (limit === undefined) return { sql, params };
    const trimmed = stripTrailingSqlSemicolon_ACU(sql);
    if (!/^(SELECT|WITH)\b/i.test(trimmed)) return { sql, params };
    return {
        sql: `SELECT * FROM (${trimmed}) AS acu_query LIMIT ? OFFSET ?`,
        params: [...(params || []), limit, offset],
    };
}

function getEnglishTableName_ACU(sheet: any, fallback: string): string {
    const ddl = sheet?.sourceData?.ddl;
    if (ddl) {
        const parsed = parseDDLTableName(ddl);
        if (parsed) return parsed;
    }
    return fallback;
}

function findQueryTargetSheet_ACU(tableNameOrSheetKey: string): { sheet: any; sheetKey: string; englishTableName: string } | null {
    const tableData = currentJsonTableData_ACU as Record<string, any> | null;
    const input = String(tableNameOrSheetKey || '').trim();
    if (!tableData || !input) return null;

    if (input.startsWith('sheet_') && tableData[input]) {
        const sheet = tableData[input];
        return { sheet, sheetKey: input, englishTableName: getEnglishTableName_ACU(sheet, String(sheet?.name || input)) };
    }

    const mapper = getNameMapper();
    const maybeChineseName = mapper.getChineseTableName(input);
    for (const sheetKey of Object.keys(tableData).filter(key => key.startsWith('sheet_'))) {
        const sheet = tableData[sheetKey];
        const english = getEnglishTableName_ACU(sheet, String(sheet?.name || sheetKey));
        if (sheet?.name === input || sheet?.name === maybeChineseName || english === input) {
            return { sheet, sheetKey, englishTableName: english };
        }
    }
    return null;
}

function resolveQueryColumn_ACU(englishTableName: string, sheet: any, column: string): string {
    const raw = String(column || '').trim();
    if (!raw) throw new Error('queryTableRows: column must not be empty.');
    if (raw === '*') return raw;
    if (raw === 'row_id') return raw;
    const mapper = getNameMapper();
    const english = mapper.resolveColumnName(englishTableName, raw);
    const chinese = mapper.getChineseColumnName(englishTableName, english);
    const headers = Array.isArray(sheet?.content?.[0]) ? sheet.content[0].map((item: any) => String(item)) : [];
    if (headers.length > 0 && !headers.includes(raw) && !headers.includes(chinese) && !headers.includes(english)) {
        throw new Error(`queryTableRows: unknown column ${raw}.`);
    }
    return english;
}

function buildWhereClause_ACU(englishTableName: string, sheet: any, where: any, params: SqlParam_ACU[]): string {
    if (!where || typeof where !== 'object' || Array.isArray(where)) return '';
    const clauses: string[] = [];
    for (const [column, value] of Object.entries(where)) {
        const sqlColumn = quoteIdentifier_ACU(resolveQueryColumn_ACU(englishTableName, sheet, column));
        if (Array.isArray(value)) {
            if (value.length === 0) {
                clauses.push('1 = 0');
                continue;
            }
            clauses.push(`${sqlColumn} IN (${value.map(() => '?').join(', ')})`);
            params.push(...value.map(item => normalizeSqlValue_ACU(item)));
        } else if (value === null || value === undefined) {
            clauses.push(`${sqlColumn} IS NULL`);
        } else {
            clauses.push(`${sqlColumn} = ?`);
            params.push(normalizeSqlValue_ACU(value));
        }
    }
    return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

function buildOrderClause_ACU(englishTableName: string, sheet: any, orderBy: any): string {
    if (!orderBy) return '';
    const items = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts = items.map(item => {
        const column = typeof item === 'string' ? item : item?.column;
        const directionRaw = typeof item === 'string' ? 'ASC' : String(item?.direction || 'ASC').toUpperCase();
        const direction = directionRaw === 'DESC' ? 'DESC' : 'ASC';
        return `${quoteIdentifier_ACU(resolveQueryColumn_ACU(englishTableName, sheet, column))} ${direction}`;
    });
    return parts.length > 0 ? ` ORDER BY ${parts.join(', ')}` : '';
}

function buildQueryTableRowsSql_ACU(options: Record<string, any>): { sql: string; params: SqlParam_ACU[]; limit: number; offset: number } {
    const targetName = String(options.sheetKey || options.tableName || options.table || '').trim();
    const target = findQueryTargetSheet_ACU(targetName);
    if (!target) throw new Error(`queryTableRows: table not found: ${targetName}`);

    const columnsInput = Array.isArray(options.columns) && options.columns.length > 0 ? options.columns : ['*'];
    const columns = columnsInput.includes('*')
        ? '*'
        : columnsInput.map((column: any) => quoteIdentifier_ACU(resolveQueryColumn_ACU(target.englishTableName, target.sheet, String(column)))).join(', ');
    const params: SqlParam_ACU[] = [];
    const where = buildWhereClause_ACU(target.englishTableName, target.sheet, options.where, params);
    const order = buildOrderClause_ACU(target.englishTableName, target.sheet, options.orderBy || options.order);
    const limit = normalizeLimit_ACU(options.limit, 100) ?? 100;
    const offset = normalizeOffset_ACU(options.offset);
    const sql = `SELECT ${columns} FROM ${quoteIdentifier_ACU(target.englishTableName)}${where}${order} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return { sql, params, limit, offset };
}

function inferRawSqlSheetKeys_ACU(sql: string): string[] {
    const tableData = currentJsonTableData_ACU as any;
    if (!tableData) return [];
    const tableNames = extractTableNamesFromStatements(splitSqlStatements(sql));
    return mapSqlTableNamesToSheetKeys_ACU(tableData, tableNames);
}

function withInferredRawSqlTargets_ACU<T extends ParsedSqlArgs_ACU>(args: T): T {
    const inferred = inferRawSqlSheetKeys_ACU(args.sql);
    if (inferred.length === 0) return args;
    return {
        ...args,
        targetSheetKeys: inferred,
    };
}

function buildRawSqlWriteSet_ACU(options: SqlMutationOptions_ACU): TableWriteConflictUnitV2_ACU[] {
    const keys = options.targetSheetKeys;
    return Array.isArray(keys) && keys.length > 0
        ? keys.map(sheetKey => ({ kind: 'sheet' as const, sheetKey }))
        : [{ kind: 'all' as const }];
}

function buildRawSqlBatchOperations_ACU(sql: string) {
    const statements = splitSqlStatements(String(sql || '').replace(/<!--|-->/g, '').trim());
    return statements.length > 0 ? [{ kind: 'sql_batch' as const, statements }] : [];
}

export function createSqlApi(ctx: ApiGroupContext): Record<string, Function> {
    return {
        executeSqlQuery: function(sqlOrOptions: any, params?: any, options?: any): PublicSqlQueryResult_ACU | null {
            try {
                const args = parseSqlArgs_ACU(sqlOrOptions, params, options, 'executeSqlQuery');
                if (!isSqlReadStatement_ACU(args.sql)) {
                    throw new Error('executeSqlQuery: only SELECT/PRAGMA/EXPLAIN/WITH statements are allowed.');
                }
                const optionSource = isPlainObjectArg_ACU(sqlOrOptions) ? sqlOrOptions : (isPlainObjectArg_ACU(options) ? options : null);
                const limit = normalizeLimit_ACU(optionSource?.limit);
                const offset = normalizeOffset_ACU(optionSource?.offset);
                const query = buildLimitedReadSql_ACU(args.sql, args.params, limit, offset);
                return toPublicSqlQueryResult_ACU(getStorageProvider().executeQuery(query.sql, query.params), { sql: query.sql, limit, offset });
            } catch (error) {
                logError_ACU('executeSqlQuery failed:', error);
                return null;
            }
        },

        querySql: function(sqlOrOptions: any, params?: any, options?: any): PublicSqlQueryResult_ACU | null {
            try {
                const args = parseSqlArgs_ACU(sqlOrOptions, params, options, 'querySql');
                if (!isSqlReadStatement_ACU(args.sql)) {
                    throw new Error('querySql: only SELECT/PRAGMA/EXPLAIN/WITH statements are allowed.');
                }
                const optionSource = isPlainObjectArg_ACU(sqlOrOptions) ? sqlOrOptions : (isPlainObjectArg_ACU(options) ? options : null);
                const limit = normalizeLimit_ACU(optionSource?.limit);
                const offset = normalizeOffset_ACU(optionSource?.offset);
                const query = buildLimitedReadSql_ACU(args.sql, args.params, limit, offset);
                return toPublicSqlQueryResult_ACU(getStorageProvider().executeQuery(query.sql, query.params), { sql: query.sql, limit, offset });
            } catch (error) {
                logError_ACU('querySql failed:', error);
                return null;
            }
        },

        queryTableRows: function(options: any = {}): PublicSqlQueryResult_ACU | null {
            try {
                if (!isPlainObjectArg_ACU(options)) {
                    throw new Error('queryTableRows: options must be an object.');
                }
                const query = buildQueryTableRowsSql_ACU(options);
                return toPublicSqlQueryResult_ACU(getStorageProvider().executeQuery(query.sql, query.params), {
                    sql: query.sql,
                    limit: query.limit,
                    offset: query.offset,
                });
            } catch (error) {
                logError_ACU('queryTableRows failed:', error);
                return null;
            }
        },

        executeSqlMutation: async function(sqlOrOptions: any, params?: any, options?: any): Promise<PublicSqlMutationResult_ACU> {
            try {
                const args = withInferredRawSqlTargets_ACU(parseSqlArgs_ACU(sqlOrOptions, params, options, 'executeSqlMutation'));
                const writeSet = buildRawSqlWriteSet_ACU(args);
                const commitResult = await runSqliteRuntimeMutationCommit_ACU<null>({
                    source: 'raw_sql_mutation',
                    reason: 'raw_sql_mutation',
                    isolationKey: getCurrentIsolationKey_ACU(),
                    writeSet,
                    revisionWriteSet: writeSet,
                    initialData: currentJsonTableData_ACU,
                    targetMessageIndex: -1,
                    targetSheetKeys: args.targetSheetKeys,
                    updateGroupKeys: args.updateGroupKeys,
                    trackingSheetKeys: args.trackingSheetKeys === undefined ? [] : args.trackingSheetKeys,
                    trackAsUpdate: false,
                    skipChatSave: args.skipChatSave,
                    sql: args.sql,
                    params: args.params,
                    mapValue: () => null,
                });
                if (!commitResult.success || !commitResult.mutationResult) {
                    return { changes: 0, errors: [commitResult.error || 'executeSqlMutation failed'] };
                }
                if (!args.skipNotify) {
                    await refreshMergedDataAndNotifyWithUI_ACU({ skipNotify: false });
                    logDebug_ACU('executeSqlMutation: refreshed merged data after raw SQL mutation.');
                }
                return args.skipChatSave
                    ? { ...commitResult.mutationResult }
                    : { ...commitResult.mutationResult, saved: commitResult.saved, messageIndex: commitResult.messageIndex };
            } catch (error: any) {
                const message = error?.message || String(error);
                logError_ACU('executeSqlMutation failed:', error);
                return { changes: 0, errors: [message] };
            }
        },

        executeSqlBatch: async function(sqlOrOptions: any, options?: any): Promise<PublicSqlBatchResult_ACU> {
            try {
                const args = withInferredRawSqlTargets_ACU(parseSqlArgs_ACU(sqlOrOptions, undefined, options, 'executeSqlBatch'));
                if (args.params && args.params.length > 0) {
                    throw new Error('executeSqlBatch: params are not supported for batch SQL. Use literal multi-statement SQL or executeSqlMutation for one parameterized statement.');
                }
                const writeSet = buildRawSqlWriteSet_ACU(args);
                const commitResult = await runTableUpdateCommit_ACU<PublicSqlBatchResult_ACU>({
                    source: 'raw_sql_batch',
                    reason: 'raw_sql_batch',
                    isolationKey: getCurrentIsolationKey_ACU(),
                    writeSet,
                    revisionWriteSet: writeSet,
                    initialData: currentJsonTableData_ACU,
                    targetMessageIndex: -1,
                    targetSheetKeys: args.targetSheetKeys,
                    updateGroupKeys: args.updateGroupKeys,
                    trackingSheetKeys: args.trackingSheetKeys === undefined ? [] : args.trackingSheetKeys,
                    trackAsUpdate: false,
                    operations: buildRawSqlBatchOperations_ACU(args.sql),
                    skipChatSave: args.skipChatSave,
                }, async () => {
                    const provider = await ensureStorageProviderReady_ACU();
                    const batchResult = provider.applyEdits(args.sql, 'raw_sql_api');
                    if (!batchResult.success) {
                        return { success: false, error: batchResult.error || 'executeSqlBatch failed' };
                    }
                    const tableData = provider.getCurrentData();
                    if (!tableData) {
                        return { success: false, error: 'SQLite runtime data export failed' };
                    }
                    return {
                        success: true,
                        tableData: tableData as any,
                        mutationResult: { changes: batchResult.appliedEdits, errors: [] },
                        value: {
                            success: true,
                            modifiedKeys: batchResult.modifiedKeys,
                            appliedEdits: batchResult.appliedEdits,
                            changes: batchResult.appliedEdits,
                            errors: [],
                        },
                    };
                });
                if (!commitResult.success || !commitResult.value) {
                    return { success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, errors: [commitResult.error || 'executeSqlBatch failed'] };
                }
                if (!args.skipNotify) {
                    await refreshMergedDataAndNotifyWithUI_ACU({ skipNotify: false });
                    logDebug_ACU('executeSqlBatch: refreshed merged data after raw SQL transaction.');
                }
                return { ...commitResult.value, saved: commitResult.saved, messageIndex: commitResult.messageIndex };
            } catch (error: any) {
                const message = error?.message || String(error);
                logError_ACU('executeSqlBatch failed:', error);
                return { success: false, modifiedKeys: [], appliedEdits: 0, changes: 0, errors: [message] };
            }
        },

        executeSql: async function(sqlOrOptions: any, params?: any, options?: any): Promise<PublicSqlExecutionResult_ACU | null> {
            try {
                const args = parseSqlArgs_ACU(sqlOrOptions, params, options, 'executeSql');
                if (isSqlReadStatement_ACU(args.sql)) {
                    const queryResult = getStorageProvider().executeQuery(args.sql, args.params);
                    return {
                        type: 'query',
                        result: toPublicSqlQueryResult_ACU(queryResult, { sql: args.sql }),
                    };
                }

                const writeArgs = withInferredRawSqlTargets_ACU(args);
                const result = await this.executeSqlMutation(writeArgs);
                return { type: 'mutation', result };
            } catch (error) {
                logError_ACU('executeSql failed:', error);
                return null;
            }
        },
    };
}
