/**
 * Regression test for the "mermaid diagram blanks for ~1-2s and redraws"
 * symptom reported in the reader's AI panel.
 *
 * Root cause (see Thread.tsx): the `components` object handed to
 * `ThreadPrimitive.Messages` used to build `AssistantMessage` with an
 * INLINE ARROW FUNCTION on every render. assistant-ui compares that prop
 * slot by identity (`isComponentsSame`), and React treats a new function
 * identity at the same position as a DIFFERENT component type — so every
 * re-render of <Thread> (page turn, settings write, notebook resize, theme
 * change…) unmounted and remounted every assistant message. Each remount
 * reset MermaidBlock's `svg` state to '' and kicked off the 500ms debounce
 * + mermaid.render(), i.e. the diagram visibly disappeared and came back.
 *
 * This test drives the real <Thread> through assistant-ui's runtime, forces
 * a parent re-render and asserts the rendered diagram survives untouched.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, waitFor, type RenderResult } from '@testing-library/react';
import { useEffect } from 'react';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';

// jsdom has no ResizeObserver; assistant-ui's viewport hooks need one.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const renderCalls: string[] = [];

vi.mock('mermaid', () => {
  const api = {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async (id: string, code: string) => {
      renderCalls.push(code);
      return { svg: `<svg id="${id}" data-mermaid="1"><text>${code.length}</text></svg>` };
    }),
  };
  return { default: api, ...api };
});

import { Thread } from '@/components/assistant/Thread';
import { clearMermaidSvgCache } from '@/store/mermaidStore';

const MERMAID_MD = [
  '下面是一个流程：',
  '',
  '```mermaid',
  'graph TD;',
  '  A[开始] --> B{判断};',
  '  B -->|是| C[结束];',
  '```',
].join('\n');

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: MERMAID_MD }] };
  },
};

function Harness({ tick, nonce }: { tick: number; nonce: number }) {
  const runtime = useLocalRuntime(adapter as never);

  useEffect(() => {
    runtime.thread.append({ role: 'user', content: [{ type: 'text', text: '画个流程图' }] });
  }, [runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* `nonce` is only here to prove the value is ignored; `tick` changes
          nothing but forces the parent (and therefore <Thread>) to re-render,
          which is what a page turn does in the real reader. */}
      <div data-tick={tick} data-nonce={nonce}>
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}

describe('Thread: assistant messages must not remount on parent re-render', () => {
  beforeEach(() => {
    renderCalls.length = 0;
    // The SVG cache is module-level and keyed by source, so a cached diagram
    // from a previous test would legitimately skip rendering. Start clean.
    clearMermaidSvgCache();
  });

  it('keeps the rendered mermaid SVG in place across re-renders', async () => {
    let view: RenderResult | null = null;
    await act(async () => {
      view = render(<Harness tick={0} nonce={0} />);
    });

    await waitFor(() => expect(renderCalls.length).toBe(1), { timeout: 5000 });

    const container = view!.container;
    const firstSvg = container.querySelector('.mermaid-diagram svg');
    expect(firstSvg).toBeTruthy();

    // Simulate what happens in the reader while the user is just reading:
    // the surrounding tree re-renders (progress save, theme, notebook, …).
    for (let i = 1; i <= 3; i++) {
      await act(async () => {
        view!.rerender(<Harness tick={i} nonce={i} />);
      });
    }

    // Give the 500ms debounce room to fire if a remount did happen.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });

    const afterSvg = container.querySelector('.mermaid-diagram svg');

    // eslint-disable-next-line no-console
    console.log(
      '[mermaid-remount] render calls:',
      renderCalls.length,
      '| same SVG node:',
      afterSvg === firstSvg,
      '| svg still present:',
      !!afterSvg,
    );

    expect(afterSvg).toBe(firstSvg); // same DOM node => never remounted
    expect(renderCalls.length).toBe(1); // mermaid.render only once
  });

  /**
   * The reader re-renders far more often than the 3 times above: every page
   * turn writes progress, and a long session accumulates dozens of messages.
   * Without the fix this loop drives one mermaid.render() per re-render, so
   * cost grew with both message count AND page turns — matching the user's
   * "fine when freshly opened, badly stuttering after three or four hours".
   */
  it('stays stable across a long run of re-renders (long-session simulator)', {
    timeout: 30000,
  }, async () => {
    let view: RenderResult | null = null;
    await act(async () => {
      view = render(<Harness tick={0} nonce={0} />);
    });

    await waitFor(() => expect(renderCalls.length).toBe(1), { timeout: 5000 });
    const firstSvg = view!.container.querySelector('.mermaid-diagram svg');
    expect(firstSvg).toBeTruthy();

    // 60 page turns' worth of parent re-renders.
    for (let i = 1; i <= 60; i++) {
      await act(async () => {
        view!.rerender(<Harness tick={i} nonce={i} />);
      });
    }

    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });

    const afterSvg = view!.container.querySelector('.mermaid-diagram svg');
    // eslint-disable-next-line no-console
    console.log(
      '[mermaid-remount/long] render calls:',
      renderCalls.length,
      '| same SVG node:',
      afterSvg === firstSvg,
    );

    expect(afterSvg).toBe(firstSvg);
    expect(renderCalls.length).toBe(1);
  });
});
