/**
 * tests/data/gateways/worldbook-gateway.test.ts
 * 世界书 CRUD 操作网关 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTavernHelper, mockSillyTavern, mockLogWarn } = vi.hoisted(() => ({
  mockTavernHelper: {} as any,
  mockSillyTavern: {} as any,
  mockLogWarn: vi.fn(),
}));

vi.mock('../../../src/shared/host-api', () => ({
  TavernHelper_API_ACU: mockTavernHelper,
  SillyTavern_API_ACU: mockSillyTavern,
}));

vi.mock('../../../src/shared/utils', () => ({
  logWarn_ACU: mockLogWarn,
}));

import {
  isWorldbookApiAvailable_ACU,
  isLorebookNotFoundError_ACU,
  getLorebookEntries_ACU,
  setLorebookEntries_ACU,
  createLorebookEntries_ACU,
  deleteLorebookEntries_ACU,
  listLorebooks_ACU,
  getWorldBooks_ACU,
  getCurrentCharPrimaryLorebook_ACU,
  getCharLorebooks_ACU,
} from '../../../src/data/gateways/worldbook-gateway';

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(mockTavernHelper).forEach(k => delete mockTavernHelper[k]);
  Object.keys(mockSillyTavern).forEach(k => delete mockSillyTavern[k]);
});

describe('isWorldbookApiAvailable_ACU', () => {
  it('API 不可用返回 false', () => {
    expect(isWorldbookApiAvailable_ACU()).toBe(false);
  });

  it('API 可用返回 true', () => {
    mockTavernHelper.getLorebookEntries = vi.fn();
    expect(isWorldbookApiAvailable_ACU()).toBe(true);
  });
});

describe('isLorebookNotFoundError_ACU', () => {
  it.each([
    new Error('Worldbook "ghost" not found'),
    new Error('Could not find the lorebook'),
    new Error('世界书“旧书”不存在'),
    new Error('未能找到世界书'),
  ])('识别明确的世界书不存在错误', error => {
    expect(isLorebookNotFoundError_ACU(error)).toBe(true);
  });

  it.each([
    Object.assign(new Error('Worldbook "ghost" not found'), { name: 'AbortError' }),
    new Error('TaskAbortedByUser'),
    new Error('permission denied'),
    new Error('network unavailable'),
  ])('不把取消或其它读取故障归类为世界书不存在', error => {
    expect(isLorebookNotFoundError_ACU(error)).toBe(false);
  });
});

describe('getLorebookEntries_ACU', () => {
  it('API 不可用返回空数组', async () => {
    expect(await getLorebookEntries_ACU('book1')).toEqual([]);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('API 可用返回条目', async () => {
    const entries = [{ uid: 1, content: '条目1' }];
    mockTavernHelper.getLorebookEntries = vi.fn().mockResolvedValue(entries);
    expect(await getLorebookEntries_ACU('book1')).toEqual(entries);
  });
});

describe('setLorebookEntries_ACU', () => {
  it('API 不可用时静默跳过', async () => {
    await setLorebookEntries_ACU('book1', []);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('API 可用时调用', async () => {
    mockTavernHelper.setLorebookEntries = vi.fn().mockResolvedValue(undefined);
    await setLorebookEntries_ACU('book1', [{ uid: 1 }]);
    expect(mockTavernHelper.setLorebookEntries).toHaveBeenCalledWith('book1', [{ uid: 1 }]);
  });
});

describe('createLorebookEntries_ACU', () => {
  it('API 不可用时静默跳过', async () => {
    await createLorebookEntries_ACU('book1', []);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('API 可用时调用', async () => {
    mockTavernHelper.createLorebookEntries = vi.fn().mockResolvedValue(undefined);
    await createLorebookEntries_ACU('book1', [{ content: '新条目' }]);
    expect(mockTavernHelper.createLorebookEntries).toHaveBeenCalled();
  });
});

describe('deleteLorebookEntries_ACU', () => {
  it('API 不可用时静默跳过', async () => {
    await deleteLorebookEntries_ACU('book1', [1]);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('API 可用时调用', async () => {
    mockTavernHelper.deleteLorebookEntries = vi.fn().mockResolvedValue(undefined);
    await deleteLorebookEntries_ACU('book1', [1, 2]);
    expect(mockTavernHelper.deleteLorebookEntries).toHaveBeenCalledWith('book1', [1, 2]);
  });
});

describe('listLorebooks_ACU', () => {
  it('两个 API 都不可用返回空数组', async () => {
    expect(await listLorebooks_ACU()).toEqual([]);
  });

  it('优先使用 TavernHelper', async () => {
    mockTavernHelper.getLorebooks = vi.fn().mockResolvedValue(['book1', 'book2']);
    mockSillyTavern.getWorldBooks = vi.fn().mockResolvedValue(['book3']);
    expect(await listLorebooks_ACU()).toEqual(['book1', 'book2']);
  });

  it('TavernHelper 不可用时降级到 SillyTavern', async () => {
    mockSillyTavern.getWorldBooks = vi.fn().mockResolvedValue(['book3']);
    expect(await listLorebooks_ACU()).toEqual(['book3']);
  });
});

describe('getWorldBooks_ACU', () => {
  it('API 不可用返回空数组', async () => {
    expect(await getWorldBooks_ACU()).toEqual([]);
  });

  it('API 可用返回列表', async () => {
    mockSillyTavern.getWorldBooks = vi.fn().mockResolvedValue(['book1']);
    expect(await getWorldBooks_ACU()).toEqual(['book1']);
  });
});

describe('getCurrentCharPrimaryLorebook_ACU', () => {
  it('API 不可用返回 null', async () => {
    expect(await getCurrentCharPrimaryLorebook_ACU()).toBeNull();
  });

  it('API 可用返回世界书名', async () => {
    mockTavernHelper.getCurrentCharPrimaryLorebook = vi.fn().mockResolvedValue('主世界书');
    expect(await getCurrentCharPrimaryLorebook_ACU()).toBe('主世界书');
  });
});

describe('getCharLorebooks_ACU', () => {
  it('API 不可用返回空对象', async () => {
    const result = await getCharLorebooks_ACU();
    expect(result).toEqual({ primary: '', additional: [] });
  });

  it('API 可用返回世界书列表', async () => {
    const data = { primary: ['book1'], additional: ['book2'] };
    mockTavernHelper.getCharLorebooks = vi.fn().mockResolvedValue(data);
    expect(await getCharLorebooks_ACU()).toEqual(data);
  });
});