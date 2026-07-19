# V2 存储旧聊天自动迁移约束

## 目标

原版旧聊天和 V1 旧聊天在新版插件加载当前聊天数据库时，自动迁移到 V2 存储结构。

迁移只改变存储结构，不改变业务可见数据：迁移前旧合并链路看到什么，迁移后的 V2 checkpoint 就保存什么。

## 业务触发点

迁移只发生在一个业务时机：

> 当前聊天、当前隔离标签的数据库加载阶段。

典型链路：

```text
进入/切换聊天
→ 应用当前模板/隔离标签
→ 加载聊天数据库
→ 检测存储策略
→ legacy-v1：合并旧数据并迁移为 V2 checkpoint
→ v2：回放 V2 storageFrame
```

切换隔离标签不是独立业务场景，本质仍是重新加载当前聊天数据库。迁移单位是 `当前聊天 + 当前 isolationKey`。

写入阶段不承担业务迁移。如果写入时仍检测到 `legacy-v1`，说明加载迁移链路漏掉了，应直接失败；不能继续写 V1，也不能偷偷兜底迁移。

## 输入旧格式

迁移覆盖两类旧格式：

1. 原版顶层字段：
   - `TavernDB_ACU_IndependentData`
   - `TavernDB_ACU_Data`
   - `TavernDB_ACU_SummaryData`
   - `TavernDB_ACU_ModifiedKeys`
   - `TavernDB_ACU_UpdateGroupKeys`
   - `TavernDB_ACU_Identity`
2. V1 隔离槽字段：
   - `TavernDB_ACU_IsolatedData[isolationKey].independentData`
   - `TavernDB_ACU_IsolatedData[isolationKey].incrementalData`
   - `modifiedKeys`
   - `updateGroupKeys`
   - `_acu_storage_mode = checkpoint | delta | legacy`
   - `_acu_storage_version = 1`

## 输出 V2 结构

迁移写入最新 AI 楼层，形成一个 V2 full checkpoint：

```ts
{
  _acu_storage_version: 2,
  storageFrame: {
    version: 2,
    headRevision: 'checkpoint:migration:...',
    checkpoint: {
      kind: 'full',
      reason: 'migration',
      createdAt: number,
      data: mergedLegacyData,
      scheduleSummary: migratedLegacyScheduleSummary
    },
    logEntries: []
  }
}
```

迁移 checkpoint 不写 `event`。原因：迁移不是一次填表事件，不能把所有表的 `lastFilledAiFloor` 推进到迁移所在楼层。

## 不生成历史 operations

旧聊天没有真实 V2 operation 语义。迁移不得把旧快照或 V1 delta 反向猜测成：

- `sql_batch`
- `table_edit_dsl`
- `row_upsert`
- `row_delete`
- `meta_update`
- `sheet_replace`

迁移只写 full checkpoint。checkpoint 之后的新写入才必须携带真实 operations。

## scheduleSummary 迁移

迁移需要从旧消息扫描当前隔离标签的历史状态，生成 `checkpoint.scheduleSummary`，避免迁移后表状态退回未初始。

规则：

- `updateGroupKeys` 命中的表：更新 `lastFilledAiFloor`。
- `modifiedKeys` 命中的表：更新 `lastFilledAiFloor` 与 `lastChangedAiFloor`。
- `incrementalData` 命中的表：更新 `lastFilledAiFloor` 与 `lastChangedAiFloor`。
- 旧消息没有 keys 但包含表数据：按旧语义视为该楼层提供过数据，更新 `lastFilledAiFloor` 与 `lastChangedAiFloor`。

只记录迁移后数据中仍存在的 `sheet_*`，不复活当前模板/指导表已过滤掉的旧表。

## 清理旧字段

V2 checkpoint 写入成功后，必须清理当前隔离标签下的旧字段，否则 `legacy-v1 wins` 会导致下一次加载继续走旧链路。

清理规则：

- 只清理当前 `isolationKey`。
- 保留其他隔离标签的数据。
- 保留已写入的 V2 `storageFrame`。
- 顶层旧字段只在 `TavernDB_ACU_Identity` 匹配当前隔离配置时清理。

## 失败语义

迁移没有兜底。

- 旧数据合并为空：失败。
- 没有 AI 目标楼层：失败。
- 写入或保存失败：失败。
- 失败时不清理旧字段。
- 写入阶段检测到 legacy-v1：失败。

不允许在失败时悄悄初始化新库、继续写 V1、或通过快照 diff 猜测 operations。
