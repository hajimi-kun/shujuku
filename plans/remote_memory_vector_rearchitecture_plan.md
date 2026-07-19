# 远记忆大总结向量化重构计划

## 1. 目标定稿

本次改造的目标不是继续优化现有按纪要行切 chunk 的向量功能，而是将其重构为两层记忆体系：

- 近记忆：保留在纪要表中的最近原始纪要，不向量化
- 远记忆：当纪要条目达到阈值时，抽取最早一批纪要，调用独立的大总结生成链路生成长期摘要
- 大总结内容约束：长期记忆只记录已经确定、已经落定的事实，不记录待解决事项、悬而未决目标或仍可能变化的判断
- 向量化对象：大总结先按每 2 句切成一个 chunk，对这些 chunk 做 embedding；命中后回卷整条大总结本身
- 召回对象：每轮用户输入后，只召回远记忆大总结
- 删除策略：仅当大总结生成成功、embedding 成功、状态写入成功后，删除这批最早纪要

这意味着当前的向量功能要从“纪要行级索引”改造成“批次级远记忆索引”。

---

## 2. 已确认事实

### 2.1 现有向量链路仍是旧模型

当前代码中的向量记忆仍然围绕纪要 chunk 组织：

- [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts) 里的配置字段仍包括 `overviewSentenceLimit`、`fallbackContentMaxLength`、`recallCandidateLimit`，明显是面向 chunk 时代的参数
- [`src/data/models/chat-message-data.ts`](src/data/models/chat-message-data.ts) 中的 [`ChatVectorState_ACU`](src/data/models/chat-message-data.ts:39) 仍然是 `items + chunks` 结构
- [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts) 当前召回逻辑仍以 chunk 相似度计算、父项聚合和回卷为核心
- [`src/service/worldbook/vector-memory-entry-service.ts`](src/service/worldbook/vector-memory-entry-service.ts) 当前输出格式也仍以“纪要概览 + 纪要内容”为中心

所以现有实现不是稍微调一下参数就能变成远记忆架构。数据语义本身就不对。

### 2.2 发送前召回挂点已存在

当前发送前召回编排入口已经存在于 [`orchestrateVectorRecallBeforeSend_ACU()`](src/service/plot/vector-recall-orchestrator.ts:70)。

这意味着：

- 发送前拦截用户输入的入口不需要重新找
- 世界书同步的总体流程不需要推翻
- 需要重写的是它内部依赖的远记忆召回实现，而不是整个编排壳子

### 2.3 当前纪要合并逻辑不能直接复用为远记忆大总结

当前自动合并纪要逻辑在 [`src/service/summary/merge-logic.ts`](src/service/summary/merge-logic.ts) 中。

它的职责是：

- 处理纪要表条目
- 基于合并提示词缩并纪要
- 输出仍然面向表格编辑和纪要整理

这条链路的提示词来源与职责，都不是为了“长期记忆提炼”。

因此，本次远记忆大总结必须：

- 不复用现有合并总结逻辑
- 不混进 [`executeAutoMergeBatch_ACU()`](src/service/summary/merge-logic.ts:103)
- 独立出一条新的逻辑链和提示词组

### 2.4 项目已有默认提示词组组织模式可复用

[`src/shared/defaults-json.js`](src/shared/defaults-json.js) 中已经存在多个默认提示词组：

- [`DEFAULT_CHAR_CARD_PROMPT_ACU`](src/shared/defaults-json.js:9)
- [`DEFAULT_PLOT_PROMPT_GROUP_ACU`](src/shared/defaults-json.js:207)

这说明项目已经接受“预置 prompt group 常量 + 运行时读取 + 配置覆盖”的模式。

所以远记忆大总结也应采用同样的组织方式，而不是把长提示词硬编码进业务函数。

### 2.5 当前 UI 仍在暴露旧 chunk 语义

当前世界书/表格页的向量配置区在 [`src/presentation/pages/main-popup-table.ts`](src/presentation/pages/main-popup-table.ts) 中，仍然暴露这些字段：

- `概要分块句数`
- `正文兜底截断长度`
- `立即生成chunk`

这和远记忆大总结方案是直接冲突的。若不调整，用户在配置“远记忆”，界面却在谈“chunk”，会形成严重的语义错位。

---

## 3. 业务语义定稿

本次方案已经确认以下关键业务约束：

1. 成功生成大总结并向量化后，删除那批最早纪要
2. 之后每轮只召回大总结，不再召回纪要本身
3. 近记忆继续保留为原始纪要表数据，不进入向量召回链路
4. 大总结使用独立逻辑和独立提示词组，不复用原生纪要合并总结

由此形成的正式语义是：

### 3.1 近记忆

- 近记忆是纪要表中最近、尚未归档的一批原始纪要
- 近记忆不向量化
- 近记忆只作为后续归档候选与人工可读数据保留

### 3.2 远记忆

- 远记忆由“最早一批纪要”压缩得到
- 一个远记忆对象代表一个归档批次，而不是一行纪要
- 每个远记忆对象包含对应大总结文本与其 embedding

### 3.3 触发规则

当未归档纪要数量达到用户设定阈值时：

1. 选取最早一批未归档纪要
2. 调用独立远记忆总结链生成大总结
3. 对大总结做 embedding
4. 写入本地聊天记录向量状态
5. 仅在上述全部成功后删除原始纪要

### 3.4 召回规则

每轮用户输入后：

1. 仅对远记忆大总结做相似度召回
2. 不再对纪要行本身进行召回
3. 将命中的远记忆写入专用世界书条目

---

## 4. 核心设计决策

## 4.1 独立出远记忆归档链路

建议新增独立链路，而不是继续挂靠在原纪要合并流程内部。

新链路职责：

1. 判断是否达到归档阈值
2. 提取最早一批纪要
3. 调用远记忆大总结提示词组生成摘要
4. 生成 embedding
5. 写入远记忆状态
6. 删除原始纪要

原因：

- 原纪要合并服务的目标是压缩纪要表
- 远记忆归档服务的目标是生成长期可检索资产
- 两者提示词目标、失败语义、产物形态和后续消费方式都不同

把这两条链路塞在一起，只会制造职责污染。

## 4.2 重构向量状态模型为按楼层增量快照

当前的 [`ChatVectorState_ACU`](src/data/models/chat-message-data.ts:39) 不适合描述你要的“随最新楼层递增快照覆盖”的远记忆状态。上一版只写了批次结构，没把“第 30 层要同时携带第 10 层与第 30 层已归档结果”这个关键约束落进去，差劲。

新的状态模型必须满足以下语义：

- 每次完成一次大总结归档后，把**截至当前楼层为止的全部已向量化远记忆**写入当前最新楼层的聊天记录
- 例如第 10 层首次归档后，第 10 层记录保存第 10 层之前全部远记忆
- 第 30 层再次归档后，第 30 层记录保存“第 10 层远记忆 + 第 30 层新增远记忆”的完整快照
- 发送前使用时，从当前聊天记录向上回溯，找到最近一个带完整远记忆向量快照的楼层即可
- 这样在楼层回退时，只会看到回退点之前最后一次快照，不会被未来楼层的远记忆污染

建议目标结构如下：

```ts
interface ChatVectorRemoteMemoryBatch_ACU {
  batchId: string;
  sourceMessageId: string;
  sourceRowKeys: string[];
  sourceRowCount: number;
  summaryText: string;
  summaryHash: string;
  chunks: Array<{
    chunkId: string;
    text: string;
    vector: number[];
    sequence: number;
  }>;
  promptGroupVersion: string;
  createdAt: string;
  archivedRange?: {
    firstRowKey: string;
    lastRowKey: string;
  };
}

interface ChatVectorState_ACU {
  snapshotMessageId: string;
  remoteMemoryBatches: ChatVectorRemoteMemoryBatch_ACU[];
  lastIndexedAt?: string;
  lastArchiveAt?: string;
}
```

必须表达出的语义：

- 一个对象对应一批纪要归档得到的一条大总结，而不是单条纪要
- 每条大总结按每 2 句切 chunk，并保存 chunk 向量
- 命中时回卷整条大总结，而不是只返回命中的 chunk
- 每次写入的是“截至当前楼层的完整远记忆快照”，不是只写本轮增量碎片
- 快照跟随聊天楼层生命周期，因此回退时天然隔离未来远记忆
- 保存来源行范围，便于追踪与重建
- 保存提示词版本，避免未来重建时丢失依据

## 4.3 召回逻辑改为直接检索远记忆

当前 [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts) 的核心是：

- query embedding
- chunk 相似度计算
- 父项聚合
- 回卷纪要内容

重构后应简化为：

- query embedding
- 远记忆大总结 embedding 相似度比较
- 直接输出命中的远记忆批次

这样可以删除旧逻辑中的：

- chunk 聚合
- 多 chunk 打分
- 纪要回卷

这会让调用链和数据解释都清晰得多。

## 4.4 世界书注入改为远记忆内容

[`src/service/worldbook/vector-memory-entry-service.ts`](src/service/worldbook/vector-memory-entry-service.ts) 现有输出格式是按纪要内容设计的。

改造后应输出：

- 远记忆批次编号
- 相关度分数
- 批次覆盖的时间范围或来源范围
- 大总结文本
- 可选的来源行区间提示

不应继续用“纪要概览 + 纪要内容”的旧模板。

---

## 5. 提示词方案设计

## 5.1 新增专用默认提示词组

建议在 [`src/shared/defaults-json.js`](src/shared/defaults-json.js) 中新增一个专用默认提示词组常量，例如：

- `DEFAULT_REMOTE_MEMORY_SUMMARIZATION_PROMPT_GROUP_ACU`

组织方式参考：

- [`DEFAULT_CHAR_CARD_PROMPT_ACU`](src/shared/defaults-json.js:9)
- [`DEFAULT_PLOT_PROMPT_GROUP_ACU`](src/shared/defaults-json.js:207)

也就是：

- 用消息数组组织
- 明确 `role`
- 保留主提示词位与可扩展段
- 支持设置覆盖与后续版本升级

## 5.2 远记忆大总结提示词的目标

这个提示词组的目标不是“缩短文本”，而是“提炼出对后续多轮仍然有效的长期记忆”。

因此必须强制模型聚焦：

- 时间阶段演进
- 核心事件链
- 重要人物变化
- 关系变化
- 持续有效的长期记忆点
- 尚未解决的冲突与悬而未决事项

禁止模型产出：

- 文学修辞
- 空泛感想
- 只追求优美而不保留事实结构的总结

## 5.3 建议输出格式

建议强制输出结构化文本：

```text
[归档批次时间范围]
...

[核心事件链]
1. ...
2. ...

[人物与关系变化]
- ...

[持续有效记忆]
- ...

[未解事项]
- ...
```

embedding 输入建议直接使用整段结构化大总结文本。

原因：

- 结构化字段更稳定
- 便于后续人类阅读排障
- 也更适合未来进一步做 rerank 或二次解析

## 5.4 提示词版本化要求

每个远记忆批次必须记录：

- `promptGroupVersion`

否则未来修改提示词后：

- 无法判断旧摘要是按什么规则生成的
- 无法决定是否需要重建
- 无法准确定位召回质量变化来源

---

## 6. 配置模型调整

当前 [`VectorMemoryConfig_ACU`](src/service/vector/vector-memory-config.ts:6) 需要从 chunk 时代配置重构为远记忆配置。

### 6.1 建议保留的配置项

- `enabled`
- `threshold`
- `topK`
- `minScore`
- `embeddingEndpoint`
- `embeddingApiKey`
- `embeddingModel`
- `entryComment`
- `entryKey`

### 6.2 建议新增的配置项

- `archiveBatchSize`：每次归档多少条最早纪要
- `remoteSummaryPromptGroup`：远记忆大总结提示词组配置入口
- `promptGroupVersion`：默认提示词版本号
- `keepPreviousMemoryOnEmptyRecall`：空召回时是否保留旧世界书内容
- `inputTooShortFallbackMode`：用户输入过短时是否回退处理

### 6.3 建议移除或废弃的字段

- `overviewSentenceLimit`
- `fallbackContentMaxLength`
- `recallCandidateLimit` 如果不再保留 chunk 候选池，可改造成普通候选上限或直接去掉

这些字段继续存在会误导后续维护者以为系统仍然基于纪要 chunk。

---

## 7. UI 与交互调整

## 7.1 世界书/表格页配置区改造

当前 [`src/presentation/pages/main-popup-table.ts`](src/presentation/pages/main-popup-table.ts) 的向量配置区需要全面换语义。

### 当前存在问题的文案

- `概要分块句数`
- `正文兜底截断长度`
- `立即生成chunk`

这些文案都绑定旧方案，不能继续保留。

### 新文案建议

- 启用远记忆向量召回
- 归档触发阈值
- 单次归档条数
- 召回 TopK
- 最低相似度
- Embedding Endpoint
- Embedding Model
- 远记忆条目备注
- 远记忆条目 Key
- 立即归档远记忆

## 7.2 事件绑定同步调整

[`src/presentation/pages/popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts) 中当前绑定逻辑仍直接读写旧字段。

必须同步修改：

- 字段绑定
- 默认值填充
- 保存逻辑
- 兼容旧配置的回退逻辑

不然 UI 文案改了，底层仍保存旧字段，只会制造更隐蔽的错误。

---

## 8. 模块拆分建议

为了避免把新逻辑继续塞进已有大文件，建议新增独立模块。

### 8.1 建议新增的 service 模块

#### `src/service/vector/remote-memory-archive-service.ts`
职责：

- 检查是否达到归档阈值
- 选取最早批次纪要
- 调用大总结提示词组
- 调用 embedding
- 写入远记忆状态
- 成功后删除原始纪要

#### `src/service/vector/remote-memory-prompt-service.ts`
职责：

- 组装远记忆提示词组
- 注入批次纪要内容
- 管理提示词版本号
- 处理默认值与设置覆盖

#### `src/service/vector/remote-memory-recall-service.ts`
职责：

- 对远记忆大总结做召回
- 返回远记忆批次命中结果
- 替代旧 chunk 召回逻辑

### 8.2 建议重构的现有模块

- [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)
  - 保留发送前编排壳子
  - 内部调用新的远记忆召回服务

- [`src/service/worldbook/vector-memory-entry-service.ts`](src/service/worldbook/vector-memory-entry-service.ts)
  - 输出模板改为远记忆批次内容

- [`src/service/vector/vector-index-state-service.ts`](src/service/vector/vector-index-state-service.ts)
  - 重构为批次级远记忆状态归并工具

- [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts)
  - 删除旧 chunk 配置约束
  - 新增远记忆配置校验

---

## 9. 受影响文件范围

### 9.1 核心必改文件

- [`src/data/models/chat-message-data.ts`](src/data/models/chat-message-data.ts)
- [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts)
- [`src/service/vector/vector-index-state-service.ts`](src/service/vector/vector-index-state-service.ts)
- [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts)
- [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)
- [`src/service/worldbook/vector-memory-entry-service.ts`](src/service/worldbook/vector-memory-entry-service.ts)
- [`src/presentation/pages/main-popup-table.ts`](src/presentation/pages/main-popup-table.ts)
- [`src/presentation/pages/popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts)
- [`src/shared/defaults.ts`](src/shared/defaults.ts)
- [`src/shared/defaults-json.js`](src/shared/defaults-json.js)

### 9.2 很可能新增的文件

- `src/service/vector/remote-memory-archive-service.ts`
- `src/service/vector/remote-memory-prompt-service.ts`
- `src/service/vector/remote-memory-recall-service.ts`

### 9.3 需要核对后决定是否替换或退役的旧入口

- 旧索引构建服务
- 原 chunk 立即生成入口
- 原基于纪要 item/chunk 的兼容逻辑

---

## 10. 执行步骤

## Phase 1：补查旧入库链与删除写回链

1. 展开旧向量入库服务的实现，确认当前旧 chunk 索引构建点
2. 确认纪要表删除写回走哪条保存链最安全
3. 确认复用哪条 AI 调用通道来执行远记忆大总结生成

说明：

这一阶段必须先做。否则后面的“删除原纪要”只是概念，不是可靠实现方案。

## Phase 2：提示词组与配置模型

1. 在 [`src/shared/defaults-json.js`](src/shared/defaults-json.js) 新增远记忆大总结默认提示词组
2. 在 [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts) 扩展远记忆配置
3. 在 [`src/shared/defaults.ts`](src/shared/defaults.ts) 中补充默认值
4. 设计并写入提示词版本号字段

## Phase 3：状态模型与归档链路

1. 重构 [`ChatVectorState_ACU`](src/data/models/chat-message-data.ts:39)
2. 实现远记忆归档服务
3. 实现批次选择逻辑
4. 实现大总结生成
5. 实现 embedding
6. 实现状态写入
7. 实现成功后删除原纪要

### 删除顺序要求

严格顺序必须是：

1. 大总结生成成功
2. embedding 成功
3. 状态写入成功
4. 删除原纪要

第一版不建议做“部分成功局部提交”。整批失败就整批不删。

## Phase 4：发送前召回链

1. 改写或替换 [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts)
2. 更新 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)
3. 更新 [`src/service/worldbook/vector-memory-entry-service.ts`](src/service/worldbook/vector-memory-entry-service.ts)
4. 验证空召回、低分召回与异常降级逻辑

## Phase 5：UI 与兼容处理

1. 改造 [`src/presentation/pages/main-popup-table.ts`](src/presentation/pages/main-popup-table.ts) 配置区
2. 改造 [`src/presentation/pages/popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts) 事件绑定
3. 明确旧 `items/chunks` 状态如何处理：
   - 迁移
   - 忽略并重建
   - 标记旧版本失效

不能静默混用旧状态与新状态，否则召回结果会被污染。

---

## 11. 风险与控制措施

## 11.1 风险：继续复用原合并总结逻辑

后果：

- 职责混淆
- 提示词目标错误
- 大总结质量不稳定
- 未来维护时无法区分“纪要压缩”与“远记忆归档”

控制措施：

- 独立模块
- 独立提示词组
- 独立配置入口

## 11.2 风险：删除原纪要时序错误

后果：

- 生成失败但原始纪要已删除
- 用户长期记忆直接丢失

控制措施：

- 严格执行“成功后删除”顺序
- 第一版采用整批成功语义

## 11.3 风险：UI 仍暴露旧 chunk 语义

后果：

- 用户理解错误
- 后续维护者继续基于错误语义开发

控制措施：

- 替换旧字段与文案
- 替换按钮行为说明

## 11.4 风险：旧状态静默兼容

后果：

- 远记忆大总结与旧纪要 chunk 同时参与召回
- 召回结果重复与污染

控制措施：

- 增加状态版本识别
- 旧状态迁移或强制重建
- 不允许静默混用

## 11.5 风险：消息级状态体积继续膨胀

后果：

- 聊天记录附加数据变大
- 性能下降

控制措施：

- 只保存大总结 embedding
- 不再保存大量 chunk embedding
- 控制远记忆批次数量和归档策略

---

## 12. 验收标准

### 12.1 归档链路验收

- 达到阈值后能够选取最早一批纪要
- 能够调用独立大总结提示词组成功生成摘要
- 能够成功对摘要做 embedding
- 能够将摘要和 embedding 写入本地聊天记录状态
- 成功后删除对应原始纪要
- 任一步骤失败时不删除原始纪要

### 12.2 召回链路验收

- 用户发送前能够执行远记忆召回
- 只召回远记忆大总结，不再召回纪要条目
- 命中结果能正确写入专用世界书条目
- 空召回不阻断主流程
- 召回失败不阻断主流程

### 12.3 UI 与配置验收

- 不再出现旧 chunk 语义字段
- 能保存新的远记忆配置字段
- 手动触发按钮文案与真实行为一致
- 旧配置不会导致功能直接报错

---

## 13. 推荐实施顺序

建议按以下顺序进入实现：

1. 先补查旧入库链和纪要删除写回链
2. 再做提示词组与配置模型
3. 再做状态模型与远记忆归档服务
4. 再改发送前召回链
5. 最后改 UI 与兼容逻辑

不能反过来先改 UI。那样只是把错误模型包装得更漂亮而已。

---

## 14. 最终结论

本次向量功能优化的正式方案是：

- 不复用 [`src/service/summary/merge-logic.ts`](src/service/summary/merge-logic.ts) 的原生纪要合并总结作为远记忆来源
- 新增独立的远记忆归档逻辑
- 新增参考 [`DEFAULT_PLOT_PROMPT_GROUP_ACU`](src/shared/defaults-json.js:207) 组织方式的远记忆大总结提示词组
- 只对大总结做向量化
- 每轮只召回远记忆大总结
- 归档成功后删除对应最早纪要批次
- 同步重构状态模型、召回链路、世界书输出模板、UI 文案与配置字段

这份计划可直接作为后续切换到实现模式时的执行蓝图。