import { describe, expect, it } from 'vitest';
import { aboveAverage, cardReminders, estimateRecurring, monthForecast } from '../alerts';
import { buildIndex } from '../stats';
import { emptyData } from '../template';
import type { Category, Data, Invoice, Movement } from '../types';

const gastos: Category = { id: 'g', name: 'Gastos', kind: 'gasto', icon: 'm:otros', color: '#000', budget: { type: 'none' }, order: 0 };
const ingresos: Category = { id: 'i', name: 'Ingresos', kind: 'ingreso', icon: 'm:inversiones', color: '#000', budget: { type: 'none' }, order: 1 };
let n = 0;
const mov = (rubroId: string, date: string, amount: number, kind: Movement['kind'] = 'gasto'): Movement => ({ id: `m${n++}`, rubroId, date, amount, kind, origin: 'manual', createdAt: 0 });
const base = (movements: Movement[]): Data => ({
  ...emptyData(),
  categories: [gastos, ingresos],
  rubros: [{ id: 'ute', name: 'UTE', categoryId: 'g', keywords: [] }, { id: 'super', name: 'Súper', categoryId: 'g', keywords: [] }, { id: 'sueldo', name: 'Sueldo', categoryId: 'i', keywords: [] }],
  recurring: [{ id: 'f', rubroId: 'ute', kind: 'gasto', amount: 2000, day: 10, createdAt: 0 }],
  movements,
});

describe('fijos que varían', () => {
  const d = base([mov('ute', '2026-07-10', 2000), mov('ute', '2026-08-10', 3000), mov('ute', '2026-09-10', 4000)]);
  it('se estiman con el promedio de los últimos meses', () => {
    expect(estimateRecurring(d, d.recurring[0], '2026-10')).toBe(3000);
  });
  it('avisa si vino mucho más alto que el promedio', () => {
    expect(aboveAverage(d, 'ute', 4500, '2026-10-10')).toMatchObject({ average: 3000 });
    expect(aboveAverage(d, 'ute', 3200, '2026-10-10')).toBeNull();
  });
});

describe('¿llego a fin de mes?', () => {
  it('el día a día al ritmo de hoy, más los fijos que faltan', () => {
    const d = base([mov('sueldo', '2026-10-01', 30000, 'ingreso'), mov('super', '2026-10-05', 10000), mov('super', '2026-10-09', 5000)]);
    // 15.000 en 10 días → 46.500 en 31; más 2.000 de UTE: faltan 18.500
    const f = monthForecast(d, buildIndex(d), '2026-10-10');
    expect(f.dailyEnd).toBe(46500);
    expect(f.pendingFixed).toBe(2000);
    expect(f.end).toBe(-18500);
  });
});

describe('avisos de la tarjeta', () => {
  const inv: Invoice = { id: 'e', kind: 'estado', card: 'OCA', fileName: 'x.pdf', mime: 'application/pdf', date: '2026-09-25', items: [], due: '2026-10-08', createdAt: 0 };
  it('vence en unos días: no te olvides de pagar (salvo que ya se marcó)', () => {
    expect(cardReminders([inv], '2026-10-05').map((r) => r.kind)).toEqual(['pagar']);
    expect(cardReminders([{ ...inv, paid: true }], '2026-10-05')).toEqual([]);
  });
  it('ya pasó el cierre siguiente: subí el estado de cuenta', () => {
    expect(cardReminders([inv], '2026-10-27').map((r) => r.kind)).toEqual(['subir']);
  });
});
