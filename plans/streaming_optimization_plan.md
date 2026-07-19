# 流式传输优化计划

## 目标

将 index.js 插件中所有使用 AI 大模型的功能改为支持流式传输（streaming），以：
- 减少首字节响应时间（TTFT）
- 避免长时间等待无响应
- 更好地处理超时问题

## 当前状态分析

### 需要修改的 AI 调用位置

| 位置 | 功能描述 | 当前状态 | 代码行数 |
|------|---------|---------|---------|
| `callAI()` | 通用 AI 调用函数 | `stream: false` | 4517-4610 |
| 剧情推进 | 生成剧情规划 | `should_stream: false` | 6720-6780 |
| 自动填表 | 更新数据库表格 | `should_stream: false` | 19838-19915 |
| 纪要合并 | 合并纪要到数据库 | `should_stream: false` | 20910-20936 |
| 其他调用1 | 辅助功能 | `should_stream: false` | 21560-21580 |
| 其他调用2 | 辅助功能 | `should_stream: false` | 25100-25130 |

### 两种 API 调用方式

1. **TavernHelper.generateRaw** - 酒馆主 API
   - 参数: `should_stream: boolean`
   
2. **fetch /api/backends/chat-completions/generate** - 自定义 API
   - 参数: `stream: boolean`

## 实现方案

### 1. 创建通用流式处理函数

创建一个通用的流式响应处理函数 `streamToText_ACU()`，用于：
- 处理 SSE（Server-Sent Events）流
- 累积所有 chunk 中的内容
- 返回完整的文本结果

```javascript
/**
 * 处理流式响应，累积所有 chunk 并返回完整文本
 * @param {Response} response - fetch 返回的 Response 对象
 * @param {AbortSignal} signal - 可选的中止信号
 * @returns {Promise<string>} 完整的 AI 响应文本
 */
async function streamToText_ACU(response, signal = null) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error('Request aborted');
            }
            
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留不完整的行

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    
                    try {
                        const json = JSON.parse(data);
                        const content = json?.choices?.[0]?.delta?.content;
                        if (content) {
                            fullContent += content;
                        }
                    } catch (e) {
                        // 忽略解析错误，继续处理下一行
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    return fullContent;
}
```

### 2. 修改位置清单

#### 2.1 `callAI()` 函数（行 4517-4610）

**修改内容：**
- TavernHelper.generateRaw 调用：`should_stream: false` → `should_stream: true`
- fetch 调用：`stream: false` → `stream: true`
- 添加流式响应处理逻辑

#### 2.2 剧情推进功能（行 6720-6780）

**修改内容：**
- TavernHelper.generateRaw 调用：`should_stream: false` → `should_stream: true`
- fetch 调用：`stream: false` → `stream: true`
- 使用 `streamToText_ACU()` 处理响应

#### 2.3 自动填表功能（行 19838-19915）

**修改内容：**
- TavernHelper.generateRaw 调用：`should_stream: false` → `should_stream: true`
- fetch 调用：`stream: false` → `stream: true`
- 使用 `streamToText_ACU()` 处理响应

#### 2.4 纪要合并功能（行 20910-20936）

**修改内容：**
- TavernHelper.generateRaw 调用：`should_stream: false` → `should_stream: true`
- fetch 调用：`stream: false` → `stream: true`

#### 2.5 其他 AI 调用（行 21560-21580, 25100-25130）

**修改内容：**
- 同样修改 `should_stream` 和 `stream` 参数

## 执行步骤

1. **步骤1**：在 index.js 中添加 `streamToText_ACU()` 函数
2. **步骤2**：修改 `callAI()` 函数
3. **步骤3**：修改剧情推进功能
4. **步骤4**：修改自动填表功能
5. **步骤5**：修改纪要合并功能
6. **步骤6**：修改其他 AI 调用位置
7. **步骤7**：更新 README.md

## 注意事项

1. **TavernHelper.generateRaw 的流式处理**
   - 当 `should_stream: true` 时，返回值可能需要不同的处理方式
   - 需要测试确认返回格式

2. **错误处理**
   - 流式传输中的错误需要正确捕获
   - 中止信号需要正确传递

3. **兼容性**
   - 确保修改后与现有功能兼容
   - 保留必要的错误处理逻辑

## 代码行数区间记录

修改完成后将在 README.md 中记录每个修改的代码行数区间。
