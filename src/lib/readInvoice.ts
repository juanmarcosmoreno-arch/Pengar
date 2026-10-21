/**
 * Foto o PDF de una factura → datos para revisar. Con clave de Claude usa la IA; si no (o si falla), el lector del
 * teléfono. Los renglones que quedan sin rubro se los pregunta a Apple Intelligence (y a Claude, si no leyó él).
 * En el iPhone, si la foto es un e-Ticket (el QR de la DGI, o sus códigos impresos), el total y la fecha del QR son
 * exactos, el RUT dice el comercio y, si el súper publica el ticket oficial, se usan sus renglones.
 */
import { differenceOf, findCfe, prefersOfficial, withCfe, type Cfe, type OfficialInvoice } from '../domain/cfe';
import { suggestRubro } from '../domain/classify';
import { norm } from '../domain/importSheet';
import { parseInvoiceText, type ParsedInvoice } from '../domain/invoice';
import type { Data, InvoiceItem } from '../domain/types';
import {
  canFetchOfficial, fetchOfficialReceipt, jpegName, OfficialReceiptError, readImageText, readTicketPhoto, toJpeg,
  type OfficialFailure, type TicketPhoto,
} from './ocr';
import { readPdfText } from './pdf';
import { isNative, isPreview } from './platform';
import { suggestRubros, type SuggestReason } from './suggest';

export interface DraftItem extends InvoiceItem {
  /** De dónde salió el rubro: la pantalla marca con «sugerido» los que eligió la IA */
  reason?: SuggestReason;
  /** El descuento de un producto (el renglón de ese índice): va a su rubro */
  discountOf?: number;
}

export interface InvoiceDraft {
  file: Blob;
  fileName: string;
  mime: string;
  merchant: string;
  date?: string;
  total?: number;
  items: DraftItem[];
  source: 'ia' | 'telefono';
  /**
   * e-Ticket de la DGI: 'oficial' si los renglones son los del ticket que publicó el súper; 'qr' si del QR salieron solo
   * el total y la fecha. `url`: el link del QR (para verlo en la DGI)
   */
  dgi?: { from: 'oficial' | 'qr'; url: string | null };
  /** Aviso para mostrar (por ejemplo, si la IA falló y se usó el lector local) */
  notice?: string;
}

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Por qué no anduvo Claude, en criollo (el mensaje del SDK es un JSON en inglés) */
export function claudeError(e: unknown): string {
  const status = typeof e === 'object' && e && 'status' in e ? Number((e as { status: unknown }).status) : NaN;
  const name = e instanceof Error ? e.name : '';
  if (status === 401 || status === 403) return 'La clave de Claude no es válida: revisala en Ajustes';
  if (status === 429 || status === 529 || status === 402) return 'Claude está ocupado o tu cuenta de Anthropic no tiene saldo';
  if (/Connection/.test(name) || (e instanceof TypeError && /fetch|network/i.test(e.message))) return 'No hay conexión para usar Claude';
  return 'Claude no respondió';
}

async function base64Of(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** El descuento de un producto va al rubro de ese producto */
const withDiscountRubros = (items: DraftItem[]): DraftItem[] =>
  items.map((it) => {
    const product = it.discountOf != null ? items[it.discountOf] : undefined;
    return product?.rubroId && !it.rubroId ? { ...it, rubroId: product.rubroId, reason: product.reason } : it;
  });

/** Renglones sin rubro → suggestRubros (Apple Intelligence y, si `claude`, Claude); los descuentos, el de su producto */
async function fillMissing(
  items: DraftItem[],
  merchant: string | undefined,
  data: Data,
  opts: { claude: boolean; onProgress: (msg: string) => void },
): Promise<DraftItem[]> {
  const missing = items.flatMap((it, i) => (!it.rubroId && it.discountOf == null && it.description.trim() ? [{ id: String(i), text: it.description, merchant }] : []));
  if (!missing.length) return withDiscountRubros(items);
  const found = await suggestRubros(missing, data, opts);
  return withDiscountRubros(items.map((it, i) => {
    const s = found.get(String(i));
    return s && !it.rubroId ? { ...it, rubroId: s.rubroId, reason: s.reason } : it;
  }));
}

/**
 * Por qué no se usó el ticket oficial, en criollo. 'no-publicado' es «los datos no coinciden»: con el QR, casi
 * seguro que todavía no lo publicó; con los códigos leídos de lo impreso, también puede ser uno mal leído
 */
const OFFICIAL_FAILED: Record<OfficialFailure, string> = {
  'no-publicado': 'El súper todavía no publicó el ticket oficial: mañana sacale la foto de nuevo. Por ahora, quedó lo leído de la foto.',
  red: 'Sin conexión para traer el ticket oficial: quedó lo leído de la foto.',
  formato: 'No se pudo leer el ticket oficial del súper: quedó lo leído de la foto.',
};

interface DgiTicket {
  cfe: Cfe;
  /** Los renglones exactos, si se pudieron traer (y cierran mejor que la foto) */
  official?: OfficialInvoice;
  notice?: string;
}

/** El e-Ticket de la foto (por el QR o lo impreso) y, si el súper lo publica, el ticket oficial */
async function dgiTicket(photo: TicketPhoto, onProgress: (msg: string) => void): Promise<DgiTicket | null> {
  const read = parseInvoiceText(photo.text);
  const cfe = findCfe(photo.qr, photo.text, read);
  if (!cfe) return null;
  if (!canFetchOfficial(cfe)) return { cfe };
  onProgress('Trayendo el ticket oficial…');
  try {
    const official = await fetchOfficialReceipt(cfe);
    // Manda el oficial, salvo que la foto cierre mejor (un ticket largo sigue en la página 2, que no se lee)
    if (official && prefersOfficial(official, { difference: differenceOf(withCfe(read, cfe)) })) return { cfe, official };
    return { cfe };
  } catch (e) {
    console.warn('No se pudo traer el ticket oficial', e);
    const reason = e instanceof OfficialReceiptError ? e.reason : 'formato';
    if (reason === 'no-publicado' && cfe.source !== 'qr') {
      return {
        cfe,
        notice: 'El súper no encontró el ticket con los datos leídos de la foto: puede que todavía no lo haya publicado o que un código o el total se hayan leído mal. Quedó lo leído de la foto.',
      };
    }
    return { cfe, notice: OFFICIAL_FAILED[reason] };
  }
}

/** El sello de la pantalla: renglones del ticket oficial, o el total y la fecha del QR */
function dgiMark(ticket: DgiTicket | null): InvoiceDraft['dgi'] {
  if (ticket?.official) return { from: 'oficial', url: ticket.cfe.url };
  return ticket?.cfe.source === 'qr' && ticket.cfe.total != null ? { from: 'qr', url: ticket.cfe.url } : undefined;
}

const joinNotices = (notices: (string | undefined)[]) => notices.filter(Boolean).join(' ') || undefined;

/** Renglones leídos → con el rubro de lo aprendido y las palabras clave (el descuento de un producto, el de ese producto) */
const withLocalRubros = (items: ParsedInvoice['items'], merchant: string | undefined, data: Data) =>
  withDiscountRubros(items.map((i): DraftItem => {
    if (i.discountOf != null) return { description: i.description, amount: i.amount, discountOf: i.discountOf };
    const s = suggestRubro(i.description, merchant, data.rubros, data.settings.learned);
    return { description: i.description, amount: i.amount, rubroId: s?.rubroId, reason: s?.reason };
  }));

/** `password`: la del PDF, si tiene (ver PdfPasswordError) */
export async function readInvoice(file: File, data: Data, onProgress: (msg: string) => void, password?: string): Promise<InvoiceDraft> {
  const pdf = isPdf(file);
  // Las fotos se guardan reducidas (ocupan mucho menos y se leen igual)
  const image = pdf ? null : await toJpeg(file);
  const stored = image?.blob ?? file;
  const base = { file: stored, fileName: pdf ? file.name || 'factura.pdf' : jpegName(file.name, 'factura'), mime: pdf ? 'application/pdf' : 'image/jpeg' };

  // En el iPhone, la foto pasa primero por Vision, que en la misma pasada lee el QR de la DGI
  let photo: TicketPhoto | null = null;
  if (image && isNative) {
    try {
      photo = await readTicketPhoto(image.base64, image.height / image.width);
    } catch (e) {
      // Se sigue como siempre: Claude, o el lector de fotos (que avisa si no puede)
      console.error(e);
    }
  }
  const ticket = photo ? await dgiTicket(photo, onProgress) : null;
  const dgi = dgiMark(ticket);
  if (ticket?.official) {
    // Renglones exactos: no hace falta que lea Claude (sí puede sugerir rubros)
    const { merchant, date, total } = ticket.official;
    const filled = await fillMissing(withLocalRubros(ticket.official.items, merchant, data), merchant, data, { claude: true, onProgress });
    return { ...base, merchant: merchant ?? '', date, total, items: filled, source: 'telefono', dgi };
  }
  /** Lo que asegura el ticket (comercio, y del QR el total y la fecha), sobre lo leído */
  const fix = <T extends ParsedInvoice>(read: T): T => (ticket ? withCfe(read, ticket.cfe) : read);
  let claudeFailed: string | undefined;

  const { apiKey, model } = data.settings.ai;
  // En la vista previa web no se puede llamar a Anthropic (el if de afuera saca el SDK de esa build)
  // Un PDF con contraseña no lo puede leer Claude: va directo al lector del teléfono
  if (!isPreview && apiKey && !password) {
    try {
      onProgress('Leyendo la factura con Claude…');
      const { readInvoiceWithClaude } = await import('./ai');
      const ai = await readInvoiceWithClaude(
        { base64: image?.base64 ?? (await base64Of(file)), mime: base.mime },
        { apiKey, model, rubros: data.rubros, categories: data.categories },
      );
      const read = fix(ai);
      const byName = new Map(data.rubros.filter((r) => !r.archived).map((r) => [norm(r.name), r.id]));
      const items = read.items.map((i): DraftItem => {
        const local = suggestRubro(i.description, read.merchant, data.rubros, data.settings.learned);
        const fromAi = i.rubro ? byName.get(norm(i.rubro)) : undefined;
        return { description: i.description, amount: i.amount, rubroId: local?.rubroId ?? fromAi, reason: local?.reason ?? (fromAi ? 'claude' : undefined) };
      });
      // Ya la leyó Claude: lo que quedó sin rubro, solo con Apple Intelligence
      const filled = await fillMissing(items, read.merchant, data, { claude: false, onProgress });
      return { ...base, merchant: read.merchant ?? '', date: read.date, total: read.total, items: filled, source: 'ia', dgi, notice: ticket?.notice };
    } catch (e) {
      console.error(e);
      claudeFailed = `${claudeError(e)}; se leyó con el teléfono.`;
    }
  }

  const text = photo?.text ?? (pdf ? await readPdfText(file, onProgress, password) : await readImageText(stored, onProgress));
  const parsed = fix(parseInvoiceText(text));
  // Si Claude acaba de fallar, no se insiste
  const filled = await fillMissing(withLocalRubros(parsed.items, parsed.merchant, data), parsed.merchant, data, { claude: !claudeFailed, onProgress });
  return {
    ...base, merchant: parsed.merchant ?? '', date: parsed.date, total: parsed.total, items: filled, source: 'telefono', dgi,
    notice: joinNotices([claudeFailed, ticket?.notice]),
  };
}
