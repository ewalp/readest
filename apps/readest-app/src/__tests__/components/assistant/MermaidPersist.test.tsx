import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';

// ---------------------------------------------------------------------------
// mermaid is mocked so we can count renders.
// ---------------------------------------------------------------------------
const renderMock = vi.fn(async (id: string, code: string) => ({
  svg: `<svg data-diagram="${id}" data-len="${code.length}"></svg>`,
}));
const parseMock = vi.fn(async () => true);

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: (...args: unknown[]) => parseMock(...(args as [])),
    render: (...args: unknown[]) => renderMock(...(args as [string, string])),
  },
}));

// ---------------------------------------------------------------------------
// Fake appService + DB. This is the point of the test: the diagram must come
// back from the database on a cold mount without calling mermaid.render().
// ---------------------------------------------------------------------------
const dbRows = new Map<string, string>();
const dbExecute = vi.fn(async (sql: string, bindings: unknown[] = []) => {
  const norm = sql.replace(/\s+/g, ' ').trim();
  if (/^INSERT INTO reedy_mermaid_svg/i.test(norm)) {
    const [bookHash, codeHash, svg] = bindings as [string, string, string];
    dbRows.set(`${bookHash}::${codeHash}`, svg);
  }
  return { rowsAffected: 1 };
});
const dbSelect = vi.fn(async (sql: string, bindings: unknown[] = []) => {
  const norm = sql.replace(/\s+/g, ' ').trim();
  if (/SELECT svg FROM reedy_mermaid_svg/i.test(norm)) {
    const [bookHash, codeHash] = bindings as [string, string];
    const svg = dbRows.get(`${bookHash}::${codeHash}`);
    return svg ? [{ svg }] : [];
  }
  if (/SELECT COUNT\(\*\) AS count/i.test(norm)) return [{ count: dbRows.size }];
  return [];
});
const fakeAppService = {
  openDatabase: vi.fn(async () => ({
    execute: dbExecute,
    select: dbSelect,
    close: async () => true,
  })),
};

vi.mock('@/context/EnvContext', async () => {
  const actual =
    await vi.importActual<typeof import('@/context/EnvContext')>('@/context/EnvContext');
  return { ...actual, useOptionalEnv: () => ({ appService: fakeAppService, envConfig: {} }) };
});

const { MermaidBlock } = await import('@/components/assistant/MermaidBlock');
const { MermaidBookProvider } = await import('@/components/assistant/MermaidBookContext');
const { clearMermaidSvgCache, getCachedMermaidSvg } = await import('@/store/mermaidStore');
const { resetMermaidSvgDbHandle } = await import('@/services/mermaidSvgStore');

const CODE = 'flowchart TD\n  A[开始] --> B[结束]';
const BOOK = 'bookhash123';

const settle = async (ms = 900) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const mount = () =>
  render(
    <MermaidBookProvider bookHash={BOOK}>
      <MermaidBlock code={CODE} />
    </MermaidBookProvider>,
  );

describe('MermaidBlock: durable cache in reedy.db', () => {
  beforeEach(() => {
    clearMermaidSvgCache();
    resetMermaidSvgDbHandle();
    dbRows.clear();
    renderMock.mockClear();
    parseMock.mockClear();
    dbExecute.mockClear();
    dbSelect.mockClear();
  });

  it('renders once, then answers from the database on a cold mount', async () => {
    // --- first ever render ------------------------------------------------
    const first = mount();
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(first.container.querySelector('.mermaid-diagram svg')).toBeTruthy();
    expect(dbRows.size).toBe(1);
    first.unmount();

    // --- simulate an app restart: memory is gone, database is not --------
    clearMermaidSvgCache();
    resetMermaidSvgDbHandle();
    renderMock.mockClear();
    expect(getCachedMermaidSvg(CODE)).toBeUndefined();

    const second = mount();
    await settle();

    // The durable copy was used: no second mermaid.render().
    expect(renderMock).toHaveBeenCalledTimes(0);
    expect(second.container.querySelector('.mermaid-diagram svg')).toBeTruthy();
    second.unmount();
  });

  it('stores exactly one row per distinct diagram, keyed by book', async () => {
    const a = mount();
    await settle();
    a.unmount();

    // Re-mount twice more: no new rows, no new renders.
    for (let i = 0; i < 2; i++) {
      clearMermaidSvgCache();
      const again = mount();
      await settle();
      again.unmount();
    }

    expect(dbRows.size).toBe(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('does not persist when no book is in scope', async () => {
    // Without a provider there is no bookHash, so nothing can be keyed.
    const view = render(createElement(MermaidBlock, { code: CODE }));
    await settle();

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(dbRows.size).toBe(0);
    view.unmount();
  });
});
