import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { merchantKey } from '../classify';
import { exampleData, exampleStatementText } from '../example';
import { importMonthlySheet, type Cell } from '../importSheet';
import { findDuplicates, isSpend, normalizeMerchant, parseStatementText, planillaMonths, statementInfo, statementPeriod, type StatementTx } from '../statement';
import { applyCredits, creditTargets, dayMonth, groupSpends, knownRubro, NOT_SPEND, spendRubros, statementNote } from '../statementReview';
import { templateData } from '../template';

function tx(date: string, amount: number, description: string, extra: Partial<StatementTx> = {}): StatementTx {
  return { date, amount, description, ...normalizeMerchant(description), currency: 'local', kind: 'compra', ...extra };
}

describe('agrupar por comercio', () => {
  it('compras y cargos por clave, en orden; sin pagos, créditos ni los que van aparte', () => {
    const txs = [
      tx('2026-10-01', 1000, 'TIENDA INGLESA SUC 12'),
      tx('2026-10-02', -5000, 'SU PAGO', { kind: 'pago' }),
      tx('2026-10-03', 500, 'NETFLIX.COM', { currency: 'usd' }),
      tx('2026-10-04', 300, 'TIENDA INGLESA 7'),
      tx('2026-10-05', -45, 'REINTEGRO IVA', { kind: 'credito' }),
      tx('2026-10-06', 120, 'INTERESES', { kind: 'cargo' }),
      tx('2026-10-07', 200, 'TIENDA INGLESA 3'),
    ];
    const groups = groupSpends(txs, (i) => i === 6);
    expect(groups.map((g) => [g.key, g.merchant, g.idx])).toEqual([
      ['tienda inglesa', 'Tienda Inglesa', [0, 3]],
      ['netflix', 'Netflix', [2]],
      ['intereses', 'Intereses', [5]],
    ]);
    expect(groups[0].description).toBe('TIENDA INGLESA SUC 12');
  });
});

describe('lo que ya se sabe de un comercio', () => {
  const t = templateData();
  const rubros = spendRubros(t.rubros, t.categories);
  const id = (name: string) => t.rubros.find((r) => r.name === name)!.id;

  it('solo rubros de gasto', () => {
    expect(rubros.some((r) => r.name === 'Sueldo')).toBe(false);
    expect(rubros.some((r) => r.name === 'Supermercado')).toBe(true);
  });
  it('primero lo aprendido para el comercio, aunque una palabra clave diga otra cosa', () => {
    const learned = { [merchantKey('DISCO 5')]: id('Farmacia') };
    expect(knownRubro(tx('2026-10-01', 1, 'DISCO 7 POCITOS'), rubros, learned)).toEqual({ rubroId: id('Farmacia'), reason: 'aprendido' });
    expect(knownRubro(tx('2026-10-01', 1, 'DEVOTO 22'), rubros, learned)).toEqual({ rubroId: id('Supermercado'), reason: 'palabra' });
    expect(knownRubro(tx('2026-10-01', 1, 'LA PASIVA'), rubros, learned)).toBeNull();
  });
  it('«no es un gasto» queda recordado; un rubro borrado no cuenta', () => {
    const learned = { [merchantKey('TRANSFERENCIA BROU')]: NOT_SPEND, [merchantKey('LA PASIVA')]: 'r-borrado' };
    expect(knownRubro(tx('2026-10-01', 1, 'TRANSFERENCIA BROU'), rubros, learned)).toBe(NOT_SPEND);
    expect(knownRubro(tx('2026-10-01', 1, 'MERCADOPAGO*LA PASIVA'), rubros, learned)).toBeNull();
  });
});

describe('restar créditos', () => {
  const items = [
    { key: 'ti', date: '2026-10-03' },
    { key: 'ti', date: '2026-10-11' },
    { key: 'nf', date: '2026-10-05' },
    { key: 'zara', date: '2026-10-12' },
  ];
  it('una devolución sale de la compra del mismo comercio más cercana de antes', () => {
    expect(applyCredits([1000, 300, 500, 3290], items, [{ key: 'ti', date: '2026-10-12', amount: -130 }])).toEqual([1000, 170, 500, 3290]);
    expect(creditTargets(items, { key: 'ti', date: '2026-10-05' })).toEqual([0, 1]);
  });
  it('el reintegro de IVA, de la compra de ese día o la anterior; si no alcanza, de la siguiente', () => {
    expect(applyCredits([1000, 300, 500, 3290], items, [{ key: 'reintegro', date: '2026-10-12', amount: -48.6 }])).toEqual([1000, 300, 500, 3241.4]);
    expect(applyCredits([1000, 300, 500, 3290], items, [{ key: 'reintegro', date: '2026-10-06', amount: -600 }])).toEqual([900, 300, 0, 3290]);
    // Antes de todas las compras: la más cercana de después
    expect(creditTargets(items, { key: 'reintegro', date: '2026-10-01' })[0]).toBe(0);
  });
  it('nunca en negativo; sin compras no hace nada', () => {
    expect(applyCredits([100, 50], [{ key: 'a', date: '2026-10-01' }, { key: 'b', date: '2026-10-02' }], [{ key: 'a', date: '2026-10-03', amount: -400 }])).toEqual([0, 50]);
    expect(applyCredits([], [], [{ key: 'a', date: '2026-10-01', amount: -40 }])).toEqual([]);
  });
});

describe('nota del gasto', () => {
  it('tarjeta, cuota y la cuenta en dólares', () => {
    expect(statementNote(tx('2026-10-01', 12.99, 'NETFLIX.COM', { currency: 'usd' }), 'OCA', 40)).toBe('OCA · U$S\u00a012,99 × 40,00');
    expect(statementNote(tx('2026-10-01', 1500, 'FARMASHOP', { installment: '2/3' }), 'Visa BROU', 40.1)).toBe('Visa BROU · cuota 2/3');
    expect(statementNote(tx('2026-10-01', 4.99, 'STEAM', { currency: 'usd' }), undefined, 40.25)).toBe('U$S\u00a04,99 × 40,25');
    expect(statementNote(tx('2026-10-01', 100, 'DISCO'), undefined, 40)).toBeUndefined();
    expect(dayMonth('2026-08-06')).toBe('6/8');
  });
});

describe('estado de cuenta de ejemplo', () => {
  const today = '2026-10-21';
  const res = importMonthlySheet(JSON.parse(readFileSync('public/ejemplo.json', 'utf8')) as Cell[][]);
  const data = exampleData(res, today);
  const text = exampleStatementText(today);
  const txs = parseStatementText(text, { today });

  it('se lee entero: período, tarjeta, cotización, pago, reintegro, dólares y cuota', () => {
    const info = statementInfo(text);
    expect(info).toMatchObject({ closing: today, card: 'OCA', usdRate: 40.1 });
    expect(statementPeriod(txs, info)).toEqual({ from: '2026-09-26', to: today });
    expect(txs.filter((t) => t.kind === 'pago')).toHaveLength(1);
    expect(txs.find((t) => t.kind === 'credito')).toMatchObject({ key: 'reintegro', amount: -48.6 });
    expect(txs.filter((t) => t.currency === 'usd').map((t) => t.key)).toEqual(['netflix', 'spotify']);
    expect(txs.find((t) => t.installment)).toMatchObject({ merchant: 'Farmashop', installment: '2/3' });
    expect(txs.every((t) => t.date >= '2026-09-26' && t.date <= today)).toBe(true);
  });

  it('con los rubros del ejemplo: algunos conocidos, otros nuevos', () => {
    const rubros = spendRubros(data.rubros, data.categories);
    const name = (id: string) => data.rubros.find((r) => r.id === id)?.name;
    const known = new Map<string, string | null>();
    for (const g of groupSpends(txs)) {
      const k = knownRubro(txs[g.idx[0]], rubros, data.settings.learned);
      known.set(g.merchant, k && k !== NOT_SPEND ? name(k.rubroId)! : null);
    }
    expect(Object.fromEntries(known)).toEqual({
      'Tienda Inglesa': 'Supermercado',
      'La Pasiva': null,
      Netflix: 'Netflix',
      'Panaderia la Espiga': null,
      'Uber Trip': null,
      Zara: 'Ropa',
      Farmashop: 'Farmacia',
      'Movie Center': null,
      'Ferreteria el Tornillo': null,
      'Pedidosya Burger King': 'Comer afuera',
      Spotify: 'Spotify',
    });
  });

  it('dos compras ya anotadas este mes y el mes pasado con los totales de la planilla', () => {
    const dups = findDuplicates(txs, data.movements, 40.1);
    expect([...dups.keys()].map((i) => [txs[i].key, txs[i].amount])).toEqual([['tienda inglesa', 3870], ['farmashop', 690]]);
    expect(planillaMonths(txs, data.movements)).toEqual(['2026-09']);
    expect(txs.filter(isSpend).length).toBeGreaterThanOrEqual(15);
  });

  it('cualquier día del mes: las fechas se acomodan y los repetidos siguen siendo los mismos', () => {
    for (const day of ['2026-11-01', '2026-11-10', '2027-02-28', '2027-03-31']) {
      const d = exampleData(res, day);
      const list = parseStatementText(exampleStatementText(day), { today: day });
      expect(list.filter(isSpend).length).toBeGreaterThanOrEqual(15);
      const dups = findDuplicates(list, d.movements, 40.1);
      expect([...dups.keys()].map((i) => list[i].key).sort()).toEqual(['farmashop', 'tienda inglesa']);
    }
  });
});
