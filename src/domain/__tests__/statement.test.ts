import { describe, expect, it } from 'vitest';
import { learnFrom, merchantKey, suggestRubro } from '../classify';
import type { Cell } from '../importSheet';
import type { TextBox } from '../ocrLines';
import {
  balanceCharge,
  balanceGaps,
  detectCard,
  findDuplicates,
  installmentOf,
  installmentsAtClosing,
  normalizeMerchant,
  parseStatementRows,
  parseStatementTable,
  parseStatementText,
  planillaMonths,
  rowsFromBoxes,
  statementInfo,
  statementKind,
  statementBalances,
  statementPeriod,
  toLocal,
  withoutInstallment,
  type StatementCell,
  type StatementRow,
  type StatementTx,
} from '../statement';
import { statementNote } from '../statementReview';
import { readRecord, toRecords } from '../sync';
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
  it('período desde el cierre anterior; límite y disponible con el título al lado', () => {
    const info = statementInfo(SANTANDER);
    expect(info).toMatchObject({ closing: '2025-12-18', previous: '2025-11-18', due: '2026-01-05', card: 'Visa Santander', limit: 150000, available: 98500 });
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

// --- Scotiabank en PDF: la cuota pegada al final («C03/03», hasta sin espacio), límite y disponible en el encabezado ---
// Datos inventados: imitan solo el formato (columnas, posiciones y cómo se escribe la cuota)

const SCOTIA_PDF: StatementRow[] = [
  row(cell('VENC.', 0.45), cell('TARJETA NÚMERO', 0.49)),
  row(cell('ANA PEREZ', 0.09)),
  row(cell('NUMERO DE CUENTA', 0.057), cell('LIMITE DE CREDITO', 0.16), cell('CREDITO DISPONIBLE', 0.254), cell('FECHA DE CIERRE', 0.359), cell('VENCIMIENTO PAGO PROXIMO VENC. PAGO', 0.441)),
  row(cell('11112222', 0.077), right('$ 150.000,00', 0.246), right('$ 98.765,43', 0.346), cell('25/03/2026', 0.37), cell('08/04/2026', 0.456), cell('07/05/2026', 0.547)),
  row(cell('FECHA', 0.064), cell('TARJETA', 0.109), cell('DETALLE', 0.253), right('IMPORTE EN ORIGEN', 0.485), right('IMPORTE $', 0.543), right('IMPORTE U$S', 0.614)),
  row(cell('02/03/2026', 0.054), cell('PAGO EN SCOTIABANK', 0.154), right('-3.000,00', 0.549)),
  row(cell('14/12/2025', 0.054), cell('LIBRERIA DEL PUERTO C03/03', 0.154), right('640,00', 0.549)),
  row(cell('27/02/2026', 0.054), cell('ALMACEN LOS ROBLES', 0.154), right('1.210,50', 0.549)),
  row(cell('01/03/2026', 0.054), cell('HELADERIA LA NUBEC01/02', 0.154), right('455,00', 0.549)),
  row(cell('09/03/2026', 0.054), cell('HELADERIA LA NUBE', 0.154), right('185,00', 0.549)),
  row(cell('18/03/2026', 0.054), cell('VIVERO EL CEIBOC01/03', 0.154), right('2.400,00', 0.549)),
  row(cell('** TOTAL Tarjeta : ANA PEREZ', 0.154), right('4.890,50', 0.549)),
  row(cell('25/03/2026', 0.054), cell('SEG.VIDA S/SALDO FINAN.CONTRAT', 0.154), right('31,20', 0.549)),
  row(cell('Total devolucion IVA Ley 17934 en MN', 0.154), right('96,10', 0.487)),
  row(cell('ELECTRONICA A TRAVES DE SUCURSAL INTERNET: www.scotiabank.com.uy', 0.051)),
];

describe('estado de cuenta Scotiabank (PDF, cuota pegada al comercio)', () => {
  const txs = parseStatementRows(SCOTIA_PDF, { today: '2026-04-02' });
  const text = SCOTIA_PDF.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');
  it('compras, cuotas, el pago y el seguro; los totales sin fecha no son movimientos', () => {
    expect(brief(txs)).toEqual([
      ['2026-03-02', 'pago', 'local', -3000, 'pago scotiabank'],
      ['2025-12-14', 'compra', 'local', 640, 'libreria puerto'],
      ['2026-02-27', 'compra', 'local', 1210.5, 'almacen robles'],
      ['2026-03-01', 'compra', 'local', 455, 'heladeria nube'],
      ['2026-03-09', 'compra', 'local', 185, 'heladeria nube'],
      ['2026-03-18', 'compra', 'local', 2400, 'vivero'],
      ['2026-03-25', 'cargo', 'local', 31.2, 'segvida'],
    ]);
    expect(txs.map((t) => t.installment ?? '')).toEqual(['', '3/3', '', '1/2', '', '1/3', '']);
    // Sin la cuota pegada: el mismo comercio que sin cuota
    expect(txs[3]).toMatchObject({ merchant: 'Heladeria la Nube', description: 'HELADERIA LA NUBEC01/02' });
    expect(txs[5].merchant).toBe('Vivero el Ceibo');
    // Las compras suman el «TOTAL Tarjeta»
    expect(txs.filter((t) => t.kind === 'compra').reduce((a, t) => a + t.amount, 0)).toBeCloseTo(4890.5, 2);
  });
  it('encabezado: límite y disponible del renglón de abajo, cierre, vencimiento y la tarjeta', () => {
    expect(statementInfo(text)).toEqual({ closing: '2026-03-25', due: '2026-04-08', limit: 150000, available: 98765.43, card: 'Scotiabank' });
  });
  it('sin el comienzo del período: desde la primera compra (no la cuota vieja); la cuota de una compra vieja va al cierre', () => {
    const period = statementPeriod(txs, statementInfo(text));
    expect(period).toEqual({ from: '2026-02-27', to: '2026-03-25' });
    const moved = installmentsAtClosing(txs, period);
    expect(moved[1]).toMatchObject({ date: '2026-03-25', purchaseDate: '2025-12-14', installment: '3/3' });
    // La primera cuota de una compra del período también es de este mes: va al cierre, con la fecha de la compra
    expect(moved[3]).toMatchObject({ date: '2026-03-25', purchaseDate: '2026-03-01', installment: '1/2' });
    expect(moved.filter((t) => t.purchaseDate).map((t) => t.installment)).toEqual(['3/3', '1/2', '1/3']);
    // Lo que no es cuota queda con su fecha
    expect(moved[2]).toMatchObject({ date: '2026-02-27' });
  });
});

// --- Itaú en PDF: sin encabezados, fecha «DD MM YY», los 4 dígitos de la tarjeta, la cuota en su columna --------
// Tres columnas de importe: el de origen (en dólares), el de $ y el de U$S. Datos inventados

/** Renglón como el de Itaú: día, «mes año», la tarjeta, el comercio, la cuota y los importes donde van */
const itau = (d: string, my: string, cardNo: string, desc: string, cuota: string, amts: { origen?: string; pesos?: string; usd?: string }) => row(
  cell(d, 0.112), cell(my, 0.133), cell(cardNo, 0.182), cell(desc, 0.239),
  ...(cuota ? [right(cuota, 0.521)] : []),
  ...(amts.origen ? [right(amts.origen, 0.698)] : []),
  ...(amts.pesos ? [right(amts.pesos, 0.796)] : []),
  ...(amts.usd ? [right(amts.usd, 0.895)] : []),
);
const ITAU_HEAD = [
  row(cell('1/', 0.886), cell('2', 0.907)),
  row(cell('28/08/26', 0.825)),
  row(cell('ANA PEREZ', 0.462)),
  row(cell('12/09/26', 0.222), cell('29/09/26', 0.346), cell('CALLE FALSA 123', 0.462)),
  row(cell('111111-1', 0.109), cell('$', 0.209), right('90.000,00', 0.315), cell('$', 0.334), right('41.000,00', 0.44)),
  row(right('61,00%', 0.605), right('8,50%', 0.778), right('7,77', 0.878)),
];
const ITAU_PDF: StatementRow[] = [
  ...ITAU_HEAD,
  row(cell('SALDO DEL ESTADO DE CUENTA ANTERIOR', 0.225), right('50.000,00', 0.705), right('120,00', 0.782)),
  row(cell('31', 0.112), cell('07 26', 0.133), cell('PAGOS', 0.189), right('-50.000,00', 0.796), right('-120,00', 0.895)),
  itau('05', '08 26', '2011', 'SUPERMERCADO EL TREBOL', '', { pesos: '1500,00' }),
  itau('10', '03 26', '2011', 'VIAJES ARCOIRIS', '6/12', { usd: '150,00' }),
  itau('12', '08 26', '2011', 'STREAMFLIX.COM', '', { origen: '15,99', usd: '15,99' }),
  itau('20', '08 26', '2011', 'CLOUDBOX', '', { origen: '0,99', usd: '-0,99' }),
  itau('15', '01 26', '2045', 'MUEBLERIA LOS PINOS', '8/ 8', { pesos: '2000,00' }),
  itau('06', '07 26', '2045', 'ZAPATERIA EL PASO', '2/ 3', { pesos: '900,00' }),
  itau('11', '12 25', '2045', 'COLCHONERIA DESCANSO', '9/12', { pesos: '1250,00' }),
  itau('18', '08 26', '2045', 'OPTICA VISION', '1/ 6', { pesos: '960,00' }),
  itau('18', '08 26', '2045', 'REDUC. IVA LEY 17934', '', { pesos: '-20,00' }),
  itau('22', '08 26', '2011', 'LA PARRILLA DEL ESTE', '', { usd: '85,00' }),
  // Una compra que el comercio presentó tarde: trae su fecha de antes del período
  itau('20', '07 26', '2045', 'KIOSCO LA ESQUINA', '', { pesos: '300,00' }),
  itau('28', '08 26', '2045', 'PEQUE?OS GIGANTES', '', { pesos: '640,00' }),
  row(cell('SEGURO DE VIDA SOBRE SALDO', 0.239), right('300,00', 0.796), right('2,00', 0.895)),
  row(cell('En', 0.175), cell('este mes la Reducción de IVA - Leyes N° 17934 y N° 19210 es de $', 0.196), right('-20,00', 0.747)),
  row(cell('SALDO CONTADO', 0.189), right('7.830,00', 0.796), right('252,00', 0.895)),
  row(cell('*', 0.161), cell('Los', 0.175), cell('montos a financiar y cuotas son meramente indicativos, pudiendo variar de acuerdo', 0.204)),
  row(cell('3', 0.168), cell('cuotas de', 0.182), right('2.300,00', 0.465), cell('TEA', 0.493), right('61,00 %', 0.578)),
];

describe('estado de cuenta Itaú (PDF sin encabezados)', () => {
  const txs = parseStatementRows(ITAU_PDF, { today: '2026-09-05' });
  const text = ITAU_PDF.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');
  it('fecha en tres pedazos, sin los dígitos de la tarjeta, y cada importe en su columna', () => {
    expect(brief(txs)).toEqual([
      ['2026-07-31', 'pago', 'local', -50000, 'pagos'],
      ['2026-07-31', 'pago', 'usd', -120, 'pagos'],
      ['2026-08-05', 'compra', 'local', 1500, 'supermercado trebol'],
      ['2026-03-10', 'compra', 'usd', 150, 'viajes'],
      ['2026-08-12', 'compra', 'usd', 15.99, 'streamflix'],
      ['2026-08-20', 'credito', 'usd', -0.99, 'cloudbox'],
      ['2026-01-15', 'compra', 'local', 2000, 'muebleria'],
      ['2026-07-06', 'compra', 'local', 900, 'zapateria'],
      ['2025-12-11', 'compra', 'local', 1250, 'colchoneria'],
      ['2026-08-18', 'compra', 'local', 960, 'optica vision'],
      ['2026-08-18', 'credito', 'local', -20, 'reduc'],
      ['2026-08-22', 'compra', 'usd', 85, 'parrilla este'],
      ['2026-07-20', 'compra', 'local', 300, 'kiosco esquina'],
      ['2026-08-28', 'compra', 'local', 640, 'pequenos'],
      // Sin fecha, pegado al último movimiento: en pesos y en dólares
      ['2026-08-28', 'cargo', 'local', 300, 'seguro'],
      ['2026-08-28', 'cargo', 'usd', 2, 'seguro'],
    ]);
  });
  it('la cuota de su columna («6/12», «8/ 8») y el comercio limpio', () => {
    expect(txs.map((t) => t.installment ?? '')).toEqual(['', '', '', '6/12', '', '', '8/8', '2/3', '9/12', '1/6', '', '', '', '', '', '']);
    expect(txs[3]).toMatchObject({ description: 'VIAJES ARCOIRIS 6/12', merchant: 'Viajes Arcoiris' });
    expect(txs[6].merchant).toBe('Muebleria los Pinos');
    expect(txs.some((t) => /2011|2045/.test(t.description))).toBe(false);
    // La Ñ que el PDF escribió como «?»
    expect(txs[13].merchant).toBe('Pequeños Gigantes');
  });
  it('cierra con el saldo contado en pesos y en dólares', () => {
    const total = (cur: string) => txs.filter((t) => t.currency === cur && t.kind !== 'pago').reduce((a, t) => a + t.amount, 0);
    expect(total('local')).toBeCloseTo(7830, 2);
    expect(total('usd')).toBeCloseTo(252, 2);
    // El saldo anterior (corrido de las columnas) y el contado, por orden: con los movimientos, no falta nada
    expect(statementBalances(text)).toEqual({ previous: { local: 50000, usd: 120 }, closing: { local: 7830, usd: 252 } });
    expect(balanceGaps(txs, text)).toEqual([]);
  });
  it('si el saldo contado es más que el anterior y los movimientos, avisa cuánto falta', () => {
    const more = text.replace('SALDO CONTADO 7.830,00 252,00', 'SALDO CONTADO 7.830,00 260,00');
    expect(balanceGaps(txs, more)).toEqual([{ currency: 'usd', amount: 8 }]);
    expect(balanceCharge('2026-08-28', 'usd', 8)).toMatchObject({ kind: 'cargo', currency: 'usd', amount: 8, balance: true });
    // Sin el saldo anterior no se compara
    expect(balanceGaps(txs, more.replace(/SALDO DEL ESTADO DE CUENTA ANTERIOR.*/, ''))).toEqual([]);
  });
  it('sin cierre escrito: el período termina en el último movimiento y empieza un mes antes (aunque haya una compra presentada tarde)', () => {
    const info = statementInfo(text);
    // Sin el nombre del banco en el texto: la tarjeta la pregunta la pantalla
    expect(info.card).toBeUndefined();
    expect(info.closing).toBeUndefined();
    const period = statementPeriod(txs, info);
    expect(period).toEqual({ from: '2026-07-29', to: '2026-08-28' });
    const moved = installmentsAtClosing(txs, period);
    expect(moved.filter((t) => t.purchaseDate).map((t) => [t.installment, t.purchaseDate, t.date])).toEqual([
      ['6/12', '2026-03-10', '2026-08-28'],
      ['8/8', '2026-01-15', '2026-08-28'],
      ['2/3', '2026-07-06', '2026-08-28'],
      ['9/12', '2025-12-11', '2026-08-28'],
      ['1/6', '2026-08-18', '2026-08-28'],
    ]);
    // La primera cuota de una compra del período también va al cierre
    expect(moved[9]).toMatchObject({ date: '2026-08-28', purchaseDate: '2026-08-18', installment: '1/6' });
  });
  it('sin «cierre» escrito, el cierre es la fecha sola de arriba: las cuotas que siguen van ahí aunque el último movimiento sea antes', () => {
    const rows = [
      row(cell('28/09/26', 0.825)),
      row(cell('13/10/26', 0.222), cell('09/11/26', 0.346)),
      row(cell('31', 0.112), cell('08 26', 0.133), cell('PAGOS', 0.189), right('-50.000,00', 0.796), right('-120,00', 0.895)),
      itau('20', '07 26', '2011', 'KIOSCO LA ESQUINA', '', { pesos: '300,00' }),
      itau('02', '09 26', '2011', 'SUPERMERCADO EL TREBOL', '', { pesos: '1500,00' }),
      itau('20', '09 26', '2011', 'PANADERIA LA ESPIGA', '', { pesos: '150,00' }),
      itau('25', '08 26', '2011', 'ZAPATERIA EL PASO', '2/ 3', { pesos: '900,00' }),
      itau('22', '08 26', '2011', 'VIVERO EL CEIBO', '2/ 2', { pesos: '400,00' }),
      itau('12', '08 26', '2011', 'OPTICA VISION', '2/ 6', { pesos: '960,00' }),
    ];
    const txs = parseStatementRows(rows, { today: '2026-10-05' });
    const info = statementInfo(rows.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n'));
    expect(info.pageDate).toBe('2026-09-28');
    const period = statementPeriod(txs, info);
    expect(period).toEqual({ from: '2026-08-29', to: '2026-09-28' });
    expect(installmentsAtClosing(txs, period).filter((t) => t.installment).map((t) => [t.installment, t.date])).toEqual([
      ['2/3', '2026-09-28'], ['2/2', '2026-09-28'], ['2/6', '2026-09-28'],
    ]);
    // Sin esa fecha, el período termina en el último movimiento y empieza unos días antes del real: las que siguen de
    // los últimos 25 días igual van al cierre (el banco repite la fecha de la compra)
    const noPage = statementPeriod(txs, {});
    expect(noPage).toEqual({ from: '2026-08-21', to: '2026-09-20' });
    expect(installmentsAtClosing(txs, noPage).filter((t) => t.installment).map((t) => t.date)).toEqual(['2026-09-20', '2026-09-20', '2026-09-20']);
    // Una fecha sola que no cuadra con los movimientos (mucho después del último) no es el cierre
    expect(statementPeriod(txs, { pageDate: '2026-12-01' })?.to).toBe('2026-09-20');
  });
  it('la tarjeta sale del encabezado o del pie, nunca de un comercio que se llama como una marca o un banco', () => {
    const head = Array.from({ length: 22 }, (_, i) => `RENGLON DEL ENCABEZADO ${i + 1}`);
    const doc = (move: string) => [...head, move, 'Consultas en www.itau.com.uy'].join('\n');
    expect(detectCard(doc('13 09 26 2011 SUPERMERCADO EL TREBOL 1.500,00'))).toBe('Itaú');
    for (const name of ['OPTICA MASTER', 'RESTAURANTE LA OCA', 'FARMACIA SANTANDER', 'VISA VIAJES', 'PAGO OCA']) {
      expect(detectCard(doc(`13 09 26 2011 ${name} 1.500,00`))).toBe('Itaú');
    }
    // En los primeros renglones también: un movimiento no es el encabezado
    expect(detectCard(['ESTADO DE CUENTA', '05/09/2026 MASTER CLEAN TINTORERIA 1.500,00', 'www.itau.com.uy'].join('\n'))).toBe('Itaú');
  });
  it('un cargo sin fecha después de cuotas viejas va con la fecha más nueva, no con la de la compra', () => {
    const rows = [
      row(cell('28/09/26', 0.825)),
      itau('02', '09 26', '2011', 'SUPERMERCADO EL TREBOL', '', { pesos: '1500,00' }),
      itau('25', '09 26', '2011', 'FARMACIA LOS ALAMOS', '', { pesos: '700,00' }),
      // La tarjeta adicional, solo con cuotas de compras anteriores (con la fecha de la compra)
      itau('15', '01 26', '2045', 'MUEBLERIA LOS PINOS', '9/ 9', { pesos: '2000,00' }),
      itau('18', '04 26', '2045', 'COLCHONERIA DESCANSO', '6/ 6', { pesos: '760,00' }),
      row(cell('SEGURO DE VIDA SOBRE SALDO', 0.239), right('300,00', 0.796), right('2,00', 0.895)),
    ];
    const txs = parseStatementRows(rows, { today: '2026-10-05' });
    expect(txs.filter((t) => t.kind === 'cargo').map((t) => [t.date, t.currency, t.amount])).toEqual([['2026-09-25', 'local', 300], ['2026-09-25', 'usd', 2]]);
  });
  it('un año de dos cifras lejos del cierre no es una fecha (y el renglón no cuenta)', () => {
    const rows = [row(cell('Cierre 28/08/2026', 0.05)), itau('10', '03 12', '2011', 'COMERCIO VIEJO', '', { pesos: '100,00' }), itau('10', '08 26', '2011', 'COMERCIO NUEVO', '', { pesos: '200,00' })];
    expect(brief(parseStatementRows(rows))).toEqual([['2026-08-10', 'compra', 'local', 200, 'comercio']]);
  });
});

describe('columnas sin encabezado', () => {
  it('dos columnas que aparecen solas: primero pesos y después dólares', () => {
    const rows = [
      row(cell('Cierre 25/09/2026', 0.05)),
      row(cell('01/09', 0.05), cell('ALMACEN', 0.14), right('500,00', 0.72)),
      row(cell('02/09', 0.05), cell('STREAMFLIX', 0.14), right('8,49', 0.92)),
      row(cell('03/09', 0.05), cell('KIOSCO PEPE', 0.14), right('120,00', 0.72)),
      row(cell('04/09', 0.05), cell('APPSTORE', 0.14), right('0,00', 0.72), right('2,99', 0.92)),
    ];
    expect(parseStatementRows(rows).map((t) => [t.currency, t.amount])).toEqual([['local', 500], ['usd', 8.49], ['local', 120], ['usd', 2.99]]);
  });
  it('una columna que nunca va sola es la del importe de origen', () => {
    const rows = [
      row(cell('Cierre 25/09/2026', 0.05)),
      row(cell('01/09', 0.05), cell('MP *MERCADOLIBRE 01/03', 0.14), right('3.000,00', 0.72), right('1.000,00', 0.92)),
      row(cell('02/09', 0.05), cell('ALMACEN', 0.14), right('450,00', 0.92)),
      row(cell('03/09', 0.05), cell('MUEBLERIA 01/06', 0.14), right('6.000,00', 0.72), right('1.000,00', 0.92)),
    ];
    expect(parseStatementRows(rows).map((t) => [t.currency, t.amount])).toEqual([['local', 1000], ['local', 450], ['local', 1000]]);
  });
  // Como Itaú: origen, $ y U$S terminan en 0,698, 0,796 y 0,895
  const HEAD = [row(cell('28/08/26', 0.825)), row(cell('12/09/26', 0.222), cell('29/09/26', 0.346))];
  const pagos = row(cell('31', 0.112), cell('07 26', 0.133), cell('PAGOS', 0.189), right('-50.000,00', 0.796), right('-120,00', 0.895));
  const seguro = row(cell('SEGURO DE VIDA SOBRE SALDO', 0.239), right('300,00', 0.796), right('2,00', 0.895));
  const pesos = [
    itau('05', '08 26', '2011', 'SUPERMERCADO EL TREBOL', '', { pesos: '1500,00' }),
    itau('06', '08 26', '2011', 'FARMACIA LOS ALAMOS', '', { pesos: '700,00' }),
  ];
  const read = (rows: StatementRow[]) => parseStatementRows(rows, { today: '2026-09-05' }).map((t) => [t.kind, t.currency, t.amount, t.key]);
  it('una sola compra en dólares, con su importe de origen o sin él', () => {
    expect(read([...HEAD, ...pesos, itau('12', '08 26', '2011', 'STREAMFLIX.COM', '', { origen: '15,99', usd: '15,99' })])).toEqual([
      ['compra', 'local', 1500, 'supermercado trebol'], ['compra', 'local', 700, 'farmacia alamos'], ['compra', 'usd', 15.99, 'streamflix'],
    ]);
    expect(read([...HEAD, ...pesos, itau('10', '03 26', '2011', 'VIAJES ARCOIRIS', '6/12', { usd: '150,00' })]).at(-1)).toEqual(['compra', 'usd', 150, 'viajes']);
  });
  it('el pago y el seguro en pesos y en dólares marcan las dos columnas, aunque no haya compras en dólares', () => {
    expect(read([...HEAD, pagos, ...pesos, seguro])).toEqual([
      ['pago', 'local', -50000, 'pagos'], ['pago', 'usd', -120, 'pagos'],
      ['compra', 'local', 1500, 'supermercado trebol'], ['compra', 'local', 700, 'farmacia alamos'],
      ['cargo', 'local', 300, 'seguro'], ['cargo', 'usd', 2, 'seguro'],
    ]);
    // Con una sola compra en dólares con su importe de origen: el de origen no es un gasto en pesos
    expect(read([...HEAD, pagos, ...pesos, itau('12', '08 26', '2011', 'STREAMFLIX.COM', '', { origen: '15,99', usd: '15,99' }), seguro]).filter((t) => t[3] === 'streamflix'))
      .toEqual([['compra', 'usd', 15.99, 'streamflix']]);
  });
  it('sin columnas, los dos importes de un pago o de un cargo son pesos y dólares (de una compra, el último)', () => {
    const txs = parseStatementText(['10/09 DISCO 500,00', '11/09 PAGOS -1.000,00 -20,00', 'SEGURO DE VIDA 30,00 2,00', '12/09 COMPRA AFUERA 15,99 15,99'].join('\n'), { today: '2025-09-30' });
    expect(txs.map((t) => [t.kind, t.currency, t.amount])).toEqual([
      ['compra', 'local', 500], ['pago', 'local', -1000], ['pago', 'usd', -20], ['cargo', 'local', 30], ['cargo', 'usd', 2], ['compra', 'local', 15.99],
    ]);
  });
  it('un renglón que nombra «pesos» y «dólares» no es un encabezado, ni arriba ni abajo de los movimientos', () => {
    const moves = [
      pagos, ...pesos,
      itau('10', '03 26', '2011', 'VIAJES ARCOIRIS', '6/12', { usd: '150,00' }),
      itau('22', '08 26', '2011', 'LA PARRILLA DEL ESTE', '', { usd: '85,00' }),
      seguro,
    ];
    const good = read([...HEAD, ...moves]);
    expect(good.filter((t) => t[1] === 'usd').map((t) => t[2])).toEqual([-120, 150, 85, 2]);
    for (const extra of [row(cell('Pagá en pesos o en dólares', 0.161)), row(cell('PESOS URUGUAYOS', 0.415), cell('DÓLARES', 0.754)), row(cell('Importes en pesos y en dólares', 0.138))]) {
      expect(read([...HEAD, ...moves, extra])).toEqual(good);
      expect(read([...HEAD, extra, ...moves])).toEqual(good);
    }
  });
  it('un párrafo que dice «cuotas» o «importe» no es un encabezado', () => {
    const rows = [...ITAU_PDF.slice(0, 13), row(cell('financiar el saldo total o un importe menor. Las cuotas incluyen IVA sobre los', 0.168))];
    expect(parseStatementRows(rows, { today: '2026-09-05' }).filter((t) => t.currency === 'usd').map((t) => t.amount)).toEqual([-120, 150, 15.99, -0.99]);
  });
});

describe('límite y disponible', () => {
  it('títulos arriba y valores abajo, solo si son tantos como los títulos', () => {
    expect(statementInfo('LIMITE DE CREDITO   CREDITO DISPONIBLE\n$ 80.000,00   $ 12.500,50')).toEqual({ limit: 80000, available: 12500.5 });
    expect(statementInfo('LIMITE DE CREDITO   CREDITO DISPONIBLE\n$ 80.000,00')).toEqual({});
    expect(statementInfo('Límite de crédito disponible $ 3.000,00')).toEqual({ available: 3000 });
  });
  it('los importes en dólares no son el límite; un texto que nombra el límite sin importe no inventa nada', () => {
    expect(statementInfo('Límite de compra U$S 2.000,00 $ 80.000,00')).toEqual({ limit: 80000 });
    expect(statementInfo('Si superás el límite de crédito se cobra un cargo')).toEqual({});
  });
  it('lo disponible para adelantos y el límite en cuotas no son lo disponible ni el límite; cada título se queda con su importe', () => {
    expect(statementInfo('Límite de crédito $ 80.000,00 Disponible para adelantos $ 5.000,00 Disponible para compras $ 30.000,00')).toEqual({ limit: 80000, available: 30000 });
    expect(statementInfo('Límite de compra en cuotas $ 50.000,00 Límite de crédito $ 80.000,00')).toEqual({ limit: 80000 });
    expect(statementInfo('Límite de crédito Pago mínimo $ 1.000,00')).toEqual({});
    // El renglón de abajo con palabras es un párrafo, no los valores
    expect(statementInfo('Si superás el límite de crédito\nse cobra un cargo de $ 320,00')).toEqual({});
  });
});

describe('período sin fechas escritas', () => {
  it('una planilla con varios meses va desde el primer movimiento', () => {
    const txs = parseStatementText(
      ['05/06/2026 ALMACEN 100,00', '10/07/2026 KIOSCO 200,00', '15/07/2026 PANADERIA LA ESPIGA 250,00', '12/08/2026 FARMACIA LOS ALAMOS 300,00', '20/08/2026 VIVERO 400,00'].join('\n'),
    );
    expect(statementPeriod(txs, {})).toEqual({ from: '2026-06-05', to: '2026-08-20' });
  });
  it('una tarjeta de poco uso con una compra presentada tarde sigue siendo un solo mes: las cuotas de antes van al cierre', () => {
    const text = [
      'FECHA DE CIERRE', '25/09/2026',
      '31/08/2026 PAGO EN SCOTIABANK -3.000,00', '05/09/2026 ALMACEN LOS ROBLES 1.210,50', '10/07/2026 KIOSCO LA ESQUINA 300,00',
      '14/07/2026 LIBRERIA DEL PUERTO C03/03 640,00', '20/07/2026 VIVERO EL CEIBO C02/02 400,00', '02/08/2026 ZAPATERIA EL PASO C02/06 900,00',
    ].join('\n');
    const txs = parseStatementText(text, { today: '2026-10-01' });
    const period = statementPeriod(txs, statementInfo(text));
    expect(period).toEqual({ from: '2026-08-26', to: '2026-09-25' });
    expect(installmentsAtClosing(txs, period).filter((t) => t.purchaseDate).map((t) => [t.installment, t.date])).toEqual([
      ['3/3', '2026-09-25'], ['2/2', '2026-09-25'], ['2/6', '2026-09-25'],
    ]);
  });
  it('si solo hay cuotas de compras anteriores, desde un mes antes del último', () => {
    const txs = parseStatementText(['05/01/2026 MUEBLERIA CUOTA 8/10 100,00', '10/03/2026 OPTICA CUOTA 3/6 200,00'].join('\n'));
    expect(statementPeriod(txs, { closing: '2026-08-25' })).toEqual({ from: '2026-07-26', to: '2026-08-25' });
  });
  it('el 31 de marzo: un mes antes es el último de febrero', () => {
    const txs = parseStatementText('05/01/2026 MUEBLERIA CUOTA 8/10 100,00', { today: '2026-04-01' });
    expect(statementPeriod(txs, { closing: '2026-03-31' })).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });
});

describe('cada cuota es un gasto del mes en que se paga', () => {
  // Un buzo de $ 3.000 en 3 cuotas, comprado el 28/8 (antes de fin de mes) con el estado de cuenta que cierra el 25/9
  const period = { from: '2026-08-26', to: '2026-09-25' };
  const txs = installmentsAtClosing(parseStatementText(['28/08/2026 TIENDA EL BUZO CUOTA 1/3 1.000,00', '29/08/2026 ALMACEN 300,00'].join('\n'), { today: '2026-10-01' }), period);
  it('la primera cuota va al mes del cierre, no al de la compra', () => {
    expect(txs.map((t) => [t.installment ?? '', t.date])).toEqual([['1/3', '2026-09-25'], ['', '2026-08-29']]);
    expect(statementNote(txs[0], 'OCA', 1)).toBe('OCA · cuota 1/3 · compra del 28/8/2026');
  });
  it('si la anotaste a mano el día de la compra, es un repetido', () => {
    expect([...findDuplicates(txs, [mov('2026-08-28', 1000, { id: 'a' })])]).toEqual([[0, 'a']]);
  });
});

describe('cuotas con la fecha de la compra y los repetidos', () => {
  const period = { from: '2026-08-26', to: '2026-09-25' };
  const read = (lines: string[]) => installmentsAtClosing(parseStatementText(lines.join('\n'), { today: '2026-10-01' }), period);
  const sept = read(['03/03/2026 COLCHONERIA DESCANSO CUOTA 7/9 1.250,00', '29/08/2026 OPTICA VISION CUOTA 1/3 900,00', '02/09/2026 ALMACEN 300,00']);
  it('la cuota de una compra vieja va al cierre y la nota dice de cuándo es la compra', () => {
    // Las dos cuotas son gastos de setiembre (el mes del cierre); la compra sin cuotas queda con su fecha
    expect(sept.map((t) => [t.date, t.purchaseDate ?? ''])).toEqual([['2026-09-25', '2026-03-03'], ['2026-09-25', '2026-08-29'], ['2026-09-02', '']]);
    expect(statementNote(sept[0], 'Itaú', 1)).toBe('Itaú · cuota 7/9 · compra del 3/3/2026');
    const usdTx = { ...sept[0], currency: 'usd' as const, amount: 30 };
    expect(statementNote(usdTx, 'Itaú', 40.1)).toBe('Itaú · cuota 7/9 · compra del 3/3/2026 · U$S\u00a030,00 × 40,10');
  });
  // Lo que quedó guardado de setiembre: un gasto por compra, con la fecha y la nota del borrador
  const saved = sept.map((t, i) => mov(t.date, t.amount, { id: `s${i}`, origin: 'tarjeta', note: statementNote(t, 'Itaú', 1) }));
  it('subir el mismo estado de cuenta otra vez encuentra todo repetido', () => {
    expect([...findDuplicates(sept, saved).entries()]).toEqual([[0, 's0'], [1, 's1'], [2, 's2']]);
  });
  it('la misma cuota guardada antes (con la fecha de la compra) también es repetida; otra cuota o sin cuota en la nota, no', () => {
    const before = [
      mov('2026-03-03', 1250, { id: 'v1', origin: 'tarjeta', note: 'Itaú · cuota 7/9' }),
      mov('2026-03-03', 1250, { id: 'v2', origin: 'tarjeta', note: 'Itaú · cuota 6/9' }),
      mov('2026-03-04', 1250, { id: 'v3' }),
    ];
    expect([...findDuplicates(sept, before).entries()]).toEqual([[0, 'v1']]);
    expect(findDuplicates(sept, before.slice(1)).size).toBe(0);
  });
  it('una cuota llevada al cierre no es una compra nueva sin cuota de esos días (ni al revés)', () => {
    const sep = installmentsAtClosing(parseStatementText('14/06/2026 LIBRERIA DEL PUERTO C04/04 640,00', { today: '2026-10-01' }), period);
    expect(sep[0]).toMatchObject({ date: '2026-09-25', purchaseDate: '2026-06-14', installment: '4/4' });
    const kept = [mov('2026-09-25', 640, { id: 'c4', origin: 'tarjeta', note: statementNote(sep[0], 'Scotiabank', 1) })];
    // En octubre, una compra sin cuota del 27/09 por el mismo monto
    const oct = parseStatementText('27/09/2026 KIOSCO LA ESQUINA 640,00', { today: '2026-11-01' });
    expect(findDuplicates(oct, kept).size).toBe(0);
    // Un gasto anotado a mano cerca del cierre no tapa la cuota
    expect(findDuplicates(sep, [mov('2026-09-24', 640, { id: 'm1' })]).size).toBe(0);
    // La misma cuota, sí
    expect([...findDuplicates(sep, kept).entries()]).toEqual([[0, 'c4']]);
  });
  it('lo guardado con la versión anterior del mismo estado de cuenta (con la fecha de la compra y sin la cuota) es repetido; lo de otro mes, no', () => {
    const again = installmentsAtClosing(parseStatementText('20/07/2026 VIVERO EL CEIBOC02/02 400,00', { today: '2026-10-01' }), period);
    expect(again[0]).toMatchObject({ date: '2026-09-25', purchaseDate: '2026-07-20', installment: '2/2' });
    const invoice = (id: string, date: string) => ({ id, kind: 'estado' as const, card: 'Scotiabank', fileName: 'e.pdf', mime: 'application/pdf', date, items: [], createdAt: 0 });
    const before = [mov('2026-07-20', 400, { id: 'v1', origin: 'tarjeta', note: 'Scotiabank', invoiceId: 'e1' })];
    expect([...findDuplicates(again, before, 40, { closing: '2026-09-25', invoices: [invoice('e1', '2026-09-25')] }).entries()]).toEqual([[0, 'v1']]);
    // La 1/2 de julio (guardada con el estado de cuenta de julio) no es la 2/2 de setiembre
    expect(findDuplicates(again, before, 40, { closing: '2026-09-25', invoices: [invoice('e1', '2026-07-25')] }).size).toBe(0);
    expect(findDuplicates(again, before).size).toBe(0);
  });
  it('la cuota siguiente del mes que viene no parece repetida', () => {
    const oct = installmentsAtClosing(
      parseStatementText(['03/03/2026 COLCHONERIA DESCANSO CUOTA 8/9 1.250,00', '29/08/2026 OPTICA VISION CUOTA 2/3 900,00'].join('\n'), { today: '2026-11-01' }),
      { from: '2026-09-26', to: '2026-10-25' },
    );
    expect(oct.map((t) => t.date)).toEqual(['2026-10-25', '2026-10-25']);
    expect(findDuplicates(oct, saved).size).toBe(0);
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
    ['SEG.VIDA S/SALDO FINAN.CONTRAT', 'cargo'], ['SEGURO DE VIDA SOBRE SALDO', 'cargo'], ['REDUC. IVA LEY 17934', 'credito'],
    // El total de lo que ya se descontó en cada compra: no es un movimiento
    ['Total devolucion IVA Ley 17934 en MN', 'saldo'], ['** TOTAL Tarjeta : ANA PEREZ', 'saldo'],
  ] as const)('%s → %s', (desc, kind) => expect(statementKind(desc)).toBe(kind));
});

describe('cuotas', () => {
  it.each([
    ['FARMASHOP CUOTA 02/06', '2/6'], ['MOTOCICLO CTA 3 DE 12', '3/12'], ['SAN ROQUE C.2/6', '2/6'], ['DIVINO C2/10', '2/10'],
    ['MP *MERCADOLIBRE 04/10', '4/10'], ['Cuota: 1/3 PANADERIA', '1/3'],
    // Scotiabank: al final, con o sin espacio; Itaú: en su columna, a veces con un espacio
    ['LIBRERIA DEL PUERTO C03/03', '3/3'], ['HELADERIA LA NUBEC01/02', '1/2'], ['VIVERO EL CEIBOC02/12 ', '2/12'], ['MUEBLERIA 6/ 6', '6/6'],
  ])('%s → %s', (desc, inst) => expect(installmentOf(desc)).toBe(inst));
  it.each([
    'TIENDA INGLESA', 'COMPRA 12/09', 'CUOTA 1/1', 'DISCO 7',
    // Pegado pero no puede ser una cuota, o no está al final
    'ALMACEN SAN MARCOC12/09', 'COMERCIO C01/2026', 'FARMACIAC01/02 POCITOS', 'PLAZAC00/03',
    // Un total de dos cifras con un espacio antes es una fecha o un número, no la columna de Itaú
    'CINE 3/ 30',
  ])('%s no tiene cuota', (desc) => expect(installmentOf(desc)).toBeUndefined());
  it.each(['CUOTA SOCIAL 09/26', 'UTE FACTURA 08/26', 'ANTEL 10/26', 'COLEGIO MATRICULA 03/26', 'SEGURO AUTO 11/27', 'PATENTE 12/25'])(
    '%s es un mes («MM/AA» con el año del cierre), no una cuota',
    (desc) => expect(installmentOf(desc, 2026)).toBeUndefined(),
  );
  it('con «cuota» o «C» antes, el mismo «MM/AA» sí es una cuota; con otro total, también', () => {
    expect(installmentOf('MUEBLERIA CUOTA 09/26', 2026)).toBe('9/26');
    expect(installmentOf('MUEBLERIA C09/26', 2026)).toBe('9/26');
    expect(installmentOf('MP *MERCADOLIBRE 04/10', 2026)).toBe('4/10');
    expect(installmentOf('MUEBLERIA 6/ 6', 2026)).toBe('6/6');
  });
  it('en un estado de cuenta, la cuota social del mes no deja cuotas; la columna de Itaú sí', () => {
    const txs = parseStatementText(
      ['Fecha de cierre: 25/09/2026', '02/09 CLUB ATLETICO CUOTA SOCIAL 09/26 1.200,00', '08/09 COLEGIO MATRICULA 03/26 4.500,00', '10/09 OPTICA VISION 02/06 900,00'].join('\n'),
      { today: '2026-10-01' },
    );
    expect(txs.map((t) => t.installment ?? '')).toEqual(['', '', '2/6']);
    // En su propia celda (la columna de la cuota), aunque parezca un mes
    const rows = [row(cell('Cierre 28/09/2026', 0.05)), itau('10', '09 26', '2011', 'COLCHONERIA DESCANSO', '1/26', { pesos: '500,00' })];
    expect(parseStatementRows(rows).map((t) => t.installment)).toEqual(['1/26']);
  });
  it('la cuota pegada no queda en el comercio; lo que no es cuota, sí', () => {
    expect(withoutInstallment('HELADERIA LA NUBEC01/02')).toBe('HELADERIA LA NUBE');
    expect(withoutInstallment('LIBRERIA DEL PUERTO C03/03')).toBe('LIBRERIA DEL PUERTO');
    expect(normalizeMerchant('HELADERIA LA NUBEC01/02')).toEqual(normalizeMerchant('HELADERIA LA NUBE'));
    expect(withoutInstallment('ALMACEN SAN MARCOC12/09')).toBe('ALMACEN SAN MARCOC12/09');
    expect(withoutInstallment('MUEBLERIA LOS PINOS 6/ 6')).toBe('MUEBLERIA LOS PINOS');
  });
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
  it('cifras y letras pegadas al comienzo son parte del nombre; la Ñ que el PDF escribió como «?»', () => {
    expect(normalizeMerchant('7K VIAJES')).toEqual({ merchant: '7K Viajes', key: '7k viajes' });
    expect(normalizeMerchant('PEQUE?OS GIGANTES')).toEqual({ merchant: 'Pequeños Gigantes', key: 'pequenos' });
    // Los códigos siguen afuera
    expect(normalizeMerchant('SPOTIFY P2A4B6C8').merchant).toBe('Spotify');
    expect(normalizeMerchant('123 DISCO').merchant).toBe('Disco');
    expect(normalizeMerchant('DISCO N? 18').merchant).toBe('Disco');
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
  describe('compras en dólares contra gastos anotados en pesos: la cotización del BCU de cada fecha', () => {
    // BCU (inventadas): el dólar subió en la quincena; viernes 9 y lunes 12 (el fin de semana vale la del viernes)
    const rates = [
      { date: '2026-10-01', rate: 39.8 },
      { date: '2026-10-09', rate: 42.4 },
      { date: '2026-10-12', rate: 42.6 },
    ];
    const amazon = tx('2026-10-10', 100, 'AMAZON MKTPLACE', { currency: 'usd' }); // sábado: 42,40
    const anotado = mov('2026-10-10', 4240, { merchant: 'Amazon' });

    it('con la del día de la compra se reconoce; con 40 fijo, no (6% de diferencia)', () => {
      expect(findDuplicates([amazon], [anotado], { rates }).get(0)).toBe(anotado.id);
      expect(findDuplicates([amazon], [anotado], { rates, fallback: 40 }).get(0)).toBe(anotado.id);
      expect(findDuplicates([amazon], [anotado], 40).size).toBe(0);
      expect(findDuplicates([amazon], [anotado], { fallback: 40 }).size).toBe(0);
    });

    it('con 40 fijo aparecía un repetido que no es: con la del día, ya no', () => {
      const otro = mov('2026-10-10', 4050, { merchant: 'Amazon' }); // 101,25 U$S a 40: otra compra
      expect(findDuplicates([amazon], [otro], 40).get(0)).toBe(otro.id);
      expect(findDuplicates([amazon], [otro], { rates, fallback: 40 }).size).toBe(0);
    });

    it('o con la del día en que se anotó (a no más de 3 días)', () => {
      // Con la del sábado (42,40): 4240 ± 3% (hasta 4367,2); con la del lunes (42,60): 4260 ± 3% (hasta 4387,8)
      const cerca = mov('2026-10-12', 4385, { merchant: 'Amazon' });
      expect(findDuplicates([amazon], [cerca], { rates }).get(0)).toBe(cerca.id);
      const lejos = mov('2026-10-12', 4390, { merchant: 'Amazon' });
      expect(findDuplicates([amazon], [lejos], { rates }).size).toBe(0);
    });

    it('un día sin cotización del BCU (antes de las que hay) usa la de respaldo; sin respaldo, no se compara', () => {
      const viejo = tx('2026-09-20', 100, 'AMAZON MKTPLACE', { currency: 'usd' });
      const m = mov('2026-09-20', 4000, { merchant: 'Amazon' });
      expect(findDuplicates([viejo], [m], { rates, fallback: 40 }).get(0)).toBe(m.id);
      expect(findDuplicates([viejo], [m], { rates }).size).toBe(0);
      expect(findDuplicates([viejo], [m], { rates: null }).size).toBe(0);
    });

    it('lo anotado con la cuenta en dólares en la nota se compara en dólares, con o sin cotizaciones', () => {
      const conNota = mov('2026-10-10', 4100, { merchant: 'Amazon', note: 'U$S 100 × 41,00' });
      expect(findDuplicates([amazon], [conNota], { rates }).get(0)).toBe(conNota.id);
      expect(findDuplicates([amazon], [conNota]).get(0)).toBe(conNota.id);
    });

    it('las compras en pesos no cambian', () => {
      const pesos = tx('2026-10-10', 1500, 'FARMASHOP 14');
      const m = mov('2026-10-11', 1510, { merchant: 'Farmashop' });
      expect(findDuplicates([pesos], [m], { rates, fallback: 40 }).get(0)).toBe(m.id);
      expect(findDuplicates([pesos], [m]).get(0)).toBe(m.id);
    });
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
  it('las cuotas, el límite y el disponible del estado de cuenta se guardan y viajan al hogar tal cual', () => {
    const base = emptyData();
    const inv = {
      id: 'f9', kind: 'estado' as const, card: 'OCA', fileName: 'oca.pdf', mime: 'application/pdf', items: [], createdAt: 1, date: '2026-09-25',
      installments: [{ merchant: 'Optica Vision', key: 'optica vision', amount: 300, n: 1, of: 3, date: '2026-09-02' }],
      limit: 80000,
      available: 12500.5,
    };
    const d = normalizeData({ ...base, invoices: [inv] });
    expect(d.invoices[0]).toEqual(inv);
    const rec = toRecords({ ...d, settings: { ...d.settings, onboarded: true } }).find((r) => r.kind === 'invoice')!;
    expect(readRecord('invoice', rec.id, JSON.parse(JSON.stringify(rec.data)))).toEqual(inv);
  });
});
