# 纪要索引优化计划

## 概述

本计划包含三个主要优化任务，旨在优化剧情推进$5占位符的读取逻辑、屏蔽纪要索引条目、以及添加重试延时。

---

## 任务1：$5占位符改为从纪要表本地数据读取

### 当前行为

目前$5占位符的读取逻辑（代码行7190-7219）：
1. 优先从世界书获取"纪要索引"条目内容（通过`getSummaryIndexContentForPlot_ACU`函数）
2. 如果不存在，回退到从`currentJsonTableData_ACU`读取"总体大纲"表内容

### 目标行为

修改为与"总体大纲"表类似的读取方式：
- **不再**从世界书中的"纪要索引"条目读取
- 直接从聊天记录的本地数据（`currentJsonTableData_ACU`）中读取纪要表
- **只读取两列**：概要列（列3）和索引编码列（列4）
- 不读取纪要表的其他内容（时间跨度、地点、纪要等）

### 纪要表结构

根据模板定义（代码行1768附近），纪要表结构为：
- 列0: 时间跨度
- 列1: 地点
- 列2: 纪要
- **列3: 概览（概要）** ← 需要读取
- **列4: 编码索引** ← 需要读取

### 修改方案

#### 1.1 新增函数：`formatSummaryIndexForPlot_ACU`

**位置**：约第6330行（在`formatOutlineTableForPlot_ACU`函数附近）

**功能**：格式化纪要表的概要列和索引编码列

```javascript
// [剧情推进专用] $5 从纪要表读取概要和编码索引两列
function formatSummaryIndexForPlot_ACU(allTablesJson) {
  try {
    if (!allTablesJson || typeof allTablesJson !== 'object') {
      return '纪要索引：未获取到表格数据。';
    }
    const sheets = Object.values(allTablesJson).filter(x => x && typeof x === 'object' && x.name && x.content);
    // 查找纪要表（兼容旧数据"总结表"）
    const summaryTable = sheets.find(s => String(s.name || '').trim() === '纪要表' || String(s.name || '').trim() === '总结表');
    if (!summaryTable || !Array.isArray(summaryTable.content) || summaryTable.content.length <= 1) {
      return '纪要索引：未找到纪要表或表为空。';
    }

    const headerRow = Array.isArray(summaryTable.content[0]) ? summaryTable.content[0] : [];
    // 找到概要列和编码索引列的索引
    const summaryColIdx = headerRow.findIndex(h => String(h ?? '').trim() === '概览' || String(h ?? '').trim() === '概要');
    const indexColIdx = headerRow.findIndex(h => String(h ?? '').trim() === '编码索引');
    
    if (summaryColIdx === -1 || indexColIdx === -1) {
      return '纪要索引：未找到概要列或编码索引列。';
    }

    let out = `## 表格: 纪要索引\n`;
    out += `Columns: 概要, 编码索引\n`;

    const rows = summaryTable.content.slice(1).filter(r => Array.isArray(r));
    if (rows.length === 0) {
      out += '(无数据行)\n';
      return out;
    }

    rows.forEach((row, idx) => {
      const summary = row[summaryColIdx] ? String(row[summaryColIdx]).trim() : '';
      const indexCode = row[indexColIdx] ? String(row[indexColIdx]).trim() : '';
      if (summary || indexCode) {
        out += `- [${idx}] 概要: ${summary} | 编码索引: ${indexCode}\n`;
      }
    });
    return out;
  } catch (e) {
    return '纪要索引：格式化时发生错误。';
  }
}
```

#### 1.2 修改$5占位符生成逻辑

**位置**：代码行7190-7219

**修改前**：
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
    ...
  }
}
```

**修改后**：
```javascript
// [剧情推进] $5 从纪要表本地数据读取概要和编码索引两列（不再从世界书读取）
let outlineTableContent = '';
try {
  // 确保数据已加载
  if (!currentJsonTableData_ACU || typeof currentJsonTableData_ACU !== 'object') {
    // 兜底：即时从聊天记录合并一次（避免 $5 为空）
    try {
      const merged = await mergeAllIndependentTables_ACU();
      if (merged && typeof merged === 'object') {
        currentJsonTableData_ACU = merged;
      }
    } catch (e) {}
  }
  if (currentJsonTableData_ACU && typeof currentJsonTableData_ACU === 'object') {
    outlineTableContent = formatSummaryIndexForPlot_ACU(currentJsonTableData_ACU);
    logDebug_ACU('[剧情推进] $5 使用纪要表的概要和编码索引列');
  } else {
    outlineTableContent = '纪要索引：当前未加载到数据库数据。';
  }
} catch (error) {
  logError_ACU('[剧情推进] 生成纪要索引($5)时出错:', error);
  outlineTableContent = '{"error": "加载表格数据时发生错误"}';
}
```

#### 1.3 代码行数区间

| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| `index.js` | 约6330行附近 | 新增`formatSummaryIndexForPlot_ACU`函数 |
| `index.js` | 7190-7219 | 修改$5占位符生成逻辑，改为从纪要表本地数据读取 |

---

## 任务2：永久屏蔽纪要索引条目

### 当前行为

纪要索引条目（`TavernDB-ACU-CustomExport-纪要索引`）目前：
- 在世界书中创建并显示
- 受0TK模式控制enabled状态
- 在剧情推进世界书读取时未被屏蔽

### 目标行为

与"总体大纲"条目（`TavernDB-ACU-OutlineTable`）相同的待遇：
- **永久屏蔽**：在世界书条目UI中不显示
- **占位符不使用**：$5占位符不再使用这个条目的内容（已通过任务1解决）
- **剧情推进不读取**：在世界书读取时跳过该条目

### 修改方案

#### 2.1 在剧情推进世界书读取时屏蔽纪要索引条目

**位置**：代码行7647-7651

**修改前**：
```javascript
// 屏蔽 OutlineTable 本体（总结大纲/总体大纲）
const isOutlineEntry = normalizedComment.startsWith('TavernDB-ACU-OutlineTable');
if (isOutlineEntry) {
  return;
}
```

**修改后**：
```javascript
// 屏蔽 OutlineTable 本体（总结大纲/总体大纲）和纪要索引条目
const isOutlineEntry = normalizedComment.startsWith('TavernDB-ACU-OutlineTable');
const isSummaryIndexEntry = normalizedComment.startsWith('TavernDB-ACU-CustomExport-纪要索引');
if (isOutlineEntry || isSummaryIndexEntry) {
  return;
}
```

#### 2.2 纪要索引条目的enabled永久设为false

由于$5占位符现在从本地数据读取，纪要索引条目不再需要被启用。可以：
1. 保持现有创建逻辑，但enabled始终为false
2. 或者完全停止创建该条目

**推荐方案**：保持创建逻辑（用于其他可能的用途），但enabled始终为false，且在剧情推进读取时屏蔽。

#### 2.3 代码行数区间

| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| `index.js` | 7647-7651 | 在剧情推进世界书读取时屏蔽纪要索引条目 |

---

## 任务3：剧情推进和填表自动重试添加5秒延时

### 当前行为

**剧情推进重试**（代码行7479-7480）：
```javascript
// 递增等待时间：1秒、2秒、3秒
await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
```

**填表重试**（代码行19791-19792）：
```javascript
// 如果不是最后一次尝试，等待后重试
if (attempt < maxRetries) {
    const waitTime = 1000 * attempt; // 递增等待时间：1秒、2秒、3秒
```

### 目标行为

将重试延时改为**固定5秒**：
- 剧情推进重试：5秒延时
- 填表重试：5秒延时

### 修改方案

#### 3.1 修改剧情推进重试延时

**位置**：代码行7479-7480

**修改前**：
```javascript
// 递增等待时间：1秒、2秒、3秒
await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
```

**修改后**：
```javascript
// 固定等待5秒后重试
await new Promise(resolve => setTimeout(resolve, 5000));
```

#### 3.2 修改填表重试延时

**位置**：代码行19791-19797

**修改前**：
```javascript
// 如果不是最后一次尝试，等待后重试
if (attempt < maxRetries) {
    const waitTime = 1000 * attempt; // 递增等待时间：1秒、2秒、3秒
    logDebug_ACU(`等待 ${waitTime}ms 后重试...`);
    if (!isSilentMode) {
        showToastr_ACU('warning', `第 ${attempt} 次尝试失败，准备重试... (${error.message.substring(0, 50)})`, { timeOut: 2000 });
    }
    await new Promise(resolve => setTimeout(resolve, waitTime));
    continue;
}
```

**修改后**：
```javascript
// 如果不是最后一次尝试，等待5秒后重试
if (attempt < maxRetries) {
    const waitTime = 5000; // 固定等待5秒
    logDebug_ACU(`等待 ${waitTime}ms 后重试...`);
    if (!isSilentMode) {
        showToastr_ACU('warning', `第 ${attempt} 次尝试失败，5秒后重试... (${error.message.substring(0, 50)})`, { timeOut: 5000 });
    }
    await new Promise(resolve => setTimeout(resolve, waitTime));
    continue;
}
```

#### 3.3 检查其他重试位置

需要检查并修改其他可能的重试位置：

1. **自动合并纪要重试**（代码行19555-19556）：
```javascript
if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 2000));
```
改为：
```javascript
if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 5000));
```

2. **手动合并纪要重试**（代码行20205-20206）：
```javascript
if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 2000));
```
改为：
```javascript
if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 5000));
```

#### 3.4 代码行数区间

| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| `index.js` | 7479-7480 | 剧情推进重试延时改为5秒 |
| `index.js` | 19791-19797 | 填表重试延时改为5秒 |
| `index.js` | 19555-19556 | 自动合并纪要重试延时改为5秒 |
| `index.js` | 20205-20206 | 手动合并纪要重试延时改为5秒 |

---

## 修改汇总

| 任务 | 文件 | 代码行数区间 | 修改说明 |
|------|------|-------------|----------|
| 1 | `index.js` | 约6330行附近 | 新增`formatSummaryIndexForPlot_ACU`函数 |
| 1 | `index.js` | 7190-7219 | 修改$5占位符生成逻辑 |
| 2 | `index.js` | 7647-7651 | 剧情推进世界书读取时屏蔽纪要索引条目 |
| 3 | `index.js` | 7479-7480 | 剧情推进重试延时改为5秒 |
| 3 | `index.js` | 19791-19797 | 填表重试延时改为5秒 |
| 3 | `index.js` | 19555-19556 | 自动合并纪要重试延时改为5秒 |
| 3 | `index.js` | 20205-20206 | 手动合并纪要重试延时改为5秒 |

---

## README.md更新内容

完成修改后，需要在README.md中添加以下更新记录：

```markdown
### 2026-03-08 纪要索引优化与重试延时调整

#### 修改内容

**1. $5占位符读取逻辑优化**
- $5占位符不再优先读取世界书中的"纪要索引"条目内容
- 改为从聊天记录的本地数据（纪要表）中读取
- 只读取纪要表的"概要"列和"编码索引"列两列内容
- 不再读取纪要表的其他内容（时间跨度、地点、纪要等）

**2. 纪要索引条目永久屏蔽**
- 纪要索引条目（`TavernDB-ACU-CustomExport-纪要索引`）在剧情推进世界书读取时被永久屏蔽
- 与"总体大纲"条目享受同等待遇

**3. 自动重试延时调整**
- 剧情推进自动重试延时改为固定5秒
- 填表自动重试延时改为固定5秒
- 自动/手动合并纪要重试延时改为固定5秒

#### 修改内容

| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| `index.js` | 约6330行附近 | 新增`formatSummaryIndexForPlot_ACU`函数，格式化纪要表的概要和编码索引列 |
| `index.js` | 7190-7219 | 修改$5占位符生成逻辑，改为从纪要表本地数据读取概要和编码索引列 |
| `index.js` | 7647-7651 | 在剧情推进世界书读取时屏蔽纪要索引条目 |
| `index.js` | 7479-7480 | 剧情推进重试延时改为固定5秒 |
| `index.js` | 19791-19797 | 填表重试延时改为固定5秒 |
| `index.js` | 19555-19556 | 自动合并纪要重试延时改为固定5秒 |
| `index.js` | 20205-20206 | 手动合并纪要重试延时改为固定5秒 |
```

---

## 注意事项

1. **向后兼容**：新的`formatSummaryIndexForPlot_ACU`函数需要兼容旧数据中的"总结表"名称
2. **数据为空处理**：需要处理纪要表不存在或为空的情况
3. **列名兼容**：需要兼容"概览"和"概要"两种列名（根据模板定义，实际列名是"概览"）
4. **重试提示**：重试延时的提示信息需要相应更新，告知用户等待5秒
