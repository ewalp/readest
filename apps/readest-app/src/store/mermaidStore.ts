import { create } from 'zustand';

interface MermaidStore {
  isOpen: boolean;
  code: string;
  openModal: (code: string) => void;
  closeModal: () => void;
}

export const useMermaidStore = create<MermaidStore>((set) => ({
  isOpen: false,
  code: '',
  openModal: (code) => set({ isOpen: true, code }),
  closeModal: () => set({ isOpen: false, code: '' }),
}));

/**
 * Small in-memory front for {@link '@/services/mermaidSvgStore'}.
 *
 * The durable copy of every rendered diagram lives in `reedy.db`, keyed by
 * (book, source hash) — it survives restarts, holds every diagram of the book,
 * and is cleaned up with the book's other AI data. This map only exists to
 * avoid an async SQLite round-trip in the render path: a component that
 * re-mounts must be able to paint on its very first frame.
 *
 * Kept intentionally small. Evicting from here costs at most one disk read,
 * never a re-render, so there is no reason to grow it.
 */
const MAX_CACHED_DIAGRAMS = 40;

const svgCache = new Map<string, string>();

/**
 * Cheap 32-bit FNV-1a hash — enough to key a cache, and much faster than
 * rendering. Shared with the persistent store so both layers agree on identity.
 */
export const hashMermaidCode = (code: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const hashCode = hashMermaidCode;

export const getCachedMermaidSvg = (code: string): string | undefined => {
  const key = hashCode(code);
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    // Refresh recency: delete + re-set moves the key to the end of the Map.
    svgCache.delete(key);
    svgCache.set(key, cached);
    return cached;
  }
  return undefined;
};

export const cacheMermaidSvg = (code: string, svg: string): void => {
  if (!svg) return;
  const key = hashCode(code);
  svgCache.delete(key);
  svgCache.set(key, svg);
  while (svgCache.size > MAX_CACHED_DIAGRAMS) {
    const oldest = svgCache.keys().next();
    if (oldest.done) break;
    svgCache.delete(oldest.value);
  }
};

/** Test seam: tests need a clean slate between cases. */
export const clearMermaidSvgCache = (): void => {
  svgCache.clear();
};

export const getMermaidSvgCacheSize = (): number => svgCache.size;
