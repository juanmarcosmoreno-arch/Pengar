/**
 * Leer el texto de una foto. En el iPhone: Vision de Apple (plugin PengarOCR), en el teléfono y sin conexión; en los
 * tickets también lee el QR de la DGI y puede traer el ticket oficial que publica el súper.
 * En la web: Tesseract (se descarga la primera vez que se usa), sin QR ni ticket oficial.
 */
import { registerPlugin } from '@capacitor/core';
import { officialPortal, parseRondanetLines, rondanetForm, type Cfe, type OfficialInvoice, type Portal } from '../domain/cfe';
import { groupLines, type TextBox } from '../domain/ocrLines';
import { rowsFromBoxes, type StatementRow } from '../domain/statement';
import { isNative, isPreview } from './platform';

interface PengarOCRPlugin {
  /** Con `qr: true` también lee los QR de la foto (una app vieja no lo conoce y no devuelve `qr`) */
  recognize(options: { image: string; qr?: boolean }): Promise<{ boxes: TextBox[]; qr?: string[] }>;
  /**
   * Pide el ticket al portal del súper (Rondanet, o el de Tienda Inglesa); devuelve los renglones del PDF hasta
   * «TOTAL A PAGAR» (nunca la ADENDA)
   */
  fetchCfe(options: { ruc: string; tipo: string; serie: string; numero: string; total: string; hash6: string; portal: Portal }): Promise<{ lines: string[] }>;
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

/** Nombre de una foto guardada como JPEG: con su extensión («IMG_1234.PNG» → «IMG_1234.jpg») */
export const jpegName = (name: string, fallback: string) => `${(name || fallback).replace(/\.[^./]+$/, '')}.jpg`;

/** JPEG reducido (lado mayor hasta `max` px) y ya orientado */
export async function toJpeg(file: Blob, max = 2800): Promise<{ base64: string; blob: Blob; width: number; height: number }> {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const blob = await (await fetch(dataUrl)).blob();
  return { base64: dataUrl.split(',')[1], blob, width: canvas.width, height: canvas.height };
}

export interface TicketPhoto {
  /** Un renglón por línea */
  text: string;
  /** Lo que dicen los QR de la foto (el de la DGI, si se pudo leer) */
  qr: string[];
}

/** El texto y los QR de una foto ya reducida (`toJpeg`), en una sola pasada de Vision. Solo en el iPhone */
export async function readTicketPhoto(base64: string): Promise<TicketPhoto> {
  const res = await PengarOCR.recognize({ image: base64, qr: true });
  return { text: groupLines(res.boxes).join('\n'), qr: res.qr ?? [] };
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

/**
 * Renglones con la posición de cada pedazo de texto (para los estados de cuenta, donde importa la columna).
 * Solo en el iPhone, con las cajas de Vision; en la web devuelve null y se usa el texto de Tesseract.
 */
export async function readImageRows(file: Blob): Promise<StatementRow[] | null> {
  if (!isNative) return null;
  const { base64, width, height } = await toJpeg(file);
  const res = await PengarOCR.recognize({ image: base64 });
  return rowsFromBoxes(res.boxes, width / height);
}

// --- Ticket oficial -------------------------------------------------------------------------------------

/**
 * Por qué no se pudo traer: 'no-publicado' (el portal dice que los datos no coinciden: el súper todavía no lo publicó, o
 * algún dato se leyó mal), 'red' (sin conexión o no contestó) o 'formato' (otra respuesta, o el PDF no se entendió).
 */
export type OfficialFailure = 'no-publicado' | 'red' | 'formato';

export class OfficialReceiptError extends Error {
  constructor(readonly reason: OfficialFailure) {
    super(reason);
    this.name = 'OfficialReceiptError';
  }
}

/**
 * ¿Se puede pedir el ticket oficial? Solo en la app de iPhone (los portales no tienen CORS), de un súper con portal
 * conocido (Rondanet o el de Tienda Inglesa), con total y código de seguridad
 */
export const canFetchOfficial = (cfe: Cfe) => isNative && !isPreview && officialPortal(cfe.ruc) != null && rondanetForm(cfe) != null;

const TIMEOUT = 25_000;

/**
 * El ticket oficial del súper, leído en el iPhone: cada renglón exacto. null si no se puede pedir (web, súper sin portal
 * conocido, o falta el total o el código de seguridad). Si falla, lanza OfficialReceiptError. Los renglones del PDF
 * solo se leen acá: el PDF no se guarda ni se manda a ningún lado.
 */
export async function fetchOfficialReceipt(cfe: Cfe): Promise<OfficialInvoice | null> {
  const form = rondanetForm(cfe);
  const portal = officialPortal(cfe.ruc);
  if (!form || !portal || !canFetchOfficial(cfe)) return null;
  let lines: string[];
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OfficialReceiptError('red')), TIMEOUT);
    });
    try {
      ({ lines } = await Promise.race([PengarOCR.fetchCfe({ ...form, portal }), timeout]));
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e instanceof OfficialReceiptError) throw e;
    // El plugin rechaza con un código corto («datos», o UNIMPLEMENTED si la app es vieja)
    const code = (e as { code?: unknown } | null)?.code;
    throw new OfficialReceiptError(code === 'no-publicado' || code === 'red' ? code : 'formato');
  }
  const parsed = parseRondanetLines(Array.isArray(lines) ? lines : [], cfe);
  if (!parsed.items.length || parsed.total == null) throw new OfficialReceiptError('formato');
  return parsed;
}
