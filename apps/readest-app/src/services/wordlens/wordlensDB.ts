import { GlossOccurrence } from './types';

const DB_NAME_PREFIX = 'readest-wordlens-';
const STORE_NAME = 'section_glosses';
const DB_VERSION = 1;

export interface SectionGlossData {
  sectionKey: string;
  bookKey: string;
  level: number;
  occurrences: GlossOccurrence[];
  updatedAt: number;
}

class WordLensDB {
  private dbs = new Map<string, IDBDatabase>();

  private async openDB(bookKey: string): Promise<IDBDatabase> {
    if (this.dbs.has(bookKey)) return this.dbs.get(bookKey)!;

    return new Promise((resolve, reject) => {
      const dbName = `${DB_NAME_PREFIX}${bookKey}`;
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'sectionKey' });
          store.createIndex('level', 'level', { unique: false });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        this.dbs.set(bookKey, db);
        resolve(db);
      };
    });
  }

  async getSectionGlosses(
    bookKey: string,
    sectionKey: string,
    level: number,
  ): Promise<GlossOccurrence[] | null> {
    try {
      const db = await this.openDB(bookKey);
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const fullKey = `${bookKey}::${sectionKey}::${level}`;
        const req = store.get(fullKey);

        req.onsuccess = () => {
          const data = req.result as SectionGlossData | undefined;
          resolve(data ? data.occurrences : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async saveSectionGlosses(
    bookKey: string,
    sectionKey: string,
    level: number,
    occurrences: GlossOccurrence[],
  ): Promise<void> {
    try {
      const db = await this.openDB(bookKey);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const fullKey = `${bookKey}::${sectionKey}::${level}`;
        const entry: SectionGlossData = {
          sectionKey: fullKey,
          bookKey,
          level,
          occurrences,
          updatedAt: Date.now(),
        };
        const req = store.put(entry);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // ignore
    }
  }

  async clearBook(bookKey: string): Promise<void> {
    if (this.dbs.has(bookKey)) {
      try {
        this.dbs.get(bookKey)?.close();
      } catch {}
      this.dbs.delete(bookKey);
    }
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(`${DB_NAME_PREFIX}${bookKey}`);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  }
}

export const wordLensDB = new WordLensDB();
