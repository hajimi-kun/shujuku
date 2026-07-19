/**
 * data/sqlite/sqlite-engine.ts — SQLite 运行时引擎
 *
 * 管理 sql.js 的 Database 实例生命周期。
 * 职责：
 * - 初始化 sql.js（从 npm 包本地引入）
 * - 创建/销毁内存数据库
 * - 提供 query/run/runBatch 的薄封装
 * - 不涉及业务逻辑（业务逻辑在 sync-bridge.ts 和 schema-mapper.ts）
 */

// sql.js asm 版本（纯 JS，不依赖 WASM，适合油猴环境）
import initSqlJs from 'sql.js/dist/sql-asm-memory-growth.js';
import { logDebug_ACU, logError_ACU, logWarn_ACU } from '../../shared/utils';

/** 列信息（PRAGMA table_info 返回的结构） */
export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

/** SELECT 查询结果 */
export interface QueryResult {
  columns: string[];
  values: SqlJsValueType[][];
}

/** 查询执行诊断选项 */
export interface SqliteQueryOptions_ACU {
  suppressErrorLog?: boolean;
}

/** INSERT/UPDATE/DELETE 执行结果 */
export interface MutationResult {
  changes: number;
}

/** 批量执行结果 */
export interface BatchResult {
  totalChanges: number;
}

export class SqliteEngine {
  private db: SqlJsDatabase | null = null;
  private sqlJs: SqlJsStatic | null = null;

  /** 是否已初始化 */
  get isReady(): boolean {
    return this.db !== null;
  }

  /**
   * 初始化 sql.js 并创建空的内存数据库
   * 如果已经初始化过，会先销毁旧实例再重建
   */
  async init(): Promise<void> {
    // 销毁旧实例（如果有）
    this.dispose();

    // [6.7.2] 检测 sql.js 是否可用（CDN @require 可能加载失败）
    if (typeof initSqlJs !== 'function') {
      throw new Error(
        'sql.js 引擎未加载：initSqlJs 函数不存在。' +
        '请检查油猴脚本的 @require 是否正确引入了 sql-asm-memory-growth.js，' +
        '或 CDN 是否可达。将自动 fallback 到原生模式。'
      );
    }

    // 初始化 sql.js（asm 版本不需要 locateFile 配置）
    if (!this.sqlJs) {
      try {
        logDebug_ACU('[SQLite引擎] 正在初始化 sql.js...');
        this.sqlJs = await initSqlJs();
        logDebug_ACU('[SQLite引擎] sql.js 初始化成功');
      } catch (e: any) {
        logError_ACU('[SQLite引擎] sql.js 初始化失败:', e?.message || String(e));
        throw new Error(
          `sql.js 初始化失败: ${e?.message || String(e)}。将自动 fallback 到原生模式。`
        );
      }
    }

    // 创建空的内存数据库
    this.db = new this.sqlJs.Database();
    logDebug_ACU('[SQLite引擎] 内存数据库已创建');

    // 启用 WAL 模式（内存数据库下无实际效果，但保持语义一致）
    // 启用外键约束
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  /**
   * 执行 SELECT 查询，返回列名 + 结果集
   * @param sql SELECT 语句
   * @param params 参数绑定（可选）
   * @returns 查询结果（columns + values）
   * @throws 数据库未初始化或 SQL 语法错误时抛出
   */
  query(sql: string, params?: SqlJsBindParams, options: SqliteQueryOptions_ACU = {}): QueryResult {
    this._ensureDb();
    try {
      const results = this.db!.exec(sql, params);
      if (results.length === 0) {
        return { columns: [], values: [] };
      }
      // exec 可能返回多个结果集（多条 SELECT），只取第一个
      return {
        columns: results[0].columns,
        values: results[0].values,
      };
    } catch (e: any) {
      if (options.suppressErrorLog !== true) {
        logError_ACU('[SQLite引擎] query 执行失败:', sql.substring(0, 200), '| 错误:', e?.message || String(e));
      }
      throw e;
    }
  }

  /**
   * 执行单条 INSERT/UPDATE/DELETE/CREATE TABLE 等语句
   * @param sql SQL 语句
   * @param params 参数绑定（可选）
   * @returns 受影响的行数
   * @throws 数据库未初始化或 SQL 语法错误时抛出
   */
  run(sql: string, params?: SqlJsBindParams): MutationResult {
    this._ensureDb();
    try {
      this.db!.run(sql, params);
      return { changes: this.db!.getRowsModified() };
    } catch (e: any) {
      logError_ACU('[SQLite引擎] run 执行失败:', sql.substring(0, 200), '| 错误:', e?.message || String(e));
      throw e;
    }
  }

  /**
   * 批量执行多条 SQL（整批事务，原子性）
   * 任何一条失败 → ROLLBACK 整个事务 → 抛出包含详细报错的 Error
   * 报错信息格式："第 N 条语句失败: [原始SQL] → [SQLite错误信息]"
   * 上层重试循环捕获后，将报错注入 AI prompt 触发重写
   *
   * @param statements SQL 语句数组
   * @returns 所有语句的总受影响行数
   * @throws 任何一条语句失败时抛出，包含详细的错误定位信息
   */
  runBatch(statements: string[], paramsList?: (SqlJsBindParams | undefined)[]): BatchResult {
    this._ensureDb();
    if (statements.length === 0) return { totalChanges: 0 };
    logDebug_ACU(`[SQLite引擎] runBatch: 执行 ${statements.length} 条语句`);

    let totalChanges = 0;
    this.db!.run('BEGIN TRANSACTION;');
    try {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i].trim();
        if (!stmt) continue;
        try {
          this.db!.run(stmt, paramsList?.[i]);
          totalChanges += this.db!.getRowsModified();
        } catch (e: any) {
          // 回滚事务
          try { this.db!.run('ROLLBACK;'); } catch (_) { /* 忽略回滚失败 */ }
          const errMsg = e?.message || String(e);
          throw new Error(`第 ${i + 1} 条语句失败: ${stmt} → ${errMsg}`);
        }
      }
      this.db!.run('COMMIT;');
      logDebug_ACU(`[SQLite引擎] runBatch: 事务提交成功, 共影响 ${totalChanges} 行`);
      return { totalChanges };
    } catch (e: any) {
      // 如果是我们自己抛出的格式化错误，直接重新抛出
      if (e.message && e.message.startsWith('第 ')) throw e;
      // 其他意外错误（如 COMMIT 失败）
      try { this.db!.run('ROLLBACK;'); } catch (_) { /* 忽略 */ }
      throw e;
    }
  }

  /**
   * 获取所有用户表名（排除 sqlite 内部表和 _acu_ 前缀的系统表）
   * @returns 用户表名数组
   */
  getTableNames(): string[] {
    this._ensureDb();
    const result = this.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_acu_%' ORDER BY name;"
    );
    return result.values.map(row => String(row[0]));
  }

  /**
   * 获取所有表名（包括 _acu_ 系统表，排除 sqlite 内部表）
   * @returns 所有表名数组
   */
  getAllTableNames(): string[] {
    this._ensureDb();
    const result = this.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
    );
    return result.values.map(row => String(row[0]));
  }

  /**
   * 获取指定表的列信息（PRAGMA table_info）
   * @param tableName 表名
   * @returns 列信息数组
   * @throws 表不存在时返回空数组（不抛出）
   */
  getTableInfo(tableName: string): ColumnInfo[] {
    this._ensureDb();
    // 防止 SQL 注入：表名只允许字母、数字、下划线
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`非法表名: ${tableName}`);
    }
    const result = this.query(`PRAGMA table_info(${tableName});`);
    return result.values.map(row => ({
      cid: Number(row[0]),
      name: String(row[1]),
      type: String(row[2]),
      notnull: row[3] === 1,
      dflt_value: row[4] != null ? String(row[4]) : null,
      pk: row[5] === 1,
    }));
  }

  /**
   * 获取指定表的建表 DDL（从 sqlite_master 读取）
   * @param tableName 表名
   * @returns CREATE TABLE 语句，表不存在时返回 null
   */
  getTableDDL(tableName: string): string | null {
    this._ensureDb();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`非法表名: ${tableName}`);
    }
    const result = this.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
      [tableName]
    );
    if (result.values.length === 0) return null;
    return String(result.values[0][0]);
  }

  /**
   * 销毁数据库实例，释放内存
   * 销毁后 isReady 变为 false，需要重新 init() 才能使用
   */
  dispose(): void {
    if (this.db) {
      logDebug_ACU('[SQLite引擎] 正在销毁数据库实例...');
      try { this.db.close(); } catch (_) { /* 忽略关闭错误 */ }
      this.db = null;
    }
  }

  /**
   * 将整个数据库导出为二进制数据（用于持久化或调试）
   * @returns Uint8Array 格式的 SQLite 数据库文件
   */
  exportBinary(): Uint8Array {
    this._ensureDb();
    return this.db!.export();
  }

  /**
   * 从二进制数据恢复数据库（用于从持久化数据恢复）
   * @param data Uint8Array 格式的 SQLite 数据库文件
   */
  async loadFromBinary(data: Uint8Array): Promise<void> {
    logDebug_ACU(`[SQLite引擎] 从二进制数据恢复数据库 (${data.byteLength} bytes)`);
    if (!this.sqlJs) {
      this.sqlJs = await initSqlJs();
    }
    this.dispose();
    this.db = new this.sqlJs.Database(data);
    this.db.run('PRAGMA foreign_keys = ON;');
    logDebug_ACU('[SQLite引擎] 数据库恢复完成');
  }

  /** 内部方法：确保数据库已初始化 */
  private _ensureDb(): void {
    if (!this.db) {
      throw new Error('SqliteEngine 未初始化，请先调用 init()');
    }
  }
}
