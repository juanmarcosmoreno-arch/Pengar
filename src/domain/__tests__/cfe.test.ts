import { describe, expect, it } from 'vitest';
import {
  cfeFromText,
  differenceOf,
  findCfe,
  merchantOfRuc,
  officialPortal,
  parseCfeQr,
  parseRondanetLines,
  prefersOfficial,
  rondanetForm,
  withCfe,
  type Cfe,
} from '../cfe';
import { parseInvoiceText } from '../invoice';

/**
 * El QR de un e-Ticket de Disco, con el espacio del principio como lo imprime la caja. El hash es inventado: con el
 * real (sus 6 primeras letras) cualquiera puede bajar el PDF, que trae la ADENDA con los datos del cliente.
 */
const QR = ' https://www.efactura.dgi.gub.uy/consultaQR/cfe?210274130017,101,BJ,1000001,1620.19,20261017,q7RxP4d+NzWmLbAeTf3VD+/9kuo=';
/** El mismo comprobante en el QR del PDF del súper: fecha dd/mm/aaaa y el hash escapado */
const QR_PDF = 'https://www.efactura.dgi.gub.uy/consultaQR/cfe?210274130017,101,BJ,1000001,1620.19,17/10/2026,q7RxP4d%2BNzWmLbAeTf3VD%2B%2F9kuo%3D';

const DISCO_CFE: Cfe = {
  ruc: '210274130017',
  tipo: 101,
  serie: 'BJ',
  numero: 1000001,
  total: 1620.19,
  date: '2026-10-17',
  hash6: 'q7RxP4',
  source: 'qr',
  url: QR.trim(),
};
const PRINTED_CFE: Cfe = { ...DISCO_CFE, source: 'text', url: null };

/** Lo impreso de ese ticket (sin la ADENDA): sirve cuando el QR no se lee */
const PRINTED = `Disco
Supermercados Disco del Uruguay S.A.
Rut: 210274130017
e-Ticket
BJ1000001 17/10/2026
CONTADO
CONSUMO FINAL
MONEDA: UYU
AGUJA SIN HUESO 422.36
1.324 KG x 319.00
BONDIOLA ENTER MEDIA 248.83
1.670 KG x 149.00
PANAL BABYSEC PREMIU 949.00
1.000 UN x 949.00
TOTAL: $ 1620.19
Cod. de Seguridad: q7RxP4
Res. DGI 2379/2012`;

/**
 * Tabla de productos y pie del PDF oficial (Rondanet) de ese ticket, renglón por renglón como los arma el plugin.
 * Solo la tabla y los totales: nada del encabezado del cliente ni de la ADENDA.
 */
const RONDANET = [
  '#    IVA       CÓDIGO                                DESCRIPCIÓN              CANTIDAD      DESC.        REC.        PRECIO C/IVA      MONTO',
  '1 10%               301323 BONDIOLA ENTER MEDIA                                    1,670        0,00         0,00         149,00          248,83',
  '2 10%               301229 AGUJA SIN HUESO                                         1,324        0,00         0,00         319,00          422,36',
  '3 22%               622458 PANAL BABYSEC PREMIU                                    1,000        0,00         0,00         949,00          949,00',
  'TOTALES',
  'Subtotal gravado a IVA 22%                            777,87',
  'Monto IVA 22%                         171,13',
  'Subtotal gravado a IVA 10%                            610,17',
  'Monto IVA 10%                           61,02',
  'TOTAL A PAGAR                          1.620,19',
];

const pairs = (r: { items: { description: string; amount: number }[] }) => r.items.map((i) => [i.description, i.amount]);

describe('QR del ticket (DGI)', () => {
  it('lee el QR de la caja: espacio adelante, fecha aaaammdd y el «+» del hash tal cual', () => {
    expect(parseCfeQr(QR)).toEqual(DISCO_CFE);
  });

  it('lee el QR del PDF del súper (fecha dd/mm/aaaa, hash escapado): mismo ticket', () => {
    expect(parseCfeQr(QR_PDF)).toEqual({ ...DISCO_CFE, url: QR_PDF });
  });

  it('el código de seguridad distingue mayúsculas', () => {
    expect(parseCfeQr(QR.replace('q7RxP4d', 'Q7rxp4d'))!.hash6).toBe('Q7rxp4');
  });

  it('no confunde otros QR ni links incompletos', () => {
    expect(parseCfeQr('https://www.disco.com.uy/vea-su-ticket-aqui')).toBeNull();
    expect(parseCfeQr('https://www.efactura.dgi.gub.uy/consultaQR/cfe?210274130017,101,BJ,1000001')).toBeNull();
    expect(parseCfeQr('https://www.efactura.dgi.gub.uy/consultaQR/cfe?2102741300,101,BJ,1000001,1620.19,20261017,q7RxP4d')).toBeNull();
    expect(parseCfeQr('https://www.efactura.dgi.gub.uy/consultaQR/cfe?210274130017,101,BJ,0,1620.19,20261017,q7RxP4d')).toBeNull();
    expect(parseCfeQr('https://otro.sitio/efactura.dgi.gub.uy/consultaQR/cfe?210274130017,101,BJ,1000001,1620.19,20261017,q7RxP4d')).toBeNull();
    expect(parseCfeQr('')).toBeNull();
  });

  it('con salto de línea al final y la fecha d/m/aaaa sin ceros', () => {
    expect(parseCfeQr(`${QR}\r\n`)).toEqual(DISCO_CFE);
    expect(parseCfeQr(QR_PDF.replace('17/10/2026', '7/1/2026'))!.date).toBe('2026-01-07');
  });

  it('una fecha rara no invalida el ticket', () => {
    expect(parseCfeQr(QR.replace('20261017', '2026-13-45'))).toMatchObject({ date: null, numero: 1000001 });
  });
});

describe('lo impreso, cuando no hay QR', () => {
  it('saca RUT, tipo, serie, número, total, fecha y código de seguridad', () => {
    expect(cfeFromText(PRINTED, parseInvoiceText(PRINTED))).toEqual(PRINTED_CFE);
  });

  it('como lo lee el OCR de la foto, con la ADENDA entre el total y el código de seguridad', () => {
    const text = PRINTED.replace(
      'Cod. de Seguridad',
      'Tarjeta Credito/Debito $ 1620.19\nCAMBIO $ 0.00\nADENDA\nTarjeta MAS 0\nFIN ADENDA\nCod. de Seguridad',
    );
    expect(cfeFromText(text, parseInvoiceText(text))).toEqual(PRINTED_CFE);
  });

  it('la serie separada del número y sin código de seguridad (Macromercado)', () => {
    const text = 'MACROMERCADO\nRUT 211589950019\ne-Ticket\nF 5434058 Contado\nTOTAL DE COMPRA: $ 11.851,00';
    expect(cfeFromText(text, parseInvoiceText(text))).toMatchObject({ ruc: '211589950019', tipo: 101, serie: 'F', numero: 5434058, total: 11851, hash6: null });
  });

  it('serie y número con etiqueta, e-Factura', () => {
    const text = 'R.U.T.: 213458920015\ne-Factura\nSerie: A Nro: 1234567\nTOTAL 100,00';
    expect(cfeFromText(text, { total: 100 })).toMatchObject({ tipo: 111, serie: 'A', numero: 1234567, total: 100, date: null });
  });

  it('el link de la DGI escrito en el texto (e-Ticket por correo) vale como el QR', () => {
    const text = `Su e-Ticket\nVerifique en ${QR_PDF}\nGracias`;
    expect(cfeFromText(text, {})).toEqual({ ...DISCO_CFE, url: QR_PDF });
  });

  it('sin RUT, sin tipo o sin número no hay ticket; una nota de crédito no es una compra', () => {
    expect(cfeFromText(PRINTED.replace('Rut: 210274130017', 'Rut: 123'), { total: 1 })).toBeNull();
    expect(cfeFromText(PRINTED.replace('e-Ticket', 'Ticket'), { total: 1 })).toBeNull();
    expect(cfeFromText(PRINTED.replace('BJ1000001', 'BJ'), { total: 1 })).toBeNull();
    expect(cfeFromText(PRINTED.replace('e-Ticket', 'Nota de Crédito de e-Ticket'), { total: 1 })).toBeNull();
  });

  it('un «X3» del nombre de un producto no es la serie', () => {
    const text = 'Rut: 210274130017\ne-Ticket\nGALL. MARIA X3 300G 133,48\nBJ1000001';
    expect(cfeFromText(text, {})).toMatchObject({ serie: 'BJ', numero: 1000001 });
  });

  it('primero el QR de la foto, después lo impreso', () => {
    const parsed = parseInvoiceText(PRINTED);
    expect(findCfe(['https://otra.cosa', QR], PRINTED, parsed)!.source).toBe('qr');
    expect(findCfe(['https://otra.cosa'], PRINTED, parsed)!.source).toBe('text');
    expect(findCfe([], 'nada', {})).toBeNull();
  });
});

describe('súper con ticket oficial', () => {
  it('Disco, Devoto, Géant y Macromercado publican en Rondanet; Tienda Inglesa en su portal; el resto, todavía no', () => {
    expect(officialPortal('210274130017')).toBe('rondanet');
    expect(officialPortal('210297450018')).toBe('rondanet');
    expect(officialPortal('213458920015')).toBe('rondanet');
    expect(officialPortal('213428330015')).toBe('rondanet');
    expect(officialPortal('211589950019')).toBe('rondanet');
    expect(officialPortal('219999990011')).toBeNull();
    expect(officialPortal('210094030014')).toBe('tienda-inglesa');
  });

  it('el comercio por el RUT', () => {
    expect(merchantOfRuc('210274130017')).toBe('Disco');
    expect(merchantOfRuc('210297450018')).toBe('Devoto');
    expect(merchantOfRuc('213428330015')).toBe('Géant');
    expect(merchantOfRuc('211589950019')).toBe('Macromercado');
    expect(merchantOfRuc('210094030014')).toBe('Tienda Inglesa');
    expect(merchantOfRuc('219999990011')).toBeNull();
    expect(merchantOfRuc(null)).toBeNull();
  });

  it('el formulario de Rondanet lleva el total con punto y el código de seguridad', () => {
    expect(rondanetForm(DISCO_CFE)).toEqual({ ruc: '210274130017', tipo: '101', serie: 'BJ', numero: '1000001', total: '1620.19', hash6: 'q7RxP4' });
    expect(rondanetForm({ ...DISCO_CFE, total: 1620 })!.total).toBe('1620.00');
    expect(rondanetForm({ ...DISCO_CFE, hash6: null })).toBeNull();
    expect(rondanetForm({ ...DISCO_CFE, total: null })).toBeNull();
  });
});

describe('PDF oficial de Rondanet', () => {
  const expectItems = (r: ReturnType<typeof parseRondanetLines>) => {
    expect(pairs(r)).toEqual([
      ['BONDIOLA ENTER MEDIA', 248.83],
      ['AGUJA SIN HUESO', 422.36],
      ['PANAL BABYSEC PREMIU', 949],
    ]);
    expect(r.total).toBe(1620.19);
    expect(r.difference).toBe(0);
  };

  it('lee cada producto con su monto; la suma cierra con TOTAL A PAGAR', () => {
    const r = parseRondanetLines(RONDANET, DISCO_CFE);
    expectItems(r);
    expect(r.merchant).toBe('Disco');
    expect(r.date).toBe('2026-10-17');
  });

  it('sin el ticket pedido: el RUT y la fecha del encabezado del PDF', () => {
    const r = parseRondanetLines(['RUT Emisor', '210297450018', 'CODIGO DE PAIS FECHA MONEDA', '17/10/2026 UYU', ...RONDANET]);
    expect(r.merchant).toBe('Devoto');
    expect(r.date).toBe('2026-10-17');
    expectItems(r);
  });

  it('otro formato de PDF: el IVA después de la descripción y signos entre los números', () => {
    const other = [
      'CÓDIGO DESCRIPCIÓN IVA CANTIDAD PRECIO MONTO',
      '301323 BONDIOLA ENTER MEDIA 10% 1,670 x 149,00 = 248,83',
      '301229 AGUJA SIN HUESO 10% 1,324 x 319,00 = 422,36',
      '622458 PANAL BABYSEC PREMIU 22% 1,000 x 949,00 = 949,00',
      'TOTAL A PAGAR',
      '1.620,19',
    ];
    expectItems(parseRondanetLines(other, DISCO_CFE));
  });

  it('sin encabezado de tabla, con números en la descripción y un descuento en la línea', () => {
    const r = parseRondanetLines([
      '1 22% 100200 COCA COLA 2.25 2,000 0,00 0,00 95,00 190,00',
      '2 22% 100300 YOGUR 0% GRASA 1,000 10,00 0,00 80,00 70,00',
      'Subtotal gravado a IVA 22% 213,11',
      'TOTAL A PAGAR 260,00',
    ]);
    expect(pairs(r)).toEqual([
      ['COCA COLA 2.25', 190],
      ['YOGUR 0% GRASA', 70],
    ]);
    expect(r.difference).toBe(0);
  });

  it('IVA exento (frutas, verduras), código antes del IVA o sin código', () => {
    const r = parseRondanetLines([
      '1 Exento 401122 BANANA ECUADOR 0,850 0,00 0,00 89,00 75,65',
      '2 405500 22% ACEITE OPTIMO 1,000 0,00 0,00 120,00 120,00',
      '3 10% PAN FLAUTA 2,000 0,00 0,00 25,00 50,00',
      'TOTAL A PAGAR 245,65',
    ]);
    expect(r.items.map((i) => i.description)).toEqual(['BANANA ECUADOR', 'ACEITE OPTIMO', 'PAN FLAUTA']);
    expect(r.difference).toBe(0);
  });

  it('las bolsas y los descuentos de toda la compra también son plata: quedan como renglones', () => {
    const rows = [
      ...RONDANET.slice(0, 4),
      '4 22% 999001 BOLSA CAMISETA 2,000 0,00 0,00 5,00 10,00',
      '5 22% 900001 DESCUENTO SOCIO 1,000 0,00 0,00 -50,00 -50,00',
      ...RONDANET.slice(4),
    ].map((l) => l.replace('1.620,19', '1.580,19'));
    const r = parseRondanetLines(rows);
    expect(pairs(r).slice(3)).toEqual([
      ['BOLSA CAMISETA', 10],
      ['DESCUENTO SOCIO', -50],
    ]);
    expect(r.difference).toBe(0);
  });

  it('el redondeo no es un renglón, pero cuenta para que cierre; un renglón en cero no es gasto', () => {
    const r = parseRondanetLines([
      ...RONDANET.slice(0, 4),
      '4 22% 777001 MUESTRA GRATIS 1,000 0,00 0,00 0,00 0,00',
      'Redondeo -0,19',
      'TOTAL A PAGAR 1.620,00',
    ]);
    expect(r.items).toHaveLength(3);
    expect(r.total).toBe(1620);
    expect(r.difference).toBe(0);
  });

  it('si falta un producto la suma no cierra (y nunca lee lo que sigue a la ADENDA)', () => {
    const r = parseRondanetLines([...RONDANET.slice(0, 3), ...RONDANET.slice(4)]);
    expect(r.items).toHaveLength(2);
    expect(r.difference).toBe(-949);
    const cut = parseRondanetLines([...RONDANET.slice(0, 3), 'ADENDA', RONDANET[3], ...RONDANET.slice(4)]);
    expect(cut.items).toHaveLength(2);
    expect(cut.total).toBeUndefined();
    expect(cut.difference).toBeNull();
  });

  it('los subtotales con varios números no son productos; un renglón que no cierra y sin código, tampoco', () => {
    const r = parseRondanetLines([
      ...RONDANET.slice(0, 4),
      'Disco 18 2,000 3,00 4,00',
      'Subtotal gravado a IVA 22% 777,87 171,13 948,99',
      'TOTAL A PAGAR 1.620,19',
    ]);
    expect(r.items).toHaveLength(3);
    expect(r.difference).toBe(0);
  });

  it('sin TOTAL A PAGAR en el PDF, el total del QR', () => {
    expect(parseRondanetLines(RONDANET.slice(0, 4), DISCO_CFE).total).toBe(1620.19);
  });
});

describe('PDF oficial de Tienda Inglesa', () => {
  // Como sale del PDF (datos del ticket inventados; productos y montos de un ticket real): el IVA va entre el precio
  // y el descuento, y el descuento es negativo
  const TI = [
    'RUC TIPO DE DOCUMENTO', '210094030014 e-Ticket', 'SERIE NUMERO FORMA DE PAGO VENCIMIENTO', 'Z 1000001 Contado', 'CONSUMO FINAL',
    'Henderson Y Cia. S.A. FECHA MONEDA', 'Tienda Inglesa 19/10/2026 Peso uruguayo', 'Montevideo',
    'SKU Descripción Cantidad Prec Unit. S/ IVA Desc Importe', 'IVA',
    '94781 COLITA DE CUADRIL ""M""" 1,148 618,99 10% -106,60 604,00',
    '28191 BANANA DOLE ECUADOR 1,008 125,00 10% -18,90 107,10',
    '94822 FALDA PARRILLERA CON HUESO ""M 0,866 298,96 10% -38,83 220,07',
    '66499 MILANESA DE CERDO EMPANADA 1,302 379,03 22% -148,05 345,45',
    '92595 CHORIZOS CENTENARIO MIX DEGUST 1,000 609,00 22% -91,35 517,65',
    '499858 CARBON VEGETAL TIENDA INGLESA 1,000 179,00 22% -20,00 159,00',
    '11111 PAN FLAUTA 2,000 45,00 10% 0,00 90,00',
    'No facturable:',
    'Subtotal gravado (10%): 846,51 Total IVA (10%): 84,66',
    'Subtotal no gravado: TOTAL A PAGAR: 2.043,27',
  ];

  it('cada producto con su monto (ya con el descuento); la suma cierra', () => {
    const r = parseRondanetLines(TI);
    expect(r.merchant).toBe('Tienda Inglesa');
    expect(r.date).toBe('2026-10-19');
    expect(r.total).toBe(2043.27);
    expect(r.difference).toBe(0);
    expect(pairs(r)).toEqual([
      ['COLITA DE CUADRIL ""M"""', 604],
      ['BANANA DOLE ECUADOR', 107.1],
      ['FALDA PARRILLERA CON HUESO ""M', 220.07],
      ['MILANESA DE CERDO EMPANADA', 345.45],
      ['CHORIZOS CENTENARIO MIX DEGUST', 517.65],
      ['CARBON VEGETAL TIENDA INGLESA', 159],
      ['PAN FLAUTA', 90],
    ]);
  });
});

describe('¿oficial o foto?', () => {
  const official = parseRondanetLines(RONDANET, DISCO_CFE);
  const photo = { difference: differenceOf(withCfe(parseInvoiceText(PRINTED), DISCO_CFE)) };

  it('la diferencia de lo leído contra el total', () => {
    expect(differenceOf({ items: [{ description: 'A', amount: 10.1 }, { description: 'B', amount: 5.2 }], total: 15.3 })).toBe(0);
    expect(differenceOf({ items: [{ description: 'A', amount: 10 }], total: 12 })).toBe(-2);
    expect(differenceOf({ items: [] })).toBeNull();
  });

  it('manda el oficial si cierra, o si cierra igual o mejor que la foto', () => {
    expect(prefersOfficial(official, photo)).toBe(true);
    expect(prefersOfficial({ difference: -2 }, { difference: -5 })).toBe(true);
    expect(prefersOfficial({ difference: -2 }, { difference: null })).toBe(true);
  });

  it('un ticket largo (la tabla sigue en la página 2): si la foto cierra mejor, la foto', () => {
    const firstPage = parseRondanetLines(RONDANET.slice(0, 3), DISCO_CFE);
    expect(firstPage.difference).toBe(-949);
    expect(prefersOfficial(firstPage, { difference: 0 })).toBe(false);
    expect(prefersOfficial(firstPage, { difference: -1200 })).toBe(true);
  });
});

describe('el QR corrige lo leído de la foto', () => {
  it('con el TOTAL mal leído, vale el total del QR', () => {
    const misread = parseInvoiceText(PRINTED.replace('TOTAL: $ 1620.19', 'TOTAL: $ 1820.19'));
    expect(misread.total).toBe(1820.19);
    expect(withCfe(misread, DISCO_CFE).total).toBe(1620.19);
  });

  it('sin TOTAL ni fecha leídos, y el comercio sale del RUT', () => {
    const noTotal = parseInvoiceText(PRINTED.replace('TOTAL: $ 1620.19', '').replace('Disco\nSupermercados Disco del Uruguay S.A.\n', '').replace('BJ1000001 17/10/2026', 'BJ1000001'));
    expect([noTotal.total, noTotal.date]).toEqual([undefined, undefined]);
    expect(noTotal.merchant).not.toBe('Disco');
    expect(withCfe(noTotal, DISCO_CFE)).toMatchObject({ total: 1620.19, date: '2026-10-17', merchant: 'Disco' });
  });

  it('lo impreso no cambia el total ni la fecha (ya son los que leyó el OCR); el comercio sí', () => {
    const r = parseInvoiceText(PRINTED.replace(/^Disco$/m, 'DISCO 14'));
    expect(withCfe(r, { ...PRINTED_CFE, total: 999, date: '2026-01-01' })).toMatchObject({ total: 1620.19, date: '2026-10-17', merchant: 'Disco' });
  });

  it('un RUT que no se conoce deja el comercio leído', () => {
    const r = parseInvoiceText(PRINTED);
    expect(withCfe({ ...r, merchant: 'Almacén Pepe' }, { ...DISCO_CFE, ruc: '219999990011' }).merchant).toBe('Almacén Pepe');
  });
});
