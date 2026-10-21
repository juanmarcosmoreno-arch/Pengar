/**
 * Cuotas de la tarjeta: cuánto queda comprometido para los meses que vienen y si hay margen para comprar. Puro: lo
 * usan las pantallas.
 *
 * - De cada tarjeta cuenta su último estado de cuenta (por fecha de cierre y, con el mismo cierre, el último que se
 *   subió): cada cuota n de N con n < N sigue N − n meses más, una por estado de cuenta (mes de cierre + 1, + 2…).
 * - Los meses son los del cierre del estado de cuenta: la cuota se anota como gasto con esa fecha.
 * - Los estados de cuenta guardados antes no tienen `installments`: salen de sus gastos con «cuota n/N» en la nota.
 * - Los montos son en pesos (las en dólares, con la cotización con que se guardaron).
 */
import { addDays, addMonths, monthOf, monthRange, shiftMonths, toISODate } from './dates';
import { splitUsdNote } from './fx';
import { norm } from './importSheet';
import { round2 } from './money';
import { normalizeMerchant } from './statement';
import { buildIndex } from './stats';
import type { Data, Invoice, InvoiceInstallment, Movement } from './types';

/** Largo máximo del nombre de una tarjeta que se escribe (entra en un botón a 320 px) */
export const CARD_NAME_MAX = 30;

/** Nombre de la tarjeta de un estado de cuenta (sin nombre, «Tarjeta») */
export const cardName = (inv: Pick<Invoice, 'card'>) => inv.card?.trim() || 'Tarjeta';
const cardKey = (name: string) => norm(name);

const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const sum = (list: number[]) => round2(list.reduce((s, v) => s + v, 0));

/** Fecha de cierre de un estado de cuenta guardado (sin fecha, el día en que se subió) */
export const closingOf = (inv: Pick<Invoice, 'date' | 'createdAt'>) => (isIso(inv.date) ? inv.date : toISODate(new Date(inv.createdAt)));

/** «cuota 7/9» y, si la cuota va con la fecha del cierre, «compra del 3/3/2026» (statementNote) */
export function noteInstallment(note: string | undefined): { n: number; of: number; date?: string } | null {
  const m = note?.match(/\bcuota (\d+)\/(\d+)\b/);
  if (!m || +m[1] < 1 || +m[2] < 2 || +m[1] > +m[2]) return null;
  const d = note!.match(/\bcompra del (\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const date = d ? `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : undefined;
  return { n: +m[1], of: +m[2], ...(date && isIso(date) ? { date } : {}) };
}

/** Una cuota guardada que sirve; las rotas (o de una versión que esta no entiende) se ignoran */
function validInstallment(x: unknown, fallbackDate: string): InvoiceInstallment | null {
  if (!x || typeof x !== 'object') return null;
  const it = x as Record<string, unknown>;
  const { n, of } = it;
  if (!isPositive(it.amount) || !Number.isInteger(n) || !Number.isInteger(of)) return null;
  if ((n as number) < 1 || (of as number) < 2 || (n as number) > (of as number)) return null;
  const merchant = typeof it.merchant === 'string' && it.merchant.trim() ? it.merchant.trim() : 'Compra';
  return {
    merchant,
    key: typeof it.key === 'string' && it.key ? it.key : normalizeMerchant(merchant).key,
    amount: it.amount,
    n: n as number,
    of: of as number,
    date: isIso(it.date) ? it.date : fallbackDate,
    ...(isPositive(it.usd) ? { usd: it.usd } : {}),
    ...(isPositive(it.rate) ? { rate: it.rate } : {}),
  };
}

/** Lo que se cobra por cuota, para reconocer la misma compra: en dólares, los dólares (la cotización cambia) */
const cuotaAmount = (it: InvoiceInstallment) => (it.usd != null ? `u${it.usd}` : String(round2(it.amount)));

/**
 * De una misma compra que aparece varias veces (una planilla exportada con varios meses trae la 1/6, la 2/6 y la 3/6),
 * la de n más alto. Es la misma compra si coinciden el comercio, la cantidad de cuotas y el monto, y la fecha (los
 * bancos que repiten la de la compra) o el mes de la primera cuota según la fecha de cada una (los que fechan cada
 * cuota en su mes). Dos compras iguales con la misma cuota (dos veces 2/6) son dos compras
 */
export function latestCuotas(list: InvoiceInstallment[]): InvoiceInstallment[] {
  const firstMonth = (it: InvoiceInstallment) => addMonths(monthOf(it.date), 1 - it.n);
  const same = (a: InvoiceInstallment, b: InvoiceInstallment) =>
    a.n !== b.n && a.key === b.key && a.of === b.of && cuotaAmount(a) === cuotaAmount(b) && (a.date === b.date || firstMonth(a) === firstMonth(b));
  return list.filter((a) => !list.some((b) => same(a, b) && b.n > a.n));
}

/**
 * Las compras en cuotas de un estado de cuenta guardado: las que se guardaron con él o, si es de antes (sin
 * `installments`), las de sus gastos con «cuota n/N» en la nota. De los gastos, el monto es el guardado (si se le
 * restó un crédito, ya va restado) y quedan afuera las cuotas que no se guardaron (repetidos, meses de la planilla).
 * Cada compra una sola vez (latestCuotas).
 */
export function invoiceInstallments(inv: Invoice, movements: Movement[]): InvoiceInstallment[] {
  const closing = closingOf(inv);
  if (Array.isArray(inv.installments)) return latestCuotas(inv.installments.map((x) => validInstallment(x, closing)).filter((x): x is InvoiceInstallment => !!x));
  const out: InvoiceInstallment[] = [];
  for (const m of movements) {
    if (m.invoiceId !== inv.id || m.kind !== 'gasto' || !isPositive(m.amount)) continue;
    const c = noteInstallment(m.note);
    if (!c) continue;
    const merchant = m.merchant?.trim() || 'Compra';
    const { usd, rate } = splitUsdNote(m.note);
    out.push({
      merchant,
      key: normalizeMerchant(merchant).key,
      amount: m.amount,
      n: c.n,
      of: c.of,
      date: c.date ?? m.date,
      ...(usd && rate ? { usd, rate } : {}),
    });
  }
  return latestCuotas(out);
}

const newer = (a: Invoice, b: Invoice) => closingOf(a) > closingOf(b) || (closingOf(a) === closingOf(b) && a.createdAt > b.createdAt);

/** El último estado de cuenta de cada tarjeta */
export function latestStatements(invoices: Invoice[]): Invoice[] {
  const best = new Map<string, Invoice>();
  for (const inv of invoices) {
    if (inv.kind !== 'estado') continue;
    const k = cardKey(cardName(inv));
    const prev = best.get(k);
    if (!prev || newer(inv, prev)) best.set(k, inv);
  }
  return [...best.values()];
}

/**
 * Las tarjetas de los estados de cuenta guardados, con nombre: la del último cierre primero. Las ofrece la revisión
 * cuando no reconoce la tarjeta (así el mismo nombre junta los meses)
 */
export function knownCards(invoices: Invoice[]): string[] {
  return latestStatements(invoices)
    .filter((inv) => inv.card?.trim())
    .sort((a, b) => (newer(a, b) ? -1 : 1))
    .map(cardName);
}

/**
 * Las tarjetas en el orden en que se subió su primer estado de cuenta: el color de cada una en las gráficas (una
 * tarjeta nueva no le cambia el color a las demás)
 */
export function cardOrder(invoices: Invoice[]): string[] {
  const first = new Map<string, { name: string; at: number }>();
  for (const inv of invoices) {
    if (inv.kind !== 'estado') continue;
    const k = cardKey(cardName(inv));
    if (!first.has(k) || inv.createdAt < first.get(k)!.at) first.set(k, { name: cardName(inv), at: inv.createdAt });
  }
  return [...first.values()].sort((a, b) => a.at - b.at).map((x) => x.name);
}

/** El mismo nombre de tarjeta (sin importar mayúsculas, tildes ni espacios) */
export const sameCard = (a: string | undefined, b: string | undefined) => cardKey(a?.trim() || 'Tarjeta') === cardKey(b?.trim() || 'Tarjeta');

/**
 * El nombre que se le puso la última vez a la tarjeta que se leyó (`read`, el `readCard` de los guardados): el mes
 * que viene se propone el mismo, así no quedan dos tarjetas («Scotiabank» y «Scotia Visa») con las mismas cuotas
 */
export function chosenCard(invoices: Invoice[], read: string | undefined): string | undefined {
  if (!read?.trim()) return undefined;
  const last = invoices.filter((i) => i.kind === 'estado' && i.readCard?.trim() && sameCard(i.readCard, read)).sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  return last?.card?.trim() || undefined;
}

const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400_000;

/**
 * Un estado de cuenta guardado con el mismo nombre de tarjeta que no puede ser de la misma: cierra el mismo mes otro
 * día, o a menos de 20 días (dos cierres de una tarjeta van a 28 a 33 días). Es otra tarjeta con el mismo nombre (la
 * Visa y la Master del mismo banco) y una taparía las cuotas de la otra. El mismo cierre es el mismo estado de cuenta
 */
export function sameNameOtherCard(invoices: Invoice[], card: string | undefined, closing: string): Invoice | undefined {
  return invoices
    .filter((i) => i.kind === 'estado' && sameCard(i.card, card) && closingOf(i) !== closing)
    .find((i) => monthOf(closingOf(i)) === monthOf(closing) || Math.abs(dayNumber(closingOf(i)) - dayNumber(closing)) < 20);
}

/**
 * Otro nombre para la tarjeta de un estado de cuenta guardado (sin nombre: «Tarjeta»), también al comienzo de la nota
 * de sus gastos: así se arregla una tarjeta con dos nombres o dos tarjetas con el mismo
 */
export function renameCardOf(data: Data, id: string, name: string): Data {
  const inv = data.invoices.find((i) => i.id === id && i.kind === 'estado');
  if (!inv) return data;
  const next = name.trim() || undefined;
  const old = inv.card?.trim() || undefined;
  const note = (n: string | undefined) => {
    let rest = n;
    if (old) {
      if (n === old) rest = undefined;
      else if (n?.startsWith(`${old} · `)) rest = n.slice(old.length + 3);
      // Una nota que ya no empieza con la tarjeta (se cambió a mano) queda como está
      else return n;
    }
    return [next, rest].filter(Boolean).join(' · ') || undefined;
  };
  const { card: _old, ...plain } = inv;
  return {
    ...data,
    invoices: data.invoices.map((i) => (i.id === id ? { ...plain, ...(next ? { card: next } : {}) } : i)),
    movements: data.movements.map((m) => {
      if (m.invoiceId !== id) return m;
      const { note: prev, ...rest } = m;
      const nn = note(prev);
      return nn ? { ...rest, note: nn } : rest;
    }),
  };
}

/** Ya hay un estado de cuenta guardado sin nombre de tarjeta (otro sin nombre se juntaría con él) */
export const hasUnnamedStatement = (invoices: Invoice[]) => invoices.some((i) => i.kind === 'estado' && !i.card?.trim());

/** Días después del cierre siguiente en los que el estado de cuenta nuevo ya tendría que estar (el PDF tarda unos días) */
const STALE_GRACE_DAYS = 10;

/** Desactualizada: ya cerró el estado de cuenta siguiente (y pasaron unos días) y no se subió */
export const isStale = (closing: string, today: string) => addDays(shiftMonths(closing, 1), STALE_GRACE_DAYS) < today;

/** Meses en los que una tarjeta sin cuotas por delante todavía pide su estado de cuenta (después, ya no se usa) */
const STALE_MONTHS = 3;

/**
 * El estado de cuenta que falta subir de una tarjeta desactualizada (YYYY-MM): el último que ya cerró, que es el que
 * trae las cuotas al día. null si no está desactualizada
 */
export function missingStatement(closing: string, today: string): string | null {
  if (!isStale(closing, today)) return null;
  let k = 1;
  while (shiftMonths(closing, k + 1) <= today) k++;
  return monthOf(shiftMonths(closing, k));
}

export interface InstallmentPlan extends InvoiceInstallment {
  card: string;
  /** Los meses (YYYY-MM, de cierre) en los que todavía viene una cuota, sin los que ya pasaron */
  months: string[];
  /** Lo que falta pagar: una cuota por cada mes de `months` */
  left: number;
  /** El mes de la última cuota */
  ends: string;
}

export interface CardInstallments {
  card: string;
  /** El estado de cuenta del que salen (el último de la tarjeta) */
  invoiceId: string;
  closing: string;
  /**
   * Falta el estado de cuenta siguiente: lo de los meses que ya pasaron no cuenta. Solo si tiene cuotas por delante
   * o el último cierre es de los últimos 3 meses (una tarjeta que ya no se usa no lo pide para siempre)
   */
  stale: boolean;
  limit?: number;
  available?: number;
  /** Las compras con cuotas por delante, de la que termina antes a la que termina después */
  plans: InstallmentPlan[];
  /** Lo comprometido en cada mes de la ventana (en el orden de `months`) */
  byMonth: number[];
  /** Todo lo que falta pagar (también después de la ventana) */
  left: number;
}

export interface Commitments {
  /** Los meses de la ventana (YYYY-MM) */
  months: string[];
  /** Una por tarjeta, por nombre */
  cards: CardInstallments[];
  /** Lo comprometido en cada mes, sumando las tarjetas */
  total: number[];
}

export interface WindowOptions {
  /** Hoy (YYYY-MM-DD) */
  today: string;
  /** Primer mes de la ventana (YYYY-MM): el de hoy si no se dice. Los de antes ya pasaron y no cuentan */
  from?: string;
  /** Cuántos meses (12) */
  months?: number;
}

/**
 * La misma compra en estados de cuenta de distintos meses: el comercio, la cantidad de cuotas, el monto y el mes de la
 * primera cuota (el del cierre menos las que ya vinieron, igual todos los meses; la fecha guardada no sirve: en los
 * guardados antes o en los bancos que fechan cada cuota en su mes, cambia)
 */
const purchaseKey = (it: InvoiceInstallment, closing: string) => [it.key, it.of, cuotaAmount(it), addMonths(monthOf(closing), 1 - it.n)].join('|');

/**
 * Lo que ya está comprometido en cuotas, mes a mes y por tarjeta. Cada compra cuenta una sola vez: si sigue en el
 * estado de cuenta más nuevo de otra tarjeta (la misma con otro nombre: renombrada, primero sin nombre o leída
 * distinto), cuenta en ese; una tarjeta cuyas compras siguen todas en otra es esa otra, y no aparece
 */
export function commitments(data: Pick<Data, 'invoices' | 'movements'>, opts: WindowOptions): Commitments {
  const from = opts.from ?? monthOf(opts.today);
  const months = monthRange(from, addMonths(from, Math.max(1, opts.months ?? 12) - 1));
  const lists = latestStatements(data.invoices).map((inv) => ({ inv, list: invoiceInstallments(inv, data.movements) }));
  const owner = new Map<string, Invoice>();
  for (const { inv, list } of lists) {
    for (const it of list) {
      const key = purchaseKey(it, closingOf(inv));
      const prev = owner.get(key);
      if (!prev || newer(inv, prev)) owner.set(key, inv);
    }
  }
  const cards = lists.flatMap(({ inv, list }): CardInstallments[] => {
    const own = list.filter((it) => owner.get(purchaseKey(it, closingOf(inv))) === inv);
    if (list.length && !own.length) return [];
    const card = cardName(inv);
    const closing = closingOf(inv);
    const base = monthOf(closing);
    const plans = own
      .flatMap((it): InstallmentPlan[] => {
        const ends = addMonths(base, it.of - it.n);
        const left = it.n < it.of ? monthRange(addMonths(base, 1), ends).filter((m) => m >= from) : [];
        return left.length ? [{ ...it, card, months: left, left: round2(it.amount * left.length), ends }] : [];
      })
      .sort((a, b) => a.ends.localeCompare(b.ends) || b.amount - a.amount);
    // Con cuotas que llegan a este mes (aunque la ventana empiece después)
    const ahead = own.some((it) => it.n < it.of && addMonths(base, it.of - it.n) >= monthOf(opts.today));
    return [{
      card,
      invoiceId: inv.id,
      closing,
      stale: isStale(closing, opts.today) && (ahead || closing >= shiftMonths(opts.today, -STALE_MONTHS)),
      ...(isPositive(inv.limit) ? { limit: inv.limit } : {}),
      ...(typeof inv.available === 'number' && Number.isFinite(inv.available) ? { available: inv.available } : {}),
      plans,
      byMonth: months.map((m) => sum(plans.filter((p) => p.months.includes(m)).map((p) => p.amount))),
      left: sum(plans.map((p) => p.left)),
    }];
  }).sort((a, b) => a.card.localeCompare(b.card, 'es'));
  return { months, cards, total: months.map((_, k) => sum(cards.map((c) => c.byMonth[k]))) };
}

/**
 * Lo que deja comprometido un estado de cuenta que todavía se está revisando (sus cuotas y su cierre), como si fuera
 * el último de su tarjeta: mes a mes desde el de hoy
 */
export function statementCommitments(installments: InvoiceInstallment[], closing: string, opts: WindowOptions): { months: string[]; total: number[]; plans: InstallmentPlan[]; left: number } {
  const draft: Invoice = { id: 'borrador', kind: 'estado', fileName: '', mime: '', date: closing, items: [], installments, createdAt: 0 };
  const c = commitments({ invoices: [draft], movements: [] }, opts);
  return { months: c.months, total: c.total, plans: c.cards[0].plans, left: c.cards[0].left };
}

/**
 * El mes del próximo estado de cuenta de una tarjeta (YYYY-MM, el del cierre siguiente al último que se subió) o, si
 * ese ya pasó (desactualizada), el de hoy
 */
export function nextStatementMonth(closing: string, today: string): string {
  const next = addMonths(monthOf(closing), 1);
  return next < monthOf(today) ? monthOf(today) : next;
}

// --- El mes que viene ------------------------------------------------------------------------------------

export interface Outlook {
  /** El mes que viene (YYYY-MM) */
  month: string;
  /**
   * Lo que se espera que entre: los ingresos fijos activos o, si no hay, el promedio de los ingresos de los últimos
   * 3 meses completos con datos (`months`; el primer mes de todos, solo si empieza en los primeros días). null si no
   * hay con qué estimarlo
   */
  income: { amount: number; from: 'fijos' | 'promedio'; months?: number } | null;
  /** Los gastos fijos activos (su monto estimado) */
  fixed: number;
  /** Las cuotas ya comprometidas para ese mes */
  installments: number;
  /** income − fixed − installments (null sin ingresos) */
  free: number | null;
  /**
   * El resto de los gastos de un mes habitual: el promedio de los últimos 3 meses completos con datos, sin las cuotas
   * que siguen de compras anteriores (ya están en `installments`) ni lo de los gastos fijos (ya está en `fixed`).
   * null sin meses con datos
   */
  usual: { amount: number; months: number } | null;
  /** free − usual: lo que quedaría para comprar (o ahorrar). null si falta alguno */
  margin: number | null;
  /** Si el ahorro cuenta como gasto (como «Incluir ahorro» de Estadísticas) */
  includeSavings: boolean;
  /** Tarjetas sin el último estado de cuenta: lo comprometido puede ser más */
  staleCards: string[];
}

export interface OutlookOptions {
  /** Hoy (YYYY-MM-DD) */
  today: string;
  /**
   * Con el ahorro como gasto (false, como el resumen del mes y el balance de Inicio): los gastos fijos y los de
   * siempre en categorías de ahorro no se restan, así el margen es lo que queda para comprar o para ahorrar. Con
   * true, lo que se ahorra cada mes también se descuenta (como «Incluir ahorro» prendido en Estadísticas)
   */
  includeSavings?: boolean;
  /** El mes (YYYY-MM): el que viene si no se dice */
  month?: string;
}

/** Hasta qué día puede empezar el primer mes con datos para contar como mes completo */
const FIRST_DAYS = 5;

/** Una cuota que sigue de una compra anterior (2/6, 3/6…), anotada desde un estado de cuenta */
const laterInstallment = (m: Movement) => m.origin === 'tarjeta' && (noteInstallment(m.note)?.n ?? 0) >= 2;

/** Cuánto queda el mes que viene: ingresos, gastos fijos, cuotas, lo de siempre y el margen */
export function nextMonthOutlook(data: Data, opts: OutlookOptions): Outlook {
  const includeSavings = opts.includeSavings ?? false;
  const current = monthOf(opts.today);
  const month = opts.month ?? addMonths(current, 1);
  const ix = buildIndex(data);
  const savings = (rubroId: string) => !!ix.category.get(ix.rubro.get(rubroId)?.categoryId ?? '')?.savings;
  const live = new Set(data.rubros.filter((r) => !r.archived).map((r) => r.id));
  const recurring = data.recurring.filter((r) => !r.paused && live.has(r.rubroId) && isPositive(r.amount));
  const fixedSpend = recurring.filter((r) => r.kind === 'gasto' && (includeSavings || !savings(r.rubroId)));
  const fixed = sum(fixedSpend.map((r) => r.amount));
  const fixedByRubro = new Map<string, number>();
  for (const r of fixedSpend) fixedByRubro.set(r.rubroId, (fixedByRubro.get(r.rubroId) ?? 0) + r.amount);

  // Los últimos 3 meses completos que tienen algún movimiento (un mes vacío es que no se anotó, no que no se gastó). El
  // primer mes de todos los datos, solo si empieza en los primeros días: si no, quedó a medias (el comienzo del período
  // del primer estado de cuenta, o se empezó a anotar a mitad de mes) y bajaría los dos promedios
  const recent = monthRange(addMonths(current, -3), addMonths(current, -1));
  const byMonth = new Map<string, Movement[]>();
  for (const m of data.movements) {
    const k = monthOf(m.date);
    if (recent.includes(k) && isPositive(m.amount)) byMonth.set(k, [...(byMonth.get(k) ?? []), m]);
  }
  const oldest = data.movements.filter((m) => isPositive(m.amount)).map((m) => m.date).sort()[0];
  const partial = oldest && Number(oldest.slice(8, 10)) > FIRST_DAYS ? monthOf(oldest) : null;
  const withData = recent.filter((m) => byMonth.has(m) && m !== partial);

  let income: Outlook['income'] = null;
  const fixedIncome = sum(recurring.filter((r) => r.kind === 'ingreso').map((r) => r.amount));
  if (fixedIncome > 0) income = { amount: fixedIncome, from: 'fijos' };
  else {
    const total = sum(withData.flatMap((k) => byMonth.get(k)!.filter((m) => m.kind === 'ingreso').map((m) => m.amount)));
    if (total > 0) income = { amount: round2(total / withData.length), from: 'promedio', months: withData.length };
  }

  // Lo de siempre: por rubro, lo que pasa de su gasto fijo (si el fijo es 9.000 y se gastó 9.500, cuentan 500)
  const usualMonths = withData.map((k) => {
    const rubros = new Map<string, number>();
    for (const m of byMonth.get(k)!) {
      if (m.kind !== 'gasto' || laterInstallment(m) || (!includeSavings && savings(m.rubroId))) continue;
      rubros.set(m.rubroId, (rubros.get(m.rubroId) ?? 0) + m.amount);
    }
    return [...rubros].reduce((s, [r, v]) => s + Math.max(0, v - (fixedByRubro.get(r) ?? 0)), 0);
  });
  const usual = withData.length ? { amount: round2(usualMonths.reduce((a, b) => a + b, 0) / withData.length), months: withData.length } : null;

  const c = commitments(data, { today: opts.today, from: month, months: 1 });
  const installments = c.total[0];
  const free = income ? round2(income.amount - fixed - installments) : null;
  return {
    month,
    income,
    fixed,
    installments,
    free,
    usual,
    margin: free != null && usual ? round2(free - usual.amount) : null,
    includeSavings,
    staleCards: c.cards.filter((k) => k.stale).map((k) => k.card),
  };
}

// --- Simular una compra ----------------------------------------------------------------------------------

/** Una compra en `count` cuotas: todas iguales en centésimos y la última con lo que sobra. [] si no tiene sentido */
export function splitPurchase(amount: number, count: number): number[] {
  if (!isPositive(amount) || !Number.isInteger(count) || count < 1 || count > 72) return [];
  const cents = Math.round(amount * 100);
  const each = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) => (i < count - 1 ? each : cents - each * (count - 1)) / 100);
}

/**
 * Mes de la primera cuota de una compra de hoy: el del próximo cierre de la tarjeta (el día de cierre, el de su
 * último estado de cuenta). Sin la tarjeta (o sin estados de cuenta de ella), el mes que viene: lo más prudente
 */
export function firstInstallmentMonth(invoices: Invoice[], card: string | undefined, today: string): string {
  const inv = card?.trim() ? latestStatements(invoices).find((i) => cardKey(cardName(i)) === cardKey(card)) : undefined;
  const next = addMonths(monthOf(today), 1);
  if (!inv) return next;
  // El de este mes ya cerró (ya se subió): va en el siguiente
  if (monthOf(closingOf(inv)) >= monthOf(today)) return next;
  return Number(today.slice(8, 10)) <= Number(closingOf(inv).slice(8, 10)) ? monthOf(today) : next;
}

export interface Purchase {
  amount: number;
  /** Cantidad de cuotas (1: un solo pago) */
  count: number;
  /** La tarjeta con que se paga (opcional) */
  card?: string;
}

export interface Simulation {
  /** Cada cuota con el mes en que se cobra */
  cuotas: { month: string; amount: number }[];
  /** La ventana: lo comprometido en cuotas sin la compra y con ella */
  months: string[];
  before: number[];
  after: number[];
  /** Con una tarjeta conocida: lo de esa tarjeta, sin la compra y con ella */
  card?: { name: string; before: number[]; after: number[] };
  /** El mes que viene sin la compra */
  outlook: Outlook;
  /** La cuota de la compra que cae el mes que viene (0 si ninguna) */
  nextMonth: number;
  /** El margen del mes que viene con la compra (null si no se sabe el margen) */
  margin: number | null;
  /**
   * La cuota que cae en el estado de cuenta que cierra este mes (0 si ninguna) y el margen estimado de este mes con
   * ella (null si no se sabe o si no cae ninguna): sale de la plata de este mes
   */
  thisMonth: number;
  thisMargin: number | null;
  /** El día de cierre de la tarjeta elegida (el de su último estado de cuenta) */
  closingDay?: number;
}

/** Cómo quedan los próximos meses y el margen con una compra nueva en cuotas. null si el monto o las cuotas no sirven */
export function simulatePurchase(data: Data, purchase: Purchase, opts: OutlookOptions & { months?: number }): Simulation | null {
  const split = splitPurchase(purchase.amount, purchase.count);
  if (!split.length) return null;
  const first = firstInstallmentMonth(data.invoices, purchase.card, opts.today);
  const cuotas = split.map((amount, i) => ({ month: addMonths(first, i), amount }));
  const extra = (m: string) => sum(cuotas.filter((q) => q.month === m).map((q) => q.amount));
  const c = commitments(data, { today: opts.today, months: opts.months });
  const own = purchase.card?.trim() ? c.cards.find((k) => cardKey(k.card) === cardKey(purchase.card!)) : undefined;
  const outlook = nextMonthOutlook(data, opts);
  const nextMonth = extra(outlook.month);
  // Lo que cae en el estado de cuenta de este mes cuenta este mes (como las cuotas): contra el margen de este mes
  const thisMonth = extra(monthOf(opts.today));
  const current = thisMonth > 0 ? nextMonthOutlook(data, { ...opts, month: monthOf(opts.today) }) : null;
  const inv = purchase.card?.trim() ? latestStatements(data.invoices).find((i) => sameCard(cardName(i), purchase.card)) : undefined;
  return {
    cuotas,
    months: c.months,
    before: c.total,
    after: c.months.map((m, k) => round2(c.total[k] + extra(m))),
    ...(own ? { card: { name: own.card, before: own.byMonth, after: c.months.map((m, k) => round2(own.byMonth[k] + extra(m))) } } : {}),
    outlook,
    nextMonth,
    margin: outlook.margin == null ? null : round2(outlook.margin - nextMonth),
    thisMonth,
    thisMargin: current?.margin == null ? null : round2(current.margin - thisMonth),
    ...(inv ? { closingDay: Number(closingOf(inv).slice(8, 10)) } : {}),
  };
}
