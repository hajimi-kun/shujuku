# 表格写入并发事务实现计划

## 目标

把当前“各入口各自加锁 / 部分锁保存阶段 / 全局状态直接 mutation”的模型，改造成：

```text
多粒度事务锁 + 私有 workingData + isolation commit lock + V2 revision/writeSet + 冲突检测/rebase
```

最终允许：

```text
A 表和 B 表可以并行计算 mutation。
同一张表的写入必须串行 mutation。
所有写入必须串行提交到同一个 isolationKey 的 V2 log。
清理/删除/compaction 必须排斥普通写入。
legacy-v1 退化为 isolation exclusive 写事务。
```

## 阶段 1：事务锁基础设施

### 新增模块

```text
src/service/table/table-write-transaction.ts
```

职责：

```text
1. maintenance shared/exclusive lock。
2. sheet mutation lock。
3. sheet:* wildcard lock。
4. isolation commit lock。
5. 固定加锁顺序：maintenance -> sheet wildcard -> sheet locks sorted -> commit。
6. 事务 ctx。
7. 私有 workingData 创建。
```

### 新增/调整类型

在 `storage-frame-v2-types.ts` 增加：

```text
TableWriteConflictUnitV2_ACU
TableMutationWriteSetV2_ACU
baseRevision
parentRevision
commitRevision
writeSet
headRevision
```

### 验收

```text
1. 不同 sheet 可并行进入 mutation。
2. 同 sheet 串行 mutation。
3. sheet:* 与任意 sheet 互斥。
4. 不同 sheet 的 commit 必须串行。
5. maintenance exclusive 排斥普通写事务。
```

## 阶段 2：V2 commit 元数据与提交入口

### 改造文件

```text
src/service/table/storage-frame-v2-persist.ts
src/service/table/storage-frame-v2-replay.ts
src/service/table/storage-frame-v2-types.ts
```

### 工作项

```text
1. headRevision 写入 frame。
2. log entry 写 baseRevision / parentRevision / commitRevision / writeSet。
3. commit lock 内重新读取 latest frame。
4. commit lock 内分配 seq。
5. commit lock 内 append log / checkpoint / saveChat。
6. 初版冲突检测先按 sheetKey 级实现。
7. 不冲突不同 sheet 自动 rebase。
8. legacy-v1 不进细粒度 rebase，走 isolation exclusive。
```

## 阶段 3：AI 填表迁移到 workingData

### 改造文件

```text
src/service/table/update-orchestrator.ts
src/service/ai/prompt-builder/table-edit-parser.ts
src/service/table/sql-table-service.ts
```

### 工作项

```text
1. AI 响应收集继续在锁外。
2. parse/apply/save 进入 runTableWriteTransaction_ACU。
3. 原生 DSL 改用 parseAndApplyTableEditsToData_ACU(aiResponse, workingData)。
4. SQL 填表改用 applySqlEditsToTableDataSnapshot_ACU。
5. 保存时使用事务 commit，不再使用 saveIndependentTableToChatHistoryWithinScopeLock_ACU。
```

## 阶段 4：前端 CRUD 迁移到事务

### 改造文件

```text
src/presentation/bootstrap/api-groups/table-crud-api.ts
```

### 工作项

```text
1. 参数解析可以在锁外。
2. findTargetSheet / row/col 校验 / mutation 必须在事务 workingData 内重新做。
3. 原生 CRUD 不再直接修改 currentJsonTableData_ACU。
4. SQLite CRUD 不再直接打全局 provider；改用 workingData / snapshot SQL。
5. source=manual_crud。
6. filledSheetKeys 默认空，changedSheetKeys 为目标表。
```

## 阶段 5：raw SQL 迁移到事务

### 改造文件

```text
src/presentation/bootstrap/api-groups/sql-api.ts
src/service/table/sql-table-service.ts
src/shared/table-storage-provider.ts
```

### 工作项

```text
1. SELECT/PRAGMA/EXPLAIN/WITH 不进写事务。
2. mutation/batch 必须进入事务。
3. 已知 targetSheetKeys 时拿对应 sheet locks。
4. 未知 targetSheetKeys 时拿 sheet:*。
5. 使用 applySqlEditsToTableDataSnapshot_ACU 或等价 snapshot engine。
6. source=raw_sql_mutation/raw_sql_batch。
```

## 阶段 6：清理/删除/compaction 进入 maintenance exclusive

### 改造文件

```text
src/service/chat/chat-service.ts
src/service/worldbook/injection-engine-state.ts
src/data/repositories/chat-message-data-repo.ts
```

### 工作项

```text
1. purgeOldLayerData_ACU 使用 maintenance exclusive。
2. clearTableDataAtFloors_ACU 使用 maintenance exclusive。
3. deleteLocalDataInChatCore_ACU 使用 maintenance exclusive。
4. purgeSheetKeysFromChatHistoryHard_ACU 使用 maintenance exclusive。
5. 删除前预检恢复链，必要时先写 boundary checkpoint。
6. 删除后 replay 只作为校验。
```

## 阶段 7：废弃绕锁入口

### 工作项

```text
1. 删除或私有化 saveIndependentTableToChatHistoryWithinScopeLock_ACU。
2. 删除公开 useScopeLock=false。
3. 禁止业务入口直接调用 runTableUpdateApplyWithScopeLock_ACU。
4. 底层 queue 只给 table-write-transaction 使用。
```

## 阶段 8：测试

### 必须新增测试

```text
1. 不同 sheet mutation 并行，commit 串行。
2. 同 sheet mutation 串行。
3. sheet:* 阻塞所有具体 sheet。
4. maintenance exclusive 阻塞普通写事务。
5. V2 A/B 表并发提交不丢 log，seq 单调。
6. 同 sheet 冲突写入返回冲突或重试。
7. CRUD 不再锁外污染 currentJsonTableData_ACU。
8. raw SQL 未声明 targetSheetKeys 时走 sheet:*。
9. legacy-v1 走 isolation exclusive。
10. purge/clear/delete 与普通写事务互斥。
```

## 当前启动项

本轮先实现阶段 1 的基础设施和阶段 2 的类型元数据，不立即切换所有业务入口，避免半迁移导致行为不一致。

## 当前进度

已完成：

```text
1. 新增 table-write-transaction.ts。
2. 实现 maintenance shared/exclusive lock。
3. 实现 sheet mutation lock。
4. 实现 sheet:* wildcard lock。
5. 实现 isolation commit lock。
6. 实现事务私有 workingData 创建。
7. 实现 resolveTableWriteTargetMessageIndex_ACU。
8. 实现 writeSet 规范化和冲突判断。
9. V2 类型增加 headRevision / baseRevision / parentRevision / commitRevision / writeSet。
10. V2 persist 写入 revision 元数据。
11. V2 persist 支持 transactionContext，并在 ctx.runCommit 内提交。
12. table-service 的 V2/empty 保存分支开始进入 runTableWriteTransaction_ACU。
```

已验证：

```text
npx vitest run tests/service/table/table-write-transaction.test.ts tests/service/table/table-service.test.ts tests/integration/table-lifecycle.test.ts
npm run typecheck
npm run build
```

收尾状态：

```text
文档内功能已全部落地。SQLite CRUD 也已从“事务内真实 provider mutation”升级为事务私有 workingData 上的参数化 snapshot SQL mutation。
```

最新补充完成：

```text
13. transaction ctx 已填充真实 baseRevision。
14. V2 commit 已支持 latestState rebase：baseRevision 变化但 writeSet 不冲突时，将当前 patches 应用到 latestState 后提交。
15. AI 填表 legacy execute 路径已移除旧 targetMessageIndex scope lock，改用 runTableWriteTransaction_ACU。
16. AI 填表 legacy execute 路径已从 parseAndApplyTableEdits_ACU(currentJsonTableData_ACU) 迁移为 parseAndApplyTableEditsToData_ACU(workingData)。
17. AI SQL 填表路径使用 applySqlEditsToTableDataSnapshot_ACU 在 workingData 上执行。
18. AI 填表保存通过 persistTablesToChatMessage_ACU({ transactionContext }) 进入 commit lock。
19. CRUD 原生 updateCell / updateRow / insertRow / deleteRow 已迁移到 workingData transaction。
20. raw SQL API 已移除旧 targetMessageIndex=-1 scope lock，改用 runTableWriteTransaction_ACU；未知 targetSheetKeys 时 writeSet=all。
21. purgeOldLayerData_ACU / clearTableDataAtFloors_ACU / deleteLocalDataInChatCore_ACU 已进入 maintenance exclusive。
22. legacy-v1 保存已通过 runTableWriteTransaction_ACU 的 all writeSet 串行化。
23. 公开 useScopeLock=false 与 saveIndependentTableToChatHistoryWithinScopeLock_ACU 已从源码业务入口移除。
24. SQLite CRUD updateCell / updateRow / insertRow / deleteRow 已进入 runTableWriteTransaction_ACU，SQL mutation 与保存共享 transactionContext。
25. SQLite CRUD 已使用参数化 snapshot SQL 在事务私有 workingData 上执行，不再直接打全局 provider mutation。
26. purgeSheetKeysFromChatHistoryHard_ACU 已进入 maintenance exclusive，按目标 sheetKey 建立 writeSet。
27. 事务异常释放、V2 rebase/conflict、raw SQL/AI transactionContext、SQLite CRUD 事务、SQLite CRUD snapshot SQL、硬删除表 maintenance exclusive 均已补测试。
```

最新验证：

```text
npm test -- --run --reporter=dot
npm run typecheck
npm run build
```

结果：

```text
162 个测试文件通过。
3285 个测试通过。
TypeScript 类型检查通过。
构建通过。
架构检查违规 0。
```
