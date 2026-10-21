/**
 * Cotización del dólar del BCU, guardada en el teléfono (clave «fx»): un día que ya pasó no se vuelve a pedir y el de
 * hoy, cada 6 horas. En el iPhone se le pide al BCU con el HTTP nativo de Capacitor (sin CORS); en la web se prueba
 * con fetch y, como el BCU no permite CORS, para hoy queda open.er-api.com. En la vista previa no se pide nada.
 * Nada de esto tira: sin cotización, null.
 */
import { CapacitorHttp } from '@capacitor/core';
import { addDays, today } from '../domain/dates';
import {
  BCU_SOAP_ACTION,
  BCU_URL,
  bcuChunks,
  bcuRequestBody,
  cachedRates,
  emptyFx,
  LOOKBACK_DAYS,
  lookbackStart,
  mergeBcu,
  normalizeFx,
  parseBcuResponse,
  parseErApi,
  pendingDays,
  rateOn,
  TODAY_MAX_AGE,
  type FxCache,
  type UsdRate,
} from '../domain/fx';
import { loadFx, saveFx } from './db';
import { isNative, isPreview } from './platform';

export const ER_API_URL = 'https://open.er-api.com/v6/latest/USD';
const TIMEOUT = 12000;

export interface UsdQuote extends UsdRate {
  /** «bcu»; en la web, si el BCU no responde, «mercado» (open.er-api.com, solo la de hoy) */
  source: 'bcu' | 'mercado';
  /** Cuándo se consultó (ms) */
  at?: number;
}

// En memoria después de la primera lectura; los pedidos van de a uno para no pisar lo guardado
let cache: Promise<FxCache> | null = null;
const load = () => (cache ??= loadFx().then(normalizeFx, emptyFx));
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
async function keep(c: FxCache): Promise<void> {
  cache = Promise.resolve(c);
  await saveFx(c);
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function postBcu(body: string): Promise<string> {
  const headers = { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: BCU_SOAP_ACTION };
  if (isNative) {
    const res = await CapacitorHttp.request({ url: BCU_URL, method: 'POST', headers, data: body, responseType: 'text', connectTimeout: TIMEOUT, readTimeout: TIMEOUT });
    if (res.status < 200 || res.status >= 300) throw new Error(`BCU: HTTP ${res.status}`);
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }
  return withTimeout(async (signal) => {
    const res = await fetch(BCU_URL, { method: 'POST', headers, body, signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`BCU: HTTP ${res.status}`);
    return res.text();
  });
}

// Después de una falla (sin conexión, o CORS en la web) no se insiste por un rato, salvo con «Actualizar»
const RETRY_AFTER = 5 * 60_000;
let downUntil = 0;
// Si el último pedido (al BCU o a open.er-api.com) respondió: para que «Actualizar» sepa si anduvo
let lastAskOk = false;

/** Pide [from, to] al BCU, de a tramos; lo que respondió queda guardado aunque falle un tramo */
async function askBcu(c: FxCache, from: string, to: string): Promise<FxCache> {
  let next = c;
  try {
    for (const [a, b] of bcuChunks(from, to)) next = mergeBcu(next, a, b, parseBcuResponse(await postBcu(bcuRequestBody(a, b))), Date.now());
    downUntil = 0;
    lastAskOk = true;
  } catch (e) {
    downUntil = Date.now() + RETRY_AFTER;
    lastAskOk = false;
    throw e;
  } finally {
    if (next !== c) await keep(next);
  }
  return next;
}

/**
 * Las cotizaciones del BCU de [from, to], desde el último día hábil antes de `from` (para que rateOn ande con un fin
 * de semana): las guardadas y, si falta alguna, se piden. null si no se pudieron tener todas (sin conexión); la de
 * hoy puede faltar (el BCU la publica en el correr del día), entonces vale la del último día hábil.
 */
export function usdRates(from: string, to: string, opts: { force?: boolean } = {}): Promise<UsdRate[] | null> {
  return serial(async () => {
    try {
      let c = await load();
      const start = lookbackStart(c, from, Date.now());
      const pending = pendingDays(c, start, to, Date.now());
      const t = today();
      if (opts.force && to >= t && !pending.includes(t)) pending.push(t);
      if (pending.length && !isPreview && (opts.force || Date.now() >= downUntil)) {
        try {
          c = await askBcu(c, pending[0], pending.at(-1)!);
        } catch (e) {
          console.warn('No se pudo consultar la cotización del BCU', e);
        }
      }
      if (pendingDays(c, start, to, Date.now()).some((d) => d !== t)) return null;
      return cachedRates(c, start, to);
    } catch (e) {
      console.warn('Cotización del dólar', e);
      return null;
    }
  });
}

/** En la web, sin el BCU: la de hoy de open.er-api.com (guardada 6 horas) */
function marketToday(force: boolean): Promise<UsdQuote | null> {
  return serial(async () => {
    try {
      const c = await load();
      const t = today();
      const m = c.market?.date === t ? c.market : undefined;
      const quote = (x: NonNullable<FxCache['market']>): UsdQuote => ({ date: x.date, rate: x.rate, source: 'mercado', at: x.at });
      if (isNative || isPreview || (m && !force && Date.now() - m.at < TODAY_MAX_AGE)) return m ? quote(m) : null;
      try {
        const rate = parseErApi(await withTimeout(async (signal) => (await fetch(ER_API_URL, { signal, credentials: 'omit' })).json()));
        lastAskOk = rate != null;
        if (rate == null) return m ? quote(m) : null;
        const market = { date: t, rate, at: Date.now() };
        await keep({ ...c, market });
        return quote(market);
      } catch (e) {
        lastAskOk = false;
        console.warn('No se pudo consultar open.er-api.com', e);
        return m ? quote(m) : null;
      }
    } catch {
      return null;
    }
  });
}

/** La cotización que vale para una fecha (la de ese día o la del último día hábil anterior), o null */
export async function usdRateOn(date: string, opts: { force?: boolean } = {}): Promise<UsdQuote | null> {
  const t = today();
  const d = date > t ? t : date;
  const rates = await usdRates(d, d, opts);
  const r = rates && rateOn(d, rates);
  if (r) {
    const c = await load();
    return { ...r, source: 'bcu', at: c.asked[d] ?? c.updatedAt };
  }
  return d === t ? marketToday(!!opts.force) : null;
}

/** La de hoy. Con `force`, se vuelve a pedir aunque esté guardada («Actualizar» en Ajustes) */
export const usdRateToday = (opts: { force?: boolean } = {}) => usdRateOn(today(), opts);

/** «Actualizar»: la de hoy pedida de nuevo; `ok` si alguien respondió (si no, la guardada, si hay) */
export async function refreshUsdRate(): Promise<{ quote: UsdQuote | null; ok: boolean }> {
  lastAskOk = false;
  const quote = await usdRateToday({ force: true });
  return { quote, ok: lastAskOk };
}

/** Solo lo guardado, sin pedir nada (para mostrar algo mientras llega la respuesta) */
export async function cachedUsdRateToday(): Promise<UsdQuote | null> {
  try {
    const c = await load();
    const t = today();
    const r = rateOn(t, cachedRates(c, addDays(t, -LOOKBACK_DAYS), t));
    if (r) return { ...r, source: 'bcu', at: c.asked[t] ?? c.updatedAt };
    return c.market?.date === t ? { date: t, rate: c.market.rate, source: 'mercado', at: c.market.at } : null;
  } catch {
    return null;
  }
}
