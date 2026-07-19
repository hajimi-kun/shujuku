# TypeScript 类型错误修复计划

> 总计 291 个问题（~264 ERROR + ~27 HINT），分布在 10 个 presentation 层文件中
>
> 制定日期：2026-04-13

---

## 一、问题分类总览

| 类别 | ERROR 数 | 根因 | 修复策略 |
|------|:--------:|------|---------|
| A. `refreshUi` 参数不在签名中 | 15 | service 层函数重构时移除了 `refreshUi` 参数，presentation 层调用方未同步 | 从所有调用方移除 `refreshUi` 参数 |
| B. "找不到名称" — UI 状态变量未导入 | ~80 | `$popupInstance_ACU`、`$cardUpdateStatusDisplay_ACU` 等 UI ref 变量在 `state/ui-refs.ts` 中定义但使用方未导入 | 在各文件顶部添加 import |
| C. "找不到名称" — `jQuery_API_ACU` 未导入 | ~80 | `jQuery_API_ACU` 在 `shared/host-api.ts` 导出，但 visualizer-main.ts 等未导入 | 在各文件顶部添加 import |
| D. "找不到名称" — `_acuVisState` 未声明 | ~40 | 可视化编辑器的状态对象，从旧代码迁移时未创建对应的模块变量 | 在 `presentation/state/` 中声明并导出，使用方 import |
| E. "找不到名称" — 其他函数未导入 | ~15 | `getActivePlotEditorSettings_ACU`、`closeACUWindow`、`DEFAULT_PLOT_SETTINGS_ACU` 等 | 逐个添加 import |
| F. 类型不兼容 | 4 | `fillFirstLayerWithTemplateData_ACU` 返回 `false \| { success, ... }` 但调用方未做类型收窄 | 添加 `if (fillResult && typeof fillResult !== 'boolean')` 类型守卫 |
| G. 其他类型错误 | ~5 | `number` 赋值给 `string`、`unknown` 参数类型不匹配等 | 逐个修复类型标注 |
| H. HINT（implicit any） | ~270 | 参数缺少类型注解 | 低优先级，不影响运行 |

---

## 二、按文件分布

| 文件 | ERROR | HINT | 主要错误类别 |
|------|:-----:|:----:|-------------|
| `visualizer-main.ts` | 112 | 30 | C(jQuery) + D(_acuVisState) + E($popupInstance) |
| `plot-editors.ts` | 61 | 26 | B($popupInstance等) + E(DEFAULT_PLOT_SETTINGS) |
| `visualizer-sidebar.ts` | 39 | 11 | C(jQuery) + D(_acuVisState) |
| `update-status-display.ts` | 15 | 2 | B($popupInstance, $cardUpdateStatusDisplay) + G(number→string) |
| `visualizer.ts` | 13 | 2 | C(jQuery) + E(closeACUWindow, createACUWindow) |
| `popup-bindings.ts` | 9 | 59 | A(refreshUi ×9) |
| `optimization-ui.ts` | 7 | 72 | E(getActivePlotEditorSettings等) |
| `api-registry.ts` | 4 | 111 | A(refreshUi ×1) + F(fillResult类型) |
| `data-admin-ui.ts` | 3 | 9 | A(refreshUi ×3) |
| `admin-ui.ts` | 1 | 1 | A(refreshUi ×1) |

---

## 三、执行计划（按优先级分批）

### 批次 1：`refreshUi` 参数清理（15 ERROR → 0）

**原理**：4 个 service 层函数在重构时已从签名中移除了 `refreshUi`（注释明确写着"纯业务逻辑，不做 UI 刷新"），但 presentation 层调用方还在传递。

**涉及函数**：
- `applyTemplatePresetToCurrent_ACU` — 签名: `{ source, updateGlobal, save, persistChatScope }`
- `applyTemplateSnapshotToScope_ACU` — 签名: `{ scope, source, presetName, save, persistChatScope, registerChatPresetEntry }`
- `switchCurrentChatPlotPreset_ACU` — 签名: `{ source, save }`
- `applyGlobalPlotPresetSelectionForEditor_ACU` — 签名: `{ source, save }`

**涉及文件及行数**：

| 文件 | 行号 | 调用的函数 |
|------|------|-----------|
| `popup-bindings.ts` | 1058, 1079, 1121, 1157, 1257 | `applyTemplatePresetToCurrent_ACU` |
| `popup-bindings.ts` | 1297 | `applyTemplateSnapshotToScope_ACU` |
| `popup-bindings.ts` | 1775, 1792, 1959 | `applyGlobalPlotPresetSelectionForEditor_ACU` / `switchCurrentChatPlotPreset_ACU` |
| `api-registry.ts` | 1232 | `applyTemplateSnapshotToScope_ACU` |
| `data-admin-ui.ts` | 141, 617, 678 | `applyTemplateSnapshotToScope_ACU` |
| `admin-ui.ts` | 102 | `applyTemplateSnapshotToScope_ACU` |
| `visualizer-main.ts` | 991 | `applyTemplatePresetToCurrent_ACU` |

**操作**：从每处调用中移除 `refreshUi: ...` 参数。

---

### 批次 2：UI ref 变量导入（~80 ERROR → 0）

**涉及变量及定义位置**（均在 `src/presentation/state/ui-refs.ts`）：
- `$popupInstance_ACU`
- `$charCardPromptSegmentsContainer_ACU`
- `$plotPromptSegmentsContainer_ACU`
- `$plotTaskListContainer_ACU`
- `$cardUpdateStatusDisplay_ACU`
- `$statusMessageSpan_ACU`

**涉及文件**：
- `plot-editors.ts` — 需导入 `$popupInstance_ACU`, `$charCardPromptSegmentsContainer_ACU`, `$plotPromptSegmentsContainer_ACU`, `$plotTaskListContainer_ACU`
- `update-status-display.ts` — 需导入 `$popupInstance_ACU`, `$cardUpdateStatusDisplay_ACU`

**操作**：在文件顶部添加 `import { ... } from '../state/ui-refs';`

---

### 批次 3：jQuery_API_ACU 导入（~80 ERROR → 0）

**定义位置**：`src/shared/host-api.ts`（但部分文件可能从 `service/runtime/state-manager.ts` re-export）

**涉及文件**：
- `visualizer-main.ts` (~60处) — 添加 `import { jQuery_API_ACU } from '../../shared/host-api';`
- `visualizer-sidebar.ts` (~5处) — 同上
- `visualizer.ts` (~5处) — 同上

**操作**：在文件顶部添加 import。

---

### 批次 4：`_acuVisState` 状态声明（~40 ERROR → 0）

**现状**：`_acuVisState` 在 visualizer-main.ts 和 visualizer-sidebar.ts 中被大量使用，但没有找到定义和导出。可能是旧 JS 中的全局闭包变量。

**方案**：
1. 在 `src/presentation/state/visualizer-state.ts` 中声明并导出
2. 在 visualizer-main.ts 和 visualizer-sidebar.ts 中导入

---

### 批次 5：其他未导入函数（~15 ERROR → 0）

| 变量/函数 | 定义位置 | 使用文件 |
|-----------|---------|---------|
| `closeACUWindow` / `createACUWindow` | `presentation/window/window-system.ts` | `visualizer.ts`, `visualizer-main.ts` |
| `getActivePlotEditorSettings_ACU` | `service/plot/plot-logic.ts` | `optimization-ui.ts` |
| `getPlotPromptContentByIdFromSettings_ACU` | `service/plot/plot-logic.ts` | `optimization-ui.ts` |
| `setPlotPromptContentByIdForSettings_ACU` | `service/plot/plot-logic.ts` | `optimization-ui.ts` |
| `ensureLoopPromptsArray_ACU` | `service/plot/plot-logic.ts` | `optimization-ui.ts` |
| `DEFAULT_PLOT_SETTINGS_ACU` | `shared/defaults-json.js` | `plot-editors.ts` |
| `$` (jQuery) | 全局声明 | `plot-editors.ts` |
| `ACU_WindowManager` | `presentation/window/window-system.ts` | `visualizer.ts` |

**操作**：逐文件添加 import。

---

### 批次 6：类型不兼容修复（4 ERROR → 0）

**api-registry.ts 第 1471/1474/1476 行**：
```typescript
const fillResult = await fillFirstLayerWithTemplateData_ACU(...);
if (fillResult.success) { // ← ERROR: false 上不存在 success
```

**修复**：添加类型守卫
```typescript
if (fillResult && typeof fillResult === 'object' && fillResult.success) {
```

**update-status-display.ts 第 163/176/179 行**：
`number` 赋值给 `string` 类型变量。

---

### 批次 7：HINT 清理（低优先级）

约 270 个 HINT，主要是：
- 参数隐式 `any` 类型 — 添加类型注解
- 已声明但未使用的变量 — 删除或加下划线前缀
- JSDoc 类型可移到 TS 类型 — 迁移

**建议**：暂不处理，不影响运行和构建。后续按文件逐步补齐类型注解。

---

## 四、执行优先级

| 优先级 | 批次 | 预计消除 ERROR 数 | 预计耗时 |
|:------:|:----:|:-----------------:|:--------:|
| P0 | 批次 1：refreshUi 清理 | 15 | 低（搜索替换） |
| P0 | 批次 6：类型不兼容 | 7 | 低（逐个修） |
| P1 | 批次 2：UI ref 导入 | ~80 | 中（2个文件加 import） |
| P1 | 批次 3：jQuery 导入 | ~80 | 中（3个文件加 import） |
| P1 | 批次 4：_acuVisState | ~40 | 中（新建文件+导入） |
| P1 | 批次 5：其他函数导入 | ~15 | 中（4个文件加 import） |
| P2 | 批次 7：HINT 清理 | 0 ERROR / ~270 HINT | 高（逐个加类型注解） |

**预计修完批次 1~6 后，ERROR 从 264 降到 0。**
