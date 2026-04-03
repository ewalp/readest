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
  promptMode?: 'standard' | 'devil' | 'feynman' | 'radar' | 'discussion';
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
      const { settings, bookHash, bookTitle, authorName, currentPage, currentSectionIndex } =
        options;
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

          // Merge and deduplicate (prefer contextChunks)
          const seen = new Set<string>();
          chunks = [];

          for (const c of contextChunks) {
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

      const systemPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, options.promptMode);

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

        async function* streamSingleTurn(sysPrompt: string, baseMessages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>): AsyncGenerator<string> {
          if (useApiRoute) {
            for await (const chunk of streamViaApiRoute(baseMessages, sysPrompt, settings, abortSignal)) {
              yield chunk;
            }
          } else if (settings.provider === 'openai') {
            console.log('[TauriAdapter] Using manual OpenAI streamChat...');
            const openAIProvider = provider as OpenAIProvider;
            if (typeof openAIProvider.streamChat !== 'function') {
              throw new Error('OpenAI Provider missing streamChat method');
            }
            try {
              for await (const chunk of openAIProvider.streamChat(baseMessages, sysPrompt, abortSignal)) {
                yield chunk;
              }
            } catch (err) {
              const error = err as Error;
              const isAbort = error.name === 'AbortError' || error.message?.includes('cancelled') || error.message?.includes('Aborted');
              if (isAbort) throw err;
              console.error('[TauriAdapter] Manual stream failed:', err);
              throw err;
            }
          } else {
            try {
              console.log('[TauriAdapter] calling streamText...');
              const result = streamText({
                model: provider.getModel(),
                system: sysPrompt,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                messages: baseMessages as any,
                abortSignal,
              });
              let hasChunks = false;
              for await (const chunk of result.textStream) {
                if (!hasChunks) console.log('[TauriAdapter] Received first chunk:', chunk);
                hasChunks = true;
                yield chunk;
              }
              if (!hasChunks) throw new Error('No content received from stream');
            } catch (streamError) {
              console.error('[TauriAdapter] Streaming failed:', streamError);
              const { generateText } = await import('ai');
              console.log('[TauriAdapter] Retrying with generateText...');
              const result = await generateText({
                model: provider.getModel(),
                system: sysPrompt,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                messages: baseMessages as any,
                abortSignal,
              });
              console.log('[TauriAdapter] generateText success. Length:', result.text.length);
              yield result.text;
            }
          }
        }

        if (options.promptMode === 'discussion') {
          let discussionLog = "";

          const students = [
            { name: '【学生各抒己见】杠精 哪吒', desc: '杠精 哪吒 (The Skeptic): 挑剔、严谨、偏执。寻找逻辑漏洞，挑战结论，迫使给出底层解释。' },
            { name: '【学生各抒己见】类比达人 沙悟净', desc: '类比达人 沙悟净 (The Analogist): 思维跳跃、幽默。将复杂概念转化为通俗易懂的类比。' },
            { name: '【学生各抒己见】实战派 孙悟空', desc: '实战派 孙悟空 (The Pragmatist): 高效、结果导向。关注落地、性能损耗和行业最佳实践。' },
            { name: '【学生各抒己见】提问机器 猪八戒', desc: '提问机器 猪八戒 (The Curious Newbie): 纯真、执着。简化问题，定位核心基础知识。' }
          ];

          for (const role of students) {
            const header = `### ${role.name}\n\n`;
            text += header;
            yield { content: [{ type: 'text', text }] };

            const roleSysPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, 'discussion_student', role.desc, discussionLog);
            let roleOutput = "";

            for await (const chunk of streamSingleTurn(roleSysPrompt, aiMessages)) {
              text += chunk;
              roleOutput += chunk;
              yield { content: [{ type: 'text', text }] };
            }

            discussionLog += `${header}${roleOutput}\n\n`;
            text += '\n\n---\n\n';
            yield { content: [{ type: 'text', text }] };
          }

          const crossfireHeader = `### 【全开麦】激烈交锋\n\n`;
          text += crossfireHeader;
          yield { content: [{ type: 'text', text }] };
          
          const crossfireSysPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, 'discussion_crossfire', undefined, discussionLog);
          let crossfireOutput = "";

          for await (const chunk of streamSingleTurn(crossfireSysPrompt, aiMessages)) {
            text += chunk;
            crossfireOutput += chunk;
            yield { content: [{ type: 'text', text }] };
          }

          discussionLog += `${crossfireHeader}${crossfireOutput}\n\n`;
          text += '\n\n---\n\n';
          yield { content: [{ type: 'text', text }] };

          const teacherHeader = `### 【导师总结与逐一点评】智多星 诸葛亮\n\n`;
          text += teacherHeader;
          yield { content: [{ type: 'text', text }] };

          const teacherSysPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage, 'discussion_teacher', undefined, discussionLog);
          
          for await (const chunk of streamSingleTurn(teacherSysPrompt, aiMessages)) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
          }
        } else {
          for await (const chunk of streamSingleTurn(systemPrompt, aiMessages)) {
            text += chunk;
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
