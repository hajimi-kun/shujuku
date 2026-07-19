# 星·数据库 III — 三层架构重构初步方案

> 文档版本：v0.1-draft  
> 日期：2026-04-12  
> 分支：plus  
> 前置状态：第三轮模块化拆分已完成（core + ui + features + bootstrap），拼接产物与 index.js 全文一致

---

## 一、现状总结

### 1.1 项目概况

「星·数据库 III」（AutoCardUpdater / ACU）是一个 **Tampermonkey 用户脚本**，运行在 SillyTavern（AI 对话前端）的 iframe 页面环境中。核心功能：在对话过程中通过 AI 自动更新结构化数据表，并将结果注入到酒馆的世界书（Lorebook）中。

- **技术栈**：原生 JavaScript（ES2020+），依赖酒馆环境提供的 jQuery
- **总代码量**：~1.68 MB / 35,283 行（单文件 `index.js`）
- **构建方式**：自研 `build-index.js` 按固定顺序文本拼接回单文件
- **运行约束**：整个项目在一个 IIFE 闭包 `(function() { ... })();` 内，所有变量共享同一作用域

### 1.2 现有目录与模块

```
src/
├── core/                          # 基础设施层（~898 KB）
│   ├── 01_header_and_env.js       #   3.7 KB  - IIFE 开头、环境常量
│   ├── 02_storage_and_profile.js  # 250.7 KB  - 存储后端、Profile、默认配置
│   ├── 03_runtime_api.js          # 106.2 KB  - 运行时 API 挂载、流式响应处理
│   ├── 04_shared_helpers.js       # 375.2 KB  - 235+ 个公共工具函数
│   └── 05_core_tail.js            # 162.5 KB  - 世界书注入、数据持久化、初始化
├── ui/                            # UI 表示层（~547 KB）
│   ├── 01_window_system.js        #  30.0 KB  - 独立窗口系统、主题切换
│   ├── 02_shared_editors_and_selectors.js # 28.3 KB - 编辑器、选择器
│   ├── 03_theme_and_toast.js      #  13.0 KB  - Toast 通知、主题样式
│   ├── 04_table_selectors.js      #   8.2 KB  - 表格选择器
│   ├── 05_main_popup.js           # 348.0 KB  - 主弹窗(8个分页)
│   └── 06_visualizer.js           # 119.6 KB  - 可视化编辑器
├── features/                      # 业务功能层（~252 KB）
│   ├── startup/                   #   2.3 KB  - 启动入口
│   ├── import/                    #  31.6 KB  - 外部导入链路
│   ├── worldbook/                 #  46.6 KB  - 世界书管理
│   ├── runtime/                   #  11.0 KB  - 运行时状态统计
│   ├── ai/                        #  75.1 KB  - AI 调用链路
│   ├── table/                     #  13.6 KB  - 表格更新主流程
│   ├── summary/                   #  18.5 KB  - 纪要合并
│   ├── ui/                        #  39.9 KB  - 交互触发器
│   └── data/                      #  35.9 KB  - 配置导入导出
└── 03_bootstrap.js                #   8 B     - IIFE 闭合
```

### 1.3 当前架构的核心问题

| 问题 | 严重程度 | 说明 |
|------|---------|------|
| **三层混杂** | 🔴 高 | `core/` 同时包含存储逻辑、业务逻辑、数据模型；`05_core_tail.js` 单文件包含世界书注入（服务层）+ 数据持久化（数据库层）+ 初始化（控制层） |
| **巨型文件** | 🔴 高 | `04_shared_helpers.js`(375KB) 和 `05_main_popup.js`(348KB) 各自超过 8000/5700 行，是维护瓶颈 |
| **UI 与业务逻辑纠缠** | 🟡 中 | `05_main_popup.js` 中 HTML 模板字符串与事件绑定逻辑混在一起；`features/ui/` 既有交互控制也有数据操作 |
| **存储抽象缺失** | 🟡 中 | 酒馆设置、IndexedDB、聊天消息自定义字段三种存储后端散落在多个文件中，没有统一 Repository 接口 |
| **全局状态泛滥** | 🟡 中 | `currentJsonTableData_ACU`、`settings_ACU`、`allChatMessages_ACU` 等 30+ 全局 `let` 变量散布各处 |
| **拼接顺序锁定** | 🟠 低 | build-index.js 的拼接顺序 ≠ 逻辑分层顺序，增加理解成本 |

---

## 二、目标三层架构

### 2.1 分层定义

```
┌─────────────────────────────────────────────────────────┐
│                   表示层 (Presentation)                   │
│  职责：UI 渲染、用户交互、DOM 操作、样式                     │
│  原则：不直接操作存储，只通过服务层获取/提交数据              │
├─────────────────────────────────────────────────────────┤
│                    服务层 (Service)                       │
│  职责：业务逻辑编排、AI 调用、数据转换、工作流控制           │
│  原则：不操作 DOM，不直接操作存储后端，通过数据库层读写数据   │
├─────────────────────────────────────────────────────────┤
│                   数据库层 (Data)                         │
│  职责：数据持久化、存储后端抽象、数据模型定义                 │
│  原则：不包含业务逻辑，不操作 DOM，只暴露 CRUD 接口          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 目标目录结构（最终态）

```
src/
├── data/                          # 数据库层
│   ├── models/                    #   数据模型定义
│   │   ├── table-data.js          #     表格数据结构（sheet、mate 等）
│   │   ├── settings.js            #     设置数据结构 + 默认值
│   │   └── template.js            #     模板数据结构
│   ├── storage/                   #   存储后端抽象
│   │   ├── tavern-bridge.js       #     酒馆设置读写（extensionSettings）
│   │   ├── indexeddb.js           #     IndexedDB 本地缓存
│   │   ├── chat-history.js        #     聊天消息自定义字段读写（TavernDB_ACU_*）
│   │   └── config-storage.js      #     统一配置存储门面（自动降级策略）
│   ├── repositories/              #   数据仓库（统一 CRUD）
│   │   ├── settings-repo.js       #     设置读写
│   │   ├── table-repo.js          #     表格数据读写
│   │   ├── template-repo.js       #     模板预设读写
│   │   ├── import-repo.js         #     导入暂存数据读写
│   │   └── isolation-repo.js      #     数据隔离层读写
│   └── index.js                   #   数据库层统一出口
│
├── service/                       # 服务层
│   ├── table/                     #   表格更新服务
│   │   ├── update-orchestrator.js #     更新编排（批次、重试、并行组）
│   │   ├── merge-engine.js        #     数据合并引擎
│   │   └── sheet-helpers.js       #     表格操作工具函数
│   ├── ai/                        #   AI 调用服务
│   │   ├── prompt-builder.js      #     提示词组装
│   │   ├── api-client.js          #     API 调用（自定义/酒馆/直连）
│   │   └── response-parser.js     #     响应解析（流式/非流式）
│   ├── worldbook/                 #   世界书注入服务
│   │   ├── injection-engine.js    #     注入/清理/更新条目
│   │   ├── pipeline.js            #     世界书内容管线
│   │   └── entry-builder.js       #     条目构建器
│   ├── import/                    #   外部导入服务
│   │   ├── import-orchestrator.js #     导入流程编排
│   │   ├── txt-splitter.js        #     TXT 分块器
│   │   └── snapshot-manager.js    #     快照管理
│   ├── summary/                   #   纪要合并服务
│   │   └── merge-summary.js       #     合并逻辑
│   ├── data-admin/                #   数据管理服务
│   │   ├── config-export.js       #     配置导入导出
│   │   └── chat-data-admin.js     #     聊天数据管理
│   ├── runtime/                   #   运行时服务
│   │   ├── state-manager.js       #     全局状态管理器
│   │   └── event-bus.js           #     事件总线
│   └── index.js                   #   服务层统一出口
│
├── presentation/                  # 表示层
│   ├── window/                    #   窗口系统
│   │   ├── window-manager.js      #     窗口管理器
│   │   └── window-styles.js       #     窗口样式
│   ├── theme/                     #   主题与通知
│   │   ├── theme-engine.js        #     主题切换引擎
│   │   └── toast.js               #     Toast 通知
│   ├── components/                #   UI 组件
│   │   ├── editors.js             #     编辑器组件
│   │   ├── selectors.js           #     选择器组件
│   │   └── table-selector.js      #     表格选择器
│   ├── pages/                     #   页面/分页
│   │   ├── main-popup/            #     主弹窗（拆分后）
│   │   │   ├── shell.js           #       弹窗外壳 + 导航
│   │   │   ├── update-tab.js      #       更新页
│   │   │   ├── settings-tab.js    #       设置页
│   │   │   ├── import-tab.js      #       导入页
│   │   │   ├── plot-tab.js        #       剧情推进页
│   │   │   ├── optimization-tab.js#       正文替换页
│   │   │   └── bindings.js        #       事件绑定
│   │   └── visualizer/            #     可视化编辑器
│   │       ├── visualizer-shell.js#       编辑器外壳
│   │       ├── sidebar.js         #       侧栏
│   │       └── main-area.js       #       主编辑区
│   └── index.js                   #   表示层统一出口
│
├── shared/                        # 共享层（跨层公用）
│   ├── constants.js               #   全局常量、存储键名
│   ├── env.js                     #   环境检测、UserScript 头
│   ├── utils.js                   #   纯工具函数（无业务依赖）
│   ├── json-helpers.js            #   JSON 解析/清洗工具
│   └── html-helpers.js            #   HTML 转义等
│
├── app.js                         # 应用入口（初始化编排）
└── bootstrap.js                   # IIFE 闭合
```

---

## 三、各层职责边界详细说明

### 3.1 数据库层 (data/)

**核心原则**：数据库层是整个系统的「数据看门人」，只关心「数据在哪、怎么读、怎么写」，不关心「为什么读、读了干什么」。

**从现有代码迁入的内容**：

| 现有位置 | 迁入目标 | 涉及函数/逻辑 |
|---------|---------|--------------|
| `core/01_header_and_env.js` | `shared/env.js` + `shared/constants.js` | IIFE 开头、UNIQUE_SCRIPT_ID、存储策略常量 |
| `core/02_storage_and_profile.js` 存储部分 | `data/storage/` | openConfigDb_ACU、loadConfigIdbCache_ACU、getTavernSettingsNamespace_ACU、persistTavernSettings_ACU、injectTavernBridgeIntoTopWindow_ACU 等 |
| `core/02_storage_and_profile.js` Profile部分 | `data/repositories/settings-repo.js` | loadSettings_ACU、saveSettings_ACU、Profile 切换逻辑 |
| `core/02_storage_and_profile.js` 默认配置 | `data/models/settings.js` | DEFAULT_SETTINGS_ACU、DEFAULT_PLOT_SETTINGS_ACU 等所有默认值定义 |
| `core/05_core_tail.js` 数据持久化 | `data/repositories/table-repo.js` | saveIndependentTableToChatHistory_ACU、loadOrCreateJsonTableFromChatHistory_ACU |
| `core/05_core_tail.js` 隔离逻辑 | `data/repositories/isolation-repo.js` | getCurrentIsolationKey_ACU、隔离标签读写 |
| `features/import/01_import_cleanup.js` | `data/repositories/import-repo.js` | importTempGet_ACU、importTempRemove_ACU |

### 3.2 服务层 (service/)

**核心原则**：服务层是业务逻辑的「指挥中心」，编排数据流向，不直接碰 DOM，不直接碰底层存储。

**从现有代码迁入的内容**：

| 现有位置 | 迁入目标 | 涉及函数/逻辑 |
|---------|---------|--------------|
| `core/03_runtime_api.js` API 挂载 | `service/runtime/state-manager.js` | AutoCardUpdaterAPI 对象组装 |
| `core/03_runtime_api.js` 流式处理 | `service/ai/response-parser.js` | streamToText_ACU、handleApiResponse_ACU |
| `core/04_shared_helpers.js` 业务工具 | `service/table/sheet-helpers.js` | parseTableTemplateJson_ACU、sanitizeChatSheetsObject_ACU、getSortedSheetKeys_ACU 等 |
| `core/04_shared_helpers.js` 纯工具 | `shared/utils.js` | deepMerge_ACU、escapeHtml_ACU、safeJsonParse_ACU |
| `core/05_core_tail.js` 世界书注入 | `service/worldbook/injection-engine.js` | updateReadableLorebookEntry_ACU、deleteAllGeneratedEntries_ACU、updateCustomTableExports_ACU |
| `core/05_core_tail.js` 更新编排 | `service/table/update-orchestrator.js` | handleManualUpdate_ACU（业务编排部分） |
| `features/ai/` | `service/ai/` | prepareAIInput_ACU、callCustomOpenAI_ACU |
| `features/table/` | `service/table/update-orchestrator.js` | processUpdates_ACU |
| `features/summary/` | `service/summary/merge-summary.js` | performAutoMergeSummary_ACU |
| `features/import/02+03` | `service/import/` | processImportedTxtAsUpdates_ACU |
| `features/worldbook/04_pipeline_core.js` | `service/worldbook/pipeline.js` | getWorldbookNames_ACU、getLorebookEntriesByNames_ACU |
| `features/data/01_data_admin.js` | `service/data-admin/` | exportCombinedSettings_ACU、importCombinedSettings_ACU |

### 3.3 表示层 (presentation/)

**核心原则**：表示层只做两件事——「把数据画成界面」和「把用户操作翻译成服务调用」。

**从现有代码迁入的内容**：

| 现有位置 | 迁入目标 | 涉及函数/逻辑 |
|---------|---------|--------------|
| `ui/01_window_system.js` | `presentation/window/` | ACU_WindowManager、窗口样式注入 |
| `ui/02_shared_editors_and_selectors.js` | `presentation/components/` | renderPromptSegments_ACU、getCharCardPromptFromUI_ACU |
| `ui/03_theme_and_toast.js` | `presentation/theme/` | showToastr_ACU、ensureAcuToastStylesInjected_ACU |
| `ui/04_table_selectors.js` | `presentation/components/table-selector.js` | renderManualTableSelector_ACU |
| `ui/05_main_popup.js` | `presentation/pages/main-popup/` | openAutoCardPopup_ACU（按分页拆分） |
| `ui/06_visualizer.js` | `presentation/pages/visualizer/` | 可视化编辑器全部 |
| `features/ui/01_update_trigger.js` | `presentation/pages/main-popup/bindings.js` + `service/table/` | proceedWithCardUpdate_ACU 中 UI 部分→表示层，业务编排部分→服务层 |
| `features/worldbook/01-03` | `presentation/components/` (UI 选择部分) + `service/worldbook/` (数据部分) | 世界书列表渲染→表示层，数据获取→服务层 |
| `features/runtime/01_runtime_state.js` | `presentation/pages/main-popup/update-tab.js` (UI统计展示) + `service/runtime/` (状态计算) | updateCardUpdateStatusDisplay_ACU |
| `features/startup/` | `app.js` | mainInitialize_ACU、addAutoCardMenuItem_ACU |

---

## 四、迁移策略

### 4.1 核心约束

1. **渐进式迁移**：不能一步到位，每一步都要保证 `build-index.js` 拼接产物与基线一致
2. **行为等价优先**：先搬位置、再改接口，不在搬迁过程中顺手重构逻辑
3. **IIFE 约束**：当前所有代码在同一个闭包内，变量互相可见。在引入真正的模块系统之前，拆分只是文件物理分离，逻辑上仍在同一作用域

### 4.2 分阶段路线图

```
Phase 0: 准备阶段（预计 1-2 天）
├── 创建目标目录结构骨架
├── 更新 build-index.js 支持新路径
├── 建立自动化验证脚本（每步拆分后自动比对）
└── 确认 .gitignore 已排除临时文件

Phase 1: 抽取共享层 shared/（预计 2-3 天）
├── 从 01_header_and_env.js 提取 env.js + constants.js
├── 从 04_shared_helpers.js 提取纯工具函数到 utils.js
├── 从 04_shared_helpers.js 提取 JSON 工具到 json-helpers.js
└── 验证拼接一致性

Phase 2: 建立数据库层 data/（预计 3-5 天）★ 最关键
├── Step 2.1: 从 02_storage_and_profile.js 提取存储后端到 data/storage/
├── Step 2.2: 提取数据模型定义到 data/models/
├── Step 2.3: 从 05_core_tail.js 提取数据持久化逻辑到 data/repositories/
├── Step 2.4: 创建统一 Repository 接口
└── 验证拼接一致性

Phase 3: 建立服务层 service/（预计 5-7 天）
├── Step 3.1: 从 core/03_runtime_api.js 提取 API 客户端逻辑
├── Step 3.2: 从 core/05_core_tail.js 提取世界书注入服务
├── Step 3.3: 迁移 features/ai/ → service/ai/
├── Step 3.4: 迁移 features/table/ → service/table/
├── Step 3.5: 迁移 features/summary/ → service/summary/
├── Step 3.6: 迁移 features/import/ → service/import/
├── Step 3.7: 迁移 features/data/ → service/data-admin/
├── Step 3.8: 建立事件总线 event-bus.js
└── 验证拼接一致性

Phase 4: 重组表示层 presentation/（预计 5-7 天）
├── Step 4.1: 迁移 ui/01_window_system.js → presentation/window/
├── Step 4.2: 迁移 ui/02-04 → presentation/components/ + theme/
├── Step 4.3: 拆分 ui/05_main_popup.js → presentation/pages/main-popup/
│   （这是工作量最大的单步，参照现有 docs/目录结构说明.md 的推荐方案）
├── Step 4.4: 拆分 ui/06_visualizer.js → presentation/pages/visualizer/
├── Step 4.5: 分离 features/worldbook/ 和 features/runtime/ 的 UI 部分
└── 验证拼接一致性

Phase 5: 清理与收束（预计 2-3 天）
├── 清理残留的 core/ 碎片
├── 统一入口 app.js 替代 startup/
├── 更新 build-index.js 为最终拼接顺序
├── 更新 docs/目录结构说明.md
└── 最终验证：dist/index.bundle.js === index.js
```

### 4.3 各阶段依赖关系

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5
(准备)      (共享层)    (数据库层)   (服务层)    (表示层)     (收束)
                            ↑
                            │
                     最关键的一步
                  决定了后续层的接口形态
```

---

## 五、关键设计决策

### 5.1 模块通信方式

**当前阶段（IIFE 内）**：各层通过闭包内的全局变量和函数调用通信。这是现实约束——在 Tampermonkey 用户脚本环境下，不能用 ES Module import/export。

**过渡方案**：引入一个轻量级的 **服务定位器（Service Locator）** 模式：

```javascript
// shared/service-locator.js
const ACU_Services = {
    _registry: {},
    register(name, instance) { this._registry[name] = instance; },
    get(name) { return this._registry[name]; }
};
```

各层在初始化时注册自己的服务，其他层通过 `ACU_Services.get('tablRepo')` 获取，而非直接调用闭包中的全局函数。这为未来可能的模块化构建打下基础。

### 5.2 全局状态管理

将现有 30+ 个散落的 `let` 全局变量收归到 `service/runtime/state-manager.js` 中统一管理：

```javascript
const ACU_State = {
    currentJsonTableData: null,
    settings: null,
    allChatMessages: [],
    currentChatFileIdentifier: '',
    isAutoUpdating: false,
    coreApisReady: false,
    // ... 其他状态
    
    // 提供 getter/setter，便于未来添加变更通知
    get(key) { return this[key]; },
    set(key, value) { this[key] = value; }
};
```

### 5.3 事件驱动解耦

引入事件总线，替代表示层与服务层之间的直接调用：

```javascript
// 表示层发出事件
ACU_EventBus.emit('user:manual-update-requested', { targetKeys, batchSize });

// 服务层监听并处理
ACU_EventBus.on('user:manual-update-requested', async (payload) => {
    await updateOrchestrator.executeManualUpdate(payload);
});

// 服务层完成后通知表示层
ACU_EventBus.emit('table:update-completed', { success, modifiedKeys });
```

### 5.4 05_main_popup.js 拆分策略

这是整个重构中工作量最大的单个文件（348 KB / 5734 行）。采用两步走：

**第一步（Phase 4.3a）**：按 `docs/目录结构说明.md` 已有的推荐方案，先做安全的物理拆分（按连续代码块切割），不改逻辑：

```
presentation/pages/main-popup/
├── 01_shell_and_update_tab.js     # 弹窗外壳 + 更新页
├── 02_settings_tabs.js            # 设置相关分页
├── 03_import_tab.js               # 外部导入页
├── 04_plot_and_optimization_tabs.js # 剧情推进 + 正文替换
├── 05_common_bindings.js          # 通用事件绑定
├── 06_plot_bindings_and_helpers.js # 剧情推进绑定
└── 07_optimization_bindings_and_tail.js # 正文替换绑定
```

**第二步（Phase 4.3b）**：在物理拆分稳定后，进一步分离 HTML 模板、CSS 样式、事件绑定。

---

## 六、风险评估

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| 拼接顺序变更导致运行时 ReferenceError | 🔴 致命 | 每步拆分后立即运行 build-index.js 验证；维护函数依赖图 |
| 闭包变量作用域被意外打破 | 🔴 致命 | 拆分时不改变缩进层级；保持所有代码在 IIFE 内 |
| 隐式依赖链断裂（函数 A 依赖先于 B 声明的变量） | 🟡 中 | Phase 0 中建立函数依赖分析脚本；按依赖图确定新拼接顺序 |
| 05_main_popup.js 拆分时模板字符串被截断 | 🟡 中 | 切割点只选在完整语句边界；切割后立即验证拼接一致性 |
| 重构周期过长导致与 main 分支冲突 | 🟠 低 | 在 plus 分支上工作；每完成一个 Phase 即可合并阶段性成果 |

---

## 七、验收标准

每个 Phase 完成后，必须满足以下条件：

1. **拼接一致性**：`node scripts/build-index.js` 输出 `✓ 拼接结果与原始 index.js 完全一致`
2. **功能等价**：在 SillyTavern 中安装 `dist/index.bundle.js`，以下功能正常运作：
   - 打开主弹窗，8 个分页全部可访问
   - 手动更新表格成功
   - 自动更新触发正常
   - 可视化编辑器打开和编辑
   - 外部导入 TXT 文件
   - 合并纪要功能
   - 配置导入导出
   - 数据隔离切换
3. **目录结构**：新文件位于正确的层级目录下

---

## 八、已确认的设计决策

### ✅ 决策 1：引入 rollup/esbuild 构建工具

**结论**：在 Phase 0 中引入 rollup（或 esbuild）替代手动维护的 `build-index.js` 文本拼接。

**理由**：
- 拆分后文件数从 28 个增长到 50-60 个，手动维护 `buildOrder` 数组不可持续
- rollup `output.format: 'iife'` 输出的产物与当前 `index.js` 结构完全一致——一个 `(function(){ ... })();` 包裹一切
- 酒馆助手只认最终的单文件 JS 脚本，不关心它是怎么生成的
- 源码可以使用 `import/export` 语法，工具自动按依赖图排序，消除隐式顺序依赖

**迁移策略**：
- Phase 0 中搭建 rollup 配置，先用它复现现有 `build-index.js` 的拼接行为
- Phase 1 起，新拆出的文件直接用 `import/export`
- 旧文件逐步迁移，每步验证产物等价

### ✅ 决策 2：同步引入 TypeScript

**结论**：在 Phase 0 中随构建工具一起配置 TypeScript，新拆出的文件用 `.ts` 编写。

**理由**：
- TS 只存在于编译期，rollup/esbuild 会将 `.ts` 编译为普通 JS 再打包成 IIFE 单文件，产物中零 TS 语法残留
- 酒馆助手拿到的仍然是纯 JavaScript 脚本，运行环境完全不受影响
- 现有 `@types/` 目录已有 31 个类型定义文件，可以直接复用
- 重构过程中 TS 的类型检查相当于一张安全网，能在编译期捕获接口不匹配、参数遗漏等问题

**迁移策略**：
- Phase 0 中配置 `tsconfig.json`，启用 `allowJs: true` 让 `.js` 和 `.ts` 共存
- 新拆出的文件直接用 `.ts`，旧文件保持 `.js` 不强制迁移
- 逐步为关键接口（Repository、Service）添加类型定义，优先覆盖数据库层

### ✅ 决策 3：Phase 严格串行执行

**结论**：Phase 0→1→2→3→4→5 严格按顺序执行，不并行。

**理由**：全程由 AI 独立完成，不存在多人协作场景。串行可以确保每一层的接口在下一层开工前已经稳定，避免跨层接口不匹配。

### ✅ 决策 4：04_shared_helpers.js 函数分类在 Phase 1 中完成

**结论**：Phase 1 中逐一审视 235+ 个函数，按「纯工具」「数据操作」「业务逻辑」三类建立分类表，然后按分类结果分流到 shared/、data/、service/ 三层。

---

## 九、待讨论事项

（已全部确认，无遗留讨论项）

---

## 附录 A：当前数据流图

```
用户操作 / AI回复事件
       │
       ▼
features/startup/  ──→  事件监听 & 菜单入口
       │
       ▼
features/worldbook/04  ──→  loadAllChatMessages_ACU()
       │
       ▼
core/05_core_tail  ──→  loadOrCreateJsonTableFromChatHistory_ACU()
       │                 从聊天消息的 TavernDB_ACU_* 字段提取/合并表格
       ▼
features/ai/       ──→  prepareAIInput_ACU() + callCustomOpenAI_ACU()
       │                 组装提示词 → 调用AI → 获取更新指令
       ▼
features/table/    ──→  processUpdates_ACU()
       │                 解析AI返回 → 合并到 currentJsonTableData_ACU
       ▼
core/05_core_tail  ──→  saveIndependentTableToChatHistory_ACU()
       │                 写回聊天消息的 TavernDB_ACU_IsolatedData
       ▼
core/05_core_tail  ──→  updateReadableLorebookEntry_ACU()
       │                 转换为世界书条目注入到酒馆
       ▼
ui/ 层             ──→  刷新弹窗 / 可视化编辑器
```

## 附录 B：文件体积排行（优先拆分目标）

| 排名 | 文件 | 体积 | 行数 | 拆分优先级 |
|-----|------|------|------|-----------|
| 1 | core/04_shared_helpers.js | 375 KB | 8459 | Phase 1+2+3 分流 |
| 2 | ui/05_main_popup.js | 348 KB | 5734 | Phase 4 |
| 3 | core/02_storage_and_profile.js | 251 KB | 5146 | Phase 2 |
| 4 | core/05_core_tail.js | 162 KB | 3143 | Phase 2+3 |
| 5 | ui/06_visualizer.js | 120 KB | 2755 | Phase 4 |
| 6 | core/03_runtime_api.js | 106 KB | 2461 | Phase 2+3 |
| 7 | features/ai/02_api_call.js | 73 KB | 1532 | Phase 3 |
| 8 | features/ui/01_update_trigger.js | 40 KB | 721 | Phase 3+4 |
| 9 | features/data/01_data_admin.js | 36 KB | 740 | Phase 3 |
