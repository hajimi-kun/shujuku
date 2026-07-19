/**
 * tests/service/runtime/plot-runtime/plot-entry.test.ts
 * 剧情推进入口 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, mockLoopState, mockPlanningGuard, mockRunPlotTasks, mockLogError, mockCaptureScope } = vi.hoisted(() => ({
  mockSettings: {
    plotSettings: { enabled: true },
    streamingEnabled: false,
  } as any,
  mockLoopState: { isRetrying: false } as any,
  mockPlanningGuard: { inProgress: false } as any,
  mockRunPlotTasks: vi.fn(),
  mockLogError: vi.fn(),
  mockCaptureScope: vi.fn(),
}));

vi.mock('../../../../src/shared/defaults-json.js', () => ({
  DEFAULT_PLOT_SETTINGS_ACU: { enabled: false, prompts: [] },
}));

vi.mock('../../../../src/service/runtime/state-manager', () => ({
  settings_ACU: mockSettings,
  loopState_ACU: mockLoopState,
  planningGuard_ACU: mockPlanningGuard,
  abortController_ACU: null,
  _set_abortController_ACU: vi.fn(),
}));

vi.mock('../../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logError_ACU: mockLogError,
}));

vi.mock('../../../../src/service/runtime/plot-runtime/plot-task-engine', () => ({
  runPlotTasksRuntime_ACU: mockRunPlotTasks,
}));

vi.mock('../../../../src/service/runtime/plot-runtime/plot-runtime-scope', () => ({
  capturePlotRuntimeScope_ACU: mockCaptureScope,
  summarizePlotRuntimeScope_ACU: (scope: any) => scope,
  summarizePlotRuntimeError_ACU: () => ({ category: 'unknown' }),
}));

import { runOptimizationLogic_ACU } from '../../../../src/service/runtime/plot-runtime/plot-entry';

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.plotSettings = { enabled: true };
  mockLoopState.isRetrying = false;
  mockPlanningGuard.inProgress = false;
  mockCaptureScope.mockReturnValue({ chatId: 'chat-1', characterId: '1', isolationKey: '', reliable: true });
  // 重置 __inFlight 标记
  (runOptimizationLogic_ACU as any).__inFlight = false;
  (runOptimizationLogic_ACU as any).__inFlightText = '';
});

describe('runOptimizationLogic_ACU', () => {
  it('成功执行返回 success=true', async () => {
    mockRunPlotTasks.mockResolvedValue({
      finalMessage: '勇者击败了恶龙',
      successfulResults: [{ taskId: 'task1' }],
      failedResults: [],
      enabledTaskCount: 1,
      aggregatedTags: new Map([['战斗', true]]),
    });
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(true);
    expect(result.finalMessage).toBe('勇者击败了恶龙');
    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);
    expect(result.aggregatedTagNames).toContain('战斗');
  });

  it('剧情推进未启用时跳过', async () => {
    mockSettings.plotSettings = { enabled: false };
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
  });

  it('重试中时跳过', async () => {
    mockLoopState.isRetrying = true;
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('retrying');
  });

  it('无任务时返回 no_tasks', async () => {
    mockRunPlotTasks.mockResolvedValue({
      finalMessage: null,
      successfulResults: [],
      failedResults: [],
      enabledTaskCount: 0,
    });
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('no_tasks');
  });

  it('所有任务失败返回 all_failed', async () => {
    mockRunPlotTasks.mockResolvedValue({
      finalMessage: null,
      successfulResults: [],
      failedResults: [{ taskId: 'task1' }],
      enabledTaskCount: 2,
    });
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('all_failed');
  });

  it('阶段失败返回 stage_failure', async () => {
    mockRunPlotTasks.mockResolvedValue({
      finalMessage: null,
      abortedByStageFailure: true,
      failedStage: 2,
      errorMessage: '阶段2失败',
      enabledTaskCount: 3,
      successfulResults: [{ taskId: 'task1' }],
      failedResults: [{ taskId: 'task2' }],
    });
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('stage_failure');
    expect(result.failedStage).toBe(2);
  });

  it('用户中止返回 aborted', async () => {
    mockRunPlotTasks.mockRejectedValue(new Error('TaskAbortedByUser'));
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it('AbortError 返回 aborted', async () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    mockRunPlotTasks.mockRejectedValue(err);
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it('未知异常返回通用错误且日志与结果均不泄露宿主正文', async () => {
    const sensitiveText = '用户输入、提示词和世界书正文都不能泄露';
    mockRunPlotTasks.mockRejectedValue(new Error(sensitiveText));
    const result = await runOptimizationLogic_ACU(sensitiveText);
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('exception');
    expect(result.errorMessage).toBe('剧情规划大师在处理时发生错误。');
    expect(result).not.toHaveProperty('error');
    expect(JSON.stringify(result)).not.toContain(sensitiveText);
    expect(mockLogError).toHaveBeenCalledWith('[剧情推进] 在核心优化逻辑中发生错误:', expect.objectContaining({
      phase: 'top_level',
      build: expect.any(String),
      initialScope: expect.objectContaining({ chatId: 'chat-1' }),
      errorScope: expect.objectContaining({ chatId: 'chat-1' }),
      error: { category: 'unknown' },
    }));
    expect(JSON.stringify(mockLogError.mock.calls)).not.toContain(sensitiveText);
  });

  it('部分失败时 hasPartialFailure=true', async () => {
    mockRunPlotTasks.mockResolvedValue({
      finalMessage: '结果',
      successfulResults: [{ taskId: 'task1' }],
      failedResults: [{ taskId: 'task2' }],
      enabledTaskCount: 2,
      aggregatedTags: new Map(),
    });
    const result = await runOptimizationLogic_ACU('继续');
    expect(result.success).toBe(true);
    expect(result.hasPartialFailure).toBe(true);
  });

  it('finally 块重置 planningGuard 和 __inFlight', async () => {
    mockRunPlotTasks.mockResolvedValue({
      finalMessage: '结果',
      successfulResults: [],
      failedResults: [],
      enabledTaskCount: 1,
      aggregatedTags: new Map(),
    });
    await runOptimizationLogic_ACU('继续');
    expect(mockPlanningGuard.inProgress).toBe(false);
    expect((runOptimizationLogic_ACU as any).__inFlight).toBe(false);
  });
});
