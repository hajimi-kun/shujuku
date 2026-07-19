# V2 表格提交与 Checkpoint 约束

## 核心原则

- 业务调用方只表达业务动作，不负责理解或手写 V2 `operations` 结构。
- `operations` 必须由对应执行服务在执行动作时生成：SQL 执行服务、DSL 解析器或 CRUD service。
- 禁止通过“执行后前后快照 diff”猜测生成 `operations`，缺失真实 operation 应直接失败。
- `checkpoint` 不是 `operation`；`checkpoint.data` 是恢复用全量快照，`logEntries[].operations` 是 checkpoint 之后的可重放增量。
- 压缩成 checkpoint 不允许丢失填表/更新调度元数据。

## Operation 语义

- SQL 填表/SQL API：生成 `sql_batch`，保存可重放 SQL 语句；参数化 SQL 需保存参数。
- DSL 填表：生成 `table_edit_dsl` 或结构化 patch。
- 前端 CRUD：生成结构化行/列/单元格级 operation；不得默认为 `sheet_replace`。
- `sheet_replace` 只允许用于显式“整表替换”语义，例如单表导入、整表恢复、schema 重建。
- `data_replace` 只允许用于显式“全库替换”语义，例如全库导入、模板覆盖、灾难恢复。
- 普通填表、SQL 写入、前端 CRUD 不得静默 fallback 成 `data_replace`。
- AI 填表允许 metadata-only fill event：`operations=[]`、`filledSheetKeys/groupKeys` 记录尝试填表范围、`changedSheetKeys=[]`，用于表示“本轮触发填表但无数据变更”。

## Checkpoint 语义

- checkpoint 可因初始化、导入、手动压缩、周期压缩产生。
- 写 checkpoint 前，必须把将被清空的历史事件汇总到 `checkpoint.scheduleSummary`。
- `scheduleSummary` 至少保存每张表的：
  - `lastFilledAiFloor`
  - `lastChangedAiFloor`
- `checkpoint.event` 只表示本次 checkpoint 提交自身的事件，不代表完整历史。
- `logEntries = []` 只能在历史事件已汇总进 `scheduleSummary` 后执行。

## 状态面板读取约束

- 自动填表节奏以 `filledSheetKeys/groupKeys` 或 `scheduleSummary.lastFilledAiFloor` 为准。
- 数据变更历史以 `changedSheetKeys` 或 `scheduleSummary.lastChangedAiFloor` 为准。
- 从 checkpoint 恢复状态时，必须读取 `scheduleSummary`，不能只看 `checkpoint.event` 和当前 `logEntries`。

## 禁止事项

- 禁止让 presentation 层直接构造 V2 commit 细节。
- 禁止调用方为了保存成功而传空 operations 后由底层写全库 `data_replace`。
- 禁止 periodic checkpoint 清空同楼已有 `logEntries` 却不合并其元数据。
- 禁止把“目标表/计划表”当作“实际更新表”。
