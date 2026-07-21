# ACU 全局测试计划

> **目标**：为项目全部功能模块建立完整的单元测试 + 集成测试覆盖  
> **测试框架**：Vitest 3.2.4  
> **创建时间**：2026-04-16  
> **当前状态**：执行中  

---

## 一、测试覆盖现状

### 已有测试（首批清单，实时总数见第四节）

> 注：以下列表保留文档创建时的首批盘点；后续新增测试以第二节模块状态和第四节实时统计为准。

| # | 测试文件 | 对应源文件 | 用例数 |
|---|---------|-----------|:------:|
| 1 | `data/sqlite/schema-mapper.test.ts` | `data/sqlite/schema-mapper.ts` | 37 |
| 2 | `data/sqlite/sqlite-engine.test.ts` | `data/sqlite/sqlite-engine.ts` | 30 |
| 3 | `data/sqlite/sync-bridge.test.ts` | `data/sqlite/sync-bridge.ts` | 12 |
| 4 | `service/table/storage-mode.test.ts` | `service/table/storage-mode.ts` | 16 |
| 5 | `service/table/sql-table-service.test.ts` | `service/table/sql-table-service.ts` | 51 |
| 6 | `service/table/table-storage-strategy.test.ts` | `service/table/table-storage-strategy.ts` | 18 |
| 7 | `service/table/native-table-service-adapter.test.ts` | `service/table/native-table-service-adapter.ts` | 20 |
| 8 | `service/table/update-orchestrator.test.ts` | `service/table/update-orchestrator.ts` | 49 |
| 9 | `service/table/update-scheduler.test.ts` | `service/table/update-scheduler.ts` | 31 |
| 10 | `service/ai/prompt-prepare.test.ts` | `service/ai/prompt-builder/prompt-prepare.ts` | 9 |
| 11 | `service/ai/prompt-prepare-sql-mode.test.ts` | `service/ai/prompt-builder/prompt-prepare.ts` | 9 |
| 12 | `service/ai/table-edit-parser.test.ts` | `service/ai/prompt-builder/table-edit-parser.ts` | 36 |
| 13 | `service/runtime/helpers-data-merge.test.ts` | `service/runtime/helpers-data-merge.ts` | 17 |
| 14 | `service/runtime/template-vars/name-mapper.test.ts` | `service/runtime/template-vars/name-mapper.ts` | 22 |
| 15 | `service/runtime/template-vars/sql-query-var.test.ts` | `service/runtime/template-vars/sql-query-var.ts` | 47 |
| 16 | `service/runtime/template-vars/if-block-and-condition.test.ts` | `service/runtime/template-vars/if-block-parser.ts` | 23 |
| 17 | `service/summary/merge-executor.test.ts` | `service/summary/merge-executor.ts` | 11 |
| 18 | `presentation/sql-console.test.ts` | `presentation/pages/sql-console.ts` | 21 |
| 19 | `presentation/table-crud-api.test.ts` | `presentation/bootstrap/api-groups/table-crud-api.ts` | 39 |
| 20 | `presentation/visualizer-main-config.test.ts` | `presentation/pages/visualizer-main-config.ts` | 13 |

---

## 二、待测试模块清单（按优先级分批）

### P0：shared 层纯函数（零外部依赖，最容易测试）

| # | 源文件 | 大小 | 导出数 | 测试策略 | 状态 |
|---|--------|:----:|:------:|---------|:----:|
| 1 | `shared/utils.ts` | 17.4KB | 13 | 纯函数直接测试（日志函数 mock console） | ✅ |
| 2 | `shared/text-optimization.ts` | 8.0KB | 7 | 纯函数直接测试（去标点/关键词提取/段落匹配） | ✅ |
| 3 | `shared/template-preset-utils.ts` | 4.1KB | 8 | 纯函数直接测试 | ✅ |
| 4 | `shared/html-helpers.ts` | 2.4KB | 4 | 纯函数直接测试（escapeHtml 等） | ✅ |
| 5 | `shared/json-helpers.ts` | 866B | 2 | 纯函数直接测试（安全解析/序列化） | ✅ |

### P1：service 层纯逻辑模块（mock 全局状态后可测试）

| # | 源文件 | 大小 | 导出数 | 测试策略 | 状态 |
|---|--------|:----:|:------:|---------|:----:|
| 6 | `service/ai/prompt-builder/json-sanitizer.ts` | 15.5KB | 14 | 纯函数密集，直接测试 JSON 清洗管线 | ✅ |
| 7 | `service/runtime/helpers-context-tags.ts` | 5.9KB | 4 | mock settings，测试标签提取/过滤 | ✅ |
| 8 | `service/runtime/helpers-table-lock.ts` | 5.2KB | 11 | mock currentJsonTableData，测试锁定逻辑 | ✅ |
| 9 | `service/runtime/template-vars/cell-utils.ts` | 8.3KB | 4 | mock 表格数据，测试单元格值获取 | ✅ |
| 10 | `service/runtime/template-vars/var-store-and-tags.ts` | 15.9KB | 15 | mock settings + 表格数据，测试变量替换 | ✅ |
| 11 | `service/runtime/template-vars/seed-condition.ts` | 14.4KB | 2 | mock 依赖，测试条件求值逻辑 | ✅ |
| 12 | `service/plot/plot-state.ts` | 3.4KB | 5 | mock settings，测试状态管理 | ✅ |
| 13 | `service/plot/plot-logic.ts` | 36.5KB | 38 | 纯逻辑函数多，分组测试 | ✅ |
| 14 | `service/runtime/plot-runtime/plot-tag-utils.ts` | 12.9KB | 16 | 纯函数密集，直接测试标签解析 | ✅ |
| 15 | `service/runtime/plot-runtime/plot-data-format.ts` | 8.2KB | 4 | 纯函数，测试数据格式化 | ✅ |
| 16 | `service/summary/merge-logic.ts` | 14.4KB | 4 | mock 表格数据，测试合并判定/批次准备 | ✅ |
| 17 | `service/loop/loop-evaluator.ts` | 3.0KB | 2 | mock settings，测试循环评估 | ✅ |
| 18 | `service/loop/loop-controller.ts` | 8.5KB | 6 | mock 依赖，测试状态机逻辑 | ✅ |
| 19 | `service/settings/settings-readers.ts` | 2.4KB | 2 | mock settings，测试读取器 | ✅ |

### P2：service 层编排模块（需要 mock 多个依赖）

| # | 源文件 | 大小 | 导出数 | 测试策略 | 状态 |
|---|--------|:----:|:------:|---------|:----:|
| 20 | `service/settings/settings-service.ts` | 32.5KB | 5 | mock storage + state-manager，测试加载/保存/迁移 | ✅ |
| 21 | `service/table/table-service.ts` | 11.2KB | 3 | mock repo + state-manager，测试表格加载/保存 | ✅ |
| 22 | `service/chat/chat-service.ts` | 16.3KB | 6 | mock gateways，测试聊天数据操作 | ✅ |
| 23 | `service/import/import-executor.ts` | 13.8KB | 5 | mock 多个 service，测试导入流程 | ✅ |
| 24 | `service/optimization/content-optimization.ts` | 22.1KB | 7 | mock AI gateway，测试优化逻辑 | ✅ |
| 25 | `service/template/template-preset-service.ts` | 21.0KB | 16 | mock storage，测试预设 CRUD | ✅ |
| 26 | `service/template/chat-scope/*.ts` | ~80KB | ~36 | mock 多个依赖，测试作用域管理 | ✅ |
| 27 | `service/plot/plot-orchestrator.ts` | 13.3KB | 8 | mock plot-logic + AI，测试编排流程 | ✅ |
| 28 | `service/runtime/plot-runtime/plot-task-engine.ts` | 26.7KB | 3 | mock 多个依赖，测试任务执行引擎 | ✅ |
| 29 | `service/runtime/plot-runtime/plot-history-preset.ts` | 15.7KB | 3 | mock 依赖，测试历史预设管理 | ✅ |
| 30 | `service/runtime/plot-runtime/plot-entry.ts` | 5.0KB | 1 | mock 依赖，测试剧情入口 | ✅ |
| 31 | `service/worldbook/pipeline.ts` | 50.2KB | 0 | 大文件，按功能分组测试 | ✅ |
| 32 | `service/worldbook/injection-engine-*.ts` | ~85KB | ~29 | mock worldbook-gateway，分模块测试 | ✅ |
| 33 | `service/worldbook/worldbook-service.ts` | 3.9KB | 3 | mock gateway，测试服务层 | ✅ |
| 34 | `service/worldbook/worldbook-cleanup.ts` | 4.0KB | 1 | mock gateway，测试清理逻辑 | ✅ |
| 35 | `service/ai/api-call.ts` | 9.6KB | 4 | mock AI gateway，测试调用编排 | ✅ |
| 36 | `service/ai/prompt-builder/prompt-api-call.ts` | 16.4KB | 2 | mock 多个依赖，测试 prompt 组装 | ✅ |

### P3：data 层（外部 API 封装，mock HTTP 调用）

| # | 源文件 | 大小 | 导出数 | 测试策略 | 状态 |
|---|--------|:----:|:------:|---------|:----:|
| 37 | `data/repositories/chat-message-data-repo.ts` | 18.2KB | 17 | mock chat 数组，测试 CRUD 操作 | ✅ |
| 38 | `data/repositories/profile-repo.ts` | 3.6KB | 9 | mock storage，测试配置读写 | ✅ |
| 39 | `data/repositories/isolation-repo.ts` | 3.1KB | 6 | mock storage，测试隔离管理 | ✅ |
| 40 | `data/storage/tavern-storage.ts` | 13.0KB | 23 | mock IDB + localStorage，测试存储入口 | ✅ |
| 41 | `data/storage/chat-history.ts` | 3.4KB | 11 | mock chat 数组，测试历史读取 | ✅ |
| 42 | `data/gateways/worldbook-gateway.ts` | 5.2KB | 9 | mock SillyTavern API，测试世界书 CRUD | ✅ |
| 43 | `data/gateways/ai-gateway.ts` | 3.9KB | 8 | mock fetch/TavernHelper，测试 AI 调用 | ✅ |
| 44 | `data/gateways/chat-gateway.ts` | 3.8KB | 8 | mock SillyTavern API，测试聊天访问 | ✅ |
| 45 | `data/gateways/character-gateway.ts` | 1.9KB | 3 | mock SillyTavern API，测试角色读取 | ✅ |
| 46 | `data/gateways/host-state-gateway.ts` | 3.9KB | 4 | mock SillyTavern API，测试宿主状态 | ✅ |

### P4：集成测试（跨模块协作验证）

| # | 测试场景 | 涉及模块 | 测试策略 | 状态 |
|---|---------|---------|---------|:----:|
| I1 | 表格数据完整生命周期 | table-service → chat-message-data-repo → state-manager | mock 底层存储，验证加载→修改→保存→重新加载的数据一致性 | ✅ |
| I2 | AI 填表完整流程 | prompt-prepare → api-call → table-edit-parser → table-service | mock AI 响应，验证 prompt 构建→AI 调用→解析→应用的完整链路 | ✅ |
| I3 | 模板变量替换管线 | var-store-and-tags → cell-utils → seed-condition → if-block-parser → sql-query-var | 构造完整模板文本，验证所有变量类型的替换结果 | ✅ |
| I4 | 合并纪要完整流程 | merge-logic → merge-executor → chat-service | mock AI 响应，验证触发判定→批次准备→执行→写入的完整链路 | ✅ |
| I5 | SQLite 模式完整链路 | sync-bridge → sqlite-engine → schema-mapper → sql-table-service | 使用真实 sql.js，验证 JSON→SQL→查询→修改→导出→JSON 的完整往返 | ✅ |
| I6 | 设置加载与迁移 | settings-service → config-storage → state-manager | mock 存储，验证旧版本设置的迁移兼容性 | ✅ |

---

## 三、测试策略

### 3.1 Mock 策略

| 依赖类型 | Mock 方式 | 示例 |
|---------|----------|------|
| 全局状态（settings_ACU 等） | `vi.mock` state-manager，提供可变 mock 对象 | `let mockSettings: any = {...}` |
| 外部 API（SillyTavern 等） | `vi.mock` host-api / gateways | `SillyTavern_API_ACU: { ... }` |
| 日志函数 | `vi.mock` shared/utils 中的 log 函数 | `logDebug_ACU: vi.fn()` |
| 存储后端（IDB/localStorage） | `vi.mock` storage 模块 | `getFromStorage: vi.fn()` |
| AI 响应 | 构造固定的 AI 返回文本 | `"<tableEdit>insertRow(...)</tableEdit>"` |

### 3.2 测试分类

每个测试文件包含三类测试：
1. **正常流程**：标准输入 → 预期输出
2. **边界条件**：空值、极端值、类型错误
3. **异常处理**：依赖抛错、网络失败、数据损坏

### 3.3 命名规范

- 测试文件：`tests/<层>/<模块>/<源文件名>.test.ts`
- describe 块：按导出函数分组
- it 描述：中文，描述行为而非实现

---

## 四、执行进度

| 批次 | 范围 | 预计文件数 | 实际用例数 | 状态 |
|:----:|------|:--------:|:--------:|:----:|
| P0 | shared 层纯函数 | 5 | 209 | ✅已完成 |
| P1 | service 层纯逻辑 | 14 | 614 | ✅已完成 |
| P2 | service 层编排 | 17 | 570（17/17 已完成） | ✅已完成 |
| P3 | data 层 | 10 | 218（10/10 已完成） | ✅已完成 |
| P4 | 集成测试 | 6 | 41（6/6 已完成） | ✅已完成 |
| P5 | 补充覆盖（遗漏模块） | 6 | 106（6/6 已完成） | ✅已完成 |
| **当前实际** | **84 文件** | **84** | **2287** | **全部通过 ✅** |

### P5：补充覆盖（遗漏模块）

| # | 源文件 | 大小 | 导出数 | 测试策略 | 状态 |
|---|--------|:----:|:------:|---------|:----:|
| 47 | `service/runtime/state-manager.ts` | 8.9KB | 40+ | mock chat-gateway，测试门控逻辑/setter/AbortController 管理 | ✅ |
| 48 | `service/runtime/message-handler.ts` | 3.0KB | 1 | mock host-state-service，测试消息评估全分支 | ✅ |
| 49 | `data/storage/config-storage.ts` | 1.5KB | 1 | mock tavern-storage + profile-repo，测试持久化逻辑 | ✅ |
| 50 | `data/storage/optimization-cache-storage.ts` | 2.5KB | 2 | mock window + localStorage，测试双层缓存读写 | ✅ |
| 51 | `service/runtime/helpers-remaining.ts` | 5.9KB | 1 | mock 全部子模块，测试 handleChatCompletionReady 管线 | ✅ |
| 52 | `service/ai/ai-service.ts` | 3.0KB | 1 | mock fetch，测试模型列表获取全分支 | ✅ |

> **跳过说明**：以下文件为纯 re-export 入口，无独立逻辑，不需要单独测试：
> - `service/host/host-state-service.ts`（re-export host-state-gateway）
> - `service/worldbook/injection-engine.ts`（re-export 5 个子模块）
> - `service/template/chat-scope/index.ts`（re-export）
>
> 以下文件已在 `chat-scope.test.ts` 中被覆盖：
> - `chat-scope-base.ts`、`chat-scope-plot.ts`、`chat-scope-sheet.ts`

---

*文档创建时间：2026-04-16*  
*P5 补充完成时间：2026-04-17*
