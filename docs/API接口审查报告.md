# API 接口全链路审查报告

> 审查范围：从 `presentation` 层出发，追踪 `AutoCardUpdaterAPI` 对外暴露的全部 80+ 个接口，验证每条调用链 `presentation → service → data` 是否打通，并排查 bug。
>
> 审查日期：2026-04-13

---

## 一、总览

| 指标 | 数值 |
|------|------|
| 暴露 API 方法数 | 80+ |
| 追踪的 service 层函数 | 33 |
| 追踪的 presentation 层函数 | 30 |
| 全部存在且正确导出 | ✅ |
| 发现的 Bug | **5** |
| 代码质量问题 | **3** |

---

## 二、Bug 清单

### BUG-1：`stopAutoLoop_ACU` 未导入 — 运行时 ReferenceError 🔴

**严重程度：高（运行时崩溃）**

| 项目 | 详情 |
|------|------|
| 文件 | `src/presentation/bootstrap/init.ts` |
| 行号 | 第 127 行 |
| 问题 | `stopAutoLoop_ACU()` 被直接调用，但 **未出现在文件的 import 语句中** |
| 定义位置 | `src/presentation/triggers/auto-loop.ts` 第 61 行，已正确 `export` |
| 影响 | 当用户切换聊天时，如果自动化循环正在运行（`loopState_ACU.isLooping === true`），会触发 `ReferenceError: stopAutoLoop_ACU is not defined`，导致整个 `CHAT_CHANGED` 事件处理中断，**后续的预设加载、TavernHelper 钩子注册、数据刷新全部跳过** |
| 复现条件 | 启动 Auto Loop → 切换到另一个聊天 |

```typescript
// init.ts 第 125-129 行
if (loopState_ACU.isLooping) {
    stopAutoLoop_ACU();  // ← 未导入！
    showToastr_ACU('info', '切换聊天，自动化循环已停止。');
}
```

---

### BUG-2：`DatabaseAPI_ACU` 中 `callAI` 重复定义 🟡

**严重程度：低（死代码，不影响运行）**

| 项目 | 详情 |
|------|------|
| 文件 | `src/presentation/bootstrap/api-registry.ts` |
| 行号 | 第 2058 行（第一次）、第 2196 行（第二次） |
| 问题 | `DatabaseAPI_ACU` 对象中 `callAI` 属性出现两次，后者用 `// @ts-ignore` 压制了 TS 报错 |
| 影响 | JavaScript 对象字面量中同名属性，后者覆盖前者。第一版（使用 `handleApiResponse_ACU`）被第二版（手动 SSE 流式解析）覆盖 |
| 备注 | 由于 `DatabaseAPI_ACU` 整体是死代码（见 BUG-3），此 bug 实际不触发 |

---

### BUG-3：`DatabaseAPI_ACU` 整体为死代码 🟡

**严重程度：低（代码膨胀，不影响运行）**

| 项目 | 详情 |
|------|------|
| 文件 | `src/presentation/bootstrap/api-registry.ts` |
| 行号 | 第 2051 ~ 2331 行（约 **280 行**） |
| 问题 | `const DatabaseAPI_ACU = { ... }` 定义了一个局部变量，但 **未被导出、未被挂载到全局、未被任何代码引用** |
| 证据 | 全项目搜索 `DatabaseAPI_ACU.` 结果为 **0 匹配**；无 `export`、无 `import`、无属性访问 |
| 影响 | 280 行无效代码膨胀构建产物；其 `callAI` / `getStoryContext` 是 `AutoCardUpdaterAPI` 同名方法的**旧版简化副本**，功能完全被覆盖 |

---

### BUG-4：`insertRow` 中 `if (true)` 硬编码条件 🟡

**严重程度：低（逻辑正确但代码残留）**

| 项目 | 详情 |
|------|------|
| 文件 | `src/presentation/bootstrap/api-registry.ts` |
| 行号 | 第 935 行 |
| 问题 | `if (true) { ... }` — 永远为真的条件判断，是从 `updateRow` 的 `if (!data?.isImportMode)` 改造时残留的 |
| 对比 | `updateRow` 第 811 行有 `if (!data?.isImportMode)` 条件保护；`deleteRow` 第 1055 行也有 `if (true)`（同样的残留问题） |
| 影响 | 不影响功能，但可能误导维护者 |

```typescript
// insertRow 第935行
if (true) {  // ← 应删除 if 包裹，直接执行内部代码
    logDebug_ACU(`insertRow: Saving [${tableName}] to its latest floor ${tableLatestFloorIndex}`);
    await saveIndependentTableToChatHistory_ACU(...);
    await refreshMergedDataAndNotifyWithUI_ACU();
}
```

---

### BUG-5：`deleteRow` 中同样存在 `if (true)` 硬编码 🟡

**严重程度：低（同 BUG-4）**

| 项目 | 详情 |
|------|------|
| 文件 | `src/presentation/bootstrap/api-registry.ts` |
| 行号 | 第 1055 行 |
| 问题 | 与 BUG-4 完全相同 |

---

## 三、代码质量问题

### QA-1：`refreshUi: false` 死参数残留（2 处）

| 调用位置 | 行号 | 被调用函数 | 实际签名中有 `refreshUi`？ |
|----------|------|-----------|:-------------------------:|
| `switchPlotPreset` / `injectPlotPresetToCurrentChat` | 1121, 1152 | `switchCurrentChatPlotPreset_ACU` | ❌ 已移除（注释写着"去掉 refreshUi"） |
| `switchTemplatePreset` | 379 | `applyTemplatePresetToCurrent_ACU` | ❌ 签名中无此参数 |

**影响**：JS/TS 解构中多余属性被静默忽略，运行时不报错。但 `refreshUi: false` 暗示"不刷新 UI"的语义，实际完全不起作用，**可能误导开发者**。

---

### QA-2：`init.ts` 中存在空语句 `;`

| 文件 | 行号 | 代码 |
|------|------|------|
| `init.ts` | 379, 395, 447 | `setSendTextareaValue_ACU(t);` 后紧跟一个独立的 `;` |

```typescript
setSendTextareaValue_ACU(t);
;   // ← 多余的空语句
```

---

### QA-3：`src/index.ts` 中 import 分层注释与实际内容不符

| 行号 | 注释 | 实际 import |
|------|------|------------|
| 39 | `// service 层` 区域 | `./presentation/triggers/update-process` |
| 42 | `// service 层` 区域 | `./presentation/triggers/admin-ui` |
| 44 | `// service 层` 区域 | `./presentation/triggers/import-process` |
| 45 | `// service 层` 区域 | `./presentation/bootstrap/init` |
| 49 | `// service 层` 区域 | `./presentation/bootstrap/api-registry` |

这些 presentation 层模块被放在了 `// service 层` 注释区域下。

---

## 四、全链路打通确认

### 4.1 service 层函数追踪（33 个）

| 源文件 | 函数数量 | 状态 |
|--------|:--------:|:----:|
| `service/table/table-service.ts` | 1 | ✅ |
| `service/runtime/helpers-remaining.ts` | 10 | ✅ |
| `service/settings/settings-service.ts` | 2 | ✅ |
| `service/worldbook/injection-engine.ts` | 1 | ✅ |
| `service/worldbook/pipeline.ts` | 3 | ✅ |
| `service/plot/plot-logic.ts` | 3 | ✅ |
| `service/optimization/content-optimization.ts` | 1 | ✅ |
| `service/template/template-preset-service.ts` | 6 | ✅ |
| `service/template/chat-scope.ts` | 4 | ✅ |
| `service/ai/api-call.ts` | 1 | ✅ |
| `service/ai/prompt-builder.ts` | 1 | ✅ |

### 4.2 presentation 层函数追踪（30 个）

| 源文件 | 函数数量 | 状态 |
|--------|:--------:|:----:|
| `pages/main-popup.ts` | 1 | ✅ |
| `pages/visualizer.ts` | 1 | ✅ |
| `components/import-status-ui.ts` | 4 | ✅ |
| `theme/toast.ts` | 1 | ✅ |
| `triggers/admin-ui.ts` | 1 | ✅ |
| `triggers/import-process.ts` | 4 | ✅ |
| `components/settings-ui-helpers.ts` | 1 | ✅ |
| `triggers/update-process.ts` | 3 | ✅ |
| `components/pipeline-ui-helpers.ts` | 1 | ✅ |
| `components/optimization-ui.ts` | 1 | ✅ |
| `components/template-preset-ui.ts` | 1 | ✅ |
| `triggers/data-admin-ui.ts` | 6 | ✅ |
| `triggers/settings-ui-sync.ts` | 3 | ✅ |
| `triggers/update-trigger.ts` | 2 | ✅ |

### 4.3 初始化链路（`init.ts`）

| 检查项 | 状态 |
|--------|:----:|
| import 路径全部有效 | ✅ |
| 架构违规（presentation→data 直引） | ✅ 无违规 |
| `runOptimizationLogicWithUI_ACU` 文件存在 | ✅ |
| `enterLoopRetryFlow_ACU` / `onLoopGenerationEnded_ACU` 已导出 | ✅ |
| **`stopAutoLoop_ACU` 缺失导入** | **✅ 已修复（FIX-1）** |

---

## 五、修复计划（全部已完成 ✅）

### P0 — 必须立即修复（运行时崩溃）

| 编号 | 修复内容 | 文件 | 预估行数 |
|------|---------|------|:--------:|
| FIX-1 | 在 `init.ts` 中添加 `stopAutoLoop_ACU` 的 import | `src/presentation/bootstrap/init.ts` | 1 |

```typescript
// 修改第 22 行
import { enterLoopRetryFlow_ACU, onLoopGenerationEnded_ACU } from '../triggers/auto-loop';
// → 改为
import { enterLoopRetryFlow_ACU, onLoopGenerationEnded_ACU, stopAutoLoop_ACU } from '../triggers/auto-loop';
```

### P1 — 建议修复（死代码清理）

| 编号 | 修复内容 | 文件 | 预估行数 |
|------|---------|------|:--------:|
| FIX-2 | 删除 `DatabaseAPI_ACU` 整个对象定义（第 2051~2331 行） | `src/presentation/bootstrap/api-registry.ts` | -280 |
| FIX-3 | 移除 `insertRow` 中的 `if (true)` 包裹（第 935 行） | `src/presentation/bootstrap/api-registry.ts` | 1 |
| FIX-4 | 移除 `deleteRow` 中的 `if (true)` 包裹（第 1055 行） | `src/presentation/bootstrap/api-registry.ts` | 1 |

### P2 — 代码清洁度改善

| 编号 | 修复内容 | 文件 | 预估行数 |
|------|---------|------|:--------:|
| FIX-5 | 移除 `switchPlotPreset` 调用中 `refreshUi: false`（第 1121 行） | `api-registry.ts` | 1 |
| FIX-6 | 移除 `injectPlotPresetToCurrentChat` 调用中 `refreshUi: false`（第 1152 行） | `api-registry.ts` | 1 |
| FIX-7 | 移除 `switchTemplatePreset` 调用中 `refreshUi: false`（第 379 行） | `api-registry.ts` | 1 |
| FIX-8 | 移除 `init.ts` 中多余的空语句 `;`（第 379, 395, 447 行） | `init.ts` | 3 |
| FIX-9 | 修正 `src/index.ts` 中 presentation 层 import 的分层注释 | `src/index.ts` | 6 |

---

## 六、结论

**核心链路已打通**。从 `AutoCardUpdaterAPI` 暴露的全部 80+ 个方法，到底层 service/data 层的调用链均正确连接，所有被引用的函数均存在且已正确导出。

**需要立即修复的只有 1 个高优先级 bug**（BUG-1：`stopAutoLoop_ACU` 未导入），此 bug 会在特定操作路径下导致运行时崩溃。其余问题均为低优先级的死代码清理和代码风格改善。
