/**
 * tests/service/settings/settings-readers.test.ts
 * 设置读取器 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings } = vi.hoisted(() => {
  const mockSettings: any = {
    characterSettings: {},
    zeroTkOccupyModeDefault: false,
  };
  return { mockSettings };
});

vi.mock('../../../src/service/runtime/state-manager', () => ({
  settings_ACU: mockSettings,
  currentChatFileIdentifier_ACU: 'test-char',
}));

vi.mock('../../../src/data/repositories/profile-repo', () => ({
  globalMeta_ACU: { zeroTkOccupyModeGlobal: false },
}));

vi.mock('../../../src/shared/defaults', () => ({
  defaultWorldbookConfig_ACU: {
    enabled: true,
    zeroTkOccupyMode: false,
    outlineEntryEnabled: true,
    maxEntries: 10,
  },
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  deepMerge_ACU: vi.fn((target: any, source: any) => ({ ...target, ...source })),
}));

import {
  getCurrentCharSettings_ACU,
  getCurrentWorldbookConfig_ACU,
} from '../../../src/service/settings/settings-readers';

beforeEach(() => {
  mockSettings.characterSettings = {};
  mockSettings.zeroTkOccupyModeDefault = false;
});

describe('getCurrentCharSettings_ACU', () => {
  it('首次调用创建新的角色设置，worldbookConfig 包含默认值', () => {
    const result = getCurrentCharSettings_ACU();
    expect(result).toBeDefined();
    expect(result.worldbookConfig).toBeDefined();
    // 验证默认配置的具体字段值（deepMerge 后应包含 defaultWorldbookConfig_ACU 的字段）
    expect(result.worldbookConfig.enabled).toBe(true);
    expect(result.worldbookConfig.maxEntries).toBe(10);
    // zeroTkOccupyModeGlobal=false 时，zeroTkOccupyMode 应为 false
    expect(result.worldbookConfig.zeroTkOccupyMode).toBe(false);
    expect(result.worldbookConfig.outlineEntryEnabled).toBe(true);
  });
  it('已有设置时 deepMerge 保留已有字段并补全缺失字段', () => {
    mockSettings.characterSettings['test-char'] = {
      worldbookConfig: { enabled: false, customField: 'test' },
    };
    const result = getCurrentCharSettings_ACU();
    // deepMerge 后：source(existing) 覆盖 target(default)
    expect(result.worldbookConfig.enabled).toBe(false);
    expect(result.worldbookConfig.customField).toBe('test');
    // 默认值应被补全
    expect(result.worldbookConfig.maxEntries).toBe(10);
  });
  it('characterSettings 为 null 时自动初始化', () => {
    mockSettings.characterSettings = null;
    const result = getCurrentCharSettings_ACU();
    expect(result).toBeDefined();
    expect(mockSettings.characterSettings).not.toBeNull();
    expect(result.worldbookConfig.enabled).toBe(true);
  });
  it('深度合并默认配置后字段完整', () => {
    mockSettings.characterSettings['test-char'] = {
      worldbookConfig: { enabled: false },
    };
    const result = getCurrentCharSettings_ACU();
    expect(result.worldbookConfig).toBeDefined();
    // 验证 deepMerge 补全了 maxEntries
    expect(result.worldbookConfig.maxEntries).toBe(10);
    // zeroTkOccupyMode 被强制设置为 globalZeroTkDefault
    expect(result.worldbookConfig.zeroTkOccupyMode).toBe(false);
    expect(result.worldbookConfig.outlineEntryEnabled).toBe(true);
  });
});

describe('getCurrentWorldbookConfig_ACU', () => {
  it('返回世界书配置', () => {
    const config = getCurrentWorldbookConfig_ACU();
    expect(config).toBeDefined();
    expect(config.enabled).toBeDefined();
  });
  it('与 getCurrentCharSettings_ACU 返回的一致', () => {
    const charSettings = getCurrentCharSettings_ACU();
    const config = getCurrentWorldbookConfig_ACU();
    expect(config).toBe(charSettings.worldbookConfig);
  });
});
