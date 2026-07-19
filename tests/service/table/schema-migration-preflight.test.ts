import { describe, expect, it } from 'vitest';
import { preflightSchemaMigrations_ACU } from '../../../src/service/table/schema-migration-preflight';

function sheet(overrides: Record<string, any> = {}): any {
  return {
    uid: 'inventory', name: '背包', orderNo: 0,
    content: [['row_id', 'name'], ['1', 'iron sword']],
    sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT);' },
    updateConfig: {}, exportConfig: {}, ...overrides,
  };
}

function state(value: any): any {
  return { mate: { type: 'acu', version: 1 }, sheet_inventory: value };
}

describe('schema migration preflight', () => {
  it('V1 安全子集返回仅内存 operation，且不修改输入', async () => {
    const baseline = state(sheet());
    const candidate = state(sheet({
      content: [['row_id', 'name', 'quality'], ['1', 'iron sword', null]],
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT, quality TEXT);' },
    }));
    const before = structuredClone({ baseline, candidate });

    const result = await preflightSchemaMigrations_ACU({ baselineData: baseline, candidateData: candidate });

    expect(result.blockers).toEqual([]);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ kind: 'sheet_schema_migrate', contractVersion: 1 });
    expect({ baseline, candidate }).toEqual(before);
  });

  it('P2 physical rename 没有显式 intent 时 fail closed', async () => {
    const baseline = state(sheet());
    const candidate = state(sheet({
      content: [['row_id', 'item_name'], ['1', 'iron sword']],
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);' },
    }));

    const result = await preflightSchemaMigrations_ACU({ baselineData: baseline, candidateData: candidate });

    expect(result.operations).toEqual([]);
    expect(result.blockers.join('\n')).toContain('mapping 契约');
  });

  it('P2 physical rename 携带完整显式 intent 时返回 V2 operation', async () => {
    const baseline = state(sheet());
    const candidate = state(sheet({
      content: [['row_id', 'item_name'], ['1', 'iron sword']],
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT);' },
    }));

    const result = await preflightSchemaMigrations_ACU({
      baselineData: baseline,
      candidateData: candidate,
      intents: {
        sheet_inventory: {
          physicalColumnMappings: [{ fromPhysicalName: 'name', toPhysicalName: 'item_name' }],
          fills: {},
          conversions: [],
          migrationPolicy: { destructiveChangeConfirmed: false, lossyConversionConfirmed: false },
        },
      },
    });

    expect(result.blockers).toEqual([]);
    expect(result.operations).toMatchObject([{ kind: 'sheet_schema_migrate', contractVersion: 2 }]);
  });

  it('完整 candidate hydrate 失败时不返回 operation', async () => {
    const baseline = state(sheet());
    const candidate = state(sheet({
      content: [['row_id', 'name', 'quality'], ['1', 'iron sword', null]],
      sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, name TEXT, quality TEXT);' },
    }));
    candidate.sheet_other = sheet({
      uid: 'other', content: [['row_id', 'value'], ['1', null]],
      sourceData: { ddl: 'CREATE TABLE other_table (row_id INTEGER PRIMARY KEY, value TEXT NOT NULL);' },
    });

    const result = await preflightSchemaMigrations_ACU({ baselineData: baseline, candidateData: candidate });

    expect(result.operations).toEqual([]);
    expect(result.blockers.join('\n')).toContain('完整 candidate SQLite hydrate 失败');
  });
});
