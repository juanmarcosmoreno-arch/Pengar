/**
 * Pruebas de regresión de los arreglos de la revisión: cada una es un caso que antes salía mal.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { suggestRubro } from '../classify';
import { exampleOutdated } from '../example';
import { movementsCsv } from '../export';
import {
  headerMonth, importMonthlySheet, importMovementSheet, isMonthlySheet, isMovementSheet, mergeImport, replaceImport, type Cell,
} from '../importSheet';
import { findDate, parseInvoiceText } from '../invoice';
import { parseAmount, parseDecimal } from '../money';
import { pendingRecurring } from '../recurring';
import { findDuplicates, parseStatementTable, parseStatementText, statementInfo, statementKind } from '../statement';
import { knownRubro, NOT_SPEND, spendRubros } from '../statementReview';
import { buildIndex, convertBudget, expenseChange, monthSummary } from '../stats';
import { emptyData, normalizeData, templateData } from '../template';
import type { Category, Data, Movement, Rubro } from '../types';

const t = templateData();
const nameOf = (id?: string) => t.rubros.find((r) => r.id === id)?.name;
const rubroNamed = (name: string) => t.rubros.find((r) => r.name === name)!;
const suggestName = (text: string) => nameOf(suggestRubro(text, undefined, t.rubros, {})?.rubroId);

function mov(date: string, amount: number, rubroId: string, extra: Partial<Movement> = {}): Movement {
  return { id: `m${date}${amount}${rubroId}`, date, amount, kind: 'gasto', rubroId, origin: 'manual', createdAt: 0, ...extra };
}

/** Como lee readSpreadsheet un archivo: los CSV como texto, sin convertir fechas ni números */
function csvRows(text: string): Cell[][] {
  const wb = XLSX.read(text, { type: 'string', cellDates: true, raw: true });
  return XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
}

function exampleRows(): Cell[][] {
  const wb = XLSX.read(readFileSync('datos/ejemplo.xlsx'), { cellDates: true });
  return XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets['presupuesto'], { header: 1, raw: true, defval: null });
}

function exampleImport(): Data {
  const res = importMonthlySheet(exampleRows());
  return { ...emptyData(), categories: res.categories, rubros: res.rubros, movements: res.movements };
}

describe('dinero', () => {
  it('la cotización con tres decimales (39,875) se lee igual en el campo de la revisión', () => {
    const rate = statementInfo('Cotización del dólar: 39,875').usdRate!;
    expect(rate).toBe(39.875);
    // ScanStatement arma el campo así y lo lee con parseDecimal (parseAmount lo toma como miles)
    expect(parseDecimal(String(rate).replace('.', ','))).toBe(39.875);
    expect(parseDecimal('39.875')).toBe(39.875);
    expect(parseDecimal('40')).toBe(40);
    expect(parseAmount('1.240')).toBe(1240);
  });
});

describe('palabras clave', () => {
  it('una compra en cuotas no va a «Colegio y cursos» por decir «CUOTA»', () => {
    const [tx] = parseStatementText(['Fecha de cierre: 25/10/2026', '12/10 ZARA 18 DE JULIO CUOTA 02/03 3.290,00'].join('\n'));
    const known = knownRubro(tx, spendRubros(t.rubros, t.categories), {});
    expect(known !== NOT_SPEND && nameOf(known?.rubroId)).toBe('Ropa y calzado');
    expect(rubroNamed('Colegio y cursos').keywords).not.toContain('cuota');
  });
  it('«pan » y «bar » (con espacio) no agarran palabras que solo empiezan igual', () => {
    expect(suggestName('PAÑALES HUGGIES XG')).not.toBe('Panadería');
    expect(suggestName('PANTALON JEAN')).not.toBe('Panadería');
    expect(suggestName('BARBERIA DON PEPE')).not.toBe('Comer afuera');
    expect(suggestName('PAN FLAUTA')).toBe('Panadería');
    expect(suggestName('SUPERMERCADO EL DORADO')).toBe('Supermercado');
  });
  it('las claves de tres y cuatro letras no agarran el comienzo de otras palabras', () => {
    expect(suggestName('UTENSILIOS DE COCINA')).not.toBe('Luz');
    expect(suggestName('MAXIKIOSCO EL TREBOL')).not.toBe('Streaming');
    expect(suggestName('AGUACATE HASS')).not.toBe('Agua');
    expect(suggestName('UTE FACTURA')).toBe('Luz');
    expect(suggestName('CAFES DEL MUNDO')).toBe('Comer afuera');
    // Rubro «Gas» de una planilla: su nombre es la palabra clave
    const gas: Rubro = { id: 'gas', name: 'Gas', categoryId: 'c', keywords: ['gas'] };
    expect(suggestRubro('GASEOSA PEPSI 1,5L', undefined, [gas], {})).toBeNull();
  });
});

describe('facturas', () => {
  it('el número del producto antes del precio no se pega al monto («HUEVOS X 12 189,00»)', () => {
    const p = parseInvoiceText(['ALMACEN LA ESQUINA', 'HUEVOS X 12 189,00', 'PILAS AA X 4 320,00', 'TOTAL 509,00'].join('\n'));
    expect(p.items.map((i) => i.amount)).toEqual([189, 320]);
  });
  it('productos que empiezan con «NO…» o «CABAL…» no se descartan; «Nº», impuestos y la tarjeta sí', () => {
    const p = parseInvoiceText(['ALMACEN LA ESQUINA', 'CERVEZA NORTEÑA 1L 150,00', 'CABALLA EN ACEITE 210,00', 'NOCILLA 350G 189,00', 'TOTAL 549,00'].join('\n'));
    expect(p.items.map((i) => i.amount)).toEqual([150, 210, 189]);
    const q = parseInvoiceText(['DISCO', 'LECHE 90,00', 'IMPUESTOS 12,00', 'CREDITOS 5,00', 'COD SEGURIDAD 123', 'No. 4521', 'MASTERCARD 90,00', 'TOTAL 90,00'].join('\n'));
    expect(q.items.map((i) => i.description)).toEqual(['LECHE']);
  });
  it('una fecha imposible (31/06) no se toma', () => {
    expect(findDate('Fecha 31/06/2026')).toBeUndefined();
    expect(findDate('Fecha 31/02/2026 13/10/2026')).toBe('2026-10-13');
  });
});

describe('estados de cuenta', () => {
  it('la cotización no sale de la fecha que la acompaña', () => {
    expect(statementInfo('Cotización al 25/09/2025: 40,10').usdRate).toBe(40.1);
    expect(statementInfo('Tipo de cambio del 26/09: 40,10').usdRate).toBe(40.1);
    expect(statementInfo('Cotización del dólar al 05/09/2025: 40,10').usdRate).toBe(40.1);
    expect(statementInfo('Cotización del dólar: 40.30').usdRate).toBe(40.3);
  });

  it('el resumen sin fecha al pie («Pagos», «Cargos») no duplica los cargos', () => {
    const txs = parseStatementText(
      [
        'OCA',
        'Fecha de cierre: 25/01/2026',
        'FECHA DESCRIPCION IMPORTE',
        '03/01 TIENDA INGLESA 7 890,00',
        '05/01 ANCAP 2.100,00',
        '20/01 INTERESES COMPENSATORIOS 120,00',
        'RESUMEN DEL PERIODO',
        'Saldo anterior 18.450,20',
        'Pagos -18.450,20',
        'Compras 2.990,00',
        'Cargos 120,00',
        'Saldo actual 3.110,00',
      ].join('\n'),
      { today: '2026-01-26' },
    );
    expect(txs.filter((x) => x.kind === 'cargo').reduce((s, x) => s + x.amount, 0)).toBe(120);
    expect(txs.filter((x) => x.kind === 'pago')).toHaveLength(0);
  });

  it('el IVA de los intereses sigue contando aunque haya un renglón de tasas en el medio', () => {
    const txs = parseStatementText(
      ['Fecha de cierre: 25/01/2026', '20/01 INTERESES COMPENSATORIOS 120,00', 'TEA 85,00 %', 'IVA S/INTERESES 26,40'].join('\n'),
      { today: '2026-01-26' },
    );
    expect(txs.map((x) => [x.kind, x.amount])).toEqual([['cargo', 120], ['cargo', 26.4]]);
  });

  it('planilla del banco con «Fecha movimiento» o «Tipo de movimiento» antes de la descripción', () => {
    const a = parseStatementTable([['Fecha movimiento', 'Descripción', 'Importe'], ['03/01/2026', 'TIENDA INGLESA', '890,00'], ['05/01/2026', 'ANCAP', '2.100,00']]);
    expect(a.map((x) => x.merchant)).toEqual(['Tienda Inglesa', 'Ancap']);
    const b = parseStatementTable([
      ['Fecha', 'Tipo de movimiento', 'Descripción', 'Importe'],
      ['03/01/2026', 'Compra', 'TIENDA INGLESA', '890,00'],
      ['05/01/2026', 'Compra', 'ANCAP', '2.100,00'],
    ]);
    expect(b.map((x) => x.merchant)).toEqual(['Tienda Inglesa', 'Ancap']);
  });

  it('planilla del banco: «$ -890,00» es negativo (una devolución, no otra compra)', () => {
    const txs = parseStatementTable([
      ['Fecha', 'Descripción', 'Importe'],
      ['03/01/2026', 'TIENDA INGLESA', '$ 890,00'],
      ['05/01/2026', 'TIENDA INGLESA', '$ -890,00'],
      ['06/01/2026', 'ANCAP', '$ 1.200,00'],
    ]);
    expect(txs[1]).toMatchObject({ amount: -890, kind: 'credito' });
    expect(txs[0]).toMatchObject({ amount: 890, kind: 'compra' });
  });

  it('la cuota 3/6 no es un repetido de la cuota 2/6 guardada el mes pasado (misma fecha de compra)', () => {
    const [c2] = parseStatementText(['Fecha de cierre: 25/09/2026', '15/08 MOTOCICLO CUOTA 02/06 4.500,00'].join('\n'));
    const [c3] = parseStatementText(['Fecha de cierre: 25/10/2026', '15/08 MOTOCICLO CUOTA 03/06 4.500,00'].join('\n'));
    const saved = mov(c2.date, 4500, 'r', { id: 'm1', origin: 'tarjeta', merchant: c2.merchant, note: 'OCA · cuota 2/6' });
    expect(c3.installment).toBe('3/6');
    expect(findDuplicates([c3], [saved]).size).toBe(0);
    // La misma cuota sí es un repetido
    expect(findDuplicates([c2], [saved]).get(0)).toBe('m1');
  });

  it('un número de dos cifras después de «19 NOV» no es el año («24 HORAS»)', () => {
    const [tx] = parseStatementText(['Fecha de cierre: 25/11/2026', '19 NOV 24 HORAS SUPER 590,00'].join('\n'), { today: '2026-11-26' });
    expect(tx.date).toBe('2026-11-19');
    expect(tx.description).toBe('24 HORAS SUPER');
    // El año del cierre sí
    const [y] = parseStatementText(['Fecha de cierre: 25/11/2026', '19 NOV 26 DISCO 590,00'].join('\n'), { today: '2026-11-26' });
    expect(y).toMatchObject({ date: '2026-11-19', merchant: 'Disco' });
  });

  it('«PAGO FACTURA UTE» es una compra (débito de un servicio), no el pago de la tarjeta', () => {
    expect(statementKind('PAGO FACTURA UTE')).toBe('compra');
    expect(statementKind('PAGO SERVICIO ANTEL')).toBe('compra');
    expect(statementKind('SU PAGO - GRACIAS')).toBe('pago');
    expect(statementKind('PAGO EN REDPAGOS')).toBe('pago');
  });
});

describe('planillas', () => {
  it('el CSV que exporta Pengar no se toma como planilla mensual por un monto entre 30.000 y 80.000', () => {
    const data: Data = {
      ...emptyData(),
      ...t,
      movements: [mov('2026-09-02', 35000, rubroNamed('Alquiler').id), mov('2026-09-05', 3870, rubroNamed('Supermercado').id)],
    };
    // Leído como texto (así lo lee ahora readSpreadsheet) y como lo leía antes SheetJS, con fechas y números
    expect(isMonthlySheet(csvRows(movementsCsv(data)))).toBe(false);
    const wb = XLSX.read(movementsCsv(data), { type: 'string', cellDates: true, raw: false });
    expect(isMonthlySheet(XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }))).toBe(false);
    expect(isMovementSheet(csvRows(movementsCsv(data)))).toBe(true);
  });

  it('un Excel de movimientos con fechas y un sueldo de 45.000 no es una planilla mensual', () => {
    const rows: Cell[][] = [
      ['Fecha', 'Tipo', 'Rubro', 'Categoría', 'Monto'],
      [new Date(2026, 9, 1), 'ingreso', 'Sueldo', 'Ingresos', 45000],
      [new Date(2026, 9, 2), 'gasto', 'Alquiler', 'Fijos', 34000],
    ];
    expect(isMonthlySheet(rows)).toBe(false);
  });

  it('un CSV en español se lee con el día primero y la coma decimal', () => {
    const res = importMovementSheet(csvRows('Fecha;Rubro;Categoría;Monto;Nota\n05/10/2026;Supermercado;Alimentación;1.234,56;súper\n20/10/2026;Farmacia;Salud;850;remedios'), t);
    expect(res.movements.map((m) => [m.date, m.amount])).toEqual([['2026-10-05', 1234.56], ['2026-10-20', 850]]);
    expect(res.warnings).toEqual([]);
  });

  it('una fecha imposible en el CSV de movimientos (31/02) avisa en vez de guardarse', () => {
    const res = importMovementSheet([['Fecha', 'Monto', 'Rubro'], ['31/02/2026', '500', 'Varios'], ['2026-06-31', '500', 'Varios']], t);
    expect(res.movements).toHaveLength(0);
    expect(res.warnings).toHaveLength(2);
  });

  it('las fechas de SheetJS se leen bien en zonas UTC+13 y UTC+14', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['Pacific/Auckland', 'Pacific/Kiritimati', 'America/Montevideo']) {
        process.env.TZ = zone;
        // SheetJS arma las fechas a la medianoche de la hora local
        expect(headerMonth(new Date(2024, 10, 1))).toBe('2024-11');
        const res = importMonthlySheet(exampleRows());
        expect(res.months[0]).toBe('2024-11');
        expect(res.months.at(-1)).toBe('2026-10');
      }
    } finally {
      if (tz == null) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('«Sumar» la misma planilla otra vez no duplica nada, y un mes que cambió se reemplaza', () => {
    const data = exampleImport();
    const again = mergeImport(data, importMonthlySheet(exampleRows()));
    expect(again.movements).toHaveLength(0);
    expect(again.rubros).toHaveLength(0);
    expect(again.categories).toHaveLength(0);
    expect(again.repeated).toBe(data.movements.length);
    // Octubre actualizado: solo ese total entra, en lugar del de antes
    const rows = exampleRows();
    const ute = rows.find((r) => r[0] === 'UTE')!;
    const col = rows[0].length > 25 ? 25 : rows[0].length - 1;
    const before = ute[col] as number;
    ute[col] = before + 1000;
    const updated = mergeImport(data, importMonthlySheet(rows));
    expect(updated.movements.map((m) => m.amount)).toEqual([before + 1000]);
    expect(updated.updated).toBe(1);
    expect(updated.replaceIds).toHaveLength(1);
    expect(data.movements.find((m) => m.id === updated.replaceIds[0])!.amount).toBe(before);
  });

  it('«Sumar» el CSV exportado no duplica, pero dos compras iguales del mismo día en el archivo quedan', () => {
    const data: Data = { ...emptyData(), ...t, movements: [mov('2026-10-05', 120, rubroNamed('Feria').id)] };
    const rows = csvRows(`${movementsCsv(data)}\n2026-10-05,gasto,Feria,Alimentación,120,,`);
    const merged = mergeImport(data, importMovementSheet(rows, data));
    expect(merged.repeated).toBe(1);
    expect(merged.movements).toHaveLength(1);
  });

  it('«Reemplazar todo» con el CSV exportado conserva los rubros y categorías que usa', () => {
    const data = exampleImport();
    const res = importMovementSheet(csvRows(movementsCsv(data)), data);
    expect(res.rubros).toHaveLength(0);
    const next = replaceImport(data, res);
    const rubros = new Set(next.rubros.map((r) => r.id));
    const cats = new Set(next.categories.map((c) => c.id));
    expect(res.movements.every((m) => rubros.has(m.rubroId))).toBe(true);
    expect(next.rubros.every((r) => cats.has(r.categoryId))).toBe(true);
  });

  it('al sumar, las categorías se unen por la letra solo si se parecen', () => {
    const existing = { ...t, movements: [] };
    const cat = (code: string, name: string, savings?: boolean): Category => ({
      id: `c${code}${name}`, code, name, kind: 'gasto', icon: 'tag', color: '#000', budget: { type: 'none' }, order: 0, savings,
    });
    const merged = mergeImport(existing, {
      categories: [cat('I', 'Impuestos'), cat('S', 'Servicios'), cat('I', 'Inversión / Ahorro', true), cat('X', 'Extras'), cat('V', 'Categoría V')],
      rubros: [], movements: [], months: [], warnings: [],
    });
    expect(merged.categories.map((c) => c.name)).toEqual(['Impuestos', 'Servicios']);
  });
});

describe('cuentas', () => {
  const data: Data = { ...emptyData(), ...t };
  const ali = t.categories.find((c) => c.name === 'Alimentación')!;
  data.categories = t.categories.map((c) => (c.id === ali.id ? { ...c, budget: { type: 'fixed', amount: 20000 } } : c));
  const ix = buildIndex(data);

  it('«Pasado del presupuesto» cuenta solo las categorías con presupuesto', () => {
    const d = { ...data, movements: [mov('2026-10-03', 30000, rubroNamed('Alquiler').id), mov('2026-10-04', 500, rubroNamed('Feria').id)] };
    const s = monthSummary(d, ix, '2026-10', true);
    expect(s.expense).toBe(30500);
    expect(s.budgetedExpense).toBe(500);
    expect(s.diff).toBe(-19500);
    // Sin ningún presupuesto no hay «pasado»
    const none = monthSummary({ ...d, categories: t.categories }, buildIndex({ ...d, categories: t.categories }), '2026-10', true);
    expect(none.budget).toBe(0);
    expect(none.diff).toBe(0);
  });

  it('«Real contra presupuesto»: primero las pasadas, después las que tienen gasto y al final las que están en $ 0', () => {
    const cats = data.categories.map((c) => (c.name === 'Fijos' ? { ...c, budget: { type: 'fixed', amount: 10000 } as const } : c.name === 'Salud' ? { ...c, budget: { type: 'fixed', amount: 100 } as const } : c));
    const d = { ...data, categories: cats, movements: [mov('2026-10-03', 12000, rubroNamed('Alquiler').id), mov('2026-10-04', 500, rubroNamed('Feria').id)] };
    const s = monthSummary(d, buildIndex(d), '2026-10', true);
    expect(s.rows.map((r) => r.category.name)).toEqual(['Fijos', 'Alimentación', 'Salud']);
  });

  it('la variación del mes en curso solo avisa la suba', () => {
    const d = { ...data, movements: [mov('2026-09-10', 10000, rubroNamed('Feria').id), mov('2026-10-02', 500, rubroNamed('Feria').id)] };
    expect(expenseChange(d, ix, '2026-10', false, '2026-10')).toBeNull();
    expect(expenseChange(d, ix, '2026-10')).toBeCloseTo(-0.95);
    const up = { ...d, movements: [...d.movements, mov('2026-10-05', 12000, rubroNamed('Feria').id)] };
    expect(expenseChange(up, ix, '2026-10', false, '2026-10')).toBeCloseTo(0.25);
  });

  it('pasar un presupuesto de monto a % del ingreso convierte el número', () => {
    expect(convertBudget(20000, 'percentIncome', 200000)).toBe(10);
    expect(convertBudget(10, 'fixed', 187892)).toBe(18789);
    expect(convertBudget(20000, 'percentIncome', 0)).toBeNull();
    expect(convertBudget(null, 'fixed', 1000)).toBeNull();
  });
});

describe('gastos fijos y datos', () => {
  it('un fijo de un rubro archivado no se pide', () => {
    const luz = rubroNamed('Luz');
    const d: Data = {
      ...emptyData(),
      ...t,
      rubros: t.rubros.map((r) => (r.id === luz.id ? { ...r, archived: true } : r)),
      recurring: [{ id: 'f', rubroId: luz.id, kind: 'gasto', amount: 4000, day: 5, doneThrough: '2026-10', createdAt: 0 }],
    };
    expect(pendingRecurring(d, '2026-11', '2026-11-12')).toHaveLength(0);
  });

  it('los íconos de línea se pasan a ilustraciones una sola vez: lo que se elige después queda', () => {
    const v1 = normalizeData({ version: 1, categories: [{ ...t.categories[0], icon: 'cart' }], rubros: t.rubros } as never);
    expect(v1.categories[0].icon).toBe('m:super');
    expect(v1.version).toBe(2);
    const chosen = normalizeData({ ...v1, categories: [{ ...v1.categories[0], icon: 'cart' }] });
    expect(chosen.categories[0].icon).toBe('cart');
    // Y «cuota» deja de reconocer «Colegio y cursos» en los datos de antes
    const old = normalizeData({ version: 1, rubros: [{ ...rubroNamed('Colegio y cursos'), keywords: ['colegio', 'cuota'] }] } as never);
    expect(old.rubros[0].keywords).toEqual(['colegio']);
  });

  it('el ejemplo guardado de otro mes se vuelve a armar', () => {
    const d = { ...emptyData(), movements: [mov('2026-10-03', 100, 'r')], settings: { ...emptyData().settings, example: true } };
    expect(exampleOutdated(d, '2026-10-21')).toBe(false);
    expect(exampleOutdated(d, '2026-12-05')).toBe(true);
    expect(exampleOutdated({ ...d, settings: { ...d.settings, example: undefined } }, '2026-12-05')).toBe(false);
  });
});

// --- Segunda revisión: resumen, diezmo, hogar compartido, tickets y dólares ---------------------------------------

describe('revisión: resumen y diezmo', () => {
  const cat = (id: string, name: string, extra: Partial<Category> = {}): Category => ({
    id, name, kind: 'gasto', icon: 'm:otros', color: '#888', budget: { type: 'none' }, order: 0, ...extra,
  });
  const categories: Category[] = [
    cat('ali', 'Alimentación', { budget: { type: 'fixed', amount: 20000 } }),
    cat('fij', 'Fijos', { budget: { type: 'fixed', amount: 30000 } }),
    cat('die', 'Diezmos', { budget: { type: 'percentIncome', pct: 10 } }),
    cat('ing', 'Ingresos', { kind: 'ingreso' }),
  ];
  const rubros: Rubro[] = [['super', 'ali'], ['alquiler', 'fij'], ['diezmo', 'die'], ['sueldo', 'ing']].map(([id, categoryId]) => ({ id, name: id, categoryId, keywords: [] }));
  const m = (rubroId: string, date: string, amount: number): Movement =>
    ({ id: `${rubroId}${date}${amount}`, rubroId, date, amount, kind: rubroId === 'sueldo' ? 'ingreso' : 'gasto', origin: 'manual', createdAt: 0 });
  const base = (movements: Movement[], extra: Partial<Data> = {}): Data =>
    ({ ...emptyData(), categories, rubros, movements, ...extra, settings: { ...emptyData().settings, onboarded: true } });

  it('un fijo olvidado sigue «sin anotar» aunque después se anote o se saltee un mes posterior', async () => {
    const { monthReport } = await import('../report');
    const { skipRecurring } = await import('../recurring');
    const alquiler = { id: 'r-alq', rubroId: 'alquiler', kind: 'gasto' as const, amount: 24000, day: 1, createdAt: Date.parse('2026-06-01T12:00:00') };
    // Octubre olvidado; el 1/11 «Anotar todos» sube doneThrough a noviembre
    const d = base([m('sueldo', '2026-10-01', 100000), m('alquiler', '2026-11-01', 24000)], { recurring: [{ ...alquiler, doneThrough: '2026-11' }] });
    const r = monthReport(d, buildIndex(d), '2026-10');
    expect(r.recurring.missing.map((x) => x.id)).toEqual(['r-alq']);
    expect(r.recurring.skipped).toEqual([]);
    // Salteado de verdad en octubre, y anotado noviembre: sigue «salteado»
    const skipped = { ...skipRecurring({ ...alquiler, doneThrough: '2026-09' }, '2026-10'), doneThrough: '2026-11' };
    const d2 = { ...d, recurring: [skipped] };
    expect(monthReport(d2, buildIndex(d2), '2026-10').recurring.skipped.map((x) => x.id)).toEqual(['r-alq']);
  });

  it('un mes cerrado sin ingresos: el presupuesto en % y el diezmo usan el mismo ingreso (el real)', async () => {
    const { monthReport } = await import('../report');
    const { percentCards } = await import('../stats');
    const d = base([m('sueldo', '2026-09-01', 100000), m('diezmo', '2026-10-05', 15000), m('super', '2026-10-06', 5000)]);
    const ix = buildIndex(d);
    const r = monthReport(d, ix, '2026-10');
    const line = [...r.budget!.over, ...r.budget!.under].find((l) => l.category.id === 'die')!;
    expect(line.budget).toBe(0);
    expect(r.percent[0].expected).toBe(0);
    expect(r.budget!.total).toBe(50000);
    // Estadísticas → Mes de ese mes cerrado dice lo mismo; el mes en curso sí estima con el anterior
    expect(monthSummary(d, ix, '2026-10', false, '2026-11').budget).toBe(50000);
    expect(percentCards(d, ix, '2026-10', '2026-10')[0]).toMatchObject({ income: 100000, incomeEstimated: true, expected: 10000 });
  });

  it('dar de más en el diezmo no es pasarse: el titular y la tarjeta del presupuesto dicen lo mismo', async () => {
    const { monthReport } = await import('../report');
    const d = base([m('sueldo', '2026-10-01', 100000), m('super', '2026-10-03', 19000), m('alquiler', '2026-10-04', 29500), m('diezmo', '2026-10-05', 15000)]);
    const r = monthReport(d, buildIndex(d), '2026-10');
    expect(r.mood).toBe('celebrando');
    expect(r.budget).toMatchObject({ total: 60000, spent: 58500, diff: -1500, extra: 5000 });
    expect(r.budget!.over.map((l) => l.category.id)).toEqual(['die']);
  });

  it('cambiar el % del diezmo cierra la cuenta con el % de antes (no inventa una deuda)', async () => {
    const { ledgerAfterChange, percentLedger } = await import('../ledger');
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const d = base(months.flatMap((mo) => [m('sueldo', `${mo}-01`, 100000), m('diezmo', `${mo}-02`, 10000)]));
    const prev = d.categories.find((c) => c.id === 'die')!;
    const next: Category = { ...prev, budget: { type: 'percentIncome', pct: 12 } };
    const ledger = ledgerAfterChange(d, buildIndex(d), prev, next, '2026-10');
    expect(ledger).toEqual({ from: '2026-10', opening: 0 });
    const d12 = { ...d, categories: d.categories.map((c) => (c.id === 'die' ? { ...next, ledger } : c)) };
    expect(percentLedger(d12, buildIndex(d12), 'die', '2026-10').pending).toBe(0);
    // Sin cambio de %, o con la cuenta cambiada a mano, queda como venía
    expect(ledgerAfterChange(d, buildIndex(d), prev, { ...prev, name: 'Diezmo' }, '2026-10')).toBeUndefined();
  });
});

describe('revisión: hogar compartido (mezcla)', async () => {
  const { localChanges, mergeRemote, outRecords, presentHashes, recordHashes, toRecords, sharedSettings } = await import('../sync');
  const { dueMovements } = await import('../recurring');
  let clock = Date.parse('2026-10-21T12:00:00.000Z');
  const rem = (kind: 'settings' | 'rubro' | 'movement' | 'invoice' | 'goal' | 'recurring', id: string, data: unknown, deleted = false) => ({
    kind, id, data: JSON.parse(JSON.stringify(data)), updatedAt: new Date((clock += 1000)).toISOString(), updatedBy: 'otro', deleted,
  });
  const cats: Category[] = [{ id: 'ali', name: 'Alimentación', kind: 'gasto', icon: 'm:otros', color: '#888', budget: { type: 'none' }, order: 0 }];
  const rubs: Rubro[] = [{ id: 'super', name: 'Super', categoryId: 'ali', keywords: [] }, { id: 'feria', name: 'Feria', categoryId: 'ali', keywords: [] }];
  const home = (): Data => normalizeData({
    categories: cats, rubros: rubs,
    movements: [mov('2026-10-10', 500, 'feria', { id: 'mf' }), mov('2026-10-11', 900, 'super', { id: 'ms' })],
    goals: [{ id: 'g1', name: 'Viaje', icon: 'plane', target: 10000, saved: 100 }],
    settings: { ...emptyData().settings, onboarded: true, learned: { disco: 'super' } },
  });
  const pendingOf = (synced: Record<string, string>, d: Data) => new Set(localChanges(synced, d).changed.map((c) => c.key));

  it('lo que esta versión no conoce se guarda y no se manda de vuelta', () => {
    const d = home();
    const synced = recordHashes(toRecords(d));
    const res = mergeRemote(d, [rem('settings', 'hogar', { ...sharedSettings(d.settings), theme: 'oscuro' }), rem('invoice', 'f9', { id: 'f9', kind: 'recibo', fileName: 'r.pdf', mime: 'application/pdf', items: [], createdAt: 1 })], []);
    expect(outRecords(localChanges({ ...synced, ...presentHashes(res.hashes) }, res.data))).toEqual([]);
    // Y si después cambia algo de acá, se manda con lo que no conoce
    const later = { ...res.data, settings: { ...res.data.settings, learned: { ...res.data.settings.learned, tata: 'super' } } };
    const out = outRecords(localChanges({ ...synced, ...presentHashes(res.hashes) }, later));
    expect(out[0].data).toMatchObject({ theme: 'oscuro' });
    expect(res.data.invoices[0].kind).toBe('recibo');
  });

  it('dos aportes a la misma meta casi a la vez se suman', () => {
    const b = home();
    const synced = recordHashes(toRecords(b));
    const mine = { ...b, goals: [{ ...b.goals[0], saved: 130 }] };
    const res = mergeRemote(mine, [rem('goal', 'g1', { ...b.goals[0], saved: 150 })], pendingOf(synced, mine), { goals: { g1: 100 } });
    expect(res.data.goals[0].saved).toBe(180);
    expect(res.goalBases).toEqual({ g1: 150 });
    // Lo mismo que llega de nuevo (el margen) no se vuelve a sumar
    const again = mergeRemote(res.data, [rem('goal', 'g1', { ...b.goals[0], saved: 150 })], ['goal:g1'], { goals: { g1: 150 } });
    expect(again.data.goals[0].saved).toBe(180);
  });

  it('un rubro unido en otro teléfono no deja huérfano lo anotado acá sin mandar: el rubro queda', () => {
    const b = home();
    const synced = recordHashes(toRecords(b));
    const mine = { ...b, movements: [...b.movements, mov('2026-10-20', 700, 'feria', { id: 'mnuevo' })] };
    const res = mergeRemote(mine, [rem('movement', 'mf', { ...b.movements[0], rubroId: 'super' }), rem('rubro', 'feria', {}, true)], pendingOf(synced, mine));
    const ix = buildIndex(res.data);
    expect(ix.categoryOf(res.data.movements.find((x) => x.id === 'mnuevo')!)?.id).toBe('ali');
    expect(res.revived).toEqual(['rubro:feria']);
    // Vuelve al hogar con lo nuevo (lo borrado en el servidor sale de lo sincronizado, como en el motor)
    const after = { ...synced, ...presentHashes(res.hashes) };
    for (const [k, h] of Object.entries(res.hashes)) if (h === null) delete after[k];
    const out = outRecords(localChanges(after, res.data)).map((o) => `${o.kind}:${o.id}`).sort();
    expect(out).toEqual(['movement:mnuevo', 'rubro:feria']);
    // Sin nada pendiente, la lápida se aplica
    expect(mergeRemote(b, [rem('rubro', 'feria', {}, true)], []).data.rubros.map((r) => r.id)).toEqual(['super']);
  });

  it('un gasto fijo anotado en dos teléfonos a la vez queda una sola vez', () => {
    const d0 = home();
    const d = { ...d0, recurring: [{ id: 'r-alq', rubroId: 'super', kind: 'gasto' as const, amount: 24000, day: 1, doneThrough: '2026-10', createdAt: 0 }] };
    const synced = recordHashes(toRecords(d));
    const a = dueMovements(d, '2026-11', '2026-11-01');
    const b = dueMovements(d, '2026-11', '2026-11-01');
    expect(a[0].movement.id).toBe(b[0].movement.id);
    const mine = { ...d, movements: [...d.movements, ...b.map((x) => x.movement)], recurring: d.recurring.map((r) => ({ ...r, doneThrough: '2026-11' })) };
    const res = mergeRemote(mine, [rem('movement', a[0].movement.id, a[0].movement), rem('recurring', 'r-alq', { ...d.recurring[0], doneThrough: '2026-11' })], pendingOf(synced, mine));
    expect(res.data.movements.filter((x) => x.date.startsWith('2026-11')).map((x) => x.amount)).toEqual([24000]);
  });
});

describe('revisión: tickets y dólares', () => {
  it('ticket de Disco impreso: sin renglones del año, de la cantidad ni del código de seguridad', () => {
    const PRINTED = ['Disco', 'e-Ticket', 'BJ1000001 17/10/2026', 'CONTADO', 'AGUJA SIN HUESO 422.36', '1.324 KG x 319.00', 'BONDIOLA ENTER MEDIA 248.83',
      '1.670 KG x 149.00', 'PANAL BABYSEC PREMIU 949.00', '1.000 UN x 949.00', 'TOTAL: $ 1620.19', 'Cod. de Seguridad: q7RxP4', 'Res. DGI 2379/2012'].join('\n');
    const p = parseInvoiceText(PRINTED);
    expect(p.items.map((i) => [i.description, i.amount])).toEqual([['AGUJA SIN HUESO', 422.36], ['BONDIOLA ENTER MEDIA', 248.83], ['PANAL BABYSEC PREMIU', 949]]);
    expect(p.total).toBe(1620.19);
  });

  it('una compra en dólares ya anotada se reconoce por la cuenta de la nota, con cualquier cotización', () => {
    const tx = { date: '2026-10-10', description: 'AMAZON', merchant: 'AMAZON', key: 'amazon', amount: 100, currency: 'usd', kind: 'compra' } as Parameters<typeof findDuplicates>[0][number];
    const anotado = mov('2026-10-10', 4250, 'r', { note: 'U$S 100 × 42,50' });
    expect(findDuplicates([tx], [anotado], 40).size).toBe(1);
    expect(findDuplicates([tx], [anotado]).size).toBe(1);
    // Otro monto en dólares no
    expect(findDuplicates([tx], [{ ...anotado, note: 'U$S 120 × 42,50' }], 42.5).size).toBe(0);
  });
});
