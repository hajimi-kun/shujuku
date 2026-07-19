import { logError_ACU } from '../../../shared/utils';
import {
  getAcuV2PiniaForBridge,
  openAcuV2App,
} from '../../bootstrap/mount';
import { getAcuHostWindow } from '../../bootstrap/host-document';
import { useRootShellStore } from '../../stores/root-shell-store';
import { useRouterStore } from '../../stores/router-store';
import {
  useVisualizerStore,
  type VisualizerOpenSource,
} from '../../stores/visualizer-store';

interface OpenVisualizerSurfaceOptions {
  source?: VisualizerOpenSource;
}

interface AutoCardUpdaterV2Api {
  open: () => Promise<boolean>;
  openVisualizer: () => Promise<boolean>;
  refreshVisualizer: () => Promise<void>;
}

export async function openAcuV2Shell_ACU(): Promise<boolean> {
  try {
    await openAcuV2App();
    return true;
  } catch (error) {
    logError_ACU('openAcuV2Shell failed:', error);
    return false;
  }
}

export async function openVisualizerSurface_ACU(
  options: OpenVisualizerSurfaceOptions = {},
): Promise<boolean> {
  try {
    const existingPinia = getAcuV2PiniaForBridge();
    const wasShellOpen = existingPinia
      ? useRootShellStore(existingPinia).isOpen
      : false;
    const previousPageId = existingPinia
      ? useRouterStore(existingPinia).activePageId
      : null;

    await openAcuV2App();

    const pinia = getAcuV2PiniaForBridge();
    if (!pinia) throw new Error('v2 app was not mounted.');

    const router = useRouterStore(pinia);
    const visualizer = useVisualizerStore(pinia);
    visualizer.open({
      source: options.source ?? 'external-api',
      wasShellOpen,
      previousPageId: previousPageId ?? router.activePageId,
    });
    return true;
  } catch (error) {
    logError_ACU('openVisualizerSurface failed:', error);
    return false;
  }
}

export async function requestVisualizerExternalRefresh_ACU(): Promise<void> {
  const pinia = getAcuV2PiniaForBridge();
  if (!pinia) return;
  useVisualizerStore(pinia).requestExternalRefresh();
}

function installAutoCardUpdaterV2ApiOnTarget_ACU(target: any): void {
  if (!target) return;
  const previous = target.AutoCardUpdaterV2API || {};
  target.AutoCardUpdaterV2API = {
    ...previous,
    open: openAcuV2Shell_ACU,
    openVisualizer: () => openVisualizerSurface_ACU({ source: 'external-api' }),
    refreshVisualizer: requestVisualizerExternalRefresh_ACU,
  } satisfies AutoCardUpdaterV2Api;
}

export function installAutoCardUpdaterV2Api_ACU(): void {
  if (typeof window === 'undefined') return;
  installAutoCardUpdaterV2ApiOnTarget_ACU(window as any);
  const hostWindow = getAcuHostWindow();
  if (hostWindow !== window) {
    installAutoCardUpdaterV2ApiOnTarget_ACU(hostWindow as any);
  }
}

installAutoCardUpdaterV2Api_ACU();
