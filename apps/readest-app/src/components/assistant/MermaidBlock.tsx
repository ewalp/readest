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
      if (!code) return;

      try {
        setError(null);
        // Clean up previous SVG potentially?
        // Generate a unique ID for the diagram
        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;

        // mermaid.render returns { svg }.
        // Note: The second arg (container) is not used for placement, just for sizing potentially?
        // Actually usually we pass the code to render.
        const { svg: renderedSvg } = await mermaid.render(id, code);

        if (mounted) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        if (mounted) {
          console.error('Mermaid rendering failed:', err);
          setError((err as Error).message);
        }
      }
    };

    renderDiagram();

    return () => {
      mounted = false;
    };
  }, [code]);

  if (error) {
    return (
      <div className='border-error/20 bg-error/10 text-error rounded-md border p-4 text-sm'>
        <p className='font-bold'>Failed to render diagram:</p>
        <pre className='mt-2 whitespace-pre-wrap'>{error}</pre>
        <pre className='border-error/20 mt-4 border-t pt-4 text-xs opacity-75'>{code}</pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className='mermaid-diagram my-6 flex justify-center overflow-x-auto rounded-lg bg-white/5 p-4'
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
