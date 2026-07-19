# 重构计划：data 层数据操作收拢

> **目标**：将 service 层中散落的 `message.TavernDB_ACU_*` 字段直接操作，收拢到 `data/repositories/chat-message-data-repo.ts`，使 data 层真正掌控核心业务数据的读写。
>
> **优先级**：高（这是实现存储层可替换的前提条件）
>
> **预计工作量**：新增 ~400 行，修改 4 个 service 文件共 ~70 处引用
>
> **风险等级**：中（改动范围广，但每处改动是机械替换，逻辑不变）

---

## 一、问题现状

### 1.1 核心矛盾

data 层只管理了**配置数据**（`chat[0]` 上的 `ScopedConfig` 和 `SheetGuide`），而**最核心的业务数据**——每条聊天消息上挂载的表格数据——完全由 service 层直接操作，data 层对此一无所知。

### 1.2 涉及的字段（7 个）

| 字段名 | 用途 | 格式 |
|--------|------|------|
| `TavernDB_ACU_IsolatedData` | **新版**按标签分组的表格数据（最核心） | `{ [isolationKey]: { independentData, modifiedKeys, updateGroupKeys } }` |
| `TavernDB_ACU_IndependentData` | **旧版**独立表格数据 | `{ [sheetKey]: SheetObject }` |
| `TavernDB_ACU_Data` | **旧版**标准表数据 | `{ mate, [sheetKey]: SheetObject }` |
| `TavernDB_ACU_SummaryData` | **旧版**摘要/大纲表数据 | `{ mate, [sheetKey]: SheetObject }` |
| `TavernDB_ACU_Identity` | 隔离标识代码 | `string \| undefined` |
| `TavernDB_ACU_ModifiedKeys` | 本次修改的表格键列表 | `string[]` |
| `TavernDB_ACU_UpdateGroupKeys` | 本次更新组的表格键列表 | `string[]` |

### 1.3 散落位置（4 个 service 文件，50+ 处引用）

| 文件 | 引用数 | 操作类型 |
|------|:------:|---------|
| `service/runtime/helpers-data-merge.ts` | 27 | 读取合并、首楼初始化、模板填充 |
| `service/table/table-service.ts` | 14 | 保存写入、首次初始化检测 |
| `service/template/chat-scope.ts` | 7 | 历史数据扫描 |
| `service/worldbook/injection-engine-state.ts` | 23 | 硬删除清理 |

### 1.4 操作模式分类（5 大类）

```
A. 读取合并 — mergeAllIndependentTables_ACU()
   遍历聊天记录，按优先级：新版 IsolatedData → 旧版 IndependentData → 旧版 Data/SummaryData
   需要隔离配置（isolationEnabled + isolationCode）来决定匹配策略

B. 写入保存 — saveIndependentTableToChatHistory_ACU()
   同时写入新版（IsolatedData）和旧版（IndependentData/Data/SummaryData）兼容格式
   需要隔离配置来设置 Identity 字段

C. 首楼初始化 — seedGreetingLocalDataFromTemplate_ACU() / fillFirstLayerWithTemplateData_ACU()
   初始化首楼消息的数据字段，同时写入新旧格式，标记幂等标志

D. 历史扫描 — chat-scope.ts 中的 collectHistoricalTableData 逻辑
   收集历史表格数据用于构建指导表，读取模式与 A 类似

E. 硬删除 — purgeSheetKeysFromChatHistoryHard_ACU()
   从所有消息中删除指定 sheetKey 的数据，同时清理新旧格式的所有字段
```

---

## 二、重构方案

### 2.1 新增文件

#### 文件 1：`src/data/models/chat-message-data.ts`

**职责**：定义消息级表格数据的 TypeScript 类型

```
需要定义的类型：
├── IsolationTagData_ACU          — 单个隔离标签下的数据槽
│   ├── independentData: Record<string, Sheet_ACU>
│   ├── modifiedKeys: string[]
│   └── updateGroupKeys: string[]
│
├── IsolatedDataContainer_ACU     — 按标签分组的容器
│   └── [isolationKey: string]: IsolationTagData_ACU
│
├── LegacyStandardData_ACU        — 旧版标准表容器
│   ├── mate: { type: string, version: number }
│   └── [sheetKey: string]: Sheet_ACU | Mate
│
├── LegacySummaryData_ACU         — 旧版摘要表容器（结构同上）
│
├── MessageTableFields_ACU        — 消息上所有 TavernDB_ACU_* 字段的完整类型
│   ├── TavernDB_ACU_IsolatedData?: IsolatedDataContainer_ACU
│   ├── TavernDB_ACU_IndependentData?: Record<string, Sheet_ACU>
│   ├── TavernDB_ACU_Data?: LegacyStandardData_ACU
│   ├── TavernDB_ACU_SummaryData?: LegacySummaryData_ACU
│   ├── TavernDB_ACU_Identity?: string
│   ├── TavernDB_ACU_ModifiedKeys?: string[]
│   ├── TavernDB_ACU_UpdateGroupKeys?: string[]
│   └── _acu_local_template_base_state_seeded?: string
│
└── IsolationConfig_ACU           — 隔离配置（作为参数传入 repository）
    ├── enabled: boolean
    └── code: string
```

**预计行数**：~60 行

#### 文件 2：`src/data/repositories/chat-message-data-repo.ts`

**职责**：封装所有对 `message.TavernDB_ACU_*` 字段的底层 CRUD 操作

```
需要封装的方法：
│
├── 读取类
│   ├── readIsolatedTagData(msg, isolationKey)
│   │   → 从消息读取指定标签的 IsolationTagData（处理 string/object 两种格式）
│   │
│   ├── readLegacyIndependentData(msg)
│   │   → 读取旧版 IndependentData
│   │
│   ├── readLegacyStandardData(msg)
│   │   → 读取旧版 Data（标准表）
│   │
│   ├── readLegacySummaryData(msg)
│   │   → 读取旧版 SummaryData（摘要表）
│   │
│   ├── readMessageIdentity(msg)
│   │   → 读取 Identity 字段
│   │
│   ├── readModifiedKeys(msg)
│   │   → 读取 ModifiedKeys
│   │
│   ├── readUpdateGroupKeys(msg)
│   │   → 读取 UpdateGroupKeys
│   │
│   └── isLegacyMatchForIsolation(msg, isolationConfig)
│       → 判断旧版消息是否匹配当前隔离配置（封装 Identity 匹配逻辑）
│
├── 写入类
│   ├── writeIsolatedTagData(msg, isolationKey, tagData)
│   │   → 写入指定标签的数据到 IsolatedData 容器
│   │
│   ├── writeLegacyCompatData(msg, independentData, modifiedKeys, updateGroupKeys)
│   │   → 同步写入旧版兼容字段（IndependentData/ModifiedKeys/UpdateGroupKeys）
│   │
│   ├── writeLegacyStandardAndSummary(msg, standardData, summaryData)
│   │   → 写入旧版 Data 和 SummaryData
│   │
│   ├── writeMessageIdentity(msg, isolationConfig)
│   │   → 根据隔离配置设置或删除 Identity 字段
│   │
│   └── initIsolatedTagSlot(msg, isolationKey)
│       → 确保 IsolatedData[isolationKey] 存在（初始化空槽）
│
├── 删除类
│   ├── purgeSheetKeysFromMessage(msg, sheetKeys)
│   │   → 从单条消息的所有字段中删除指定 sheetKey（新版+旧版）
│   │   → 处理删除后空对象的清理
│   │
│   └── clearAllTableFields(msg)
│       → 清除消息上所有 TavernDB_ACU_* 字段（用于重置）
│
└── 辅助类
    ├── hasAnyTableData(msg, isolationKey?, isolationConfig?)
    │   → 检查消息是否包含任何表格数据（新版或旧版）
    │
    └── cloneIsolatedData(msg)
        → 深拷贝 IsolatedData 容器（安全修改用）
```

**预计行数**：~350 行

**关键设计决策**：
1. **纯函数导出**（与现有 repository 风格一致，不使用 class）
2. **隔离配置作为参数传入**（不引用 service 层的 state-manager，保持 data 层独立性）
3. **不包含业务逻辑**（不做合并策略、不做优先级判断，只做字段级 CRUD）
4. **统一处理 string/object 格式**（IsolatedData 可能是 JSON 字符串）

### 2.2 修改文件

#### 修改 1：`service/runtime/helpers-data-merge.ts`（27 处）

| 当前代码模式 | 替换为 |
|-------------|--------|
| `message.TavernDB_ACU_IsolatedData && message.TavernDB_ACU_IsolatedData[key]` | `readIsolatedTagData(message, key)` |
| `message.TavernDB_ACU_Identity` | `readMessageIdentity(message)` |
| `message.TavernDB_ACU_IndependentData` | `readLegacyIndependentData(message)` |
| `message.TavernDB_ACU_ModifiedKeys \|\| []` | `readModifiedKeys(message)` |
| `message.TavernDB_ACU_UpdateGroupKeys \|\| []` | `readUpdateGroupKeys(message)` |
| `message.TavernDB_ACU_Data` | `readLegacyStandardData(message)` |
| `message.TavernDB_ACU_SummaryData` | `readLegacySummaryData(message)` |
| 首楼初始化中的 `greetingMsg.TavernDB_ACU_IsolatedData = {}` 等 | `initIsolatedTagSlot(msg, key)` + `writeIsolatedTagData(msg, key, data)` + `writeLegacyCompatData(msg, ...)` |
| `fillFirstLayerWithTemplateData_ACU` 中的写入逻辑 | 同上 |

**隔离匹配逻辑**：
```
// 当前（散落在 service 层）
const msgIdentity = message.TavernDB_ACU_Identity;
let isLegacyMatch = false;
if (settings_ACU.dataIsolationEnabled) {
    isLegacyMatch = (msgIdentity === settings_ACU.dataIsolationCode);
} else {
    isLegacyMatch = !msgIdentity;
}

// 重构后
const isolationConfig = { enabled: settings_ACU.dataIsolationEnabled, code: settings_ACU.dataIsolationCode };
const isLegacyMatch = isLegacyMatchForIsolation(message, isolationConfig);
```

#### 修改 2：`service/table/table-service.ts`（14 处）

| 当前代码模式 | 替换为 |
|-------------|--------|
| `targetMessage.TavernDB_ACU_IsolatedData ? JSON.parse(JSON.stringify(...)) : {}` | `cloneIsolatedData(targetMessage)` |
| `targetMessage.TavernDB_ACU_IsolatedData = isolatedData` | `writeIsolatedTagData(targetMessage, key, tagData)` |
| `targetMessage.TavernDB_ACU_Identity = ...` / `delete targetMessage.TavernDB_ACU_Identity` | `writeMessageIdentity(targetMessage, isolationConfig)` |
| `targetMessage.TavernDB_ACU_IndependentData = ...` 等旧版写入 | `writeLegacyCompatData(targetMessage, ...)` |
| `targetMessage.TavernDB_ACU_Data = ...` / `TavernDB_ACU_SummaryData = ...` | `writeLegacyStandardAndSummary(targetMessage, ...)` |
| `checkIfFirstTimeInit_ACU` 中的读取逻辑 | `readIsolatedTagData` + `isLegacyMatchForIsolation` + `readLegacyIndependentData` |

#### 修改 3：`service/template/chat-scope.ts`（7 处）

| 当前代码模式 | 替换为 |
|-------------|--------|
| `typeof message.TavernDB_ACU_IsolatedData === 'string' ? safeJsonParse(...) : message.TavernDB_ACU_IsolatedData` | `readIsolatedTagData(message, normalizedKey)` |
| `message.TavernDB_ACU_Identity` | `readMessageIdentity(message)` |
| `message.TavernDB_ACU_IndependentData` | `readLegacyIndependentData(message)` |
| `message.TavernDB_ACU_Data` | `readLegacyStandardData(message)` |
| `message.TavernDB_ACU_SummaryData` | `readLegacySummaryData(message)` |

#### 修改 4：`service/worldbook/injection-engine-state.ts`（23 处）

| 当前代码模式 | 替换为 |
|-------------|--------|
| `purgeSheetKeysFromChatHistoryHard_ACU` 中对每条消息的逐字段操作 | `purgeSheetKeysFromMessage(msg, keys)` |
| 具体来说：对 `IsolatedData` 的遍历+删除、对 `IndependentData` 的删除、对 `ModifiedKeys`/`UpdateGroupKeys` 的过滤、对 `Data`/`SummaryData` 的删除 | 全部收拢到 repository 的 `purgeSheetKeysFromMessage` 方法中 |

**注意**：`purgeSheetKeysFromChatHistoryHard_ACU` 函数本身仍留在 service 层（因为它包含遍历聊天记录、保存聊天、重新加载等业务编排逻辑），但其中对单条消息的字段操作委托给 repository。

#### 修改 5：`docs/代码结构视图.md`

更新 data 层的文件树和职责说明，新增 `chat-message-data.ts` 和 `chat-message-data-repo.ts` 的描述。

---

## 三、执行步骤

### Phase 1：新增 data 层抽象（不改 service 层）

| 步骤 | 内容 | 风险 |
|:----:|------|:----:|
| 1.1 | 新建 `data/models/chat-message-data.ts`，定义所有消息级数据类型 | 低 |
| 1.2 | 新建 `data/repositories/chat-message-data-repo.ts`，实现所有 CRUD 方法 | 低 |
| 1.3 | 编译验证：`tsc` 无错误 | 低 |

**Phase 1 完成标志**：新文件编译通过，但尚未被任何 service 文件引用。

### Phase 2：逐文件迁移 service 层引用

按风险从低到高的顺序迁移：

| 步骤 | 文件 | 引用数 | 风险 | 说明 |
|:----:|------|:------:|:----:|------|
| 2.1 | `chat-scope.ts` | 7 | 低 | 只有读取操作，最安全 |
| 2.2 | `table-service.ts` | 14 | 中 | 包含写入操作，需要仔细对齐参数 |
| 2.3 | `helpers-data-merge.ts` | 27 | 中 | 读取+写入混合，首楼初始化逻辑复杂 |
| 2.4 | `injection-engine-state.ts` | 23 | 中 | 硬删除逻辑复杂，但可以整块替换 |

**每步完成后**：`tsc` 编译验证 + 搜索确认该文件不再直接引用 `TavernDB_ACU_` 字段。

### Phase 3：验证与文档更新

| 步骤 | 内容 |
|:----:|------|
| 3.1 | 全局搜索 `TavernDB_ACU_`，确认只剩 `data/` 层内的引用 |
| 3.2 | `tsc` 全量编译 0 ERROR |
| 3.3 | 更新 `docs/代码结构视图.md` |

---

## 四、关键设计决策

### 4.1 为什么用纯函数而不是 class？

与现有 `profile-repo.ts`、`isolation-repo.ts` 保持一致。项目中所有 repository 都是纯函数导出，不使用 class 或依赖注入。

### 4.2 为什么隔离配置作为参数传入？

```
// ❌ 错误：repository 引用 service 层的 state-manager（违反层级规则）
import { settings_ACU } from '../service/runtime/state-manager';

// ✅ 正确：调用方传入隔离配置
function isLegacyMatchForIsolation(msg, isolationConfig: IsolationConfig_ACU): boolean
```

data 层不允许引用 service 层。隔离配置由 service 层的调用方从 `settings_ACU` 中提取后传入。

### 4.3 为什么 purgeSheetKeysFromChatHistoryHard 不整体迁移到 data 层？

该函数包含：
1. 遍历聊天记录（业务编排）
2. 对每条消息执行字段操作（数据操作）← 这部分迁移
3. 调用 `SillyTavern_API_ACU.saveChat()`（外部 API 调用）
4. 调用 `loadAllChatMessages_ACU()`（业务编排）

只有第 2 步属于 data 层职责，其余是 service 层的业务编排。

### 4.4 为什么同时保留新旧格式写入？

旧版格式（`TavernDB_ACU_IndependentData` 等）是为了兼容尚未升级的聊天记录。在 repository 中统一封装后，未来废弃旧格式时只需修改 repository 一处，而非 service 层的多处。

---

## 五、风险评估

| 风险 | 等级 | 缓解措施 |
|------|:----:|---------|
| 修改范围广（50+ 处） | 中 | 逐文件迁移，每步编译验证 |
| chat-scope.ts 是大文件（1,410行） | 中 | 只修改 7 处引用，不改动其他逻辑 |
| 新旧格式兼容逻辑可能遗漏 | 中 | repository 方法内部统一处理，迁移时逐行对比 |
| 运行时行为变化 | 低 | 纯机械替换，逻辑不变，只是调用入口变了 |
| 类型定义不完整 | 低 | 先用宽松类型（any），后续渐进式收紧 |

---

## 六、预期收益

### 重构完成后

```
重构前：
  service 层 → 直接操作 message.TavernDB_ACU_* → 聊天消息对象

重构后：
  service 层 → chat-message-data-repo → message.TavernDB_ACU_* → 聊天消息对象
```

1. **data 层真正掌控核心数据**：所有表格数据的读写都经过 data 层
2. **新旧格式兼容逻辑只写一次**：消除 4 个文件中的重复代码
3. **存储替换成为可能**：未来替换为 SQLite 时，只需替换 repository 实现
4. **数据校验有统一入口**：可以在 repository 中添加数据完整性校验
5. **数据迁移有统一入口**：修改数据结构时只改 repository 一处

### 对后续工作的影响

| 后续任务 | 重构前难度 | 重构后难度 |
|---------|:----------:|:----------:|
| 替换为 SQLite 存储 | 极高（改 4 个文件 50+ 处） | 低（只改 repository） |
| 废弃旧版数据格式 | 高（改 4 个文件） | 低（只改 repository） |
| 添加数据版本迁移 | 无入口 | 在 repository 中添加 |
| 添加数据校验 | 无入口 | 在 repository 中添加 |
| 添加数据变更审计日志 | 无入口 | 在 repository 中添加 |

---

## 七、验收标准

- [x] `data/models/chat-message-data.ts` 存在且类型定义完整
- [x] `data/repositories/chat-message-data-repo.ts` 存在且方法覆盖 5 大操作模式
- [x] `grep -r "TavernDB_ACU_" src/service/` 返回 0 结果（service 层不再直接引用字段名）
- [x] `tsc` 全量编译 0 ERROR
- [x] `docs/代码结构视图.md` 已更新
- [ ] data 层代码行数从 794 行增长到 ~1,200 行（合理增长）

---

## 八、附加重构项：外部服务 Gateway 收拢

> **性质**：独立的代码质量改进，**不是**切换 SQLite 的前置条件
>
> **动机**：世界书和角色数据属于 SillyTavern 的宿主数据，不需要存入 SQLite。但将散落在 service 层的直接调用收拢到统一的 Gateway 接口中，能带来以下收益：
> - **单一职责**：SillyTavern API 签名变更时只改 Gateway 一处，而非 5 个文件 46 处
> - **可测试性**：mock 一个 Gateway 接口即可，不需要 mock 整个全局对象
> - **一致性**：与 data 层已有的 `config-storage.ts`、`chat-history.ts` 等封装保持风格统一
> - **防御性**：`TavernHelper_API_ACU` 存在性检查只写一次，消除散落的 `if (TavernHelper_API_ACU && typeof ...)` 模式

### 8.1 WorldbookGateway

#### 8.1.1 问题现状

service 层有 **5 个文件、46 处**直接调用 `TavernHelper_API_ACU` 的世界书相关方法：

| 文件 | 引用数 | 调用的方法 |
|------|:------:|-----------|
| `service/worldbook/pipeline.ts` | 20 | `getLorebookEntries`、`setLorebookEntries`、`createLorebookEntries`、`deleteLorebookEntries`、`getLorebooks`、`getLorebookEntries`（能力检测） |
| `service/worldbook/injection-engine-entries.ts` | 16 | `getLorebookEntries`、`setLorebookEntries`、`createLorebookEntries`、`deleteLorebookEntries` |
| `service/worldbook/injection-engine-custom.ts` | 5 | `getLorebookEntries`、`setLorebookEntries`、`createLorebookEntries`、`deleteLorebookEntries` |
| `service/worldbook/injection-engine-state.ts` | 4 | `getCurrentCharPrimaryLorebook`、`getLorebookEntries`、`deleteLorebookEntries` |
| `service/runtime/helpers-plot-runtime.ts` | 1 | `getLorebookEntries` |

#### 8.1.2 涉及的方法（6 个）

| 方法 | 用途 | 调用次数 |
|------|------|:--------:|
| `getLorebookEntries(bookName)` | 读取指定世界书的所有条目 | 10 |
| `setLorebookEntries(bookName, entries)` | 更新已有条目 | 9 |
| `createLorebookEntries(bookName, entries)` | 创建新条目 | 8 |
| `deleteLorebookEntries(bookName, uids)` | 删除条目 | 6 |
| `getLorebooks()` | 获取所有世界书列表 | 2 |
| `getCurrentCharPrimaryLorebook()` | 获取当前角色的主世界书名称 | 2 |

#### 8.1.3 Gateway 接口设计

**新增文件**：`src/data/gateways/worldbook-gateway.ts`

```
需要封装的方法：
│
├── 条目 CRUD
│   ├── getEntries(bookName: string): Promise<LorebookEntry[]>
│   │   → 读取指定世界书的所有条目
│   │   → 内部处理：TavernHelper_API_ACU 存在性检查 + 调用 getLorebookEntries
│   │
│   ├── setEntries(bookName: string, entries: Partial<LorebookEntry>[]): Promise<void>
│   │   → 更新已有条目
│   │
│   ├── createEntries(bookName: string, entries: NewLorebookEntry[]): Promise<void>
│   │   → 创建新条目
│   │
│   └── deleteEntries(bookName: string, uids: string[]): Promise<void>
│       → 删除条目
│
├── 世界书管理
│   ├── listLorebooks(): Promise<string[]>
│   │   → 获取所有世界书名称列表
│   │   → 统一 getLorebooks / getWorldBooks 两个方法名
│   │
│   └── getCurrentCharPrimaryLorebook(): Promise<string | null>
│       → 获取当前角色的主世界书名称
│
└── 辅助
    └── isAvailable(): boolean
        → 检查 TavernHelper_API_ACU 是否可用（消除散落的存在性检查）
```

**预计行数**：~80 行

**关键设计决策**：
1. **纯函数导出**（与现有 repository 风格一致）
2. **统一防御性检查**：每个方法内部检查 `TavernHelper_API_ACU` 是否存在，不可用时返回空数组/null
3. **不包含业务逻辑**：不做条目过滤、不做隔离前缀拼接，只做 API 调用转发
4. **统一方法命名**：`getLorebooks` 和 `getWorldBooks` 统一为 `listLorebooks`

#### 8.1.4 执行步骤

| 步骤 | 内容 | 风险 |
|:----:|------|:----:|
| 1 | 新建 `data/gateways/worldbook-gateway.ts`，实现所有方法 | 低 |
| 2 | 迁移 `injection-engine-state.ts`（4 处） | 低 |
| 3 | 迁移 `injection-engine-custom.ts`（5 处） | 低 |
| 4 | 迁移 `injection-engine-entries.ts`（16 处） | 中 |
| 5 | 迁移 `pipeline.ts`（20 处） | 中 |
| 6 | 迁移 `helpers-plot-runtime.ts`（1 处） | 低 |
| 7 | 全局搜索确认 service 层不再直接调用世界书方法 | 低 |

### 8.2 CharacterGateway

#### 8.2.1 问题现状

service 层有 **4 个文件、7 处**直接调用 `TavernHelper_API_ACU` 的角色/聊天数据相关方法：

| 文件 | 引用数 | 调用的方法 |
|------|:------:|-----------|
| `service/runtime/helpers-plot-runtime.ts` | 3 | `getCharLorebooks` ×2、`getCharData` ×1 |
| `service/worldbook/pipeline.ts` | 2 | `getChatMessages` ×1、`getCharLorebooks` ×1 |
| `service/optimization/content-optimization.ts` | 1 | `getCharData` ×1 |
| `service/ai/prompt-builder.ts` | 1 | `getCharData` ×1 |

#### 8.2.2 涉及的方法（3 个）

| 方法 | 用途 | 调用次数 |
|------|------|:--------:|
| `getCharData('current')` | 获取当前角色卡片数据 | 3 |
| `getCharLorebooks({ type: 'all' })` | 获取角色关联的世界书列表 | 3 |
| `getChatMessages(range, options)` | 获取指定范围的聊天消息 | 1 |

#### 8.2.3 Gateway 接口设计

**新增文件**：`src/data/gateways/character-gateway.ts`

```
需要封装的方法：
│
├── getCurrentCharData(): CharacterData | null
│   → 获取当前角色卡片数据
│   → 内部处理：TavernHelper_API_ACU 存在性检查 + 调用 getCharData('current')
│
├── getCharLorebooks(): Promise<string[]>
│   → 获取角色关联的所有世界书名称
│   → 内部处理：调用 getCharLorebooks({ type: 'all' })
│
├── getChatMessages(range: string, options?: object): Promise<any[]>
│   → 获取指定范围的聊天消息
│   → 内部处理：调用 getChatMessages(range, options)
│
└── isAvailable(): boolean
    → 检查 TavernHelper_API_ACU 是否可用
```

**预计行数**：~50 行

#### 8.2.4 执行步骤

| 步骤 | 内容 | 风险 |
|:----:|------|:----:|
| 1 | 新建 `data/gateways/character-gateway.ts`，实现所有方法 | 低 |
| 2 | 迁移 `helpers-plot-runtime.ts`（3 处） | 低 |
| 3 | 迁移 `pipeline.ts`（2 处） | 低 |
| 4 | 迁移 `content-optimization.ts`（1 处） | 低 |
| 5 | 迁移 `prompt-builder.ts`（1 处） | 低 |
| 6 | 全局搜索确认 service 层不再直接调用角色数据方法 | 低 |

### 8.3 与主重构计划的关系

```
重构优先级路线图：

Phase A（P0 - SQLite 前置条件）
  ├── 消息级表格数据收拢（本文档第一~七章）
  └── chat 数组访问 + saveChat 收拢（待补充）

Phase B（P1/P2 - 代码质量改进，可独立执行）
  ├── WorldbookGateway（本章 8.1）— 5 文件 46 处
  └── CharacterGateway（本章 8.2）— 4 文件 7 处

Phase C（目标）
  └── 切换 SQLite 存储（只需替换 Phase A 的 repository 实现）
```

**Phase B 可以在 Phase A 之前、之后或并行执行**，因为它们操作的文件和字段没有重叠（Phase A 操作 `TavernDB_ACU_*` 字段，Phase B 操作 `TavernHelper_API_ACU` 方法调用）。

### 8.4 验收标准

- [ ] `data/gateways/worldbook-gateway.ts` 存在且方法覆盖 6 个世界书操作
- [ ] `data/gateways/character-gateway.ts` 存在且方法覆盖 3 个角色数据操作
- [ ] `grep -r "TavernHelper_API_ACU\.\(getLorebookEntries\|setLorebookEntries\|createLorebookEntries\|deleteLorebookEntries\|getLorebooks\|getWorldBooks\|getCurrentCharPrimaryLorebook\)" src/service/` 返回 0 结果
- [ ] `grep -r "TavernHelper_API_ACU\.\(getCharData\|getCharLorebooks\|getChatMessages\)" src/service/` 返回 0 结果
- [ ] `tsc` 全量编译 0 ERROR
- [ ] `docs/代码结构视图.md` 已更新（新增 `data/gateways/` 目录描述）

---

*计划编写时间：2026-04-15 02:20*
*附加章节编写时间：2026-04-15 02:32*
*基于侦察：4 个 service 文件 + 全部 data 层文件 + 代码结构视图文档*
*附加侦察：5 个 worldbook 相关 service 文件 + 4 个角色数据相关 service 文件*

---

## 九、运行时数据库方案 + 外部 API 全量收拢计划

> **编写时间**：2026-04-15 11:30
>
> **背景**：用户明确了 SQLite 的定位是**运行时数据库**，不是持久化数据库。
> - 只有**表格数据**走 SQLite 运行时数据库
> - 其他配置（settings、profile、isolation 等）保持原有方式存储
> - 但所有外部 API 调用都要收拢到 data 层，确保 service 层不直接依赖宿主 API

### 9.1 运行时数据库架构

```
┌─────────────────────────────────────────────────┐
│  SillyTavern 宿主（JSON 文件持久化）             │
│  ├── chat.jsonl        ← 用户的聊天记录          │
│  └── settings.json     ← 用户的设置              │
└──────────────┬──────────────────────────────────┘
               │ 启动时加载 / 保存时写回
               ▼
┌─────────────────────────────────────────────────┐
│  SQLite 运行时数据库（内存或临时文件）            │
│  └── 表格数据（独立表/标准表/摘要表/隔离数据）    │
└──────────────┬──────────────────────────────────┘
               │ 读写（运行时高效查询）
               ▼
┌─────────────────────────────────────────────────┐
│  service 层（业务逻辑）                          │
└─────────────────────────────────────────────────┘
```

**关键设计**：
- **启动时**：从 `message.TavernDB_ACU_*` 字段加载数据到 SQLite
- **运行时**：service 层通过 data 层的 repository 操作 SQLite（高效查询）
- **保存时**：从 SQLite 读出数据写回 `message.TavernDB_ACU_*` 字段 → `saveChat()` 持久化到 JSON
- **用户消息不动**：我们不操作用户的聊天内容，只操作我们挂载的表格数据
- **不破坏兼容性**：用户的 JSON 文件格式不变，卸载插件后数据还在

### 9.2 当前进度与剩余工作

#### ✅ 已完成（Phase A — SQLite 前置条件）

| 项目 | 状态 | 说明 |
|------|:----:|------|
| 消息级表格数据 CRUD 收拢 | ✅ | `chat-message-data-repo.ts`（470行），service 层不再直接操作 `TavernDB_ACU_*` 字段 |
| 消息级数据类型定义 | ✅ | `chat-message-data.ts`（70行） |
| 配置档案读写收拢 | ✅ | `profile-repo.ts`（96行） |
| 数据隔离历史收拢 | ✅ | `isolation-repo.ts`（71行） |
| 配置持久化收拢 | ✅ | `config-storage.ts`（36行） |
| 聊天历史数据读取收拢 | ✅ | `chat-history.ts`（83行） |

#### 🔧 本次要做的（Phase B — 外部 API 全量收拢到 data 层 Gateway）

> **目标**：service 层不再直接调用 `TavernHelper_API_ACU`、`SillyTavern_API_ACU.chat`、`SillyTavern_API_ACU.saveChat()`、`SillyTavern_API_ACU.ConnectionManagerRequestService`、`SillyTavern_API_ACU.extensionSettings`、`SillyTavern_API_ACU.getWorldBooks()`

### 9.3 service 层外部 API 调用全量清单

#### 9.3.1 TavernHelper_API_ACU 调用（50 处，7 文件）

| 文件 | 引用数 | 调用的方法 |
|------|:------:|-----------|
| `worldbook/pipeline.ts` | 14 | `getLorebookEntries` ×1、`setLorebookEntries` ×4、`createLorebookEntries` ×4、`deleteLorebookEntries` ×2、`getCharLorebooks` ×1、`getChatMessages` ×1、`getWorldBooks`（通过 SillyTavern_API_ACU）×1 |
| `ai/prompt-builder.ts` | 14 | `getCharData` ×1、`triggerSlash` ×7、`generateRaw` ×4、`extensionSettings`（通过 SillyTavern_API_ACU）×1、`ConnectionManagerRequestService`（通过 SillyTavern_API_ACU）×1 |
| `worldbook/injection-engine-custom.ts` | 7 | `getLorebookEntries` ×2、`setLorebookEntries` ×1、`createLorebookEntries` ×1、`deleteLorebookEntries` ×1、存在性检查 ×1、import ×1 |
| `runtime/helpers-plot-runtime.ts` | 6 | `getCharLorebooks` ×2、`getLorebookEntries` ×1、`getCharData` ×1、import ×1、存在性检查 ×1 |
| `ai/api-call.ts` | 4 | `generateRaw` ×3、import ×1 |
| `optimization/content-optimization.ts` | 3 | `getCharData` ×1、存在性检查 ×1、import ×1 |
| `worldbook/injection-engine-state.ts` | 2 | `getCurrentCharPrimaryLorebook` ×2 |

> 注：`state-manager.ts` 中的 2 处是 re-export 声明，不需要迁移。

#### 9.3.2 SillyTavern_API_ACU.chat 访问（14 处，8 文件）

| 文件 | 引用数 | 用途 |
|------|:------:|------|
| `runtime/helpers-plot-runtime.ts` | 4 | 遍历聊天记录读取表格数据、获取 chat 数组 |
| `table/table-service.ts` | 3 | 获取 chat 数组用于保存/加载/初始化检测 |
| `worldbook/pipeline.ts` | 2 | 获取 `chat.length - 1` 作为最后消息索引 |
| `runtime/helpers-data-merge.ts` | 1 | 获取 chat 数组用于合并 |
| `runtime/helpers-template-vars.ts` | 1 | 获取 chat 数组用于模板变量 |
| `plot/plot-logic.ts` | 1 | 获取 chat 数组用于剧情逻辑 |
| `optimization/content-optimization.ts` | 1 | 获取 chat 数组用于正文优化 |
| `summary/merge-logic.ts` | 1 | 获取 `chat.length - 1` 用于保存索引 |

#### 9.3.3 SillyTavern_API_ACU.saveChat() 调用（16 处，7 文件）

| 文件 | 引用数 | 模式 |
|------|:------:|------|
| `template/chat-scope.ts` | 4 | 条件检查 + 调用（2处 try-catch 包裹） |
| `plot/plot-logic.ts` | 4 | 条件检查 + Promise.then 链式调用 |
| `runtime/helpers-plot-runtime.ts` | 2 | 条件检查 + await 调用 |
| `runtime/helpers-data-merge.ts` | 2 | 直接 await 调用 |
| `template/template-preset-service.ts` | 2 | 条件检查 + Promise.then 链式调用 |
| `table/table-service.ts` | 1 | 直接 await 调用 |
| `worldbook/injection-engine-state.ts` | 1 | 直接 await 调用 |

#### 9.3.4 AI 调用（14 处，3 文件）

| 文件 | 引用数 | 方法 |
|------|:------:|------|
| `ai/prompt-builder.ts` | 7 | `generateRaw` ×4（含 2 处存在性检查）、`ConnectionManagerRequestService.sendRequest` ×1、`triggerSlash` ×7（profile 切换） |
| `ai/api-call.ts` | 5 | `generateRaw` ×3（含 1 处存在性检查）、`ConnectionManagerRequestService.sendRequest` ×1 |
| `summary/merge-logic.ts` | 2 | `ConnectionManagerRequestService.sendRequest` ×1、`TavernHelper?.generateRaw` ×1 |

#### 9.3.5 其他（2 处，2 文件）

| 文件 | 引用数 | 方法 |
|------|:------:|------|
| `ai/prompt-builder.ts` | 1 | `SillyTavern_API_ACU.extensionSettings?.connectionManager?.profiles` |
| `worldbook/pipeline.ts` | 4 | `SillyTavern_API_ACU.getWorldBooks()`（4处，含存在性检查） |

### 9.4 Gateway 设计方案

#### Gateway 1：`data/gateways/worldbook-gateway.ts`

**职责**：封装所有世界书 CRUD 操作

```
方法清单：
├── getEntries(bookName): Promise<LorebookEntry[]>
│   → TavernHelper_API_ACU.getLorebookEntries(bookName)
│   → 不可用时返回 []
│
├── setEntries(bookName, entries): Promise<void>
│   → TavernHelper_API_ACU.setLorebookEntries(bookName, entries)
│
├── createEntries(bookName, entries): Promise<void>
│   → TavernHelper_API_ACU.createLorebookEntries(bookName, entries)
│
├── deleteEntries(bookName, uids): Promise<void>
│   → TavernHelper_API_ACU.deleteLorebookEntries(bookName, uids)
│
├── listLorebooks(): Promise<string[]>
│   → 优先 TavernHelper_API_ACU.getLorebooks()
│   → 降级 SillyTavern_API_ACU.getWorldBooks()
│   → 统一两个 API 名称
│
├── getCurrentCharPrimaryLorebook(): Promise<string | null>
│   → TavernHelper_API_ACU.getCurrentCharPrimaryLorebook()
│
└── isAvailable(): boolean
    → 检查 TavernHelper_API_ACU 是否存在
```

**覆盖文件**：pipeline.ts（14处）、injection-engine-custom.ts（6处）、injection-engine-state.ts（2处）、helpers-plot-runtime.ts（1处）
**预计行数**：~100 行

#### Gateway 2：`data/gateways/character-gateway.ts`

**职责**：封装角色/聊天数据读取

```
方法清单：
├── getCurrentCharData(): any | null
│   → TavernHelper_API_ACU.getCharData('current')
│   → 不可用时返回 null
│
├── getCharLorebooks(): Promise<string[]>
│   → TavernHelper_API_ACU.getCharLorebooks({ type: 'all' })
│   → 不可用时返回 []
│
└── getChatMessages(range, options?): Promise<any[]>
    → TavernHelper_API_ACU.getChatMessages(range, options)
    → 不可用时返回 []
```

**覆盖文件**：helpers-plot-runtime.ts（3处）、pipeline.ts（2处）、content-optimization.ts（1处）、prompt-builder.ts（1处）
**预计行数**：~60 行

#### Gateway 3：`data/gateways/ai-gateway.ts`

**职责**：封装 AI 调用（generateRaw + ConnectionManager + triggerSlash）

```
方法清单：
├── generateRaw(options): Promise<string>
│   → TavernHelper_API_ACU.generateRaw(options)
│   → 统一存在性检查 + 错误处理
│
├── sendRequest(profile, messages, maxTokens): Promise<any>
│   → SillyTavern_API_ACU.ConnectionManagerRequestService.sendRequest(...)
│   → 统一存在性检查
│
├── triggerSlash(command): Promise<string>
│   → TavernHelper_API_ACU.triggerSlash(command)
│   → 统一存在性检查
│
├── getConnectionManagerProfiles(): any[]
│   → SillyTavern_API_ACU.extensionSettings?.connectionManager?.profiles || []
│
└── isGenerateRawAvailable(): boolean
    → typeof TavernHelper_API_ACU.generateRaw === 'function'
```

**覆盖文件**：prompt-builder.ts（13处）、api-call.ts（4处）、merge-logic.ts（2处）
**预计行数**：~80 行

#### Gateway 4：`data/gateways/chat-gateway.ts`

**职责**：封装聊天数组访问 + saveChat

```
方法清单：
├── getChatArray(): any[]
│   → SillyTavern_API_ACU.chat || []
│   → 统一空值防御
│
├── getChatLength(): number
│   → (SillyTavern_API_ACU.chat?.length) || 0
│
├── getLastMessageIndex(): number
│   → Math.max(0, getChatLength() - 1)
│
└── saveChat(): Promise<void>
    → SillyTavern_API_ACU.saveChat()
    → 统一存在性检查（typeof === 'function'）
    → 不可用时静默跳过
```

**覆盖文件**：helpers-plot-runtime.ts（4处chat+2处save）、table-service.ts（3处chat+1处save）、pipeline.ts（2处chat）、helpers-data-merge.ts（1处chat+2处save）、helpers-template-vars.ts（1处chat）、plot-logic.ts（1处chat+4处save）、content-optimization.ts（1处chat）、merge-logic.ts（1处chat）、chat-scope.ts（4处save）、template-preset-service.ts（2处save）、injection-engine-state.ts（1处save）
**预计行数**：~50 行

### 9.5 执行计划（按步骤）

#### Phase B-1：创建 4 个 Gateway 文件（不改 service 层）

| 步骤 | 内容 | 风险 |
|:----:|------|:----:|
| B-1.1 | 创建 `data/gateways/` 目录 | 无 |
| B-1.2 | 新建 `worldbook-gateway.ts`（~100行） | 低 |
| B-1.3 | 新建 `character-gateway.ts`（~60行） | 低 |
| B-1.4 | 新建 `ai-gateway.ts`（~80行） | 低 |
| B-1.5 | 新建 `chat-gateway.ts`（~50行） | 低 |
| B-1.6 | `tsc` 编译验证新文件无错误 | 低 |

#### Phase B-2：逐文件迁移 service 层引用

按文件从简单到复杂的顺序：

| 步骤 | 文件 | 替换数 | 涉及 Gateway | 风险 |
|:----:|------|:------:|-------------|:----:|
| B-2.1 | `injection-engine-state.ts` | 3 | Worldbook + Chat | 低 |
| B-2.2 | `injection-engine-custom.ts` | 6 | Worldbook | 低 |
| B-2.3 | `content-optimization.ts` | 2 | Character + Chat | 低 |
| B-2.4 | `merge-logic.ts` | 2 | AI + Chat | 低 |
| B-2.5 | `table-service.ts` | 4 | Chat | 低 |
| B-2.6 | `template-preset-service.ts` | 2 | Chat | 低 |
| B-2.7 | `helpers-data-merge.ts` | 3 | Chat | 低 |
| B-2.8 | `helpers-template-vars.ts` | 1 | Chat | 低 |
| B-2.9 | `plot-logic.ts` | 5 | Chat | 低 |
| B-2.10 | `api-call.ts` | 4 | AI + Worldbook | 中 |
| B-2.11 | `helpers-plot-runtime.ts` | 9 | Worldbook + Character + Chat | 中 |
| B-2.12 | `chat-scope.ts` | 4 | Chat | 中 |
| B-2.13 | `pipeline.ts` | 20 | Worldbook + Character + Chat | 高 |
| B-2.14 | `prompt-builder.ts` | 14 | AI + Character | 高 |

#### Phase B-3：验证与文档更新

| 步骤 | 内容 |
|:----:|------|
| B-3.1 | `tsc` 全量编译 0 ERROR |
| B-3.2 | 全局搜索确认 service 层不再直接调用外部 API |
| B-3.3 | 更新 `docs/代码结构视图.md`（新增 `data/gateways/` 目录描述） |
| B-3.4 | 更新本文档验收标准 |

### 9.6 验收标准

- [ ] `data/gateways/worldbook-gateway.ts` 存在且覆盖 7 个世界书方法
- [ ] `data/gateways/character-gateway.ts` 存在且覆盖 3 个角色数据方法
- [ ] `data/gateways/ai-gateway.ts` 存在且覆盖 5 个 AI 调用方法
- [ ] `data/gateways/chat-gateway.ts` 存在且覆盖 4 个聊天数组方法
- [ ] `grep -r "TavernHelper_API_ACU" src/service/` 只剩 `state-manager.ts` 中的 re-export（2处）
- [ ] `grep -r "SillyTavern_API_ACU\.chat" src/service/` 返回 0 结果
- [ ] `grep -r "SillyTavern_API_ACU\.saveChat" src/service/` 返回 0 结果（注意 saveChat 可能在 service 中被 re-export）
- [ ] `grep -r "ConnectionManagerRequestService" src/service/` 返回 0 结果
- [ ] `grep -r "SillyTavern_API_ACU\.extensionSettings" src/service/` 返回 0 结果
- [ ] `grep -r "SillyTavern_API_ACU\.getWorldBooks" src/service/` 返回 0 结果
- [ ] `tsc` 全量编译 0 ERROR
- [ ] `docs/代码结构视图.md` 已更新

### 9.7 与 SQLite 切换的关系

```
Phase A（✅ 已完成）：消息级表格数据 CRUD 收拢到 chat-message-data-repo
Phase B（本次）：外部 API 全量收拢到 data/gateways/
Phase C（未来）：SQLite 运行时数据库实现
  └── 只需替换 chat-message-data-repo 的内部实现：
      - 启动时：从 message 字段 → 加载到 SQLite
      - 运行时：SQL 查询替代 JS 对象遍历
      - 保存时：SQLite → 写回 message 字段
```

**Phase B 完成后，service 层将完全不依赖任何宿主 API**，所有外部调用都经过 data 层的 Gateway/Repository 抽象。这意味着：
1. 切换 SQLite 只需改 `chat-message-data-repo.ts` 一个文件
2. 切换宿主平台（如果有的话）只需改 `data/gateways/` 下的 4 个文件
3. 单元测试只需 mock data 层，不需要 mock 全局对象

### 9.8 关于 presentation 层的说明

presentation 层也有大量直接调用 `TavernHelper_API_ACU`（约 32 处）和 `SillyTavern_API_ACU`（约 50+ 处）的代码。但：

1. **presentation 层按架构规则不能直接访问 data 层**（见依赖关系矩阵）
2. presentation 层的这些调用大部分在 `init.ts`（事件监听）和 `import-process.ts`（导入流程）中
3. 要收拢这些调用，需要在 service 层新增对应的 service 方法来中转
4. **本次不处理 presentation 层**，聚焦 service 层收拢

这是一个独立的后续任务，可以在 Phase B 完成后再规划。

### 9.9 关于"只关注表格"的说明

用户明确要求：
- **表格数据**：走 SQLite 运行时数据库（已有 `chat-message-data-repo` 抽象）
- **其他配置**（settings、profile、isolation 等）：保持原有方式存储，但要收拢到 data 层
  - settings → 已通过 `settings-service.ts` 管理（service 层），底层通过 `config-storage.ts`（data 层）持久化 ✅
  - profile → 已通过 `profile-repo.ts`（data 层）管理 ✅
  - isolation → 已通过 `isolation-repo.ts`（data 层）管理 ✅
  - 世界书/角色/AI/聊天 → **本次通过 Gateway 收拢** 🔧

所以本次 Phase B 完成后，**所有外部数据操作都经过 data 层**，配置类的已经在 data 层，外部 API 类的通过 Gateway 收拢。
