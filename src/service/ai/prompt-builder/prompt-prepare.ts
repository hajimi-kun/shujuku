/**
 * service/ai/prompt-builder/prompt-prepare.ts
 * AI 输入准备 — 格式化表格数据和对话内容为 AI 可读文本
 * 从 prompt-builder.ts 拆出（L14-L194）
 */
import { manualExtraHint_ACU } from '../../runtime/state-manager';
import { currentJsonTableData_ACU, settings_ACU } from '../../runtime/state-manager';
import { getUserName_ACU } from '../../../data/gateways/host-state-gateway';
import { attachSeedRowsToCurrentDataFromGuide_ACU, ensureChatSheetGuideSeeded_ACU, getEffectiveSeedRowsForSheet_ACU, getSortedSheetKeys_ACU } from '../../template/chat-scope';
import { getCombinedWorldbookContent_ACU, getWorldBooks_ACU } from '../../worldbook/pipeline';
import { isDatabaseGeneratedLorebookEntry_ACU, resolveGeneratedEntriesForTable_ACU } from '../../worldbook/worldbook-placeholder-classification';
import { resolvePreTakeoverWorldbookSnapshot_ACU } from '../../agent/agent-worldbook-takeover';
import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU, normalizeExcludeRules_ACU, normalizeExtractRules_ACU } from '../../../shared/utils';
import { applyContextTagFilters_ACU } from '../../runtime/helpers-remaining';
import { isSqliteMode } from '../../table/storage-mode';
import { ensureStorageProviderReady_ACU } from '../../table/table-storage-strategy';
import { parseDDLColumnNames } from '../../../shared/ddl-utils';
import { replaceDbSqlVariables } from '../../runtime/template-vars/sql-query-var';

  async function resolvePromptSourceTableData_ACU(options: any, sqlMode: boolean) {
    if (!sqlMode) {
        return options?.tableData || currentJsonTableData_ACU;
    }

    try {
        const provider = await ensureStorageProviderReady_ACU();
        if (provider.mode !== 'sqlite') {
            logError_ACU(`prepareAIInput_ACU: SQLite mode expected runtime DB provider, got ${provider.mode}.`);
            return null;
        }
        return provider.getCurrentData();
    } catch (e) {
        logError_ACU('prepareAIInput_ACU: 无法从 SQLite 运行时 DB 获取权威表格数据。', e);
        return null;
    }
  }

  export async function prepareAIInput_ACU(messages: any[], updateMode = 'standard', targetSheetKeys: string[] | null = null, options: any = {}) {
    const sqlMode = isSqliteMode();
    const sourceTableData = await resolvePromptSourceTableData_ACU(options, sqlMode);
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
    const tableIndexes = getSortedSheetKeys_ACU(workingTableData);
    tableIndexes.forEach((sheetKey, tableIndex) => {
        const table = workingTableData[sheetKey];
        if (!table || !table.name || !table.content) return;

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
        if (sqlMode && table.sourceData?.ddl) {
            tableDataText += formatTableForSqliteMode(table, tableIndex, sheetKey, _seedGuideDataForThisPrepare_ACU, { allowSeedRowsFallback: false });
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

        if (effectiveAllRows.length === 0) {
            tableDataText += `[${tableIndex}:${table.name}]\n`;
            // [修复] 列头编号使用 0 基索引，与原生 DSL insertRow/updateRow 的对象键语义一致。
            // 原先使用 i + 1 导致列头标注为 [1:列名],[2:列名]...，
            // 而默认提示词示例使用 {"0":"...","1":"..."} 的 0 基格式，
            // 模型会把列头编号 "1" 跟对象键 "1" 做映射，导致所有数据整体右移一列。
            const headers = table.content[0] ? table.content[0].slice(1).map((h: any, i: number) => `[${i}:${h}]`).join(', ') : 'No Headers';
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
            const headers = table.content[0] ? table.content[0].slice(1).map((h: any, i: number) => `[${i}:${h}]`).join(', ') : 'No Headers';
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
                    const rowData = row.slice(1).join(', ');
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

            return `${prefix}: ${content}`;
        }).join('\n');
    } else {
        messagesText += '(无最新对话内容)';
    }

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
            tableDataText += `\n-- [SQL 编辑格式说明]\n-- 请在响应 JSON 的 sql 字符串中使用标准 SQL 语句（INSERT INTO / UPDATE / DELETE FROM）\n-- 所有 UPDATE 和 DELETE 必须带 WHERE 条件，优先参考各表 Note 中的 SQL 示例和 DDL 中的 UNIQUE 约束选择定位方式\n-- INSERT 时 row_id 值为当前表最大 row_id + 1\n-- 支持表达式更新（如 SET quantity = quantity + 1）、条件批量更新、CASE 条件更新等标准 SQL 写法\n-- 每条语句以分号结尾，多条语句用换行分隔\n`;
        } else {
            tableDataText += `\n-- [SQL 编辑格式说明]\n-- 请在 <tableEdit> 标签内使用标准 SQL 语句（INSERT INTO / UPDATE / DELETE FROM）\n-- 所有 UPDATE 和 DELETE 必须带 WHERE 条件，优先参考各表 Note 中的 SQL 示例和 DDL 中的 UNIQUE 约束选择定位方式\n-- INSERT 时 row_id 值为当前表最大 row_id + 1\n-- 支持表达式更新（如 SET quantity = quantity + 1）、条件批量更新、CASE 条件更新等标准 SQL 写法\n-- 每条语句以分号结尾，多条语句用换行分隔\n`;
        }
    }

    return {
        tableDataText,
        messagesText,
        worldbookContent,
        worldbookDatabaseExcludedContent,
        resolveTableWorldbookContent,
        manualExtraHint: manualExtraHintText,
    };
}

/**
 * SQLite 模式下的表格格式化
 * 输出 DDL + Note/Trigger 注释 + 当前数据（注释格式）
 */
export function formatTableForSqliteMode(table: any, tableIndex: number, sheetKey: string, guideData: any, options: { allowSeedRowsFallback?: boolean } = {}): string {
    let text = '';
    const ddl = table.sourceData.ddl;
    const allowSeedRowsFallback = options.allowSeedRowsFallback !== false;

    // 输出 DDL
    text += ddl.trim() + '\n';

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
    const effectiveAllRows = (allRows.length > 0) ? allRows : (seedRows.length > 0 ? seedRows : []);

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

    const ddlColumnNames = parseDDLColumnNames(ddl);
    const headers = (ddlColumnNames.length > 0) ? ddlColumnNames : (table.content[0] || []);
    const sendRowsSqlTemplate = typeof table.updateConfig?.sendRowsSqlTemplate === 'string'
        ? table.updateConfig.sendRowsSqlTemplate.trim()
        : '';

    if (sendRowsSqlTemplate) {
        const renderedRows = replaceDbSqlVariables(sendRowsSqlTemplate).trim();
        text += `\n-- 当前数据\n`;
        text += renderedRows
            ? `${renderedRows}\n`
            : '-- (No data rows)\n';
        text += '\n';
        return text;
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
        text += `-- | ${row.join(' | ')} |\n`;
    });
    text += '\n';

    return text;
}
