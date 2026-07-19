# 星·数据库 III UI 重构计划

## 1. 任务目标

基于用户提供的参考 UI 风格与新的分类草稿，对当前主弹窗 UI 做一次信息架构重组与视觉系统升级。

本次计划的目标不是单纯改样式，而是同时解决两个问题：

1. 现有导航按技术模块组织，用户使用路径不直观
2. 现有页面存在功能混装，尤其是 [`状态页`](../src/presentation/pages/main-popup-status.ts)、[`世界书页`](../src/presentation/pages/main-popup-worldbook.ts)、[`数据页`](../src/presentation/pages/main-popup-data.ts)

本次改版必须满足以下硬约束：

- 不减少任何现有功能
- 用户草稿未提到的已有功能也必须保留并重新安置
- 优先复用现有 DOM id、事件绑定和数据结构，避免 UI 改版演变成业务逻辑重写
- 风格向用户截图靠拢：浅色管理台、细边框、弱阴影、蓝色主强调、左侧纵向导航、主内容卡片化

---

## 2. 现状侦察结论

### 2.1 当前一级导航

当前主弹窗由 [`openAutoCardPopup_ACU()`](../src/presentation/pages/main-popup.ts:30) 组装，现有一级标签页为：

- [`status`](../src/presentation/pages/main-popup-status.ts:11) 状态与操作
- [`prompt`](../src/presentation/pages/main-popup-prompt.ts:10) AI 指令预设
- [`api`](../src/presentation/pages/main-popup-api.ts:10) API 与连接
- [`worldbook`](../src/presentation/pages/main-popup-worldbook.ts:10) 世界书
- [`data`](../src/presentation/pages/main-popup-data.ts:11) 数据管理
- [`import`](../src/presentation/pages/main-popup-import.ts:10) 外部导入
- [`plot`](../src/presentation/pages/main-popup-plot.ts:11) 剧情推进
- [`optimization`](../src/presentation/pages/main-popup-optimization.ts:10) 正文替换，默认隐藏
- [`sql-console`](../src/presentation/pages/sql-console.ts:22) SQL 控制台，仅 SQLite 模式显示
- [`log-viewer`](../src/presentation/pages/log-viewer.ts:69) 运行日志

### 2.2 当前页面混装问题

#### A. [`status`](../src/presentation/pages/main-popup-status.ts:11) 混合了仪表盘与更新配置

该页同时包含：

- 数据库状态总览
- 手动更新入口
- 填表相关标签规则
- 自动更新开关
- 功能总开关
- 公用设置
- 更新配置

这说明用户草稿里的“仪表盘”和“更新”在当前实现中尚未拆开。

#### B. [`worldbook`](../src/presentation/pages/main-popup-worldbook.ts:10) 混合了注入目标、读取来源与 0TK

该页同时包含：

- 数据注入目标世界书
- 0TK 占用模式
- 世界书来源选择
- 启用条目管理

但用户草稿要求：

- 世界书注入归入“表格”
- 0TK 迁移到“仪表盘”

因此这里不能整页照搬，必须拆分。

#### C. [`data`](../src/presentation/pages/main-popup-data.ts:11) 同时承载表格配置与数据管理

该页包含：

- 数据隔离
- 合并导入导出
- 导出 JSON
- 恢复默认模板及提示词
- 模板覆盖最新层数据
- 表格模板预设（全局 / 当前聊天）
- 删除范围设置
- 删除本地数据
- 打开可视化表格编辑器
- 纪要合并 Medusa

这意味着“表格”与“数据管理”在当前代码中并未分离。

#### D. [`plot`](../src/presentation/pages/main-popup-plot.ts:11) 是一套强耦合工作流

该页包含：

- 剧情推进总开关
- 预设管理（全局 / 当前聊天）
- 剧情推进 API 预设
- 剧情任务列表与任务参数
- 提示词设置与最终注入指令
- 匹配替换参数，含 `zhaohui` 记忆召回数量
- 自动循环生成
- 剧情推进专用世界书选择
- 循环状态与开始/停止控制

因此，“记忆召回”“剧情规划”“自动循环改名”为三个视觉分区是合适的，但当前阶段不适合强拆成多个一级页面。

---

## 3. 新信息架构

## 3.1 一级导航

建议改为以下一级导航：

1. 仪表盘
2. 更新
3. API
4. 表格
5. 核心功能
6. 数据管理
7. 高级工具

这是本次计划的正式结构，已获得用户确认。

## 3.2 一级导航到现有模块的映射

| 新一级分类 | 承接现有模块 | 说明 |
|---|---|---|
| 仪表盘 | [`status`](../src/presentation/pages/main-popup-status.ts:11) 的状态总览与核心操作区一部分 | 负责展示当前聊天状态、数据库状态、API摘要、快速入口、关键开关、0TK 状态 |
| 更新 | [`status`](../src/presentation/pages/main-popup-status.ts:11) + [`prompt`](../src/presentation/pages/main-popup-prompt.ts:10) | 负责自动更新参数、跳过与重试、标签筛选、数据库更新预设 |
| API | [`api`](../src/presentation/pages/main-popup-api.ts:10) | 原样保留业务结构，主要改视觉与布局 |
| 表格 | [`data`](../src/presentation/pages/main-popup-data.ts:11) 中的模板预设与表格入口 + [`worldbook`](../src/presentation/pages/main-popup-worldbook.ts:10) 的普通世界书注入 | 负责全局/当前聊天模板、表格提示词、世界书注入 |
| 核心功能 | [`plot`](../src/presentation/pages/main-popup-plot.ts:11) + [`import`](../src/presentation/pages/main-popup-import.ts:10) | 负责剧情推进、记忆召回、智能续写、外部导入 |
| 数据管理 | [`data`](../src/presentation/pages/main-popup-data.ts:11) 的数据隔离、删除、备份、Medusa 合并 | 负责数据资产管理 |
| 高级工具 | [`optimization`](../src/presentation/pages/main-popup-optimization.ts:10)、[`sql-console`](../src/presentation/pages/sql-console.ts:22)、[`log-viewer`](../src/presentation/pages/log-viewer.ts:69) | 保留低频高级能力，不混入主流程导航 |

---

## 4. 新页面设计方案

## 4.1 仪表盘

### 页面定位

进入插件后的默认页。强调“当前运行状态 + 立即可操作项”。

### 主要内容

#### A. 顶部状态横条

展示：

- 当前聊天名称
- 当前模式摘要
- API 使用状态摘要
- 数据库状态摘要

该区域对应当前 [`main-popup.ts`](../src/presentation/pages/main-popup.ts:44) 的标题区与 [`status`](../src/presentation/pages/main-popup-status.ts:16) 的数据库状态摘要。

#### B. 数据库状态卡片

保留当前 [`status`](../src/presentation/pages/main-popup-status.ts:16) 的：

- 上下文总层数
- 数据库状态
- 表格状态表
- 下次更新提示

但布局改成截图风格：

- 上方状态摘要条
- 中间表格区域
- 底部辅助状态

#### C. 快速操作卡片

放置：

- 立即手动更新 [`manual-update-card`](../src/presentation/pages/main-popup-status.ts:64)
- 快速手动总结按钮，承接 Medusa 启动入口
- 打开可视化表格编辑器入口

说明：

用户草稿明确要求“快速手动总结按钮”，当前代码里 Medusa 位于 [`data`](../src/presentation/pages/main-popup-data.ts:148)，重构后应在仪表盘提供快捷入口，同时在“数据管理”保留完整配置页。

#### D. 核心功能开关卡片

从当前 [`status`](../src/presentation/pages/main-popup-status.ts:69) 起的开关区中提取：

- 自动更新
- 规范填表
- 静默提示框
- 条件模板
- 0TK 占用模式，从 [`worldbook`](../src/presentation/pages/main-popup-worldbook.ts:24) 迁入

其中 0TK 需要附带说明：

- 它仍然作用于世界书注入链路
- 迁移位置仅是为了提高可见性，不改变逻辑归属

#### E. API 快照卡片

显示：

- 当前 API 模式
- 当前选中的填表 API 预设
- 当前选中的剧情推进 API 预设
- Streaming 开关状态

这部分信息来自 [`main-popup-api.ts`](../src/presentation/pages/main-popup-api.ts:14) 与 [`main-popup-status.ts`](../src/presentation/pages/main-popup-status.ts:42)。

---

## 4.2 更新

### 页面定位

集中放置所有与“数据库更新流程”相关的参数，不再与状态总览混在一起。

### 二级结构

#### A. 基础设置

承接当前：

- AI 读取上下文层数 [`auto-update-threshold`](../src/presentation/pages/main-popup-status.ts:138)
- 每 N 层自动更新一次 [`auto-update-frequency`](../src/presentation/pages/main-popup-status.ts:144)
- 每批次更新楼层数 [`update-batch-size`](../src/presentation/pages/main-popup-status.ts:150)
- 最大并发数 [`max-concurrent-groups`](../src/presentation/pages/main-popup-status.ts:156)
- 保留 X 层不更新 [`skip-update-floors`](../src/presentation/pages/main-popup-status.ts:162)
- 保留最近 N 层数据 [`retain-recent-layers`](../src/presentation/pages/main-popup-status.ts:168)

新增排版要求：

- 将“预选更新方案”设计为顶部方案卡或预设切换器
- 其本质不是新功能，而是把现有更新参数组织成更易选用的组合布局

#### B. 内容筛选

承接当前：

- 跳过更新最小回复长度 [`auto-update-token-threshold`](../src/presentation/pages/main-popup-status.ts:117)
- 填表自动重试次数 [`table-max-retries`](../src/presentation/pages/main-popup-status.ts:124)
- 正文标签提取规则 [`table-context-extract-rules`](../src/presentation/pages/main-popup-status.ts:49)
- 标签排除规则 [`table-context-exclude-rules`](../src/presentation/pages/main-popup-status.ts:55)
- 仅识别最后一对 `<tableEdit>` [`tableedit-last-pair-only-checkbox`](../src/presentation/pages/main-popup-status.ts:61)

这部分与用户草稿“跳过、自动重试、标签排除”一致。

#### C. 更新任务提示词

将 [`prompt`](../src/presentation/pages/main-popup-prompt.ts:14) 的“数据库更新预设 任务指令”并入“更新”页底部，作为“更新任务提示词”区块。

原因：

- 该提示词本质上属于数据库更新流程
- 继续独立占用一级页会打断导航节奏

---

## 4.3 API

### 页面定位

尽量保持当前业务结构不变，只做视觉与排版重构。

### 保留内容

完整保留当前 [`generateApiTabHTML()`](../src/presentation/pages/main-popup-api.ts:10) 的：

- API 模式
- 酒馆连接预设
- 使用主 API
- Streaming
- 自定义 URL / Key / 模型 / 温度 / 最大 Tokens
- 模型列表加载
- API 状态显示
- API 预设管理

### 改版重点

- 由单列长表单改为“连接方式 / 核心参数 / 模型选择 / 预设管理”四段式布局
- 输入区统一浅色边框风格
- 状态信息改为轻量状态条
- 保留所有现有 id，避免修改 [`popup-bindings.ts`](../src/presentation/pages/popup-bindings.ts:33) 的绑定逻辑

---

## 4.4 表格

### 页面定位

聚合“表格结构、模板预设、表格提示词、世界书注入”这些与数据表本身强相关的配置。

### 二级结构

#### A. 当前表格 / 全局表格

承接当前 [`main-popup-data.ts`](../src/presentation/pages/main-popup-data.ts:48) 的模板预设双作用域结构：

- 全局正在使用
- 当前聊天正在使用

这一结构必须完整保留，不能压缩为一个下拉框。

#### B. 表格提示词

来自当前 [`prompt`](../src/presentation/pages/main-popup-prompt.ts:14) 的能力，但在新 IA 下不建议单独一级导航。

两种可行方案中，本计划选择：

- 数据库更新提示词主入口放在“更新”
- 表格页提供“相关提示词入口卡”或“联动说明”

如果后续实现时发现用户更常在“表格”下寻找它，可在 UI 上提供快捷跳转，而不改变逻辑归属。

#### C. 世界书注入

承接当前 [`main-popup-worldbook.ts`](../src/presentation/pages/main-popup-worldbook.ts:14) 中与普通填表相关的部分：

- 数据注入目标
- 世界书来源
- 手动选择世界书
- 启用条目列表

迁移规则：

- 0TK 占用模式不在此处展示，改到“仪表盘”
- 剧情推进专用世界书选择不在此处展示，仍留在“核心功能”

#### D. 表格工具入口

保留：

- 打开可视化表格编辑器 [`open-new-visualizer`](../src/presentation/pages/main-popup-data.ts:141)
- 模板导入导出 / 恢复默认 / 覆盖模板 等与表格本体相关的操作

这些按钮在当前属于“数据管理”，但从用户认知上更偏“表格系统”。

---

## 4.5 核心功能

### 页面定位

这里承接用户草稿中的高频功能区，包括：

- 记忆召回
- 剧情规划
- 智能续写，原自动循环
- 外部导入

### 结构设计

#### A. 记忆召回与剧情规划

基于当前 [`main-popup-plot.ts`](../src/presentation/pages/main-popup-plot.ts:87) 到 [`main-popup-plot.ts`](../src/presentation/pages/main-popup-plot.ts:185) 的任务与提示词区域，整理为：

- 剧情任务列表
- 当前任务参数
- 提示词编辑器
- 最终注入指令
- 记忆召回数量 `zhaohui` [`plot-recall-count`](../src/presentation/pages/main-popup-plot.ts:219)
- 剧情速率参数 `sulv1-4`

关于“什么时候分家”的结论：

当前不把“记忆召回”和“剧情规划”拆成两个一级页面。

原因：

- 二者共享任务列表、占位符、API 预设和提示词构造器
- 先做视觉分区即可满足易用性目标
- 真正拆页需要先解耦内部状态模型，不应在本次 UI 重排中顺手完成

#### B. 智能续写

当前对应 [`main-popup-plot.ts`](../src/presentation/pages/main-popup-plot.ts:226) 起的“自动循环生成”区域。

本次改版中仅做以下处理：

- 对外文案改名为“智能续写”
- 保留原有字段和行为：
  - 循环提示词列表
  - 标签验证
  - 循环延时
  - 总时长
  - 自动循环失败上限
  - AI 上下文楼层数
  - 上下文提取与排除规则
  - 开始/停止控制

改名不改逻辑，是本次计划的约束。

#### C. 上下文与世界书

保留剧情推进专用世界书设置，来源于 [`main-popup-plot.ts`](../src/presentation/pages/main-popup-plot.ts:291)。

理由：

- 这套世界书选择与普通填表世界书是独立逻辑
- 用户在“核心功能”中配置剧情工作流时，需要看到它

#### D. 外部导入

完整保留 [`main-popup-import.ts`](../src/presentation/pages/main-popup-import.ts:10) 的结构与交互：

- TXT 文件导入
- 独立世界书注入目标
- 屏蔽外部导入世界书条目占位符
- 拆分字符数与编码
- 注入表选择
- 注入 / 删除条目 / 清空缓存

用户草稿写明“原样”，因此该页只改布局风格，不改逻辑组织。

---

## 4.6 数据管理

### 页面定位

这里承接“数据资产”和“结果维护”操作，而不是表格结构配置。

### 二级结构

#### A. 数据隔离

保留当前 [`main-popup-data.ts`](../src/presentation/pages/main-popup-data.ts:15) 的：

- 标识代码
- 历史标识代码
- 保存并应用
- 删除当前标识的注入条目

#### B. 删除与清理

保留当前：

- 删除范围设置 [`delete-start-floor`](../src/presentation/pages/main-popup-data.ts:123)
- 删除当前标识本地数据 [`delete-current-local-data`](../src/presentation/pages/main-popup-data.ts:137)
- 删除所有本地数据 [`delete-all-local-data`](../src/presentation/pages/main-popup-data.ts:138)

#### C. 备份与恢复

保留当前：

- 合并导入 模板+指令 [`import-combined-settings`](../src/presentation/pages/main-popup-data.ts:38)
- 合并导出 模板+指令 [`export-combined-settings`](../src/presentation/pages/main-popup-data.ts:39)
- 导出 JSON 数据 [`export-json-data`](../src/presentation/pages/main-popup-data.ts:43)
- 恢复默认模板及提示词 [`reset-all-defaults`](../src/presentation/pages/main-popup-data.ts:44)
- 模板覆盖最新层数据 [`override-with-template`](../src/presentation/pages/main-popup-data.ts:45)

这些操作虽未出现在用户草稿，但都是现有功能，必须保留。

#### D. 合并功能

完整保留当前 [`纪要合并 Medusa`](../src/presentation/pages/main-popup-data.ts:149)：

- 手动合并参数
- 自动合并设置
- 提示词模板
- 保存设置 / 恢复默认
- 开始合并纪要

同时在“仪表盘”提供快速入口按钮，但完整参数面板仍放在“数据管理”。

---

## 4.7 高级工具

### 页面定位

承接用户草稿未提但现有代码中真实存在的低频高级能力，避免丢失功能，同时不打断主流程导航。

### 包含页面

#### A. 正文替换

保留 [`main-popup-optimization.ts`](../src/presentation/pages/main-popup-optimization.ts:10)：

- 基础设置
- 优化模式
- 标签筛选
- 预设管理
- 优化提示词
- 手动测试

#### B. SQL 控制台

保留 [`generateSqlConsoleTabHTML()`](../src/presentation/pages/sql-console.ts:22)：

- 仅在 SQLite 模式显示
- 查看所有表 / 表结构 / 历史记录
- SQL 输入与执行
- 结果展示

#### C. 运行日志

保留 [`generateLogViewerTabHTML()`](../src/presentation/pages/log-viewer.ts:69)：

- 级别过滤
- 模块过滤
- 搜索
- 暂停、清空、导出
- Debug 日志采集开关

---

## 5. 草稿到正式结构的映射表

| 用户草稿 | 正式结构 | 处理说明 |
|---|---|---|
| 仪表盘 | 仪表盘 | 承接状态总览、API 摘要、快速手动总结、功能键、0TK |
| 更新 → 基础设置 | 更新 → 基础设置 | 对应当前更新参数主配置区 |
| 更新 → 内容筛选 | 更新 → 内容筛选 | 对应跳过、重试、标签提取/排除 |
| API → API填写 原样 | API | 结构原样保留，升级视觉与排版 |
| 表格 → 当前表格、全局表格、表格提示词 | 表格 | 用模板预设双作用域 + 表格工具入口承接 |
| 表格 → 世界书注入 | 表格 | 普通填表世界书设置迁入此处 |
| 核心功能 → 记忆召回、剧情规划 | 核心功能 | 作为剧情推进内部第一区块 |
| 核心功能 → 智能续写 | 核心功能 | 自动循环生成改名，不改逻辑 |
| 核心功能 → 外部导入 | 核心功能 | 保持原样 |
| 数据管理 → 数据隔离、删除 | 数据管理 | 原样保留 |
| 数据管理 → 合并功能 | 数据管理 | Medusa 完整保留 |

---

## 6. 用户草稿未覆盖但必须保留的功能

以下能力在用户草稿中未被明确提到，但当前代码已存在，不能删：

1. [`数据库更新预设 任务指令`](../src/presentation/pages/main-popup-prompt.ts:14)
2. [`正文替换`](../src/presentation/pages/main-popup-optimization.ts:10)
3. [`SQL 控制台`](../src/presentation/pages/sql-console.ts:22)
4. [`运行日志`](../src/presentation/pages/log-viewer.ts:69)
5. [`数据页`](../src/presentation/pages/main-popup-data.ts:35) 中的导入导出、恢复默认、覆盖模板、可视化编辑器入口

本计划中的安置方式：

- 更新任务提示词 → 并入“更新”
- 正文替换 / SQL / 日志 → 归入“高级工具”
- 数据备份恢复与表格工具入口 → 分别归入“数据管理”与“表格”

---

## 7. 视觉风格规范

## 7.1 整体基调

参考用户截图，统一为：

- 浅色背景
- 极浅灰卡片底
- 细边框
- 蓝色强调按钮与激活态
- 小圆角或轻圆角
- 轻阴影，不使用当前深色玻璃态和蓝紫发光
- 左侧导航保持树状分区感
- 顶部保留当前聊天标题，居中展示

## 7.2 需要替换的当前风格问题

当前 [`MAIN_POPUP_CSS_ACU`](../src/presentation/pages/main-popup-styles.ts:8) 存在：

- 深色背景
- 蓝紫高光
- 大圆角
- 玻璃态模糊
- 阴影过重

这些都与用户提供的目标截图不一致，需要整体改写 token 与关键组件样式。

## 7.3 样式实施原则

- 继续由 [`MAIN_POPUP_CSS_ACU`](../src/presentation/pages/main-popup-styles.ts:8) 集中管理样式
- 优先改 CSS 变量与通用组件样式，不在各页面继续堆大量 inline style
- 长期目标是逐步收敛页面级 inline style，但本轮实现以“稳定重排 + 可落地”优先，不强行一次性清完所有内联样式

---

## 8. 实施方案

## 8.1 阶段一：重组顶层导航与样式骨架

涉及文件：

- [`main-popup.ts`](../src/presentation/pages/main-popup.ts)
- [`main-popup-styles.ts`](../src/presentation/pages/main-popup-styles.ts)

工作内容：

- 调整左侧导航分组与命名
- 建立新页面容器结构
- 重写主视觉系统
- 保证现有 tab 切换机制仍可工作

## 8.2 阶段二：拆分并重组内容页

涉及文件：

- [`main-popup-status.ts`](../src/presentation/pages/main-popup-status.ts)
- [`main-popup-prompt.ts`](../src/presentation/pages/main-popup-prompt.ts)
- [`main-popup-worldbook.ts`](../src/presentation/pages/main-popup-worldbook.ts)
- [`main-popup-data.ts`](../src/presentation/pages/main-popup-data.ts)
- [`main-popup-plot.ts`](../src/presentation/pages/main-popup-plot.ts)
- [`main-popup-import.ts`](../src/presentation/pages/main-popup-import.ts)
- [`main-popup-api.ts`](../src/presentation/pages/main-popup-api.ts)
- [`main-popup-optimization.ts`](../src/presentation/pages/main-popup-optimization.ts)

工作内容：

- 把现有混装页面按新 IA 拆成新的内容区块
- 保留原控件 id 与绑定入口
- 只在必要时增补结构性包裹元素 class

## 8.3 阶段三：绑定与状态显示适配

涉及文件：

- [`popup-bindings.ts`](../src/presentation/pages/popup-bindings.ts)
- [`popup-helpers.ts`](../src/presentation/pages/popup-helpers.ts)
- 必要时涉及各子绑定文件

工作内容：

- 确认 tab 名称、默认激活页、条件显示页仍与新结构匹配
- 处理高级工具隐藏/显示逻辑
- 处理快捷入口跳转，例如仪表盘中的“快速手动总结”跳到 Medusa 区或直接触发操作

---

## 9. 实现约束

1. 不优先重命名字段 id，优先复用现有 id
2. 不在本次 UI 改版中顺手改业务逻辑
3. 不把 [`plot`](../src/presentation/pages/main-popup-plot.ts:11) 强拆成多个独立一级页
4. 不删除 [`optimization`](../src/presentation/pages/main-popup-optimization.ts:10)、[`sql-console`](../src/presentation/pages/sql-console.ts:22)、[`log-viewer`](../src/presentation/pages/log-viewer.ts:69)
5. 不合并全局 / 当前聊天两套模板预设作用域
6. 不合并普通填表世界书与剧情推进世界书的配置入口

---

## 10. 风险与应对

| 风险 | 具体表现 | 应对方式 |
|---|---|---|
| 顶层布局重排导致事件失效 | tab 按钮和内容区映射错位 | 保持 `data-tab` 与 `#acu-tab-*` 命名机制不变 |
| 页面拆分后 id 丢失 | 子绑定无法找到元素 | 优先保留原 id，不必要不改 |
| 视觉改版牵连太多 inline style | 某些区块新旧样式冲突 | 先统一通用 token 与卡片层，再逐页修正 |
| 剧情推进区块拆分过度 | 后续状态同步复杂 | 本轮只做区块化，不做业务解耦 |
| 草稿未提能力被误删 | 高级页入口消失 | 通过“高级工具”统一保留 |

---

## 11. 验收标准

### 11.1 信息架构验收

- 用户草稿中的 6 个主分类全部可见并能对应到真实页面内容
- 草稿未提到的现有功能仍可访问
- 0TK 已从“世界书”主页面迁移到“仪表盘”
- 外部导入仍保留独立页面或清晰独立区块
- 剧情推进页已按“记忆召回与规划 / 智能续写 / 上下文与世界书”完成区块拆分

### 11.2 交互验收

- 所有原有主要按钮仍可触发绑定逻辑
- 所有原有输入控件仍能被加载与保存
- SQLite 模式下 SQL 控制台按条件显示
- 正文替换仍保留可达入口
- 日志页仍可正常订阅和过滤

### 11.3 视觉验收

- 主体为浅色界面
- 左侧导航激活态接近用户截图中的蓝色高亮风格
- 卡片边框和阴影整体轻量化
- 表单、表格、状态信息视觉风格统一

---

## 12. 推荐实现顺序

1. 先改 [`main-popup-styles.ts`](../src/presentation/pages/main-popup-styles.ts:8) 与 [`main-popup.ts`](../src/presentation/pages/main-popup.ts:30)，建立新骨架
2. 再改 [`status`](../src/presentation/pages/main-popup-status.ts:11)、[`data`](../src/presentation/pages/main-popup-data.ts:11)、[`worldbook`](../src/presentation/pages/main-popup-worldbook.ts:10) 这三个混装最严重的页面
3. 再处理 [`plot`](../src/presentation/pages/main-popup-plot.ts:11) 与 [`import`](../src/presentation/pages/main-popup-import.ts:10)
4. 最后收尾 [`api`](../src/presentation/pages/main-popup-api.ts:10)、[`optimization`](../src/presentation/pages/main-popup-optimization.ts:10)、[`sql-console`](../src/presentation/pages/sql-console.ts:22)、[`log-viewer`](../src/presentation/pages/log-viewer.ts:69) 的风格一致性
5. 最后检查 [`popup-bindings.ts`](../src/presentation/pages/popup-bindings.ts:30) 与条件显示逻辑是否需要小幅适配

---

## 13. 最终决策记录

本计划已确认以下关键决策：

- 接受“高级工具”分组
- [`剧情推进页`](../src/presentation/pages/main-popup-plot.ts:11) 本轮不拆成多个一级页，而是在同页中拆成多个高层区块
- API 页面维持原有业务结构
- 外部导入保持原样能力
- 不减少现有功能，只做重排和重设计
