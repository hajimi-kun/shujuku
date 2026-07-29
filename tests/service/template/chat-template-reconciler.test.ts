import { describe, expect, it } from 'vitest';
import { reconcileChatTemplate_ACU } from '../../../src/service/template/chat-template-reconciler';
import { buildDefaultTableTemplateObject_ACU, buildOriginalDefaultTableTemplateObject_ACU } from '../../../src/shared/table-defaults/index.js';
import { getSheetColumnProjection_ACU } from '../../../src/shared/ddl-utils';

function sheet(key: string, name: string, headers: string[], ddlColumns: string, rows: Array<Array<string | null>> = [['1', '铁剑']]): any {
  return {
    uid: key, name, orderNo: 0, content: [headers, ...rows],
    sourceData: { ddl: `CREATE TABLE inventory (\n  ${ddlColumns.replace(/ -- ([^,\n]+), /g, ', -- $1\n  ')}\n);` }, updateConfig: {}, exportConfig: {},
  };
}

function state(sheets: Record<string, any>): any {
  return { mate: { type: 'chatSheets', version: 1 }, ...sheets };
}

describe('reconcileChatTemplate_ACU', () => {
  it('按 canonical 表名复用旧 key，按 canonical 列名继承数据并为空新增列生成 V2 contract', async () => {
    const baseline = state({
      sheet_legacy: sheet('sheet_legacy', ' 背包 ', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY,\n  item_name TEXT -- 名称'),
    });
    const template = state({
      sheet_imported: sheet('sheet_imported', '背包', ['row_id', '名称', '品质'], 'row_id INTEGER PRIMARY KEY,\n  item_name TEXT, -- 名称\n  quality TEXT -- 品质'),
    });
    const original = structuredClone({ baseline, template });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_legacy.uid).toBe('sheet_legacy');
    expect(plan.candidateData.sheet_legacy.content).toEqual([['row_id', '名称', '品质'], ['1', '铁剑', null]]);
    expect(plan.candidateData.sheet_imported).toBeUndefined();
    expect(plan.sheetChanges).toEqual([expect.objectContaining({
      kind: 'rebase', sheetKey: 'sheet_legacy',
      sheetData: expect.objectContaining({ content: [['row_id', '名称', '品质'], ['1', '铁剑', null]] }),
    })]);
    expect({ baseline, template }).toEqual(original);
  });

  it('新增表 introduction 保留模板自带数据；旧表默认走 hide，仅硬删除才需确认', async () => {
    const baseline = state({ sheet_old: sheet('sheet_old', '旧表', ['row_id', '值'], 'row_id INTEGER PRIMARY KEY, value TEXT -- 值') });
    const template = state({ sheet_new: sheet('sheet_new', '新表', ['row_id', 'value'], 'row_id INTEGER PRIMARY KEY, value TEXT', [['9', '示例']]) });

    // 默认行为（语义1）：切换默认走 hide，不再要求删除确认。
    const defaultPlan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });
    expect(defaultPlan.blockers).toEqual([]);
    expect(defaultPlan.hiddenSheetKeys).toEqual(['sheet_old']);
    expect(defaultPlan.deletedSheetKeys).toEqual([]);
    expect(defaultPlan.candidateData.sheet_new.content).toEqual([['row_id', 'value'], ['9', '示例']]);
    expect(defaultPlan.sheetChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'introduction', sheetKey: 'sheet_new' }),
      expect.objectContaining({ kind: 'hide', sheetKey: 'sheet_old' }),
    ]));

    // 显式硬删除仍需 destructiveChangeConfirmed 显式确认。
    const rejected = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false, hardDeleteMissingSheets: true });
    expect(rejected.blockers.join('\n')).toContain('删除表');
    expect(rejected.sheetChanges).toEqual([]);

    const accepted = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true, hardDeleteMissingSheets: true });
    expect(accepted.blockers).toEqual([]);
    expect(accepted.deletedSheetKeys).toEqual(['sheet_old']);
    expect(accepted.candidateData.sheet_new.content).toEqual([['row_id', 'value'], ['9', '示例']]);
    expect(accepted.sheetChanges).toEqual([expect.objectContaining({ kind: 'introduction', sheetKey: 'sheet_new' })]);
  });

  it('旧表无数据且新模板同名表有数据时，采用模板数据', async () => {
    // 与“是否首楼、是否已初始化”无关，只看该表当前有没有数据。
    const baseline = state({
      sheet_rules: sheet('sheet_rules', '系统规则表', ['row_id', '规则名称'],
        'row_id INTEGER PRIMARY KEY,\n  rule_name TEXT -- 规则名称', []),
    });
    const template = state({
      sheet_rules2: sheet('sheet_rules2', '系统规则表', ['row_id', '规则名称'],
        'row_id INTEGER PRIMARY KEY,\n  rule_name TEXT -- 规则名称', [
          [null as any, '属性说明'],
          [null as any, '升级公式'],
        ]),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_rules.content).toEqual([
      ['row_id', '规则名称'],
      ['1', '属性说明'],
      ['2', '升级公式'],
    ]);
  });

  it('旧表已有数据时忽略模板自带数据，以旧表为主', async () => {
    const baseline = state({
      sheet_rules: sheet('sheet_rules', '系统规则表', ['row_id', '规则名称'],
        'row_id INTEGER PRIMARY KEY,\n  rule_name TEXT -- 规则名称', [['1', '旧数据']]),
    });
    const template = state({
      sheet_rules2: sheet('sheet_rules2', '系统规则表', ['row_id', '规则名称'],
        'row_id INTEGER PRIMARY KEY,\n  rule_name TEXT -- 规则名称', [[null as any, '模板数据']]),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_rules.content).toEqual([['row_id', '规则名称'], ['1', '旧数据']]);
  });

  it('两边都无数据时保持表头空表', async () => {
    const baseline = state({
      sheet_rules: sheet('sheet_rules', '系统规则表', ['row_id', '规则名称'],
        'row_id INTEGER PRIMARY KEY,\n  rule_name TEXT -- 规则名称', []),
    });
    const template = state({
      sheet_rules2: sheet('sheet_rules2', '系统规则表', ['row_id', '规则名称'],
        'row_id INTEGER PRIMARY KEY,\n  rule_name TEXT -- 规则名称', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_rules.content).toEqual([['row_id', '规则名称']]);
  });


  it('模板声明 columnAliases 时，列改名仍能继承数据', async () => {
    const baseline = state({
      sheet_g: sheet('sheet_g', '表', ['row_id', '上轮场景时间'],
        'row_id INTEGER PRIMARY KEY,\n  last_round_time TEXT -- 上轮场景时间', [['1', 'T0']]),
    });
    // 新模板把显示名改成「前一轮时间」，并声明它的旧名。
    const template = state({
      sheet_g2: sheet('sheet_g2', '表', ['row_id', '前一轮时间'],
        'row_id INTEGER PRIMARY KEY,\n  last_round_time TEXT -- 前一轮时间'),
    });
    template.sheet_g2.sourceData.columnAliases = { last_round_time: ['上轮场景时间'] };

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    // 数据跟着新显示名继承过来，没有变成空值。
    expect(plan.candidateData.sheet_g.content).toEqual([['row_id', '前一轮时间'], ['1', 'T0']]);
    // 旧列没有被降级成隐藏列。
    expect(plan.candidateData.sheet_g.sourceData.hiddenPhysicalColumns || []).toEqual([]);
    expect(plan.audit[0].inheritedColumns).toContain('前一轮时间');
  });

  it('改名后自动累积别名，再改一次仍能顺别名链继承', async () => {
    const baseline = state({
      sheet_g: sheet('sheet_g', '表', ['row_id', '上轮场景时间'],
        'row_id INTEGER PRIMARY KEY,\n  last_round_time TEXT -- 上轮场景时间', [['1', 'T0']]),
    });
    const template1 = state({
      sheet_g2: sheet('sheet_g2', '表', ['row_id', '前一轮时间'],
        'row_id INTEGER PRIMARY KEY,\n  last_round_time TEXT -- 前一轮时间'),
    });
    template1.sheet_g2.sourceData.columnAliases = { last_round_time: ['上轮场景时间'] };

    const first = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template1, destructiveChangeConfirmed: false });
    expect(first.blockers).toEqual([]);
    // 数据已按声明继承，且旧显示名被累积进该物理列的别名。
    expect(first.candidateData.sheet_g.content).toEqual([['row_id', '前一轮时间'], ['1', 'T0']]);
    expect(first.candidateData.sheet_g.sourceData.columnAliases.last_round_time).toContain('上轮场景时间');

    // 第二次改名：无需再次声明，靠累积的别名链认回。
    const template2 = state({
      sheet_g3: sheet('sheet_g3', '表', ['row_id', '上轮场景时间'],
        'row_id INTEGER PRIMARY KEY,\n  last_round_time TEXT -- 上轮场景时间'),
    });
    const second = await reconcileChatTemplate_ACU({
      baselineData: first.candidateData,
      templateData: template2,
      destructiveChangeConfirmed: false,
    });
    expect(second.blockers).toEqual([]);
    expect(second.candidateData.sheet_g.content).toEqual([['row_id', '上轮场景时间'], ['1', 'T0']]);
  });

  it('没有别名声明时不猜：列改名仍按新增列处理，旧列隐藏保留', async () => {
    const baseline = state({
      sheet_g: sheet('sheet_g', '表', ['row_id', '上轮场景时间'],
        'row_id INTEGER PRIMARY KEY,\n  last_round_time TEXT -- 上轮场景时间', [['1', 'T0']]),
    });
    const template = state({
      sheet_g2: sheet('sheet_g2', '表', ['row_id', '无关新列'],
        'row_id INTEGER PRIMARY KEY,\n  unrelated TEXT -- 无关新列'),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    // 新列为空，旧列作为隐藏列保留原值——不把两列混为一谈。
    expect(plan.candidateData.sheet_g.content).toEqual([['row_id', '无关新列', '上轮场景时间'], ['1', null, 'T0']]);
    expect(plan.candidateData.sheet_g.sourceData.hiddenPhysicalColumns).toEqual(['last_round_time']);
  });


  it('canonical 相同但模板物理列名不同时，沁用既有物理列名，不随模板改名', async () => {
    // 列身份由 canonical 显示名判定；物理列名一旦确立就不能变。
    // 否则历史 log 里按旧物理名书写的 SQL 回放时会撞 "has no column named ..."。
    const baseline = state({
      sheet_g: sheet('sheet_g', '全局数据表', ['row_id', '上轮场景时间', '当前时间'],
        'row_id INTEGER PRIMARY KEY,\n  last_round_time TEXT, -- 上轮场景时间\n  current_time TEXT -- 当前时间', [['1', 'T0', 'T1']]),
    });
    // 模板用同样的显示名，但物理列名不同。
    const template = state({
      sheet_g2: sheet('sheet_g2', '全局数据表', ['row_id', '上轮场景时间', '当前时间'],
        'row_id INTEGER PRIMARY KEY,\n  prev_scene_time TEXT, -- 上轮场景时间\n  cur_time TEXT -- 当前时间'),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    const ddl = plan.candidateData.sheet_g.sourceData.ddl as string;
    // 沁用旧物理名，不采用模板的新名。
    expect(ddl).toContain('last_round_time');
    expect(ddl).toContain('current_time');
    expect(ddl).not.toContain('prev_scene_time');
    expect(ddl).not.toContain('cur_time');
    // 数据与显示名不变。
    expect(plan.candidateData.sheet_g.content).toEqual([['row_id', '上轮场景时间', '当前时间'], ['1', 'T0', 'T1']]);
  });

  it('沁用旧物理列名时保留模板列的类型与约束', async () => {
    const baseline = state({
      sheet_g: sheet('sheet_g', '表', ['row_id', '数量'],
        'row_id INTEGER PRIMARY KEY,\n  old_qty TEXT -- 数量', [['1', '3']]),
    });
    const template = state({
      sheet_g2: sheet('sheet_g2', '表', ['row_id', '数量'],
        'row_id INTEGER PRIMARY KEY,\n  new_qty INTEGER NOT NULL DEFAULT 0 -- 数量'),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    const ddl = plan.candidateData.sheet_g.sourceData.ddl as string;
    // 列名沁用旧名，但类型/约束/DEFAULT 采用模板的。
    expect(ddl).toMatch(/old_qty INTEGER NOT NULL DEFAULT 0/);
    expect(ddl).not.toContain('new_qty');
  });


  it('模板缺失旧列时保留并隐藏；新增 NOT NULL 无 literal default 时仍 fail closed', async () => {
    const baseline = state({
      sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', '名称', '备注'], 'row_id INTEGER PRIMARY KEY,\n  item_name TEXT, -- 名称\n  note TEXT -- 备注', [['1', '铁剑', '旧备注']]),
    });
    const dropTemplate = state({
      sheet_new: sheet('sheet_new', '背包', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY,\n  item_name TEXT -- 名称'),
    });
    const unconfirmed = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: dropTemplate, destructiveChangeConfirmed: false });
    expect(unconfirmed.blockers).toEqual([]);
    expect(unconfirmed.candidateData.sheet_legacy.content).toEqual([['row_id', '名称', '备注'], ['1', '铁剑', '旧备注']]);
    expect(unconfirmed.candidateData.sheet_legacy.sourceData.hiddenPhysicalColumns).toEqual(['note']);
    expect(unconfirmed.audit[0]).toMatchObject({ deletedColumns: [], hiddenColumns: ['备注'], destructiveChangeConfirmed: false });

    const restored = await reconcileChatTemplate_ACU({
      baselineData: unconfirmed.candidateData,
      templateData: baseline,
      destructiveChangeConfirmed: false,
    });
    expect(restored.blockers).toEqual([]);
    expect(restored.candidateData.sheet_legacy.content).toEqual([['row_id', '名称', '备注'], ['1', '铁剑', '旧备注']]);
    expect(restored.candidateData.sheet_legacy.sourceData.hiddenPhysicalColumns).toEqual([]);
    expect(getSheetColumnProjection_ACU(restored.candidateData.sheet_legacy).visibleColumns.map(column => column.header)).toEqual(['row_id', '名称', '备注']);

    const baselineWithoutDrop = state({
      sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY,\n  item_name TEXT -- 名称'),
    });
    const requiredTemplate = state({
      sheet_new: sheet('sheet_new', '背包', ['row_id', '名称', '品质'], 'row_id INTEGER PRIMARY KEY, item_name TEXT -- 名称, quality TEXT NOT NULL -- 品质'),
    });
    const invalidDefault = await reconcileChatTemplate_ACU({ baselineData: baselineWithoutDrop, templateData: requiredTemplate, destructiveChangeConfirmed: false });
    // rebase 语义下：新增 NOT NULL 无 DEFAULT 列以空串回填，TEXT NOT NULL 接受 '' → 协调成功。
    expect(invalidDefault.blockers).toEqual([]);
    expect(invalidDefault.candidateData.sheet_legacy.content).toEqual([['row_id', '名称', '品质'], ['1', '铁剑', '']]);
  });

  it('拒绝新表占用当前聊天已有不同表的 key', async () => {
    const baseline = state({ sheet_taken: sheet('sheet_taken', '旧表', ['row_id', '值'], 'row_id INTEGER PRIMARY KEY, value TEXT -- 值') });
    const template = state({ sheet_taken: sheet('sheet_taken', '新表', ['row_id', '值'], 'row_id INTEGER PRIMARY KEY, value TEXT -- 值') });
    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });
    expect(plan.blockers.join('\n')).toContain('已被当前聊天占用');
  });

  it('同一稳定 key 的表名仅增减末尾“表”时按既有 Sheet 协调，而非误判 key 被占用', async () => {
    const baseline = state({
      sheet_DpKcVGqg: sheet('sheet_DpKcVGqg', '主角信息', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', [['1', '助手']]),
    });
    const template = state({
      sheet_DpKcVGqg: sheet('sheet_DpKcVGqg', '主角信息表', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_DpKcVGqg).toMatchObject({ uid: 'sheet_DpKcVGqg', name: '主角信息表' });
    expect(plan.candidateData.sheet_DpKcVGqg.content).toEqual([['row_id', '姓名'], ['1', '助手']]);
    expect(plan.deletedSheetKeys).toEqual([]);
  });

  it('任意用户表名仅增减末尾“表”时仍视为不同表，不扩大历史兼容范围', async () => {
    const baseline = state({
      sheet_stable: sheet('sheet_stable', '订单', ['row_id', '编号'], 'row_id INTEGER PRIMARY KEY,\n  order_no TEXT -- 编号', [['1', 'A-1']]),
    });
    const template = state({
      sheet_stable: sheet('sheet_stable', '订单表', ['row_id', '编号'], 'row_id INTEGER PRIMARY KEY,\n  order_no TEXT -- 编号', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers.join('\n')).toContain('已被当前聊天占用');
    expect(plan.sheetChanges).toEqual([]);
    expect(plan.deletedSheetKeys).toEqual([]);
    expect(plan.candidateData.sheet_stable.content[1][1]).toBe('A-1');
  });

  it('稳定 key 与精确表名分别命中不同历史表时 fail closed，禁止静默串表', async () => {
    const baseline = state({
      sheet_stable: sheet('sheet_stable', '主角信息', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', [['1', '稳定 key 数据']]),
      sheet_other: sheet('sheet_other', '主角信息表', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', [['2', '同名表数据']]),
    });
    const template = state({
      sheet_stable: sheet('sheet_stable', '主角信息表', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers.join('\n')).toContain('无法唯一协调');
    expect(plan.sheetChanges).toEqual([]);
    expect(plan.deletedSheetKeys).toEqual([]);
    expect(plan.candidateData.sheet_stable.content[1][1]).toBe('稳定 key 数据');
    expect(plan.candidateData.sheet_other.content[1][1]).toBe('同名表数据');
  });

  it.each([
    ['精确名称项在前', ['sheet_other', 'sheet_DpKcVGqg']],
    ['历史别名项在前', ['sheet_DpKcVGqg', 'sheet_other']],
  ])('多个模板表争用同一历史 Sheet 时 fail closed：%s', async (_label, order) => {
    const baseline = state({
      sheet_DpKcVGqg: sheet('sheet_DpKcVGqg', '主角信息', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', [['1', '历史数据']]),
    });
    const entries: Record<string, any> = {
      sheet_other: sheet('sheet_other', '主角信息', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', []),
      sheet_DpKcVGqg: sheet('sheet_DpKcVGqg', '主角信息表', ['row_id', '姓名'], 'row_id INTEGER PRIMARY KEY,\n  name TEXT -- 姓名', []),
    };
    const template = state(Object.fromEntries(order.map(key => [key, entries[key]])));

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers.join('\n')).toContain('多个表同时匹配');
    expect(plan.sheetChanges).toEqual([]);
    expect(plan.deletedSheetKeys).toEqual([]);
    expect(plan.candidateData.sheet_DpKcVGqg.content).toEqual([
      ['row_id', '姓名'],
      ['1', '历史数据'],
    ]);
  });

  it('同一稳定 key 下 physical column 未变时允许表头改名并继承历史数据', async () => {
    const baseline = state({
      sheet_stable: sheet('sheet_stable', '全局数据表', ['row_id', '主角当前所在地点'], 'row_id INTEGER PRIMARY KEY,\n  current_location TEXT -- 主角当前所在地点', [['1', '御苑']]),
    });
    const template = state({
      sheet_stable: sheet('sheet_stable', '全局数据表', ['row_id', '当前详细地点'], 'row_id INTEGER PRIMARY KEY,\n  current_location TEXT -- 当前详细地点', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_stable.content).toEqual([['row_id', '当前详细地点'], ['1', '御苑']]);
    expect(plan.audit[0]).toMatchObject({ inheritedColumns: ['当前详细地点'], addedColumns: [], deletedColumns: [] });
  });

  it('不同 key 的模板仍禁止用同名 physical column 将删除列重解释为新字段', async () => {
    const baseline = state({
      sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', '备注'], 'row_id INTEGER PRIMARY KEY, note TEXT -- 备注', [['1', '旧备注']]),
    });
    const template = state({
      sheet_imported: sheet('sheet_imported', '背包', ['row_id', '品质'], 'row_id INTEGER PRIMARY KEY, note TEXT -- 品质', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers.join('\n')).toContain('无法安全重解释历史数据');
    expect(plan.sheetChanges).toEqual([]);
  });

  it('不同 key 的 physical column 仅大小写不同时仍按 SQLite 身份冲突 fail closed', async () => {
    const baseline = state({
      sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', '备注'], 'row_id INTEGER PRIMARY KEY,\n  Note TEXT -- 备注', [['1', '旧备注']]),
    });
    const template = state({
      sheet_imported: sheet('sheet_imported', '背包', ['row_id', '品质'], 'row_id INTEGER PRIMARY KEY,\n  note TEXT -- 品质', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers.join('\n')).toContain('无法安全重解释历史数据');
    expect(plan.sheetChanges).toEqual([]);
    expect(plan.deletedSheetKeys).toEqual([]);
  });

  it('旧默认模板切换到当前默认模板时协调稳定 key、历史表名与同 physical 列的显示名变更', async () => {
    const original = buildOriginalDefaultTableTemplateObject_ACU() as any;
    const current = buildDefaultTableTemplateObject_ACU() as any;
    const globalKey = 'sheet_dCudvUnH';
    const protagonistKey = 'sheet_DpKcVGqg';
    const skillsKey = 'sheet_lEARaBa8';
    const baseline = state({
      [globalKey]: structuredClone(original[globalKey]),
      [protagonistKey]: structuredClone(original[protagonistKey]),
      [skillsKey]: structuredClone(original[skillsKey]),
    });
    baseline[globalKey].content.push(['1', '御苑', '2026-02-03 09:00', null, '0分']);
    baseline[protagonistKey].name = '主角信息';
    baseline[protagonistKey].content.push(['1', '助手', '女/18', '红发', '研究员', '旧经历', '理性']);
    baseline[skillsKey].content[0][3] = '技能等级';
    baseline[skillsKey].sourceData.ddl = baseline[skillsKey].sourceData.ddl.replace('-- 等级/阶段', '-- 技能等级');
    baseline[skillsKey].content.push(['1', '分析', '主动', 'Lv.1', '定位问题']);
    const template = state({
      [globalKey]: structuredClone(current[globalKey]),
      [protagonistKey]: structuredClone(current[protagonistKey]),
      [skillsKey]: structuredClone(current[skillsKey]),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData[globalKey].content).toEqual([
      current[globalKey].content[0],
      ['1', null, '御苑', null, null, null, '0分', '2026-02-03 09:00'],
    ]);
    expect(plan.candidateData[skillsKey].content).toEqual([
      current[skillsKey].content[0],
      ['1', '分析', '主动', 'Lv.1', '定位问题'],
    ]);
    expect(plan.candidateData[protagonistKey].name).toBe('主角信息表');
    expect(getSheetColumnProjection_ACU(plan.candidateData[protagonistKey]).visibleColumns.map(column => column.header)).toEqual(current[protagonistKey].content[0]);
    expect(plan.candidateData[protagonistKey].content[1]).toEqual([
      '1', null, null, null, '红发', null, null, null, null,
      '助手', '女/18', '研究员', '旧经历', '理性',
    ]);
    expect(plan.candidateData[protagonistKey].sourceData.hiddenPhysicalColumns).toHaveLength(5);
    expect(plan.deletedSheetKeys).toEqual([]);
    expect(plan.audit.find(item => item.sheetKey === globalKey)).toMatchObject({
      inheritedColumns: expect.arrayContaining(['当前详细地点', '上轮场景时间', '经过的时间', '当前时间']),
      addedColumns: expect.arrayContaining(['全局状态', '当前次要地区', '当前主要地区']),
      deletedColumns: [],
    });
    expect(plan.audit.find(item => item.sheetKey === skillsKey)).toMatchObject({
      inheritedColumns: expect.arrayContaining(['等级/阶段']),
      addedColumns: [],
      deletedColumns: [],
    });
    expect(plan.audit.find(item => item.sheetKey === protagonistKey)).toMatchObject({
      inheritedColumns: ['外貌特征'],
      addedColumns: expect.arrayContaining(['姓名', '性别', '年龄', '身份', '近况', '所在地点', '随身财物']),
      deletedColumns: [],
      hiddenColumns: expect.arrayContaining(['人物名称', '性别/年龄', '职业/身份', '过往经历', '性格特点']),
    });
  });

  it('以 V2 replay 作为 candidate 事实来源，BOOLEAN DEFAULT TRUE 使用 SQLite 单元格表示', async () => {
    const baseline = state({
      sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', 'item_name'], 'row_id INTEGER PRIMARY KEY, item_name TEXT', [['1', '铁剑']]),
    });
    const template = state({
      sheet_imported: sheet('sheet_imported', '背包', ['row_id', 'item_name', 'equipped'], 'row_id INTEGER PRIMARY KEY, item_name TEXT, equipped BOOLEAN NOT NULL DEFAULT TRUE'),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_legacy.content).toEqual([['row_id', 'item_name', 'equipped'], ['1', '铁剑', '1']]);
    expect((plan.sheetChanges[0] as any).sheetData.content).toEqual(plan.candidateData.sheet_legacy.content);
    expect(plan.audit[0]).toMatchObject({ affectedRowCount: 1, fills: [{ physicalName: 'equipped', kind: 'literal_default', literal: '1' }] });
  });

  it.each([
    { label: '非数组行', rows: [['1', '铁剑'], 'bad-row' as any], expected: '不是数组' },
    { label: '短行', rows: [['1']], expected: '宽度' },
    { label: '超宽行', rows: [['1', '铁剑', '多余']], expected: '宽度' },
    { label: '空 row_id', rows: [['', '铁剑']], expected: 'row_id 为空' },
    { label: '重复 row_id', rows: [['1', '铁剑'], ['1', '木剑']], expected: 'row_id 重复' },
  ])('历史基线存在$label时 fail closed', async ({ rows, expected }) => {
    const baseline = state({ sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY, item_name TEXT -- 名称', rows as any) });
    const template = state({ sheet_imported: sheet('sheet_imported', '背包', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY, item_name TEXT -- 名称') });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers.join('\n')).toContain(expected);
    expect(plan.sheetChanges).toEqual([]);
  });

  it('模板缺失列与新增列并存时保留旧值、隐藏旧列并以 null 填充新列', async () => {
    const baseline = state({ sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', 'item_name', 'note'], 'row_id INTEGER PRIMARY KEY, item_name TEXT, note TEXT', [['1', '铁剑', '旧备注']]) });
    const template = state({ sheet_imported: sheet('sheet_imported', '背包', ['row_id', 'item_name', 'quality'], 'row_id INTEGER PRIMARY KEY, item_name TEXT, quality TEXT', []) });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_legacy.content).toEqual([['row_id', 'item_name', 'quality', 'note'], ['1', '铁剑', null, '旧备注']]);
    expect(plan.candidateData.sheet_legacy.sourceData.hiddenPhysicalColumns).toEqual(['note']);
    expect(plan.sheetChanges[0]).toMatchObject({
      kind: 'rebase',
      sheetKey: 'sheet_legacy',
      sheetData: { content: [['row_id', 'item_name', 'quality', 'note'], ['1', '铁剑', null, '旧备注']] },
    });
  });

  it('模板数据行 row_id 为 null（真实模板形态）时仍能带数据引入', async () => {
    // 真实模板里作者不写 row_id，首列是 null（不是空串）。
    const templateSheet = sheet('sheet_rules', '系统规则表', ['row_id', '规则类别', '规则名称'],
      'row_id INTEGER PRIMARY KEY,\n  rule_category TEXT, -- 规则类别\n  rule_name TEXT -- 规则名称', [
        [null as any, '六维属性', '属性说明'],
        [null as any, '经验', '升级公式'],
      ]);
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_rules: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_rules.content).toEqual([
      ['row_id', '规则类别', '规则名称'],
      ['1', '六维属性', '属性说明'],
      ['2', '经验', '升级公式'],
    ]);
    expect(plan.sheetChanges).toEqual([expect.objectContaining({ kind: 'introduction', sheetKey: 'sheet_rules' })]);
  });


  it('新增表 introduction 保留模板自带数据行，content 优先于 seedRows', async () => {
    // 模板自带数据 = 作者的格式意图，引入时即随 checkpoint 落盘；
    // seedRows 不再随 sheet 落盘（数据已在 content 中），避免二次注入撞 row_id。
    const templateSheet = sheet('sheet_new', '新表', ['row_id', 'value'], 'row_id INTEGER PRIMARY KEY, value TEXT', [['9', '示例']]);
    templateSheet.seedRows = [['9', 'seed']];
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_new: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_new).toMatchObject({ content: [['row_id', 'value'], ['9', '示例']] });
    expect(plan.candidateData.sheet_new.seedRows).toBeUndefined();
  });

  it('新增表无 content 数据行时，退回使用模板 seedRows 作为初始数据', async () => {
    const templateSheet = sheet('sheet_new', '新表', ['row_id', 'value'], 'row_id INTEGER PRIMARY KEY, value TEXT', []);
    templateSheet.seedRows = [['9', 'seed']];
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_new: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_new).toMatchObject({ content: [['row_id', 'value'], ['9', 'seed']] });
    expect(plan.candidateData.sheet_new.seedRows).toBeUndefined();
  });

  it('模板数据行缺少 row_id 时自动补齐稳定 row_id，不再拒绝引入', async () => {
    // 模板作者通常不手写 row_id：首列为空串/缺失。引入必须成功并补齐 1..n。
    const templateSheet = sheet('sheet_new', '系统规则表', ['row_id', 'rule_name', 'rule_desc'],
      'row_id INTEGER PRIMARY KEY, rule_name TEXT, rule_desc TEXT', [
        ['', '六维属性', '力量/敏捷/体质'],
        ['', '初始分配', '总值36点'],
      ]);
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_new: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_new.content).toEqual([
      ['row_id', 'rule_name', 'rule_desc'],
      ['1', '六维属性', '力量/敏捷/体质'],
      ['2', '初始分配', '总值36点'],
    ]);
  });

  it('模板已显式给出 row_id 时保留原值，并从当前最大身份后为缺失行分配', async () => {
    const templateSheet = sheet('sheet_new', '系统规则表', ['row_id', 'rule_name'],
      'row_id INTEGER PRIMARY KEY, rule_name TEXT', [
        ['5', '已有ID'],
        ['', '待分配'],
      ]);
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_new: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_new.content).toEqual([
      ['row_id', 'rule_name'],
      ['5', '已有ID'],
      ['6', '待分配'],
    ]);
  });

  it('模板数据行末尾省略单元格时按表头宽度补齐', async () => {
    const templateSheet = sheet('sheet_new', '系统规则表', ['row_id', 'a', 'b'],
      'row_id INTEGER PRIMARY KEY, a TEXT, b TEXT', [['', '只有A']]);
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_new: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_new.content).toEqual([['row_id', 'a', 'b'], ['1', '只有A', '']]);
  });


  it('新增表完全无数据时仍为 header-only 空壳', async () => {
    const templateSheet = sheet('sheet_new', '新表', ['row_id', 'value'], 'row_id INTEGER PRIMARY KEY, value TEXT', []);
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_new: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_new).toMatchObject({ content: [['row_id', 'value']] });
  });

  it('rebase 语义下 sourceData 字段删除可通过整表 checkpoint 表达', async () => {
    const baselineSheet = sheet('sheet_legacy', '背包', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY, item_name TEXT -- 名称');
    baselineSheet.sourceData.note = '旧说明';
    const templateSheet = sheet('sheet_imported', '背包', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY, item_name TEXT -- 名称');
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({ sheet_legacy: baselineSheet }), templateData: state({ sheet_imported: templateSheet }), destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    // 模板 sourceData 不含 note → checkpoint.data 的 sourceData 也不再包含该字段。
    expect(plan.candidateData.sheet_legacy.sourceData.note).toBeUndefined();
  });

  it('合法 physical rename 可与独立隐藏和新增列一起回放', async () => {
    const baseline = state({
      sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', '名称', '备注'], 'row_id INTEGER PRIMARY KEY,\n  item_name TEXT, -- 名称\n  note TEXT -- 备注', [['1', '铁剑', '旧备注']]),
    });
    const template = state({
      sheet_imported: sheet('sheet_imported', '背包', ['row_id', '名称', '品质'], 'row_id INTEGER PRIMARY KEY,\n  item_title TEXT, -- 名称\n  quality TEXT -- 品质', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_legacy.content).toEqual([['row_id', '名称', '品质', '备注'], ['1', '铁剑', null, '旧备注']]);
    expect(plan.candidateData.sheet_legacy.sourceData.hiddenPhysicalColumns).toEqual(['note']);
    expect(plan.sheetChanges[0]).toMatchObject({ kind: 'rebase', sheetKey: 'sheet_legacy' });
    expect(plan.audit[0].physicalColumnMappings).toEqual([{ fromPhysicalName: 'item_name', toPhysicalName: 'item_title' }]);
  });

  it('删列与新增列复用同一 physical 名称时仍 fail closed，不能把旧值改解释为新字段', async () => {
    const baseline = state({
      sheet_legacy: sheet('sheet_legacy', '背包', ['row_id', '备注'], 'row_id INTEGER PRIMARY KEY, note TEXT -- 备注', [['1', '旧备注']]),
    });
    const template = state({
      sheet_imported: sheet('sheet_imported', '背包', ['row_id', '品质'], 'row_id INTEGER PRIMARY KEY, note TEXT -- 品质', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: template, destructiveChangeConfirmed: true });

    expect(plan.blockers.join('\n')).toContain('无法安全重解释历史数据');
    expect(plan.sheetChanges).toEqual([]);
    expect(plan.deletedSheetKeys).toEqual([]);
  });

  it('匹配表的最终 replay candidate 不携带 baseline seedRows', async () => {
    const baselineSheet = sheet('sheet_legacy', '背包', ['row_id', 'item_name'], 'row_id INTEGER PRIMARY KEY, item_name TEXT', [['1', '铁剑']]);
    baselineSheet.seedRows = [['seed', '种子']];
    const template = state({
      sheet_imported: sheet('sheet_imported', '背包', ['row_id', 'item_name', 'quality'], 'row_id INTEGER PRIMARY KEY, item_name TEXT, quality TEXT', []),
    });

    const plan = await reconcileChatTemplate_ACU({ baselineData: state({ sheet_legacy: baselineSheet }), templateData: template, destructiveChangeConfirmed: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_legacy.seedRows).toBeUndefined();
    expect((plan.sheetChanges[0] as any).sheetData.seedRows).toBeUndefined();
  });

  it('blocker 结果返回已剥离运行时字段的 baseline，而非半构造候选', async () => {
    const baselineSheet = sheet('sheet_legacy', '背包', ['row_id', '名称'], 'row_id INTEGER PRIMARY KEY, item_name TEXT -- 名称', [['1'] as any]);
    baselineSheet.seedRows = [['seed', '种子']];
    const baseline = state({ sheet_legacy: baselineSheet });
    const plan = await reconcileChatTemplate_ACU({ baselineData: baseline, templateData: state({}), destructiveChangeConfirmed: false });

    expect(plan.blockers.join('\n')).toContain('宽度');
    expect(plan.candidateData.sheet_legacy.content).toEqual(baselineSheet.content);
    expect(plan.candidateData.sheet_legacy.seedRows).toBeUndefined();
  });

  it('原生模式导入无 DDL 模板时不执行 SQLite 门禁', async () => {
    const nativeTemplate = sheet('sheet_new', '全局数据表', ['row_id', '地点'], 'row_id INTEGER PRIMARY KEY, location TEXT', []);
    nativeTemplate.sourceData = {};

    const plan = await reconcileChatTemplate_ACU({
      baselineData: state({}),
      templateData: state({ sheet_new: nativeTemplate }),
      destructiveChangeConfirmed: false,
      storageMode: 'native',
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_new.content).toEqual([['row_id', '地点']]);
    expect(plan.candidateData.sheet_new.sourceData).toEqual({});
    expect(plan.sheetChanges).toEqual([expect.objectContaining({ kind: 'introduction', sheetKey: 'sheet_new' })]);
  });

  it('原生模式匹配旧表时只按表头继承，不解析错误 DDL', async () => {
    const baselineSheet = sheet('sheet_live', '全局数据表', ['row_id', '地点', '旧列'], 'row_id INTEGER PRIMARY KEY, location TEXT, old_value TEXT', [['1', '御苑', '历史']]);
    baselineSheet.sourceData.ddl = 'not sql';
    const templateSheet = sheet('sheet_imported', '全局数据表', ['row_id', '地点', '新列'], 'row_id INTEGER PRIMARY KEY, location TEXT, new_value TEXT', []);
    templateSheet.sourceData.ddl = '';

    const plan = await reconcileChatTemplate_ACU({
      baselineData: state({ sheet_live: baselineSheet }),
      templateData: state({ sheet_imported: templateSheet }),
      destructiveChangeConfirmed: false,
      storageMode: 'native',
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.candidateData.sheet_live.content).toEqual([['row_id', '地点', '新列'], ['1', '御苑', null]]);
    expect(plan.audit[0]).toMatchObject({ inheritedColumns: ['地点'], addedColumns: ['新列'], deletedColumns: ['旧列'] });
  });


  it('仅 introduction 的 DDL 与表头不一致时，完整 replay candidate hydrate 必须阻断', async () => {
    const invalidTemplate = sheet('sheet_new', '新表', ['row_id', '显示名称'], 'row_id INTEGER PRIMARY KEY, physical_name TEXT', []);
    const plan = await reconcileChatTemplate_ACU({ baselineData: state({}), templateData: state({ sheet_new: invalidTemplate }), destructiveChangeConfirmed: false });

    expect(plan.blockers.join('\n')).toContain('完整 replay candidate SQLite hydrate 失败');
    expect(plan.sheetChanges).toEqual([]);
    expect(plan.candidateData.sheet_new).toBeUndefined();
    expect(plan.audit.every(item => item.operations.length === 0)).toBe(true);
  });

  it('audit 与实际 change set 对账，包含 schema、metadata、introduction 和 hide/delete 摘要', async () => {
    const baselineSheet = sheet('sheet_old', '旧表', ['row_id', 'value'], 'row_id INTEGER PRIMARY KEY, value TEXT', []);
    baselineSheet.sourceData.ddl = 'CREATE TABLE old_table (row_id INTEGER PRIMARY KEY, value TEXT);';
    const matchedBaseline = sheet('sheet_legacy', '背包', ['row_id', 'item_name'], 'row_id INTEGER PRIMARY KEY, item_name TEXT', [['1', '铁剑']]);
    matchedBaseline.orderNo = 3;
    const templateMatched = sheet('sheet_imported', '背包', ['row_id', 'item_name', 'quality'], 'row_id INTEGER PRIMARY KEY, item_name TEXT, quality TEXT', []);
    templateMatched.orderNo = 4;
    const templateNew = sheet('sheet_new', '新表', ['row_id', 'value'], 'row_id INTEGER PRIMARY KEY, value TEXT', []);
    templateNew.sourceData.ddl = 'CREATE TABLE new_table (row_id INTEGER PRIMARY KEY, value TEXT);';

    // 默认路径（语义1）：缺失表 sheet_old 走 hide，不再产出 delete。
    const defaultPlan = await reconcileChatTemplate_ACU({
      baselineData: state({ sheet_old: baselineSheet, sheet_legacy: matchedBaseline }),
      templateData: state({ sheet_imported: templateMatched, sheet_new: templateNew }),
      destructiveChangeConfirmed: false,
    });

    expect(defaultPlan.blockers).toEqual([]);
    expect(defaultPlan.candidateData.sheet_old).toBeUndefined();
    const matchedAudit = defaultPlan.audit.find(item => item.sheetKey === 'sheet_legacy');
    expect(matchedAudit).toMatchObject({
      baselineSheetKey: 'sheet_legacy', templateSheetKey: 'sheet_imported', canonicalName: '背包', metadataChangedFields: ['orderNo'],
    });
    expect(matchedAudit?.operations).toEqual([{ kind: 'rebase' }]);
    expect(defaultPlan.audit.find(item => item.sheetKey === 'sheet_new')?.operations).toEqual([{ kind: 'introduction' }]);
    expect(defaultPlan.audit.find(item => item.sheetKey === 'sheet_old')?.operations).toEqual([{ kind: 'hide' }]);

    // 显式硬删除路径：hardDeleteMissingSheets=true + destructiveChangeConfirmed=true，产出 delete。
    const hardDeletePlan = await reconcileChatTemplate_ACU({
      baselineData: state({ sheet_old: baselineSheet, sheet_legacy: matchedBaseline }),
      templateData: state({ sheet_imported: templateMatched, sheet_new: templateNew }),
      destructiveChangeConfirmed: true,
      hardDeleteMissingSheets: true,
    });
    expect(hardDeletePlan.audit.find(item => item.sheetKey === 'sheet_old')?.operations).toEqual([{ kind: 'delete' }]);
  });


});
