/**
 * service/ai/prompt-builder/prompt-prepare.ts
 * AI 输入准备 — 格式化表格数据和对话内容为 AI 可读文本
 * 从 prompt-builder.ts 拆出（L14-L194）
 */
import { manualExtraHint_ACU } from '../../runtime/state-manager';
import { currentJsonTableData_ACU, settings_ACU } from '../../runtime/state-manager';
import type { TemplateScope_ACU } from '../../template/chat-scope';
import type { SqlTableApplyScope_ACU } from '../../../shared/table-storage-provider';
import { getUserName_ACU } from '../../../data/gateways/host-state-gateway';
import { attachSeedRowsToCurrentDataFromGuide_ACU, ensureChatSheetGuideSeeded_ACU, getEffectiveSeedRowsForSheet_ACU, getSortedSheetKeys_ACU, filterSheetKeysByTemplateScope_ACU, projectSheetForTemplateScope_ACU, resolveTemplateScope_ACU } from '../../template/chat-scope';
import { getCombinedWorldbookContent_ACU, getWorldBooks_ACU } from '../../worldbook/pipeline';
import { isDatabaseGeneratedLorebookEntry_ACU, resolveGeneratedEntriesForTable_ACU } from '../../worldbook/worldbook-placeholder-classification';
import { resolvePreTakeoverWorldbookSnapshot_ACU } from '../../agent/agent-worldbook-takeover';
import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU, normalizeExcludeRules_ACU, normalizeExtractRules_ACU } from '../../../shared/utils';
import { applyContextTagFilters_ACU } from '../../runtime/helpers-remaining';
import { isSqliteMode } from '../../table/storage-mode';
import { ensureStorageProviderReady_ACU, getStorageRuntimeHealth_ACU } from '../../table/table-storage-strategy';
import { parseDDLTableName, rebindCreateTableName_ACU, resolveEffectiveDDL, type EffectiveDDLColumnMap_ACU } from '../../../data/sqlite/schema-mapper';
import { getSheetColumnProjection_ACU, projectSheetDDLForVisibleColumns_ACU, projectSheetRowToVisibleColumns_ACU } from '../../../shared/ddl-utils';
import { getPhysicalTableNameForSheet_ACU } from '../../../shared/sheet-identity';
import { replaceDbSqlVariables } from '../../runtime/template-vars/sql-query-var';

const AUTHOR_SQL_TABLE_IDENTIFIER_ACU = /^[A-Za-z_][A-Za-z0-9_]*$/;

  export interface PrepareAIInputFailure_ACU {
    ok: false;
    failureCode: string;
    message: string;
    retryable: boolean;
  }

  function createPromptRuntimeFailure_ACU(
    failureCode: string,
    message: string,
    retryable: boolean,
  ): PrepareAIInputFailure_ACU {
    return { ok: false, failureCode, message, retryable };
  }

  function getPromptRuntimeFailureFromHealth_ACU(): PrepareAIInputFailure_ACU {
    const health = getStorageRuntimeHealth_ACU();
    if (health.status === 'loading') {
      return createPromptRuntimeFailure_ACU('runtime_loading', 'SQLite 运行时正在加载，请等待加载完成后重试。', true);
    }
    if (health.failureCode === 'provider_fallback' || health.activeMode === 'native') {
      return createPromptRuntimeFailure_ACU('provider_fallback', 'SQLite 运行时加载失败，当前未使用 SQLite 数据库。', false);
    }
    return createPromptRuntimeFailure_ACU(
      health.failureCode || 'provider_load_failed',
      'SQLite 运行时未就绪，已阻止准备 AI 输入。',
      health.status === 'idle',
    );
  }

  async function resolvePromptSourceTableData_ACU(options: any, sqlMode: boolean): Promise<any | PrepareAIInputFailure_ACU> {
    if (!sqlMode) {
        return options?.tableData || currentJsonTableData_ACU;
    }

    try {
        const provider = await ensureStorageProviderReady_ACU({ signal: options?.signal });
        if (provider.mode !== 'sqlite') {
            logError_ACU('prepareAIInput_ACU: SQLite mode expected a SQLite runtime provider.');
            return createPromptRuntimeFailure_ACU('provider_fallback', 'SQLite 运行时加载失败，当前未使用 SQLite 数据库。', false);
        }
        const runtimeData = provider.getCurrentData();
        if (!runtimeData) {
            logError_ACU('prepareAIInput_ACU: SQLite runtime exported no table data.');
            return createPromptRuntimeFailure_ACU('runtime_export_null', 'SQLite 运行时未导出可用表格数据。', true);
        }
        return runtimeData;
    } catch (e) {
        if ((e as any)?.name === 'AbortError') {
            throw e;
        }
        const failure = getPromptRuntimeFailureFromHealth_ACU();
        logError_ACU(`prepareAIInput_ACU: SQLite runtime unavailable (${failure.failureCode}).`, e);
        return failure;
    }
  }

  export async function prepareAIInput_ACU(
    messages: any[],
    updateMode = 'standard',
    targetSheetKeys: string[] | null = null,
    options: { tableData?: any; excludeImportTaggedWorldbookEntries?: boolean; agentGreenlights?: any[]; isolationKey?: string; templateScope?: TemplateScope_ACU; sqlApplyScope?: SqlTableApplyScope_ACU; signal?: AbortSignal } = {},
  ) {
    const sqlMode = isSqliteMode();
    const sourceTableData = await resolvePromptSourceTableData_ACU(options, sqlMode);
    if (sourceTableData && typeof sourceTableData === 'object' && sourceTableData.ok === false) {
        return sourceTableData;
    }
    if (!sourceTableData) {
        logError_ACU(sqlMode
            ? 'prepareAIInput_ACU: Cannot prepare AI input, SQLite runtime DB data is null.'
            : 'prepareAIInput_ACU: Cannot prepare AI input, currentJsonTableData_ACU is null.');
        return null;
    }

    let _seedGuideDataForThisPrepare_ACU: Record<string, any> | null = null;
    let workingTableData = sourceTableData;
    try {
        if (!sqlMode) {
            _seedGuideDataForThisPrepare_ACU = await ensureChatSheetGuideSeeded_ACU({ reason: 'prepare_ai_input_seedrows' });
            if (_seedGuideDataForThisPrepare_ACU) {
                if (options?.tableData) {
                    workingTableData = JSON.parse(JSON.stringify(sourceTableData));
                    Object.keys(workingTableData).forEach((sheetKey) => {
                        if (!sheetKey.startsWith('sheet_')) return;
                        const table = workingTableData[sheetKey];
                        if (!table || typeof table !== 'object') return;
                        const existing = table?.seedRows;
                        if (Array.isArray(existing) && existing.length > 0) return;
                        const seedRows = _seedGuideDataForThisPrepare_ACU?.[sheetKey]?.seedRows;
                        if (Array.isArray(seedRows) && seedRows.length > 0) {
                            table.seedRows = JSON.parse(JSON.stringify(seedRows));
                        }
                    });
                } else {
                    attachSeedRowsToCurrentDataFromGuide_ACU(_seedGuideDataForThisPrepare_ACU);
                }
            }
        }
    } catch (e) { logWarn_ACU('[AI输入准备] ensureChatSheetGuideSeeded 失败, seed rows 可能不完整:', e); }

    let tableDataText = '';
    let _seedRowsTablesUsed_ACU: string[] = [];
    // 模板只起指导作用：只有模板声明的表参与 prompt。
    // 范围未知（解析失败）时不过滤，避免把所有表判成不参与。
    const templateScope = Object.prototype.hasOwnProperty.call(options, 'templateScope')
        ? options.templateScope ?? null
        : resolveTemplateScope_ACU(options.isolationKey);
    const tableIndexes = filterSheetKeysByTemplateScope_ACU(getSortedSheetKeys_ACU(workingTableData), templateScope);
    // 作者 DDL 名是 AI 写入契约；冲突时不能让异常越过编排器，也不能继续构造无法安全路由的 prompt。
    const promptIdentifierSource = options.sqlApplyScope?.templateData || workingTableData;
    const authoredTableNames = new Map<string, string | undefined>();
    if (sqlMode) {
        try {
            for (const sheetKey of tableIndexes) {
                authoredTableNames.set(sheetKey, resolveAuthoredTableNameForPrompt_ACU(promptIdentifierSource, sheetKey));
            }
        } catch (error: any) {
            const message = error?.message || String(error);
            return createPromptRuntimeFailure_ACU('authored_table_name_conflict', message, false);
        }
    }
    tableIndexes.forEach((sheetKey, tableIndex) => {
        const rawTable = workingTableData[sheetKey];
        if (!rawTable || !rawTable.name || !rawTable.content) return;
        // 模板未声明的列合并进 hiddenPhysicalColumns，只影响投影，不改写持久化数据。
        const table: any = projectSheetForTemplateScope_ACU(rawTable, templateScope, sheetKey);

        if (targetSheetKeys && Array.isArray(targetSheetKeys)) {
            if (!targetSheetKeys.includes(sheetKey)) return;
        }

        const isSummaryTable = isSummaryOrOutlineTable_ACU(table.name);
        let shouldShowData = true;
        
        if (!targetSheetKeys) {
            const isUnifiedMode = (updateMode === 'full' || updateMode === 'manual_unified' || updateMode === 'auto_unified');
            const isStandardMode = (updateMode === 'standard' || updateMode === 'auto_standard' || updateMode === 'manual_standard');
            const isSummaryMode = (updateMode === 'summary' || updateMode === 'auto_summary_silent' || updateMode === 'manual_summary');
            
            if (isUnifiedMode) {
                 shouldShowData = true;
            } else if (isStandardMode && isSummaryTable) {
                shouldShowData = false;
            } else if (isSummaryMode && !isSummaryTable) {
                shouldShowData = false;
            }
        }

        if (!shouldShowData) {
            return;
        }

        // SQLite 模式：输出 DDL + 注释数据格式；数据只来自运行时 DB，不再从模板 seedRows 兜底。
        if (sqlMode) {
            // 作者 DDL 名必须与提交阶段使用同一请求前模板快照解析；运行时数据可能仍保留旧模板显示名。
            tableDataText += formatTableForSqliteMode(table, tableIndex, sheetKey, _seedGuideDataForThisPrepare_ACU, {
                allowSeedRowsFallback: false,
                authoredTableName: authoredTableNames.get(sheetKey),
                runtimeTableName: resolveRuntimeTableNameForPrompt_ACU(promptIdentifierSource, sheetKey),
            });
            return;
        }

        const allRows = table.content.slice(1);
        const seedRows = sqlMode ? [] : getEffectiveSeedRowsForSheet_ACU(sheetKey, { guideData: _seedGuideDataForThisPrepare_ACU, allowTemplateFallback: true });
        try {
            if ((!Array.isArray(table.seedRows) || table.seedRows.length === 0) && Array.isArray(seedRows) && seedRows.length > 0) {
                table.seedRows = JSON.parse(JSON.stringify(seedRows));
            }
        } catch (e) {}
        const isUsingSeedRows = (allRows.length === 0 && seedRows.length > 0);
        if (isUsingSeedRows) {
            try { _seedRowsTablesUsed_ACU.push(String(table.name || sheetKey)); } catch (e) {}
        }
        const effectiveAllRows = (allRows.length > 0) ? allRows : (seedRows.length > 0 ? seedRows : []);
        const visibleColumns = getSheetColumnProjection_ACU(table).visibleColumns.filter(column => column.sourceIndex > 0);
        const visibleHeaders = visibleColumns.map(column => column.header);

        if (effectiveAllRows.length === 0) {
            tableDataText += `[${tableIndex}:${table.name}]\n`;
            // [修复] 列头编号使用 0 基索引，与原生 DSL insertRow/updateRow 的对象键语义一致。
            // 原先使用 i + 1 导致列头标注为 [1:列名],[2:列名]...，
            // 而默认提示词示例使用 {"0":"...","1":"..."} 的 0 基格式，
            // 模型会把列头编号 "1" 跟对象键 "1" 做映射，导致所有数据整体右移一列。
            const headers = visibleHeaders.length > 0 ? visibleHeaders.map((h: any, i: number) => `[${i}:${h}]`).join(', ') : 'No Headers';
            tableDataText += `  Columns: ${headers}\n`;

            if (table.sourceData) {
                tableDataText += `  - Note: ${table.sourceData.note || 'N/A'}\n`;
                const initNodeContent = table.sourceData.initNode || table.sourceData.insertNode || 'N/A';
                tableDataText += `  - Init Trigger: ${initNodeContent}\n`;
            }
            tableDataText += `  (该表格为空，请进行初始化。)\n\n`;
        } else {
            tableDataText += `[${tableIndex}:${table.name}]\n`;
            // [修复] 同上——列头编号 0 基，与原生 DSL 对象键语义对齐
            const headers = visibleHeaders.length > 0 ? visibleHeaders.map((h: any, i: number) => `[${i}:${h}]`).join(', ') : 'No Headers';
            tableDataText += `  Columns: ${headers}\n`;
            if (table.sourceData) {
                tableDataText += `  - Note: ${table.sourceData.note || 'N/A'}\n`;
                tableDataText += `  - Insert Trigger: ${table.sourceData.insertNode || table.sourceData.initNode || 'N/A'}\n`;
                tableDataText += `  - Update Trigger: ${table.sourceData.updateNode || 'N/A'}\n`;
                tableDataText += `  - Delete Trigger: ${table.sourceData.deleteNode || 'N/A'}\n`;
            }
            if (isUsingSeedRows) {
                tableDataText += `  - SeedRows: 已提供模板基础数据（尚未写入聊天楼层数据；本次填表可直接基于这些行更新）\n`;
            }

            let rowsToProcess = effectiveAllRows;
            let startIndex = 0;

            const isSummaryTable = (table.name.trim() === '纪要表' || table.name.trim() === '总结表');
            if (isSummaryTable && effectiveAllRows.length > 10) {
                startIndex = effectiveAllRows.length - 10;
                rowsToProcess = effectiveAllRows.slice(-10);
                tableDataText += `  - Note: Showing last ${rowsToProcess.length} of ${effectiveAllRows.length} entries (summary table fixed limit).\n`;
            } else if (!isSummaryTable) {
                const sendLatestRows = (table.updateConfig && typeof table.updateConfig.sendLatestRows === 'number')
                    ? table.updateConfig.sendLatestRows : -1;
                if (sendLatestRows > 0 && effectiveAllRows.length > sendLatestRows) {
                    startIndex = effectiveAllRows.length - sendLatestRows;
                    rowsToProcess = effectiveAllRows.slice(-sendLatestRows);
                    tableDataText += `  - Note: Showing last ${rowsToProcess.length} of ${effectiveAllRows.length} entries (sendLatestRows=${sendLatestRows}).\n`;
                }
            }

            if (rowsToProcess.length > 0) {
                rowsToProcess.forEach((row: any, index: number) => {
                    const originalRowIndex = startIndex + index;
                    const rowData = visibleColumns.map(column => Array.isArray(row) ? row[column.sourceIndex] : null).join(', ');
                    tableDataText += `  [${originalRowIndex}] ${rowData}\n`;
                });
            } else {
                tableDataText += '  (No data rows)\n';
            }
            tableDataText += '\n';
        }
    });
    if (_seedRowsTablesUsed_ACU.length > 0) {
        logDebug_ACU(`[SeedRows] $0 使用 seedRows 作为基础数据：${_seedRowsTablesUsed_ACU.join('、')}`);
    }
    
    let messagesText = '当前最新对话内容:\n';
    const conditionalSeedParts: string[] = [];
    if (messages && messages.length > 0) {
        const extractTags = (settings_ACU.tableContextExtractTags || '').trim();
        const extractRules = normalizeExtractRules_ACU(settings_ACU.tableContextExtractRules, extractTags);
        const excludeTags = (settings_ACU.tableContextExcludeTags || '').trim();
        const excludeRules = normalizeExcludeRules_ACU(settings_ACU.tableContextExcludeRules, excludeTags);

        messagesText += messages.map((msg: any) => {
            const prefix = msg.is_user ? getUserName_ACU() : msg.name || '角色';
            let content = msg.mes || msg.message || '';

            if (!msg.is_user && (extractTags || extractRules.length > 0 || excludeTags || excludeRules.length > 0)) {
                content = applyContextTagFilters_ACU(content, { extractTags, extractRules, excludeTags, excludeRules });
            }
            if (!msg.is_user && typeof content === 'string' && content) {
                conditionalSeedParts.push(content);
            }

            return `${prefix}: ${content}`;
        }).join('\n');
    } else {
        messagesText += '(无最新对话内容)';
    }
    const conditionalSeedContent = conditionalSeedParts.join('\n');

    const worldbookScanText = messagesText;
    const excludeImportTaggedWorldbookEntries = options?.excludeImportTaggedWorldbookEntries === true;
    let entryStateSnapshot;
    let entryStateSnapshotSignature = '';
    try {
        const resolvedSnapshot = await resolvePreTakeoverWorldbookSnapshot_ACU();
        entryStateSnapshot = resolvedSnapshot.snapshot;
        entryStateSnapshotSignature = resolvedSnapshot.expectedSignature;
    } catch (error) {
        logWarn_ACU('[Worldbook] 无法读取 Agent 世界书接管快照，填表世界书将使用 live 状态。', error);
    }
    const worldbookOptions = {
        excludeImportTaggedEntries: excludeImportTaggedWorldbookEntries,
        agentGreenlights: Array.isArray(options?.agentGreenlights) ? options.agentGreenlights : [],
        entryStateView: 'pre_takeover',
        entryStateSnapshot,
        entryStateSnapshotSignature,
    };
    const [worldbookContent, worldbookDatabaseExcludedContent] = await Promise.all([
        getCombinedWorldbookContent_ACU(worldbookScanText, worldbookOptions),
        getCombinedWorldbookContent_ACU(worldbookScanText, {
            ...worldbookOptions,
            excludeEntry: isDatabaseGeneratedLorebookEntry_ACU,
        }),
    ]);
    const resolveTableWorldbookContent = async (tableName: string): Promise<string | null> => {
        const normalizedTableName = String(tableName || '').trim();
        if (!normalizedTableName) return null;
        try {
            const worldbooks = await getWorldBooks_ACU();
            const entries = worldbooks.flatMap((worldbook: any) => (Array.isArray(worldbook?.entries) ? worldbook.entries : [])
                .map((entry: any) => ({ ...entry, bookName: String(worldbook?.name || '').trim() })));
            const scopedEntries = resolveGeneratedEntriesForTable_ACU(entries, normalizedTableName, workingTableData);
            if (scopedEntries.length === 0) return null;
            const scopedKeys = new Set(scopedEntries.map((entry: any) => `${String(entry.bookName || '').trim()}\u0000${String(entry.uid || '').trim()}`));
            const content = await getCombinedWorldbookContent_ACU(worldbookScanText, {
                ...worldbookOptions,
                includeGeneratedEntries: true,
                entryScope: (entry: any) => scopedKeys.has(`${String(entry.bookName || '').trim()}\u0000${String(entry.uid || '').trim()}`),
            });
            return `<worldbook_context>\n${content}\n</worldbook_context>`;
        } catch (error) {
            logWarn_ACU(`[Worldbook] 无法解析填表表名占位符 "${normalizedTableName}"，保留原 token。`, error);
            return null;
        }
    };
    const manualExtraHintText = manualExtraHint_ACU || '';

    // SQLite 模式下追加 SQL 编辑格式兜底说明（Q17 确认：$0 自带格式说明）
    if (isSqliteMode() && tableDataText) {
        if (settings_ACU.strictJsonTableFillEnabled === true) {
            tableDataText += `\n-- [SQL 编辑格式说明]\n-- 请在响应 JSON 的 sql 字符串中仅使用 INSERT INTO / INSERT OR REPLACE INTO / REPLACE INTO / UPDATE / DELETE FROM 数据变更语句\n-- SQL 表名和列名必须严格使用上方 CREATE TABLE 中的英文标识符；禁止使用中文名、sheet key、uid 或自行拼音化的内部表名\n-- 上方 CREATE TABLE 仅用于说明表结构，严禁复制或输出 CREATE、ALTER、DROP、SELECT、PRAGMA、VACUUM、BEGIN、COMMIT、ROLLBACK 等语句\n-- 所有 UPDATE 和 DELETE 必须带 WHERE 条件，优先参考各表 Note 中的 SQL 示例和 DDL 中的 UNIQUE 约束选择定位方式\n-- 普通 INSERT 必须显式列出业务列，不得包含 row_id；row_id 由系统在执行前分配稳定身份\n-- INSERT OR REPLACE / REPLACE INTO 按 SQLite 原生整行替换语义执行，应显式提供目标列及用于冲突定位的 row_id 或 UNIQUE 列\n-- 支持表达式更新（如 SET quantity = quantity + 1）、条件批量更新、CASE 条件更新标准 SQL 写法\n-- 每条语句以分号结尾，多条语句用换行分隔\n`;
        } else {
            tableDataText += `\n-- [SQL 编辑格式说明]\n-- 请在 <tableEdit> 标签内仅使用 INSERT INTO / INSERT OR REPLACE INTO / REPLACE INTO / UPDATE / DELETE FROM 数据变更语句\n-- SQL 表名和列名必须严格使用上方 CREATE TABLE 中的英文标识符；禁止使用中文名、sheet key、uid 或自行拼音化的内部表名\n-- 上方 CREATE TABLE 仅用于说明表结构，严禁复制或输出 CREATE、ALTER、DROP、SELECT、PRAGMA、VACUUM、BEGIN、COMMIT、ROLLBACK 等语句\n-- 所有 UPDATE 和 DELETE 必须带 WHERE 条件，优先参考各表 Note 中的 SQL 示例和 DDL 中的 UNIQUE 约束选择定位方式\n-- 普通 INSERT 必须显式列出业务列，不得包含 row_id；row_id 由系统在执行前分配稳定身份\n-- INSERT OR REPLACE / REPLACE INTO 按 SQLite 原生整行替换语义执行，应显式提供目标列及用于冲突定位的 row_id 或 UNIQUE 列\n-- 支持表达式更新（如 SET quantity = quantity + 1）、条件批量更新、CASE 条件更新等标准 SQL 写法\n-- 每条语句以分号结尾，多条语句用换行分隔\n`;
        }
    }

    return {
        tableDataText,
        messagesText,
        conditionalSeedContent,
        worldbookContent,
        worldbookDatabaseExcludedContent,
        resolveTableWorldbookContent,
        manualExtraHint: manualExtraHintText,
    };
}

/**
 * Resolves the user-authored DDL identifier that AI must use for mutations.
 * Runtime names are deliberately excluded from the prompt: they are an
 * implementation detail rebound at the write boundary.
 */
function resolveAuthoredTableNameForPrompt_ACU(data: any, sheetKey: string): string | undefined {
    const sheet = data?.[sheetKey];
    const tableName = parseDDLTableName(String(sheet?.sourceData?.ddl || ''));
    if (!tableName || !AUTHOR_SQL_TABLE_IDENTIFIER_ACU.test(tableName)) return undefined;

    const normalized = tableName.toLowerCase();
    for (const [candidateKey, candidate] of Object.entries(data || {})) {
        if (candidateKey === sheetKey || !candidateKey.startsWith('sheet_')) continue;
        const candidateName = parseDDLTableName(String((candidate as any)?.sourceData?.ddl || ''));
        if (candidateName && candidateName.toLowerCase() === normalized) {
            throw new Error(`模板中多个表共用作者 DDL 表名「${tableName}」，无法安全路由 AI SQL。`);
        }
    }
    return tableName;
}

function resolveRuntimeTableNameForPrompt_ACU(data: any, sheetKey: string): string | undefined {
    try {
        return getPhysicalTableNameForSheet_ACU(data, sheetKey);
    } catch (error: any) {
        logWarn_ACU(`[AI输入准备] 无法解析 runtime 物理表名: ${sheetKey}: ${error?.message || error}`);
        return undefined;
    }
}


/**
 * SQLite 模式下的表格格式化
 * 输出 DDL + Note/Trigger 注释 + 当前数据（注释格式）
 */
export function formatTableForSqliteMode(table: any, tableIndex: number, sheetKey: string, guideData: any, options: { allowSeedRowsFallback?: boolean; runtimeTableName?: string; authoredTableName?: string } = {}): string {
    let text = '';
    const projection = getSheetColumnProjection_ACU(table);
    const hasHiddenPhysicalColumns = projection.hiddenPhysicalColumns.length > 0;
    const visibleDDL = projectSheetDDLForVisibleColumns_ACU(table);
    const promptSchemaTable = hasHiddenPhysicalColumns
        ? {
            ...table,
            sourceData: { ...table.sourceData, ddl: visibleDDL, hiddenPhysicalColumns: [] },
            content: (Array.isArray(table.content) ? table.content : []).map((row: unknown[]) =>
                projectSheetRowToVisibleColumns_ACU(table, row)),
        }
        : table;
    const runtimeSchema = table?._acu_runtimeEffectiveSchema;
    // runtime effective schema controls columns; only its CREATE TABLE name is
    // replaced with the author-facing SQL contract shown to AI.
    const resolvedDDL = (!hasHiddenPhysicalColumns && runtimeSchema)
        || resolveEffectiveDDL(promptSchemaTable, table.uid || sheetKey, options.runtimeTableName);
    let ddl = hasHiddenPhysicalColumns
        ? resolvedDDL.effectiveDDL
        : projectSheetDDLForVisibleColumns_ACU(table, resolvedDDL.effectiveDDL);
    const promptTableName = options.authoredTableName || options.runtimeTableName;
    if (promptTableName) {
        ddl = rebindCreateTableName_ACU(ddl, promptTableName);
    }
    const visiblePhysicalNames = new Set(projection.visibleColumns.map(column => column.physicalName.toLowerCase()));
    const allowSeedRowsFallback = options.allowSeedRowsFallback !== false;

    // 输出 DDL
    text += ddl.trim() + '\n';
    if (resolvedDDL.source !== 'explicit') {
        text += `-- WARNING: ${resolvedDDL.diagnostics[0]} 原始 DDL 未被改写。\n`;
    }
    if (options.authoredTableName) {
        text += `-- SQL 写入必须使用表名 ${options.authoredTableName}；系统会在执行时映射到内部表。\n`;
    }

    // 输出 Note 和 Trigger（作为 SQL 注释）
    if (table.sourceData) {
        if (table.sourceData.note) text += `-- Note: ${table.sourceData.note.replace(/\n/g, '\n-- ')}\n`;
        if (table.sourceData.insertNode) text += `-- INSERT: ${table.sourceData.insertNode}\n`;
        if (table.sourceData.updateNode) text += `-- UPDATE: ${table.sourceData.updateNode}\n`;
        if (table.sourceData.deleteNode) text += `-- DELETE: ${table.sourceData.deleteNode}\n`;
    }

    // 获取有效数据行
    const allRows = table.content.slice(1);
    const seedRows = allowSeedRowsFallback ? getEffectiveSeedRowsForSheet_ACU(sheetKey, { guideData, allowTemplateFallback: true }) : [];
    const isUsingSeedRows = (allRows.length === 0 && seedRows.length > 0);
    const sourceRows = (allRows.length > 0) ? allRows : (seedRows.length > 0 ? seedRows : []);
    const effectiveAllRows = hasHiddenPhysicalColumns
        ? sourceRows.map((row: unknown[]) => projectSheetRowToVisibleColumns_ACU(table, row))
        : sourceRows;

    if (effectiveAllRows.length === 0) {
        if (table.sourceData?.initNode) {
            text += `-- INIT: ${table.sourceData.initNode.replace(/\n/g, '\n-- ')}\n`;
        }
        text += `-- (该表格为空，请进行初始化。)\n\n`;
        return text;
    }

    if (isUsingSeedRows) {
        text += `-- SeedRows: 已提供模板基础数据（尚未写入聊天楼层数据；本次填表可直接基于这些行更新）\n`;
    }

    const columnMappings: EffectiveDDLColumnMap_ACU['mappings'] = projection.hiddenPhysicalColumns.length === 0
        ? resolvedDDL.columnMap.mappings
        : resolvedDDL.columnMap.mappings.filter((mapping: EffectiveDDLColumnMap_ACU['mappings'][number]) => visiblePhysicalNames.has(mapping.sqlName.toLowerCase()));
    const headers = columnMappings.map(mapping => mapping.sqlName);
    const sendRowsSqlTemplate = typeof table.updateConfig?.sendRowsSqlTemplate === 'string'
        ? table.updateConfig.sendRowsSqlTemplate.trim()
        : '';

    if (sendRowsSqlTemplate && !hasHiddenPhysicalColumns) {
        const renderedRows = replaceDbSqlVariables(sendRowsSqlTemplate).trim();
        text += `\n-- 当前数据\n`;
        text += renderedRows
            ? `${renderedRows}\n`
            : '-- (No data rows)\n';
        text += '\n';
        return text;
    }
    if (sendRowsSqlTemplate) {
        logWarn_ACU(`[SQLite prompt] 已忽略表 ${table.name || sheetKey} 的 sendRowsSqlTemplate：隐藏 physical columns 时无法证明自定义 SQL 不会泄露隐藏数据。`);
    }

    // 行数限制逻辑（与原生模式一致）
    let rowsToProcess = effectiveAllRows;
    let startIndex = 0;
    const isSummaryTable = (table.name.trim() === '纪要表' || table.name.trim() === '总结表');
    if (isSummaryTable && effectiveAllRows.length > 10) {
        startIndex = effectiveAllRows.length - 10;
        rowsToProcess = effectiveAllRows.slice(-10);
        text += `-- Note: Showing last ${rowsToProcess.length} of ${effectiveAllRows.length} entries (summary table fixed limit).\n`;
    } else if (!isSummaryTable) {
        const sendLatestRows = (table.updateConfig && typeof table.updateConfig.sendLatestRows === 'number')
            ? table.updateConfig.sendLatestRows : -1;
        if (sendLatestRows > 0 && effectiveAllRows.length > sendLatestRows) {
            startIndex = effectiveAllRows.length - sendLatestRows;
            rowsToProcess = effectiveAllRows.slice(-sendLatestRows);
            text += `-- Note: Showing last ${rowsToProcess.length} of ${effectiveAllRows.length} entries (sendLatestRows=${sendLatestRows}).\n`;
        }
    }

    // 输出当前数据（注释格式的表格）
    // 优先使用 DDL 中的英文列名作为表头，避免 AI 看到中文列名后用中文属性名写 SQL
    text += `\n-- 当前数据 (${rowsToProcess.length} rows)\n`;
    text += `-- | ${headers.join(' | ')} |\n`;
    rowsToProcess.forEach((row: any) => {
        const orderedValues = columnMappings.map(mapping => Array.isArray(row) ? row[mapping.sourceIndex] : null);
        text += `-- | ${orderedValues.join(' | ')} |\n`;
    });
    text += '\n';

    return text;
}
