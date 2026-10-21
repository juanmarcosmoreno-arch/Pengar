import { describe, expect, it } from 'vitest';
import { learnFrom, merchantKey, suggestRubro } from '../classify';
import type { Cell } from '../importSheet';
import type { TextBox } from '../ocrLines';
import {
  detectCard,
  findDuplicates,
  installmentOf,
  normalizeMerchant,
  parseStatementRows,
  parseStatementTable,
  parseStatementText,
  planillaMonths,
  rowsFromBoxes,
  statementInfo,
  statementKind,
  statementPeriod,
  toLocal,
  type StatementCell,
  type StatementRow,
  type StatementTx,
} from '../statement';
import { emptyData, normalizeData, templateData } from '../template';
import type { Data, Movement } from '../types';

// Celdas como las arma el PDF: x y ancho normalizados (una letra ≈ 0,0075 del ancho de la página)
const CW = 0.0075;
const cell = (text: string, x: number): StatementCell => ({ text, x, w: text.length * CW });
/** Celda alineada a la derecha (los importes y sus encabezados) */
const right = (text: string, r: number): StatementCell => ({ text, x: r - text.length * CW, w: text.length * CW });
const row = (...cells: StatementCell[]): StatementRow => ({ cells });

/** Lo esencial de cada movimiento, para comparar de un vistazo */
const brief = (txs: StatementTx[]) => txs.map((t) => [t.date, t.kind, t.currency, t.amount, t.key]);

// --- OCA: FECHA, DESCRIPCION, IMPORTE $, IMPORTE U$S. Cierre en enero, con compras de diciembre --------------

const OCA: StatementRow[] = [
  row(cell('OCA', 0.05), cell('Estado de cuenta', 0.4)),
  row(cell('Titular: ANA PEREZ', 0.05), cell('Cuenta Nro. 0012345', 0.6)),
  row(cell('Fecha de cierre: 25/01/2026', 0.05), cell('Vencimiento: 10/02/2026', 0.55)),
  row(cell('Pago mínimo', 0.05), right('$ 2.500,00', 0.72)),
  row(cell('FECHA', 0.05), cell('DESCRIPCION', 0.14), right('IMPORTE $', 0.72), right('IMPORTE U$S', 0.92)),
  row(cell('26/12', 0.05), cell('SALDO ANTERIOR', 0.14), right('18.450,20', 0.72), right('35,00', 0.92)),
  row(cell('28/12', 0.05), cell('TIENDA INGLESA SUC 12 MONTEVIDEO', 0.14), right('2.345,60', 0.72)),
  row(cell('30/12', 0.05), cell('NETFLIX.COM', 0.14), right('15,99', 0.92)),
  row(cell('02/01', 0.05), cell('SU PAGO - GRACIAS', 0.14), right('-18.450,20', 0.72)),
  row(cell('02/01', 0.05), cell('SU PAGO - GRACIAS', 0.14), right('-35,00', 0.92)),
  row(cell('03/01', 0.05), cell('MERCADOPAGO*LA PASIVA', 0.14), right('890,00', 0.72)),
  row(cell('05/01', 0.05), cell('ANCAP EST 1234 CARRASCO', 0.14), right('2.100,00', 0.72)),
  row(cell('10/01', 0.05), cell('TIENDA INGLESA 7', 0.14), right('1.120,40', 0.72)),
  row(cell('12/01', 0.05), cell('FARMASHOP 14 CUOTA 02/03', 0.14), right('1.500,00', 0.72)),
  row(cell('15/01', 0.05), cell('REINTEGRO IVA LEY 19210', 0.14), right('-45,20', 0.72)),
  row(cell('20/01', 0.05), cell('INTERESES COMPENSATORIOS', 0.14), right('120,00', 0.72)),
  row(cell('IVA S/INTERESES', 0.14), right('26,40', 0.72)),
  row(cell('TOTAL A PAGAR', 0.14), right('25.000,00', 0.72), right('15,99', 0.92)),
  row(cell('Cotización del dólar: 40,25', 0.05)),
];

describe('estado de cuenta OCA (PDF con columnas)', () => {
  const txs = parseStatementRows(OCA, { today: '2026-02-01' });
  it('lee cada renglón con su moneda por la columna', () => {
    expect(brief(txs)).toEqual([
      ['2025-12-26', 'saldo', 'local', 18450.2, 'saldo'],
      ['2025-12-26', 'saldo', 'usd', 35, 'saldo'],
      ['2025-12-28', 'compra', 'local', 2345.6, 'tienda inglesa'],
      ['2025-12-30', 'compra', 'usd', 15.99, 'netflix'],
      ['2026-01-02', 'pago', 'local', -18450.2, 'su pago gracias'],
      ['2026-01-02', 'pago', 'usd', -35, 'su pago gracias'],
      ['2026-01-03', 'compra', 'local', 890, 'pasiva'],
      ['2026-01-05', 'compra', 'local', 2100, 'ancap'],
      ['2026-01-10', 'compra', 'local', 1120.4, 'tienda inglesa'],
      ['2026-01-12', 'compra', 'local', 1500, 'farmashop'],
      ['2026-01-15', 'credito', 'local', -45.2, 'reintegro'],
      ['2026-01-20', 'cargo', 'local', 120, 'intereses'],
      // Sin fecha: queda con la del renglón de arriba
      ['2026-01-20', 'cargo', 'local', 26.4, 'iva'],
    ]);
  });
  it('comercios limpios, descripción como viene y cuotas', () => {
    expect(txs[2]).toMatchObject({ description: 'TIENDA INGLESA SUC 12 MONTEVIDEO', merchant: 'Tienda Inglesa' });
    expect(txs[3].merchant).toBe('Netflix');
    expect(txs[6].merchant).toBe('La Pasiva');
    expect(txs[9]).toMatchObject({ merchant: 'Farmashop', installment: '2/3' });
    expect(txs.filter((t) => t.installment)).toHaveLength(1);
  });
  it('encabezado: cierre, vencimiento, cotización y tarjeta', () => {
    const text = OCA.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');
    const info = statementInfo(text);
    expect(info).toEqual({ closing: '2026-01-25', due: '2026-02-10', usdRate: 40.25, card: 'OCA' });
    expect(statementPeriod(txs, info)).toEqual({ from: '2025-12-26', to: '2026-01-25' });
  });
  it('la fecha de hoy no cambia nada si el documento trae el cierre', () => {
    expect(brief(parseStatementRows(OCA, { today: '2030-06-01' }))).toEqual(brief(txs));
  });
});

// --- Visa BROU / Itaú: Fecha, Comprobante, Descripción, Cuota, Moneda, Importe origen, Importe $, Importe U$S ---

const VISA: StatementRow[] = [
  row(cell('BROU', 0.03), cell('Tarjeta VISA Internacional', 0.3)),
  row(cell('Estado de cuenta', 0.03), cell('Período: 26/08/2025 al 25/09/2025', 0.5)),
  row(cell('Vencimiento: 10/10/2025', 0.5)),
  row(
    cell('Fecha', 0.03), cell('Comprobante', 0.11), cell('Descripción', 0.22), cell('Cuota', 0.47), cell('Moneda', 0.52),
    right('Importe origen', 0.72), right('Importe $', 0.84), right('Importe U$S', 0.96),
  ),
  row(cell('28/08/25', 0.03), cell('004512', 0.11), cell('TIENDA INGLESA SUC 12', 0.22), cell('$', 0.54), right('2.345,60', 0.72), right('2.345,60', 0.84)),
  row(cell('01/09/25', 0.03), cell('004513', 0.11), cell('DISCO N 7 MONTEVIDEO', 0.22), cell('01/06', 0.47), cell('$', 0.54), right('12.000,00', 0.72), right('2.000,00', 0.84)),
  row(cell('03/09/25', 0.03), cell('004514', 0.11), cell('SPOTIFY P2A4B6C8', 0.22), cell('U$S', 0.54), right('10,99', 0.72), right('10,99', 0.96)),
  row(cell('05/09/25', 0.03), cell('004515', 0.11), cell('AMAZON.COM*2K4AB1', 0.22), cell('EUR', 0.54), right('20,00', 0.72), right('23,50', 0.96)),
  row(cell('10/09/25', 0.03), cell('PAGO RECIBIDO', 0.22), right('-15.000,00', 0.84)),
  row(cell('15/09/25', 0.03), cell('004516', 0.11), cell('DEVOLUCION TIENDA INGLESA', 0.22), cell('$', 0.54), right('500,00', 0.72), right('500,00 CR', 0.84)),
  row(cell('20/09/25', 0.03), cell('COMISION RENOVACION ANUAL', 0.22), right('350,00', 0.84)),
  row(cell('22/09/25', 0.03), cell('004517', 0.11), cell('MP *MERCADOLIBRE', 0.22), cell('03/12', 0.47), cell('$', 0.54), right('36.000,00', 0.72), right('3.000,00', 0.84)),
  row(cell('24/09/25', 0.03), cell('004518', 0.11), cell('PAYPAL *STEAM GAMES', 0.22), cell('U$S', 0.54), right('4,99', 0.72), right('4,99', 0.96)),
  row(cell('SALDO CONTADO', 0.22), right('20.540,60', 0.84), right('39,48', 0.96)),
];

describe('estado de cuenta Visa BROU (con importe de origen)', () => {
  const txs = parseStatementRows(VISA, { today: '2025-10-01' });
  it('usa la columna en pesos o en dólares, no la de origen', () => {
    expect(brief(txs)).toEqual([
      ['2025-08-28', 'compra', 'local', 2345.6, 'tienda inglesa'],
      ['2025-09-01', 'compra', 'local', 2000, 'disco'],
      ['2025-09-03', 'compra', 'usd', 10.99, 'spotify'],
      ['2025-09-05', 'compra', 'usd', 23.5, 'amazon'],
      ['2025-09-10', 'pago', 'local', -15000, 'pago recibido'],
      ['2025-09-15', 'credito', 'local', -500, 'tienda inglesa'],
      ['2025-09-20', 'cargo', 'local', 350, 'comision'],
      ['2025-09-22', 'compra', 'local', 3000, 'mercadolibre'],
      ['2025-09-24', 'compra', 'usd', 4.99, 'steam'],
    ]);
  });
  it('saca el comprobante y la moneda de la descripción; la cuota va aparte', () => {
    expect(txs[0].description).toBe('TIENDA INGLESA SUC 12');
    expect(txs[1]).toMatchObject({ merchant: 'Disco', installment: '1/6' });
    expect(txs[3]).toMatchObject({ description: 'AMAZON.COM*2K4AB1', merchant: 'Amazon' });
    expect(txs[7]).toMatchObject({ merchant: 'Mercadolibre', installment: '3/12' });
    expect(txs[8].merchant).toBe('Steam Games');
  });
  it('período y tarjeta', () => {
    const info = statementInfo(VISA.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n'));
    expect(info).toMatchObject({ from: '2025-08-26', closing: '2025-09-25', due: '2025-10-10', card: 'Visa BROU' });
    expect(statementPeriod(txs, info)).toEqual({ from: '2025-08-26', to: '2025-09-25' });
  });
  it('el mismo estado de cuenta en texto plano (sin posiciones)', () => {
    const text = VISA.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');
    expect(brief(parseStatementText(text, { today: '2025-10-01' }))).toEqual(brief(txs));
  });
});

// --- Santander en texto plano: fechas «19 NOV» sin año, columnas PESOS y DOLARES -----------------------------

const SANTANDER = `Banco Santander Uruguay
Resumen de Tarjeta de Crédito Santander Visa
Cierre actual: 18 DIC 2025    Vencimiento: 05 ENE 2026
Cierre anterior: 18 NOV 2025
Límite de compra $ 150.000,00   Disponible $ 98.500,00
FECHA DETALLE PESOS DOLARES
19 NOV SALDO ANTERIOR 12.300,00 0,00
25 NOV SU PAGO EN REDPAGOS -12.300,00
27 NOV TIENDA INGLESA SUC 3 1.876,50
02 DIC PEDIDOSYA*BURGER KING 640,00
05 DIC NETFLIX.COM U$S 15,99
10 DIC FARMACIA SAN ROQUE C.2/6 980,00
12 DIC DLO*UBER TRIP 312,00
15 DIC REINTEGRO IVA 21,30 CR
15 DIC SEGURO SALDO DEUDOR 95,00
16 DIC STEAM GAMES 0,00 4,99
TOTAL A PAGAR 14.200,00 4,99`;

describe('estado de cuenta Santander (texto plano)', () => {
  const txs = parseStatementText(SANTANDER, { today: '2026-01-02' });
  it('fechas con el mes en letras y moneda por símbolo o por orden de columnas', () => {
    expect(brief(txs)).toEqual([
      ['2025-11-19', 'saldo', 'local', 12300, 'saldo'],
      ['2025-11-25', 'pago', 'local', -12300, 'su pago redpagos'],
      ['2025-11-27', 'compra', 'local', 1876.5, 'tienda inglesa'],
      ['2025-12-02', 'compra', 'local', 640, 'pedidosya'],
      ['2025-12-05', 'compra', 'usd', 15.99, 'netflix'],
      ['2025-12-10', 'compra', 'local', 980, 'farmacia san roque'],
      ['2025-12-12', 'compra', 'local', 312, 'uber'],
      ['2025-12-15', 'credito', 'local', -21.3, 'reintegro'],
      ['2025-12-15', 'cargo', 'local', 95, 'seguro'],
      ['2025-12-16', 'compra', 'usd', 4.99, 'steam'],
    ]);
    expect(txs[5]).toMatchObject({ merchant: 'Farmacia San Roque', installment: '2/6' });
    expect(txs[6].merchant).toBe('Uber Trip');
  });
  it('período desde el cierre anterior', () => {
    const info = statementInfo(SANTANDER);
    expect(info).toMatchObject({ closing: '2025-12-18', previous: '2025-11-18', due: '2026-01-05', card: 'Visa Santander' });
    expect(statementPeriod(txs, info)).toEqual({ from: '2025-11-19', to: '2025-12-18' });
  });
});

// --- Scotiabank en texto plano: títulos arriba y valores abajo, fechas dd-mm cruzando el año --------------------

const SCOTIA = `Scotiabank Uruguay S.A.
Tarjeta Mastercard Black
Fecha de cierre    Fecha de vencimiento    Pago mínimo
05/01/2026         20/01/2026              1.200,00
Fecha Descripción Importe
08-12 COMPRA TIENDA INGLESA 1.050,00
15-12 PAYPAL *SPOTIFY USD 10,99
22-12 PAGO - GRACIAS 9.870,00
24-12 ANULACION COMPRA DEVOTO 300,00
28-12 COSTO DE EMISION 150,00
02-01 DEVOTO 22 PUNTA DEL ESTE 2.400,00
03-01 TIMBRE 12,00
04-01 TIENDA INGLESA SUC 5 MALDONADO 860,30
TOTAL DEL MES 3.612,00
Tipo de cambio: 40,10`;

describe('estado de cuenta Scotiabank (texto plano)', () => {
  const txs = parseStatementText(SCOTIA, { today: '2026-01-10' });
  it('lee compras, pagos, anulaciones y cargos', () => {
    expect(brief(txs)).toEqual([
      ['2025-12-08', 'compra', 'local', 1050, 'tienda inglesa'],
      ['2025-12-15', 'compra', 'usd', 10.99, 'spotify'],
      ['2025-12-22', 'pago', 'local', -9870, 'pago gracias'],
      ['2025-12-24', 'credito', 'local', -300, 'devoto'],
      ['2025-12-28', 'cargo', 'local', 150, 'costo'],
      ['2026-01-02', 'compra', 'local', 2400, 'devoto'],
      ['2026-01-03', 'cargo', 'local', 12, 'timbre'],
      ['2026-01-04', 'compra', 'local', 860.3, 'tienda inglesa'],
    ]);
    expect(txs[0].merchant).toBe('Tienda Inglesa');
    expect(txs[5].merchant).toBe('Devoto');
  });
  it('cierre y vencimiento del renglón de abajo, cotización y tarjeta', () => {
    expect(statementInfo(SCOTIA)).toEqual({ closing: '2026-01-05', due: '2026-01-20', usdRate: 40.1, card: 'Master Scotiabank' });
  });
});

// --- Itaú leído con Tesseract: separadores «|», encabezado en dos renglones, moneda pegada y signo suelto --------

const ITAU = `ITAU Mastercard
Fecha de Cierre 23/10/2025 Vencimiento 07/11/2025  Próximo cierre 24/11/2025
FECHA | DESCRIPCION | IMPORTE | IMPORTE
$ U$S
24/09 | TIENDA INGLESA | 1.234,50
25/09 | NETFLIX.COM | U$S 12,99
26/09  FARMASHOP 14 CTA 1 DE 3  1.000,00
30/09  RAPPI*RAPPI URUGUAY 450,00
02/10  SU PAGO EN ABITAB  - 8.000,00
03/10  SPOTIFY 0,00 10,99`;

describe('estado de cuenta Itaú (texto de Tesseract)', () => {
  it('se arregla con el ruido del lector de fotos', () => {
    const txs = parseStatementText(ITAU, { today: '2025-11-01' });
    expect(brief(txs)).toEqual([
      ['2025-09-24', 'compra', 'local', 1234.5, 'tienda inglesa'],
      ['2025-09-25', 'compra', 'usd', 12.99, 'netflix'],
      ['2025-09-26', 'compra', 'local', 1000, 'farmashop'],
      ['2025-09-30', 'compra', 'local', 450, 'rappi'],
      ['2025-10-02', 'pago', 'local', -8000, 'su pago abitab'],
      ['2025-10-03', 'compra', 'usd', 10.99, 'spotify'],
    ]);
    expect(txs[2].installment).toBe('1/3');
    expect(txs[3].merchant).toBe('Rappi');
    expect(statementInfo(ITAU)).toEqual({ closing: '2025-10-23', due: '2025-11-07', card: 'Master Itaú' });
  });
});

// --- Planillas exportadas por el banco ----------------------------------------------------------------------

describe('planilla del banco (CSV o Excel)', () => {
  it('CSV con moneda, importe y cuotas', () => {
    const rows: Cell[][] = [
      ['Movimientos de tarjeta Visa Itaú'],
      ['Fecha de cierre', '25/09/2025'],
      [],
      ['Fecha', 'Descripción', 'Moneda', 'Importe', 'Cuotas'],
      ['28/08/2025', 'TIENDA INGLESA SUC 12', '$', '1.234,56', ''],
      ['30/08/2025', 'NETFLIX.COM', 'U$S', '15,99', ''],
      ['05/09/2025', 'SU PAGO', '$', '-10.000,00', ''],
      ['10/09/2025', 'MOTOCICLO', '$', '2.500,00', '2/12'],
      ['15/09/2025', 'REINTEGRO IVA LEY 19210', '$', '-30,10', ''],
      ['', 'Total', '', '5.000,00', ''],
    ];
    const txs = parseStatementTable(rows);
    expect(brief(txs)).toEqual([
      ['2025-08-28', 'compra', 'local', 1234.56, 'tienda inglesa'],
      ['2025-08-30', 'compra', 'usd', 15.99, 'netflix'],
      ['2025-09-05', 'pago', 'local', -10000, 'su pago'],
      ['2025-09-10', 'compra', 'local', 2500, 'motociclo'],
      ['2025-09-15', 'credito', 'local', -30.1, 'reintegro'],
    ]);
    expect(txs[3].installment).toBe('2/12');
    expect(detectCard(rows.map((r) => r.join(' ')).join('\n'))).toBe('Visa Itaú');
  });
  it('columnas en pesos y en dólares, fechas sin año cruzando el año', () => {
    const txs = parseStatementTable([
      ['Fecha de cierre: 25/01/2026'],
      ['Fecha', 'Descripción', 'Importe $', 'Importe U$S'],
      ['28/12', 'TIENDA INGLESA', '2.345,60', ''],
      ['30/12', 'NETFLIX.COM', '', '15,99'],
      ['03/01', 'DEVOTO', '890,00', null],
      ['12 SET', 'COMPRA VIEJA', '100,00', null],
    ], { today: '2026-02-01' });
    expect(brief(txs)).toEqual([
      ['2025-12-28', 'compra', 'local', 2345.6, 'tienda inglesa'],
      ['2025-12-30', 'compra', 'usd', 15.99, 'netflix'],
      ['2026-01-03', 'compra', 'local', 890, 'devoto'],
      ['2025-09-12', 'compra', 'local', 100, 'vieja'],
    ]);
  });
  it('Excel con fechas de verdad y débito / crédito', () => {
    const txs = parseStatementTable([
      ['Fecha', 'Concepto', 'Débito', 'Crédito'],
      [new Date(Date.UTC(2025, 11, 28)), 'DISCO 7', 1520.5, null],
      [new Date(Date.UTC(2026, 0, 2)), 'PAGO RECIBIDO', null, 8000],
      [46025, 'SPOTIFY', 389, null],
      [46026, 'DEVOLUCION DISCO', null, 120],
    ]);
    expect(brief(txs)).toEqual([
      ['2025-12-28', 'compra', 'local', 1520.5, 'disco'],
      ['2026-01-02', 'pago', 'local', -8000, 'pago recibido'],
      ['2026-01-03', 'compra', 'local', 389, 'spotify'],
      ['2026-01-04', 'credito', 'local', -120, 'disco'],
    ]);
  });
  it('si las compras vienen en negativo (como débitos), da vuelta los signos', () => {
    const txs = parseStatementTable([
      ['Fecha', 'Detalle', 'Importe'],
      ['12/09/2025', 'TIENDA INGLESA', '-1.200,00'],
      ['13/09/2025', 'FARMASHOP', '-450,00'],
      ['15/09/2025', 'DEVOLUCION FARMASHOP', '100,00'],
      ['20/09/2025', 'PAGO RECIBIDO', '1.550,00'],
    ]);
    expect(txs.map((t) => [t.kind, t.amount])).toEqual([['compra', 1200], ['compra', 450], ['credito', -100], ['pago', -1550]]);
  });
  it('sin encabezado reconocible no inventa nada', () => {
    expect(parseStatementTable([['Rubro', 'Monto'], ['UTE', 1200]])).toEqual([]);
  });
});

// --- Detalles de la lectura -------------------------------------------------------------------------------

describe('fechas e importes', () => {
  it('sin ningún año en el documento usa hoy (diciembre en enero es del año anterior)', () => {
    const txs = parseStatementText('12/11 TIENDA INGLESA 1.000,00\n03/01 DISCO 500,00', { today: '2026-01-10' });
    expect(txs.map((t) => t.date)).toEqual(['2025-11-12', '2026-01-03']);
  });
  it('formatos de fecha', () => {
    const txs = parseStatementText(
      ['12-sep-25 NETFLIX U$S 15,99', '13/09/2025 DISCO 100,00', '14.09.25 DEVOTO 200,00', '15 SETIEMBRE TATA 300,00', '1O/O9 TIENDA INGLESA 400,00'].join('\n'),
      { today: '2025-09-30' },
    );
    expect(txs.map((t) => [t.date, t.key])).toEqual([
      ['2025-09-12', 'netflix'], ['2025-09-13', 'disco'], ['2025-09-14', 'devoto'], ['2025-09-15', 'tata'], ['2025-09-10', 'tienda inglesa'],
    ]);
  });
  it('importes: separadores, signo, CR, moneda pegada y porcentajes', () => {
    const txs = parseStatementText(
      [
        '01/09 A COMERCIO 1,234.56', '02/09 B COMERCIO 150,00-', '03/09 C COMERCIO (80,00)', '04/09 D COMERCIO U$S12,99',
        '05/09 E COMERCIO $1.000,00', '06/09 F COMERCIO 0,00 12,99', '07/09 INTERESES TASA 85,00 % 320,00', '08/09 G COMERCIO 75,50CR',
      ].join('\n'),
      { today: '2025-09-30' },
    );
    expect(txs.map((t) => [t.currency, t.amount])).toEqual([
      ['local', 1234.56], ['local', -150], ['local', -80], ['usd', 12.99], ['local', 1000], ['usd', 12.99], ['local', 320], ['local', -75.5],
    ]);
    expect(txs.map((t) => t.kind)).toEqual(['compra', 'credito', 'credito', 'compra', 'compra', 'compra', 'cargo', 'credito']);
  });
  it('renglones sin fecha: solo cargos y créditos del banco, nunca compras ni la cotización', () => {
    const txs = parseStatementText(
      ['10/09 DISCO 500,00', 'IVA S/INTERESES 12,00', 'SUPERMERCADO SIN FECHA 300,00', 'Cotización 40,25', 'SALDO CONTADO 512,00'].join('\n'),
      { today: '2025-09-30' },
    );
    expect(brief(txs)).toEqual([
      ['2025-09-10', 'compra', 'local', 500, 'disco'],
      ['2025-09-10', 'cargo', 'local', 12, 'iva'],
    ]);
  });
  it('renglones sin importe o sin descripción no cuentan', () => {
    expect(parseStatementText('10/09 TIENDA INGLESA\n11/09 1.000,00\nFECHA DESCRIPCION IMPORTE', { today: '2025-09-30' })).toEqual([]);
  });
});

describe('tipo de movimiento', () => {
  it.each([
    ['SU PAGO', 'pago'], ['PAGO RECIBIDO', 'pago'], ['PAGO - GRACIAS', 'pago'], ['PAGO EN REDPAGOS', 'pago'], ['Gracias por su pago', 'pago'],
    ['SALDO ANTERIOR', 'saldo'], ['SALDO CONTADO', 'saldo'], ['TOTAL A PAGAR', 'saldo'], ['PAGO MÍNIMO', 'saldo'], ['LÍMITE DE CRÉDITO', 'saldo'],
    ['DISPONIBLE', 'saldo'], ['REINTEGRO IVA LEY 19210', 'credito'], ['DEVOLUCIÓN COMPRA', 'credito'], ['BONIFICACIÓN CARGO ANUAL', 'credito'],
    ['ANULACIÓN TIENDA INGLESA', 'credito'], ['DTO. LEY 19.210', 'credito'], ['CARGO ANUAL', 'cargo'], ['COMISIÓN POR ATRASO', 'cargo'],
    ['SEGURO DE VIDA', 'cargo'], ['SEGURO SALDO DEUDOR', 'cargo'], ['INTERESES FINANCIACION', 'cargo'], ['IVA S/INTERESES', 'cargo'],
    ['TIMBRE', 'cargo'], ['COSTO DE EMISIÓN', 'cargo'], ['TIENDA INGLESA', 'compra'], ['PAGOS WEB ANTEL', 'compra'], ['MAPFRE SEGUROS', 'compra'],
    ['ANTEL RECARGA SALDO', 'compra'], ['MERCADOPAGO*DISCO', 'compra'],
  ] as const)('%s → %s', (desc, kind) => expect(statementKind(desc)).toBe(kind));
});

describe('cuotas', () => {
  it.each([
    ['FARMASHOP CUOTA 02/06', '2/6'], ['MOTOCICLO CTA 3 DE 12', '3/12'], ['SAN ROQUE C.2/6', '2/6'], ['DIVINO C2/10', '2/10'],
    ['MP *MERCADOLIBRE 04/10', '4/10'], ['Cuota: 1/3 PANADERIA', '1/3'],
  ])('%s → %s', (desc, inst) => expect(installmentOf(desc)).toBe(inst));
  it.each(['TIENDA INGLESA', 'COMPRA 12/09', 'CUOTA 1/1', 'DISCO 7'])('%s no tiene cuota', (desc) => expect(installmentOf(desc)).toBeUndefined());
});

describe('comercios', () => {
  const key = (d: string) => normalizeMerchant(d).key;
  const name = (d: string) => normalizeMerchant(d).merchant;
  it('la misma tienda da la misma clave todos los meses', () => {
    expect(key('TIENDA INGLESA SUC 12 MONTEVIDEO')).toBe('tienda inglesa');
    expect(key('TIENDA INGLESA 7')).toBe('tienda inglesa');
    expect(key('TIENDA INGLESA SUC 12 MONTEVID')).toBe('tienda inglesa');
    expect(key('COMPRA TIENDA INGLESA')).toBe('tienda inglesa');
    expect(key('MERCADOPAGO*TIENDA INGLESA SUC 3')).toBe('tienda inglesa');
    expect(key('NETFLIX.COM')).toBe('netflix');
    expect(key('NETFLIX')).toBe('netflix');
    expect(key('NETFLIX.COM LOS GATOS CA')).toBe('netflix');
    expect(key('FARMASHOP 14 POCITOS')).toBe('farmashop');
    expect(key('FARMASHOP 3 18 DE JULIO')).toBe('farmashop');
    expect(key('DEVOTO 22 PUNTA DEL ESTE')).toBe(key('DEVOTO 5'));
  });
  it('saca procesadores de pago, dominios y códigos', () => {
    expect(key('MERCADOPAGO*LA PASIVA')).toBe('pasiva');
    expect(key('MP *LA PASIVA 18 DE JULIO')).toBe('pasiva');
    expect(key('PAYPAL *SPOTIFY')).toBe('spotify');
    expect(key('SPOTIFY P2A4B6C8')).toBe('spotify');
    expect(key('EBANX*SHEIN')).toBe('shein');
    expect(key('PAYU*AR*UBER')).toBe('uber');
    expect(key('SQ *CAFE BRASILERO')).toBe('cafe brasilero');
    expect(key('AMAZON.COM*2K4AB1')).toBe('amazon');
    expect(key('APPLE.COM/BILL')).toBe('apple');
    expect(name('DLO*UBER TRIP HELP.UBER.COM')).toBe('Uber Trip');
  });
  it('lo que sigue al número de sucursal es la ubicación; la ciudad se saca solo si queda el nombre', () => {
    expect(normalizeMerchant('MC DONALDS 18 DE JULIO')).toEqual({ merchant: 'Mc Donalds', key: 'mc donalds' });
    expect(normalizeMerchant('TATA 123 LAS PIEDRAS')).toEqual({ merchant: 'Tata', key: 'tata' });
    expect(normalizeMerchant('FARMACIA MERCEDES')).toEqual({ merchant: 'Farmacia Mercedes', key: 'farmacia mercedes' });
    expect(normalizeMerchant('SQ *CAFE MONTEVIDEO')).toEqual({ merchant: 'Cafe Montevideo', key: 'cafe montevideo' });
    expect(name('REINTEGRO IVA LEY 19210')).toBe('Reintegro IVA Ley');
  });
  it('rubros genéricos necesitan la palabra que distingue a la tienda', () => {
    expect(key('FARMACIA SAN ROQUE CUOTA 02/06')).toBe('farmacia san roque');
    expect(key('SUPERMERCADO EL DORADO S.A.')).toBe('supermercado dorado');
    expect(key('KIOSCO PEPE')).toBe('kiosco pepe');
    expect(key('MOTOCICLO SRL')).toBe('motociclo');
    expect(key('PANADERÍA LA ESPIGA')).toBe('panaderia espiga');
  });
  it('nombre para mostrar', () => {
    expect(name('TIENDA INGLESA SUC 12 MONTEVIDEO')).toBe('Tienda Inglesa');
    expect(name('SUPERMERCADO EL DORADO S.A.')).toBe('Supermercado el Dorado');
    expect(name('PANADERÍA LA ESPIGA')).toBe('Panadería la Espiga');
    expect(name('UTE')).toBe('UTE');
    expect(name('BAR TABARE')).toBe('Bar Tabare');
    expect(name('Kiosco Pepe')).toBe('Kiosco Pepe');
    expect(name('NETFLIX.COM')).toBe('Netflix');
    expect(name('DEVOLUCION TIENDA INGLESA')).toBe('Tienda Inglesa');
    expect(name('123456')).toBe('123456');
  });
  it('las facturas y la tarjeta comparten lo aprendido', () => {
    expect(merchantKey('TIENDA INGLESA S.A.')).toBe('merchant:tienda inglesa');
    expect(merchantKey('TIENDA INGLESA S.A.')).toBe(`merchant:${key('MERCADOPAGO*TIENDA INGLESA SUC 3')}`);
    const t = templateData();
    const sup = t.rubros.find((r) => r.name === 'Supermercado')!;
    const learned = learnFrom({}, 'Almacén Doña Rosa', [{ description: 'Leche', rubroId: sup.id }]);
    expect(suggestRubro('', normalizeMerchant('MERCADOPAGO*ALMACEN DOÑA ROSA SUC 2').merchant, t.rubros, learned)).toEqual({ rubroId: sup.id, reason: 'aprendido' });
    // Lo aprendido con la clave vieja (el nombre entero) se sigue usando
    expect(suggestRubro('', 'Kiosco Pepe Pocitos', t.rubros, { 'merchant:kiosco pepe pocitos': sup.id })?.reason).toBe('aprendido');
  });
});

describe('cajas de texto → renglones', () => {
  // Palabras sueltas como las devuelve pdf.js, en una página A4 apaisada a lo alto (ancho/alto ≈ 0,7)
  const H = 0.012;
  const word = (text: string, x: number, y: number): TextBox => ({ text, x, y, w: text.length * CW, h: H });
  const words = (text: string, x: number, y: number) => text.split(' ').map((t, i, all) => word(t, x + all.slice(0, i).join(' ').length * CW + (i ? CW : 0), y));
  const boxes: TextBox[] = [
    ...words('FECHA', 0.05, 0.2), ...words('DESCRIPCION', 0.14, 0.2), ...words('IMPORTE $', 0.6525, 0.2), ...words('IMPORTE U$S', 0.8375, 0.2),
    ...words('28/12', 0.05, 0.22), ...words('TIENDA INGLESA SUC 12', 0.14, 0.2205), word('2.345,60', 0.6525, 0.22),
    ...words('30/12', 0.05, 0.24), ...words('NETFLIX.COM', 0.14, 0.24), word('15,99', 0.8825, 0.2395),
  ];
  const rows = rowsFromBoxes(boxes, 0.7);
  it('une las palabras cercanas y separa las columnas', () => {
    expect(rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ['FECHA', 'DESCRIPCION', 'IMPORTE $', 'IMPORTE U$S'],
      ['28/12', 'TIENDA INGLESA SUC 12', '2.345,60'],
      ['30/12', 'NETFLIX.COM', '15,99'],
    ]);
  });
  it('y la moneda sale de la columna', () => {
    const txs = parseStatementRows([row(cell('Cierre 25/01/2026', 0.05)), ...rows]);
    expect(brief(txs)).toEqual([
      ['2025-12-28', 'compra', 'local', 2345.6, 'tienda inglesa'],
      ['2025-12-30', 'compra', 'usd', 15.99, 'netflix'],
    ]);
  });
});

// --- Contra lo ya anotado -----------------------------------------------------------------------------------

let n = 0;
function mov(date: string, amount: number, extra: Partial<Movement> = {}): Movement {
  return { id: `m${++n}`, date, amount, kind: 'gasto', rubroId: 'r', origin: 'manual', createdAt: 0, ...extra };
}
function tx(date: string, amount: number, description: string, extra: Partial<StatementTx> = {}): StatementTx {
  return { date, amount, description, ...normalizeMerchant(description), currency: 'local', kind: 'compra', ...extra };
}

describe('duplicados y planilla', () => {
  it('empareja con lo ya anotado: mismo monto (±1%) y a no más de 3 días', () => {
    const txs = [
      tx('2025-12-28', 2345.6, 'TIENDA INGLESA SUC 12'),
      tx('2026-01-05', 2100, 'ANCAP EST 1234'),
      tx('2026-01-10', 1120.4, 'TIENDA INGLESA 7'),
      tx('2026-01-12', 1500, 'FARMASHOP 14'),
      tx('2026-01-02', -18450.2, 'SU PAGO', { kind: 'pago' }),
      tx('2026-01-15', 45.2, 'REINTEGRO IVA', { kind: 'credito', amount: -45.2 }),
    ];
    const movements = [
      mov('2025-12-27', 2345, { merchant: 'Tienda Inglesa', origin: 'factura' }),
      mov('2026-01-07', 2000),
      mov('2026-01-11', 1120, { note: 'súper' }),
      mov('2026-01-17', 1500),
      mov('2025-12-01', 2345.6, { origin: 'planilla', monthly: true }),
      mov('2026-01-02', 18450.2, { kind: 'ingreso' }),
    ];
    const d = findDuplicates(txs, movements);
    expect([...d.entries()].sort()).toEqual([[0, movements[0].id], [2, movements[2].id]]);
  });
  it('cada movimiento con una sola compra, prefiriendo el comercio parecido', () => {
    const txs = [tx('2026-01-05', 500, 'DISCO 7'), tx('2026-01-06', 500, 'FARMASHOP 14'), tx('2026-01-06', 500, 'DEVOTO')];
    const movements = [mov('2026-01-05', 500, { merchant: 'Farmashop' }), mov('2026-01-05', 503)];
    const d = findDuplicates(txs, movements);
    expect(d.get(1)).toBe(movements[0].id);
    expect(d.get(0)).toBe(movements[1].id);
    expect(d.has(2)).toBe(false);
  });
  it('las compras en dólares se comparan solo con cotización', () => {
    const txs = [tx('2025-12-30', 15.99, 'NETFLIX.COM', { currency: 'usd' })];
    const movements = [mov('2025-12-30', 640, { merchant: 'Netflix' })];
    expect(findDuplicates(txs, movements).size).toBe(0);
    expect(findDuplicates(txs, movements, 40).get(0)).toBe(movements[0].id);
  });
  it('meses que ya vinieron como totales de la planilla', () => {
    const txs = [tx('2025-12-28', 100, 'DISCO'), tx('2026-01-03', 200, 'DEVOTO'), tx('2026-02-01', -50, 'DEVOLUCION', { kind: 'credito' })];
    const movements = [mov('2025-12-01', 30000, { origin: 'planilla', monthly: true }), mov('2026-02-01', 9000, { origin: 'planilla', monthly: true }), mov('2026-01-01', 90000, { kind: 'ingreso', origin: 'planilla', monthly: true })];
    expect(planillaMonths(txs, movements)).toEqual(['2025-12']);
  });
  it('pasa a pesos con la cotización', () => {
    expect(toLocal({ amount: 15.99, currency: 'usd' }, 40.25)).toBe(643.6);
    expect(toLocal({ amount: 1500, currency: 'local' }, 40.25)).toBe(1500);
  });
});

describe('datos guardados', () => {
  it('los datos viejos siguen andando y los nuevos campos se validan', () => {
    const base = emptyData();
    const old = normalizeData({ ...base, invoices: [{ id: 'f1', fileName: 'a.jpg', mime: 'image/jpeg', items: [], createdAt: 0 }] } as Partial<Data>);
    expect(old.invoices[0].kind).toBeUndefined();
    expect(old.settings.usdRate).toBeUndefined();
    const d = normalizeData({
      ...base,
      invoices: [
        { id: 'f2', kind: 'estado', card: 'OCA', fileName: 'oca.pdf', mime: 'application/pdf', items: [], createdAt: 0 },
        { id: 'f3', kind: 'otro' as 'estado', fileName: 'x.pdf', mime: 'application/pdf', items: [], createdAt: 0 },
      ],
      settings: { ...base.settings, usdRate: 40.25 },
    });
    // Uno desconocido (de una versión más nueva) queda como vino: se muestra como factura
    expect(d.invoices.map((i) => i.kind)).toEqual(['estado', 'otro']);
    expect(d.invoices[0].card).toBe('OCA');
    expect(d.settings.usdRate).toBe(40.25);
    expect(normalizeData({ ...base, settings: { ...base.settings, usdRate: -3 } }).settings.usdRate).toBeUndefined();
  });
});
