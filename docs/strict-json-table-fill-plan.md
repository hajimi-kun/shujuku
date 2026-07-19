# 严格 JSON 填表响应改造计划

## 结论

严格 JSON 填表开启后，新提示词和 AI 响应中不再出现 `<tableEdit>`，也不再要求 AI 输出 `insertRow(...)`、`updateRow(...)`、`deleteRow(...)`。

严格 JSON 填表只保留两套新协议，由当前存储模式自动选择：

```text
原生表格模式：table_edit_ops_v1
SQLite 模式：table_edit_sql_v1
```

用户设置只新增一个主开关：

```ts
strictJsonTableFillEnabled: false
```

开启后固定行为：

```text
1. 原生表格模式要求 AI 输出结构化 JSON 操作数组。
2. SQLite 模式要求 AI 输出 JSON 包裹的完整 SQL 脚本字符串。
3. 面向 AI 的 strict prompt 只描述新 JSON 格式，不暴露旧协议词。
4. 表格用 sheet 字符串定位。
5. 字段用表头字段名定位。
6. 更新和删除用 where 条件定位唯一行。
7. 不自动注入 response_format/json_schema；需要 API 级 schema 时由用户在 API 附加 Body 参数中自行配置。
```

旧 `<tableEdit>` 只在关闭严格 JSON 时作为 legacy 模式保留，不进入严格 JSON prompt。

## 删除 Wrapped 方案

不保留 `table_edit_wrapped_v1`。

原因：

```text
1. JSON 字符串里再塞 <tableEdit> 会继续污染提示词。
2. 模型仍要处理标签闭合、函数调用、双引号转义和换行转义。
3. 低能力模型最容易坏的部分没有被移除，只是被包进 JSON。
4. 严格 JSON 模式的目标是让模型输出纯 JSON 数据，而不是输出一段旧 DSL 字符串。
```

因此严格 JSON 模式没有 wrapped 兼容格式，没有 fallback 格式，没有模式选择。

## 表格定位原则

新协议禁止数字表 ID。

AI 只能使用：

```ts
sheet: string
```

`sheet` 必须从系统提示词列出的可编辑表格中复制。示例：

```text
可编辑表格：
- sheet: "角色状态"，字段：姓名、状态、位置、备注
- sheet: "关系记录"，字段：姓名、关系、好感、备注
- sheet: "纪要"，字段：时间、内容
```

程序解析规则：

```text
1. 先按内部 sheetKey 精确匹配。
2. 再按表名精确匹配。
3. 再按本轮生成的稳定 sheet 别名精确匹配。
4. 匹配 0 个表：报错并重试。
5. 匹配多个表：报错并重试。
6. 不做模糊匹配，不猜表。
```

如果内部 sheetKey 对模型不可读，提示词应使用表名或本轮稳定别名，而不是数字 ID。

## 字段定位原则

新协议禁止数字列号。

`row`、`where`、`set` 都必须使用表头字段名：

```json
{
  "姓名": "小玉",
  "状态": "疲惫"
}
```

程序解析规则：

```text
1. 字段名必须与目标表表头精确匹配。
2. 匹配不到字段：报错并重试。
3. 匹配多个字段：报错并重试。
4. 不做模糊匹配，不猜列。
5. 程序内部再把字段名映射成现有列索引。
```

## 动态 Schema 生成

原生模式的严格 JSON 不能使用静态 schema，因为每个聊天、模板、分组、表结构都可能不同。严格性来自“运行时动态生成 schema + 程序二次校验”。

固定部分：

```text
format 固定为 table_edit_ops_v1
ops 固定为数组
op 固定为 insert/update/delete
insert/update/delete 的结构固定
```

动态部分：

```text
sheet enum 来自本轮可编辑表
row 允许字段来自该 sheet 的表头
where 允许字段来自该 sheet 的表头
set 允许字段来自该 sheet 的表头
```

动态 schema 有两种实现策略。

策略 A：强 schema 分支。

```text
ops.items 使用 oneOf。
每个可编辑 sheet 生成 insert/update/delete 三个分支。
每个分支里 sheet 是 const。
row/where/set 的 properties 是该表字段集合。
additionalProperties=false。
```

示意：

```json
{
  "op": "insert",
  "sheet": "角色状态",
  "row": {
    "姓名": "...",
    "状态": "...",
    "位置": "..."
  }
}
```

这里的 `角色状态/姓名/状态/位置` 不是固定写死，而是由当前表结构生成。如果当前表是 `背包`，schema 分支就生成 `sheet: "背包"` 和背包表字段。

策略 B：宽 schema + 程序严格校验。

```text
response_format 只约束 format/op/sheet/row/where/set 的基本类型。
sheet 和字段名的合法性由 extractStrictJsonTableFillResponse_ACU 根据当前表结构校验。
```

采用规则：

```text
1. 动态 schema 工具生成时优先生成策略 A。
2. 本轮动态 schema 超过明确阈值时使用策略 B。
3. 无论使用哪种策略，程序二次校验都是必需的。
4. 程序二次校验失败必须重试，不能静默猜表、猜字段。
```

“复杂 schema”必须用固定阈值判定，不能凭感觉判断。

建议阈值：

```text
可编辑表数量 > 8：降级为策略 B。
任意单表字段数量 > 32：降级为策略 B。
所有可编辑字段总数 > 120：降级为策略 B。
oneOf 分支数量 > 48：降级为策略 B。
序列化后的 response_format JSON 大小 > 24KB：降级为策略 B。
动态 schema 工具只负责生成候选 schema，不在默认请求链路中自动探测后端兼容性。
```

oneOf 分支数量计算：

```text
分支数 = 可编辑表数量 * 3
```

因为每张表需要生成：

```text
insert 分支
update 分支
delete 分支
```

策略 B 不是放松业务校验，只是放松 API 侧 schema。程序侧仍必须按当前表结构严格校验：

```text
sheet 必须精确匹配本轮可编辑表。
字段必须精确匹配目标表表头。
update/delete 的 where 必须定位唯一行。
tableId、rowIndex、数字列号仍然拒绝。
```

降级选择函数建议：

```ts
function shouldUseWideStrictJsonSchema_ACU(stats: {
  sheetCount: number;
  maxFieldCount: number;
  totalFieldCount: number;
  oneOfBranchCount: number;
  responseFormatBytes: number;
}) {
  return stats.sheetCount > 8
    || stats.maxFieldCount > 32
    || stats.totalFieldCount > 120
    || stats.oneOfBranchCount > 48
    || stats.responseFormatBytes > 24 * 1024;
}
```

因此“严格 JSON”不是指所有表结构在代码里写死，而是指响应外壳、操作类型、字段类型、合法 sheet/字段集合在本轮请求中被严格约束。

## 行定位原则

新协议禁止数字行号。

更新和删除必须使用 `where` 对象定位唯一行：

```json
{
  "where": {
    "姓名": "小玉"
  }
}
```

程序定位规则：

```text
1. where 必须至少包含一个字段。
2. where 中所有字段都必须存在于目标表。
3. where 中所有字段必须同时匹配同一行。
4. 命中 0 行：报错并重试。
5. 命中 1 行：执行。
6. 命中多行：报错并重试，要求 AI 增加 where 条件。
```

禁止：

```json
{"tableId": 1}
```

禁止：

```json
{"rowIndex": 3}
```

## 原生表格模式协议

原生表格模式使用 `table_edit_ops_v1`。

这里的严格 JSON 不是写死某一张表的固定模板。`format/op/sheet/row/where/set` 这些协议外壳是固定的，但 `sheet` 允许值、`row/where/set` 允许字段必须由程序根据本次实际可编辑表动态生成。

也就是说，每次填表请求都会基于当前 `targetSheetKeys`、表名、表头、锁定规则和当前数据生成本轮专属 schema/prompt：

```text
本轮可编辑表 A -> schema 允许 sheet=A，只允许 A 的字段
本轮可编辑表 B -> schema 允许 sheet=B，只允许 B 的字段
本轮不可编辑表 C -> schema 不包含 C
```

文档中的 `角色状态/姓名/状态` 只是说明结构，不是固定模板。实际实现不能把这些示例硬编码进 prompt 或 schema。

响应必须是单个 JSON 对象：

```json
{
  "format": "table_edit_ops_v1",
  "ops": []
}
```

### 插入

```json
{
  "op": "insert",
  "sheet": "角色状态",
  "row": {
    "姓名": "小玉",
    "状态": "疲惫",
    "位置": "卧室"
  }
}
```

规则：

```text
1. op 固定为 insert。
2. sheet 必须精确匹配可编辑表格。
3. row 必须是字段名到字符串值的对象。
4. row 字段必须存在于目标表表头。
5. 未提供的字段由程序按现有插入逻辑补默认值或空值。
```

### 更新

```json
{
  "op": "update",
  "sheet": "关系记录",
  "where": {
    "姓名": "小玉"
  },
  "set": {
    "好感": "升高",
    "备注": "接受安抚"
  }
}
```

规则：

```text
1. op 固定为 update。
2. where 必须定位唯一行。
3. set 必须至少包含一个字段。
4. set 只更新指定字段。
5. where 和 set 的字段都必须存在于目标表表头。
```

### 删除

```json
{
  "op": "delete",
  "sheet": "临时事件",
  "where": {
    "事件": "已完成的临时约定"
  }
}
```

规则：

```text
1. op 固定为 delete。
2. where 必须定位唯一行。
3. 不允许按数字行号删除。
```

### 完整示例

下面示例只用于说明 JSON 形状。真实运行时必须用本轮 prompt 列出的 `sheet` 和字段名，不能照抄示例里的表名和字段名。

```json
{
  "format": "table_edit_ops_v1",
  "ops": [
    {
      "op": "insert",
      "sheet": "角色状态",
      "row": {
        "姓名": "小玉",
        "状态": "疲惫",
        "位置": "卧室"
      }
    },
    {
      "op": "update",
      "sheet": "关系记录",
      "where": {
        "姓名": "小玉"
      },
      "set": {
        "好感": "升高"
      }
    }
  ]
}
```

无修改时：

```json
{"format":"table_edit_ops_v1","ops":[]}
```

## SQLite 模式协议

SQLite 模式使用 `table_edit_sql_v1`。

SQLite 模式当前实现已经在 `$0` 中提供 DDL、Note、Trigger 和当前数据。代码位置：`src/service/ai/prompt-builder/prompt-prepare.ts`。

关键事实：`formatTableForSqliteMode` 会直接输出 `table.sourceData.ddl`，并且当前数据表头优先使用 DDL 中解析出的列名，代码注释明确写着“优先使用 DDL 中的英文列名作为表头，避免 AI 看到中文列名后用中文属性名写 SQL”。

因此 SQLite 严格 JSON 不能设计 `sheet/where/set` 中间结构，也不能在示例里暗示使用中文表名/中文字段名。AI 应该直接按提示词中真实 DDL 的表名、列名、约束写 SQL。程序只负责用严格 JSON 收集 SQL 脚本文本，并继续交给现有 SQLite 安全检查和提交链路执行。

响应必须是单个 JSON 对象：

```json
{
  "format": "table_edit_sql_v1",
  "sql": ""
}
```

完整示例：

```json
{
  "format": "table_edit_sql_v1",
  "sql": "UPDATE character_status SET status='tired', location='bedroom' WHERE name='Xiaoyu';\nINSERT INTO summary_log (turn_label, content) VALUES ('current', 'Xiaoyu accepted comfort and returned to the bedroom to rest');"
}
```

上面的英文表名和字段名只是文档示例。真实运行时必须以 `$0` 中输出的 DDL 为准，不能凭空翻译或使用中文列名。

规则：

```text
1. format 固定为 table_edit_sql_v1。
2. sql 必须是字符串。
3. sql 字符串是一段完整 SQL 脚本，可包含多条语句，用换行分隔。
4. 允许的语句类型仍由现有 SQLite 填表规则约束，主要是 INSERT、UPDATE、DELETE。
5. UPDATE 和 DELETE 应带 WHERE，避免无条件更新或删除。
6. 每条 SQL 必须以分号结尾。
7. UPDATE 和 DELETE 的 WHERE 建议优先使用 DDL 中的 UNIQUE 约束、业务唯一字段或 Note/Trigger 指定的业务键定位。
8. 程序不新增 row_id WHERE 拒绝规则，不自动改写 AI 已生成的 SQL。
9. 表名、字段名、唯一约束必须直接依据提示词提供的 DDL。
10. 不要把中文展示名、中文注释或中文剧情词当作 SQL 表名/字段名，除非 DDL 本身就是中文标识符。
11. 禁止 SELECT、DROP、ALTER、CREATE、PRAGMA 等非填表语句。
12. SQL 安全检查继续由现有 SQLite 提交链路执行。
```

无修改时：

```json
{"format":"table_edit_sql_v1","sql":""}
```

## 设置项设计

用户可见的行为开关只新增一个：

```ts
strictJsonTableFillEnabled: false
```

不新增模式选择，不新增 fallback 开关，不新增 schema 开关。

为了让 strict prompt 与 legacy prompt 完全隔离，需要新增两个 strict 专用 prompt 存储字段：

```ts
strictJsonCharCardPrompt: DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU,
strictJsonSqlCharCardPrompt: DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU,
```

这两个字段不是模式开关，只用于保存 strict 模式下的提示词内容，避免 strict 模式复用或拼接 legacy `charCardPrompt`。

固定选择规则：

```text
strictJsonTableFillEnabled=false
使用现有 legacy 填表协议。

strictJsonTableFillEnabled=true && 原生表格模式
使用 table_edit_ops_v1。

strictJsonTableFillEnabled=true && SQLite 模式
使用 table_edit_sql_v1。
```

内部常量：

```ts
const STRICT_JSON_TABLE_FILL_USE_RESPONSE_FORMAT = true;
const STRICT_JSON_TABLE_FILL_SCHEMA_STRICT = true;
```

严格 JSON 开关只控制提示词和响应解析，不自动修改 API body。若用户需要 API 级 schema 约束，可在 API 配置的附加 Body 参数中自行设置 `response_format`。

## Prompt 设计

严格 JSON 开启后，最终发送给 AI 的填表 prompt 必须只描述新 JSON 响应格式。

Prompt 必须使用正向约束，只告诉模型“应该输出什么”。不要在 AI 可见文本里列旧协议禁用词，因为这会把旧词重新注入模型上下文。

旧协议关键词检测只能作为工程侧校验实现，例如放在 `STRICT_JSON_PROMPT_LEGACY_TOKEN_DENYLIST_ACU` 之类的常量里，用来检查最终 messages 是否污染。该 denylist 不能拼接进 prompt，不能展示给模型。

### 原生表格模式 Prompt

```text
## 严格 JSON 填表响应协议

回复内容必须是一个合法 JSON 对象，且只能包含这个 JSON 对象本身。

本次必须使用：
{"format":"table_edit_ops_v1","ops":[]}

ops 只允许 insert、update、delete 三种操作。

insert 格式：
{"op":"insert","sheet":"表格名","row":{"字段名":"字段值"}}

update 格式：
{"op":"update","sheet":"表格名","where":{"字段名":"定位值"},"set":{"字段名":"新值"}}

delete 格式：
{"op":"delete","sheet":"表格名","where":{"字段名":"定位值"}}

规则：
- 回复必须完全符合上述 JSON 对象结构。
- ops 中每一项只能使用 op、sheet、row、where、set 这些字段。
- insert 只能包含 op、sheet、row。
- update 只能包含 op、sheet、where、set。
- delete 只能包含 op、sheet、where。
- sheet 必须从系统列出的可编辑表格中复制。
- 字段名必须从对应表格的表头中复制。
- update/delete 必须使用 where 定位唯一行。
- 如果没有任何修改，输出 {"format":"table_edit_ops_v1","ops":[]}。
```

### SQLite 模式 Prompt

```text
## 严格 JSON SQL 填表响应协议

回复内容必须是一个合法 JSON 对象，且只能包含这个 JSON 对象本身。

本次必须使用：
{"format":"table_edit_sql_v1","sql":""}

规则：
- 回复必须完全符合上述 JSON 对象结构。
- 根对象只能包含 format 和 sql 两个字段。
- sql 必须是字符串。
- sql 是按 DDL 写出的完整 SQL 脚本，可包含多条 INSERT、UPDATE 或 DELETE。
- UPDATE 和 DELETE 应带 WHERE，避免无条件更新或删除。
- UPDATE 和 DELETE 的 WHERE 优先使用 DDL 中的 UNIQUE 约束、业务唯一字段或 Note/Trigger 指定的业务键定位。
- 每条 SQL 必须以分号结尾。
- 表名和字段名必须从上文 DDL 中逐字复制。
- 当前数据表头优先使用 DDL 列名；不要把中文注释、中文剧情描述或中文显示名当作 SQL 标识符。
- 除非 DDL 本身使用中文标识符，否则 SQL 里不要写中文表名或中文字段名。
- 如果没有任何修改，输出 {"format":"table_edit_sql_v1","sql":""}。
```

SQLite 严格 JSON prompt 必须接在现有 `$0` SQLite 表格上下文之后使用。当前 `$0` 已由 `formatTableForSqliteMode` 输出 DDL 和当前数据，严格 JSON prompt 只改变响应外壳，不替代 DDL 指导。

同时必须修改现有 `$0` SQLite 兜底说明。当前代码在 `src/service/ai/prompt-builder/prompt-prepare.ts` 追加：

```text
-- 所有 UPDATE 和 DELETE 必须带 WHERE 条件，优先参考各表 Note 中的 SQL 示例和 DDL 中的 UNIQUE 约束选择定位方式
```

严格 JSON 改造时应替换为：

```text
-- 所有 UPDATE 和 DELETE 应带 WHERE 条件，避免无条件更新或删除
-- 优先参考各表 Note 中的 SQL 示例、DDL 中的 UNIQUE 约束、业务唯一字段选择定位方式
```

### Prompt 隔离策略

严格 JSON 模式必须使用完全隔离的新默认提示词，不对 legacy prompt 做追加、覆盖、裁剪或正则替换。

提示词选择矩阵：

```text
strictJsonTableFillEnabled=false && 原生表格模式
使用现有 DEFAULT_CHAR_CARD_PROMPT_ACU。

strictJsonTableFillEnabled=false && SQLite 模式
使用现有 DEFAULT_CHAR_CARD_PROMPT_SQL_ACU。

strictJsonTableFillEnabled=true && 原生表格模式
使用新增 DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU。

strictJsonTableFillEnabled=true && SQLite 模式
使用新增 DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU。
```

实现要求：

```text
1. strict 模式不复用 legacy 默认提示词。
2. strict 模式不在 legacy prompt 后动态追加协议。
3. strict 模式不尝试从 legacy prompt 中删除旧输出格式。
4. strict 模式的默认 prompt 从源头就不包含旧协议输出示例。
5. 原生 strict prompt 只描述 table_edit_ops_v1。
6. SQLite strict prompt 只描述 table_edit_sql_v1。
7. 当前 $0 表格上下文仍按存储模式生成：原生输出表格/字段/数据，SQLite 输出 DDL/Note/Trigger/当前数据。
```

用户自定义 prompt 处理：

```text
1. 现有 charCardPrompt 继续作为 legacy prompt 设置保留。
2. 新增 strictJsonCharCardPrompt 和 strictJsonSqlCharCardPrompt，分别保存原生 strict 与 SQLite strict 的自定义提示词。
3. strictJsonTableFillEnabled=true 时，只读取 strict 专用 prompt。
4. strict 专用 prompt 为空时使用对应 strict 默认提示词。
5. 不把 legacy prompt 和 strict prompt 混合。
```

新增默认值：

```ts
DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU
DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU
```

新增设置项：

```ts
strictJsonCharCardPrompt: DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU,
strictJsonSqlCharCardPrompt: DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU,
```

最终 messages 构建前必须按上述矩阵选择 prompt 源，而不是在 `callCustomOpenAI_ACU` 末尾动态注入 strict 协议。

## API Schema 配置

严格 JSON 填表开关不自动注入 `response_format/json_schema`。

原因：

```text
1. 项目已有 API 附加 Body 参数配置，用户可以自行设置 response_format。
2. 不同后端对 json_schema 支持差异很大，自动注入会造成兼容性问题。
3. 自动失败后重试会让不兼容后端每次多浪费一次请求。
4. strict JSON 的基础能力应由隔离 prompt + 程序解析校验保证，而不是强依赖 API schema。
```

用户如需 API 级 schema 约束，可以在 API 配置的附加 Body 参数里手动配置，例如按后端能力填写 `response_format`。本功能不覆盖用户的 `bodyParams`，也不在请求失败时自动删除用户配置的 `response_format`。

程序仍然保留动态 schema 构建工具用于测试、诊断或未来手动配置辅助，但默认请求链路不调用它。

## 响应提取器

新增模块：

```text
src/service/ai/prompt-builder/strict-json-table-fill.ts
```

核心函数：

```ts
extractStrictJsonTableFillResponse_ACU(text, context)
```

返回：

```ts
{
  ok: boolean;
  format?: 'table_edit_ops_v1' | 'table_edit_sql_v1';
  operations?: any[];
  sql?: string;
  normalizedTableEditText?: string;
  error?: string;
  retryHint?: string;
}
```

解析流程：

```text
1. 去掉可能的 markdown code fence。
2. 尝试 JSON.parse 完整响应。
3. 完整解析失败时，截取第一个 JSON 对象再 parse。
4. 校验 format 是否符合当前存储模式。
5. 原生模式校验 ops。
6. SQLite 模式校验 sql 字符串。
7. 原生模式把 sheet/字段/where 解析成内部操作。
8. SQLite 模式把 sql 字符串直接作为 SQL 脚本文本。
9. 返回归一化结果给现有提交链路。
```

严格 JSON 开启时，不接受 legacy `<tableEdit>`。

## 原生 ops 到内部操作

原生 JSON ops 转换规则：

```text
insert -> 根据 sheet 找表，根据 row 字段名找列，构造插入行。
update -> 根据 sheet 找表，根据 where 定位唯一行，根据 set 字段名找列，构造更新。
delete -> 根据 sheet 找表，根据 where 定位唯一行，构造删除。
```

内部执行可以有两种实现方式：

```text
1. 转成现有 DSL 后复用 parseAndApplyTableEditsToData_ACU。
2. 直接调用现有表格编辑应用逻辑。
```

无论实现选哪种，对 AI 都不可见。AI 永远只看 JSON ops。

## SQLite sql 到内部提交

SQLite JSON sql 处理规则：

```text
1. sql 必须是字符串。
2. trim 后为空表示本轮无 SQL 修改。
3. 非空 sql 原样作为 SQL 脚本文本，不拆成数组，不做字段映射。
4. 是否每条语句以分号结尾、是否仅包含允许语句、UPDATE/DELETE 是否带 WHERE，由 SQLite SQL 安全检查负责。
5. 交给现有 SQLite SQL 提交和事务逻辑。
```

严格 JSON 改造不新增 row_id WHERE 处理逻辑：

```text
1. strict JSON 改造不新增无 WHERE 拒绝逻辑。
2. 不拒绝 AI 写出的 row_id WHERE。
3. 不自动改写 AI 写出的 row_id WHERE。
4. 不把 row_id WHERE 变成 strict JSON 模式专属失败原因。
5. AI 生成的 SQL 在 JSON 解析成功后原样交给现有 SQLite SQL 提交链路。
```

## 收集链路改造

修改：

```text
src/service/table/update-orchestrator.ts
```

当前硬判断 `<tableEdit>` 的逻辑需要替换。

strict 关闭：

```text
保持当前 legacy 提取逻辑。
```

strict 开启：

```text
1. 调用 extractStrictJsonTableFillResponse_ACU。
2. 失败则抛 retryHint，触发重试。
3. 成功则返回归一化 tableEditText 或内部操作文本。
4. 后续提交链路继续使用归一化结果。
```

## 解析链路改造

修改：

```text
src/service/ai/prompt-builder/table-edit-parser.ts
```

strict 关闭：

```text
保持现有 parseAndApplyTableEditsToData_ACU 行为。
```

strict 开启：

```text
1. 先解析严格 JSON。
2. 原生模式执行 ops 转换和应用。
3. SQLite 模式交给 SQL 提交路径。
4. 不调用 legacy <tableEdit> 提取器处理原始 AI 回复。
```

## UI 设计

新增一个开关：

```text
[ ] 严格 JSON 填表响应
```

说明文案：

```text
开启后，填表 AI 必须返回严格 JSON。原生表格模式使用结构化操作数组，SQLite 模式使用完整 SQL 脚本字符串。适合容易输出标签混乱的模型。
```

不提供模式下拉，不提供 fallback 选项，不提供 schema 选项。

提示词编辑区需要按当前开关和存储模式显示对应 prompt 源：

```text
strictJsonTableFillEnabled=false && 原生表格模式
编辑 legacy charCardPrompt。

strictJsonTableFillEnabled=false && SQLite 模式
编辑 legacy SQLite charCardPrompt。

strictJsonTableFillEnabled=true && 原生表格模式
编辑 strictJsonCharCardPrompt。

strictJsonTableFillEnabled=true && SQLite 模式
编辑 strictJsonSqlCharCardPrompt。
```

重置默认提示词时也必须按矩阵选择默认值，不能把 legacy 默认提示词重置到 strict prompt 字段里。

## 错误重试提示

提取器返回明确 retryHint：

```text
JSON_PARSE_FAILED
回复不是合法 JSON。请只返回一个 JSON 对象，不要解释、Markdown 或代码块。

WRONG_FORMAT_FOR_NATIVE
当前是原生表格模式，format 必须是 table_edit_ops_v1。

WRONG_FORMAT_FOR_SQLITE
当前是 SQLite 模式，format 必须是 table_edit_sql_v1。

UNKNOWN_SHEET
sheet 未匹配到可编辑表格。请从系统列出的 sheet 中复制。

UNKNOWN_FIELD
字段名不存在。请从目标表表头中复制字段名。

WHERE_MATCH_NONE
where 未匹配到任何行。请修正定位条件。

WHERE_MATCH_MULTIPLE
where 匹配到多行。请增加条件定位唯一行。

INVALID_SQL_SCRIPT
sql 必须是字符串，内容是一段按 DDL 写出的 INSERT/UPDATE/DELETE SQL 脚本。

```

## 测试计划

新增：

```text
tests/service/ai/strict-json-table-fill.test.ts
```

覆盖：

```text
1. 原生模式 table_edit_ops_v1 insert 成功。
2. 原生模式 update 使用 where 定位唯一行成功。
3. 原生模式 delete 使用 where 定位唯一行成功。
4. 原生模式 tableId 被拒绝。
5. 原生模式 rowIndex 被拒绝。
6. 原生模式未知 sheet 被拒绝。
7. 原生模式未知字段被拒绝。
8. 原生模式 where 0 命中被拒绝。
9. 原生模式 where 多命中被拒绝。
10. SQLite 模式 table_edit_sql_v1 的 sql 字符串成功进入 SQL 提交路径。
11. SQLite 模式 table_edit_ops_v1 被拒绝。
12. 原生模式 table_edit_sql_v1 被拒绝。
13. SQLite 模式 UPDATE/DELETE 无 WHERE 不作为 strict JSON 新增门禁。
14. SQLite 模式 UPDATE/DELETE 使用 row_id WHERE 时不因 strict JSON 规则被拒绝或改写，SQL 原样进入现有 SQLite 提交链路。
15. strict 开启时裸 <tableEdit> 被拒绝。
16. strict 关闭时 legacy <tableEdit> 仍成功。
17. markdown code fence 包裹 JSON 可恢复。
18. JSON 前后废话可截取恢复，但仍必须通过 schema 校验。
```

更新：

```text
tests/service/ai/table-edit-parser.test.ts
tests/integration/ai-fill-table.test.ts
tests/service/table/table-update-queue.test.ts
```

## 实现任务清单

后续实现时必须逐项把 `[ ]` 改成 `[x]`。没有对应代码、测试或验证记录的项目不能打勾。

### 配置与默认值

- [x] 在 `src/service/runtime/state-manager.ts` 增加 `strictJsonTableFillEnabled`、`strictJsonCharCardPrompt`、`strictJsonSqlCharCardPrompt` 默认值。
- [x] 在 `src/service/settings/settings-service.ts` 的 `buildDefaultSettings_ACU` 增加同名默认值。
- [x] 确认设置加载、保存、导入、导出流程不会丢失三个新字段。
- [x] 保持 `charCardPrompt` 作为 legacy prompt 字段，不把 strict prompt 混入 legacy 字段。

### 隔离默认提示词

- [x] 新增 `DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU`。
- [x] 新增 `DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU`。
- [x] 原生 strict 默认提示词只描述 `table_edit_ops_v1`。
- [x] SQLite strict 默认提示词只描述 `table_edit_sql_v1`。
- [x] strict 默认提示词不包含 legacy 输出格式示例。
- [x] strict 默认提示词使用正向约束，不把旧协议关键词作为 AI 可见禁用列表写入 prompt。

### Prompt 源选择

- [x] legacy 原生模式使用 `charCardPrompt`。
- [x] legacy SQLite 模式使用现有 SQLite legacy prompt。
- [x] strict 原生模式使用 `strictJsonCharCardPrompt` 或 `DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU`。
- [x] strict SQLite 模式使用 `strictJsonSqlCharCardPrompt` 或 `DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU`。
- [x] 不在 legacy prompt 末尾动态追加 strict 协议。
- [x] 不对 legacy prompt 做正则裁剪、覆盖或替换来生成 strict prompt。
- [x] 构建最终 messages 后做工程侧污染检查，strict 模式下发现旧协议关键词只记录 warning，不把 denylist 展示给 AI。

### SQLite Prompt 上下文

- [x] 保持 `formatTableForSqliteMode` 输出 DDL、Note、Trigger、当前数据的现有能力。
- [x] 保持当前数据表头优先使用 DDL 列名的逻辑。
- [x] 更新 SQLite `$0` 兜底说明，使其匹配 strict 和 legacy 两种模式。
- [x] strict SQLite prompt 只改变响应外壳，不替代 DDL 指导。
- [x] SQLite strict 模式不新增 row_id WHERE 拒绝逻辑。
- [x] SQLite strict 模式不自动改写 AI 生成的 SQL。

### Strict JSON 模块

- [x] 新增 `src/service/ai/prompt-builder/strict-json-table-fill.ts`。
- [x] 实现 strict JSON 响应提取函数。
- [x] 支持完整 JSON 解析。
- [x] 支持去掉 markdown code fence 后解析。
- [x] 支持从前后废话中截取 JSON 对象后解析。
- [x] strict 开启时不接受 legacy 裸响应。
- [x] strict 关闭时不改变现有 legacy 解析行为。

### 原生 Ops 协议

- [x] 实现 `table_edit_ops_v1` 根对象校验。
- [x] 实现 `insert` op 校验。
- [x] 实现 `update` op 校验。
- [x] 实现 `delete` op 校验。
- [x] 实现 sheet 精确匹配本轮可编辑表。
- [x] 实现字段名精确匹配目标表表头。
- [x] 拒绝未知 sheet。
- [x] 拒绝未知字段。
- [x] 拒绝额外字段。
- [x] 拒绝数字表定位字段。
- [x] 拒绝数字行定位字段。
- [x] update/delete 的 where 必须至少包含一个字段。
- [x] update/delete 的 where 必须定位唯一行。
- [x] where 命中 0 行时返回可重试错误。
- [x] where 命中多行时返回可重试错误。
- [x] 将合法 ops 转成内部编辑操作或内部 DSL，且转换过程不暴露给 AI。

### SQLite SQL 协议

- [x] 实现 `table_edit_sql_v1` 根对象校验。
- [x] 校验 `sql` 必须是字符串。
- [x] `sql.trim()` 为空时表示无修改。
- [x] 非空 SQL 原样作为 SQL 脚本文本进入现有 SQLite 提交流程。
- [x] 不把 SQL 拆成数组。
- [x] 不做 `sheet/where/set` 中间结构转换。
- [x] 不新增 row_id WHERE 拒绝。
- [x] 不自动改写 row_id WHERE。
- [x] 不新增 UPDATE/DELETE 无 WHERE 门禁，仅保留 prompt 引导和现有 SQL 提交流程。

### 动态 Schema

- [x] 根据本轮可编辑表和字段生成强 schema 统计信息。
- [x] 实现强 schema：每个可编辑 sheet 生成 insert/update/delete 分支。
- [x] 强 schema 中 sheet 使用 const 或 enum。
- [x] 强 schema 中 row/where/set 的字段来自对应表头。
- [x] 实现宽 schema 降级。
- [x] 按阈值决定强 schema 或宽 schema：可编辑表数量、最大字段数、总字段数、oneOf 分支数、response_format 字节数。
- [x] 动态 schema 工具仅保留为工具能力，不接入默认请求链路。
- [x] 无论强 schema 还是宽 schema，都执行程序侧严格校验。

### API 请求

- [x] strict 开启时不自动注入 `response_format/json_schema`。
- [x] 用户仍可通过 API 附加 Body 参数自行配置 `response_format`。
- [x] 不做 schema 不兼容后的自动重试，避免每次浪费一次请求。
- [x] 酒馆主 API 和酒馆连接预设路径不受 schema 注入影响。

### 收集链路

- [x] 修改 `collectGroupFillResponse_ACU`，strict 开启时不再硬检查 legacy 标签。
- [x] strict 开启时收集阶段调用 strict JSON 提取器。
- [x] strict 原生成功时返回归一化内部操作文本或 tableEditText。
- [x] strict SQLite 成功时返回 SQL 脚本文本。
- [x] strict 解析失败时返回明确 retryHint。
- [x] strict 关闭时保持现有收集逻辑。

### 解析与提交链路

- [x] 修改 `parseAndApplyTableEditsToData_ACU`，strict 开启时不直接解析原始 legacy 响应。
- [x] strict 原生模式走 ops 校验和应用。
- [x] strict SQLite 模式走 SQL 提交路径。
- [x] strict SQLite 模式 SQL 原样进入现有 SQLite 安全检查和事务提交。
- [x] 所有成功写入仍进入现有操作日志和持久化链路。
- [x] strict 关闭时现有 legacy 行为不变。

### UI

- [x] 增加“严格 JSON 填表响应”单开关。
- [x] 不增加模式下拉。
- [x] 不增加 fallback 开关。
- [x] 不增加 schema 开关。
- [x] 提示词编辑区根据 strict 开关和存储模式显示对应 prompt 字段。
- [x] 重置默认提示词根据 strict 开关和存储模式写入对应默认 prompt。
- [x] UI 文案说明原生模式使用结构化 JSON 操作，SQLite 模式使用完整 SQL 脚本文本。

### 测试

- [x] 新增 `tests/service/ai/strict-json-table-fill.test.ts`。
- [x] 覆盖原生 strict insert 成功。
- [x] 覆盖原生 strict update 通过 where 唯一定位成功。
- [x] 覆盖原生 strict delete 通过 where 唯一定位成功。
- [x] 覆盖原生 strict 未知 sheet 被拒绝。
- [x] 覆盖原生 strict 未知字段被拒绝。
- [x] 覆盖原生 strict 额外字段被拒绝。
- [x] 覆盖原生 strict 数字表定位字段被拒绝。
- [x] 覆盖原生 strict 数字行定位字段被拒绝。
- [x] 覆盖原生 strict where 命中 0 行被拒绝。
- [x] 覆盖原生 strict where 命中多行被拒绝。
- [x] 覆盖 SQLite strict `sql` 字符串成功进入 SQL 提交路径。
- [x] 覆盖 SQLite strict 不拆 SQL 数组。
- [x] 覆盖 SQLite strict 不做 `sheet/where/set` 转换。
- [x] 覆盖 SQLite strict 不拒绝 row_id WHERE。
- [x] 覆盖 SQLite strict 不改写 row_id WHERE。
- [x] 覆盖 SQLite strict 不新增 UPDATE/DELETE 无 WHERE 门禁。
- [x] 覆盖 strict 开启时 legacy 裸响应被拒绝。
- [x] 覆盖 strict 关闭时 legacy 响应仍成功。
- [x] 覆盖 markdown code fence 包裹 JSON 可恢复。
- [x] 覆盖 JSON 前后废话可截取恢复。
- [x] 更新 `tests/service/ai/table-edit-parser.test.ts`。
- [x] 更新 `tests/integration/ai-fill-table.test.ts`。
- [x] 更新 `tests/service/table/table-update-queue.test.ts`。

## 验收清单

### 行为验收

- [x] `strictJsonTableFillEnabled=false` 时现有 legacy 行为不变。
- [x] `strictJsonTableFillEnabled=true` 且原生模式时只使用 strict 原生 prompt 源。
- [x] `strictJsonTableFillEnabled=true` 且 SQLite 模式时只使用 strict SQLite prompt 源。
- [x] strict 模式最终 AI messages 不包含 legacy 输出格式示例。
- [x] strict 模式不会把旧协议关键词 denylist 展示给 AI。
- [x] 原生 strict 模式只接受 `table_edit_ops_v1`。
- [x] SQLite strict 模式只接受 `table_edit_sql_v1`。
- [x] 原生 strict 模式不接受 SQL 协议。
- [x] SQLite strict 模式不接受 ops 协议。
- [x] strict 开启时 legacy 裸响应不会被当作成功响应。

### 原生协议验收

- [x] sheet 必须来自本轮可编辑表。
- [x] 字段必须来自对应 sheet 的表头。
- [x] insert/update/delete 结构正确时可执行。
- [x] update/delete 的 where 必须唯一定位。
- [x] where 命中 0 行时不写入。
- [x] where 命中多行时不写入。
- [x] AI 使用数字表定位字段时不写入。
- [x] AI 使用数字行定位字段时不写入。

### SQLite 协议验收

- [x] SQLite strict JSON 只负责收集 `sql` 字符串。
- [x] SQLite strict 模式不把 SQL 拆成数组。
- [x] SQLite strict 模式不把 SQL 转成 `sheet/where/set`。
- [x] SQLite strict 模式不新增 row_id WHERE 拒绝。
- [x] SQLite strict 模式不自动改写 row_id WHERE。
- [x] SQLite strict 模式不新增 UPDATE/DELETE 无 WHERE 门禁。
- [x] SQLite strict SQL 原样进入现有 SQLite 提交事务。

### API 验收

- [x] 严格 JSON 开关不自动注入 `response_format/json_schema`。
- [x] 用户可通过 API 附加 Body 参数自行配置 `response_format`。
- [x] 不因 schema 不兼容自动重试浪费请求。
- [x] 酒馆主 API 路径不受 schema 注入影响。
- [x] 酒馆连接预设路径不受 schema 注入影响。

### UI 验收

- [x] UI 能开关严格 JSON 填表响应。
- [x] UI 不暴露模式下拉、fallback 开关、schema 开关。
- [x] strict 原生模式编辑 strict 原生 prompt 字段。
- [x] strict SQLite 模式编辑 strict SQLite prompt 字段。
- [x] legacy 模式仍编辑 legacy prompt 字段。
- [x] 重置默认提示词写入当前模式对应字段。

### 验证命令

- [x] 运行 strict JSON 单元测试并通过。
- [x] 运行 table edit parser 相关测试并通过。
- [x] 运行 AI 填表集成测试并通过。
- [x] 运行 table update queue 相关测试并通过。
- [x] 运行 `npm run typecheck` 并通过。
- [ ] 运行完整 build 并通过；当前阶段按要求不再主动生成制品，且此前 build 的架构检查失败来自既有无关违规。

## 最终链路

原生表格模式：

```text
AI JSON -> table_edit_ops_v1 校验 -> sheet/字段/where 解析 -> 内部编辑操作 -> 现有提交链路
```

SQLite 模式：

```text
AI JSON -> table_edit_sql_v1 校验 -> SQL 脚本文本 -> 现有 SQLite 安全检查和提交链路
```

legacy 模式：

```text
strictJsonTableFillEnabled=false -> 现有 <tableEdit> 链路
```
