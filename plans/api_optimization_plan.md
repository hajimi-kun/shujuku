# 神·数据库插件 API 优化计划

## 概述

根据用户需求，本次优化需要完成以下任务：
1. 添加三个缺失的 API 接口
2. 为纪要表添加索引编码锁定功能

---

## 一、缺失的 API 接口

### 1. 更新配置参数读写 API

**需求分析**：
- 用户需要读写 `autoUpdateThreshold`（自动更新阈值）
- 用户需要读写 `autoUpdateFrequency`（自动更新频率）
- 用户需要读写 `updateBatchSize`（批处理大小）

**当前状态**：
- 这些参数已存在于 `settings_ACU` 中
- 但没有暴露给外部 API

**计划添加的 API**：

```javascript
// 获取更新配置参数
getUpdateConfigParams()

// 返回值示例
{
    autoUpdateThreshold: 3,
    autoUpdateFrequency: 1,
    updateBatchSize: 2
}

// 设置更新配置参数
setUpdateConfigParams(params)

// 参数示例
{
    autoUpdateThreshold: 5,
    autoUpdateFrequency: 2,
    updateBatchSize: 3
}
```

**代码位置**：在 `index.js` 第 2818 行附近的 `topLevelWindow_ACU.AutoCardUpdaterAPI` 对象中添加

---

### 2. 手动更新表选择读写 API

**需求分析**：
- 用户需要读写 `manualSelectedTables`（手动更新时选择的表格列表）
- 用户需要读写 `hasManualSelection`（是否用户显式选择过）

**当前状态**：
- 这些参数已存在于 `settings_ACU` 中（第 2361-2363 行）
- 有相关的 UI 处理函数（第 9159-9343 行）
- 但没有暴露给外部 API

**计划添加的 API**：

```javascript
// 获取手动更新表选择
getManualSelectedTables()

// 返回值示例
{
    selectedTables: ['sheet_xxx', 'sheet_yyy'],
    hasManualSelection: true
}

// 设置手动更新表选择
setManualSelectedTables(sheetKeys)

// 参数示例
['sheet_xxx', 'sheet_yyy']

// 清除手动选择（恢复全选状态）
clearManualSelectedTables()
```

**代码位置**：在 `index.js` 第 2818 行附近的 `topLevelWindow_ACU.AutoCardUpdaterAPI` 对象中添加

---

### 3. API 预设管理 API

**需求分析**：
- 用户需要管理 `apiPresets`（API 预设列表）
- 用户需要读写 `tableApiPreset`（填表使用的 API 预设）
- 用户需要读写 `plotApiPreset`（剧情推进使用的 API 预设）

**当前状态**：
- 这些参数已存在于 `settings_ACU` 中（第 2331-2334 行）
- 有相关的内部函数：
  - `saveApiPreset_ACU()`（第 8073 行）
  - `loadApiPreset_ACU()`（第 8088 行）
  - `deleteApiPreset_ACU()`（第 8105 行）
  - `getApiConfigByPreset_ACU()`（第 8177 行）
  - `refreshApiPresetSelectors_ACU()`（第 8130 行）
- 但没有暴露给外部 API

**计划添加的 API**：

```javascript
// 获取所有 API 预设列表
getApiPresets()

// 返回值示例
[
    { name: '预设1', apiMode: 'proxy', apiConfig: {...}, tavernProfile: '' },
    { name: '预设2', apiMode: 'custom', apiConfig: {...}, tavernProfile: '' }
]

// 获取当前选中的填表 API 预设
getTableApiPreset()

// 返回值：预设名称或空字符串

// 设置填表 API 预设
setTableApiPreset(presetName)

// 获取当前选中的剧情推进 API 预设
getPlotApiPreset()

// 返回值：预设名称或空字符串

// 设置剧情推进 API 预设
setPlotApiPreset(presetName)

// 保存/更新 API 预设
saveApiPreset(presetData)

// 参数示例
{
    name: '新预设',
    apiMode: 'custom',
    apiConfig: {
        customApiUrl: 'https://...',
        customApiKey: '...',
        customApiModel: 'gpt-4'
    },
    tavernProfile: ''
}

// 加载 API 预设（应用到当前配置）
loadApiPreset(presetName)

// 删除 API 预设
deleteApiPreset(presetName)
```

**代码位置**：在 `index.js` 第 2818 行附近的 `topLevelWindow_ACU.AutoCardUpdaterAPI` 对象中添加

---

## 二、纪要表索引编码锁定功能

**需求分析**：
- 总结表已有"编码索引列特殊锁定"功能
- 纪要表需要拥有相同的功能

**当前状态**：
- 索引编码锁定功能在以下位置实现：
  - `isSpecialIndexLockEnabled_ACU()`（第 5119 行）
  - `setSpecialIndexLockEnabled_ACU()`（第 5126 行）
  - `getSummaryIndexColumnIndex_ACU()`（第 5135 行）
  - `applySummaryIndexSequenceToTable_ACU()`（第 5156 行）
  - `applySpecialIndexSequenceToSummaryTables_ACU()`（第 5165 行）
- 判断逻辑在 `isSummaryOrOutlineTable_ACU()`（第 5045 行）中只检查 `'总结表'` 或 `'总体大纲'`
- **问题**：没有包含 `'纪要表'`

**解决方案**：

修改 [`isSummaryOrOutlineTable_ACU()`](index.js:5045) 函数，添加对 `'纪要表'` 的判断：

```javascript
// 修改前
function isSummaryOrOutlineTable_ACU(tableName) {
    if (!tableName || typeof tableName !== 'string') return false;
    const trimmedName = tableName.trim();
    return trimmedName === '总结表' || trimmedName === '总体大纲';
}

// 修改后
function isSummaryOrOutlineTable_ACU(tableName) {
    if (!tableName || typeof tableName !== 'string') return false;
    const trimmedName = tableName.trim();
    return trimmedName === '总结表' || trimmedName === '总体大纲' || trimmedName === '纪要表';
}
```

**影响范围**：
- 此修改将使纪要表获得与总结表相同的索引编码锁定功能
- 包括：
  - 编码索引列的自动锁定
  - 新增/删除行时自动重新排序编码
  - 可视化编辑器中的"编码索引列特殊锁定"按钮

---

## 三、实施步骤

### 步骤 1：添加更新配置参数 API
- 位置：`index.js` 第 2818 行附近
- 添加 `getUpdateConfigParams()` 和 `setUpdateConfigParams()` 方法

### 步骤 2：添加手动更新表选择 API
- 位置：`index.js` 第 2818 行附近
- 添加 `getManualSelectedTables()`、`setManualSelectedTables()` 和 `clearManualSelectedTables()` 方法

### 步骤 3：添加 API 预设管理 API
- 位置：`index.js` 第 2818 行附近
- 添加以下方法：
  - `getApiPresets()`
  - `getTableApiPreset()`
  - `setTableApiPreset()`
  - `getPlotApiPreset()`
  - `setPlotApiPreset()`
  - `saveApiPreset()`
  - `loadApiPreset()`
  - `deleteApiPreset()`

### 步骤 4：修改纪要表索引编码锁定
- 位置：`index.js` 第 5045-5049 行
- 修改 `isSummaryOrOutlineTable_ACU()` 函数

### 步骤 5：更新 README.md
- 添加本次更新的内容与代码行数区间

### 步骤 6：更新 API_DOCUMENTATION.md
- 添加新增的 API 接口文档

---

## 四、代码修改详情

| 文件 | 预计代码行数区间 | 修改说明 |
|------|-----------------|----------|
| `index.js` | ~2818+ | 添加更新配置参数读写 API |
| `index.js` | ~2818+ | 添加手动更新表选择读写 API |
| `index.js` | ~2818+ | 添加 API 预设管理 API |
| `index.js` | 5045-5049 | 修改 `isSummaryOrOutlineTable_ACU()` 添加纪要表支持 |
| `README.md` | 末尾追加 | 记录本次更新内容 |
| `API_DOCUMENTATION.md` | 适当位置 | 添加新增 API 文档 |

---

## 五、API 使用示例

### 更新配置参数 API 示例

```javascript
// 获取当前配置
const config = window.AutoCardUpdaterAPI.getUpdateConfigParams();
console.log('当前阈值:', config.autoUpdateThreshold);
console.log('当前频率:', config.autoUpdateFrequency);
console.log('批处理大小:', config.updateBatchSize);

// 修改配置
window.AutoCardUpdaterAPI.setUpdateConfigParams({
    autoUpdateThreshold: 5,
    autoUpdateFrequency: 2
});
```

### 手动更新表选择 API 示例

```javascript
// 获取当前选择的表
const selection = window.AutoCardUpdaterAPI.getManualSelectedTables();
console.log('已选择的表:', selection.selectedTables);
console.log('是否手动选择过:', selection.hasManualSelection);

// 设置选择的表
window.AutoCardUpdaterAPI.setManualSelectedTables(['sheet_abc123', 'sheet_def456']);

// 清除选择（恢复全选）
window.AutoCardUpdaterAPI.clearManualSelectedTables();
```

### API 预设管理示例

```javascript
// 获取所有预设
const presets = window.AutoCardUpdaterAPI.getApiPresets();
console.log('可用预设:', presets.map(p => p.name));

// 获取当前填表预设
const tablePreset = window.AutoCardUpdaterAPI.getTableApiPreset();
console.log('当前填表预设:', tablePreset || '使用当前配置');

// 切换填表预设
window.AutoCardUpdaterAPI.setTableApiPreset('战斗场景API');

// 创建新预设
window.AutoCardUpdaterAPI.saveApiPreset({
    name: '测试预设',
    apiMode: 'custom',
    apiConfig: {
        customApiUrl: 'https://api.example.com/v1',
        customApiKey: 'sk-xxx',
        customApiModel: 'gpt-4o'
    }
});

// 删除预设
window.AutoCardUpdaterAPI.deleteApiPreset('测试预设');
```

---

## 六、风险评估

1. **兼容性风险**：低
   - 新增 API 不会影响现有功能
   - 修改 `isSummaryOrOutlineTable_ACU()` 只增加判断条件，不影响现有逻辑

2. **数据安全风险**：低
   - 所有 API 都通过 `saveSettings_ACU()` 保存设置
   - 参数验证确保数据有效性

3. **性能风险**：无
   - API 调用都是简单的读写操作

---

## 七、测试计划

1. **更新配置参数 API 测试**
   - 测试获取默认值
   - 测试设置新值
   - 测试部分更新
   - 测试无效参数处理

2. **手动更新表选择 API 测试**
   - 测试获取选择状态
   - 测试设置选择
   - 测试清除选择

3. **API 预设管理测试**
   - 测试获取预设列表
   - 测试创建/更新/删除预设
   - 测试切换预设

4. **纪要表索引锁定测试**
   - 测试纪要表是否显示索引锁定按钮
   - 测试锁定功能是否正常工作
   - 测试新增/删除行时编码自动更新
