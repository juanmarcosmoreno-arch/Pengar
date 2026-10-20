/**
 * Importar una planilla de presupuesto.
 *
 * Formato «planilla mensual» (el de presupuesto.xlsx):
 *   - Columna 1: rubro (UTE, Netflix…). Columna 2: letra de la categoría (F, ST…).
 *   - Una columna por mes, con la fecha del mes en el encabezado. Cada celda es lo gastado ese mes.
 *   - Los rubros sin letra que se llaman Entrada/Ingreso/Sueldo son ingresos. TOTAL y BALANCE se ignoran.
 *   - Opcional, a la derecha: la tabla de categorías (letra, nombre y PROYECTADO = presupuesto básico).
 *
 * Formato «movimientos» (CSV o Excel): una fila por movimiento con fecha, rubro, categoría, monto
 * (y opcionalmente tipo y nota). Es el mismo que exporta Pengar.
 */
import { monthOf } from './dates';
import { parseAmount } from './money';
import { newId, OTHER_COLOR, PALETTE, templateKeywords } from './template';
import type { Budget, Category, Kind, Movement, Rubro } from './types';

export type Cell = string | number | boolean | Date | null | undefined;

export interface ImportResult {
  categories: Category[];
  rubros: Rubro[];
  movements: Movement[];
  months: string[];
  warnings: string[];
}

const SKIP = /^(total(es)?|balance|saldo|subtotal)$/i;
const INCOME = /^(entrada|entradas|ingreso|ingresos|sueldo|salario)$/i;

export const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Ícono probable según el nombre de la categoría */
export function guessIcon(name: string): string {
  const n = norm(name);
  const rules: [RegExp, string][] = [
    [/aliment|super|mercado/, 'm:super'],
    [/comida|cocina/, 'm:comida'],
    [/restaurant|comer afuera/, 'm:restaurantes'],
    [/fijo|servicio|cuenta/, 'm:servicios'],
    [/vivienda|alquiler/, 'm:vivienda'],
    [/transporte|auto|nafta|combustible/, 'm:mant-auto'],
    [/salud|medic|mutual/, 'm:salud'],
    [/deporte|gimnasio|club/, 'm:deporte'],
    [/educa|estudio|colegio/, 'm:educacion'],
    [/libro|cultura/, 'm:libros'],
    [/limpieza/, 'm:limpieza'],
    [/manten|arreglo/, 'm:mant-casa'],
    [/impuesto|tramite|patente|contribucion|\bbps\b|\bdgi\b/, 'm:impuestos'],
    [/bienes|online|mercado ?libre|temu|amazon/, 'm:compras-online'],
    [/electro|tecnolog/, 'm:tecnologia'],
    [/hogar|mueble|decora|casa/, 'm:hogar'],
    [/jardin/, 'm:jardin'],
    [/vestimenta|ropa/, 'm:ropa'],
    [/internet|stream|suscrip|entreten/, 'm:entretenimiento'],
    [/telefon|celular/, 'm:telefonia'],
    [/calefac|gas|lena/, 'flame'],
    [/diezmo|ofrenda|donac|ayuda/, 'hand-heart'],
    [/ahorro/, 'm:ahorro'],
    [/inversi/, 'm:ahorro'],
    [/extra|ocio|salida|paseo/, 'm:salidas'],
    [/ingreso|sueldo|entrada/, 'm:inversiones'],
    [/viaje|vacacion/, 'm:viajes'],
    [/mascota|veterin/, 'm:mascotas'],
    [/hijo|familia|bebe/, 'm:familia'],
    [/seguro/, 'm:seguros'],
    [/regalo/, 'm:regalos'],
    [/imprevist|emergencia/, 'm:imprevistos'],
    [/otro|vario/, 'm:otros'],
  ];
  return rules.find(([re]) => re.test(n))?.[1] ?? 'm:otros';
}

/** Fecha de un encabezado: Date, número de serie de Excel (45597), «2024-11», «11/2024», «nov 2024» */
export function headerMonth(v: Cell): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // SheetJS arma la fecha en UTC: se suman unas horas para no caer en el día anterior
    const d = new Date(v.getTime() + 12 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 30000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    let m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
    m = s.match(/^(?:\d{1,2}[-/])?(\d{1,2})[-/](\d{4})$/);
    if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
    const names = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
    m = norm(s).match(/^([a-z]{3})[a-z]*\.?[\s-]+(\d{2,4})$/);
    if (m) {
      const i = names.indexOf(m[1] === 'sep' ? 'set' : m[1]);
      if (i >= 0) return `${m[2].length === 2 ? '20' + m[2] : m[2]}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  return null;
}

function num(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return parseAmount(v);
  return null;
}

const str = (v: Cell) => (v == null ? '' : String(v).trim());

/** ¿Es una planilla con un mes por columna? */
export function isMonthlySheet(rows: Cell[][]): boolean {
  return rows.slice(0, 5).some((r) => r.filter((c) => headerMonth(c)).length >= 2);
}

export function importMonthlySheet(rows: Cell[][]): ImportResult {
  const warnings: string[] = [];
  const headerIndex = rows.findIndex((r) => r.filter((c) => headerMonth(c)).length >= 2);
  if (headerIndex < 0) throw new Error('No encontré los meses en el encabezado de la planilla.');
  const header = rows[headerIndex];
  const monthCols: { col: number; month: string }[] = [];
  header.forEach((c, col) => {
    const month = headerMonth(c);
    if (month && col >= 1) monthCols.push({ col, month });
  });
  const projectedCol = header.findIndex((c) => /^(proyectado|presupuesto|basico|básico)$/i.test(str(c)));

  // Tabla de categorías (letra, nombre, presupuesto) a la izquierda de PROYECTADO
  const table = new Map<string, { name: string; amount: number | null }>();
  if (projectedCol >= 2) {
    for (const r of rows.slice(headerIndex)) {
      const code = str(r[projectedCol - 2]);
      const name = str(r[projectedCol - 1]);
      if (code && name && code.length <= 3) table.set(code.toUpperCase(), { name, amount: num(r[projectedCol]) });
    }
  }

  const categories = new Map<string, Category>();
  const ensureCategory = (code: string, kind: Kind): Category => {
    const key = kind === 'ingreso' ? '__income' : code || '__none';
    let c = categories.get(key);
    if (!c) {
      const fromTable = table.get(code);
      const name = kind === 'ingreso' ? 'Ingresos' : fromTable?.name ?? (code ? `Categoría ${code}` : 'Sin categoría');
      const n = norm(name);
      let budget: Budget = { type: 'none' };
      if (fromTable?.amount != null && fromTable.amount > 0) budget = { type: 'fixed', amount: fromTable.amount };
      else if (/diezmo/.test(n)) budget = { type: 'percentIncome', pct: 10 };
      c = {
        id: newId('c'),
        name,
        code: kind === 'ingreso' ? undefined : code || undefined,
        kind,
        icon: guessIcon(name),
        color: kind === 'ingreso' ? '#176B60' : OTHER_COLOR,
        budget,
        savings: /ahorro|inversi/.test(n) || undefined,
        order: 0,
      };
      categories.set(key, c);
    }
    return c;
  };

  const rubros: Rubro[] = [];
  const movements: Movement[] = [];
  const now = Date.now();
  for (const r of rows.slice(headerIndex + 1)) {
    const name = str(r[0]);
    if (!name || SKIP.test(name)) continue;
    const code = str(r[1]).toUpperCase();
    const isIncome = !code && INCOME.test(name);
    if (!code && !isIncome) warnings.push(`«${name}» no tiene categoría: quedó en «Sin categoría».`);
    const kind: Kind = isIncome ? 'ingreso' : 'gasto';
    const category = ensureCategory(code, kind);
    const values = monthCols.map(({ col, month }) => ({ month, value: num(r[col]) })).filter((v) => v.value);
    const existing = rubros.find((x) => norm(x.name) === norm(name) && x.categoryId === category.id);
    const rubro = existing ?? { id: newId('r'), name, categoryId: category.id, keywords: [norm(name)] };
    if (!existing) rubros.push(rubro);
    for (const { month, value } of values) {
      movements.push({
        id: newId('m'),
        date: `${month}-01`,
        amount: Math.round(value! * 100) / 100,
        kind,
        rubroId: rubro.id,
        origin: 'planilla',
        monthly: true,
        createdAt: now,
      });
    }
  }
  // Categorías de la tabla que no tienen rubros todavía (para presupuestar igual)
  for (const code of table.keys()) ensureCategory(code, 'gasto');

  const incomeCats = new Set([...categories.values()].filter((c) => c.kind === 'ingreso').map((c) => c.id));
  enrichKeywords(rubros.filter((r) => !incomeCats.has(r.categoryId)));
  const list = finishCategories([...categories.values()], movements, rubros);
  const months = [...new Set(movements.map((m) => monthOf(m.date)))].sort();
  return { categories: list, rubros, movements, months, warnings };
}

/** Orden y colores: las categorías que más gastan van primero y se llevan los colores de la paleta */
export function finishCategories(categories: Category[], movements: Movement[], rubros: Rubro[]): Category[] {
  const catOf = new Map(rubros.map((r) => [r.id, r.categoryId]));
  const totals = new Map<string, number>();
  for (const m of movements) {
    const c = catOf.get(m.rubroId);
    if (c) totals.set(c, (totals.get(c) ?? 0) + m.amount);
  }
  const expenses = categories.filter((c) => c.kind === 'gasto').sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0));
  expenses.forEach((c, i) => {
    c.order = i;
    c.color = i < PALETTE.length ? PALETTE[i] : OTHER_COLOR;
  });
  const incomes = categories.filter((c) => c.kind === 'ingreso');
  incomes.forEach((c, i) => (c.order = expenses.length + i));
  return [...expenses, ...incomes];
}

// --- Movimientos sueltos (CSV) -------------------------------------------------------------------------

const COLS = {
  date: /^(fecha|date|dia|día)$/i,
  amount: /^(monto|importe|amount|valor)$/i,
  rubro: /^(rubro|concepto|gasto|item)$/i,
  category: /^(categoria|categoría|category|cat)$/i,
  kind: /^(tipo|kind)$/i,
  note: /^(nota|detalle|descripcion|descripción|note)$/i,
  merchant: /^(comercio|merchant)$/i,
};

export function isMovementSheet(rows: Cell[][]): boolean {
  const h = (rows[0] ?? []).map(str);
  return h.some((c) => COLS.date.test(c)) && h.some((c) => COLS.amount.test(c));
}

function parseDate(v: Cell): string | null {
  if (v instanceof Date) return new Date(v.getTime() + 12 * 3600_000).toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400_000).toISOString().slice(0, 10);
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Movimientos sueltos. Usa las categorías y rubros que ya existen (por nombre) y crea los que falten.
 */
export function importMovementSheet(rows: Cell[][], existing: { categories: Category[]; rubros: Rubro[] }): ImportResult {
  const h = rows[0].map(str);
  const idx = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, h.findIndex((c) => re.test(c))])) as Record<keyof typeof COLS, number>;
  const categories = [...existing.categories];
  const rubros = [...existing.rubros];
  const newCategories: Category[] = [];
  const newRubros: Rubro[] = [];
  const movements: Movement[] = [];
  const warnings: string[] = [];
  const now = Date.now();
  rows.slice(1).forEach((r, i) => {
    const date = parseDate(r[idx.date]);
    let amount = num(r[idx.amount]);
    if (!date || amount == null || amount === 0) {
      if (r.some((c) => str(c))) warnings.push(`Fila ${i + 2}: falta la fecha o el monto.`);
      return;
    }
    const kindText = idx.kind >= 0 ? norm(str(r[idx.kind])) : '';
    let kind: Kind = /ingreso|entrada/.test(kindText) ? 'ingreso' : 'gasto';
    if (!kindText && amount > 0 && idx.kind < 0) kind = 'gasto';
    if (amount < 0 && !kindText) amount = -amount;
    const catName = idx.category >= 0 ? str(r[idx.category]) : '';
    const rubroName = (idx.rubro >= 0 ? str(r[idx.rubro]) : '') || catName || 'Varios';
    let category = categories.find((c) => norm(c.name) === norm(catName || (kind === 'ingreso' ? 'Ingresos' : 'Otros')) && c.kind === kind)
      ?? categories.find((c) => c.code && c.code.toUpperCase() === catName.toUpperCase() && c.kind === kind);
    let rubro = rubros.find((x) => norm(x.name) === norm(rubroName) && (!category || x.categoryId === category.id));
    if (!rubro) {
      if (!category) {
        const name = catName || (kind === 'ingreso' ? 'Ingresos' : 'Otros');
        category = { id: newId('c'), name, kind, icon: guessIcon(name), color: kind === 'ingreso' ? '#176B60' : OTHER_COLOR, budget: { type: 'none' }, order: categories.length };
        categories.push(category);
        newCategories.push(category);
      }
      rubro = { id: newId('r'), name: rubroName, categoryId: category.id, keywords: [norm(rubroName)] };
      rubros.push(rubro);
      newRubros.push(rubro);
    }
    movements.push({
      id: newId('m'),
      date,
      amount: Math.abs(amount),
      kind,
      rubroId: rubro.id,
      note: idx.note >= 0 ? str(r[idx.note]) || undefined : undefined,
      merchant: idx.merchant >= 0 ? str(r[idx.merchant]) || undefined : undefined,
      origin: 'planilla',
      createdAt: now,
    });
  });
  const months = [...new Set(movements.map((m) => monthOf(m.date)))].sort();
  return { categories: newCategories, rubros: newRubros, movements, months, warnings };
}

/**
 * Suma lo importado a lo que ya hay: las categorías y rubros con el mismo nombre se unen (no se duplican)
 * y los movimientos pasan a apuntar a los existentes.
 */
export function mergeImport(existing: { categories: Category[]; rubros: Rubro[] }, res: ImportResult): ImportResult {
  const catMap = new Map<string, string>();
  const categories: Category[] = [];
  for (const c of res.categories) {
    const same = existing.categories.find((x) => x.kind === c.kind && (norm(x.name) === norm(c.name) || (!!c.code && x.code === c.code)));
    if (same) catMap.set(c.id, same.id);
    else categories.push({ ...c, order: existing.categories.length + categories.length });
  }
  const rubroMap = new Map<string, string>();
  const rubros: Rubro[] = [];
  for (const r of res.rubros) {
    const categoryId = catMap.get(r.categoryId) ?? r.categoryId;
    const same = existing.rubros.find((x) => x.categoryId === categoryId && norm(x.name) === norm(r.name));
    if (same) rubroMap.set(r.id, same.id);
    else rubros.push({ ...r, categoryId });
  }
  const movements = res.movements.map((m) => ({ ...m, rubroId: rubroMap.get(m.rubroId) ?? m.rubroId }));
  return { ...res, categories, rubros, movements };
}

/**
 * Los rubros de una planilla traen solo su nombre como palabra clave. Si el nombre se parece a un único rubro
 * sugerido («UTE» → Luz, «super alimentacion» → Supermercado), hereda sus palabras (Tienda Inglesa, Disco…), así
 * las facturas se asignan solas desde el primer día. Cada palabra queda en un solo rubro.
 */
export function enrichKeywords(rubros: Rubro[]): void {
  const used = new Set(rubros.flatMap((r) => r.keywords));
  const wordIn = (k: string, text: string) => new RegExp(`(^|[^a-z0-9])${k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text);
  for (const r of rubros) {
    const name = norm(r.name);
    const matches = templateKeywords().filter((t) => wordIn(norm(t.name), name) || t.keywords.some((k) => k.trim().length >= 3 && wordIn(norm(k), name)));
    if (matches.length !== 1) continue;
    for (const k of matches[0].keywords) {
      if (used.has(k)) continue;
      used.add(k);
      r.keywords.push(k);
    }
  }
}
