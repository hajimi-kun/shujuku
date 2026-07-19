import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/data/repositories/profile-repo', () => ({
  globalMeta_ACU: {},
  saveGlobalMeta_ACU: vi.fn(),
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  currentChatFileIdentifier_ACU: 'chat-file',
  settings_ACU: {},
}));

vi.mock('../../../src/service/settings/settings-readers', () => ({
  getCurrentWorldbookConfig_ACU: () => ({}),
}));

import {
  getEffectiveSummaryVectorIndexConfig_ACU,
  normalizeVectorMemoryConfig_ACU,
} from '../../../src/service/vector/vector-memory-config';

describe('vector-memory-config hybrid retrieval fields', () => {
  it('normalize 默认启用 hybrid，并补齐 BM25/RRF 默认值', () => {
    const config = normalizeVectorMemoryConfig_ACU({ recallCandidateLimit: 321 });

    expect(config.hybridRetrievalEnabled).toBe(true);
    expect(config.bm25CandidateLimit).toBe(1000);
    expect(config.rrfK).toBe(60);
  });

  it('normalize 保留显式关闭 hybrid，并归一化 BM25/RRF 正整数', () => {
    const config = normalizeVectorMemoryConfig_ACU({
      hybridRetrievalEnabled: false,
      bm25CandidateLimit: 25,
      rrfK: 7,
    });

    expect(config.hybridRetrievalEnabled).toBe(false);
    expect(config.bm25CandidateLimit).toBe(25);
    expect(config.rrfK).toBe(7);
  });

  it('effective config 暴露运行时使用的 summaryIndex hybrid 字段', () => {
    const config = getEffectiveSummaryVectorIndexConfig_ACU({
      embeddingEndpoint: 'https://embedding.test',
      embeddingModel: 'model',
      topK: 8,
      recallCandidateLimit: 3,
      hybridRetrievalEnabled: false,
      bm25CandidateLimit: 5,
      rrfK: 11,
    });

    expect(config.summaryIndexHybridRetrievalEnabled).toBe(false);
    expect(config.summaryIndexBm25CandidateLimit).toBe(5);
    expect(config.summaryIndexRrfK).toBe(11);
    expect(config.summaryIndexCandidateLimit).toBe(8);
  });
});
