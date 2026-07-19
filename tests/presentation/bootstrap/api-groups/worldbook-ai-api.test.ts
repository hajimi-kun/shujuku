/**
 * tests/presentation/bootstrap/api-groups/worldbook-ai-api.test.ts
 * worldbook-ai-api callAI 参数透传测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetApiConfigByPreset, mockBuildCustomBody, mockSettings, mockHandleApiResponse } = vi.hoisted(() => ({
  mockGetApiConfigByPreset: vi.fn(),
  mockBuildCustomBody: vi.fn(() => ({ messages: [], model: 'gpt-4', max_tokens: 4096, temperature: 1.0, top_p: 0.95, stream: false })),
  mockSettings: { streamingEnabled: false, tavernProfile: 'default' } as any,
  mockHandleApiResponse: vi.fn(),
}));

vi.mock('../../../../src/service/ai/api-call', () => ({
  getApiConfigByPreset_ACU: mockGetApiConfigByPreset,
  buildCustomApiRequestBody_ACU: mockBuildCustomBody,
}));
vi.mock('../../../../src/service/ai/ai-service', () => ({
  sendConnectionManagerRequest_ACU: vi.fn(),
  generateRaw_ACU: vi.fn(),
  isGenerateRawAvailable_ACU: vi.fn(() => false),
  getHostRequestHeaders_ACU: vi.fn(() => ({})),
}));
vi.mock('../../../../src/service/ai/prompt-builder', () => ({
  handleApiResponse_ACU: mockHandleApiResponse,
}));
vi.mock('../../../../src/service/runtime/state-manager', () => ({
  settings_ACU: mockSettings,
  currentJsonTableData_ACU: null,
}));
vi.mock('../../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logError_ACU: vi.fn(),
}));
vi.mock('../../../../src/shared/env', () => ({ topLevelWindow_ACU: {} }));
vi.mock('../../../../src/service/chat/chat-service', () => ({ getChatArray_ACU: vi.fn() }));
vi.mock('../../../../src/service/settings/settings-service', () => ({ setZeroTkOccupyMode_ACU: vi.fn() }));
vi.mock('../../../../src/service/worldbook/pipeline', () => ({ deleteAllGeneratedEntries_ACU: vi.fn(), updateReadableLorebookEntry_ACU: vi.fn() }));
vi.mock('../../../../src/service/worldbook/injection-engine', () => ({ updateOutlineTableEntry_ACU: vi.fn() }));
vi.mock('../../../../src/service/runtime/helpers-remaining', () => ({ formatJsonToReadable_ACU: vi.fn() }));
vi.mock('../../../../src/service/optimization/content-optimization', () => ({ cancelContentOptimization_ACU: vi.fn() }));
vi.mock('../../../../src/presentation/components/optimization-ui', () => ({ reoptimizeMessage_ACU: vi.fn() }));
vi.mock('../../../../src/presentation/components/pipeline-ui-helpers', () => ({ refreshMergedDataAndNotifyWithUI_ACU: vi.fn() }));
vi.mock('../../../../src/presentation/theme/toast', () => ({ showToastr_ACU: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createWorldbookAiApi } from '../../../../src/presentation/bootstrap/api-groups/worldbook-ai-api';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetApiConfigByPreset.mockReturnValue({
    apiMode: 'custom',
    apiConfig: { url: 'https://api.example.com', model: 'gpt-4', apiKey: 'sk-test', temperature: 1.0, max_tokens: 4096 },
    tavernProfile: '',
  });
  mockFetch.mockResolvedValue({ ok: true });
  mockHandleApiResponse.mockResolvedValue('AI reply');
});

describe('callAI 参数透传', () => {
  it('custom API 分支 overrides 不含 temperature/topP', async () => {
    const api = createWorldbookAiApi({} as any);
    await api.callAI([{ role: 'user', content: 'hello' }]);
    expect(mockBuildCustomBody).toHaveBeenCalled();
    const overrides = mockBuildCustomBody.mock.calls[0][2];
    expect(overrides).not.toHaveProperty('temperature');
    expect(overrides).not.toHaveProperty('topP');
    expect(overrides.stripModelPrefix).toBe(false);
  });

  it('custom API 分支 temperature=0 配置透传到 buildCustomApiRequestBody_ACU', async () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'custom',
      apiConfig: { url: 'https://api.example.com', model: 'gpt-4', apiKey: 'sk-test', temperature: 0, max_tokens: 4096 },
      tavernProfile: '',
    });
    const api = createWorldbookAiApi({} as any);
    await api.callAI([{ role: 'user', content: 'hello' }]);
    const effectiveApiConfig = mockBuildCustomBody.mock.calls[0][1];
    expect(effectiveApiConfig.temperature).toBe(0);
  });

  it('custom API 分支 topP 驼峰别名透传', async () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'custom',
      apiConfig: { url: 'https://api.example.com', model: 'gpt-4', apiKey: 'sk-test', topP: 0.3 },
      tavernProfile: '',
    });
    const api = createWorldbookAiApi({} as any);
    await api.callAI([{ role: 'user', content: 'hello' }]);
    const effectiveApiConfig = mockBuildCustomBody.mock.calls[0][1];
    expect(effectiveApiConfig.topP).toBe(0.3);
  });

  it('custom API 分支 max_tokens=0 配置不被 override 改为 4096', async () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'custom',
      apiConfig: { url: 'https://api.example.com', model: 'gpt-4', apiKey: 'sk-test', max_tokens: 0 },
      tavernProfile: '',
    });
    const api = createWorldbookAiApi({} as any);
    await api.callAI([{ role: 'user', content: 'hello' }]);
    expect(mockBuildCustomBody).toHaveBeenCalled();
    const overrides = mockBuildCustomBody.mock.calls[0][2];
    // 无 options 时不传 maxTokens override，由 buildCustomApiRequestBody_ACU 统一兜底
    expect(overrides.maxTokens).toBeUndefined();
    const effectiveApiConfig = mockBuildCustomBody.mock.calls[0][1];
    expect(effectiveApiConfig.max_tokens).toBe(0);
  });

  it('custom API 分支 options.max_tokens=0 时作为 override 透传', async () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'custom',
      apiConfig: { url: 'https://api.example.com', model: 'gpt-4', apiKey: 'sk-test', max_tokens: 4096 },
      tavernProfile: '',
    });
    const api = createWorldbookAiApi({} as any);
    await api.callAI([{ role: 'user', content: 'hello' }], { max_tokens: 0 });
    expect(mockBuildCustomBody).toHaveBeenCalled();
    const overrides = mockBuildCustomBody.mock.calls[0][2];
    expect(overrides.maxTokens).toBe(0);
  });

  it('custom API 分支 topP=0 配置透传', async () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'custom',
      apiConfig: { url: 'https://api.example.com', model: 'gpt-4', apiKey: 'sk-test', topP: 0 },
      tavernProfile: '',
    });
    const api = createWorldbookAiApi({} as any);
    await api.callAI([{ role: 'user', content: 'hello' }]);
    const effectiveApiConfig = mockBuildCustomBody.mock.calls[0][1];
    expect(effectiveApiConfig.topP).toBe(0);
  });

  it('tavern API 分支 max_tokens=0 透传给 sendConnectionManagerRequest_ACU', async () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'tavern',
      apiConfig: { max_tokens: 0 },
      tavernProfile: 'profile-1',
    });
    const { sendConnectionManagerRequest_ACU } = await import('../../../../src/service/ai/ai-service');
    vi.mocked(sendConnectionManagerRequest_ACU).mockResolvedValue({
      result: { choices: [{ message: { content: 'tavern reply' } }] },
    } as any);
    const api = createWorldbookAiApi({} as any);
    const result = await api.callAI([{ role: 'user', content: 'hello' }]);
    expect(sendConnectionManagerRequest_ACU).toHaveBeenCalledWith(
      'profile-1',
      expect.any(Array),
      0,
    );
    expect(result).toBe('tavern reply');
  });
});
