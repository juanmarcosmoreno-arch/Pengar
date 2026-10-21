/** Gastos fijos: lo que se repite todos los meses. Cuáles faltan anotar en un mes y cuáles sugerir según el historial. */
import { addMonths, monthOf } from './dates';
import { round2 } from './money';
import { newId } from './template';
import type { Data, Kind, Movement, Recurring } from './types';

export interface PendingRecurring extends Recurring {
  /** Ya llegó su día (o el mes ya pasó) */
  due: boolean;
}

export interface SuggestedRecurring {
  rubroId: string;
  kind: Kind;
  amount: number;
  day: number;
}

/** Variación máxima de los totales mensuales (desvío / promedio) para sugerir un rubro como fijo */
const MAX_VARIATION = 0.35;

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (iso: string) => Number(iso.slice(8, 10));
export const clampDay = (n: number) => Math.min(28, Math.max(1, Math.round(n) || 1));

export const recurringOf = (data: Pick<Data, 'recurring'>, rubroId: string | undefined) =>
  rubroId ? data.recurring.find((r) => r.rubroId === rubroId) : undefined;

/**
 * Los fijos que faltan anotar en `month`: no pausados, de un rubro activo, con `doneThrough` anterior a ese mes y sin ningún movimiento
 * de su rubro en el mes (si ya lo anotaste a mano, con una factura o vino en la planilla, no se pide de nuevo).
 */
export function pendingRecurring(data: Data, month: string, todayISO: string): PendingRecurring[] {
  const current = monthOf(todayISO);
  // Los de un rubro archivado no se piden (al anotarlo no se vería el rubro)
  const rubros = new Set(data.rubros.filter((r) => !r.archived).map((r) => r.id));
  const recorded = new Set(data.movements.filter((m) => monthOf(m.date) === month).map((m) => `${m.rubroId}|${m.kind}`));
  return data.recurring
    .filter((r) => !r.paused && (!r.doneThrough || r.doneThrough < month) && rubros.has(r.rubroId) && !recorded.has(`${r.rubroId}|${r.kind}`))
    .map((r) => ({ ...r, due: month < current || (month === current && r.day <= dayOf(todayISO)) }))
    .sort((a, b) => a.day - b.day || b.amount - a.amount);
}

/** Fecha del movimiento de un fijo en `month`: su día, sin pasar de hoy */
export function recurringDate(r: Pick<Recurring, 'day'>, month: string, todayISO: string): string {
  const date = `${month}-${pad(clampDay(r.day))}`;
  return date > todayISO ? todayISO : date;
}

/**
 * El id del movimiento de un fijo en un mes: siempre el mismo. En un hogar compartido, si dos teléfonos lo anotan
 * antes de recibir lo del otro, escriben el mismo registro (no queda dos veces)
 */
export const recurringMovementId = (recurringId: string, month: string) => `m-${recurringId}-${month}`;

/** Los movimientos de todos los fijos vencidos de `month`, con su monto estimado (y de qué fijo sale cada uno) */
export function dueMovements(data: Data, month: string, todayISO: string, now = Date.now()): { recurringId: string; movement: Movement }[] {
  // Si ya hay uno con ese id (se anotó y después se le cambió el rubro), otro id: nunca dos movimientos con el mismo
  const taken = new Set(data.movements.map((m) => m.id));
  return pendingRecurring(data, month, todayISO)
    .filter((p) => p.due && p.amount > 0)
    .map((p) => ({
      recurringId: p.id,
      movement: {
        id: taken.has(recurringMovementId(p.id, month)) ? newId('m') : recurringMovementId(p.id, month),
        date: recurringDate(p, month, todayISO),
        amount: p.amount,
        kind: p.kind,
        rubroId: p.rubroId,
        note: p.note || undefined,
        origin: 'manual',
        createdAt: now,
      },
    }));
}

/**
 * Rubros que aparecen en al menos 5 de los últimos 6 meses completos y todavía no son fijos.
 * Quedan afuera los que varían mucho de un mes a otro (Farmacia, Varios) y los de todos los días (más de dos
 * movimientos por mes, como el súper anotado compra por compra): esos no se anotan una vez por mes.
 * El monto es el total del mes más reciente con datos; el día, la mediana de los movimientos del día a día
 * (1 si solo hay totales mensuales de la planilla).
 */
export function suggestRecurring(data: Data, todayISO: string): SuggestedRecurring[] {
  const current = monthOf(todayISO);
  const from = addMonths(current, -6);
  const taken = new Set(data.recurring.map((r) => r.rubroId));
  const active = new Set(data.rubros.filter((r) => !r.archived).map((r) => r.id));
  const byRubro = new Map<string, Movement[]>();
  for (const m of data.movements) {
    const month = monthOf(m.date);
    if (month < from || month >= current || m.amount <= 0 || taken.has(m.rubroId) || !active.has(m.rubroId)) continue;
    const list = byRubro.get(m.rubroId) ?? [];
    list.push(m);
    byRubro.set(m.rubroId, list);
  }
  const out: SuggestedRecurring[] = [];
  for (const [rubroId, ms] of byRubro) {
    const totals = new Map<string, number>();
    for (const m of ms) totals.set(monthOf(m.date), (totals.get(monthOf(m.date)) ?? 0) + m.amount);
    if (totals.size < 5 || ms.length / totals.size > 2) continue;
    const values = [...totals.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    if (sd / mean > MAX_VARIATION) continue;
    const last = [...totals.keys()].sort().at(-1)!;
    const latest = ms.reduce((a, b) => (b.date > a.date ? b : a));
    const days = ms.filter((m) => !m.monthly).map((m) => dayOf(m.date)).sort((a, b) => a - b);
    const mid = days.length >> 1;
    const median = !days.length ? 1 : days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
    out.push({ rubroId, kind: latest.kind, amount: round2(totals.get(last)!), day: clampDay(median) });
  }
  return out.sort((a, b) => b.amount - a.amount).slice(0, 20);
}

/** Los meses salteados que se guardan en cada fijo (para el resumen): los últimos dos años */
const KEEP_SKIPPED = 24;

/** «Saltar» un fijo en `month`: queda hecho hasta ese mes y anotado que ese mes se salteó */
export function skipRecurring(r: Recurring, month: string): Recurring {
  const skipped = [...new Set([...(Array.isArray(r.skipped) ? r.skipped : []), month])].sort().slice(-KEEP_SKIPPED);
  return { ...r, doneThrough: !r.doneThrough || r.doneThrough < month ? month : r.doneThrough, skipped };
}

/**
 * ¿Se salteó en `month`? Con la lista de salteados, lo que diga; los fijos de antes (sin lista) solo saben el último
 * mes hecho: si es ese mismo mes y no hay movimiento, se salteó
 */
export const wasSkipped = (r: Recurring, month: string): boolean =>
  Array.isArray(r.skipped) ? r.skipped.includes(month) : r.doneThrough === month;

/** Un fijo nuevo empieza a pedirse desde el mes en curso */
export function newRecurring(fields: Omit<Recurring, 'id' | 'createdAt' | 'doneThrough'> & { doneThrough?: string }, todayISO: string): Recurring {
  return {
    ...fields,
    id: newId('rec'),
    day: clampDay(fields.day),
    doneThrough: fields.doneThrough ?? addMonths(monthOf(todayISO), -1),
    createdAt: Date.now(),
  };
}
