/**
 * PDF rendering helpers built on pdf.js.
 *
 * The worker is loaded from the local bundle (no CDN), so the whole client
 * works offline.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface RenderedPage {
  /** 1-based page number. */
  number: number;
  /** Canvas width in CSS pixels at the requested scale. */
  width: number;
  /** Canvas height in CSS pixels at the requested scale. */
  height: number;
  /** PDF point size of the page, used to convert coordinates. */
  pointWidth: number;
  pointHeight: number;
  canvas: HTMLCanvasElement;
}

/** Loads a PDF from a URL into a pdf.js document proxy. */
export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ url }).promise;
}

/**
 * Renders every page of a document at the given scale.
 */
export async function renderPages(
  pdf: PDFDocumentProxy,
  scale = 1.2,
): Promise<RenderedPage[]> {
  const pages: RenderedPage[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    pages.push({
      number: index,
      width: canvas.width,
      height: canvas.height,
      pointWidth: viewport.width / scale,
      pointHeight: viewport.height / scale,
      canvas,
    });
  }
  return pages;
}

/** Converts a mouse event to PDF point coordinates inside a rendered page. */
export function eventToPoint(
  page: RenderedPage,
  event: { clientX: number; clientY: number },
): { x: number; y: number } {
  const rect = page.canvas.getBoundingClientRect();
  const scaleX = page.pointWidth / rect.width;
  const scaleY = page.pointHeight / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}
