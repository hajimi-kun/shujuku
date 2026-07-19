import { describe, expect, it } from 'vitest';
import {
  allocateStableRowId_ACU,
  createStableRowIdReservation_ACU,
} from '../../src/shared/stable-row-id-allocator';

describe('stable-row-id-allocator', () => {
  it('为删除中间行和非数字 ID 的表分配最小未占用正整数', () => {
    const reserved = createStableRowIdReservation_ACU([
      ['1', '铁剑'],
      ['3', '盾牌'],
      ['alpha', '标记'],
      [' ', '不占用'],
      { malformed: true },
    ]);

    expect(allocateStableRowId_ACU(reserved)).toBe('2');
  });

  it('canonicalize number 与带空格的既有 ID，但不会重写或修复重复输入', () => {
    const reserved = createStableRowIdReservation_ACU([
      [1],
      [' 3 '],
      ['1'],
      [null],
      undefined,
    ]);

    expect([...reserved]).toEqual(['1', '3']);
    expect(allocateStableRowId_ACU(reserved)).toBe('2');
  });

  it('立即保留分配结果，供同一批次连续插入使用', () => {
    const reserved = createStableRowIdReservation_ACU([['2'], ['alpha']]);

    expect(allocateStableRowId_ACU(reserved)).toBe('1');
    expect(allocateStableRowId_ACU(reserved)).toBe('3');
    expect([...reserved]).toEqual(['2', 'alpha', '1', '3']);
  });
});
