'use client';

import { useEffect, useState, useRef, memo, useMemo } from 'react';
import mermaid from 'mermaid';
import { ZoomIn, ZoomOut, Maximize2, RefreshCcw } from 'lucide-react';
import {
  useMermaidStore,
  getCachedMermaidSvg,
  cacheMermaidSvg,
  clearMermaidSvgCache,
  hashMermaidCode,
} from '@/store/mermaidStore';
import { loadMermaidSvg, saveMermaidSvg, clearMermaidSvgForBook } from '@/services/mermaidSvgStore';
import { useOptionalEnv } from '@/context/EnvContext';
import { useMermaidBookHash } from './MermaidBookContext';

// Initialize mermaid config
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'loose',
  suppressErrorRendering: true,
  themeVariables: {
    // Basic adjustments could go here
  },
});

interface MermaidBlockProps {
  code: string;
}

export const MermaidBlock = memo(function MermaidBlock({ code }: MermaidBlockProps) {
  const env = useOptionalEnv();
  const appService = env?.appService ?? null;
  const bookHash = useMermaidBookHash();
  const codeHash = useMemo(() => hashMermaidCode(code), [code]);

  // Seed from the in-memory front synchronously, so a re-mount paints the
  // already-rendered SVG on the very first frame instead of blanking out.
  const [svg, setSvg] = useState(() => getCachedMermaidSvg(code) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [retryCount, setRetryCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const { openModal } = useMermaidStore();
  // Stable ID for this component instance
  const diagramId = useMemo(() => `mermaid-${Math.random().toString(36).slice(2, 9)}`, []);
  const codeRef = useRef(code);

  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  const handleZoom = (delta: number) => {
    setScale((prev) => Math.min(Math.max(0.5, prev + delta), 5));
  };

  const resetZoom = () => setScale(1);

  useEffect(() => {
    let mounted = true;
    const currentCode = code;

    // L1: in-memory hit. Zero async work, paints immediately.
    if (retryCount === 0) {
      const cached = getCachedMermaidSvg(currentCode);
      if (cached) {
        setSvg(cached);
        setError(null);
        return;
      }
    }

    const renderDiagram = async () => {
      // Don't try to render if code is too short
      if (!currentCode || currentCode.length < 3) return;
      // Stale check
      if (currentCode !== codeRef.current) return;

      // L2: the durable copy in reedy.db. This is what makes the cache live as
      // long as the book rather than as long as the process: on a cold start,
      // or after an L1 eviction, the diagram comes back without re-rendering.
      if (retryCount === 0 && appService && bookHash) {
        const persisted = await loadMermaidSvg(appService, bookHash, codeHash);
        if (!mounted || currentCode !== codeRef.current) return;
        if (persisted) {
          cacheMermaidSvg(currentCode, persisted);
          setSvg(persisted);
          setError(null);
          return;
        }
      }

      try {
        if (await mermaid.parse(currentCode)) {
          // Valid
        }

        // Double check stale before heavier render
        if (!mounted || currentCode !== codeRef.current) return;

        // Render with stable ID
        const { svg: renderedSvg } = await mermaid.render(diagramId, currentCode);

        // Final check
        if (mounted && currentCode === codeRef.current) {
          cacheMermaidSvg(currentCode, renderedSvg);
          setSvg(renderedSvg);
          setError(null);
          // Persist for future sessions. Written after paint so a slow disk
          // never delays the diagram appearing.
          if (appService && bookHash) {
            void saveMermaidSvg(appService, bookHash, codeHash, renderedSvg);
          }
        }
      } catch (err) {
        if (mounted && currentCode === codeRef.current) {
          // Keep previous SVG if available to avoid flicker
          setSvg((prev) => {
            if (prev) return prev;
            setError((err as Error).message);
            return '';
          });
        }
      }
    };

    // Debounce stays: it only delays genuinely new diagram source (streaming
    // output), never a cache hit, which returned above.
    const timeoutId = setTimeout(renderDiagram, 500);

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [code, codeHash, diagramId, retryCount, appService, bookHash]);

  if (error && !svg) {
    return (
      <div className='border-base-300 relative my-4 rounded-md border bg-white p-4'>
        <pre className='overflow-x-auto font-mono text-xs text-black opacity-80'>{code}</pre>
        <div className='absolute right-2 top-2 flex items-center gap-2'>
          <span className='text-[10px] text-red-500'>Render Failed</span>
          <button
            onClick={() => {
              // A manual retry means "I don't trust the cached result" — drop
              // both layers so the render effect cannot short-circuit on a
              // stale hit, in memory or in the database.
              clearMermaidSvgCache();
              if (appService && bookHash) {
                void clearMermaidSvgForBook(appService, bookHash);
              }
              setError(null);
              setRetryCount((c) => c + 1);
            }}
            className='btn btn-ghost btn-xs btn-square hover:text-primary text-gray-500'
            title='Retry'
          >
            <RefreshCcw className='size-3' />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className='relative my-6 w-full rounded-lg border border-gray-200 bg-white'>
      {/* Controls */}
      <div className='absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-sm'>
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
          <span className='inline-block w-8 text-center text-xs font-medium'>
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
        <button
          onClick={() => openModal(code)}
          className='rounded p-1 text-gray-600 transition-colors hover:bg-gray-100'
          title='Maximize'
        >
          <Maximize2 className='size-4' />
        </button>
      </div>

      {/* Scrollable Container */}
      <div className='h-full w-full overflow-auto p-4' style={{ maxHeight: '600px' }}>
        <div
          ref={containerRef}
          className='mermaid-diagram flex min-h-[100px] w-full origin-top-left justify-center text-black'
          style={{
            transform: `scale(${scale})`,
            width: scale > 1 ? `${scale * 100}%` : '100%',
            transformOrigin: 'top left',
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
});
