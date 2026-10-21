import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { importMonthlySheet, type Cell } from '../importSheet';
import { monthReport, pendingReport } from '../report';
import { buildIndex } from '../stats';
import { emptyData, normalizeData } from '../template';
import type { Category, Data, Movement, Recurring, Rubro } from '../types';

const cat = (id: string, name: string, extra: Partial<Category> = {}): Category => ({
  id, name, kind: 'gasto', icon: 'm:otros', color: '#888', budget: { type: 'none' }, order: 0, ...extra,
});
const categories: Category[] = [
  cat('ali', 'Alimentación', { budget: { type: 'fixed', amount: 20000 } }),
  cat('sal', 'Salidas', { budget: { type: 'fixed', amount: 5000 } }),
  cat('fij', 'Fijos', { budget: { type: 'fixed', amount: 30000 } }),
  cat('die', 'Diezmos', { budget: { type: 'percentIncome', pct: 10 } }),
  cat('aho', 'Ahorro', { savings: true, budget: { type: 'fixed', amount: 10000 } }),
  cat('ing', 'Ingresos', { kind: 'ingreso' }),
];
const rubros: Rubro[] = [
  ['super', 'ali'], ['feria', 'ali'], ['cine', 'sal'], ['alquiler', 'fij'], ['ute', 'fij'], ['netflix', 'fij'], ['diezmo', 'die'], ['ahorro', 'aho'], ['sueldo', 'ing'],
].map(([id, categoryId]) => ({ id, name: id, categoryId, keywords: [] }));

let n = 0;
const mov = (rubroId: string, date: string, amount: number, extra: Partial<Movement> = {}): Movement => ({
  id: `m${n++}`, rubroId, date, amount, kind: rubroId === 'sueldo' ? 'ingreso' : 'gasto', origin: 'manual', createdAt: 0, ...extra,
});
const rec = (rubroId: string, extra: Partial<Recurring> = {}): Recurring => ({ id: `r-${rubroId}`, rubroId, kind: 'gasto', amount: 1000, day: 5, createdAt: 0, ...extra });

const base = (movements: Movement[], extra: Partial<Data> = {}): Data => ({ ...emptyData(), categories, rubros, movements, ...extra });

const september = [
  mov('sueldo', '2026-09-01', 100000),
  mov('alquiler', '2026-09-02', 24000),
  mov('super', '2026-09-04', 9000),
  mov('feria', '2026-09-08', 2500),
  mov('cine', '2026-09-12', 8200),
  mov('diezmo', '2026-09-03', 9000),
  mov('ahorro', '2026-09-05', 15000),
];
// Los meses anteriores: agosto 50.000; de marzo a julio, 40.000 cada uno (y uno vacío en el medio)
const before = [
  mov('alquiler', '2026-08-02', 50000),
  ...['2026-02', '2026-03', '2026-04', '2026-06', '2026-07'].map((m) => mov('alquiler', `${m}-02`, 40000)),
  mov('alquiler', '2025-12-02', 99999),
];

describe('resumen del mes', () => {
  const d = base([...september, ...before]);
  const r = monthReport(d, buildIndex(d), '2026-09');

  it('ingresos, gastos sin ahorro, ahorro y balance', () => {
    expect(r.income).toBe(100000);
    expect(r.expense).toBe(52700);
    expect(r.savings).toBe(15000);
    expect(r.balance).toBe(47300);
    expect(r.movements).toBe(7);
    expect(r.onlySheet).toBe(false);
  });

  it('contra el presupuesto: las que se pasaron y las que quedaron debajo, ordenadas (sin el ahorro)', () => {
    expect(r.budget!.total).toBe(65000);
    expect(r.budget!.spent).toBe(52700);
    expect(r.budget!.over.map((l) => [l.category.name, l.diff])).toEqual([['Salidas', 3200]]);
    expect(r.budget!.under.map((l) => [l.category.name, l.diff])).toEqual([['Alimentación', -8500], ['Fijos', -6000], ['Diezmos', -1000]]);
    expect(r.budget!.under.find((l) => l.category.name === 'Diezmos')!.percent).toBe(true);
  });

  it('las 3 categorías y los 3 gastos más grandes', () => {
    expect(r.top.map((g) => g.name)).toEqual(['Fijos', 'Alimentación', 'Diezmos']);
    expect(r.biggest.map((m) => m.amount)).toEqual([24000, 9000, 9000]);
    expect(r.biggestFromSheet).toBe(false);
    expect(r.hasSheet).toBe(false);
    // Con totales de la planilla y gastos sueltos, van los sueltos
    const mixed = base([...september, mov('alquiler', '2026-09-01', 50000, { origin: 'planilla', monthly: true })]);
    const m = monthReport(mixed, buildIndex(mixed), '2026-09');
    expect(m.biggest.map((x) => x.amount)).toEqual([24000, 9000, 9000]);
    expect(m.hasSheet).toBe(true);
    expect(m.biggestFromSheet).toBe(false);
  });

  it('contra el mes anterior y el promedio de los 6 meses anteriores con gastos', () => {
    expect(r.prev).toMatchObject({ month: '2026-08', expense: 50000 });
    expect(r.prev!.change).toBeCloseTo(0.054);
    // Agosto, julio, junio, abril, marzo y febrero (mayo no tiene gastos; diciembre ya queda afuera)
    expect(r.average!.months).toBe(6);
    expect(r.average!.expense).toBeCloseTo((50000 + 5 * 40000) / 6);
  });

  it('el diezmo del mes con su acumulado', () => {
    expect(r.percent).toHaveLength(1);
    expect(r.percent[0]).toMatchObject({ income: 100000, expected: 10000, given: 9000, diff: -1000 });
    // Diciembre de 2025 es el primer mes con datos: los meses sin ingresos esperan 0
    expect(r.percent[0].from).toBe('2025-12');
    expect(r.percent[0].pending).toBe(1000);
  });

  it('el suricata: festeja, contento, pensando o preocupado', () => {
    expect(r.mood).toBe('contento');
    const ok = base(september.filter((m) => m.rubroId !== 'cine'));
    expect(monthReport(ok, buildIndex(ok), '2026-09').mood).toBe('celebrando');
    // Dar de más en el diezmo no cuenta como pasarse
    const generous = base([...ok.movements, mov('diezmo', '2026-09-20', 5000)]);
    const g = monthReport(generous, buildIndex(generous), '2026-09');
    expect(g.budget!.over.map((l) => l.category.name)).toEqual(['Diezmos']);
    expect(g.mood).toBe('celebrando');
    const tight = base([mov('sueldo', '2026-09-01', 100000), mov('alquiler', '2026-09-02', 98000)]);
    expect(monthReport(tight, buildIndex(tight), '2026-09').mood).toBe('pensando');
    const bad = base([mov('sueldo', '2026-09-01', 100000), mov('alquiler', '2026-09-02', 120000)]);
    expect(monthReport(bad, buildIndex(bad), '2026-09').mood).toBe('preocupado');
  });

  it('gastos fijos anotados, salteados y sin anotar (los creados después no cuentan)', () => {
    const october = new Date('2026-10-05T12:00:00').getTime();
    const withRec = base(september, {
      recurring: [
        rec('alquiler', { doneThrough: '2026-09' }),
        rec('netflix', { doneThrough: '2026-09' }),
        rec('ute', { doneThrough: '2026-08' }),
        rec('sueldo', { kind: 'ingreso' }),
        rec('feria', { paused: true }),
        rec('cine', { createdAt: october }),
      ],
    });
    const f = monthReport(withRec, buildIndex(withRec), '2026-09').recurring;
    expect(f.recorded.map((x) => x.rubroId)).toEqual(['alquiler', 'sueldo', 'feria']);
    expect(f.skipped.map((x) => x.rubroId)).toEqual(['netflix']);
    expect(f.missing.map((x) => x.rubroId)).toEqual(['ute']);
  });

  it('un mes que solo tiene los totales de la planilla', () => {
    const wb = XLSX.read(readFileSync('datos/ejemplo.xlsx'), { cellDates: true });
    const res = importMonthlySheet(XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets['presupuesto'], { header: 1, raw: true, defval: null }));
    const sheet: Data = { ...emptyData(), categories: res.categories, rubros: res.rubros, movements: res.movements };
    const s = monthReport(sheet, buildIndex(sheet), '2026-09');
    expect(s.onlySheet).toBe(true);
    expect(s.biggestFromSheet).toBe(true);
    expect(s.biggest).toHaveLength(3);
    expect(s.biggest.every((m) => m.monthly)).toBe(true);
    expect(s.income).toBeGreaterThan(0);
    expect(s.expense).toBeGreaterThan(0);
    expect(s.top).toHaveLength(3);
    expect(s.prev).not.toBeNull();
    expect(s.average!.months).toBe(6);
    expect(s.percent[0].pending).toBe(0);
    expect(s.budget).not.toBeNull();
  });
});

describe('cuándo Inicio ofrece el resumen', () => {
  const d = base(september);
  it('desde el 1 hasta que se abre, si el mes pasado tiene datos', () => {
    expect(pendingReport(d, '2026-10-01')).toBe('2026-09');
    expect(pendingReport(d, '2026-10-28')).toBe('2026-09');
    expect(pendingReport({ ...d, settings: { ...d.settings, lastReportSeen: '2026-09' } }, '2026-10-01')).toBeNull();
    expect(pendingReport({ ...d, settings: { ...d.settings, lastReportSeen: '2026-08' } }, '2026-10-01')).toBe('2026-09');
    // Noviembre: octubre no tiene datos
    expect(pendingReport(d, '2026-11-02')).toBeNull();
  });
  it('normalizeData valida lo guardado', () => {
    const s = (settings: object) => normalizeData({ settings: { ...emptyData().settings, ...settings } }).settings;
    expect(s({ lastReportSeen: '2026-09' }).lastReportSeen).toBe('2026-09');
    expect(s({ lastReportSeen: '2026-13' }).lastReportSeen).toBeUndefined();
    expect(s({ lastReportSeen: 202609 }).lastReportSeen).toBeUndefined();
    // El aviso del día 1 pasó a los ajustes de este teléfono (lib/device): sale de los datos
    expect(s({ reportReminder: true })).not.toHaveProperty('reportReminder');
  });
});
