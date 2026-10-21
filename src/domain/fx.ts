/**
 * Cotización del dólar del Banco Central del Uruguay (BCU): armar el pedido al web service, leer la respuesta, la
 * caché del teléfono y la cotización de cada fecha. Lo que va a la red está en lib/fx.ts.
 */
import { addDays, toISODate } from './dates';
import { NBSP, parseAmount, parseDecimal, round2 } from './money';

export interface UsdRate {
  /** YYYY-MM-DD */
  date: string;
  /** Pesos por dólar */
  rate: number;
}

export const BCU_URL = 'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones';
export const BCU_SOAP_ACTION = '"Cotizaactionaction/AWSBCUCOTIZACIONES.Execute"';
/** Código del BCU para «DLS. USA BILLETE» */
export const BCU_USD = 2225;
/** El BCU rechaza los rangos de más de un año («Rango de fechas excede lo permitido»): se pide de a tramos */
export const BCU_MAX_DAYS = 180;
/** Días de antes que se piden de más: un fin de semana o un feriado usa el último día hábil (Turismo es una semana) */
export const LOOKBACK_DAYS = 14;
/** La de hoy se vuelve a pedir pasadas 6 horas: el BCU la publica en el correr del día */
export const TODAY_MAX_AGE = 6 * 3600_000;

/** La cotización que se acepta: un número fuera de esto es un error de tipeo (o no es pesos por dólar) */
export const validUsdRate = (v: number) => v > 10 && v < 200;

/** Cuerpo SOAP del pedido de cotizaciones entre dos fechas (YYYY-MM-DD), del dólar billete */
export function bcuRequestBody(from: string, to: string, currency = BCU_USD): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cot="Cotiza"><soapenv:Body>'
    + '<cot:wsbcucotizaciones.Execute><cot:Entrada>'
    + `<cot:Moneda><cot:item>${currency}</cot:item></cot:Moneda><cot:FechaDesde>${from}</cot:FechaDesde><cot:FechaHasta>${to}</cot:FechaHasta>`
    + '<cot:Grupo>0</cot:Grupo></cot:Entrada></cot:wsbcucotizaciones.Execute></soapenv:Body></soapenv:Envelope>';
}

/** El texto de la primera etiqueta `name` (con o sin prefijo de espacio de nombres) */
const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:[\\w.-]+:)?${name.replace('.', '\\.')}\\b[^>]*?(?:/>|>([^<]*)<)`))?.[1]?.trim() ?? '';

/**
 * Lee la respuesta del BCU: una cotización por día hábil, ordenadas por fecha (los fines de semana y feriados no
 * vienen). La cotización es la de vendedor (TCV); si la de comprador (TCC) es otra, el promedio de las dos (en el
 * dólar billete el BCU publica una sola y las dos son iguales). «No existe cotización» (un rango sin días hábiles)
 * es una lista vacía; cualquier otro error, o algo que no es una respuesta del BCU, tira.
 * Con expresiones regulares y no DOMParser: anda igual en el teléfono y en las pruebas (Node).
 */
export function parseBcuResponse(xml: string, currency = BCU_USD): UsdRate[] {
  const status = xml.match(/<(?:[\w.-]+:)?respuestastatus\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?respuestastatus>/)?.[1];
  if (status == null) throw new Error('No es una respuesta del BCU');
  if (tag(status, 'status') !== '1') {
    if (tag(status, 'codigoerror') === '100') return [];
    throw new Error(`BCU: ${tag(status, 'mensaje') || `error ${tag(status, 'codigoerror')}`}`);
  }
  const out = new Map<string, number>();
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?datoscotizaciones\.dato\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?datoscotizaciones\.dato>/g)) {
    const item = m[1];
    const date = tag(item, 'Fecha').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(tag(item, 'Moneda')) !== currency) continue;
    const tcc = Number(tag(item, 'TCC'));
    const tcv = Number(tag(item, 'TCV'));
    const rate = tcc > 0 && tcv > 0 && tcc !== tcv ? Math.round(((tcc + tcv) / 2) * 10000) / 10000 : tcv > 0 ? tcv : tcc;
    if (Number.isFinite(rate) && rate > 0) out.set(date, rate);
  }
  return [...out].map(([date, rate]) => ({ date, rate })).sort((a, b) => a.date.localeCompare(b.date));
}

/** De open.er-api.com/v6/latest/USD: los pesos uruguayos por dólar de hoy, o null */
export function parseErApi(json: unknown): number | null {
  const j = json as { result?: string; rates?: Record<string, unknown> } | null;
  const v = j?.result === 'success' ? Number(j.rates?.UYU) : NaN;
  return Number.isFinite(v) && validUsdRate(v) ? round2(v) : null;
}

/** La cotización que vale para una fecha: la de ese día o la del último día hábil anterior (null si no hay) */
export function rateOn(date: string, rates: UsdRate[]): UsdRate | null {
  let best: UsdRate | null = null;
  for (const r of rates) if (r.date <= date && (!best || r.date > best.date)) best = r;
  return best;
}

/** [from, to] partido en tramos que el BCU acepta */
export function bcuChunks(from: string, to: string, maxDays = BCU_MAX_DAYS): [string, string][] {
  const out: [string, string][] = [];
  for (let a = from; a <= to; a = addDays(a, maxDays)) {
    const b = addDays(a, maxDays - 1);
    out.push([a, b < to ? b : to]);
  }
  return out;
}

const daysBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

// --- Caché -----------------------------------------------------------------------------------------------

/** Lo que queda guardado en el teléfono (clave «fx»): las cotizaciones no cambian, así que no se piden dos veces */
export interface FxCache {
  /** Fecha → cotización del BCU (solo los días hábiles) */
  rates: Record<string, number>;
  /** Fecha → cuándo se le preguntó al BCU por ese día (ms), haya tenido cotización o no */
  asked: Record<string, number>;
  /** Cuándo respondió el BCU la última vez (ms) */
  updatedAt?: number;
  /** En la web, si el BCU no deja (CORS): la de hoy de open.er-api.com */
  market?: { date: string; rate: number; at: number };
}

export const emptyFx = (): FxCache => ({ rates: {}, asked: {} });

/** Lo leído de IndexedDB, sano (si es de otra versión o está roto, vacío) */
export function normalizeFx(raw: unknown): FxCache {
  const c = raw as Partial<FxCache> | null | undefined;
  const nums = (o: unknown, ok: (v: number) => boolean) => Object.fromEntries(
    Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && ok(v)),
  ) as Record<string, number>;
  const m = c?.market;
  return {
    rates: nums(c?.rates, validUsdRate),
    asked: nums(c?.asked, (v) => v > 0),
    ...(typeof c?.updatedAt === 'number' ? { updatedAt: c.updatedAt } : {}),
    ...(m && typeof m.date === 'string' && validUsdRate(m.rate) && typeof m.at === 'number' ? { market: { date: m.date, rate: m.rate, at: m.at } } : {}),
  };
}

/**
 * ¿Ya se sabe la cotización de ese día? Un día que se preguntó después de terminado no se vuelve a pedir nunca;
 * el de hoy (que el BCU puede no haber publicado todavía), por 6 horas.
 */
export function knownDay(cache: FxCache, date: string, now: number): boolean {
  const at = cache.asked[date];
  if (at == null) return false;
  const askedOn = toISODate(new Date(at));
  if (askedOn > date) return true;
  return askedOn === date && toISODate(new Date(now)) === date && now - at < TODAY_MAX_AGE;
}

/** Los días de [from, to] (hasta hoy: del futuro no hay) que hay que pedirle al BCU */
export function pendingDays(cache: FxCache, from: string, to: string, now: number): string[] {
  const todayISO = toISODate(new Date(now));
  return daysBetween(from, to < todayISO ? to : todayISO).filter((d) => !knownDay(cache, d, now));
}

/**
 * Desde qué día hace falta saber para usar rateOn desde `from`: el último día con cotización ya guardada (hasta
 * `from`) o, si no hay, 14 días antes (para tener el último día hábil aunque `from` caiga en fin de semana)
 */
export function lookbackStart(cache: FxCache, from: string, now: number): string {
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = addDays(from, -i);
    if (cache.rates[d] != null && knownDay(cache, d, now)) return d;
  }
  return addDays(from, -LOOKBACK_DAYS);
}

/** Suma lo que respondió el BCU por [from, to]: las cotizaciones y que esos días ya se preguntaron */
export function mergeBcu(cache: FxCache, from: string, to: string, rates: UsdRate[], now: number): FxCache {
  const todayISO = toISODate(new Date(now));
  const asked = { ...cache.asked };
  for (const d of daysBetween(from, to < todayISO ? to : todayISO)) asked[d] = now;
  const next = { ...cache.rates };
  for (const r of rates) if (validUsdRate(r.rate)) next[r.date] = r.rate;
  return { ...cache, rates: next, asked, updatedAt: now };
}

/** Las cotizaciones guardadas entre dos fechas, ordenadas */
export function cachedRates(cache: FxCache, from: string, to: string): UsdRate[] {
  return Object.entries(cache.rates)
    .filter(([d]) => d >= from && d <= to)
    .map(([date, rate]) => ({ date, rate }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- Para mostrar ----------------------------------------------------------------------------------------

const rateFormat = new Intl.NumberFormat('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const usdFormat = new Intl.NumberFormat('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «40,10», «40,236» (el BCU publica tres decimales) */
export const formatRate = (n: number) => rateFormat.format(n);

/** «U$S 12,99» */
export const usd = (n: number) => `U$S${NBSP}${usdFormat.format(n)}`;

/** ¿La moneda de la app ya es el dólar? (entonces no hay nada que pasar a pesos) */
export const isUsdSymbol = (symbol: string) => /^(u\$s|us\$|u\$d|usd)$/i.test(symbol.replace(/\s/g, ''));

/** Nota de un gasto anotado en dólares: «U$S 20 × 40,10» (sin decimales si son centavos cero) */
export function usdNote(amount: number, rate: number): string {
  return `U$S${NBSP}${Number.isInteger(amount) ? amount : usdFormat.format(amount)} × ${formatRate(rate)}`;
}

const USD_NOTE = /(?:^|\s·\s)U\$S\s?([\d.,]+) × ([\d.,]+)$/;

/** Separa la cuenta en dólares del final de una nota («Almuerzo · U$S 20 × 40,10» → «Almuerzo», 20, 40,1) */
export function splitUsdNote(note: string | undefined): { rest: string; usd?: number; rate?: number } {
  const m = note?.match(USD_NOTE);
  const amount = m ? parseAmount(m[1]) : null;
  const rate = m ? parseDecimal(m[2]) : null;
  if (!m || amount == null || amount <= 0 || rate == null || !validUsdRate(rate)) return { rest: note ?? '' };
  return { rest: note!.slice(0, m.index).trim(), usd: amount, rate };
}

/** La nota con la cuenta en dólares al final (la de antes, si había, se reemplaza) */
export function withUsdNote(note: string, amount: number, rate: number): string {
  const rest = splitUsdNote(note.trim()).rest;
  return [rest, usdNote(amount, rate)].filter(Boolean).join(' · ');
}
