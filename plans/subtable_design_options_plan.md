# 子表格实现方案评估

## 2026-04-03 需求确认

- 目标不是把一张表嵌成 JSON 树，而是继续保持“父表”和“子表”都是独立表。
- 两者通过业务字段关联，典型形式是 `parentRowId`。
- 优先级最高的是：
  1. 数据结构稳定
  2. AI 继续兼容现有填表指令
  3. 后续可逐步补上可视化编辑器分组展示与世界书导出优化

---

## 现状约束

结合当前 [`index.js`](../index.js) 的实现，子表格设计需要遵守以下事实：

1. 当前模板层是平铺的 `sheet_*` 集合，不存在原生嵌套表结构，见 [`DEFAULT_TABLE_TEMPLATE_ACU`](../index.js:1878)。
2. 新增表格时，可视化编辑器只会生成普通表定义，不会记录父子关系元数据，见 [`$addBtn.on()`](../index.js:31104)。
3. AI 指令解析层只认识 [`insertRow()`](../index.js:6497)、[`updateRow()`](../index.js:6355)、`deleteRow` 这套老语法，核心入口在 [`parseTableEditCommandLine_ACU()`](../index.js:27075)。
4. 指令应用阶段仍是“按表索引 + 行索引”落库，不理解子表语义，见 [`parseAndApplyTableEdits_ACU()`](../index.js:27204) 和 [`parseAndApplyTableEdits_ACU()`](../index.js:27315)。
5. 给 AI 的上下文也是按平铺表输出的，后续如果想让 AI 更稳定地产生父子表更新，需要调整 [`prepareAIInput_ACU()`](../index.js:25875) 的展示方式。
6. 世界书导出与可读文本生成也是“按单表处理”，见 [`formatJsonToReadable_ACU()`](../index.js:10331)、[`updateCustomTableExports_ACU()`](../index.js:17136) 和导出 UI [`renderVisualizerConfigPanel_ACU()`](../index.js:31546)。

结论：**最稳妥的方向不是推翻平铺表结构，而是在平铺表之上增加“关系层”**。

---

## 建议统一的基础数据约定

无论采用哪一种方案，底层都建议先统一成下面这套约定：

### 父表最少字段

- `rowId`：父行稳定主键，不能依赖当前行号
- 业务字段若干

### 子表最少字段

- `childRowId`：子行稳定主键
- `parentRowId`：指向父表的 `rowId`
- `sortNo`：同一父行下的子项顺序
- 业务字段若干

### 关系示意

```mermaid
flowchart LR
    A[父表 行含 rowId] --> B[子表 行含 parentRowId]
    B --> C[AI 继续输出 insertRow updateRow deleteRow]
    C --> D[解析器 仍按现有流程写入]
    D --> E[后续再做分组展示与校验]
```

这套约定的关键价值是：**把“行号关联”改成“业务 ID 关联”**。因为当前 [`updateRow()`](../index.js:6355) 依赖行索引，行一旦插删，单靠行号无法稳定表示父子关系。

---

## 方案一：纯字段约定方案

### 核心思路

不改内核结构，不新增关系配置。只要求模板作者在父表和子表中手动增加：

- 父表：`rowId`
- 子表：`childRowId`、`parentRowId`、`sortNo`

AI 仍然按照现有 [`insertRow()`](../index.js:6497) / [`updateRow()`](../index.js:6355) 语法更新两张独立表。

### 需要改动的位置

- 模板默认值：[`DEFAULT_TABLE_TEMPLATE_ACU`](../index.js:1878)
- AI 输入描述：[`prepareAIInput_ACU()`](../index.js:25875)
- 可视化编辑器文案与列建议：[`$addBtn.on()`](../index.js:31104)、[`renderVisualizerConfigPanel_ACU()`](../index.js:31481)

### 优点

- 改动最小
- 与现有 AI 指令完全兼容
- 历史数据结构最容易兼容
- 不会冲击合并、存储、世界书导出主链路

### 缺点

- 没有系统级外键校验
- AI 容易漏填 `parentRowId`
- 前端无法天然知道哪张表是谁的子表
- 后续做树形展示和导出分组时，还得继续补机制

### 适用判断

如果你想先快速上线一个“可用但偏约定式”的子表格能力，这个方案最省事；但它更像“数据规范”，还不算真正的插件级子表格能力。

---

## 方案二：关系元数据增强层

### 核心思路

继续保持底层数据是平铺表，但给每张表增加一个可选的 `relationConfig`，由系统明确声明：

- 这张表是不是子表
- 它挂在哪个父表下
- 父表主键列是哪一列
- 子表外键列是哪一列
- 是否允许删除父行时保留孤儿子行
- 可视化编辑器默认如何分组展示

示例结构：

```js
relationConfig: {
  role: 'child',
  parentSheetKey: 'sheet_parent',
  parentIdColumn: 'rowId',
  childIdColumn: 'childRowId',
  foreignKeyColumn: 'parentRowId',
  orderColumn: 'sortNo',
  renderMode: 'grouped',
  cascadeDelete: false
}
```

### 需要改动的位置

1. **模板层**
   - 在 [`DEFAULT_TABLE_TEMPLATE_ACU`](../index.js:1878) 和新建表逻辑 [`$addBtn.on()`](../index.js:31104) 中增加 `relationConfig`
2. **可视化编辑器**
   - 在 [`renderVisualizerConfigPanel_ACU()`](../index.js:31481) 增加父表选择、主键列、外键列、排序列配置项
3. **AI 输入准备**
   - 在 [`prepareAIInput_ACU()`](../index.js:25875) 中把子表以“父行 + 子行集合”的方式展示给 AI，但底层仍输出成两张表
4. **指令应用与校验**
   - 在 [`parseTableEditCommandLine_ACU()`](../index.js:27075) 之后、[`parseAndApplyTableEdits_ACU()`](../index.js:27204) 内部增加关系校验
   - 例如：插入子表时检查 `parentRowId` 是否存在；新增父表时如果 `rowId` 为空可自动生成
5. **导出与可读文本**
   - 在 [`formatJsonToReadable_ACU()`](../index.js:10331) 与 [`updateCustomTableExports_ACU()`](../index.js:17136) 中增加“按父行聚合显示子项”的可选模式

### 优点

- 兼容现有平铺存储和现有指令语法
- 系统终于“知道”谁是父表、谁是子表
- 可以做外键校验、自动补 ID、分组展示、导出聚合
- 后续扩展到多级子表也有清晰路径

### 缺点

- 改动面中等，需要同时碰模板、编辑器、AI 输入、应用层、导出层
- 需要设计一套稳定的主键列与外键列规则
- 要考虑旧模板没有 `relationConfig` 时的兼容回退

### 适用判断

如果目标是“正式支持子表格”，**这是最平衡、也最值得投入的方案**。

---

## 方案三：子表格专用指令 DSL

### 核心思路

在现有 [`insertRow()`](../index.js:6497) / [`updateRow()`](../index.js:6355) 之外，再引入专门的子表格指令，例如：

```js
insertChildRow(parentTableIndex, parentRowId, childTableIndex, {"0":"xxx"})
updateChildRowsByParent(childTableIndex, parentRowId, [...])
```

甚至让 AI 直接输出“父行 + 子行数组”的嵌套结构，再由解析器拆平成当前表结构。

### 需要改动的位置

- 指令语法与解析：[`parseTableEditCommandLine_ACU()`](../index.js:27075)
- 指令应用主链路：[`parseAndApplyTableEdits_ACU()`](../index.js:27204)
- 默认提示词与格式约束：`DEFAULT_CHAR_CARD_PROMPT_ACU` 相关段落，见 [`DEFAULT_CHAR_CARD_PROMPT_ACU`](../index.js:1822)
- JSON 容错链路也要一起兼容新 payload 形态，仍会影响 [`parseTableEditCommandLine_ACU()`](../index.js:27075)

### 优点

- 子表语义最清晰
- 后续做级联更新、批量替换、父子联动最自然
- 可以减少 AI 自己理解父子关系时的歧义

### 缺点

- 对现有 AI 输出格式冲击最大
- 指令解析、容错、日志、调试成本都会明显上升
- 老模型提示词迁移成本高
- 一旦 AI 输出新旧语法混用，排障复杂度会很高

### 适用判断

这个方案更适合“第二阶段重构”，**不建议作为第一版子表格落地方式**。

---

## 三种方案对比

| 方案 | AI 兼容性 | 改动范围 | 数据一致性 | 可视化分组能力 | 后续扩展性 | 结论 |
|---|---|---|---|---|---|---|
| 方案一 纯字段约定 | 高 | 小 | 低到中 | 低 | 中 | 可快速试水 |
| 方案二 关系元数据增强层 | 高 | 中 | 中到高 | 高 | 高 | **推荐** |
| 方案三 子表格专用 DSL | 中到低 | 大 | 高 | 高 | 很高 | 适合后续重构 |

---

## 推荐路线

### 推荐结论

推荐采用：**方案二为主，方案一为底座，暂不引入方案三新语法**。

也就是：

1. 底层继续使用当前平铺 `sheet_*` 数据结构
2. 父表、子表都保留普通表身份
3. 先强制引入稳定主键列和外键列
4. 再加 `relationConfig` 让系统知道父子关系
5. AI 仍继续输出现有 [`insertRow()`](../index.js:6497) / [`updateRow()`](../index.js:6355) 指令
6. 在系统内部补足关系校验、分组展示、导出聚合

### 这样选的原因

- 最符合你当前强调的“数据结构和 AI 更新兼容”
- 不会破坏当前 [`parseTableEditCommandLine_ACU()`](../index.js:27075) 的成熟容错链路
- 不需要一下子重写整个填表 DSL
- 后续如果真的需要更强语义，再从方案二平滑升级到方案三

---

## 如果进入实施，建议拆成这几个步骤

1. **数据层**：给模板和新建表能力增加主键列 / 外键列约定与 `relationConfig`
2. **AI 层**：改 [`prepareAIInput_ACU()`](../index.js:25875)，把父子表关系展示得更明确
3. **应用层**：在 [`parseAndApplyTableEdits_ACU()`](../index.js:27204) 增加父子关系校验与自动补 ID
4. **编辑器层**：在 [`renderVisualizerConfigPanel_ACU()`](../index.js:31481) 增加父子关系配置 UI，并支持按父行展开子项
5. **导出层**：在 [`formatJsonToReadable_ACU()`](../index.js:10331) / [`updateCustomTableExports_ACU()`](../index.js:17136) 增加聚合显示策略
6. **兼容层**：对没有 `relationConfig` 的旧模板自动按“普通表”处理，避免旧数据失效

---

## 当前建议的优先级

如果你要我继续往下细化，我建议下一步直接输出一份“方案二实施计划”，把需要改的字段结构、UI 表单项、AI 输入格式、校验规则、兼容规则逐条列出来，再准备同步追加到 [`README.md`](../README.md) 作为本次规划记录。
