import { memo, useEffect, useState, useRef, useMemo } from 'react';
import mermaid from 'mermaid';
import { ZoomIn, ZoomOut, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogClose } from '@/components/primitives/dialog';
import {
  useMermaidStore,
  getCachedMermaidSvg,
  cacheMermaidSvg,
  hashMermaidCode,
} from '@/store/mermaidStore';
import { loadMermaidSvg, saveMermaidSvg } from '@/services/mermaidSvgStore';
import { useOptionalEnv } from '@/context/EnvContext';
import { useMermaidBookHash } from './MermaidBookContext';

// Reusing the logic from MermaidBlock but simplified for the modal viewer
const MermaidViewer = memo(function MermaidViewer({ code }: { code: string }) {
  const env = useOptionalEnv();
  const appService = env?.appService ?? null;
  const bookHash = useMermaidBookHash();
  const codeHash = useMemo(() => hashMermaidCode(code), [code]);

  // A diagram the user is expanding is almost always one already visible in
  // the thread, so it is already cached: open instantly, no re-render.
  const [svg, setSvg] = useState(() => getCachedMermaidSvg(code) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [diagramId] = useState(() => `mermaid-modal-${Math.random().toString(36).slice(2, 9)}`);

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const scrollStart = useRef({ x: 0, y: 0 });
  /**
   * Natural (unscaled) size of the rendered SVG. Measured once the markup is
   * in the DOM: mermaid emits an intrinsic width/height, and the modal needs
   * those numbers to size its scroll area. Percentages cannot do this job —
   * a scaled diagram is taller than its container, and percentage heights
   * inside an auto-height scroll box resolve against nothing.
   */
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  /** Padding around the diagram, kept in sync with the container's p-8. */
  const PADDING = 32;

  /**
   * Mermaid emits `<svg width=… height=… style="max-width:…">`. Its inline
   * height would override the box we size, so the height has to be released
   * (100%) for the scale to actually apply. Done with a scoped <style> because
   * the markup is injected via dangerouslySetInnerHTML and carries no class
   * we can target from Tailwind.
   */
  const svgFitCss = `
    .mermaid-modal-canvas > svg {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      display: block;
    }
  `;

  const handleZoom = (delta: number) => {
    setScale((prev) => Math.min(Math.max(0.2, prev + delta), 5));
  };

  const resetZoom = () => setScale(1);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    if (containerRef.current) {
      scrollStart.current = {
        x: containerRef.current.scrollLeft,
        y: containerRef.current.scrollTop,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    containerRef.current.scrollLeft = scrollStart.current.x - dx;
    containerRef.current.scrollTop = scrollStart.current.y - dy;
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    let mounted = true;

    // Already rendered elsewhere in the thread: reuse it instead of re-parsing.
    const cached = getCachedMermaidSvg(code);
    if (cached) {
      setSvg(cached);
      setError(null);
      return;
    }

    const renderDiagram = async () => {
      if (!code) return;

      // Fall back to the durable copy before paying for a render.
      if (appService && bookHash) {
        const persisted = await loadMermaidSvg(appService, bookHash, codeHash);
        if (!mounted) return;
        if (persisted) {
          cacheMermaidSvg(code, persisted);
          setSvg(persisted);
          setError(null);
          return;
        }
      }

      try {
        if (await mermaid.parse(code)) {
          // Valid
        }
        setError(null);
        // Using a distinct ID prefix for the modal to avoid collision with inline
        const { svg: renderedSvg } = await mermaid.render(diagramId, code);

        if (mounted) {
          cacheMermaidSvg(code, renderedSvg);
          setSvg(renderedSvg);
          if (appService && bookHash) {
            void saveMermaidSvg(appService, bookHash, codeHash, renderedSvg);
          }
        }
      } catch (err) {
        if (mounted) setError((err as Error).message);
      }
    };

    // Small delay to ensure render happens after mount
    const timeoutId = setTimeout(renderDiagram, 50);

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [code, codeHash, diagramId, appService, bookHash]);

  /**
   * Measure the diagram's intrinsic size whenever the markup changes.
   *
   * mermaid's SVG carries width/height attributes, but it is created offscreen
   * and its CSS `max-width: 100%` means the browser may render it narrower
   * than the nominal size. Reading the actual box from the DOM is the only way
   * to learn how much room the diagram really wants, which the scroll area
   * needs in order to show all of it.
   *
   * A ResizeObserver rather than a one-shot read: the modal opens while the
   * dialog is still animating in, so an immediate measurement would catch a
   * 0-width box and leave the diagram stuck at its smallest size.
   */
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      const svg = el.querySelector('svg');
      if (!svg) return;

      // viewBox is the authoritative intrinsic size: `0 0 W H`. Prefer it over
      // the width/height attributes, which mermaid may emit as percentages
      // ("100%") when the diagram is fluid — `Number('100%')` is NaN and would
      // silently fall back to whatever the container happens to be.
      let width = 0;
      let height = 0;
      const viewBox = svg.getAttribute('viewBox');
      if (viewBox) {
        const parts = viewBox.split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
          width = parts[2]!;
          height = parts[3]!;
        }
      }
      if (!width || !height) {
        const widthAttr = Number(svg.getAttribute('width'));
        const heightAttr = Number(svg.getAttribute('height'));
        if (widthAttr > 0 && heightAttr > 0) {
          width = widthAttr;
          height = heightAttr;
        }
      }
      // Last resort: the box as laid out right now.
      if (!width || !height) {
        const box = svg.getBoundingClientRect();
        width = box.width;
        height = box.height;
      }

      if (width > 0 && height > 0) {
        const w = Math.round(width);
        const h = Math.round(height);
        setNatural((prev) =>
          prev.width === w && prev.height === h ? prev : { width: w, height: h },
        );
      }
    };

    measure();
    // ResizeObserver is not universal (older WebViews, jsdom). Fall back to a
    // one-shot measure rather than throwing — without it the diagram would
    // still render, just at its intrinsic size.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [svg]);

  if (error) {
    return (
      <div className='flex h-full flex-col items-center justify-center p-4 text-red-500'>
        <p>Failed to render diagram</p>
        <pre className='mt-2 text-xs'>{error}</pre>
      </div>
    );
  }

  return (
    <div className='relative h-full w-full overflow-hidden bg-white'>
      {/* Controls */}
      <div className='absolute right-4 top-4 z-50 flex items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-sm'>
        <button
          onClick={() => handleZoom(-0.25)}
          className='rounded p-1 text-gray-600 transition-colors hover:bg-gray-100'
          title='Zoom Out'
        >
          <ZoomOut className='size-4' />
        </button>
        <button
          onClick={resetZoom}
          className='rounded p-1 text-gray-600 transition-colors hover:bg-gray-100'
          title='Reset Zoom'
        >
          <span className='inline-block w-10 text-center text-xs font-medium'>
            {Math.round(scale * 100)}%
          </span>
        </button>
        <button
          onClick={() => handleZoom(0.25)}
          className='rounded p-1 text-gray-600 transition-colors hover:bg-gray-100'
          title='Zoom In'
        >
          <ZoomIn className='size-4' />
        </button>
      </div>

      {/*
        Scroll container. `overflow: auto` + an explicitly sized inner box is
        what keeps the top of a tall diagram reachable.

        The previous version centred the content with `flex items-center` and
        gave it `height: N%`. When the content is taller than the viewport,
        `center` splits the overflow evenly above and below, and the part above
        scrollTop=0 is unreachable — that is exactly the "top is cut off" bug.
        Percent heights were also resolving against nothing in an auto-height
        box. Sizing the inner element in pixels from the measured natural size
        and using `align-items: flex-start` removes both failure modes.
      */}
      <div
        className='h-full w-full overflow-auto'
        role='presentation'
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'default' }}
      >
        <div
          // min-w/min-h keep the flex box from collapsing when the scaled
          // diagram already fills the viewport; without them the child shrinks
          // and `justify-center` re-introduces clipping.
          className='flex min-h-full w-max min-w-full items-start justify-center'
          style={{ padding: PADDING }}
        >
          <div
            ref={contentRef}
            className='mermaid-modal-canvas shrink-0'
            style={{
              // Explicit, scaled pixel box: the scrollbar then represents the
              // real content extent, so every part of the diagram is reachable.
              width: natural.width ? natural.width * scale : undefined,
              height: natural.height ? natural.height * scale : undefined,
            }}
            // The SVG must fill the box we computed, otherwise it keeps its
            // own intrinsic size and the scaling would not be visible.
            // mermaid sets width/height attributes + max-width:100% inline.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
      <style>{svgFitCss}</style>
    </div>
  );
});

export function GlobalMermaidModal() {
  const { isOpen, code, closeModal } = useMermaidStore();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className='block h-[90vh] w-full max-w-[90vw] overflow-hidden border-0 bg-transparent p-0 shadow-2xl sm:max-w-[90vw] sm:rounded-xl'>
        <DialogTitle className='sr-only'>Mermaid Diagram Full View</DialogTitle>
        <div className='relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-white'>
          <div className='absolute left-4 top-4 z-50'>
            <DialogClose className='rounded-full bg-gray-100 p-2 text-gray-600 transition-colors hover:bg-gray-200'>
              <X className='size-5' />
            </DialogClose>
          </div>
          <MermaidViewer code={code} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
