# 交火向量索引混合热缓存改造计划

## 1. 背景

当前项目已经实现内容寻址外置向量索引，核心链路位于 [`src/service/vector/summary-vector-index-storage-service.ts`](../src/service/vector/summary-vector-index-storage-service.ts) 与 [`src/data/storage/vector-index-st-files-storage.ts`](../src/data/storage/vector-index-st-files-storage.ts)。该方案解决了向量数据塞入聊天楼层导致体积膨胀的问题，并提供了 `manifest`、`row_index`、`vector_chunk`、`vector_pack`、`registry`、安全 GC、健康检查和楼层回退所需的 checkpoint 能力。

当前外置层已经从“逐 chunk 文件”演进为“内容寻址 pack + chunk 引用”的混合协议：chunk 级引用仍保留，pack 作为实际冷备份载体。这样可以减少零散文件数量，同时保留按 chunk 恢复、按 chunk 校验和热缓存回填的能力。

但当前方案也暴露出明显工程成本：实时更新一行向量时，容易牵动 `manifest`、`row_index`、chunk 引用、pack 引用、registry、GC 和楼层状态。能跑不等于设计合格，把每一次行级变化都变成外置文件协议维护，复杂得像是在给未来事故预留接口。

对比 [`Engram`](../Engram-master/Engram-master/README.md) 项目后确认，其向量主存储方案是：

- 使用 [`Dexie`](../Engram-master/Engram-master/src/data/db.ts) 封装浏览器 `IndexedDB`。
- 每个聊天一个数据库，数据库名类似 `Engram_${chatId}`。
- 向量直接作为事件记录字段 `embedding?: number[]` 保存。
- 单条重嵌时通过 `db.events.update(event.id, { embedding, is_embedded: true })` 精确更新。
- 可选同步时把整库 dump 成 `Engram_sync_${safeChatId}.json` 上传到 `/api/files/upload`。

Engram 的行级更新很干净，但如果浏览器清理缓存，IndexedDB 可能丢失。它依赖整库同步文件恢复，这对本项目不够，因为本项目还要求：

1. 纪要表实时联动。
2. 用户回退旧楼层时向量也能回退。
3. 浏览器缓存丢失后可恢复。
4. 外置文件不能无限残留。
5. 删除索引时外置文件也要清理。
6. 不能让当前态向量污染旧楼层时间线。

因此，本计划采用混合架构：**IndexedDB 做热索引，聊天楼层保存 checkpoint，外置内容寻址文件做冷备份与跨端恢复。**

---

## 2. 设计目标

### 2.1 必须满足

- 支持单行精确重嵌，不重写整份索引。
- 支持快速检索，优先走本地热缓存。
- 支持浏览器 IndexedDB 被清理后的恢复。
- 支持聊天楼层回退时向量版本同步回退。
- 支持现有外置索引协议兼容迁移。
- 支持安全 GC，不能误删仍被旧楼层引用的文件。
- 支持健康检查明确指出缺失、损坏、版本不一致。

### 2.2 旧数据兼容与非破坏迁移验收标准

- 旧版 `v1`/`v2` 外置索引 `manifest` 必须保持可读，读取期统一做规范化，不允许因为缺少新字段就判定索引损坏。
- 旧版 `base_shard`、`delta_shard`、`batchRefs`、`snapshot.activeRowKeys`、`snapshot.activeChunkIds` 必须继续被加载、排序和去重。
- 显式迁移旧索引时只能新增内容寻址 `manifest` 与新协议 `vector_pack` / `chunkRefs`（旧版本迁移产生的 `vector_chunk` 仍需兼容读取），并只更新当前最新 AI 楼层指针；不得删除旧楼层、旧 `manifest`、旧 shard 或旧外置文件。
- 迁移过程中如果旧外置文件缺失、checksum 不一致或无法还原行/chunk，必须失败退出并保留原状态，不允许写入半迁移状态。
- `IndexedDB` 热缓存只能作为加速层；浏览器缓存丢失时必须以聊天楼层 checkpoint 与外置文件恢复，不能把空热缓存当作空索引。
- 健康检查中的 `legacy_manifest` 属于可迁移警告，不属于数据损坏错误；真正的错误必须限定为外置文件缺失、校验失败、身份不匹配等会破坏恢复能力的问题。
- 安全 GC 必须基于全聊天楼层可达性扫描；即使当前最新楼层已迁移到内容寻址协议，仍不能清理旧楼层引用的 legacy 文件。

### 2.3 明确非目标

- 不直接照搬 Engram 的“当前态 IndexedDB + 整库 JSON 同步”作为唯一方案。
- 不把浏览器 IndexedDB 当唯一可信数据源。
- 不依赖酒馆文件接口支持真文件夹。
- 不用聊天记录原始全称作为裸文件路径。
- 不在没有 scope 的情况下执行外置文件删除。

---

## 3. 总体架构

```text
聊天楼层 tagData
  └─ 保存轻量 checkpoint：版本号、索引身份、行 hash、外置 manifest 指针

IndexedDB 热缓存
  └─ 保存当前聊天当前表的行级向量，可单条更新、快速检索

外置内容寻址冷备份
  └─ 保存 manifest、row_index、vector_pack、chunkRefs、checkpoint、registry，用于缓存丢失后恢复
```

职责划分：

| 层级 | 职责 | 是否可信 | 是否大体积 | 典型操作 |
|---|---|---:|---:|---|
| 聊天楼层 checkpoint | 时间线坐标、版本指针 | 高 | 否 | 回退、恢复定位 |
| IndexedDB 热缓存 | 快速检索、单行更新 | 中 | 是 | 查询、重嵌、缓存命中 |
| 外置内容寻址文件 | 冷备份、跨端恢复、抗缓存清理 | 高 | 是 | 恢复、迁移、GC |
| registry / health check | 文件治理、诊断 | 高 | 小 | 可达性扫描、缺失报告 |

核心原则：

```text
IndexedDB = 当前态高速工作区
checkpoint = 时间线坐标
外置内容寻址文件 = 可恢复冷备份
registry + health check = 安全治理层
```

---

## 4. 数据模型设计

### 4.1 IndexedDB 热缓存

新增本地向量缓存库，暂定名称：`TavernDB_ACU_VectorCache`。

表：`vectorRows`

```ts
interface VectorHotCacheRow_ACU {
    key: string;
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    rowKey: string;
    rowHash: string;
    embedding: number[];
    vectorModelKey: string;
    indexedAt: string;
    updatedAt: string;
    floorAnchor?: number;
    checkpointId: string;
    externalChunkKey?: string;
    status: 'ready' | 'dirty' | 'missing_external' | 'stale';
}
```

建议索引：

```text
key = chatKey + isolationKey + sourceTableKey + rowKey + checkpointId
indexes:
  - [chatKey+isolationKey+sourceTableKey]
  - [checkpointId]
  - [rowKey]
  - [rowHash]
  - [status]
```

说明：

- `rowHash` 用于判断表行是否变化。
- `checkpointId` 用于支持楼层回退，不允许只保存当前态。
- `externalChunkKey` 用于和内容寻址外置 chunk 对齐。
- `status` 用于健康检查和恢复流程。

### 4.2 聊天楼层 checkpoint

聊天楼层只保存轻量状态，不保存大向量。

```ts
interface SummaryVectorCheckpointState_ACU {
    checkpointId: string;
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    vectorModelKey: string;
    rowCount: number;
    rowHashes: Record<string, string>;
    manifestRef?: {
        path: string;
        checksum?: string;
    };
    indexedAt: string;
    updatedAt: string;
}
```

说明：

- `rowHashes` 是轻量版本坐标，避免旧楼层无法判断行集合。
- `manifestRef` 指向外置冷备份。
- 楼层回退时必须以当前楼层 checkpoint 为准，不得直接使用 IndexedDB 最新 checkpoint。

### 4.3 外置冷备份

继续保留当前内容寻址外置协议，但定位从“实时主索引”降级为“冷备份和恢复层”。

保留角色：

- `manifest`
- `row_index`
- `vector_pack`：新协议的实际冷备份载体，一个 pack 聚合多个内容寻址 chunk。
- `chunkRefs`：manifest 内的 chunk 级引用，不再等同于独立外置文件。
- `vector_chunk`：旧 `content_addressed_chunks` 协议兼容角色，只用于读取旧数据或非破坏迁移过渡。
- `tombstone`
- `registry`
- `checkpoint`

外置文件命名建议：

```text
TavernDB_ACU_vector_<safeChatName>_<shortHash>_<isolationKey>_<sourceTableKey>_<role>_<id>
```

要求：

- `safeChatName` 只用于可读，必须清洗非法字符。
- `shortHash` 用于稳定唯一，避免同名聊天冲突。
- 不依赖 `/` 真目录。
- 旧文件命名必须兼容读取。

---

## 5. 关键流程

### 5.1 新增或修改一行纪要

```text
表格行变化
  → 计算 rowKey 与 rowHash
  → 查询 IndexedDB 中对应 rowKey 的旧 rowHash
  → rowHash 未变化：跳过重嵌
  → rowHash 变化：只重嵌该行
  → 更新 IndexedDB.vectorRows 单条记录
  → 标记当前 checkpoint dirty
  → 后台稳定后将热缓存内容打包为 vector_pack，并同步更新外置 manifest / chunkRefs / packRefs
```

要求：

- 修改一行只重嵌一行。
- 未变化行不得重复向量化。
- 高并发变化时，外置层应减少零散文件数量，而不是继续写出大量单 chunk 文件。
- 更新失败不能破坏旧 checkpoint。
- 本阶段不把聊天楼层 manifest 写入改成真正异步防抖；楼层 checkpoint 仍需与已落盘的外置 pack 保持同步。

### 5.2 检索

```text
读取当前楼层 checkpoint
  → 查询 IndexedDB 是否存在该 checkpoint 的 vectorRows
  → 命中：直接本地向量检索
  → 未命中：从外置 manifest / row_index / vector_pack + chunkRefs 恢复 IndexedDB
  → 外置恢复成功：继续检索
  → 外置也缺失：健康检查报告并提示重建索引
```

要求：

- 不允许用 IndexedDB 最新态替代当前楼层 checkpoint。
- 检索结果必须和当前楼层状态一致。
- 恢复流程必须有 checksum 校验。

### 5.3 楼层回退

```text
用户回退聊天楼层
  → 读取该楼层 tagData 中 checkpointId
  → 检查 IndexedDB 是否存在该 checkpoint 的缓存
  → 有：切换检索视图
  → 没有：从外置 checkpoint 恢复
  → 恢复失败：提示缺失，不清空楼层状态
```

要求：

- 旧楼层不能检索到未来行。
- 新楼层新增向量不能污染旧楼层。
- 外置文件缺失不能把楼层状态删掉，只能标记健康问题。

### 5.4 浏览器缓存被清理

```text
IndexedDB 丢失
  → 插件启动或进入聊天时检测热缓存为空
  → 读取当前聊天楼层 checkpoint / manifestRef
  → 从外置文件恢复 vectorRows
  → 恢复成功：重建热缓存
  → 恢复失败：健康检查报告缺失项
```

要求：

- IndexedDB 只是热缓存，不是唯一真相源。
- 恢复失败时不能静默退化成空索引。
- 用户必须能看到缺了哪些文件。

### 5.5 外置文件防抖备份

```text
表格保存 / API 编辑 / 导入 / 填表完成
  → enqueue 当前 scope 的 flush task
  → IndexedDB 持久化 task 与 dirty scope
  → debounce 合并同 scope 多次触发
  → 到期后重新读取当前聊天、当前纪要表与目标楼层
  → 调用同步归档核心生成新 checkpoint
  → 将有效 chunk 聚合写入 vector_pack
  → 外置 manifest / row_index / chunkRefs / packRefs 全部成功后
  → 写入楼层 checkpoint
  → 清除 dirty / queued task
```

要求：

- 防抖窗口内多次行变化只写一次外置备份。
- 防抖只能合并触发频率，不能拆散 checkpoint 原子性。
- chunk 内容寻址去重，但新外置文件应以 pack 为主要落盘单位。
- 写入新 checkpoint 成功前，不破坏旧 checkpoint。
- flush 到期时必须重新读取真实表格状态，不能使用 enqueue 时捕获的旧 rows。旧 rows 进队列就是把过期数据包装成“异步优化”，这种实现不合格。
- 手动重建、旧协议迁移、删除索引等显式操作保留立即执行路径，不混入后台防抖。

### 5.6 Flush 队列状态机

```text
idle
  → dirty
  → queued
  → flushing
  → ready
  → failed_retryable
  → queued

flushing
  → failed_terminal
```

状态含义：

| 状态 | 含义 | 是否可自动恢复 |
|---|---|---:|
| `idle` | 当前 scope 无待处理任务 | 是 |
| `dirty` | 表格已变更，但尚未进入执行窗口 | 是 |
| `queued` | 防抖任务已排队，等待执行 | 是 |
| `flushing` | 正在执行同步归档与外置 pack 写入 | 需等待 |
| `ready` | 最近一次 flush 成功，checkpoint 与外置文件一致 | 是 |
| `failed_retryable` | 网络、上传、临时读取失败，可重试 | 是 |
| `failed_terminal` | 配置无效、目标楼层不存在、表结构不可恢复等终止错误 | 否 |

持久化 task 字段：

```ts
interface SummaryVectorIndexFlushTask_ACU {
    scopeKey: string;
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    targetMessageIndex?: number;
    mode: 'append' | 'sync';
    status: 'dirty' | 'queued' | 'flushing' | 'ready' | 'failed_retryable' | 'failed_terminal';
    requestedAt: number;
    debounceUntil: number;
    attemptCount: number;
    lastAttemptAt?: number;
    lastSuccessAt?: number;
    lastError?: string;
}
```

约束：

- `scopeKey` 必须由 `chatKey + isolationKey + sourceTableKey` 构成，禁止只按表名去重。
- `flushing` 状态崩溃后，下次启动应降级为 `failed_retryable` 或重新排队，而不是永远卡死。
- 自动入口只 enqueue；真正写楼层仍由同步归档核心完成。
- 队列执行期间如果发现当前聊天或纪要表已经切换，必须放弃本次 flush 并记录错误，不允许跨聊天写 checkpoint。

### 5.7 崩溃恢复

```text
插件启动 / 进入聊天 / 打开数据管理页
  → 扫描 IndexedDB flushTasks
  → 找到当前 chatKey + isolationKey 下 dirty / queued / failed_retryable task
  → 未到 debounceUntil：恢复 timer
  → 已到期：重新 enqueue 立即执行
  → flushing 超时：标记 failed_retryable 后重试
  → failed_terminal：只报告，不自动执行
```

要求：

- 崩溃恢复只处理当前聊天上下文可验证的 task。
- 找不到当前表或目标楼层时不得盲 flush。
- 恢复失败不能清空楼层 manifest，也不能删除外置文件。
- UI 必须显示 pending 数量、失败数量和最近错误。

### 5.8 Pack compaction

第一阶段不做激进重写历史 pack，只做安全治理：

```text
扫描全聊天楼层 manifest
  → 收集 reachable pack / legacy shard / manifest / row_index / tombstone
  → registry 中同 scope 不可达文件进入 GC 候选
  → pack 级健康检查报告 chunkRef 缺失、checksum mismatch、身份不匹配
```

后续可选 compact：

```text
只选择当前最新 checkpoint 专属且历史楼层不可达的 pack
  → 重新打包为较少 pack
  → 写新 manifest
  → 新 manifest 落楼层成功后
  → 老 pack 进入安全 GC
```

约束：

- compaction 不能只看最新楼层。
- compaction 不能覆盖旧楼层引用的 pack。
- compaction 失败必须保留旧 manifest。

### 5.9 GC

```text
扫描所有聊天楼层 checkpoint / manifest
  → 收集 reachable external paths
  → 读取 registry
  → 删除同 scope 内不可达文件
  → 无 scope 时不删除
  → 删除失败保留 registry 或记录 failedDeletes
```

要求：

- 不能只看当前楼层。
- 不能在清除 checkpoint 后再推导 scope。
- 不能因为外置文件 404 就删除楼层状态。

---

## 6. 分阶段实施计划

### 阶段一：引入 IndexedDB 热缓存，不改变外置协议

目标：低风险接入热缓存。

任务：

1. 新增本地 `VectorHotCacheStorage_ACU` 模块。
2. 建立 `vectorRows` 表结构。
3. 归档完成后，将当前 `manifest/chunk/row_index` 解包写入 IndexedDB。
4. 检索优先读 IndexedDB，未命中再走当前外置读取链路。
5. 保留现有外置写入协议不变。

验收：

- 不清 IndexedDB 时检索不读外置大文件。
- 清 IndexedDB 后能从外置恢复。
- 旧 manifest 仍可读取。
- 类型检查和构建通过。

### 阶段二：实现行级增量更新

目标：吸收 Engram 的行级精确更新优势。

任务：

1. 定义稳定 `rowKey`。
2. 定义稳定 `rowHash`。
3. 表格更新时检测变化行。
4. 只对变化行调用 embedding。
5. 只更新 IndexedDB 单条 `vectorRows`。
6. checkpoint 标记 dirty。

验收：

- 修改一行只重嵌一行。
- 未变化行不重复上传、不重复向量化。
- 检索结果反映最新行。
- embedding 失败不会破坏旧向量。

### 阶段三：checkpoint 版本化与楼层回退

目标：保证时间线一致性。

任务：

1. 每个楼层保存 checkpoint 指针。
2. IndexedDB 支持按 checkpoint 查询行集合。
3. 楼层回退时切换 checkpoint。
4. checkpoint 缺失时从外置恢复。
5. 新旧 checkpoint 共存，直到 GC 确认不可达。

验收：

- 回退旧楼层不会检索到未来行。
- 新楼层新增行不会污染旧楼层。
- 外置 checkpoint 缺失时健康检查明确报错。

### 阶段四：防抖 flush 队列与外置冷备份

目标：降低实时写外置文件压力，同时不破坏 checkpoint 原子性。

任务：

1. 新增持久化 flush task / dirty scope 存储。
2. 新增调度层，将自动触发合并到同一 scope 的 debounce flush。
3. 保留同步归档核心，由队列到期后调用同步归档完成外置 pack 与楼层 checkpoint 写入。
4. 将填表完成、表 CRUD、可视化保存、JSON 导入四个自动入口统一改为 enqueue。
5. 手动重建、旧协议迁移、删除索引保留立即执行路径。
6. 内容寻址 chunk 继续去重，但多个 chunk 聚合写入 `vector_pack`。
7. registry 记录 checkpoint、pack 引用与 manifest 内 chunkRefs。
8. 删除当前索引时先收集 scope，再清状态，再 GC。

验收：

- 高频表格变化在防抖窗口内只触发一次外置上传。
- flush 成功前旧 checkpoint 仍可读取。
- flush 上传失败不会写入新楼层 manifest。
- 四个自动入口行为一致，不存在有的防抖、有的同步阻塞。
- 刷新页面后 pending task 能恢复或报告失败，不会静默丢失。
- 删除本地索引能删除对应外置备份。
- 浏览器缓存清理后可从外置 pack 恢复。
- registry 不残留已删除路径。

### 阶段五：UI、诊断与 pack 治理

目标：让用户知道系统状态，而不是靠猜。

新增健康检查字段：

- 热缓存是否存在。
- 当前 checkpointId。
- IndexedDB chunk 数。
- pending flush task 数量。
- dirty scope 数量。
- failed flush task 数量。
- 最近一次 flush 错误。
- 外置 manifest 是否存在。
- pack 数量与 chunkRef 数量。
- pack 内 chunk 与 manifest chunkRefs 是否一致。
- checksum mismatch 数量。
- 当前楼层是否可恢复。
- 是否需要重建索引。

UI 入口：

- 复用现有健康检查按钮。
- 在数据管理页显示热缓存、flush 队列与外置备份状态。
- 删除索引时显示本地热缓存、pending task 与外置文件清理结果。
- 失败 task 提供明确日志，不用 `{}` 这种废话错误对象糊弄用户。

pack 治理：

- 第一阶段只做可达性统计、安全 GC 与细粒度 health。
- 真正 pack compaction 必须确认历史楼层不可达后再写新 manifest。

验收：

- 用户能区分“热缓存缺失”“flush 未完成”和“外置备份缺失”。
- 健康检查不再只给模糊错误。
- 删除、恢复、重建、flush 失败都有明确日志。
- pack 健康检查能定位到具体 pack / chunkRef。

---

## 7. 风险与约束

### 7.1 IndexedDB 风险

浏览器可能清理 IndexedDB，因此 IndexedDB 不可作为唯一真相源。

处理方式：

- 外置 checkpoint 必须可恢复。
- 启动时检测热缓存缺失。
- 恢复失败时明确提示用户。

### 7.2 外置文件风险

外置文件可能被用户删除、上传失败、checksum 不一致。

处理方式：

- checksum 校验。
- 健康检查报告缺失项。
- 不清空楼层状态。
- 允许用户重新归档或按行重嵌。

### 7.3 时间线污染风险

如果检索直接使用 IndexedDB 最新态，旧楼层会检索到未来数据。

处理方式：

- 所有检索必须绑定 checkpoint。
- 楼层回退必须切换 checkpoint。
- 当前态缓存和历史 checkpoint 缓存不能混用。

### 7.4 文件命名风险

聊天名可能含非法字符、超长字符、emoji、同名冲突。

处理方式：

- 聊天名只做可读前缀。
- 使用清洗后的 `safeChatName`。
- 加入 `shortHash` 保证唯一。
- 不依赖 `/` 目录。

### 7.5 GC 风险

GC 如果 scope 推导错误，会误删有效文件。

处理方式：

- 先扫描所有楼层可达性。
- 删除入口清状态前先收集 scopeHints。
- 无 scope 时不删除。
- 删除失败要记录 failedDeletes。

---

## 8. 与 Engram 的对照

| 维度 | Engram | 本计划 |
|---|---|---|
| 主存储 | IndexedDB | IndexedDB 热缓存 + 外置冷备份 |
| 向量粒度 | 事件字段 `embedding` | 表行级 `vectorRows.embedding` |
| 单条更新 | `db.events.update()` | `vectorRows.update()` |
| 楼层回退 | 不作为核心目标 | checkpoint 强约束 |
| 缓存丢失 | 依赖整库同步文件 | 从外置 checkpoint / vector_pack / chunkRefs 恢复 |
| 文件同步 | 整库 JSON dump | 内容寻址 chunkRefs + vector_pack + checkpoint |
| GC | 删除 IndexedDB 或同步文件 | 可达性 GC |
| 风险 | IndexedDB 丢失、dump 变大 | 架构复杂，但可恢复性更强 |

结论：

- 借鉴 Engram 的行级 IndexedDB 精确更新。
- 不照搬 Engram 的当前态单库模型。
- 保留当前项目内容寻址、checkpoint、GC、健康检查能力。

---

## 9. 推荐落地顺序

优先级从高到低：

1. IndexedDB 热缓存读取层。
2. 外置恢复到 IndexedDB。
3. 行级 `rowHash` 增量重嵌。
4. checkpoint 版本绑定。
5. 防抖外置冷备份。
6. GC 与健康检查增强。
7. UI 状态展示。

不要反过来先做 UI 或文件命名美化。那种顺序只是把真正困难的问题藏起来，最后留下一个看着漂亮、实际一碰就碎的系统。

---

## 10. 最终判断

本计划的核心不是“换一种存储”，而是重新定义各层职责：

```text
IndexedDB 负责快。
checkpoint 负责准。
外置文件负责不丢。
registry 和 health check 负责可治理。
```

这套设计同时吸收：

- Engram 的单条向量精确更新能力。
- 当前项目的外置内容寻址恢复能力。
- 当前项目的楼层 checkpoint 与回退一致性能力。
- 当前项目已修复的安全 GC 与健康检查能力。

真正可靠的系统不是缓存永远不丢，而是缓存丢了也能恢复；不是文件名看着整齐，而是状态、引用、版本和删除边界都经得起事故复盘。