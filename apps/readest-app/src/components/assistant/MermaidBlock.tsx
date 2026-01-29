'use client';

import { useEffect, useState, useRef, memo, useMemo } from 'react';
import mermaid from 'mermaid';
import { ZoomIn, ZoomOut } from 'lucide-react';

// Initialize mermaid config
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'loose',
  suppressErrorRendering: true, // We handle errors manually
  themeVariables: {
    // Basic adjustments to match typical light/dark modes
    // Proper theming might require observing system theme or data attributes
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
  // Stable ID for this component instance
  const diagramId = useMemo(() => `mermaid-${Math.random().toString(36).slice(2, 9)}`, []);

  const handleZoom = (delta: number) => {
    setScale((prev) => Math.min(Math.max(0.5, prev + delta), 3));
  };

  const resetZoom = () => setScale(1);

  useEffect(() => {
    let mounted = true;

    const renderDiagram = async () => {
      // Don't try to render if code is too short
      if (!code || code.length < 3) return;

      try {
        // Validate syntax first
        if (await mermaid.parse(code)) {
          // It's valid
        }

        setError(null);

        // Render with stable ID
        const { svg: renderedSvg } = await mermaid.render(diagramId, code);

        if (mounted) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        if (mounted) {
          // If we already have a valid SVG, don't show error, just keep the old one
          // This prevents flickering during streaming when syntax is temporarily broken
          setSvg((prev) => {
            if (prev) return prev;
            setError((err as Error).message);
            return '';
          });
        }
      }
    };

    const timeoutId = setTimeout(renderDiagram, 200);

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [code, diagramId]);

  if (error && !svg) {
    // Fallback to displaying code if rendering fails and we have no previous valid SVG
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
      </div>

      {/* Scrollable Container */}
      <div className='overflow-auto p-4' style={{ maxHeight: '600px' }}>
        <div
          ref={containerRef}
          className='mermaid-diagram flex min-h-[100px] w-full origin-top-left justify-center text-black'
          style={{
            transform: `scale(${scale})`,
            width: scale > 1 ? `${scale * 100}%` : '100%',
            transformOrigin: 'top center',
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
});
