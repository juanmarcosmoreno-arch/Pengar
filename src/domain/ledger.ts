/**
 * Cuenta corriente de una categoría en % del ingreso (el diezmo): mes a mes, cuánto tocaba dar según lo que entró,
 * cuánto se dio y lo que se va arrastrando.
 */
import { addMonths, monthOf, monthRange } from './dates';
import { dataSpan, type Index } from './stats';
import type { Category, Data } from './types';

export interface LedgerRow {
  month: string;
  /** Lo que entró ese mes (el real: un mes sin ingresos espera 0) */
  income: number;
  /** El porcentaje de ese ingreso, redondeado como la moneda (sin centavos: $ 18.640, no $ 18.640,30) */
  expected: number;
  /** Lo que se dio ese mes en la categoría (de todos los orígenes: a mano, planilla, facturas, tarjeta) */
  given: number;
  /** given − expected: negativo, faltó; positivo, se dio de más (como en las tarjetas de Estadísticas) */
  diff: number;
  /** Lo acumulado hasta ese mes, con el saldo inicial: positivo, falta dar; negativo, se dio de más */
  pending: number;
}

export interface Ledger {
  /** Del primer mes al último (`toMonth`) */
  rows: LedgerRow[];
  /** Total acumulado: >0 falta dar, <0 se dio de más */
  pending: number;
  /** Desde qué mes se cuenta */
  from: string;
  /** Saldo de antes de `from` (positivo: lo que faltaba dar) */
  opening: number;
}

const round = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/** Primer mes de la cuenta: el elegido o, si no, el primer mes con datos (o `toMonth` si no hay nada) */
export function ledgerFrom(data: Data, categoryId: string, toMonth: string): string {
  return data.categories.find((c) => c.id === categoryId)?.ledger?.from ?? dataSpan(data)?.from ?? toMonth;
}

export function percentLedger(data: Data, ix: Index, categoryId: string, toMonth: string): Ledger {
  const from = ledgerFrom(data, categoryId, toMonth);
  const opening = data.categories.find((c) => c.id === categoryId)?.ledger?.opening ?? 0;
  const rows = ledgerRows(data, ix, categoryId, from, toMonth, opening);
  return { rows, pending: rows.at(-1)?.pending ?? opening, from, opening };
}

/** Los renglones de `from` a `to`, arrastrando desde `opening` */
export function ledgerRows(data: Data, ix: Index, categoryId: string, from: string, to: string, opening = 0): LedgerRow[] {
  const category = data.categories.find((c) => c.id === categoryId);
  const pct = category?.budget.type === 'percentIncome' ? category.budget.pct : 0;
  const decimals = data.settings.currency.decimals;
  const income = new Map<string, number>();
  const given = new Map<string, number>();
  for (const m of data.movements) {
    const month = monthOf(m.date);
    if (month < from || month > to) continue;
    if (m.kind === 'ingreso') income.set(month, (income.get(month) ?? 0) + m.amount);
    else if (ix.categoryOf(m)?.id === categoryId) given.set(month, (given.get(month) ?? 0) + m.amount);
  }
  let pending = opening;
  return monthRange(from, to).map((month) => {
    const inc = round(income.get(month) ?? 0, 2);
    const expected = round((inc * pct) / 100, decimals);
    const g = round(given.get(month) ?? 0, 2);
    pending = round(pending + expected - g, 2);
    return { month, income: inc, expected, given: g, diff: round(g - expected, 2), pending };
  });
}

/**
 * Al cambiar el % de una categoría que ya tiene meses contados, la cuenta se cierra con el % de antes: desde el mes en
 * curso se cuenta con el nuevo, con lo acumulado hasta el mes anterior como saldo inicial. Si no, el % nuevo se
 * aplicaría a todos los meses pasados (pasar de 10 % a 12 % inventaría una deuda). Devuelve la cuenta de `next`
 */
export function ledgerAfterChange(data: Data, ix: Index, prev: Category, next: Category, current: string): Category['ledger'] {
  if (prev.budget.type !== 'percentIncome' || next.budget.type !== 'percentIncome' || prev.budget.pct === next.budget.pct) return next.ledger;
  // `next.ledger` distinto del de antes: lo cambiaron a mano a la vez
  if (JSON.stringify(next.ledger ?? null) !== JSON.stringify(prev.ledger ?? null)) return next.ledger;
  const withPrev = { ...data, categories: data.categories.map((c) => (c.id === prev.id ? prev : c)) };
  if (ledgerFrom(withPrev, prev.id, current) >= current) return next.ledger;
  const before = percentLedger(withPrev, ix, prev.id, addMonths(current, -1));
  return { from: current, opening: round(before.pending, 2) };
}
