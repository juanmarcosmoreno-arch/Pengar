/**
 * Resumen al cerrar el mes: cómo te fue (ingresos, gastos, ahorro, balance), contra el presupuesto, lo que más pesó,
 * contra los meses anteriores, el diezmo acumulado y los gastos fijos. Lo muestra MonthReport.
 */
import { addMonths, monthOf, toISODate } from './dates';
import { ledgerRows, percentLedger } from './ledger';
import { wasSkipped } from './recurring';
import { expenses, groupTotals, incomes, monthly, monthSummary, type Filter, type GroupTotal, type Index } from './stats';
import type { Category, Data, Movement, Recurring } from './types';

/** El suricata del resumen: festeja, contento, pensando o preocupado */
export type ReportMood = 'celebrando' | 'contento' | 'pensando' | 'preocupado';

export interface BudgetLine {
  category: Category;
  real: number;
  budget: number;
  /** real − budget (positivo: te pasaste) */
  diff: number;
  /** Presupuestada como % del ingreso (el diezmo): dar de más no es «pasarse» */
  percent: boolean;
}

export interface PercentStatus {
  category: Category;
  pct: number;
  /** Lo que entró en el mes (el real) */
  income: number;
  expected: number;
  given: number;
  /** given − expected */
  diff: number;
  /** Acumulado hasta este mes (>0 falta dar); null si el mes es anterior a «Contar desde» */
  pending: number | null;
  from: string;
}

export interface MonthReport {
  month: string;
  income: number;
  /** Gastos sin el ahorro */
  expense: number;
  savings: number;
  /** income − expense (el ahorro no cuenta como gasto, como en Inicio) */
  balance: number;
  /** Contra presupuesto, sin el ahorro (null si no hay presupuesto) */
  budget: {
    total: number;
    /** Lo gastado en las categorías con presupuesto; las en % del ingreso, hasta su presupuesto (dar de más no es pasarse) */
    spent: number;
    /** spent − total (positivo: te pasaste) */
    diff: number;
    /** Lo dado de más en las categorías en % del ingreso (no cuenta en `spent`) */
    extra: number;
    /** Las que se pasaron, de la que más a la que menos */
    over: BudgetLine[];
    /** Las que quedaron debajo, de la que más sobró a la que menos */
    under: BudgetLine[];
  } | null;
  /** Las 3 categorías con más gasto */
  top: GroupTotal[];
  /** Los 3 gastos más grandes, sin los totales de la planilla (salvo que el mes solo tenga esos: `biggestFromSheet`) */
  biggest: Movement[];
  biggestFromSheet: boolean;
  /** El mes tiene gastos con totales de la planilla (si hay de los dos, `biggest` deja afuera los de la planilla) */
  hasSheet: boolean;
  /** Contra el mes anterior (null si no tuvo gastos). change: −0,08 es 8% menos */
  prev: { month: string; expense: number; change: number } | null;
  /** Contra el promedio de hasta 6 meses anteriores con gastos (null si hay menos de 2) */
  average: { months: number; expense: number; change: number } | null;
  percent: PercentStatus[];
  /** Los fijos que ya existían ese mes: anotados, salteados y los que quedaron sin anotar */
  recurring: { recorded: Recurring[]; skipped: Recurring[]; missing: Recurring[] };
  movements: number;
  /** El mes solo tiene totales de la planilla */
  onlySheet: boolean;
  mood: ReportMood;
}

/** Balance «cerca de cero»: hasta el 3% de lo que se movió en el mes */
const NEAR_ZERO = 0.03;

const sum = (ms: Movement[]) => ms.reduce((s, m) => s + m.amount, 0);
const change = (cur: number, base: number) => (cur - base) / base;

export function monthReport(data: Data, ix: Index, month: string): MonthReport {
  const f: Filter = { from: month, to: month, includeSavings: false };
  const point = monthly(data, ix, f)[0];
  const income = sum(incomes(data, f));
  const spent = expenses(data, ix, f);
  const expense = sum(spent);
  const balance = income - expense;

  // Presupuesto: lo mismo que Estadísticas → Mes sin «Incluir ahorro»
  const s = monthSummary(data, ix, month, false);
  const lines: BudgetLine[] = s.rows
    .filter((r) => r.hasBudget)
    .map((r) => ({ category: r.category, real: r.real, budget: r.budget, diff: r.diff, percent: r.category.budget.type === 'percentIncome' }));
  // Dar de más en el diezmo no es pasarse del presupuesto: cuenta hasta lo presupuestado (como en el titular)
  const spentCapped = lines.reduce((t, l) => t + (l.percent ? Math.min(l.real, l.budget) : l.real), 0);
  const budget = s.budget > 0 ? {
    total: s.budget,
    spent: spentCapped,
    diff: spentCapped - s.budget,
    extra: s.budgetedExpense - spentCapped,
    over: lines.filter((l) => l.diff > 0.5).sort((a, b) => b.diff - a.diff),
    under: lines.filter((l) => l.diff <= 0.5).sort((a, b) => a.diff - b.diff),
  } : null;

  const daily = spent.filter((m) => !m.monthly);
  const biggestFromSheet = !daily.length && spent.length > 0;
  const biggest = [...(biggestFromSheet ? spent : daily)].sort((a, b) => b.amount - a.amount).slice(0, 3);

  // Meses anteriores con gastos (sin ahorro)
  const byMonth = new Map<string, number>();
  for (const m of expenses(data, ix, { from: '0000-01', to: addMonths(month, -1), includeSavings: false })) {
    byMonth.set(monthOf(m.date), (byMonth.get(monthOf(m.date)) ?? 0) + m.amount);
  }
  const prevMonth = addMonths(month, -1);
  const prevExpense = byMonth.get(prevMonth) ?? 0;
  const prev = prevExpense > 0 ? { month: prevMonth, expense: prevExpense, change: change(expense, prevExpense) } : null;
  const last = [...byMonth.entries()].filter(([, v]) => v > 0).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6);
  const avg = last.length ? last.reduce((t, [, v]) => t + v, 0) / last.length : 0;
  const average = last.length >= 2 && avg > 0 ? { months: last.length, expense: avg, change: change(expense, avg) } : null;

  const percent = data.categories.filter((c) => c.budget.type === 'percentIncome').map((category): PercentStatus => {
    const ledger = percentLedger(data, ix, category.id, month);
    const row = ledger.rows.at(-1)?.month === month ? ledger.rows.at(-1)! : ledgerRows(data, ix, category.id, month, month)[0];
    return {
      category,
      pct: category.budget.type === 'percentIncome' ? category.budget.pct : 0,
      income: row.income,
      expected: row.expected,
      given: row.given,
      diff: row.diff,
      pending: month >= ledger.from ? ledger.pending : null,
      from: ledger.from,
    };
  });

  const inMonth = data.movements.filter((m) => monthOf(m.date) === month);
  const recorded = new Set(inMonth.map((m) => `${m.rubroId}|${m.kind}`));
  const active = new Set(data.rubros.filter((r) => !r.archived).map((r) => r.id));
  const recurring: MonthReport['recurring'] = { recorded: [], skipped: [], missing: [] };
  for (const r of data.recurring) {
    // Los que se crearon después de ese mes no cuentan; los pausados y los de un rubro archivado, solo si se anotaron
    if (monthOf(toISODate(new Date(r.createdAt))) > month) continue;
    if (recorded.has(`${r.rubroId}|${r.kind}`)) recurring.recorded.push(r);
    else if (r.paused || !active.has(r.rubroId)) continue;
    // Salteado con «Saltar» en ese mes; si después se anotó o se salteó un mes posterior, sigue siendo «sin anotar»
    else if (wasSkipped(r, month)) recurring.skipped.push(r);
    else recurring.missing.push(r);
  }

  const near = Math.abs(balance) <= Math.max(1, Math.max(income, expense) * NEAR_ZERO);
  // Dar de más en el diezmo no le quita el festejo
  const overSpent = budget?.over.some((l) => !l.percent) ?? false;
  const mood: ReportMood = near ? 'pensando' : balance < 0 ? 'preocupado' : overSpent ? 'contento' : 'celebrando';

  return {
    month,
    income,
    expense,
    savings: point?.savings ?? 0,
    balance,
    budget,
    top: groupTotals(data, ix, f, 'category').slice(0, 3),
    biggest,
    biggestFromSheet,
    hasSheet: spent.some((m) => m.monthly),
    prev,
    average,
    percent,
    recurring,
    movements: inMonth.length,
    onlySheet: inMonth.length > 0 && inMonth.every((m) => m.monthly),
    mood,
  };
}

/** El resumen que Inicio ofrece: el del mes pasado, si tiene datos y todavía no se abrió */
export function pendingReport(data: Data, todayISO: string): string | null {
  const prev = addMonths(monthOf(todayISO), -1);
  if ((data.settings.lastReportSeen ?? '') >= prev) return null;
  return data.movements.some((m) => monthOf(m.date) === prev) ? prev : null;
}
