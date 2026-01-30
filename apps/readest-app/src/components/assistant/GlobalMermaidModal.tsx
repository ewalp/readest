import { memo, useEffect, useState, useRef } from 'react';
import mermaid from 'mermaid';
import { ZoomIn, ZoomOut, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogClose } from '@/components/primitives/dialog';
import { useMermaidStore } from '@/store/mermaidStore';

// Reusing the logic from MermaidBlock but simplified for the modal viewer
const MermaidViewer = memo(function MermaidViewer({ code }: { code: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [diagramId] = useState(() => `mermaid-modal-${Math.random().toString(36).slice(2, 9)}`);

  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const scrollStart = useRef({ x: 0, y: 0 });

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

    const renderDiagram = async () => {
      if (!code) return;
      try {
        if (await mermaid.parse(code)) {
          // Valid
        }
        setError(null);
        // Using a distinct ID prefix for the modal to avoid collision with inline
        const { svg: renderedSvg } = await mermaid.render(diagramId, code);

        if (mounted) setSvg(renderedSvg);
      } catch (err) {
        if (mounted) setError((err as Error).message);
      }
    };

    // Small delay to ensure render happens after mount
    setTimeout(renderDiagram, 50);

    return () => {
      mounted = false;
    };
  }, [code, diagramId]);

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

      <div
        className='h-full w-full overflow-auto p-8'
        role='presentation'
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'default' }}
      >
        <div
          className='flex min-h-full w-full origin-top-left items-center justify-center'
          style={{
            transform: `scale(${scale})`,
            width: scale > 1 ? `${scale * 100}%` : '100%',
            height: scale > 1 ? `${scale * 100}%` : '100%',
            transformOrigin: 'top left',
            pointerEvents: 'none', // Allow clicks to pass through to container for dragging? No, SVG might have interactions.
            // But if we want to drag, we need to capture events on container.
            // SVG interactions (clicks) usually work on mouse up if no drag occurred.
            // For now, let's keep interactions enabled but prevent selection if dragging.
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
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
