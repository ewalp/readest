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

      // Pre-create conversation if none exists, to avoid race condition on first message
      const { useAIChatStore } = await import('@/store/aiChatStore');
      if (!useAIChatStore.getState().activeConversationId) {
        await useAIChatStore.getState().createConversation(bookHash, 'Chat');
      }

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
          let currentMessages = [...baseMessages];
          let keepGoing = true;

          while (keepGoing) {
            let turnText = '';
            let buffer = '';
            const tailLength = 15;

            async function* processRawStream(rawStream: AsyncGenerator<string>) {
              for await (const chunk of rawStream) {
                buffer += chunk;
                if (buffer.length > tailLength) {
                  const toYield = buffer.slice(0, -tailLength);
                  buffer = buffer.slice(-tailLength);
                  turnText += toYield;
                  yield toYield;
                }
              }
            }

            let rawStream: AsyncGenerator<string>;
            if (useApiRoute) {
              rawStream = streamViaApiRoute(currentMessages, sysPrompt, settings, abortSignal);
            } else if (settings.provider === 'openai') {
              console.log('[TauriAdapter] Using manual OpenAI streamChat...');
              const openAIProvider = provider as OpenAIProvider;
              if (typeof openAIProvider.streamChat !== 'function') {
                throw new Error('OpenAI Provider missing streamChat method');
              }
              rawStream = openAIProvider.streamChat(currentMessages, sysPrompt, abortSignal);
            } else {
              rawStream = (async function* () {
                try {
                  console.log('[TauriAdapter] calling streamText...');
                  const result = streamText({
                    model: provider.getModel(),
                    system: sysPrompt,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    messages: currentMessages as any,
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
                    messages: currentMessages as any,
                    abortSignal,
                  });
                  console.log('[TauriAdapter] generateText success. Length:', result.text.length);
                  yield result.text;
                }
              })();
            }

            for await (const chunk of processRawStream(rawStream)) {
              yield chunk;
            }

            if (buffer.includes('[CONTINUE]')) {
              const finalYield = buffer.replace('[CONTINUE]', '');
              if (finalYield) {
                turnText += finalYield;
                yield finalYield;
              }
              console.log('[TauriAdapter] Auto-continuing due to [CONTINUE] marker');
              currentMessages.push({ role: 'assistant', content: turnText });
              currentMessages.push({ role: 'user', content: '继续' });
              keepGoing = true;
            } else {
              if (buffer) {
                turnText += buffer;
                yield buffer;
              }
              keepGoing = false;
            }
          }
        }

        if (options.promptMode === 'discussion') {
          let discussionLog = "";

          const students = [
            { name: '【学生各抒己见】逻辑杠精 独孤败天', desc: '逻辑杠精 独孤败天 (The Skeptic): 万古第一禁忌大神，严谨到恐怖的布局者。不相信任何现成结论，只问"这是天道的谎言吗？"。寻找逻辑死角，挑战权威定义，强迫进行深层推理。标志性口头禅："此法看似圆满，实则破绽百出。若天道反向运行，你这逻辑还站得住吗？"' },
            { name: '【学生各抒己见】类比达人 紫金神龙', desc: '类比达人 紫金神龙 (The Analogist): 满嘴"嗷呜"、痞气十足的老痞龙。思维跳跃、极其接地气、满脑子损招。最讨厌正经八百的理论，总能把高深概念比喻成最俗最搞笑的段子。标志性口头禅："嗷呜！这什么狗屁原理？说白了不就是……"' },
            { name: '【学生各抒己见】硬核实战 魔主', desc: '硬核实战 魔主 (The Pragmatist): 千古魔主，效率与力量的极致。霸道、冷酷、追求极致性能。不在乎过程多华丽，只在乎"能杀天吗？"。关注落地实践，剔除一切花架子。标志性口头禅："废话少说，告诉我这一招的杀伤力是多少？用不出来，那就是垃圾。"' },
            { name: '【学生各抒己见】提问机器 龙宝宝', desc: '提问机器 龙宝宝 (The Curious Newbie): 爱吃果子、人畜无害的小豆丁。纯真、执着、大智若愚。用最天真的语气问出最根本的问题。标志性口头禅："神说，偶听不懂。那个叫XX的东西，能吃吗？"' },
            { name: '【学生各抒己见】调皮学霸 辰南', desc: '调皮学霸 辰南 (The Innovator): 万古布局中的一线生机，不按常理出牌的天才。机灵、坚韧、擅长在绝境中找"外挂"。尊重规则但更擅长利用规则漏洞。标志性口头禅："按部就班太慢了，咱们直接挖它祖坟（底层源码），能不能拿到结果？"' }
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

          const teacherHeader = `### 【真相揭示】工藤新一\n\n`;
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
