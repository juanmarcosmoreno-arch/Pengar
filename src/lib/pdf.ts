/** Texto de un PDF (facturas electrónicas). Si es un escaneo sin texto, se pasa cada página por el lector de fotos. */
import { groupLines, type TextBox } from '../domain/ocrLines';
import { readImageText } from './ocr';

async function pdfjs() {
  const lib = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
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
