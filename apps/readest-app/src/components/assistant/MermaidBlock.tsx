'use client';

import { useEffect, useState, useRef, memo, useMemo } from 'react';
import mermaid from 'mermaid';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { useMermaidStore } from '@/store/mermaidStore';

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
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
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

    const renderDiagram = async () => {
      // Don't try to render if code is too short
      if (!currentCode || currentCode.length < 3) return;
      // Stale check
      if (currentCode !== codeRef.current) return;

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
          setSvg(renderedSvg);
          setError(null);
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

    // Increased debounce to reduce flickering during streaming
    const timeoutId = setTimeout(renderDiagram, 500);

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [code, diagramId]);

  if (error && !svg) {
    return (
      <div className='border-base-300 relative my-4 rounded-md border bg-white p-4'>
        <pre className='overflow-x-auto font-mono text-xs text-black opacity-80'>{code}</pre>
        <div className='absolute right-2 top-2 text-[10px] text-gray-500'>Rendering diagram...</div>
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
