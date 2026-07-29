import { beforeEach, describe, expect, it, vi } from 'vitest';
import legacyValidFixture from '../../fixtures/migrations/spv7.9/legacy-valid.json';
import headerChineseFixture from '../../fixtures/migrations/spv7.9/header-chinese.json';
import headerIdFixture from '../../fixtures/migrations/spv7.9/header-id.json';
import headerRowIdFixture from '../../fixtures/migrations/spv7.9/header-row-id.json';
import headerNullFixture from '../../fixtures/migrations/spv7.9/header-null.json';
import duplicateNumberStringFixture from '../../fixtures/migrations/spv7.9/duplicate-row-id-number-string.json';
import emptyRowIdFixture from '../../fixtures/migrations/spv7.9/empty-row-id.json';
import shortRowFixture from '../../fixtures/migrations/spv7.9/row-width-short.json';
import longRowFixture from '../../fixtures/migrations/spv7.9/row-width-long.json';
import mixedLegacyV2Fixture from '../../fixtures/migrations/spv7.9/mixed-legacy-v2.json';

const { mockChatRef, mockSaveChatToHost, mockRuntimeScope } = vi.hoisted(() => ({
  mockChatRef: { value: [] as any[] },
  mockSaveChatToHost: vi.fn().mockResolvedValue(undefined),
  mockRuntimeScope: {
    chatIdentifier: 'migration-test-chat',
    isolationKey: '',
  },
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: vi.fn(() => mockChatRef.value),
  saveChatToHostStrict_ACU: mockSaveChatToHost,
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  settings_ACU: { storageMode: 'native' },
  get currentChatFileIdentifier_ACU() { return mockRuntimeScope.chatIdentifier; },
  getCurrentIsolationKey_ACU: vi.fn(() => mockRuntimeScope.isolationKey),
}));

vi.mock('../../../src/shared/utils', async () => {
  const actual = await vi.importActual<any>('../../../src/shared/utils');
  return {
    ...actual,
    logDebug_ACU: vi.fn(),
    logWarn_ACU: vi.fn(),
    logError_ACU: vi.fn(),
  };
});

import { resolveTableStorageStrategy_ACU } from '../../../src/service/table/storage-strategy-resolver';
import { migrateLegacyStorageToV2OnLoad_ACU } from '../../../src/service/table/storage-v2-migration';
import { getTableDataFingerprint_ACU } from '../../../src/service/table/table-data-upgrade-audit';
import { validateMigrationProvenanceV1_ACU } from '../../../src/shared/canonical-checkpoint-validator';
import { loadTableStateFromFramesV2_ACU } from '../../../src/service/table/storage-frame-v2-replay';

function sheet(name: string, rows: any[][] = [['row_id', '名称'], ['1', name]]) {
  return {
    uid: name,
    name,
    content: rows,
    updateConfig: {},
    exportConfig: {},
    sourceData: {},
    orderNo: 0,
  } as any;
}

function setLegacyMigrationChat(data: any) {
  mockChatRef.value = [
    {
      is_user: false,
      TavernDB_ACU_IndependentData: { sheet_0: data.sheet_0 },
      TavernDB_ACU_ModifiedKeys: ['sheet_0'],
    },
    { is_user: true },
    { is_user: false, mes: 'latest ai' },
  ];
}

function getBusinessDataProjection_ACU(data: any): {
  sheetCount: number;
  sheets: Record<string, { rowCount: number; nonEmptyBusinessCellCount: number; businessValueFingerprint: string }>;
} {
  const sheetEntries = Object.entries(data || {})
    .filter(([key, value]) => key.startsWith('sheet_') && value && typeof value === 'object')
    .sort(([left], [right]) => left.localeCompare(right));
  const sheets = Object.fromEntries(sheetEntries.map(([sheetKey, sheet]: [string, any]) => {
    const rows = Array.isArray(sheet.content)
      ? sheet.content.slice(1).filter(Array.isArray).map((row: any[]) => {
        const businessCells = row.slice(1);
        while (businessCells.length > 0) {
          const lastCell = businessCells[businessCells.length - 1];
          if (lastCell !== null && lastCell !== undefined) break;
          businessCells.pop();
        }
        return businessCells;
      })
      : [];
    const serializedValues = JSON.stringify(rows);
    let hash = 2166136261;
    for (let index = 0; index < serializedValues.length; index += 1) {
      hash ^= serializedValues.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return [sheetKey, {
      rowCount: rows.length,
      nonEmptyBusinessCellCount: rows.flat().filter(value => value !== null && value !== undefined && value !== '').length,
      businessValueFingerprint: `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`,
    }];
  }));
  return { sheetCount: sheetEntries.length, sheets };
}


describe('migrateLegacyStorageToV2OnLoad_ACU', () => {
  beforeEach(() => {
    mockChatRef.value = [];
    mockSaveChatToHost.mockClear();
    mockRuntimeScope.chatIdentifier = 'migration-test-chat';
    mockRuntimeScope.isolationKey = '';
  });

  it('在数据库加载阶段把原版顶层旧字段迁移为 V2 migration checkpoint，并清理旧字段', async () => {
    const data = { sheet_0: sheet('背包') } as any;
    mockChatRef.value = [
      {
        is_user: false,
        TavernDB_ACU_IndependentData: { sheet_0: data.sheet_0 },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
      { is_user: true },
      { is_user: false, mes: 'latest ai' },
    ];

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result).toMatchObject({ migrated: true, messageIndex: 2 });
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
    expect(mockChatRef.value[0].TavernDB_ACU_IndependentData).toBeUndefined();
    expect(mockChatRef.value[0].TavernDB_ACU_ModifiedKeys).toBeUndefined();

    const tagData = mockChatRef.value[2].TavernDB_ACU_IsolatedData[''];
    expect(tagData._acu_storage_version).toBe(2);
    expect(tagData.storageFrame.checkpoint.reason).toBe('migration');
    expect(tagData.storageFrame.checkpoint.data).toEqual(data);
    expect(tagData.storageFrame.checkpoint.event).toBeUndefined();
    expect(tagData.storageFrame.checkpoint.scheduleSummary.sheet_0).toEqual({
      lastFilledAiFloor: 1,
      lastChangedAiFloor: 1,
    });
    expect(tagData.storageFrame.checkpoint.migrationProvenance).toMatchObject({
      version: 1,
      legacyDataFingerprint: expect.any(String),
      legacySourceMessageIndices: [0],
      legacySourceAiFloors: [1],
      legacyLastChangedAiFloorBySheet: { sheet_0: 1 },
      targetMessageIndex: 2,
      targetAiFloor: 2,
      isolationKey: '',
      migratedAt: expect.any(Number),
    });
    expect(validateMigrationProvenanceV1_ACU(tagData.storageFrame.checkpoint.migrationProvenance))
      .toEqual({ valid: true, issues: [] });
    expect(tagData.storageFrame.logEntries).toEqual([]);
    expect(resolveTableStorageStrategy_ACU(mockChatRef.value, '', { enabled: false, code: '' }).mode).toBe('v2');
  });

  it('配置保留当前楼不更新时，旧存储迁移 checkpoint 落在当前 AI 楼的上一楼', async () => {
    const data = { sheet_0: sheet('背包') } as any;
    mockChatRef.value = [
      {
        is_user: false,
        mes: 'previous ai',
        TavernDB_ACU_IndependentData: { sheet_0: data.sheet_0 },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
      { is_user: true },
      { is_user: false, mes: 'current ai without fill' },
    ];

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
      skipUpdateFloors: 1,
    });

    expect(result).toMatchObject({ migrated: true, messageIndex: 0 });
    expect(mockChatRef.value[0].TavernDB_ACU_IsolatedData['']._acu_storage_version).toBe(2);
    expect(mockChatRef.value[0].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data).toEqual(data);
    expect(mockChatRef.value[2].TavernDB_ACU_IsolatedData).toBeUndefined();
  });

  it('表级 skipFloors=1 时，旧存储迁移也落在当前 AI 楼的上一楼', async () => {
    const data = { sheet_0: sheet('背包') } as any;
    data.sheet_0.updateConfig = { skipFloors: 1 };
    mockChatRef.value = [
      {
        is_user: false,
        mes: 'previous ai',
        TavernDB_ACU_IndependentData: { sheet_0: data.sheet_0 },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
      { is_user: true },
      { is_user: false, mes: 'current ai without fill' },
    ];

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result).toMatchObject({ migrated: true, messageIndex: 0 });
    expect(mockChatRef.value[0].TavernDB_ACU_IsolatedData['']._acu_storage_version).toBe(2);
    expect(mockChatRef.value[2].TavernDB_ACU_IsolatedData).toBeUndefined();
  });

  it('迁移 V1 隔离槽时保留其他隔离标签，并把旧 updateGroupKeys 写入 scheduleSummary', async () => {
    const data = {
      sheet_0: sheet('角色'),
      sheet_1: sheet('后勤'),
    } as any;
    mockChatRef.value = [
      {
        is_user: false,
        TavernDB_ACU_Identity: 'tag-b',
        TavernDB_ACU_IndependentData: { sheet_9: sheet('顶层其他') },
        TavernDB_ACU_IsolatedData: {
          'tag-a': {
            independentData: { sheet_0: data.sheet_0 },
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: ['sheet_1'],
            summaryVectorIndexManifest: { id: 'manifest-a' },
            _acu_storage_mode: 'checkpoint',
            _acu_storage_version: 1,
          },
          'tag-b': {
            independentData: { sheet_9: sheet('其他') },
            modifiedKeys: ['sheet_9'],
            updateGroupKeys: [],
            _acu_storage_version: 1,
          },
        },
      },
    ];

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: 'tag-a',
      isolationConfig: { enabled: true, code: 'tag-a' },
    });

    expect(result.migrated).toBe(true);
    const isolatedData = mockChatRef.value[0].TavernDB_ACU_IsolatedData;
    expect(isolatedData['tag-b'].independentData.sheet_9.name).toBe('其他');
    expect(mockChatRef.value[0].TavernDB_ACU_Identity).toBe('tag-b');
    expect(mockChatRef.value[0].TavernDB_ACU_IndependentData.sheet_9.name).toBe('顶层其他');
    expect(isolatedData['tag-a'].summaryVectorIndexManifest).toEqual({ id: 'manifest-a' });
    expect(isolatedData['tag-a'].storageFrame.checkpoint.scheduleSummary.sheet_0).toEqual({
      lastFilledAiFloor: 1,
      lastChangedAiFloor: 1,
    });
    expect(isolatedData['tag-a'].storageFrame.checkpoint.scheduleSummary.sheet_1).toEqual({
      lastFilledAiFloor: 1,
    });
    expect(resolveTableStorageStrategy_ACU(mockChatRef.value, 'tag-a', { enabled: true, code: 'tag-a' }).mode).toBe('v2');
  });

  it('旧数据合并结果为空时失败且不清理旧字段', async () => {
    mockChatRef.value = [
      {
        is_user: false,
        TavernDB_ACU_IndependentData: { sheet_0: sheet('背包') },
      },
    ];

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data: null,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result.migrated).toBe(false);
    expect(result.error).toContain('non-empty merged table data');
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockChatRef.value[0].TavernDB_ACU_IndependentData.sheet_0.name).toBe('背包');
  });

  it('legacy 数据含 canonical 后重复 row_id 时重映射后迁移，并保留全部行', async () => {
    const data = {
      sheet_0: sheet('背包', [['row_id', '名称'], ['1', '铁剑'], [' 1 ', '冒名副本']]),
    } as any;
    mockChatRef.value = [
      {
        is_user: false,
        TavernDB_ACU_IndependentData: { sheet_0: data.sheet_0 },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
      { is_user: true },
      { is_user: false, mes: 'latest ai' },
    ];

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result).toEqual(expect.objectContaining({ migrated: true }));
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
    expect(mockChatRef.value[2].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_0.content)
      .toEqual([['row_id', '名称'], ['1', '铁剑'], ['2', '冒名副本']]);
  });

  it('可从合成 spv7.9 合法 legacy fixture 建立 V2 checkpoint', async () => {
    const data = {
      sheet_0: sheet(legacyValidFixture.name, structuredClone(legacyValidFixture.content)),
    } as any;
    setLegacyMigrationChat(data);

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result).toMatchObject({ migrated: true, messageIndex: 2 });
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
    expect(mockChatRef.value[2].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data).toEqual(data);
  });

  it.each([
    { name: 'id 表头', fixture: headerIdFixture },
    { name: 'rowId 表头', fixture: headerRowIdFixture },
    { name: 'null 表头', fixture: headerNullFixture },
    { name: '数值与字符串等价 row_id', fixture: duplicateNumberStringFixture },
    { name: '空 row_id', fixture: emptyRowIdFixture },
    { name: '短行', fixture: shortRowFixture },
  ])('无损可修复的合成 spv7.9 fixture 会迁移为 V2 checkpoint', async ({ fixture }) => {
    const data = {
      sheet_0: sheet(fixture.name, structuredClone(fixture.content)),
    } as any;
    const beforeProjection = getBusinessDataProjection_ACU(data);
    setLegacyMigrationChat(data);

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result).toEqual(expect.objectContaining({ migrated: true }));
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
    const checkpointData = mockChatRef.value[2].TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data;
    const replayedData = await loadTableStateFromFramesV2_ACU(mockChatRef.value, '', { updateRuntimeState: false });
    expect(getBusinessDataProjection_ACU(result.data)).toEqual(beforeProjection);
    expect(getBusinessDataProjection_ACU(checkpointData)).toEqual(beforeProjection);
    expect(getBusinessDataProjection_ACU(replayedData)).toEqual(beforeProjection);
  });

  it.each([
    { name: '中文业务表头', fixture: headerChineseFixture },
    { name: '长行', fixture: longRowFixture },
  ])('无法安全推导的合成 spv7.9 fixture 要求确认，且不写入或删除 legacy 数据', async ({ fixture }) => {
    const data = { sheet_0: sheet(fixture.name, structuredClone(fixture.content)) } as any;
    setLegacyMigrationChat(data);
    const before = structuredClone(mockChatRef.value);
    const result = await migrateLegacyStorageToV2OnLoad_ACU({ data, isolationKey: '', isolationConfig: { enabled: false, code: '' } });

    expect(result).toEqual(expect.objectContaining({ migrated: false }));
    expect(result.error).toContain('requires confirmation');
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockChatRef.value).toEqual(before);
  });

  it('mixed 且 migration provenance、coverage、fingerprint 全部验证时，仅清理 legacy 并保持 V2 frame', async () => {
    const data = { sheet_0: sheet('背包', [['row_id', '名称'], ['1', 'legacy 铁剑']]) } as any;
    mockChatRef.value = [
      { is_user: false, TavernDB_ACU_Data: data, TavernDB_ACU_ModifiedKeys: ['sheet_0'] },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            _acu_storage_version: 2,
            storageFrame: {
              version: 2,
              headRevision: 'checkpoint:verified-migration',
              checkpoint: {
                kind: 'full',
                createdAt: 1,
                reason: 'migration',
                data: structuredClone(data),
                scheduleSummary: { sheet_0: { lastChangedAiFloor: 1 } },
                migrationProvenance: {
                  version: 1,
                  legacyDataFingerprint: getTableDataFingerprint_ACU(data),
                  legacySourceMessageIndices: [0],
                  legacySourceAiFloors: [1],
                  legacyLastChangedAiFloorBySheet: { sheet_0: 1 },
                  targetMessageIndex: 1,
                  targetAiFloor: 2,
                  isolationKey: '',
                  migratedAt: 1,
                },
              },
              logEntries: [],
            },
          },
        },
      },
    ];
    const v2Before = structuredClone(mockChatRef.value[1].TavernDB_ACU_IsolatedData[''].storageFrame);

    const result = await migrateLegacyStorageToV2OnLoad_ACU({ data, isolationKey: '', isolationConfig: { enabled: false, code: '' } });

    expect(result.error).toBeUndefined();
    expect(result.mixedDecision?.kind).toBe('equivalent_provenance_verified');
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
    expect(mockChatRef.value[0].TavernDB_ACU_Data).toBeUndefined();
    expect(mockChatRef.value[1].TavernDB_ACU_IsolatedData[''].storageFrame).toEqual(v2Before);
  });

  it('合成 spv7.9 mixed legacy/V2 fixture 无 provenance 时保持 fail-closed 且零写入', async () => {
    const data = structuredClone(mixedLegacyV2Fixture.legacy) as any;
    mockChatRef.value = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': { _acu_storage_version: 2, storageFrame: structuredClone(mixedLegacyV2Fixture.v2Frame) },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: { sheet_0: data.sheet_0 },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
      { is_user: true },
      { is_user: false, mes: 'latest ai' },
    ];
    const before = structuredClone(mockChatRef.value);

    const result = await migrateLegacyStorageToV2OnLoad_ACU({ data, isolationKey: '', isolationConfig: { enabled: false, code: '' } });

    expect(result).toEqual(expect.objectContaining({ migrated: false }));
    expect(result.mixedDecision?.kind).toBe('conflict_requires_user_choice');
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockChatRef.value).toEqual(before);
  });

  it('mixed legacy/V2 缺少已验证 provenance 时只按决策协议阻止自动迁移，不再比较 candidate 与 replay', async () => {
    const data = { sheet_0: sheet('背包', [['row_id', '名称'], ['1', 'legacy 铁剑']]) } as any;
    mockChatRef.value = [
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': { _acu_storage_version: 2, storageFrame: {
            version: 2,
            headRevision: 'checkpoint:existing',
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: { sheet_0: sheet('背包', [['row_id', '名称'], ['1', 'V2 铁剑']]) } },
            logEntries: [],
          } },
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: { sheet_0: data.sheet_0 },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
      { is_user: true },
      { is_user: false, mes: 'latest ai' },
    ];
    const before = structuredClone(mockChatRef.value);

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result.mixedDecision?.kind).toBe('conflict_requires_user_choice');
    expect(result).toEqual(expect.objectContaining({ migrated: false, error: 'mixed legacy-v1 and V2 data detected: conflict_requires_user_choice; automatic migration remains blocked' }));
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockChatRef.value.flatMap(message => Object.values(message?.TavernDB_ACU_IsolatedData || {})).some((tagData: any) => tagData?.storageFrame?.checkpoint?.migrationProvenance)).toBe(false);
    expect(mockChatRef.value).toEqual(before);
  });


  it('严格保存失败时恢复整个 legacy chat，不留下半迁移状态', async () => {
    const data = { sheet_0: sheet('背包') } as any;
    setLegacyMigrationChat(data);
    const before = structuredClone(mockChatRef.value);
    mockSaveChatToHost.mockRejectedValueOnce(new Error('host write failed'));

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result).toEqual(expect.objectContaining({ migrated: false, error: expect.stringContaining('host write failed') }));
    expect(mockSaveChatToHost).toHaveBeenCalledTimes(1);
    expect(mockChatRef.value).toEqual(before);
  });

});
