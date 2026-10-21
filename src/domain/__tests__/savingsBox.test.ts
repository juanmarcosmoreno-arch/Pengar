import { describe, expect, it } from 'vitest';
import { savingsBalance } from '../savingsBox';
import { buildIndex } from '../stats';
import { emptyData } from '../template';
import type { Category, Data, Movement } from '../types';

const ahorro: Category = { id: 'a', name: 'Ahorro', kind: 'gasto', icon: 'm:ahorro', color: '#000', budget: { type: 'none' }, order: 0, savings: true };
const ingresos: Category = { id: 'i', name: 'Ingresos', kind: 'ingreso', icon: 'm:inversiones', color: '#000', budget: { type: 'none' }, order: 1 };
const mov = (rubroId: string, kind: Movement['kind'], amount: number, createdAt: number, note?: string): Movement =>
  ({ id: `m${createdAt}`, rubroId, kind, amount, date: '2026-10-10', origin: 'manual', createdAt, note });

describe('saldo del ahorro', () => {
  it('el escrito a mano, más lo ahorrado después, menos lo pasado al mes (pesos y dólares)', () => {
    const d: Data = {
      ...emptyData(),
      categories: [ahorro, ingresos],
      rubros: [{ id: 'ra', name: 'Ahorro', categoryId: 'a', keywords: [] }, { id: 'del', name: 'Del ahorro', categoryId: 'i', keywords: [] }],
      movements: [
        mov('ra', 'gasto', 5000, 50),
        mov('ra', 'gasto', 3000, 200),
        mov('del', 'ingreso', 2000, 300),
        mov('del', 'ingreso', 4010, 400, 'Del ahorro · U$S 100 × 40,10'),
      ],
      settings: { ...emptyData().settings, savingsBox: { pesos: 10000, usd: 500, at: 100, rubroId: 'del' } },
    };
    expect(savingsBalance(d, buildIndex(d), d.settings.savingsBox)).toEqual({ pesos: 11000, usd: 400 });
  });
});
