# 模板切换「数据边界 Checkpoint」重构计划

> 目标路径：切换当前表格模板（chat scope）
> 方案核心：新增的表和列不再通过 log 内迁移契约表达，而是全部写入当前数据边界（最新 AI 楼层）的 per-sheet checkpoint。模板自带数据行则随 checkpoint 写入，没有则为空；历史楼层零补写（回放数据为空）；回放到边界时由 checkpoint 呈现新结构，最终快照正确显示。
> 状态：计划（未实施）
> 日期：2026-07-24

---

## 1. 三类报错的根因定位

### 1.1 错误一：新增 NOT NULL 列缺少可验证的 DDL literal DEFAULT

```text
表「重要角色表」无法协调：新增 NOT NULL 列「身份」缺少可验证的 DDL literal DEFAULT。
表「选项表」无法协调：新增 NOT NULL 列「选项五」缺少可验证的 DDL literal DEFAULT。
```

传播链：

```text
src/service/template/chat-template-reconciler.ts:315-316
  reconcileMatchedSheet_ACU 对每个新增列要求：
    NOT NULL 列 → parseDDLSafeDefaultLiteral_ACU(defaultExpression) 必须解析出白名单 literal
    解析失败 → throw
src/service/template/chat-template-reconciler.ts:100-101
  外层 catch 包装为 blocker「表「X」无法协调：...」
```

literal 白名单（src/shared/ddl-utils.ts:278-298）：NULL / TRUE / FALSE / X'..' blob / 安全整数 / 实数 / 单引号字符串。函数与表达式（CURRENT_TIMESTAMP、(unixepoch()) 等）一律拒绝。

本质：现有实现要求「历史行回填值」必须能从 DDL 静态证明，模板作者写 `身份 TEXT NOT NULL`（无 DEFAULT）即被拒绝。

### 1.2 错误二：definition/type 变更缺少 conversion policy

```text
sheet_in05z9vz: definition/type 变更缺少 conversion policy: quantity
sheet_lEARaBa8: definition/type 变更缺少 conversion policy: skill_level
```

传播链：

```text
src/service/template/chat-template-reconciler.ts:339
  协调器构造 intent 时硬编码 conversions: []
src/service/template/chat-template-reconciler.ts:114-119
  → preflightSchemaMigrations_ACU
src/service/table/schema-migration-preflight.ts:70
  → buildSheetSchemaMigrationOperationV2_ACU
src/service/table/table-schema-migration.ts:348-350
  getSemanticColumnDefinition_ACU(source) !== getSemanticColumnDefinition_ACU(target)
  且无 conversion → throw「definition/type 变更缺少 conversion policy: <col>」
src/service/table/schema-migration-preflight.ts:71-73
  → blocker「sheet_xxx: ...」
```

本质：迁移契约规定「列语义定义（类型/NOT NULL/DEFAULT/CHECK 任一）变化必须显式声明 identity/stringify/integer_strict/real_strict 转换策略」，而模板协调器没有能力生成任何策略——它能识别变更，却把决策位留空。

### 1.3 错误三：缺少 row_id 首列表头

```text
缺少 row_id 首列表头。
```

来源：src/service/template/chat-template-reconciler.ts:221-225 `headers_ACU`（`content[0][0] !== 'row_id'` 即 throw）。

关键缺陷——两处调用未被 try/catch 包裹，裸异常直接穿透：

```text
chat-template-reconciler.ts:84   asHeaderOnlySheet_ACU（introduced 新表分支）
chat-template-reconciler.ts:109  headers_ACU(sheet)（deleted 表 audit 分支）
```

且 template-preset-service.ts:380 调用 `reconcileChatTemplate_ACU` 也无 try 包裹，异常带不上任何 sheetKey/表名上下文直接抛到 UI。错误文本无定位信息即源于此。最可能触发场景：导入模板中某张新表的 `content[0]` 首列不是 `row_id`（如首列是「姓名」、`行号`、`id`，或 content 为空）。

---

## 2. 目标语义与不变量

用户思路的工程化表述：

```text
S1  切换模板产生的一切结构变更（新表、新列、列定义变化、列删除/隐藏、元数据变化），
    统一表达为「当前数据边界（最新 AI 楼层 frame）上的 per-sheet full checkpoint」。
S2  checkpoint.data 是协调器在 JS 层直接算好的目标 sheet 全量（结构+数据）：
      - 模板自带数据行（新表）→ 随 checkpoint 写入；
      - 模板无数据行 → 只有表头，显示为空；
      - 既有表的历史行 → 保留匹配列数据，新列按填充规则得值。
S3  历史楼层零补写：不向任何旧楼层追加操作或 patch，旧 frame 原样不动
    （"每层楼对应的回放数据为空"——新表/新列在旧楼层根本不存在，这是合法状态）。
S4  回放确定性：checkpoint 分片带 afterSeq 定位，回放到边界楼层时在既有日志之后
    整表替换生效；边界之前的回放视图保持旧结构（"最后回放为快照时正确显示"）。
S5  唯一门禁 = 真实 SQLite strict hydrate（hydrateTableDataStrict_ACU，生产 SyncBridge
    同路径）。不再要求「DDL 静态可证明」的双重契约；NOT NULL/CHECK/类型由 SQLite 裁决，
    裁决失败 → 提交前 blocker（带表/列定位），绝不落盘半成品。
```

不变量（重构后必须依然成立）：

```text
I1  V2 回放对同一 chat 输入永远产生同一状态（append-only + seq 保序 + checkpoint 整量替换）。
I2  已存在的历史 sheet_schema_migrate 日志永久可读（回放读路径不删除、不改语义）。
I3  legacy-v1 聊天继续被拒绝进入 V2 模板提交（persist:1843-1849 现有行为）。
I4  visualizer 保存路径与模板助手路径的迁移契约不受影响（见 §4.7）。
I5  提交事务性：guideData + scope + checkpoint 同事务写入，失败整体回滚
    （persist 现有 snapshot/restore 机制）。
```

---

## 3. 现有机制盘点（方案的落点依据）

### 3.1 已存在的「数据边界 checkpoint」机制

`TableSheetCheckpointV2_ACU`（storage-frame-v2-types.ts:97-108）：`kind:'sheet_full'` 整表快照，可带 `timeline`。

`TableSheetIntroductionTimelineV2_ACU`（storage-frame-v2-types.ts:89-95）：

```ts
{ kind: 'sheet_introduction'; activateAtMessageIndex: number; afterSeq: number }
```

新表引入已经走这条通道：commitCurrentFloorTemplateChanges_ACU 为每个 introduction 写 per-sheet checkpoint（reason='schema_change'，afterSeq=当前帧最后 seq，persist:2016-2044）。**这正是用户思路在新表维度的既有实现——本计划把它推广到"既有表的结构变更"维度。**

### 3.2 回放顺序（storage-frame-v2-replay.ts:688-785）

```text
1. 找最近 full checkpoint → state = checkpoint.data
2. 从该楼层起逐 frame：
   a. 无 timeline 的 per-sheet checkpoint → 在该 frame 全部日志之前整表替换
   b. logEntries 按 seq 升序应用；带 timeline 的分片按 afterSeq < nextSeq 插入
      （applyDueIntroductions，replay:735-745）
3. frame 末尾 flush 剩余分片（afterSeq=∞ 场景，replay:777）
```

推论：**既有表的结构变更 checkpoint 必须带 timeline（afterSeq 定位）**。若不带，回放时会在该 frame 已有日志之前应用——当前楼层已被 AI 填表过时顺序错误。

### 3.3 模板提交双通道（storage-frame-v2-persist.ts:1797-2115）

```text
introduction 变更 → per-sheet checkpoint + timeline（守卫：header-only :1980-1982；全新表 :2016-2023）
operations 变更   → mutation log entry 携带 sheet_schema_migrate + meta_update（:2046-2072）
                    ← 本计划要替换的通道
pristine 预填表   → full checkpoint(reason='init') + 每表 initial checkpoint，强制剥数据行（:1896-1901）
```

### 3.4 验证体系现状

```text
双重契约（要删的）：fills/conversions 静态契约（table-schema-migration.ts:327-356）
                    + dryRun 逐行一致性（:358-381）
唯一门禁（要留的）：hydrateTableDataStrict_ACU —— 真实 SQLite 执行 DDL + 全部行插入
                    （sqlite-template-validation.ts:8-17；reconciler:149-158 已对完整
                    replay 后 candidate 执行）
```

### 3.5 迁移契约的其他调用方（不动区）

```text
src/service/template-assistant/service.ts:1201,1343   模板助手
src/presentation-v2/composables/visualizer/useVisualizerSave.ts:519   可视化编辑器保存
src/presentation/pages/visualizer-template-assistant-apply.ts:31      旧版助手应用
```

`preflightSchemaMigrations_ACU`、`buildSheetSchemaMigrationOperationV2_ACU`、`applySheetSchemaMigrationOperation_ACU` 本体保留不动。

---

## 4. 方案设计

### 4.1 新 timeline kind：`sheet_rebase`

storage-frame-v2-types.ts 扩展：

```ts
export interface TableSheetRebaseTimelineV2_ACU {
  kind: 'sheet_rebase';
  /** rebase 分片所在的 AI message index。 */
  activateAtMessageIndex: number;
  /** 同一 frame 中在该 seq 之后才用 checkpoint.data 整表替换 replay state。 */
  afterSeq: number;
}

// TableSheetCheckpointV2_ACU.timeline 类型放宽为：
timeline?: TableSheetIntroductionTimelineV2_ACU | TableSheetRebaseTimelineV2_ACU;
```

语义对比：

| 维度 | sheet_introduction | sheet_rebase |
|---|---|---|
| 写入守卫 | 表必须**不**存在于 active replay state | 表必须**已**存在于 active replay state |
| checkpoint.data | 模板新表（结构 + 模板数据行） | 协调器算好的迁移后全量（结构 + 迁移数据行） |
| 回放行为 | afterSeq 之后把新表加入 state | afterSeq 之后整表替换 state[sheetKey] |
| 调度摘要 | 继承既有 scheduleSummary | 继承既有 scheduleSummary（同 introduction :2028-2035） |

选择新增 kind 而非复用 introduction 的原因：两者写入守卫互斥（存在性检查方向相反），复用会迫使守卫退化为"不检查"，丢失 introduction 现有的防覆盖保护（persist:2016-2023 防止新表意外覆盖同 key 旧数据）。

### 4.2 协调器改造：直接产出迁移后数据（chat-template-reconciler.ts）

`reconcileMatchedSheet_ACU` 从「产出 SchemaMigrationPreflightIntent（fills/conversions 契约）」改为「产出迁移后的完整 sheet 数据」。列匹配逻辑（canonical 名匹配 → 同 key 下 physical 名匹配、hiddenPhysicalColumns 保留链、DDL 重建 buildRetainedColumnDDL_ACU、physical 复用防护 :309-311、meta delta 计算）全部保留，仅替换产出物：

```text
迁移后行计算（纯 JS，替代 buildMigratedSheetV2_ACU 的契约驱动版本）：
for row of before.content[1..]:
  targetRow = [激活列(目标顺序) ..., 保留隐藏列 ...]
  每个目标列 c：
    有匹配来源列（canonical 或 physical mapping）→ 原值直通（字符串保真，不转换）
    无来源（新增列）→ fillValueFor(c)
  隐藏保留列 → 原值直通
```

新列填充规则表（替代 fills 契约，错误一的消解）：

| 目标列定义 | 填充值 | 依据 |
|---|---|---|
| 有可解析 literal DEFAULT（任意 nullability） | 该 literal（literalToCellValue 语义：boolean→'1'/'0'，null→null，其余 String(value)） | 与 SQLite 实际 DEFAULT 一致 |
| NOT NULL、无可解析 DEFAULT | `''`（空字符串——"显示为空"的合法 NOT NULL 表达） | S2/S5；SQLite 弱类型下 '' 可入任意声明类型列 |
| nullable、无 DEFAULT | `null` | 显示为空 |

定义变更列（错误二的消解）：**原值直通，零转换**。SQLite 弱类型保证绝大多数直通可行（如 `quantity TEXT → INTEGER NOT NULL DEFAULT 1 CHECK(quantity>0)`：旧值 '3' 正常，旧值 '三个' 以 TEXT affinity 存储且 `TEXT > INTEGER` 在 SQLite 排序规则下恒真，CHECK 通过）。不可行的个别行（如 quantity='0' 违反 CHECK）由 §4.6 的 hydrate 裁决拦截并精确报错。conversion policy 概念从模板路径整体移除。

产出物类型变化（storage-frame-v2-persist.ts 的 `TemplateSheetChange_ACU`）：

```ts
// 现有：{ kind: 'introduction', sheetKey, sheetData }
//       { kind: 'operations', sheetKey, targetSheetData, operations }   ← 模板路径停用
// 新增：{ kind: 'rebase', sheetKey, sheetData: Sheet_ACU }              ← 迁移后全量
```

协调器主流程（reconcileChatTemplate_ACU）随之简化：

```text
删除：intents 收集、preflightSchemaMigrations_ACU 调用（:113-125）、
      applyTableOperationV2_ACU 逐操作 replay（:126-127）、operations 组装（:137-146）
保留：名称/key 匹配、blocker 收集、deleted 清扫、audit（operations 字段改记
      { kind: 'rebase' } / { kind: 'introduction' }）、meta_update 并入 rebase
      checkpoint.data（sheet 全量自带 name/orderNo/sourceData/updateConfig/exportConfig，
      无需独立 meta_update 操作）
保留并强化：末段完整 candidate 的 validateDDLTextAgainstHeaders + getSheetColumnProjection
      + hydrateTableDataStrict（:149-158）——升级为唯一门禁，错误信息按 §4.6 增强
```

### 4.3 模板数据行随 checkpoint 写入（introduction 与 pristine 统一）

「模板里本身有数据就把数据写进去，没有就显示为空」：

```text
a. reconciler asHeaderOnlySheet_ACU（:227-233）：不再剥离数据行。
   保留 uid===key 校验；数据行经规范化（row_id 唯一性、列宽一致）后随 introduced sheet 进入
   candidateData。
b. persist introduction 守卫（:1980-1982 content.length!==1 → throw）：删除 header-only
   限制，改为 normalizeCanonicalTableRows_ACU 规范校验（该调用已存在于 :1983-1987，直接
   承担全部行合法性）。
c. pristine 预填表路径（:1896-1901 强制 content=[headers]）：同样放开——checkpoint.data
   保留模板数据行，full checkpoint 与 per-sheet initial checkpoint 一致携带。
d. seedRows 字段本身的既有通道不变：仍经 stripRuntimeSeedRows 剥离出 candidate、经
   guideData 保留、由 materializeSeedRowsForDslReplay 延迟物化。本计划只改变
   sheet.content 数据行的去向，不重定义 seedRows。
```

区分两条数据通道的语义边界：`content[1..]`（模板实体数据）→ 直接落 checkpoint，立即可见；`seedRows`（AI 首填种子）→ 维持延迟物化。模板作者用哪个字段表达哪种意图不变。

### 4.4 row_id 规范化与错误可观测性（错误三的消解）

```text
a. 输入规范化（reconciler 入口新增 normalizeTemplateSheetRowIdColumn_ACU，仅作用于
   templateData 侧）：
   - content[0] 存在但首列不是 'row_id'：
     · 若 'row_id' 出现在其他位置 → blocker（位置错误不可自动修复，带表名/key）
     · 若完全没有 'row_id' → 表头前插 'row_id'，数据行前插顺序行号（'1','2',...），
       DDL 前插 `row_id INTEGER PRIMARY KEY`（无 DDL 时走既有 generateDDL 兜底）
   - content 为空/content[0] 非数组 → blocker（带表名/key）
   基线（当前聊天）侧不自动修复——基线不满足 canonical 契约属于数据损坏，保持
   validateBaselineSheetRows_ACU 现有 blocker 行为。
b. 错误上下文补全：
   - headers_ACU 增加调用方传入的上下文参数：『表「NAME」(KEY) 缺少 row_id 首列表头。』
   - :84 introduced 分支、:109 deleted 分支包 try/catch 收敛为 blocker。
   - template-preset-service.ts:380 reconcile 调用包 try，异常转
     { saved:false, error } 返回，杜绝裸异常穿透 UI。
```

### 4.5 persist 端改造（storage-frame-v2-persist.ts）

`commitCurrentFloorTemplateChanges_ACU`：

```text
a. assertValidTemplateSheetChanges_ACU（:1746）接受新 kind 'rebase'（sheetKey 唯一性、
   sheetData 结构校验与 introduction 同规）。
b. rebase 变更处理（新增，紧邻 introduction 块 :2016-2044）：
   - 守卫：sheet 必须存在于 activeReplayState（与 introduction :2019 相反）；
     不得与 deletedSheetKeys 重叠；createdAt 单调性守卫（:2024-2027 同款）。
   - 写 per-sheet checkpoint：kind='sheet_full'，reason='schema_change'，
     data=change.sheetData，scheduleSummary 继承（:2028 同款），
     timeline={ kind:'sheet_rebase', activateAtMessageIndex:target.index,
                afterSeq:targetFrameLastLogSeq }，baseRevision 同 introduction。
c. operations 通道（:2046-2072）：模板路径不再产出 operations 类变更后，该块对
   'rebase' 无操作；块本身保留（其他调用方 assertValidTemplateMetaUpdate 等结构不动），
   但在 assertValidTemplateSheetChanges 中拒绝模板协调器新产出的
   sheet_schema_migrate（防止旧调用方混入）——具体拒绝范围实施时按调用方清单核实。
d. 行数据校验：rebase/introduction 共用既有 normalizeCanonicalTableRows +
   validateDDLTextAgainstHeaders + createSheetInsertPlan（:1983-2000），天然覆盖
   携带数据行的新语义。
e. headRevision 推进：写 checkpoint 后按现有 buildCommitRevision_ACU('checkpoint',...)
   语义推进（与 pristine 路径 :1931 一致；实施时核实非 pristine 路径当前是否推进，
   若仅靠 log entry 推进则 rebase-only 提交需补 checkpoint revision）。
```

`persistTableSheetCheckpointV2_ACU` / `validateSheetCheckpointInput_ACU`（:900-1113）：校验逻辑按新 timeline kind 分派（introduction 校验保持，rebase 走存在性反向守卫）。

### 4.6 replay 端改造与失败可观测性（storage-frame-v2-replay.ts）

```text
a. getValidatedSheetCheckpoints_ACU（:115-147）：timeline 校验放宽为两种 kind 皆合法
   （字段校验同构：activateAtMessageIndex/afterSeq 数值校验）。
b. getValidatedIntroductionsForFrame_ACU（:168-179）：改名或扩展为「timeline 分片收集」，
   introduction 与 rebase 同队列按 afterSeq 插入（applyDueIntroductions :735-745 逻辑
   不变，天然支持——整表替换语义对两种 kind 相同：state[sheetKey]=data）。
c. applySheetCheckpointsForReplay_ACU（:264-274）：确认 runtime.loaded 时的 SQLite
   重载路径对 rebase 生效（结构变更必须触发 runtime 重建表；实施时核实该函数
   是否已调用 reloadSqlReplayRuntime_ACU，introduction 依赖同一行为）。
d. collectScheduleSummaryFromFramesV2_ACU（:637-686）：pendingIntroductions 队列同样
   纳入 rebase 分片（scheduleSummary 继承语义一致）。
e. historyContainsOrCannotDisproveSheet_ACU / checkpointIsValidForIntroductionHistory_ACU
   / logEntryConflictsWithSheetCheckpoint_ACU（persist:566-897）：识别集合加入
   'sheet_rebase'。
f. hydrate 失败可观测性（reconciler 末段 :156-157 与 persist :1996-1998）：
   错误信息升级为『表「NAME」(KEY) 列「COL」…（SQLite: 原始错误）』——SyncBridge
   strict 插入失败时携带 sheetKey 与行 row_id；具体注入点在 SyncBridge.loadFromTableData
   的错误包装层，实施时核实其现有错误结构后最小侵入增强。
   血量下限：至少做到 reconciler/persist 两处 catch 时补上 sheetKey 前缀。
```

### 4.7 兼容性策略

```text
a. 读路径永久兼容：applyTableOperationV2_ACU 对 sheet_schema_migrate 的回放
   （table-schema-migration.ts applySheetSchemaMigrationOperation_ACU）原样保留。
   历史聊天中已落盘的迁移日志继续可读（不变量 I2）。
b. 写路径收敛：仅模板协调器停止产出 sheet_schema_migrate/meta_update 操作。
   preflightSchemaMigrations_ACU 及三个外部调用方（template-assistant、
   useVisualizerSave、visualizer-template-assistant-apply）契约与行为零变化。
c. schema-migration-preflight.ts：chat-template-reconciler 移除 import 后若无其他
   变化则文件不动；不删除任何导出。
d. 数据格式前向兼容风险：旧版本代码读到 'sheet_rebase' timeline 会因
   getValidatedSheetCheckpoints 校验失败而拒绝回放（fail-closed，不产生错误数据）。
   与项目既有升级策略一致（V2 协议内 additive 变更）。
e. compaction/清理链路：full checkpoint 前移（boundary compaction）时 per-sheet
   分片随 frame 吸收进新 full checkpoint 的既有行为覆盖 rebase（分片被 full
   checkpoint.data 取代后不再需要）；实施时在 compaction 模块（核实实际文件，
   设计文档指向 storage-frame-v2-compaction.ts，当前仓库以 mixed-storage-* 承载）
   补一条「rebase 分片吸收」回归测试。
```

---

## 5. 边界条件清单

| # | 场景 | 预期行为 |
|---|---|---|
| E1 | 新增 NOT NULL 列无 DEFAULT 且带 CHECK（如 `CHECK(x>0)`），空串填充无法通过 CHECK | hydrate 失败 → 提交前 blocker：『表「X」列「Y」的历史行回填值无法满足约束，请为该列提供 DEFAULT 或放宽约束（SQLite: ...）』；绝不落盘 |
| E2 | 定义变更列的个别历史值违反新 CHECK（如 quantity='0' vs CHECK(quantity>0)） | hydrate 失败 → blocker 带 sheetKey/列名/首个失败 row_id |
| E3 | 当前楼层 frame 已有 AI 填表日志时切换模板 | rebase checkpoint afterSeq=当前帧最后 seq；回放中新结构在既有日志之后生效 |
| E4 | 同一楼层多次切换模板 | perSheetCheckpoints 按 sheetKey 覆盖；createdAt 单调性守卫拒绝时钟回拨覆盖（沿用 :2024-2027） |
| E5 | 模板删除表 A 且新增同名不同 key 的表 B | deletedSheetKeys 清扫 + introduction 存在性守卫组合；名称/key 冲突仍走 reconciler :69-71 blocker；列入回归测试 |
| E6 | 隐藏列保留链（hiddenPhysicalColumns） | rebase checkpoint.data 的 DDL 含 retained 列（buildRetainedColumnDDL 不变），行数据直通同步保留隐藏列值 |
| E7 | 模板表首列非 row_id / content 为空 | 可修复（无 row_id）→ 自动注入；不可修复（错位/空 content）→ blocker 带表名与 key；不再裸异常 |
| E8 | pristine 预填表路径携带模板数据行 | 与非 pristine 语义统一：checkpoint 保留数据行；seedRows 通道不变 |
| E9 | legacy-v1 聊天切换模板 | 现有拒绝路径不变（persist:1843-1849），提示先完成迁移 |
| E10 | 历史聊天含旧 sheet_schema_migrate 日志 | 回放读路径永久保留；新提交不再产出该类操作；新旧操作在同一聊天中共存可回放 |

---

## 6. 分步实施顺序

> 排序依据：风险从高到低——先动定义与回放（错则全链路崩），后动入口收敛与观测性。

```text
step 1  类型与回放识别（高风险，先行）
        文件：storage-frame-v2-types.ts、storage-frame-v2-replay.ts
        改动：TableSheetRebaseTimelineV2_ACU；timeline 联合类型；
              getValidatedSheetCheckpoints / getValidatedIntroductionsForFrame /
              collectScheduleSummaryFromFramesV2 识别 rebase；
              核实 applySheetCheckpointsForReplay 的 runtime 重载行为。
        验证：storage-frame-v2-replay.test.ts 新增 rebase 分片回放用例（含 E3 顺序用例）。

step 2  persist 守卫与 rebase 写入
        文件：storage-frame-v2-persist.ts
        改动：TemplateSheetChange 联合类型 + assertValidTemplateSheetChanges；
              commitCurrentFloorTemplateChanges 的 rebase 块（§4.5b）；
              introduction/pristine 放开数据行（§4.3b/c）；
              validateSheetCheckpointInput / historyContains… / logEntryConflicts…
              / checkpointIsValidForIntroductionHistory 识别集合更新；
              headRevision 推进核实（§4.5e）。
        验证：storage-frame-v2-persist.test.ts：rebase 提交、带数据行 introduction、
              pristine 带数据行、E4/E5/E9 用例。

step 3  协调器核心改造
        文件：chat-template-reconciler.ts
        改动：reconcileMatchedSheet 产出迁移后 sheet（§4.2 填充规则表）；
              删除 intents/preflight/operations 组装；audit 调整；
              asHeaderOnlySheet 放开数据行；meta 并入 checkpoint。
        验证：chat-template-reconciler.test.ts 重写 matched 场景断言
              （fills/conversions 断言 → rebase 数据断言）；错误一/二场景转绿。

step 4  row_id 规范化与错误上下文
        文件：chat-template-reconciler.ts、template-preset-service.ts
        改动：normalizeTemplateSheetRowIdColumn（§4.4a）；headers_ACU 上下文；
              :84/:109 包 try；:380 调用包 try。
        验证：错误三场景用例（自动注入成功 + 错位 blocker 带表名）。

step 5  hydrate 失败信息增强
        文件：sync-bridge.ts（错误包装层，最小侵入）或 reconciler/persist catch 层
        改动：§4.6f。
        验证：E1/E2 用例断言错误文本含表/列定位。

step 6  compaction/清理回归
        文件：实施时核实（mixed-storage-* / 清理链路）
        改动：仅补测试——boundary compaction 吸收 rebase 分片、清理不破坏恢复链。

step 7  集成回归
        运行：tests/service/template/*、tests/service/table/storage-frame-v2-*、
              tests/integration/table-*（checkpoint roundtrip / lifecycle / import-commit）。

step 8  文档同步
        文件：docs/table-storage-v2-checkpoint-log-refactor.md（timeline kind 增补）、
              docs/table-checkpoint-import-export.md（模板数据行语义）。
```

---

## 7. 测试计划（桩点）

```text
tests/service/table/storage-frame-v2-replay.test.ts
  R1 rebase 分片在 afterSeq 之后整表替换（E3：前置日志先应用）
  R2 rebase 前的历史楼层回放视图保持旧结构（S4）
  R3 introduction 与 rebase 同帧共存按各自 afterSeq 生效
  R4 非法 timeline kind fail-closed（§4.7d）
  R5 旧 sheet_schema_migrate 日志与新 rebase 分片同聊天共存回放（E10）

tests/service/table/storage-frame-v2-persist.test.ts
  P1 rebase 提交写入 perSheetCheckpoints + timeline 字段完整
  P2 rebase 守卫：表不存在 → 拒绝；与 deletedSheetKeys 重叠 → 拒绝
  P3 introduction 携带数据行提交成功；行标识非法 → 拒绝
  P4 pristine 预填表携带数据行（E8）
  P5 同楼层重复提交覆盖 + createdAt 回拨拒绝（E4）
  P6 legacy 聊天拒绝不变（E9）

tests/service/template/chat-template-reconciler.test.ts
  C1 新增 NOT NULL 无 DEFAULT 列 → 空串填充成功（错误一转绿）
  C2 新增 NOT NULL 带 literal DEFAULT → literal 填充
  C3 定义变更列原值直通（错误二转绿：quantity/skill_level 同构场景）
  C4 直通值违反 CHECK → blocker 带定位（E1/E2）
  C5 模板缺 row_id 自动注入；row_id 错位 → blocker 带表名（错误三转绿）
  C6 隐藏列数据保留（E6）
  C7 audit 结构：rebase/introduction 记录、fills/conversions 字段移除后的兼容
  C8 删除+同名新增组合（E5）

tests/presentation-v2/visualizer/use-visualizer-save.test.ts（回归，不改断言）
  V1 visualizer 迁移契约路径行为零变化（I4）
```

---

## 8. 验收标准（用户三个报错逐一映射）

```text
A1 「重要角色表/选项表：新增 NOT NULL 列缺少可验证的 DDL literal DEFAULT」
   → 同一模板重新切换：协调成功。历史行新列显示为空（''），新楼层数据按新结构写入。
   仅当空值确实无法满足列约束（E1）时才出现 blocker，且信息精确到表/列并给出修复建议。

A2 「sheet_in05z9vz/sheet_lEARaBa8: definition/type 变更缺少 conversion policy」
   → 同一模板重新切换：协调成功，quantity/skill_level 历史值原样保留；
   回放快照中两表结构为新定义。个别行违反新 CHECK 时 blocker 精确到行（E2）。

A3 「缺少 row_id 首列表头。」
   → 缺失场景自动注入后协调成功；不可修复场景报
   『表「X」(sheet_yyy) …』并列出全部问题表，不再出现无定位裸错误。

A4 通用回放正确性：切换后 (a) 历史楼层回放视图 = 旧结构旧数据；(b) 边界及之后
   = 新结构；(c) 关闭重开聊天 loadTableStateFromFramesV2 与切换时视图一致；
   (d) validateCurrentChatTableRecovery 通过。
```

---

## 9. 非目标

```text
N1 不改 visualizer 保存 / 模板助手两条迁移契约路径（它们面向单表显式编辑，
   契约语义仍是正确工具）。
N2 不做 legacy-v1 → V2 隐式迁移；legacy 拒绝行为不变。
N3 不清理、不改写历史聊天中已存在的 sheet_schema_migrate 日志。
N4 不重定义 seedRows 机制（延迟物化通道原样保留）。
N5 不引入 per-sheet checkpoint 体积治理新策略（沿用既有 compaction 阈值；
   大表频繁切换的体积放大记录为已知代价，见 §4.7e）。
```
