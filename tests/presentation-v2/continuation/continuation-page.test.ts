/**
 * ContinuationPage 集成 — 智能续写页
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const STORAGE_KEY = 'acu_v2_ui_state';

function setParent(parent: any) {
  Object.defineProperty(window, 'parent', {
    value: parent,
    writable: true,
    configurable: true,
  });
}

function stopContinuationLoop(doc: Document = document): void {
  const stopButton = Array.from(doc.querySelectorAll('button'))
    .find(button => (button.textContent || '').includes('停止智能续写')) as HTMLButtonElement | undefined;
  stopButton?.click();
}

function createSettings() {
  return {
    plotSettings: {
      enabled: true,
      contextTurnCount: 3,
      contextExtractTags: '',
      contextExtractRules: [{ start: '<content>', end: '</content>' }],
      contextExcludeTags: '',
      contextExcludeRules: [{ start: '<think>', end: '</think>' }],
      loopSettings: {
        quickReplyContent: ['继续推进剧情'],
        currentPromptIndex: 0,
        loopTags: 'content',
        loopDelay: 5,
        retryDelay: 3,
        loopTotalDuration: 20,
        maxRetries: 3,
      },
    },
    contentOptimizationSettings: { apiPreset: '' },
  } as any;
}

async function mountContinuationPage(settings = createSettings(), loopStateOverrides: Record<string, any> = {}) {
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ router: { activePageId: 'continuation' } }));
  const saveSettings = vi.fn(() => ({ saved: true }));
  const loopState = {
    isLooping: false,
    isRetrying: false,
    timerId: null,
    retryCount: 0,
    startTime: 0,
    totalDuration: 0,
    tickInterval: null,
    awaitingReply: false,
    ...loopStateOverrides,
  };

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
    currentChatFileIdentifier_ACU: 'chat-continuation',
    currentJsonTableData_ACU: null,
    getCurrentIsolationKey_ACU: () => '',
    coreApisAreReady_ACU: true,
    loopState_ACU: loopState,
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    saveSettings_ACU: saveSettings,
    setGlobalPlotEnabled_ACU: vi.fn(),
  }));
  vi.doMock('../../../src/service/ai/ai-service', () => ({
    getConnectionManagerProfiles_ACU: () => [],
    fetchAvailableModels_ACU: vi.fn(async () => ({ success: true, models: [] })),
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    getWorldbookNames_ACU: vi.fn(async () => []),
    getLorebookEntriesByNames_ACU: vi.fn(async () => ({})),
  }));
  vi.doMock('../../../src/service/worldbook/worldbook-service', () => ({
    getCurrentCharPrimaryLorebook_ACU: vi.fn(async () => ''),
    getCharLorebooks_ACU: vi.fn(async () => ({ primary: '', additional: [] })),
  }));
  vi.doMock('../../../src/service/loop/loop-controller', async () => {
    const state = await import('../../../src/service/runtime/state-manager');
    return {
      validateLoopStartParams_ACU: vi.fn(() => null),
      initLoopState_ACU: vi.fn(() => {
        state.loopState_ACU.isLooping = true;
        state.loopState_ACU.startTime = Date.now();
        state.loopState_ACU.totalDuration = 20 * 60 * 1000;
        return { loopDuration: state.loopState_ACU.totalDuration };
      }),
      stopLoopState_ACU: vi.fn(() => {
        state.loopState_ACU.isLooping = false;
        if (state.loopState_ACU.timerId) {
          clearTimeout(state.loopState_ACU.timerId);
          state.loopState_ACU.timerId = null;
        }
        if (state.loopState_ACU.tickInterval) {
          clearInterval(state.loopState_ACU.tickInterval);
          state.loopState_ACU.tickInterval = null;
        }
      }),
      getNextLoopPrompt_ACU: vi.fn(() => settings.plotSettings.loopSettings.quickReplyContent[0]),
    };
  });

  const mount = await import('../../../src/presentation-v2/bootstrap/mount');
  await mount.openAcuV2App();
  await new Promise(r => setTimeout(r, 0));
  return { mount, settings, saveSettings, loopState };
}

beforeEach(() => {
  setParent(window);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ContinuationPage', () => {
  it('渲染智能续写真实页面，不再是占位页', async () => {
    const { mount } = await mountContinuationPage();

    const page = document.querySelector('.acu-v2-continuation-page');
    expect(page).not.toBeNull();
    const text = page!.textContent || '';
    expect(text).toContain('循环提示词');
    expect(text).toContain('循环条件');
    expect(text).toContain('运行控制');
    expect(text).not.toContain('上下文过滤');
    const promptTextarea = page!.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(promptTextarea?.value).toBe('继续推进剧情');
    expect(Array.from(page!.querySelectorAll('.acu-panel__title')).map(el => el.textContent?.trim())).toEqual([
      '循环条件',
      '循环提示词',
      '运行控制',
    ]);
    expect(text).not.toContain('阶段 0 占位页');
    expect(text).not.toContain('外部导入');

    mount.__resetAcuV2MountForTests();
  });

  it('每个 AcuPanel 都附常驻说明信息条', async () => {
    const { mount } = await mountContinuationPage();

    const panels = document.querySelectorAll('.acu-v2-continuation-page .acu-panel');
    expect(panels).toHaveLength(3);
    panels.forEach(panel => {
      expect(panel.querySelector('.acu-panel__description-region .acu-info-banner')).not.toBeNull();
    });

    mount.__resetAcuV2MountForTests();
  });

  it('修改循环延时会写回 settings 并保存', async () => {
    const { mount, settings, saveSettings } = await mountContinuationPage();

    const delayPanel = Array.from(document.querySelectorAll('.acu-form-row'))
      .find(row => (row.textContent || '').includes('循环延时')) as HTMLElement | undefined;
    expect(delayPanel).not.toBeUndefined();
    const input = delayPanel!.querySelector('input[type="number"]') as HTMLInputElement;
    input.value = '9';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(settings.plotSettings.loopSettings.loopDelay).toBe(9);
    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('点击开始会写入酒馆输入框并触发发送按钮', async () => {
    const { mount } = await mountContinuationPage();

    const textarea = document.createElement('textarea');
    textarea.id = 'send_textarea';
    document.body.appendChild(textarea);
    const sendButton = document.createElement('button');
    sendButton.id = 'send_but';
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);
    document.body.appendChild(sendButton);

    const startButton = Array.from(document.querySelectorAll('button'))
      .find(button => (button.textContent || '').includes('开始智能续写')) as HTMLButtonElement | undefined;
    expect(startButton).not.toBeUndefined();
    expect(startButton!.disabled).toBe(false);
    startButton!.click();
    await new Promise(r => setTimeout(r, 150));

    expect(textarea.value).toBe('继续推进剧情');
    expect(sendSpy).toHaveBeenCalled();
    expect((document.querySelector('.acu-v2-continuation-page__status') as HTMLElement).textContent || '').toContain('运行中');

    stopContinuationLoop();
    mount.__resetAcuV2MountForTests();
  });

  it('父文档挂载时点击开始会写入宿主酒馆输入框', async () => {
    const parentDom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    setParent(parentDom.window);
    const { mount } = await mountContinuationPage();
    const parentDoc = parentDom.window.document;

    const textarea = parentDoc.createElement('textarea');
    textarea.id = 'send_textarea';
    parentDoc.body.appendChild(textarea);
    const sendButton = parentDoc.createElement('button');
    sendButton.id = 'send_but';
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);
    parentDoc.body.appendChild(sendButton);

    const startButton = Array.from(parentDoc.querySelectorAll('button'))
      .find(button => (button.textContent || '').includes('开始智能续写')) as HTMLButtonElement | undefined;
    expect(startButton).not.toBeUndefined();
    startButton!.click();
    await new Promise(r => setTimeout(r, 150));

    expect(textarea.value).toBe('继续推进剧情');
    expect(sendSpy).toHaveBeenCalled();

    stopContinuationLoop(parentDoc);
    mount.__resetAcuV2MountForTests();
    parentDom.window.close();
    setParent(window);
  });

  it('打开页面时会从已有循环状态恢复倒计时', async () => {
    const { mount } = await mountContinuationPage(createSettings(), {
      isLooping: true,
      startTime: Date.now() - 30_000,
      totalDuration: 20 * 60 * 1000,
    });

    const statusText = (document.querySelector('.acu-v2-continuation-page__status') as HTMLElement).textContent || '';
    expect(statusText).toContain('运行中');
    expect(statusText).toContain('剩余');

    stopContinuationLoop();
    mount.__resetAcuV2MountForTests();
  });

  it('关闭新 UI 后重开会恢复倒计时显示', async () => {
    const { mount } = await mountContinuationPage();

    const textarea = document.createElement('textarea');
    textarea.id = 'send_textarea';
    document.body.appendChild(textarea);
    const sendButton = document.createElement('button');
    sendButton.id = 'send_but';
    document.body.appendChild(sendButton);

    const startButton = Array.from(document.querySelectorAll('button'))
      .find(button => (button.textContent || '').includes('开始智能续写')) as HTMLButtonElement | undefined;
    startButton!.click();
    await Promise.resolve();

    expect((document.querySelector('.acu-v2-continuation-page__status') as HTMLElement).textContent || '').toContain('剩余');

    mount.closeAcuV2App();
    await Promise.resolve();
    await mount.openAcuV2App();
    await new Promise(r => setTimeout(r, 0));

    const reopenedStatusText = (document.querySelector('.acu-v2-continuation-page__status') as HTMLElement).textContent || '';
    expect(reopenedStatusText).toContain('运行中');
    expect(reopenedStatusText).toContain('剩余');

    stopContinuationLoop();
    mount.__resetAcuV2MountForTests();
  });
});
