type SummaryVectorIndexRealignDirtyReason_ACU =
    | 'chat_modified_deleted'
    | 'chat_modified_swiped'
    | 'self_heal_identity_mismatch'
    | 'runtime_stale_rows'
    | string;

interface SummaryVectorIndexRealignDirtyState_ACU {
    dirty: boolean;
    reason: SummaryVectorIndexRealignDirtyReason_ACU;
    markedAt: string;
}

let summaryVectorIndexRealignDirtyState_ACU: SummaryVectorIndexRealignDirtyState_ACU | null = null;

export function markSummaryVectorIndexDirtyForRealign_ACU(reason: SummaryVectorIndexRealignDirtyReason_ACU): SummaryVectorIndexRealignDirtyState_ACU {
    summaryVectorIndexRealignDirtyState_ACU = {
        dirty: true,
        reason: String(reason || 'runtime_stale_rows'),
        markedAt: new Date().toISOString(),
    };
    return { ...summaryVectorIndexRealignDirtyState_ACU };
}

export function clearSummaryVectorIndexDirtyForRealign_ACU(): void {
    summaryVectorIndexRealignDirtyState_ACU = null;
}

export function isSummaryVectorIndexDirtyForRealign_ACU(): boolean {
    return summaryVectorIndexRealignDirtyState_ACU?.dirty === true;
}

export function getSummaryVectorIndexDirtyForRealign_ACU(): SummaryVectorIndexRealignDirtyState_ACU | null {
    return summaryVectorIndexRealignDirtyState_ACU ? { ...summaryVectorIndexRealignDirtyState_ACU } : null;
}
