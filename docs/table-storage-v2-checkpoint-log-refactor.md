# 表格持久层 V2 重构设计：全量 checkpoint + 顺序日志

## 结论

当前表格持久层需要在不破坏旧聊天的前提下，引入 V2 存储协议：

```text
V2: 全量 checkpoint + 按楼层/楼层内 seq 顺序追加的 mutation log
legacy-v1: 继续兼容 partial checkpoint + aggregate delta + modifiedKeys/updateGroupKeys
```

核心原则：

```text
1. V2 只作为新协议，不强制替换旧协议。
2. 读取和写入前必须先识别当前聊天、当前 isolationKey 的存储策略。
3. 识别到旧模式后，整个 isolationKey 退化使用旧模式。
4. 旧模式聊天不自动升级、不混写 V2 frame、不删除旧字段。
5. V2 checkpoint 只负责恢复基底，必须是当前隔离标签下完整数据库快照。
6. V2 mutation log 只负责记录每一次串行写入的顺序事件和数据 patch。
7. V2 调度状态只从 checkpoint scheduleSummary / log event 重建，不再从数据是否变化反推。
```

本重构不是一次破坏性迁移，而是一次“双协议兼容”改造：

```text
empty / new isolationKey -> 默认使用 V2。
v2 -> 使用 full checkpoint + ordered log。
legacy-v1 -> 保持旧 partial checkpoint / incrementalData 语义。
mixed -> 默认 legacy-v1 wins，记录 warning，不做隐式迁移。
```

旧聊天必须继续可读、可写、可清理、可调度。任何从 legacy-v1 到 V2 的升级，都必须通过后续显式迁移工具完成，不能在普通读写路径里隐式发生。

## 当前实现的问题

当前实现主要分布在：

```text
src/data/models/chat-message-data.ts
src/data/repositories/chat-message-data-repo.ts
src/service/runtime/helpers-data-merge.ts
src/service/table/table-service.ts
src/service/table/table-delta.ts
src/service/table/sql-table-service.ts
src/service/table/native-table-service-adapter.ts
src/service/table/update-orchestrator.ts
src/service/table/table-update-queue.ts
src/shared/table-storage-provider.ts
src/presentation/bootstrap/api-groups/table-crud-api.ts
src/presentation/bootstrap/api-groups/sql-api.ts
```

当前模型把以下职责混在了一起：

```text
数据恢复：independentData / incrementalData
数据变化：modifiedKeys
填表触发记录：updateGroupKeys / trackingSheetKeys
分组调度门禁：independentTableStates_ACU.lastUpdatedAiFloor
同楼层多次写入合并：反复展开旧 delta 再覆盖 incrementalData
```

这导致当前结构既不像可靠快照，也不像可靠日志。

### partial checkpoint 的问题

当前 `checkpoint` 实际只是：

```text
当前消息中 independentData 包含的部分 sheet 的完整快照
```

不是：

```text
当前隔离标签下完整数据库快照
```

这让读取逻辑必须按 sheet 查找最近基底，并正确截断旧 delta 链。当前 `mergeAllIndependentTables_ACU` 使用全局 `pendingDeltas`，与 partial checkpoint 模型不匹配。

### aggregate delta 的问题

当前 `incrementalData` 是一个“楼层最终状态相对某个 base 的合并差异”：

```ts
incrementalData: Record<sheetKey, TableIncrementalUpdate_ACU>
```

它不是操作日志。

引入前端 CRUD、raw SQL、AI 多分组填表后，同一 AI 楼层可能发生多次写入：

```text
seq 1: AI 填表 sheet_0，改变数据
seq 2: 前端 updateCell sheet_0，再次改变数据
seq 3: raw SQL batch sheet_1，改变数据
seq 4: AI 填表 sheet_0，成功但无变化
```

当前做法会把这些事件压扁成最终 `incrementalData`，丢失：

```text
写入顺序
每次写入边界
触发但无变化事件
失败/跳过事件
来源 source
前端更新接口的事务边界
raw SQL batch 的事务边界
```

### modifiedKeys / updateGroupKeys 的问题

当前 `modifiedKeys` 和 `updateGroupKeys` 被用来同时表达：

```text
哪些表发生数据变化
哪些表执行过填表动作
哪些表推进自动更新门禁
哪些表需要参与保存
```

这几个概念必须拆开。

真实业务只需要把调度事件和数据变化分开：

```text
filledSheetKeys: 本楼层成功执行过填表流程的表。触发但失败不算 filled。
patches: 本次实际数据变化。没有 patch 也可以有 filledSheetKeys，表示成功填表但无变化。
```

V2 目标模型下，删除楼层回退时数据应由 checkpoint + log 重放恢复；调度状态必须由 `filledSheetKeys` 重建，不能由数据变化推断。legacy-v1 继续保留现有 `modifiedKeys/updateGroupKeys` 推断语义。

## 新旧模式优缺点对比

### legacy-v1：partial checkpoint + aggregate delta

legacy-v1 是当前已经存在的模式，核心字段包括：

```text
independentData
incrementalData
modifiedKeys
updateGroupKeys
_acu_storage_mode = checkpoint | delta | legacy
_acu_storage_version = 1 或缺失
TavernDB_ACU_IndependentData
TavernDB_ACU_Data
TavernDB_ACU_SummaryData
```

说明：当前普通写入路径主要写 `_acu_storage_mode='checkpoint'` 或 `'delta'`；`'legacy'` 主要作为兼容识别值存在，未作为普通新写入模式。

优点：

```text
1. 兼容已有聊天记录，不需要迁移即可继续读取。
2. 已经被现有业务路径验证，短期风险低。
3. 对简单行级变化，incrementalData 体积较小。
4. 与现有 retainRecentLayers、clearTableDataAtFloors、deleteLocalDataInChatCore 等逻辑耦合较深，保持旧路径可以避免一次性改动过大。
5. modifiedKeys/updateGroupKeys 已被现有自动调度逻辑使用，旧模式下保留可减少调度回归风险。
```

缺点：

```text
1. checkpoint 实际是 partial checkpoint，不是完整数据库快照。
2. incrementalData 是楼层聚合 delta，不是操作日志，无法表达同楼层多次写入的真实顺序。
3. modifiedKeys/updateGroupKeys 同时表达数据变化、填表触发、调度门禁，语义混杂。
4. 同一楼层多次写入容易被压扁成最终状态，丢失事务边界。
5. 成功填表但无数据变化、失败/跳过事件难以准确表达。
6. 删除楼层、清理旧楼层时需要复杂的按 sheet 回溯和 orphaned sheet 兜底。
7. merge 逻辑依赖 first-write-wins、pendingDeltas、按 sheet 找 base，长期维护成本高。
```

适用场景：

```text
1. 已存在旧聊天。
2. 已存在旧 isolationKey 数据。
3. 需要最大限度保持当前行为稳定的场景。
4. 用户没有显式执行迁移工具之前的所有历史数据。
```

### V2：full checkpoint + ordered mutation log

V2 是新增协议，核心字段为：

```text
storageFrame.version = 2
storageFrame.checkpoint
storageFrame.logEntries
checkpoint.scheduleSummary
entry.filledSheetKeys
entry.changedSheetKeys
entry.patches
```

优点：

```text
1. 数据恢复模型简单：latest full checkpoint + ordered logs。
2. checkpoint 语义清晰，永远是完整数据库快照。
3. logEntries 保留同楼层内 seq 顺序，不压扁多次写入。
4. 能表达成功填表但无数据变化：filledSheetKeys 有值，patches 为空。
5. 能区分 filled 和 changed，调度状态不再依赖数据是否变化。
6. raw SQL batch、前端 CRUD、AI 填表可以拥有明确事务边界。
7. 删除楼层和 retainRecentLayers 清理可以通过 boundary checkpoint/compaction 保证恢复链。
8. 并发行为更容易验证：scope lock 内完成 beforeData -> mutation -> afterData -> append log -> save。
```

缺点：

```text
1. 实现成本高，需要新增 frame repo、replay、patch、persist、compaction 等模块。
2. full checkpoint 会带来额外存储体积，需要自适应 checkpoint 策略。
3. replay 和 compaction 需要额外测试，尤其是 retainRecentLayers 很小时。
4. 与旧模式混用风险高，因此必须明确 legacy-v1 wins，避免隐式混写。
5. 调度状态需要从 checkpoint scheduleSummary 和 log event 重建，对清理逻辑要求更高。
6. 如果没有显式迁移工具，旧聊天不能直接享受 V2 的完整语义。
```

适用场景：

```text
1. 新聊天。
2. 新 isolationKey。
3. 用户显式迁移后的聊天。
4. 需要可靠表达同楼层多次写入、raw SQL batch、前端 CRUD 事务边界的场景。
```

### 对比表

| 维度 | legacy-v1 | V2 |
|---|---|---|
| 兼容旧聊天 | 强 | 需要识别后退化或显式迁移 |
| checkpoint 语义 | partial checkpoint | full checkpoint |
| delta/log 语义 | 楼层聚合 delta | 顺序 mutation log |
| 同楼层多次写入 | 易被压扁 | seq 保序追加 |
| 成功但无变化事件 | 难表达 | filledSheetKeys 可表达 |
| 调度状态 | modifiedKeys/updateGroupKeys 推断 | filled/changed 明确重建 |
| 删除楼层恢复 | 复杂，依赖按 sheet 回溯 | checkpoint + log replay |
| 存储体积 | 简单场景较省 | 需要 checkpoint 策略控制 |
| 实现风险 | 低，已有逻辑 | 高，需要新增完整链路 |
| 推荐用途 | 旧数据兼容 | 新数据、新协议、显式迁移后数据 |

## 存储策略识别与退化规则

### 策略类型

新增统一策略识别函数：

```ts
export type TableStorageStrategy_ACU =
  | { mode: 'empty' }
  | { mode: 'legacy-v1'; reason: string }
  | { mode: 'v2' };
```

运行时所有读取、写入、清理、删除楼层、调度恢复，都必须先识别当前聊天当前 isolationKey 的策略。

```text
empty:
当前 isolationKey 没有任何历史表格数据。首次写入默认使用 V2。

legacy-v1:
当前 isolationKey 下识别到任何旧模式数据。读取和写入退化走旧模式。

v2:
当前 isolationKey 下只识别到合法 V2 storageFrame。读取和写入使用 V2。
```

### legacy-v1 判定条件

满足任一条件，即判定为 `legacy-v1`：

```text
1. TavernDB_ACU_IsolatedData[isolationKey] 存在，但不存在合法 storageFrame.version === 2。
2. tagData 中存在 independentData。
3. tagData 中存在 incrementalData。
4. tagData 中存在 modifiedKeys。
5. tagData 中存在 updateGroupKeys。
6. tagData._acu_storage_mode 为 checkpoint/delta/legacy。
7. tagData._acu_storage_version 缺失或等于 1。
8. 当前消息存在旧顶层字段，且隔离标识匹配：
   - TavernDB_ACU_IndependentData
   - TavernDB_ACU_Data
   - TavernDB_ACU_SummaryData
   - TavernDB_ACU_ModifiedKeys
   - TavernDB_ACU_UpdateGroupKeys
```

### V2 判定条件

只有满足以下条件时才判定为 `v2`：

```text
1. 当前 isolationKey 下存在至少一个合法 storageFrame.version === 2。
2. 当前 isolationKey 下没有 legacy-v1 字段。
3. 匹配当前 isolationKey 的旧顶层字段不存在。
```

### mixed 状态处理

如果同一个 isolationKey 下同时存在 legacy-v1 数据和 V2 frame：

```text
默认判定为 legacy-v1。
记录 warning。
不自动删除 V2 frame。
不自动删除旧字段。
不做隐式迁移。
不混写新 V2 entry。
```

原因：

```text
旧模式数据可能是完整恢复链的一部分。
强行从 V2 checkpoint 开始读取，可能丢失 V2 checkpoint 之前的旧楼层贡献。
```

因此混合状态下必须采用：

```text
legacy wins
```

### 显式迁移工具

legacy-v1 到 V2 的升级不属于普通读写路径。

后续如果需要迁移工具，必须满足：

```text
1. 用户显式触发。
2. 迁移前完整 replay legacy-v1 当前视图。
3. 在迁移目标楼层写入 full checkpoint。
4. 可选清理旧字段。
5. 迁移前后数据视图一致。
6. 迁移前后调度状态在可表达范围内一致。
7. 迁移失败不得破坏原始 legacy-v1 数据。
```

## 目标模型

本节描述待新增的 V2 目标结构。当前源码尚未实现 `storageFrame`、`TableStorageFrameV2_ACU`、`resolveTableStorageStrategy_ACU`、`loadTableStateFromFramesV2_ACU`、`persistTableMutationLogV2_ACU` 等类型和入口；实施时应按前文策略识别规则先保留 legacy-v1 路径，再接入 V2。

### 存储帧

每条 AI 消息在当前隔离标签下保存一个 V2 frame：

```ts
export interface TableStorageFrameV2_ACU {
  version: 2;
  checkpoint?: TableCheckpointV2_ACU;
  logEntries: TableMutationLogEntryV2_ACU[];
}
```

规则：

```text
checkpoint 可选，但一旦存在必须是完整数据库快照。
logEntries 是本楼层内按 seq 严格递增的追加日志。
同一楼层多次写入不合并、不覆盖旧 entry，只 append 新 entry。
```

### 全量 checkpoint

```ts
export interface TableCheckpointV2_ACU {
  kind: 'full';
  createdAt: number;
  reason: 'init' | 'periodic' | 'manual' | 'schema_change' | 'compaction' | 'import';
  data: TableDataObject_ACU;
}
```

约束：

```text
data 必须包含当前隔离标签下完整数据库视图，包括 mate 和所有有效 sheet_*。
不得存 partial checkpoint。
不得用 checkpoint 表达“本次只更新了某些表”。
```

### 顺序 mutation log

```ts
export interface TableMutationLogEntryV2_ACU {
  seq: number;
  entryId: string;
  createdAt: number;
  source: TableMutationSourceV2_ACU;
  targetMessageIndex: number;
  aiFloor: number;

  filledSheetKeys: string[];
  changedSheetKeys: string[];

  groupKeys: string[];
  requestId?: string;
  batchId?: string;
  error?: string;

  patches: TablePatchV2_ACU[];
}
```

```ts
export type TableMutationSourceV2_ACU =
  | 'auto_fill'
  | 'manual_fill'
  | 'group_fill'
  | 'manual_crud'
  | 'raw_sql_mutation'
  | 'raw_sql_batch'
  | 'import'
  | 'merge_summary'
  | 'template_assistant'
  | 'system';
```

语义：

```text
filledSheetKeys 表示本楼层成功执行过填表流程的表，用于推进自动更新门禁。
changedSheetKeys 表示本次 patch 实际改变的表，用于数据/UI/刷新判断。
填表失败不进入 filledSheetKeys；从调度角度看，失败等价于没填过。
成功填表但无数据变化时：filledSheetKeys 有值，changedSheetKeys 为空，patches 为空。
patches 是本次成功写入的数据变更，不压扁同楼层历史。
```

### Patch 类型

```ts
export type TablePatchV2_ACU =
  | TableRowUpsertPatchV2_ACU
  | TableRowDeletePatchV2_ACU
  | TableSheetReplacePatchV2_ACU
  | TableMetaPatchV2_ACU;
```

```ts
export interface TableRowUpsertPatchV2_ACU {
  kind: 'row_upsert';
  sheetKey: string;
  rowId: string;
  cells: (string | null)[];
}

export interface TableRowDeletePatchV2_ACU {
  kind: 'row_delete';
  sheetKey: string;
  rowId: string;
}

export interface TableSheetReplacePatchV2_ACU {
  kind: 'sheet_replace';
  sheetKey: string;
  sheet: Sheet_ACU;
  reason: 'schema_change' | 'unstable_row_id' | 'raw_sql_export' | 'import' | 'fallback';
}

export interface TableMetaPatchV2_ACU {
  kind: 'meta_update';
  sheetKey: string;
  meta: Partial<Pick<Sheet_ACU, 'name' | 'orderNo' | 'updateConfig' | 'exportConfig' | 'sourceData'>>;
}
```

规则：

```text
能安全表达行为级 patch 时使用 row_upsert / row_delete / meta_update。
无法安全表达时使用 sheet_replace。
schema 变更、row_id 不稳定、raw SQL 难以反推出行级 diff 时直接 sheet_replace。
sheet_replace 是单次日志 entry 的 patch，不是 checkpoint。
```

## 新字段落点

V2 新结构落在 `TavernDB_ACU_IsolatedData[isolationKey]` 下：

```ts
export interface IsolationTagDataV2_ACU {
  storageFrame: TableStorageFrameV2_ACU;
  summaryVectorIndexState?: ChatSummaryVectorIndexState_ACU | null;
  summaryVectorIndexManifest?: ChatSummaryVectorIndexManifest_ACU | null;
  _acu_storage_version: 2;
}
```

legacy-v1 字段继续保留：

```text
independentData
incrementalData
modifiedKeys
updateGroupKeys
_acu_storage_mode
_acu_storage_version = 1 或缺失
TavernDB_ACU_IndependentData
TavernDB_ACU_Data
TavernDB_ACU_SummaryData
TavernDB_ACU_ModifiedKeys
TavernDB_ACU_UpdateGroupKeys
```

约束：

```text
1. V2 模式下，运行时读取 storageFrame 恢复数据。
2. legacy-v1 模式下，运行时继续读取旧字段恢复数据。
3. 不在普通读写路径中把 legacy-v1 自动转换为 V2。
4. 不在 legacy-v1 聊天中混写 storageFrame。
5. 不删除旧字段类型定义；最多标记为 legacy/deprecated。
6. 只有显式迁移工具可以把旧字段转换为 V2 frame。
```

## 读取流程

`mergeAllIndependentTables_ACU` 保留为统一读取门面，不直接删除旧逻辑。

新读取流程：

```text
1. 获取当前 chat 和 isolationKey。
2. 调用 resolveTableStorageStrategy_ACU(chat, isolationKey)。
3. 如果 strategy.mode === 'legacy-v1'：
   - 调用 mergeAllIndependentTablesLegacyV1_ACU。
   - 保持 partial checkpoint / incrementalData / modifiedKeys / updateGroupKeys 语义。
4. 如果 strategy.mode === 'v2'：
   - 调用 loadTableStateFromFramesV2_ACU。
   - 使用 latest full checkpoint + ordered logs 恢复。
5. 如果 strategy.mode === 'empty'：
   - 返回指导表/模板空壳，或 null，由现有初始化流程处理。
```

伪代码：

```ts
export async function mergeAllIndependentTables_ACU(): Promise<TableDataObject_ACU | null> {
  const chat = getChatArray_ACU();
  if (!chat || chat.length === 0) return null;

  const isolationKey = getCurrentIsolationKey_ACU();
  const strategy = resolveTableStorageStrategy_ACU(chat, isolationKey);

  if (strategy.mode === 'legacy-v1') {
    return mergeAllIndependentTablesLegacyV1_ACU();
  }

  if (strategy.mode === 'v2') {
    return loadTableStateFromFramesV2_ACU();
  }

  return null;
}
```

### legacy-v1 读取

legacy-v1 读取保留现有语义：

```text
1. 逆序扫描 AI 消息。
2. 读取 TavernDB_ACU_IsolatedData[isolationKey]。
3. 识别 checkpoint / delta / legacy。
4. 对 checkpoint/legacy 使用 first-write-wins per sheet。
5. 逆序扫描期间把 delta 楼层放入全局 pendingDeltas。
6. 扫描结束后将 pendingDeltas reverse 成正序，统一叠加到已找到的 base 表上。
7. 当前实现不是按 sheet 精确查找 base 后截断 delta 链，这也是 V2 要修复的问题之一。
8. 兼容旧顶层 TavernDB_ACU_IndependentData / Data / SummaryData。
9. 用 modifiedKeys/updateGroupKeys 恢复 lastUpdatedAiFloor。
```

### V2 读取

V2 读取使用新算法：

```text
1. 从最新 AI 消息向旧消息查找第一个 full checkpoint。
2. 如果找不到 checkpoint：返回指导表/模板空壳，或 null。
3. 以 checkpoint.data 作为 state。
4. 先恢复 checkpoint.scheduleSummary / checkpoint.event。
5. 从 checkpoint 所在消息之后，按消息顺序从旧到新遍历。
6. 对每条消息，读取 storageFrame.logEntries，按 seq 升序排序。
7. 逐 entry 应用 patches 到 state。
8. 用 entry.filledSheetKeys / changedSheetKeys 重建调度状态。
9. 返回 state。
```

V2 不存在 partial checkpoint，因此 V2 replay 不需要：

```text
foundSheets
pendingDeltas
first-write-wins per sheet
旧 delta 截断
按 sheet 查找 base
```

## 写入流程

`persistTablesToChatMessage_ACU` 保留为统一写入门面，不直接删除旧逻辑。

写入前必须先识别 storage strategy：

```text
legacy-v1 -> persistTablesToChatMessageLegacyV1_ACU
v2        -> persistTableMutationLogV2_ACU
empty     -> 默认初始化 V2
```

原则：

```text
1. 旧模式聊天不自动升级。
2. 旧模式聊天不混写 V2 frame。
3. V2 聊天不再把旧字段作为核心数据写入。
4. empty 场景首次写入默认使用 V2。
5. 显式迁移工具是独立能力，不进入普通保存路径。
```

伪代码：

```ts
export async function persistTablesToChatMessage_ACU(
  options: TableChatPersistOptions_ACU = {},
): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
  const chat = getChatArray_ACU();
  const isolationKey = getCurrentIsolationKey_ACU();
  const strategy = resolveTableStorageStrategy_ACU(chat, isolationKey);

  if (strategy.mode === 'legacy-v1') {
    return persistTablesToChatMessageLegacyV1_ACU(options);
  }

  return persistTableMutationLogV2_ACU(
    mapTableChatPersistOptionsToV2Mutation_ACU(options),
  );
}
```

### legacy-v1 写入

legacy-v1 写入保留现有逻辑：

```text
1. 定位目标 AI 消息。
2. 读取或初始化 TavernDB_ACU_IsolatedData[isolationKey]。
3. 根据上一 AI 楼层的 IsolatedData base 尝试 buildTableDelta_ACU。
4. 可 delta 时写 incrementalData，清空 independentData，并标记 _acu_storage_mode='delta'。
5. 不可 delta 或无 base 时写 independentData，并标记 _acu_storage_mode='checkpoint'。
6. 按 trackAsUpdate/trackingSheetKeys/updateGroupKeys 写 modifiedKeys/updateGroupKeys。
7. 写 TavernDB_ACU_Identity。
8. 不主动同步旧顶层 TavernDB_ACU_IndependentData/Data/SummaryData；旧顶层字段主要用于读取兼容和清理。
9. saveChatToHost。
```

### V2 写入入口

```ts
export interface PersistTableMutationV2Options_ACU {
  targetMessageIndex?: number;
  source: TableMutationSourceV2_ACU;
  beforeData: TableDataObject_ACU;
  afterData: TableDataObject_ACU;
  filledSheetKeys: string[];
  candidateChangedSheetKeys?: string[];
  groupKeys?: string[];
  requestId?: string;
  batchId?: string;
  error?: string;
  forceCheckpoint?: boolean;
  checkpointReason?: TableCheckpointV2_ACU['reason'];
}

export async function persistTableMutationLogV2_ACU(
  options: PersistTableMutationV2Options_ACU,
): Promise<{ saved: boolean; messageIndex?: number; entry?: TableMutationLogEntryV2_ACU; error?: string }>;
```

V2 写入流程：

```text
1. 调用方必须在进入前准备 beforeData 和 afterData。
2. 使用 table update scope lock 包住“计算 patch + append log + saveChatToHost”。
3. 定位目标 AI 消息。
4. 读取或初始化该消息当前 isolationKey 的 storageFrame。
5. 计算本次 patches。
6. 生成 seq = max(existing seq) + 1。
7. append entry。
8. 如满足 checkpoint 策略，写入 full checkpoint。
9. 保存聊天。
```

### Patch 生成

替换 `buildTableDelta_ACU` 为更明确的 patch 生成器：

```ts
export function buildTablePatchesV2_ACU(
  beforeData: TableDataObject_ACU,
  afterData: TableDataObject_ACU,
  candidateSheetKeys: string[] | null,
): { patches: TablePatchV2_ACU[]; changedSheetKeys: string[] };
```

规则：

```text
candidateSheetKeys 为本次可能影响的表。
如果为空，则比较所有 sheet。
表不存在到存在：sheet_replace。
表存在到不存在：sheet_replace 或 sheet_delete（如引入该 patch）。
header 内容或列顺序变化：sheet_replace。
row_id 缺失/重复：sheet_replace。
元数据变化：meta_update。
行新增/修改：row_upsert。
行删除：row_delete。
```

与旧 `buildTableDelta_ACU` 的区别：

```text
旧：生成楼层聚合 delta，可被后续写入覆盖。
新：生成单次写入 patch，只 append，不覆盖。
```

### checkpoint 策略

checkpoint 必须全量，但不需要每次写入都生成。

建议策略：

```text
首次写入当前隔离标签：checkpoint full。
模板结构变化：checkpoint full。
导入完整数据：checkpoint full。
距离最近 checkpoint 后 log entry 数超过 N：checkpoint full。
checkpoint 后累计 patch 字节超过阈值：checkpoint full。
手动压缩：checkpoint full。
```

额外硬约束：

```text
保留窗口内必须始终存在至少一个可恢复当前状态的 full checkpoint。
任何会删除旧 frame 的操作，都必须先在删除边界内生成 full checkpoint。
普通写入 checkpoint cadence 不能单独保证恢复能力；retainRecentLayers 清理必须执行 boundary compaction。
```

不要把普通 checkpoint 周期简单压缩成：

```text
effectiveCheckpointInterval <= max(1, retainRecentLayers - 1)
```

否则当用户设置 `retainRecentLayers=1` 时，就会退化成每个数据楼层都主动 full checkpoint。正确做法是区分两种 checkpoint：

```text
普通 checkpoint：按 log 数量/字节数/schema/import 等策略生成，用于降低正常恢复成本。
boundary checkpoint：仅在 purgeOldLayerData_ACU 即将删除旧 frame 前生成，用于保证保留窗口内还有恢复锚点。
```

如果用户设置的保留层数小于普通 checkpoint 周期，不要求每次普通写入都 full checkpoint；但一旦清理动作会删除最近 full checkpoint，清理流程必须先把当前完整状态压缩进边界保留楼层。若 `retainRecentLayers=1` 且每个新 AI 数据楼层都会触发清理，那么边界保留楼层最终会频繁成为 full checkpoint。这不是普通 checkpoint 策略导致的，而是“只保留 1 层数据”配置本身要求最后保留下来的那一层必须自包含。

可选产品策略：

```text
策略 A：允许 retainRecentLayers 很小，接受清理时频繁 boundary checkpoint。
策略 B：限制 retainRecentLayers 的最小值，例如必须 >= 2 或 >= 推荐 checkpoint window。
策略 C：把 full checkpoint 放到不受 retainRecentLayers 清理的数据锚点；当前设计不采用，因为会把数据恢复锚点从 AI 数据楼层挪到全局字段，增加回退语义复杂度。
```

本设计默认采用策略 A：尊重用户保留层数设置，但把 full checkpoint 成本转移到清理阶段，而不是每次普通写入阶段。

普通 checkpoint 阈值不应使用单一固定值。`maxEntriesAfterCheckpoint = 50` / `maxPatchBytesAfterCheckpoint = 256 KB` 只能作为粗略上限，不适合作为最终策略，因为：

```text
小表场景：50 条 log 的 replay 成本很低，过早 checkpoint 会浪费空间。
大表场景：少量 sheet_replace patch 可能已经接近完整库大小，继续攒 log 没意义。
raw SQL 场景：patch 常退化为 sheet_replace，需要按字节和表数量判断。
retainRecentLayers 很小：恢复锚点由 boundary checkpoint 保证，不应强迫普通写入每层 checkpoint。
```

推荐采用自适应阈值：

```text
entryCountSinceCheckpoint >= 50
或 cumulativePatchBytesSinceCheckpoint >= min(256 KB, fullCheckpointBytes * 0.35)
或 cumulativePatchOpsSinceCheckpoint >= 2000
或 latestPatchBytes >= fullCheckpointBytes * 0.5
```

其中：

```text
entryCountSinceCheckpoint 控制日志链长度。
cumulativePatchBytesSinceCheckpoint 控制聊天 JSON 体积和 replay 输入体积。
cumulativePatchOpsSinceCheckpoint 控制 row patch 回放成本。
latestPatchBytes >= fullCheckpointBytes * 0.5 用于 raw SQL / sheet_replace 场景，避免存一个接近全量的 patch 后又继续保留旧 checkpoint。
```

默认建议：

```text
maxEntriesAfterCheckpoint = 50
maxPatchBytesAfterCheckpoint = min(256 KB, fullCheckpointBytes * 0.35)
maxPatchOpsAfterCheckpoint = 2000
singlePatchCheckpointRatio = 0.5
```

这些值必须作为可调内部常量，不应一开始暴露给普通用户。后续可通过日志统计恢复耗时、checkpoint 大小和 patch 链长度再调整。

checkpoint 写入可以和本次 log entry 同帧共存：

```text
如果先生成 checkpoint，再记录本次 entry：checkpoint.data 是 before 或 after 必须明确。
推荐 checkpoint.data 始终是 append entry 后的 afterData，且同帧 logEntries 清空或仅保留 checkpoint 后的新 entry。
```

推荐规则：

```text
普通写入：append log entry。
触发 compaction：写 full checkpoint = afterData，并清空本帧旧 logEntries，然后 append 当前 entry 仅当当前 entry 不包含在 checkpoint 中。
更简单：compaction checkpoint 包含当前 afterData，本次 entry 不再追加，只记录 checkpointEvent。
```

为避免双重应用，设计为：

```ts
checkpoint.data = afterData;
logEntries = [];
checkpoint.reason = 'compaction' | ...;
checkpointEvent = optional metadata only, not replayed as data patch.
```

如果 compaction/checkpoint 本身需要推进调度门禁，则 checkpoint 结构需要携带 event：

```ts
export interface TableCheckpointV2_ACU {
  kind: 'full';
  createdAt: number;
  reason: ...;
  data: TableDataObject_ACU;
  event?: TableMutationEventV2_ACU;
}
```

读取 checkpoint 时也要用 `checkpoint.event.filledSheetKeys` 更新调度状态。

## 调度状态恢复

调度状态恢复按 storage strategy 分支。

### legacy-v1

legacy-v1 继续使用旧调度语义：

```text
modifiedKeys
updateGroupKeys
lastUpdatedAiFloor
```

恢复规则保持现状：

```text
1. 如果 updateGroupKeys 和 modifiedKeys 都有值，以 updateGroupKeys 表示本轮成功更新组。
2. 如果只有 modifiedKeys，以 modifiedKeys 表示本楼层更新过的表。
3. 如果两者都没有但存在旧完整快照，则按旧逻辑视为可更新来源。
```

legacy-v1 下不强行引入 filled/changed 概念，避免改变旧聊天自动填表冷却行为。

### V2

V2 下废弃从 `modifiedKeys/updateGroupKeys` 推断 `lastUpdatedAiFloor`，新增运行时状态：

```ts
interface IndependentTableRuntimeStateV2_ACU {
  lastFilledAiFloor?: number;
  lastChangedAiFloor?: number;
}
```

读取时从 checkpoint scheduleSummary、checkpoint event 和 log entries 重建：

```ts
for (const sheetKey of event.filledSheetKeys) {
  state[sheetKey].lastFilledAiFloor = aiFloor;
}
for (const sheetKey of event.changedSheetKeys) {
  state[sheetKey].lastChangedAiFloor = aiFloor;
}
```

自动更新冷却默认使用：

```text
lastFilledAiFloor
```

不是：

```text
lastChangedAiFloor
```

原因：成功执行过填表流程的表应推进冷却；触发但失败等价于没填过，不推进冷却。

## 并发模型

保留 `table-update-queue.ts` 的 scope lock 思路，但锁的覆盖范围必须统一为：

```text
读取 beforeData
执行 mutation
得到 afterData
生成 patch
append log / checkpoint
saveChatToHost
刷新 currentJsonTableData_ACU
```

不得只锁保存阶段。

scope key：

```ts
buildTableUpdateApplyScopeKey_ACU({
  chatKey: currentChatFileIdentifier_ACU,
  isolationKey: getCurrentIsolationKey_ACU(),
  targetMessageIndex,
})
```

同一 scope 下严格串行，seq 由当前消息已有 logEntries 决定。

## SQLite 模式改造

当前 `SqlTableService` 职责：

```text
loadFromChat: mergeAllIndependentTables_ACU -> SQLite
applyEdits: SQL batch -> engine.runBatch -> _syncToJson
executeMutation: single SQL -> engine.run -> _syncToJson
saveToChat: exportToTableData -> saveIndependentTableToChatHistory_ACU
```

双协议改造：

```text
loadFromChat 继续调用统一读取门面 mergeAllIndependentTables_ACU，由门面按策略分支。
saveToChat 继续调用统一写入门面 persistTablesToChatMessage_ACU，由门面按策略分支。
legacy-v1 下保持 partial save / incrementalData 行为。
V2 下由 executeMutation/executeSqlBatch 在锁内捕获 beforeData/afterData 并写 log entry。
SqlTableService 只负责运行时 SQLite 状态，不直接决定 legacy-v1 或 V2 frame 结构。
```

raw SQL 写入流程仅描述 V2 分支；legacy-v1 分支继续通过统一写入门面落到现有 `saveIndependentTableToChatHistory_ACU` / `persistTablesToChatMessage_ACU` 行为。

```text
1. lock。
2. beforeData = provider.getCurrentData() 或 SQLite export。
3. 执行 SQL transaction。
4. afterData = SQLite export。
5. build patches，raw SQL 不可靠时对 targetSheetKeys 使用 sheet_replace。
6. persistTableMutationLogV2_ACU(source='raw_sql_batch')。
7. refresh/notify。
```

raw SQL API 必须要求或强烈校验：

```text
targetSheetKeys
```

如果无法确定目标表，允许保存但必须使用：

```text
changedSheetKeys = all changed sheets by full diff
patches = sheet_replace for changed sheets
source = raw_sql_batch
```

## AI 填表改造

当前 `executeCardUpdateCore_ACU` 和 `applyUnifiedGroupFillResponses_ACU` 在解析后调用旧保存入口。

以下流程仅适用于 strategy.mode === 'v2'；legacy-v1 继续调用统一写入门面并落到旧保存逻辑。

V2 流程：

```text
1. collect AI response。
2. 进入 scope lock。
3. beforeData = 当前完整数据。
4. 应用 AI DSL/SQL 到 workingData 或 SQLite。
5. afterData = 应用后的完整数据。
6. filledSheetKeys = targetSheetKeys 或 group.sheetKeys，但仅在填表流程成功时写入。
7. changedSheetKeys = patch 生成结果。
8. append log entry source='auto_fill'/'group_fill'。
9. 刷新世界书和向量索引。
```

AI 返回成功但没有数据变化：

```text
patches = []
filledSheetKeys = targetSheetKeys
changedSheetKeys = []
```

AI 调用失败不记录 filled 事件：

```text
失败等价于没填过。
不 append 调度 entry。
如需错误诊断，走日志系统，不进入表持久层调度语义。
```

## 前端 CRUD API 改造

当前 `table-crud-api.ts` 直接修改 JSON 或 SQLite 后保存。

以下流程仅适用于 strategy.mode === 'v2'；legacy-v1 继续调用统一写入门面并落到旧保存逻辑。

V2 流程：

```text
1. lock。
2. beforeData。
3. 执行 CRUD mutation。
4. afterData。
5. append source='manual_crud' log entry。
6. filledSheetKeys 默认 []，前端 CRUD 不表示“填表成功”。
7. changedSheetKeys = [target sheet] 或实际 diff。
```

前端 CRUD 不应默认推进 AI 自动填表冷却，除非明确需要。

## import / clear / delete floors 改造

这些操作必须先解析 storage strategy。

### legacy-v1

legacy-v1 继续使用现有旧逻辑：

```text
1. partial checkpoint / incrementalData 的保留策略不改变。
2. orphaned sheet 搬运、旧字段清理逻辑保留。
3. 调度状态仍从 modifiedKeys/updateGroupKeys 恢复。
4. 清理或删除楼层后继续调用旧 merge 逻辑校验视图。
```

### V2

V2 才使用 full checkpoint + ordered log 的 import、clear、delete floors 语义。

导入完整数据库：

```text
写 full checkpoint reason='import'。
logEntries=[]。
event.changedSheetKeys=全部导入表。
event.filledSheetKeys=[]，导入不表示“填表成功”。
```

清空数据：

```text
可写 full checkpoint 空状态，reason='manual'。
或 append sheet_replace 到空表。
如果是全库清空，推荐 full checkpoint。
```

删除楼层回退：

```text
删除前必须预检删除范围是否覆盖当前恢复链依赖的 latest full checkpoint。
如果会覆盖 latest full checkpoint，必须先在删除范围之外、仍会保留的安全楼层写入 boundary full checkpoint。
boundary checkpoint 写入成功后才允许删除旧 frame。
boundary checkpoint 写入失败必须中止删除，禁止先删后补。
删除后只允许做 replay 校验，用于发现异常；删除后校验不能作为保护恢复链的主机制。
```

## 与现有源码约束的冲突清单

以下冲突只适用于 strategy.mode === 'v2' 的路径。strategy.mode === 'legacy-v1' 时继续使用现有旧逻辑，不把 V2 compaction、V2 replay 或 V2 调度摘要强加到旧聊天上。

V2 模型必须正面处理现有源码里的保留层数、清楼层、自动调度、模板指导表和 SQLite 延迟建表行为。以下冲突如果不解决，V2 会在真实运行时断链。

### retainRecentLayers 会删除 checkpoint

现有清理入口：

```text
src/service/chat/chat-service.ts: purgeOldLayerData_ACU
```

当前逻辑：

```text
settings_ACU.retainRecentLayers > 0 时，只保留最近 N 条含本地数据的消息。
更早消息会删除 TavernDB_ACU_Data / SummaryData / IndependentData / IsolatedData / Identity 等字段。
清理前会把 orphaned sheet 搬到边界保留楼层，作为 partial checkpoint 兜底。
```

这与 V2 的 full checkpoint + log replay 有硬冲突：

```text
如果最近 full checkpoint 位于 indicesToPurge 内，清理后 checkpoint 消失。
保留区里的 logEntries 没有 checkpoint base，恢复链断裂。
```

因此 V2 下 `purgeOldLayerData_ACU` 不能继续使用“搬运 orphaned sheet”的兜底策略，必须改成：

```text
1. 在删除旧楼层前，对每个 isolationKey 用完整 V2 replay 计算 cutoff 前后的当前完整数据库状态。
2. 在边界保留楼层 anchorIndex 写入 full checkpoint，checkpoint.data 必须是清理前重放得到的完整状态。
3. 该 checkpoint 的 reason='compaction'。
4. checkpoint.scheduleSummary 必须汇总被清理区间中仍需保留的调度状态，至少保留每张表在清理边界前的 lastFilled/lastChanged 语义。
5. 清理旧楼层的 V2 frames。
6. 清理后读取应从 anchorIndex 的 full checkpoint 开始，继续重放保留区日志。
```

也就是说，保留层数清理本质上是一次 compaction：

```text
old checkpoint + old logs -> boundary full checkpoint
```

不是字段删除。

约束：

```text
retainRecentLayers 不得小于 checkpoint 所需恢复跨度，因为清理时必须主动把恢复基底前移到保留窗口内。
如果 anchorIndex 无效或写 checkpoint 失败，必须中止清理，不允许继续删除旧 frames。
```

验收：

```text
retainRecentLayers=1 时，清理后最新保留数据消息必须包含 full checkpoint。
清理前后 loadTableStateFromFramesV2_ACU 的数据视图一致。
清理前后 lastFilledAiFloor / lastChangedAiFloor 在可表达范围内一致；被清理楼层的具体历史 seq 可丢弃，但压缩后的调度状态不能丢。
```

### chat[0] 指导表保护不等于数据 checkpoint 保护

现有 `purgeOldLayerData_ACU` 会保护 chat[0] 的 `TavernDB_ACU_InternalSheetGuide`。

V2 不能依赖 chat[0] 作为数据恢复锚点，因为指导表只表达模板/表头/seedRows，不表达当前聊天数据。

规则：

```text
InternalSheetGuide 继续只作为结构指导。
full checkpoint 必须写在 AI 数据楼层 frame 中。
清理保留层数时必须保证保留窗口内存在 full checkpoint。
```

### clearTableDataAtFloors 不能只删除字段

现有入口：

```text
src/service/chat/chat-service.ts: clearTableDataAtFloors_ACU
```

当前行为会直接删除目标楼层的当前隔离标签表格数据或指定 sheet 数据。

V2 下需要区分两种操作：

```text
手动重填前清空目标楼层：必须把“清空旧 frame + 写入新的 log/checkpoint”放在同一临界区内；如果后续写入失败，不能留下已破坏恢复链的中间状态。
用户显式清空历史楼层数据：删除前必须预检删除范围是否覆盖 latest full checkpoint；如果会覆盖，必须先生成删除范围之外的 boundary checkpoint，成功后才允许删除。
```

禁止行为：

```text
先删除 frame，再检查是否移除了 latest full checkpoint。
删除会覆盖 latest full checkpoint 时，未先生成可恢复的 boundary checkpoint 就继续删除。
只删除某些 sheet 的 patch，因为 V2 checkpoint 是全量，log 是顺序事件，不能做 partial field surgery。
```

### deleteLocalDataInChatCore 会破坏 V2 链

现有入口：

```text
src/service/chat/chat-service.ts: deleteLocalDataInChatCore_ACU
```

该功能按 AI 楼层范围删除本地数据字段。V2 下必须改为：

```text
删除前先计算待删除范围和保留范围。
删除前预检待删除范围是否包含 latest full checkpoint，或是否截断 latest full checkpoint 之后的必要 logs。
如果删除范围会破坏恢复链，必须先在保留范围内生成 boundary full checkpoint；如果没有可写入的安全保留楼层，则必须中止删除并提示用户。
boundary checkpoint 写入成功后才允许删除范围内 frames。
删除后只做 replay 校验；校验失败只能作为异常处理，不能替代删除前保护。
```

### 自动调度依赖 lastTrackedUpdateAiFloor

现有调度入口：

```text
src/service/table/update-scheduler.ts: buildAutoUpdatePlan_ACU
src/service/table/table-history.ts: resolveTableHistoryStateFromChat_ACU
```

当前调度使用：

```text
history.lastTrackedUpdateAiFloor
```

V2 下必须将其定义为：

```text
lastFilledAiFloor
```

并从 V2 checkpoint event + log entry event 重建。

冲突点：

```text
如果 retainRecentLayers 清理掉旧日志，但 boundary checkpoint 没有携带压缩后的 lastFilled 状态，自动调度会误认为很多表从未成功填表，导致立即重复触发。
```

因此 checkpoint event 不能只记录本次 checkpoint 发生时的事件，还要能携带 compaction 后的调度摘要。

建议结构：

```ts
export interface TableCheckpointV2_ACU {
  kind: 'full';
  createdAt: number;
  reason: ...;
  data: TableDataObject_ACU;
  scheduleSummary?: Record<string, {
    lastFilledAiFloor?: number;
    lastChangedAiFloor?: number;
  }>;
  event?: TableMutationEventV2_ACU;
}
```

读取 checkpoint 时先恢复 `scheduleSummary`，再重放 checkpoint 后 logs。

### skipFloors 和 retainRecentLayers 的边界

自动更新中 `skipFloors` 会忽略最近 N 个 AI 楼层；`retainRecentLayers` 会删除旧本地数据。

V2 必须保证：

```text
retainRecentLayers 清理不改变 totalAiMessages。
调度计算仍以聊天 AI 消息数量为准。
lastFilledAiFloor 来自 scheduleSummary/log，而不是是否存在数据 frame。
```

如果用户把 `retainRecentLayers` 设置得很小，系统仍应通过 boundary checkpoint + scheduleSummary 保持调度可计算，而不是要求保留所有历史 logs。

### SQLite 延迟建表与 full checkpoint

当前 `SqlTableService.loadFromChat` 在只有模板空壳/基底状态时不建表，避免新开卡提前锁定表结构。

V2 不能因为 full checkpoint 而破坏这个行为。

规则：

```text
模板空壳/指导表 fallback 不是 checkpoint。
只有真实写入后才生成 full checkpoint。
full checkpoint 中若只有表头且标记为 base/greeting state，SqlTableService 仍应按现有规则不提前建表。
```

### 世界书和向量索引引用清理

现有清理会删除向量索引 manifest 引用，世界书刷新依赖当前重建后的表数据。

V2 下：

```text
表格 frame compaction 不应删除仍被保留 checkpoint/log 引用的外置向量文件。
如果 full checkpoint 包含 summary/outlines 当前状态，向量索引 manifest 需要有独立的 checkpoint/manifest 保留策略，不能跟随旧楼层删除误删。
```

这部分可参考 `summary-vector-index-storage-service.ts` 中“不再按 retention 删除历史快照”的处理思路。

## 模块拆分建议

新增：

```text
src/service/table/storage-strategy-resolver.ts
src/service/table/storage-frame-v2-types.ts
src/service/table/storage-frame-v2-repo.ts
src/service/table/storage-frame-v2-replay.ts
src/service/table/storage-frame-v2-patch.ts
src/service/table/storage-frame-v2-persist.ts
src/service/table/storage-frame-v2-compaction.ts
```

职责：

```text
storage-strategy-resolver.ts: 识别 empty / legacy-v1 / v2 / mixed，并提供 reason/warning。
storage-frame-v2-types.ts: V2 类型。
storage-frame-v2-repo.ts: 从 message 读写 frame，不含业务逻辑。
storage-frame-v2-replay.ts: checkpoint + log 重放。
storage-frame-v2-patch.ts: before/after -> patches。
storage-frame-v2-persist.ts: append log / full checkpoint 持久化入口。
storage-frame-v2-compaction.ts: checkpoint 策略和压缩。
```

重构后旧文件变化：

```text
table-delta.ts: 保留为 legacy-v1 delta builder，或在不改变 API 的前提下标记 legacy。
table-service.ts: 将当前保存逻辑抽为 persistTablesToChatMessageLegacyV1_ACU；原 persistTablesToChatMessage_ACU 保留为统一门面。
helpers-data-merge.ts: 将当前合并逻辑抽为 mergeAllIndependentTablesLegacyV1_ACU；原 mergeAllIndependentTables_ACU 保留为统一门面。
chat-message-data.ts: 保留旧存储类型并标记 legacy/deprecated，新增 V2 frame 类型。
chat-message-data-repo.ts: 保留 legacy 读写能力，新增 frame get/set。
sql-table-service.ts: 调统一门面，不直接决定写 legacy-v1 还是 V2。
native-table-service-adapter.ts: 同上。
update-orchestrator.ts: V2 下明确 filled/changed，legacy-v1 下保持 updateGroupKeys/modifiedKeys 语义。
table-crud-api.ts: V2 下写 manual_crud log entry，legacy-v1 下仍走旧保存门面。
sql-api.ts: V2 下写 raw_sql_mutation/raw_sql_batch log entry，legacy-v1 下仍走旧保存门面。
```

## 外部 API 语义

本节是 V2 分支的目标 API 语义。legacy-v1 分支保持当前 API 调用习惯，通过统一门面继续写旧字段，不要求调用方直接感知 V1/V2。

raw SQL API：

```ts
executeSqlBatch({
  sql,
  targetSheetKeys: ['sheet_0'],
  filledSheetKeys: [],
  source: 'raw_sql_batch',
});
```

字段语义：

```text
targetSheetKeys: 用于 diff 范围和 patch 范围。
filledSheetKeys: 是否推进自动填表冷却；raw SQL 默认不推进。
changedSheetKeys: 由系统 diff 得出，也允许调用方提供校验范围。
```

CRUD API：

```ts
updateCell({ tableName, rowIndex, colIdentifier, value, trackAsTriggered?: false })
```

默认：

```text
source='manual_crud'
filledSheetKeys=[]
changedSheetKeys=[targetSheet]
```

AI 填表：

```text
source='auto_fill'/'manual_fill'/'group_fill'
filledSheetKeys=targetSheetKeys/group.sheetKeys
changedSheetKeys=patch diff result
```

## 验收用例

### 兼容与退化

1. 当前源码中的 `independentData / incrementalData / modifiedKeys / updateGroupKeys / _acu_storage_mode / _acu_storage_version` 均能被 legacy-v1 识别。
2. 旧 isolated `independentData` 能读取。
3. 旧 isolated `incrementalData` 能读取，并按当前 pendingDeltas 语义恢复。
4. 旧顶层 `TavernDB_ACU_IndependentData / TavernDB_ACU_Data / TavernDB_ACU_SummaryData` 能读取。
5. 旧模式写入后仍写 `TavernDB_ACU_IsolatedData[isolationKey]` 下的 legacy-v1 字段，不生成 `storageFrame`。
6. 当前源码未实现 `storageFrame` 时，文档中的 V2 类型和入口均不得被当成现状 API 使用。
7. 混合旧+V2 时默认 `legacy-v1 wins`，记录 warning，不自动删除任一侧字段。

### V2 数据恢复

1. 首次写入生成 full checkpoint，读取可恢复完整表。
2. checkpoint 后追加 3 条 log，读取按顺序恢复最终数据。
3. 同一楼层同一表多次 update row，读取结果等于按 seq 顺序应用。
4. 同一楼层先 update 后 delete 同一 row，最终 row 不存在。
5. 同一楼层先 delete 后 upsert 同一 row，最终 row 存在且值为最后 upsert。
6. schema/header 变化生成 sheet_replace patch，不走 row patch。
7. row_id 缺失/重复生成 sheet_replace patch。

### 调度状态

1. 填表成功且变化：lastFilledAiFloor 和 lastChangedAiFloor 都更新。
2. 填表成功但无变化：只更新 lastFilledAiFloor。
3. 填表失败：不更新 lastFilledAiFloor，从调度角度等价于没填过。
4. 前端 CRUD 默认不更新 lastFilledAiFloor，只更新 lastChangedAiFloor。
5. raw SQL 默认不更新 lastFilledAiFloor，除非显式传 filledSheetKeys。
6. 删除楼层后重载，lastFilledAiFloor 回退到剩余日志中的最新成功填表楼层。

### 并发与同楼层顺序

1. 两个 raw SQL batch 并发调用，同 scope 下 seq 单调递增。
2. CRUD 与 AI 填表同时写同一楼层，最终日志顺序等于锁获取顺序。
3. 任一 entry 写入失败不得部分 append。
4. log append 后 saveChatToHost 失败，运行时状态必须回滚或标记失败，不得假装成功。

### checkpoint/compaction

1. 超过 log entry 阈值后生成 full checkpoint。
2. checkpoint 后读取不应用 checkpoint 前日志。
3. checkpoint scheduleSummary 能恢复压缩前的 filled/changed 状态。
4. full checkpoint 必须包含所有当前 sheet，不允许只包含 targetSheetKeys。

## 实施顺序

1. 新增 storage strategy resolver：
   - `resolveTableStorageStrategy_ACU`
   - `isV2TagData_ACU`
   - `isLegacyV1TagData_ACU`
   - `hasLegacyTopLevelTableData_ACU`
2. 将当前 `mergeAllIndependentTables_ACU` 的旧逻辑抽为 `mergeAllIndependentTablesLegacyV1_ACU`。
3. 保留 `mergeAllIndependentTables_ACU` 作为统一读取门面：
   - legacy-v1 -> 旧 merge
   - v2 -> V2 replay
   - empty -> 指导表/模板 fallback
4. 将当前 `persistTablesToChatMessage_ACU` 的旧逻辑抽为 `persistTablesToChatMessageLegacyV1_ACU`。
5. 保留 `persistTablesToChatMessage_ACU` 作为统一写入门面：
   - legacy-v1 -> 旧保存
   - v2/empty -> V2 persist
6. 新增 V2 类型、frame repo、patch builder、replay、persist、compaction。
7. 改造 SQLite/raw SQL/CRUD/AI 填表时，只调用统一门面，不直接指定 V1/V2。
8. 清理、删除楼层、retainRecentLayers 分支：
   - legacy-v1 -> 旧逻辑
   - v2 -> boundary checkpoint compaction
9. 增加兼容测试：
   - 旧 isolated independentData 能读取
   - 旧 incrementalData 能读取
   - 旧顶层 IndependentData/Data/SummaryData 能读取
   - 旧模式写入后仍写旧字段，不生成 storageFrame
   - 空聊天首次写入生成 V2
   - V2 聊天继续走 V2
   - 混合旧+V2 时默认 legacy-v1 wins，并记录 warning
10. 补充 V2 回放、并发、checkpoint、raw SQL、CRUD、填表成功无变化测试。

## 非目标

本重构不做隐式迁移。

不会在普通读取/写入路径中把旧聊天自动转换为 V2。

不会在识别到旧模式后混写 V2 frame。

不会删除旧模式读取/写入逻辑。

不会强制把旧 partial checkpoint / incrementalData 改造成 full checkpoint + ordered log。

不会在 legacy-v1 模式下废弃 `modifiedKeys/updateGroupKeys` 的调度语义。

不要求 raw SQL patch 一定可还原为行级操作；V2 下无法安全推断时使用 sheet_replace。

V2 的目标是为新数据提供更可靠的存储模型；旧数据继续由旧路径稳定承载。

## 最终目标

重构完成后，持久层应满足：

```text
兼容旧聊天：识别到 legacy-v1 后退化使用旧读取、旧写入、旧清理、旧调度。
新数据更可靠：V2 使用 latest full checkpoint + ordered logs。
同楼层多次写入可靠：V2 append-only seq log。
调度状态准确：V2 中 filled 与 changed 独立记录；失败不算 filled。
并发可验证：锁内完成 mutation + append + save。
checkpoint 语义清晰：V2 checkpoint 永远是全量数据库快照。
升级路径安全：legacy-v1 到 V2 只能通过显式迁移工具完成。
```
