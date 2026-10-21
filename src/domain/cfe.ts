/**
 * Ticket oficial (CFE, comprobante fiscal electrónico de Uruguay).
 * El QR de cada e-Ticket es el link de la DGI con los datos del comprobante, separados por comas:
 *   https://www.efactura.dgi.gub.uy/consultaQR/cfe?RUT,TIPO,SERIE,NRO,TOTAL,FECHA,HASH
 * Con esos datos el súper publica el ticket completo (la DGI lo exige hasta las 18 h del día hábil siguiente, por 3
 * meses). Disco, Devoto, Géant y Macromercado lo publican en Rondanet: un PDF con cada producto, su código interno,
 * cantidad, precio y monto. Si no hay QR, los mismos datos vienen impresos («Rut:», «e-Ticket», «BJ1000001», el TOTAL
 * y «Cod. de Seguridad: q7RxP4»).
 * Todo acá es puro: leer el QR o los códigos impresos, el comercio por el RUT y los renglones del PDF oficial.
 * (Copiado de Kvar, adaptado a las facturas de Pengar: cada renglón es descripción y monto.)
 */
import type { ParsedInvoice } from './invoice';

export interface Cfe {
  /** RUT del comercio (12 cifras) */
  ruc: string;
  /** 101 e-Ticket, 111 e-Factura */
  tipo: number;
  /** «BJ» */
  serie: string;
  /** 1000001 */
  numero: number;
  /** Total a pagar (en el QR, exacto) */
  total: number | null;
  /** AAAA-MM-DD */
  date: string | null;
  /** «Código de seguridad»: las 6 primeras letras del hash (distingue mayúsculas) */
  hash6: string | null;
  /** 'qr': del QR (o del link escrito en el texto), exacto; 'text': de lo impreso, leído por el OCR */
  source: 'qr' | 'text';
  /** El link de la DGI tal cual (para verlo allá); null si salió de lo impreso */
  url: string | null;
}

/** El ticket oficial: como una factura leída, pero exacto. `difference`: suma de los renglones (y el redondeo) − total */
export interface OfficialInvoice extends ParsedInvoice {
  difference: number | null;
}

/** RUT → súper que publica en Rondanet (Disco, Devoto y Géant probados; Macromercado, mismo portal, sin probar) */
const RONDANET: Record<string, string> = {
  '210274130017': 'Disco',
  '210297450018': 'Devoto',
  '213458920015': 'Géant', // Géant Roosevelt
  '213428330015': 'Géant', // Géant Nuevo Centro
  '211589950019': 'Macromercado',
};

/**
 * RUT → súper que publica en su propio portal (Uruware): Tienda Inglesa, en comprobantes.tiendainglesa.com.uy/henderson/
 * (formulario con tipo, serie, número, monto «1953.27» y código de seguridad; después, el PDF). Probado con un ticket real.
 * El Dorado publica en Scanntech (efactura.scanntech.com): no está probado que devuelva los productos, así que no está.
 */
const TIENDA_INGLESA: Record<string, string> = {
  '210094030014': 'Tienda Inglesa',
};

export type Portal = 'rondanet' | 'tienda-inglesa';

const round2 = (n: number) => Math.round(n * 100) / 100 + 0; // + 0: nunca «-0»

/** El nombre del comercio de un RUT conocido */
export const merchantOfRuc = (ruc: string | null | undefined): string | null => (ruc ? RONDANET[ruc] ?? TIENDA_INGLESA[ruc] ?? null : null);

/** Dónde publica el súper su ticket oficial (null: no se sabe, se usa la foto) */
export const officialPortal = (ruc: string): Portal | null => (RONDANET[ruc] ? 'rondanet' : TIENDA_INGLESA[ruc] ? 'tienda-inglesa' : null);

function isoDate(y: string, mo: string, d: string): string | null {
  const [Y, M, D] = [Number(y), Number(mo), Number(d)];
  return Y >= 2000 && Y <= 2100 && M >= 1 && M <= 12 && D >= 1 && D <= 31 ? `${y}-${mo}-${d}` : null;
}

/** La fecha del QR: «20261017» (la caja) o «17/10/2026» (como dice la DGI, y el PDF del súper) */
function qrDate(s: string): string | null {
  const compact = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (compact) return isoDate(compact[1], compact[2], compact[3]);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return dmy ? isoDate(dmy[3], dmy[2].padStart(2, '0'), dmy[1].padStart(2, '0')) : null;
}

/** «%2B» → «+». Nunca URLSearchParams: convierte el «+» del hash en un espacio */
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** "1.620,19" → 1620.19 ; "1,670" (cantidad) → 1.67 ; "1.620.19" (un separador mal leído) → 1620.19 */
function parseNumber(s: string): number {
  const t = s.trim();
  // Con dos o más separadores, el último seguido de dos cifras es el decimal
  const m = /^(-?\d[\d.,]*)[.,](\d{2})$/.exec(t);
  if (m && /[.,]/.test(m[1])) return Number(`${m[1].replace(/[.,]/g, '')}.${m[2]}`);
  if (/,\d{1,3}$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  return Number(t.replace(/,/g, ''));
}

const QR_RE = /^https?:\/\/(?:www\.)?efactura\.dgi\.gub\.uy\/consultaqr\/cfe\?(\S+)$/i;
/** El mismo link dentro de un texto (el e-Ticket que llega por correo) */
const DGI_LINK_RE = /https?:\/\/(?:www\.)?efactura\.dgi\.gub\.uy\/consultaqr\/cfe\?[^\s"'<>]+/gi;
const HASH6_RE = /^[A-Za-z0-9+/=]{6}/;

/** Texto del QR → datos del ticket; null si no es el QR de la DGI */
export function parseCfeQr(text: string): Cfe | null {
  const url = text.trim();
  const m = QR_RE.exec(url);
  if (!m) return null;
  const fields = m[1].split(',').map((f) => decode(f).trim());
  if (fields.length !== 7) return null;
  const [ruc, tipo, serie, nro, monto, fecha, hash] = fields;
  if (!/^\d{12}$/.test(ruc) || !/^\d{3}$/.test(tipo) || !/^[A-Za-z]{1,2}$/.test(serie) || !/^\d{1,7}$/.test(nro) || Number(nro) < 1) return null;
  if (!HASH6_RE.test(hash)) return null;
  return {
    ruc,
    tipo: Number(tipo),
    serie: serie.toUpperCase(),
    numero: Number(nro),
    total: /^\d+(?:\.\d{1,2})?$/.test(monto) ? Number(monto) : null,
    date: qrDate(fecha),
    hash6: hash.slice(0, 6),
    source: 'qr',
    url,
  };
}

/** «Rut: 210274130017», «RUT 211589950019», «R.U.T. Emisor: …» */
const RUT_RE = /\bR\.?\s?U\.?\s?[TC]\.?(?:\s*emisor)?\s*:?\s*(\d{12})\b/i;
const TYPES: [RegExp, number][] = [
  [/\be-?\s?ticket\b/i, 101],
  [/\be-?\s?factura\b/i, 111],
];
/** Una nota de crédito o débito no es una compra */
const NOTE_RE = /\bnota\s+de\s+(?:cr[eé]dito|d[eé]bito)\b/i;
/** «Serie: BJ Nro: 1000001» */
const LABELED_RE = /\bserie\s*:?\s*([A-Z]{1,2})\b[^\n]*?\b(?:n(?:[uú]mero|ro|[°º])|nº)\.?\s*:?\s*(\d{1,7})\b/i;
/** «BJ1000001», «BJ 1000001», «F 1000001» (cerca de «e-Ticket»; con 4 cifras o más para no confundir «X3») */
const SERIE_NRO_RE = /(?:^|[\s:])([A-Z]{1,2})[\s-]?(\d{4,7})(?=\s|$)/;
const HASH_TEXT_RE = /\bc[oó]d(?:igo)?\.?\s*(?:de\s*)?seguridad\s*:?\s*([A-Za-z0-9+/]{6})(?![A-Za-z0-9+/])/i;

/**
 * Los datos del ticket a partir de su texto: el link de la DGI si está escrito (correo), o lo impreso (foto sin QR).
 * El total y la fecha son los que leyó el lector de facturas (`parsed`). null si falta el RUT, el tipo o la serie y
 * el número; sin código de seguridad sirve para el comercio (pero no para pedir el ticket oficial).
 */
export function cfeFromText(text: string, parsed: Pick<ParsedInvoice, 'total' | 'date'>): Cfe | null {
  for (const link of text.matchAll(DGI_LINK_RE)) {
    const cfe = parseCfeQr(link[0]);
    if (cfe) return cfe;
  }
  if (NOTE_RE.test(text)) return null;
  const ruc = RUT_RE.exec(text)?.[1] ?? [...Object.keys(RONDANET), ...Object.keys(TIENDA_INGLESA)].find((r) => text.includes(r));
  // El tipo que aparece primero (más abajo puede decir «Puede verificar su e-Factura…»)
  const type = TYPES.map(([re, tipo]) => ({ tipo, at: text.search(re) }))
    .filter((t) => t.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (!ruc || !type) return null;
  let serie = LABELED_RE.exec(text);
  if (!serie) {
    // Serie y número van en el renglón del tipo o en los de abajo
    const rows = text.split(/\r?\n/);
    const at = rows.findIndex((r) => TYPES.some(([re]) => re.test(r)));
    for (const row of rows.slice(at, at + 4)) {
      serie = SERIE_NRO_RE.exec(row);
      if (serie) break;
    }
  }
  if (!serie || Number(serie[2]) < 1) return null;
  return {
    ruc,
    tipo: type.tipo,
    serie: serie[1].toUpperCase(),
    numero: Number(serie[2]),
    total: parsed.total ?? null,
    date: parsed.date ?? null,
    hash6: HASH_TEXT_RE.exec(text)?.[1] ?? null,
    source: 'text',
    url: null,
  };
}

/** Primero el QR de la foto (exacto), después el link o los códigos impresos */
export function findCfe(qr: string[], text: string, parsed: Pick<ParsedInvoice, 'total' | 'date'>): Cfe | null {
  for (const q of qr) {
    const cfe = parseCfeQr(q);
    if (cfe) return cfe;
  }
  return cfeFromText(text, parsed);
}

/**
 * Lo que el ticket asegura de la factura leída de la foto: el comercio (por el RUT) y, si salió del QR, el total y la
 * fecha exactos (aunque el OCR o Claude hayan leído mal el TOTAL).
 */
export function withCfe<T extends ParsedInvoice>(parsed: T, cfe: Cfe): T {
  const merchant = merchantOfRuc(cfe.ruc) ?? parsed.merchant;
  const date = (cfe.source === 'qr' && cfe.date) || parsed.date || cfe.date || undefined;
  const total = cfe.source === 'qr' && cfe.total != null ? cfe.total : parsed.total;
  return { ...parsed, merchant, date, total };
}

/** Suma de los renglones − total (0: cierra); null sin total */
export const differenceOf = (inv: Pick<ParsedInvoice, 'items' | 'total'>): number | null =>
  inv.total == null ? null : round2(inv.items.reduce((s, i) => s + i.amount, 0) - inv.total);

/**
 * ¿Se usa el ticket oficial en vez de la foto? Sí, salvo que la foto cierre mejor con el total: solo se lee la primera
 * página del PDF, y en un ticket largo los productos siguen en la segunda (sin TOTAL A PAGAR, con el total del QR).
 */
export const prefersOfficial = (official: { difference: number | null }, photo: { difference: number | null }) =>
  Math.abs(official.difference ?? Infinity) <= Math.abs(photo.difference ?? Infinity);

/** Lo que el plugin nativo manda al portal (Rondanet o el de Tienda Inglesa: el total con punto y dos decimales); null si falta el total o el código */
export function rondanetForm(cfe: Cfe): { ruc: string; tipo: string; serie: string; numero: string; total: string; hash6: string } | null {
  if (cfe.total == null || !cfe.hash6) return null;
  return { ruc: cfe.ruc, tipo: String(cfe.tipo), serie: cfe.serie, numero: String(cfe.numero), total: cfe.total.toFixed(2), hash6: cfe.hash6 };
}

// --- El PDF de Rondanet (y el de Tienda Inglesa) -----------------------------------------------------
// Tabla: # IVA CÓDIGO DESCRIPCIÓN CANTIDAD DESC. REC. PRECIO C/IVA MONTO
//   1 10% 301323 BONDIOLA ENTER MEDIA 1,670 0,00 0,00 149,00 248,83
// Tienda Inglesa: SKU DESCRIPCIÓN CANTIDAD PRECIO IVA DESC IMPORTE
//   94781 COLITA DE CUADRIL 1,148 618,99 10% -106,60 604,00
// Después: subtotales de IVA, TOTAL A PAGAR 1.620,19 y la ADENDA (datos del cliente: nunca se lee).
// Hay más de un formato de PDF (las columnas cambian un poco): se lee por la forma de cada renglón.

/** Número con decimales: «1.620,19», «248,83», «1,670» (cantidad), «0,00», «1.324» */
const DEC_RE = /^-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2,3}$/;
/** Signos entre los números («1,324 x 319,00 = 422,36») */
const OP_RE = /^(?:[x×=*$])$/i;
/** La tasa de IVA del renglón: «22%», «10%», «0%», «Exento» (frutas, verduras, leche) */
const IVA_RE = /^(?:\d{1,2}(?:[.,]\d{1,2})?%|ex(?:ent[oa]|e)?\.?)$/i;
const LETTERS_RE = /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2}/;
const HEADER_RE = /descripci[oó]n/i;
const HEADER2_RE = /cantidad|cant\./i;
/** Donde terminan los productos */
const END_RE = /\b(?:totales|sub\s?-?total\w*|monto\s+iva|total\s+a\s+pagar|adenda)\b/i;
const AMOUNT = String.raw`-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2}(?!\d)`;
const TOTAL_RE = new RegExp(String.raw`\btotal\s+a\s+pagar\b\D*?(${AMOUNT})`, 'i');
const TOTAL_LABEL_RE = /\btotal\s+a\s+pagar\b/i;
const FIRST_AMOUNT_RE = new RegExp(String.raw`(?:^|\s)\$?\s*(${AMOUNT})`);
const ROUNDING_RE = new RegExp(String.raw`\b(?:redondeo|no\s+facturable)\b\D*?(${AMOUNT})`, 'i');
const DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{4})\b/;

/** ¿Cantidad × precio (− descuento + recargo) da el monto? El descuento puede ser un monto o un porcentaje */
function fitsAmount(qty: number, price: number, amount: number, desc = 0, rec = 0): boolean {
  if (!(qty > 0)) return false;
  // Redondeo al centésimo, y la cantidad con 3 decimales
  const tol = 0.011 + Math.abs(price) * 0.0005;
  return Math.abs(qty * price - desc + rec - amount) <= tol || (desc > 0 && desc < 100 && Math.abs(qty * price * (1 - desc / 100) + rec - amount) <= tol);
}

/** Los números del final del renglón → cantidad, precio y monto; `extra`: los de adelante son de la descripción */
function readNumbers(n: number[]): { qty: number; price: number; amount: number; extra: number; exact: boolean } | null {
  const len = n.length;
  if (len < 3) return null;
  const five = len >= 5 ? { qty: n[len - 5], price: n[len - 2], amount: n[len - 1], extra: len - 5, exact: true } : null;
  if (five && fitsAmount(five.qty, five.price, five.amount, n[len - 4], n[len - 3])) return five;
  if (len >= 4 && fitsAmount(n[len - 4], n[len - 2], n[len - 1], n[len - 3])) {
    return { qty: n[len - 4], price: n[len - 2], amount: n[len - 1], extra: len - 4, exact: true };
  }
  // Tienda Inglesa: cantidad, precio, descuento (negativo o 0,00) y monto
  if (len >= 4 && n[len - 2] <= 0 && fitsAmount(n[len - 4], n[len - 3], n[len - 1], -n[len - 2])) {
    return { qty: n[len - 4], price: n[len - 3], amount: n[len - 1], extra: len - 4, exact: true };
  }
  const three = { qty: n[len - 3], price: n[len - 2], amount: n[len - 1], extra: len - 3, exact: true };
  if (fitsAmount(three.qty, three.price, three.amount)) return three;
  // No cierra: el monto es el oficial igual (la suma contra el total lo controla)
  const loose = { ...(five ?? three), exact: false };
  return loose.qty > 0 ? loose : null;
}

/** Un renglón de la tabla de productos; null si no lo es */
function itemRow(row: string): { description: string; amount: number } | null {
  const tokens = row.split(/\s+/).filter(Boolean);
  // Los números del final (y los signos entre ellos)
  let k = tokens.length;
  // (Tienda Inglesa pone el IVA entre el precio y el descuento)
  const ivaBetween = (i: number) => IVA_RE.test(tokens[i]) && i > 0 && DEC_RE.test(tokens[i - 1]) && i < tokens.length - 1;
  while (k > 0 && (DEC_RE.test(tokens[k - 1]) || (OP_RE.test(tokens[k - 1]) && k < tokens.length) || ivaBetween(k - 1))) k--;
  while (k < tokens.length && OP_RE.test(tokens[k])) k++;
  const tail = tokens.slice(k).filter((t) => !OP_RE.test(t) && !IVA_RE.test(t));
  const numbers = readNumbers(tail.map(parseNumber));
  if (!numbers) return null;
  const head = tokens.slice(0, k);
  // El IVA («10%», «Exento»): adelante (después del #) o, si no, justo antes de los números («AGUJA SIN HUESO 10%»).
  // Un «0%» en el medio es de la descripción («YOGUR 0% GRASA»)
  if (!head.slice(0, 2).some((t) => IVA_RE.test(t)) && head.length > 1 && IVA_RE.test(head[head.length - 1])) head.pop();
  // Antes de la descripción: el # del renglón, el IVA y el código interno (el primer número largo)
  const at = head.slice(0, 4).findIndex((t) => /^\d{4,14}$/.test(t));
  const code = at >= 0 && at < head.length - 1 ? head[at] : undefined;
  let start = code ? at + 1 : 0;
  while (start < head.length - 1 && (IVA_RE.test(head[start]) || (!code && /^\d{1,3}$/.test(head[start])))) start++;
  const description = [...head.slice(start), ...tail.slice(0, numbers.extra)].join(' ');
  // Si la cuenta no cierra, solo es un producto con su código
  if (!LETTERS_RE.test(description) || (!numbers.exact && !code)) return null;
  return { description, amount: numbers.amount };
}

/**
 * Renglones del PDF oficial (en orden de lectura, hasta «TOTAL A PAGAR») → la factura, igual que la de la foto pero
 * exacta. Las bolsas y los descuentos de toda la compra (renglones negativos) quedan como renglones: también son plata.
 * `cfe`: lo que se pidió (RUT, fecha y total si el PDF no los trae). Lo que venga después de «ADENDA» nunca se lee.
 */
export function parseRondanetLines(rows: string[], cfe?: Cfe): OfficialInvoice {
  const clean = rows.map((r) => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const adenda = clean.findIndex((r) => /\badenda\b/i.test(r));
  const page = adenda >= 0 ? clean.slice(0, adenda) : clean;
  const header = page.findIndex((r) => HEADER_RE.test(r) && HEADER2_RE.test(r));
  const items: OfficialInvoice['items'] = [];
  let rounding = 0;
  let end = page.length;
  for (let i = header + 1; i < page.length; i++) {
    if (END_RE.test(page[i])) {
      end = i;
      break;
    }
    const item = itemRow(page[i]);
    if (item) {
      // Un renglón en cero (un regalo) no es gasto
      if (item.amount !== 0) items.push(item);
    } else {
      const r = ROUNDING_RE.exec(page[i]);
      if (r) rounding += parseNumber(r[1]);
    }
  }

  // Total y redondeo, debajo de los productos
  let total: number | undefined;
  for (let i = end; i < page.length && total == null; i++) {
    const t = TOTAL_RE.exec(page[i]);
    if (t) total = parseNumber(t[1]);
    else if (TOTAL_LABEL_RE.test(page[i])) {
      // El monto quedó en el renglón de abajo
      const next = FIRST_AMOUNT_RE.exec(page[i + 1] ?? '');
      if (next) total = parseNumber(next[1]);
    }
    const r = ROUNDING_RE.exec(page[i]);
    if (r) rounding += parseNumber(r[1]);
  }
  total ??= cfe?.total ?? undefined;

  // Encabezado (arriba de la tabla): el RUT y la fecha
  const top = page.slice(0, header >= 0 ? header : end).join('\n');
  const ruc = cfe?.ruc ?? /\b(\d{12})\b/.exec(top)?.[1] ?? null;
  const d = DATE_RE.exec(top);
  const date = (d && isoDate(d[3], d[2], d[1])) || cfe?.date || undefined;

  const sum = items.reduce((a, l) => a + l.amount, 0);
  return {
    merchant: merchantOfRuc(ruc) ?? undefined,
    date,
    total,
    items,
    difference: total == null ? null : round2(sum + rounding - total),
  };
}
