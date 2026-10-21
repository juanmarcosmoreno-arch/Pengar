/**
 * Foto o PDF de una factura → datos para revisar. Con clave de Claude usa la IA; si no (o si falla), el lector del
 * teléfono. Los renglones que quedan sin rubro se los pregunta a Apple Intelligence (y a Claude, si no leyó él).
 */
import { suggestRubro } from '../domain/classify';
import { norm } from '../domain/importSheet';
import { parseInvoiceText } from '../domain/invoice';
import type { Data, InvoiceItem } from '../domain/types';
import { jpegName, readImageText, toJpeg } from './ocr';
import { readPdfText } from './pdf';
import { isPreview } from './platform';
import { suggestRubros, type SuggestReason } from './suggest';

export interface DraftItem extends InvoiceItem {
  /** De dónde salió el rubro: la pantalla marca con «sugerido» los que eligió la IA */
  reason?: SuggestReason;
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

/** Renglones sin rubro → suggestRubros (Apple Intelligence y, si `claude`, Claude) */
async function fillMissing(
  items: DraftItem[],
  merchant: string | undefined,
  data: Data,
  opts: { claude: boolean; onProgress: (msg: string) => void },
): Promise<DraftItem[]> {
  const missing = items.flatMap((it, i) => (!it.rubroId && it.description.trim() ? [{ id: String(i), text: it.description, merchant }] : []));
  if (!missing.length) return items;
  const found = await suggestRubros(missing, data, opts);
  return items.map((it, i) => {
    const s = found.get(String(i));
    return s && !it.rubroId ? { ...it, rubroId: s.rubroId, reason: s.reason } : it;
  });
}

/** `password`: la del PDF, si tiene (ver PdfPasswordError) */
export async function readInvoice(file: File, data: Data, onProgress: (msg: string) => void, password?: string): Promise<InvoiceDraft> {
  const pdf = isPdf(file);
  // Las fotos se guardan reducidas (ocupan mucho menos y se leen igual)
  const image = pdf ? null : await toJpeg(file);
  const stored = image?.blob ?? file;
  const base = { file: stored, fileName: pdf ? file.name || 'factura.pdf' : jpegName(file.name, 'factura'), mime: pdf ? 'application/pdf' : 'image/jpeg' };
  let notice: string | undefined;

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
      const byName = new Map(data.rubros.filter((r) => !r.archived).map((r) => [norm(r.name), r.id]));
      const items = ai.items.map((i): DraftItem => {
        const local = suggestRubro(i.description, ai.merchant, data.rubros, data.settings.learned);
        const fromAi = i.rubro ? byName.get(norm(i.rubro)) : undefined;
        return { description: i.description, amount: i.amount, rubroId: local?.rubroId ?? fromAi, reason: local?.reason ?? (fromAi ? 'claude' : undefined) };
      });
      // Ya la leyó Claude: lo que quedó sin rubro, solo con Apple Intelligence
      const filled = await fillMissing(items, ai.merchant, data, { claude: false, onProgress });
      return { ...base, merchant: ai.merchant ?? '', date: ai.date, total: ai.total, items: filled, source: 'ia' };
    } catch (e) {
      console.error(e);
      notice = `${claudeError(e)}; se leyó con el teléfono.`;
    }
  }

  const text = pdf ? await readPdfText(file, onProgress, password) : await readImageText(stored, onProgress);
  const parsed = parseInvoiceText(text);
  const items = parsed.items.map((i): DraftItem => {
    const s = suggestRubro(i.description, parsed.merchant, data.rubros, data.settings.learned);
    return { ...i, rubroId: s?.rubroId, reason: s?.reason };
  });
  // Si Claude acaba de fallar, no se insiste
  const filled = await fillMissing(items, parsed.merchant, data, { claude: !notice, onProgress });
  return { ...base, merchant: parsed.merchant ?? '', date: parsed.date, total: parsed.total, items: filled, source: 'telefono', notice };
}
