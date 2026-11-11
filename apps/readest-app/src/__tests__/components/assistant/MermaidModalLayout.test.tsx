import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// The modal's bug was a layout one: a tall diagram inside a scroll container
// whose centred content overflowed upwards made the top unreachable. jsdom has
// no layout engine, so these tests assert the *structure* that guarantees
// reachability (explicit pixel sizing + top alignment) rather than pixel
// geometry, plus the measurement plumbing that feeds it.
// ---------------------------------------------------------------------------

const SVG_W = 400;
const SVG_H = 1600; // deliberately much taller than a 90vh modal

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({
      svg: `<svg width="${SVG_W}" height="${SVG_H}" style="max-width:${SVG_W}px" viewBox="0 0 ${SVG_W} ${SVG_H}"><g><text>top</text></g></svg>`,
    })),
  },
}));

const { GlobalMermaidModal } = await import('@/components/assistant/GlobalMermaidModal');
const { useMermaidStore, clearMermaidSvgCache } = await import('@/store/mermaidStore');

const settle = async (ms = 200) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const openModal = async () => {
  act(() => {
    useMermaidStore.getState().openModal('flowchart TD\n  A-->B');
  });
  await settle();
};

const canvas = () => document.querySelector('.mermaid-modal-canvas') as HTMLElement | null;
const scroller = () => document.querySelector('[role="presentation"]') as HTMLElement | null;

describe('GlobalMermaidModal layout: tall diagrams must not lose their top', () => {
  beforeEach(() => {
    clearMermaidSvgCache();
    useMermaidStore.getState().closeModal();
  });

  afterEach(() => {
    cleanup();
    useMermaidStore.getState().closeModal();
  });

  it('sizes the canvas in pixels from the measured SVG, not percentages', async () => {
    render(<GlobalMermaidModal />);
    await openModal();

    const el = canvas();
    expect(el).toBeTruthy();

    // Height must equal the diagram's real height so the scrollbar covers the
    // whole thing. A percentage here was the original defect.
    expect(el!.style.height).toBe(`${SVG_H}px`);
    expect(el!.style.width).toBe(`${SVG_W}px`);
    expect(el!.style.height).not.toContain('%');
  });

  it('aligns content to the top so overflow is below, not above', async () => {
    render(<GlobalMermaidModal />);
    await openModal();

    const inner = canvas()!.parentElement as HTMLElement;
    // items-start == align-items: flex-start. `items-center` on a too-tall
    // child pushes half the overflow above scrollTop 0, where it cannot be
    // reached — that was the "top is cut off" symptom.
    expect(inner.className).toContain('items-start');
    expect(inner.className).not.toContain('items-center');
  });

  it('does not clip the scroll container itself', async () => {
    render(<GlobalMermaidModal />);
    await openModal();

    const s = scroller();
    expect(s).toBeTruthy();
    expect(s!.className).toContain('overflow-auto');
    // overflow-hidden on this element would make the diagram unreachable.
    expect(s!.className).not.toContain('overflow-hidden');
  });

  it('scales the pixel box when zooming, so the scrollbar still tracks content', async () => {
    render(<GlobalMermaidModal />);
    await openModal();

    const before = canvas()!.style.height;
    expect(before).toBe(`${SVG_H}px`);

    const zoomIn = screen.getByTitle('Zoom In');
    await act(async () => {
      zoomIn.click();
    });
    await settle(50);

    // 125% of the natural height.
    expect(canvas()!.style.height).toBe(`${Math.round(SVG_H * 1.25)}px`);
  });

  it('keeps the diagram reachable when zoomed out below 100%', async () => {
    render(<GlobalMermaidModal />);
    await openModal();

    const zoomOut = screen.getByTitle('Zoom Out');
    await act(async () => {
      zoomOut.click();
      zoomOut.click();
    });
    await settle(50);

    // 50% of natural height — still an explicit pixel value.
    expect(canvas()!.style.height).toBe(`${SVG_H * 0.5}px`);
  });

  it('renders the injected svg inside the sized canvas', async () => {
    render(<GlobalMermaidModal />);
    await openModal();

    const el = canvas()!;
    const svg = el.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute('viewBox')).toBe(`0 0 ${SVG_W} ${SVG_H}`);
  });
});

describe('GlobalMermaidModal sizing: viewBox wins over percentage attributes', () => {
  beforeEach(() => {
    clearMermaidSvgCache();
    useMermaidStore.getState().closeModal();
  });

  afterEach(() => {
    cleanup();
    useMermaidStore.getState().closeModal();
  });

  it('uses viewBox dimensions when mermaid emits width="100%"', async () => {
    // This is the shape that broke the first attempt at this fix:
    // Number('100%') is NaN, so a naive reader falls back to the container's
    // width and the diagram loses its real proportions.
    const mermaid = (await import('mermaid')).default as unknown as {
      render: ReturnType<typeof vi.fn>;
    };
    mermaid.render.mockResolvedValueOnce({
      svg: `<svg width="100%" height="100%" viewBox="0 0 320 900" style="max-width:100%"><g/></svg>`,
    });

    render(<GlobalMermaidModal />);
    await openModal();

    expect(canvas()!.style.height).toBe('900px');
    expect(canvas()!.style.width).toBe('320px');
  });
});
