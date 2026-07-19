/**
 * service/runtime/template-vars/name-mapper.ts
 * 中英文名称双向映射器
 *
 * 从 DDL 注释中自动构建中英文双向映射。
 * 用户在 ORM / SQL / <if> 中可以使用中文名、英文名、甚至混用，
 * 引擎自动翻译为英文名后执行。
 *
 * 翻译在应用层完成，SQLite 引擎本身只认英文名。
 */

import {
  parseDDLTableName,
  parseDDLChineseName,
  parseDDLColumnComments,
} from '../../../shared/ddl-utils';
import { logDebug_ACU, logWarn_ACU } from '../../../shared/utils';

/** 全局 NameMapper 单例 */
let _globalNameMapper: NameMapper | null = null;

/**
 * 获取全局 NameMapper 实例
 * 如果尚未构建，返回一个空的 NameMapper（所有名称直接透传）
 */
export function getNameMapper(): NameMapper {
  if (!_globalNameMapper) {
    _globalNameMapper = new NameMapper();
  }
  return _globalNameMapper;
}

/**
 * 从所有表的 DDL 构建全局 NameMapper
 * 在 SQLite 加载完成后调用
 *
 * @param ddlMap 表英文名 → DDL 语句的映射
 */
export function buildGlobalNameMapper(ddlMap: Map<string, string>): void {
  _globalNameMapper = NameMapper.fromDDLs(ddlMap);
  logDebug_ACU(`[NameMapper] 全局映射器已构建: ${_globalNameMapper.tableCount} 张表`);
}

/**
 * 销毁全局 NameMapper
 */
export function disposeGlobalNameMapper(): void {
  _globalNameMapper = null;
}

/**
 * 中英文名称双向映射器
 */
export class NameMapper {
  // 表名映射：中文 → 英文
  private tableNameMap: Map<string, string> = new Map();
  // 列名映射：表英文名.中文列名 → 英文列名
  private columnNameMap: Map<string, string> = new Map();
  // 反向映射：英文 → 中文
  private reverseTableMap: Map<string, string> = new Map();
  private reverseColumnMap: Map<string, string> = new Map();

  /** 映射的表数量 */
  get tableCount(): number {
    return this.reverseTableMap.size;
  }

  /**
   * 从多张表的 DDL 构建映射器
   * @param ddlMap 表英文名 → DDL 语句的映射
   */
  static fromDDLs(ddlMap: Map<string, string>): NameMapper {
    const mapper = new NameMapper();

    for (const [_key, ddl] of ddlMap) {
      if (!ddl) continue;

      // 解析英文表名
      const englishTableName = parseDDLTableName(ddl);
      if (!englishTableName) continue;

      // 解析中文表名（DDL 第一行注释）
      const chineseTableName = parseDDLChineseName(ddl);
      if (chineseTableName) {
        mapper.tableNameMap.set(chineseTableName, englishTableName);
        mapper.reverseTableMap.set(englishTableName, chineseTableName);
      } else {
        // 没有中文注释，也记录英文名（用于 reverseTableMap）
        mapper.reverseTableMap.set(englishTableName, englishTableName);
      }

      // 解析列名注释
      const columnComments = parseDDLColumnComments(ddl);
      for (const [colName, comment] of columnComments) {
        if (comment && colName !== 'row_id') {
          const key = `${englishTableName}.${comment}`;
          mapper.columnNameMap.set(key, colName);
          mapper.reverseColumnMap.set(`${englishTableName}.${colName}`, comment);
        }
      }
    }

    return mapper;
  }

  /**
   * 解析表名（中文→英文，英文直接返回）
   */
  resolveTableName(name: string): string {
    if (!name) return name;
    const trimmed = name.trim();
    // 先查中文映射
    const english = this.tableNameMap.get(trimmed);
    if (english) return english;
    // 检查是否本身就是英文表名
    if (this.reverseTableMap.has(trimmed)) return trimmed;
    // 未找到映射，原样返回
    return trimmed;
  }

  /**
   * 解析列名（中文→英文，英文直接返回）
   * @param tableName 英文表名（已解析过的）
   * @param columnName 列名（可能是中文或英文）
   */
  resolveColumnName(tableName: string, columnName: string): string {
    if (!columnName) return columnName;
    const trimmed = columnName.trim();
    // 先查中文映射
    const key = `${tableName}.${trimmed}`;
    const english = this.columnNameMap.get(key);
    if (english) return english;
    // 检查是否本身就是英文列名
    if (this.reverseColumnMap.has(`${tableName}.${trimmed}`)) return trimmed;
    // 未找到映射，原样返回（可能是英文名或未知名）
    return trimmed;
  }

  /**
   * 反向：英文表名→中文（用于展示给用户）
   */
  getChineseTableName(englishName: string): string {
    return this.reverseTableMap.get(englishName) || englishName;
  }

  /**
   * 反向：英文列名→中文（用于展示给用户）
   */
  getChineseColumnName(tableName: string, englishName: string): string {
    return this.reverseColumnMap.get(`${tableName}.${englishName}`) || englishName;
  }

  /**
   * 将原生 SQL 中的中文名替换为英文名（跳过字符串值）
   *
   * 安全替换策略：
   * 1. 先把单引号字符串提取出来，用占位符替代
   * 2. 在安全的 SQL 上做中文→英文替换（长名称优先，避免子串误匹配）
   * 3. 把字符串值放回去
   */
  translateSql(sql: string): string {
    if (!sql) return sql;

    // 1. 提取单引号字符串，用占位符替代
    const strings: string[] = [];
    let safeSql = sql.replace(/'[^']*'/g, (match) => {
      strings.push(match);
      return `__STR_${strings.length - 1}__`;
    });

    // 2. 替换中文表名（长名称优先）
    const sortedTableNames = [...this.tableNameMap.entries()]
      .sort((a, b) => b[0].length - a[0].length);
    for (const [cn, en] of sortedTableNames) {
      safeSql = safeSql.split(cn).join(en);
    }

    // 3. 替换中文列名（长名称优先）
    const sortedColumnNames = [...this.columnNameMap.entries()]
      .map(([key, en]) => {
        const dotIndex = key.indexOf('.');
        const cn = key.substring(dotIndex + 1);
        return { cn, en };
      })
      .sort((a, b) => b.cn.length - a.cn.length);
    for (const { cn, en } of sortedColumnNames) {
      safeSql = safeSql.split(cn).join(en);
    }

    // 4. 把字符串值放回去
    safeSql = safeSql.replace(/__STR_(\d+)__/g, (_, i) => strings[Number(i)]);

    return safeSql;
  }

  /**
   * 获取所有英文表名
   */
  getAllTableNames(): string[] {
    return [...this.reverseTableMap.keys()];
  }
}
