import { describe, expect, it } from 'vitest';
import { applySplits } from '../statementReview';

describe('un comercio repartido en varios rubros', () => {
  it('cada parte sale del gasto más grande y lo que queda sigue en el rubro elegido', () => {
    const list = [
      { group: 'macro', amount: 3000, rubroId: 'alim', date: '2026-10-05' },
      { group: 'macro', amount: 1000, rubroId: 'alim', date: '2026-10-20' },
      { group: 'ute', amount: 2000, rubroId: 'luz', date: '2026-10-10' },
    ];
    const out = applySplits(list, { macro: [{ rubroId: 'limp', amount: 800 }] });
    expect(out).toEqual([
      { amount: 2200, rubroId: 'alim', date: '2026-10-05' },
      { amount: 1000, rubroId: 'alim', date: '2026-10-20' },
      { amount: 2000, rubroId: 'luz', date: '2026-10-10' },
      { amount: 800, rubroId: 'limp', date: '2026-10-05' },
    ]);
  });
  it('una parte más grande que un gasto sigue con el siguiente', () => {
    const out = applySplits([{ group: 'm', amount: 500, rubroId: 'a' }, { group: 'm', amount: 400, rubroId: 'a' }], { m: [{ rubroId: 'b', amount: 700 }] });
    expect(out.reduce((s, m) => s + m.amount, 0)).toBe(900);
    expect(out.filter((m) => m.rubroId === 'b').reduce((s, m) => s + m.amount, 0)).toBe(700);
  });
});
