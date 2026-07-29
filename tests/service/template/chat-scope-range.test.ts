import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGuide = vi.fn();
const mockTemplate = vi.fn();

vi.mock('../../../src/service/template/chat-scope/chat-scope-guide', () => ({
  getChatSheetGuideDataForIsolationKey_ACU: (...args: any[]) => mockGuide(...args),
}));
vi.mock('../../../src/shared/utils', () => ({
  logWarn_ACU: vi.fn(),
  parseTableTemplateJson_ACU: (...args: any[]) => mockTemplate(...args),
}));

const makeSheet = (ddl: string, headers: string[]) => ({
  uid: 'u', name: 'n',
  sourceData: { ddl },
  content: [headers],
});

let range: typeof import('../../../src/service/template/chat-scope/chat-scope-range');

beforeEach(async () => {
  vi.clearAllMocks();
  range = await import('../../../src/service/template/chat-scope/chat-scope-range');
});

describe('resolveTemplateScope_ACU', () => {
  it('优先用 sheet guide 的声明范围', () => {
    mockGuide.mockReturnValue({ mate: {}, sheet_a: makeSheet('CREATE TABLE a (row_id INTEGER PRIMARY KEY);', ['row_id']), sheet_b: makeSheet('CREATE TABLE b (row_id INTEGER PRIMARY KEY);', ['row_id']) });
    const scope = range.resolveTemplateScope_ACU('');
    expect(scope).not.toBeNull();
    expect([...scope!.sheetKeys].sort()).toEqual(['sheet_a', 'sheet_b']);
    expect(mockTemplate).not.toHaveBeenCalled();
  });

  it('guide 为空时回退到全局模板', () => {
    mockGuide.mockReturnValue(null);
    mockTemplate.mockReturnValue({ mate: {}, sheet_x: makeSheet('CREATE TABLE x (row_id INTEGER PRIMARY KEY);', ['row_id']) });
    const scope = range.resolveTemplateScope_ACU('');
    expect([...scope!.sheetKeys]).toEqual(['sheet_x']);
  });

  it('guide 与模板都拿不到时返回 null（范围未知）', () => {
    mockGuide.mockReturnValue(null);
    mockTemplate.mockReturnValue(null);
    expect(range.resolveTemplateScope_ACU('')).toBeNull();
  });

  it('guide 报错时回退到模板，不抛出', () => {
    mockGuide.mockImplementation(() => { throw new Error('guide boom'); });
    mockTemplate.mockReturnValue({ mate: {}, sheet_y: makeSheet('CREATE TABLE y (row_id INTEGER PRIMARY KEY);', ['row_id']) });
    const scope = range.resolveTemplateScope_ACU('');
    expect([...scope!.sheetKeys]).toEqual(['sheet_y']);
  });
});

describe('filterSheetKeysByTemplateScope_ACU', () => {
  it('范围未知（null）时不过滤', () => {
    expect(range.filterSheetKeysByTemplateScope_ACU(['sheet_a', 'sheet_c'], null)).toEqual(['sheet_a', 'sheet_c']);
  });

  it('只保留模板声明的表', () => {
    const scope = { sheetKeys: new Set(['sheet_a', 'sheet_b']), sheets: {} as any };
    expect(range.filterSheetKeysByTemplateScope_ACU(['sheet_a', 'sheet_b', 'sheet_c'], scope)).toEqual(['sheet_a', 'sheet_b']);
  });
});

describe('resolveOutOfScopeColumns_ACU', () => {
  it('返回运行时有、模板无的列，row_id 永不列入', () => {
    const runtimeSheet = makeSheet(
      'CREATE TABLE t (row_id INTEGER PRIMARY KEY, a TEXT, b TEXT, extra TEXT);',
      ['row_id', 'a', 'b', 'extra'],
    );
    const scopeSheet = makeSheet(
      'CREATE TABLE t (row_id INTEGER PRIMARY KEY, a TEXT, b TEXT);',
      ['row_id', 'a', 'b'],
    );
    expect(range.resolveOutOfScopeColumns_ACU(runtimeSheet as any, scopeSheet as any)).toEqual(['extra']);
  });

  it('模板列与运行时一致时返回空', () => {
    const sheet = makeSheet('CREATE TABLE t (row_id INTEGER PRIMARY KEY, a TEXT);', ['row_id', 'a']);
    expect(range.resolveOutOfScopeColumns_ACU(sheet as any, sheet as any)).toEqual([]);
  });
});

describe('projectSheetForTemplateScope_ACU', () => {
  it('把模板未声明的列合并进 hiddenPhysicalColumns，不改写原对象', () => {
    const scopeSheet = makeSheet('CREATE TABLE t (row_id INTEGER PRIMARY KEY, a TEXT);', ['row_id', 'a']);
    const scope = { sheetKeys: new Set(['sheet_t']), sheets: { sheet_t: scopeSheet as any } };
    const runtimeSheet = makeSheet('CREATE TABLE t (row_id INTEGER PRIMARY KEY, a TEXT, extra TEXT);', ['row_id', 'a', 'extra']);
    const projected = range.projectSheetForTemplateScope_ACU(runtimeSheet as any, scope, 'sheet_t');
    expect(projected.sourceData!.hiddenPhysicalColumns).toEqual(['extra']);
    // 原对象不被改写。
    expect((runtimeSheet as any).sourceData.hiddenPhysicalColumns).toBeUndefined();
  });

  it('范围未知时原样返回', () => {
    const runtimeSheet = makeSheet('CREATE TABLE t (row_id INTEGER PRIMARY KEY, a TEXT);', ['row_id', 'a']);
    expect(range.projectSheetForTemplateScope_ACU(runtimeSheet as any, null, 'sheet_t')).toBe(runtimeSheet);
  });
});

describe('projectTableDataForTemplateScope_ACU', () => {
  it('范围外的表从投影中移除，非 sheet_ 键保留', () => {
    const scope = { sheetKeys: new Set(['sheet_a']), sheets: {} as any };
    const data: any = { mate: { type: 'acu' }, sheet_a: makeSheet('CREATE TABLE a (row_id INTEGER PRIMARY KEY);', ['row_id']), sheet_c: makeSheet('CREATE TABLE c (row_id INTEGER PRIMARY KEY);', ['row_id']) };
    const projected = range.projectTableDataForTemplateScope_ACU(data, scope) as any;
    expect(projected.mate).toEqual({ type: 'acu' });
    expect(projected.sheet_a).toBeDefined();
    expect(projected.sheet_c).toBeUndefined();
  });
});
