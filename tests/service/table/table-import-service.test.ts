import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatArray: vi.fn(),
  getCurrentIsolationKey: vi.fn(() => ''),
  sanitizeChatSheetsObject: vi.fn((data: any) => data),
  replaceAllData: vi.fn().mockResolvedValue({ success: true }),
  getCurrentData: vi.fn(),
  runTableUpdateCommit: vi.fn(),
}));

vi.mock('../../../src/service/chat/chat-service', () => ({
  getChatArray_ACU: mocks.getChatArray,
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  currentJsonTableData_ACU: { mate: { type: 'acu', version: 1 } },
  getCurrentIsolationKey_ACU: mocks.getCurrentIsolationKey,
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  sanitizeChatSheetsObject_ACU: mocks.sanitizeChatSheetsObject,
}));

vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  getStorageProvider: vi.fn(() => ({
    replaceAllData: mocks.replaceAllData,
    getCurrentData: mocks.getCurrentData,
  })),
}));

vi.mock('../../../src/service/table/table-update-commit', () => ({
  runTableUpdateCommit_ACU: mocks.runTableUpdateCommit,
}));

vi.mock('../../../src/shared/utils', () => ({
  isSummaryOrOutlineTable_ACU: vi.fn((name: string) => name.includes('纪要') || name.includes('总结')),
}));

import { importTableJsonThroughCommit_ACU } from '../../../src/service/table/table-import-service';

describe('importTableJsonThroughCommit_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatArray.mockReturnValue([{ is_user: true }, { is_user: false, mes: 'AI回复' }]);
    mocks.getCurrentData.mockReturnValue(null);
    mocks.runTableUpdateCommit.mockImplementation(async (options: any, apply: any) => {
      const applied = await apply();
      return {
        success: applied.success !== false,
        value: applied.value,
        tableData: applied.tableData,
        messageIndex: options.targetMessageIndex,
      };
    });
  });

  it('外部导入会写入聊天持久化，但不推进自动更新楼层标记', async () => {
    const importedData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { name: '纪要表', content: [['row_id', '事件'], ['1', '开始']] },
      sheet_1: { name: '背包', content: [['row_id', '物品']] },
    };

    const result = await importTableJsonThroughCommit_ACU(JSON.stringify(importedData));

    expect(result.success).toBe(true);
    expect(mocks.replaceAllData).toHaveBeenCalledWith(importedData);
    expect(result.persisted).toBe(true);
    expect(mocks.runTableUpdateCommit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'import',
      reason: 'importTableAsJson',
      targetMessageIndex: 1,
      targetSheetKeys: ['sheet_0', 'sheet_1'],
      updateGroupKeys: null,
      trackingSheetKeys: [],
      trackAsUpdate: false,
      operations: [{ kind: 'data_replace', data: importedData, reason: 'import' }],
    }), expect.any(Function));
  });

  it('删除楼层/备份恢复模式只恢复运行时，不写新的持久化事件', async () => {
    const importedData = {
      mate: { type: 'acu', version: 1 },
      sheet_0: { name: '纪要表', content: [['row_id', '事件'], ['1', '开始']] },
    };

    const result = await importTableJsonThroughCommit_ACU(JSON.stringify(importedData), { persist: false });

    expect(result.success).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.tableData).toEqual(importedData);
    expect(mocks.replaceAllData).toHaveBeenCalledWith(importedData);
    expect(mocks.runTableUpdateCommit).not.toHaveBeenCalled();
  });
});
