# P4-B 执行计划：消除 30 条 presentation→data 违规

> 当前状态：33 条违规（service→pres 3 条 C/D 类暂保留，presentation→data 30 条）
> 目标：presentation→data 0 条
> 原则：**不建中转层、不建空壳包装、不建 re-export 门面。系统思考每段代码到底该在哪一层。**

---

## 第一类：纯函数/常量 → 搬到 shared 层（11 条 import 路径更新）

**已完成的工作（当前 git diff 中）：**

### 1.1 `shared/template-preset-utils.ts` 已创建
从 `data/repositories/template-preset-repo.ts` 搬出以下纯函数/常量：
- `DEFAULT_TEMPLATE_PRESET_OPTION_VALUE_ACU`（纯常量）
- `normalizeTemplatePresetSelectionValue_ACU`（纯函数）
- `isDefaultTemplatePresetSelection_ACU`（纯函数）
- `getCurrentTemplatePresetName_ACU`（纯函数，接受 settings 参数）
- `derivePresetNameFromFilename_ACU`（纯函数）
- `getCurrentCharacterCardName_ACU`（读 window 全局，不写存储）
- `deriveTemplatePresetNameForImport_ACU`（纯函数）
- `sanitizeFilenameComponent_ACU`（纯函数）

### 1.2 已更新的 import（7/9 个文件）
- ✅ `presentation/pages/visualizer-main.ts` → `shared/template-preset-utils`
- ✅ `presentation/pages/main-popup.ts` → `shared/template-preset-utils`
- ✅ `presentation/triggers/data-admin-ui.ts` → `shared/template-preset-utils`
- ✅ `presentation/triggers/admin-ui.ts` → `shared/template-preset-utils`
- ✅ `presentation/bootstrap/api-registry.ts` → `shared/template-preset-utils`
- ✅ `service/template/chat-scope.ts` → `shared/template-preset-utils`
- ✅ `service/runtime/helpers-remaining.ts` → `shared/template-preset-utils`
- ✅ `service/settings/settings-service.ts` → `shared/template-preset-utils`

### 1.3 待完成的 import 更新（2 个文件混合引用纯函数 + data 操作）
- [ ] `presentation/pages/popup-bindings.ts` — 纯函数改引 shared，`persistCurrentTemplatePresetName_ACU` 改引 service
- [ ] `presentation/components/template-preset-ui.ts` — 纯函数改引 shared，`persistCurrentTemplatePresetName_ACU` 改引 service

### 1.4 `data/repositories/template-preset-repo.ts` 清理
- [x] 已删除纯函数，只保留 `persistCurrentTemplatePresetName_ACU`
- [ ] `persistCurrentTemplatePresetName_ACU` 搬到 `service/settings/settings-service.ts`（已添加），原 data 文件中该函数删除
- [ ] 更新 `data/index.ts` 中的 re-export

### 1.5 `data/index.ts` 更新
- [ ] 删除 `export * from './repositories/template-preset-repo'`（该文件最终只剩空壳或可删除）

---

## 第二类：DI 注入函数 → 搬到 `service/runtime/di-setup.ts`（4 条）

**文件：** `presentation/bootstrap/init.ts` L4-7, L29-49

**现状：** `mainInitialize_ACU` 直接 import 4 个 `_inject*` 函数并调用。

**正确处理：** 将 DI 注入逻辑提取到 `service/runtime/di-setup.ts` 的 `initializeDataLayerDeps_ACU()` 函数中。init.ts 改为调用该 service 函数。

**步骤：**
- [ ] 创建 `service/runtime/di-setup.ts`，定义 `initializeDataLayerDeps_ACU(deps: { getSettings, getChatFileId, ... })` 函数
  - 内部 import 4 个 `_inject*` 并调用
  - 接受的参数由 init.ts 传入（settings_ACU getter 等）
- [ ] `init.ts` 删除对 4 个 data repo 的 import，改为 `import { initializeDataLayerDeps_ACU } from '../../service/runtime/di-setup'`
- [ ] 构建验证

---

## 第三类：`getCurrentWorldbookConfig_ACU` → 已在 service 层可用（4 条 presentation import）

**现状：** 4 个 presentation 文件直接 import `data/repositories/character-settings-repo` 的 `getCurrentWorldbookConfig_ACU`。

**分析：** `getCurrentWorldbookConfig_ACU` 做的是：读 settings → deep merge 默认值 → 写回 settings 对象。这是**业务逻辑**（不是纯 CRUD），它操作的是业务状态 `settings_ACU`。应该放在 service 层。

**但是：** `service/settings/settings-service.ts` 已经 import 了 `getCurrentCharSettings_ACU`（同一 repo）。这个函数链（`getCurrentWorldbookConfig → getCurrentCharSettings`）整体应该搬到 service 层。

**步骤：**
- [ ] 将 `getCurrentWorldbookConfig_ACU` 和 `getCurrentCharSettings_ACU` 搬到 `service/settings/settings-service.ts`
- [ ] `character-settings-repo.ts` 只保留 `_injectCharSettingsDeps`（DI 注入点）和被注入的 getter
- [ ] 更新 4 个 presentation 文件的 import → `service/settings/settings-service`
- [ ] 更新 service 层内部引用
- [ ] 构建验证

---

## 第四类：`globalMeta_ACU` + `saveGlobalMeta_ACU` → service 层提供访问器（2 条）

**现状：** `popup-bindings.ts` 和 `api-registry.ts` 直接读写 `globalMeta_ACU` 并调用 `saveGlobalMeta_ACU`。

**分析：** 两处使用场景都是「切换 0TK 占用模式」：
1. 读取 `getCurrentWorldbookConfig_ACU()` 修改配置
2. 修改 `globalMeta_ACU.zeroTkOccupyModeGlobal`
3. 调用 `saveGlobalMeta_ACU()`
4. 调用 `saveSettings_ACU()`

这整个流程是**"切换 0TK 占用模式"的业务操作**。

**步骤：**
- [ ] 在 `service/settings/settings-service.ts` 创建 `setZeroTkOccupyMode_ACU(modeEnabled: boolean)` 业务函数，封装上述完整流程（读 worldbookConfig → 设字段 → 写 globalMeta → 写 settings）
- [ ] `popup-bindings.ts` 和 `api-registry.ts` 的 0TK 切换逻辑改为调用该 service 函数
- [ ] 删除 presentation 层对 `globalMeta_ACU` 和 `saveGlobalMeta_ACU` 的直接 import
- [ ] 构建验证

---

## 第五类：`getDataIsolationHistory_ACU` + `removeDataIsolationHistory_ACU`（1 条）

**现状：** `popup-bindings.ts` 中渲染隔离标识历史下拉列表 + 删除历史条目。

**分析：** 这是 UI 读取 data 层列表数据来渲染下拉框。应该在 service 层提供"获取隔离历史列表"和"删除隔离历史条目"的业务函数。

**但是：** `service/settings/settings-service.ts` 已经 import 了 `isolation-repo` 的多个函数（`addDataIsolationHistory_ACU`, `ensureProfileExists_ACU`, `normalizeDataIsolationHistory_ACU`）。可以在同一文件补充。

**步骤：**
- [ ] 在 `service/settings/settings-service.ts` 添加：
  - `getDataIsolationHistory_ACU()` — 直接透传 `isolation-repo.getDataIsolationHistory_ACU()`
  - `removeDataIsolationHistory_ACU(code, opts)` — 直接透传
  注意：这不是空壳包装——service 层已经是隔离功能的编排中心（`switchIsolationProfile_ACU` 就在这里），补充这两个读/删操作是合理的。
- [ ] `popup-bindings.ts` 改为从 `service/settings/settings-service` import
- [ ] 构建验证

---

## 第六类：table-repo 的 3 个函数（6 条 presentation import）

### 6.1 `saveIndependentTableToChatHistory_ACU`（4 个 presentation 文件）

**分析：** 在所有场景中，该函数都与以下操作组合使用：
- `checkIfFirstTimeInit_ACU` → 判断是否首次初始化
- `refreshMergedDataAndNotify_ACU` → 刷新合并数据
- `updateReadableLorebookEntry_ACU` → 刷新世界书

这构成一个完整的 **"持久化表格变更并刷新"** 业务流程。

**步骤：**
- [ ] 在 `service/table/table-service.ts`（新文件）创建：
  ```ts
  async function persistTableChangesAndRefresh_ACU(
    saveTargetIndex: number,
    keysToSave: string[],
    updateGroupKeys: string[],
    options?: { skipPostRefresh?: boolean }
  ): Promise<boolean>
  ```
  内部调用 `saveIndependentTableToChatHistory_ACU` + 可选的 `refreshMergedDataAndNotify_ACU`
- [ ] 但不能一刀切——有些调用方传了 `skipPostRefresh=true` 然后自己刷新。需要逐个文件分析调用参数。

### 6.2 `loadOrCreateJsonTableFromChatHistory_ACU`（3 个 presentation 文件）

**分析：** 3 处调用场景：
1. `popup-bindings.ts` — 切换隔离标识后重载
2. `data-admin-ui.ts` — 删除聊天数据后重载 / 用模板覆盖后重载
3. `update-trigger.ts` — 手动合并纪要前刷新

这 3 个场景的共同模式是"强制从聊天记录重新加载内存数据库"。

**步骤：**
- [ ] 在 `service/table/table-service.ts` 创建 `reloadTableFromChatHistory_ACU()`
  内部调用 `loadOrCreateJsonTableFromChatHistory_ACU`
- [ ] 3 个 presentation 文件改为调用 service 函数

### 6.3 `checkIfFirstTimeInit_ACU`（2 个 presentation 文件）

**分析：** 总是和 `saveIndependentTableToChatHistory_ACU` 一起使用，决定是否需要保存完整模板结构。

**步骤：**
- [ ] 在 `service/table/table-service.ts` 中 `persistTableChangesAndRefresh_ACU` 内部处理首次初始化逻辑
  或者单独导出 `checkIfFirstTimeInit_ACU` 的转发
- [ ] 需要根据实际 `proceedWithCardUpdate_ACU` 的逻辑决定——如果 checkIfFirstTimeInit + saveIndependent 的组合很紧密，可以合并为一个 service 函数

---

## 第七类：`saveCurrentProfileTemplate_ACU`（1 条）

**现状：** `template-preset-ui.ts` L480 在 `applyTemplateSnapshotToScope_ACU` 中调用。

**分析：** 该调用发生在"将模板应用到全局作用域"时。`saveCurrentProfileTemplate_ACU` 做的是：根据当前 profile isolationCode 将模板字符串写入 profile 存储。

**步骤：**
- [ ] 这个函数应该放在 `service/settings/settings-service.ts` 中（它操作的是 profile 持久化 + isolationCode 判断）
- [ ] 将 `saveCurrentProfileTemplate_ACU` 从 `data/repositories/profile-repo.ts` 搬到 `service/settings/settings-service.ts`
- [ ] `template-preset-ui.ts` 改为从 service import
- [ ] 构建验证

---

## 第八类：`importTempGet/Set/Remove_ACU`（2 条 presentation import）

**现状：** `import-process.ts` 和 `import-status-ui.ts` 直接使用 IndexedDB 临时存储操作。

**分析：** 这些是**纯存储工具函数**（IndexedDB + 内存回退），不含业务逻辑。但按架构规则，presentation 不能直接调 data 层。

**正确处理：** 这些函数应该移到 `shared` 层。它们不依赖任何 data 层模块（只依赖 `shared/env` 和 `shared/constants`），本质是通用的 KV 存储工具。

**步骤：**
- [ ] 将 `importTempGet/Set/Remove_ACU` 以及它们依赖的 `idbGet/Set/Del_ACU`、`openImportTempDb_ACU` 等**整个 idb-import-temp.ts 文件**搬到 `shared/idb-import-temp.ts`
  - 检查依赖：只依赖 `shared/env` 和 `shared/constants`，没有 data 层依赖 ✓
- [ ] 更新所有 import 路径（presentation 层 2 个文件 + data/storage/tavern-storage.ts 中的 `isIndexedDbAvailable_ACU` 引用 + service 层引用）
- [ ] 构建验证

---

## 第九类：`getConfigStorage_ACU` + `persistTavernSettings_ACU`（3 条 presentation import）

**现状：** `window-styles.ts`、`window-system.ts`、`template-preset-ui.ts` 使用。

**分析：**
- `getConfigStorage_ACU` 是**通用配置存储门面**（酒馆设置 → IDB → localStorage 降级策略），被所有层使用
- `persistTavernSettings_ACU` 是**触发酒馆侧持久化**

这两个函数的本质是**存储基础设施**，不是业务逻辑。它们应该放在 `shared` 层或作为 data 层的内部实现被 service 层封装。

**方案：** 由于 `getConfigStorage_ACU` 依赖 `tavern-storage.ts` 中的大量酒馆桥接逻辑（`initTavernSettingsBridge_ACU`、`getTavernSettingsNamespace_ACU` 等），整个搬到 shared 不现实。

**正确处理：** presentation 层的 3 个使用场景是：
1. `window-styles.ts`: 读写 UI 主题（`getItem/setItem`）
2. `window-system.ts`: 读写窗口状态（`getItem/setItem`） + 触发酒馆持久化
3. `template-preset-ui.ts`: 读写模板预设库（`getItem/setItem`）

这 3 个场景都是"读写 UI 偏好/本地状态"，属于 presentation 层自己的职责。**但按架构规则不能直接调 data 层**。

**步骤：**
- [ ] 在 `service/settings/settings-service.ts` 添加以下封装函数：
  ```ts
  // UI 偏好/本地状态的读写封装
  function readConfigItem_ACU(key: string): any
  function writeConfigItem_ACU(key: string, value: any): void
  function triggerTavernPersist_ACU(): void
  ```
  这不是空壳包装——这是将"配置存储"的接口从 data 层暴露给 presentation 层的**唯一合法路径**，且包含了"选择正确的存储后端"这个业务决策。
- [ ] 3 个 presentation 文件改为调用 service 函数
- [ ] 构建验证

---

## 执行顺序

```
Step 1: 收尾第一类（2 个混合引用文件的 import 更新 + data/template-preset-repo.ts 清理）
         → 构建验证 → check-arch.sh（预期 -7~8 条）

Step 2: 第八类（idb-import-temp.ts 搬到 shared）
         → 构建验证 → check-arch.sh（预期 -2 条）

Step 3: 第二类（DI 注入提取到 service/runtime/di-setup.ts）
         → 构建验证 → check-arch.sh（预期 -4 条）

Step 4: 第三类 + 第四类 + 第五类 + 第七类
         （getCurrentWorldbookConfig + globalMeta/saveGlobalMeta + isolation history + saveCurrentProfileTemplate → 全部到 service/settings/settings-service.ts）
         → 构建验证 → check-arch.sh（预期 -8 条）

Step 5: 第六类（table-repo 3 个函数 → service/table/table-service.ts）
         → 构建验证 → check-arch.sh（预期 -6 条）

Step 6: 第九类（getConfigStorage + persistTavernSettings → service 封装）
         → 构建验证 → check-arch.sh（预期 -3 条）
```

最终目标：presentation→data 0 条
