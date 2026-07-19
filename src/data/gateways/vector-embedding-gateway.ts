export interface VectorEmbeddingRequest_ACU {
    endpoint: string;
    apiKey?: string;
    model: string;
    input: string[];
}

export interface VectorEmbeddingResult_ACU {
    index: number;
    embedding: number[];
}

function normalizeEmbeddingVector_ACU(value: any): number[] {
    if (!Array.isArray(value)) return [];
    const vector = value
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
    return vector.length === value.length ? vector : [];
}

function normalizeEmbeddingResponse_ACU(payload: any): VectorEmbeddingResult_ACU[] {
    const data = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.embeddings)
            ? payload.embeddings
            : [];
    return data
        .map((item: any, fallbackIndex: number): VectorEmbeddingResult_ACU => ({
            index: Number.isInteger(item?.index) ? Number(item.index) : fallbackIndex,
            embedding: normalizeEmbeddingVector_ACU(item?.embedding ?? item),
        }))
        .filter((item: VectorEmbeddingResult_ACU) => item.embedding.length > 0);
}

export async function createEmbeddings_ACU(request: VectorEmbeddingRequest_ACU): Promise<VectorEmbeddingResult_ACU[]> {
    const endpoint = String(request.endpoint || '').trim();
    const model = String(request.model || '').trim();
    const input = Array.isArray(request.input) ? request.input.map((item) => String(item ?? '')) : [];
    if (!endpoint) {
        throw new Error('缺少 embeddingEndpoint，无法生成纪要向量索引。');
    }
    if (!model) {
        throw new Error('缺少 embeddingModel，无法生成纪要向量索引。');
    }
    if (input.length === 0) {
        return [];
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = String(request.apiKey || '').trim();
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input }),
    });
    if (!response.ok) {
        const detail = await response.text().catch((): string => response.statusText);
        throw new Error(`Embedding 请求失败 ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    const normalized = normalizeEmbeddingResponse_ACU(payload);
    if (normalized.length === 0) {
        throw new Error('Embedding 响应中没有可用向量。');
    }
    return normalized;
}
