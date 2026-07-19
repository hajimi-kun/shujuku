/**
 * presentation/components/summary-vector-index-ui.ts — 交火模式纪要索引 UI 层封装
 *
 * 负责：交火发送前召回过程的进度 toast 与结果提示。
 * 不负责：关键词生成、向量召回、rerank、世界书覆盖等业务逻辑。
 */
import { toastr_API_ACU } from '../../shared/host-api';
import { ACU_TOAST_CATEGORY_ACU } from '../../shared/constants';
import { logDebug_ACU } from '../../shared/utils';
import { processSummaryVectorIndexBeforeGeneration_ACU, type SummaryVectorIndexRuntimeResult_ACU } from '../../service/vector/summary-vector-index-runtime';
import { showToastr_ACU } from '../theme/toast';

function clearToastElement_ACU($toast: JQuery<HTMLElement> | null) {
  try { if ($toast) toastr_API_ACU?.clear?.($toast); } catch (e) {}
  try { if ($toast && $toast.closest) $toast.closest('.toast').remove(); } catch (e) {}
}

function shouldShowSummaryVectorResultToast_ACU(result: SummaryVectorIndexRuntimeResult_ACU): boolean {
  if (!result || result.skipped) return false;
  return result.success === true && Number(result.injectedCount || 0) > 0;
}

/**
 * 包装交火发送前处理，显示“正在召回记忆”进度提示。
 */
export async function processSummaryVectorIndexBeforeGenerationWithUI_ACU(
  options: { userInput?: string; source?: string } = {},
): Promise<SummaryVectorIndexRuntimeResult_ACU> {
  const toastMsg = `
      <div style="display: flex; align-items: center; justify-content: space-between;">
          <span class="toastr-message" style="margin-right: 10px;">正在召回交火记忆并重排纪要索引，请稍后...</span>
      </div>
  `;

  const $toast = showToastr_ACU('info', toastMsg, {
    timeOut: 0,
    extendedTimeOut: 0,
    escapeHtml: false,
    tapToDismiss: false,
    closeButton: false,
    progressBar: false,
    toastClass: 'toast acu-toast acu-toast--info',
    acuToastCategory: ACU_TOAST_CATEGORY_ACU.PLANNING,
  });

  try {
    const result = await processSummaryVectorIndexBeforeGeneration_ACU(options);
    if (shouldShowSummaryVectorResultToast_ACU(result)) {
      showToastr_ACU(
        'success',
        `交火记忆召回完成，已覆盖纪要索引 ${result.injectedCount || 0} 条。`,
        '交火召回完成',
        { acuToastCategory: ACU_TOAST_CATEGORY_ACU.PLAN_OK },
      );
    } else {
      logDebug_ACU(`[交火模式纪要索引] UI 包装完成：success=${result?.success === true}, skipped=${result?.skipped === true}, reason=${result?.reason || 'none'}`);
    }
    return result;
  } finally {
    clearToastElement_ACU($toast);
  }
}
