'use client';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export function PdfPreview({
  bytes,
  children,
  onReady,
}: {
  bytes: Uint8Array;
  children?: ReactNode;
  onReady?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let destroy: (() => Promise<void>) | undefined;
    void (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (stopped) return;
      pdfjs.GlobalWorkerOptions.workerSrc =
        '/api/printing/pdf-worker?v=' + encodeURIComponent(pdfjs.version);
      const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
      destroy = () => task.destroy();
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      if (stopped || !canvas.current) return;
      const viewport = page.getViewport({ scale: (zoom * 96) / 72 });
      const target = canvas.current,
        ratio = window.devicePixelRatio || 1;
      target.width = Math.ceil(viewport.width * ratio);
      target.height = Math.ceil(viewport.height * ratio);
      target.style.width = viewport.width + 'px';
      target.style.height = viewport.height + 'px';
      await page.render({ canvas: target, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
        .promise;
      if (!stopped) {
        setError('');
        onReady?.();
      }
    })().catch(() => {
      if (!stopped) setError('No pudimos representar el PDF. Volvé a abrir la vista previa.');
    });
    return () => {
      stopped = true;
      if (destroy) void destroy().catch(() => {});
    };
  }, [bytes, zoom, onReady]);
  return (
    <div>
      <label className="print-zoom">
        Zoom de pantalla
        <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
            <option key={n} value={n}>
              {n * 100} %
            </option>
          ))}
        </select>
      </label>
      <p className="muted">El zoom solo cambia la pantalla. El PDF conserva su tamaño físico.</p>
      {error && (
        <p role="alert" className="catalog-error">
          {error}
        </p>
      )}
      <div className="print-canvas-scroll">
        <div style={{ position: 'relative', width: 'max-content' }}>
          <canvas
            ref={canvas}
            aria-label="Vista previa del formulario y datos del remito"
            role="img"
          />
          {children}
        </div>
      </div>
    </div>
  );
}
