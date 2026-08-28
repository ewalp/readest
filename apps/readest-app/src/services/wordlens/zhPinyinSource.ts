import { pinyin } from 'pinyin-pro';
import type { GlossEntry, GlossSource } from './types';

/**
 * Common / Rare Han character difficulty metrics based on character stroke/frequency heuristic.
 * Rare/difficult characters or words return rank > cutoff (e.g. 15000); common words return rank 1000.
 */
function getZhRank(word: string): number {
  if (!word) return 0;
  let maxCodePoint = 0;
  for (const char of word) {
    const code = char.codePointAt(0) ?? 0;
    if (code > maxCodePoint) maxCodePoint = code;
  }
  // 生僻字/拓展区字 (C2 级别: >= 24000)
  if (maxCodePoint > 0x9fff || maxCodePoint < 0x4e00) {
    return 30000;
  }

  // 四字成语/长词 (C1 级别: >= 18000)
  if (word.length >= 4) {
    return 20000;
  }

  // 三字词 (B2 级别: >= 15000)
  if (word.length === 3) {
    return 16000;
  }

  // 双字词汇 (B1 级别: >= 12000)
  if (word.length === 2) {
    return 13000;
  }

  // 基础双字/单字 (A1/A2 级别: 9000 >= A2 cutoff 9000)
  return 9000;
}

/**
 * In-memory Chinese GlossSource powered by `pinyin-pro` with context-aware polyphone support
 * and dynamic AI override correction cache.
 */
export class DynamicZhPinyinSource implements GlossSource {
  #overrides: Map<string, { pinyin?: string; gloss?: string }>;

  constructor(overrides?: Map<string, { pinyin?: string; gloss?: string }>) {
    this.#overrides = overrides ?? new Map();
  }

  setOverride(word: string, entry: { pinyin?: string; gloss?: string }): void {
    this.#overrides.set(word, entry);
  }

  lookup(word: string): GlossEntry | null {
    if (!word || !/[\u4e00-\u9fa5]/.test(word)) return null;

    const rank = getZhRank(word);
    const override = this.#overrides.get(word);

    // If AI provided an override for this word/polyphone
    if (override) {
      return {
        rank,
        gloss: override.gloss ?? '',
        pinyin: override.pinyin ?? pinyin(word, { toneType: 'symbol', type: 'string' }),
      };
    }

    // Fallback to pinyin-pro
    const py = pinyin(word, { toneType: 'symbol', type: 'string' });
    if (!py) return null;

    return {
      rank,
      gloss: '',
      pinyin: py,
    };
  }
}

/** Cache for AI-verified pinyin & gloss corrections to avoid repeating API calls. */
const aiCorrectionCache = new Map<string, { pinyin?: string; gloss?: string }>();

/**
 * Asynchronously review section text using the user's configured AI model
 * to correct polyphone pinyin & rare word glosses in the background.
 */
export async function correctSectionWithAI(
  text: string,
  source: DynamicZhPinyinSource,
  getAIProviderFn?: () =>
    | {
        streamChat?(
          messages: Array<{ role: string; content: string }>,
          systemPrompt: string,
        ): AsyncGenerator<string>;
      }
    | unknown,
): Promise<void> {
  if (!text || !getAIProviderFn) return;
  try {
    const provider = getAIProviderFn();
    if (!provider) return;

    // Apply existing cached AI corrections first
    for (const [word, entry] of aiCorrectionCache.entries()) {
      source.setOverride(word, entry);
    }

    // Use streamChat to communicate with the configured provider (OpenAI, DeepSeek, Ollama, etc.)
    const prompt = `请排查以下中文文本中的特定语境多音字或生僻字注音与简明释义。
仅针对有特定语境多音字（如"重要(zhòng)","行走(xíng)","重合(chóng)"）或生字返回纯 JSON 数组，格式如下：
[{"word": "词语或字", "pinyin": "带声调拼音", "gloss": "简明注解（可选）"}]
如果无需要纠正的特殊多音字，直接返回 []。请勿输出任何 Markdown 格式或多余文字。

文本内容：
"${text.slice(0, 1000)}"`;

    let outputText = '';
    const systemPrompt =
      '你是一个严谨的中文语言学专家，专门核对中文多音字在具体语境下的正确拼音和简注。你只输出纯 JSON 数组。';

    const chatProvider = provider as {
      streamChat?(
        messages: Array<{ role: string; content: string }>,
        systemPrompt: string,
      ): AsyncGenerator<string>;
    };
    if (!chatProvider || typeof chatProvider.streamChat !== 'function') return;

    for await (const chunk of chatProvider.streamChat(
      [{ role: 'user', content: prompt }],
      systemPrompt,
    )) {
      outputText += chunk;
    }

    const jsonMatch = outputText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const items = JSON.parse(jsonMatch[0]);
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.word && (item.pinyin || item.gloss)) {
          const entry = { pinyin: item.pinyin, gloss: item.gloss };
          aiCorrectionCache.set(item.word, entry);
          source.setOverride(item.word, entry);
        }
      }
    }
  } catch (err) {
    console.error('[wordlens] AI pinyin correction error:', err);
    throw err;
  }
}
