/**
 * shared/table-storage-provider.ts — 统一的表格存储提供者接口
 *
 * 定义 ITableStorageProvider 接口，原生模式和 SQLite 模式各自实现。
 * 上层代码通过策略选择器获取 Provider，不直接依赖具体实现。
 */

import type { TableDataObject_ACU } from './models/table-data';

/** 存储模式 */
export type StorageMode = 'native' | 'sqlite';

/** SQL 查询结果（SELECT） */
export interface SqlQueryResult {
  /** 列名数组 */
  columns: string[];
  /** 结果行（每行是一个值数组） */
  values: (string | number | Uint8Array | null)[][];
  /** 结果行数 */
  rowCount: number;
}

/** SQL 查询执行选项 */
export interface SqlQueryExecutionOptions_ACU {
  suppressErrorLog?: boolean;
}

/** SQL 变更结果（INSERT/UPDATE/DELETE） */
export interface SqlMutationResult {
  /** 受影响的行数 */
  changes: number;
  /** 错误信息列表（如果有） */
  errors: string[];
}

/** AI 编辑应用结果 */
export interface ApplyEditsResult {
  /** 是否成功 */
  success: boolean;
  /** 受影响的 sheetKey 列表 */
  modifiedKeys: string[];
  /** 成功应用的编辑数量 */
  appliedEdits: number;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 统一的表格存储提供者接口
 *
 * 原生模式（NativeTableServiceAdapter）和 SQLite 模式（SqlTableService）
 * 各自实现此接口。上层代码通过 getStorageProvider() 获取当前 Provider，
 * 不需要知道底层是 JSON 操作还是 SQL 操作。
 */
export interface ITableStorageProvider {
  /** 模式标识 */
  readonly mode: StorageMode;

  /**
   * 从聊天消息加载表格数据到运行时
   * - native：调用 loadOrCreateJsonTableFromChatHistory_ACU
   * - sqlite：mergeAll → loadFromTableData → 建表灌数据
   */
  loadFromChat(): Promise<{
    loaded: boolean;
    source: 'merged' | 'initialized' | 'empty';
    error?: string;
  }>;

  /**
   * 从调用方已恢复的当前聊天快照初始化运行时。
   *
   * SQLite 实现用它避免重复回放/迁移同一聊天；native 无需实现，
   * 因为它直接使用全局 JSON 运行时视图。
   */
  loadFromData?(data: TableDataObject_ACU | null): Promise<{
    loaded: boolean;
    source: 'merged' | 'initialized' | 'empty';
    error?: string;
  }>;

  /** 当前运行时是否已经可用。native 恒为 true；sqlite 需引擎已初始化。 */
  isReady(): boolean;

  /**
   * 保存当前运行时数据到聊天消息
   * - native：调用 saveIndependentTableToChatHistory_ACU
   * - sqlite：exportToTableData → 更新 JSON 视图 → saveIndependentTable
   */
  saveToChat(
    targetSheetKeys?: string[] | null,
    updateGroupKeys?: string[] | null,
    trackingSheetKeys?: string[] | null,
    options?: { source?: string; requestId?: string; batchId?: string; operations?: unknown[]; transactionContext?: unknown },
  ): Promise<{ saved: boolean; messageIndex?: number; error?: string }>;

  /**
   * 获取当前运行时的完整表格数据（JSON 格式）
   * 两种模式都返回 TableDataObject_ACU，保证上层代码零改动
   */
  getCurrentData(): TableDataObject_ACU | null;

  /**
   * 在公共提交模型内替换完整运行时数据。
   * 注意：只负责运行时更新，不负责持久化聊天记录。
   */
  replaceAllData?(data: TableDataObject_ACU): Promise<ApplyEditsResult> | ApplyEditsResult;

  /**
   * 应用 AI 返回的编辑指令
   * - native：解析 DSL（insertRow/updateRow/deleteRow）
   * - sqlite：执行 SQL 语句（事务包裹，失败回滚）
   *
   * @param edits AI 返回的编辑内容（DSL 或 SQL）
   * @param updateMode 更新模式（standard/summary/unified）
   * @returns 应用结果
   */
  applyEdits(edits: string, updateMode?: string): ApplyEditsResult;

  /**
   * 批量应用多段 AI SQL/编辑内容。
   * sqlite 模式必须把所有 SQL 放进同一个运行时事务；native 可不实现。
   */
  applyEditsBatch?(editsList: string[], updateMode?: string, paramsList?: (string | number | null)[][]): ApplyEditsResult;

  /** 创建运行时快照，用于提交失败或重试前回滚。sqlite 返回二进制 DB 快照；native 可不实现。 */
  createRuntimeSnapshot?(): unknown;

  /** 恢复 createRuntimeSnapshot 创建的运行时快照。 */
  restoreRuntimeSnapshot?(snapshot: unknown): Promise<void>;

  /**
   * 精确清空运行时表格状态，不读取聊天记录也不创建模板数据。
   * 失败补偿依赖此方法恢复“旧运行时为空”的状态，因此所有 provider 必须实现。
   */
  clearRuntimeData(): void;

  /**
   * 执行 SQL 查询（仅 sqlite 模式支持）
   * native 模式调用时抛出 Error
   */
  executeQuery(
    sql: string,
    params?: (string | number | null)[],
    options?: SqlQueryExecutionOptions_ACU,
  ): SqlQueryResult;

  /**
   * 执行 SQL 变更语句（仅 sqlite 模式支持）
   * native 模式调用时抛出 Error
   */
  executeMutation(sql: string, params?: (string | number | null)[]): SqlMutationResult;

  /**
   * 销毁/清理资源
   * - native：无操作
   * - sqlite：关闭数据库实例
   */
  dispose(): void;
}
