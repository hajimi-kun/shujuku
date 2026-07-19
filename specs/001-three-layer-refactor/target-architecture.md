# 三层架构重构 — 终态架构文档 v2

> 本文档描述项目的**目标终态**和**从现状到终态的全部差距**。
> 终态 = 所有业务代码归入 shared/ data/ service/ presentation/ 四层，`core/` 和 `features/` **完全清空**。
> 基准：`plans/three_layer_refactor_plan.md` 初版设计。本文档必须与初版设计完全对齐。

---

## 一、当前现状（差距审计）

### 已迁移（35 个 .ts 文件，~16,032 行）

| 层 | 模块数 | 总行数 |
|----|--------|--------|
| shared/ | 6 | ~1,800 |
| data/ | 8 | ~3,200 |
| service/ | 8 | ~6,500 |
| presentation/ | 10 | ~4,500 |

### 未迁移残留

#### `src/core/`（5 文件，~15,948 行，442 个 _ACU 定义）

| 文件 | 行数 | 函数数 | 变量数 | 说明 |
|------|------|--------|--------|------|
| `01_header_and_env.js` | 56 | 0 | 5 | IIFE 入口 + 存储策略初始化 |
| `02_storage_and_profile.js` | 4,089 | 121 | 33 | 模板预设 UI、用户发送意图、正文优化、巨型 JSON 默认值 |
| `03_runtime_api.js` | 2,402 | 3 | 6 | DatabaseAPI_ACU（80+ 方法的对外 API 对象）、流式响应处理 |
| `04_shared_helpers.js` | 7,347 | 206 | 19 | 聊天作用域配置、模板归档、Sheet Guide、条件模板引擎、剧情规划 |
| `05_core_tail.js` | 2,058 | 38 | 11 | 世界书导出构建、数据初始化、隔离键管理 |

#### `src/features/`（16 文件，~3,580 行实质代码）

| 文件 | 行数 | 函数数 | 变量数 | 说明 |
|------|------|--------|--------|------|
| `ai/01_prompt_prepare.js` | 4 | 1 | 0 | prepareAIInput_ACU（函数开头，续写在 02_api_call.js） |
| `ai/02_api_call.js` | 1,532 | 4 | 19 | callCustomOpenAI_ACU + JSON清洗管线 + 表格编辑解析 |
| `ai/direct_bridge.js` | 1 | 0 | 0 | ✅ 已清空 |
| `data/01_data_admin.js` | 707 | 8 | 0 | 导入/导出/重置/删除本地数据 |
| `import/01_import_cleanup.js` | 29 | 3 | 2 | 导入批次 ID + 前缀 |
| `import/02_import_lorebook_snapshot.js` | 70 | 2 | 0 | 导入状态 UI + 存储注释 |
| `import/03_import_processing.js` | 9 | 3 | 0 | 兼容旧 API 包装函数 |
| `runtime/01_runtime_state.js` | 241 | 1 | 1 | 更新状态显示 UI |
| `startup/01_ready_and_menu.js` | 53 | 1 | 0 | 菜单注册 + DOMReady 触发 |
| `summary/01_summary_logic.js` | 4 | 0 | 0 | ✅ 已清空 |
| `table/01_update_process.js` | 3 | 0 | 0 | ✅ 已清空 |
| `ui/01_update_trigger.js` | 754 | 4 | 1 | 手动更新触发 + 导出合并配置 |
| `worldbook/01_plot_worldbook.js` | 185 | 5 | 0 | 剧情世界书 UI |
| `worldbook/02_selection_support.js` | 351 | 18 | 1 | 世界书选择/过滤 UI |
| `worldbook/03_worldbook_list.js` | 136 | 2 | 0 | 世界书列表 UI |
| `worldbook/04_pipeline_core.js` | 25 | 0 | 0 | ✅ 已清空 |

---

## 二、目标终态目录结构

> 与初版设计 `plans/three_layer_refactor_plan.md` §2.2 完全对齐。
> 标注 ✅ = 已完成，🔲 = 待实现。

```
src/
├── shared/                              # 共享层（跨层公用，无副作用、无DOM、无全局状态依赖）
│   ├── constants.ts              ✅     # 脚本 ID、调试开关
│   ├── env.ts                    🔲     # 环境检测 (topLevelWindow, 存储策略常量) — 从 01_header_and_env.js 迁入
│   ├── utils.ts                  ✅     # deepMerge, cleanChatName, 表格工具函数等
│   ├── json-helpers.ts           ✅     # safeJsonParse/Stringify
│   ├── html-helpers.ts           ✅     # escapeHtml
│   ├── text-optimization.ts      ✅     # 正文优化纯算法
│   ├── service-locator.ts        🔲     # ACU_Services 服务定位器（初版 §5.1）
│   └── index.ts                  ✅
│
├── data/                                # 数据库层（数据持久化、存储后端抽象、数据模型）
│   ├── constants.ts              ✅     # 存储键 + Profile 工具
│   ├── models/                          # 数据模型定义
│   │   ├── defaults.ts           ✅(部分) # 默认配置常量（简单部分已迁）
│   │   ├── defaults-json.js      🔲     # 巨型 JSON 默认值（.js 绕过 TS 中文引号问题）
│   │   ├── table-data.ts         🔲     # 表格数据结构定义（sheet、mate 等）
│   │   ├── settings-model.ts     🔲     # 设置数据结构 + DEFAULT_SETTINGS_ACU 等
│   │   └── template-model.ts     🔲     # 模板数据结构定义
│   ├── storage/                         # 存储后端抽象
│   │   ├── tavern-storage.ts     ✅     # 酒馆设置后端
│   │   ├── idb-import-temp.ts    ✅     # IndexedDB 导入临时存储
│   │   ├── chat-history.ts       🔲     # 聊天消息自定义字段读写（TavernDB_ACU_* 字段 CRUD）
│   │   └── config-storage.ts     🔲     # 统一配置存储门面（自动降级策略）
│   ├── repositories/                    # 数据仓库（统一 CRUD）
│   │   ├── profile-repo.ts       ✅
│   │   ├── isolation-repo.ts     ✅
│   │   ├── template-preset-repo.ts ✅
│   │   ├── character-settings-repo.ts ✅
│   │   ├── table-repo.ts         🔲     # 表格数据 CRUD（save/load/create JsonTable）
│   │   ├── settings-repo.ts      🔲     # 设置读写 Repository
│   │   └── import-repo.ts        🔲     # 导入暂存数据 Repository
│   └── index.ts                  ✅
│
├── service/                             # 服务层（业务逻辑编排，无 DOM 操作）
│   ├── settings/
│   │   └── settings-service.ts   ✅
│   ├── ai/                              # AI 调用服务
│   │   ├── api-call.ts           ✅     # API 调用（自定义/酒馆/直连）
│   │   ├── prompt-builder.ts     🔲     # 提示词组装（从 features/ai/ 迁入）
│   │   └── response-parser.ts    🔲     # 响应解析（流式/非流式）+ JSON清洗 + 表格编辑解析
│   ├── table/                           # 表格更新服务
│   │   ├── update-process.ts     ✅     # 更新编排（批次、重试）
│   │   ├── merge-engine.ts       🔲     # 数据合并引擎
│   │   └── sheet-helpers.ts      🔲     # 表格操作工具函数（sanitize、getSortedSheetKeys 等）
│   ├── worldbook/                       # 世界书服务
│   │   ├── pipeline.ts           ✅     # 世界书内容管线
│   │   ├── injection-engine.ts   🔲     # 注入/清理/更新条目（运行时写入世界书）
│   │   └── entry-builder.ts      🔲     # 条目构建器（导出配置、格式化 markdown 表格等）
│   ├── template/                        # 聊天模板作用域管理
│   │   ├── chat-scope.ts         🔲     # 聊天级模板/剧情作用域 CRUD
│   │   ├── sheet-guide.ts        🔲     # Sheet Guide 管理
│   │   └── template-archive.ts   🔲     # 模板归档
│   ├── optimization/                    # 正文优化服务
│   │   └── content-optimization.ts 🔲   # 正文优化业务逻辑（不含 UI）
│   ├── import/                          # 外部导入服务
│   │   ├── import-process.ts     ✅     # 导入处理主流程
│   │   ├── import-orchestrator.ts 🔲    # 导入流程编排
│   │   ├── txt-splitter.ts       🔲     # TXT 分块器
│   │   └── snapshot-manager.ts   🔲     # 快照管理
│   ├── summary/
│   │   └── merge-logic.ts        ✅     # 合并逻辑
│   ├── data-admin/                      # 数据管理服务
│   │   ├── admin.ts              ✅     # 现有导入导出逻辑
│   │   ├── config-export.ts      🔲     # 配置导入导出（从 admin 拆分）
│   │   └── chat-data-admin.ts    🔲     # 聊天数据管理（删除/重置）
│   ├── runtime/                         # 运行时服务
│   │   ├── init.ts               ✅     # 初始化
│   │   ├── state-manager.ts      🔲     # ACU_State 全局状态管理器（getter/setter + 变更通知）
│   │   └── event-bus.ts          🔲     # ACU_EventBus 事件总线
│   └── index.ts                  ✅
│
├── presentation/                        # 表示层（纯 UI 渲染 + 用户交互）
│   ├── window/
│   │   ├── window-system.ts      ✅     # 窗口管理器
│   │   └── window-styles.ts      🔲     # 窗口样式（从 window-system 拆出）
│   ├── theme/
│   │   ├── toast.ts              ✅
│   │   └── theme-engine.ts       🔲     # 主题切换引擎（从 toast 拆出）
│   ├── components/
│   │   ├── table-selector.ts     ✅
│   │   ├── plot-editors.ts       ✅
│   │   ├── template-preset-ui.ts 🔲     # 模板预设下拉框 UI
│   │   ├── worldbook-selector.ts 🔲     # 世界书选择/过滤 UI
│   │   ├── import-status-ui.ts   🔲     # 导入状态 UI
│   │   ├── update-status-display.ts 🔲  # 更新状态显示
│   │   └── optimization-ui.ts    🔲     # 正文优化 UI（overlay, toast, replace）
│   ├── pages/
│   │   ├── main-popup/                  # 主弹窗（拆分为子文件）
│   │   │   ├── shell.ts          🔲     # 弹窗外壳 + 导航
│   │   │   ├── update-tab.ts     🔲     # 更新页
│   │   │   ├── settings-tab.ts   🔲     # 设置页
│   │   │   ├── import-tab.ts     🔲     # 导入页
│   │   │   ├── plot-tab.ts       🔲     # 剧情推进页
│   │   │   ├── optimization-tab.ts 🔲   # 正文替换页
│   │   │   └── bindings.ts       🔲     # 事件绑定
│   │   └── visualizer/                  # 可视化编辑器（拆分为子文件）
│   │       ├── visualizer-shell.ts 🔲   # 编辑器外壳
│   │       ├── sidebar.ts        🔲     # 侧栏
│   │       └── main-area.ts      🔲     # 主编辑区
│   ├── triggers/
│   │   ├── update-trigger.ts     🔲     # 手动更新/合并纪要触发
│   │   └── data-admin-ui.ts      🔲     # 导入/导出/重置 UI 操作
│   ├── bootstrap/
│   │   └── startup.ts            🔲     # 菜单注册 + DOMReady
│   └── index.ts                  ✅
│
├── app.ts                        🔲     # 应用入口（初始化编排，替代 startup + IIFE 头）
└── 03_bootstrap.js               ✅     # IIFE 闭合（最终由 rollup banner/footer 替代）
```

**终态目标：`src/core/` 和 `src/features/` 目录完全删除，不保留任何胶水文件。**

- `01_header_and_env.js` → IIFE 入口移到 rollup `output.banner` 或 `app.ts`
- `03_runtime_api.js` → DatabaseAPI_ACU 注册移到 `service/runtime/state-manager.ts` 或独立的 `service/api-registry.ts`
- 所有拼接顺序依赖由 rollup import 图自动解决

---

## 三、迁移任务清单

### 阶段 8A：共享层补全

| # | 源 | 目标 | 行数 | 说明 |
|---|-----|------|------|------|
| M01 | `01_header_and_env.js:17~47` | `shared/env.ts` | ~30 | topLevelWindow_ACU, storage_ACU, 存储策略常量 |
| M02 | 新建 | `shared/service-locator.ts` | ~30 | ACU_Services 注册表（初版 §5.1） |

### 阶段 8B：数据层补全（模型 + 存储 + 仓库）

| # | 源 | 目标 | 行数 | 说明 |
|---|-----|------|------|------|
| M03 | `02_storage.js:796~1080` | `data/models/defaults-json.js` | ~280 | 巨型 JSON 默认值（.js 绕过中文引号） |
| M04 | 新建 | `data/models/table-data.ts` | ~60 | 表格数据结构定义（sheet/mate 接口） |
| M05 | 新建 | `data/models/settings-model.ts` | ~80 | 设置数据结构 + 默认值接口 |
| M06 | 新建 | `data/models/template-model.ts` | ~40 | 模板数据结构定义 |
| M07 | `04_shared_helpers.js:43~50` + 相关 | `data/storage/chat-history.ts` | ~150 | 聊天消息自定义字段 CRUD（getChatScopedConfigContainer, normalize 等） |
| M08 | 从 tavern-storage.ts 拆出 | `data/storage/config-storage.ts` | ~80 | 统一配置存储门面（降级策略） |
| M09 | `05_core_tail.js:1767~2058` | `data/repositories/table-repo.ts` | ~290 | saveIndependentTableToChatHistory, loadOrCreateJsonTable, initializeJsonTable, checkIfFirstTimeInit |
| M10 | 从 settings-service.ts 拆出 | `data/repositories/settings-repo.ts` | ~100 | loadSettings/saveSettings 的纯数据读写部分 |
| M11 | 新建 | `data/repositories/import-repo.ts` | ~60 | 导入暂存数据高层 Repository |

### 阶段 8C：服务层补全

| # | 源 | 目标 | 行数 | 说明 |
|---|-----|------|------|------|
| M12 | `02_storage.js:624~680` | `service/runtime/state-manager.ts` | ~80 | ACU_State — 全局状态 getter/setter + 变更通知（loopState, planningGuard, abortController 等 11 个变量） |
| M13 | `02_storage.js:673~790` | `service/runtime/state-manager.ts` (续) | ~120 | 用户发送意图 + 生成门控（markUserSendIntent, installSendIntentCaptureHooks 等 10 函数）— DOM hook 部分委托给 presentation 层 |
| M14 | 新建 | `service/runtime/event-bus.ts` | ~60 | ACU_EventBus 事件总线（初版 §5.3） |
| M15 | `04_shared_helpers.js:29~160` | `service/template/chat-scope.ts` | ~130 | 剧情作用域 CRUD（Plot scope: normalize/get/set/clear/build） |
| M16 | `04_shared_helpers.js:160~346` | `service/template/chat-scope.ts` (续) | ~186 | 模板作用域 CRUD（Template scope: normalize/get/set/clear/build + preset entries） |
| M17 | `04_shared_helpers.js:347~510` | `service/template/template-archive.ts` | ~163 | 模板归档（archive/restore/fingerprint/label，10 函数） |
| M18 | `04_shared_helpers.js:510~640` | `service/template/chat-scope.ts` (续) | ~130 | 聊天模板状态持久化 + 全局快照 |
| M19 | `04_shared_helpers.js:641~1030` | `service/template/sheet-guide.ts` | ~390 | Sheet Guide 管理（container/normalize/materialize/legacy/historical，8 函数） |
| M20 | `04_shared_helpers.js:1031~1370` | `service/table/sheet-helpers.ts` | ~340 | sanitizeChatSheetsObject, getSortedSheetKeys, 数据清洗工具 |
| M21 | `04_shared_helpers.js:1370~2050` | `service/template/chat-scope.ts` (续) | ~680 | 模板应用/迁移/greeting base state 逻辑 |
| M22 | `04_shared_helpers.js:2050~2600` | `service/table/merge-engine.ts` | ~550 | 条件模板引擎、条件变量（randomVariables, calcVariables, maxVariables, minVariables） |
| M23 | `04_shared_helpers.js:2600~4230` | `service/ai/prompt-builder.ts` (部分) | ~1630 | 剧情规划 prompt 组装、剧情推进逻辑 |
| M24 | `04_shared_helpers.js:4230~5850` | `service/ai/prompt-builder.ts` (续) | ~1620 | processPromptTemplateContent, 剧情预测/规划执行 |
| M25 | `04_shared_helpers.js:5850~7347` | `service/optimization/content-optimization.ts` (部分) + `service/table/sheet-helpers.ts` (部分) | ~1497 | 剩余业务函数按功能域分流 |
| M26 | `02_storage.js:1085~1700` | `service/optimization/content-optimization.ts` | ~615 | 正文优化业务逻辑（build prompt, getPlaceholders, perform, parse response，15+ 函数，不含 UI） |
| M27 | `05_core_tail.js:86~390` | `service/worldbook/entry-builder.ts` | ~305 | 世界书导出配置构建（defaultExportConfig, placementConfig, 27 函数） |
| M28 | `05_core_tail.js:392~572` | `service/worldbook/injection-engine.ts` | ~180 | purgeSheetKeysFromChatHistoryHard（运行时写入/清理世界书） |
| M29 | `05_core_tail.js:573~1580` | `service/worldbook/injection-engine.ts` (续) | ~1007 | updateOutlineTableEntry, updateSummaryTableEntries, updateCustomTableExports, updateImportantPersonsRelatedEntries |
| M30 | `05_core_tail.js:1580~1766` | `service/worldbook/injection-engine.ts` (续) | ~186 | getCurrentIsolationKey, 人名关键词构建 |
| M31 | `features/ai/01+02_api_call.js` | `service/ai/prompt-builder.ts` + `service/ai/response-parser.ts` | ~1536 | prepareAIInput + callCustomOpenAI（跨文件合并）+ JSON清洗管线 + parseAndApplyTableEdits |
| M32 | `03_runtime_api.js:2025~2110` | `service/ai/response-parser.ts` | ~85 | streamToText + parseNonStreamResponse + handleApiResponse |
| M33 | 从 import-process.ts 拆出 | `service/import/import-orchestrator.ts` | ~100 | 导入流程编排 |
| M34 | 从 import-process.ts 拆出 | `service/import/txt-splitter.ts` | ~80 | TXT 分块器 |
| M35 | 从 import-process.ts 拆出 | `service/import/snapshot-manager.ts` | ~60 | 快照管理 |
| M36 | 从 admin.ts 拆出 | `service/data-admin/config-export.ts` | ~70 | 配置导入导出（纯数据逻辑） |
| M37 | 从 admin.ts 拆出 | `service/data-admin/chat-data-admin.ts` | ~70 | 聊天数据管理（删除/重置） |
| M38 | `03_runtime_api.js:4~2024` | `service/runtime/api-registry.ts` | ~2020 | DatabaseAPI_ACU 对象 → 各方法委托到 service/presentation 层函数 |

### 阶段 8D：表示层补全

| # | 源 | 目标 | 行数 | 说明 |
|---|-----|------|------|------|
| M39 | `02_storage.js:20~620` | `presentation/components/template-preset-ui.ts` | ~600 | 模板预设下拉框 UI（24 函数） |
| M40 | `02_storage.js:1700~4089` | `presentation/components/optimization-ui.ts` | ~2389 | 正文优化 UI（overlay, toast, replaceChatMessage） |
| M41 | `features/worldbook/01~03` | `presentation/components/worldbook-selector.ts` | ~672 | 世界书选择/过滤 UI（25 函数） |
| M42 | `features/runtime/01_runtime_state.js` | `presentation/components/update-status-display.ts` | ~241 | 更新状态显示 |
| M43 | `features/import/01~03` | `presentation/components/import-status-ui.ts` | ~108 | 导入 UI 相关 |
| M44 | `features/startup/01_ready_and_menu.js` | `presentation/bootstrap/startup.ts` | ~53 | 菜单注册 + DOMReady |
| M45 | `features/ui/01_update_trigger.js` | `presentation/triggers/update-trigger.ts` | ~754 | 手动更新触发（UI 部分） |
| M46 | `features/data/01_data_admin.js` | `presentation/triggers/data-admin-ui.ts` | ~707 | 导入/导出/重置 UI 操作 |
| M47 | `presentation/pages/main-popup.ts` (348KB) | `presentation/pages/main-popup/` 7 个子文件 | ~5733 | 按初版设计拆分：shell + update-tab + settings-tab + import-tab + plot-tab + optimization-tab + bindings |
| M48 | `presentation/pages/visualizer.ts` (120KB) | `presentation/pages/visualizer/` 3 个子文件 | ~2755 | 按初版设计拆分：visualizer-shell + sidebar + main-area |
| M49 | 从 window-system.ts 拆出 | `presentation/window/window-styles.ts` | ~200 | 窗口样式 |
| M50 | 从 toast.ts 拆出 | `presentation/theme/theme-engine.ts` | ~100 | 主题切换引擎 |

### 阶段 8E：入口统一 + 旧目录清除

| # | 源 | 目标 | 说明 |
|---|-----|------|------|
| M51 | `01_header_and_env.js` IIFE 头 | rollup `output.banner` 或 `app.ts` | IIFE 开头移到构建层 |
| M52 | `03_runtime_api.js` | 已由 M38 迁出 | DatabaseAPI_ACU 已移到 service 层 |
| M53 | `04_shared_helpers.js` | **删除** | M15~M25 已迁出全部内容 |
| M54 | `05_core_tail.js` | **删除** | M09, M27~M30 已迁出全部内容 |
| M55 | `02_storage_and_profile.js` | **删除** | M03, M12~M13, M26, M39~M40 已迁出全部内容 |
| M56 | `src/core/` 目录 | **删除** | 全部文件已迁出 |
| M57 | `src/features/` 目录 | **删除** | 全部文件已迁出 |
| M58 | `src/ui/` 6 个空壳文件 | **删除** | 从 buildOrder 中移除 |
| M59 | 新建 `app.ts` | 应用入口 | 初始化编排，替代 features/startup + IIFE 头尾 |
| M60 | rollup.config.js | 更新 | 移除 buildOrder / concat 模式，改为纯 import 图驱动 |

---

## 四、技术难点与解决方案

### 1. 中文引号 TS 编译问题
- `DEFAULT_CHAR_CARD_PROMPT_ACU` 等巨型 JSON 字符串包含 `"` `"` 中文引号
- TS 编译器会将其转为 `\"`，破坏内容
- **方案**：使用 `.js` 后缀的模块文件（rollup 直接读取不经 TS 转译）

### 2. 跨文件 concat 函数续写
- `prepareAIInput_ACU` 的函数声明在 `01_prompt_prepare.js`，函数体在 `02_api_call.js`
- **方案**：合并到一个 `.ts` 模块（M31）

### 3. ACU_State 全局状态管理（初版 §5.2）
- 30+ 个散落的 `let` 全局变量
- **方案**：收归到 `service/runtime/state-manager.ts`，提供 getter/setter 接口，为未来变更通知打基础
- **注意**：放在 **service 层**（不是 data 层），因为状态管理是运行时业务逻辑，不是持久化数据

### 4. ACU_EventBus 事件驱动解耦（初版 §5.3）
- 表示层与服务层之间直接函数调用 → 通过事件解耦
- **方案**：`service/runtime/event-bus.ts`，表示层 emit，服务层 on

### 5. ACU_Services 服务定位器（初版 §5.1）
- 各层通过注册表通信，为未来模块化打基础
- **方案**：`shared/service-locator.ts`，各层初始化时注册

### 6. DatabaseAPI_ACU 对外 API
- 80+ 方法的对象字面量，引用闭包内全部函数
- **方案**：移到 `service/runtime/api-registry.ts`，各方法委托到对应 service/presentation 层函数

### 7. main-popup.ts 348KB 拆分（初版 §5.4）
- **方案**：按初版设计拆成 7 个子文件（shell + 6 分页 + bindings），先做物理拆分不改逻辑

### 8. DOM 操作函数与业务逻辑耦合
- 很多函数同时做 DOM 查询 + 数据处理
- **方案**：拆分为 service（纯逻辑）+ presentation（DOM 操作），presentation 调用 service
- **特别注意**：`installSendIntentCaptureHooks_ACU` 中的 DOM hook 部分留在 presentation 层，纯逻辑部分到 service 层

---

## 五、验收标准

1. **`src/core/` 目录完全删除**（不保留任何文件）
2. **`src/features/` 目录完全删除**
3. **`src/ui/` 目录完全删除**
4. 所有 `_ACU` 函数定义都在 shared/data/service/presentation/ 中
5. `app.ts` 作为唯一入口编排初始化
6. `BUILD_MODE=module npx rollup -c` 构建成功
7. `node scripts/audit-bundle.cjs` 零错误，793 标识符零丢失
8. SillyTavern 全量手动测试 16 项通过
9. 目录结构与初版设计 `plans/three_layer_refactor_plan.md` §2.2 一致

---

## 六、工作量估算

| 阶段 | 任务数 | 行数 | 预估复杂度 |
|------|--------|------|-----------|
| 8A (共享层补全) | 2 | ~60 | 低 |
| 8B (数据层补全) | 9 | ~1,140 | 中 |
| 8C (服务层补全) | 27 | ~12,800 | **极高** |
| 8D (表示层补全) | 12 | ~13,812 | **极高** |
| 8E (入口统一+清除) | 10 | 清理 | 中 |
| **总计** | **60** | **~27,812** | — |

---

## 七、与初版设计的对齐检查

| 初版设计模块 | 终态对应 | 状态 |
|-------------|---------|------|
| `shared/constants.js` | `shared/constants.ts` | ✅ |
| `shared/env.js` | `shared/env.ts` | M01 |
| `shared/utils.js` | `shared/utils.ts` | ✅ |
| `shared/json-helpers.js` | `shared/json-helpers.ts` | ✅ |
| `shared/html-helpers.js` | `shared/html-helpers.ts` | ✅ |
| `shared/service-locator.js` | `shared/service-locator.ts` | M02 |
| `data/models/table-data.js` | `data/models/table-data.ts` | M04 |
| `data/models/settings.js` | `data/models/settings-model.ts` | M05 |
| `data/models/template.js` | `data/models/template-model.ts` | M06 |
| `data/storage/tavern-bridge.js` | `data/storage/tavern-storage.ts` | ✅ |
| `data/storage/indexeddb.js` | `data/storage/idb-import-temp.ts` | ✅ |
| `data/storage/chat-history.js` | `data/storage/chat-history.ts` | M07 |
| `data/storage/config-storage.js` | `data/storage/config-storage.ts` | M08 |
| `data/repositories/settings-repo.js` | `data/repositories/settings-repo.ts` | M10 |
| `data/repositories/table-repo.js` | `data/repositories/table-repo.ts` | M09 |
| `data/repositories/template-repo.js` | `data/repositories/template-preset-repo.ts` | ✅ |
| `data/repositories/import-repo.js` | `data/repositories/import-repo.ts` | M11 |
| `data/repositories/isolation-repo.js` | `data/repositories/isolation-repo.ts` | ✅ |
| `service/table/update-orchestrator.js` | `service/table/update-process.ts` | ✅ |
| `service/table/merge-engine.js` | `service/table/merge-engine.ts` | M22 |
| `service/table/sheet-helpers.js` | `service/table/sheet-helpers.ts` | M20 |
| `service/ai/prompt-builder.js` | `service/ai/prompt-builder.ts` | M23+M24+M31 |
| `service/ai/api-client.js` | `service/ai/api-call.ts` | ✅ |
| `service/ai/response-parser.js` | `service/ai/response-parser.ts` | M31+M32 |
| `service/worldbook/injection-engine.js` | `service/worldbook/injection-engine.ts` | M28+M29+M30 |
| `service/worldbook/pipeline.js` | `service/worldbook/pipeline.ts` | ✅ |
| `service/worldbook/entry-builder.js` | `service/worldbook/entry-builder.ts` | M27 |
| `service/import/import-orchestrator.js` | `service/import/import-orchestrator.ts` | M33 |
| `service/import/txt-splitter.js` | `service/import/txt-splitter.ts` | M34 |
| `service/import/snapshot-manager.js` | `service/import/snapshot-manager.ts` | M35 |
| `service/summary/merge-summary.js` | `service/summary/merge-logic.ts` | ✅ |
| `service/data-admin/config-export.js` | `service/data-admin/config-export.ts` | M36 |
| `service/data-admin/chat-data-admin.js` | `service/data-admin/chat-data-admin.ts` | M37 |
| `service/runtime/state-manager.js` | `service/runtime/state-manager.ts` | M12+M13 |
| `service/runtime/event-bus.js` | `service/runtime/event-bus.ts` | M14 |
| `presentation/window/window-manager.js` | `presentation/window/window-system.ts` | ✅ |
| `presentation/window/window-styles.js` | `presentation/window/window-styles.ts` | M49 |
| `presentation/theme/theme-engine.js` | `presentation/theme/theme-engine.ts` | M50 |
| `presentation/theme/toast.js` | `presentation/theme/toast.ts` | ✅ |
| `presentation/components/editors.js` | `presentation/components/plot-editors.ts` | ✅ |
| `presentation/components/selectors.js` | `presentation/components/worldbook-selector.ts` | M41 |
| `presentation/components/table-selector.js` | `presentation/components/table-selector.ts` | ✅ |
| `presentation/pages/main-popup/*` (7文件) | `presentation/pages/main-popup/*` | M47 |
| `presentation/pages/visualizer/*` (3文件) | `presentation/pages/visualizer/*` | M48 |
| `app.js` | `app.ts` | M59 |

**全部 44 个初版设计目标模块均已在终态文档中对应，无遗漏。**
