/**
 * tests/service/runtime/message-handler.test.ts
 * 新消息处理核心逻辑 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetCurrentCharacterFallback,
} = vi.hoisted(() => ({
  mockGetCurrentCharacterFallback: vi.fn(() => null),
}));

vi.mock('../../../src/service/host/host-state-service', () => ({
  getCurrentCharacterFallback_ACU: mockGetCurrentCharacterFallback,
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
}));

import {
  evaluateNewMessageAction_ACU,
  type MessageAction,
  type MessageActionResult,
} from '../../../src/service/runtime/message-handler';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentCharacterFallback.mockReturnValue(null);
});

describe('evaluateNewMessageAction_ACU', () => {
  // ═══ 跳过场景 ═══
  describe('skip 场景', () => {
    it('wasStoppedByUser 时跳过', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        false, true, true, {},
      );
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('user abort');
    });

    it('正在自动更新时跳过', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        true, true, false, {},
      );
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('already in progress');
    });

    it('核心 API 未就绪时跳过', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        false, false, false, {},
      );
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('not ready');
    });

    it('无聊天数据时跳过', () => {
      const result = evaluateNewMessageAction_ACU([], false, true, false, {});
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('No chat data');
    });

    it('null 聊天数据时跳过', () => {
      const result = evaluateNewMessageAction_ACU(null as any, false, true, false, {});
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('No chat data');
    });

    it('最新消息是用户消息时跳过', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: true, mes: '用户消息' }],
        false, true, false, {},
      );
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('not an AI reply');
    });

    it('最新消息来自不同角色时跳过', () => {
      mockGetCurrentCharacterFallback.mockReturnValue({ name: '角色A' });
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复', name: '角色B' }],
        false, true, false, {},
      );
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('different character');
    });
  });

  // ═══ update_only 场景 ═══
  describe('update_only 场景', () => {
    it('无正文优化配置时返回 update_only', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复', name: '角色A' }],
        false, true, false, {},
      );
      expect(result.action).toBe('update_only');
      expect(result.lastMessageIndex).toBe(0);
    });

    it('正文优化未启用时返回 update_only', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        false, true, false, { enabled: false },
      );
      expect(result.action).toBe('update_only');
    });

    it('activeChar 无 name 时不做角色匹配检查', () => {
      mockGetCurrentCharacterFallback.mockReturnValue({});
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复', name: '任意角色' }],
        false, true, false, {},
      );
      expect(result.action).toBe('update_only');
    });
  });

  // ═══ optimize 场景 ═══
  describe('optimize 场景', () => {
    it('parallelMode 启用时返回 optimize_parallel', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        false, true, false,
        { enabled: true, parallelMode: true },
      );
      expect(result.action).toBe('optimize_parallel');
      expect(result.lastMessageIndex).toBe(0);
    });

    it('手动确认模式返回 optimize_manual', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        false, true, false,
        { enabled: true, parallelMode: false, autoApply: false, seamlessMode: false },
      );
      expect(result.action).toBe('optimize_manual');
    });

    it('顺序模式返回 optimize_then_update', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        false, true, false,
        { enabled: true, parallelMode: false, autoApply: true, seamlessMode: true },
      );
      expect(result.action).toBe('optimize_then_update');
    });

    it('autoApply=true 但 seamlessMode=false 时返回 optimize_then_update', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        false, true, false,
        { enabled: true, parallelMode: false, autoApply: true, seamlessMode: false },
      );
      expect(result.action).toBe('optimize_then_update');
    });
  });

  // ═══ lastMessageIndex ═══
  describe('lastMessageIndex', () => {
    it('多条消息时 lastMessageIndex 指向最后一条', () => {
      const chat = [
        { is_user: true, mes: '用户消息' },
        { is_user: false, mes: 'AI回复1' },
        { is_user: true, mes: '用户消息2' },
        { is_user: false, mes: 'AI回复2' },
      ];
      const result = evaluateNewMessageAction_ACU(chat, false, true, false, {});
      expect(result.lastMessageIndex).toBe(3);
    });
  });

  // ═══ 优先级验证 ═══
  describe('条件优先级', () => {
    it('wasStoppedByUser 优先于 isAutoUpdating', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        true, true, true, {},
      );
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('user abort');
    });

    it('isAutoUpdating 优先于 coreApisReady', () => {
      const result = evaluateNewMessageAction_ACU(
        [{ is_user: false, mes: 'AI回复' }],
        true, false, false, {},
      );
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('already in progress');
    });
  });
});
