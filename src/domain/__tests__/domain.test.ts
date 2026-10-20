import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { suggestRubro, learnFrom } from '../classify';
import { importMonthlySheet, importMovementSheet, isMonthlySheet, type Cell } from '../importSheet';
import { distributeTotal, parseInvoiceText } from '../invoice';
import { parseAmount, formatMoney } from '../money';
import { buildIndex, groupTotals, kpis, monthSummary, percentCards, stack } from '../stats';
import { emptyData, templateData } from '../template';
import type { Data } from '../types';

function sheetRows(file = 'datos/ejemplo.xlsx'): Cell[][] {
  const wb = XLSX.read(readFileSync(file), { cellDates: true });
  return XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets['presupuesto'], { header: 1, raw: true, defval: null });
}

describe('montos', () => {
  it('lee formatos comunes', () => {
    expect(parseAmount('1.240')).toBe(1240);
    expect(parseAmount('$ 1.234,50')).toBe(1234.5);
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount('12,5')).toBe(12.5);
    expect(parseAmount('980')).toBe(980);
    expect(parseAmount('abc')).toBeNull();
  });
  it('formatea con miles', () => {
    expect(formatMoney(28450)).toBe('$ 28.450');
    expect(formatMoney(-1240)).toBe('- $ 1.240');
  });
});

describe('planilla mensual (datos/ejemplo.xlsx)', () => {
  const rows = sheetRows();
  it('reconoce el formato', () => expect(isMonthlySheet(rows)).toBe(true));
  const res = importMonthlySheet(rows);
  const data: Data = { ...emptyData(), categories: res.categories, rubros: res.rubros, movements: res.movements };
  const ix = buildIndex(data);
  const rowOf = (name: string) => rows.find((r) => r[0] === name)!;
  it('importa rubros, categorías y meses', () => {
    expect(res.months[0]).toBe('2024-11');
    expect(res.months.at(-1)).toBe('2026-10');
    expect(res.rubros.find((r) => r.name === 'UTE')).toBeTruthy();
    expect(res.categories.find((c) => c.name === 'Fijos')!.budget).toEqual({ type: 'fixed', amount: 35000 });
    expect(res.categories.find((c) => c.name.startsWith('Diezmos'))!.budget).toEqual({ type: 'percentIncome', pct: 10 });
    expect(res.categories.find((c) => c.name.startsWith('Inversi'))!.savings).toBe(true);
    expect(res.categories.find((c) => c.kind === 'ingreso')!.name).toBe('Ingresos');
    expect(res.warnings).toEqual([]);
  });
  it('las cuentas coinciden con TOTAL e ingresos de la planilla', () => {
    for (const [col, month] of [[2, '2024-11'], [13, '2025-10'], [25, '2026-10']] as const) {
      const k = kpis(data, ix, { from: month, to: month, includeSavings: true });
      expect(k.expense).toBe(rowOf('TOTAL')[col]);
      expect(k.income).toBe(rowOf('Entrada')[col]);
    }
  });
  it('mes, porcentaje del ingreso y agrupaciones', () => {
    const s = monthSummary(data, ix, '2026-09', true);
    expect(s.rows.length).toBeGreaterThan(5);
    const card = percentCards(data, ix, '2026-09')[0];
    expect(card.expected).toBeCloseTo((rowOf('Entrada')[24] as number) * 0.1, 1);
    expect(card.real).toBe(rowOf('Diezmo')[24]);
    const g = groupTotals(data, ix, { from: '2024-11', to: '2026-10', includeSavings: false }, 'category');
    expect(g[0].total).toBeGreaterThan(g[1].total);
    expect(g.some((x) => x.name.startsWith('Inversi'))).toBe(false);
    const st = stack(data, ix, { from: '2025-01', to: '2025-12', includeSavings: true }, 'category');
    expect(st.series.length).toBeLessThanOrEqual(8);
    expect(st.rows.length).toBe(12);
  });
});

// Con la planilla real (no está en el repositorio): se prueba solo si está en datos/presupuesto.xlsx
describe.skipIf(!existsSync('datos/presupuesto.xlsx'))('planilla real', () => {
  it('importa sin avisos y cuadra con TOTAL', () => {
    const rows = sheetRows('datos/presupuesto.xlsx');
    const res = importMonthlySheet(rows);
    expect(res.warnings).toEqual([]);
    const data: Data = { ...emptyData(), categories: res.categories, rubros: res.rubros, movements: res.movements };
    const k = kpis(data, buildIndex(data), { from: res.months[0], to: res.months[0], includeSavings: true });
    expect(Math.round(k.expense * 10) / 10).toBe(Math.round((rows.find((r) => r[0] === 'TOTAL')![2] as number) * 10) / 10);
  });
});

describe('movimientos sueltos', () => {
  it('importa CSV y crea lo que falta', () => {
    const t = templateData();
    const res = importMovementSheet([
      ['Fecha', 'Rubro', 'Categoría', 'Monto', 'Tipo'],
      ['13/10/2026', 'Supermercado', 'Alimentación', '1.240', 'gasto'],
      ['2026-10-01', 'Sueldo', 'Ingresos', 90000, 'ingreso'],
      ['2026-10-02', 'Veterinaria', 'Mascotas', 800, ''],
    ], t);
    expect(res.movements).toHaveLength(3);
    expect(res.movements[0].date).toBe('2026-10-13');
    expect(res.movements[0].amount).toBe(1240);
    expect(res.movements[1].kind).toBe('ingreso');
    expect(res.categories.map((c) => c.name)).toEqual(['Mascotas']);
  });
});

describe('facturas', () => {
  const ticket = `TIENDA INGLESA
S.A. RUT 210000000012
e-Ticket Serie A Nro 123456
Fecha: 13/10/2026 09:14
LECHE CONAPROLE 1L 2 x 45,00 90,00
PAN FLAUTA 60,00
DETERGENTE NEVEX 250,00
DESC. PROMO -20,00
SUBTOTAL 380,00
IVA 22% 68,52
TOTAL
380,00
TARJETA VISA 380,00`;
  it('saca comercio, fecha, total y renglones', () => {
    const p = parseInvoiceText(ticket);
    expect(p.merchant).toBe('TIENDA INGLESA');
    expect(p.date).toBe('2026-10-13');
    expect(p.total).toBe(380);
    expect(p.items.map((i) => [i.description, i.amount])).toEqual([
      ['LECHE CONAPROLE 1L', 90], ['PAN FLAUTA', 60], ['DETERGENTE NEVEX', 250], ['DESC. PROMO', -20],
    ]);
  });
  it('factura de servicio', () => {
    const p = parseInvoiceText(`UTE
Administración Nacional de Usinas
Fecha de emisión 05/10/2026  Vencimiento 25/10/2026
Cargo fijo 350,50
Energía consumida 1.820,00
IVA 22% 554,51
Total a pagar $ 3.075,01`);
    expect(p.total).toBe(3075.01);
    expect(p.date).toBe('2026-10-05');
    expect(p.items.length).toBe(2);
  });
  it('reparte el total en proporción', () => {
    const m = distributeTotal(new Map([['a', 100], ['b', 300]]), 488);
    expect(m.get('a')).toBe(122);
    expect(m.get('b')).toBe(366);
  });
  it('sugiere y aprende rubros', () => {
    const t = templateData();
    const sup = t.rubros.find((r) => r.name === 'Supermercado')!;
    const lim = t.rubros.find((r) => r.name === 'Artículos de limpieza')!;
    expect(suggestRubro('LECHE CONAPROLE', 'TIENDA INGLESA', t.rubros, {})?.rubroId).toBe(sup.id);
    expect(suggestRubro('DETERGENTE NEVEX', 'TIENDA INGLESA', t.rubros, {})?.rubroId).toBe(lim.id);
    const ute = t.rubros.find((r) => r.name === 'Luz')!;
    expect(suggestRubro('Cargo fijo', 'UTE', t.rubros, {})?.rubroId).toBe(ute.id);
    const learned = learnFrom({}, 'Kiosco Pepe', [{ description: 'Yerba Canarias', rubroId: sup.id }]);
    expect(suggestRubro('Yerba Canarias 1kg', undefined, t.rubros, learned)?.reason).toBe('aprendido');
    expect(suggestRubro('Algo raro', 'Kiosco Pepe', t.rubros, learned)?.rubroId).toBe(sup.id);
  });
});
