import { streamText } from 'ai';
import type { ChatModelAdapter, ChatModelRunResult } from '@assistant-ui/react';
import { getAIProvider } from '../providers';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { hybridSearch, isBookIndexed, getChapterContextChunks } from '../ragService';
import { aiLogger } from '../logger';
import { buildSystemPrompt } from '../prompts';
import type { AISettings, ScoredChunk } from '../types';

let lastSources: ScoredChunk[] = [];

export function getLastSources(): ScoredChunk[] {
  return lastSources;
}

export function clearLastSources(): void {
  lastSources = [];
}

interface TauriAdapterOptions {
  settings: AISettings;
  bookHash: string;
  bookTitle: string;
  authorName: string;
  currentPage: number;
  currentSectionIndex: number;
  promptMode?: 'standard' | 'devil' | 'feynman' | 'radar' | 'discussion' | 'knowledge';
}

// ========== Background Stream Infrastructure ==========

/**
 * Async queue for push/pull communication between background stream and UI generator.
 * The background stream pushes chunks; the UI generator pulls them via async iteration.
 * When the UI stops pulling (unmount), chunks accumulate in the buffer.
 * When a new UI generator starts pulling (remount), it gets buffered chunks first.
 */
class ChunkQueue {
  private buffer: string[] = [];
  private waiter: ((value: string | null) => void) | null = null;
  private _done = false;

  push(chunk: string) {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(chunk);
    } else {
      this.buffer.push(chunk);
    }
  }

  finish() {
    this._done = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }

  get done() { return this._done; }

  async next(): Promise<string | null> {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }
    if (this._done) return null;
    return new Promise<string | null>((resolve) => {
      this.waiter = resolve;
    });
  }
}

interface BackgroundStream {
  bookHash: string;
  queue: ChunkQueue;
  fullText: string;
  isComplete: boolean;
  abortController: AbortController;
}

let bgStream: BackgroundStream | null = null;

/** Cancel the active background stream (e.g. when switching books) */
export function cancelBackgroundStream() {
  if (bgStream) {
    console.log('[BackgroundStream] Cancelling active stream for book:', bgStream.bookHash);
    bgStream.abortController.abort();
    bgStream.queue.finish();
    bgStream = null;
  }
}

/** Get the active background stream state (for resume on remount) */
export function getBackgroundStream(): BackgroundStream | null {
  return bgStream;
}

/** Clear the background stream reference after it's been consumed */
export function clearBackgroundStream() {
  bgStream = null;
}

// ========== Streaming Helpers ==========

async function* streamViaApiRoute(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  settings: AISettings,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      system: systemPrompt,
      apiKey: settings.aiGatewayApiKey,
      model: settings.aiGatewayModel || 'google/gemini-2.5-flash-lite',
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Chat failed: ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

// ========== Background Stream Runner ==========

/**
 * Runs a single streaming turn (with [CONTINUE] auto-loop) and pushes chunks to the queue.
 * Uses its OWN AbortController, not the runtime's, so it survives component unmounts.
 */
async function runStreamSingleTurn(
  stream: BackgroundStream,
  bgAbortSignal: AbortSignal,
  sysPrompt: string,
  baseMessages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>,
  settings: AISettings,
  provider: ReturnType<typeof getAIProvider>,
  useApiRoute: boolean,
): Promise<void> {
  let currentMessages = [...baseMessages];
  let keepGoing = true;

  while (keepGoing) {
    if (bgAbortSignal.aborted) return;

    let turnText = '';
    let buffer = '';
    const tailLength = 15;

    // Create the raw stream using the BACKGROUND abort signal
    let rawStream: AsyncGenerator<string>;
    if (useApiRoute) {
      rawStream = streamViaApiRoute(currentMessages, sysPrompt, settings, bgAbortSignal);
    } else if (settings.provider === 'openai') {
      const openAIProvider = provider as OpenAIProvider;
      if (typeof openAIProvider.streamChat !== 'function') {
        throw new Error('OpenAI Provider missing streamChat method');
      }
      rawStream = openAIProvider.streamChat(currentMessages, sysPrompt, bgAbortSignal);
    } else {
      rawStream = (async function* () {
        try {
          const result = streamText({
            model: provider.getModel(),
            system: sysPrompt,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: currentMessages as any,
            abortSignal: bgAbortSignal,
          });
          let hasChunks = false;
          for await (const chunk of result.textStream) {
            hasChunks = true;
            yield chunk;
          }
          if (!hasChunks) throw new Error('No content received from stream');
        } catch (streamError) {
          const sErr = streamError as Error;
          const isAbort = sErr.name === 'AbortError' || sErr.message?.includes('cancelled') || sErr.message?.includes('Aborted');
          if (isAbort) return;
          console.error('[BackgroundStream] Streaming failed:', streamError);
          const { generateText } = await import('ai');
          const result = await generateText({
            model: provider.getModel(),
            system: sysPrompt,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: currentMessages as any,
            abortSignal: bgAbortSignal,
          });
          yield result.text;
        }
      })();
    }

    // Process the raw stream with buffer to detect [CONTINUE]
    for await (const chunk of rawStream) {
      if (bgAbortSignal.aborted) return;
      buffer += chunk;
      if (buffer.length > tailLength) {
        const toYield = buffer.slice(0, -tailLength);
        buffer = buffer.slice(-tailLength);
        turnText += toYield;
        stream.fullText += toYield;
        stream.queue.push(toYield);
      }
    }

    if (bgAbortSignal.aborted) return;

    // Check for [CONTINUE] in the tail buffer
    if (buffer.includes('[CONTINUE]')) {
      const finalYield = buffer.replace('[CONTINUE]', '');
      if (finalYield) {
        turnText += finalYield;
        stream.fullText += finalYield;
        stream.queue.push(finalYield);
      }
      console.log('[BackgroundStream] Auto-continuing due to [CONTINUE] marker');
      currentMessages.push({ role: 'assistant', content: turnText });
      currentMessages.push({ role: 'user', content: '继续' });
      keepGoing = true;
    } else {
      if (buffer) {
        turnText += buffer;
        stream.fullText += buffer;
        stream.queue.push(buffer);
      }
      keepGoing = false;
    }
  }
}

/**
 * Runs the full streaming pipeline (standard or discussion mode) in the background.
 * Pushes all chunks to the queue. On completion, saves to the store.
 */
async function startBackgroundPipeline(
  stream: BackgroundStream,
  options: TauriAdapterOptions,
  systemPrompt: string,
  aiMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
  chunks: ScoredChunk[],
) {
  const { settings, bookTitle, authorName, currentPage } = options;
  const provider = getAIProvider(settings);
  const useApiRoute = typeof window !== 'undefined' && settings.provider === 'ai-gateway';
  const bgSignal = stream.abortController.signal;

  try {
    if (options.promptMode === 'discussion') {
      // Discussion mode: sequential student → crossfire → teacher pipeline
      let discussionLog = "";

      const students = [
        { name: '【学生各抒己见】逻辑杠精 独孤败天', desc: '逻辑杠精 独孤败天 (The Skeptic): 万古第一禁忌大神，严谨到恐怖的布局者。不相信任何现成结论，只问"这是天道的谎言吗？"。寻找逻辑死角，挑战权威定义，强迫进行深层推理。标志性口头禅："此法看似圆满，实则破绽百出。若天道反向运行，你这逻辑还站得住吗？"' },
        { name: '【学生各抒己见】类比达人 紫金神龙', desc: '类比达人 紫金神龙 (The Analogist): 满嘴"嗷呜"、痞气十足的老痞龙。思维跳跃、极其接地气、满脑子损招。最讨厌正经八百的理论，总能把高深概念比喻成最俗最搞笑的段子。标志性口头禅："嗷呜！这什么狗屁原理？说白了不就是……"' },
        { name: '【学生各抒己见】硬核实战 魔主', desc: '硬核实战 魔主 (The Pragmatist): 千古魔主，效率与力量的极致。霸道、冷酷、追求极致性能。不在乎过程多华丽，只在乎"能杀天吗？"。关注落地实践，剔除一切花架子。标志性口头禅："废话少说，告诉我这一招的杀伤力是多少？用不出来，那就是垃圾。"' },
        { name: '【学生各抒己见】提问机器 龙宝宝', desc: '提问机器 龙宝宝 (The Curious Newbie): 爱吃果子、人畜无害的小豆丁。纯真、执着、大智若愚。用最天真的语气问出最根本的问题。标志性口头禅："神说，偶听不懂。那个叫XX的东西，能吃吗？"' },
        { name: '【学生各抒己见】调皮学霸 辰南', desc: '调皮学霸 辰南 (The Innovator): 万古布局中的一线生机，不按常理出牌的天才。机灵、坚韧、擅长在绝境中找"外挂"。尊重规则但更擅长利用规则漏洞。标志性口头禅："按部就班太慢了，咱们直接挖它祖坟（底层源码），能不能拿到结果？"' }
      ];

      for (const role of students) {
        if (bgSignal.aborted) return;
        const header = `### ${role.name}\n\n`;
        stream.queue.push(header);
        stream.fullText += header;

        const roleSysPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, 'discussion_student', role.desc, discussionLog);
        const beforeLen = stream.fullText.length;
        await runStreamSingleTurn(stream, bgSignal, roleSysPrompt, aiMessages, settings, provider, useApiRoute);
        const roleOutput = stream.fullText.slice(beforeLen);
        discussionLog += `${header}${roleOutput}\n\n`;

        const sep = '\n\n---\n\n';
        stream.queue.push(sep);
        stream.fullText += sep;
      }

      if (bgSignal.aborted) return;

      const crossfireHeader = `### 【全开麦】激烈交锋\n\n`;
      stream.queue.push(crossfireHeader);
      stream.fullText += crossfireHeader;

      const crossfireSysPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, 'discussion_crossfire', undefined, discussionLog);
      const beforeCrossfire = stream.fullText.length;
      await runStreamSingleTurn(stream, bgSignal, crossfireSysPrompt, aiMessages, settings, provider, useApiRoute);
      const crossfireOutput = stream.fullText.slice(beforeCrossfire);
      discussionLog += `${crossfireHeader}${crossfireOutput}\n\n`;

      const sep2 = '\n\n---\n\n';
      stream.queue.push(sep2);
      stream.fullText += sep2;

      if (bgSignal.aborted) return;

      const teacherHeader = `### 【真相揭示】工藤新一\n\n`;
      stream.queue.push(teacherHeader);
      stream.fullText += teacherHeader;

      const teacherSysPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, 'discussion_teacher', undefined, discussionLog);
      await runStreamSingleTurn(stream, bgSignal, teacherSysPrompt, aiMessages, settings, provider, useApiRoute);
    } else {
      // Standard / other modes
      await runStreamSingleTurn(stream, bgSignal, systemPrompt, aiMessages, settings, provider, useApiRoute);
    }

    aiLogger.chat.complete(stream.fullText.length);
  } catch (error) {
    const err = error as Error;
    const isAbort = err.name === 'AbortError' || err.message?.includes('cancelled') || err.message?.includes('Aborted');
    if (!isAbort) {
      console.error('[BackgroundStream] Error:', error);
      aiLogger.chat.error(err.message);
    }
  } finally {
    stream.isComplete = true;
    stream.queue.finish();

    // Update the last assistant message in the store with the complete text
    // so history loads the full content when the component remounts
    if (stream.fullText && !bgSignal.aborted) {
      try {
        const { useAIChatStore } = await import('@/store/aiChatStore');
        const state = useAIChatStore.getState();
        if (state.activeConversationId && state.currentBookHash === stream.bookHash) {
          await state.updateLastAssistantMessage(stream.fullText);
          console.log('[BackgroundStream] Updated store with complete response, length:', stream.fullText.length);
        }
      } catch (e) {
        console.error('[BackgroundStream] Failed to update store:', e);
      }
    }
  }
}

// ========== Main Adapter ==========

export function createTauriAdapter(getOptions: () => TauriAdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages }): AsyncGenerator<ChatModelRunResult> {
      const options = getOptions();
      const { settings, bookHash, bookTitle, authorName, currentPage, currentSectionIndex } =
        options;
      let chunks: ScoredChunk[] = [];

      // Pre-create conversation if none exists
      const { useAIChatStore } = await import('@/store/aiChatStore');
      if (!useAIChatStore.getState().activeConversationId) {
        await useAIChatStore.getState().createConversation(bookHash, 'Chat');
      }

      // Check for existing background stream for the SAME book (component remount)
      if (bgStream && bgStream.bookHash === bookHash) {
        console.log('[TauriAdapter] Resuming background stream. Accumulated:', bgStream.fullText.length, 'chars');

        // Yield accumulated text immediately
        let text = bgStream.fullText;
        if (text) {
          yield { content: [{ type: 'text', text }] };
        }

        // If still streaming, keep reading new chunks
        if (!bgStream.isComplete) {
          let chunk = await bgStream.queue.next();
          while (chunk !== null) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
            chunk = await bgStream.queue.next();
          }
        }

        // Done — the background stream already saved to store
        bgStream = null;
        aiLogger.chat.complete(text.length);
        return;
      }

      // Cancel any background stream for a DIFFERENT book
      if (bgStream && bgStream.bookHash !== bookHash) {
        cancelBackgroundStream();
      }

      // ========== Normal flow: start new background stream ==========
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
      const query =
        lastUserMessage?.content
          ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join(' ') || '';

      aiLogger.chat.send(query.length, false);

      if (await isBookIndexed(bookHash)) {
        try {
          const [contextChunks, searchChunks] = await Promise.all([
            getChapterContextChunks(bookHash, currentSectionIndex),
            hybridSearch(
              bookHash,
              query,
              settings,
              settings.maxContextChunks || 5,
              settings.spoilerProtection ? currentPage : undefined,
            ),
          ]);

          const seen = new Set<string>();
          chunks = [];
          for (const c of contextChunks) { chunks.push(c); seen.add(c.id); }
          for (const c of searchChunks) { if (!seen.has(c.id)) { chunks.push(c); seen.add(c.id); } }

          aiLogger.chat.context(chunks.length, chunks.map((c) => c.text).join('').length);
          lastSources = chunks;
        } catch (e) {
          aiLogger.chat.error(`RAG failed: ${(e as Error).message}`);
          lastSources = [];
        }
      } else {
        lastSources = [];
      }

      const systemPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, options.promptMode);

      const aiMessages = messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
      }));

      // Create background stream with its own AbortController
      const bgAbortController = new AbortController();
      const queue = new ChunkQueue();
      const stream: BackgroundStream = {
        bookHash,
        queue,
        fullText: '',
        isComplete: false,
        abortController: bgAbortController,
      };
      bgStream = stream;

      // Start the background pipeline (fire and forget)
      startBackgroundPipeline(stream, options, systemPrompt, aiMessages, chunks);

      // Read from queue and yield to the runtime UI
      try {
        let text = '';
        let chunk = await queue.next();
        while (chunk !== null) {
          text += chunk;
          yield { content: [{ type: 'text', text }] };
          chunk = await queue.next();
        }

        // Stream completed while UI was connected — clear background state
        bgStream = null;
        aiLogger.chat.complete(text.length);
      } catch {
        // Generator was terminated (runtime called .return() on unmount)
        // Background stream continues running — we just stop yielding
        console.log('[TauriAdapter] UI disconnected, background stream continues for book:', bookHash);
      }
    },
  };
}
