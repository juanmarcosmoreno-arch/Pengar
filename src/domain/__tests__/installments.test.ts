import { describe, expect, it } from 'vitest';
import {
  cardName,
  cardOrder,
  chosenCard,
  commitments,
  firstInstallmentMonth,
  hasUnnamedStatement,
  invoiceInstallments,
  isStale,
  knownCards,
  latestCuotas,
  latestStatements,
  missingStatement,
  nextMonthOutlook,
  nextStatementMonth,
  noteInstallment,
  renameCardOf,
  sameCard,
  sameNameOtherCard,
  simulatePurchase,
  splitPurchase,
  statementCommitments,
} from '../installments';
import { normalizeMerchant } from '../statement';
import { emptyData, normalizeData, templateData } from '../template';
import type { Data, Invoice, InvoiceInstallment, Movement, Recurring } from '../types';

// Datos inventados

const t = templateData();
const rid = (name: string) => t.rubros.find((r) => r.name === name)!.id;

let k = 0;
const inst = (merchant: string, amount: number, n: number, of: number, date: string, extra: Partial<InvoiceInstallment> = {}): InvoiceInstallment => ({
  merchant, key: normalizeMerchant(merchant).key, amount, n, of, date, ...extra,
});
function estado(card: string | undefined, date: string, installments?: unknown[], extra: Partial<Invoice> = {}): Invoice {
  k++;
  return {
    id: `f${k}`, kind: 'estado', ...(card ? { card } : {}), fileName: 'estado.pdf', mime: 'application/pdf', date, items: [], createdAt: 1000 + k,
    ...(installments ? { installments: installments as InvoiceInstallment[] } : {}),
    ...extra,
  };
}
function mov(date: string, amount: number, rubro: string, extra: Partial<Movement> = {}): Movement {
  k++;
  return { id: `m${k}`, date, amount, kind: 'gasto', rubroId: rid(rubro), origin: 'manual', createdAt: k, ...extra };
}
function fijo(rubro: string, amount: number, extra: Partial<Recurring> = {}): Recurring {
  k++;
  return { id: `rec${k}`, rubroId: rid(rubro), kind: 'gasto', amount, day: 5, createdAt: k, ...extra };
}
const data = (extra: Partial<Data>): Data => normalizeData({ ...emptyData(), ...t, ...extra });

const TODAY = '2026-10-21';

describe('planes por tarjeta', () => {
  const viejo = estado('Itaú', '2026-08-28', [inst('Colchoneria Descanso', 1250, 6, 9, '2026-03-03'), inst('Comercio Viejo', 999, 1, 12, '2026-08-01')]);
  const ultimo = estado('Itaú', '2026-09-28', [
    inst('Colchoneria Descanso', 1250, 7, 9, '2026-03-03'),
    inst('Optica Vision', 900, 1, 3, '2026-09-10'),
    inst('Muebleria los Pinos', 400, 6, 6, '2026-04-18'),
    inst('Viajes Arcoiris', 1000, 6, 12, '2026-03-10', { usd: 25, rate: 40 }),
  ]);
  const d = data({ invoices: [ultimo, viejo] });
  const c = commitments(d, { today: TODAY });

  it('del último estado de cuenta, cada cuota que sigue: monto, cuánto falta y en qué mes termina', () => {
    expect(c.months).toHaveLength(12);
    expect(c.months[0]).toBe('2026-10');
    expect(c.months[11]).toBe('2027-09');
    expect(c.cards).toHaveLength(1);
    const card = c.cards[0];
    expect(card).toMatchObject({ card: 'Itaú', invoiceId: ultimo.id, closing: '2026-09-28', stale: false });
    expect(card.plans.map((p) => [p.merchant, p.amount, p.n, p.of, p.months, p.left, p.ends])).toEqual([
      ['Colchoneria Descanso', 1250, 7, 9, ['2026-10', '2026-11'], 2500, '2026-11'],
      ['Optica Vision', 900, 1, 3, ['2026-10', '2026-11'], 1800, '2026-11'],
      ['Viajes Arcoiris', 1000, 6, 12, ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'], 6000, '2027-03'],
    ]);
    // La última cuota (6/6) ya no sigue; la de dólares lleva su cuenta
    expect(card.plans.find((p) => p.merchant === 'Viajes Arcoiris')).toMatchObject({ usd: 25, rate: 40, date: '2026-03-10', card: 'Itaú' });
    expect(card.left).toBe(10300);
  });
  it('comprometido por mes, de la tarjeta y en total', () => {
    expect(c.cards[0].byMonth).toEqual([3150, 3150, 1000, 1000, 1000, 1000, 0, 0, 0, 0, 0, 0]);
    expect(c.total).toEqual(c.cards[0].byMonth);
  });
  it('una ventana que empieza en otro mes', () => {
    expect(commitments(d, { today: TODAY, from: '2026-12', months: 3 })).toMatchObject({ months: ['2026-12', '2027-01', '2027-02'], total: [1000, 1000, 1000] });
  });
});

describe('varias tarjetas', () => {
  it('cada una con su último estado de cuenta; la que no tiene nombre es «Tarjeta»', () => {
    const d = data({
      invoices: [
        estado('OCA', '2026-10-05', [inst('Zapateria el Paso', 600, 2, 3, '2026-08-20')]),
        estado(undefined, '2026-09-30', [inst('Kiosco Pepe', 300, 1, 2, '2026-09-12')]),
        estado('Itaú', '2026-09-28', [inst('Optica Vision', 900, 1, 3, '2026-09-10')]),
        // Una factura no es un estado de cuenta
        { id: 'fac', fileName: 'ticket.jpg', mime: 'image/jpeg', items: [], createdAt: 1, date: '2026-10-01' },
      ],
    });
    const c = commitments(d, { today: TODAY, months: 3 });
    expect(c.cards.map((x) => [x.card, x.byMonth])).toEqual([
      ['Itaú', [900, 900, 0]],
      ['OCA', [0, 600, 0]],
      ['Tarjeta', [300, 0, 0]],
    ]);
    expect(c.total).toEqual([1200, 1500, 0]);
    expect(cardName({})).toBe('Tarjeta');
  });
  it('varios del mismo mes: el de cierre más nuevo y, con el mismo cierre, el último que se subió', () => {
    const a = estado('OCA', '2026-10-05', [inst('Uno', 100, 1, 2, '2026-10-01')]);
    const b = estado('oca ', '2026-10-05', [inst('Dos', 200, 1, 2, '2026-10-01')]);
    const viejo = estado('OCA', '2026-09-05', [inst('Tres', 300, 1, 6, '2026-09-01')], { createdAt: 99999 });
    expect(latestStatements([a, b, viejo]).map((x) => x.id)).toEqual([b.id]);
    expect(commitments(data({ invoices: [viejo, b, a] }), { today: TODAY, months: 2 }).total).toEqual([0, 200]);
  });
});

describe('la misma tarjeta con dos nombres', () => {
  it('la misma compra en el estado de cuenta más nuevo de otra tarjeta cuenta una sola vez; la tarjeta vieja no aparece', () => {
    const d = data({
      invoices: [
        estado('Visa Itaú', '2026-08-28', [inst('Optica Vision', 1000, 1, 6, '2026-08-10'), inst('Viajes Arcoiris', 4000, 2, 12, '2026-07-02', { usd: 100, rate: 40 })]),
        // El mes siguiente, con otro nombre (y la cuota en dólares con otra cotización; la fecha guardada, la del cierre)
        estado('Itaú', '2026-09-28', [inst('Optica Vision', 1000, 2, 6, '2026-09-28'), inst('Viajes Arcoiris', 4100, 3, 12, '2026-07-02', { usd: 100, rate: 41 })]),
      ],
    });
    const c = commitments(d, { today: TODAY, months: 6 });
    expect(c.cards.map((x) => x.card)).toEqual(['Itaú']);
    expect(c.total).toEqual([5100, 5100, 5100, 5100, 4100, 4100]);
  });
  it('lo que no sigue en la otra queda en la suya (y dos tarjetas distintas no se juntan)', () => {
    const d = data({
      invoices: [
        estado('Tarjeta', '2026-09-05', [inst('Optica Vision', 1000, 1, 6, '2026-09-01'), inst('Colchoneria', 2000, 1, 3, '2026-09-02')]),
        estado('OCA', '2026-10-05', [inst('Optica Vision', 1000, 2, 6, '2026-09-01'), inst('Kiosco', 500, 1, 2, '2026-10-01')]),
      ],
    });
    const c = commitments(d, { today: TODAY, months: 3 });
    expect(c.cards.map((x) => [x.card, x.plans.map((p) => p.merchant)])).toEqual([['OCA', ['Kiosco', 'Optica Vision']], ['Tarjeta', ['Colchoneria']]]);
    expect(c.total).toEqual([2000, 3500, 1000]);
  });
  it('el nombre que se le puso la última vez a la tarjeta leída', () => {
    const invoices = [
      estado('Scotia Visa', '2026-08-25', [], { readCard: 'Scotiabank' }),
      estado('Scotiabank', '2026-07-25', [], { readCard: 'Scotiabank' }),
      estado('OCA', '2026-09-05', []),
    ];
    expect(chosenCard(invoices, 'SCOTIABANK')).toBe('Scotia Visa');
    expect(chosenCard(invoices, 'OCA')).toBeUndefined();
    expect(chosenCard(invoices, undefined)).toBeUndefined();
  });
  it('cambiar el nombre de la tarjeta de un estado de cuenta guardado (y en la nota de sus gastos)', () => {
    const inv = estado('Visa Itaú', '2026-08-28', [inst('Optica Vision', 1000, 1, 6, '2026-08-10')]);
    const ms = [
      mov('2026-08-10', 1000, 'Supermercado', { invoiceId: inv.id, origin: 'tarjeta', note: 'Visa Itaú · cuota 1/6' }),
      mov('2026-08-12', 300, 'Supermercado', { invoiceId: inv.id, origin: 'tarjeta', note: 'Visa Itaú' }),
      mov('2026-08-14', 200, 'Supermercado', { invoiceId: inv.id, origin: 'tarjeta', note: 'la compré con Ana' }),
      mov('2026-08-14', 200, 'Supermercado', { note: 'Visa Itaú' }),
    ];
    const d = renameCardOf(data({ invoices: [inv], movements: ms }), inv.id, ' Itaú ');
    expect(d.invoices[0].card).toBe('Itaú');
    expect(d.movements.map((m) => m.note)).toEqual(['Itaú · cuota 1/6', 'Itaú', 'la compré con Ana', 'Visa Itaú']);
    const sin = renameCardOf(d, inv.id, '');
    expect(sin.invoices[0].card).toBeUndefined();
    expect(sin.movements.map((m) => m.note)).toEqual(['cuota 1/6', undefined, 'la compré con Ana', 'Visa Itaú']);
    expect(renameCardOf(sin, inv.id, 'OCA').movements.map((m) => m.note)).toEqual(['OCA · cuota 1/6', 'OCA', 'OCA · la compré con Ana', 'Visa Itaú']);
  });
});

describe('la misma compra varias veces en un estado de cuenta', () => {
  it('queda la de n más alto: con la misma fecha de compra o el mismo mes de la primera cuota', () => {
    const list = [
      inst('Optica Vision', 1000, 1, 6, '2026-07-10'), inst('Optica Vision', 1000, 2, 6, '2026-08-10'), inst('Optica Vision', 1000, 3, 6, '2026-09-10'),
      inst('Zapateria', 600, 1, 3, '2026-07-02'), inst('Zapateria', 600, 2, 3, '2026-07-02'),
      // Otra compra en el mismo comercio (otro monto) y dos iguales con la misma cuota
      inst('Optica Vision', 800, 1, 6, '2026-09-11'), inst('Kiosco', 300, 2, 2, '2026-08-01'), inst('Kiosco', 300, 2, 2, '2026-08-01'),
    ];
    expect(latestCuotas(list).map((c) => `${c.merchant} ${c.amount} ${c.n}/${c.of}`)).toEqual([
      'Optica Vision 1000 3/6', 'Zapateria 600 2/3', 'Optica Vision 800 1/6', 'Kiosco 300 2/2', 'Kiosco 300 2/2',
    ]);
  });
});

describe('dos tarjetas con el mismo nombre', () => {
  const invoices = [estado('Itaú', '2026-09-28', []), estado(undefined, '2026-09-05', [])];
  it('el mismo nombre con un cierre del mismo mes o a menos de 20 días es otra tarjeta', () => {
    expect(sameNameOtherCard(invoices, 'itau', '2026-09-15')?.id).toBe(invoices[0].id);
    expect(sameNameOtherCard(invoices, 'Itaú', '2026-10-05')?.id).toBe(invoices[0].id);
    // El mes siguiente, o el mismo estado de cuenta otra vez, no
    expect(sameNameOtherCard(invoices, 'Itaú', '2026-10-28')).toBeUndefined();
    expect(sameNameOtherCard(invoices, 'Itaú', '2026-09-28')).toBeUndefined();
    expect(sameNameOtherCard(invoices, 'OCA', '2026-09-15')).toBeUndefined();
    // Sin nombre también
    expect(sameNameOtherCard(invoices, undefined, '2026-09-20')?.id).toBe(invoices[1].id);
  });
  it('ya hay uno sin nombre', () => {
    expect(hasUnnamedStatement(invoices)).toBe(true);
    expect(hasUnnamedStatement([invoices[0]])).toBe(false);
  });
});

describe('los nombres de las tarjetas', () => {
  const invoices = [
    estado('OCA', '2026-10-05', [], { createdAt: 3 }),
    estado('Itaú', '2026-09-28', [], { createdAt: 1 }),
    estado(undefined, '2026-10-10', [], { createdAt: 2 }),
    estado('itau', '2026-08-28', [], { createdAt: 0 }),
    { id: 'fac', fileName: 'ticket.jpg', mime: 'image/jpeg', items: [], createdAt: -1, merchant: 'Disco' } as Invoice,
  ];
  it('las ya usadas, con nombre, del último cierre al más viejo (una vez cada una)', () => {
    expect(knownCards(invoices)).toEqual(['OCA', 'Itaú']);
    expect(knownCards([])).toEqual([]);
  });
  it('el orden de los colores: el del primer estado de cuenta subido de cada una', () => {
    expect(cardOrder(invoices)).toEqual(['itau', 'Tarjeta', 'OCA']);
  });
  it('el mismo nombre sin importar mayúsculas, tildes ni espacios; sin nombre es «Tarjeta»', () => {
    expect(sameCard('Itaú', ' ITAU ')).toBe(true);
    expect(sameCard('Itaú', 'Visa Itaú')).toBe(false);
    expect(sameCard(undefined, 'Tarjeta')).toBe(true);
    expect(sameCard('', undefined)).toBe(true);
  });
});

describe('el estado de cuenta que se está revisando', () => {
  it('lo que deja comprometido mes a mes, como si fuera el último de su tarjeta', () => {
    const c = statementCommitments([inst('Optica Vision', 900, 1, 3, '2026-09-10'), inst('Zapateria', 600, 3, 3, '2026-07-02')], '2026-10-15', { today: TODAY, months: 4 });
    expect(c.months).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
    expect(c.total).toEqual([0, 900, 900, 0]);
    expect(c.plans.map((p) => [p.merchant, p.ends])).toEqual([['Optica Vision', '2026-12']]);
    expect(c.left).toBe(1800);
    expect(statementCommitments([], '2026-10-15', { today: TODAY, months: 2 })).toEqual({ months: ['2026-10', '2026-11'], total: [0, 0], plans: [], left: 0 });
  });
});

describe('estado de cuenta viejo', () => {
  it('cuál falta subir: el último que ya cerró', () => {
    expect(missingStatement('2026-09-28', '2026-10-21')).toBeNull();
    expect(missingStatement('2026-09-28', '2026-11-08')).toBe('2026-10');
    expect(missingStatement('2026-08-15', '2026-10-03')).toBe('2026-09');
    expect(missingStatement('2026-08-15', '2026-10-21')).toBe('2026-10');
    expect(missingStatement('2026-11-20', '2027-01-15')).toBe('2026-12');
  });
  it('el mes del próximo estado de cuenta (si ya pasó, el de hoy)', () => {
    expect(nextStatementMonth('2026-10-05', TODAY)).toBe('2026-11');
    expect(nextStatementMonth('2026-09-28', TODAY)).toBe('2026-10');
    expect(nextStatementMonth('2026-07-28', TODAY)).toBe('2026-10');
  });

  it('desactualizada cuando ya tendría que haber llegado el siguiente (el cierre + un mes + 10 días)', () => {
    expect(isStale('2026-09-28', '2026-10-21')).toBe(false);
    expect(isStale('2026-09-28', '2026-11-07')).toBe(false);
    expect(isStale('2026-09-28', '2026-11-08')).toBe(true);
    expect(isStale('2026-01-31', '2026-03-10')).toBe(false);
    expect(isStale('2026-01-31', '2026-03-11')).toBe(true);
  });
  it('una tarjeta sin cuotas por delante y con el último cierre de hace más de 3 meses ya no pide su estado de cuenta', () => {
    const c = commitments(data({ invoices: [estado('BROU', '2025-03-10', []), estado('OCA', '2026-08-15', [])] }), { today: TODAY });
    expect(c.cards.map((x) => [x.card, x.stale])).toEqual([['BROU', false], ['OCA', true]]);
    expect(nextMonthOutlook(data({ invoices: [estado('BROU', '2025-03-10', [])] }), { today: TODAY }).staleCards).toEqual([]);
    // Con cuotas que llegan a este mes, sí (aunque sea vieja)
    expect(commitments(data({ invoices: [estado('BROU', '2026-05-10', [inst('Muebleria', 500, 1, 12, '2026-05-01')])] }), { today: TODAY }).cards[0].stale).toBe(true);
  });
  it('los meses que ya pasaron no cuentan', () => {
    const d = data({ invoices: [estado('Santander', '2026-08-15', [inst('Optica Vision', 300, 2, 6, '2026-06-10'), inst('Kiosco Pepe', 500, 1, 2, '2026-08-01')])] });
    const card = commitments(d, { today: TODAY, months: 4 }).cards[0];
    expect(card.stale).toBe(true);
    // Setiembre ya pasó: quedan octubre, noviembre y diciembre; la de 2 cuotas terminó en setiembre
    expect(card.plans.map((p) => [p.merchant, p.months, p.left, p.ends])).toEqual([['Optica Vision', ['2026-10', '2026-11', '2026-12'], 900, '2026-12']]);
    expect(card.byMonth).toEqual([300, 300, 300, 0]);
  });
});

describe('fin de año', () => {
  it('las cuotas siguen en enero del año que viene', () => {
    const d = data({ invoices: [estado('OCA', '2026-12-20', [inst('Jugueteria', 1500, 1, 3, '2026-12-10')])] });
    const c = commitments(d, { today: '2026-12-28', months: 4 });
    expect(c.months).toEqual(['2026-12', '2027-01', '2027-02', '2027-03']);
    expect(c.total).toEqual([0, 1500, 1500, 0]);
    expect(c.cards[0].plans[0].ends).toBe('2027-02');
  });
});

describe('estados de cuenta guardados antes (sin las cuotas)', () => {
  const inv = estado('Itaú', '2026-09-28');
  const otro = estado('OCA', '2026-09-05');
  const ms = [
    mov('2026-09-28', 1250, 'Electrodomésticos y muebles', { invoiceId: inv.id, origin: 'tarjeta', merchant: 'Colchoneria Descanso', note: 'Itaú · cuota 7/9 · compra del 3/3/2026' }),
    mov('2026-09-28', 1000, 'Paseos y viajes', { invoiceId: inv.id, origin: 'tarjeta', merchant: 'Viajes Arcoiris', note: 'Itaú · cuota 6/12 · U$S 25,00 × 40,00' }),
    mov('2026-09-12', 700, 'Supermercado', { invoiceId: inv.id, origin: 'tarjeta', merchant: 'Almacen', note: 'Itaú' }),
    mov('2026-09-02', 500, 'Farmacia', { invoiceId: otro.id, origin: 'tarjeta', merchant: 'Farmacia', note: 'OCA · cuota 2/3' }),
  ];
  it('salen de sus gastos con «cuota n/N» en la nota (con la fecha de la compra y los dólares, si están)', () => {
    expect(invoiceInstallments(inv, ms)).toEqual([
      { merchant: 'Colchoneria Descanso', key: 'colchoneria', amount: 1250, n: 7, of: 9, date: '2026-03-03' },
      { merchant: 'Viajes Arcoiris', key: 'viajes', amount: 1000, n: 6, of: 12, date: '2026-09-28', usd: 25, rate: 40 },
    ]);
    const c = commitments(data({ invoices: [inv], movements: ms }), { today: TODAY, months: 3 });
    expect(c.total).toEqual([2250, 2250, 1000]);
  });
  it('con la lista guardada (aunque esté vacía) no se mira la nota', () => {
    expect(invoiceInstallments({ ...inv, installments: [] }, ms)).toEqual([]);
  });
  it('la nota del gasto', () => {
    expect(noteInstallment('OCA · cuota 2/3')).toEqual({ n: 2, of: 3 });
    expect(noteInstallment('Itaú · cuota 7/9 · compra del 3/3/2026 · U$S 25,00 × 40,00')).toEqual({ n: 7, of: 9, date: '2026-03-03' });
    expect(noteInstallment('pagué la cuota del club')).toBeNull();
    expect(noteInstallment('cuota 3/2')).toBeNull();
  });
});

describe('cuotas que no sirven y créditos', () => {
  it('se ignoran las rotas, en negativo o de una versión que no se entiende; sin cuotas la tarjeta igual aparece', () => {
    const rotas = [
      inst('Devolucion Optica', -300, 1, 3, '2026-09-10'),
      inst('Cero', 0, 1, 3, '2026-09-10'),
      { merchant: 'Al reves', amount: 100, n: 4, of: 3, date: '2026-09-10' },
      { merchant: 'Texto', amount: '100', n: 1, of: 3 },
      'cualquier cosa',
      null,
      { amount: 200, n: 1, of: 2 },
    ];
    const inv = estado('OCA', '2026-09-30', rotas);
    expect(invoiceInstallments(inv, [])).toEqual([{ merchant: 'Compra', key: 'compra', amount: 200, n: 1, of: 2, date: '2026-09-30' }]);
    const sin = commitments(data({ invoices: [estado('BROU', '2026-10-02', [])] }), { today: TODAY, months: 2 });
    expect(sin.cards).toMatchObject([{ card: 'BROU', plans: [], byMonth: [0, 0], left: 0 }]);
  });
  it('sin estados de cuenta no hay nada comprometido', () => {
    const c = commitments(data({}), { today: TODAY });
    expect(c.cards).toEqual([]);
    expect(c.total).toEqual(new Array(12).fill(0));
  });
  it('el límite y el disponible del último estado de cuenta', () => {
    const c = commitments(data({ invoices: [estado('OCA', '2026-10-05', [], { limit: 80000, available: 12500.5 })] }), { today: TODAY });
    expect(c.cards[0]).toMatchObject({ limit: 80000, available: 12500.5 });
  });
});

// --- El mes que viene ------------------------------------------------------------------------------------

/** Tres meses completos parecidos: sueldo, alquiler, luz, súper, ahorro y la tarjeta */
function hogar(extra: Partial<Data> = {}): Data {
  const movements: Movement[] = [];
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    movements.push(
      mov(`${m}-01`, 60000, 'Sueldo', { kind: 'ingreso' }),
      mov(`${m}-05`, 20000, 'Alquiler'),
      mov(`${m}-10`, 3200, 'Luz'),
      mov(`${m}-12`, 14000, 'Supermercado'),
      mov(`${m}-15`, 5000, 'Ahorro'),
      // La cuota que sigue de una compra anterior (ya está en lo comprometido) y la primera de una compra nueva (es gasto del mes)
      mov(`${m}-28`, 1000, 'Electrodomésticos y muebles', { origin: 'tarjeta', note: 'Itaú · cuota 3/6' }),
      mov(`${m}-20`, 600, 'Ropa y calzado', { origin: 'tarjeta', note: 'Itaú · cuota 1/3' }),
    );
  }
  return data({
    movements,
    recurring: [
      fijo('Sueldo', 60000, { kind: 'ingreso' }),
      fijo('Alquiler', 20000),
      fijo('Luz', 3000),
      fijo('Ahorro', 5000),
      fijo('Agua', 1000, { paused: true }),
    ],
    invoices: [estado('Itaú', '2026-10-15', [inst('Muebleria', 1000, 2, 6, '2026-09-02'), inst('Zapateria', 600, 1, 3, '2026-10-03')])],
    ...extra,
  });
}

describe('el mes que viene', () => {
  it('ingresos fijos, gastos fijos, cuotas, lo de siempre y el margen (sin contar el ahorro como gasto)', () => {
    expect(nextMonthOutlook(hogar(), { today: TODAY })).toEqual({
      month: '2026-11',
      income: { amount: 60000, from: 'fijos' },
      // Alquiler y luz; el ahorro no es un gasto y el agua está en pausa
      fixed: 23000,
      installments: 1600,
      free: 35400,
      // Por mes: súper 14.000, lo que la luz pasó de su fijo (200) y la primera cuota de la compra nueva (600)
      usual: { amount: 14800, months: 3 },
      margin: 20600,
      includeSavings: false,
      staleCards: [],
    });
  });
  it('con «Incluir ahorro», lo que se ahorra también se descuenta', () => {
    expect(nextMonthOutlook(hogar(), { today: TODAY, includeSavings: true })).toMatchObject({ fixed: 28000, free: 30400, usual: { amount: 14800, months: 3 }, margin: 15600, includeSavings: true });
  });
  it('sin ingresos fijos: el promedio de los últimos 3 meses completos con datos, y dice de cuántos', () => {
    const d = hogar();
    const out = nextMonthOutlook({ ...d, recurring: d.recurring.filter((r) => r.kind !== 'ingreso'), movements: d.movements.filter((m) => !m.date.startsWith('2026-07')).map((m) => (m.kind === 'ingreso' && m.date.startsWith('2026-09') ? { ...m, amount: 64000 } : m)) }, { today: TODAY });
    expect(out.income).toEqual({ amount: 62000, from: 'promedio', months: 2 });
    expect(out.usual).toEqual({ amount: 14800, months: 2 });
  });
  it('el primer mes de todos los datos, si empieza tarde (el comienzo del primer estado de cuenta), no cuenta', () => {
    const d = data({
      movements: [
        mov('2026-09-01', 80000, 'Sueldo', { kind: 'ingreso' }),
        mov('2026-09-08', 30000, 'Supermercado', { origin: 'tarjeta' }),
        mov('2026-09-20', 20000, 'Supermercado', { origin: 'tarjeta' }),
        mov('2026-08-30', 3000, 'Supermercado', { origin: 'tarjeta' }),
      ],
    });
    expect(nextMonthOutlook(d, { today: TODAY })).toMatchObject({ income: { amount: 80000, from: 'promedio', months: 1 }, usual: { amount: 50000, months: 1 }, margin: 30000 });
    // Con datos de antes, un mes que empieza el 10 cuenta igual
    const before = data({ movements: [...d.movements, mov('2025-11-03', 100, 'Supermercado')] });
    expect(nextMonthOutlook(before, { today: TODAY })).toMatchObject({ income: { amount: 40000, months: 2 }, usual: { months: 2 } });
  });
  it('sin datos suficientes no inventa', () => {
    expect(nextMonthOutlook(data({}), { today: TODAY })).toEqual({
      month: '2026-11', income: null, fixed: 0, installments: 0, free: null, usual: null, margin: null, includeSavings: false, staleCards: [],
    });
    // Con el sueldo fijo pero sin meses anotados: lo libre sí, el margen no
    const solo = nextMonthOutlook(data({ recurring: [fijo('Sueldo', 50000, { kind: 'ingreso' })] }), { today: TODAY });
    expect(solo).toMatchObject({ income: { amount: 50000, from: 'fijos' }, free: 50000, usual: null, margin: null });
    // Meses con gastos pero sin ningún ingreso: no hay con qué estimarlo
    expect(nextMonthOutlook(data({ movements: [mov('2026-09-03', 500, 'Supermercado')] }), { today: TODAY })).toMatchObject({ income: null, usual: { amount: 500, months: 1 }, margin: null });
  });
  it('avisa las tarjetas desactualizadas', () => {
    const d = hogar({ invoices: [estado('OCA', '2026-07-05', [inst('Uno', 100, 1, 6, '2026-07-01')])] });
    expect(nextMonthOutlook(d, { today: TODAY })).toMatchObject({ installments: 100, staleCards: ['OCA'] });
  });
});

// --- Simular una compra ----------------------------------------------------------------------------------

describe('simular una compra', () => {
  it('cuotas iguales en centésimos; la última ajusta', () => {
    expect(splitPurchase(1000, 3)).toEqual([333.33, 333.33, 333.34]);
    expect(splitPurchase(100, 1)).toEqual([100]);
    expect(splitPurchase(1234.5, 6)).toEqual([205.75, 205.75, 205.75, 205.75, 205.75, 205.75]);
    expect(splitPurchase(0.05, 10)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.05]);
    for (const [a, n] of [[0, 3], [-10, 3], [100, 0], [100, 2.5], [100, 73], [Number.NaN, 2]]) expect(splitPurchase(a, n)).toEqual([]);
  });
  it('la primera cuota va en el próximo cierre de la tarjeta; sin la tarjeta, el mes que viene', () => {
    const inv = [estado('Itaú', '2026-09-28', [])];
    expect(firstInstallmentMonth(inv, 'Itaú', '2026-10-21')).toBe('2026-10');
    // El mismo día del cierre todavía entra (y el nombre, sin importar mayúsculas ni tildes)
    expect(firstInstallmentMonth(inv, 'itau', '2026-10-28')).toBe('2026-10');
    expect(firstInstallmentMonth(inv, 'ITAÚ', '2026-10-29')).toBe('2026-11');
    // Si el de este mes ya cerró (y se subió), va en el siguiente aunque sea el mismo día
    expect(firstInstallmentMonth([estado('Itaú', '2026-10-21', [])], 'Itaú', '2026-10-21')).toBe('2026-11');
    expect(firstInstallmentMonth(inv, 'OCA', '2026-10-21')).toBe('2026-11');
    expect(firstInstallmentMonth(inv, undefined, '2026-12-21')).toBe('2027-01');
  });
  it('cómo quedan los próximos meses y el margen', () => {
    // Itaú cierra el 15: una compra del 21 entra en el de noviembre
    const s = simulatePurchase(hogar(), { amount: 3000, count: 3, card: 'Itaú' }, { today: TODAY, months: 4 })!;
    expect(s.cuotas).toEqual([{ month: '2026-11', amount: 1000 }, { month: '2026-12', amount: 1000 }, { month: '2027-01', amount: 1000 }]);
    expect(s.months).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
    expect(s.before).toEqual([0, 1600, 1600, 1000]);
    expect(s.after).toEqual([0, 2600, 2600, 2000]);
    expect(s.card).toEqual({ name: 'Itaú', before: [0, 1600, 1600, 1000], after: [0, 2600, 2600, 2000] });
    expect(s.nextMonth).toBe(1000);
    expect(s.outlook.margin).toBe(20600);
    expect(s.margin).toBe(19600);
    expect(s).toMatchObject({ thisMonth: 0, thisMargin: null, closingDay: 15 });
  });
  it('en un pago con una tarjeta que cierra antes de fin de mes, el mes que viene no cambia', () => {
    const d = hogar({ invoices: [estado('OCA', '2026-09-28', [])] });
    const s = simulatePurchase(d, { amount: 5000, count: 1, card: 'OCA' }, { today: TODAY })!;
    expect(s.cuotas).toEqual([{ month: '2026-10', amount: 5000 }]);
    expect(s.nextMonth).toBe(0);
    expect(s.margin).toBe(s.outlook.margin);
    // Sale de la plata de este mes: contra el margen de este mes (sin cuotas de antes: 60.000 − 23.000 − 14.800)
    expect(s).toMatchObject({ thisMonth: 5000, thisMargin: 17200, closingDay: 28 });
    const big = simulatePurchase(d, { amount: 500000, count: 1, card: 'OCA' }, { today: TODAY })!;
    expect(big.thisMargin).toBe(-477800);
  });
  it('sin margen conocido, igual dice cómo quedan los meses; con monto o cuotas que no sirven, null', () => {
    const s = simulatePurchase(data({}), { amount: 1200, count: 2 }, { today: TODAY, months: 3 })!;
    expect(s.after).toEqual([0, 600, 600]);
    expect(s.card).toBeUndefined();
    expect(s.margin).toBeNull();
    expect(simulatePurchase(data({}), { amount: 0, count: 2 }, { today: TODAY })).toBeNull();
  });
});
