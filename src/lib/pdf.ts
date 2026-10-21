/**
 * Texto de un PDF (facturas electrónicas y estados de cuenta). Si es un escaneo sin texto, se pasa cada página por
 * el lector de fotos.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { groupLines, type TextBox } from '../domain/ocrLines';
import { rowsFromBoxes, rowsFromText, type StatementRow } from '../domain/statement';
import { readImageRows, readImageText } from './ocr';
import { isPreview } from './platform';

// Versión «legacy»: trae los polyfills que pdf.js necesita para dibujar (Map.getOrInsertComputed) en Safari y Chrome
async function pdfjs() {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}

/** Abre el PDF, hace lo que haga falta y lo cierra (libera el worker) */
async function withPdf<T>(file: Blob, fn: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    return await fn(await task.promise);
  } finally {
    void task.destroy();
  }
}

/** Los pedazos de texto de una página, con su caja normalizada (origen arriba a la izquierda) */
async function pageBoxes(page: PDFPageProxy): Promise<{ boxes: TextBox[]; aspect: number }> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const boxes: TextBox[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [, , , d, e, f] = item.transform as number[];
    const h = Math.abs(d) || item.height || 10;
    boxes.push({ text: item.str, x: e / viewport.width, y: 1 - (f + h) / viewport.height, w: item.width / viewport.width, h: h / viewport.height });
  }
  return { boxes, aspect: viewport.width / viewport.height };
}

const textLength = (boxes: TextBox[]) => boxes.map((b) => b.text).join('').replace(/\s/g, '').length;

/** La página dibujada como foto, para leerla con el lector de fotos (PDF escaneado) */
async function pageImage(page: PDFPageProxy): Promise<Blob> {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
  return new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.9));
}

const MAX_PAGES = 4;

export async function readPdfText(file: Blob, onProgress?: (msg: string) => void): Promise<string> {
  return withPdf(file, async (doc) => {
    const pages = Math.min(doc.numPages, MAX_PAGES);
    const out: string[] = [];
    for (let p = 1; p <= pages; p++) out.push(...groupLines((await pageBoxes(await doc.getPage(p))).boxes));
    if (out.join('').replace(/\s/g, '').length > 20) return out.join('\n');
    // En la vista previa web no hay lector de fotos (Tesseract se descarga de otro sitio)
    if (isPreview) throw new Error('PDF escaneado');

    // Sin texto: es un escaneo. Se dibuja cada página y se lee como foto
    const texts: string[] = [];
    for (let p = 1; p <= pages; p++) {
      onProgress?.(`Leyendo la página ${p} de ${pages}…`);
      texts.push(await readImageText(await pageImage(await doc.getPage(p)), onProgress));
    }
    return texts.join('\n');
  });
}

/** Los estados de cuenta son más largos que una factura */
const STATEMENT_PAGES = 10;

/**
 * Renglones de un estado de cuenta con la posición de cada celda (para saber si un importe está en la columna de
 * pesos o en la de dólares). Si es un escaneo: en el iPhone con las cajas de Vision; en la web, el texto de
 * Tesseract sin posiciones.
 */
export async function readPdfRows(file: Blob, onProgress?: (msg: string) => void): Promise<StatementRow[]> {
  return withPdf(file, async (doc) => {
    const pages = Math.min(doc.numPages, STATEMENT_PAGES);
    const rows: StatementRow[] = [];
    let chars = 0;
    for (let p = 1; p <= pages; p++) {
      const { boxes, aspect } = await pageBoxes(await doc.getPage(p));
      chars += textLength(boxes);
      rows.push(...rowsFromBoxes(boxes, aspect));
    }
    if (chars > 20) return rows;
    if (isPreview) throw new Error('PDF escaneado');

    const scanned: StatementRow[] = [];
    for (let p = 1; p <= pages; p++) {
      onProgress?.(`Leyendo la página ${p} de ${pages}…`);
      const image = await pageImage(await doc.getPage(p));
      scanned.push(...((await readImageRows(image)) ?? rowsFromText(await readImageText(image, onProgress))));
    }
    return scanned;
  });
}

const VIEW_PAGES = 6;

/** Dibuja las primeras páginas de un PDF para verlo: cada una en un canvas de `cssWidth` px de ancho, nítido según la pantalla */
export async function renderPdfPages(file: Blob, cssWidth: number): Promise<{ pages: HTMLCanvasElement[]; total: number }> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  // Tope de 3x: en el iPhone un canvas muy grande se queda en blanco
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  try {
    const pages: HTMLCanvasElement[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, VIEW_PAGES); p++) {
      const page = await doc.getPage(p);
      const scale = cssWidth / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      pages.push(canvas);
    }
    return { pages, total: doc.numPages };
  } finally {
    void task.destroy();
  }
}
