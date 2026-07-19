# Seed关键词解析来源优化计划

## 需求概述

将seed关键词解析来源从"表格内容和上轮推进数据"改为"最新一层的推进数据和最新一层的AI回复正文"。

## 当前实现分析

### 当前seed关键词解析来源

1. **表格内容**（`formatNonSummaryTablesForSeed_ACU`）
   - 位置：`index.js:10335-10375`
   - 功能：获取除纪要表以外的所有数据库表格内容
   - 格式：将表格数据格式化为文本

2. **上轮推进数据**（`getPlotFromHistory_ACU`）
   - 位置：`index.js:11955-12026`
   - 功能：从聊天记录中反向查找最新的plot数据

### 当前调用位置

| 位置 | 行号 | 说明 |
|------|------|------|
| 正文优化 | 2182-2183 | `seedContentForConditional = formatNonSummaryTablesForSeed_ACU(...)` |
| 提示词模板 | 11215-11229 | `parseConditionalTemplate_ACU(templateContent, seedContent, allTablesJson, plotContent)` |
| 剧情推进 | 12565-12606 | `seedContentForConditional = formatNonSummaryTablesForSeed_ACU(...)` + 添加lastPlotContent |
| 填表 | 24658-24660 | `seedContent: filterTableInjectedContent(dynamicContent.messagesText, '$1') + '\n' + (lastPlotContent || '')` |

## 新实现方案

### 数据来源变更

| 原来源 | 新来源 | 说明 |
|--------|--------|------|
| 表格内容 | ~~移除~~ | 不再使用表格内容作为seed关键词解析来源 |
| 上轮推进数据 | 最新一层推进数据 | 继续使用`getPlotFromHistory_ACU()` |
| - | 最新一层AI回复正文 | 新增：获取最新一条AI消息的`mes`字段 |

### 新增函数

#### 1. `getLatestAIMessageContent_ACU()`

```javascript
/**
 * 获取最新一条AI消息的正文内容
 * @returns {string} - 最新AI消息的mes字段内容，如果没有则返回空字符串
 */
function getLatestAIMessageContent_ACU() {
  const chat = SillyTavern_API_ACU.chat;
  if (!chat || chat.length === 0) return '';
  
  // 从后往前遍历查找最新的AI消息
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && !chat[i].is_user) {
      return chat[i].mes || '';
    }
  }
  return '';
}
```

### 修改函数

#### 1. `evaluateSeedExpression_ACU()`

**位置**: `index.js:10390-10480`

**修改内容**:
- 参数变更：`content` 参数含义从"表格内容"改为"最新AI回复正文"
- 文档注释更新

```javascript
/**
 * 解析关键词表达式并判断是否匹配
 * ...
 * @param {string} content - 待检测的内容（最新AI回复正文）
 * @param {string} plotContent - 最新推进数据，可选
 * @returns {boolean} - 是否匹配
 */
function evaluateSeedExpression_ACU(expression, content, plotContent = '') {
  // ... 逻辑不变，只是数据来源变了
}
```

### 调用位置修改

#### 1. 正文优化场景 (`index.js:2181-2184`)

**修改前**:
```javascript
const seedContentForConditional = formatNonSummaryTablesForSeed_ACU(currentJsonTableData_ACU);
const contextForIf = { seedContent: seedContentForConditional, allTablesJson: currentJsonTableData_ACU, plotContent: '' };
```

**修改后**:
```javascript
const latestAiContent = getLatestAIMessageContent_ACU();
const latestPlotContent = getPlotFromHistory_ACU();
const contextForIf = { seedContent: latestAiContent, allTablesJson: currentJsonTableData_ACU, plotContent: latestPlotContent };
```

#### 2. 提示词模板场景 (`index.js:11497-11506`)

**修改前**:
```javascript
const lastPlotContent = getPlotFromHistory_ACU();
const context = {
  seedContent: getSeedContentForPrompt_ACU(),  // 表格内容
  allTablesJson: getTableDataForPrompt_ACU(),
  plotContent: lastPlotContent
};
```

**修改后**:
```javascript
const lastPlotContent = getPlotFromHistory_ACU();
const latestAiContent = getLatestAIMessageContent_ACU();
const context = {
  seedContent: latestAiContent,  // 最新AI回复正文
  allTablesJson: getTableDataForPrompt_ACU(),
  plotContent: lastPlotContent
};
```

#### 3. 剧情推进场景 (`index.js:12565-12606`)

**修改前**:
```javascript
let seedContentForConditional = '';
try {
  if (currentJsonTableData_ACU && typeof currentJsonTableData_ACU === 'object') {
    seedContentForConditional = formatNonSummaryTablesForSeed_ACU(currentJsonTableData_ACU);
  }
  if (lastPlotContent && typeof lastPlotContent === 'string') {
    seedContentForConditional += '\n' + lastPlotContent;
  }
} catch (e) { ... }
// ...
const contextForIf = { seedContent: seedContentForConditional, allTablesJson: currentJsonTableData_ACU, plotContent: '' };
```

**修改后**:
```javascript
let seedContentForConditional = '';
try {
  // 获取最新AI回复正文
  seedContentForConditional = getLatestAIMessageContent_ACU();
  // 添加最新推进数据
  if (lastPlotContent && typeof lastPlotContent === 'string') {
    seedContentForConditional += '\n' + lastPlotContent;
  }
} catch (e) { ... }
// ...
const contextForIf = { seedContent: seedContentForConditional, allTablesJson: currentJsonTableData_ACU, plotContent: lastPlotContent };
```

#### 4. 填表场景 (`index.js:24658-24660`)

**修改前**:
```javascript
const templateContext = {
  seedContent: filterTableInjectedContent(dynamicContent.messagesText, '$1') + '\n' + (lastPlotContent || ''),
  allTablesJson: currentJsonTableData_ACU
};
```

**修改后**:
```javascript
const latestAiContent = getLatestAIMessageContent_ACU();
const templateContext = {
  seedContent: latestAiContent,
  allTablesJson: currentJsonTableData_ACU,
  plotContent: lastPlotContent || ''
};
```

## 实施步骤

1. **新增函数** `getLatestAIMessageContent_ACU()`
   - 位置：在 `getPlotFromHistory_ACU()` 函数附近（约 `index.js:11950` 附近）
   - 行号区间：待确定

2. **修改函数** `evaluateSeedExpression_ACU()` 的文档注释
   - 位置：`index.js:10377-10389`
   - 更新参数说明

3. **修改调用位置**
   - 正文优化：`index.js:2181-2184`
   - 提示词模板：`index.js:11497-11506`
   - 剧情推进：`index.js:12565-12606`
   - 填表：`index.js:24658-24660`

4. **更新README.md**
   - 记录本次修改的功能描述
   - 记录修改的函数和行号区间

## 注意事项

1. `formatNonSummaryTablesForSeed_ACU` 函数可能仍被其他地方使用，需要确认是否可以删除或保留
2. 需要确保 `getLatestAIMessageContent_ACU()` 在各种场景下都能正确获取AI消息
3. 需要考虑没有AI消息时的边界情况处理

## 测试场景

1. 剧情推进时条件模板的seed关键词匹配
2. 正文优化时条件模板的seed关键词匹配
3. 填表时条件模板的seed关键词匹配
4. 没有AI消息时的边界情况
5. 没有推进数据时的边界情况