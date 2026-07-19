# SQL 注入模板实现计划

目标：新增“表注入内容模板”字段，让表格进入全局可读条目或单独世界书条目时，优先使用用户写的 `{[sql ...]}` / `{[db...]}` 模板，而不是只能使用默认整表 Markdown。

## 判断规则

- 注入去向继续沿用现有配置自动判断，不新增 `injectionMode`。
- `exportConfig.injectIntoWorldbook === false`：不注入。
- `exportConfig.enabled === true`：单独生成世界书条目。
- `exportConfig.enabled !== true && injectIntoWorldbook !== false`：拼进全局可读条目。
- 如果表配置了注入内容模板，则使用模板原文。
- 如果没有配置注入内容模板，则保持旧的 Markdown 生成逻辑。
- 模板中的 `{[sql ...]}` / `{[db...]}` 必须保留到世界书条目中，发送前由现有 `replaceDbSqlVariables()` 链路展开。
- 该能力仅在 SQLite 模式启用；非 SQLite 模式下流程会忽略 `sqlInjectionTemplate` 并回退旧的表格内容生成。

## 任务清单

- [x] 梳理现有世界书注入和新 UI 配置入口。
- [x] 编写实现计划文档。
- [x] 扩展表格导出配置数据结构和默认值。
- [x] 改造全局可读条目生成逻辑，支持单表注入模板。
- [x] 改造单独导出条目生成逻辑，支持单表注入模板。
- [x] 在新 UI 单表配置中加入注入内容模板编辑。
- [x] 限制 SQL 注入模板仅在 SQLite 模式显示和生效。
- [x] 运行类型检查/测试并记录结果。

## 验证结果

- `npm run typecheck`：通过。
- `npm run build:nocheck`：通过，并同步更新 `index.js` 与 `酒馆助手脚本-SP·数据库.json`。
- SQLite 模式限制：已补充 UI 显示判断和世界书生成流程判断。

## 实现细节

- 字段名：`exportConfig.sqlInjectionTemplate`。
- 含义：该表参与世界书注入时的内容模板。
- 全局可读条目：参与全局的表逐表生成内容；若有 `sqlInjectionTemplate`，拼入模板原文；否则拼入旧的 `# 表名 + Markdown 表格`。
- 单独导出条目：若有 `sqlInjectionTemplate`，主条目内容使用模板原文；索引条目逻辑保持不变。
- 按行拆分导出：先保持旧逻辑，不对 `sqlInjectionTemplate` 做行级拆分；若配置了模板，则按整表主条目处理，避免同一模板被拆成多条重复条目。
- UI：在新 UI 的单表配置中加入多行文本框，提示“留空则使用默认表格内容；支持 `{[sql ...]}` / `{[db...]}`”。
