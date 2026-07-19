import { callAIWithPreset_ACU } from '../ai/api-call';
import { settings_ACU } from '../runtime/state-manager';
import { getSortedSheetKeys_ACU } from '../template/chat-scope';
import { getGlobalInjectionConfigFromData_ACU } from '../worldbook/injection-engine';
import { safeJsonStringify_ACU } from '../../shared/json-helpers';
import { hashUserInput_ACU, logError_ACU } from '../../shared/utils';
import { buildTemplateAssistantCumulativeCompileResult_ACU, compileTemplateAssistantDraft_ACU, type TemplateAssistantCompileResult_ACU } from './compiler';
import { preflightSchemaMigrations_ACU, type SchemaMigrationPreflightIntent_ACU } from '../table/schema-migration-preflight';
import { buildTemplateAssistantEmbeddedReferenceText_ACU } from './reference-docs';

type AnyRecord = Record<string, any>;

const TEMPLATE_ASSISTANT_SOURCE_DATA_ALLOWED_KEYS_ACU = ['note', 'initNode', 'insertNode', 'updateNode', 'deleteNode'] as const;
const TEMPLATE_ASSISTANT_SOURCE_DATA_ALLOWED_KEY_SET_ACU = new Set<string>(TEMPLATE_ASSISTANT_SOURCE_DATA_ALLOWED_KEYS_ACU);

export interface TemplateAssistantAddSheetOperation_ACU {
    op: 'add_sheet';
    sheetName: string;
    headers: string[];
    insertAfterSheetKey?: string;
    sourceData?: Record<string, any>;
    updateConfig?: Record<string, any>;
    exportConfig?: Record<string, any>;
}

export interface TemplateAssistantRenameSheetOperation_ACU {
    op: 'rename_sheet';
    sheetKey: string;
    newName: string;
}

export interface TemplateAssistantDeleteSheetOperation_ACU {
    op: 'delete_sheet';
    sheetKey: string;
}

export interface TemplateAssistantMoveSheetOperation_ACU {
    op: 'move_sheet';
    sheetKey: string;
    beforeSheetKey?: string;
    afterSheetKey?: string;
}

export interface TemplateAssistantPatchSheetSourceDataPatch_ACU {
    note?: string;
    initNode?: string;
    insertNode?: string;
    updateNode?: string;
    deleteNode?: string;
}

export interface TemplateAssistantPatchSheetUpdateConfigPatch_ACU {
    contextDepth?: number;
    updateFrequency?: number;
    batchSize?: number;
    groupId?: number;
    skipFloors?: number;
    sendLatestRows?: number;
}

export interface TemplateAssistantContentUpdateCell_ACU {
    rowNumber: number;
    columnName: string;
    value: any;
}

export interface TemplateAssistantContentAddRow_ACU {
    [columnName: string]: any;
}

export interface TemplateAssistantPatchSheetContentPatch_ACU {
    updateCells?: TemplateAssistantContentUpdateCell_ACU[];
    addRows?: TemplateAssistantContentAddRow_ACU[];
    deleteRows?: number[];
}

export interface TemplateAssistantSchemaRenameColumn_ACU {
    from: string;
    to: string;
}

export interface TemplateAssistantSchemaAddColumn_ACU {
    name: string;
    defaultValue?: any;
}

export interface TemplateAssistantPatchSheetSchemaPatch_ACU {
    renameColumns?: TemplateAssistantSchemaRenameColumn_ACU[];
    addColumns?: TemplateAssistantSchemaAddColumn_ACU[];
    deleteColumns?: string[];
    ddl?: string;
    migrationIntent?: SchemaMigrationPreflightIntent_ACU;
}

export interface TemplateAssistantLockRowPatch_ACU {
    rowNumber: number;
    locked: boolean;
}

export interface TemplateAssistantLockColumnPatch_ACU {
    columnName: string;
    locked: boolean;
}

export interface TemplateAssistantLockCellPatch_ACU {
    rowNumber: number;
    columnName: string;
    locked: boolean;
}

export interface TemplateAssistantPatchSheetLocksPatch_ACU {
    rows?: TemplateAssistantLockRowPatch_ACU[];
    columns?: TemplateAssistantLockColumnPatch_ACU[];
    cells?: TemplateAssistantLockCellPatch_ACU[];
    specialIndexLocked?: boolean;
}

export interface TemplateAssistantPatchSheetSourceDataOperation_ACU {
    op: 'patch_sheet_source_data';
    sheetKey: string;
    patch: TemplateAssistantPatchSheetSourceDataPatch_ACU;
}

export interface TemplateAssistantPatchSheetUpdateConfigOperation_ACU {
    op: 'patch_sheet_update_config';
    sheetKey: string;
    patch: TemplateAssistantPatchSheetUpdateConfigPatch_ACU;
}

export interface TemplateAssistantPatchSheetExportConfigOperation_ACU {
    op: 'patch_sheet_export_config';
    sheetKey: string;
    patch: Record<string, any>;
}

export interface TemplateAssistantPatchSheetContentOperation_ACU {
    op: 'patch_sheet_content';
    sheetKey: string;
    patch: TemplateAssistantPatchSheetContentPatch_ACU;
}

export interface TemplateAssistantPatchSheetSchemaOperation_ACU {
    op: 'patch_sheet_schema';
    sheetKey: string;
    patch: TemplateAssistantPatchSheetSchemaPatch_ACU;
}

export interface TemplateAssistantPatchSheetLocksOperation_ACU {
    op: 'patch_sheet_locks';
    sheetKey: string;
    patch: TemplateAssistantPatchSheetLocksPatch_ACU;
}

export interface TemplateAssistantPatchGlobalInjectionConfigOperation_ACU {
    op: 'patch_global_injection_config';
    patch: Record<string, any>;
}

export type TemplateAssistantOperation_ACU =
    | TemplateAssistantAddSheetOperation_ACU
    | TemplateAssistantRenameSheetOperation_ACU
    | TemplateAssistantDeleteSheetOperation_ACU
    | TemplateAssistantMoveSheetOperation_ACU
    | TemplateAssistantPatchSheetSourceDataOperation_ACU
    | TemplateAssistantPatchSheetUpdateConfigOperation_ACU
    | TemplateAssistantPatchSheetExportConfigOperation_ACU
    | TemplateAssistantPatchSheetContentOperation_ACU
    | TemplateAssistantPatchSheetSchemaOperation_ACU
    | TemplateAssistantPatchSheetLocksOperation_ACU
    | TemplateAssistantPatchGlobalInjectionConfigOperation_ACU;

type TemplateAssistantBaseDraft_ACU = {
    protocolVersion: 1 | 2;
    mode: 'modify_current_template_incremental';
    baseFingerprint: string;
    selectedSheetKey: string;
    summary: string;
    warnings: string[];
    operations: TemplateAssistantOperation_ACU[];
};

export interface TemplateAssistantDraftV1_ACU extends TemplateAssistantBaseDraft_ACU {
    protocolVersion: 1;
}

export interface TemplateAssistantDraftV2_ACU extends TemplateAssistantBaseDraft_ACU {
    protocolVersion: 2;
    requestId: string;
    atomic: true;
}

export type TemplateAssistantDraft_ACU = TemplateAssistantDraftV1_ACU | TemplateAssistantDraftV2_ACU;

export interface TemplateAssistantPriorTurn_ACU {
    user: string;
    assistant?: string;
}

export interface TemplateAssistantGenerateInput_ACU {
    tempData: AnyRecord;
    currentSheetKey: string | null;
    sheetOrder?: string[] | null;
    userRequest: string;
    priorTurns?: TemplateAssistantPriorTurn_ACU[] | null;
    tableApiPreset?: string;
}

export interface TemplateAssistantGenerateResult_ACU {
    draft: TemplateAssistantDraft_ACU;
    aiRawText: string;
    messages: Array<{ role: string; content: string }>;
    compileResult: TemplateAssistantCompileResult_ACU;
    originalBaseFingerprint?: string;
    rounds?: TemplateAssistantSessionRound_ACU[];
    session?: TemplateAssistantSessionMeta_ACU;
}

export type TemplateAssistantSessionStopReason_ACU =
    | 'max_rounds'
    | 'empty_operations'
    | 'repeated_working_fingerprint'
    | 'repair_retry_capped';

export type TemplateAssistantSessionAbortReason_ACU = 'cancelled' | 'stale';

export interface TemplateAssistantSessionRound_ACU {
    round: number;
    userRequest: string;
    draft: TemplateAssistantDraft_ACU;
    aiRawText: string;
    messages: Array<{ role: string; content: string }>;
    perRoundCompileResult: TemplateAssistantCompileResult_ACU;
    workingFingerprint: string;
}

export interface TemplateAssistantSessionMeta_ACU {
    originalBaseFingerprint: string;
    finalWorkingFingerprint: string;
    stopReason: TemplateAssistantSessionStopReason_ACU;
    roundsExecuted: number;
    maxRounds: number;
    repairRetriesUsed: number;
    maxRepairRetries: number;
    lastErrorMessage: string;
}

export interface TemplateAssistantSessionResult_ACU extends TemplateAssistantGenerateResult_ACU {
    originalBaseFingerprint: string;
    rounds: TemplateAssistantSessionRound_ACU[];
    session: TemplateAssistantSessionMeta_ACU;
}

export interface TemplateAssistantSessionProgress_ACU {
    round: TemplateAssistantSessionRound_ACU;
    rounds: TemplateAssistantSessionRound_ACU[];
    maxRounds: number;
}

export interface TemplateAssistantSessionRunGuard_ACU {
    isCancelled?: () => boolean;
    isStale?: () => boolean;
}

export interface TemplateAssistantSessionGuardController_ACU {
    createRunGuard: () => TemplateAssistantSessionRunGuard_ACU;
    invalidate: () => void;
    cancel: () => void;
    reset: () => void;
}

export interface TemplateAssistantSessionRunInput_ACU extends TemplateAssistantGenerateInput_ACU {
    maxRounds?: number;
    maxRepairRetries?: number;
    onRoundComplete?: (progress: TemplateAssistantSessionProgress_ACU) => void;
    guard?: TemplateAssistantSessionRunGuard_ACU | null;
}

export class TemplateAssistantSessionStoppedError_ACU extends Error {
    stopReason: TemplateAssistantSessionAbortReason_ACU;

    constructor(stopReason: TemplateAssistantSessionAbortReason_ACU) {
        super(stopReason === 'cancelled' ? '模板助手会话已取消' : '模板助手会话已过期');
        this.name = 'TemplateAssistantSessionStoppedError_ACU';
        this.stopReason = stopReason;
    }
}

const DEFAULT_TEMPLATE_ASSISTANT_MAX_ROUNDS_ACU = 3;
const DEFAULT_TEMPLATE_ASSISTANT_MAX_REPAIR_RETRIES_ACU = 1;

function clone_ACU<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function normalizePositiveInteger_ACU(value: any, fallback: number) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) return fallback;
    const integer = Math.floor(normalized);
    return integer > 0 ? integer : fallback;
}

function normalizeNonNegativeInteger_ACU(value: any, fallback: number) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) return fallback;
    const integer = Math.floor(normalized);
    return integer >= 0 ? integer : fallback;
}

function asObject_ACU(value: any, fallback: AnyRecord = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function trimAssistantMessage_ACU(value: any) {
    return String(value ?? '').trim();
}

function normalizePriorTurns_ACU(priorTurns: TemplateAssistantPriorTurn_ACU[] | null | undefined) {
    if (!Array.isArray(priorTurns)) return [];
    return priorTurns
        .map((turn) => ({
            user: trimAssistantMessage_ACU(turn?.user),
            assistant: trimAssistantMessage_ACU(turn?.assistant),
        }))
        .filter((turn) => !!turn.user || !!turn.assistant);
}

function buildTemplateAssistantMessages_ACU(input: TemplateAssistantGenerateInput_ACU, baseFingerprint: string) {
    const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: buildSystemPrompt_ACU() },
    ];
    normalizePriorTurns_ACU(input.priorTurns).forEach((turn) => {
        if (turn.user) {
            messages.push({ role: 'user', content: turn.user });
        }
        if (turn.assistant) {
            messages.push({ role: 'assistant', content: turn.assistant });
        }
    });
    messages.push({ role: 'user', content: buildUserPrompt_ACU(input, baseFingerprint) });
    return messages;
}

function sanitizeSourceDataSnapshotForAssistant_ACU(value: any) {
    const sourceData = asObject_ACU(value);
    const sanitized: AnyRecord = {};
    TEMPLATE_ASSISTANT_SOURCE_DATA_ALLOWED_KEYS_ACU.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(sourceData, key)) {
            sanitized[key] = clone_ACU(sourceData[key]);
        }
    });
    return sanitized;
}

function validateSourceDataPayload_ACU(value: any, label: string) {
    if (value == null) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    Object.keys(value).forEach((key) => {
        if (TEMPLATE_ASSISTANT_SOURCE_DATA_ALLOWED_KEY_SET_ACU.has(key)) return;
        if (key === 'ddl') {
            throw new Error(`${label} 不能直接修改 ddl，请改用 patch_sheet_schema.ddl`);
        }
        throw new Error(`${label} 包含未知字段: ${key}`);
    });
}

function extractHeaders_ACU(sheet: any) {
    return Array.isArray(sheet?.content?.[0]) ? sheet.content[0].slice(1).map((item: any) => String(item ?? '')) : [];
}

function getSheetSnapshot_ACU(tempData: AnyRecord, sheetKey: string) {
    const sheet = tempData?.[sheetKey] || {};
    return {
        sheetKey,
        name: String(sheet?.name || ''),
        orderNo: Number.isFinite(sheet?.orderNo) ? sheet.orderNo : null,
        headers: extractHeaders_ACU(sheet),
        content: clone_ACU(Array.isArray(sheet?.content) ? sheet.content : []),
        sourceData: sanitizeSourceDataSnapshotForAssistant_ACU(sheet?.sourceData),
        updateConfig: clone_ACU(asObject_ACU(sheet?.updateConfig)),
        exportConfig: clone_ACU(asObject_ACU(sheet?.exportConfig)),
    };
}

function getSelectedSheetSnapshot_ACU(tempData: AnyRecord, sheetKey: string | null) {
    if (!sheetKey || !tempData?.[sheetKey]) return null;
    return getSheetSnapshot_ACU(tempData, sheetKey);
}

function buildSheetSummary_ACU(tempData: AnyRecord) {
    const sheetKeys = getSortedSheetKeys_ACU(tempData, { ignoreChatGuide: true });
    return sheetKeys.map((sheetKey) => {
        const sheet = tempData[sheetKey] || {};
        return {
            sheetKey,
            name: String(sheet.name || ''),
            orderNo: Number.isFinite(sheet.orderNo) ? sheet.orderNo : null,
            headers: extractHeaders_ACU(sheet),
            rowCount: Math.max(0, (Array.isArray(sheet?.content) ? sheet.content.length : 0) - 1),
        };
    });
}

function buildDetailedSheetSnapshots_ACU(tempData: AnyRecord) {
    return buildSheetSummary_ACU(tempData).map((item) => getSheetSnapshot_ACU(tempData, item.sheetKey));
}

export function buildTemplateAssistantFingerprint_ACU(tempData: AnyRecord) {
    const normalized = asObject_ACU(tempData);
    const sheetKeys = getSortedSheetKeys_ACU(normalized, { ignoreChatGuide: true });
    const snapshot = {
        globalInjectionConfig: getGlobalInjectionConfigFromData_ACU(normalized, { ensureWriteBack: false }),
        sheets: sheetKeys.map((sheetKey) => {
            const sheet = normalized[sheetKey] || {};
            return {
                sheetKey,
                uid: sheet.uid ?? '',
                name: sheet.name ?? '',
                orderNo: sheet.orderNo ?? null,
                content: Array.isArray(sheet?.content) ? sheet.content : [],
                sourceData: asObject_ACU(sheet.sourceData),
                updateConfig: asObject_ACU(sheet.updateConfig),
                exportConfig: asObject_ACU(sheet.exportConfig),
            };
        }),
    };
    return `acu-struct:${hashUserInput_ACU(safeJsonStringify_ACU(snapshot, '{}'))}`;
}

function getLastTaggedDraftText_ACU(aiText: string) {
    const tagPattern = /<templateAssistantDraft>([\s\S]*?)<\/templateAssistantDraft>/g;
    const matches = Array.from(String(aiText || '').matchAll(tagPattern));
    if (!matches.length) {
        throw new Error('AI 响应中未找到 <templateAssistantDraft> 标签');
    }
    return String(matches[matches.length - 1][1] || '').trim();
}

export function parseTemplateAssistantDraft_ACU(aiText: string): TemplateAssistantDraft_ACU {
    const jsonText = getLastTaggedDraftText_ACU(aiText);
    let parsed: any = null;
    try {
        parsed = JSON.parse(jsonText);
    } catch (error: any) {
        throw new Error(`assistant draft JSON 解析失败: ${error?.message || '未知错误'}`);
    }
    return validateTemplateAssistantDraft_ACU(parsed);
}

function validatePatchSheetBoundary_ACU(op: any, selectedSheetKey: string, currentSheetKey: string | null, protocolVersion: 1 | 2) {
    if (protocolVersion !== 1) return;
    if (op.sheetKey !== selectedSheetKey) {
        throw new Error(`${op.op} 的 sheetKey 必须与 draft.selectedSheetKey 一致`);
    }
    if (currentSheetKey && op.sheetKey !== currentSheetKey) {
        throw new Error(`${op.op} 只能修改当前选中表`);
    }
}

function validateTemplateAssistantContentPatch_ACU(op: any) {
    const patch = op?.patch;
    const allowedKeys = new Set(['updateCells', 'addRows', 'deleteRows']);
    Object.keys(patch).forEach((key) => {
        if (!allowedKeys.has(key)) {
            throw new Error(`patch_sheet_content.patch 包含未知字段: ${key}`);
        }
    });

    const updateCells = patch?.updateCells;
    const addRows = patch?.addRows;
    const deleteRows = patch?.deleteRows;
    const hasAnyOperation =
        (Array.isArray(updateCells) && updateCells.length > 0)
        || (Array.isArray(addRows) && addRows.length > 0)
        || (Array.isArray(deleteRows) && deleteRows.length > 0);
    if (!hasAnyOperation) {
        throw new Error('patch_sheet_content 至少需要 updateCells、addRows、deleteRows 之一');
    }

    if (updateCells != null) {
        if (!Array.isArray(updateCells)) {
            throw new Error('patch_sheet_content.patch.updateCells 必须是数组');
        }
        updateCells.forEach((item: any, index: number) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new Error(`patch_sheet_content.patch.updateCells[${index}] 必须是对象`);
            }
            if (!Number.isInteger(item.rowNumber) || item.rowNumber <= 0) {
                throw new Error(`patch_sheet_content.patch.updateCells[${index}].rowNumber 必须是正整数`);
            }
            if (typeof item.columnName !== 'string' || !item.columnName.trim()) {
                throw new Error(`patch_sheet_content.patch.updateCells[${index}].columnName 必须是非空字符串`);
            }
            if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
                throw new Error(`patch_sheet_content.patch.updateCells[${index}].value 缺失`);
            }
        });
    }

    if (addRows != null) {
        if (!Array.isArray(addRows)) {
            throw new Error('patch_sheet_content.patch.addRows 必须是数组');
        }
        addRows.forEach((item: any, index: number) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new Error(`patch_sheet_content.patch.addRows[${index}] 必须是对象`);
            }
        });
    }

    if (deleteRows != null) {
        if (!Array.isArray(deleteRows)) {
            throw new Error('patch_sheet_content.patch.deleteRows 必须是数组');
        }
        deleteRows.forEach((rowNumber: any, index: number) => {
            if (!Number.isInteger(rowNumber) || rowNumber <= 0) {
                throw new Error(`patch_sheet_content.patch.deleteRows[${index}] 必须是正整数`);
            }
        });
    }
}

function assertTemplateAssistantPlainObject_ACU(value: unknown, path: string): asserts value is Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`${path} 必须是普通对象`);
    }
}

function assertTemplateAssistantAllowedKeys_ACU(value: Record<string, any>, allowedKeys: string[], path: string) {
    const allowedKeySet = new Set(allowedKeys);
    Object.keys(value).forEach((key) => {
        if (!allowedKeySet.has(key)) {
            throw new Error(`${path} 包含未知字段: ${key}`);
        }
    });
}

function assertTemplateAssistantNonEmptyString_ACU(value: unknown, path: string) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${path} 必须是非空字符串`);
    }
}

function validateTemplateAssistantMigrationLiteral_ACU(value: unknown, path: string) {
    assertTemplateAssistantPlainObject_ACU(value, path);
    assertTemplateAssistantAllowedKeys_ACU(value, ['kind', 'sql', 'value'], path);
    const kind = value.kind;
    if (!['null', 'integer', 'real', 'string', 'blob', 'boolean'].includes(kind)) {
        throw new Error(`${path}.kind 不受支持: ${String(kind)}`);
    }
    if (kind === 'null') {
        if (value.sql !== 'NULL' || value.value !== null) {
            throw new Error(`${path} 的 null literal 必须使用 sql="NULL" 且 value=null`);
        }
        return;
    }
    if (kind === 'boolean') {
        if ((value.sql !== 'TRUE' && value.sql !== 'FALSE') || typeof value.value !== 'boolean') {
            throw new Error(`${path} 的 boolean literal 必须使用 TRUE/FALSE SQL 和 boolean value`);
        }
        return;
    }
    if (typeof value.sql !== 'string' || !value.sql.trim()) {
        throw new Error(`${path}.sql 必须是非空字符串`);
    }
    if ((kind === 'integer' || kind === 'real') && (typeof value.value !== 'number' || !Number.isFinite(value.value))) {
        throw new Error(`${path}.${kind} literal 的 value 必须是有限数字`);
    }
    if ((kind === 'string' || kind === 'blob') && typeof value.value !== 'string') {
        throw new Error(`${path}.${kind} literal 的 value 必须是字符串`);
    }
}

function validateTemplateAssistantMigrationIntent_ACU(value: unknown, path: string) {
    assertTemplateAssistantPlainObject_ACU(value, path);
    assertTemplateAssistantAllowedKeys_ACU(value, ['physicalColumnMappings', 'fills', 'conversions', 'migrationPolicy'], path);
    if (!Array.isArray(value.physicalColumnMappings)) {
        throw new Error(`${path}.physicalColumnMappings 必须是数组`);
    }
    value.physicalColumnMappings.forEach((mapping: unknown, index: number) => {
        const mappingPath = `${path}.physicalColumnMappings[${index}]`;
        assertTemplateAssistantPlainObject_ACU(mapping, mappingPath);
        assertTemplateAssistantAllowedKeys_ACU(mapping, ['fromPhysicalName', 'toPhysicalName'], mappingPath);
        assertTemplateAssistantNonEmptyString_ACU(mapping.fromPhysicalName, `${mappingPath}.fromPhysicalName`);
        assertTemplateAssistantNonEmptyString_ACU(mapping.toPhysicalName, `${mappingPath}.toPhysicalName`);
    });
    assertTemplateAssistantPlainObject_ACU(value.fills, `${path}.fills`);
    Object.entries(value.fills).forEach(([physicalName, fill]) => {
        const fillPath = `${path}.fills.${physicalName}`;
        assertTemplateAssistantNonEmptyString_ACU(physicalName, `${path}.fills 的 physical column key`);
        assertTemplateAssistantPlainObject_ACU(fill, fillPath);
        assertTemplateAssistantAllowedKeys_ACU(fill, ['kind', 'literal'], fillPath);
        if (fill.kind !== 'literal' && fill.kind !== 'ddl_literal_default') {
            throw new Error(`${fillPath}.kind 不受支持: ${String(fill.kind)}`);
        }
        validateTemplateAssistantMigrationLiteral_ACU(fill.literal, `${fillPath}.literal`);
    });
    if (!Array.isArray(value.conversions)) {
        throw new Error(`${path}.conversions 必须是数组`);
    }
    value.conversions.forEach((conversion: unknown, index: number) => {
        const conversionPath = `${path}.conversions[${index}]`;
        assertTemplateAssistantPlainObject_ACU(conversion, conversionPath);
        assertTemplateAssistantAllowedKeys_ACU(conversion, ['fromPhysicalName', 'toPhysicalName', 'policy'], conversionPath);
        assertTemplateAssistantNonEmptyString_ACU(conversion.fromPhysicalName, `${conversionPath}.fromPhysicalName`);
        assertTemplateAssistantNonEmptyString_ACU(conversion.toPhysicalName, `${conversionPath}.toPhysicalName`);
        assertTemplateAssistantPlainObject_ACU(conversion.policy, `${conversionPath}.policy`);
        assertTemplateAssistantAllowedKeys_ACU(conversion.policy, ['kind'], `${conversionPath}.policy`);
        if (!['identity', 'stringify', 'integer_strict', 'real_strict'].includes(conversion.policy.kind)) {
            throw new Error(`${conversionPath}.policy.kind 不受支持: ${String(conversion.policy.kind)}`);
        }
    });
    assertTemplateAssistantPlainObject_ACU(value.migrationPolicy, `${path}.migrationPolicy`);
    assertTemplateAssistantAllowedKeys_ACU(value.migrationPolicy, ['destructiveChangeConfirmed', 'lossyConversionConfirmed'], `${path}.migrationPolicy`);
    if (typeof value.migrationPolicy.destructiveChangeConfirmed !== 'boolean' || typeof value.migrationPolicy.lossyConversionConfirmed !== 'boolean') {
        throw new Error(`${path}.migrationPolicy 必须提供 destructiveChangeConfirmed 和 lossyConversionConfirmed 两个 boolean`);
    }
}

function validateTemplateAssistantSchemaPatch_ACU(op: any) {
    const patch = op?.patch;
    const allowedKeys = new Set(['renameColumns', 'addColumns', 'deleteColumns', 'ddl', 'migrationIntent']);
    Object.keys(patch).forEach((key) => {
        if (!allowedKeys.has(key)) {
            throw new Error(`patch_sheet_schema.patch 包含未知字段: ${key}`);
        }
    });

    const renameColumns = patch?.renameColumns;
    const addColumns = patch?.addColumns;
    const deleteColumns = patch?.deleteColumns;
    const ddl = patch?.ddl;
    const hasAnyOperation =
        (Array.isArray(renameColumns) && renameColumns.length > 0)
        || (Array.isArray(addColumns) && addColumns.length > 0)
        || (Array.isArray(deleteColumns) && deleteColumns.length > 0)
        || (typeof ddl === 'string' && !!ddl.trim());
    if (!hasAnyOperation) {
        throw new Error('patch_sheet_schema 至少需要 renameColumns、addColumns、deleteColumns、ddl 之一');
    }

    if (renameColumns != null) {
        if (!Array.isArray(renameColumns)) {
            throw new Error('patch_sheet_schema.patch.renameColumns 必须是数组');
        }
        renameColumns.forEach((item: any, index: number) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new Error(`patch_sheet_schema.patch.renameColumns[${index}] 必须是对象`);
            }
            if (typeof item.from !== 'string' || !item.from.trim()) {
                throw new Error(`patch_sheet_schema.patch.renameColumns[${index}].from 必须是非空字符串`);
            }
            if (typeof item.to !== 'string' || !item.to.trim()) {
                throw new Error(`patch_sheet_schema.patch.renameColumns[${index}].to 必须是非空字符串`);
            }
        });
    }

    if (addColumns != null) {
        if (!Array.isArray(addColumns)) {
            throw new Error('patch_sheet_schema.patch.addColumns 必须是数组');
        }
        addColumns.forEach((item: any, index: number) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new Error(`patch_sheet_schema.patch.addColumns[${index}] 必须是对象`);
            }
            if (typeof item.name !== 'string' || !item.name.trim()) {
                throw new Error(`patch_sheet_schema.patch.addColumns[${index}].name 必须是非空字符串`);
            }
        });
    }

    if (deleteColumns != null) {
        if (!Array.isArray(deleteColumns)) {
            throw new Error('patch_sheet_schema.patch.deleteColumns 必须是数组');
        }
        deleteColumns.forEach((item: any, index: number) => {
            if (typeof item !== 'string' || !item.trim()) {
                throw new Error(`patch_sheet_schema.patch.deleteColumns[${index}] 必须是非空字符串`);
            }
        });
    }

    if (ddl != null && (typeof ddl !== 'string' || !ddl.trim())) {
        throw new Error('patch_sheet_schema.patch.ddl 必须是非空字符串');
    }
    if (patch?.migrationIntent != null) {
        validateTemplateAssistantMigrationIntent_ACU(patch.migrationIntent, 'patch_sheet_schema.patch.migrationIntent');
    }
}

function validateTemplateAssistantLockPatch_ACU(op: any) {
    const patch = op?.patch;
    const allowedKeys = new Set(['rows', 'columns', 'cells', 'specialIndexLocked']);
    Object.keys(patch).forEach((key) => {
        if (!allowedKeys.has(key)) {
            throw new Error(`patch_sheet_locks.patch 包含未知字段: ${key}`);
        }
    });

    const rows = patch?.rows;
    const columns = patch?.columns;
    const cells = patch?.cells;
    const hasAnyOperation =
        (Array.isArray(rows) && rows.length > 0)
        || (Array.isArray(columns) && columns.length > 0)
        || (Array.isArray(cells) && cells.length > 0)
        || typeof patch?.specialIndexLocked === 'boolean';
    if (!hasAnyOperation) {
        throw new Error('patch_sheet_locks 至少需要 rows、columns、cells、specialIndexLocked 之一');
    }

    if (rows != null) {
        if (!Array.isArray(rows)) {
            throw new Error('patch_sheet_locks.patch.rows 必须是数组');
        }
        rows.forEach((item: any, index: number) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new Error(`patch_sheet_locks.patch.rows[${index}] 必须是对象`);
            }
            if (!Number.isInteger(item.rowNumber) || item.rowNumber <= 0) {
                throw new Error(`patch_sheet_locks.patch.rows[${index}].rowNumber 必须是正整数`);
            }
            if (typeof item.locked !== 'boolean') {
                throw new Error(`patch_sheet_locks.patch.rows[${index}].locked 必须是布尔值`);
            }
        });
    }

    if (columns != null) {
        if (!Array.isArray(columns)) {
            throw new Error('patch_sheet_locks.patch.columns 必须是数组');
        }
        columns.forEach((item: any, index: number) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new Error(`patch_sheet_locks.patch.columns[${index}] 必须是对象`);
            }
            if (typeof item.columnName !== 'string' || !item.columnName.trim()) {
                throw new Error(`patch_sheet_locks.patch.columns[${index}].columnName 必须是非空字符串`);
            }
            if (typeof item.locked !== 'boolean') {
                throw new Error(`patch_sheet_locks.patch.columns[${index}].locked 必须是布尔值`);
            }
        });
    }

    if (cells != null) {
        if (!Array.isArray(cells)) {
            throw new Error('patch_sheet_locks.patch.cells 必须是数组');
        }
        cells.forEach((item: any, index: number) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new Error(`patch_sheet_locks.patch.cells[${index}] 必须是对象`);
            }
            if (!Number.isInteger(item.rowNumber) || item.rowNumber <= 0) {
                throw new Error(`patch_sheet_locks.patch.cells[${index}].rowNumber 必须是正整数`);
            }
            if (typeof item.columnName !== 'string' || !item.columnName.trim()) {
                throw new Error(`patch_sheet_locks.patch.cells[${index}].columnName 必须是非空字符串`);
            }
            if (typeof item.locked !== 'boolean') {
                throw new Error(`patch_sheet_locks.patch.cells[${index}].locked 必须是布尔值`);
            }
        });
    }

    if (patch?.specialIndexLocked != null && typeof patch.specialIndexLocked !== 'boolean') {
        throw new Error('patch_sheet_locks.patch.specialIndexLocked 必须是布尔值');
    }
}

export function validateTemplateAssistantDraft_ACU(draft: any): TemplateAssistantDraft_ACU {
    if (!draft || typeof draft !== 'object') {
        throw new Error('assistant draft 必须是对象');
    }
    if (draft.protocolVersion !== 1 && draft.protocolVersion !== 2) {
        throw new Error('assistant draft.protocolVersion 必须为 1 或 2');
    }
    if (draft.mode !== 'modify_current_template_incremental') {
        throw new Error('assistant draft.mode 非法');
    }
    if (typeof draft.baseFingerprint !== 'string' || !draft.baseFingerprint.trim()) {
        throw new Error('assistant draft.baseFingerprint 缺失');
    }
    if (typeof draft.selectedSheetKey !== 'string' || !draft.selectedSheetKey.trim()) {
        throw new Error('assistant draft.selectedSheetKey 必须是非空字符串');
    }
    if (typeof draft.summary !== 'string') {
        throw new Error('assistant draft.summary 必须是字符串');
    }
    if (!Array.isArray(draft.warnings)) {
        throw new Error('assistant draft.warnings 必须是数组');
    }
    if (!Array.isArray(draft.operations)) {
        throw new Error('assistant draft.operations 必须是数组');
    }

    const protocolVersion = draft.protocolVersion as 1 | 2;
    if (protocolVersion === 2) {
        if (typeof draft.requestId !== 'string' || !draft.requestId.trim()) {
            throw new Error('assistant draft.requestId 必须是非空字符串');
        }
        if (draft.atomic !== true) {
            throw new Error('assistant draft.atomic 目前必须为 true');
        }
    }

    draft.operations.forEach((op: any, index: number) => {
        if (!op || typeof op !== 'object') {
            throw new Error(`operations[${index}] 必须是对象`);
        }
        const opName = String(op.op || '');
        const allowedOps = new Set([
            'add_sheet',
            'rename_sheet',
            'delete_sheet',
            'move_sheet',
            'patch_sheet_source_data',
            'patch_sheet_update_config',
            'patch_sheet_export_config',
            'patch_global_injection_config',
            ...(protocolVersion === 2 ? ['patch_sheet_content', 'patch_sheet_schema', 'patch_sheet_locks'] : []),
        ]);
        if (!allowedOps.has(opName)) {
            throw new Error(`operations[${index}] 包含当前协议不支持的操作: ${opName}`);
        }
        if (opName === 'replace_sheet_schema') {
            throw new Error('当前协议禁止 replace_sheet_schema');
        }
        if (opName.startsWith('patch_sheet_')) {
            if (typeof op.sheetKey !== 'string' || !op.sheetKey) {
                throw new Error(`${opName} 缺少 sheetKey`);
            }
            if (!op.patch || typeof op.patch !== 'object' || Array.isArray(op.patch)) {
                throw new Error(`${opName} 缺少合法 patch 对象`);
            }
        }
        if (opName === 'add_sheet') {
            validateSourceDataPayload_ACU(op.sourceData, 'add_sheet.sourceData');
        }
        if (opName === 'patch_sheet_source_data') {
            validateSourceDataPayload_ACU(op.patch, 'patch_sheet_source_data.patch');
        }
        if (opName === 'patch_sheet_content') {
            validateTemplateAssistantContentPatch_ACU(op);
        }
        if (opName === 'patch_sheet_schema') {
            validateTemplateAssistantSchemaPatch_ACU(op);
        }
        if (opName === 'patch_sheet_locks') {
            validateTemplateAssistantLockPatch_ACU(op);
        }
    });

    const normalizedBase = {
        protocolVersion,
        mode: 'modify_current_template_incremental' as const,
        baseFingerprint: draft.baseFingerprint,
        selectedSheetKey: String(draft.selectedSheetKey || ''),
        summary: String(draft.summary || ''),
        warnings: draft.warnings.map((item: any) => String(item ?? '')),
        operations: draft.operations.map((item: any) => clone_ACU(item)),
    };

    if (protocolVersion === 2) {
        return {
            ...normalizedBase,
            protocolVersion: 2,
            requestId: String(draft.requestId || ''),
            atomic: true,
        };
    }

    return {
        ...normalizedBase,
        protocolVersion: 1,
    };
}

function buildSystemPrompt_ACU() {
    const embeddedReferenceText = buildTemplateAssistantEmbeddedReferenceText_ACU();
    return [
        '你是 visualizer 内的模板改表助手。',
        '你只能输出一个被 <templateAssistantDraft> 和 </templateAssistantDraft> 包裹的 JSON 对象，不能输出解释文本。',
        '严格使用 protocolVersion=2、mode="modify_current_template_incremental"、atomic=true。',
        '下面会附带两份本地语法文档的原文分块嵌入内容；这些内容不是摘要，而是从 `syntax-reference (1).md` 和 `SQL模板语法从0开始上手教程.txt` 摘取的原文片段。凡是涉及提示词模板、条件表达式、SQLite 查询、变量、内置表、执行顺序、常见踩坑时，优先以这些原文片段为准。',
        '如果需求信息不足、字段缺失、或当前协议无法安全表达，仍然必须返回合法 draft：summary 简述原因、warnings 写明原因、operations 输出空数组；不要输出追问文本，不要输出非法操作。',
        '严格只允许以下操作：add_sheet、rename_sheet、delete_sheet、move_sheet、patch_sheet_source_data、patch_sheet_update_config、patch_sheet_export_config、patch_sheet_content、patch_sheet_schema、patch_sheet_locks、patch_global_injection_config。',
        '每个 operations[i] 必须使用 op 字段表示操作名；禁止使用 type、operation、action 等别名。',
        '严格禁止任何直接保存行为。',
        'add_sheet 必须同时提供非空 sheetName 和至少一个 headers 项；并且应尽量同时提供 sourceData.note、sourceData.initNode、sourceData.insertNode、sourceData.updateNode、sourceData.deleteNode；sheetName 缺失时不要猜名字，直接返回空 operations。',
        'add_sheet.sourceData 与 patch_sheet_source_data.patch 只允许 note、initNode、insertNode、updateNode、deleteNode 五个字段；禁止出现 ddl、sql、schema、createTable 等字段。',
        '新建表时，不要只给空壳。sourceData.note 要写清这张表记录什么、一行代表什么、是单行表还是多行表、各列含义、哪列可以作为稳定标识。sourceData.initNode/insertNode/updateNode/deleteNode 要写清何时初始化、何时新增、何时更新、何时删除。',
        '当用户只表达“新增某某表”但没有给出表头时，可以根据表名语义生成一组最小、合理、通用、可直接用于后续剧情更新的 headers；自定义表头尽量避免使用带 / 的列名；不要伪造数据行。',
        '物品/战利品/库存类表，优先考虑“物品名称、数量、描述/效果、类别、备注、来源/掉落来源”等能直接支撑后续更新的列；其中应至少包含一个稳定标识列。',
        '默认优先 add_sheet + 完整 sourceData，让新表立刻具备初始化/新增/更新/删除指引；除非用户明确要求 DDL、字段类型、约束或 SQLite 建表语句，否则不要主动输出 patch_sheet_schema.ddl。',
        '即使用户要求“顺便写 SQL/DDL”，也不要把 ddl 或 sql 塞进 add_sheet.sourceData；新建表时优先输出 headers + 合法的五段 sourceData。',
        '如果当前 headers 主要是中文，自定义 ddl 只有在你能提供英文/ASCII 物理列名，并用 `-- 中文表头` 注释按原顺序一一对应时才安全；除非用户明确要求并且已经给出可直接落地的列名方案，否则不要生成 ddl。',
        '示例 add_sheet：{"op":"add_sheet","sheetName":"角色关系表","headers":["角色A","角色B","关系","备注"]}。',
        '示例（库存/战利品类）add_sheet：{"op":"add_sheet","sheetName":"战利品表","headers":["物品名称","数量","描述/效果","类别"],"sourceData":{"note":"记录战利品条目，一行代表一种物品。","initNode":"当剧情或设定已经明确存在初始战利品时初始化。","insertNode":"出现新的战利品时新增。","updateNode":"已有战利品数量或状态变化时更新。","deleteNode":"战利品被清空、移除或失效时删除。"}}。',
        'patch_sheet_source_data 不能修改 ddl；DDL 只能通过 patch_sheet_schema.patch.ddl 修改。',
        '当前协议校验会逐列对比 patch_sheet_schema.patch.ddl 与当前 headers：ASCII/英文 headers 必须由同名物理列匹配；中文 headers 必须使用英文/ASCII 物理列名，并用 `-- 中文表头` 注释匹配。第一列必须是 row_id INTEGER PRIMARY KEY。',
        '正确示例（中文 headers）：CREATE TABLE loot_table ( -- 战利品表\n  row_id INTEGER PRIMARY KEY, -- 行号\n  item_name TEXT, -- 物品名称\n  quantity INTEGER, -- 数量\n  time_span TEXT NOT NULL, -- 时间跨度\n  remarks TEXT -- 备注\n);',
        '即使是 row_id INTEGER PRIMARY KEY 这一行，也必须保留 `-- 行号` 注释，不能省略。',
        '错误示例：CREATE TABLE loot_table (\n  row_id INTEGER PRIMARY KEY,\n  物品名称 TEXT,\n  数量 INTEGER\n); 这种把中文表头直接写成物理列名的 ddl 会被拒绝；即使再写 `-- 物品名称` 这类同名注释也不合法。',
        '不要为刚 add_sheet 的新表生成依赖真实 sheetKey 的 follow-up patch 来补 DDL 或 starter rows；当前同一份 draft 无法可靠引用尚未落地的新表。',
        'patch_sheet_content.patch 只允许使用 updateCells、addRows、deleteRows；其中 rowNumber 必须使用 1-based 行号，列使用 columnName。',
        'patch_sheet_schema.patch 只允许使用 renameColumns、addColumns、deleteColumns、ddl、migrationIntent；migrationIntent 仅用于明确声明无法由 V1 安全子集表达的 schema migration 契约，不能替代实际 schema 修改。',
        'migrationIntent 必须完整提供 physicalColumnMappings（每项 {fromPhysicalName,toPhysicalName}）、fills、conversions、migrationPolicy（{destructiveChangeConfirmed,lossyConversionConfirmed}）。physical rename 示例：{"physicalColumnMappings":[{"fromPhysicalName":"name","toPhysicalName":"item_name"}],"fills":{},"conversions":[],"migrationPolicy":{"destructiveChangeConfirmed":false,"lossyConversionConfirmed":false}}。新增 physical 列时 fills 必须覆盖每个新增列，格式为 {"列名":{"kind":"literal","literal":{"kind":"string","sql":"\'normal\'","value":"normal"}}} 或与目标 DDL DEFAULT 对应的 ddl_literal_default；类型变更时 conversions 必须使用 identity、stringify、integer_strict 或 real_strict。',
        'patch_sheet_locks.patch 只允许使用 rows、columns、cells、specialIndexLocked；rows/cells 使用 1-based rowNumber，列使用 columnName，所有锁变更都必须显式给出 locked 布尔值。',
        'move_sheet 只能提供 beforeSheetKey 或 afterSheetKey 之一。',
        'add_sheet 不要生成最终 sheetKey，本地会自动生成。',
        'patch 对象只能填写当前结构里真实存在的字段、表头和表格，不要猜测未知字段。',
        '顶层 JSON 必须包含 protocolVersion、mode、requestId、baseFingerprint、atomic、selectedSheetKey、summary、warnings、operations。',
        'warnings 必须是字符串数组；没有则输出空数组。',
        '如果无法生成合法操作，请保持 warnings 为字符串数组，并让 operations=[]，不要输出协议外字段。',
        embeddedReferenceText,
    ].join('\n');
}

function buildUserPrompt_ACU(input: TemplateAssistantGenerateInput_ACU, baseFingerprint: string) {
    const tempData = input.tempData;
    const payload = {
        userRequest: String(input.userRequest || '').trim(),
        baseFingerprint,
        selectedSheetKey: input.currentSheetKey || '',
        selectedSheet: getSelectedSheetSnapshot_ACU(tempData, input.currentSheetKey),
        sheetCount: buildSheetSummary_ACU(tempData).length,
        allSheets: buildDetailedSheetSnapshots_ACU(tempData),
        globalInjectionConfig: getGlobalInjectionConfigFromData_ACU(tempData, { ensureWriteBack: false }),
        constraints: {
            protocolVersion: 2,
            requestIdRequired: true,
            atomicOnly: true,
            allowCrossSheetPatch: true,
            patchSourceDataForbidDdl: true,
            sourceDataAllowedKeys: [...TEMPLATE_ASSISTANT_SOURCE_DATA_ALLOWED_KEYS_ACU],
            addSheetSourceDataForbidDdl: true,
            allowStructuredContentPatch: true,
            allowStructuredSchemaPatch: true,
            allowStructuredLockPatch: true,
            contentPatchRowNumberBase: 1,
            lockPatchRowNumberBase: 1,
            preferRichSourceDataForAddSheet: true,
            defaultNoDdlForNewSheetUnlessExplicitlyRequested: true,
            ddlMustPreserveHeaderOrder: true,
            ddlChineseHeadersRequireCommentMapping: true,
            ddlChineseHeadersForbidChinesePhysicalNames: true,
            ddlPhysicalColumnNamesShouldBeAsciiWhenHeadersAreChinese: true,
            avoidSlashInNewCustomHeaders: true,
            cannotPatchNewSheetAfterAddInSameDraft: true,
            redactExistingSourceDataDdlFromSnapshots: true,
        },
    };
    return safeJsonStringify_ACU(payload, '{}');
}

function buildSessionRoundUserRequest_ACU(options: {
    userRequest: string;
    round: number;
    maxRounds: number;
    repairReason: string;
}) {
    const chunks = [String(options.userRequest || '').trim()];
    if (options.round > 1) {
        chunks.push(`补充说明：当前是第 ${options.round}/${options.maxRounds} 轮，输入数据已经包含前面轮次产生的内存草稿结果。请只继续未完成的改动；如果已经无需继续修改，请返回空 operations。`);
    }
    if (options.repairReason) {
        chunks.push(`修复要求：上一轮 assistant 草稿未通过本地校验，原因是：${options.repairReason}。请修复草稿并继续完成需求，仍然只能输出合法 draft JSON。`);
    }
    return chunks.filter(Boolean).join('\n\n');
}

function getTemplateAssistantSessionAbortReason_ACU(guard?: TemplateAssistantSessionRunGuard_ACU | null): TemplateAssistantSessionAbortReason_ACU | null {
    if (guard?.isCancelled?.()) return 'cancelled';
    if (guard?.isStale?.()) return 'stale';
    return null;
}

function assertTemplateAssistantSessionActive_ACU(guard?: TemplateAssistantSessionRunGuard_ACU | null) {
    const stopReason = getTemplateAssistantSessionAbortReason_ACU(guard);
    if (stopReason) {
        throw new TemplateAssistantSessionStoppedError_ACU(stopReason);
    }
}

export function createTemplateAssistantSessionGuard_ACU(): TemplateAssistantSessionGuardController_ACU {
    let version = 0;
    let cancelled = false;
    return {
        createRunGuard() {
            const capturedVersion = version;
            return {
                isCancelled: () => cancelled,
                isStale: () => !cancelled && capturedVersion !== version,
            };
        },
        invalidate() {
            version += 1;
        },
        cancel() {
            cancelled = true;
            version += 1;
        },
        reset() {
            cancelled = false;
            version += 1;
        },
    };
}

function buildTemplateAssistantNoopDraft_ACU(baseFingerprint: string, selectedSheetKey: string | null, summary = '', warnings: string[] = []): TemplateAssistantDraft_ACU {
    return {
        protocolVersion: 2,
        mode: 'modify_current_template_incremental',
        requestId: 'template-assistant-noop',
        baseFingerprint,
        atomic: true,
        selectedSheetKey: String(selectedSheetKey || ''),
        summary,
        warnings: warnings.map((item) => String(item ?? '')),
        operations: [],
    };
}

function appendUniqueByJson_ACU<T>(target: T[], source: T[]) {
    const seen = new Set(target.map((item) => safeJsonStringify_ACU(item, 'null')));
    source.forEach((item) => {
        const key = safeJsonStringify_ACU(item, 'null');
        if (seen.has(key)) return;
        seen.add(key);
        target.push(clone_ACU(item));
    });
}

function aggregateCompileResults_ACU(params: {
    baselineSheetOrder: string[] | null;
    currentSheetKey: string | null;
    rounds: TemplateAssistantSessionRound_ACU[];
    workingTempData: AnyRecord;
    workingSheetOrder: string[] | null;
    workingCurrentSheetKey: string | null;
}): TemplateAssistantCompileResult_ACU {
    const aggregated: TemplateAssistantCompileResult_ACU = {
        candidateData: clone_ACU(params.workingTempData),
        orderedSheetKeys: Array.isArray(params.workingSheetOrder)
            ? [...params.workingSheetOrder]
            : (params.baselineSheetOrder ? [...params.baselineSheetOrder] : []),
        deletedSheetKeys: [],
        focusSheetKey: params.workingCurrentSheetKey || params.currentSheetKey,
        diff: {
            addedSheets: [],
            deletedSheets: [],
            renamedSheets: [],
            movedSheets: [],
            patchedSourceDataSheets: [],
            patchedUpdateConfigSheets: [],
            patchedExportConfigSheets: [],
            patchedContentSheets: [],
            patchedSchemaSheets: [],
            patchedLockSheets: [],
            globalInjectionChanged: false,
        },
        highRiskItems: [],
        lockChanges: [],
        schemaMigrationIntents: {},
    };
    params.rounds.forEach((round) => {
        appendUniqueByJson_ACU(aggregated.deletedSheetKeys, round.perRoundCompileResult.deletedSheetKeys || []);
        appendUniqueByJson_ACU(aggregated.diff.addedSheets, round.perRoundCompileResult.diff?.addedSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.deletedSheets, round.perRoundCompileResult.diff?.deletedSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.renamedSheets, round.perRoundCompileResult.diff?.renamedSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.movedSheets, round.perRoundCompileResult.diff?.movedSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.patchedSourceDataSheets, round.perRoundCompileResult.diff?.patchedSourceDataSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.patchedUpdateConfigSheets, round.perRoundCompileResult.diff?.patchedUpdateConfigSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.patchedExportConfigSheets, round.perRoundCompileResult.diff?.patchedExportConfigSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.patchedContentSheets, round.perRoundCompileResult.diff?.patchedContentSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.patchedSchemaSheets, round.perRoundCompileResult.diff?.patchedSchemaSheets || []);
        appendUniqueByJson_ACU(aggregated.diff.patchedLockSheets, round.perRoundCompileResult.diff?.patchedLockSheets || []);
        if (round.perRoundCompileResult.diff?.globalInjectionChanged) {
            aggregated.diff.globalInjectionChanged = true;
        }
        appendUniqueByJson_ACU(aggregated.highRiskItems, round.perRoundCompileResult.highRiskItems || []);
        appendUniqueByJson_ACU(aggregated.lockChanges, round.perRoundCompileResult.lockChanges || []);
        const schemaPatchedSheetKeys = new Set((round.perRoundCompileResult.diff?.patchedSchemaSheets || []).map((item) => item.sheetKey));
        for (const sheetKey of schemaPatchedSheetKeys) {
            const wasPatchedInEarlierRound = params.rounds
                .filter((earlierRound) => earlierRound.round < round.round)
                .some((earlierRound) => (earlierRound.perRoundCompileResult.diff?.patchedSchemaSheets || [])
                    .some((item) => item.sheetKey === sheetKey));
            if (wasPatchedInEarlierRound) {
                throw new Error(`多轮会话不支持同一张表跨轮重复 schema migration：${sheetKey}。请在同一轮完成该表的结构修改。`);
            }
        }
        Object.entries(round.perRoundCompileResult.schemaMigrationIntents || {}).forEach(([sheetKey, intent]) => {
            aggregated.schemaMigrationIntents[sheetKey] = clone_ACU(intent);
        });
        if (round.perRoundCompileResult.focusSheetKey) {
            aggregated.focusSheetKey = round.perRoundCompileResult.focusSheetKey;
        }
    });
    if (aggregated.focusSheetKey && !aggregated.candidateData?.[aggregated.focusSheetKey]) {
        aggregated.focusSheetKey = aggregated.orderedSheetKeys[0] || null;
    }
    return aggregated;
}

export function getTemplateAssistantApplyBaselineFingerprint_ACU(result: TemplateAssistantGenerateResult_ACU | null | undefined) {
    const originalBaseFingerprint = String(result?.originalBaseFingerprint || '').trim();
    if (originalBaseFingerprint) {
        return originalBaseFingerprint;
    }
    if (Array.isArray(result?.rounds) || !!result?.session) {
        return '';
    }
    return String(result?.draft?.baseFingerprint || '').trim();
}

function emitTemplateAssistantRoundComplete_ACU(
    onRoundComplete: TemplateAssistantSessionRunInput_ACU['onRoundComplete'],
    round: TemplateAssistantSessionRound_ACU,
    rounds: TemplateAssistantSessionRound_ACU[],
    maxRounds: number,
) {
    if (typeof onRoundComplete !== 'function') return;
    try {
        onRoundComplete({
            round: clone_ACU(round),
            rounds: clone_ACU(rounds),
            maxRounds,
        });
    } catch (error: any) {
        logError_ACU('[TemplateAssistant] onRoundComplete 执行失败', {
            errorMessage: error?.message || '未知错误',
            round: round.round,
        });
    }
}

export async function generateTemplateAssistantDraft_ACU(input: TemplateAssistantGenerateInput_ACU): Promise<TemplateAssistantGenerateResult_ACU> {
    const tempData = asObject_ACU(input?.tempData);
    const userRequest = String(input?.userRequest || '').trim();
    if (!userRequest) {
        throw new Error('请输入改表需求');
    }
    if (!String(input?.currentSheetKey || '').trim()) {
        throw new Error('请先选中一个表后再使用 AI 改表助手');
    }
    const baseFingerprint = buildTemplateAssistantFingerprint_ACU(tempData);
    const messages = buildTemplateAssistantMessages_ACU({ ...input, tempData }, baseFingerprint);

    const overridePreset = String(input?.tableApiPreset || '').trim();
    let effectivePreset = overridePreset;
    if (!effectivePreset) {
        effectivePreset = settings_ACU.tableApiPreset || '';
        const currentSheet = input.currentSheetKey ? tempData[input.currentSheetKey] : null;
        const currentTableName = String(currentSheet?.name || '').trim();
        if (currentTableName) {
            const overrides = settings_ACU.tableApiPresetOverridesByName;
            if (overrides && typeof overrides === 'object' && typeof overrides[currentTableName] === 'string' && overrides[currentTableName].trim()) {
                effectivePreset = overrides[currentTableName].trim();
            }
        }
    }

    const aiRawText = await callAIWithPreset_ACU(messages, effectivePreset);
    if (!aiRawText) {
        throw new Error('AI 未返回有效内容');
    }

    let draft: TemplateAssistantDraft_ACU;
    try {
        draft = parseTemplateAssistantDraft_ACU(aiRawText);
    } catch (error: any) {
        logError_ACU('[TemplateAssistant] draft 解析失败', {
            currentSheetKey: input.currentSheetKey,
            baseFingerprint,
            userRequest,
            errorMessage: error?.message || '未知错误',
            aiRawText,
        });
        throw error;
    }

    if (draft.baseFingerprint !== baseFingerprint) {
        throw new Error('AI 返回的 baseFingerprint 与当前结构不一致');
    }
    draft.operations.forEach((op) => {
        if (String(op?.op || '').startsWith('patch_sheet_')) {
            validatePatchSheetBoundary_ACU(op, draft.selectedSheetKey, input.currentSheetKey, draft.protocolVersion);
        }
    });

    const compileResult = compileTemplateAssistantDraft_ACU({
        tempData,
        sheetOrder: input.sheetOrder,
        currentSheetKey: input.currentSheetKey,
        draft,
    });
    const preflight = await preflightSchemaMigrations_ACU({
        baselineData: tempData as any,
        candidateData: compileResult.candidateData as any,
        intents: compileResult.schemaMigrationIntents,
    });
    if (preflight.blockers.length > 0) throw new Error(`schema migration preflight 失败：${preflight.blockers.join('；')}`);

    return {
        draft,
        aiRawText,
        messages,
        compileResult,
    };
}

export async function runTemplateAssistantSession_ACU(input: TemplateAssistantSessionRunInput_ACU): Promise<TemplateAssistantSessionResult_ACU> {
    const tempData = asObject_ACU(input?.tempData);
    const currentSheetKey = String(input?.currentSheetKey || '').trim();
    const userRequest = String(input?.userRequest || '').trim();
    if (!userRequest) {
        throw new Error('请输入改表需求');
    }
    if (!currentSheetKey) {
        throw new Error('请先选中一个表后再使用 AI 改表助手');
    }

    const maxRounds = normalizePositiveInteger_ACU(input?.maxRounds, DEFAULT_TEMPLATE_ASSISTANT_MAX_ROUNDS_ACU);
    const maxRepairRetries = normalizeNonNegativeInteger_ACU(input?.maxRepairRetries, DEFAULT_TEMPLATE_ASSISTANT_MAX_REPAIR_RETRIES_ACU);
    const originalTempData = clone_ACU(tempData);
    const originalSheetOrder = Array.isArray(input?.sheetOrder) ? [...input.sheetOrder] : null;
    const originalBaseFingerprint = buildTemplateAssistantFingerprint_ACU(originalTempData);
    const rounds: TemplateAssistantSessionRound_ACU[] = [];
    const basePriorTurns = normalizePriorTurns_ACU(input?.priorTurns);
    const onRoundComplete = input?.onRoundComplete;

    let workingTempData = clone_ACU(originalTempData);
    let workingSheetOrder = Array.isArray(originalSheetOrder) ? [...originalSheetOrder] : null;
    let workingCurrentSheetKey: string | null = currentSheetKey;
    let workingFingerprint = originalBaseFingerprint;
    let stopReason: TemplateAssistantSessionStopReason_ACU = 'max_rounds';
    let repairRetriesUsed = 0;
    let lastErrorMessage = '';
    let lastResult: TemplateAssistantGenerateResult_ACU | null = null;

    outerLoop:
    for (let round = 1; round <= maxRounds; round += 1) {
        let repairReason = '';
        while (true) {
            assertTemplateAssistantSessionActive_ACU(input.guard);
            const roundUserRequest = buildSessionRoundUserRequest_ACU({
                userRequest,
                round,
                maxRounds,
                repairReason,
            });
            try {
                const historyForRound = [
                    ...basePriorTurns,
                    ...rounds.map((item) => ({
                        user: item.userRequest,
                        assistant: item.aiRawText,
                    })),
                ];
                const result = await generateTemplateAssistantDraft_ACU({
                    tempData: workingTempData,
                    currentSheetKey: workingCurrentSheetKey,
                    sheetOrder: workingSheetOrder,
                    userRequest: roundUserRequest,
                    priorTurns: historyForRound,
                    tableApiPreset: input.tableApiPreset,
                });
                assertTemplateAssistantSessionActive_ACU(input.guard);
                lastResult = result;
                const hasOperations = result.draft.operations.length > 0;
                const nextWorkingTempData = hasOperations ? clone_ACU(result.compileResult.candidateData || {}) : clone_ACU(workingTempData);
                const nextWorkingSheetOrder = hasOperations
                    ? (Array.isArray(result.compileResult.orderedSheetKeys) ? [...result.compileResult.orderedSheetKeys] : [])
                    : (Array.isArray(workingSheetOrder) ? [...workingSheetOrder] : null);
                const nextWorkingFingerprint = hasOperations ? buildTemplateAssistantFingerprint_ACU(nextWorkingTempData) : workingFingerprint;

                const roundRecord: TemplateAssistantSessionRound_ACU = {
                    round,
                    userRequest: roundUserRequest,
                    draft: result.draft,
                    aiRawText: result.aiRawText,
                    messages: result.messages,
                    perRoundCompileResult: result.compileResult,
                    workingFingerprint: nextWorkingFingerprint,
                };
                rounds.push(roundRecord);
                emitTemplateAssistantRoundComplete_ACU(onRoundComplete, roundRecord, rounds, maxRounds);

                if (!hasOperations) {
                    stopReason = 'empty_operations';
                    break outerLoop;
                }

                workingTempData = nextWorkingTempData;
                workingSheetOrder = nextWorkingSheetOrder;
                workingCurrentSheetKey = result.compileResult.focusSheetKey || workingCurrentSheetKey;
                if (nextWorkingFingerprint === workingFingerprint) {
                    workingFingerprint = nextWorkingFingerprint;
                    stopReason = 'repeated_working_fingerprint';
                    break outerLoop;
                }

                workingFingerprint = nextWorkingFingerprint;
                lastErrorMessage = '';
                if (round === maxRounds) {
                    stopReason = 'max_rounds';
                    break outerLoop;
                }
                break;
            } catch (error: any) {
                assertTemplateAssistantSessionActive_ACU(input.guard);
                lastErrorMessage = error?.message || '未知错误';
                if (repairRetriesUsed >= maxRepairRetries) {
                    stopReason = 'repair_retry_capped';
                    break outerLoop;
                }
                repairRetriesUsed += 1;
                repairReason = lastErrorMessage;
            }
        }
    }

    const compileResult = rounds.length
        ? aggregateCompileResults_ACU({
            baselineSheetOrder: originalSheetOrder,
            currentSheetKey,
            rounds,
            workingTempData,
            workingSheetOrder,
            workingCurrentSheetKey,
        })
        : buildTemplateAssistantCumulativeCompileResult_ACU({
            baselineData: originalTempData,
            baselineSheetOrder: originalSheetOrder,
            candidateData: workingTempData,
            candidateSheetOrder: workingSheetOrder,
            focusSheetKey: workingCurrentSheetKey,
        });
    const finalPreflight = await preflightSchemaMigrations_ACU({
        baselineData: originalTempData as any,
        candidateData: compileResult.candidateData as any,
        intents: compileResult.schemaMigrationIntents,
    });
    if (finalPreflight.blockers.length > 0) throw new Error(`schema migration 最终 preflight 失败：${finalPreflight.blockers.join('；')}`);
    const finalDraft = lastResult?.draft || buildTemplateAssistantNoopDraft_ACU(originalBaseFingerprint, currentSheetKey);
    const finalWorkingFingerprint = buildTemplateAssistantFingerprint_ACU(compileResult.candidateData || workingTempData);

    return {
        draft: finalDraft,
        aiRawText: lastResult?.aiRawText || '',
        messages: lastResult?.messages || [],
        compileResult,
        originalBaseFingerprint,
        rounds,
        session: {
            originalBaseFingerprint,
            finalWorkingFingerprint,
            stopReason,
            roundsExecuted: rounds.length,
            maxRounds,
            repairRetriesUsed,
            maxRepairRetries,
            lastErrorMessage,
        },
    };
}
