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

describe('pasar los gastos guardados al día del pago', () => {
  it('cambia la fecha, guarda la de la compra y la pone en la nota (los dólares siguen al final)', async () => {
    const { movementsToPayDay } = await import('../statementReview');
    const out = movementsToPayDay([
      { date: '2026-09-28', note: 'OCA' },
      { date: '2026-10-02', note: 'OCA · U$S 10,00 × 40,10' },
      { date: '2026-10-08', note: 'OCA' },
    ], '2026-10-08');
    expect(out[0]).toEqual({ date: '2026-10-08', purchased: '2026-09-28', note: 'OCA · compra del 28/9/2026' });
    expect(out[1].note).toMatch(/^OCA · compra del 2\/10\/2026 · U\$S.+10 × 40,10$/);
    expect(out[2]).toEqual({ date: '2026-10-08', note: 'OCA' });
  });
});
