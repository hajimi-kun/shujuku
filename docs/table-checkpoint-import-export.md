# 表格与模板 Checkpoint：发布、回滚与宿主验收

## 发布范围

Checkpoint 导入导出以 `acu-table-checkpoint` V1 文件在当前聊天间迁移完整表格数据、实际生效模板快照与 Sheet Guide。导出文件名为 `TavernDB_checkpoint_<chat>_<YYYYMMDD-HHmmss>.json`，避免浏览器下载覆盖使恢复点难以区分。来源 `storageMode` 仅用于提示；恢复允许 native 与 sqlite 双向迁移。

恢复服务为 `restoreTableCheckpointToLatestAi_ACU()`。核心提交成功后，由服务统一执行模板作用域应用、SQLite 运行时重载、旧世界书条目清理、合并数据与世界书刷新、向量 manifest 清理。V2 页面不再重复执行这些派生步骤。

成功结果包含：

- `postCondition.runtimeMatches`：活动 provider 的当前数据与 Checkpoint 快照一致；
- `postCondition.scopeIsChatOverride`：目标聊天模板作用域为 `chat_override`；
- `postCondition.templateMatches`：目标聊天规范化后的 `chat_override` 模板快照与 Checkpoint 模板一致；
- `postCondition.guideMatches`：目标聊天 Guide 与 Checkpoint 一致；
- `postCondition.providerMode`：实际活动 provider 模式，可能不同于设置模式（SQLite fallback 时尤其重要）；
- `derivedRefreshWarnings` 与 `cleanupWarnings`：核心数据已保存、但派生刷新或清理步骤失败时的部分成功告警。

## 不变量与风险边界

- 不修改 Checkpoint JSON 格式、完整性 hash、schema 校验、核心事务 write set、聊天字段集合或核心失败补偿逻辑。
- **清除范围**：导入会清除当前聊天全部 AI 楼层、所有隔离标识的本地表格数据及关联 manifest。
- **写回范围**：导入的数据只在当前激活隔离键的最新 AI 楼层建立新的 V2 revision 链；不会复制来源 revision/log。
- **模板范围**：导入把文件模板与 Guide 以 `chat_override` 写入当前聊天、当前隔离键；后续更新使用该模板，不修改聊天正文、全局模板、全局预设或其他聊天。
- SQLite provider 重载失败可 fallback 为 native。结果必须读取实际活动 provider，不能用会按设置惰性重建的 `getStorageProvider()` 覆盖 fallback 状态。
- `derivedRefreshWarnings` 不触发核心事务补偿；在核心数据已经严格保存后回滚运行时会造成聊天与运行时分裂。

## 已完成自动化证据

- 定向回归：`table-checkpoint-transfer`、`table-checkpoint-roundtrip`、`chat-scope-template`、`shared/utils`、`data-mgmt-page` 共 186 通过；覆盖 transfer 两侧 sanitizer 调用、排序委派、部分成功提示和 Checkpoint 文件名时间戳/非法字符清洗。
- 四象限：`tests/integration/table-checkpoint-roundtrip.test.ts` 使用真实 `NativeTableServiceAdapter`、`SqlTableService` 和 sql.js，native→native、native→sqlite、sqlite→native、sqlite→sqlite 共 4 通过。
- 全量：`pnpm test` 通过 200 个文件、3971 个用例，24 个既有跳过。
- `pnpm typecheck` 通过；`pnpm build` 通过，包含生成物同步与架构检查。
- 以上仅证明自动化边界；真实宿主保存、重载、世界书/向量和后续更新模板使用仍由 cp-09 人工验收确认。

## 发布前检查

1. 从干净构建环境执行 `pnpm typecheck`、`pnpm test`、`pnpm build`。
2. 检查导入确认框同时显示来源模式与当前目标模式；确认取消时不得调用恢复服务。
3. 检查 `runtimeMatches`、`scopeIsChatOverride`、`templateMatches`、`guideMatches` 与实际 `providerMode`；任何一项不满足均为部分成功，不得宣传为完全成功。
4. 若 `success` 为 true 且存在 `derivedRefreshWarnings` 或 `cleanupWarnings`，UI 必须展示具体警告摘要；保留文本并执行对应的手动刷新/宿主复查。
5. SQLite 设置下确认 `postCondition.providerMode` 是实际模式；出现 native 时 UI 必须明确标注 fallback，不得按 SQLite 完整成功处理。

## 回滚

### 单次恢复失败

核心失败路径会恢复聊天插件字段、旧 template scope、Guide 与 provider 运行时；SQLite 有二进制快照时优先恢复旧 Engine。检查返回 `success: false` 与错误文本，不要再次盲目导入。

### 已成功导入但需恢复旧业务状态

1. 使用导入前导出的 Checkpoint 再次导入；这是恢复数据、模板和 Guide 组合状态的首选方式。
2. 若只需恢复模板，使用既有聊天模板 archive 恢复入口；不要用全局模板覆盖目标聊天。
3. 若要撤回功能发布，回退本功能调用方与服务改动，随后重新执行构建和宿主人工验证；不要删除用户已有 Checkpoint 文件或聊天数据。
4. 若出现派生刷新警告，先保留已提交数据，诊断世界书/向量/SQLite 环境，再运行受控刷新；不要手工清空聊天插件字段。

## SillyTavern 宿主人工验收（待执行）

此部分必须由助手在真实 SillyTavern 宿主执行；截至本文档创建时，未执行，不能以 Vitest 代替。

1. 准备含至少一个 AI 楼层、两张表、非默认 chat override 模板与 Guide 的源聊天；分别在 native 和 sqlite 模式导出 Checkpoint。
2. 在目标聊天导入 native 文件到 native、native 文件到 sqlite、sqlite 文件到 native、sqlite 文件到 sqlite。每次确认框核对来源/目标模式，取消一次并确认零副作用。
3. 每次成功后检查表数据行、sheet 顺序、`sourceData`、`updateConfig`、`exportConfig`、Guide 与当前 chat override；刷新页面、重载聊天并切换/reload provider 后再次检查。
4. 每次导入后触发一次真实自动或手动表格更新，确认它使用导入模板，不是全局模板或旧目标模板。
5. 检查世界书条目与向量索引结果；若 UI/日志报告 `derivedRefreshWarnings`，记录完整警告与 `postCondition`，判定为部分成功而非验收通过。
6. 制造可控保存失败仅在隔离测试聊天中验证回滚，确认聊天数据、模板、Guide 和 SQLite runtime 没有分裂。

人工验收完成后，记录宿主版本、测试聊天、四象限结果、警告、复现步骤和结论，再将 cp-09 标记完成。

### 人工验收记录表

| 宿主版本 | 测试聊天 | 来源→目标模式 | 导入与重载结果 | 后续更新模板 | 世界书/向量 | 警告与 fallback | 复现步骤 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待执行 | 待执行 | native → native | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 |
| 待执行 | 待执行 | native → sqlite | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 |
| 待执行 | 待执行 | sqlite → native | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 |
| 待执行 | 待执行 | sqlite → sqlite | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 | 待执行 |

本表为空不代表通过。当前尚未在真实 SillyTavern 宿主执行，cp-09 保持未完成。
