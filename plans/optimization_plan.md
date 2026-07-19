# 神化再临V10 数据库插件优化计划

## 概述

本次优化包含三个主要任务：
1. 修改0TK功能的开关控制
2. 优化剧情推进的$5占位符替换逻辑
3. 优化合并总结大纲功能

---

## 任务1: 修改0TK功能的开关控制

### 需求描述
当0TK占用模式启用时，除了关闭之前的条目外，还要额外关闭一个叫做 `TavernDB-ACU-CustomExport-纪要索引` 的条目（如果存在的话）。

### 当前逻辑分析
- **位置**: `index.js` 第 10561-10652 行
- **函数**: `updateOutlineTableEntry_ACU()`
- **当前行为**: 
  - 0TK占用模式启用时，只控制 `TavernDB-ACU-OutlineTable` 条目的 `enabled` 状态
  - 不涉及其他条目

### 修改方案

#### 1.1 修改 `updateOutlineTableEntry_ACU` 函数
**位置**: 第 10561-10652 行

在更新 `TavernDB-ACU-OutlineTable` 条目后，额外查找并更新 `TavernDB-ACU-CustomExport-纪要索引` 条目：

```javascript
// 在现有逻辑后添加：
// [新增] 同步更新"纪要索引"条目的enabled状态
const OUTLINE_INDEX_COMMENT = isoPrefix + 'TavernDB-ACU-CustomExport-纪要索引';
const existingIndexEntry = allEntries.find(e => e.comment === OUTLINE_INDEX_COMMENT);
if (existingIndexEntry) {
    if (existingIndexEntry.enabled !== outlineEntryEnabled) {
        await TavernHelper_API_ACU.setLorebookEntries(primaryLorebookName, [{
            uid: existingIndexEntry.uid,
            enabled: outlineEntryEnabled
        }]);
        logDebug_ACU(`Successfully updated 纪要索引 entry. enabled=${outlineEntryEnabled}`);
    }
}
```

#### 1.2 修改UI事件绑定
**位置**: 第 15920-15949 行

在0TK开关的change事件中，确保同步更新纪要索引条目：

```javascript
// 在现有的 updateOutlineTableEntry_ACU 调用后
// 函数内部已经会处理纪要索引条目，无需额外修改UI绑定
```

### 涉及代码行数
| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| `index.js` | 10630-10648 | 在更新OutlineTable条目后，添加纪要索引条目的同步更新逻辑 |

---

## 任务2: 优化剧情推进的$5占位符替换逻辑

### 需求描述
$5占位符现在应该优先替换成 `TavernDB-ACU-CustomExport-纪要索引` 条目里的内容，如果不存在这个世界书条目则再按照原本的逻辑替换（总体大纲表内容）。

### 当前逻辑分析
- **位置**: `index.js` 第 7294-7316 行
- **函数**: `runOptimizationLogic_ACU()` 中的 $5 处理部分
- **当前行为**: 
  - 直接从 `currentJsonTableData_ACU` 中读取"总体大纲"表内容
  - 调用 `formatOutlineTableForPlot_ACU()` 格式化输出

### 修改方案

#### 2.1 新增辅助函数：从世界书获取纪要索引内容
**位置**: 第 6435 行附近（`formatOutlineTableForPlot_ACU` 函数前）

```javascript
// [新增] 从世界书获取"纪要索引"条目内容（用于$5优先替换）
async function getSummaryIndexContentForPlot_ACU(plotSettings) {
    try {
        const plotCfg = plotSettings?.plotWorldbookConfig;
        const worldbookSource = plotCfg?.source || 'character';
        let bookNames = [];
        
        if (worldbookSource === 'manual' && plotCfg?.manualSelection?.length) {
            bookNames = plotCfg.manualSelection;
        } else {
            try {
                const charLorebooks = await TavernHelper_API_ACU.getCharLorebooks({ type: 'all' });
                if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
                if (charLorebooks.secondary) bookNames.push(charLorebooks.secondary);
            } catch (e) {
                return null;
            }
        }
        
        const isoPrefix = getIsolationPrefix_ACU();
        const targetComment = isoPrefix + 'TavernDB-ACU-CustomExport-纪要索引';
        
        for (const bookName of bookNames) {
            try {
                const entries = await TavernHelper_API_ACU.getLorebookEntries(bookName);
                const indexEntry = entries?.find(e => e.comment === targetComment && e.enabled);
                if (indexEntry?.content) {
                    logDebug_ACU('[剧情推进] $5 从世界书纪要索引条目获取成功');
                    return indexEntry.content;
                }
            } catch (e) {
                continue;
            }
        }
        return null;
    } catch (error) {
        logError_ACU('[剧情推进] 获取纪要索引条目失败:', error);
        return null;
    }
}
```

#### 2.2 修改 $5 占位符生成逻辑
**位置**: 第 7294-7316 行

```javascript
// [剧情推进] $5 优先从世界书"纪要索引"条目获取，若不存在则回退到"总体大纲"表
let outlineTableContent = '';
try {
    // 优先尝试从世界书获取纪要索引条目
    const summaryIndexContent = await getSummaryIndexContentForPlot_ACU(plotSettings);
    if (summaryIndexContent) {
        outlineTableContent = summaryIndexContent;
        logDebug_ACU('[剧情推进] $5 使用世界书纪要索引条目内容');
    } else {
        // 回退：从数据库读取总体大纲表
        if (!currentJsonTableData_ACU || typeof currentJsonTableData_ACU !== 'object') {
            try {
                const merged = await mergeAllIndependentTables_ACU();
                if (merged && typeof merged === 'object') {
                    currentJsonTableData_ACU = merged;
                }
            } catch (e) {}
        }
        if (currentJsonTableData_ACU && typeof currentJsonTableData_ACU === 'object') {
            outlineTableContent = formatOutlineTableForPlot_ACU(currentJsonTableData_ACU);
            logDebug_ACU('[剧情推进] $5 回退使用总体大纲表内容');
        } else {
            outlineTableContent = '总体大纲表：当前未加载到数据库数据。';
        }
    }
} catch (error) {
    logError_ACU('[剧情推进] 生成总体大纲表($5)时出错:', error);
    outlineTableContent = '{"error": "加载表格数据时发生错误"}';
}
```

### 涉及代码行数
| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| `index.js` | 6435 前 | 新增 `getSummaryIndexContentForPlot_ACU()` 函数 |
| `index.js` | 7294-7316 | 修改 $5 占位符生成逻辑，优先读取纪要索引条目 |

---

## 任务3: 优化合并总结大纲功能

### 需求描述
合并总结功能不再对总结表和总结大纲表生效，而是改为只对叫做"纪要表"的表格生效。该表格只有一个，不再有总结大纲表和总结表。因此对应的占位符号、默认提示词都要一并修改。

### 当前逻辑分析
- **DEFAULT_MERGE_SUMMARY_PROMPT_ACU**: 第 2831 行
- **handleManualMergeSummary_ACU**: 第 19995-20350 行
- **performAutoMergeSummary_ACU**: 第 19355-19700 行
- **checkAndTriggerAutoMergeSummary_ACU**: 第 19280-19350 行

### 修改方案

#### 3.1 修改默认合并提示词
**位置**: 第 2831 行

将提示词中的：
- "总结表" → "纪要表"
- "总体大纲" → 删除相关引用
- 两个表格 → 一个表格
- 占位符 `$A`（总结数据）和 `$B`（大纲数据）→ 合并为 `$A`（纪要数据）
- tableIndex 从 0/1 改为只有 0

新的提示词结构：
```javascript
const DEFAULT_MERGE_SUMMARY_PROMPT_ACU = `---BEGIN PROMPT---

[System]
你是"填表美杜莎"——一个执行型表格编辑AI。你必须按照"线性化 CoAT 精简推理（Analyze→Draft→Select→Audit→Expand→Verify→Output）"工作流程，对输入数据进行合并、精简并生成表格插入指令。

严禁输出冗长逐字推理链。对外输出采用 <thought> + <tableEdit> 双壳结构。
严禁输出"我将重复以上步骤直到…"等代码式循环描述；你只能在一次输出里给出线性化的推理日志与最终指令。

============================================================

[Input]
- TASK: 在 <已精简的数据> 基础上，将本批次的 <需要精简的纪要数据> 融合进去，对整体内容进行重新梳理和精简，最终通过 insertRow 指令写入表格。
- TARGET_COUNT: $TARGET_COUNT（目标条目数）

- 需要精简的纪要数据:
$A

- 已精简的数据（基础底稿，新增编码索引从 AM0001 开始，每次 +1）:
$BASE_DATA

============================================================

[Core Tables]
你需要维护一个表格：
1. **纪要表 (tableIndex=0)**：记录关键剧情纪要，包含以下列：
   - 列0: 时间跨度 - 本轮事件发生的精确时间范围
   - 列1: 地点 - 本轮事件发生的地点，从大到小描述
   - 列2: 纪要 - 以第三方视角客观记录本轮事件（≥300字）
   - 列3: 概要 - 一句话概括纪要内容（≤30字）
   - 列4: 编码索引 - 格式为 AMXXXX，XXXX从0001递增

============================================================

[Constraints — 硬约束，违反任意一条即判定输出无效]

C1-编码索引：每条纪要的编码索引（AM0001, AM0002, AM0003...）必须严格递增。
C2-纪要字数：每条纪要内容 ≥ 300 个中文字符 且 ≤ 400 个中文字符。
C3-条目数量：精简后的条目总数 = $TARGET_COUNT 条。
C4-编码连续：索引从 AM0001 起始，严格递增（AM0001→AM0002→AM0003→...），不跳号、不重复。
C5-内容完整：原始数据中的关键剧情节点、重要人物行为、因果关系不得丢失。
C6-时序正确：条目按时间线顺序排列，不得错乱。
C7-指令格式：仅使用 insertRow 操作，参数中 colIndex 必须是带双引号的字符串。

============================================================

[Scoring — 精简质量评估量表]

每完成一轮草稿后，按以下维度自检打分（Yes/No → 计数 → 0~1 分）：

(1) Fg — 生成质量分（0~1）：
- g1 约束满足（0~1）：C1~C7 是否全部满足；违反关键约束直接 = 0
- g2 信息保真（0~1）：关键剧情、人物、因果是否保留完整
- g3 精简有效（0~1）：是否去除了冗余/重复内容而非截断重要信息
- g4 时序连贯（0~1）：时间线是否合理无跳跃
- g5 语言质量（0~1）：表述通顺、无歧义、无矛盾

Fg = 0.30*g1 + 0.25*g2 + 0.20*g3 + 0.15*g4 + 0.10*g5

(2) 通过阈值：Fg ≥ 0.80 方可输出最终指令；否则必须触发修正。

============================================================

[Search Controller — 线性化精简推理流程]

你必须在 <thought> 中按以下 **严格顺序** 执行单轮或多轮推理，每轮包含：

── Round N ──

Step 1 — Analyze（分析）<|analyze|>
- 盘点 <已精简的数据> 中已有多少条目、当前索引编号
- 盘点 <需要精简的纪要数据> 中有多少条原始信息
- 计算需要新增的条目数 = $TARGET_COUNT - 已有条目数
- 识别数据中的重叠内容、可合并段落、时间线断点

Step 2 — Draft（草稿生成）<|draft|>
- 生成 2~3 种不同的合并/精简策略草稿（每条策略 ≤ 20 字概括）
- 策略之间角度明显不同（如：按时间段合并 / 按人物线合并 / 按事件因果链合并）

Step 3 — Select（选择最优策略）<|select|>
- 对每个草稿策略逐条检查：
· 约束满足率：能否满足 C1~C7？
· 信息保留度：哪种策略丢失最少关键信息？
· 字数可控性：哪种策略最容易控制在字数范围内？
- 选出 BestStrategy 并简述理由（1~2 句）

Step 4 — Expand（执行精简）<|expand|>
- 按 BestStrategy 将原始数据合并、压缩为目标条目
- 为每条生成：编码索引 + 时间跨度 + 地点 + 纪要 + 概要
- 严格遵循字数约束（纪要 ≥300 字，概要 ≤30 字）

Step 5 — Audit（硬约束审计）<|audit|>
- 逐条核查 C1~C7：
· C1：编码索引是否严格递增？
· C2：每条纪要是否在 300~400 字之间？（逐条估算）
· C3：总条目数是否 = $TARGET_COUNT？
· C4：索引是否从 AM0001 连续递增？
· C5：是否有关键剧情被遗漏？
· C6：时序是否正确？
· C7：insertRow 语法是否正确？
- 若任一约束不满足 → 标记问题 → 回到 Step 4 修正（最多修正 2 轮）

Step 6 — Score（打分判定）<|reflect|>
- 按评分量表对 g1~g5 逐项打分
- 计算 Fg
- Fg ≥ 0.80 → 进入输出阶段
- Fg < 0.80 → 记录教训 → 修正后重新评估（最多 1 次修正）

── 终止条件 ──
- 全部约束通过 + Fg ≥ 0.80 → 输出 <tableEdit>
- 修正轮次超限 → 输出当前最优结果并在 thought 中标注"预算终止"

============================================================

[Action-Thought Protocol]
- meta-action 标记（<|analyze|> <|draft|> <|select|> <|expand|> <|audit|> <|reflect|>）仅在 <thought> 内的步骤标题中使用，用于标识当前认知阶段。
- <tableEdit> 内严禁出现任何 meta-action 标记。
- <thought> 中的推理必须精炼简洁，但每个步骤不可跳过。

============================================================

[Output Format — 严格遵守]

输出必须且只能包含以下两个块，除此之外不得输出任何额外文字：

<thought>
（精炼的推理过程，按 Round/Step 展开：
- Step 1 Analyze: 数据盘点结论
- Step 2 Draft: 2~3 个策略草稿
- Step 3 Select: 选择理由
- Step 4 Expand: 精简执行要点（无需列出完整内容）
- Step 5 Audit: 逐条约束核查结果（通过/不通过）
- Step 6 Score: g1~g5 打分 → Fg 值 → 判定
不得写成冗长内心独白。）
</thought>

<tableEdit>
<!--

insertRow(0, {"0":"AM0001", "1":"时间跨度", "2":"地点", "3":"纪要内容（≥300字）", "4":"概要（≤30字）", "5":"编码索引"})

...（生成$TARGET_COUNT条的指令）

-->
</tableEdit>

============================================================

[Critical Reminders]

1. insertRow 的第一个参数是 tableIndex（0=纪要表），不是行号。
2. colIndex 必须用双引号包裹的字符串："0"、"1"、"2"等。
3. 纪要内容（列3）需 ≥300 字，概要（列4）需 ≤30 字。
4. 纯文本输出，严禁使用 markdown 代码块包裹整个输出。
5. 严禁在 <tableEdit> 块外添加任何解释性文字。

---END PROMPT---`;
```

#### 3.2 修改手动合并总结函数
**位置**: 第 19995-20350 行

主要修改点：
1. 查找表格时只查找"纪要表"
2. 删除所有"总体大纲"相关逻辑
3. 修改占位符：`$A` = 纪要数据，删除 `$B`
4. 修改确认对话框的提示文本

```javascript
// 查找纪要表（不再查找总结表和总体大纲）
const summaryKey = Object.keys(currentJsonTableData_ACU).find(k => 
    currentJsonTableData_ACU[k].name === '纪要表' || 
    currentJsonTableData_ACU[k].name === '总结表' // 兼容旧数据
);

if (!summaryKey) {
    showToastr_ACU('warning', '未找到"纪要表"，无法进行合并。');
    return;
}

let fullSummaryRows = summaryKey ? (currentJsonTableData_ACU[summaryKey].content || []).slice(1) : [];

// 删除 outlineKey 相关的所有逻辑
// ...
```

#### 3.3 修改自动合并总结函数
**位置**: 第 19355-19700 行

同样的修改逻辑：
1. 只查找"纪要表"
2. 删除"总体大纲"相关逻辑
3. 修改占位符

#### 3.4 修改自动合并触发检测函数
**位置**: 第 19280-19350 行

```javascript
async function checkAndTriggerAutoMergeSummary_ACU() {
    // 只检测纪要表的条数
    const summaryKey = Object.keys(currentJsonTableData_ACU).find(k => 
        currentJsonTableData_ACU[k].name === '纪要表' || 
        currentJsonTableData_ACU[k].name === '总结表'
    );
    
    if (!summaryKey) return;
    
    const summaryCount = (currentJsonTableData_ACU[summaryKey].content || []).slice(1).length;
    // ... 后续逻辑只处理纪要表
}
```

#### 3.5 修改UI提示文本
**位置**: 第 15102-15136 行

```html
<span style="font-size: 0.9em; font-weight: 500;">开启自动合并纪要</span>
<!-- ... -->
<i class="fa-solid fa-play" style="margin-right: 8px;"></i>开始合并纪要
```

### 涉及代码行数
| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| `index.js` | 2831 | 修改 `DEFAULT_MERGE_SUMMARY_PROMPT_ACU` 默认提示词 |
| `index.js` | 15102-15136 | 修改UI文本：合并总结 → 合并纪要 |
| `index.js` | 19280-19350 | 修改 `checkAndTriggerAutoMergeSummary_ACU()` 函数 |
| `index.js` | 19355-19700 | 修改 `performAutoMergeSummary_ACU()` 函数 |
| `index.js` | 19995-20350 | 修改 `handleManualMergeSummary_ACU()` 函数 |

---

## 实施顺序

1. **任务1** - 修改0TK功能开关控制（最简单，影响范围最小）
2. **任务2** - 优化$5占位符逻辑（中等复杂度）
3. **任务3** - 优化合并总结功能（最复杂，需要修改多处代码）
4. **更新README.md** - 记录本次修改

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 旧数据兼容性 | 用户可能有旧的"总结表"数据 | 在查找表格时同时兼容"纪要表"和"总结表"名称 |
| 世界书条目不存在 | 纪要索引条目可能未创建 | 使用 try-catch 包裹，优雅回退到原逻辑 |
| 提示词变更 | 用户可能已自定义提示词 | 保留用户自定义提示词，仅在恢复默认时使用新模板 |

---

## 测试要点

1. **0TK功能测试**
   - 启用0TK模式 → 验证纪要索引条目被禁用
   - 禁用0TK模式 → 验证纪要索引条目被启用
   - 纪要索引条目不存在时 → 不报错

2. **$5占位符测试**
   - 纪要索引条目存在且启用 → 使用条目内容
   - 纪要索引条目不存在 → 回退到总体大纲表
   - 纪要索引条目禁用 → 回退到总体大纲表

3. **合并纪要功能测试**
   - 只有纪要表 → 正常合并
   - 只有总结表（旧数据）→ 正常合并
   - 确认对话框显示正确信息
   - AI生成的指令格式正确（单表）
