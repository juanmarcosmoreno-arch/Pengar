/**
 * Estados de cuenta de la tarjeta (PDF, foto o planilla del banco) → compras, cargos, pagos y créditos.
 * No depende de un banco: busca la fecha al comienzo de cada renglón y los importes con dos decimales. Si hay
 * encabezados («Importe $», «U$S»…), cada importe va a la columna que tiene más cerca: así se sabe si es en pesos
 * o en dólares. Los comercios se limpian (procesadores de pago, sucursales, ciudades) para que la misma tienda
 * tenga siempre la misma clave y lo aprendido sirva para los meses siguientes (y para las facturas).
 */
import { monthOf, today as todayISO } from './dates';
import { norm, type Cell } from './importSheet';
import { parseAmount, round2 } from './money';
import { groupRows, type TextBox } from './ocrLines';
import type { Movement } from './types';

export interface StatementCell {
  text: string;
  /** Borde izquierdo, normalizado 0..1 */
  x: number;
  /** Ancho normalizado (opcional): ubica cada palabra cuando la celda junta varias */
  w?: number;
}

export interface StatementRow {
  cells: StatementCell[];
}

export type StatementKind = 'compra' | 'cargo' | 'pago' | 'credito' | 'saldo';
export type StatementCurrency = 'local' | 'usd';

export interface StatementTx {
  /** YYYY-MM-DD */
  date: string;
  /** Como viene en el estado de cuenta */
  description: string;
  /** Nombre limpio para mostrar («Tienda Inglesa») */
  merchant: string;
  /** Clave del comercio para aprender («tienda inglesa») */
  key: string;
  /** Positivo = gasto; negativo = crédito, devolución o pago */
  amount: number;
  currency: StatementCurrency;
  /** Cuota «2/6» */
  installment?: string;
  kind: StatementKind;
}

export interface StatementOptions {
  /** Hoy (YYYY-MM-DD): para el año de las fechas cuando el documento no trae ninguna fecha completa */
  today?: string;
}

/** Datos del encabezado del estado de cuenta */
export interface StatementInfo {
  /** Fecha de cierre */
  closing?: string;
  /** Comienzo del período («Período del 26/08/2025 al 25/09/2025») */
  from?: string;
  /** Cierre anterior */
  previous?: string;
  /** Vencimiento */
  due?: string;
  /** Cotización del dólar que usó el banco */
  usdRate?: number;
  /** «OCA», «Visa BROU», «Master Itaú»… */
  card?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

// --- Fechas ---------------------------------------------------------------------------------------------

interface DayParts {
  d: number;
  m: number;
  y?: number;
}

/** Año y mes de referencia para las fechas sin año (el cierre) */
interface Ref {
  y: number;
  m: number;
}

const MONTH_WORD = /^(ene(ro)?|feb(rero)?|mar(zo)?|abr(il)?|may(o)?|jun(io)?|jul(io)?|ago(sto)?|set(iembre)?|sep(t(iembre)?)?|oct(ubre)?|nov(iembre)?|dic(iembre)?|jan|apr|aug|dec)$/;
const MONTH_INDEX: Record<string, number> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

function monthWord(word: string | undefined): number | null {
  if (!word) return null;
  const w = norm(word).replace(/\.$/, '');
  return MONTH_WORD.test(w) ? MONTH_INDEX[w.slice(0, 3)] : null;
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

function valid(p: DayParts): DayParts | null {
  if (p.d < 1 || p.d > 31 || p.m < 1 || p.m > 12) return null;
  if (p.y != null && (p.y < 2000 || p.y > 2099)) return null;
  return p;
}

/** Fecha en un solo pedazo: 12/09/2025, 12/09/25, 12-09, 12/09, 12-sep-25, 12-SET, 2025-09-12 */
function dateToken(raw: string): DayParts | null {
  let t = raw.replace(/[,;:]$/, '');
  // El lector de fotos confunde el 0 con la O y el 1 con la l
  if (/^[\dOoIl|]{1,2}[/.-][\dOoIl|]{1,2}([/.-][\dOoIl|]{2,4})?$/.test(t)) t = t.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return valid({ d: +m[3], m: +m[2], y: +m[1] });
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?$/);
  if (m) return valid({ d: +m[1], m: +m[2], y: m[3] ? fullYear(m[3]) : undefined });
  m = t.match(/^(\d{1,2})[/.-]?([a-záéíóú]{3,10})\.?(?:[/.-](\d{4}|\d{2}))?$/i);
  const mo = m ? monthWord(m[2]) : null;
  if (m && mo) return valid({ d: +m[1], m: mo, y: m[3] ? fullYear(m[3]) : undefined });
  return null;
}

/** Fecha que empieza en el pedazo `i` (puede ocupar hasta tres: «12 SET 2025») */
function dateAt(words: string[], i: number): { parts: DayParts; next: number } | null {
  const t = words[i];
  if (!t) return null;
  const p = dateToken(t);
  if (p) return { parts: p, next: i + 1 };
  const mo = /^\d{1,2}$/.test(t) ? monthWord(words[i + 1]) : null;
  if (!mo) return null;
  const y = words[i + 2]?.match(/^(\d{4}|\d{2})$/)?.[1];
  const year = y ? fullYear(y) : undefined;
  const withYear = year != null && year >= 2020 && year <= 2069;
  const parts = valid({ d: +t, m: mo, y: withYear ? year : undefined });
  return parts ? { parts, next: i + (withYear ? 3 : 2) } : null;
}

/** Sin año: si el mes es posterior al del cierre, la compra es del año anterior (diciembre en un cierre de enero) */
function isoOf(p: DayParts, ref: Ref): string | null {
  const y = p.y ?? (p.m > ref.m ? ref.y - 1 : ref.y);
  if (new Date(Date.UTC(y, p.m - 1, p.d)).getUTCMonth() !== p.m - 1) return null;
  return `${y}-${pad(p.m)}-${pad(p.d)}`;
}

function addDays(iso: string, n: number): string {
  return new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
}

const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400_000;

const FULL_DATE =
  /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b|\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})(?:[\s/.-]+de)?[\s/.-]+([a-z]{3,10})\.?(?:[\s/.-]+de)?[\s/.-]+(\d{4}|\d{2})\b/g;

/** Fechas completas de un renglón ya normalizado, en orden: 25/09/2025, 25-sep-2025, 25 de setiembre de 2025 */
function fullDates(line: string): { iso: string; index: number }[] {
  const out: { iso: string; index: number }[] = [];
  for (const m of line.matchAll(FULL_DATE)) {
    let p: DayParts | null = null;
    if (m[1]) p = valid({ d: +m[1], m: +m[2], y: fullYear(m[3]) });
    else if (m[4]) p = valid({ d: +m[6], m: +m[5], y: +m[4] });
    else {
      const mo = monthWord(m[8]);
      if (mo) p = valid({ d: +m[7], m: mo, y: fullYear(m[9]) });
    }
    const iso = p ? isoOf(p, { y: p.y!, m: p.m }) : null;
    if (iso) out.push({ iso, index: m.index! });
  }
  return out;
}

// --- Encabezado: cierre, vencimiento, cotización y tarjeta ------------------------------------------------

type DateLabel = 'previous' | 'closing' | 'due' | 'period' | null;

/** En orden: «cierre anterior» antes que «cierre»; los que no interesan (próximo cierre) igual ocupan su fecha */
const LABELS: [DateLabel, RegExp][] = [
  ['previous', /cierre anterior|ultimo cierre/g],
  [null, /proximo cierre|proximo vencimiento|cierre siguiente|vencimiento anterior|fecha de emision/g],
  ['closing', /cierre/g],
  ['due', /vencimiento|\bvence\b|fecha limite de pago/g],
  ['period', /periodo/g],
];

const BRANDS: [string, RegExp][] = [
  ['OCA', /\boca\b/], ['Visa', /\bvisa\b/], ['Master', /\bmaster ?card\b|\bmaster\b/], ['Amex', /\bamex\b|american express/],
  ['Cabal', /\bcabal\b/], ['Diners', /\bdiners\b/], ['Creditel', /\bcreditel\b/], ['Passcard', /\bpasscard\b/],
];
const BANKS: [string, RegExp][] = [
  ['BROU', /\bbrou\b|banco republica|republica oriental/], ['Itaú', /\bitau\b/], ['Santander', /\bsantander\b/],
  ['Scotiabank', /\bscotia ?bank\b|\bscotia\b/], ['BBVA', /\bbbva\b/], ['HSBC', /\bhsbc\b/], ['Heritage', /\bheritage\b/], ['Bandes', /\bbandes\b/],
];

function earliest(list: [string, RegExp][], text: string): string | undefined {
  let best: { name: string; index: number } | undefined;
  for (const [name, re] of list) {
    const m = text.match(re);
    if (m && (!best || m.index! < best.index)) best = { name, index: m.index! };
  }
  return best?.name;
}

/** La tarjeta, si aparece en el encabezado: «OCA», «Visa BROU», «Master Scotiabank» */
export function detectCard(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(norm);
  for (const part of [lines.slice(0, 20).join('\n'), lines.join('\n')]) {
    const brand = earliest(BRANDS, part);
    if (brand === 'OCA') return brand;
    const card = [brand, earliest(BANKS, part)].filter(Boolean).join(' ');
    if (card) return card;
  }
  return undefined;
}

/** Cierre, vencimiento, período, cotización y tarjeta: con el título en el mismo renglón o en el de arriba */
export function statementInfo(text: string): StatementInfo {
  const lines = text.split(/\r?\n/).map(norm);
  const info: StatementInfo = {};
  const set = (key: Exclude<DateLabel, 'period' | null>, iso: string | undefined) => {
    if (iso && !info[key]) info[key] = iso;
  };
  lines.forEach((line, i) => {
    let masked = line;
    const labels: { key: DateLabel; index: number }[] = [];
    for (const [key, re] of LABELS) {
      for (const m of [...masked.matchAll(re)]) {
        labels.push({ key, index: m.index! });
        masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index! + m[0].length);
      }
    }
    if (!labels.length) return;
    labels.sort((a, b) => a.index - b.index);
    const dates = fullDates(line);
    if (dates.length) {
      labels.forEach((l, k) => {
        const end = labels[k + 1]?.index ?? Infinity;
        const own = dates.filter((d) => d.index > l.index && d.index < end);
        if (l.key === 'period') {
          if (own.length >= 2) {
            if (!info.from) info.from = own[0].iso;
            set('closing', own[1].iso);
          }
        } else if (l.key) set(l.key, own[0]?.iso);
      });
    } else {
      // Títulos en un renglón y valores en el de abajo, en el mismo orden
      const below = fullDates(lines[i + 1] ?? '');
      labels.forEach((l, k) => {
        if (l.key && l.key !== 'period') set(l.key, below[k]?.iso);
      });
    }
  });
  const rate = lines.join('\n').match(/(cotizacion|tipo de cambio|t\/c|\btc\b)[^\d\n]{0,30}(\d{1,3}(?:[.,]\d{1,4})?)/);
  if (rate) {
    const v = Number(rate[2].replace(',', '.'));
    if (v > 10 && v < 200) info.usdRate = v;
  }
  const card = detectCard(text);
  if (card) info.card = card;
  return info;
}

/** El cierre (o el vencimiento, o la fecha completa más nueva del documento) da el año de las fechas sin año */
function refOf(info: StatementInfo, text: string, today: string): Ref {
  let iso = info.closing ?? info.due;
  if (!iso) {
    const limit = addDays(today, 62);
    const all = text.split(/\r?\n/).flatMap((l) => fullDates(norm(l)).map((d) => d.iso)).filter((d) => d <= limit).sort();
    iso = all[all.length - 1];
  }
  iso ??= today;
  return { y: +iso.slice(0, 4), m: +iso.slice(5, 7) };
}

/** Período del estado de cuenta: del cierre anterior (o el primer renglón, el saldo anterior) al cierre (o el último movimiento) */
export function statementPeriod(txs: StatementTx[], info: StatementInfo): { from: string; to: string } | undefined {
  const all = txs.map((t) => t.date).sort();
  const moves = txs.filter((t) => t.kind !== 'saldo').map((t) => t.date).sort();
  const from = info.from ?? (info.previous ? addDays(info.previous, 1) : all[0]);
  const to = info.closing ?? moves[moves.length - 1] ?? all[all.length - 1];
  if (!from || !to) return undefined;
  return { from: from <= to ? from : to, to };
}

// --- Tipo de movimiento y cuotas -------------------------------------------------------------------------

const SALDO = /^saldo\b|\bsaldo (anterior|contado|actual|a pagar|deudor|financiado|total|al cierre|a favor|pendiente|del periodo)\b|total a pagar|\bpago minimo\b|minimo a pagar|\bpago contado\b|\blimite\b|\bdisponible\b|^total\b|\bsub ?total\b/;
const PAGO = /^(su |sus )?pagos?\b(?! (web|online|facil|movil|express))|pago recibido|gracias por su pago|\bpago (de |del )?(la )?(tarjeta|resumen|estado de cuenta)\b/;
const CREDITO = /reintegro|devolucion|bonificacion|\bbonif\b|\banul|reverso|reversion|contracargo|nota de credito|reembolso|cashback|\ba favor\b|descuento ley|\bdto ley\b|ley 19\.?210|ley 17\.?934|\bcr$/;
const CARGO = /\bcargos?\b|comision|^seguro|\bseguro de vida\b|\bintereses?\b|^iva\b|\btimbres?\b|costo (de )?emision|\brecargo|\bmora\b|gastos? (de )?(administracion|cobranza|emision|envio|mantenimiento)|anualidad|membresia|renovacion|cuota anual|^impuestos?\b|sellado/;

/** Qué es un renglón según su descripción: pago de la tarjeta, saldo o total, crédito, cargo del banco o compra */
export function statementKind(description: string): StatementKind {
  const p = norm(description).replace(/\./g, '');
  // «SEGURO SALDO DEUDOR» o «IVA S/INTERESES» son cargos aunque digan «saldo»
  if (/^(seguros?|iva|intereses?|comision(es)?)\b/.test(p) && !CREDITO.test(p)) return 'cargo';
  if (SALDO.test(p)) return 'saldo';
  if (PAGO.test(p)) return 'pago';
  if (CREDITO.test(p)) return 'credito';
  if (CARGO.test(p)) return 'cargo';
  return 'compra';
}

/** «CUOTA 02/06», «CTA 2 DE 6», «C.2/6» o «02/06» suelto */
const CUOTA_RES = [
  /\b(?:cuotas?|cta)\.?\s*:?\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,3})\b/gi,
  /\bc\.?\s?(\d{1,2})\/(\d{1,3})\b/gi,
  /(^|\s)(\d{1,2})\/(\d{1,3})(?=\s|$)/g,
];

export function installmentOf(text: string): string | undefined {
  for (const re of CUOTA_RES) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[m.length - 2]);
      const total = Number(m[m.length - 1]);
      if (n >= 1 && total >= 2 && n <= total && total <= 72) return `${n}/${total}`;
    }
  }
  return undefined;
}

// --- Comercios -------------------------------------------------------------------------------------------

/** Procesadores de pago que van antes del comercio («MERCADOPAGO*», «PAYPAL *», «DLO*») */
const PROCESSOR = /^(?:mercado ?pago|merpago|mpago|mp|payu|paypal|pp|sq|dlo|dlocal|ebanx|stripe|nuvei|pagosweb)\s*\*\s*(?:(?:ar|uy|br|us|mx|cl|co)\s*\*\s*)?/i;
const PREFIX = /^(?:compras?|cpra|consumo|deb(?:ito)?\.?\s*aut(?:omatico)?\.?|devoluci[oó]n(?:es)?|anulaci[oó]n|reverso|contracargo)\s+(?:(?:de|del|compra|en)\s+)*/i;
const LEGAL = /(^|\s)(?:s\.?\s?a\.?|s\.?\s?r\.?\s?l\.?|ltda\.?|s\.?a\.?s\.?|inc\.?|llc\.?|ltd\.?|sociedad an[oó]nima)(?=\s|$)/gi;
const TLD = new Set(['com', 'net', 'org', 'io', 'app', 'tv', 'co', 'uy', 'ar', 'br', 'es', 'us', 'me', 'ly', 'gg', 'www']);
const DROP = new Set(['suc', 'sucursal', 'nro', 'num', 'numero', 'n', 'local', 'loc', 'pos', 'caja', 'terminal', 'eur', 'usd', 'uyu', 'brl', 'ars']);
const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'al', 'a', 'o', 'the', 'of', 'and', '&']);
/** Rubros de comercio: solos no alcanzan para reconocer la tienda («farmacia», «tienda») */
const GENERIC = new Set([
  'tienda', 'tiendas', 'supermercado', 'supermercados', 'super', 'hiper', 'hipermercado', 'autoservice', 'autoservicio', 'almacen',
  'minimercado', 'mercado', 'market', 'shop', 'store', 'farmacia', 'panaderia', 'confiteria', 'carniceria', 'verduleria', 'fruteria',
  'kiosco', 'quiosco', 'restaurante', 'restaurant', 'resto', 'bar', 'cafe', 'cafeteria', 'parrilla', 'pizzeria', 'heladeria',
  'libreria', 'papeleria', 'ferreteria', 'barraca', 'optica', 'peluqueria', 'estacion', 'est', 'servicio', 'servicios', 'hotel',
  'club', 'gimnasio', 'gym', 'centro', 'clinica', 'sanatorio', 'laboratorio', 'taller', 'lavadero', 'veterinaria', 'casa', 'grupo',
  'distribuidora', 'comercial', 'cooperativa', 'coop', 'instituto', 'colegio', 'escuela', 'academia', 'agencia', 'inmobiliaria',
  'estudio', 'san', 'santa', 'santo', 'nuevo', 'nueva', 'gran', 'don', 'dona', 'punto', 'mundo', 'shopping', 'free', 'duty',
  'sociedad', 'compania', 'cia', 'empresa', 'pago', 'pagos', 'cobro', 'cobros', 'red', 'mi',
]);
/** Ciudades, departamentos y países que los bancos agregan al final */
const CITIES = new Set([
  'montevideo', 'mvd', 'mdeo', 'mtdeo', 'mvdeo', 'punta del este', 'pde', 'p del este', 'maldonado', 'canelones', 'san jose',
  'san jose de mayo', 'colonia', 'colonia del sacramento', 'paysandu', 'salto', 'rivera', 'tacuarembo', 'durazno', 'florida', 'minas',
  'rocha', 'treinta y tres', 'artigas', 'mercedes', 'fray bentos', 'melo', 'trinidad', 'las piedras', 'pando', 'ciudad de la costa',
  'la paz', 'piriapolis', 'atlantida', 'la barra', 'jose ignacio', 'carmelo', 'nueva helvecia', 'chuy', 'solymar', 'el pinar',
  'santa lucia', 'young', 'dolores', 'rosario', 'juan lacaze', 'libertad', 'carrasco', 'pocitos', 'punta carretas', 'cordon',
  'malvin', 'buceo', 'ciudad vieja', 'parque rodo', 'tres cruces', 'la blanqueada', 'punta gorda', 'parque batlle',
  'uruguay', 'uy', 'ury', 'uru', 'los gatos',
  'san francisco', 'seattle', 'cupertino', 'mountain view', 'sunnyvale', 'menlo park', 'palo alto', 'dublin', 'luxembourg',
  'amsterdam', 'london', 'sao paulo', 'buenos aires', 'caba', 'miami', 'new york', 'ny', 'ca', 'us', 'usa', 'ar', 'arg', 'br',
  'bra', 'gb', 'ie', 'nl', 'lu', 'cl', 'mx', 'es',
]);
/** Palabras cortas que no son siglas (para mostrar «Bar», no «BAR») */
const COMMON_SHORT = new Set([
  ...STOP, 'bar', 'sur', 'mar', 'sol', 'pan', 'gas', 'red', 'uno', 'dos', 'mas', 'rio', 'san', 'don', 'luz', 'paz', 'oro', 'pub',
  'spa', 'ola', 'gym', 'mi', 'tu', 'su', 'dia', 'pet', 'car', 'box', 'top', 'fit', 'one', 'new', 'big', 'day', 'art', 'pro', 'mc',
  'est', 'eat', 'eats', 'go', 'app', 'web', 'net', 'hot', 'ice', 'sky', 'way', 'kid', 'max', 'ley', 'por', 'sin',
]);

const word = (w: string) => norm(w).replace(/[^a-z0-9&]/g, '');

/** «NETFLIX.COM» → «NETFLIX», «HELP.UBER.COM» → «UBER», «APPLE.COM/BILL» → «APPLE» */
function domainName(tok: string): string {
  const m = tok.match(/^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\S*)?$/i);
  if (!m) return tok;
  const labels = m[1].toLowerCase().split('.');
  if (!TLD.has(labels[labels.length - 1])) return tok;
  const name = labels.filter((l) => !TLD.has(l)).pop();
  if (!name) return tok;
  return tok === tok.toUpperCase() ? name.toUpperCase() : name;
}

function displayWord(w: string, i: number): string {
  const hasLower = /\p{Ll}/u.test(w);
  const hasUpper = /\p{Lu}/u.test(w);
  if (hasLower && hasUpper) return w;
  const lower = w.toLocaleLowerCase('es');
  if (i > 0 && STOP.has(lower)) return lower;
  // Siglas: UTE, OSE, BSE
  if (hasUpper && w.length <= 3 && !COMMON_SHORT.has(word(w))) return w;
  return lower.charAt(0).toLocaleUpperCase('es') + lower.slice(1);
}

/**
 * Nombre limpio del comercio y su clave para aprender. La clave son las primeras palabras significativas,
 * hasta la primera que distingue a la tienda («tienda inglesa», «farmacia san roque», «netflix»): así no cambia
 * con la sucursal, el número de comprobante o la ciudad.
 */
export function normalizeMerchant(description: string): { merchant: string; key: string } {
  let s = description.replace(/\s+/g, ' ').trim();
  for (const re of CUOTA_RES) s = s.replace(re, ' ');
  for (let k = 0; k < 4; k++) {
    const next = s.trim().replace(PROCESSOR, '').replace(PREFIX, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(LEGAL, ' ').replace(/[*#|_]+/g, ' ');
  const tokens = s.split(' ').map(domainName).join(' ').replace(/[/\\]+/g, ' ').split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, ''))
    .filter(Boolean);
  // Lo que sigue al número de sucursal es la ubicación («MC DONALDS 18 DE JULIO»), si antes ya está el nombre
  const distinctive = (list: string[]) => list.some((w) => word(w).length >= 3 && !STOP.has(word(w)) && !GENERIC.has(word(w)) && !DROP.has(word(w)));
  const firstNumber = tokens.findIndex((w) => /\d/.test(w));
  const named = firstNumber > 0 && distinctive(tokens.slice(0, firstNumber)) ? tokens.slice(0, firstNumber) : tokens;
  // Fuera números de comprobante, códigos y «SUC»
  let kept = named.filter((w) => {
    const k = word(w);
    return k && !/\d/.test(k) && !DROP.has(k);
  });
  if (!kept.length) kept = tokens;
  // Ciudades y países al final, si lo que queda todavía distingue a la tienda («FARMACIA MERCEDES» queda entera)
  for (let changed = true; changed; ) {
    changed = false;
    for (const len of [4, 3, 2, 1]) {
      if (kept.length <= len) continue;
      const tail = kept.slice(-len).map(word).join(' ');
      // Los estados de cuenta cortan los nombres largos: «MONTEVID»
      const city = CITIES.has(tail) || (len === 1 && tail.length >= 6 && 'montevideo'.startsWith(tail));
      if (city && distinctive(kept.slice(0, -len))) {
        kept = kept.slice(0, -len);
        changed = true;
        break;
      }
    }
  }
  // Sin palabras repetidas («UBER TRIP HELP.UBER.COM»)
  const seen = new Set<string>();
  kept = kept.filter((w) => {
    const k = word(w);
    if (k.length < 3) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const keyWords: string[] = [];
  for (const w of kept.map(word)) {
    if (w.length < 2 || STOP.has(w)) continue;
    keyWords.push(w);
    if (keyWords.length >= 3 || (w.length >= 3 && !GENERIC.has(w))) break;
  }
  const fallback = norm(description).replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  return { merchant: kept.map(displayWord).join(' ') || description.trim(), key: keyWords.join(' ') || fallback };
}

// --- Renglones con posición (PDF y fotos) ----------------------------------------------------------------

/** Cajas de texto (Vision o pdf.js) → renglones con celdas: las cajas muy juntas forman una sola celda */
export function rowsFromBoxes(boxes: TextBox[], aspect = 1): StatementRow[] {
  return groupRows(boxes).map((line) => {
    const cells: StatementCell[] = [];
    let end = 0;
    let lastRaw = '';
    let lastH = 0;
    for (const b of line) {
      const cell = cells[cells.length - 1];
      // La distancia se mide en «letras»: la altura de la caja, pasada a unidades de ancho
      const gap = (b.x - end) * aspect;
      const em = Math.max(lastH, b.h);
      if (cell && gap < em * 0.6) {
        const space = gap > em * 0.12 || /\s$/.test(lastRaw) || /^\s/.test(b.text);
        cell.text = `${cell.text}${space ? ' ' : ''}${b.text}`.replace(/\s+/g, ' ').trim();
        cell.w = Math.max(cell.w ?? 0, b.x + b.w - cell.x);
        end = Math.max(end, b.x + b.w);
      } else {
        cells.push({ text: b.text.replace(/\s+/g, ' ').trim(), x: b.x, w: b.w });
        end = b.x + b.w;
      }
      lastRaw = b.text;
      lastH = b.h;
    }
    return { cells };
  });
}

/** Texto plano (lector de fotos de la web) → un renglón por línea, sin posiciones */
export function rowsFromText(text: string): StatementRow[] {
  return text.split(/\r?\n/).map((l) => l.replace(/\t/g, ' ').trim()).filter(Boolean).map((t) => ({ cells: [{ text: t, x: 0 }] }));
}

interface Tok {
  t: string;
  x?: number;
  r?: number;
}

type Marker = StatementCurrency | 'foreign';

/** Monedas extranjeras que no son dólares (el importe de origen; el banco lo pasa a dólares) */
const FOREIGN = /^(eur|euros?|brl|ars|gbp|clp|mxn|r\$)$/;

function markerOf(t: string): Marker | null {
  const u = norm(t).replace(/[.:,]+$/, '');
  if (/^(u\$s|us\$|u\$d|usd|u\$|dolares|dolar)$/.test(u)) return 'usd';
  if (/^(\$|\$u|\$uy|uyu|pesos|\$ur)$/.test(u)) return 'local';
  if (FOREIGN.test(u)) return 'foreign';
  return null;
}

/** Importes con dos decimales: 1.234,56 · 1,234.56 · -150,00 · 150,00- · (150,00) */
const AMOUNT = /^\(?-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2}-?\)?$/;

function tokenAmount(t: string): number | null {
  if (!AMOUNT.test(t)) return null;
  // Los dos últimos dígitos son los centavos, sea cual sea el separador (el lector de fotos a veces cambia la coma por punto)
  const n = Number(t.replace(/\D/g, '')) / 100;
  return /^\(?-|-\)?$|^\(.*\)$/.test(t) ? -n : n;
}

/** Separa la moneda pegada al importe («U$S12,99», «$1.234,56») y el «CR» del final */
const splitGlued = (s: string) =>
  s.replace(/(U\$S|US\$|U\$D|USD|\$U|\$)(?=[-(]?\d)/gi, '$1 ').replace(/(\d[.,]\d{2})(CR|DB)\b/gi, '$1 $2');

function rowTokens(row: StatementRow, positional: boolean): Tok[] {
  const out: Tok[] = [];
  for (const c of row.cells) {
    const text = splitGlued(c.text);
    const words = [...text.matchAll(/\S+/g)];
    for (const w of words) {
      const i = w.index!;
      if (positional && c.w != null && text.length) {
        out.push({ t: w[0], x: c.x + (c.w * i) / text.length, r: c.x + (c.w * (i + w[0].length)) / text.length });
      } else if (positional && words.length === 1) out.push({ t: w[0], x: c.x, r: c.x });
      else out.push({ t: w[0] });
    }
  }
  return out;
}

type ColType = StatementCurrency | 'origin' | 'any';

interface Column {
  type: ColType;
  x?: number;
  r?: number;
}

const HEADER_LABEL = /^(fecha|descripcion|concepto|detalle|comercio|establecimiento|movimientos?|referencia|cuotas?|comprobante)$/;
const GENERIC_AMOUNT = /^(importes?|montos?|valor)$/;

/** Columnas de importe de un encabezado: «IMPORTE $», «IMPORTE U$S», «Importe origen», «Pesos», «Dólares» */
function headerOf(toks: Tok[]): Column[] | null {
  const words = toks.map((t) => norm(t.t).replace(/[:.]+$/, ''));
  const cols: Column[] = [];
  let label = false;
  for (let i = 0; i < toks.length; i++) {
    const w = words[i];
    if (HEADER_LABEL.test(w)) {
      label = true;
      continue;
    }
    // «Moneda» (u «Moneda origen») es la columna con el símbolo, no un importe
    if (w === 'moneda') {
      if (/^(origen|original)$/.test(words[i + 1] ?? '')) i++;
      continue;
    }
    const generic = GENERIC_AMOUNT.test(w);
    let j = i;
    if (generic) j = words[i + 1] === 'en' ? i + 2 : i + 1;
    const target = generic ? words[j] : w;
    const mk = target == null ? null : markerOf(toks[j].t);
    const type: ColType | null = target != null && /^(origen|original)$/.test(target) ? 'origin' : mk === 'local' || mk === 'usd' ? mk : null;
    if (type) {
      cols.push({ type, x: toks[i].x, r: toks[j].r });
      i = j;
    } else if (generic) cols.push({ type: 'any', x: toks[i].x, r: toks[i].r });
  }
  if (!cols.length || (!label && cols.length < 2)) return null;
  return cols;
}

interface RowAmount {
  v: number;
  x?: number;
  r?: number;
  marker?: Marker;
}

interface ParsedRow {
  date?: DayParts;
  desc: string;
  amounts: RowAmount[];
  /** Primera moneda que aparece en el renglón (la columna «Moneda» o el símbolo pegado a un importe) */
  marker?: Marker;
}

function parseRow(toks: Tok[]): ParsedRow {
  const words = toks.map((t) => t.t);
  // La fecha va primero (puede haber una viñeta o un número antes)
  let found = dateAt(words, 0);
  if (!found && words.length > 2 && !/[a-z]/i.test(words[0]) && tokenAmount(words[0]) == null) found = dateAt(words, 1);
  let start = 0;
  let date: DayParts | undefined;
  if (found) {
    date = found.parts;
    start = found.next;
    // Fecha de proceso a continuación, o un rango («26/08 al 25/09»)
    for (;;) {
      const sep = /^(-|al|a)$/i.test(words[start] ?? '') ? 1 : 0;
      const more = dateAt(words, start + sep);
      if (!more) break;
      start = more.next;
    }
  }
  const isAmount = (k: number) => k >= start && k < words.length && tokenAmount(words[k]) != null && words[k + 1] !== '%' && !/^%/.test(words[k + 1] ?? '');
  const used = new Set<number>();
  const amounts: RowAmount[] = [];
  let marker: Marker | undefined;
  for (let k = start; k < words.length; k++) {
    if (!isAmount(k)) continue;
    let v = tokenAmount(words[k])!;
    let mk: Marker | undefined;
    used.add(k);
    // Moneda y signo antes del importe («- U$S 12,99»), o la moneda y «CR» después
    let p = k - 1;
    if (p >= start && !used.has(p) && markerOf(words[p])) {
      mk = markerOf(words[p])!;
      used.add(p--);
    }
    if (p >= start && !used.has(p) && words[p] === '-') {
      v = -Math.abs(v);
      used.add(p);
    }
    let n = k + 1;
    if (!mk && n < words.length && markerOf(words[n]) && !isAmount(n + 1)) {
      mk = markerOf(words[n])!;
      used.add(n++);
    }
    if (/^(cr|db)\.?$/i.test(words[n] ?? '')) {
      if (/^cr/i.test(words[n])) v = -Math.abs(v);
      used.add(n);
    }
    marker ??= mk;
    amounts.push({ v, x: toks[k].x, r: toks[k].r, marker: mk });
  }
  const desc: string[] = [];
  for (let k = start; k < words.length; k++) {
    if (used.has(k)) continue;
    const mk = markerOf(words[k]);
    if (mk) marker ??= mk;
    else desc.push(words[k]);
  }
  // Fuera el número de comprobante del comienzo
  const text = desc.join(' ').replace(/^[-|*·•]+\s*/, '').replace(/^(\d{3,}\s+)+(?=\S*[a-z])/i, '').trim();
  return { date, desc: text, amounts, marker };
}

/** Columna más cercana al importe: la que se superpone con él o, si ninguna, la de centro más cerca */
function nearest(cols: Column[], a: RowAmount): Column {
  let best = cols[0];
  let bestGap = Infinity;
  let bestCenter = Infinity;
  for (const c of cols) {
    const gap = Math.max(0, c.x! - a.r!, a.x! - c.r!);
    const center = Math.abs((c.x! + c.r!) / 2 - (a.x! + a.r!) / 2);
    if (gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) < 1e-9 && center < bestCenter)) {
      best = c;
      bestGap = gap;
      bestCenter = center;
    }
  }
  return best;
}

/** A qué moneda va cada importe del renglón. Devuelve uno por moneda (el último distinto de cero) */
function assignAmounts(amts: RowAmount[], cols: Column[] | null, rowMarker?: Marker): { currency: StatementCurrency; amount: number }[] {
  const typed: { type: ColType; v: number; marker?: Marker }[] = [];
  const positional = !!cols && cols.every((c) => c.x != null) && amts.every((a) => a.x != null);
  let fallback: Marker | undefined = rowMarker;
  if (positional) {
    for (const a of amts) typed.push({ type: nearest(cols!, a).type, v: a.v, marker: a.marker });
  } else {
    let rest = amts;
    // Sin posiciones, con columna de importe de origen: el primero es el de origen y su moneda vale para el resto
    if (cols?.some((c) => c.type === 'origin') && amts.length >= 2) {
      typed.push({ type: 'origin', v: amts[0].v, marker: amts[0].marker });
      fallback = amts[0].marker ?? rowMarker;
      rest = amts.slice(1);
    }
    const unmarked = rest.filter((a) => !a.marker);
    const sheetCols = cols?.filter((c) => c.type !== 'origin').map((c) => c.type);
    let order: ColType[] | null = null;
    if (sheetCols && unmarked.length === sheetCols.length) order = sheetCols;
    // Dos importes sin encabezado y uno en cero: primero pesos, después dólares
    else if (!cols && unmarked.length === 2 && unmarked.some((a) => a.v === 0)) order = ['local', 'usd'];
    let k = 0;
    for (const a of rest) {
      if (a.marker === 'local' || a.marker === 'usd') typed.push({ type: a.marker, v: a.v });
      else typed.push({ type: a.marker ? 'any' : order ? order[k++] : 'any', v: a.v, marker: a.marker });
    }
  }
  const currencyOf = (m?: Marker): StatementCurrency => {
    const c = m ?? fallback;
    return c === 'usd' || c === 'foreign' ? 'usd' : 'local';
  };
  const out = new Map<StatementCurrency, number>();
  for (const t of typed) if ((t.type === 'local' || t.type === 'usd') && t.v !== 0) out.set(t.type, t.v);
  const direct = new Set(out.keys());
  for (const t of typed) {
    if (t.type !== 'any' || t.v === 0) continue;
    const c = currencyOf(t.marker);
    if (!direct.has(c)) out.set(c, t.v);
  }
  if (!out.size) for (const t of typed) if (t.type === 'origin' && t.v !== 0) out.set(currencyOf(t.marker), t.v);
  return [...out].map(([currency, amount]) => ({ currency, amount }));
}

function makeTx(date: string, description: string, amount: number, currency: StatementCurrency, installment = installmentOf(description)): StatementTx {
  let kind = statementKind(description);
  let value = amount;
  if (kind === 'pago' || kind === 'credito') value = -Math.abs(value);
  else if (value < 0 && kind !== 'saldo') kind = 'credito';
  const { merchant, key } = normalizeMerchant(description);
  const tx: StatementTx = { date, description, merchant, key, amount: round2(value), currency, kind };
  if (installment) tx.installment = installment;
  return tx;
}

/** Renglones sin fecha que no son movimientos (aunque tengan un número) */
const INFO_LINE = /cotizacion|tipo de cambio|\btasa\b|\bt ?e ?a\b|\bt ?n ?a\b/;

function parseTokenRows(rows: Tok[][], text: string, opts: StatementOptions): StatementTx[] {
  const ref = refOf(statementInfo(text), text, opts.today ?? todayISO());
  let cols: Column[] | null = null;
  let lastDate: string | undefined;
  const txs: StatementTx[] = [];
  for (const toks of rows) {
    if (!toks.length) continue;
    const row = parseRow(toks);
    if (!row.date && !row.amounts.length) {
      cols = headerOf(toks) ?? cols;
      continue;
    }
    if (!row.amounts.length || !/[a-z]{2}/.test(norm(row.desc))) continue;
    let date = row.date ? isoOf(row.date, ref) : null;
    if (date) lastDate = date;
    else {
      // Sin fecha: cargos y créditos del banco debajo del último movimiento (intereses, IVA, reintegros)
      const kind = statementKind(row.desc);
      if (row.date || !lastDate || kind === 'compra' || kind === 'saldo' || INFO_LINE.test(norm(row.desc))) continue;
      date = lastDate;
    }
    for (const { currency, amount } of assignAmounts(row.amounts, cols, row.marker)) txs.push(makeTx(date, row.desc, amount, currency));
  }
  return txs;
}

const rowText = (rows: StatementRow[]) => rows.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');

/** Estado de cuenta leído de un PDF o de una foto, con la posición de cada celda */
export function parseStatementRows(rows: StatementRow[], opts: StatementOptions = {}): StatementTx[] {
  return parseTokenRows(rows.map((r) => rowTokens(r, true)), rowText(rows), opts);
}

/** Estado de cuenta en texto plano (sin posiciones): la moneda sale de los símbolos y del orden de las columnas */
export function parseStatementText(text: string, opts: StatementOptions = {}): StatementTx[] {
  const rows = rowsFromText(text);
  return parseTokenRows(rows.map((r) => rowTokens(r, false)), rowText(rows), opts);
}

// --- Planillas exportadas por el banco (CSV o Excel) -----------------------------------------------------

const cellText = (v: Cell) => (v == null || v instanceof Date ? '' : String(v).trim());

interface TableCols {
  date: number;
  desc: number;
  local: number;
  usd: number;
  any: number;
  origin: number;
  debit: number;
  credit: number;
  currency: number;
  installment: number;
}

function tableColumns(header: string[]): TableCols | null {
  const h = header.map(norm);
  const find = (re: RegExp, not?: RegExp) => h.findIndex((c) => !!c && re.test(c) && !not?.test(c));
  let date = find(/^fecha\b|^date$|^dia$/, /valor|proceso|vencimiento|cierre|pago|emision/);
  if (date < 0) date = find(/^fecha\b/);
  let desc = find(/descripcion|concepto|detalle|comercio|establecimiento|movimiento|description/);
  if (desc < 0) desc = find(/referencia/);
  const currency = find(/^(moneda|divisa|currency)$/);
  const installment = find(/^(cuotas?|cuota nro|nro de cuota|plan)$/);
  const debit = find(/debito|\bdebe\b|^cargos?$|^consumos?$/);
  const credit = find(/credito|\bhaber\b|^abonos?$|^pagos?$/);
  const origin = find(/origen|original/);
  const taken = new Set([date, desc, currency, installment, debit, credit, origin]);
  const amountCol = (re: RegExp) => h.findIndex((c, i) => !taken.has(i) && re.test(c));
  const usd = amountCol(/u\$s|us\$|u\$d|\busd\b|dolar/);
  taken.add(usd);
  const local = amountCol(/\$|\bpesos\b|\buyu\b|moneda nacional/);
  const any = amountCol(/^(importe|monto|valor|amount|total|importe total|monto total)$/);
  if (date < 0 || desc < 0 || [local, usd, any, origin, debit, credit].every((i) => i < 0)) return null;
  return { date, desc, local, usd, any, origin, debit, credit, currency, installment };
}

function cellAmount(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || !/\d/.test(s)) return null;
  const negative = /^-|-$|^\(.*\)$|\bcr\.?$/i.test(s);
  const n = parseAmount(s.replace(/\b(cr|db)\.?$/i, '').replace(/[()-]/g, ''));
  return n == null ? null : negative ? -Math.abs(n) : n;
}

function cellDate(v: Cell, ref: Ref): string | null {
  // SheetJS arma las fechas en UTC: se suman unas horas para no caer en el día anterior
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(v.getTime() + 12 * 3600_000).toISOString().slice(0, 10);
  if (typeof v === 'number') return v > 30000 && v < 80000 ? new Date(Date.UTC(1899, 11, 30) + v * 86400_000).toISOString().slice(0, 10) : null;
  const s = cellText(v);
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (iso) return iso[1];
  const found = dateAt(s.split(/\s+/), 0);
  return found ? isoOf(found.parts, ref) : null;
}

/** Planilla del banco: una fila por movimiento con fecha, descripción e importe (o débito y crédito) */
export function parseStatementTable(rows: Cell[][], opts: StatementOptions = {}): StatementTx[] {
  let h = -1;
  let cols: TableCols | null = null;
  for (let i = 0; i < Math.min(rows.length, 60) && !cols; i++) {
    cols = tableColumns((rows[i] ?? []).map(cellText));
    if (cols) h = i;
  }
  if (!cols) return [];
  const c = cols;
  const text = rows.map((r) => r.map(cellText).join(' ')).join('\n');
  const ref = refOf(statementInfo(text), text, opts.today ?? todayISO());
  const raw: { date: string; desc: string; amount: number; currency: StatementCurrency; installment?: string }[] = [];
  for (const r of rows.slice(h + 1)) {
    const desc = cellText(r[c.desc]);
    if (!/[a-z]{2}/.test(norm(desc))) continue;
    const date = cellDate(r[c.date], ref);
    if (!date) continue;
    const curText = c.currency >= 0 ? cellText(r[c.currency]) : '';
    const rowCur: StatementCurrency = markerOf(curText) === 'usd' || /dolar|usd|u\$s/.test(norm(curText)) ? 'usd' : 'local';
    const amt = (i: number) => (i >= 0 ? cellAmount(r[i]) : null);
    const out: [StatementCurrency, number][] = [];
    if (c.debit >= 0 || c.credit >= 0) {
      const debit = amt(c.debit);
      const credit = amt(c.credit);
      if (debit) out.push([rowCur, Math.abs(debit)]);
      else if (credit) out.push([rowCur, -Math.abs(credit)]);
    }
    if (!out.length) {
      const local = amt(c.local);
      const usd = amt(c.usd);
      if (local) out.push(['local', local]);
      if (usd) out.push(['usd', usd]);
    }
    if (!out.length) {
      const a = amt(c.any) || amt(c.origin);
      if (a) out.push([rowCur, a]);
    }
    const installment = c.installment >= 0 ? installmentOf(`cuota ${cellText(r[c.installment])}`) : undefined;
    for (const [currency, amount] of out) raw.push({ date, desc, amount, currency, installment });
  }
  // Hay bancos que exportan las compras en negativo (como débitos de una cuenta): se dan vuelta los signos
  const buys = raw.filter((x) => statementKind(x.desc) === 'compra');
  const flip = buys.length >= 2 && buys.filter((x) => x.amount < 0).length > buys.length / 2;
  return raw.map((x) => makeTx(x.date, x.desc, flip ? -x.amount : x.amount, x.currency, x.installment));
}

// --- Contra lo ya anotado --------------------------------------------------------------------------------

/** Compras y cargos (lo que se anota como gasto) */
export const isSpend = (tx: StatementTx) => (tx.kind === 'compra' || tx.kind === 'cargo') && tx.amount > 0;

/** Monto en pesos (las compras en dólares, con la cotización) */
export function toLocal(tx: Pick<StatementTx, 'amount' | 'currency'>, usdRate: number): number {
  return tx.currency === 'usd' ? round2(tx.amount * usdRate) : tx.amount;
}

function similarity(key: string, other: string | undefined): number {
  if (!other) return 0;
  const k = normalizeMerchant(other).key;
  if (k === key) return 2;
  const words = new Set(key.split(' ').filter((w) => w.length >= 3));
  return k.split(' ').some((w) => words.has(w)) || norm(other).includes(key) ? 1 : 0;
}

/**
 * Compras del estado de cuenta que ya están anotadas (a mano, con una factura o de otro estado de cuenta):
 * un gasto con el mismo monto (tolerancia de $ 1 o 1%) y a no más de 3 días. Cada movimiento se empareja con una
 * sola compra, prefiriendo el de comercio parecido. Las compras en dólares se comparan solo si hay cotización.
 * Devuelve índice de la compra → id del movimiento.
 */
export function findDuplicates(txs: StatementTx[], movements: Movement[], usdRate?: number): Map<number, string> {
  const pool = movements.filter((m) => m.kind === 'gasto' && !m.monthly);
  const pairs: { i: number; id: string; sim: number; dAmount: number; dDays: number }[] = [];
  txs.forEach((tx, i) => {
    if (!isSpend(tx)) return;
    if (tx.currency === 'usd' && !(usdRate && usdRate > 0)) return;
    const amount = toLocal(tx, usdRate ?? 1);
    // En dólares la cotización del día de la compra puede ser otra
    const tol = Math.max(1, amount * (tx.currency === 'usd' ? 0.03 : 0.01));
    for (const m of pool) {
      const dAmount = Math.abs(m.amount - amount);
      const dDays = Math.abs(dayNumber(m.date) - dayNumber(tx.date));
      if (dAmount <= tol && dDays <= 3) pairs.push({ i, id: m.id, sim: similarity(tx.key, m.merchant || m.note), dAmount, dDays });
    }
  });
  pairs.sort((a, b) => b.sim - a.sim || a.dAmount - b.dAmount || a.dDays - b.dDays || a.i - b.i);
  const out = new Map<number, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.i) || used.has(p.id)) continue;
    out.set(p.i, p.id);
    used.add(p.id);
  }
  return out;
}

/** Meses de las compras que ya tienen los totales mensuales de la planilla (sumarlas duplicaría el gasto) */
export function planillaMonths(txs: StatementTx[], movements: Movement[]): string[] {
  const monthly = new Set(movements.filter((m) => m.monthly && m.kind === 'gasto').map((m) => monthOf(m.date)));
  return [...new Set(txs.filter(isSpend).map((t) => monthOf(t.date)))].filter((m) => monthly.has(m)).sort();
}
