# 数据库插件 - 酒馆提示词整合方案

## 用户确认需求
- ✅ 支持 else 分支
- ✅ 支持嵌套条件
- ✅ 需要设置总开关

## 一、背景分析

### st-prompt-template 插件工作原理
- **核心事件**：`CHAT_COMPLETION_SETTINGS_READY`
- **处理流程**：监听事件 → 处理 `data.messages` 数组 → 执行 EJS 模板 → 返回处理后的消息
- **执行时机**：在 SillyTavern 构建完提示词后、发送给 LLM 之前

### 数据库插件现有事件监听
- `CHAT_CHANGED`：切换聊天
- `MESSAGE_SENT`：消息发送
- `GENERATION_STARTED`：生成开始
- `GENERATION_ENDED`：生成结束
- `GENERATION_AFTER_COMMANDS`：生成后命令

## 二、整合方案设计

### 2.0 语法设计（支持 else 和嵌套）

#### 基本语法
```
<if seed="关键词">条件内容</if>
<if cell="表格/行/列 > 数值">条件内容</if>
```

#### 带 else 的语法
```
<if seed="战斗">
战斗场景内容
<else>
非战斗场景内容
</if>
```

#### 嵌套语法
```
<if seed="战斗">
  <if cell="状态表/主角/魔力值 > 30">
    有足够魔力施放高级魔法。
  <else>
    魔力不足，只能使用普通攻击。
  </if>
<else>
  <if seed="对话">
    可以进行和平对话。
  </if>
</if>
```

#### 语法解析规则
1. 使用正则表达式匹配 `<if ...>` 开始标签
2. 递归解析内部内容，支持嵌套
3. 匹配 `</if>` 结束标签
4. 检测 `<else>` 分支（可选）
5. 根据条件评估结果选择输出内容

### 2.1 核心思路
数据库插件独立监听 `CHAT_COMPLETION_SETTINGS_READY` 事件，使用 `eventSource.makeLast()` 确保在 st-prompt-template 之后执行。

### 2.2 执行顺序保证
```
SillyTavern 构建提示词
    ↓
st-prompt-template 处理（如果存在）
    ↓
数据库插件处理（makeLast 确保最后执行）
    ↓
发送给 LLM
```

### 2.3 功能设计

#### 条件模板语法（复用已有实现）
```
<if seed="关键词表达式">条件内容</if>
<if cell="表格名/行名/列名 > 数值">条件内容</if>
```

#### 作用范围
- 角色卡描述（Character Description）
- 角色卡场景（Scenario）
- 世界书条目（World Info Entries）
- 预设提示词（Preset Prompts）
- 消息内容（Messages）

### 2.4 技术实现

#### 新增事件监听
```javascript
// 在插件初始化时添加
if (SillyTavern_API_ACU.eventTypes.CHAT_COMPLETION_SETTINGS_READY) {
    SillyTavern_API_ACU.eventSource.makeLast(
        SillyTavern_API_ACU.eventTypes.CHAT_COMPLETION_SETTINGS_READY,
        handleChatCompletionReady_ACU
    );
}
```

#### 处理函数结构
```javascript
async function handleChatCompletionReady_ACU(data) {
    // 1. 检查功能是否启用
    if (!settings_ACU.promptTemplateEnabled) return;
    
    // 2. 获取数据库表格数据
    const tableData = getTableDataForPrompt_ACU();
    
    // 3. 遍历处理消息
    for (const message of data.messages) {
        if (typeof message.content === 'string') {
            message.content = parseConditionalTemplate_ACU(
                message.content,
                tableData,
                /* 其他上下文 */
            );
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === 'text' && part.text) {
                    part.text = parseConditionalTemplate_ACU(
                        part.text,
                        tableData,
                        /* 其他上下文 */
                    );
                }
            }
        }
    }
}
```

## 二、详细实现计划

### 步骤1：添加设置选项
- 在设置中添加"启用提示词模板"开关
- 添加"处理顺序"选项（在 st-prompt-template 之后）

### 步骤2：实现事件监听
- 使用 `eventSource.makeLast()` 确保在最后执行
- 处理 `CHAT_COMPLETION_SETTINGS_READY` 事件

### 步骤3：扩展条件模板函数
- 修改 `parseConditionalTemplate_ACU()` 支持更多上下文
- 添加获取数据库表格数据的函数

### 步骤4：处理多种消息格式
- 字符串格式：`message.content = "text"`
- 数组格式：`message.content = [{type: 'text', text: '...'}]`

### 步骤5：更新 README.md
- 记录新增功能
- 说明与 st-prompt-template 的兼容性

## 三、代码修改位置

| 文件 | 代码行数区间 | 修改说明 |
|------|-------------|----------|
| index.js | 待定 | 新增 `handleChatCompletionReady_ACU()` 函数 |
| index.js | 待定 | 新增 `getTableDataForPrompt_ACU()` 函数 |
| index.js | 待定 | 修改 `parseConditionalTemplate_ACU()` 支持更多上下文 |
| index.js | 待定 | 在初始化时添加事件监听 |
| index.js | 待定 | 添加设置选项 |
| README.md | 待定 | 记录新增功能 |

## 四、使用示例

### 在角色卡中使用
```
你是一个冒险者。

<if seed="战斗,打架">
当发生战斗时，你需要注意战斗动作的流畅性。
</if>

<if cell="重要人物表/威尔逊/好感度 > 50">
威尔逊对你很友好，可以寻求他的帮助。
</if>
```

### 在世界书中使用
```
<if seed="魔法,施法">
魔法系统说明：在这个世界中，魔法需要消耗魔力值...
</if>

<if cell="状态表/主角/魔力值 < 20">
警告：主角魔力值过低，可能无法施放高级魔法。
</if>
```

## 五、兼容性说明

### 与 st-prompt-template 共存
- 数据库插件使用 `makeLast()` 确保在最后执行
- 条件模板语法 `<if ...>` 与 EJS 语法 `<% ... %>` 不冲突
- 两者可以同时使用

### 执行顺序
1. SillyTavern 构建原始提示词
2. st-prompt-template 处理 EJS 模板
3. **数据库插件处理条件模板**
4. 发送给 LLM

## 六、已确认事项

- ✅ 支持 else 分支
- ✅ 支持嵌套条件
- ✅ 需要设置总开关

## 七、实现要点

### 7.1 递归解析器设计
```javascript
function parseIfBlock_ACU(content, context, depth = 0) {
    // 防止无限递归
    if (depth > 10) return content;
    
    // 匹配最外层的 <if ...>...</if>
    const ifRegex = /<if\s+(seed|cell)="([^"]+)"\s*>([\s\S]*?)<\/if>/g;
    
    return content.replace(ifRegex, (match, type, condition, body) => {
        // 检查是否有 <else> 分支
        const elseIndex = body.indexOf('<else>');
        let ifContent, elseContent;
        
        if (elseIndex !== -1) {
            ifContent = body.substring(0, elseIndex);
            elseContent = body.substring(elseIndex + 6); // '<else>'.length = 6
        } else {
            ifContent = body;
            elseContent = '';
        }
        
        // 评估条件
        const conditionMet = evaluateCondition_ACU(type, condition, context);
        
        // 递归处理嵌套
        const result = conditionMet ? ifContent : elseContent;
        return parseIfBlock_ACU(result, context, depth + 1);
    });
}
```

### 7.2 设置选项
```javascript
const DEFAULT_PROMPT_TEMPLATE_SETTINGS_ACU = {
    enabled: true,           // 总开关
    maxNestingDepth: 10,     // 最大嵌套深度
    debugMode: false         // 调试模式
};
```
