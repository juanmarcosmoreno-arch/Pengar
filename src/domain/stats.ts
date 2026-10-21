/**
 * Cuentas para las gráficas: las mismas del tablero en R (ingresos y ahorro, gastos por categoría en el tiempo,
 * distribución, promedios, top de rubros, real contra presupuesto del mes y el porcentaje del ingreso).
 */
import { addMonths, monthOf, monthRange } from './dates';
import { OTHER_COLOR, PALETTE } from './template';
import type { Category, Data, Movement, Rubro } from './types';

export interface Index {
  rubro: Map<string, Rubro>;
  category: Map<string, Category>;
  categoryOf: (m: Movement) => Category | undefined;
}

export function buildIndex(data: Pick<Data, 'rubros' | 'categories'>): Index {
  const rubro = new Map(data.rubros.map((r) => [r.id, r]));
  const category = new Map(data.categories.map((c) => [c.id, c]));
  return { rubro, category, categoryOf: (m) => category.get(rubro.get(m.rubroId)?.categoryId ?? '') };
}

export interface Filter {
  /** YYYY-MM, inclusive */
  from: string;
  to: string;
  includeSavings: boolean;
}

export type GroupBy = 'category' | 'rubro';

const inRange = (m: Movement, f: { from: string; to: string }) => {
  const month = monthOf(m.date);
  return month >= f.from && month <= f.to;
};

/** Gastos del período (sin ahorro si `includeSavings` es falso) */
export function expenses(data: Data, ix: Index, f: Filter): Movement[] {
  return data.movements.filter((m) => m.kind === 'gasto' && inRange(m, f) && (f.includeSavings || !ix.categoryOf(m)?.savings));
}

export function incomes(data: Data, f: { from: string; to: string }): Movement[] {
  return data.movements.filter((m) => m.kind === 'ingreso' && inRange(m, f));
}

const sum = (ms: Movement[]) => ms.reduce((s, m) => s + m.amount, 0);

/** Primer y último mes con movimientos */
export function dataSpan(data: Data): { from: string; to: string } | null {
  if (!data.movements.length) return null;
  let from = '9999-12';
  let to = '0000-01';
  for (const m of data.movements) {
    const month = monthOf(m.date);
    if (month < from) from = month;
    if (month > to) to = month;
  }
  return { from, to };
}

/** Cantidad de meses del período que tienen algún movimiento (para promediar sin contar meses vacíos del futuro) */
export function activeMonths(data: Data, f: { from: string; to: string }): string[] {
  const set = new Set(data.movements.filter((m) => inRange(m, f)).map((m) => monthOf(m.date)));
  return monthRange(f.from, f.to).filter((m) => set.has(m));
}

export interface Kpis {
  income: number;
  expense: number;
  balance: number;
  monthlyAverage: number;
  months: number;
}

export function kpis(data: Data, ix: Index, f: Filter): Kpis {
  const income = sum(incomes(data, f));
  const exp = expenses(data, ix, f);
  const expense = sum(exp);
  const months = new Set(exp.map((m) => monthOf(m.date))).size;
  return { income, expense, balance: income - expense, monthlyAverage: months ? expense / months : 0, months };
}

export interface MonthPoint {
  month: string;
  income: number;
  expense: number;
  savings: number;
}

/** Ingresos, gastos y ahorro de cada mes del período */
export function monthly(data: Data, ix: Index, f: Filter): MonthPoint[] {
  const points = new Map(monthRange(f.from, f.to).map((month) => [month, { month, income: 0, expense: 0, savings: 0 }]));
  for (const m of data.movements) {
    const p = points.get(monthOf(m.date));
    if (!p) continue;
    if (m.kind === 'ingreso') p.income += m.amount;
    else {
      const isSavings = ix.categoryOf(m)?.savings;
      if (isSavings) p.savings += m.amount;
      if (!isSavings || f.includeSavings) p.expense += m.amount;
    }
  }
  return [...points.values()];
}

export interface GroupTotal {
  key: string;
  name: string;
  color: string;
  icon: string;
  categoryId: string;
  total: number;
  /** Promedio por mes del período (meses con datos) */
  average: number;
  share: number;
}

export function groupTotals(data: Data, ix: Index, f: Filter, by: GroupBy): GroupTotal[] {
  const exp = expenses(data, ix, f);
  const months = Math.max(1, new Set(exp.map((m) => monthOf(m.date))).size);
  const total = sum(exp);
  const groups = new Map<string, GroupTotal>();
  for (const m of exp) {
    const cat = ix.categoryOf(m);
    const rubro = ix.rubro.get(m.rubroId);
    const key = by === 'category' ? cat?.id ?? '?' : m.rubroId;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        name: (by === 'category' ? cat?.name : rubro?.name) ?? 'Sin categoría',
        color: cat?.color ?? OTHER_COLOR,
        icon: cat?.icon ?? 'tag',
        categoryId: cat?.id ?? '?',
        total: 0,
        average: 0,
        share: 0,
      };
      groups.set(key, g);
    }
    g.total += m.amount;
  }
  const list = [...groups.values()].filter((g) => g.total !== 0).sort((a, b) => b.total - a.total);
  for (const g of list) {
    g.average = g.total / months;
    g.share = total ? g.total / total : 0;
  }
  return list;
}

/**
 * Junta las más chicas en «Otras» para no pasar de `max` colores. Si se agrupa por rubro, los colores salen
 * de la paleta en orden (los rubros no tienen color propio).
 */
export function foldOthers(list: GroupTotal[], max: number, by: GroupBy): GroupTotal[] {
  const colored = by === 'rubro' ? list.map((g, i) => ({ ...g, color: i < PALETTE.length ? PALETTE[i] : OTHER_COLOR })) : list;
  if (colored.length <= max) return colored;
  const head = colored.slice(0, max - 1);
  const tail = colored.slice(max - 1);
  const total = tail.reduce((s, g) => s + g.total, 0);
  return [
    ...head,
    {
      key: '__otras',
      name: by === 'category' ? 'Otras categorías' : 'Otros rubros',
      color: OTHER_COLOR,
      icon: 'more',
      categoryId: '',
      total,
      average: tail.reduce((s, g) => s + g.average, 0),
      share: tail.reduce((s, g) => s + g.share, 0),
    },
  ];
}

export interface StackData {
  series: { key: string; name: string; color: string }[];
  rows: { month: string; values: Record<string, number> }[];
}

/** Gastos de cada mes repartidos por grupo (sin ahorro, como el streamgraph del tablero) */
export function stack(data: Data, ix: Index, f: Filter, by: GroupBy, max = 8): StackData {
  const noSavings = { ...f, includeSavings: false };
  const groups = foldOthers(groupTotals(data, ix, noSavings, by), max, by);
  const keys = new Set(groups.map((g) => g.key));
  const rows = monthRange(f.from, f.to).map((month) => ({ month, values: Object.fromEntries(groups.map((g) => [g.key, 0])) as Record<string, number> }));
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  for (const m of expenses(data, ix, noSavings)) {
    const row = byMonth.get(monthOf(m.date));
    if (!row) continue;
    let key = by === 'category' ? ix.categoryOf(m)?.id ?? '?' : m.rubroId;
    if (!keys.has(key)) key = '__otras';
    if (key in row.values) row.values[key] += m.amount;
  }
  return { series: groups.map(({ key, name, color }) => ({ key, name, color })), rows };
}

// --- Mes contra presupuesto ------------------------------------------------------------------------------

export type BudgetStatus = 'ok' | 'over' | 'none';

export interface CategoryCompare {
  category: Category;
  real: number;
  budget: number;
  hasBudget: boolean;
  diff: number;
  pct: number | null;
  status: BudgetStatus;
}

export interface MonthSummary {
  month: string;
  income: number;
  /** Todos los gastos del mes */
  expense: number;
  budget: number;
  /** Lo gastado en las categorías con presupuesto: es lo que se compara con `budget` */
  budgetedExpense: number;
  /** budgetedExpense − budget (positivo: te pasaste). Las categorías sin presupuesto no cuentan */
  diff: number;
  rows: CategoryCompare[];
}

/** Lo que entró en el mes; si todavía no entró nada, lo del mes anterior (para estimar los «% del ingreso») */
export function incomeFor(data: Data, month: string): { amount: number; estimated: boolean } {
  const real = sum(incomes(data, { from: month, to: month }));
  if (real > 0) return { amount: real, estimated: false };
  const prev = addMonths(month, -1);
  return { amount: sum(incomes(data, { from: prev, to: prev })), estimated: true };
}

export function budgetAmount(c: Category, income: number): number {
  if (c.budget.type === 'fixed') return c.budget.amount;
  if (c.budget.type === 'percentIncome') return (income * c.budget.pct) / 100;
  return 0;
}

export function monthSummary(data: Data, ix: Index, month: string, includeSavings: boolean): MonthSummary {
  const f: Filter = { from: month, to: month, includeSavings };
  const real = new Map<string, number>();
  for (const m of expenses(data, ix, f)) {
    const c = ix.categoryOf(m);
    if (c) real.set(c.id, (real.get(c.id) ?? 0) + m.amount);
  }
  const { amount: income } = incomeFor(data, month);
  const rows: CategoryCompare[] = data.categories
    .filter((c) => c.kind === 'gasto' && (includeSavings || !c.savings))
    .map((category) => {
      const r = real.get(category.id) ?? 0;
      const hasBudget = category.budget.type !== 'none';
      const budget = budgetAmount(category, income);
      const diff = r - budget;
      return {
        category,
        real: r,
        budget,
        hasBudget,
        diff,
        pct: hasBudget && budget > 0 ? diff / budget : null,
        status: (!hasBudget ? 'none' : diff > 0.5 ? 'over' : 'ok') as BudgetStatus,
      };
    })
    .filter((r) => r.real > 0 || r.budget > 0)
    .sort(compareRows);
  const expense = rows.reduce((s, r) => s + r.real, 0);
  const budget = rows.reduce((s, r) => s + r.budget, 0);
  const budgetedExpense = rows.filter((r) => r.hasBudget).reduce((s, r) => s + r.real, 0);
  return { month, income: sum(incomes(data, f)), expense, budget, budgetedExpense, diff: budgetedExpense - budget, rows };
}

/**
 * Orden de «Real contra presupuesto»: primero las que se pasaron (las que más), después las que tienen gasto (las
 * que usaron más de su presupuesto primero; las sin presupuesto, por lo gastado) y al final las que están en $ 0.
 */
function compareRows(a: CategoryCompare, b: CategoryCompare): number {
  const group = (r: CategoryCompare) => (r.status === 'over' ? 0 : r.real <= 0 ? 3 : r.hasBudget ? 1 : 2);
  const ga = group(a);
  const gb = group(b);
  if (ga !== gb) return ga - gb;
  if (ga === 0) return b.diff - a.diff;
  if (ga === 1) return b.real / (b.budget || 1) - a.real / (a.budget || 1);
  if (ga === 2) return b.real - a.real;
  return b.budget - a.budget;
}

/**
 * Al cambiar un presupuesto de monto a «% del ingreso» (o al revés), el número se convierte con el ingreso del mes:
 * $ 20.000 con $ 200.000 de ingreso es el 10 %. Sin ingreso no hay cómo: queda vacío.
 */
export function convertBudget(value: number | null, to: 'fixed' | 'percentIncome', income: number): number | null {
  if (value == null || value <= 0 || income <= 0) return null;
  return to === 'percentIncome' ? Math.round((value / income) * 100) : Math.round((income * value) / 100);
}

export interface PercentCard {
  category: Category;
  pct: number;
  income: number;
  incomeEstimated: boolean;
  real: number;
  expected: number;
  diff: number;
}

/** Categorías presupuestadas como porcentaje del ingreso (por ejemplo, el diezmo: 10% de lo que entra) */
export function percentCards(data: Data, ix: Index, month: string): PercentCard[] {
  const { amount: income, estimated } = incomeFor(data, month);
  return data.categories
    .filter((c) => c.budget.type === 'percentIncome')
    .map((category) => {
      const pct = category.budget.type === 'percentIncome' ? category.budget.pct : 0;
      const real = sum(data.movements.filter((m) => m.kind === 'gasto' && monthOf(m.date) === month && ix.categoryOf(m)?.id === category.id));
      const expected = (income * pct) / 100;
      return { category, pct, income, incomeEstimated: estimated, real, expected, diff: real - expected };
    });
}

/**
 * Variación de los gastos contra el mes anterior (null si el anterior no tiene gastos). Con `current` (el mes en
 * curso, todavía incompleto) solo vale la suba: ya pasó al mes anterior entero. Una baja a principio de mes no dice
 * nada (con $ 0 anotado sería «100 % menos»).
 */
export function expenseChange(data: Data, ix: Index, month: string, includeSavings = false, current?: string): number | null {
  const cur = sum(expenses(data, ix, { from: month, to: month, includeSavings }));
  const prevMonth = addMonths(month, -1);
  const prev = sum(expenses(data, ix, { from: prevMonth, to: prevMonth, includeSavings }));
  if (!prev) return null;
  const change = (cur - prev) / prev;
  return month === current && change <= 0 ? null : change;
}
