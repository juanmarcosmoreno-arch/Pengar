import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { merchantKey } from '../classify';
import { splitUsdNote } from '../fx';
import { exampleData, exampleStatements, exampleStatementText } from '../example';
import { importMonthlySheet, type Cell } from '../importSheet';
import { statementCommitments } from '../installments';
import { findDuplicates, installmentsAtClosing, isSpend, normalizeMerchant, parseStatementTable, parseStatementText, planillaMonths, statementInfo, statementPeriod, type StatementTx } from '../statement';
import { applyCredits, creditTargets, dayMonth, dayMonthYear, groupSpends, knownRubro, NOT_SPEND, spendRubros, statementInstallments, statementNote } from '../statementReview';
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
  it('la cuota que va con la fecha del cierre dice de cuándo es la compra (y los dólares siguen al final)', () => {
    const cuota = tx('2026-09-25', 25, 'VIAJES ARCOIRIS', { installment: '6/12', purchaseDate: '2026-03-10', currency: 'usd' });
    expect(statementNote(cuota, 'Itaú', 40.5)).toBe('Itaú · cuota 6/12 · compra del 10/3/2026 · U$S\u00a025,00 × 40,50');
    expect(splitUsdNote(statementNote(cuota, 'Itaú', 40.5))).toEqual({ rest: 'Itaú · cuota 6/12 · compra del 10/3/2026', usd: 25, rate: 40.5 });
    expect(dayMonthYear('2025-12-01')).toBe('1/12/2025');
  });
});

describe('compras en cuotas para guardar con el estado de cuenta', () => {
  const txs = [
    tx('2026-09-25', 1250, 'COLCHONERIA DESCANSO', { installment: '7/9', purchaseDate: '2026-03-03' }),
    tx('2026-09-02', 300, 'ALMACEN'),
    tx('2026-09-25', 25, 'VIAJES ARCOIRIS', { installment: '6/12', purchaseDate: '2026-03-10', currency: 'usd' }),
    tx('2026-09-10', 900, 'OPTICA VISION', { installment: '1/3' }),
    tx('2026-09-12', 720, 'CARGO ANUAL', { installment: '1/3', kind: 'cargo' }),
    tx('2026-09-14', -300, 'DEVOLUCION OPTICA VISION', { installment: '1/3', kind: 'credito' }),
    tx('2026-09-15', 500, 'TRANSFERENCIA PEPE', { installment: '2/4' }),
    tx('2026-09-25', 400, 'MUEBLERIA LOS PINOS', { installment: '6/6', purchaseDate: '2026-04-18' }),
  ];
  const rates = txs.map((t) => (t.currency === 'usd' ? 40 : 1));
  it('compras y cargos en cuotas, en pesos, con la fecha de la compra; sin créditos ni los que no son gastos', () => {
    expect(statementInstallments(txs, rates, (t) => t.description.startsWith('TRANSFERENCIA'))).toEqual([
      { merchant: 'Colchoneria Descanso', key: 'colchoneria', amount: 1250, n: 7, of: 9, date: '2026-03-03' },
      { merchant: 'Viajes Arcoiris', key: 'viajes', amount: 1000, n: 6, of: 12, date: '2026-03-10', usd: 25, rate: 40 },
      { merchant: 'Optica Vision', key: 'optica vision', amount: 900, n: 1, of: 3, date: '2026-09-10' },
      { merchant: 'Cargo Anual', key: 'cargo', amount: 720, n: 1, of: 3, date: '2026-09-12' },
      { merchant: 'Muebleria los Pinos', key: 'muebleria', amount: 400, n: 6, of: 6, date: '2026-04-18' },
    ]);
  });
  it('en dólares sin cotización no se guarda', () => {
    expect(statementInstallments(txs, txs.map(() => 0)).map((i) => i.key)).not.toContain('viajes');
  });
  it('una planilla con varios meses trae la misma compra en cada uno (1/6, 2/6, 3/6): queda la última y se proyecta una vez', () => {
    const rows: Cell[][] = [
      ['Fecha', 'Descripción', 'Cuota', 'Importe $'],
      ['10/07/2026', 'OPTICA VISION', '1/6', '1000,00'],
      ['03/07/2026', 'SUPERMERCADO EL TREBOL', '', '500,00'],
      ['10/08/2026', 'OPTICA VISION', '2/6', '1000,00'],
      ['03/08/2026', 'SUPERMERCADO EL TREBOL', '', '500,00'],
      ['10/09/2026', 'OPTICA VISION', '3/6', '1000,00'],
      ['03/09/2026', 'SUPERMERCADO EL TREBOL', '', '500,00'],
      ['20/09/2026', 'KIOSCO', '', '200,00'],
    ];
    const read = parseStatementTable(rows, { today: '2026-10-01' });
    const period = statementPeriod(read, {});
    expect(period).toEqual({ from: '2026-07-03', to: '2026-09-20' });
    const moved = installmentsAtClosing(read, period);
    const cuotas = statementInstallments(moved, moved.map(() => 1));
    expect(cuotas.map((c) => `${c.n}/${c.of}`)).toEqual(['3/6']);
    const ahead = statementCommitments(cuotas, period!.to, { today: '2026-10-21', months: 6 });
    expect(ahead.total).toEqual([1000, 1000, 1000, 0, 0, 0]);
    expect(ahead.left).toBe(3000);
    // Dos compras iguales con la misma cuota son dos; la misma con la fecha de la compra repetida, una
    const same = [
      tx('2026-09-25', 600, 'ZAPATERIA', { installment: '2/6', purchaseDate: '2026-07-02' }),
      tx('2026-09-25', 600, 'ZAPATERIA', { installment: '2/6', purchaseDate: '2026-07-09' }),
      tx('2026-07-02', 600, 'ZAPATERIA', { installment: '1/6' }),
    ];
    expect(statementInstallments(same, same.map(() => 1)).map((c) => [c.n, c.date])).toEqual([[2, '2026-07-02'], [2, '2026-07-09']]);
  });
});

describe('estado de cuenta de ejemplo', () => {
  const today = '2026-10-21';
  const res = importMonthlySheet(JSON.parse(readFileSync('public/ejemplo.json', 'utf8')) as Cell[][]);
  const data = exampleData(res, today);
  const text = exampleStatementText(today);
  const raw = parseStatementText(text, { today });
  // Como en la app (readStatement): las cuotas de compras de antes del período, con la fecha de cierre
  const txs = installmentsAtClosing(raw, statementPeriod(raw, statementInfo(text)));

  it('se lee entero: período, tarjeta, cotización, pago, reintegro, dólares y cuotas', () => {
    const info = statementInfo(text);
    expect(info).toMatchObject({ closing: today, card: 'OCA', usdRate: 40.1 });
    expect(statementPeriod(raw, info)).toEqual({ from: '2026-09-26', to: today });
    expect(txs.filter((t) => t.kind === 'pago')).toHaveLength(1);
    expect(txs.find((t) => t.kind === 'credito')).toMatchObject({ key: 'reintegro', amount: -48.6 });
    expect(txs.filter((t) => t.currency === 'usd').map((t) => t.key)).toEqual(['netflix', 'spotify']);
    // Dos con la fecha de la compra (una pegada al comercio, como en Scotiabank), una que sigue y una nueva
    expect(txs.filter((t) => t.installment).map((t) => [t.merchant, t.installment, t.date, t.purchaseDate ?? ''])).toEqual([
      ['Muebleria los Alamos', '3/10', today, '2026-08-10'],
      ['Bicicleteria la Rueda', '2/6', today, '2026-09-10'],
      ['Farmashop', '2/3', '2026-10-09', ''],
      ['Jugueteria el Tren', '1/3', '2026-10-17', ''],
    ]);
    expect(txs.every((t) => t.date >= '2026-09-26' && t.date <= today)).toBe(true);
  });

  it('las cuotas siguen las del estado de cuenta anterior de OCA (con la misma fecha de compra)', () => {
    const oca = exampleStatements(today).find((i) => i.card === 'OCA')!;
    const now = statementInstallments(txs, txs.map(() => 40.1));
    for (const before of oca.installments!) {
      const next = now.find((i) => i.key === before.key)!;
      expect([next.n, next.of, next.amount]).toEqual([before.n + 1, before.of, before.amount]);
      // Las que vienen con la fecha de la compra guardan esa (Farmashop trae la de la cuota)
      if (txs.find((t) => t.key === before.key)!.purchaseDate) expect(next.date).toBe(before.date);
    }
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
      'Muebleria los Alamos': null,
      'Bicicleteria la Rueda': null,
      // Por las palabras del rubro
      'Jugueteria el Tren': 'Regalos',
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
