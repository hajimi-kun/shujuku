# 表格写入并发与锁设计

## 背景

V2 存储协议已经具备 append-only log、before/after patch、checkpoint 和 source 语义，但并发安全不能只靠 V2 log。当前真正的问题不是某一个 `targetMessageIndex` 锁粒度不对，而是：

```text
不同写入入口各自维护锁，锁的语义不统一。
有的入口只锁保存阶段，有的入口锁 mutation + save，有的入口使用 -1，有的入口使用真实楼层。
最终导致所有入口看起来“有锁”，但不一定互斥同一份运行时状态和同一条持久化链路。
```

因此必须先定义哪些操作必须串行，再按这些规则设计一套唯一的写锁机制。

## 事实修正

AI 填表 vs AI 填表不同楼层不会作为主要并发场景处理。

原因：当前填表编排本身按批次/桶推进，同一轮 AI 填表不会同时把两个不同楼层作为独立写事务并发提交。AI 响应收集可以并发，但真正应用到运行时表格并保存的阶段应进入统一写事务。

所以本文重点处理的是：

```text
AI 填表写入 vs 前端 CRUD 写入
AI 填表写入 vs raw SQL 写入
前端 CRUD vs 前端 CRUD
前端 CRUD vs raw SQL
清理/删除楼层/compaction vs 任意表格写入
导入/重载 provider/保存当前表 vs 任意表格写入
```

## 当前问题

### 1. 锁 scope 语义不一致

当前 `buildTableUpdateApplyScopeKey_ACU` 使用：

```text
chatKey + isolationKey + targetMessageIndex
```

这会把同一个聊天、同一个隔离标签下的写入拆成多个互不互斥的 scope。

问题不只是 `-1` 和真实楼层不一致，更根本的是：表格运行时状态是全局共享的。

```text
currentJsonTableData_ACU
SQLite provider 内部状态
SillyTavern chat message 上的 TavernDB_ACU_IsolatedData
世界书刷新依赖的合并视图
```

这些状态不是按 `targetMessageIndex` 隔离的，因此锁也不能按 `targetMessageIndex` 作为主要隔离维度。

### 2. 有些入口只锁保存阶段

例如前端 CRUD 的原生模式会先修改 `currentJsonTableData_ACU`，之后才调用保存入口。

这会导致：

```text
mutation 已经发生在锁外。
save 阶段再加锁已经太晚。
beforeData/afterData 的 diff 可能混入别的写入。
V2 log 的 source 和 patches 可能归属错误。
```

### 3. `useScopeLock=false` / `WithinScopeLock` 语义不安全

当前存在“外层已经加锁，所以内层保存不再加锁”的调用形式。但这个约定依赖调用方自觉维护，无法从类型和运行时上证明外层真的持有同一把锁。

这会形成隐患：

```text
某个新入口误用 WithinScopeLock。
某个入口直接传 useScopeLock=false。
保存绕过统一锁。
```

## 设计目标

1. 所有会修改表格运行时状态或表格持久层的入口，必须使用同一套锁。
2. 锁的 scope 基于真实共享资源，而不是调用者各自理解的目标楼层。
3. mutation、before/after 捕获、V2 append log、legacy 保存、checkpoint、saveChat 必须在同一个临界区内完成。
4. AI 响应收集、纯读取、UI 通知、向量索引异步 flush 可以不占用表写锁。
5. 禁止入口自行维护锁 key。
6. 禁止公开绕过锁的保存 API。
7. 允许内部可证明的重入，但必须通过 transaction context，而不是布尔参数。

## 哪些地方必须串行

### A. 运行时表格数据写入

以下操作必须串行：

```text
1. 直接修改 currentJsonTableData_ACU。
2. 通过 _set_currentJsonTableData_ACU 替换当前运行时表格。
3. SQLite provider 执行 INSERT / UPDATE / DELETE / DDL 后同步 JSON 视图。
4. 导入完整数据库。
5. 初始化数据库结构。
6. 从聊天历史重新加载并覆盖当前运行时表格。
```

原因：这些操作共享同一份运行时数据源。

### B. 聊天持久层写入

以下操作必须串行：

```text
1. V2 persist：计算 patches、生成 seq、append log、写 checkpoint。
2. legacy-v1 persist：写 independentData / incrementalData / modifiedKeys / updateGroupKeys。
3. saveChatToHost_ACU。
4. 写 TavernDB_ACU_IsolatedData。
5. 写/删旧顶层 TavernDB_ACU_Data / TavernDB_ACU_IndependentData / TavernDB_ACU_SummaryData。
```

原因：这些操作共享同一条聊天消息持久化链。

### C. 会改变恢复链的历史操作

以下操作必须串行：

```text
1. purgeOldLayerData_ACU。
2. clearTableDataAtFloors_ACU。
3. deleteLocalDataInChatCore_ACU。
4. V2 boundary checkpoint / compaction。
5. 删除楼层本地数据字段。
```

原因：这些操作可能删除 checkpoint/log 或旧 partial checkpoint 链。

### D. 同一写入事务中的派生刷新

以下操作默认放在写事务保存成功之后执行，但仍应由统一事务入口调度：

```text
1. refreshMergedDataAndNotifyWithUI_ACU。
2. updateReadableLorebookEntry_ACU。
3. enqueueSummaryVectorIndexFlush_ACU。
4. AutoCardUpdaterAPI._notifyTableUpdate。
```

建议：

```text
写锁内完成 mutation + persist + saveChat。
写锁外执行 UI notify / 异步 vector flush。
如果 refresh 会重新读取并覆盖 currentJsonTableData_ACU，则 refresh 必须仍由事务入口串行调度，不能和另一个写事务并发。
```

## 哪些地方不需要表写锁

以下操作不占用表写锁：

```text
1. AI 请求发送和响应收集。
2. prompt 构造。
3. 纯 SELECT / PRAGMA / EXPLAIN SQL 查询。
4. 只读的表格快照展示。
5. 参数解析和基础校验。
6. 只 enqueue、不立即读写表格状态的异步任务。
```

但注意：只读操作如果结果会用于后续写入，则必须在写锁内重新确认关键条件。

例如：

```text
前端 CRUD 可以在锁外解析参数。
但 targetSheet、rowIndex、latestDataMessageIndex、targetMessageIndex 必须在锁内重新读取或校验。
```

## 统一锁模型

### 锁粒度

最正确的目标模型不是“单一表写锁”，也不是“只按表锁”。正确模型应是多粒度事务锁：

```text
1. isolation maintenance lock：保护恢复链结构变更。
2. sheet mutation lock：保护具体 sheet 的业务 mutation。
3. isolation commit lock：保护 V2 log append、seq 分配、checkpoint、saveChat。
```

`targetMessageIndex` 不参与锁 scope。它是写入目标和日志元数据，不是并发隔离维度。

### 为什么不能只有表锁

A 表锁和 B 表锁可以让两个表的 mutation 并行，但不能保护同一个 `storageFrame.logEntries`。

错误模型：

```text
T1: A 表写事务拿 A 表锁。
T2: B 表写事务拿 B 表锁。
T1/T2 不互斥，同时读取同一个 TavernDB_ACU_IsolatedData[isolationKey].storageFrame。
T1 看到 logEntries=[1,2]，准备 append seq=3(A)。
T2 也看到 logEntries=[1,2]，准备 append seq=3(B)。
T1 saveChat，frame 变为 [1,2,3(A)]。
T2 saveChat，frame 变为 [1,2,3(B)]。
结果：A 的 log 被 B 覆盖，或者 seq 冲突。
```

因此：

```text
sheet lock 只能保护“这张表怎么改”。
commit lock 必须保护“这次修改如何进入 isolationKey 级共享日志”。
```

### 正确锁层级

#### 1. isolation maintenance lock

锁 key：

```text
chatKey + isolationKey + maintenance
```

用途：

```text
purgeOldLayerData_ACU
clearTableDataAtFloors_ACU
deleteLocalDataInChatCore_ACU
V2 compaction / boundary checkpoint
provider reload / storage mode switch
```

模式：

```text
普通写事务获取 shared maintenance lock。
清理/删除/compaction 获取 exclusive maintenance lock。
```

含义：清理恢复链时，禁止普通写事务同时写入。

#### 2. sheet mutation lock

锁 key：

```text
chatKey + isolationKey + sheet + sheetKey
```

用途：

```text
保护同一张表的业务 mutation。
A 表和 B 表可以并行 mutation。
同一张 A 表的两个 CRUD / AI / SQL 写入必须串行 mutation。
```

多表事务必须按稳定顺序加锁，避免死锁：

```text
sheetKeys.sort() 后依次加锁。
```

如果无法静态确定写入表，例如 raw SQL 未提供 targetSheetKeys，必须升级为：

```text
chatKey + isolationKey + sheet + *
```

`sheet:*` 与所有具体 sheet lock 互斥。

#### 3. isolation commit lock

锁 key：

```text
chatKey + isolationKey + commit
```

用途：

```text
重新读取最新 storageFrame。
分配 V2 log seq。
append log entry。
写 full checkpoint / periodic checkpoint / boundary checkpoint。
执行 saveChatToHost_ACU。
更新全局 currentJsonTableData_ACU 的已提交视图。
```

A 表和 B 表可以并行计算 patch，但 commit 必须串行：

```text
A mutation 并行完成。
B mutation 并行完成。
A 进入 commit lock，append seq=3。
B 等待 commit lock。
B 进入 commit lock 后重新读取最新 head，append seq=4。
```

这样不会发生 A log 覆盖 B log。

### 正确事务模型

每个写事务必须有私有 working copy，禁止在锁外或未提交前直接污染全局状态：

```text
baseData：事务开始时的快照。
workingData：事务私有可变副本。
beforeData：mutation 前的 workingData。
afterData：mutation 后的 workingData。
patches：beforeData -> afterData。
writeSet：本事务写入的 sheet/row/cell 范围。
baseRevision：事务基于的 V2 log head。
```

commit 时必须执行 rebase/冲突检测：

```text
1. 进入 isolation commit lock。
2. 读取 latestRevision / latestState。
3. 如果 latestRevision === baseRevision，直接 append。
4. 如果 latestRevision !== baseRevision：
   - 收集 baseRevision 之后已经提交的 writeSet。
   - 如果与当前 writeSet 不冲突，把当前 patches rebase 到 latestState 后 append。
   - 如果冲突，按策略重试、拒绝或重新基于 latestState 执行 mutation。
5. 分配全局单调 seq。
6. append log entry。
7. 必要时基于 latestState + 当前 patches 写 checkpoint。
8. saveChatToHost_ACU。
9. 提交后再更新全局 currentJsonTableData_ACU。
```

### 冲突判定粒度

最小可接受粒度：

```text
sheetKey 级冲突。
```

更精确的目标粒度：

```text
row_id 级冲突。
cell 级冲突。
schema/meta 变更视为整表冲突。
sheet_replace 视为整表冲突。
```

冲突策略：

```text
不同 sheet：允许自动 rebase。
同 sheet 不同行：如果 patch 能稳定定位 row_id，允许 rebase。
同 row/cell：默认冲突，要求重试或返回失败。
schema_change / sheet_replace：与同 sheet 任意写入冲突。
legacy-v1：不做细粒度并发，退化为 isolation exclusive 写事务。
```

### V2 log 需要补充的元数据

为支持正确 rebase，V2 log entry 应补充：

```ts
interface TableMutationLogEntryV2_ACU {
  seq: number;
  entryId: string;
  baseRevision?: string;
  parentRevision?: string;
  commitRevision?: string;
  writeSet?: TableMutationWriteSetV2_ACU;
}
```

`commitRevision` 可以使用：

```text
entryId
或 `${seq}:${entryId}`
```

storageFrame 可补充：

```ts
interface TableStorageFrameV2_ACU {
  version: 2;
  headRevision?: string;
  checkpoint?: TableCheckpointV2_ACU;
  logEntries: TableMutationLogEntryV2_ACU[];
}
```

### 锁 key 构造

```ts
export function buildTableMaintenanceScopeKey_ACU(parts: {
  chatKey?: string | null;
  isolationKey?: string | null;
}): string;

export function buildTableSheetMutationScopeKey_ACU(parts: {
  chatKey?: string | null;
  isolationKey?: string | null;
  sheetKey: string | '*';
}): string;

export function buildTableCommitScopeKey_ACU(parts: {
  chatKey?: string | null;
  isolationKey?: string | null;
}): string;
```

加锁顺序固定为：

```text
maintenance shared/exclusive -> sheet locks sorted -> commit lock
```

任何代码不得反向加锁。

### 统一事务入口

新增唯一入口。调用方必须声明写入范围，事务管理器据此选择 sheet lock 或 `sheet:*`：

```ts
export type TableWriteConflictUnitV2_ACU =
  | { kind: 'sheet'; sheetKey: string }
  | { kind: 'row'; sheetKey: string; rowId: string }
  | { kind: 'cell'; sheetKey: string; rowId: string; columnKey: string }
  | { kind: 'schema'; sheetKey: string }
  | { kind: 'all' };

export interface TableWriteTransactionContext_ACU {
  readonly transactionId: string;
  readonly chatKey: string;
  readonly isolationKey: string;
  readonly source: TableMutationSourceV2_ACU | 'system_cleanup' | 'system_reload';
  readonly baseRevision: string | null;
  readonly writeSet: TableWriteConflictUnitV2_ACU[];
}

export interface RunTableWriteTransactionOptions_ACU {
  source: TableMutationSourceV2_ACU | 'system_cleanup' | 'system_reload';
  reason: string;
  isolationKey?: string;
  writeSet: TableWriteConflictUnitV2_ACU[];
  maintenanceMode?: 'shared' | 'exclusive';
  conflictPolicy?: 'fail' | 'retry' | 'rebase-disjoint';
}

export async function runTableWriteTransaction_ACU<T>(
  options: RunTableWriteTransactionOptions_ACU,
  task: (ctx: TableWriteTransactionContext_ACU, workingData: TableDataObject_ACU) => Promise<T>,
): Promise<T>;
```

所有表写入口必须通过这个函数进入事务。该函数负责：

```text
1. 获取 maintenance lock。
2. 根据 writeSet 获取 sheet mutation locks。
3. 创建私有 workingData。
4. 执行业务 mutation。
5. 进入 commit lock。
6. 执行冲突检测 / rebase / append log / checkpoint / saveChat。
7. 提交后更新全局运行时视图。
```

### 禁止公开绕锁

废弃或私有化：

```text
saveIndependentTableToChatHistoryWithinScopeLock_ACU
useScopeLock=false
runRawSqlWriteWithScopeLock_ACU 自建 scope
调用方直接 buildTableUpdateApplyScopeKey_ACU
```

替代为：

```text
所有内部保存函数接收 TableWriteTransactionContext_ACU。
没有 ctx 就不能走内部 no-lock 保存。
```

示例：

```ts
async function persistTablesToChatMessageInTransaction_ACU(
  ctx: TableWriteTransactionContext_ACU,
  options: TableChatPersistOptions_ACU,
): Promise<PersistResult_ACU>;
```

## 写事务标准流程

所有写事务必须遵守：

```text
1. 解析调用参数，声明 writeSet；不能确定 writeSet 时声明 all。
2. 进入 runTableWriteTransaction_ACU。
3. 获取 maintenance shared lock；清理/删除类操作获取 exclusive lock。
4. 按 writeSet 获取 sheet mutation locks；多个 sheet 按 sheetKey 排序。
5. 在事务内重新获取 chat / isolationKey / storage strategy。
6. 在事务内解析真实 targetMessageIndex。
7. 基于当前 committed state 创建私有 workingData。
8. 在 workingData 上捕获 beforeData。
9. 在 workingData 上执行 mutation，不直接污染全局 currentJsonTableData_ACU。
10. 捕获 afterData，生成 patches 和 writeSet。
11. 进入 isolation commit lock。
12. 重新读取 latestRevision / latestState。
13. 执行冲突检测；不冲突则 rebase 到 latestState，冲突则 fail/retry。
14. 分配全局 seq，append V2 log；legacy-v1 则在 isolation exclusive 模式下保存。
15. 必要时基于 latestState + patches 写 checkpoint。
16. saveChatToHost_ACU。
17. 提交成功后原子更新全局 currentJsonTableData_ACU / provider 视图。
18. 释放 commit lock、sheet locks、maintenance lock。
19. 锁外执行 UI notify / 异步 vector flush。
```

禁止流程：

```text
1. 锁外修改 currentJsonTableData_ACU，再进锁保存。
2. 锁外执行 raw SQL mutation，再进锁保存。
3. 锁外删除 frame/checkpoint，再进锁修复。
4. 在不同入口自行计算不同 scopeKey。
```

## 各入口改造规则

### 1. AI 填表

AI 请求和响应收集不加表写锁。

进入锁的边界：

```text
parseAndApplyTableEdits_ACU 开始之前。
```

锁内执行：

```text
1. 恢复 batchBaseSnapshot 或读取当前数据。
2. parseAndApplyTableEdits_ACU。
3. applySpecialIndexSequenceToSummaryTables_ACU。
4. 计算 keysToPersist / keysToTrackAsUpdated。
5. persistTablesToChatMessageInTransaction_ACU。
6. updateReadableLorebookEntry_ACU 如果会读写当前表状态，则留在事务调度内；如果只是外部 worldbook 写，可在保存后执行。
```

AI vs AI 不按“不同楼层并发”建模。单次编排的 apply/save 本来应串行；多次外部触发的 AI 填表按 writeSet 获取 sheet mutation lock，最终通过 isolation commit lock 串行进入 V2 log。

### 2. 前端 CRUD

参数解析可以在锁外。

以下必须在锁内重新执行或校验：

```text
1. findTargetSheet。
2. 行列边界检查。
3. SQLite mutation 或原生 JSON mutation。
4. findTableLatestFloor / resolveTableHistoryStateFromChat。
5. saveToLatestFloorAndRefresh 中的 persist。
```

保存 source：

```text
manual_crud
```

CRUD 的 `filledSheetKeys`：

```text
默认为空，不推进自动填表冷却。
changedSheetKeys 使用被修改的 sheetKey。
```

### 3. raw SQL

`executeSqlMutation` / `executeSqlBatch` 的 SQL 写入必须在统一表写事务内执行。

锁内执行：

```text
1. getStorageProvider().executeMutation / executeBatch。
2. provider exportToTableData。
3. _set_currentJsonTableData_ACU。
4. saveToChat / persist。
```

保存 source：

```text
executeSqlMutation -> raw_sql_mutation
executeSqlBatch -> raw_sql_batch
```

`SELECT / PRAGMA / EXPLAIN / WITH` 不加写锁。

### 4. saveCurrentDataForTable_ACU

必须通过统一事务入口。

锁内重新计算：

```text
1. currentJsonTableData_ACU[sheetKey] 是否存在。
2. resolveTableHistoryStateFromChat_ACU。
3. targetMessageIndex。
4. persist。
```

### 5. purgeOldLayerData_ACU

整个恢复链变更必须在统一写事务内完成。

锁内执行：

```text
1. 计算 dataMessageIndices / cutoff / anchor。
2. 对 V2 isolationKey 删除前写 boundary checkpoint。
3. legacy orphaned sheet 迁移。
4. 删除旧楼层字段。
5. saveChatToHost_ACU。
```

禁止在写锁外删除 checkpoint/log。

### 6. clearTableDataAtFloors_ACU

必须在统一写事务内执行。

规则：

```text
1. 删除前预检删除范围是否覆盖 latest full checkpoint。
2. 如果会破坏恢复链，先生成删除范围之外的 boundary checkpoint。
3. boundary checkpoint 成功后才允许删除。
4. 如果没有安全保留楼层，必须中止。
5. 后续重写必须在同一事务或同一事务链内完成。
```

### 7. deleteLocalDataInChatCore_ACU

必须在统一写事务内执行。

规则：

```text
1. 删除前计算待删除范围和保留范围。
2. 删除前预检 V2 恢复链。
3. 必要时先写 boundary checkpoint。
4. 成功后删除。
5. 删除后 replay 只做校验，不作为保护机制。
```

### 8. provider reload / storage mode 切换

如果会替换当前 provider、导出/导入当前数据、重载 SQLite 状态，必须进入统一表写事务。

## targetMessageIndex 的定位

`targetMessageIndex` 不再参与锁 scope，但仍然是持久化元数据。

规则：

```text
1. targetMessageIndex 必须在锁内解析。
2. -1 表示“当前事务内的最新 AI 消息”。
3. 如果调用方传入真实 index，也必须在锁内校验该 index 仍然存在且仍是 AI 消息。
4. V2 log entry 的 targetMessageIndex 写解析后的真实 index。
5. legacy-v1 写入也使用解析后的真实 index。
```

新增：

```ts
export function resolveTableWriteTargetMessageIndex_ACU(
  chat: any[],
  requestedTargetMessageIndex?: number | null,
): number;
```

## before/after 的语义

V2 patch 的 before/after 必须来自同一事务。

```text
beforeData：锁内 mutation 前的当前数据快照。
afterData：锁内 mutation 后的当前数据快照。
patches：beforeData -> afterData。
```

对于已经由外部 mutation 完成的旧入口，改造时必须把 mutation 移入事务；不能继续使用“保存时现取 beforeData”的方式掩盖锁外修改。

## Reentrant / 嵌套调用设计

允许事务内调用内部 persist，但必须显式传递 `ctx`。

禁止：

```text
useScopeLock=false
WithinScopeLock 但没有 ctx
内部函数自己猜测当前已经持锁
```

允许：

```ts
await runTableWriteTransaction_ACU({ source: 'manual_crud', reason: 'updateCell' }, async (ctx) => {
  // mutate
  await persistTablesToChatMessageInTransaction_ACU(ctx, options);
});
```

如果内部函数收到的 `ctx.scopeKey` 与当前 chat/isolationKey 不一致，必须拒绝执行。

## 错误处理

写事务失败时：

```text
1. 不吞异常。
2. 必须释放锁。
3. 如果 mutation 已经改了运行时状态但 persist 失败，应按能力恢复 beforeData，或至少重新从聊天恢复当前数据。
4. V2 append log 和 saveChatToHost_ACU 失败时，不应标记为 saved。
5. cleanup/delete/compaction 失败时必须中止后续删除。
```

## 建议模块拆分

新增：

```text
src/service/table/table-write-transaction.ts
```

职责：

```text
1. buildTableWriteScopeKey_ACU。
2. runTableWriteTransaction_ACU。
3. resolveTableWriteTargetMessageIndex_ACU。
4. assertTableWriteTransactionContext_ACU。
5. 提供事务内 before/after snapshot 工具。
```

调整：

```text
src/service/table/table-update-queue.ts
```

保留底层 FIFO promise queue，但不再暴露给业务入口直接构造 scope。

```text
src/service/table/table-service.ts
```

保留公开 `persistTablesToChatMessage_ACU`，但其内部必须走统一 transaction。
新增私有 `persistTablesToChatMessageInTransaction_ACU(ctx, options)`。

```text
src/presentation/bootstrap/api-groups/table-crud-api.ts
```

CRUD mutation 整体进入 transaction。

```text
src/presentation/bootstrap/api-groups/sql-api.ts
```

raw SQL 写入整体进入 transaction，删除独立 raw SQL scope。

```text
src/service/chat/chat-service.ts
```

purge / clear / delete local data 进入 transaction。
```

## 实施顺序

1. 新增 `table-write-transaction.ts`，实现 maintenance lock / sheet mutation lock / isolation commit lock。
2. 为 V2 log entry 增加 `baseRevision / parentRevision / commitRevision / writeSet`，为 frame 增加 `headRevision`。
3. 新增 `resolveTableWriteTargetMessageIndex_ACU`，所有 persist 写入 log 前使用真实 index。
4. 新增事务私有 `workingData`，禁止写入口直接修改全局 `currentJsonTableData_ACU`。
5. 实现 commit lock 内的 latest frame 重新读取、seq 分配、rebase、冲突检测和 saveChat。
6. 把 `persistTablesToChatMessage_ACU` 改为事务提交能力，内部 no-lock persist 只能接收 ctx。
7. 改造 AI 填表：AI 响应收集在锁外，parse/apply/save 进入 transaction。
8. 改造 raw SQL：已知 targetSheetKeys 时拿对应 sheet locks；未知写入范围时拿 `sheet:*`；SQL mutation + export + persist 放入 transaction。
9. 改造前端 CRUD：mutation + save + refresh 调度进入 transaction，source=`manual_crud`。
10. 改造 saveCurrentDataForTable_ACU。
11. 改造 purgeOldLayerData_ACU / clearTableDataAtFloors_ACU / deleteLocalDataInChatCore_ACU，使用 maintenance exclusive lock。
12. 删除或私有化 `saveIndependentTableToChatHistoryWithinScopeLock_ACU` 和 `useScopeLock=false`。
13. 增加并发、rebase、冲突检测测试。
14. 全量测试、typecheck、build。

## 验收用例

### 锁 scope

1. `targetMessageIndex=-1` 和真实最新 AI index 不能产生不同 commit scope；它们最终必须进入同一个 isolation commit lock。
2. 两个不同 sheet 的 CRUD 可以并行 mutation，但必须串行 commit，且第二个提交不能覆盖第一个 log。
3. 两个同 sheet 的 CRUD 必须在 sheet mutation lock 上串行。
4. raw SQL 未声明 targetSheetKeys 时必须获取 `sheet:*`，与所有 sheet mutation 互斥。
5. AI apply/save 与 raw SQL 如果 writeSet 冲突必须串行 mutation；不冲突时可以并行 mutation，但必须串行 commit。
6. 不同 isolationKey 可以并行。
7. 不同 chatKey 可以并行。

### mutation 边界

1. CRUD 原生模式不得在锁外修改 `currentJsonTableData_ACU`。
2. SQLite raw SQL 不得在锁外执行写 SQL。
3. V2 beforeData 不得包含同事务 mutation 后的数据。
4. V2 afterData 必须包含本事务 mutation 后的数据。
5. source 必须正确：`auto_fill/group_fill/manual_crud/raw_sql_mutation/raw_sql_batch`。

### 恢复链

1. purge 删除旧楼层前必须先写 boundary checkpoint。
2. clear 删除 V2 frame 前必须预检 latest full checkpoint。
3. deleteLocalData 删除范围覆盖恢复链时必须先写 boundary checkpoint 或中止。
4. 删除后 replay 校验失败应暴露错误，不能静默吞掉。

### 防误用

1. 业务层不能直接调用底层 queue 构造 scope。
2. 没有 ctx 时不能调用 no-lock persist。
3. `useScopeLock=false` 不再作为公开参数存在。

## 最终原则

```text
锁不是按“谁在写哪个楼层”设计，而是按“谁在修改什么资源”设计。

sheet mutation lock 保护单表业务修改，让 A 表和 B 表可以并行计算。

isolation commit lock 保护共享 V2 log、seq、checkpoint 和 saveChat，禁止 A/B 表提交互相覆盖。

maintenance lock 保护恢复链结构变更，清理/删除/compaction 必须排斥普通写事务。

targetMessageIndex 是写入目标和日志元数据，不是并发隔离维度。
```
