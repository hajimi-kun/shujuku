# 表格模板数据隔离优化计划

## 问题分析

### 当前问题
在切换/导入新表格模板后，旧模板的表格本地数据仍然会被读取和显示，这可能导致：
1. **前端显示不相关的表格**：旧模板的表格数据仍然显示在前端
2. **世界书注入不相关的数据**：旧模板的表格数据被注入到世界书
3. **数据结构不匹配**：新模板的表结构与旧数据共存，可能造成字段错位

### 数据流程分析

#### 1. 指导表机制（已存在）
当导入/切换模板时，会调用 [`overwriteChatSheetGuideFromTemplate_ACU()`](index.js:8368) 更新聊天第一层的"空白指导表"。

指导表保存了当前模板的表格键列表、表头、参数和顺序。

#### 2. 数据读取流程
[`mergeAllIndependentTables_ACU()`](index.js:8906) 函数是读取本地数据的核心：

**流程**：
1. 检查是否存在指导表（8919-8920行）
2. 从聊天记录中读取**所有表格数据**（8922-9031行）- **不做模板过滤**
3. 如果存在指导表，则过滤和合并数据（9065-9123行）

**问题所在**：
- 在第2步，代码会读取所有表格数据，包括不在当前模板中的表格
- 只有当存在指导表时（`hasSheetGuide = true`），才会在第3步过滤
- **如果聊天没有指导表（旧聊天记录），则不会过滤非模板表格**

#### 3. 世界书注入流程
[`updateReadableLorebookEntry_ACU()`](index.js:16081) 函数：
1. 调用 [`mergeAllIndependentTables_ACU()`](index.js:16110) 获取合并数据
2. 调用 [`formatJsonToReadable_ACU()`](index.js:16126) 格式化数据
3. 注入到世界书

[`formatJsonToReadable_ACU()`](index.js:9243) 函数：
- 使用 [`getSortedSheetKeys_ACU()`](index.js:9252) 获取表格键
- 如果存在指导表，会按指导表过滤；否则返回所有存在的表格键

#### 4. 关键函数调用链

```
导入/切换模板
    ↓
overwriteChatSheetGuideFromTemplate_ACU()  ← 更新指导表
    ↓
refreshMergedDataAndNotify_ACU()
    ↓
mergeAllIndependentTables_ACU()  ← 读取本地数据（问题点）
    ↓
getSortedSheetKeys_ACU()  ← 排序/过滤表格键
    ↓
formatJsonToReadable_ACU()  ← 格式化数据
    ↓
updateReadableLorebookEntry_ACU()  ← 世界书注入
```

### 问题根源

**核心问题**：在 [`mergeAllIndependentTables_ACU()`](index.js:8906) 函数的第2步（8922-9031行），代码会读取聊天记录中**所有表格数据**，不做模板过滤。

虽然后续有指导表过滤逻辑（9065-9123行），但：
1. **如果聊天没有指导表**（旧聊天记录或新聊天未初始化），不会过滤
2. **即使有指导表**，在第2步读取时也会先读取所有数据，浪费资源

## 解决方案

### 方案：在读取本地数据时添加模板过滤

**核心思路**：在 [`mergeAllIndependentTables_ACU()`](index.js:8906) 函数中，无论是否有指导表，都只读取当前模板中存在的表格数据。

**优点**：
- 不删除本地数据，切换回原模板后数据仍可用
- 前端只显示当前模板的表格
- 世界书只注入当前模板的表格数据
- 减少不必要的资源消耗

### 修改方案

#### 修改位置
[`mergeAllIndependentTables_ACU()`](index.js:8906) 函数

#### 具体修改步骤

**步骤1**：在函数开头（约第8915行后）添加获取模板表格键的逻辑

```javascript
// [新增] 获取当前模板的表格键列表，用于过滤非当前模板的数据
// 优先使用指导表（如果存在），否则使用模板
const templateSheetKeys = (() => {
    if (hasSheetGuide) {
        // 存在指导表：使用指导表的表格键
        return Object.keys(sheetGuideData).filter(k => k.startsWith('sheet_'));
    }
    // 不存在指导表：使用当前模板的表格键
    return getTemplateSheetKeys_ACU();
})();
const templateSheetKeySet = new Set(templateSheetKeys);
logDebug_ACU(`[Merge] Filtering by template/guide: ${templateSheetKeys.length} tables allowed`);
```

**步骤2**：在读取新版按标签分组存储数据时（约第8937行），添加过滤条件

```javascript
Object.keys(independentData).forEach(storedSheetKey => {
    // [新增] 只处理当前模板/指导表中存在的表格
    if (!templateSheetKeySet.has(storedSheetKey)) {
        logDebug_ACU(`[Merge] Skipping sheet [${storedSheetKey}] - not in current template/guide`);
        return;
    }
    if (!foundSheets[storedSheetKey]) {
        // ... 原有逻辑
    }
});
```

**步骤3**：在读取旧版独立数据格式时（约第8982行），添加同样的过滤条件

**步骤4**：在读取旧版标准表/总结表格式时（约第9008行和9020行），添加同样的过滤条件

### 影响范围

#### 受影响的功能
1. **前端表格显示**：只显示当前模板中的表格
2. **世界书注入**：只注入当前模板中的表格数据
3. **表格更新**：只更新当前模板中的表格
4. **手动填表**：只显示当前模板中的表格选项

#### 不受影响的功能
1. **本地数据存储**：旧数据仍然保存在聊天记录中，只是不被读取
2. **模板切换**：切换回原模板后，数据仍然可用
3. **数据隔离标识**：原有的数据隔离机制不受影响

### 修改代码行数区间预估

| 修改位置 | 行号区间 | 说明 |
|---------|---------|------|
| [`mergeAllIndependentTables_ACU()`](index.js:8906) | 约8915-8920 | 新增：获取模板/指导表表格键列表 |
| [`mergeAllIndependentTables_ACU()`](index.js:8937) | 约8937-8941 | 新增：过滤非模板表格（新版存储格式） |
| [`mergeAllIndependentTables_ACU()`](index.js:8982) | 约8982-8986 | 新增：过滤非模板表格（旧版独立数据） |
| [`mergeAllIndependentTables_ACU()`](index.js:9008) | 约9008-9012 | 新增：过滤非模板表格（旧版标准表） |
| [`mergeAllIndependentTables_ACU()`](index.js:9020) | 约9020-9024 | 新增：过滤非模板表格（旧版总结表） |

### 测试要点

1. **切换模板后验证**：
   - 前端只显示新模板中的表格
   - 世界书只注入新模板中的表格数据
   
2. **切换回原模板验证**：
   - 原模板的数据仍然可用
   - 数据完整性不受影响

3. **无指导表的旧聊天记录验证**：
   - 切换模板后，只显示当前模板的表格
   - 旧数据不被读取，但仍然保存在聊天记录中

4. **数据隔离标识验证**：
   - 不同标识的数据仍然正确隔离
   - 过滤逻辑与数据隔离逻辑协同工作

## 下一步

请确认此方案是否符合您的需求，确认后我将切换到 Code 模式进行实现。