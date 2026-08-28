import type { ViewSettings } from '@/types/book';
import type { AppService } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import { canTokenizeSource, getRankCutoff } from '@/services/wordlens/difficulty';
import type { GlossSource } from '@/services/wordlens/types';
import { loadGlossIndex } from '@/services/wordlens/glossPacks';
import { planGlosses } from '@/services/wordlens/planner';
import { buildSectionTextModel, applyGlosses, clearGlosses } from '@/app/reader/utils/wordlensRuby';
import { cutZh, isJiebaReady } from '@/utils/jieba';

/** Normalize a book language tag to its 2-letter base source code, or fallback to 'zh' if Chinese text/metadata is present. */
export const toWordLensSource = (lang?: string | null): string | null => {
  if (!lang) return 'zh'; // Fallback to 'zh' for books with empty/missing language metadata
  const l = lang.toLowerCase().trim();
  // Support BCP 47 and ISO 639-1/2/3 codes for Chinese (zh, zh-CN, zh-TW, zh-HK, zh-Hans, zh-Hant, cmn, yue, chi, zho)
  if (
    l.startsWith('zh') ||
    l.startsWith('cmn') ||
    l.startsWith('yue') ||
    l.startsWith('chi') ||
    l.startsWith('zho') ||
    l.includes('chinese') ||
    l.includes('mandarin')
  ) {
    return 'zh';
  }
  const base = l.split(/[-_,; ]/)[0] || '';
  return base || 'zh';
};

interface RefreshContext {
  appService: AppService;
  bookKey?: string;
  sectionIndex?: number | string;
  bookLang?: string | null;
  /** App UI language base code, used as the hint when none is selected. */
  appLang: string;
  /**
   * Whether the reader may silently download an uncached pack. Threaded to
   * loadGlossIndex → ensurePack; when false an uncached pack yields no glosses
   * (the user downloads it explicitly from the Word Lens sub-page).
   */
  allowDownload?: boolean;
  onProgress?: ProgressHandler;
}

// Per-document generation counter. Dragging the difficulty slider fires the
// settings effect repeatedly, producing overlapping refresh calls. A later call
// supersedes earlier ones: each call stamps its generation, and any call whose
// stamp is stale after the `await` bails before touching the DOM, so the latest
const refreshGen = new WeakMap<Document, number>();
const appliedLevelMap = new WeakMap<Document, number>();

/** Re-render glosses for one section doc. Clears first, then injects if enabled. */
export const refreshSectionGlosses = async (
  doc: Document,
  viewSettings: ViewSettings,
  ctx: RefreshContext,
): Promise<void> => {
  try {
    if (!viewSettings.wordLensEnabled) {
      clearGlosses(doc);
      appliedLevelMap.delete(doc);
      return;
    }
    // If this document already has glosses applied for the exact same level, DO NOT re-render / clear on scroll!
    if (
      appliedLevelMap.get(doc) === viewSettings.wordLensLevel &&
      doc.querySelectorAll('.wl-gloss').length > 0
    ) {
      return;
    }

    const myGen = (refreshGen.get(doc) ?? 0) + 1;
    refreshGen.set(doc, myGen);
    clearGlosses(doc);
    appliedLevelMap.set(doc, viewSettings.wordLensLevel ?? 3);

    const source = toWordLensSource(ctx.bookLang);
    if (!source || !canTokenizeSource(source)) return;
    const hint = (viewSettings.wordLensHintLang || ctx.appLang).toLowerCase().split('-')[0] || '';
    if (!hint) return;
    // Same-language packs (e.g. en-en monolingual) are allowed; availability is
    // decided by the manifest — loadGlossIndex returns null when no pack exists.
    let index: GlossSource | null = await loadGlossIndex(ctx.appService, source, hint, {
      onProgress: ctx.onProgress,
      allowDownload: ctx.allowDownload,
    });
    if (refreshGen.get(doc) !== myGen) return; // a newer refresh superseded us
    if (!index && source === 'zh') {
      const { DynamicZhPinyinSource } = await import('@/services/wordlens/zhPinyinSource');
      index = new DynamicZhPinyinSource();
    }
    if (!index) return;
    const model = buildSectionTextModel(doc);
    const sectionIndex =
      ctx.sectionIndex !== undefined
        ? String(ctx.sectionIndex)
        : (doc.defaultView?.frameElement as Element | undefined)?.getAttribute?.('data-index') ||
          doc.location?.pathname ||
          doc.location?.href ||
          '0';
    const level = viewSettings.wordLensLevel ?? 3;

    // 1. Try reading directly from local IndexedDB cache first!
    if (ctx.bookKey) {
      try {
        const { wordLensDB } = await import('@/services/wordlens/wordlensDB');
        const cached = await wordLensDB.getSectionGlosses(ctx.bookKey, sectionIndex, level);
        if (cached && cached.length) {
          if (refreshGen.get(doc) === myGen) {
            applyGlosses(doc, model, cached);
          }
          return; // Instant 0ms return from local database cache!
        }
      } catch {
        // Fallback to calculation if DB read fails
      }
    }

    // 2. Local calculation via pinyin-pro / index (ensure Jieba is initialized for accurate Chinese segmentation)
    if (source === 'zh' && !isJiebaReady()) {
      try {
        const { initJieba } = await import('@/utils/jieba');
        await initJieba();
      } catch {
        // Continue if jieba initialization fails
      }
    }

    const occ = planGlosses(model.text, index, {
      sourceLang: source,
      rankCutoff: getRankCutoff(source, level),
      cutZh: source === 'zh' && isJiebaReady() ? cutZh : undefined,
      monolingual: hint === source, // en-en: gloss is a build-formatted definition
    });

    if (occ.length) {
      if (refreshGen.get(doc) === myGen) {
        applyGlosses(doc, model, occ);
      }
      // 3. Asynchronously persist to local IndexedDB database so subsequent visits are instant
      if (ctx.bookKey) {
        import('@/services/wordlens/wordlensDB').then(({ wordLensDB }) => {
          wordLensDB.saveSectionGlosses(ctx.bookKey!, sectionIndex, level, occ).catch(() => {});
        });
      }
    }
  } catch (err) {
    console.warn('[wordlens] refresh failed', err);
  }
};
