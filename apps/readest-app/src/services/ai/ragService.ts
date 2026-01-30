import { embed, embedMany } from 'ai';
import { fetch } from '@tauri-apps/plugin-http';
import { aiStore } from './storage/aiStore';
import { chunkSection, extractTextFromDocument } from './utils/chunker';
import { withRetryAndTimeout, AI_TIMEOUTS, AI_RETRY_CONFIGS } from './utils/retry';
import { getAIProvider } from './providers';
import { aiLogger } from './logger';
import { BookDoc } from '@/libs/document';
import type { AISettings, TextChunk, ScoredChunk, EmbeddingProgress, BookIndexMeta } from './types';

const indexingStates = new Map<string, IndexingState>();

async function fetchOpenAIEmbeddings(
  settings: AISettings,
  texts: string[],
  abortSignal?: AbortSignal,
): Promise<number[][]> {
  const modelId = settings.openAiEmbeddingModel || 'text-embedding-3-small';
  const baseUrl = settings.openAiBaseUrl || 'https://api.openai.com/v1';
  const url = baseUrl.endsWith('/v1')
    ? baseUrl + '/embeddings'
    : baseUrl.replace(/\/+$/, '') + '/embeddings';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openAiApiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      input: texts,
      encoding_format: 'float',
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Embedding ${response.status}: ${errText}`);
  }
  const data = (await response.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function isBookIndexed(bookHash: string): Promise<boolean> {
  const indexed = await aiStore.isIndexed(bookHash);
  aiLogger.rag.isIndexed(bookHash, indexed);
  return indexed;
}

function extractTitle(metadata?: BookDoc['metadata']): string {
  if (!metadata?.title) return 'Unknown Book';
  if (typeof metadata.title === 'string') return metadata.title;
  // Handle LanguageMap: it has keys like 'en', 'default' or others
  // The type is defined in utils/book usually, assuming it allows string index
  const titleObj = metadata.title as Record<string, string>;
  return titleObj['en'] || titleObj['default'] || Object.values(titleObj)[0] || 'Unknown Book';
}

function extractAuthor(metadata?: BookDoc['metadata']): string {
  if (!metadata?.author) return 'Unknown Author';
  if (typeof metadata.author === 'string') return metadata.author;

  // Contributor interface has name: LanguageMap
  const contributor = metadata.author as { name: Record<string, string> };
  const nameMap = contributor.name;

  return nameMap['en'] || nameMap['default'] || Object.values(nameMap)[0] || 'Unknown Author';
}

function getChapterTitle(toc: BookDoc['toc'], sectionIndex: number): string {
  if (!toc || toc.length === 0) return `Section ${sectionIndex + 1}`;
  for (let i = toc.length - 1; i >= 0; i--) {
    if (toc[i]!.id <= sectionIndex) return toc[i]!.label;
  }
  return toc[0]?.label || `Section ${sectionIndex + 1}`;
}

export async function indexBook(
  bookDoc: BookDoc,
  bookHash: string,
  settings: AISettings,
  onProgress?: (progress: EmbeddingProgress) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const startTime = Date.now();
  const title = extractTitle(bookDoc.metadata);

  if (await aiStore.isIndexed(bookHash)) {
    aiLogger.rag.isIndexed(bookHash, true);
    return;
  }

  aiLogger.rag.indexStart(bookHash, title);
  const provider = getAIProvider(settings);
  const sections = bookDoc.sections || [];
  const toc = bookDoc.toc || [];

  // calculate cumulative character sizes like toc.ts does
  const sizes = sections.map((s) => (s.linear !== 'no' && s.size > 0 ? s.size : 0));
  let cumulative = 0;
  const cumulativeSizes = sizes.map((size) => {
    const current = cumulative;
    cumulative += size;
    return current;
  });

  const state: IndexingState = {
    bookHash,
    status: 'indexing',
    progress: 0,
    chunksProcessed: 0,
    totalChunks: 0,
  };
  indexingStates.set(bookHash, state);

  try {
    if (abortSignal?.aborted) throw new Error('Indexing aborted');

    onProgress?.({ current: 0, total: 1, phase: 'chunking' });
    aiLogger.rag.indexProgress('chunking', 0, sections.length);
    const allChunks: TextChunk[] = [];

    for (let i = 0; i < sections.length; i++) {
      if (abortSignal?.aborted) throw new Error('Indexing aborted');
      const section = sections[i]!;
      try {
        const doc = await section.createDocument();
        const text = extractTextFromDocument(doc);
        if (text.length < 100) continue;
        const sectionChunks = chunkSection(
          doc,
          i,
          getChapterTitle(toc, i),
          bookHash,
          cumulativeSizes[i] ?? 0,
        );
        aiLogger.chunker.section(i, text.length, sectionChunks.length);
        allChunks.push(...sectionChunks);
      } catch (e) {
        aiLogger.chunker.error(i, (e as Error).message);
      }
    }

    aiLogger.chunker.complete(bookHash, allChunks.length);
    state.totalChunks = allChunks.length;

    if (allChunks.length === 0) {
      state.status = 'complete';
      state.progress = 100;
      aiLogger.rag.indexComplete(bookHash, 0, Date.now() - startTime);
      return;
    }

    if (abortSignal?.aborted) throw new Error('Indexing aborted');

    onProgress?.({ current: 0, total: allChunks.length, phase: 'embedding' });
    const embeddingModelName =
      settings.provider === 'ollama'
        ? settings.ollamaEmbeddingModel
        : settings.provider === 'openai'
          ? settings.openAiEmbeddingModel || 'text-embedding-3-small'
          : settings.aiGatewayEmbeddingModel || 'text-embedding-3-small';
    aiLogger.embedding.start(embeddingModelName, allChunks.length);

    const texts = allChunks.map((c) => c.text);
    try {
      let embeddings: number[][] = [];

      if (settings.provider === 'openai') {
        const BATCH_SIZE = 5;
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          if (abortSignal?.aborted) throw new Error('Indexing aborted');
          const batch = texts.slice(i, i + BATCH_SIZE);

          const batchEmbeddings = await withRetryAndTimeout(
            async () => {
              const modelId = settings.openAiEmbeddingModel || 'text-embedding-3-small';
              const baseUrl = settings.openAiBaseUrl || 'https://api.openai.com/v1';
              const url = baseUrl.endsWith('/v1')
                ? baseUrl + '/embeddings'
                : baseUrl.replace(/\/+$/, '') + '/embeddings';

              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${settings.openAiApiKey}`,
                },
                body: JSON.stringify({
                  model: modelId,
                  input: batch,
                  encoding_format: 'float',
                }),
                signal: abortSignal,
              });

              if (!response.ok) {
                const errText = await response.text();
                throw new Error(`OpenAI Embedding ${response.status}: ${errText}`);
              }
              const data = (await response.json()) as {
                data: Array<{ embedding: number[]; index: number }>;
              };
              return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
            },
            AI_TIMEOUTS.EMBEDDING_BATCH,
            AI_RETRY_CONFIGS.EMBEDDING,
          );

          embeddings.push(...batchEmbeddings);

          // Update progress roughly
          const currentProcessed = i + batch.length;
          onProgress?.({
            current: currentProcessed,
            total: texts.length,
            phase: 'embedding',
          });
        }
      } else {
        const result = await withRetryAndTimeout(
          () =>
            embedMany({
              model: provider.getEmbeddingModel(),
              values: texts,
              abortSignal, // Pass the signal to embedMany
            }),
          AI_TIMEOUTS.EMBEDDING_BATCH,
          AI_RETRY_CONFIGS.EMBEDDING,
        );
        embeddings = result.embeddings;
      }

      if (abortSignal?.aborted) throw new Error('Indexing aborted');

      for (let i = 0; i < allChunks.length; i++) {
        allChunks[i]!.embedding = embeddings[i];
        state.chunksProcessed = i + 1;
        state.progress = Math.round(((i + 1) / allChunks.length) * 100);
      }
      onProgress?.({ current: allChunks.length, total: allChunks.length, phase: 'embedding' });
      aiLogger.embedding.complete(embeddings.length, allChunks.length, embeddings[0]?.length || 0);
    } catch (e) {
      if ((e as Error).message === 'Indexing aborted' || (e as Error).name === 'AbortError') {
        throw e;
      }
      // If embedding fails (e.g. 401, quota exceeded), we log it but proceed to save text-only chunks.
      // This allows the app to function using BM25 (Keyword Search) locally.
      aiLogger.embedding.error(
        'batch',
        `Embedding failed, falling back to Keyword Index only: ${(e as Error).message}`,
      );
      // We do NOT throw here, so execution continues to saveChunks/saveBM25
    }

    if (abortSignal?.aborted) throw new Error('Indexing aborted');

    onProgress?.({ current: 0, total: 2, phase: 'indexing' });
    aiLogger.store.saveChunks(bookHash, allChunks.length);
    await aiStore.saveChunks(allChunks);

    onProgress?.({ current: 1, total: 2, phase: 'indexing' });
    aiLogger.store.saveBM25(bookHash);
    await aiStore.saveBM25Index(bookHash, allChunks);

    const meta: BookIndexMeta = {
      bookHash,
      bookTitle: title,
      authorName: extractAuthor(bookDoc.metadata),
      totalSections: sections.length,
      totalChunks: allChunks.length,
      embeddingModel: embeddingModelName,
      lastUpdated: Date.now(),
    };
    aiLogger.store.saveMeta(meta);
    await aiStore.saveMeta(meta);

    onProgress?.({ current: 2, total: 2, phase: 'indexing' });
    state.status = 'complete';
    state.progress = 100;
    aiLogger.rag.indexComplete(bookHash, allChunks.length, Date.now() - startTime);
  } catch (error) {
    state.status = 'error';
    state.error = (error as Error).message;
    aiLogger.rag.indexError(bookHash, (error as Error).message);
    // clean up if aborted or error?
    // Maybe we should clear the partial index or just leave it.
    // For now, simple error reporting.
    throw error;
  }
}

export async function hybridSearch(
  bookHash: string,
  query: string,
  settings: AISettings,
  topK = 10,
  maxPage?: number,
): Promise<ScoredChunk[]> {
  aiLogger.search.query(query, maxPage);
  const provider = getAIProvider(settings);
  let queryEmbedding: number[] | null = null;

  try {
    if (settings.provider === 'openai') {
      const embeddings = await withRetryAndTimeout(
        () => fetchOpenAIEmbeddings(settings, [query]),
        AI_TIMEOUTS.EMBEDDING_SINGLE,
        AI_RETRY_CONFIGS.EMBEDDING,
      );
      queryEmbedding = embeddings[0] || null;
    } else {
      // use AI SDK embed with provider's embedding model
      const { embedding } = await withRetryAndTimeout(
        () =>
          embed({
            model: provider.getEmbeddingModel(),
            value: query,
          }),
        AI_TIMEOUTS.EMBEDDING_SINGLE,
        AI_RETRY_CONFIGS.EMBEDDING,
      );
      queryEmbedding = embedding;
    }
  } catch {
    // bm25 only fallback
  }

  const results = await aiStore.hybridSearch(bookHash, queryEmbedding, query, topK, maxPage);
  aiLogger.search.hybridResults(results.length, [...new Set(results.map((r) => r.searchMethod))]);
  return results;
}

export async function getPageContextChunks(
  bookHash: string,
  pageNumber: number,
): Promise<ScoredChunk[]> {
  const chunks = await aiStore.getChunksForPage(bookHash, pageNumber);
  return chunks.map((c) => ({
    ...c,
    score: 2.0, // prioritize explicit page context
    searchMethod: 'context',
  }));
}

export async function getChapterContextChunks(
  bookHash: string,
  pageNumber: number,
): Promise<ScoredChunk[]> {
  const pageChunks = await aiStore.getChunksForPage(bookHash, pageNumber);
  if (pageChunks.length === 0) return [];

  // Assuming all chunks on a page belong to the same section (mostly true)
  // We take the first chunk's sectionIndex
  const sectionIndex = pageChunks[0]!.sectionIndex;

  const sectionChunks = await aiStore.getChunksForSection(bookHash, sectionIndex);

  return sectionChunks.map((c) => ({
    ...c,
    score: 2.0, // prioritize explicit context
    searchMethod: 'context',
  }));
}

export async function clearBookIndex(bookHash: string): Promise<void> {
  aiLogger.store.clear(bookHash);
  await aiStore.clearBook(bookHash);
  indexingStates.delete(bookHash);
}

// internal type for indexing state tracking
interface IndexingState {
  bookHash: string;
  status: 'idle' | 'indexing' | 'complete' | 'error';
  progress: number;
  chunksProcessed: number;
  totalChunks: number;
  error?: string;
}
