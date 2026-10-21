/**
 * Texto de una factura o ticket (leído de una foto o de un PDF) → comercio, fecha, total y renglones con monto.
 * Dos lectores: el de las facturas, que no depende del formato de ningún comercio (busca montos al final de cada
 * renglón y descarta los que son totales, impuestos o datos del pago), y el de los tickets de súper (receipt.ts, el de
 * Kvar: cantidad × precio en dos renglones, descuentos, bolsas, el ruido del OCR). Si el texto parece un ticket de súper
 * se leen los dos y queda el que mejor cierra con el TOTAL.
 */
import { merchantOfRuc } from './cfe';
import { validDay } from './importSheet';
import { round2 } from './money';
import { detectStore, discountsFit, parseReceiptText, storeName } from './receipt';

export interface ParsedInvoice {
  merchant?: string;
  date?: string;
  total?: number;
  /** `discountOf`: el renglón es el descuento del producto de ese índice (va al mismo rubro) */
  items: { description: string; amount: number; discountOf?: number }[];
}

// Los miles van con punto o coma, no con espacio: en «HUEVOS X 12 189,00» el 12 es del producto
const AMOUNT_AT_END = /(-?\s?\$?\s?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?)\s*-?$/;

/**
 * Renglones que no son productos ni servicios. Cada palabra va entera (con su plural): «cabal» no es «CABALLA» ni
 * «lote» es «LOTERIA». «Nº», «No.» o «No» suelto es un número de comprobante, no «NORTEÑA».
 */
const NOT_ITEM = new RegExp(
  [
    'total', 'sub ?total', 'iva', 'impuesto', 'tasa', 'cambio', 'vuelto', 'efectivo', 'tarjeta', 'pago', 'pagado', 'cobrado',
    'r\\.?u\\.?[ct]', 'c\\.?i\\.?\\b', 'fecha', 'hora', 'serie', 'n[º°]', 'no\\.', 'no$', 'nro', 'numero', 'cfe', 'e-?ticket',
    'e-?factura', 'redondeo', 'gravado', 'exento', 'no gravado', 'neto', 'base', 'cuota', 'saldo', 'vencimiento', 'vence', 'cliente',
    'consumo final', 'caja', 'cajero', 'ticket', 'telefono', 'tel\\b', 'direccion', 'codigo', 'monto', 'importe', 'debito', 'credito',
    'visa', 'master', 'master ?card', 'oca', 'cabal', 'amex', 'transaccion', 'autorizacion', 'lote', 'terminal', 'comprobante', 'dgi',
    'ley', 'descuento ley', 'devolucion iva', 'resolucion', 'puntos', 'ahorraste', 'items?\\b', 'articulos', 'cantidad',
  ].map((w) => `\\b(?:${w})(?:e?s)?(?![a-z])`)
    // «COD SEGURIDAD», «Cod. de Seguridad», «Código de seguridad»
    .concat('\\bcod(?:igo)?\\.?(?: de)? seg')
    .join('|'),
  'i',
);

const DISCOUNT = /\b(desc(uento)?|bonif|promo|ahorro|rebaja)\b/i;

/** El renglón de la cantidad, debajo del producto: «1.324 KG x 319.00», «2 UN x 45,00» (no es otro producto) */
const QUANTITY_LINE = /^\s*\d+(?:[.,]\d+)?\s*(?:un|u|unid|kgs?|lts?|l|grs?|g)?\.?\s*[x*]\s*\$?\s*[\d.,]+\s*$/i;
/** Un renglón que termina en una fecha («BJ1000001 17/10/2026»): el año no es un monto */
const DATE_AT_END = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\s*$/;

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Monto de factura: en Uruguay la coma es decimal («1.240,50»), pero los PDF a veces usan punto («1240.50») */
export function invoiceAmount(raw: string): number | null {
  let s = raw.replace(/[$\s]/g, '');
  const negative = s.startsWith('-') || s.endsWith('-');
  s = s.replace(/-/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const m = s.match(/^(.*?)(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  const intPart = m[1].replace(/[.,]/g, '');
  const dec = m[2] ?? '';
  if (!intPart) return null;
  const n = Number(`${intPart}.${dec || '0'}`);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function lastAmount(line: string): { amount: number; text: string } | null {
  const m = line.match(AMOUNT_AT_END);
  if (!m) return null;
  const amount = invoiceAmount(m[1]);
  if (amount == null) return null;
  return { amount, text: line.slice(0, m.index).trim() };
}

const pad = (n: string) => n.padStart(2, '0');

export function findDate(text: string): string | undefined {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
  const candidates: string[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    // Las imposibles (31/06, 31/02: el lector de fotos a veces lee mal un número) no cuentan
    if (validDay(+y, +m[2], +m[1])) candidates.push(`${y}-${pad(m[2])}-${pad(m[1])}`);
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) if (validDay(+m[1], +m[2], +m[3])) candidates.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of plain(text).matchAll(/\b(\d{1,2})\s+(?:de\s+)?([a-z]{3})[a-z]*\.?\s+(?:de\s+)?(\d{4})\b/g)) {
    const i = months.indexOf(m[2] === 'sep' ? 'set' : m[2]);
    if (i >= 0 && validDay(+m[3], i + 1, +m[1])) candidates.push(`${m[3]}-${pad(String(i + 1))}-${pad(m[1])}`);
  }
  // La primera fecha razonable (no muy vieja ni en el futuro lejano: las facturas de servicios traen el vencimiento)
  const now = new Date();
  const limit = new Date(now.getFullYear(), now.getMonth() + 2, 1).toISOString().slice(0, 10);
  return candidates.find((d) => d >= '2000-01-01' && d <= limit);
}

function findTotal(lines: string[]): number | undefined {
  const scored: { amount: number; score: number; index: number }[] = [];
  lines.forEach((line, i) => {
    const p = plain(line);
    if (!/\btotal\b|\bimporte\b|\ba pagar\b|\bmonto\b/.test(p) || /\bsub ?total\b|\biva\b|\bitems?\b|\barticulos\b/.test(p)) return;
    let found = lastAmount(line);
    // El monto puede quedar en el renglón de abajo
    if (!found && lines[i + 1]) {
      const next = lastAmount(lines[i + 1]);
      if (next && !/[a-z]{3}/i.test(next.text)) found = next;
    }
    if (!found || found.amount <= 0) return;
    let score = 1;
    if (/a pagar|total a pagar|importe total|total factura|total general/.test(p)) score = 3;
    else if (/^\s*total\b/.test(p)) score = 2;
    scored.push({ amount: found.amount, score, index: i });
  });
  if (!scored.length) return undefined;
  scored.sort((a, b) => b.score - a.score || b.amount - a.amount);
  return scored[0].amount;
}

function findMerchant(lines: string[]): string | undefined {
  for (const line of lines.slice(0, 8)) {
    const t = line.trim();
    const p = plain(t);
    if (t.length < 3 || !/[a-z]{3}/i.test(t)) continue;
    if (/\b(rut|ruc|e-?ticket|e-?factura|fecha|tel|direccion|consumo final|cfe|serie|documento|copia|original|bienvenid)/.test(p)) continue;
    if (/^\d/.test(t) && !/[a-z]{4}/i.test(t)) continue;
    return t.replace(/\s{2,}/g, ' ').replace(/[*_=]+/g, '').trim().slice(0, 60);
  }
  return undefined;
}

/** El lector de facturas: montos al final de cada renglón */
function genericItems(lines: string[]): { total?: number; items: ParsedInvoice['items'] } {
  const total = findTotal(lines);
  const items: ParsedInvoice['items'] = [];
  for (const line of lines) {
    if (QUANTITY_LINE.test(line)) continue;
    const date = DATE_AT_END.exec(line);
    if (date && validDay(+(date[3].length === 2 ? `20${date[3]}` : date[3]), +date[2], +date[1])) continue;
    const found = lastAmount(line);
    if (!found) continue;
    // Sacar cantidades y precios unitarios: «2 x 45,00», «1,000 UN x 120,00»
    let desc = found.text.replace(/\b\d+(?:[.,]\d+)?\s*(?:un|u|kg|lt|l|gr|g)?\.?\s*[x*]\s*\$?\s*[\d.,]+\s*$/i, '').trim();
    desc = desc.replace(/^\d{4,}\s+/, '').replace(/[$:]+\s*$/, '').trim();
    const p = plain(desc);
    if (!/[a-z]{2}/.test(p) || desc.length < 2) continue;
    const isDiscount = DISCOUNT.test(p);
    if (!isDiscount && NOT_ITEM.test(p)) continue;
    let amount = found.amount;
    if (isDiscount && amount > 0) amount = -amount;
    if (amount === 0 || Math.abs(amount) > 1e8) continue;
    // Un renglón con el mismo monto que el total, muy probablemente es el total con otra palabra
    if (total != null && !isDiscount && Math.abs(amount - total) < 0.01 && items.length > 0) continue;
    items.push({ description: desc.replace(/\s{2,}/g, ' '), amount: round2(amount) });
  }
  return { total, items };
}

/** Un súper conocido, «e-Ticket» o «Supermercados» */
const SUPER_RE = /\b(?:e-?\s?ticket|supermercados?|disco|devoto|g[eé]ant|ta-?ta|tienda\s*inglesa|tiendainglesa|macromercado|el\s+dorado|multi[\s.-]*ahorro|kinko)\b/i;
/** Un renglón de cantidad × precio: «1.324 KG x 319.00», «2 x 45,90», «2 UN @ 45,00» */
const QTY_PRICE_RE = /(?:^|\s)\d{1,4}(?:[.,]\d{1,3})?\s*(?:kgs?|kgr|un|und|uni|u)?\.?\s*[x×@*]\s*\$?\s*\d+[.,]\d{2}(?!\d)/im;

/** ¿Puede ser un ticket de súper? Un súper conocido (por el nombre o el RUT), «e-Ticket» o renglones de cantidad × precio */
export function looksLikeReceipt(text: string): boolean {
  return SUPER_RE.test(text) || QTY_PRICE_RE.test(text) || [...text.matchAll(/\b\d{12}\b/g)].some((m) => merchantOfRuc(m[0]) != null);
}

/** Lo leído y qué tan bien cierra: suma de los renglones (y el redondeo) − total; null sin total */
interface Reading {
  invoice: ParsedInvoice;
  difference: number | null;
}

const closeness = (r: Reading) => (r.difference == null ? Infinity : Math.abs(r.difference));

function readText(text: string): Reading {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, ' ').trim()).filter(Boolean);
  const date = findDate(text);
  const generic = genericItems(lines);
  const sum = (items: ParsedInvoice['items']) => items.reduce((s, i) => s + i.amount, 0);
  const plainReading: Reading = {
    invoice: { merchant: findMerchant(lines), date, ...generic },
    difference: generic.total == null ? null : round2(sum(generic.items) - generic.total),
  };
  if (!looksLikeReceipt(text)) return plainReading;

  // El lector de tickets: cada renglón de plata (los descuentos de un producto, con el índice de ese producto)
  const r = parseReceiptText(text);
  const items: ParsedInvoice['items'] = [];
  const at = new Map<number, number>();
  r.entries.forEach((e, i) => {
    if (!e.amount) return;
    const of = e.of != null ? at.get(e.of) : undefined;
    at.set(i, items.length);
    items.push({ description: e.description.replace(/\s{2,}/g, ' '), amount: e.amount, ...(of != null ? { discountOf: of } : {}) });
  });
  // El comercio: lo de arriba del ticket, o el súper de arriba si eso no lo dice (puede haber una publicidad antes del
  // logo). Solo en el encabezado (los renglones sin monto): «DISCO DURO 1TB 2.890,00» es un producto
  const header = lines.slice(0, 10).filter((l) => !/\d[.,]\d{2}\s*[A-Z]?$/.test(l));
  const merchant = storeName(detectStore(header.join('\n')), plainReading.invoice.merchant);
  const receiptReading: Reading = { invoice: { merchant, date, total: r.total ?? undefined, items }, difference: r.difference };
  // A igualdad, el de tickets
  return closeness(receiptReading) <= closeness(plainReading) + 0.005
    ? receiptReading
    : { ...plainReading, invoice: { ...plainReading.invoice, merchant } };
}

export function parseInvoiceText(text: string): ParsedInvoice {
  return readText(text).invoice;
}

/** Puntaje de una lectura que encontró el TOTAL y cierra con él */
export const INVOICE_CLOSES = 10_000;

/**
 * Qué tan bien se leyeron los renglones de la foto, para elegir entre formas de armarlos (bestGrouping): primero que
 * encuentre el TOTAL, después que la suma cierre, después que cada descuento vaya con su monto negativo y después
 * cuántos renglones. (Un renglón que cuesta lo mismo que el TOTAL no cuenta: es el total pegado a otro renglón.)
 */
export function invoiceLinesScore(rows: string[]): number {
  const { invoice, difference } = readText(rows.join('\n'));
  const { total } = invoice;
  const items = invoice.items.filter((i) => total == null || Math.abs(i.amount - total) >= 0.5).length;
  const closes = difference != null && Math.abs(difference) < 0.5;
  return (total == null ? -100_000 : 0) + (closes ? INVOICE_CLOSES : 0) + discountsFit(rows) * 3 + items;
}

/**
 * Reparte el total de la factura entre grupos de renglones: lo que no está en ningún renglón (impuestos,
 * redondeos, cargos) se reparte en proporción a cada grupo, así la suma da exactamente el total.
 */
export function distributeTotal<K extends string>(groups: Map<K, number>, total: number): Map<K, number> {
  const sumItems = [...groups.values()].reduce((s, v) => s + v, 0);
  const out = new Map<K, number>();
  if (!groups.size) return out;
  if (sumItems <= 0) {
    const first = [...groups.keys()][0];
    out.set(first, round2(total));
    return out;
  }
  let assigned = 0;
  const keys = [...groups.keys()];
  keys.forEach((k, i) => {
    const v = i === keys.length - 1 ? round2(total - assigned) : round2((groups.get(k)! / sumItems) * total);
    assigned += v;
    out.set(k, v);
  });
  return out;
}
