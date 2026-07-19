# 运行时 DB 与 V2 顺序日志实现思路

## 核心原则

运行时 DB 是热路径的当前状态权威。

SQL 填表的热路径只做两件事：

1. SQL 直接在当前运行时 DB 上执行。
2. 执行成功后，把 SQL 作为 V2 operation log 顺序追加到聊天持久化数据中。

不允许在热路径中：

- 为了填表保存而 replay 聊天历史。
- 为了填表保存而重建运行时 DB。
- 先在临时 DB 上执行 SQL，再把结果反灌回运行时 DB。
- 用 `beforeData/afterData` diff 伪造 patch。

## 热路径：AI SQL 填表

正确流程：

```text
AI 返回 SQL
→ 获取当前 StorageProvider
→ 确保运行时 DB 已初始化
→ 在运行时 DB 上执行 SQL（SQLite 事务）
→ 从运行时 DB 导出当前 JSON 快照（仅用于持久化 checkpoint/世界书/UI）
→ 追加 V2 operation log：{ kind: 'sql_batch', statements: [...] }
→ 用运行时 DB 当前快照更新世界书/UI
```

注意：

- SQL 执行成功后，运行时 DB 已经是新状态，不需要重建。
- 不同自动填表分组可以使用不同 AI / 不同预设；它们不是同一个 AI 批次，也不应因为保存目标相同而被强行合并成一个跨 group SQL 事务。
- 同一个 group 的一次 SQL 输出才是必须原子的事务边界：如果同一段 SQL 先写 A/B 表、后续 C 表报错，A/B 的写入必须随本次 SQLite 事务一起回滚。
- SQL 真正修改运行时 DB 之前必须做 runtime revision 新鲜度校验；版本过期时直接失败并重试，不允许先改 DB 再在保存阶段发现版本不对。
- 同一个 group 的 SQL 执行失败或持久化失败，都必须恢复执行前的运行时 DB 快照，避免下一轮重试遇到 `UNIQUE constraint failed` 这类半成功残留。
- `afterData` 不是 SQL log 的来源；SQL log 的来源是实际执行成功的 SQL 语句。`afterData` 只用于 checkpoint 或需要当前 JSON 的消费方。

## 冷路径：恢复运行时 DB

冷路径只在运行时 DB 不存在或需要重建时发生，例如：

- 页面刷新。
- 切换聊天。
- 脚本重新加载。
- SQLite provider dispose 后重新初始化。
- 用户显式要求重载/恢复。

正确流程：

```text
找到最后一个 V2 full checkpoint
→ 初始化新的运行时 DB
→ 将 checkpoint.data load 到运行时 DB
→ 从 checkpoint 之后开始按 messageIndex 升序遍历
→ 同一 message 内按 seq 升序遍历 operation log
→ 按顺序把 operation 应用到同一个运行时 DB
→ 恢复完成；需要 JSON 时再从运行时 DB export
```

冷路径不应该每条 SQL 新建临时 DB。恢复目标是运行时 DB，不是“中间 JSON 快照”。

## V2 operation 应用规则

- `sql_batch`：在同一个恢复运行时 DB 上执行 SQL。
- `sheet_replace`：替换目标表，可通过运行时 DB 的表级导入/重建实现。
- `data_replace`：替换完整数据，可直接重新 load 到运行时 DB。
- `table_edit_dsl`：原生 DSL 兼容路径；SQLite 模式应尽量避免新增这种日志。

## 状态/UI 刷新

热路径提交成功后：

```text
provider.getCurrentData()
→ updateReadableLorebookEntry(dataOverride)
→ _notifyTableUpdate
→ updateCardUpdateStatusDisplay
```

不应调用会从聊天历史 `merge/replay` 的刷新函数。

冷路径初始化完成后，才允许通过 V2 checkpoint + log 恢复运行时 DB。
