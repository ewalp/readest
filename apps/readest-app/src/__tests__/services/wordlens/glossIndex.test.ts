import { describe, it, expect } from 'vitest';
import { GlossIndex } from '@/services/wordlens/glossIndex';
import fixture from '../../fixtures/wordlens/en-zh.fixture.json';
import type { GlossIndexData } from '@/services/wordlens/types';

const index = GlossIndex.fromData(fixture as GlossIndexData);

describe('GlossIndex', () => {
  it('looks up an exact headword', () => {
    expect(index.lookup('cryptic')).toEqual({ rank: 18000, gloss: '晦涩的' });
  });
  it('is case-insensitive', () => {
    expect(index.lookup('The')).toEqual({ rank: 1, gloss: '这' });
  });
  it('resolves inflected forms to the lemma', () => {
    expect(index.lookup('running')).toEqual({ rank: 312, gloss: '跑；经营' });
    expect(index.lookup('RAN')).toEqual({ rank: 312, gloss: '跑；经营' });
  });
  it('returns null for unknown words', () => {
    expect(index.lookup('zzzq')).toBeNull();
  });
  it('supports pinyin in GlossEntry when present in GlossIndexData', () => {
    const dataWithPinyin: GlossIndexData = {
      meta: { source: 'zh', target: 'zh', metric: 'hsk', version: 1, count: 1 },
      entries: {
        饕餮: { r: 15000, g: '古代传说中的凶兽', p: 'tāo tiè' },
      },
      inflections: {},
    };
    const pinyinIndex = GlossIndex.fromData(dataWithPinyin);
    expect(pinyinIndex.lookup('饕餮')).toEqual({
      rank: 15000,
      gloss: '古代传说中的凶兽',
      pinyin: 'tāo tiè',
    });
  });
});

describe('DynamicZhPinyinSource', () => {
  it('generates accurate pinyin and difficulty rank for Chinese words', async () => {
    const { DynamicZhPinyinSource } = await import('@/services/wordlens/zhPinyinSource');
    const source = new DynamicZhPinyinSource();
    const result = source.lookup('饕餮');
    expect(result).not.toBeNull();
    expect(result?.pinyin).toBe('tāo tiè');
    expect(result?.rank).toBeGreaterThanOrEqual(6000);
  });
});
