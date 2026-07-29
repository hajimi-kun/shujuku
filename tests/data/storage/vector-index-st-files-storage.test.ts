import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildVectorIndexSingleSnapshotV2FilePath_ACU,
  buildVectorIndexStableDirectory_ACU,
  registerVectorIndexFiles_ACU,
} from '../../../src/data/storage/vector-index-st-files-storage';

afterEach(() => vi.unstubAllGlobals());

const base = {
  chatKey: 'chat-main',
  isolationKey: 'profile-a',
  sourceTableKey: 'sheet_summary',
  indexId: 'snap_one',
  writeGeneration: 'write_one',
};

describe('向量索引 V2 物理路径', () => {
  it('同一 scope 和 generation 的路径稳定，角色显示名不参与权威寻址', () => {
    expect(buildVectorIndexSingleSnapshotV2FilePath_ACU(base)).toBe(
      buildVectorIndexSingleSnapshotV2FilePath_ACU({ ...base, chatName: 'Renamed Character' }),
    );
  });

  it.each([
    ['isolationKey', 'profile-b'],
    ['sourceTableKey', 'sheet_outline'],
    ['chatKey', 'chat-other'],
    ['indexId', 'snap_two'],
    ['writeGeneration', 'write_two'],
  ] as const)('任一身份维度 %s 改变时路径不同', (key, value) => {
    expect(buildVectorIndexSingleSnapshotV2FilePath_ACU(base)).not.toBe(
      buildVectorIndexSingleSnapshotV2FilePath_ACU({ ...base, [key]: value }),
    );
  });

  it('不会把旧规范化会碰撞的 scope 段折叠为同一路径', () => {
    const slash = buildVectorIndexSingleSnapshotV2FilePath_ACU({ ...base, isolationKey: 'iso/A' });
    const underscore = buildVectorIndexSingleSnapshotV2FilePath_ACU({ ...base, isolationKey: 'iso_A' });
    expect(slash).not.toBe(underscore);
    expect(buildVectorIndexStableDirectory_ACU({
      chatKey: base.chatKey,
      isolationKey: 'iso/A',
      sourceTableKey: base.sourceTableKey,
    })).toBe(buildVectorIndexStableDirectory_ACU({
      chatKey: base.chatKey,
      isolationKey: 'iso_A',
      sourceTableKey: base.sourceTableKey,
    }));
  });

  it('canonical scope 编码后的对象路径超过宿主安全上限时拒绝写入，不截断制造碰撞', () => {
    expect(() => buildVectorIndexSingleSnapshotV2FilePath_ACU({
      ...base,
      chatKey: 'chat-'.repeat(40),
      isolationKey: 'isolation-'.repeat(40),
      sourceTableKey: 'summary-'.repeat(40),
    })).toThrow('V2 快照对象路径超长');
  });
});

describe('向量索引 registry 持久化', () => {
  it('registry 上传返回失败时向调用方传播错误，不能伪装成已登记', async () => {
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.result = 'data:application/json;base64,e30=';
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('FileReader', FakeFileReader);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'registry backend unavailable' }));

    await expect(registerVectorIndexFiles_ACU([{
      role: 'manifest', path: 'orphan-v2-path', byteSize: 1, checksum: 'checksum', createdAt: '', updatedAt: '', status: 'ready',
    }])).rejects.toThrow('registry 保存失败');
  });
});
