# 五项 BUG 修复实施计划

## 背景

本轮修复覆盖五条链路：

1. 向量注入世界书后未稳定触发剧情推进，且同文本输入存在只触发一次的问题。
2. 手动更新被表格模板中的自动更新参数干扰。
3. 外部导入生成条目不完整，目标世界书下常表现为只生成一个条目。
4. 保留最近 N 层数据失效，旧本地数据没有被自动清理。
5. 剧情推进子任务单独选择的 API 预设无法稳定持久化。

这些问题分别属于事件门控、参数边界、世界书目标传递、本地数据候选识别、UI 编辑状态提交边界。它们不是同一个根因，不能用一次粗暴重构解决。

## 目标

- 每次用户输入都重新执行向量关键词生成、向量召回，并覆盖注入对应世界书条目。
- 向量召回完成后，剧情推进不因召回耗时导致发送门控过期而被跳过。
- 手动更新只受手动配置和分组参数影响，不受模板自动更新参数干扰。
- 保留模板基础数据首次初始化写入本地数据的行为。
- 外部导入所有条目写入用户选择的目标世界书。
- 最近 N 层清理按“含任意本地数据字段的消息层”计数。
- 剧情子任务 `taskApiPreset` 在编辑、保存、切换预设、新开对话后保持一致显示与持久化。

## 非目标

- 不修改根目录 `index.js` 这类疑似构建产物。
- 不改变剧情任务运行时“同 stage 统一 API 预设”的调度策略。
- 不改变外部导入整表/拆分条目的合并规则。
- 不移除表格模板基础数据初始化行为。

## 问题 1：向量注入与剧情推进门控

### 根因

`runVectorRecallPreprocess_ACU()` 调用 `orchestrateVectorRecallBeforeSend_ACU()` 时传入 `previousSignature`。当用户连续输入相同文本时，向量召回编排会认为已处理并跳过，导致不会重新计算并覆盖世界书条目。

同时，向量召回发生在剧情推进之前。召回过程可能耗时超过 `USER_SEND_TRIGGER_TTL_MS_ACU`，随后 `shouldProcessPlotForGeneration_ACU()` 重新检查 fresh user send gate 时可能失败，剧情推进被跳过，正文生成直接继续。

### 修复方案

- 在用户主动发送路径中调用向量召回时显式传入 `force: true`。
- 保留事件对象级 `_acu_vector_recall_processed`，只防止同一次事件对象重复处理。
- 向量召回完成后，如果本事件在召回前已被判定为 fresh user send，则延续本次发送资格，避免剧情推进门控因 TTL 过期失败。
- 确认 `syncVectorMemoryLorebookEntry_ACU()` 使用固定 comment upsert 条目，确保覆盖而非追加。

### 验收标准

- 连续两次相同用户输入都会重新计算向量召回。
- 第二次召回会覆盖同一世界书条目内容。
- 向量召回耗时较长时仍会继续进入剧情推进。
- 向量功能关闭时不阻断正常生成。

## 问题 2：手动更新参数边界

### 根因

`orchestrateManualUpdate_ACU()` 当前读取模板 `updateConfig`，并把 `updateFrequency`、`contextDepth`、`skipFloors`、`batchSize` 纳入手动分组键。这些属于自动更新参数，不应影响手动更新。

### 修复方案

- 手动路径只读取模板中的 `groupId`。
- 手动上下文范围使用 UI/全局手动参数：`autoUpdateThreshold`、`skipUpdateFloors`、`updateBatchSize`。
- 手动分组键不再包含模板 `updateFrequency`、`contextDepth`、`skipFloors`、`batchSize`。
- 保留首次初始化将模板基础数据写入本地数据的行为。

### 验收标准

- 同一 `groupId` 的表，即使模板自动参数不同，手动更新仍按手动配置分组。
- 自动更新继续使用模板自动参数。
- 模板基础数据在首次初始化时仍写入本地数据。

## 问题 3：外部导入目标世界书传递

### 根因

`updateReadableLorebookEntry_ACU()` 接收 `targetLorebookOverride`，但下游 `updateImportantPersonsRelatedEntries_ACU()`、`updateSummaryTableEntries_ACU()`、`updateOutlineTableEntry_ACU()`、`updateCustomTableExports_ACU()` 内部仍调用默认注入目标，导致条目写入目标不一致。

### 修复方案

- 为四个下游条目生成函数增加可选 `targetLorebookOverride` 参数。
- 在外部导入模式下优先使用该参数作为 `primaryLorebookName`。
- `updateReadableLorebookEntry_ACU()` 将 `targetLorebookOverride` 传递给所有下游条目函数。

### 验收标准

- 外部导入到指定世界书时，readable、wrapper、人物、总结、大纲、自定义导出条目都在同一目标世界书。
- 默认注入世界书不会收到本次外部导入的分散条目。

## 问题 4：保留最近 N 层数据

### 根因

`purgeOldLayerData_ACU()` 删除字段列表完整度较高，但候选识别只检查旧字段和 `qrf_plot`，漏掉 `TavernDB_ACU_IndependentData`、`TavernDB_ACU_IsolatedData` 等实际本地数据字段。候选不进集合，后续删除自然不会发生。

### 修复方案

- 提取统一的本地数据字段集合。
- 候选识别和删除循环共用该集合。
- 保留跳过 `chat[0]` 的保护，避免误删指导表。

### 验收标准

- 只含 `TavernDB_ACU_IndependentData` 的消息会参与 N 层计数。
- 只含 `TavernDB_ACU_IsolatedData` 的消息会参与 N 层计数。
- 超出最近 N 层的旧消息本地字段被删除。
- 普通聊天消息不参与计数。

## 问题 5：剧情子任务 API 预设持久化

### 根因

`taskApiPreset` 字段在归一化、UI 保存、运行时调用中存在，但预设切换前未统一 flush 当前任务编辑器状态。任务级 API 下拉刷新也只保留当前 DOM 值，没有从当前编辑任务状态回填；当预设列表暂时不包含保存值时，UI 会静默显示为空。

### 修复方案

- 在全局剧情预设切换和当前聊天剧情预设切换前调用 `flushCurrentPlotTaskEditorState_ACU()`。
- 增强任务级 API 下拉刷新逻辑：优先使用当前 DOM 值，其次读取当前编辑任务的 `taskApiPreset`。
- 如果保存的任务 API 预设不在当前 API 预设列表中，追加不可用占位 option，避免静默丢失显示。

### 验收标准

- 修改子任务 API 后切换预设或新开对话，值仍可恢复显示。
- 预设不存在时显示不可用占位，不自动清空保存值。
- 运行时仍保留同 stage 统一 API 策略，不引入语义变更。

## 执行顺序

1. 写入本计划文档。
2. 修复向量每次输入强制重算与剧情推进门控延续。
3. 修复外部导入目标世界书传递。
4. 修复手动更新参数边界。
5. 修复最近 N 层候选字段集合。
6. 修复剧情子任务 API 编辑状态 flush 与下拉回填。
7. 运行类型检查/构建验证。

## 回归清单

- 向量功能开启：同文本连续发送两次，世界书条目内容应重新计算并覆盖。
- 向量功能开启：召回耗时较长时，剧情推进仍执行。
- 手动更新：同组不同模板自动参数的表，按手动参数处理。
- 手动更新：首次初始化保留模板基础数据。
- 外部导入：指定目标世界书生成完整条目集合。
- 最近 N 层：独立数据字段和隔离数据字段都会被清理。
- 剧情子任务 API：保存、切换预设、新开对话后保持显示与运行值一致。
