/** Texto de un PDF (facturas electrónicas). Si es un escaneo sin texto, se pasa cada página por el lector de fotos. */
import { groupLines, type TextBox } from '../domain/ocrLines';
import { readImageText } from './ocr';
import { isPreview } from './platform';

// Versión «legacy»: trae los polyfills que pdf.js necesita para dibujar (Map.getOrInsertComputed) en Safari y Chrome
async function pdfjs() {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}

const MAX_PAGES = 4;

export async function readPdfText(file: Blob, onProgress?: (msg: string) => void): Promise<string> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = Math.min(doc.numPages, MAX_PAGES);
  const out: string[] = [];
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const boxes: TextBox[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const [, , , d, e, f] = item.transform as number[];
      const h = Math.abs(d) || item.height || 10;
      boxes.push({ text: item.str, x: e / viewport.width, y: 1 - (f + h) / viewport.height, w: item.width / viewport.width, h: h / viewport.height });
    }
    out.push(...groupLines(boxes));
  }
  if (out.join('').replace(/\s/g, '').length > 20) return out.join('\n');
  // En la vista previa web no hay lector de fotos (Tesseract se descarga de otro sitio)
  if (isPreview) throw new Error('PDF escaneado');

  // Sin texto: es un escaneo. Se dibuja cada página y se lee como foto
  const texts: string[] = [];
  for (let p = 1; p <= pages; p++) {
    onProgress?.(`Leyendo la página ${p} de ${pages}…`);
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.9));
    texts.push(await readImageText(blob, onProgress));
  }
  return texts.join('\n');
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
