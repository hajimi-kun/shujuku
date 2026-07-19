/**
 * data/models/table-data.ts — 表格数据结构定义
 *
 * 定义 sheet、mate、表格数据对象的 TypeScript 接口。
 * 这些类型描述了 currentJsonTableData_ACU 的内部结构。
 */

/** 单个表格的更新配置 */

export interface SheetUpdateConfig_ACU {
  uiSentinel: number;
  contextDepth: number;
  updateFrequency: number;
  batchSize: number;
  skipFloors: number;
  sendRowsSqlTemplate?: string;
}

/** 世界书导出位置配置 */
export interface PlacementConfig_ACU {
  position: string;
  depth: number;
  order: number;
}

/** 单个表格的导出配置 */
export interface SheetExportConfig_ACU {
  enabled: boolean;
  splitByRow: boolean;
  entryName: string;
  entryType: string;
  keywords: string;
  preventRecursion: boolean;
  injectionTemplate: string;
  extraIndexEnabled: boolean;
  extraIndexEntryName: string;
  extraIndexColumns: string[];
  extraIndexColumnModes: Record<string, string>;
  extraIndexInjectionTemplate: string;
  sqlInjectionTemplate?: string;
  entryPlacement: PlacementConfig_ACU;
  extraIndexPlacement: PlacementConfig_ACU;
  fixedEntryPlacement: PlacementConfig_ACU;
  fixedIndexPlacement: PlacementConfig_ACU;
  injectIntoWorldbook?: boolean;
}

/** 单个表格的源数据描述 */
export interface SheetSourceData_ACU {
  note: string;
  initNode: string;
  deleteNode: string;
  updateNode: string;
  insertNode: string;
  /** SQLite 模式下的建表 DDL（可选，仅 sqlite 模式使用） */
  ddl?: string;
}

/** 单张表格（sheet）的完整结构 */
export interface Sheet_ACU {
  uid: string;
  name: string;
  sourceData: SheetSourceData_ACU;
  content: (string | null)[][];
  updateConfig: SheetUpdateConfig_ACU;
  exportConfig: SheetExportConfig_ACU;
  orderNo: number;
  /** 运行时附加：seedRows 基底数据（来自 Sheet Guide） */
  seedRows?: (string | null)[][];
}

/** 全局注入配置 */
export interface GlobalInjectionConfig_ACU {
  readableEntryPlacement: PlacementConfig_ACU;
  wrapperPlacement: PlacementConfig_ACU;
}

/** mate 元信息块 */
export interface Mate_ACU {
  type: string;
  version: number;
  updateConfigUiSentinel: number;
  globalInjectionConfig: GlobalInjectionConfig_ACU;
}

/** 完整的表格数据对象（currentJsonTableData_ACU 的类型） */
export interface TableDataObject_ACU {
  mate: Mate_ACU;
  [sheetKey: string]: Sheet_ACU | Mate_ACU;
}
