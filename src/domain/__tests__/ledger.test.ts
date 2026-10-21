import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { importMonthlySheet, type Cell } from '../importSheet';
import { percentLedger } from '../ledger';
import { buildIndex } from '../stats';
import { emptyData, normalizeData } from '../template';
import type { Category, Data, Movement, Rubro } from '../types';

const diezmo: Category = { id: 'd', name: 'Diezmos', kind: 'gasto', icon: 'hand-heart', color: '#000', budget: { type: 'percentIncome', pct: 10 }, order: 0 };
const ingresos: Category = { id: 'i', name: 'Ingresos', kind: 'ingreso', icon: 'm:inversiones', color: '#176B60', budget: { type: 'none' }, order: 1 };
const otros: Category = { id: 'o', name: 'Otros', kind: 'gasto', icon: 'm:otros', color: '#888', budget: { type: 'none' }, order: 2 };
const rubros: Rubro[] = [
  { id: 'diezmo', name: 'Diezmo', categoryId: 'd', keywords: [] },
  { id: 'sueldo', name: 'Sueldo', categoryId: 'i', keywords: [] },
  { id: 'varios', name: 'Varios', categoryId: 'o', keywords: [] },
];

let n = 0;
const mov = (rubroId: string, date: string, amount: number, extra: Partial<Movement> = {}): Movement => ({
  id: `m${n++}`, rubroId, date, amount, kind: rubroId === 'sueldo' ? 'ingreso' : 'gasto', origin: 'manual', createdAt: 0, ...extra,
});

function data(movements: Movement[], ledger?: Category['ledger']): Data {
  return { ...emptyData(), categories: [{ ...diezmo, ledger }, ingresos, otros], rubros, movements };
}

describe('diezmo acumulado', () => {
  const movements = [
    mov('sueldo', '2026-07-01', 100000),
    mov('diezmo', '2026-07-05', 8000),
    mov('varios', '2026-07-06', 5000),
    // Agosto: sin ingresos, se espera 0 (no el ingreso de julio); se pone al día una parte
    mov('diezmo', '2026-08-10', 1000, { origin: 'tarjeta' }),
    mov('sueldo', '2026-09-01', 120000),
    mov('diezmo', '2026-09-30', 13000, { origin: 'planilla', monthly: true }),
  ];

  it('suma mes a mes lo que faltó y lo que se dio de más, con el ingreso real de cada mes', () => {
    const d = data(movements);
    const l = percentLedger(d, buildIndex(d), 'd', '2026-09');
    expect(l.from).toBe('2026-07');
    expect(l.rows.map((r) => [r.month, r.income, r.expected, r.given, r.diff, r.pending])).toEqual([
      ['2026-07', 100000, 10000, 8000, -2000, 2000],
      ['2026-08', 0, 0, 1000, 1000, 1000],
      ['2026-09', 120000, 12000, 13000, 1000, 0],
    ]);
    expect(l.pending).toBe(0);
  });

  it('«Contar desde» y el saldo inicial', () => {
    const d = data(movements, { from: '2026-08', opening: 3000 });
    const l = percentLedger(d, buildIndex(d), 'd', '2026-09');
    expect(l.rows.map((r) => r.month)).toEqual(['2026-08', '2026-09']);
    expect(l.rows.map((r) => r.pending)).toEqual([2000, 1000]);
    expect(l.pending).toBe(1000);
    // Negativo: se había dado de más
    const ahead = data(movements, { from: '2026-09', opening: -5000 });
    expect(percentLedger(ahead, buildIndex(ahead), 'd', '2026-09').pending).toBe(-6000);
  });

  it('hasta un mes anterior a «Contar desde» no hay renglones: queda el saldo inicial', () => {
    const d = data(movements, { from: '2026-09', opening: 500 });
    const l = percentLedger(d, buildIndex(d), 'd', '2026-08');
    expect(l.rows).toEqual([]);
    expect(l.pending).toBe(500);
  });

  it('lo esperado se redondea como la moneda: el 10% de $ 186.403 son $ 18.640', () => {
    const d = data([mov('sueldo', '2026-10-01', 186403), mov('diezmo', '2026-10-02', 18640)]);
    expect(percentLedger(d, buildIndex(d), 'd', '2026-10').rows[0]).toMatchObject({ expected: 18640, pending: 0 });
    const cents = { ...d, settings: { ...d.settings, currency: { ...d.settings.currency, decimals: 2 } } };
    expect(percentLedger(cents, buildIndex(cents), 'd', '2026-10').rows[0].expected).toBe(18640.3);
  });

  it('con la planilla de ejemplo (el diezmo es el 10% redondeado) queda al día', () => {
    const wb = XLSX.read(readFileSync('datos/ejemplo.xlsx'), { cellDates: true });
    const res = importMonthlySheet(XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets['presupuesto'], { header: 1, raw: true, defval: null }));
    const d: Data = { ...emptyData(), categories: res.categories, rubros: res.rubros, movements: res.movements };
    const cat = d.categories.find((c) => c.budget.type === 'percentIncome')!;
    const l = percentLedger(d, buildIndex(d), cat.id, '2026-10');
    expect(l.rows).toHaveLength(24);
    expect(l.pending).toBe(0);
  });

  it('normalizeData descarta una cuenta con un mes que no es mes', () => {
    const d = normalizeData({ categories: [{ ...diezmo, ledger: { from: '2026-8', opening: 10 } }, { ...otros, ledger: { from: '2026-08', opening: 'x' as never } }] });
    expect(d.categories[0].ledger).toBeUndefined();
    expect('ledger' in d.categories[0]).toBe(false);
    expect(d.categories[1].ledger).toEqual({ from: '2026-08', opening: 0 });
    expect(normalizeData({ categories: [{ ...diezmo, ledger: { from: '2026-08', opening: -250 } }] }).categories[0].ledger).toEqual({ from: '2026-08', opening: -250 });
  });
});

describe('ingresos que no llevan diezmo', () => {
  it('no cuentan para lo que hay que dar', () => {
    const d = data([mov('sueldo', '2026-07-01', 100000), mov('sueldo', '2026-07-15', 20000, { noTithe: true })]);
    const l = percentLedger(d, buildIndex(d), 'd', '2026-07');
    expect(l.rows.at(-1)).toMatchObject({ income: 100000, expected: 10000 });
  });
});
