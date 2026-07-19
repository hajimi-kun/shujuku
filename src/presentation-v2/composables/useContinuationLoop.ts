import { computed, onBeforeUnmount, ref } from 'vue';
import {
  getNextLoopPrompt_ACU,
  initLoopState_ACU,
  stopLoopState_ACU,
  validateLoopStartParams_ACU,
} from '../../service/loop/loop-controller';
import { loopState_ACU } from '../../service/runtime/state-manager';
import {
  acuClearInterval,
  acuSetInterval,
  acuSetTimeout,
  type AcuTimerHandle,
} from '../bootstrap/host-env';
import { getAcuHostDocument } from '../bootstrap/host-document';
import { useToastStore } from '../stores/toast-store';

function setSendTextareaValue(text: string): boolean {
  const input = getAcuHostDocument().querySelector<HTMLTextAreaElement>('#send_textarea');
  if (!input) return false;
  input.value = text;
  const EventCtor = input.ownerDocument.defaultView?.Event ?? Event;
  input.dispatchEvent(new EventCtor('input', { bubbles: true }));
  return true;
}

function clickSendButton(): boolean {
  const button = getAcuHostDocument().querySelector<HTMLElement>('#send_but');
  if (!button) return false;
  button.click();
  return true;
}

export function useContinuationLoop() {
  const toast = useToastStore();
  const running = ref(loopState_ACU.isLooping);
  const timerText = ref('');
  let displayInterval: AcuTimerHandle | null = null;

  function refreshStatus(): void {
    running.value = loopState_ACU.isLooping;
  }

  function getRemainingMs(): number | null {
    if (!loopState_ACU.isLooping || !loopState_ACU.startTime || !loopState_ACU.totalDuration) {
      return null;
    }
    return Math.max(0, loopState_ACU.totalDuration - (Date.now() - loopState_ACU.startTime));
  }

  function clearDisplayTick(): void {
    if (displayInterval) {
      acuClearInterval(displayInterval);
      displayInterval = null;
    }
  }

  function updateTimer(): void {
    refreshStatus();
    const remaining = getRemainingMs();
    if (remaining === null) {
      timerText.value = '';
      return;
    }
    if (remaining <= 0) {
      stop();
      toast.info('总时长已结束，智能续写已停止。', { muteable: false });
      return;
    }
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    timerText.value = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  function startDisplayTick(): void {
    clearDisplayTick();
    updateTimer();
    if (getRemainingMs() !== null) {
      displayInterval = acuSetInterval(updateTimer, 1000);
    }
  }

  function ensureDurationGuardTick(): void {
    if (loopState_ACU.tickInterval) return;
    loopState_ACU.tickInterval = acuSetInterval(() => {
      const remaining = getRemainingMs();
      if (remaining === null) {
        if (loopState_ACU.tickInterval) {
          acuClearInterval(loopState_ACU.tickInterval as AcuTimerHandle);
          loopState_ACU.tickInterval = null;
        }
        return;
      }
      if (remaining <= 0) {
        stopLoopState_ACU();
      }
    }, 1000);
  }

  function syncFromLoopState(): void {
    refreshStatus();
    if (getRemainingMs() === null) {
      clearDisplayTick();
      timerText.value = '';
      return;
    }
    ensureDurationGuardTick();
    startDisplayTick();
  }

  function triggerNextPrompt(): void {
    const prompt = getNextLoopPrompt_ACU();
    if (prompt === null) {
      stop();
      toast.error('没有可用的循环提示词，智能续写已停止。', { muteable: false });
      return;
    }
    if (!setSendTextareaValue(prompt)) {
      stop();
      toast.error('找不到酒馆输入框，请确认当前页面可以正常发送消息。', { muteable: false });
      return;
    }
    acuSetTimeout(() => {
      if (!loopState_ACU.isLooping) return;
      if (!clickSendButton()) {
        stop();
        toast.error('找不到发送按钮，智能续写已停止。', { muteable: false });
      }
    }, 100);
  }

  function start(): void {
    const validationError = validateLoopStartParams_ACU();
    if (validationError) {
      toast.error(validationError);
      stopLoopState_ACU();
      refreshStatus();
      return;
    }
    initLoopState_ACU();
    toast.success('智能续写已启动。', { muteable: false });
    refreshStatus();
    ensureDurationGuardTick();
    startDisplayTick();
    triggerNextPrompt();
  }

  function stop(): void {
    stopLoopState_ACU();
    clearDisplayTick();
    timerText.value = '';
    refreshStatus();
  }

  onBeforeUnmount(() => {
    clearDisplayTick();
    refreshStatus();
  });

  return {
    running,
    timerText,
    statusText: computed(() => (running.value ? '运行中' : '未运行')),
    start,
    stop,
    refreshStatus,
    syncFromLoopState,
  };
}
