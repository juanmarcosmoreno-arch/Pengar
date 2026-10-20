/**
 * Leer el texto de una foto. En el iPhone: Vision de Apple (plugin PengarOCR), en el teléfono y sin conexión.
 * En la web: Tesseract (se descarga la primera vez que se usa).
 */
import { registerPlugin } from '@capacitor/core';
import { groupLines, type TextBox } from '../domain/ocrLines';
import { isNative } from './platform';

interface PengarOCRPlugin {
  recognize(options: { image: string }): Promise<{ boxes: TextBox[] }>;
}

const PengarOCR = registerPlugin<PengarOCRPlugin>('PengarOCR');

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo abrir la imagen'));
    };
    img.src = url;
  });
}

/** JPEG reducido (lado mayor hasta `max` px) y ya orientado */
export async function toJpeg(file: Blob, max = 2800): Promise<{ base64: string; blob: Blob }> {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const blob = await (await fetch(dataUrl)).blob();
  return { base64: dataUrl.split(',')[1], blob };
}

export async function readImageText(file: Blob, onProgress?: (msg: string) => void): Promise<string> {
  if (isNative) {
    const { base64 } = await toJpeg(file);
    const res = await PengarOCR.recognize({ image: base64 });
    return groupLines(res.boxes).join('\n');
  }
  onProgress?.('Preparando el lector de texto…');
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('spa');
  try {
    onProgress?.('Leyendo la foto…');
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
