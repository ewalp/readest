import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';

// ---------------------------------------------------------------------------
// Mermaid is mocked so we can count render invocations. The point of these
// tests is the caching contract, not mermaid's own rendering.
// ---------------------------------------------------------------------------
const renderMock = vi.fn(async (id: string, code: string) => ({
  svg: `<svg data-diagram="${id}" data-code-len="${code.length}"></svg>`,
}));
const parseMock = vi.fn(async () => true);

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: (...args: unknown[]) => parseMock(...(args as [])),
    render: (...args: unknown[]) => renderMock(...(args as [string, string])),
  },
}));

const { MermaidBlock } = await import('@/components/assistant/MermaidBlock');
const { clearMermaidSvgCache, getMermaidSvgCacheSize, getCachedMermaidSvg } = await import(
  '@/store/mermaidStore'
);

const CODE = 'flowchart TD\n  A[开始] --> B[结束]';

/** Let the 500ms debounce fire and the resulting state settle. */
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 700));
  });
};

describe('MermaidBlock render caching', () => {
  beforeEach(() => {
    clearMermaidSvgCache();
    renderMock.mockClear();
    parseMock.mockClear();
  });

  it('renders a diagram exactly once and reuses the SVG on remount', async () => {
    // --- first mount: performs a real render -------------------------------
    const first = render(createElement(MermaidBlock, { code: CODE }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700)); // outrun the 500ms debounce
    });

    expect(renderMock).toHaveBeenCalledTimes(1);
    const svgAfterFirst = first.container.querySelector('.mermaid-diagram svg');
    expect(svgAfterFirst).toBeTruthy();

    // --- unmount + remount with identical source -------------------------
    // This is what a message bubble re-mount looks like to this component.
    first.unmount();

    const second = render(createElement(MermaidBlock, { code: CODE }));
    // Cache hit must paint synchronously, on the very first frame — before any
    // debounce timer could fire. That is the "never blanks out" guarantee.
    const svgAfterRemount = second.container.querySelector('.mermaid-diagram svg');
    expect(svgAfterRemount).toBeTruthy();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });

    // Still one render total: the remount never called mermaid.render again.
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(getMermaidSvgCacheSize()).toBe(1);
  });

  it('renders again when the diagram source actually changes', async () => {
    const view = render(createElement(MermaidBlock, { code: CODE }));
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(1);

    const changed = 'flowchart LR\n  X --> Y';
    // Flush the update in its own act: passive effects (and therefore the
    // debounce timer) are only installed when the act scope exits, so a rerender
    // and the wait must not share one act block.
    await act(async () => {
      view.rerender(createElement(MermaidBlock, { code: changed }));
    });
    await settle();

    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(getMermaidSvgCacheSize()).toBe(2);
    view.unmount();
  });

  it('does not re-render when re-rendered with the same source', async () => {
    const view = render(createElement(MermaidBlock, { code: CODE }));
    await settle();
    expect(renderMock).toHaveBeenCalledTimes(1);

    // Parent re-renders 10 times with an unchanged code string.
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        view.rerender(createElement(MermaidBlock, { code: CODE }));
      });
    }
    await settle();

    expect(renderMock).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe('mermaid SVG cache', () => {
  beforeEach(() => {
    clearMermaidSvgCache();
  });

  it('returns undefined for unknown source', () => {
    expect(getCachedMermaidSvg('never rendered')).toBeUndefined();
  });

  it('round-trips a value', async () => {
    const { cacheMermaidSvg } = await import('@/store/mermaidStore');
    cacheMermaidSvg('abc', '<svg>abc</svg>');
    expect(getCachedMermaidSvg('abc')).toBe('<svg>abc</svg>');
  });

  it('evicts least-recently-used entries beyond the cap', async () => {
    const { cacheMermaidSvg } = await import('@/store/mermaidStore');
    for (let i = 0; i < 250; i++) {
      cacheMermaidSvg(`code-${i}`, `<svg>${i}</svg>`);
    }
    // Bounded: never grows past the documented cap.
    expect(getMermaidSvgCacheSize()).toBeLessThanOrEqual(200);
    // Newest survives, oldest is gone.
    expect(getCachedMermaidSvg('code-249')).toBe('<svg>249</svg>');
    expect(getCachedMermaidSvg('code-0')).toBeUndefined();
  });
});
