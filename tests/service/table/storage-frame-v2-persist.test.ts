import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: [] as any[],
  saveChat: vi.fn().mockResolvedValue(undefined),
  saveChatStrict: vi.fn().mockResolvedValue(undefined),
  settings: { dataIsolationEnabled: false, dataIsolationCode: '' },
  collectSummary: vi.fn(() => ({ sheet_a: { lastFilledAiFloor: 7, lastChangedAiFloor: 6 } })),
  loadReplayState: vi.fn(),
  scopeContainer: null as any,
  guideContainer: null as any,
  setGuide: vi.fn(() => true),
  runTransaction: vi.fn(),
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: vi.fn(() => mocks.chat),
  saveChatToHost_ACU: mocks.saveChat,
  saveChatToHostStrict_ACU: mocks.saveChatStrict,
}));
vi.mock('../../../src/data/repositories/chat-message-data-repo', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data/repositories/chat-message-data-repo')>()),
  cloneIsolatedData_ACU: vi.fn((message: any) => JSON.parse(JSON.stringify(message.TavernDB_ACU_IsolatedData || {}))),
  writeMessageIdentity_ACU: vi.fn((message: any, isolationConfig: any) => {
    if (isolationConfig.enabled) {
      message.TavernDB_ACU_Identity = isolationConfig.code;
    } else {
      delete message.TavernDB_ACU_Identity;
    }
  }),
}));
vi.mock('../../../src/shared/utils', () => ({ logDebug_ACU: vi.fn(), logWarn_ACU: vi.fn() }));
vi.mock('../../../src/service/runtime/state-manager', () => ({
  getCurrentIsolationKey_ACU: vi.fn(() => ''),
  settings_ACU: mocks.settings,
}));
vi.mock('../../../src/service/table/storage-strategy-resolver', () => ({
  isV2TagData_ACU: vi.fn((tagData: any) => tagData?.storageFrame?.version === 2 && Array.isArray(tagData.storageFrame.logEntries)),
  isLegacyV1TagData_ACU: vi.fn((tagData: any) => {
    if (!tagData || typeof tagData !== 'object' || Array.isArray(tagData)) return false;
    if (tagData?.storageFrame?.version === 2 && Array.isArray(tagData.storageFrame.logEntries)) return false;
    return Object.keys(tagData.independentData || {}).some(key => key.startsWith('sheet_'))
      || Object.keys(tagData.incrementalData || {}).some(key => key.startsWith('sheet_'))
      || (tagData._acu_storage_version === 1
        && ('independentData' in tagData || 'incrementalData' in tagData));
  }),
  hasLegacyTopLevelTableData_ACU: vi.fn((message: any) => {
    if (!message || typeof message !== 'object') return false;
    return ['TavernDB_ACU_IndependentData', 'TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData']
      .some(field => Object.keys(message[field] || {}).some(key => key.startsWith('sheet_')))
      || ['TavernDB_ACU_ModifiedKeys', 'TavernDB_ACU_UpdateGroupKeys']
        .some(field => Array.isArray(message[field]) && message[field].some((key: unknown) => typeof key === 'string' && key.startsWith('sheet_')));
  }),
}));
vi.mock('../../../src/service/table/storage-frame-v2-replay', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/service/table/storage-frame-v2-replay')>()),
  collectScheduleSummaryFromFramesV2_ACU: mocks.collectSummary,
  loadTableStateFromFramesV2_ACU: mocks.loadReplayState,
}));
vi.mock('../../../src/data/storage/chat-history', () => ({
  getChatScopedConfigContainer_ACU: vi.fn(() => mocks.scopeContainer),
  getChatSheetGuideContainer_ACU: vi.fn(() => mocks.guideContainer),
  setChatScopedConfigContainer_ACU: vi.fn((_chat: any[], value: any) => { mocks.scopeContainer = value; }),
  setChatSheetGuideContainer_ACU: vi.fn((_chat: any[], value: any) => { mocks.guideContainer = value; }),
}));
vi.mock('../../../src/service/template/chat-scope', () => ({
  normalizeGuideData_ACU: vi.fn((data: any) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const normalized: Record<string, any> = { mate: data.mate && typeof data.mate === 'object' ? data.mate : { type: 'chatSheets', version: 1 } };
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith('sheet_') || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const sheet = value as Record<string, any>;
      normalized[key] = {
        ...sheet,
        content: [Array.isArray(sheet.content?.[0]) ? sheet.content[0] : [null]],
      };
    }
    return normalized;
  }),
  setChatSheetGuideDataForIsolationKey_ACU: mocks.setGuide,
}));
vi.mock('../../../src/service/table/table-write-transaction', () => ({
  runTableWriteTransaction_ACU: mocks.runTransaction,
}));

import { commitCurrentFloorTemplateChanges_ACU, persistNullRowCleanupShards_ACU, persistTableSheetCheckpointV2_ACU } from '../../../src/service/table/storage-frame-v2-persist';
import { buildSheetSchemaMigrationOperation_ACU } from '../../../src/service/table/table-schema-migration';

const sheetA = { uid: 'a', name: 'A', sourceData: {}, content: [['row_id', 'value'], ['1', 'new']], updateConfig: {}, exportConfig: {}, orderNo: 1 } as any;
const sheetB = { uid: 'b', name: 'B', sourceData: {}, content: [['row_id', 'value']], updateConfig: {}, exportConfig: {}, orderNo: 2 } as any;

function makeEntry(overrides: Record<string, any> = {}): any {
  return {
    seq: 1, entryId: 'entry-1', createdAt: 10, source: 'manual_fill', targetMessageIndex: 0, aiFloor: 1,
    filledSheetKeys: [], changedSheetKeys: [], groupKeys: [], operations: [], ...overrides,
  };
}

function seedFrame(frameOverrides: Record<string, any> = {}): any {
  const frame = {
    version: 2,
    checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } },
    headRevision: '3:existing',
    manualRefillProgress: { kind: 'manual_refill', status: 'in_progress', selectedSheetKeys: ['sheet_b'] },
    logEntries: [makeEntry({ operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_b', sheet: sheetB, reason: 'system' }] })],
    perSheetCheckpoints: { sheet_b: { kind: 'sheet_full', createdAt: 2, reason: 'manual', sheetKey: 'sheet_b', data: sheetB } },
    ...frameOverrides,
  };
  const message = { is_user: false, TavernDB_ACU_IsolatedData: { '': { _acu_storage_version: 2, storageFrame: frame } } };
  mocks.chat.splice(0, mocks.chat.length, message);
  mocks.loadReplayState.mockResolvedValue(frame.checkpoint?.data ?? null);
  return message;
}

function makeTransaction(baseRevision: string | null = 'runtime-v1:test'): any {
  return {
    baseRevision,
    writeSet: [{ kind: 'sheet', sheetKey: 'sheet_a' }],
    assertFresh: vi.fn(),
    runCommit: vi.fn(async (task: () => any) => task()),
  };
}


describe('manualRefillProgress V2 validation', () => {
  it('接受无 version 的旧版手动重填进度', async () => {
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');
    seedFrame({ manualRefillProgress: undefined });
    const result = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData: { sheet_a: sheetA, sheet_b: sheetB } as any,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_a', sheet: sheetA, reason: 'system' }],
      manualRefillProgress: {
        kind: 'manual_refill', status: 'in_progress', selectedSheetKeys: ['sheet_a'], contextMessageIndices: [0],
        originalStartMessageIndex: 0, targetMessageIndex: 0, batchSize: 1, completedUntilMessageIndex: 0, updatedAt: 1,
      },
      transactionContext: makeTransaction(), assumeCommitLock: true,
    });
    expect(result.saved).toBe(true);
  });

  it('仅更新新版手动追平进度时不追加 mutation entry 或创建 checkpoint', async () => {
    mocks.saveChat.mockClear();
    mocks.saveChatStrict.mockClear();
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');
    const message = seedFrame();
    const frameBefore = JSON.parse(JSON.stringify(message.TavernDB_ACU_IsolatedData[''].storageFrame));

    const result = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData: frameBefore.checkpoint.data,
      filledSheetKeys: [],
      candidateChangedSheetKeys: [],
      operations: [],
      manualRefillProgress: {
        kind: 'manual_refill', version: 2, status: 'complete',
        selectedSheetKeys: ['sheet_a'], contextMessageIndices: [0],
        originalStartMessageIndex: 0, targetMessageIndex: 0, batchSize: 1,
        completedUntilMessageIndex: 0, completedSheetMessageIndexByKey: { sheet_a: 0 },
        runId: 'catch-up-run', mode: 'catch_up', targetAiFloor: 1,
        planSignature: 'plan-signature', waveIndex: 0, bucketIndex: 0,
        totalWaves: 1, totalBuckets: 1, updatedAt: 2,
      },
      transactionContext: makeTransaction(), assumeCommitLock: true,
    });

    const frameAfter = message.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(result.saved).toBe(true);
    expect(frameAfter.manualRefillProgress).toEqual(expect.objectContaining({
      version: 2,
      status: 'complete',
      runId: 'catch-up-run',
      completedSheetMessageIndexByKey: { sheet_a: 0 },
    }));
    expect(frameAfter.logEntries).toEqual(frameBefore.logEntries);
    expect(frameAfter.checkpoint).toEqual(frameBefore.checkpoint);
    expect(frameAfter.headRevision).toBe(frameBefore.headRevision);
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });

  it('无 full checkpoint 时拒绝 progress-only，且不创建无根 V2 frame 或触发保存', async () => {
    mocks.saveChat.mockClear();
    mocks.saveChatStrict.mockClear();
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');
    const message = seedFrame({ checkpoint: undefined, logEntries: [], headRevision: null });
    const beforeIsolatedData = JSON.parse(JSON.stringify(message.TavernDB_ACU_IsolatedData));

    const result = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData: { mate: { type: 'acu' }, sheet_a: sheetA } as any,
      filledSheetKeys: [],
      candidateChangedSheetKeys: [],
      operations: [],
      manualRefillProgress: {
        kind: 'manual_refill', version: 2, status: 'stopped',
        selectedSheetKeys: ['sheet_a'], contextMessageIndices: [0],
        originalStartMessageIndex: 0, targetMessageIndex: 0, batchSize: 1,
        completedUntilMessageIndex: 0, completedSheetMessageIndexByKey: {},
        runId: 'catch-up-no-checkpoint', mode: 'catch_up', targetAiFloor: 1,
        planSignature: 'plan-signature', waveIndex: 0, bucketIndex: 0,
        totalWaves: 1, totalBuckets: 1, lastError: 'stopped', updatedAt: 2,
      },
      strictSave: true,
      transactionContext: makeTransaction(), assumeCommitLock: true,
    });

    expect(result).toEqual({
      saved: false,
      error: 'V2 manualRefillProgress-only write requires an existing full checkpoint anchor.',
    });
    expect(message.TavernDB_ACU_IsolatedData).toEqual(beforeIsolatedData);
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  it('progress-only 严格保存失败时恢复 frame metadata、headRevision 与 identity', async () => {
    mocks.saveChat.mockClear();
    mocks.saveChatStrict.mockReset().mockRejectedValueOnce(new Error('strict save failed'));
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');
    const message = seedFrame();
    message.TavernDB_ACU_Identity = 'original-identity';
    const beforeIsolatedData = JSON.parse(JSON.stringify(message.TavernDB_ACU_IsolatedData));

    await expect(persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData: beforeIsolatedData[''].storageFrame.checkpoint.data,
      filledSheetKeys: [],
      candidateChangedSheetKeys: [],
      operations: [],
      manualRefillProgress: {
        kind: 'manual_refill', version: 2, status: 'failed',
        selectedSheetKeys: ['sheet_a'], contextMessageIndices: [0],
        originalStartMessageIndex: 0, targetMessageIndex: 0, batchSize: 1,
        completedUntilMessageIndex: 0, completedSheetMessageIndexByKey: {},
        runId: 'catch-up-save-failed', mode: 'catch_up', targetAiFloor: 1,
        planSignature: 'plan-signature', waveIndex: 0, bucketIndex: 0,
        totalWaves: 1, totalBuckets: 1, lastError: 'primary failure', updatedAt: 2,
      },
      strictSave: true,
      transactionContext: makeTransaction(), assumeCommitLock: true,
    })).rejects.toThrow('strict save failed');

    expect(message.TavernDB_ACU_IsolatedData).toEqual(beforeIsolatedData);
    expect(message.TavernDB_ACU_Identity).toBe('original-identity');
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });
});

describe('persistTableMutationLogV2_ACU incremental replacement', () => {
  beforeEach(() => {
    mocks.chat.length = 0;
    mocks.saveChat.mockReset().mockResolvedValue(undefined);
    mocks.saveChatStrict.mockReset().mockResolvedValue(undefined);
    mocks.settings.dataIsolationEnabled = false;
    mocks.settings.dataIsolationCode = '';
  });

  function makeReplacementOptions(targetMessageIndex: number) {
    return {
      targetMessageIndex,
      source: 'manual_fill' as const,
      afterData: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } as any,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [{ kind: 'sheet_replace' as const, sheetKey: 'sheet_a', sheet: sheetA, reason: 'system' as const }],
      replaceExistingIncremental: { targetMessageIndices: [0, 1], targetSheetKeys: ['sheet_a'] },
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    };
  }

  it('拒绝包含空 row_id 的普通 full snapshot，且不修改聊天或保存', async () => {
    const message = seedFrame();
    message.TavernDB_ACU_Identity = 'identity-before-rejection';
    const isolatedDataBefore = message.TavernDB_ACU_IsolatedData;
    const messageBefore = JSON.parse(JSON.stringify(message));
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');

    const result = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData: {
        mate: { type: 'acu' },
        sheet_a: { ...sheetA, content: [['row_id', 'value'], ['1', 'new'], [' ', 'must-not-drop']] },
        sheet_b: sheetB,
      } as any,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_a', sheet: sheetA, reason: 'system' }],
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(result).toEqual({ saved: false, error: expect.stringContaining('空 row_id') });
    expect(message).toEqual(messageBefore);
    expect(message.TavernDB_ACU_IsolatedData).toBe(isolatedDataBefore);
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'row_upsert 身份不一致',
      operations: [{ kind: 'row_upsert', sheetKey: 'sheet_a', rowId: '1', cells: ['2', 'new'] }],
      error: /回放失败.*身份不一致/i,
    },
    {
      label: 'row_upsert 行宽不匹配',
      operations: [{ kind: 'row_upsert', sheetKey: 'sheet_a', rowId: '1', cells: ['1'] }],
      error: /回放失败.*行宽不匹配/i,
    },
    {
      label: 'operation 回放后与 afterData 分叉',
      operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: '回放后的名称' } }],
      error: /回放结果与 afterData Sheet 不一致/i,
    },
  ])('通用 persist 在 $label 时写前拒绝且零副作用', async ({ operations, error }) => {
    const message = seedFrame({ logEntries: [] });
    message.TavernDB_ACU_Identity = 'identity-before-rejection';
    const isolatedDataBefore = message.TavernDB_ACU_IsolatedData;
    const messageBefore = JSON.parse(JSON.stringify(message));
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');

    const result = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } as any,
      filledSheetKeys: [],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: operations as any,
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(result).toEqual({ saved: false, error: expect.stringMatching(error) });
    expect(message).toEqual(messageBefore);
    expect(message.TavernDB_ACU_IsolatedData).toBe(isolatedDataBefore);
    expect(message.TavernDB_ACU_Identity).toBe('identity-before-rejection');
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'sql_batch',
      operation: { kind: 'sql_batch', statements: ["UPDATE inventory SET value = 'sql-updated' WHERE row_id = 1"] },
    },
    {
      label: 'sql_sheet_batch',
      operation: {
        kind: 'sql_sheet_batch', sheetKey: 'sheet_a',
        statements: ["UPDATE inventory SET value = 'sql-updated' WHERE row_id = 1"],
        tableName: 'inventory', reason: 'manual_crud',
      },
    },
  ])('通用 persist 接受可回放且满足 afterData 的 $label', async ({ operation }) => {
    const sqlBaseSheet = {
      ...sheetA,
      uid: 'inventory',
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, value TEXT);' },
    };
    const message = seedFrame({
      checkpoint: {
        kind: 'full', createdAt: 1, reason: 'init',
        data: { mate: { type: 'acu' }, sheet_a: sqlBaseSheet, sheet_b: sheetB },
      },
      logEntries: [],
    });
    const afterData = {
      mate: { type: 'acu' },
      sheet_a: { ...sqlBaseSheet, content: [['row_id', 'value'], ['1', 'sql-updated']] },
      sheet_b: sheetB,
    } as any;
    mocks.loadReplayState.mockResolvedValue({ mate: { type: 'acu' }, sheet_a: sqlBaseSheet, sheet_b: sheetB });
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');

    const result = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [operation] as any,
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(result.saved).toBe(true);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toHaveLength(1);
    expect(mocks.saveChat).toHaveBeenCalledOnce();
  });

  it('跨 replacement 范围裁剪旧 bucket 增量、追加新 entry，并只严格保存一次', async () => {
    const first = seedFrame({
      headRevision: '1:first-old',
      logEntries: [makeEntry({ seq: 1, commitRevision: '1:first-old', filledSheetKeys: ['sheet_a'], changedSheetKeys: ['sheet_a'], groupKeys: ['sheet_a'], operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_a', sheet: { ...sheetA, name: '旧 A' }, reason: 'system' }] })],
    });
    const second = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            headRevision: '2:target-old',
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } },
            logEntries: [makeEntry({ seq: 2, entryId: 'target-old', commitRevision: '2:target-old', filledSheetKeys: ['sheet_a'], changedSheetKeys: ['sheet_a'], groupKeys: ['sheet_a'], operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_a', sheet: { ...sheetA, name: '旧目标 A' }, reason: 'system' }] })],
          },
        },
      },
    };
    mocks.chat.splice(0, mocks.chat.length, first, second);
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');

    const result = await persistTableMutationLogV2_ACU(makeReplacementOptions(1));

    expect(result.saved).toBe(true);
    expect(mocks.saveChatStrict).toHaveBeenCalledOnce();
    expect(mocks.saveChat).not.toHaveBeenCalled();
    const firstFrame = first.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(firstFrame.logEntries).toEqual([]);
    expect(firstFrame.headRevision).toBeNull();
    const secondFrame = second.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(secondFrame.logEntries).toHaveLength(1);
    expect(secondFrame.logEntries[0]).toMatchObject({
      seq: 1,
      parentRevision: null,
      filledSheetKeys: ['sheet_a'],
      operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_a', sheet: sheetA, reason: 'system' }],
    });
    expect(secondFrame.headRevision).toBe(secondFrame.logEntries[0].commitRevision);
  });

  it('replacement 的严格保存失败时恢复所有目标消息的内存状态', async () => {
    const first = seedFrame({
      headRevision: '1:first-old',
      logEntries: [makeEntry({ seq: 1, commitRevision: '1:first-old', filledSheetKeys: ['sheet_a'], operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_a', sheet: sheetA, reason: 'system' }] })],
    });
    const second = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            headRevision: '2:target-old',
            checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } },
            logEntries: [makeEntry({ seq: 2, entryId: 'target-old', commitRevision: '2:target-old', filledSheetKeys: ['sheet_a'], operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_a', sheet: sheetA, reason: 'system' }] })],
          },
        },
      },
    };
    mocks.chat.splice(0, mocks.chat.length, first, second);
    const firstBefore = first.TavernDB_ACU_IsolatedData;
    const secondBefore = second.TavernDB_ACU_IsolatedData;
    mocks.saveChatStrict.mockRejectedValueOnce(new Error('host save failed'));
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');

    await expect(persistTableMutationLogV2_ACU(makeReplacementOptions(1))).rejects.toThrow('host save failed');

    expect(mocks.saveChatStrict).toHaveBeenCalledOnce();
    expect(first.TavernDB_ACU_IsolatedData).toBe(firstBefore);
    expect(second.TavernDB_ACU_IsolatedData).toBe(secondBefore);
  });
});


describe('persistTableSheetCheckpointV2_ACU', () => {
  beforeEach(() => {
    mocks.chat.length = 0;
    mocks.saveChat.mockReset().mockResolvedValue(undefined);
    mocks.saveChatStrict.mockReset().mockResolvedValue(undefined);
    mocks.collectSummary.mockClear();
    mocks.settings.dataIsolationEnabled = false;
    mocks.settings.dataIsolationCode = '';
    mocks.scopeContainer = { version: 1, template: { '': { old: true } } };
    mocks.guideContainer = { version: 1, tags: { '': { data: { sheet_old: {} } } } };
    mocks.setGuide.mockReset().mockImplementation(() => true);
    mocks.runTransaction.mockReset().mockImplementation(async (_options: any, task: any) => task({
      baseRevision: 'runtime-v1:test',
      assertFresh: vi.fn(),
      runCommit: async (commitTask: () => any) => commitTask(),
    }));
  });

  it('拒绝包含空 row_id 的普通 sheet checkpoint，且不修改聊天或保存', async () => {
    const message = seedFrame();
    message.TavernDB_ACU_Identity = 'identity-before-rejection';
    const isolatedDataBefore = message.TavernDB_ACU_IsolatedData;
    const messageBefore = JSON.parse(JSON.stringify(message));

    const result = await persistTableSheetCheckpointV2_ACU({
      targetMessageIndex: 0,
      sheetKey: 'sheet_a',
      sheetData: { ...sheetA, content: [['row_id', 'value'], ['', 'must-not-drop']] },
      reason: 'manual',
      transactionContext: makeTransaction(),
    });

    expect(result).toEqual({ saved: false, error: expect.stringContaining('空 row_id') });
    expect(message).toEqual(messageBefore);
    expect(message.TavernDB_ACU_IsolatedData).toBe(isolatedDataBefore);
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });


  it('写入目标 shard 且保持根 checkpoint、revision、日志、进度和其他 shard 不变', async () => {
    const message = seedFrame();
    const beforeFrame = JSON.parse(JSON.stringify(message.TavernDB_ACU_IsolatedData[''].storageFrame));
    const transaction = makeTransaction();
    const event = { filledSheetKeys: ['sheet_a'], changedSheetKeys: ['sheet_a'], groupKeys: ['sheet_a'] };

    const result = await persistTableSheetCheckpointV2_ACU({
      targetMessageIndex: 0, sheetKey: 'sheet_a', sheetData: sheetA, reason: 'manual', createdAt: 20,
      event, baseRevision: 'base-20', transactionContext: transaction,
    });

    expect(result.saved).toBe(true);
    expect(transaction.runCommit).toHaveBeenCalledWith(expect.any(Function), []);
    expect(transaction.assertFresh).toHaveBeenCalledWith('persistTableSheetCheckpointV2:before_persist');
    expect(mocks.saveChat).toHaveBeenCalledOnce();
    expect(mocks.collectSummary).toHaveBeenCalledWith(mocks.chat, '', { maxMessageIndex: 0 });
    const frame = message.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(frame.perSheetCheckpoints.sheet_a).toEqual({
      kind: 'sheet_full', createdAt: 20, reason: 'manual', sheetKey: 'sheet_a', data: sheetA,
      scheduleSummary: { lastFilledAiFloor: 7, lastChangedAiFloor: 6 }, event, baseRevision: 'base-20',
    });
    expect(frame.checkpoint).toEqual(beforeFrame.checkpoint);
    expect(frame.headRevision).toBe(beforeFrame.headRevision);
    expect(frame.logEntries).toEqual(beforeFrame.logEntries);
    expect(frame.manualRefillProgress).toEqual(beforeFrame.manualRefillProgress);
    expect(frame.perSheetCheckpoints.sheet_b).toEqual(beforeFrame.perSheetCheckpoints.sheet_b);

    sheetA.content[1][1] = 'caller-mutated';
    event.changedSheetKeys.push('sheet_b');
    expect(frame.perSheetCheckpoints.sheet_a.data.content[1][1]).toBe('new');
    expect(frame.perSheetCheckpoints.sheet_a.event.changedSheetKeys).toEqual(['sheet_a']);
    sheetA.content[1][1] = 'new';
  });

  it('宿主保存失败时恢复 isolated data 与 Identity，并继续抛出原错误', async () => {
    const message = seedFrame();
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    message.TavernDB_ACU_Identity = 'old-identity';
    mocks.settings.dataIsolationEnabled = true;
    mocks.settings.dataIsolationCode = 'new-identity';
    const saveError = new Error('host save failed');
    mocks.saveChat.mockRejectedValueOnce(saveError);

    await expect(persistTableSheetCheckpointV2_ACU({
      targetMessageIndex: 0,
      sheetKey: 'sheet_a',
      sheetData: sheetA,
      reason: 'manual',
      transactionContext: makeTransaction(),
    })).rejects.toBe(saveError);

    expect(mocks.saveChat).toHaveBeenCalledOnce();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBe('old-identity');
  });

  it('R1：没有 transactionContext 时拒绝直接写入', async () => {
    seedFrame();
    const result = await persistTableSheetCheckpointV2_ACU({ sheetKey: 'sheet_a', sheetData: sheetA, reason: 'manual' });
    expect(result).toEqual({ saved: false, error: expect.stringContaining('requires TableWriteTransactionContext') });
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  it.each([
    ['R6 非 sheet_ key', { sheetKey: 'mate', sheetData: sheetA, reason: 'manual' }, 'sheetKey beginning'],
    ['R7 sheetData 缺失', { sheetKey: 'sheet_a', sheetData: undefined, reason: 'manual' }, 'object sheetData'],
    ['R7 sheetData 非对象', { sheetKey: 'sheet_a', sheetData: [], reason: 'manual' }, 'object sheetData'],
    ['R8 reason 缺失', { sheetKey: 'sheet_a', sheetData: sheetA }, 'explicit checkpoint reason'],
  ])('%s 时拒绝且不保存', async (_name, partial, errorText) => {
    seedFrame();
    const result = await persistTableSheetCheckpointV2_ACU({ ...partial, transactionContext: makeTransaction() } as any);
    expect(result.saved).toBe(false);
    expect(result.error).toContain(errorText);
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  it.each([
    ['filledSheetKeys', makeEntry({ filledSheetKeys: ['sheet_a'] })],
    ['changedSheetKeys', makeEntry({ changedSheetKeys: ['sheet_a'] })],
    ['groupKeys', makeEntry({ groupKeys: ['sheet_a'] })],
    ['结构化 operation', makeEntry({ operations: [{ kind: 'row_delete', sheetKey: 'sheet_a', rowId: '1' }] })],
    ['legacy patch', makeEntry({ patches: [{ kind: 'row_delete', sheetKey: 'sheet_a', rowId: '1' }] })],
  ])('R9：目标 frame 已有目标表 %s 时拒绝', async (_name, entry) => {
    seedFrame({ logEntries: [entry] });
    const result = await persistTableSheetCheckpointV2_ACU({ sheetKey: 'sheet_a', sheetData: sheetA, reason: 'manual', transactionContext: makeTransaction() });
    expect(result.saved).toBe(false);
    expect(result.error).toContain('existing target-sheet log entry');
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  it.each(['data_replace', 'sql_batch', 'table_edit_dsl'])('R9：存在无法证明不影响目标表的 %s 时拒绝', async kind => {
    const operation = kind === 'data_replace'
      ? { kind, data: { mate: {}, sheet_a: sheetA }, reason: 'system' }
      : kind === 'sql_batch'
        ? { kind, statements: ['UPDATE anything SET value = 1'] }
        : { kind, text: 'unknown edit' };
    seedFrame({ logEntries: [makeEntry({ operations: [operation] })] });
    const result = await persistTableSheetCheckpointV2_ACU({ sheetKey: 'sheet_a', sheetData: sheetA, reason: 'manual', transactionContext: makeTransaction() });
    expect(result.saved).toBe(false);
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  it('R10：已有更新 createdAt 的同表 shard 时拒绝旧写覆盖', async () => {
    seedFrame({ perSheetCheckpoints: {
      sheet_a: { kind: 'sheet_full', createdAt: 30, reason: 'manual', sheetKey: 'sheet_a', data: sheetA },
      sheet_b: { kind: 'sheet_full', createdAt: 2, reason: 'manual', sheetKey: 'sheet_b', data: sheetB },
    } });
    const result = await persistTableSheetCheckpointV2_ACU({
      sheetKey: 'sheet_a', sheetData: sheetA, reason: 'manual', createdAt: 20, transactionContext: makeTransaction(),
    });
    expect(result.saved).toBe(false);
    expect(result.error).toContain('cannot replace a newer checkpoint');
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  it('目标 frame 早于最后一个 full checkpoint 时拒绝写入无效 shard', async () => {
    const earlyMessage = seedFrame({
      checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } },
      logEntries: [],
    });
    const laterFullMessage = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 10, reason: 'compaction', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } },
            logEntries: [],
          },
        },
      },
    };
    mocks.chat.splice(0, mocks.chat.length, earlyMessage, laterFullMessage);

    const result = await persistTableSheetCheckpointV2_ACU({ targetMessageIndex: 0, sheetKey: 'sheet_a', sheetData: sheetA, reason: 'manual', transactionContext: makeTransaction() });
    expect(result.saved).toBe(false);
    expect(result.error).toContain('precedes the latest full checkpoint');
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });

  it('没有根 full checkpoint 时拒绝仅写 shard', async () => {
    seedFrame({ checkpoint: undefined });
    const result = await persistTableSheetCheckpointV2_ACU({ sheetKey: 'sheet_a', sheetData: sheetA, reason: 'manual', transactionContext: makeTransaction() });
    expect(result.saved).toBe(false);
    expect(result.error).toContain('existing full checkpoint anchor');
    expect(mocks.saveChat).not.toHaveBeenCalled();
  });
});

describe('persistNullRowCleanupShards_ACU', () => {
  beforeEach(() => {
    mocks.chat.length = 0;
    mocks.saveChat.mockReset().mockResolvedValue(undefined);
    mocks.saveChatStrict.mockReset().mockResolvedValue(undefined);
    mocks.collectSummary.mockClear();
    mocks.settings.dataIsolationEnabled = false;
    mocks.settings.dataIsolationCode = '';
    mocks.runTransaction.mockReset().mockImplementation(async (_options: any, task: any) => task({
      baseRevision: 'runtime-v1:test',
      assertFresh: vi.fn(),
      runCommit: async (commitTask: () => any) => commitTask(),
    }));
  });

  it('在一次事务和一次严格宿主保存中批量写入受影响 shard，不写 guide 或根 frame 字段', async () => {
    const message = seedFrame({ logEntries: [] });
    const before = JSON.parse(JSON.stringify(message.TavernDB_ACU_IsolatedData[''].storageFrame));

    const result = await persistNullRowCleanupShards_ACU({
      sheetDataByKey: { sheet_a: sheetA, sheet_b: sheetB },
      createdAt: 30,
    });

    expect(result).toMatchObject({ status: 'persisted', messageIndex: 0 });
    expect(result.checkpoints).toHaveLength(2);
    expect(mocks.saveChatStrict).toHaveBeenCalledOnce();
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toEqual(before.checkpoint);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toEqual(before.logEntries);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.headRevision).toBe(before.headRevision);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toMatchObject({
      kind: 'sheet_full', reason: 'integrity_repair', createdAt: 30, sheetKey: 'sheet_a',
    });
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_b).toMatchObject({
      kind: 'sheet_full', reason: 'integrity_repair', createdAt: 30, sheetKey: 'sheet_b',
    });
    expect(mocks.setGuide).not.toHaveBeenCalled();
  });

  it('没有 full checkpoint anchor 时跳过且不创建 V2 checkpoint', async () => {
    const message = seedFrame({ checkpoint: undefined, logEntries: [] });

    const result = await persistNullRowCleanupShards_ACU({ sheetDataByKey: { sheet_a: sheetA } });

    expect(result).toEqual({ status: 'skipped_no_anchor' });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint).toBeUndefined();
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
  });

  it('最新 AI 楼层不是 V2 frame 时跳过，不把 legacy 目标隐式迁移为 V2', async () => {
    const anchor = seedFrame({ logEntries: [] });
    const legacyTarget = { is_user: false, TavernDB_ACU_IndependentData: { sheet_a: { legacy: true } } };
    mocks.chat.splice(0, mocks.chat.length, anchor, legacyTarget);

    const result = await persistNullRowCleanupShards_ACU({ sheetDataByKey: { sheet_a: sheetA } });

    expect(result).toEqual({ status: 'skipped_no_v2_target' });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(legacyTarget.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(legacyTarget.TavernDB_ACU_Identity).toBeUndefined();
    expect(anchor.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
  });

  it('commit 前 freshness conflict 时零写入、零保存且不报告已持久化', async () => {
    const message = seedFrame({ logEntries: [] });
    const original = message.TavernDB_ACU_IsolatedData;
    mocks.runTransaction.mockImplementationOnce(async (_options: any, task: any) => task({
      baseRevision: 'runtime-v1:stale',
      assertFresh: () => { throw new Error('runtime revision conflict'); },
      runCommit: async (commitTask: () => any) => commitTask(),
    }));

    const result = await persistNullRowCleanupShards_ACU({ sheetDataByKey: { sheet_a: sheetA } });

    expect(result).toEqual({ status: 'failed', error: 'runtime revision conflict' });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(original);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
  });

  it('严格宿主保存失败时恢复 isolated data 与 identity，并报告失败', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    message.TavernDB_ACU_Identity = 'old-identity';
    mocks.settings.dataIsolationEnabled = true;
    mocks.settings.dataIsolationCode = 'new-identity';
    mocks.saveChatStrict.mockRejectedValueOnce(new Error('host save failed'));

    const result = await persistNullRowCleanupShards_ACU({ sheetDataByKey: { sheet_a: sheetA } });

    expect(result).toEqual({ status: 'failed', error: 'host save failed' });
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(2);
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBe('old-identity');
  });

  it('提交与回滚宿主保存均失败时保留两个错误并恢复内存状态', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    message.TavernDB_ACU_Identity = 'old-identity';
    mocks.settings.dataIsolationEnabled = true;
    mocks.settings.dataIsolationCode = 'new-identity';
    mocks.saveChatStrict.mockRejectedValueOnce(new Error('commit save failed')).mockRejectedValueOnce(new Error('rollback save failed'));

    const result = await persistNullRowCleanupShards_ACU({ sheetDataByKey: { sheet_a: sheetA } });

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('commit save failed') });
    expect(result.error).toContain('rollback save failed');
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(2);
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBe('old-identity');
  });
});

describe('commitCurrentFloorTemplateChanges_ACU', () => {
  beforeEach(() => {
    mocks.chat.length = 0;
    mocks.saveChat.mockReset().mockResolvedValue(undefined);
    mocks.saveChatStrict.mockReset().mockResolvedValue(undefined);
    mocks.collectSummary.mockClear();
    mocks.settings.dataIsolationEnabled = false;
    mocks.settings.dataIsolationCode = '';
    mocks.scopeContainer = { version: 1, template: { '': { old: true } } };
    mocks.guideContainer = { version: 1, tags: { '': { data: { sheet_old: {} } } } };
    mocks.loadReplayState.mockReset();
    mocks.setGuide.mockReset().mockImplementation(() => true);
    mocks.runTransaction.mockReset().mockImplementation(async (_options: any, task: any) => task({
      baseRevision: 'runtime-v1:test',
      assertFresh: vi.fn(),
      runCommit: async (commitTask: () => any) => commitTask(),
    }));
  });

  it('pristine 聊天保存完整模板快照时只提交 guide/template scope，不创建 V2 checkpoint', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);
    const templateSource = { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource,
      syncTemplateScope: true,
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: true, mode: 'template_only', messageIndex: 0, checkpoints: [], removedNullRowCount: 0 });
    expect(mocks.loadReplayState).not.toHaveBeenCalled();
    expect(mocks.saveChatStrict).toHaveBeenCalledOnce();
    expect(mocks.setGuide).toHaveBeenCalledOnce();
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBeUndefined();
  });

  it('尚无 full checkpoint 且缺少完整 templateSource 时拒绝并保持消息不变', async () => {
    const message = { is_user: false, marker: 'unchanged' } as any;
    mocks.chat.push(message);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' } },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('完整有效的 templateSource') });
    expect(message).toEqual({ is_user: false, marker: 'unchanged' });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
  });

  it('尚无 full checkpoint 时拒绝非法 mate，且不创建 storage frame', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource: { mate: null, sheet_a: sheetA, sheet_b: sheetB },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('templateSource.mate 无效') });
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
  });

  it('尚无 full checkpoint 时拒绝未参与变更的畸形 Sheet', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: { ...sheetB, content: 'invalid' } },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('无效 Sheet：sheet_b') });
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });

  it('尚无 full checkpoint 时拒绝未参与变更 Sheet 的 DDL 与表头不一致', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);
    const invalidSheetB = {
      ...sheetB,
      sourceData: { ddl: 'CREATE TABLE b (row_id INTEGER PRIMARY KEY, missing TEXT);' },
    };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: invalidSheetB },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('DDL 无法 strict hydrate：sheet_b') });
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });

  it('尚无 full checkpoint 时通过静态映射但真实 SQLite hydrate 失败仍拒绝保存', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);
    const hydrateInvalidSheetB = {
      ...sheetB,
      content: [['row_id', 'value'], ['1', null]],
      sourceData: { ddl: 'CREATE TABLE b (row_id INTEGER PRIMARY KEY, value TEXT CHECK (value IS NOT NULL));' },
    };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: hydrateInvalidSheetB },
    });

    expect(result).toMatchObject({
      saved: false,
      error: expect.stringContaining('完整 templateSource 无法通过 SQLite strict hydrate'),
    });
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
  });

  it('尚无 full checkpoint 时拒绝 templateSource 与 guideData 的 Sheet 集合不一致', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] }],
      guideData: { sheet_a: { name: 'A' } },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('Sheet 集合不一致') });
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });

  it('尚无 full checkpoint 时按规范化后的 guideData 拒绝会被丢弃的 Sheet', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: null },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('Sheet 集合不一致') });
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
  });

  it('template-only 严格保存失败时不创建 storage frame 或 identity', async () => {
    const message = { is_user: false, TavernDB_ACU_Identity: 'old-identity' } as any;
    mocks.chat.push(message);
    mocks.settings.dataIsolationEnabled = true;
    mocks.settings.dataIsolationCode = 'new-identity';
    mocks.saveChatStrict.mockRejectedValueOnce(new Error('initial template save failed')).mockResolvedValueOnce(undefined);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: 'initial template save failed' });
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(2);
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBe('old-identity');
  });

  it('连续 template-only 保存始终不创建 V2 数据或 identity', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);
    const templateSource = { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB };
    const options = {
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations' as const,
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update' as const, sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource,
      syncTemplateScope: true,
    };

    const first = await commitCurrentFloorTemplateChanges_ACU(options);
    const second = await commitCurrentFloorTemplateChanges_ACU(options);

    expect(first).toMatchObject({ saved: true, mode: 'template_only' });
    expect(second).toMatchObject({ saved: true, mode: 'template_only' });
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(2);
    expect(mocks.setGuide).toHaveBeenCalledTimes(2);
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBeUndefined();
  });

  it('template-only 仅传递目标 isolation 的 guide/scope 更新请求', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: 'isolated-template',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB },
      syncTemplateScope: true,
    });

    expect(result).toMatchObject({ saved: true, mode: 'template_only' });
    expect(mocks.setGuide).toHaveBeenCalledWith('isolated-template', expect.any(Object), expect.objectContaining({
      syncTemplateScope: true,
      templateSource: expect.any(Object),
    }));
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBeUndefined();
  });

  it('template-only guide/scope 写入失败时恢复两个容器且不保存宿主', async () => {
    const message = { is_user: false } as any;
    mocks.chat.push(message);
    const originalScope = JSON.parse(JSON.stringify(mocks.scopeContainer));
    const originalGuide = JSON.parse(JSON.stringify(mocks.guideContainer));
    mocks.setGuide.mockImplementation(() => {
      mocks.scopeContainer = { version: 1, template: { '': { changed: true } } };
      mocks.guideContainer = { version: 1, tags: { '': { changed: true } } };
      return false;
    });

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: sheetA,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('无法原子写入 guideData 与 template scope') });
    expect(mocks.saveChatStrict).toHaveBeenCalledOnce();
    expect(mocks.scopeContainer).toEqual(originalScope);
    expect(mocks.guideContainer).toEqual(originalGuide);
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(message.TavernDB_ACU_Identity).toBeUndefined();
  });

  it('template-only 后首次真实数据写入才创建唯一 full/init checkpoint，且使用当次完整 afterData', async () => {
    const { persistTableMutationLogV2_ACU } = await import('../../../src/service/table/storage-frame-v2-persist');
    const message = { is_user: false } as any;
    mocks.chat.push(message);
    const templateSource = {
      mate: { type: 'acu' },
      sheet_a: { ...sheetA, content: [['row_id', 'value']] },
      sheet_b: sheetB,
    };

    const templateResult = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: templateSource.sheet_a,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      templateSource,
    });

    expect(templateResult).toMatchObject({ saved: true, mode: 'template_only' });
    expect(message.TavernDB_ACU_IsolatedData).toBeUndefined();

    const afterData = {
      mate: { type: 'acu' },
      sheet_a: { ...sheetA, content: [['row_id', 'value'], ['1', 'first-real-data']] },
      sheet_b: sheetB,
    } as any;
    const firstWrite = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [],
      checkpointReason: 'init',
      forceCheckpoint: true,
      strictSave: true,
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(firstWrite.saved).toBe(true);
    const frame = message.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(frame.checkpoint).toMatchObject({ kind: 'full', reason: 'init', data: afterData });
    expect(frame.logEntries).toEqual([]);

    const firstImportMessage = { is_user: false } as any;
    mocks.chat.splice(0, mocks.chat.length, firstImportMessage);
    mocks.saveChat.mockClear();
    mocks.saveChatStrict.mockClear();
    const firstImport = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'import',
      afterData,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [],
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(firstImport.saved).toBe(true);
    expect(firstImportMessage.TavernDB_ACU_IsolatedData[''].storageFrame).toMatchObject({
      checkpoint: { kind: 'full', reason: 'init', data: afterData },
      logEntries: [],
    });
    expect(mocks.saveChat).toHaveBeenCalledOnce();

    const historicalImportMessage = { is_user: false } as any;
    const futureCheckpointMessage = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: { kind: 'full', createdAt: 2, reason: 'init', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } },
            logEntries: [],
          },
        },
      },
    } as any;
    mocks.chat.splice(0, mocks.chat.length, historicalImportMessage, futureCheckpointMessage);
    mocks.saveChat.mockClear();
    const historicalImport = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'import',
      afterData,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [],
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(historicalImport.saved).toBe(true);
    expect(historicalImportMessage.TavernDB_ACU_IsolatedData[''].storageFrame).toMatchObject({
      checkpoint: { kind: 'full', reason: 'init', data: afterData },
      logEntries: [],
    });
    expect(futureCheckpointMessage.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data).toEqual({
      mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB,
    });
    expect(mocks.saveChat).toHaveBeenCalledOnce();

    const incrementalImportMessage = seedFrame({ logEntries: [] });
    mocks.loadReplayState.mockResolvedValue({ mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB });
    mocks.saveChat.mockClear();
    const incrementalAfterData = {
      mate: { type: 'acu' },
      sheet_a: { ...sheetA, name: 'imported-sheet-a' },
      sheet_b: sheetB,
    } as any;
    const incrementalImport = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'import',
      afterData: incrementalAfterData,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [],
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(incrementalImport.saved).toBe(true);
    expect(incrementalImportMessage.TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toMatchObject([
      { operations: [{ kind: 'data_replace', data: incrementalAfterData, reason: 'import' }] },
    ]);
    expect(mocks.saveChat).toHaveBeenCalledOnce();

    const rejectedInitialMessage = { is_user: false } as any;
    mocks.chat.splice(0, mocks.chat.length, rejectedInitialMessage);
    const initialSnapshot = JSON.parse(JSON.stringify(rejectedInitialMessage));
    const rejectedInitialIsolatedData = rejectedInitialMessage.TavernDB_ACU_IsolatedData;
    mocks.saveChat.mockClear();
    mocks.saveChatStrict.mockClear();
    for (const operation of [
      { kind: 'row_upsert', sheetKey: 'sheet_a', rowId: '1', cells: ['2', 'identity-mismatch'] },
      { kind: 'row_upsert', sheetKey: 'sheet_a', rowId: '1', cells: ['1'] },
      { kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'unreplayed-change' } },
    ]) {
      const result = await persistTableMutationLogV2_ACU({
        targetMessageIndex: 0,
        source: 'manual_fill',
        afterData,
        filledSheetKeys: ['sheet_a'],
        candidateChangedSheetKeys: ['sheet_a'],
        operations: [operation] as any,
        checkpointReason: 'init',
        forceCheckpoint: true,
        transactionContext: makeTransaction(),
        assumeCommitLock: true,
      });

      expect(result).toEqual({ saved: false, error: expect.stringContaining('初始 full checkpoint 不接受 operations') });
      expect(rejectedInitialMessage).toEqual(initialSnapshot);
      expect(rejectedInitialMessage.TavernDB_ACU_IsolatedData).toBe(rejectedInitialIsolatedData);
      expect(mocks.saveChat).not.toHaveBeenCalled();
      expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    }

    mocks.chat.splice(0, mocks.chat.length, message);
    mocks.loadReplayState.mockResolvedValue(afterData);
    const secondWrite = await persistTableMutationLogV2_ACU({
      targetMessageIndex: 0,
      source: 'manual_fill',
      afterData,
      filledSheetKeys: ['sheet_a'],
      candidateChangedSheetKeys: ['sheet_a'],
      operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }],
      checkpointReason: 'init',
      forceCheckpoint: true,
      strictSave: true,
      transactionContext: makeTransaction(),
      assumeCommitLock: true,
    });

    expect(secondWrite.saved).toBe(true);
    const persistedFrame = message.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(persistedFrame.checkpoint).toMatchObject({ kind: 'full', reason: 'init', data: afterData });
    expect(persistedFrame.logEntries).toHaveLength(1);
  });

  it('在最新 AI 楼层原子追加多个既有 Sheet operation 与 guide，并且严格保存一次', async () => {
    const message = seedFrame({ logEntries: [] });
    const guideData = { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [
        { kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] },
        { kind: 'operations', sheetKey: 'sheet_b', targetSheetData: sheetB, operations: [{ kind: 'meta_update', sheetKey: 'sheet_b', meta: { name: 'B' } }] },
      ],
      guideData,
      syncTemplateScope: true,
      createdAt: 30,
    });

    expect(result.saved).toBe(true);
    expect(result.messageIndex).toBe(0);
    expect(mocks.saveChatStrict).toHaveBeenCalledOnce();
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.setGuide).toHaveBeenCalledWith('', guideData, expect.objectContaining({
      syncTemplateScope: true,
      updatedAt: 30,
    }));
    const frame = message.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(frame.perSheetCheckpoints.sheet_a).toBeUndefined();
    expect(frame.perSheetCheckpoints.sheet_b).toBeDefined();
    expect(frame.logEntries).toHaveLength(1);
    expect(frame.logEntries[0]).toMatchObject({
      seq: 1, source: 'template_assistant', filledSheetKeys: [], changedSheetKeys: ['sheet_a', 'sheet_b'], groupKeys: [],
      operations: [
        { kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } },
        { kind: 'meta_update', sheetKey: 'sheet_b', meta: { name: 'B' } },
      ],
    });
  });

  it('当前 frame 已有目标 Sheet 日志时将 migration 和 meta_update 追加到尾部且不创建旧 Sheet checkpoint', async () => {
    const beforeSheet = {
      uid: 'inventory', name: '旧背包', orderNo: 0,
      content: [['row_id', '名称'], ['1', '铁剑']],
      sourceData: { ddl: 'CREATE TABLE inventory (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  item_name TEXT -- 名称\n);', note: '旧说明' },
      updateConfig: {}, exportConfig: {},
    } as any;
    const migratedSheet = {
      ...beforeSheet,
      content: [['row_id', '名称', '品质'], ['1', '铁剑', null]],
      sourceData: { ...beforeSheet.sourceData, ddl: 'CREATE TABLE inventory (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  item_name TEXT, -- 名称\n  quality TEXT -- 品质\n);' },
    } as any;
    const targetSheet = {
      ...migratedSheet,
      name: '新背包',
      orderNo: 4,
      sourceData: { ...migratedSheet.sourceData, note: '新说明' },
    } as any;
    const migration = await buildSheetSchemaMigrationOperation_ACU('sheet_a', beforeSheet, migratedSheet);
    const existingEntry = makeEntry({
      seq: 7,
      entryId: 'existing-target-entry',
      changedSheetKeys: ['sheet_a'],
      operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: '旧背包' } }],
    });
    const message = seedFrame({
      checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: { mate: { type: 'acu' }, sheet_a: beforeSheet, sheet_b: sheetB } },
      logEntries: [existingEntry],
      perSheetCheckpoints: { sheet_b: { kind: 'sheet_full', createdAt: 2, reason: 'manual', sheetKey: 'sheet_b', data: sheetB } },
    });
    mocks.loadReplayState.mockResolvedValue({ mate: { type: 'acu' }, sheet_a: beforeSheet, sheet_b: sheetB });

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: targetSheet,
        operations: [
          migration,
          { kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: '新背包', orderNo: 4, sourceData: { note: '新说明' } } },
        ],
      }],
      guideData: { sheet_a: { name: '新背包' }, sheet_b: { name: 'B' } },
      createdAt: 30,
    });

    expect(result.saved).toBe(true);
    const frame = message.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(frame.logEntries[0]).toEqual(existingEntry);
    expect(frame.logEntries[1]).toMatchObject({
      seq: 8,
      source: 'template_assistant',
      changedSheetKeys: ['sheet_a'],
      operations: [
        expect.objectContaining({ kind: 'sheet_schema_migrate', sheetKey: 'sheet_a' }),
        { kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: '新背包', orderNo: 4, sourceData: { note: '新说明' } } },
      ],
    });
    expect(frame.headRevision).toBe(frame.logEntries[1].commitRevision);
    expect(frame.perSheetCheckpoints.sheet_a).toBeUndefined();
  });

  it('同批 introduction 与已有 Sheet migration 使用旧尾 seq 激活并将 operation 写入下一 seq', async () => {
    const beforeSheet = {
      uid: 'inventory', name: '背包', orderNo: 0,
      content: [['row_id', '名称'], ['1', '铁剑']],
      sourceData: { ddl: 'CREATE TABLE inventory (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  item_name TEXT -- 名称\n);' },
      updateConfig: {}, exportConfig: {},
    } as any;
    const targetSheet = {
      ...beforeSheet,
      content: [['row_id', '名称', '品质'], ['1', '铁剑', null]],
      sourceData: { ddl: 'CREATE TABLE inventory (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  item_name TEXT, -- 名称\n  quality TEXT -- 品质\n);' },
    } as any;
    const migration = await buildSheetSchemaMigrationOperation_ACU('sheet_a', beforeSheet, targetSheet);
    const introducedSheet = { ...sheetB, uid: 'new_sheet', name: '新增表', content: [['row_id', 'value']] } as any;
    const message = seedFrame({
      checkpoint: { kind: 'full', createdAt: 1, reason: 'init', data: { mate: { type: 'acu' }, sheet_a: beforeSheet, sheet_b: sheetB } },
      logEntries: [makeEntry({ seq: 7 })],
      perSheetCheckpoints: {},
    });
    mocks.loadReplayState.mockResolvedValue({ mate: { type: 'acu' }, sheet_a: beforeSheet, sheet_b: sheetB });

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [
        { kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet },
        { kind: 'operations', sheetKey: 'sheet_a', targetSheetData: targetSheet, operations: [migration] },
      ],
      guideData: { sheet_a: { name: '背包' }, sheet_b: { name: 'B' }, sheet_new: { name: '新增表' } },
      createdAt: 30,
    });

    expect(result.saved).toBe(true);
    const frame = message.TavernDB_ACU_IsolatedData[''].storageFrame;
    expect(frame.perSheetCheckpoints.sheet_new.timeline).toEqual({ kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 7 });
    expect(frame.logEntries[1]).toMatchObject({ seq: 8, operations: [expect.objectContaining({ kind: 'sheet_schema_migrate', sheetKey: 'sheet_a' })] });
  });

  it('新增 sheet 在目标 frame 尾部日志后写入 introduction timeline', async () => {
    const introducedSheet = { ...sheetB, uid: 'introduced', name: '新增表' };
    const message = seedFrame({
      logEntries: [makeEntry({
        seq: 7,
        operations: [{ kind: 'data_replace', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB }, reason: 'system' }],
      })],
    });

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '新增表' } },
      createdAt: 30,
    });

    expect(result.saved).toBe(true);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toMatchObject({
      kind: 'sheet_full', sheetKey: 'sheet_new',
      timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 0, afterSeq: 7 },
    });
  });

  it('历史 full checkpoint 后的正常增量 frame 继续走 V2 commit', async () => {
    const historicalMessage = seedFrame({ logEntries: [], perSheetCheckpoints: {} });
    const targetMessage = seedFrame({ checkpoint: undefined, logEntries: [], perSheetCheckpoints: {} });
    mocks.chat.splice(0, mocks.chat.length, historicalMessage, targetMessage);
    mocks.loadReplayState.mockResolvedValue(historicalMessage.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data);
    const introducedSheet = { ...sheetB, uid: 'incremental-after-checkpoint', name: 'checkpoint 后新增表' };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: 'checkpoint 后新增表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: true, mode: 'v2_commit' });
    expect(mocks.saveChatStrict).toHaveBeenCalledOnce();
    expect(targetMessage.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toMatchObject({
      kind: 'sheet_full',
      sheetKey: 'sheet_new',
      timeline: { kind: 'sheet_introduction', activateAtMessageIndex: 1, afterSeq: 0 },
    });
  });

  it('全历史没有 full checkpoint 的 V2 frame 时 fail closed，不覆盖 orphan 状态', async () => {
    const message = seedFrame({ checkpoint: undefined, logEntries: [], perSheetCheckpoints: {} });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const introducedSheet = { ...sheetB, uid: 'orphan-v2-frame', name: '无根 V2 表' };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '无根 V2 表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('缺少 full checkpoint 的 V2 存储痕迹') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toBeUndefined();
  });

  it('既有 full checkpoint 或当前 shard 的 sheet 被标为新增时受控拒绝且零写入', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const headerOnlySheetA = { ...sheetA, content: [sheetA.content[0]] };
    const headerOnlySheetB = { ...sheetB, content: [sheetB.content[0]] };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [
        { kind: 'introduction', sheetKey: 'sheet_a', sheetData: headerOnlySheetA },
        { kind: 'introduction', sheetKey:'sheet_b', sheetData: headerOnlySheetB },
      ],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('genuinely new sheet') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
  });

  it('replay state 已存在同名 sheet 但 target frame 无 shard 时拒绝 introduction 且零写入', async () => {
    const message = seedFrame({ logEntries: [], perSheetCheckpoints: {} });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const introducedSheet = { ...sheetB, uid: 'replayed-sheet', name: '历史已存在表' };
    mocks.loadReplayState.mockResolvedValue({
      ...message.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data,
      sheet_new: introducedSheet,
    });

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '历史已存在表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('genuinely new sheet') });
    expect(mocks.loadReplayState).toHaveBeenCalledWith(mocks.chat, '', { maxMessageIndex: 0, updateRuntimeState: false });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
  });

  it('历史 full checkpoint 曾存在且后续 data_replace 删除同名 sheet 时拒绝 introduction 且零写入', async () => {
    const historicalSheet = { ...sheetB, uid: 'historical-sheet', name: '已删除历史表' };
    const historicalMessage = seedFrame({
      checkpoint: {
        kind: 'full', createdAt: 1, reason: 'init',
        data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB, sheet_new: historicalSheet },
      },
      logEntries: [],
      perSheetCheckpoints: {},
    });
    const targetMessage = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          _acu_storage_version: 2,
          storageFrame: {
            version: 2,
            checkpoint: {
              kind: 'full', createdAt: 2, reason: 'system',
              data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB },
            },
            logEntries: [makeEntry({
              operations: [{ kind: 'data_replace', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB }, reason: 'system' }],
            })],
            perSheetCheckpoints: {},
          },
        },
      },
    };
    mocks.chat.splice(0, mocks.chat.length, historicalMessage, targetMessage);
    mocks.loadReplayState.mockResolvedValue(targetMessage.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data);
    const originalIsolatedData = targetMessage.TavernDB_ACU_IsolatedData;

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: historicalSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '已删除历史表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('genuinely new sheet') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(targetMessage.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(targetMessage.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toBeUndefined();
  });

  it('带业务行的新 sheet 不能作为 introduction 且零写入', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const sheetWithDataRow = { ...sheetB, uid: 'new-with-data', name: '含数据新表', content: [['row_id', 'value'], ['1', '业务数据']] };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: sheetWithDataRow }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '含数据新表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('header-only') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toBeUndefined();
  });

  it.each([
    ['伪造 sheetKey 的全局 sql_batch', { kind: 'sql_batch', sheetKey: 'sheet_other', statements: ['UPDATE any_table SET value = 1'] }],
    ['伪造 sheetKey 的全局 table_edit_dsl', { kind: 'table_edit_dsl', sheetKey: 'sheet_other', text: '更新表格：任意表' }],
    ['伪造 sheetKey 的未知 operation', { kind: 'future_unknown_operation', sheetKey: 'sheet_other' }],
    ['缺少 rowId 的单表 operation', { kind: 'row_delete', sheetKey: 'sheet_other' }],
  ])('无法证明安全的历史 %s 时拒绝 introduction 且零写入', async (_label, operation) => {
    const message = seedFrame({
      logEntries: [makeEntry({ operations: [operation] })],
      perSheetCheckpoints: {},
    });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const introducedSheet = { ...sheetB, uid: `unsafe-history-${_label}`, name: '新增表' };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '新增表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('genuinely new sheet') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toBeUndefined();
  });

  it.each([
    ['logEntries 非数组', { logEntries: null }],
    ['perSheetCheckpoints 非对象', { logEntries: [], perSheetCheckpoints: [] }],
  ])('带 V2 标记的畸形历史 frame：%s 时拒绝 introduction 且零写入', async (_label, frameOverrides) => {
    const historicalMessage = seedFrame(frameOverrides);
    const targetMessage = seedFrame({ logEntries: [], perSheetCheckpoints: {} });
    mocks.chat.splice(0, mocks.chat.length, historicalMessage, targetMessage);
    mocks.loadReplayState.mockResolvedValue(targetMessage.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data);
    const originalIsolatedData = targetMessage.TavernDB_ACU_IsolatedData;
    const introducedSheet = { ...sheetB, uid: `malformed-history-${_label}`, name: '新增表' };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '新增表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('genuinely new sheet') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(targetMessage.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(targetMessage.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toBeUndefined();
  });

  it.each([
    ['缺少 createdAt 的 full checkpoint', { checkpoint: { kind: 'full', reason: 'init', data: { mate: { type: 'acu' }, sheet_a: sheetA, sheet_b: sheetB } } }],
    ['缺少 reason 的 sheet checkpoint', { perSheetCheckpoints: { sheet_other: { kind: 'sheet_full', sheetKey: 'sheet_other', createdAt: 1, data: sheetB } } }],
    ['V2 marker 与 frame version 不一致', { version: 1, logEntries: [] }],
    ['缺少 entry 必填字段', { logEntries: [{ operations: [{ kind: 'row_delete', sheetKey: 'sheet_other', rowId: '1' }] }] }],
    ['空 sheet_replace sheet', { logEntries: [makeEntry({ operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_other', sheet: {}, reason: 'system' }] })] }],
    ['空 schema migration descriptor', { logEntries: [makeEntry({ operations: [{ kind: 'sheet_schema_migrate', sheetKey: 'sheet_other', contractVersion: 1, beforeSchemaDigest: 'before', targetSchemaDigest: 'after', beforeSchema: {}, targetSchema: {}, columnChanges: [], migrationPolicy: { destructiveChangeConfirmed: false } }] })] }],
    ['畸形 sql_sheet_batch', { logEntries: [makeEntry({ operations: [{ kind: 'sql_sheet_batch', sheetKey: 'sheet_other', statements: [123] }] })] }],
    ['畸形 schema migration', { logEntries: [makeEntry({ operations: [{ kind: 'sheet_schema_migrate', sheetKey: 'sheet_other', contractVersion: 999 }] })] }],
    ['畸形 row_upsert cells', { logEntries: [makeEntry({ operations: [{ kind: 'row_upsert', sheetKey: 'sheet_other', rowId: '1', cells: [1] }] })] }],
    ['未知 legacy patch', { logEntries: [makeEntry({ patches: [{ kind: 'future_unknown_patch', sheetKey: 'sheet_other' }] })] }],
  ])('不完整的历史 persisted contract：%s 时拒绝 introduction 且零写入', async (_label, frameOverrides) => {
    const historicalMessage = seedFrame(frameOverrides);
    const targetMessage = seedFrame({ logEntries: [], perSheetCheckpoints: {} });
    mocks.chat.splice(0, mocks.chat.length, historicalMessage, targetMessage);
    mocks.loadReplayState.mockResolvedValue(targetMessage.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data);
    const originalIsolatedData = targetMessage.TavernDB_ACU_IsolatedData;
    const introducedSheet = { ...sheetB, uid: `incomplete-contract-${_label}`, name: '新增表' };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '新增表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('genuinely new sheet') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(targetMessage.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(targetMessage.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_new).toBeUndefined();
  });

  it.each([
    { label: '重复', entries: [makeEntry({ seq: 7 }), makeEntry({ seq: 7, entryId: 'entry-2' })], error: '唯一且严格递增' },
    { label: '倒序', entries: [makeEntry({ seq: 8 }), makeEntry({ seq: 7, entryId: 'entry-2' })], error: '唯一且严格递增' },
    { label: '非法', entries: [makeEntry({ seq: -1 })], error: '非法 log seq' },
  ])('目标 frame log seq $label 时拒绝 introduction 且零写入', async ({ entries, error }) => {
    const message = seedFrame({ logEntries: entries });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const introducedSheet = { ...sheetB, uid: `introduced-${entries[0].seq}`, name: '新增表' };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'introduction', sheetKey: 'sheet_new', sheetData: introducedSheet }],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' }, sheet_new: { name: '新增表' } },
      createdAt: 30,
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining(error) });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
  });

  it.each([
    ['空 operations', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [] }]],
    ['operation sheetKey 不一致', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_b', meta: { name: 'A' } }] }]],
    ['非法 operation kind', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_a', rowId: '1', cells: ['1', 'x'] }] }]],
    ['meta_update meta 不是普通对象', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: [] }] }]],
    ['meta_update meta 是 Date', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: new Date(0) }] }]],
    ['meta_update meta 是 class instance', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: new (class MetaPatch { name = 'A'; })() }] }]],
    ['meta_update sourceData 不是普通对象', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { sourceData: [] } }] }]],
    ['meta_update sourceData 是 Map', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { sourceData: new Map() } }] }]],
    ['meta_update updateConfig 是 Set', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { updateConfig: new Set() } }] }]],
    ['meta_update 包含非法字段', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { content: [] } }] }]],
    ['meta_update name 类型错误', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 1 } }] }]],
    ['重复 action', [
      { kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] },
      { kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { orderNo: 1 } }] },
    ]],
    ['meta_update 携带 ddl', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { sourceData: { ddl: 'unsafe' } } }] }]],
    ['畸形 migration', [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'sheet_schema_migrate', sheetKey: 'sheet_a', contractVersion: 999 }] }]],
  ])('%s 时在事务写入前 fail closed', async (_label, sheetChanges) => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: sheetChanges as any,
      guideData: { sheet_a: { name: 'A' } },
    });

    expect(result.saved).toBe(false);
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
  });

  it('operation 回放结果与 targetSheetData 不一致时零写入', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const mismatchedTarget = { ...sheetA, name: '目标名称' };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{
        kind: 'operations',
        sheetKey: 'sheet_a',
        targetSheetData: mismatchedTarget,
        operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: '另一个名称' } }],
      }],
      guideData: { sheet_a: { name: '目标名称' } },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('回放结果与目标 Sheet 不一致') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
  });

  it('严格保存失败时回滚 introduction shard、operation entry、headRevision、identity、guide 与 scope', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const originalFrame = JSON.parse(JSON.stringify(originalIsolatedData[''].storageFrame));
    message.TavernDB_ACU_Identity = 'old-identity';
    const originalScope = JSON.parse(JSON.stringify(mocks.scopeContainer));
    const originalGuide = JSON.parse(JSON.stringify(mocks.guideContainer));
    mocks.settings.dataIsolationEnabled = true;
    mocks.settings.dataIsolationCode = 'new-identity';
    mocks.setGuide.mockImplementation(() => {
      mocks.scopeContainer.template[''].changed = true;
      mocks.guideContainer.tags[''].changed = true;
      return true;
    });
    mocks.saveChatStrict.mockRejectedValueOnce(new Error('host save failed'));

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [
        { kind: 'introduction', sheetKey: 'sheet_new', sheetData: { ...sheetB, uid: 'new-sheet', name: '新增表' } },
        { kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] },
      ],
      guideData: { sheet_a: { name: 'A' } },
      syncTemplateScope: true,
    });

    expect(result).toEqual({ saved: false, error: 'host save failed' });
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(2);
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame).toEqual(originalFrame);
    expect(message.TavernDB_ACU_Identity).toBe('old-identity');
    expect(mocks.scopeContainer).toEqual(originalScope);
    expect(mocks.guideContainer).toEqual(originalGuide);
  });

  it('提交与回滚宿主保存均失败时组合两个错误并恢复模板提交内存状态', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const originalFrame = JSON.parse(JSON.stringify(originalIsolatedData[''].storageFrame));
    message.TavernDB_ACU_Identity = 'old-identity';
    const originalScope = JSON.parse(JSON.stringify(mocks.scopeContainer));
    const originalGuide = JSON.parse(JSON.stringify(mocks.guideContainer));
    mocks.settings.dataIsolationEnabled = true;
    mocks.settings.dataIsolationCode = 'new-identity';
    mocks.setGuide.mockImplementation(() => {
      mocks.scopeContainer.template[''].changed = true;
      mocks.guideContainer.tags[''].changed = true;
      return true;
    });
    mocks.saveChatStrict
      .mockRejectedValueOnce(new Error('commit save failed'))
      .mockRejectedValueOnce(new Error('rollback save failed'));

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [
        { kind: 'introduction', sheetKey: 'sheet_new', sheetData: { ...sheetB, uid: 'new-sheet', name: '新增表' } },
        { kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] },
      ],
      guideData: { sheet_a: { name: 'A' } },
      syncTemplateScope: true,
    });

    expect(result.saved).toBe(false);
    expect(result.error).toContain('commit save failed');
    expect(result.error).toContain('rollback save failed');
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(2);
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame).toEqual(originalFrame);
    expect(message.TavernDB_ACU_Identity).toBe('old-identity');
    expect(mocks.scopeContainer).toEqual(originalScope);
    expect(mocks.guideContainer).toEqual(originalGuide);
  });

  it('仅删表时在一次严格保存内清理全聊天 V2、全部隔离槽和 legacy 数据', async () => {
    const historical = seedFrame({ logEntries: [makeEntry({ operations: [{ kind: 'sheet_replace', sheetKey: 'sheet_b', sheet: sheetB, reason: 'system' }] })] });
    historical.TavernDB_ACU_IsolatedData.archive = {
      _acu_storage_version: 2,
      storageFrame: JSON.parse(JSON.stringify(historical.TavernDB_ACU_IsolatedData[''].storageFrame)),
      independentData: { sheet_b: { archived: true } },
      modifiedKeys: ['sheet_b'],
      updateGroupKeys: ['sheet_b'],
    };
    historical.TavernDB_ACU_IndependentData = { sheet_b: { legacy: true } };
    historical.TavernDB_ACU_Data = { sheet_b: { legacy: true } };
    historical.TavernDB_ACU_SummaryData = { sheet_b: { legacy: true } };
    historical.TavernDB_ACU_ModifiedKeys = ['sheet_b'];
    historical.TavernDB_ACU_UpdateGroupKeys = ['sheet_b'];
    const target = seedFrame({ logEntries: [] });
    mocks.chat.splice(0, mocks.chat.length, historical, target);
    mocks.loadReplayState.mockResolvedValue(target.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data);

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '', sheetChanges: [], deletedSheetKeys: ['sheet_b'], guideData: { sheet_a: { name: 'A' } }, createdAt: 30,
    });

    expect(result).toMatchObject({ saved: true, mode: 'v2_commit', deletedSheetKeys: ['sheet_b'], purgedMessageCount: 2, checkpoints: [] });
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(1);
    for (const tagData of Object.values(historical.TavernDB_ACU_IsolatedData) as any[]) {
      expect(tagData.independentData?.sheet_b).toBeUndefined();
      expect(tagData.storageFrame.checkpoint.data.sheet_b).toBeUndefined();
      expect(tagData.storageFrame.perSheetCheckpoints.sheet_b).toBeUndefined();
    }
    expect(historical.TavernDB_ACU_IndependentData).toBeUndefined();
    expect(historical.TavernDB_ACU_Data).toBeUndefined();
    expect(historical.TavernDB_ACU_SummaryData).toBeUndefined();
    expect(historical.TavernDB_ACU_ModifiedKeys).toEqual([]);
    expect(historical.TavernDB_ACU_UpdateGroupKeys).toEqual([]);
    expect(target.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_b).toBeUndefined();
    expect(target.TavernDB_ACU_IsolatedData[''].storageFrame.logEntries).toEqual([]);
  });

  it('删除 key 与模板变更 key 冲突时在事务前拒绝', async () => {
    const message = seedFrame({ logEntries: [] });
    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '', deletedSheetKeys: ['sheet_a'],
      sheetChanges: [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] }],
      guideData: { sheet_a: { name: 'A' } },
    });
    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('同时删除和变更') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data.sheet_a).toEqual(sheetA);
  });

  it('删表严格保存失败时恢复跨消息历史字段、guide 与 scope', async () => {
    const historical = seedFrame({ logEntries: [] });
    historical.TavernDB_ACU_Data = { sheet_b: { legacy: true } };
    const target = seedFrame({ logEntries: [] });
    mocks.chat.splice(0, mocks.chat.length, historical, target);
    mocks.loadReplayState.mockResolvedValue(target.TavernDB_ACU_IsolatedData[''].storageFrame.checkpoint.data);
    const beforeHistorical = JSON.parse(JSON.stringify(historical));
    const beforeTarget = JSON.parse(JSON.stringify(target));
    const beforeScope = JSON.parse(JSON.stringify(mocks.scopeContainer));
    const beforeGuide = JSON.parse(JSON.stringify(mocks.guideContainer));
    mocks.setGuide.mockImplementation(() => {
      mocks.scopeContainer.template[''].changed = true;
      mocks.guideContainer.tags[''].changed = true;
      return true;
    });
    mocks.saveChatStrict.mockRejectedValueOnce(new Error('host save failed'));

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '', sheetChanges: [], deletedSheetKeys: ['sheet_b'], guideData: { sheet_a: { name: 'A' } }, createdAt: 30,
    });

    expect(result).toEqual({ saved: false, error: 'host save failed' });
    expect(mocks.saveChatStrict).toHaveBeenCalledTimes(2);
    expect(historical).toEqual(beforeHistorical);
    expect(target).toEqual(beforeTarget);
    expect(mocks.scopeContainer).toEqual(beforeScope);
    expect(mocks.guideContainer).toEqual(beforeGuide);
  });


  it('最新 AI 楼层不是 V2 frame 时拒绝提交，不隐式迁移或修改 guide/scope', async () => {
    const anchor = seedFrame({ logEntries: [] });
    const legacyTarget = { is_user: false, TavernDB_ACU_IndependentData: { sheet_a: { legacy: true } } };
    mocks.chat.splice(0, mocks.chat.length, anchor, legacyTarget);
    const originalScope = JSON.parse(JSON.stringify(mocks.scopeContainer));
    const originalGuide = JSON.parse(JSON.stringify(mocks.guideContainer));

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] }],
      guideData: { sheet_a: { name: 'A' } },
    });

    expect(result).toMatchObject({ saved: false, error: expect.stringContaining('legacy 持久化数据') });
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(mocks.scopeContainer).toEqual(originalScope);
    expect(mocks.guideContainer).toEqual(originalGuide);
    expect(legacyTarget.TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(legacyTarget.TavernDB_ACU_Identity).toBeUndefined();
    expect(anchor.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
  });

  it('拒绝非最新 AI 楼层且不保存', async () => {
    seedFrame({ logEntries: [] });
    mocks.chat.push({ is_user: false });

    const result = await commitCurrentFloorTemplateChanges_ACU({
      targetMessageIndex: 0,
      sheetChanges: [{ kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] }],
      guideData: { sheet_a: { name: 'A' } },
    });

    expect(result.saved).toBe(false);
    expect(result.error).toContain('最新 AI 楼层');
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
  });

  it('任一 shard 的 DDL 无法 strict hydrate 时拒绝整批提交且不写 guide', async () => {
    const message = seedFrame({ logEntries: [] });
    const originalIsolatedData = message.TavernDB_ACU_IsolatedData;
    const invalidSheet = {
      ...sheetB,
      sourceData: { ddl: 'CREATE TABLE sheet_b ( value TEXT );' },
    };

    const result = await commitCurrentFloorTemplateChanges_ACU({
      isolationKey: '',
      sheetChanges: [
        { kind: 'operations', sheetKey: 'sheet_a', targetSheetData: sheetA, operations: [{ kind: 'meta_update', sheetKey: 'sheet_a', meta: { name: 'A' } }] },
        { kind: 'operations', sheetKey: 'sheet_b', targetSheetData: invalidSheet, operations: [{ kind: 'meta_update', sheetKey: 'sheet_b', meta: { name: 'B' } }] },
      ],
      guideData: { sheet_a: { name: 'A' }, sheet_b: { name: 'B' } },
    });

    expect(result.saved).toBe(false);
    expect(result.error).toContain('DDL 无法 strict hydrate');
    expect(mocks.saveChatStrict).not.toHaveBeenCalled();
    expect(mocks.setGuide).not.toHaveBeenCalled();
    expect(message.TavernDB_ACU_IsolatedData).toBe(originalIsolatedData);
    expect(message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints.sheet_a).toBeUndefined();
  });
});
