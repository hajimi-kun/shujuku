# api-registry.ts 按领域拆分改造计划

> 创建时间：2026-04-14
> 目标文件：`src/presentation/bootstrap/api-registry.ts`（2,040 行）
> 分支：`001-three-layer-refactor`

---

## 一、现状分析

### 1.1 文件概况

`api-registry.ts` 是 `AutoCardUpdaterAPI` 全局对象的唯一注册点，将所有对外 API 方法以一个巨大的对象字面量挂载到 `(topLevelWindow_ACU).AutoCardUpdaterAPI`。

- **总行数**：2,040 行
- **API 方法数量**：约 60+ 个
- **import 语句**：33 条，引用 shared / service / presentation 三层的 20+ 个模块
- **引用方式**：无 export，通过 `import './presentation/bootstrap/api-registry'` 副作用导入（index.ts 第 52 行）
- **外部访问**：全部通过 `(topLevelWindow_ACU).AutoCardUpdaterAPI.xxx` 全局调用

### 1.2 领域分布

经逐行分析，文件内的 API 方法可按业务领域划分为以下 **9 个分组**：

| # | 领域 | 方法数 | 估算行数 | 说明 |
|---|------|:------:|:--------:|------|
| 1 | **核心数据操作** | 3 | ~240 | exportTableAsJson / importTableAsJson / triggerUpdate |
| 2 | **表格 CRUD** | 4 | ~440 | updateCell / updateRow / insertRow / deleteRow |
| 3 | **表格锁定** | 11 | ~140 | get/set/clear/toggle 系列锁定操作 |
| 4 | **回调管理** | 5 | ~50 | register/unregister/notify 表格更新和填表开始回调 |
| 5 | **模板预设** | 4+1 | ~160 | getTemplatePresetNames / switchTemplatePreset / injectTemplatePresetToCurrentChat / importTemplateFromData + getTableTemplate |
| 6 | **剧情推进预设** | 9+1 | ~320 | getPlotPresets / getCurrentPlotPreset / switchPlotPreset / injectPlotPresetToCurrentChat / getPlotPresetDetails / getPlotPresetNames / importPlotPresetFromData / importPlotPresetsFromData / exportAllPlotPresets + initGameSession |
| 7 | **数据管理与导入** | 8+8+1 | ~30 | 模板导入导出 8 个 + TXT导入链路 8 个 + mergeSummaryNow（均为单行包装） |
| 8 | **设置与配置** | 12 | ~310 | openSettings / openVisualizer + 更新配置参数 2 个 + 手动更新表选择 3 个 + API 预设管理 8 个 |
| 9 | **世界书与AI** | 7 | ~260 | syncWorldbookEntries / refreshDataAndWorldbook / deleteInjectedEntries / setOutlineEntryEnabled / setZeroTkOccupyMode / reoptimizeMessage / cancelContentOptimization + callAI / getStoryContext |

### 1.3 共享状态

文件级变量（跨方法共享）：
- `tableUpdateCallbacks_ACU: any[]` — 表格更新回调列表
- `tableFillStartCallbacks_ACU: any[]` — 填表开始回调列表

这两个变量被 **回调管理** 分组的 5 个方法使用，需要在拆分时作为共享上下文传递。

### 1.4 this 引用

以下方法内部通过 `this.xxx` 引用同一 API 对象上的其他方法：
- `injectTemplatePresetToCurrentChat` → `this.switchTemplatePreset`
- `importPlotPresetFromData` → `this.injectPlotPresetToCurrentChat`
- `importPlotPresetsFromData` → `this.importPlotPresetFromData`
- `initGameSession` → `this.importPlotPresetFromData` / `this.injectPlotPresetToCurrentChat`

拆分后需要确保这些 `this` 引用在合并挂载后仍然有效。

---

## 二、目标架构

### 2.1 目录结构

```
src/presentation/bootstrap/
├── api-registry.ts              (重构后 ~80 行) 主入口：import 分组 → 合并 → 挂载全局对象
└── api-groups/                  (新建目录)
    ├── core-data-api.ts         (~240 行) 核心数据操作
    ├── table-crud-api.ts        (~440 行) 表格 CRUD（updateCell/updateRow/insertRow/deleteRow）
    ├── table-lock-api.ts        (~140 行) 表格锁定
    ├── callback-api.ts          (~50 行)  回调管理（含 tableUpdateCallbacks / tableFillStartCallbacks 状态）
    ├── template-preset-api.ts   (~160 行) 模板预设
    ├── plot-preset-api.ts       (~320 行) 剧情推进预设 + 游戏初始化
    ├── data-admin-api.ts        (~30 行)  数据管理与导入（单行包装集合）
    ├── settings-config-api.ts   (~310 行) 设置面板 + 更新配置 + 手动表选择 + API 预设管理
    └── worldbook-ai-api.ts      (~260 行) 世界书操作 + 正文优化 + AI 调用
```

### 2.2 设计原则

1. **每个分组文件 export 一个工厂函数**，返回该领域的方法集合（`Record<string, Function>`）
2. **主文件（api-registry.ts）**：
   - import 所有分组工厂函数
   - 创建回调管理器实例（shared context）
   - 调用各工厂函数，传入必要的共享上下文
   - 用 `Object.assign` 合并所有方法到一个对象
   - 挂载到 `(topLevelWindow_ACU).AutoCardUpdaterAPI`
3. **this 引用解决方案**：所有工厂函数返回的方法使用箭头函数或在主文件中统一 bind，确保 `this` 指向最终的 API 对象

### 2.3 接口约定

每个分组文件的标准签名：

```typescript
// api-groups/xxx-api.ts

import { ... } from '...';

/**
 * 返回该领域的 API 方法集合
 * @param ctx - 共享上下文（回调管理器等）
 * @returns 方法集合，key 为 API 方法名
 */
export function createXxxApi(ctx: ApiGroupContext): Record<string, Function> {
    return {
        methodA: async function(...) { ... },
        methodB: function(...) { ... },
    };
}
```

共享上下文类型：

```typescript
interface ApiGroupContext {
    /** 表格更新回调列表 */
    tableUpdateCallbacks: Function[];
    /** 填表开始回调列表 */
    tableFillStartCallbacks: Function[];
    /** 获取完整 API 对象的引用（解决 this 引用） */
    getApi: () => any;
}
```

---

## 三、执行计划

### Phase 1：创建分组文件（9 个文件）

按以下顺序创建，每个文件从 api-registry.ts 中提取对应方法：

| 步骤 | 文件 | 提取的方法 | 特殊处理 |
|:----:|------|-----------|---------|
| 1 | `callback-api.ts` | registerTableUpdateCallback / unregisterTableUpdateCallback / _notifyTableUpdate / registerTableFillStartCallback / _notifyTableFillStart | 包含回调数组状态的创建和管理 |
| 2 | `core-data-api.ts` | exportTableAsJson / importTableAsJson / triggerUpdate | importTableAsJson 是最大的单个方法（~130行） |
| 3 | `table-crud-api.ts` | updateCell / updateRow / insertRow / deleteRow | 提取"查找表格最新楼层"公共函数 `findTableLatestFloor` |
| 4 | `table-lock-api.ts` | getTableLockState / setTableLockState / clearTableLocks / lockTableRow / lockTableCol / lockTableCell / toggleTableRowLock / toggleTableColLock / toggleTableCellLock / getSpecialIndexLockEnabled / setSpecialIndexLockEnabled | 纯转发，无共享状态依赖 |
| 5 | `template-preset-api.ts` | getTemplatePresetNames / switchTemplatePreset / injectTemplatePresetToCurrentChat / importTemplateFromData / getTableTemplate | `injectTemplatePresetToCurrentChat` 需要通过 ctx.getApi() 调用 switchTemplatePreset |
| 6 | `plot-preset-api.ts` | getPlotPresets / getCurrentPlotPreset / switchPlotPreset / injectPlotPresetToCurrentChat / getPlotPresetDetails / getPlotPresetNames / importPlotPresetFromData / importPlotPresetsFromData / exportAllPlotPresets / initGameSession | 多个方法有 this 互调，需统一使用 ctx.getApi() |
| 7 | `data-admin-api.ts` | importTemplate / exportTemplate / resetTemplate / resetAllDefaults / exportJsonData / importCombinedSettings / exportCombinedSettings / overrideWithTemplate / importTxtAndSplit / injectImportedSelected / injectImportedStandard / injectImportedSummary / injectImportedFull / deleteImportedEntries / clearImportedEntries / clearImportCache / mergeSummaryNow | 全部是单行包装函数 |
| 8 | `settings-config-api.ts` | openSettings / openVisualizer / manualUpdate / getUpdateConfigParams / setUpdateConfigParams / getManualSelectedTables / setManualSelectedTables / clearManualSelectedTables / getApiPresets / getTableApiPreset / setTableApiPreset / getPlotApiPreset / setPlotApiPreset / saveApiPreset / loadApiPreset / deleteApiPreset | 无 this 互调 |
| 9 | `worldbook-ai-api.ts` | syncWorldbookEntries / refreshDataAndWorldbook / deleteInjectedEntries / setOutlineEntryEnabled / setZeroTkOccupyMode / reoptimizeMessage / cancelContentOptimization / callAI / getStoryContext | callAI 是第二大单个方法（~110行） |

### Phase 2：重写主文件 api-registry.ts

重写后的 api-registry.ts 结构：

```typescript
import { topLevelWindow_ACU } from '../../shared/env';
import { createCallbackApi } from './api-groups/callback-api';
import { createCoreDataApi } from './api-groups/core-data-api';
import { createTableCrudApi } from './api-groups/table-crud-api';
import { createTableLockApi } from './api-groups/table-lock-api';
import { createTemplatePresetApi } from './api-groups/template-preset-api';
import { createPlotPresetApi } from './api-groups/plot-preset-api';
import { createDataAdminApi } from './api-groups/data-admin-api';
import { createSettingsConfigApi } from './api-groups/settings-config-api';
import { createWorldbookAiApi } from './api-groups/worldbook-ai-api';

// 共享上下文
const tableUpdateCallbacks: Function[] = [];
const tableFillStartCallbacks: Function[] = [];

let apiRef: any = null;
const ctx = {
    tableUpdateCallbacks,
    tableFillStartCallbacks,
    getApi: () => apiRef,
};

// 组装
const api = Object.assign(
    {},
    createCallbackApi(ctx),
    createCoreDataApi(ctx),
    createTableCrudApi(ctx),
    createTableLockApi(ctx),
    createTemplatePresetApi(ctx),
    createPlotPresetApi(ctx),
    createDataAdminApi(ctx),
    createSettingsConfigApi(ctx),
    createWorldbookAiApi(ctx),
);

apiRef = api;

// 挂载到全局
(topLevelWindow_ACU as any).AutoCardUpdaterAPI = api;
```

### Phase 3：验证

1. `npm run build` — 确保 tsc 编译 0 ERROR
2. `scripts/check-arch.sh` — 确保架构检查 0 违规
3. 确认 `AutoCardUpdaterAPI` 全局对象上所有方法仍然可用
4. 确认 `_notifyTableUpdate` / `_notifyTableFillStart` 外部调用路径不变
5. 更新 `docs/代码结构视图.md`

---

## 四、风险与注意事项

### 4.1 this 引用风险

**高风险**：以下方法通过 `this` 互调，必须在组装后才能正确工作：
- `injectTemplatePresetToCurrentChat` → `this.switchTemplatePreset`
- `importPlotPresetFromData` → `this.injectPlotPresetToCurrentChat`
- `importPlotPresetsFromData` → `this.importPlotPresetFromData`
- `initGameSession` → `this.importPlotPresetFromData`

**解决方案**：在分组文件中将 `this.xxx(...)` 替换为 `ctx.getApi().xxx(...)`，通过共享上下文的 `getApi()` 获取最终组装后的 API 对象引用。

### 4.2 回调数组的闭包引用

`tableUpdateCallbacks` 和 `tableFillStartCallbacks` 在 callback-api.ts 和 core-data-api.ts / table-crud-api.ts 中都会被访问（`_notifyTableUpdate` 在内部使用，外部也通过全局对象调用）。

**解决方案**：回调数组在主文件中创建，通过 `ctx` 传入所有分组。

### 4.3 import 语句拆分

原文件 33 条 import 将分散到各分组文件中。每个分组文件只 import 自己需要的依赖。

### 4.4 表格 CRUD 的重复代码

`updateRow` / `insertRow` / `deleteRow` 中有大段重复的"查找表格最新楼层"逻辑（每个约 50 行），可提取为 `table-crud-api.ts` 内部的 `findTableLatestFloor` 工具函数。

---

## 五、预期成果

| 指标 | 改造前 | 改造后 |
|------|:------:|:------:|
| api-registry.ts 行数 | 2,040 | ~80 |
| 文件数 | 1 | 10（1 主文件 + 9 分组） |
| 最大单文件行数 | 2,040 | ~440（table-crud-api.ts） |
| tsc ERROR | 0 | 0 |
| 架构违规 | 0 | 0 |
| 运行时行为变更 | — | 无 |

---

## 六、依赖关系（分组 → 被 import 的模块）

### callback-api.ts
- `../../shared/utils`（logDebug_ACU / logError_ACU）

### core-data-api.ts
- `../../shared/utils`（logDebug_ACU / logError_ACU / logWarn_ACU / isSummaryOrOutlineTable_ACU）
- `../../shared/env`（topLevelWindow_ACU）
- `../../service/runtime/state-manager`（currentJsonTableData_ACU / _set_currentJsonTableData_ACU / SillyTavern_API_ACU / isAutoUpdatingCard_ACU / _set_isAutoUpdatingCard_ACU / settings_ACU / getCurrentIsolationKey_ACU）
- `../../service/template/chat-scope`（sanitizeChatSheetsObject_ACU / sanitizeSheetForStorage_ACU）
- `../../service/worldbook/pipeline`（loadAllChatMessages_ACU）
- `../../service/runtime/helpers-remaining`（getEffectiveAutoUpdateThreshold_ACU）
- `../triggers/update-process`（proceedWithCardUpdate_ACU / saveCurrentDataForTable_ACU）
- `../components/pipeline-ui-helpers`（refreshMergedDataAndNotifyWithUI_ACU）
- `../theme/toast`（showToastr_ACU）
- `../../shared/constants`（ACU_TOAST_CATEGORY_ACU）

### table-crud-api.ts
- `../../shared/utils`（logDebug_ACU / logError_ACU / logWarn_ACU / isSummaryOrOutlineTable_ACU）
- `../../shared/env`（topLevelWindow_ACU）
- `../../service/runtime/state-manager`（currentJsonTableData_ACU / SillyTavern_API_ACU / settings_ACU / getCurrentIsolationKey_ACU）
- `../../service/table/table-service`（saveIndependentTableToChatHistory_ACU）
- `../triggers/update-process`（saveCurrentDataForTable_ACU）
- `../components/pipeline-ui-helpers`（refreshMergedDataAndNotifyWithUI_ACU）

### table-lock-api.ts
- `../../shared/utils`（logError_ACU）
- `../../service/runtime/helpers-remaining`（getTableLocksForSheet_ACU / saveTableLocksForSheet_ACU / toggleRowLock_ACU / toggleColLock_ACU / toggleCellLock_ACU / isSpecialIndexLockEnabled_ACU / setSpecialIndexLockEnabled_ACU）

### template-preset-api.ts
- `../../shared/utils`（logDebug_ACU / logError_ACU）
- `../../shared/defaults-json.js`（TABLE_TEMPLATE_ACU）
- `../../shared/template-preset-utils`（normalizeTemplatePresetSelectionValue_ACU / deriveTemplatePresetNameForImport_ACU）
- `../../service/template/template-preset-service`（applyTemplatePresetToCurrent_ACU / applyTemplateSnapshotToScope_ACU / listTemplatePresetNames_ACU / normalizeTemplateOperationScope_ACU / parseImportedTemplateData_ACU / upsertTemplatePreset_ACU）
- `../components/template-preset-ui`（refreshTemplatePresetSelectInUI_ACU）

### plot-preset-api.ts
- `../../shared/utils`（logDebug_ACU / logError_ACU / logWarn_ACU）
- `../../shared/env`（topLevelWindow_ACU）
- `../../shared/template-preset-utils`（deriveTemplatePresetNameForImport_ACU）
- `../../service/runtime/state-manager`（settings_ACU / SillyTavern_API_ACU）
- `../../service/plot/plot-logic`（getCurrentRuntimePlotPresetName_ACU / normalizePlotPresetExcludeRules_ACU / switchCurrentChatPlotPreset_ACU）
- `../../service/runtime/helpers-remaining`（fillFirstLayerWithTemplateData_ACU）
- `../../service/template/chat-scope`（overwriteChatSheetGuideFromTemplate_ACU）
- `../components/settings-ui-helpers`（saveSettingsAndNotify_ACU）

### data-admin-api.ts
- `../../shared/utils`（logError_ACU）
- `../triggers/data-admin-ui`（exportCurrentJsonData_ACU / exportTableTemplate_ACU / importTableTemplate_ACU / overrideLatestLayerWithTemplate_ACU / resetAllToDefaults_ACU / resetTableTemplate_ACU）
- `../triggers/admin-ui`（importCombinedSettings_ACU）
- `../triggers/update-trigger`（exportCombinedSettings_ACU / handleManualMergeSummary_ACU）
- `../triggers/import-process`（clearImportLocalStorage_ACU / clearImportedEntries_ACU / deleteImportedEntries_ACU / handleInjectImportedTxtSelected_ACU）
- `../components/import-status-ui`（handleTxtImportAndSplit_ACU / handleInjectSplitEntriesFull_ACU / handleInjectSplitEntriesStandard_ACU / handleInjectSplitEntriesSummary_ACU）

### settings-config-api.ts
- `../../shared/utils`（logDebug_ACU / logError_ACU）
- `../../service/runtime/state-manager`（settings_ACU / currentJsonTableData_ACU）
- `../../service/template/chat-scope`（getSortedSheetKeys_ACU）
- `../pages/main-popup`（openAutoCardPopup_ACU）
- `../pages/visualizer`（openNewVisualizer_ACU）
- `../theme/toast`（showToastr_ACU）
- `../triggers/update-process`（handleManualUpdate_ACU）
- `../triggers/settings-ui-sync`（deleteApiPreset_ACU / loadApiPreset_ACU / saveApiPreset_ACU）
- `../components/settings-ui-helpers`（saveSettingsAndNotify_ACU）

### worldbook-ai-api.ts
- `../../shared/utils`（logDebug_ACU / logError_ACU）
- `../../shared/env`（topLevelWindow_ACU）
- `../../service/runtime/state-manager`（settings_ACU / currentJsonTableData_ACU / SillyTavern_API_ACU / TavernHelper_API_ACU）
- `../../service/settings/settings-service`（setZeroTkOccupyMode_ACU / getCurrentWorldbookConfig_ACU）
- `../../service/worldbook/pipeline`（deleteAllGeneratedEntries_ACU / updateReadableLorebookEntry_ACU）
- `../../service/worldbook/injection-engine`（updateOutlineTableEntry_ACU）
- `../../service/runtime/helpers-remaining`（formatJsonToReadable_ACU）
- `../../service/ai/api-call`（getApiConfigByPreset_ACU）
- `../../service/ai/prompt-builder`（handleApiResponse_ACU）
- `../../service/optimization/content-optimization`（cancelContentOptimization_ACU）
- `../components/optimization-ui`（reoptimizeMessage_ACU）
- `../components/pipeline-ui-helpers`（refreshMergedDataAndNotifyWithUI_ACU）

---

*文档创建时间：2026-04-14*
*基于 commit: 001-three-layer-refactor 分支*
