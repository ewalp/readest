import { streamText } from 'ai';
import type { ChatModelAdapter, ChatModelRunResult } from '@assistant-ui/react';
import { getAIProvider } from '../providers';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { hybridSearch, isBookIndexed, getPageContextChunks } from '../ragService';
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
}

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

export function createTauriAdapter(getOptions: () => TauriAdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }): AsyncGenerator<ChatModelRunResult> {
      const options = getOptions();
      const { settings, bookHash, bookTitle, authorName, currentPage } = options;
      const provider = getAIProvider(settings);
      let chunks: ScoredChunk[] = [];

      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
      const query =
        lastUserMessage?.content
          ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join(' ') || '';

      aiLogger.chat.send(query.length, false);

      if (await isBookIndexed(bookHash)) {
        try {
          const [pageChunks, searchChunks] = await Promise.all([
            getPageContextChunks(bookHash, currentPage),
            hybridSearch(
              bookHash,
              query,
              settings,
              settings.maxContextChunks || 5,
              settings.spoilerProtection ? currentPage : undefined,
            ),
          ]);

          // Merge and deduplicate (prefer pageChunks)
          const seen = new Set<string>();
          chunks = [];

          for (const c of pageChunks) {
            chunks.push(c);
            seen.add(c.id);
          }

          for (const c of searchChunks) {
            if (!seen.has(c.id)) {
              chunks.push(c);
              seen.add(c.id);
            }
          }

          aiLogger.chat.context(chunks.length, chunks.map((c) => c.text).join('').length);
          lastSources = chunks;
        } catch (e) {
          aiLogger.chat.error(`RAG failed: ${(e as Error).message}`);
          lastSources = [];
        }
      } else {
        lastSources = [];
      }

      const systemPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage);

      const aiMessages = messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
      }));

      try {
        const useApiRoute = typeof window !== 'undefined' && settings.provider === 'ai-gateway';

        let text = '';
        console.log('[TauriAdapter] Starting chat request. Provider:', settings.provider);

        if (useApiRoute) {
          for await (const chunk of streamViaApiRoute(
            aiMessages,
            systemPrompt,
            settings,
            abortSignal,
          )) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
          }
        } else if (settings.provider === 'openai') {
          // Manual implementation for OpenAI to bypass SDK issues
          console.log('[TauriAdapter] Using manual OpenAI streamChat...');

          // Cast to OpenAIProvider to access the new method we just added
          const openAIProvider = provider as OpenAIProvider;

          try {
            if (typeof openAIProvider.streamChat !== 'function') {
              throw new Error('OpenAI Provider missing streamChat method');
            }

            for await (const chunk of openAIProvider.streamChat(
              aiMessages,
              systemPrompt,
              abortSignal,
            )) {
              text += chunk;
              yield { content: [{ type: 'text', text }] };
            }
          } catch (err) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const error = err as any;

            const isAbort =
              error.name === 'AbortError' ||
              error.message?.includes('cancelled') ||
              error.message?.includes('Aborted');

            if (isAbort) {
              console.log('[TauriAdapter] Manual stream aborted');
              throw error; // Re-throw to be caught by outer block
            }

            console.error('[TauriAdapter] Manual stream failed:', error);
            alert('Chat Error: ' + (error.message || 'Unknown error'));
            throw error;
          }
        } else {
          try {
            // First try streaming (Ollama, etc)
            console.log('[TauriAdapter] calling streamText...');
            const result = streamText({
              model: provider.getModel(),
              system: systemPrompt,
              messages: aiMessages,
              abortSignal,
            });

            let hasChunks = false;
            for await (const chunk of result.textStream) {
              if (!hasChunks) console.log('[TauriAdapter] Received first chunk:', chunk);
              hasChunks = true;
              text += chunk;
              yield { content: [{ type: 'text', text }] };
            }
            console.log('[TauriAdapter] Stream finished. Total length:', text.length);

            // If streaming yielded no chunks, it might be a non-streaming API that behaving oddly with streamText
            // or simply empty. If empty, we can't do much.
            if (!hasChunks && text.length === 0) {
              console.error('[TauriAdapter] No content received from stream');
              throw new Error('No content received from stream');
            }
          } catch (streamError) {
            console.error('[TauriAdapter] Streaming failed:', streamError);
            // If streaming fails (e.g. API doesn't support SSE), try non-streaming generateText
            // This is common with some internal/custom OpenAI-compatible endpoints
            aiLogger.chat.error(
              `Streaming failed, retrying with generateText: ${(streamError as Error).message}`,
            );

            // Re-import generateText dynamically or assume it's available from 'ai'
            const { generateText } = await import('ai');

            console.log('[TauriAdapter] Retrying with generateText...');
            const result = await generateText({
              model: provider.getModel(),
              system: systemPrompt,
              messages: aiMessages,
              abortSignal,
            });

            text = result.text;
            console.log('[TauriAdapter] generateText success. Length:', text.length);
            yield { content: [{ type: 'text', text }] };
          }
        }

        aiLogger.chat.complete(text.length);
      } catch (error) {
        const err = error as Error;
        const isAbort =
          err.name === 'AbortError' ||
          err.message?.includes('cancelled') ||
          err.message?.includes('Aborted');

        if (!isAbort) {
          const errMsg = err.message;
          console.error('[TauriAdapter] Critical Chat Error:', error);
          aiLogger.chat.error(errMsg);
          // VISIBLE ERROR FOR DEBUGGING:
          alert(`Chat Error: ${errMsg}\n\nPlease check console for details.`);
          throw error;
        }
      }
    },
  };
}
