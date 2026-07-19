--- shujukumov5.0.js (修改前)
+++ shujukumov5.0.js (修改后)
@@ -2785,6 +2785,10 @@
       summaryPromptGroupId: 'remote-memory-archive-default',
       archiveWithoutSummary: false,
       recentFixedInjectCount: 50,
+      // [交火向量索引·实验] 基线+滚动增量写入（默认关闭，省远程上传带宽；读取侧自动识别两种格式）。
+      summaryIndexRollingDeltaEnabled: false,
+      // 折叠阈值 K：滚动增量累计达到 K 个不同纪要行时，把增量折叠进基线（最高占用 ≈ 2K 行的多文件）。
+      summaryIndexRollingDeltaFoldThreshold: 15,
       summaryPromptGroup: [
           {
               role: 'system',
@@ -3655,6 +3659,8 @@
           keywordPromptGroup: normalizeKeywordPromptGroup_ACU(source.keywordPromptGroup, defaults.keywordPromptGroup),
           recallCandidateLimit: normalizePositiveInteger_ACU$1(source.recallCandidateLimit, defaults.recallCandidateLimit),
           recentFixedInjectCount: normalizePositiveInteger_ACU$1(source.recentFixedInjectCount, defaults.recentFixedInjectCount || 50),
+          summaryIndexRollingDeltaEnabled: source.summaryIndexRollingDeltaEnabled === true,
+          summaryIndexRollingDeltaFoldThreshold: normalizePositiveInteger_ACU$1(source.summaryIndexRollingDeltaFoldThreshold, defaults.summaryIndexRollingDeltaFoldThreshold || 15),
       };
   }
   /**
@@ -3800,8 +3806,41 @@
           summaryIndexArchiveMaxConcurrency,
           summaryIndexKeywordMinRows,
           summaryIndexRecentFixedInjectCount: recentFixedInjectCount,
+          summaryIndexRollingDeltaEnabled: config.summaryIndexRollingDeltaEnabled === true,
+          summaryIndexRollingDeltaFoldThreshold: Math.max(1, Math.floor(Number(config.summaryIndexRollingDeltaFoldThreshold) || 15)),
       };
   }
+  // [交火向量索引·实验] 运行时开关：在浏览器控制台调用
+  //   ACU_setCrossfireRollingDelta(true, 15)  → 开启滚动增量写入，K=15
+  //   ACU_setCrossfireRollingDelta(false)     → 关回单文件 float32 模式
+  //   ACU_getCrossfireRollingDelta()          → 查看当前状态
+  // 注意：仅影响"之后新归档"的写入格式；读取侧两种格式自动识别、可共存。
+  function setSummaryVectorIndexRollingDeltaEnabled_ACU(enabled, foldThreshold) {
+      const config = getCurrentVectorMemoryConfig_ACU();
+      config.summaryIndexRollingDeltaEnabled = enabled === true;
+      if (foldThreshold != null && Number.isFinite(Number(foldThreshold)) && Number(foldThreshold) >= 1)
+          config.summaryIndexRollingDeltaFoldThreshold = Math.floor(Number(foldThreshold));
+      saveGlobalMeta_ACU();
+      const status = {
+          enabled: config.summaryIndexRollingDeltaEnabled,
+          foldThreshold: Math.max(1, Math.floor(Number(config.summaryIndexRollingDeltaFoldThreshold) || 15)),
+      };
+      logDebug_ACU('[交火向量索引] 滚动增量写入开关已更新:', status);
+      return status;
+  }
+  try {
+      if (typeof window !== 'undefined') {
+          window.ACU_setCrossfireRollingDelta = setSummaryVectorIndexRollingDeltaEnabled_ACU;
+          window.ACU_getCrossfireRollingDelta = () => {
+              const c = getCurrentVectorMemoryConfig_ACU();
+              return {
+                  enabled: c.summaryIndexRollingDeltaEnabled === true,
+                  foldThreshold: Math.max(1, Math.floor(Number(c.summaryIndexRollingDeltaFoldThreshold) || 15)),
+              };
+          };
+      }
+  }
+  catch (_) { }
   function validateSummaryVectorIndexConfig_ACU(configInput) {
       const config = getEffectiveSummaryVectorIndexConfig_ACU(configInput);
       const errors = [];
@@ -20146,6 +20185,7 @@
           .replace(/^user\/files\//, '')
           .replace(/^files\//, '');
   }
+  let preferredDeletePrefixLabel_ACU = null;
   function buildDeleteRequestCandidates_ACU(path) {
       const fileName = normalizeDeletePathInput_ACU(path);
       const candidates = [];
@@ -20160,10 +20200,20 @@
       // SillyTavern exposes uploaded files as /user/files/<name>. Different builds have accepted
       // different relative roots for /api/files/delete, so keep candidates explicit and verify after
       // a 404 instead of pretending the delete succeeded. 能跑不等于能删干净。
-      addCandidate('path:files-prefix', { path: `files/${fileName}` });
-      addCandidate('path:filename', { path: fileName });
+      // user/files/<name> is the form modern builds accept, so try it first to avoid noisy 400s.
       addCandidate('path:user-files-prefix', { path: `user/files/${fileName}` });
       addCandidate('path:absolute-user-files-prefix', { path: `/user/files/${fileName}` });
+      addCandidate('path:files-prefix', { path: `files/${fileName}` });
+      addCandidate('path:filename', { path: fileName });
+      if (preferredDeletePrefixLabel_ACU) {
+          candidates.sort((a, b) => {
+              if (a.label === preferredDeletePrefixLabel_ACU)
+                  return -1;
+              if (b.label === preferredDeletePrefixLabel_ACU)
+                  return 1;
+              return 0;
+          });
+      }
       return candidates;
   }
   async function vectorIndexFileExists_ACU(path) {
@@ -20192,6 +20242,7 @@
                   body: JSON.stringify(candidate.body),
               });
               if (response.ok) {
+                  preferredDeletePrefixLabel_ACU = candidate.label;
                   return { ok: true, path: normalizedPath };
               }
               const detail = await response.text().catch(() => response.statusText);
@@ -20319,12 +20370,17 @@
           };
       }));
   }
-  async function getVectorIndexCachedShard_ACU(indexId, shardId) {
+  async function getVectorIndexCachedShard_ACU(indexId, shardId, expectedChecksum = '') {
       try {
           const key = makeKey_ACU(indexId, shardId);
           const record = await runStore_ACU('readonly', (store) => store.get(key));
           if (!record?.shard)
               return null;
+          // [滚动增量·缓存防过期] 同一 (indexId, shardId) 内容可能随每楼覆盖（如增量分片），
+          // 因此当调用方提供 expectedChecksum 时必须校验：记录必须有匹配的 checksum；
+          // 记录无 checksum（历史遗留条目）也视为不可信 → 返回 null 触发重新下载，避免读到过期向量。
+          if (expectedChecksum && record.checksum !== expectedChecksum)
+              return null;
           void putVectorIndexCachedShard_ACU(indexId, shardId, record.shard, record.checksum).catch(() => undefined);
           return record.shard;
       }
@@ -21780,6 +21836,24 @@
       if (dimension <= 0) {
           throw new Error('交火向量快照索引缺少有效向量维度。');
       }
+      // [交火向量索引·实验] 基线+滚动增量写入分支（默认关闭）。
+      // 开启后：基线分片仅在折叠时重写，平时只覆盖小体积增量分片，显著降低远程上传带宽。
+      // 读取侧通过 manifest.batchRefs 自动识别，单文件/滚动增量两种格式可无缝并存与迁移。
+      const rollingDeltaConfig = getCurrentVectorMemoryConfig_ACU() || {};
+      if (rollingDeltaConfig.summaryIndexRollingDeltaEnabled === true) {
+          return await persistSummaryVectorIndexSnapshotAsRollingDelta_ACU(options, {
+              chatKey,
+              isolationKey,
+              indexedAt,
+              snapshotRevision,
+              indexId,
+              rows,
+              chunks,
+              dimension,
+              activeRowKeys,
+              foldThreshold: Math.max(1, Math.floor(Number(rollingDeltaConfig.summaryIndexRollingDeltaFoldThreshold) || 15)),
+          });
+      }
       const rowsByKey = new Map(rows.map((row) => [row.rowKey, row]));
       const chunkKeysByChunkId = new Map();
       for (const chunk of chunks) {
@@ -21876,7 +21950,8 @@
           updatedAt: indexedAt,
           manifest: manifestDraft,
           rows: rowsWithShardIds,
-          chunks: chunks.map((chunk) => ({ ...chunk, chunkKeys: chunkKeysByChunkId.get(chunk.chunkId) ? [chunkKeysByChunkId.get(chunk.chunkId)] : chunk.chunkKeys })),
+          // [float32] 写盘时把向量打包成 f32b64 二进制（无损、约 2.6x 体积缩减）；读取侧自动解码。
+          chunks: chunks.map((chunk) => encodeChunkVectorForStorage_ACU({ ...chunk, chunkKeys: chunkKeysByChunkId.get(chunk.chunkId) ? [chunkKeysByChunkId.get(chunk.chunkId)] : chunk.chunkKeys })),
           tombstone,
       };
       const written = await uploadVectorIndexJsonFile_ACU({
@@ -21921,36 +21996,320 @@
       }
       return { state, manifest: finalManifest, uploadedFiles: [written.ref] };
   }
+  // ── [交火向量索引] float32 二进制无损编解码（省带宽：JSON 浮点数组 → base64 二进制，约 2.6x）──
+  // 标记：chunk.vectorEncoding === 'f32b64' 表示 chunk.vector 为 base64 编码的 Float32 小端二进制。
+  const VECTOR_ENCODING_F32B64_ACU = 'f32b64';
+  function encodeVectorToF32B64_ACU(vector) {
+      if (!Array.isArray(vector) || vector.length === 0)
+          return '';
+      const floats = Float32Array.from(vector);
+      const bytes = new Uint8Array(floats.buffer);
+      let binary = '';
+      const stride = 0x8000;
+      for (let i = 0; i < bytes.length; i += stride) {
+          binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + stride, bytes.length)));
+      }
+      return btoa(binary);
+  }
+  function decodeF32B64ToVector_ACU(encoded) {
+      if (typeof encoded !== 'string' || encoded.length === 0)
+          return [];
+      const binary = atob(encoded);
+      const bytes = new Uint8Array(binary.length);
+      for (let i = 0; i < binary.length; i += 1)
+          bytes[i] = binary.charCodeAt(i);
+      // Float32Array 需要 4 字节对齐的 buffer；atob 产出的 buffer 起始对齐，长度应为 4 的倍数
+      const usableLength = bytes.length - (bytes.length % 4);
+      const floats = new Float32Array(bytes.buffer, 0, usableLength / 4);
+      return Array.from(floats);
+  }
+  // 写入前：把 chunk.vector（数组）打包成 f32b64；返回浅拷贝，不改原对象。
+  function encodeChunkVectorForStorage_ACU(chunk) {
+      if (!chunk || !Array.isArray(chunk.vector) || chunk.vector.length === 0)
+          return chunk;
+      return { ...chunk, vector: encodeVectorToF32B64_ACU(chunk.vector), vectorEncoding: VECTOR_ENCODING_F32B64_ACU };
+  }
+  // 读取后：若 chunk 是 f32b64 编码则就地解码回数组（在 Array.isArray(vector) 过滤之前调用）。
+  function decodeChunkVectorInPlace_ACU(chunk) {
+      if (!chunk)
+          return chunk;
+      if (chunk.vectorEncoding === VECTOR_ENCODING_F32B64_ACU && typeof chunk.vector === 'string') {
+          chunk.vector = decodeF32B64ToVector_ACU(chunk.vector);
+          delete chunk.vectorEncoding;
+      }
+      return chunk;
+  }
+  function decodeChunkVectorsInPlace_ACU(chunks) {
+      if (Array.isArray(chunks))
+          chunks.forEach((chunk) => decodeChunkVectorInPlace_ACU(chunk));
+      return chunks;
+  }
+  // ── [交火向量索引·实验] 基线 + 滚动增量写入 ────────────────────────────────────────────
+  // 设计要点：
+  //  · 始终维护两份文件：基线分片(base_shard) + 滚动增量分片(delta_shard)。
+  //  · 平时每楼只覆盖增量分片（体积小）；当增量累计达到 K 个不同纪要行时，把"基线∪增量=全量"
+  //    重写为新基线、清空增量（折叠 fold）。基线分片只在折叠时上传，显著降低远程上传带宽。
+  //  · 正确性靠读取侧三层过滤兜底：removedRowKeys / activeRowKeys / activeChunkIds，
+  //    再按 chunkId 去重（增量覆盖基线）。因此基线允许残留"改写行的旧块"，会被 activeChunkIds 滤除。
+  //  · 基线分片 (indexId, shardId) 在折叠之间保持稳定 → 命中分片缓存、避免重复下载；
+  //    增量分片 id 稳定但内容每楼变化 → 依赖 checksum 校验防止读到过期缓存。
+  function buildVectorShardBlob_ACU(params) {
+      return {
+          version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
+          schema: 'vector_shard',
+          indexId: params.indexId,
+          shardId: params.shardId,
+          chatKey: params.chatKey,
+          isolationKey: params.isolationKey,
+          sourceTableKey: params.sourceTableKey,
+          embeddingModel: params.embeddingModel,
+          dimension: params.dimension,
+          updatedAt: params.indexedAt,
+          // 写盘时把向量打包成 f32b64 二进制（无损、约 2.6x 体积缩减）；读取侧自动解码。
+          chunks: (Array.isArray(params.chunks) ? params.chunks : []).map((chunk) => encodeChunkVectorForStorage_ACU({
+              chunkId: chunk.chunkId,
+              rowKey: chunk.rowKey,
+              rowOrder: Number.isFinite(Number(chunk.rowOrder)) ? Number(chunk.rowOrder) : 0,
+              text: chunk.text,
+              vector: chunk.vector,
+              sequence: Number.isFinite(Number(chunk.sequence)) ? Number(chunk.sequence) : 0,
+              ...(Array.isArray(chunk.chunkKeys) && chunk.chunkKeys.length > 0 ? { chunkKeys: chunk.chunkKeys } : {}),
+          })),
+      };
+  }
+  async function persistSummaryVectorIndexSnapshotAsRollingDelta_ACU(options, ctx) {
+      const uploadedFiles = [];
+      try {
+          const chunks = ctx.chunks;
+          const rows = ctx.rows;
+          const indexId = ctx.indexId;
+          const activeChunkIds = chunks.map((chunk) => chunk.chunkId);
+          const activeRowKeys = Array.from(new Set(ctx.activeRowKeys?.length ? ctx.activeRowKeys : rows.map((row) => row.rowKey)));
+          const removedRowKeys = Array.from(new Set(options.removedRowKeys || []));
+          const replacedRowKeys = Array.from(new Set(options.replacedRowKeys || []));
+          const parentIndexIds = Array.from(new Set([
+              ...(options.parentIndexIds || []),
+              ...(options.previousManifest?.indexId ? [options.previousManifest.indexId] : []),
+          ].filter(Boolean)));
+          const prevBatchRefs = Array.isArray(options.previousManifest?.batchRefs) ? options.previousManifest.batchRefs : [];
+          const prevBaseBatch = prevBatchRefs.find((batch) => batch?.role === 'base');
+          const prevBaseRef = (prevBaseBatch?.files || []).find((file) => file?.role === 'base_shard');
+          const prevBaseChunkIds = new Set(Array.isArray(prevBaseBatch?.baseChunkIds) ? prevBaseBatch.baseChunkIds : []);
+          const prevDeltaBatch = prevBatchRefs.find((batch) => batch?.role === 'delta');
+          const prevDeltaRef = (prevDeltaBatch?.files || []).find((file) => file?.role === 'delta_shard');
+          const baseUsable = !!(prevBaseRef && prevBaseChunkIds.size > 0 && prevBaseBatch?.indexId);
+          const deltaCandidates = baseUsable ? chunks.filter((chunk) => !prevBaseChunkIds.has(chunk.chunkId)) : chunks.slice();
+          const deltaRowKeySet = new Set(deltaCandidates.map((chunk) => chunk.rowKey));
+          const shouldFold = !baseUsable || deltaRowKeySet.size >= ctx.foldThreshold;
+          const chatName = getCurrentCharacterCardName_ACU();
+          const scopePath = buildVectorIndexSingleSnapshotFilePath_ACU({ chatKey: ctx.chatKey, isolationKey: ctx.isolationKey, sourceTableKey: options.sourceTableKey, chatName });
+          const shardBlobCommon = {
+              chatKey: ctx.chatKey,
+              isolationKey: ctx.isolationKey,
+              sourceTableKey: options.sourceTableKey,
+              embeddingModel: options.embeddingModel,
+              dimension: ctx.dimension,
+              indexedAt: ctx.indexedAt,
+          };
+          let baseBatchIndexId;
+          let baseShardId;
+          let basePath;
+          let baseRef;
+          let baseChunkIds;
+          let baseBlobForCache = null;
+          if (shouldFold) {
+              baseBatchIndexId = indexId;
+              baseShardId = `base_${indexId}`;
+              basePath = `${scopePath}_base`;
+              baseChunkIds = chunks.map((chunk) => chunk.chunkId);
+              baseBlobForCache = buildVectorShardBlob_ACU({ ...shardBlobCommon, indexId: baseBatchIndexId, shardId: baseShardId, chunks });
+              const baseWritten = await uploadVectorIndexJsonFile_ACU({
+                  path: basePath,
+                  role: 'base_shard',
+                  shardId: baseShardId,
+                  data: baseBlobForCache,
+                  chunkCount: chunks.length,
+                  rowCount: rows.length,
+                  status: 'ready',
+              });
+              if (!baseWritten.ok || !baseWritten.ref)
+                  throw new Error(baseWritten.error || '交火向量基线分片写入失败');
+              uploadedFiles.push(baseWritten.ref);
+              baseRef = baseWritten.ref;
+          }
+          else {
+              baseBatchIndexId = String(prevBaseBatch.indexId);
+              baseShardId = String(prevBaseRef.shardId);
+              basePath = String(prevBaseRef.path);
+              baseChunkIds = Array.from(prevBaseChunkIds);
+              baseRef = { ...prevBaseRef, role: 'base_shard' };
+          }
+          const deltaBatchIndexId = shouldFold
+              ? `${indexId}_delta`
+              : String(prevDeltaBatch?.indexId || `${indexId}_delta`);
+          const deltaShardId = `delta_${deltaBatchIndexId}`;
+          const deltaPath = (!shouldFold && prevDeltaRef?.path) ? String(prevDeltaRef.path) : `${scopePath}_delta`;
+          const deltaChunks = shouldFold ? [] : deltaCandidates;
+          const deltaBlob = buildVectorShardBlob_ACU({ ...shardBlobCommon, indexId: deltaBatchIndexId, shardId: deltaShardId, chunks: deltaChunks });
+          const deltaWritten = await uploadVectorIndexJsonFile_ACU({
+              path: deltaPath,
+              role: 'delta_shard',
+              shardId: deltaShardId,
+              data: deltaBlob,
+              chunkCount: deltaChunks.length,
+              rowCount: new Set(deltaChunks.map((chunk) => chunk.rowKey)).size,
+              status: 'ready',
+          });
+          if (!deltaWritten.ok || !deltaWritten.ref)
+              throw new Error(deltaWritten.error || '交火向量增量分片写入失败');
+          uploadedFiles.push(deltaWritten.ref);
+          const deltaRef = deltaWritten.ref;
+          // 预热分片缓存：写入后即写本地缓存，避免下一轮立刻重新下载。
+          if (baseBlobForCache)
+              await putVectorIndexCachedShard_ACU(baseBatchIndexId, baseShardId, baseBlobForCache, baseRef.checksum);
+          await putVectorIndexCachedShard_ACU(deltaBatchIndexId, deltaShardId, deltaBlob, deltaRef.checksum);
+          const baseBatch = {
+              batchId: `base:${baseBatchIndexId}`,
+              role: 'base',
+              indexId: baseBatchIndexId,
+              status: 'ready',
+              baseChunkIds,
+              chunkIds: baseChunkIds,
+              rowKeys: [],
+              files: [{ ...baseRef, role: 'base_shard' }],
+          };
+          const deltaBatch = {
+              batchId: `delta:${deltaBatchIndexId}`,
+              role: 'delta',
+              indexId: deltaBatchIndexId,
+              status: 'ready',
+              chunkIds: deltaChunks.map((chunk) => chunk.chunkId),
+              rowKeys: Array.from(new Set(deltaChunks.map((chunk) => chunk.rowKey))),
+              files: [{ ...deltaRef, role: 'delta_shard' }],
+          };
+          const manifestFiles = [{ ...baseRef, role: 'base_shard' }, { ...deltaRef, role: 'delta_shard' }];
+          const finalManifest = {
+              version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
+              backend: 'st-files',
+              status: 'ready',
+              indexId,
+              chatKey: ctx.chatKey,
+              isolationKey: ctx.isolationKey,
+              snapshotMessageId: options.snapshotMessageId,
+              sourceTableKey: options.sourceTableKey,
+              sourceTableName: options.sourceTableName,
+              indexedAt: ctx.indexedAt,
+              updatedAt: ctx.indexedAt,
+              rowCount: rows.length,
+              chunkCount: chunks.length,
+              skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
+              embeddingModel: options.embeddingModel,
+              dimension: ctx.dimension,
+              rowsFile: '',
+              tombstoneFile: '',
+              manifestFile: '',
+              files: manifestFiles,
+              baseShardCount: 1,
+              deltaShardCount: 1,
+              tombstoneRowCount: removedRowKeys.length,
+              tombstoneChunkCount: 0,
+              externalTotalBytes: sumUniqueVectorIndexFileBytes_ACU(manifestFiles),
+              snapshot: {
+                  revision: ctx.snapshotRevision,
+                  mode: 'base_rolling_delta',
+                  parentIndexIds,
+                  activeRowKeys,
+                  activeChunkIds,
+                  removedRowKeys,
+                  replacedRowKeys,
+                  batchIds: [baseBatch.batchId, deltaBatch.batchId],
+              },
+              batchRefs: [baseBatch, deltaBatch],
+          };
+          const stateRows = rows.map((row) => ({ ...row, shardIds: [] }));
+          const state = {
+              version: SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU,
+              backend: 'st-files',
+              status: 'ready',
+              indexId,
+              snapshotMessageId: options.snapshotMessageId,
+              sourceTableKey: options.sourceTableKey,
+              sourceTableName: options.sourceTableName,
+              indexedAt: ctx.indexedAt,
+              rowCount: rows.length,
+              chunkCount: chunks.length,
+              skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount) || 0)),
+              rows: stateRows,
+              manifest: finalManifest,
+          };
+          await registerVectorIndexFiles_ACU(manifestFiles);
+          const retainedPaths = new Set([basePath, deltaPath]);
+          try {
+              await cleanupManifestFilesExcept_ACU(options.previousManifest, retainedPaths);
+              await cleanupSnapshotScopeFilesExcept_ACU(finalManifest, retainedPaths, { includeSameSourceTableFallback: true });
+          }
+          catch (error) {
+              logWarn_ACU('[纪要向量索引] 滚动增量旧文件清理失败，保留当前快照继续运行:', error);
+          }
+          logDebug_ACU(`[交火向量索引] 滚动增量写入完成：fold=${shouldFold} base(${baseChunkIds.length}块)=${basePath} delta(${deltaChunks.length}块)=${deltaPath}`);
+          return { state, manifest: finalManifest, uploadedFiles: manifestFiles };
+      }
+      catch (error) {
+          await rollbackUploadedFiles_ACU(uploadedFiles).catch(() => undefined);
+          throw error;
+      }
+  }
+  async function loadOneShardChunks_ACU(indexId, ref, options = {}) {
+      let shard = null;
+      if (options.preferExternalFiles !== true) {
+          shard = await getVectorIndexCachedShard_ACU(indexId, ref.shardId, ref.checksum);
+      }
+      if (!shard) {
+          const loaded = await readVectorIndexJsonFile_ACU(ref.path);
+          if (!loaded.ok || !loaded.data) {
+              throw new Error(`交火向量索引分片读取失败: ${ref.path} ${loaded.error || ''}`.trim());
+          }
+          const loadedShard = loaded.data;
+          const loadedShardId = String(loadedShard?.shardId || '');
+          const loadedIndexId = String(loadedShard?.indexId || '');
+          const shardMatchesManifest = loadedIndexId === indexId && loadedShardId === ref.shardId;
+          if (!shardMatchesManifest) {
+              throw new Error(`交火向量索引分片身份不匹配: ${ref.path} expectedIndex=${indexId} actualIndex=${loadedIndexId || 'empty'} expectedShard=${ref.shardId} actualShard=${loadedShardId || 'empty'}`);
+          }
+          const json = JSON.stringify(loadedShard);
+          const checksum = await sha256Text_ACU(json);
+          if (ref.checksum && checksum !== ref.checksum) {
+              throw new Error(`交火向量索引分片校验失败: ${ref.path} expected=${ref.checksum} actual=${checksum}`);
+          }
+          shard = loadedShard;
+          await putVectorIndexCachedShard_ACU(indexId, ref.shardId, shard, checksum || ref.checksum);
+      }
+      return (shard.chunks || []).map((chunk) => decodeChunkVectorInPlace_ACU({ ...chunk }));
+  }
   async function loadChunksFromShardRefs_ACU(indexId, shardRefs, options = {}) {
+      const refs = (Array.isArray(shardRefs) ? shardRefs : []).filter((ref) => ref && ref.shardId);
+      if (refs.length === 0)
+          return [];
+      // [滚动增量] 分片读取并行化（带并发上限），降低多文件冷读延迟；
+      // 结果按 refs 原始顺序回填，保证后续 sortAndDedupe 的覆盖语义（增量覆盖基线）不变。
+      const concurrency = Math.max(1, Math.min(refs.length, Math.floor(Number(options.shardReadConcurrency) || 6)));
+      const perRefChunks = new Array(refs.length);
+      let cursor = 0;
+      const worker = async () => {
+          while (true) {
+              const current = cursor++;
+              if (current >= refs.length)
+                  return;
+              perRefChunks[current] = await loadOneShardChunks_ACU(indexId, refs[current], options);
+          }
+      };
+      await Promise.all(Array.from({ length: concurrency }, () => worker()));
       const chunks = [];
-      for (const ref of shardRefs) {
-          if (!ref.shardId)
+      for (const list of perRefChunks) {
+          if (!list)
               continue;
-          let shard = null;
-          if (options.preferExternalFiles !== true) {
-              shard = await getVectorIndexCachedShard_ACU(indexId, ref.shardId);
-          }
-          if (!shard) {
-              const loaded = await readVectorIndexJsonFile_ACU(ref.path);
-              if (!loaded.ok || !loaded.data) {
-                  throw new Error(`交火向量索引分片读取失败: ${ref.path} ${loaded.error || ''}`.trim());
-              }
-              const loadedShard = loaded.data;
-              const loadedShardId = String(loadedShard?.shardId || '');
-              const loadedIndexId = String(loadedShard?.indexId || '');
-              const shardMatchesManifest = loadedIndexId === indexId && loadedShardId === ref.shardId;
-              if (!shardMatchesManifest) {
-                  throw new Error(`交火向量索引分片身份不匹配: ${ref.path} expectedIndex=${indexId} actualIndex=${loadedIndexId || 'empty'} expectedShard=${ref.shardId} actualShard=${loadedShardId || 'empty'}`);
-              }
-              const json = JSON.stringify(loadedShard);
-              const checksum = await sha256Text_ACU(json);
-              if (ref.checksum && checksum !== ref.checksum) {
-                  throw new Error(`交火向量索引分片校验失败: ${ref.path} expected=${ref.checksum} actual=${checksum}`);
-              }
-              shard = loadedShard;
-              await putVectorIndexCachedShard_ACU(indexId, ref.shardId, shard, checksum || ref.checksum);
-          }
-          (shard.chunks || []).forEach((chunk) => chunks.push({ ...chunk }));
+          for (const chunk of list)
+              chunks.push(chunk);
       }
       return chunks.filter((chunk) => Array.isArray(chunk.vector) && chunk.vector.length > 0);
   }
@@ -22098,7 +22457,8 @@
       if (String(blob.sourceTableKey || '') !== String(manifest.sourceTableKey || '')) {
           throw new Error(`交火向量单文件快照表标识不匹配: ${snapshotPath} expectedTable=${manifest.sourceTableKey} actualTable=${String(blob.sourceTableKey || 'empty')}`);
       }
-      const chunks = sortAndDedupeVectorChunks_ACU(Array.isArray(blob.chunks) ? blob.chunks : []);
+      const decodedBlobChunks = decodeChunkVectorsInPlace_ACU(Array.isArray(blob.chunks) ? blob.chunks.map((chunk) => ({ ...chunk })) : []);
+      const chunks = sortAndDedupeVectorChunks_ACU(decodedBlobChunks);
       if (manifest.chunkCount > 0 && chunks.length === 0) {
           throw new Error(`交火向量单文件快照缺少有效 chunks: ${snapshotPath}`);
       }
@@ -29706,6 +30066,13 @@
           const defaults = getDefaultVectorMemoryConfig_ACU();
           updateVectorMemoryField_ACU('recentFixedInjectCount', parseIntegerField_ACU($input.val(), defaults.recentFixedInjectCount || 50));
       });
+      bindVectorMemoryInput_ACU(`#${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rolling-delta-enabled`, 'change', ($input) => {
+          updateVectorMemoryField_ACU('summaryIndexRollingDeltaEnabled', $input.is(':checked'));
+      });
+      bindVectorMemoryInput_ACU(`#${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rolling-delta-fold-threshold`, 'input change', ($input) => {
+          const defaults = getDefaultVectorMemoryConfig_ACU();
+          updateVectorMemoryField_ACU('summaryIndexRollingDeltaFoldThreshold', parseIntegerField_ACU($input.val(), defaults.summaryIndexRollingDeltaFoldThreshold || 15));
+      });
       bindVectorMemoryInput_ACU(`#${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-entry-comment`, 'input change', ($input) => {
           updateVectorMemoryField_ACU('entryComment', String($input.val() ?? '').trim());
       });
@@ -32521,6 +32888,8 @@
           });
           if (result.success) {
               await deleteSummaryVectorFlushTask_ACU(task.scopeKey);
+              // 归档（含填表/S1b 兜底重对齐）成功即清除 S2 懒对齐脏标。
+              clearSummaryVectorIndexDirtyForRealign_ACU();
               logDebug_ACU(`[交火向量索引] 防抖 flush 完成：scope=${task.scopeKey}, skipped=${result.skipped}, reason=${result.reason || ''}`);
               return { success: true, skipped: result.skipped, reason: result.reason, result };
           }
@@ -35728,6 +36097,8 @@
       setChecked('worldbook-vector-memory-archive-without-summary', vectorMemoryConfig.archiveWithoutSummary === true);
       setVal('worldbook-vector-memory-recall-candidate-limit', vectorMemoryConfig.recallCandidateLimit);
       setVal('worldbook-vector-memory-recent-fixed-inject-count', vectorMemoryConfig.recentFixedInjectCount || 50);
+      setChecked('worldbook-vector-memory-rolling-delta-enabled', vectorMemoryConfig.summaryIndexRollingDeltaEnabled === true);
+      setVal('worldbook-vector-memory-rolling-delta-fold-threshold', vectorMemoryConfig.summaryIndexRollingDeltaFoldThreshold || 15);
       setVal('worldbook-vector-memory-entry-comment', vectorMemoryConfig.entryComment);
       setVal('worldbook-vector-memory-entry-key', vectorMemoryConfig.entryKey);
       setVal('worldbook-vector-memory-keyword-api-preset', vectorMemoryConfig.keywordApiPreset);
@@ -48442,6 +48813,18 @@
                                           <small class="notes">最近 X 条纪要固定注入，不参与排序；X 计入触发阈值但不计入 TopK。例如阈值200、X=50，则最近50条固定注入，较早的行参与向量召回。</small>
                                       </div>
                                       <div class="acu-col-sm">
+                                          <label for="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rolling-delta-enabled" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
+                                              <input type="checkbox" id="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rolling-delta-enabled" style="width: 14px; height: 14px; cursor: pointer;">
+                                              <span>启用滚动增量（base + delta）</span>
+                                          </label>
+                                          <small class="notes">开启后每楼只上传变更的 ≤K 行增量，基线仅在折叠时重写，可省约 96% 带宽；关闭则使用单文件 + float32 快照模式。仅影响之后新归档的写入格式，读取侧两种格式自动兼容。</small>
+                                      </div>
+                                      <div class="acu-col-sm">
+                                          <label for="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rolling-delta-fold-threshold">滚动增量折叠阈值 K</label>
+                                          <input type="number" id="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rolling-delta-fold-threshold" min="1" step="1" placeholder="15">
+                                          <small class="notes">滚动增量累计达到 K 行变更时折叠进基线并重写一次基线。K 越大上传越省、折叠越少（单次基线越大）；不影响文件数（恒为 2）。默认 15。仅在启用滚动增量时生效。</small>
+                                      </div>
+                                      <div class="acu-col-sm">
                                           <label for="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-namespace">索引命名空间前缀</label>
                                           <input type="text" id="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-namespace" placeholder="chat">
                                           <small class="notes">用于区分不同聊天的外置索引缓存；会与当前聊天标识拼接。</small>
@@ -51531,7 +51914,92 @@
       return text.includes('交火向量索引分片身份不匹配')
           || text.includes('交火向量索引分片校验失败')
           || text.includes('交火向量索引内容块身份不匹配')
-          || text.includes('交火向量索引内容块校验失败');
+          || text.includes('交火向量索引内容块校验失败')
+          // [S1] 单文件快照类不匹配同样视为"可自愈/可重建"，避免抛出吓人的报错、改为优雅降级 + 重对齐
+          || text.includes('交火向量单文件快照身份不匹配')
+          || text.includes('交火向量单文件快照协议不匹配')
+          || text.includes('交火向量单文件快照表标识不匹配')
+          || text.includes('交火向量索引内容包身份不匹配')
+          || text.includes('交火向量索引内容包校验失败');
+  }
+  // [S2] 删除/滑动后的「标脏 + 懒对齐」：仅标记索引为待对齐，不立即上传；
+  // 真正的对齐推迟到「下次填表归档」（顺带清脏）或「下次发送前由 S1 兜底」自然发生，
+  // 从而把「连续 reroll/删 N 次」的额外上传压到约 0。
+  let summaryVectorIndexDirtyForRealign_ACU = false;
+  function markSummaryVectorIndexDirtyForRealign_ACU(reason) {
+      summaryVectorIndexDirtyForRealign_ACU = true;
+      logDebug_ACU(`[交火模式纪要索引] 已标脏待对齐（懒对齐，不立即上传）：${reason || ''}`);
+  }
+  function clearSummaryVectorIndexDirtyForRealign_ACU() {
+      if (summaryVectorIndexDirtyForRealign_ACU) {
+          summaryVectorIndexDirtyForRealign_ACU = false;
+          logDebug_ACU('[交火模式纪要索引] 待对齐脏标已清除。');
+      }
+  }
+  function isSummaryVectorIndexDirtyForRealign_ACU() {
+      return summaryVectorIndexDirtyForRealign_ACU === true;
+  }
+  // [S1a] 发送前自愈·指针对齐（优先、最省）：当楼层指针 indexId 与磁盘单文件快照不一致时，
+  // 若磁盘文件可读、表标识一致、且版本不旧于期望版本，则直接把楼层指针对齐到磁盘实际 indexId，
+  // 并用「当前存活行集」刷新 activeRowKeys 以过滤已删行——不重传、不重算 embedding。
+  // 成功返回对齐后的 manifest（并尽力持久化回存活楼层）；不适用时返回 null，交由 S1b 重归档兜底。
+  async function tryRealignSummaryVectorIndexPointerFromDisk_ACU(layer, expectedManifest, activeRowKeysForAlign) {
+      try {
+          if (!layer || !expectedManifest)
+              return null;
+          const normalizedExpected = normalizeSummaryVectorIndexManifestForRead_ACU(expectedManifest);
+          if (!normalizedExpected || !isSingleFileSnapshotManifest_ACU(normalizedExpected))
+              return null;
+          const snapshotPath = String(normalizedExpected.manifestFile || normalizedExpected.files?.[0]?.path || '').trim();
+          if (!snapshotPath)
+              return null;
+          const loaded = await readVectorIndexJsonFile_ACU(snapshotPath);
+          if (!loaded.ok || !loaded.data)
+              return null;
+          const blob = loaded.data;
+          if (blob.schema !== 'single_file_snapshot')
+              return null;
+          const diskManifest = (blob.manifest && typeof blob.manifest === 'object') ? blob.manifest : null;
+          if (!diskManifest || !diskManifest.indexId)
+              return null;
+          // 自洽校验：blob 自身 indexId 必须与其内嵌 manifest 一致，且表标识匹配，避免对齐到错误的表。
+          if (String(blob.indexId || '') !== String(diskManifest.indexId))
+              return null;
+          if (String(diskManifest.sourceTableKey || '') !== String(normalizedExpected.sourceTableKey || ''))
+              return null;
+          // 仅当磁盘文件版本不旧于期望版本时才对齐，防止指向被回滚/陈旧的文件。
+          const diskRevision = Math.floor(Number(diskManifest.snapshot?.revision) || 0);
+          const expectedRevision = Math.floor(Number(normalizedExpected.snapshot?.revision) || 0);
+          if (diskRevision < expectedRevision)
+              return null;
+          const aligned = cloneJson_ACU(diskManifest);
+          if (!aligned.snapshot || typeof aligned.snapshot !== 'object')
+              aligned.snapshot = {};
+          if (Array.isArray(activeRowKeysForAlign) && activeRowKeysForAlign.length > 0)
+              aligned.snapshot.activeRowKeys = Array.from(new Set(activeRowKeysForAlign.map((key) => String(key))));
+          // 把对齐后的指针持久化回存活楼层，避免后续每次发送都触发同样的不匹配（持久化失败不影响本轮复用）。
+          const chat = getChatArray_ACU();
+          const message = Array.isArray(chat) ? chat[layer.messageIndex] : null;
+          const container = message ? parseIsolatedDataField(message) : null;
+          const tagData = container ? container[layer.isolationKey] : null;
+          if (message && container && tagData && typeof tagData === 'object') {
+              const layerState = readLayerState_ACU(tagData);
+              assignSummaryVectorIndexStateToTagData_ACU(tagData, layerState, aligned);
+              container[layer.isolationKey] = tagData;
+              message.TavernDB_ACU_IsolatedData = container;
+              writeMessageIdentity_ACU(message, {
+                  enabled: settings_ACU.dataIsolationEnabled,
+                  code: settings_ACU.dataIsolationCode,
+              });
+              await saveChatToHost_ACU();
+              logDebug_ACU(`[交火模式纪要索引] S1a 已将楼层指针对齐到磁盘 indexId=${aligned.indexId}（messageIndex=${layer.messageIndex}）。`);
+          }
+          return aligned;
+      }
+      catch (error) {
+          logWarn_ACU('[交火模式纪要索引] S1a 指针对齐失败，转入 S1b 重归档兜底:', error);
+          return null;
+      }
   }
   async function preloadSummaryVectorIndexCacheForCurrentChat_ACU() {
       const snapshot = getLatestSummaryVectorIndexSnapshotState_ACU();
@@ -51849,10 +52317,41 @@
       if (!state) {
           return { success: false, skipped: true, reason: 'no_index_state' };
       }
+      // [A·脏分片防护] 召回以「实时纪要表」为准，避免删楼/reroll 后、下次填表前的陈旧分片进入召回/重排。
+      // 数据源 currentJsonTableData_ACU 在删/滑事件后已由 refreshMergedDataAndNotify_ACU 重新合并刷新，
+      // 故 findSummaryTable_ACU 取到的是当前聊天的真实纪要表（删的行已不在、reroll 改的行已是新文本）。
+      // 本步只防护召回正确性，不清脏标——外置文件与本地缓存仍由下次填表归档彻底治愈（重算改动行）。
+      const liveSummaryTableInfo_ACU = findSummaryTable_ACU();
+      const livePreparedRowsResult_ACU = liveSummaryTableInfo_ACU
+          ? buildPreparedRows_ACU(liveSummaryTableInfo_ACU.table, liveSummaryTableInfo_ACU.summaryKey)
+          : null;
+      const liveRowByKey_ACU = (livePreparedRowsResult_ACU
+          && Array.isArray(livePreparedRowsResult_ACU.rows)
+          && livePreparedRowsResult_ACU.rows.length > 0)
+          ? new Map(livePreparedRowsResult_ACU.rows.map((row) => [row.rowKey, row]))
+          : null;
       const activeRowKeys = new Set(state.manifest?.snapshot?.activeRowKeys || []);
-      const rows = Array.isArray(state.rows)
+      let rows = Array.isArray(state.rows)
           ? state.rows.filter((row) => row.status !== 'removed' && (activeRowKeys.size === 0 || activeRowKeys.has(row.rowKey)))
           : [];
+      if (liveRowByKey_ACU) {
+          // 与实时表对账：删掉已不存在的行（删楼）；存活行用实时文本（reroll 后文本即时正确），
+          // rowOrder 采用实时顺序。不向候选新增行（新增行尚未 embedding，无向量）。
+          rows = rows
+              .filter((row) => liveRowByKey_ACU.has(row.rowKey))
+              .map((row) => {
+                  const live = liveRowByKey_ACU.get(row.rowKey);
+                  return {
+                      ...row,
+                      timeSpan: live.timeSpan,
+                      location: live.location,
+                      summary: live.summary,
+                      indexCode: live.indexCode,
+                      vectorSourceText: live.vectorSourceText,
+                      rowOrder: Number.isFinite(Number(live.rowOrder)) ? Number(live.rowOrder) : row.rowOrder,
+                  };
+              });
+      }
       if (rows.length < config.summaryIndexKeywordMinRows) {
           return { success: false, skipped: true, reason: 'below_min_rows' };
       }
@@ -51882,10 +52381,89 @@
                           indexId: state.manifest.indexId,
                       });
                   }
-                  logWarn_ACU('[交火模式纪要索引] 外置向量文件校验失败，已清空缓存并保留聊天索引指针，等待修复或重归档:', message);
-                  return { success: false, skipped: true, reason: 'vector_index_corrupted_rebuild_required' };
+                  // [S1a 指针对齐（优先、最省）] 先尝试把楼层指针对齐到磁盘单文件快照的实际 indexId，
+                  // 复用磁盘已有向量（不重传、不重算 embedding），并用当前存活行集过滤已删行；成功则继续本轮注入。
+                  let realignedManifest = null;
+                  if (latestLayer) {
+                      realignedManifest = await tryRealignSummaryVectorIndexPointerFromDisk_ACU(latestLayer, state.manifest, rows.map((row) => row.rowKey));
+                  }
+                  if (realignedManifest) {
+                      try {
+                          chunks = await loadSummaryVectorIndexChunksFromManifest_ACU(realignedManifest);
+                          clearSummaryVectorIndexDirtyForRealign_ACU();
+                          logDebug_ACU('[交火模式纪要索引] S1a 指针对齐成功，已复用磁盘向量，无需重传/重算。');
+                      }
+                      catch (realignLoadError) {
+                          realignedManifest = null;
+                          logWarn_ACU('[交火模式纪要索引] S1a 对齐后仍无法读取，转入 S1b 重归档兜底:', realignLoadError);
+                      }
+                  }
+                  if (!realignedManifest) {
+                      // [S1b 重归档兜底] S1a 不适用时再主动入队一次防抖重对齐：按当前最新 AI 楼层重归档，
+                      // 让索引自愈对齐。复用既有防抖 flush 队列（同 scope 自动合并），与下次填表的归档合并，避免重复上传。
+                      try {
+                          await enqueueSummaryVectorIndexFlush_ACU({
+                              targetMessageIndex: undefined,
+                              mode: 'sync',
+                              reason: 'self_heal_identity_mismatch',
+                          });
+                          logDebug_ACU('[交火模式纪要索引] 已入队自愈重对齐（身份/校验不匹配）。');
+                      }
+                      catch (enqueueError) {
+                          logWarn_ACU('[交火模式纪要索引] 自愈重对齐入队失败:', enqueueError);
+                      }
+                      logWarn_ACU('[交火模式纪要索引] 外置向量文件校验失败，已清空缓存并入队重对齐，本轮跳过注入:', message);
+                      return { success: false, skipped: true, reason: 'vector_index_corrupted_rebuild_required' };
+                  }
+                  // S1a 成功：chunks 已就绪，跳出 catch 继续后续注入流程。
+              }
+              else {
+                  throw error;
               }
-              throw error;
+          }
+      }
+      if (isSummaryVectorIndexDirtyForRealign_ACU()) {
+          // 存在未对齐的删除/滑动改动：本轮若命中不匹配已由上方 S1 兜底对齐并清脏；
+          // 否则脏标保留，推迟到下次填表归档时由归档流程清除（懒对齐）。
+          logDebug_ACU('[交火模式纪要索引] 检测到待对齐脏标（将于发送前 S1 兜底或下次填表归档时清除）。');
+      }
+      if (liveRowByKey_ACU && Array.isArray(chunks) && chunks.length > 0) {
+          // [A·脏分片防护] 丢弃陈旧 chunk，使其不参与本轮向量打分/重排：
+          //   · 行已删 → 该行全部 chunk 丢弃；
+          //   · 行内容已变(reroll) → 旧向量与新文本不符，该行 chunk 本轮全丢，下次填表重算后自然回到候选。
+          // 判定方式：该行已存 chunk 文本按序拼接，与实时 vectorSourceText 经同一拆句器
+          // （splitSentences_ACU，与归档 chunkTextBySentenceCount_ACU 同源）拼接后比对（均归一化去空白）。
+          // 走同一拆句器可避免「连续分隔符(如！？/。。)被丢弃」造成的误判，相等即未变、可信旧向量。
+          const stripForCompare_ACU = (text) => normalizeText_ACU$1(String(text || '')).replace(/\s+/g, '');
+          const chunksByRowKey_ACU = new Map();
+          chunks.forEach((chunk) => {
+              if (!chunk || typeof chunk.rowKey !== 'string' || !chunk.rowKey)
+                  return;
+              const list = chunksByRowKey_ACU.get(chunk.rowKey) || [];
+              list.push(chunk);
+              chunksByRowKey_ACU.set(chunk.rowKey, list);
+          });
+          const staleRowKeys_ACU = new Set();
+          chunksByRowKey_ACU.forEach((rowChunks, rowKey) => {
+              const live = liveRowByKey_ACU.get(rowKey);
+              if (!live) {
+                  staleRowKeys_ACU.add(rowKey);
+                  return;
+              }
+              const joined = rowChunks
+                  .slice()
+                  .sort((left, right) => (Number(left.sequence) || 0) - (Number(right.sequence) || 0)
+                      || String(left.chunkId || '').localeCompare(String(right.chunkId || '')))
+                  .map((chunk) => chunk.text || '')
+                  .join('');
+              const liveJoined = splitSentences_ACU(live.vectorSourceText).join('');
+              if (stripForCompare_ACU(joined) !== stripForCompare_ACU(liveJoined))
+                  staleRowKeys_ACU.add(rowKey);
+          });
+          if (staleRowKeys_ACU.size > 0) {
+              const beforeCount = chunks.length;
+              chunks = chunks.filter((chunk) => !staleRowKeys_ACU.has(chunk.rowKey));
+              logDebug_ACU(`[交火模式纪要索引] A·脏分片防护：剔除 ${staleRowKeys_ACU.size} 行的陈旧/已删 chunk（${beforeCount}→${chunks.length}），待下次填表重算后回到候选。`);
           }
       }
       if (chunks.length === 0) {
@@ -52402,6 +52980,21 @@
                               }
                               // [修复] 重新合并数据并更新UI和世界书
                               await refreshMergedDataAndNotifyWithUI_ACU();
+                              // [S2] 删除/滑动(reroll)后「标脏 + 懒对齐」：
+                              // 仅在交火全局开启且已存在索引指针时，标记索引为「待对齐」，不立即上传。
+                              // 真正的对齐推迟到下次填表归档（顺带清脏）或下次发送前由 S1 兜底自然发生，
+                              // 因此「连续 reroll/删 N 次」本身不产生任何额外上传，「+ 填表 1 次」也只上传 1 次。
+                              try {
+                                  if (globalMeta_ACU?.summaryVectorIndexModeGlobal === true) {
+                                      const realignSnapshot = getLatestSummaryVectorIndexSnapshotState_ACU();
+                                      if (realignSnapshot?.summaryVectorIndexState?.manifest) {
+                                          markSummaryVectorIndexDirtyForRealign_ACU(`chat_modified_${evName.toLowerCase()}`);
+                                      }
+                                  }
+                              }
+                              catch (realignError) {
+                                  logWarn_ACU('[交火模式纪要索引] 删除/滑动后标脏失败:', realignError);
+                              }
                           }, 500)); // 使用防抖处理快速滑动
                       });
                   }
@@ -87392,6 +87985,8 @@
           keywordApiPreset: defaults.keywordApiPreset || '',
           keywordContextPairCount: defaults.keywordContextPairCount,
           keywordGenerationMaxAttempts: defaults.keywordGenerationMaxAttempts,
+          summaryIndexRollingDeltaEnabled: defaults.summaryIndexRollingDeltaEnabled === true,
+          summaryIndexRollingDeltaFoldThreshold: defaults.summaryIndexRollingDeltaFoldThreshold ?? 15,
       };
   }
   function cloneSegments(segments) {
@@ -87471,6 +88066,8 @@
           form.keywordApiPreset = config.keywordApiPreset || '';
           form.keywordContextPairCount = config.keywordContextPairCount;
           form.keywordGenerationMaxAttempts = config.keywordGenerationMaxAttempts;
+          form.summaryIndexRollingDeltaEnabled = config.summaryIndexRollingDeltaEnabled === true;
+          form.summaryIndexRollingDeltaFoldThreshold = config.summaryIndexRollingDeltaFoldThreshold;
           promptSegments.value = cloneSegments(config.keywordPromptGroup);
           promptDirty.value = false;
       }
@@ -87521,6 +88118,14 @@
           runValidation();
           pushSavedMessage();
       }
+      function setBooleanField(key, value) {
+          const next = value === true;
+          form[key] = next;
+          updateGlobalVectorMemoryConfigFields_ACU({ [key]: next });
+          saveSettings_ACU();
+          runValidation();
+          pushSavedMessage();
+      }
       function previewRecentFixedInjectCount(raw) {
           const value = Number(raw);
           form.recentFixedInjectCount = Number.isFinite(value) ? Math.floor(value) : 0;
@@ -87808,6 +88413,7 @@
           previewRecentFixedInjectCount,
           setApiField,
           setNumberField,
+          setBooleanField,
           setMinScore,
           addPromptSegment,
           deletePromptSegment,
@@ -87939,7 +88545,7 @@
               refreshAll();
           });
           useUiCloseGuard(confirmPromptClose);
-          const __returned__ = { dialogStore, vector, vectorApiConfig, devOptions, apiStore, followActiveApiLabel, keywordApiOptions, promptDrawerOpen, panelNavItems, ROLE_OPTIONS, promptSegmentsForView, keywordPromptEmpty, promptTemplateBadgeLabel, promptTemplateBadgeVariant, confirmPromptClose, onPromptUpdate, refreshAll, saveVectorApiConfig, onDeleteCurrentIndex, AcuBadge, AcuButton, AcuFormRow, AcuInput, AcuMessage, AcuMobilePanelNav, AcuPanel, AcuPanelGrid, AcuSelect, AcuStatsList, VectorIndexPromptDrawer, get vectorIndexCopy() { return vectorIndexCopy; } };
+          const __returned__ = { dialogStore, vector, vectorApiConfig, devOptions, apiStore, followActiveApiLabel, keywordApiOptions, promptDrawerOpen, panelNavItems, ROLE_OPTIONS, promptSegmentsForView, keywordPromptEmpty, promptTemplateBadgeLabel, promptTemplateBadgeVariant, confirmPromptClose, onPromptUpdate, refreshAll, saveVectorApiConfig, onDeleteCurrentIndex, AcuBadge, AcuButton, AcuFormRow, AcuInput, AcuMessage, AcuMobilePanelNav, AcuPanel, AcuPanelGrid, AcuSelect, AcuStatsList, AcuToggle, VectorIndexPromptDrawer, get vectorIndexCopy() { return vectorIndexCopy; } };
           Object.defineProperty(__returned__, '__isScriptSetup', { enumerable: false, value: true });
           return __returned__;
       }
@@ -88394,6 +89000,27 @@
               onChange: _cache[19] || (_cache[19] = ($event) => $setup.vector.setNumberField("summaryIndexArchiveMaxConcurrency", $event))
             }, null, 8, ["model-value"])]),
             _: 1
+          }), createVNode($setup["AcuFormRow"], {
+            label: "滚动增量",
+            hint: "开启后每楼只上传变更的 ≤K 行增量，基线仅在折叠时重写，可省约 96% 带宽；关闭则用单文件 + float32 快照。仅影响之后新归档的写入格式，读取两种格式自动兼容。与控制台 ACU_setCrossfireRollingDelta 共用同一开关。"
+          }, {
+            default: withCtx(() => [createVNode($setup["AcuToggle"], {
+              "model-value": $setup.vector.form.summaryIndexRollingDeltaEnabled,
+              "onUpdate:modelValue": _cache[34] || (_cache[34] = ($event) => $setup.vector.setBooleanField("summaryIndexRollingDeltaEnabled", $event))
+            }, null, 8, ["model-value"])]),
+            _: 1
+          }), createVNode($setup["AcuFormRow"], {
+            label: "折叠阈值 K",
+            hint: "滚动增量累计达到 K 行变更时折叠进基线并重写一次基线。K 越大上传越省、折叠越少（单次基线越大）；不影响文件数（恒为 2）。默认 15，仅在启用滚动增量时生效。"
+          }, {
+            default: withCtx(() => [createVNode($setup["AcuInput"], {
+              "model-value": $setup.vector.form.summaryIndexRollingDeltaFoldThreshold,
+              type: "number",
+              min: 1,
+              step: 1,
+              onChange: _cache[35] || (_cache[35] = ($event) => $setup.vector.setNumberField("summaryIndexRollingDeltaFoldThreshold", $event))
+            }, null, 8, ["model-value"])]),
+            _: 1
           })])]),
           _: 1
         }, 8, ["title", "description"])]),
