import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppService } from '@/types/system';
import {
  loadMermaidSvg,
  saveMermaidSvg,
  clearMermaidSvgForBook,
  resetMermaidSvgDbHandle,
} from '@/services/mermaidSvgStore';
import { getMigrations } from '@/services/database/migrations';

/**
 * In-memory stand-in for the DatabaseService the app hands out. It implements
 * just the two calls the store uses, so these tests exercise the real SQL the
 * store issues instead of asserting on mock call shapes.
 */
const makeDb = () => {
  const rows = new Map<
    string,
    { book_hash: string; code_hash: string; svg: string; created_at: number; last_used_at: number }
  >();

  return {
    rows,
    execute: vi.fn(async (sql: string, bindings: unknown[] = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (/^INSERT INTO reedy_mermaid_svg/i.test(norm)) {
        const [bookHash, codeHash, svg, createdAt, lastUsedAt] = bindings as [
          string,
          string,
          string,
          number,
          number,
        ];
        rows.set(`${bookHash}::${codeHash}`, {
          book_hash: bookHash,
          code_hash: codeHash,
          svg,
          created_at: createdAt,
          last_used_at: lastUsedAt,
        });
        return { rowsAffected: 1 };
      }

      if (/^UPDATE reedy_mermaid_svg SET last_used_at/i.test(norm)) {
        const [ts, bookHash, codeHash] = bindings as [number, string, string];
        const row = rows.get(`${bookHash}::${codeHash}`);
        if (row) row.last_used_at = ts;
        return { rowsAffected: row ? 1 : 0 };
      }

      if (/^DELETE FROM reedy_mermaid_svg WHERE book_hash = \? AND/i.test(norm)) {
        const bookHash = bindings[0] as string;
        for (const key of [...rows.keys()]) {
          if (key.startsWith(`${bookHash}::`)) rows.delete(key);
        }
        return { rowsAffected: 1 };
      }

      if (/^DELETE FROM reedy_mermaid_svg WHERE book_hash = \?$/i.test(norm)) {
        const bookHash = bindings[0] as string;
        for (const key of [...rows.keys()]) {
          if (key.startsWith(`${bookHash}::`)) rows.delete(key);
        }
        return { rowsAffected: 1 };
      }

      return { rowsAffected: 0 };
    }),
    select: vi.fn(async (sql: string, bindings: unknown[] = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (/SELECT svg FROM reedy_mermaid_svg WHERE book_hash = \? AND code_hash = \?/i.test(norm)) {
        const [bookHash, codeHash] = bindings as [string, string];
        const row = rows.get(`${bookHash}::${codeHash}`);
        return row ? [{ svg: row.svg }] : [];
      }

      if (/SELECT COUNT\(\*\) AS count FROM reedy_mermaid_svg WHERE book_hash = \?/i.test(norm)) {
        const bookHash = bindings[0] as string;
        let count = 0;
        for (const key of rows.keys()) if (key.startsWith(`${bookHash}::`)) count++;
        return [{ count }];
      }

      return [];
    }),
    close: vi.fn(async () => true),
  };
};

const makeAppService = (db: ReturnType<typeof makeDb>) =>
  ({ openDatabase: vi.fn(async () => db) }) as unknown as AppService;

describe('mermaidSvgStore', () => {
  beforeEach(() => {
    resetMermaidSvgDbHandle();
  });

  it('returns null when the diagram was never stored', async () => {
    const db = makeDb();
    const appService = makeAppService(db);
    expect(await loadMermaidSvg(appService, 'book1', 'hash1')).toBeNull();
  });

  it('round-trips an SVG and survives a fresh handle (cold start)', async () => {
    const db = makeDb();
    await saveMermaidSvg(makeAppService(db), 'book1', 'hash1', '<svg>diagram</svg>');

    // Simulate an app restart: forget the memoized DB promise.
    resetMermaidSvgDbHandle();

    const loaded = await loadMermaidSvg(makeAppService(db), 'book1', 'hash1');
    expect(loaded).toBe('<svg>diagram</svg>');
  });

  it('upserts rather than duplicating on re-render', async () => {
    const db = makeDb();
    const appService = makeAppService(db);
    await saveMermaidSvg(appService, 'book1', 'hash1', '<svg>v1</svg>');
    await saveMermaidSvg(appService, 'book1', 'hash1', '<svg>v2</svg>');

    expect(db.rows.size).toBe(1);
    expect(await loadMermaidSvg(appService, 'book1', 'hash1')).toBe('<svg>v2</svg>');
  });

  it('scopes rows per book so the same diagram in two books does not collide', async () => {
    const db = makeDb();
    const appService = makeAppService(db);
    await saveMermaidSvg(appService, 'bookA', 'shared', '<svg>A</svg>');
    await saveMermaidSvg(appService, 'bookB', 'shared', '<svg>B</svg>');

    expect(await loadMermaidSvg(appService, 'bookA', 'shared')).toBe('<svg>A</svg>');
    expect(await loadMermaidSvg(appService, 'bookB', 'shared')).toBe('<svg>B</svg>');
    expect(db.rows.size).toBe(2);
  });

  it('clears only the requested book', async () => {
    const db = makeDb();
    const appService = makeAppService(db);
    await saveMermaidSvg(appService, 'bookA', 'h1', '<svg>A1</svg>');
    await saveMermaidSvg(appService, 'bookB', 'h1', '<svg>B1</svg>');

    await clearMermaidSvgForBook(appService, 'bookA');

    expect(await loadMermaidSvg(appService, 'bookA', 'h1')).toBeNull();
    expect(await loadMermaidSvg(appService, 'bookB', 'h1')).toBe('<svg>B1</svg>');
  });

  it('never throws into the render path when the database is unavailable', async () => {
    const broken = {
      openDatabase: vi.fn(async () => {
        throw new Error('disk on fire');
      }),
    } as unknown as AppService;

    await expect(saveMermaidSvg(broken, 'book1', 'hash1', '<svg/>')).resolves.toBeUndefined();
    await expect(loadMermaidSvg(broken, 'book1', 'hash1')).resolves.toBeNull();
    await expect(clearMermaidSvgForBook(broken, 'book1')).resolves.toBeUndefined();
  });

  it('treats a missing appService as "persistence off"', async () => {
    expect(await loadMermaidSvg(null, 'book1', 'hash1')).toBeNull();
    await expect(saveMermaidSvg(null, 'book1', 'hash1', '<svg/>')).resolves.toBeUndefined();
  });
});

describe('reedy_mermaid_svg migration', () => {
  it('is registered for the reedy schema with the expected columns', () => {
    const entries = getMigrations('reedy');
    const entry = entries.find((e) => e.name === '2026111101_reedy_mermaid_svg');

    expect(entry).toBeDefined();
    const sql = entry!.sql;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS reedy_mermaid_svg');
    expect(sql).toContain('book_hash TEXT NOT NULL');
    expect(sql).toContain('code_hash TEXT NOT NULL');
    expect(sql).toContain('svg TEXT NOT NULL');
    expect(sql).toContain('last_used_at INTEGER NOT NULL');
    // Composite key: one row per (book, diagram source).
    expect(sql).toMatch(/PRIMARY KEY \(book_hash, code_hash\)/);
  });

  it('keeps migration names unique so the runner cannot skip one', () => {
    const names = getMigrations('reedy').map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
