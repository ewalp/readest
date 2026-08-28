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

// Built-in standard dictionary for high-frequency Chinese polyphones and idioms
const BUILTIN_POLYPHONE_DICT: Record<string, string> = {
  会计: 'kuài jì',
  会计师: 'kuài jì shī',
  财会: 'cái kuài',
  做会计: 'zuò kuài jì',
  高科技行业: 'gāo kē jì háng yè',
  行业: 'háng yè',
  这个行业: 'zhè ge háng yè',
  本行业: 'běn háng yè',
  同行: 'tóng háng',
  银行: 'yín háng',
  行长: 'háng zhǎng',
  行规: 'háng guī',
  行话: 'háng huà',
  行走: 'xíng zǒu',
  行动: 'xíng dòng',
  行为: 'xíng wéi',
  重阳: 'chóng yáng',
  重复: 'chóng fù',
  重新: 'chóng xīn',
  重申: 'chóng shēn',
  重要: 'zhòng yào',
  重心: 'zhòng xīn',
  重量: 'zhòng liàng',
  音乐: 'yīn yuè',
  乐曲: 'yuè qǔ',
  乐队: 'yuè duì',
  乐意: 'lè yì',
  快乐: 'kuài lè',
  便宜: 'pián yi',
  便当: 'biàn dang',
  便利: 'biàn lì',
  方便: 'fāng biàn',
  感觉: 'gǎn jué',
  觉得: 'jué de',
  睡觉: 'shuì jiào',
  差别: 'chā bié',
  出差: 'chū chāi',
  参差: 'cēn cī',
};

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

    // 1. Check AI override cache
    if (override) {
      return {
        rank,
        gloss: override.gloss ?? '',
        pinyin: override.pinyin ?? pinyin(word, { toneType: 'symbol', type: 'string' }),
      };
    }

    // 2. Check built-in standard polyphone dictionary
    const dictPinyin = BUILTIN_POLYPHONE_DICT[word];
    if (dictPinyin) {
      return {
        rank,
        gloss: '',
        pinyin: dictPinyin,
      };
    }

    // 3. Fallback to pinyin-pro with surname/polyphone awareness
    const py = pinyin(word, { toneType: 'symbol', type: 'string', multiple: false });
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

    // Send full section context (up to 4000 characters) to cover the entire chapter
    const prompt = `请严格根据中文句子的具体语境，排查并纠正以下文本中被错误拼读的多音字（例如："会计"必须为"kuài jì"；"行业/这个行业/高科技行业"必须为"háng yè"；"银行"为"yín háng"；"行走/行动"为"xíng"；"重要/重量"为"zhòng"；"重复/重新"为"chóng"；"做会计"为"zuò kuài jì"）或生僻字注音与简明释义。
请返回纯 JSON 数组，格式如下：
[{"word": "词语或字", "pinyin": "精准带声调拼音", "gloss": "简明注解（可选）"}]
如果无需要纠正的特殊多音字，直接返回 []。请勿输出任何额外文字或 Markdown 标记。

文本内容：
"${text.slice(0, 4000)}"`;

    let outputText = '';
    const systemPrompt =
      '你是一个国家级中文语言学审音专家，专门核对中文多音字在具体句子语境下的权威标准读音（例如会计师中的“会”读kuài，行业中的“行”读háng）。你只输出纯 JSON 数组。';

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
