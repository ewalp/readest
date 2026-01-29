'use client';

import { useEffect, useState, useRef } from 'react';
import mermaid from 'mermaid';

// Initialize mermaid config
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'loose',
  themeVariables: {
    // Basic adjustments to match typical light/dark modes
    // Proper theming might require observing system theme or data attributes
  },
});

interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;

    const renderDiagram = async () => {
      // Don't try to render if code is too short
      if (!code || code.length < 10) return;

      try {
        // Validate syntax first to avoid "Syntax error" SVG
        // mermaid has .parse since v10.
        await mermaid.parse(code);

        setError(null);
        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, code);

        if (mounted) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        if (mounted) {
          // console.error('Mermaid parsing/rendering failed:', err);
          setError((err as Error).message);
        }
      }
    };

    const timeoutId = setTimeout(renderDiagram, 200); // Debounce to allow typing completion

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [code]);

  if (error) {
    // Fallback to displaying code if rendering fails (likely due to incomplete streaming)
    return (
      <div className='border-base-300 bg-base-200 relative my-4 rounded-md border p-4'>
        <pre className='overflow-x-auto font-mono text-xs opacity-80'>{code}</pre>
        <div className='text-base-content/40 absolute right-2 top-2 text-[10px]'>
          Rendering diagram...
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className='mermaid-diagram my-6 flex w-full justify-center overflow-x-auto rounded-lg bg-white/5 p-4'
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
