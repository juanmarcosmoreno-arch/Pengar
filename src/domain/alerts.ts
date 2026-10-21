import { addDays, addMonths, monthOf } from './dates';
import { cardName, closingOf, sameCard } from './installments';
import { round2 } from './money';
import { pendingRecurring } from './recurring';
import type { Index } from './stats';
import type { Data, Invoice, Kind } from './types';

const dayOf = (iso: string) => Number(iso.slice(8, 10));
const daysIn = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();

/** Lo anotado en un rubro en cada uno de los `n` meses antes de `month` que tienen algo (para los fijos que varían) */
export function recentMonths(data: Data, rubroId: string, kind: Kind, month: string, n = 3): number[] {
  const by = new Map<string, number>();
  for (const m of data.movements) {
    if (m.rubroId !== rubroId || m.kind !== kind) continue;
    const k = monthOf(m.date);
    if (k >= month || k < addMonths(month, -n)) continue;
    by.set(k, (by.get(k) ?? 0) + m.amount);
  }
  return [...by.values()];
}

/** El promedio de esos meses (null si hay menos de 2) */
export function recentAverage(data: Data, rubroId: string, kind: Kind, month: string): number | null {
  const v = recentMonths(data, rubroId, kind, month);
  return v.length >= 2 ? round2(v.reduce((s, x) => s + x, 0) / v.length) : null;
}

/**
 * Un fijo cuyo monto cambia de un mes a otro (UTE, OSE, Antel): el promedio de los últimos meses; si siempre fue
 * igual, su monto
 */
export function estimateRecurring(data: Data, r: { rubroId: string; kind: Kind; amount: number }, month: string): number {
  const v = recentMonths(data, r.rubroId, r.kind, month);
  if (v.length < 2 || v.every((x) => Math.abs(x - v[0]) < 1)) return r.amount;
  return Math.round(v.reduce((s, x) => s + x, 0) / v.length);
}

/** «UTE vino 40 % más alta que el promedio»: si un gasto de un fijo pasa en más de 25 % el promedio de antes */
export function aboveAverage(data: Data, rubroId: string, amount: number, date: string): { average: number; pct: number } | null {
  if (!data.recurring.some((r) => r.rubroId === rubroId && r.kind === 'gasto')) return null;
  const average = recentAverage(data, rubroId, 'gasto', monthOf(date));
  if (!average || amount <= average * 1.25) return null;
  return { average, pct: amount / average - 1 };
}

export interface Forecast {
  /** Lo que quedaría a fin de mes si seguís gastando al mismo ritmo (negativo: no llegás) */
  end: number;
  /** Lo del día a día gastado hasta hoy y lo que sería a fin de mes */
  daily: number;
  dailyEnd: number;
  /** Fijos que faltan anotar */
  pendingFixed: number;
}

/**
 * A fin de mes: lo que entró (y los ingresos fijos que faltan) menos lo ya anotado, los fijos que faltan y el día a
 * día al ritmo de hoy. El día a día es lo que no es de un fijo, ni de la tarjeta, ni un total de la planilla
 */
export function monthForecast(data: Data, ix: Index, todayISO: string): Forecast {
  const month = monthOf(todayISO);
  const fixed = new Set(data.recurring.map((r) => r.rubroId));
  let income = 0;
  let spent = 0;
  let daily = 0;
  for (const m of data.movements) {
    if (monthOf(m.date) !== month) continue;
    if (m.kind === 'ingreso') { income += m.amount; continue; }
    if (ix.categoryOf(m)?.savings) continue;
    spent += m.amount;
    if (!fixed.has(m.rubroId) && m.origin !== 'tarjeta' && !m.monthly && m.date <= todayISO) daily += m.amount;
  }
  const pending = pendingRecurring(data, month, todayISO);
  const pendingFixed = pending.filter((r) => r.kind === 'gasto').reduce((s, r) => s + r.amount, 0);
  const pendingIncome = pending.filter((r) => r.kind === 'ingreso').reduce((s, r) => s + r.amount, 0);
  const dailyEnd = (daily / dayOf(todayISO)) * daysIn(month);
  const end = income + pendingIncome - spent - pendingFixed - (dailyEnd - daily);
  return { end: round2(end), daily: round2(daily), dailyEnd: round2(dailyEnd), pendingFixed: round2(pendingFixed) };
}

export interface CardReminder {
  kind: 'subir' | 'pagar';
  card: string;
  /** El estado de cuenta (para «Ya pagué») */
  invoice: Invoice;
  /** Cierre que se espera (subir) o vencimiento (pagar) */
  date: string;
}

/**
 * Por cada tarjeta, con su último estado de cuenta: si ya pasó el cierre siguiente (un mes después del último),
 * «subí el estado de cuenta» (hasta 20 días después); si vence en los próximos 5 días (o hoy) y no se marcó pagado,
 * «no te olvides de pagar»
 */
export function cardReminders(invoices: Invoice[], todayISO: string): CardReminder[] {
  const latest: Invoice[] = [];
  for (const inv of invoices.filter((i) => i.kind === 'estado').sort((a, b) => closingOf(b).localeCompare(closingOf(a)))) {
    if (!latest.some((l) => sameCard(l.card, inv.card))) latest.push(inv);
  }
  const out: CardReminder[] = [];
  for (const inv of latest) {
    const closing = closingOf(inv);
    const next = `${addMonths(monthOf(closing), 1)}-${String(Math.min(dayOf(closing), daysIn(addMonths(monthOf(closing), 1)))).padStart(2, '0')}`;
    if (todayISO > next && todayISO <= addDays(next, 20)) out.push({ kind: 'subir', card: cardName(inv), invoice: inv, date: next });
    if (inv.due && !inv.paid && todayISO >= addDays(inv.due, -5) && todayISO <= inv.due) out.push({ kind: 'pagar', card: cardName(inv), invoice: inv, date: inv.due });
  }
  return out;
}
