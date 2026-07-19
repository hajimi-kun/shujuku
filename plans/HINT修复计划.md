# HINT 修复计划（360+ 条）

## 修复顺序

按 **Code → 文件** 两级排序，先修简单的再修大头。

### 第一轮：Code 80007 — 多余 await（5 条，1 个文件）

| 文件 | 行号 | 内容 |
|------|------|------|
| api-registry.ts | 350,351,354,355,356 | 这5行的 async 函数内部 await 了非 Promise 返回值 |

**修复方式**：确认被调用函数是否真的不返回 Promise。如果确实不返回，去掉 `await`；如果返回 Promise 只是 TS 没推断出来，保留 `await` 不改。

### 第二轮：Code 6133/6192 — 未使用声明（~50 条，5 个文件）

| 文件 | 6133 数量 | 说明 |
|------|:---------:|------|
| popup-bindings.ts | 26 | 大量 UI 元素变量从 ui-refs 导入但未在本文件使用（这些是通过 `_assignUIPlaceholders_ACU` 间接赋值的副作用导入，**不能删**） |
| optimization-ui.ts | 21 | 混合：部分是未使用的 re-export 导入（可能是副作用依赖），部分是真正未使用的局部变量 |
| api-registry.ts | 2 | `getCurrentWorldbookConfig_ACU`、`presetName` |
| data-admin-ui.ts | 1 | `importCombinedSettings_ACU` |
| auto-loop.ts | 1 | `loopSettings` |

**修复方式**：
- popup-bindings.ts 的 26 个是**副作用导入**（`_assignUIPlaceholders_ACU` 需要这些变量在 scope 里才能赋值），**不能删除**，用 `// @ts-ignore` 或移到 `_assignUIPlaceholders_ACU` 调用处
- 其他真正未使用的：删除 import 或用 `_` 前缀

### 第三轮：Code 7043 — 变量隐式 any（~15 条，3 个文件）

| 文件 | 数量 | 典型变量 |
|------|:----:|---------|
| window-system.ts | 10 | `initialW`, `initialH`, `dragStartX`, `resizeStartX` 等 |
| api-registry.ts | 3 | `preset`, `templateData`, `presetData` |
| optimization-ui.ts | 2 | 内部变量 |

**修复方式**：给变量声明加显式类型注解（如 `let initialW: number`）

### 第四轮：Code 80004 — JSDoc 类型迁移（~40 条，2 个文件）

| 文件 | 数量 |
|------|:----:|
| api-registry.ts | 30 |
| optimization-ui.ts | 8 |
| window-system.ts | 3 |

**修复方式**：将 JSDoc `@param {type} name` 迁移到函数签名 `name: type`，然后删除 JSDoc 类型标注

### 第五轮：Code 7044 — 参数隐式 any（~250 条，11 个文件）

这是大头。按文件 HINT 数量排列：

| 文件 | 7044 数量 | 修复策略 |
|------|:---------:|---------|
| api-registry.ts | 69 | 给每个方法参数加 `: any`（保守）或具体类型 |
| optimization-ui.ts | 38 | 同上 |
| popup-bindings.ts | 31 | 同上 |
| window-system.ts | 20 | 给参数加 `: string`/`: number`/`: any` |
| visualizer-main.ts | 30 | 同上 |
| settings-ui-sync.ts | 20 | 同上 |
| plot-editors.ts | 20 | 同上 |
| import-process.ts | 14 | 同上 |
| init.ts | 10 | 同上 |
| visualizer-sidebar.ts | 10 | 同上 |
| data-admin-ui.ts | 8 | 同上 |

**修复方式**：统一给参数加 `: any` 注解。虽然不是最精确的类型，但能消除 HINT 且零风险。后续可以渐进式地将 `any` 替换为具体类型。

## 总工作量预估

| 轮次 | 条目数 | 预计修改文件数 | 风险 |
|:----:|:------:|:------------:|:----:|
| 1 | 5 | 1 | 低 |
| 2 | ~50 | 5 | 中（需判断副作用导入） |
| 3 | ~15 | 3 | 低 |
| 4 | ~40 | 3 | 低 |
| 5 | ~250 | 11 | 低（但改动量大） |
| **总计** | **~360** | **~15** | |
