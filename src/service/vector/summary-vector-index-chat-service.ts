import { readIsolatedTagData_ACU, writeIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import {
    clearSummaryVectorFlushTasksByScope_ACU,
    deleteSummaryVectorHotCacheByScope_ACU,
} from '../../data/storage/vector-index-hot-cache';
import { isSummaryOrOutlineTable_ACU } from '../../shared/utils';
import { getChatArray_ACU, saveChatToHost_ACU } from '../chat/chat-service';
import { currentChatFileIdentifier_ACU, currentJsonTableData_ACU } from '../runtime/state-manager';
import {
    assignSummaryVectorIndexStateToTagData_ACU,
    getAggregatedSummaryVectorIndexSnapshot_ACU,
} from './summary-vector-index-state-service';
import { cleanupUnreachableSummaryVectorIndexFiles_ACU } from './summary-vector-index-storage-service';

function getCurrentSummaryVectorIndexSourceTableKey_ACU(): string {
    const tables = currentJsonTableData_ACU && typeof currentJsonTableData_ACU === 'object'
        ? currentJsonTableData_ACU
        : null;
    if (!tables) return 'summary';
    return Object.keys(tables).find((key) => {
        const table = tables[key];
        return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
    }) || 'summary';
}

export async function deleteCurrentSummaryVectorIndexFromChat_ACU(): Promise<boolean> {
    const snapshot = getAggregatedSummaryVectorIndexSnapshot_ACU();
    const chat = getChatArray_ACU();
    const scopeHints = new Map<string, { chatKey?: string; isolationKey: string; sourceTableKey: string }>();
    let changed = false;

    if (snapshot?.layers?.length) {
        for (const layer of snapshot.layers) {
            const message = chat[layer.messageIndex];
            if (!message || message.is_user) continue;
            const tagData = readIsolatedTagData_ACU(message, layer.isolationKey);
            if (!tagData) continue;
            const manifest = tagData.summaryVectorIndexManifest || tagData.summaryVectorIndexState?.manifest || null;
            if (manifest) {
                const hint = {
                    chatKey: manifest.chatKey || currentChatFileIdentifier_ACU,
                    isolationKey: manifest.isolationKey || layer.isolationKey,
                    sourceTableKey: manifest.sourceTableKey || getCurrentSummaryVectorIndexSourceTableKey_ACU(),
                };
                scopeHints.set(`${hint.chatKey || ''}\n${hint.isolationKey}\n${hint.sourceTableKey}`, hint);
            }
            assignSummaryVectorIndexStateToTagData_ACU(tagData, null);
            writeIsolatedTagData_ACU(message, layer.isolationKey, tagData);
            changed = true;
        }
    }

    if (changed) {
        await saveChatToHost_ACU();
    }

    const scopeHintList = Array.from(scopeHints.values());
    for (const hint of scopeHintList) {
        await deleteSummaryVectorHotCacheByScope_ACU(hint);
        await clearSummaryVectorFlushTasksByScope_ACU(hint);
    }
    const gcResult = await cleanupUnreachableSummaryVectorIndexFiles_ACU({ scopeHints: scopeHintList });
    return changed || gcResult.deletedPaths.length > 0 || gcResult.failedDeletes.length > 0;
}
