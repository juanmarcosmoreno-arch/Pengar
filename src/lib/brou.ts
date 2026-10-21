/** Las cotizaciones del BROU: solo en el iPhone (la página no deja leerla desde la web). Se guardan media hora */
import { CapacitorHttp } from '@capacitor/core';
import { parseBrou, type BrouRates } from '../domain/brou';
import { isNative, isPreview } from './platform';

const URL = 'https://www.brou.com.uy/cotizaciones';
let last: { at: number; rates: BrouRates } | null = null;

export async function brouRates(force = false): Promise<BrouRates | null> {
  if (!isNative || isPreview) return null;
  if (!force && last && Date.now() - last.at < 30 * 60_000) return last.rates;
  try {
    const res = await CapacitorHttp.request({ url: URL, method: 'GET', responseType: 'text', connectTimeout: 10_000, readTimeout: 10_000 });
    if (res.status < 200 || res.status >= 300) return last?.rates ?? null;
    const rates = parseBrou(typeof res.data === 'string' ? res.data : String(res.data ?? ''));
    if (rates) last = { at: Date.now(), rates };
    return rates ?? last?.rates ?? null;
  } catch {
    return last?.rates ?? null;
  }
}
