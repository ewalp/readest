import type { AppService } from '@/types/system';
import type { DatabaseService } from '@/types/database';

/**
 * Persistent store for rendered Mermaid SVGs.
 *
 * Why a database and not an in-memory cache: a diagram's SVG is a pure
 * function of its source, so it only ever needs to be computed once — not once
 * per session, and not once per time the message scrolls back into view. The
 * AI panel re-mounts message subtrees constantly (virtualization, thread
 * switches, history reloads), and each mount would otherwise pay for a full
 * `mermaid.render()`, which also blanks the diagram while it swaps the old
 * SVG out. Rows live in `reedy.db` alongside the book's index, so they survive
 * restarts and are cleaned up with the rest of that book's data.
 *
 * An in-memory map only fronts this store to avoid hitting SQLite on every
 * re-render; it is not the source of truth and can be dropped at any time.
 */
const REEDY_DB_KEY = 'reedy';
const REEDY_DB_FILE = 'reedy.db';

/**
 * In-flight/open handle cache. `openDatabase` is idempotent per path but the
 * call itself awaits file resolution and migration checks, which is far too
 * slow to sit in a render path, so the promise is memoized here.
 */
let dbPromise: Promise<DatabaseService> | null = null;

const getDb = (appService: AppService): Promise<DatabaseService> => {
  if (!dbPromise) {
    dbPromise = appService
      .openDatabase(REEDY_DB_KEY, REEDY_DB_FILE, 'Data', { experimental: ['index_method'] })
      .catch((err: unknown) => {
        // Do not cache a rejection: a transient failure would otherwise
        // disable persistence for the rest of the session.
        dbPromise = null;
        throw err;
      });
  }
  return dbPromise;
};

/** Bound on rows per book; oldest-first eviction keeps the table small. */
const MAX_ROWS_PER_BOOK = 500;

export interface MermaidSvgRecord {
  svg: string;
}

/**
 * Look up a previously rendered diagram. Returns `null` when the source has
 * never been rendered for this book (or persistence is unavailable, e.g. the
 * DB failed to open — callers must still be able to render).
 */
export const loadMermaidSvg = async (
  appService: AppService | null,
  bookHash: string,
  codeHash: string,
): Promise<string | null> => {
  if (!appService) return null;
  try {
    const db = await getDb(appService);
    const rows = await db.select<{ svg: string }>(
      'SELECT svg FROM reedy_mermaid_svg WHERE book_hash = ? AND code_hash = ?',
      [bookHash, codeHash],
    );
    const row = rows[0];
    if (!row) return null;
    // Touch last_used_at so the eviction order reflects actual use.
    void db
      .execute(
        'UPDATE reedy_mermaid_svg SET last_used_at = ? WHERE book_hash = ? AND code_hash = ?',
        [Date.now(), bookHash, codeHash],
      )
      .catch(() => {});
    return row.svg;
  } catch {
    return null;
  }
};

/**
 * Persist a rendered diagram. Fire-and-forget by contract: a storage failure
 * must never break rendering, so this swallows errors after logging nothing
 * (the diagram is already on screen by the time it is called).
 */
export const saveMermaidSvg = async (
  appService: AppService | null,
  bookHash: string,
  codeHash: string,
  svg: string,
): Promise<void> => {
  if (!appService || !svg) return;
  try {
    const db = await getDb(appService);
    const now = Date.now();
    await db.execute(
      `INSERT INTO reedy_mermaid_svg (book_hash, code_hash, svg, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(book_hash, code_hash) DO UPDATE SET
         svg = excluded.svg,
         last_used_at = excluded.last_used_at`,
      [bookHash, codeHash, svg, now, now],
    );

    // Evict oldest rows for this book. A single book's diagram count is small,
    // but an unbounded table would grow across re-index and edits.
    const rows = await db.select<{ count: number }>(
      'SELECT COUNT(*) AS count FROM reedy_mermaid_svg WHERE book_hash = ?',
      [bookHash],
    );
    const count = rows[0]?.count ?? 0;
    if (count > MAX_ROWS_PER_BOOK) {
      await db.execute(
        `DELETE FROM reedy_mermaid_svg
          WHERE book_hash = ?
            AND code_hash IN (
              SELECT code_hash FROM reedy_mermaid_svg
               WHERE book_hash = ?
               ORDER BY last_used_at ASC
               LIMIT ?
            )`,
        [bookHash, bookHash, count - MAX_ROWS_PER_BOOK],
      );
    }
  } catch {
    // Persistence is an optimization; never surface storage errors to the UI.
  }
};

/** Drop every cached diagram for a book — used when its index is cleared. */
export const clearMermaidSvgForBook = async (
  appService: AppService | null,
  bookHash: string,
): Promise<void> => {
  if (!appService) return;
  try {
    const db = await getDb(appService);
    await db.execute('DELETE FROM reedy_mermaid_svg WHERE book_hash = ?', [bookHash]);
  } catch {
    /* noop */
  }
};

/** Test seam: forget the memoized DB handle. */
export const resetMermaidSvgDbHandle = (): void => {
  dbPromise = null;
};
