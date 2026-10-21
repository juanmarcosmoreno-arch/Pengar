/**
 * Estados de cuenta de la tarjeta (PDF, foto o planilla del banco) → compras, cargos, pagos y créditos.
 * No depende de un banco: busca la fecha al comienzo de cada renglón y los importes con dos decimales. Si hay
 * encabezados («Importe $», «U$S»…), cada importe va a la columna que tiene más cerca: así se sabe si es en pesos
 * o en dólares. Los comercios se limpian (procesadores de pago, sucursales, ciudades) para que la misma tienda
 * tenga siempre la misma clave y lo aprendido sirva para los meses siguientes (y para las facturas).
 */
import { monthOf, shiftMonths, today as todayISO } from './dates';
import { norm, sheetDate, type Cell } from './importSheet';
import { rateOn, splitUsdNote, type UsdRate } from './fx';
import { parseAmount, round2 } from './money';
import { groupRows, type TextBox } from './ocrLines';
import type { Invoice, Movement } from './types';

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
  /**
   * Fecha de la compra, cuando la cuota vino con la de la compra original (de antes del período): entonces `date` es
   * la del cierre (installmentsAtClosing)
   */
  purchaseDate?: string;
  kind: StatementKind;
  /**
   * No es un renglón del estado de cuenta: lo que cobra de más que los movimientos (el saldo contado contra el
   * anterior y lo leído, balanceGaps). La revisión lo ofrece como cargo
   */
  balance?: true;
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
  /** Límite de crédito y crédito disponible (en pesos), si los trae con su título */
  limit?: number;
  available?: number;
  /** La fecha sola arriba de la página (Itaú, que no escribe «cierre»): el cierre, si cuadra con los movimientos */
  pageDate?: string;
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

/**
 * Fecha que empieza en el pedazo `i` (puede ocupar hasta tres: «12 SET 2025», «13 02 26»). Con `ref`, un año de dos
 * cifras después del mes vale solo si es el del cierre o el anterior: en «19 NOV 24 HORAS» el 24 es del comercio.
 */
function dateAt(words: string[], i: number, ref?: Ref): { parts: DayParts; next: number } | null {
  const t = words[i];
  if (!t) return null;
  const p = dateToken(t);
  if (p) return { parts: p, next: i + 1 };
  // Día, mes y año en números separados por espacios (Itaú: «13 02 26»). Sin el año no es una fecha; con `ref`, el
  // año va de hasta seis antes del cierre (la cuota de una compra vieja trae su fecha) a uno después
  if (/^\d{1,2}$/.test(t) && /^\d{1,2}$/.test(words[i + 1] ?? '') && /^(\d{2}|\d{4})$/.test(words[i + 2] ?? '')) {
    const year = fullYear(words[i + 2]);
    const parts = !ref || (year >= ref.y - 6 && year <= ref.y + 1) ? valid({ d: +t, m: +words[i + 1], y: year }) : null;
    if (parts) return { parts, next: i + 3 };
  }
  const mo = /^\d{1,2}$/.test(t) ? monthWord(words[i + 1]) : null;
  if (!mo) return null;
  const y = words[i + 2]?.match(/^(\d{4}|\d{2})$/)?.[1];
  const year = y ? fullYear(y) : undefined;
  const withYear = year != null && year >= 2020 && year <= 2069 && (y!.length === 4 || !ref || year === ref.y || year === ref.y - 1);
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

/** Un renglón que parece un movimiento (una fecha al comienzo y un importe): el comercio no dice de qué tarjeta es */
function looksLikeMovement(line: string): boolean {
  const words = splitGlued(line).split(/\s+/).filter(Boolean);
  const dated = dateAt(words, 0) || (words.length > 2 && !/[a-z]/i.test(words[0]) && tokenAmount(words[0]) == null && dateAt(words, 1));
  return !!dated && words.some((w) => tokenAmount(w) != null);
}

/**
 * La tarjeta, si aparece en el encabezado: «OCA», «Visa BROU», «Master Scotiabank». Si no, el banco en el resto (Itaú
 * lo dice solo en el pie). Nunca de los movimientos: «MASTER CLEAN» o «FARMACIA SANTANDER» son comercios
 */
export function detectCard(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(norm).filter((l) => !looksLikeMovement(l));
  const brand = earliest(BRANDS, lines.slice(0, 20).join('\n'));
  if (brand === 'OCA') return brand;
  const card = [brand, earliest(BANKS, lines.slice(0, 20).join('\n'))].filter(Boolean).join(' ');
  return card || earliest([BRANDS[0], ...BANKS], lines.join('\n'));
}

/** Fechas escritas en un renglón ya normalizado: 25/09/2025, 26/09, 25.09.2025, 2025-09-25, 25 de setiembre (de 2025) */
const DATE_TEXT =
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?: de)? (?:ene|feb|mar|abr|may|jun|jul|ago|set|sep|oct|nov|dic)[a-z]*\.?(?:(?: de)? \d{4})?/g;

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
  // Sin las fechas: en «Cotización al 25/09/2025: 40,10» el primer número es el día
  const noDates = lines.join('\n').replace(DATE_TEXT, ' ');
  for (const m of noDates.matchAll(/(cotizacion|tipo de cambio|t\/c|\btc\b)[^\d\n]{0,30}(\d{1,3}(?:[.,]\d{1,4})?)/g)) {
    const v = Number(m[2].replace(',', '.'));
    if (v > 10 && v < 200) {
      info.usdRate = v;
      break;
    }
  }
  // Límite y disponible: el importe al lado del título (antes del título siguiente) o, si el renglón de los títulos no
  // tiene importes, los del de abajo en el mismo orden: solo si son tantos como los títulos y ese renglón no tiene
  // palabras (un párrafo que sigue no es la fila de valores)
  lines.forEach((raw, i) => {
    let masked = splitGlued(raw);
    const labels: { key: MoneyLabel | null; index: number }[] = [];
    for (const [key, re] of MONEY_LABELS) {
      for (const m of [...masked.matchAll(re)]) {
        labels.push({ key, index: m.index! });
        masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index! + m[0].length);
      }
    }
    if (!labels.some((l) => l.key)) return;
    labels.sort((a, b) => a.index - b.index);
    const own = lineAmounts(raw);
    const set = (key: MoneyLabel | null, v: number | undefined) => {
      if (key && v != null && info[key] == null) info[key] = v;
    };
    if (own.length) {
      labels.forEach((l, k) => {
        const end = labels[k + 1]?.index ?? Infinity;
        set(l.key, own.find((a) => a.index > l.index && a.index < end)?.v);
      });
    } else {
      const next = lines[i + 1] ?? '';
      const below = lineAmounts(next);
      const values = splitGlued(next).split(/\s+/).every((w) => !/\p{L}/u.test(w) || markerOf(w));
      if (values && below.length === labels.length) labels.forEach((l, k) => set(l.key, below[k].v));
    }
  });
  const card = detectCard(text);
  if (card) info.card = card;
  if (!info.closing) {
    // Itaú no escribe «cierre»: la fecha sola arriba de cada página lo es (statementPeriod la usa si cuadra)
    const lone = lines.slice(0, 10).find((l) => /^\d{1,2}[/.-]\d{1,2}[/.-](\d{4}|\d{2})$/.test(l));
    const page = lone ? fullDates(lone)[0]?.iso : undefined;
    if (page) info.pageDate = page;
  }
  return info;
}

type MoneyLabel = 'limit' | 'available';

/**
 * En orden: los que no interesan (lo disponible para adelantos, el límite en cuotas), lo disponible («límite de
 * crédito disponible» es lo disponible), el límite y otros títulos con importe (el pago mínimo, el saldo, un cargo):
 * los que no interesan igual cortan el tramo del título de antes
 */
const MONEY_LABELS: [MoneyLabel | null, RegExp][] = [
  [null, /\b(?:(?:limite (?:de )?)?credito |saldo |limite )?disponible (?:para |de |en )?(?:adelantos?|efectivo|retiros?)\b|\blimite (?:de |para )?(?:compras? )?(?:en cuotas|adelantos?|efectivo|retiros?)\b/g],
  ['available', /\b(?:(?:limite (?:de )?)?credito |saldo |limite )?disponible(?: (?:para|de) compras?)?\b/g],
  ['limit', /\blimite (?:de )?(?:credito|compras?)\b/g],
  [null, /\bpago minimo\b|\bminimo a pagar\b|\bsaldo\b|\btotal\b|\bdeuda\b|\bcargos?\b|\bcuotas?\b/g],
];

/** Importes de un renglón ya normalizado, con dónde empiezan (los en dólares no: el límite es en pesos) */
function lineAmounts(line: string): { v: number; index: number }[] {
  const out: { v: number; index: number }[] = [];
  let prev = '';
  for (const m of splitGlued(line).matchAll(/\S+/g)) {
    const v = tokenAmount(m[0]);
    if (v != null && markerOf(prev) !== 'usd') out.push({ v, index: m.index! });
    prev = m[0];
  }
  return out;
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

/** La cuota que sigue de una compra anterior (2/6, 3/6…): su fecha puede ser la de la compra */
const laterCuota = (t: StatementTx) => !!t.installment && Number(t.installment.split('/')[0]) >= 2;

/** Movimientos de antes de un mes antes del cierre a partir de los cuales el archivo es una planilla de varios meses */
const PLANILLA_EARLY = 3;

/**
 * Período del estado de cuenta: del cierre anterior al cierre (o a la fecha sola arriba de la página, si cuadra con el
 * último movimiento; si no, al último movimiento). Si no dice desde cuándo, el primer renglón (el saldo anterior o la
 * primera compra), sin las cuotas de compras anteriores (algunos bancos repiten la fecha de la compra original) y no
 * antes de un mes antes del cierre: alguna compra que el comercio presentó tarde trae su fecha de antes. Si son muchas
 * (más de un cuarto y por lo menos 3), el archivo trae más de un mes (una planilla exportada) y va desde el primer
 * renglón.
 */
export function statementPeriod(txs: StatementTx[], info: StatementInfo): { from: string; to: string } | undefined {
  const all = txs.map((t) => t.date).sort();
  const moves = txs.filter((t) => t.kind !== 'saldo').map((t) => t.date).sort();
  const last = moves[moves.length - 1];
  const page = info.pageDate && (!last || (info.pageDate >= last && dayNumber(info.pageDate) - dayNumber(last) <= 15)) ? info.pageDate : undefined;
  const to = info.closing ?? page ?? last ?? all[all.length - 1];
  if (!to) return undefined;
  let from = info.from ?? (info.previous ? addDays(info.previous, 1) : undefined);
  if (!from) {
    const own = txs.filter((t) => !laterCuota(t)).map((t) => t.date).sort();
    const floor = addDays(shiftMonths(to, -1), 1);
    const early = own.filter((d) => d < floor).length;
    from = !own.length ? floor : (early >= PLANILLA_EARLY && early > own.length / 4) || own[0] > floor ? own[0] : floor;
  }
  return { from: from <= to ? from : to, to };
}

/**
 * Cada cuota es un gasto del mes en que se paga: en un estado de cuenta de un mes, todas las cuotas van con la fecha de
 * cierre. Un buzo de $ 3.000 en 3 cuotas son $ 1.000 de ropa en cada uno de los tres meses. Si la fecha que trae es la
 * de la compra (la de la primera cuota, la de una cuota de antes del período: «cuota 7/9» de marzo en el de setiembre,
 * o la de las que siguen en un banco que repite la fecha de la compra), queda en `purchaseDate`. Los repetidos
 * (findDuplicates) comparan con las dos fechas. Sin el cierre anterior escrito, el comienzo es una estimación y puede
 * quedar unos días antes. En un archivo de varios meses (una planilla exportada) solo pasan al cierre las de antes.
 */
export function installmentsAtClosing(txs: StatementTx[], period: { from: string; to: string } | undefined): StatementTx[] {
  if (!period) return txs;
  const { from, to } = period;
  const single = dayNumber(to) - dayNumber(from) <= 35;
  const purchaseDated = single && txs.some((t) => laterCuota(t) && t.kind !== 'saldo' && t.date < from);
  const cut = addDays(to, -25);
  return txs.map((t) => {
    if (!t.installment || t.kind === 'saldo' || t.date === to) return t;
    if (!single) return t.date < from ? { ...t, date: to, purchaseDate: t.date } : t;
    const bought = t.date < from || !laterCuota(t) || (purchaseDated && t.date < cut);
    return bought ? { ...t, date: to, purchaseDate: t.date } : { ...t, date: to };
  });
}

/**
 * Cuándo se paga el estado de cuenta: el vencimiento, si se leyó y cuadra con el cierre; si no, 15 días después del
 * cierre (en Uruguay se paga a principios o mediados del mes siguiente)
 */
export function paymentDate(closing: string, due?: string): string {
  const days = due ? dayNumber(due) - dayNumber(closing) : -1;
  return due && days >= 0 && days <= 40 ? due : addDays(closing, 15);
}

// --- Tipo de movimiento y cuotas -------------------------------------------------------------------------

const SALDO = /^saldo\b|\bsaldo (anterior|contado|actual|a pagar|deudor|financiado|total|al cierre|a favor|pendiente|del periodo)\b|total a pagar|\bpago minimo\b|minimo a pagar|\bpago contado\b|\blimite\b|\bdisponible\b|^total\b|\bsub ?total\b/;
const PAGO = /^(su |sus )?pagos?\b(?! (web|online|facil|movil|express|(de )?(factura|servicio)s?\b))|pago recibido|gracias por su pago|\bpago (de |del )?(la )?(tarjeta|resumen|estado de cuenta)\b/;
const CREDITO = /reintegro|devolucion|bonificacion|\bbonif\b|\banul|reverso|reversion|contracargo|nota de credito|reembolso|cashback|\ba favor\b|descuento ley|\bdto ley\b|ley 19\.?210|ley 17\.?934|\bcr$/;
const CARGO = /\bcargos?\b|comision|^seguro|\bseguro de vida\b|\bintereses?\b|^iva\b|\btimbres?\b|costo (de )?emision|\brecargo|\bmora\b|gastos? (de )?(administracion|cobranza|emision|envio|mantenimiento)|anualidad|membresia|renovacion|cuota anual|^impuestos?\b|sellado/;

/** Qué es un renglón según su descripción: pago de la tarjeta, saldo o total, crédito, cargo del banco o compra */
export function statementKind(description: string): StatementKind {
  // Sin los asteriscos o guiones del comienzo («** TOTAL Tarjeta»)
  const p = norm(description).replace(/\./g, '').replace(/^[^a-z0-9]+/, '');
  // «SEGURO SALDO DEUDOR», «SEG.VIDA S/SALDO» o «IVA S/INTERESES» son cargos aunque digan «saldo»
  if (/^(seguros?|seg ?vida|iva|intereses?|comision(es)?)\b/.test(p) && !CREDITO.test(p)) return 'cargo';
  if (SALDO.test(p)) return 'saldo';
  if (PAGO.test(p)) return 'pago';
  if (CREDITO.test(p)) return 'credito';
  if (CARGO.test(p)) return 'cargo';
  return 'compra';
}

/**
 * «CUOTA 02/06», «CTA 2 DE 6», «C.2/6», «02/06» o «6/ 6» suelto (Itaú la pone en su columna y completa con un
 * espacio el total de una cifra: «3/ 3», nunca «3/ 30»)
 */
const CUOTA_RES = [
  /\b(?:cuotas?|cta)\.?\s*:?\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,3})\b/gi,
  /\bc\.?\s?(\d{1,2})\/(\d{1,3})\b/gi,
  /(^|\s)(\d{1,2})\/(?: (?=\d(?:\s|$)))?(\d{1,3})(?=\s|$)/g,
];
/** El «n/N» suelto (el último de CUOTA_RES) */
const LOOSE = CUOTA_RES.length - 1;

const validCuota = (n: number, total: number) => n >= 1 && total >= 2 && n <= total && total <= 72;

/**
 * Scotiabank pega la cuota al final, a veces sin espacio: «HELADERIA LA NUBEC01/02». Vale solo al final, con dos
 * cifras de cada lado y si puede ser una cuota (01/02 sí, 12/09 no): si no, es parte del nombre
 */
function gluedCuota(text: string): { n: number; total: number; index: number } | null {
  const m = text.trimEnd().match(/c(\d{2})\/(\d{2})$/i);
  return m && validCuota(+m[1], +m[2]) ? { n: +m[1], total: +m[2], index: m.index! } : null;
}

/** La descripción sin el texto de la cuota («ZARA CUOTA 02/03» → «ZARA»): la cuota no dice de qué es la compra */
export function withoutInstallment(text: string): string {
  const glued = gluedCuota(text);
  let s = glued ? text.trimEnd().slice(0, glued.index) : text;
  for (const re of CUOTA_RES) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * La cuota de una descripción. Con `year` (el del cierre), un «MM/AA» suelto con el año del cierre (o el de antes o
 * después) es una fecha («CUOTA SOCIAL 09/26», «UTE FACTURA 08/26»), no la cuota 9 de 26; después de «cuota», «cta»
 * o «C» sí es una cuota
 */
export function installmentOf(text: string, year?: number): string | undefined {
  for (const [k, re] of CUOTA_RES.entries()) {
    for (const m of text.matchAll(re)) {
      const a = m[m.length - 2];
      const b = m[m.length - 1];
      if (k === LOOSE && year != null && a.length === 2 && b.length === 2 && Math.abs(Number(b) - (year % 100)) <= 1) continue;
      if (validCuota(Number(a), Number(b))) return `${Number(a)}/${Number(b)}`;
    }
  }
  const glued = gluedCuota(text);
  return glued ? `${glued.n}/${glued.total}` : undefined;
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
  // Un «?» entre mayúsculas es la Ñ que el PDF no supo escribir («ESPA?OLA»)
  let s = withoutInstallment(description.replace(/\s+/g, ' ').trim().replace(/(?<=\p{Lu})\?(?=\p{Lu})/gu, 'Ñ'));
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
  // Un nombre que empieza con cifras y letras pegadas las conserva («7K VIAJES», «3M»): no es un código
  const lead = tokens.length > 1 && /^(?=\D*\d)(?=.*\p{L})[\p{L}\d]{2,3}$/u.test(tokens[0]);
  const firstNumber = tokens.findIndex((w, i) => /\d/.test(w) && !(lead && i === 0));
  const named = firstNumber > 0 && distinctive(tokens.slice(0, firstNumber)) ? tokens.slice(0, firstNumber) : tokens;
  // Fuera números de comprobante, códigos y «SUC»
  let kept = named.filter((w, i) => {
    const k = word(w);
    return (lead && i === 0) || (k && !/\d/.test(k) && !DROP.has(k));
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
  /** La celda de donde sale (con posiciones): la cuota de Itaú va en la suya */
  cell?: number;
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
  row.cells.forEach((c, cell) => {
    const text = splitGlued(c.text);
    const words = [...text.matchAll(/\S+/g)];
    for (const w of words) {
      const i = w.index!;
      if (positional && c.w != null && text.length) {
        out.push({ t: w[0], x: c.x + (c.w * i) / text.length, r: c.x + (c.w * (i + w[0].length)) / text.length, cell });
      } else if (positional && words.length === 1) out.push({ t: w[0], x: c.x, r: c.x, cell });
      else out.push({ t: w[0], ...(positional ? { cell } : {}) });
    }
  });
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

/**
 * Columnas de importe de un encabezado: «IMPORTE $», «IMPORTE U$S», «Importe origen», «Pesos», «Dólares». `label`: trae
 * otro título («Fecha», «Descripción»…). Sin título, solo los nombres de las columnas: «Pagá en pesos o en dólares» o
 * «PESOS URUGUAYOS DÓLARES» (la tabla de financiación) no son un encabezado
 */
function headerOf(toks: Tok[]): { cols: Column[]; label: boolean } | null {
  const words = toks.map((t) => norm(t.t).replace(/[:.]+$/, ''));
  // Un párrafo que nombra las «cuotas» o el «importe» no es un encabezado: tiene muchas otras palabras
  const other = words.filter((w, i) => /[a-z]{4}/.test(w) && !HEADER_LABEL.test(w) && !GENERIC_AMOUNT.test(w) && !markerOf(toks[i].t) && !/^(moneda|origen|original|tarjeta)$/.test(w));
  if (other.length > 3) return null;
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
  if (!cols.length || (!label && (cols.length < 2 || other.length > 0 || words.some((w) => /^(y|o|e|u)$/.test(w))))) return null;
  return { cols, label };
}

/** Las columnas de un encabezado sin título caen sobre los importes de los movimientos que siguen (con posiciones) */
function alignedWith(cols: Column[], rows: ParsedRow[]): boolean {
  const amounts = rows.slice(0, 40).flatMap((r) => r.amounts).filter((a) => a.x != null && a.r != null);
  return cols.every((c) => c.x == null || c.r == null || amounts.some((a) => a.x! <= c.r! + COLUMN_GAP && a.r! >= c.x! - COLUMN_GAP));
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
  /** La cuota «n/N» en su propia celda, después de la descripción (la columna de Itaú) */
  cuota?: string;
}

function parseRow(toks: Tok[], ref?: Ref): ParsedRow {
  const words = toks.map((t) => t.t);
  // La fecha va primero (puede haber una viñeta o un número antes)
  let found = dateAt(words, 0, ref);
  if (!found && words.length > 2 && !/[a-z]/i.test(words[0]) && tokenAmount(words[0]) == null) found = dateAt(words, 1, ref);
  let start = 0;
  let date: DayParts | undefined;
  if (found) {
    date = found.parts;
    start = found.next;
    // Fecha de proceso a continuación, o un rango («26/08 al 25/09»)
    for (;;) {
      const sep = /^(-|al|a)$/i.test(words[start] ?? '') ? 1 : 0;
      const more = dateAt(words, start + sep, ref);
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
  const cells = new Map<number, string[]>();
  for (let k = start; k < words.length; k++) {
    if (used.has(k)) continue;
    const mk = markerOf(words[k]);
    if (mk) marker ??= mk;
    else {
      desc.push(words[k]);
      const c = toks[k].cell;
      if (c != null) cells.set(c, [...(cells.get(c) ?? []), words[k]]);
    }
  }
  // La cuota en su celda, con la descripción antes («6/12», «2/ 3»): todas las palabras de la celda son la cuota
  let cuota: string | undefined;
  [...cells.entries()].forEach(([c, list], k) => {
    const m = list.join(' ').match(/^(\d{1,2})\/ ?(\d{1,3})$/);
    if (k > 0 && m && validCuota(+m[1], +m[2]) && toks.filter((t) => t.cell === c).every((t) => list.includes(t.t))) cuota ??= `${+m[1]}/${+m[2]}`;
  });
  // Fuera el número de comprobante del comienzo
  const text = desc.join(' ').replace(/^[-|*·•]+\s*/, '').replace(/^(\d{3,}\s+)+(?=\S*[a-z])/i, '').trim();
  return { date, desc: text, amounts, marker, ...(cuota ? { cuota } : {}) };
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

/**
 * A qué moneda va cada importe del renglón. Devuelve uno por moneda (el último distinto de cero). Sin columnas, dos
 * importes sin moneda en un pago, un cargo o un saldo son pesos y dólares (en ese orden: «PAGOS -50.000,00 -120,00»);
 * en una compra, el segundo (el de origen va antes)
 */
function assignAmounts(amts: RowAmount[], cols: Column[] | null, rowMarker: Marker | undefined, kind: StatementKind): { currency: StatementCurrency; amount: number }[] {
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
    // Dos importes sin encabezado y uno en cero (o en un pago, un cargo o un saldo): primero pesos, después dólares
    else if (!cols && unmarked.length === 2 && (unmarked.some((a) => a.v === 0) || kind !== 'compra')) order = ['local', 'usd'];
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

function makeTx(date: string, description: string, amount: number, currency: StatementCurrency, installment?: string): StatementTx {
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

/** Distancia máxima entre los bordes derechos de los importes de una misma columna (en anchos de página) */
const COLUMN_GAP = 0.015;

/** Un renglón que trae el pago o el saldo en pesos y en dólares, cada uno en su columna (Itaú: los pagos, el seguro y
 * el saldo contado; el saldo anterior no, que va corrido) */
const anchorRow = (row: ParsedRow) =>
  row.amounts.length === 2 && (statementKind(row.desc) === 'pago' || statementKind(row.desc) === 'cargo' || /\bsaldo contado\b/.test(norm(row.desc)));

interface Mark {
  x: number;
  r: number;
  v: number;
  row: number;
}

/**
 * Columnas de importe sin encabezado (Itaú no lo trae como texto): salen de dónde terminan los importes de los
 * renglones con fecha, que van alineados a la derecha.
 * - Si hay renglones con el pago o el saldo en pesos y en dólares (anchorRow), esas son las dos columnas; a su
 *   izquierda, la que nunca va sola es la del importe de origen. Sirve aunque haya una sola compra en dólares.
 * - Si no, la de la izquierda que nunca tiene un importe solo (sin contar los ceros) es la del importe de origen:
 *   siempre va con el convertido. De las otras, la de la izquierda es la de pesos y la de la derecha, la de dólares
 *   (si no hay columna de origen, solo si también aparece sola: si no, puede ser otra cosa). Primero con todos los
 *   importes (una sola compra en dólares también es una columna) y, si no se entiende, sin los sueltos.
 * Con una sola columna o con más de tres, null: cada importe va por su símbolo, como antes.
 */
function inferColumns(rows: ParsedRow[]): Column[] | null {
  const marks: Mark[] = [];
  rows.forEach((row, k) => {
    if (row.date || anchorRow(row)) for (const a of row.amounts) if (a.x != null && a.r != null) marks.push({ x: a.x, r: a.r, v: a.v, row: k });
  });
  marks.sort((a, b) => a.r - b.r);
  const groups: Mark[][] = [];
  for (const m of marks) {
    const g = groups[groups.length - 1];
    if (g && m.r - g[g.length - 1].r <= COLUMN_GAP) g.push(m);
    else groups.push([m]);
  }
  const nonZero = new Map<number, number>();
  for (const m of marks) if (m.v !== 0) nonZero.set(m.row, (nonZero.get(m.row) ?? 0) + 1);
  const alone = (g: Mark[]) => g.some((m) => m.v !== 0 && nonZero.get(m.row) === 1);
  const col = (g: Mark[], type: ColType): Column => ({ type, x: Math.min(...g.map((m) => m.x)), r: Math.max(...g.map((m) => m.r)) });

  // Las dos columnas de los renglones con pesos y dólares (todos de acuerdo)
  const pairs = new Set<string>();
  rows.forEach((row, k) => {
    if (!anchorRow(row)) return;
    const own = groups.map((g, i) => (g.some((m) => m.row === k) ? i : -1)).filter((i) => i >= 0);
    pairs.add(own.length === 2 ? own.join(',') : 'no');
  });
  if (pairs.size === 1 && !pairs.has('no')) {
    const [local, usd] = [...pairs][0].split(',').map(Number);
    const typed = groups.map((g, i): Column | null =>
      i === local ? col(g, 'local') : i === usd ? col(g, 'usd') : i < local && !alone(g) ? col(g, 'origin') : null);
    if (typed.every(Boolean)) return typed as Column[];
  }

  const infer = (found: Mark[][]): Column[] | null => {
    if (found.length < 2 || found.length > 3) return null;
    const origin = !alone(found[0]);
    const rest = origin ? found.slice(1) : found;
    if (rest.length === 1) return origin ? [col(found[0], 'origin'), col(rest[0], 'any')] : null;
    if (rest.length !== 2 || (!origin && !alone(rest[1]))) return null;
    return [...(origin ? [col(found[0], 'origin')] : []), col(rest[0], 'local'), col(rest[1], 'usd')];
  };
  // Un importe suelto en otro lado no es una columna (si con él no se entiende)
  return infer(groups) ?? infer(groups.filter((g) => g.length >= 2));
}

function parseTokenRows(rows: Tok[][], text: string, opts: StatementOptions): StatementTx[] {
  const ref = refOf(statementInfo(text), text, opts.today ?? todayISO());
  const parsed = rows.map((toks) => (toks.length ? parseRow(toks, ref) : null));
  // Los encabezados que van antes de algún movimiento. Sin otro título («Fecha», «Descripción»), solo si sus columnas
  // caen sobre los importes de los movimientos que siguen: una promoción que nombra «pesos» y «dólares» no lo es
  const headers = new Map<number, Column[]>();
  rows.forEach((toks, k) => {
    const row = parsed[k];
    if (!row || row.date || row.amounts.length) return;
    const h = headerOf(toks);
    const after = parsed.slice(k + 1).filter((r): r is ParsedRow => !!r?.date && r.amounts.length > 0);
    if (h && after.length && (h.label || alignedWith(h.cols, after))) headers.set(k, h.cols);
  });
  // Antes del primer encabezado (o en todo el documento, si no tiene), las columnas que salen de los importes
  const first = Math.min(...headers.keys());
  const inferred = inferColumns(parsed.slice(0, first).filter((r): r is ParsedRow => !!r));
  let cols: Column[] | null = null;
  // Hay un movimiento antes (los cargos sin fecha van pegados) y la fecha más nueva hasta ahí, sin las cuotas que siguen
  // (pueden traer la fecha de la compra, de hace meses)
  let chain = false;
  let lastDate: string | undefined;
  let newest: string | undefined;
  const txs: StatementTx[] = [];
  for (const k of rows.keys()) {
    const row = parsed[k];
    if (!row) continue;
    if (!row.date && !row.amounts.length) {
      cols = headers.get(k) ?? cols;
      continue;
    }
    if (!row.amounts.length || !/[a-z]{2}/.test(norm(row.desc))) continue;
    const installment = row.cuota ?? installmentOf(row.desc, ref.y);
    let date = row.date ? isoOf(row.date, ref) : null;
    if (date) {
      chain = true;
      lastDate = date;
      if (!(installment && Number(installment.split('/')[0]) >= 2) && (!newest || date > newest)) newest = date;
    } else if (row.date) continue;
    else {
      // Sin fecha: cargos y créditos del banco pegados al último movimiento (intereses, IVA, reintegros). Cualquier
      // otro renglón con importe (saldo, compra, cotización) corta la cadena: el cuadro de resumen del pie no cuenta
      const kind = statementKind(row.desc);
      if (!chain || (kind !== 'cargo' && kind !== 'credito') || INFO_LINE.test(norm(row.desc))) {
        chain = false;
        continue;
      }
      date = newest ?? lastDate!;
    }
    for (const { currency, amount } of assignAmounts(row.amounts, cols ?? inferred, row.marker, statementKind(row.desc))) {
      txs.push(makeTx(date, row.desc, amount, currency, installment));
    }
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
  const find = (re: RegExp, not?: RegExp, skip = -1) => h.findIndex((c, i) => i !== skip && !!c && re.test(c) && !not?.test(c));
  let date = find(/^fecha\b|^date$|^dia$/, /valor|proceso|vencimiento|cierre|pago|emision/);
  if (date < 0) date = find(/^fecha\b/);
  // La descripción no es la fecha ni el tipo («Fecha movimiento», «Tipo de movimiento»): primero los títulos claros
  const notDesc = /^fecha|^tipo/;
  let desc = find(/^(descripcion|concepto|detalle|comercio|establecimiento|description)/, notDesc, date);
  if (desc < 0) desc = find(/descripcion|concepto|detalle|comercio|establecimiento|movimiento|description/, notDesc, date);
  if (desc < 0) desc = find(/referencia/, notDesc, date);
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
  // El signo puede venir después del símbolo («$ -890,00», «U$S (12,99)»)
  const negative = /^[^\d(]*-|-$|^[^\d(]*\(.*\)$|\bcr\.?$/i.test(s);
  const n = parseAmount(s.replace(/\b(cr|db)\.?$/i, '').replace(/[()-]/g, ''));
  return n == null ? null : negative ? -Math.abs(n) : n;
}

function cellDate(v: Cell, ref: Ref): string | null {
  if (v instanceof Date) return sheetDate(v);
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
  return raw.map((x) => makeTx(x.date, x.desc, flip ? -x.amount : x.amount, x.currency, x.installment ?? installmentOf(x.desc, ref.y)));
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
 * Cotizaciones para pasar a pesos las compras en dólares al buscar repetidos: las del BCU (`rates`: la de cada día, o la
 * del último día hábil antes) y, para un día que no tiene, `fallback` (la del estado de cuenta o, sin conexión, una
 * aproximada). Un número solo es `fallback`.
 */
export interface DuplicateRates {
  rates?: UsdRate[] | null;
  fallback?: number;
}

/**
 * Compras del estado de cuenta que ya están anotadas (a mano, con una factura o de otro estado de cuenta):
 * un gasto con el mismo monto (tolerancia de $ 1 o 1%) y a no más de 3 días. Cada movimiento se empareja con una
 * sola compra, prefiriendo el de comercio parecido. Las compras en dólares se comparan en dólares si lo anotado tiene
 * la cuenta en la nota; si no, en pesos con la cotización del día de la compra o la del día en que se anotó (3% de
 * tolerancia: el banco cobra el dólar algo más caro), y sin ninguna cotización no se comparan.
 * Una cuota guardada no es una compra sin cuota (y al revés, la cuota de una compra vieja, que va con la fecha de
 * cierre, solo es la misma cuota ya anotada). `statement`: el cierre del que se revisa y las facturas, para
 * reconocer lo guardado de ese mismo estado de cuenta con una versión anterior. Devuelve índice de la compra → id del
 * movimiento.
 */
export function findDuplicates(
  txs: StatementTx[],
  movements: Movement[],
  usdRates?: number | DuplicateRates,
  statement: { closing?: string; invoices?: Invoice[] } = {},
): Map<number, string> {
  const opts: DuplicateRates = typeof usdRates === 'number' ? { fallback: usdRates } : usdRates ?? {};
  const fallback = opts.fallback && opts.fallback > 0 ? opts.fallback : null;
  const rateFor = (date: string) => (opts.rates ? rateOn(date, opts.rates)?.rate : undefined) || fallback;
  const pool = movements.filter((m) => m.kind === 'gasto' && !m.monthly);
  // Los gastos de otro estado de cuenta guardado con el mismo cierre (el mismo, subido otra vez)
  const same = new Set((statement.invoices ?? []).filter((i) => i.kind === 'estado' && !!statement.closing && i.date === statement.closing).map((i) => i.id));
  // Lo anotado en dólares lleva la cuenta en la nota («U$S 100 × 42,50»): se compara en dólares, sin cotización
  const usdOf = new Map(pool.map((m) => [m.id, splitUsdNote(m.note).usd]));
  const pairs: { i: number; id: string; sim: number; dAmount: number; dDays: number }[] = [];
  txs.forEach((tx, i) => {
    if (!isSpend(tx) || tx.balance) return;
    const usd = tx.currency === 'usd';
    /** El monto en pesos que más se acerca a lo anotado ese día: con la cotización de la compra o la del día anotado */
    const diffInPesos = (m: Movement): { dAmount: number; tol: number } | null => {
      if (!usd) return { dAmount: Math.abs(m.amount - tx.amount), tol: Math.max(1, tx.amount * 0.01) };
      let best: { dAmount: number; tol: number } | null = null;
      for (const rate of new Set([rateFor(tx.date), rateFor(m.date)])) {
        if (!rate) continue;
        const amount = toLocal(tx, rate);
        const dAmount = Math.abs(m.amount - amount);
        if (!best || dAmount < best.dAmount) best = { dAmount, tol: Math.max(1, amount * 0.03) };
      }
      return best;
    };
    for (const m of pool) {
      // Otra cuota de la misma compra: hay bancos que repiten la fecha de la compra todos los meses
      const cuota = m.note?.match(/cuota (\d+\/\d+)/)?.[1];
      if (tx.installment && cuota && cuota !== tx.installment) continue;
      // Una cuota guardada (quizá llevada al cierre) no es una compra nueva de esos días por el mismo monto
      if (!tx.installment && cuota) continue;
      // Lo guardado con la fecha del pago de la tarjeta se compara también con la de la compra
      const days = (iso: string) =>
        Math.min(Math.abs(dayNumber(m.date) - dayNumber(iso)), m.purchased ? Math.abs(dayNumber(m.purchased) - dayNumber(iso)) : Infinity);
      let dDays: number;
      if (tx.purchaseDate) {
        // La cuota de una compra vieja: la misma cuota (en el cierre o, guardada antes, con la fecha de la compra), o lo
        // guardado de este mismo estado de cuenta con una versión anterior (con la fecha de la compra, sin la cuota)
        if (cuota === tx.installment) dDays = Math.min(days(tx.date), days(tx.purchaseDate));
        // La primera cuota anotada a mano el día de la compra (sin la nota de la cuota) también es la misma
        else if (!cuota && (tx.installment?.startsWith('1/') || (m.invoiceId && same.has(m.invoiceId)))) dDays = days(tx.purchaseDate);
        else continue;
      } else dDays = days(tx.date);
      if (dDays > 3) continue;
      const mUsd = usd ? usdOf.get(m.id) : undefined;
      let dAmount: number;
      if (mUsd != null) {
        dAmount = Math.abs(mUsd - tx.amount);
        if (dAmount > Math.max(0.01, tx.amount * 0.005)) continue;
      } else {
        const d = diffInPesos(m);
        if (!d || d.dAmount > d.tol) continue;
        dAmount = d.dAmount;
      }
      pairs.push({ i, id: m.id, sim: similarity(tx.key, m.merchant || m.note), dAmount, dDays });
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

// --- Contra el saldo del estado de cuenta ----------------------------------------------------------------

const PREVIOUS_BALANCE = /\bsaldo (?:del (?:estado de cuenta|resumen|mes) )?anterior\b/;
const CLOSING_BALANCE = /\bsaldo (?:contado|actual|al cierre)\b|\bnuevo saldo\b/;

type Balances = Partial<Record<StatementCurrency, number>>;

/**
 * El saldo anterior y el del cierre (el contado) de cada moneda, si los trae con su título. Por orden, no por columna
 * (en Itaú el saldo anterior va corrido): el primer importe sin moneda es en pesos y el segundo en dólares
 */
export function statementBalances(text: string): { previous: Balances; closing: Balances } {
  const out = { previous: {} as Balances, closing: {} as Balances };
  for (const raw of text.split(/\r?\n/)) {
    const line = norm(raw);
    const which = PREVIOUS_BALANCE.test(line) ? out.previous : CLOSING_BALANCE.test(line) ? out.closing : null;
    if (!which || Object.keys(which).length || line.includes('%')) continue;
    const words = splitGlued(line).split(/\s+/);
    const order: StatementCurrency[] = ['local', 'usd'];
    words.forEach((w, k) => {
      const v = tokenAmount(w);
      if (v == null) return;
      const mk = markerOf(words[k - 1] ?? '');
      const cur = mk === 'usd' || mk === 'foreign' ? 'usd' : mk === 'local' ? 'local' : order.find((c) => which[c] == null);
      if (cur && which[cur] == null) which[cur] = v;
    });
  }
  return out;
}

/**
 * Lo que el estado de cuenta cobra (o acredita) sin que aparezca como movimiento: en cada moneda con los dos saldos,
 * el del cierre menos el anterior y todos los movimientos leídos (con los pagos). Positivo: cobra de más
 */
export function balanceGaps(txs: StatementTx[], text: string): { currency: StatementCurrency; amount: number }[] {
  const { previous, closing } = statementBalances(text);
  const out: { currency: StatementCurrency; amount: number }[] = [];
  for (const currency of ['local', 'usd'] as const) {
    if (previous[currency] == null || closing[currency] == null) continue;
    const moved = txs.filter((t) => t.currency === currency && t.kind !== 'saldo' && !t.balance).reduce((s, t) => s + t.amount, 0);
    const amount = round2(closing[currency]! - previous[currency]! - moved);
    if (Math.abs(amount) >= 0.01) out.push({ currency, amount });
  }
  return out;
}

/** Lo que cobra de más que los movimientos, como un cargo para revisar (balanceGaps) */
export function balanceCharge(date: string, currency: StatementCurrency, amount: number): StatementTx {
  const description = 'Diferencia con el saldo del estado de cuenta';
  return { date, description, merchant: 'Diferencia con el saldo', key: 'diferencia con el saldo', amount: round2(amount), currency, kind: 'cargo', balance: true };
}

/** Meses de las compras que ya tienen los totales mensuales de la planilla (sumarlas duplicaría el gasto) */
export function planillaMonths(txs: StatementTx[], movements: Movement[]): string[] {
  const monthly = new Set(movements.filter((m) => m.monthly && m.kind === 'gasto').map((m) => monthOf(m.date)));
  return [...new Set(txs.filter(isSpend).map((t) => monthOf(t.date)))].filter((m) => monthly.has(m)).sort();
}
