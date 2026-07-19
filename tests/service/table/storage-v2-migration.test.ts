import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockChatRef, mockSaveChatToHost } = vi.hoisted(() => ({
  mockChatRef: { value: [] as any[] },
  mockSaveChatToHost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: vi.fn(() => mockChatRef.value),
  saveChatToHost_ACU: mockSaveChatToHost,
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

describe('migrateLegacyStorageToV2OnLoad_ACU', () => {
  beforeEach(() => {
    mockChatRef.value = [];
    mockSaveChatToHost.mockClear();
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

  it('legacy 数据含 canonical 后重复 row_id 时拒绝迁移，且不写入、不保存、不删除旧字段', async () => {
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
    const before = JSON.parse(JSON.stringify(mockChatRef.value));

    const result = await migrateLegacyStorageToV2OnLoad_ACU({
      data,
      isolationKey: '',
      isolationConfig: { enabled: false, code: '' },
    });

    expect(result).toEqual(expect.objectContaining({ migrated: false }));
    expect(result.error).toMatch(/duplicate_row_id|重复.*row_id|row_id.*重复/i);
    expect(mockSaveChatToHost).not.toHaveBeenCalled();
    expect(mockChatRef.value).toEqual(before);
  });
});
