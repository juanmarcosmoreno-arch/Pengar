/**
 * (Copiado de Kvar, src/domain/__tests__/receipt.adversarial.test.ts: el lector de tickets es el mismo.)
 * Casos difíciles de tickets uruguayos (revisión adversaria): ruido del OCR, fotos curvadas, formatos de otras
 * cadenas y descuentos. Reglas: nunca inventar productos con renglones de encabezado, pie o pago; ante la duda
 * se pierde el renglón, pero entonces la diferencia no es 0 (la pantalla avisa «la suma no cierra»).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packSizeOf, parseNumber, parseReceiptText } from '../receipt';

type Parsed = ReturnType<typeof parseReceiptText>;
const rowsOf = (r: Parsed) => r.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.amount]);
const amounts = (r: Parsed) => r.lines.map((l) => l.amount);
/** Un ticket de Disco corto: encabezado mínimo, los renglones y el total */
const disco = (body: string, total: string) => `Disco\ne-Ticket\n17/10/2026\n${body}\nTOTAL: $ ${total}`;

/** El ticket de Disco Fresh Market (dirección, cliente y códigos inventados), con otros productos y otro total */
const realDisco = (body: string, total: string) => `en tus productos favoritos
FRESH MARKET
Disco
Supermercados Disco del Uruguay S.A. LOCAL
Rut: 210274130017
Avda. Siempreviva Km. 12.300 45
Barrio Ejemplo - Montevideo
Teléfonos: 20000000 - 20000001
e-Ticket
BJ1000001 17/10/2026
CONTADO
CONSUMO FINAL
MONEDA: UYU
${body}
TOTAL: $ ${total}
Tarjeta Credito/Debito $ ${total}
Pago total $ ${total}
CAMBIO $ 0.00
ADENDA
VT:00000
Más
CLIENTE EJEMPLO ****0000
Tarjeta MAS 0
Puntaje del Ticket 248
Saldo de la cuenta
Gracias: CLIENTE EJEMPLO
Cajera [100000000]: ANA
N° Trans Fecha Hora Caja
1000001 17/10/2026 12:00:00 001
CI Titular 0000
FIN ADENDA
Cod. de Seguridad: zz9zz9
Res. DGI 2379/2012`;
const BASE = 'AGUJA SIN HUESO 422.36\n1.324 KG x 319.00\nBONDIOLA ENTER MEDIA 248.83\n1.670 KG x 149.00\nPANAL BABYSEC PREMIU 949.00\n1.000 UN x 949.00';
const EXPECTED = [
  ['AGUJA SIN HUESO', 1.324, 319, 422.36],
  ['BONDIOLA ENTER MEDIA', 1.67, 149, 248.83],
  ['PANAL BABYSEC PREMIU', 1, 949, 949],
];
const expectReal = (body: string) => {
  const r = parseReceiptText(realDisco(body, '1620.19'));
  expect(rowsOf(r)).toEqual(EXPECTED);
  expect(r.total).toBe(1620.19);
  expect(r.difference).toBe(0);
};

const MACRO = readFileSync(resolve(__dirname, 'fixtures/ticket-macromercado.txt'), 'utf8');
const LECHE_MACRO = '168953 LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4 2,000 185,07 370,14E';
const QUESO_MACRO = '1359 QUESO CONAPROLE UNT.REQUESON LIGHT 250GR 1,000 161,93 161,93B';
/** El ticket de demo de Macromercado con un renglón cambiado: siguen las 57 líneas y la suma cierra */
const expectMacro = (from: string, to: string) => {
  expect(MACRO).toContain(from);
  const r = parseReceiptText(MACRO.replace(from, to));
  expect(r.lines).toHaveLength(57);
  expect(r.ignored).toEqual(['BOLSONES MACROMERCADO', 'BOLSAS CAMISETA MACRO']);
  expect(r.difference).toBe(0);
  return r;
};

describe('montos y precios de 1000 o más sin separador de miles (Disco imprime «1620.19»)', () => {
  const ASADO = [['ASADO DE TIRA', 2.5, 459, 1147.5]];
  it.each([
    ['dos renglones', 'ASADO DE TIRA 1147.50\n2.500 KG x 459.00'],
    ['coma decimal', 'ASADO DE TIRA 1147,50\n2,500 KG x 459,00'],
    ['monto pegado a la cantidad (foto curvada)', 'ASADO DE TIRA\n2.500 KG x 459.00 1147.50'],
    ['los dos renglones juntos', 'ASADO DE TIRA 2.500 KG x 459.00 1147.50'],
    ['monto suelto', 'ASADO DE TIRA\n1147.50\n2.500 KG x 459.00'],
    ['cantidad arriba', '2.500 KG x 459.00\nASADO DE TIRA 1147.50'],
  ])('%s', (_label, body) => {
    const r = parseReceiptText(disco(body, '1147.50'));
    expect(rowsOf(r)).toEqual(ASADO);
    expect(r.lines[0]).toMatchObject({ weighed: true, units: 1 });
    expect(r.total).toBe(1147.5);
    expect(r.difference).toBe(0);
  });

  it('en el ticket real, junto a los otros productos', () => {
    const r = parseReceiptText(realDisco(BASE.replace('BONDIOLA', 'ASADO DE TIRA 1147.50\n2.500 KG x 459.00\nBONDIOLA'), '2767.69'));
    expect(amounts(r)).toEqual([422.36, 1147.5, 248.83, 949]);
    expect(r.difference).toBe(0);
  });

  it('precio por kilo de 1000 o más con monto chico', () => {
    expect(rowsOf(parseReceiptText(disco('JAMON CRUDO 283.50\n0.150 KG x 1890.00', '283.50')))).toEqual([['JAMON CRUDO', 0.15, 1890, 283.5]]);
    expect(rowsOf(parseReceiptText(disco('JAMON CRUDO 193.50\n0.150 KG x 1290.00', '193.50')))).toEqual([['JAMON CRUDO', 0.15, 1290, 193.5]]);
  });

  it('una unidad cara, y dos paquetes', () => {
    const panal = parseReceiptText(disco('PANAL PAMPERS XXG X52 1199.00\n1.000 UN x 1199.00', '1199.00'));
    expect(panal.lines[0]).toMatchObject({ quantity: 1, unitPrice: 1199, amount: 1199, packSize: 52, units: 52, weighed: false });
    expect(panal.difference).toBe(0);
    const whisky = parseReceiptText('Disco\nWHISKY JW RED 750 1299.00\n1.000 UN x 1299.00\nTOTAL: $ 1299.00\nPago total $ 1299.00');
    expect(rowsOf(whisky)).toEqual([['WHISKY JW RED 750', 1, 1299, 1299]]);
    expect(whisky.difference).toBe(0);
    const dos = parseReceiptText(disco('PANAL BABYSEC PREMIU 1898.00\n2.000 UN x 949.00', '1898.00'));
    expect(dos.lines[0]).toMatchObject({ quantity: 2, amount: 1898, units: 2 });
  });

  it('con coma decimal (Ta-Ta, Tienda Inglesa)', () => {
    const r = parseReceiptText('ASADO DE TIRA 1089,65\n1,850 KG x 589,00\nTOTAL $ 1089,65');
    expect(rowsOf(r)).toEqual([['ASADO DE TIRA', 1.85, 589, 1089.65]]);
    expect(r.difference).toBe(0);
  });
});

describe('TOTAL, CAJA o PAGO dentro del nombre del producto', () => {
  it('PASTA COLGATE TOTAL no es el total ni se descarta', () => {
    const r = parseReceiptText(disco('PAN FLAUTA 45.00\n1.000 UN x 45.00\nPASTA COLGATE TOTAL 145.00\n1.000 UN x 145.00', '190.00'));
    expect(rowsOf(r)).toEqual([['PAN FLAUTA', 1, 45, 45], ['PASTA COLGATE TOTAL', 1, 145, 145]]);
    expect(r.total).toBe(190);
    expect(r.difference).toBe(0);
  });

  it.each([
    ['SH ELVIVE TOTAL REPA', '239.00'],
    ['VINO TINTO CAJA 1L', '99.00'],
    ['VINO FAISAN CAJA 1LT', '120.00'],
    ['COLGATE TOTAL 12 90G', '179.00'],
    ['CREMA COLGATE TOTAL', '179.00'],
    ['VINO PAGO DEL SOL', '389.00'],
  ])('%s (Disco)', (name, amount) => {
    const r = parseReceiptText(disco(`${name} ${amount}\n1.000 UN x ${amount}`, amount));
    expect(rowsOf(r)).toEqual([[name, 1, Number(amount), Number(amount)]]);
    expect(r.difference).toBe(0);
  });

  it.each([
    ['PASTA DENTAL COLGATE TOTAL', '189,00'],
    ['CREMA DENTAL COLGATE TOTAL 12', '189,00'],
    ['VINO TINTO SANTA TERESA CAJA 1L', '112,00'],
    ['HUEVOS COLOR CAJA X 12', '165,00'],
  ])('%s (Ta-Ta, Tienda Inglesa)', (name, amount) => {
    const r = parseReceiptText(`${name} ${amount}\n1 x ${amount}\nTOTAL $ ${amount}`);
    expect(r.lines.map((l) => [l.description, l.amount])).toEqual([[name, parseNumber(amount)]]);
    expect(r.total).toBe(parseNumber(amount));
    expect(r.difference).toBe(0);
  });

  it('si la foto se cortó antes del TOTAL, no hay total (nunca el monto de un producto)', () => {
    const r = parseReceiptText('PAN FLAUTA 45.00\n1.000 UN x 45.00\nPASTA COLGATE TOTAL 145.00\n1.000 UN x 145.00');
    expect(r.total).toBeNull();
    expect(amounts(r)).toEqual([45, 145]);
  });
});

describe('bolsas: las del súper se descartan, las bolsas de residuos o el hielo son productos', () => {
  it('Disco', () => {
    const r = parseReceiptText(disco('BOLSA RESIDUOS 50X55 89.00\n1.000 UN x 89.00\nHIELO BOLSA 2KG 75.00\n1.000 UN x 75.00\nBOLSA 5.00\n1.000 UN x 5.00', '169.00'));
    expect(r.lines.map((l) => l.description)).toEqual(['BOLSA RESIDUOS 50X55', 'HIELO BOLSA 2KG']);
    expect(r.ignored).toEqual(['BOLSA']);
    expect(r.difference).toBe(0);
    const s = parseReceiptText('BOLSAS RESIDUOS X 30 89.00\n1.000 UN x 89.00\nHIELO BOLSA 2KG 95.00\n1.000 UN x 95.00\nTOTAL: $ 184.00');
    expect(s.lines.map((l) => l.description)).toEqual(['BOLSAS RESIDUOS X 30', 'HIELO BOLSA 2KG']);
    expect(s.ignored).toEqual([]);
  });

  it('Ta-Ta: el paquete de bolsas de residuos', () => {
    const r = parseReceiptText('BOLSA RESIDUOS 50X55 X 30 89,00\n1 x 89,00\nTOTAL $ 89,00');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ description: 'BOLSA RESIDUOS 50X55 X 30', quantity: 1, unitPrice: 89, amount: 89, packSize: 30 });
    expect(r.ignored).toEqual([]);
  });

  it('Macromercado: siguen descartadas solo las bolsas del súper', () => {
    const r = parseReceiptText(MACRO
      .replace(QUESO_MACRO, `${QUESO_MACRO}\n55555 BOLSA RESIDUOS CEFA 50X55 X 30 1,000 89,00 89,00B`)
      .replace('TOTAL DE COMPRA: $ 13.130,00', 'TOTAL DE COMPRA: $ 13.219,00'));
    expect(r.lines).toHaveLength(58);
    expect(r.lines.find((l) => l.storeCode === '55555')).toMatchObject({ amount: 89, packSize: 30 });
    expect(r.ignored).toEqual(['BOLSONES MACROMERCADO', 'BOLSAS CAMISETA MACRO']);
    expect(r.difference).toBe(0);
  });
});

describe('descuentos debajo del producto: otras palabras y otros signos', () => {
  const leche = (discount: string, total: string) => parseReceiptText(`LECHE CONAPROLE 91,80\n2 x 45,90\n${discount}\nTOTAL $ ${total}`);

  it.each(['DCTO SOCIO -9,18', 'DESCUENTOS -9,18', 'BENEFICIO SOCIO -9,18', 'SOCIO TATA -9,18', 'DESCUENTO SOCIO 9,18-', 'DESCUENTO SOCIO - 9,18', 'DESCUENTO -$ 9,18', '-9,18\nDESC. SOCIO', '-9,18'])('«%s»', (d) => {
    const r = leche(d, '82,62');
    expect([r.lines[0].amount, r.lines[0].promo, r.difference, r.discounts]).toEqual([82.62, true, 0, 0]);
  });

  it('segunda unidad al 50 %', () => {
    const r = leche('2DA UNIDAD 50% -22,95', '68,85');
    expect([r.lines[0].amount, r.difference]).toEqual([68.85, 0]);
  });

  it.each(['3X2 LECHE -45,90', 'LLEVA 3 PAGA 2 -45,90'])('«%s»', (d) => {
    const r = parseReceiptText(`LECHE CONAPROLE 137,70\n3 x 45,90\n${d}\nTOTAL $ 91,80`);
    expect(r.lines[0]).toMatchObject({ amount: 91.8, unitPrice: 45.9, promo: true });
    expect(r.difference).toBe(0);
  });

  it.each(['DCTO TARJETA MAS -20.00', 'DESCTO. MAS -20.00'])('Disco «%s»', (d) => {
    const r = parseReceiptText(disco(`YOGUR FRUTILLA 90.00\n2.000 UN x 45.00\n${d}`, '70.00'));
    expect([r.lines[0].amount, r.lines[0].promo, r.difference]).toEqual([70, true, 0]);
  });

  it.each(['3X2 ALFAJORES -45.00', 'PROMO 3X2 - 45.00', 'PROMO 3X2 45.00-'])('Disco «%s»', (d) => {
    const r = parseReceiptText(disco(`ALFAJOR PORTEZUELO 135.00\n3.000 UN x 45.00\n${d}`, '90.00'));
    expect([r.lines[0].amount, r.difference]).toEqual([90, 0]);
  });
});

describe('descuentos de toda la compra: no cambian los montos de los productos', () => {
  const COMPRA = 'COCA COLA 2.25L 270.00\n2.000 UN x 135.00\nPAN FLAUTA 45.00\n1.000 UN x 45.00';

  it.each(['DTO. IVA LEY 19210 -5.16', 'DESCUENTO SANTANDER 20% -63.00'])('«%s» después del TOTAL', (d) => {
    const r = parseReceiptText(`Disco\n${COMPRA}\nTOTAL: $ 315.00\n${d}\nTarjeta Credito/Debito $ 309.84\nPago total $ 309.84`);
    expect(amounts(r)).toEqual([270, 45]);
    expect(r.total).toBe(315);
    expect(r.difference).toBe(0);
  });

  it('el descuento repetido en la ADENDA no se cuenta dos veces', () => {
    const r = parseReceiptText('LECHE CONAPROLE 91,80\n2 x 45,90\nDTO. SOCIO -9,18\nTOTAL $ 82,62\nADENDA\nDTO. SOCIO -9,18\nFIN ADENDA');
    expect([r.lines[0].amount, r.difference]).toEqual([82.62, 0]);
  });

  it('descuento del banco antes del TOTAL (mayor que el producto de arriba)', () => {
    const r = parseReceiptText(disco(`${COMPRA}\nDESCUENTO ITAU 20% -63.00`, '252.00'));
    expect(amounts(r)).toEqual([270, 45]);
    expect(r.lines.every((l) => !l.promo)).toBe(true);
    expect(r.discounts).toBe(-63);
    expect(r.difference).toBe(0);
  });

  it.each([
    ['debajo del SUBTOTAL', 'SUBTOTAL 334,00\nDESC. TARJETA 20% -66,80'],
    ['con el nombre del banco', 'DESC. BBVA 20% -66,80'],
  ])('%s', (_label, rows) => {
    const r = parseReceiptText(`YERBA CANARIAS 1KG 289,00\n1 x 289,00\nPAN FLAUTA 45,00\n1 x 45,00\n${rows}\nTOTAL $ 267,20`);
    expect(amounts(r)).toEqual([289, 45]);
    expect(r.discounts).toBe(-66.8);
    expect(r.difference).toBe(0);
  });

  it('SUBTOTAL y descuento chico: tampoco va al último producto', () => {
    const r = parseReceiptText('LECHE CONAPROLE 91,80\n2 x 45,90\nYERBA CANARIAS 1KG 289,00\n1 x 289,00\nSUBTOTAL 380,80\nDESC. CLUB CARD 10% -38,08\nTOTAL $ 342,72');
    expect(r.lines.map((l) => [l.amount, l.unitPrice])).toEqual([[91.8, 45.9], [289, 289]]);
    expect(r.discounts).toBe(-38.08);
    expect(r.difference).toBe(0);
  });
});

describe('cantidad y precio que perdieron el punto decimal', () => {
  it.each([
    ['cantidad «1000 UN»', 'PANAL BABYSEC PREMIU 949.00\n1000 UN x 949.00', '949.00', ['PANAL BABYSEC PREMIU', 1, 949, 949]],
    ['cantidad «1324 KG»', 'AGUJA SIN HUESO 422.36\n1324 KG x 319.00', '422.36', ['AGUJA SIN HUESO', 1.324, 319, 422.36]],
    ['precio «31900»', 'AGUJA SIN HUESO 422.36\n1.324 KG x 31900', '422.36', ['AGUJA SIN HUESO', 1.324, 319, 422.36]],
  ])('%s', (_label, body, total, line) => {
    const r = parseReceiptText(disco(body, total));
    expect(rowsOf(r)).toEqual([line]);
    expect(r.lines[0].units).toBe(1);
    expect(r.difference).toBe(0);
  });

  it('si además el monto está mal leído, se queda con la lectura que más se acerca (y avisa)', () => {
    const r = parseReceiptText(disco('PANAL BABYSEC PREMIU 943.00\n1000 UN x 949.00', '949.00'));
    expect(r.lines[0]).toMatchObject({ quantity: 1, units: 1, amount: 943 });
    expect(r.difference).toBe(-6);
  });
});

describe('un monto mal leído no hace que la cantidad se vaya con el producto de abajo', () => {
  it.each([
    ['YOGUR FRUTILLA', 'YOGUR VAINILLA'],
    ['PAN FLAUTA', 'PAN FLAUTA'],
  ])('%s / %s', (a, b) => {
    const r = parseReceiptText(disco(`${a} 46.00\n1.000 UN x 45.00\n${b} 45.00\n1.000 UN x 45.00`, '90.00'));
    expect(r.lines.map((l) => [l.description, l.amount])).toEqual([[a, 46], [b, 45]]);
    expect(r.difference).toBe(1);
  });
});

describe('foto curvada: el tamaño al final del nombre no es el monto', () => {
  it.each([
    ['COCA COLA 2.25L', '2.000 UN x 135.00 270.00', 2, 135, 270],
    ['AGUA SALUS S/GAS 2.25', '2.000 UN x 67.50 135.00', 2, 67.5, 135],
    ['COCA COLA 2.25 L', '2.000 UN x 129.00 258.00', 2, 129, 258],
    ['REFRESCO COCA COLA 2.25', '2 x 129,00 258,00', 2, 129, 258],
    ['COCA COLA 2,25L', '2 x 129,00 258,00', 2, 129, 258],
    ['COCA COLA 2.25L', '1.000 UN x 89.00 89.00', 1, 89, 89],
    ['COCA COLA ZERO 2.25', '1.000 UN x 89.00 89.00', 1, 89, 89],
  ])('«%s» / «%s»', (name, qty, quantity, price, amount) => {
    const r = parseReceiptText(`Disco\n${name}\n${qty}\nTOTAL: $ ${amount.toFixed(2)}`);
    expect(rowsOf(r)).toEqual([[name, quantity, price, amount]]);
    expect(r.lines[0]).toMatchObject({ weighed: false, units: quantity });
    expect(r.difference).toBe(0);
  });
});

describe('los dos renglones juntos, con la cantidad primero', () => {
  it('Disco', () => {
    const r = parseReceiptText(disco('1.324 KG x 319.00 AGUJA SIN HUESO 422.36', '422.36'));
    expect(rowsOf(r)).toEqual([['AGUJA SIN HUESO', 1.324, 319, 422.36]]);
    expect(r.lines[0]).toMatchObject({ weighed: true, units: 1 });
    expect(r.difference).toBe(0);
    expectReal(BASE.replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', '1.324 KG x 319.00 AGUJA SIN HUESO 422.36'));
  });

  it('Ta-Ta', () => {
    expect(rowsOf(parseReceiptText('2 x 45,90 LECHE CONAPROLE 91,80\nTOTAL $ 91,80'))).toEqual([['LECHE CONAPROLE', 2, 45.9, 91.8]]);
  });

  it('la cantidad de un producto pegada al nombre del siguiente', () => {
    for (const merged of ['1.324 KG x 319.00 BONDIOLA ENTER MEDIA 248.83', 'BONDIOLA ENTER MEDIA 1.324 KG x 319.00 248.83']) {
      expectReal(BASE.replace('1.324 KG x 319.00\nBONDIOLA ENTER MEDIA 248.83', merged));
      const r = parseReceiptText(`Disco\nAGUJA SIN HUESO 422.36\n${merged}\n1.670 KG x 149.00\nTOTAL: $ 671.19\nPago total $ 671.19`);
      expect(rowsOf(r)).toEqual(EXPECTED.slice(0, 2));
      expect(r.difference).toBe(0);
    }
  });
});

describe('formas de escribir el TOTAL', () => {
  it.each(['TOTAL A PAGAR $ 91,80', 'TOTAL UYU 91,80', 'TOTAL $U 91,80', 'TOTAL ($): 91,80', 'TOTAL\n$ 91,80', 'TOTAL:\n$ 91,80', 'IVA TOTAL 8,35\nTOTAL\n$ 91,80'])('«%s»', (t) => {
    const r = parseReceiptText(`LECHE CONAPROLE 91,80\n2 x 45,90\n${t}`);
    expect(r.lines).toHaveLength(1);
    expect(r.total).toBe(91.8);
    expect(r.difference).toBe(0);
  });

  it.each(['AHORRO TOTAL $ 9,18', 'IVA TOTAL 8,35', 'Cantidad total: 2'])('«%s» no es el total', (t) => {
    for (const text of [`LECHE CONAPROLE 91,80\n2 x 45,90\nTOTAL A PAGAR $ 91,80\n${t}`, `LECHE CONAPROLE 91,80\n2 x 45,90\n${t}\nTOTAL A PAGAR $ 91,80`]) {
      const r = parseReceiptText(text);
      expect(r.lines).toHaveLength(1);
      expect(r.total).toBe(91.8);
      expect(r.difference).toBe(0);
    }
  });

  it('Macromercado con «TOTAL DE COMPRA:» y el monto en renglones separados', () => {
    const r = expectMacro('TOTAL DE COMPRA: $ 13.130,00', 'TOTAL DE COMPRA:\n$ 13.130,00');
    expect(r.total).toBe(13130);
  });

  it('el TOTAL que perdió el punto no le gana a «Pago total»', () => {
    const r = parseReceiptText(realDisco(BASE, '1620.19').replace('TOTAL: $ 1620.19', 'TOTAL: $ 162019'));
    expect(r.total).toBe(1620.19);
    expect(r.difference).toBe(0);
  });

  it.each(['1.410.48', '1,410,48'])('separadores mal leídos en el total de Macromercado («%s»)', (t) => {
    const r = parseReceiptText(`MACROMERCADO\n70947 CARNICERIA OFERTA POLLO C/MENUDO 9,686 145,62 1410,48M\nTOTAL DE COMPRA: $ ${t}`);
    expect(r.total).toBe(1410.48);
    expect(r.difference).toBe(0);
  });

  it('«T0TAL» debajo de un producto mal leído no se vuelve un producto', () => {
    const r = parseReceiptText('Disco\nAGUJA SIN HUESO 422.36\n1.324 KG x 319.00\nBONDIOLA ENTER MEDIA 248.B3\n1.670 KG x 149.00\nT0TAL: $ 671.19\nTarjeta Credito/Debito $ 671.19\nPago total $ 671.19');
    expect(r.lines.map((l) => l.description)).toEqual(['AGUJA SIN HUESO']);
    expect(r.total).toBe(671.19);
    expect(r.difference).toBe(-248.83);
  });
});

describe('un producto de una unidad en un solo renglón', () => {
  it.each([
    ['primero', 'LECHE CONAPROLE ENTERA 1L 45,90\nYOGUR BIOTOP 1KG 178,00\n2 x 89,00'],
    ['último', 'YOGUR BIOTOP 1KG 178,00\n2 x 89,00\nLECHE CONAPROLE ENTERA 1L 45,90'],
  ])('%s', (_label, body) => {
    const r = parseReceiptText(`${body}\nTOTAL $ 223,90`);
    expect(rowsOf(r).sort()).toEqual([['LECHE CONAPROLE ENTERA 1L', 1, 45.9, 45.9], ['YOGUR BIOTOP 1KG', 2, 89, 178]]);
    expect(r.difference).toBe(0);
  });

  it('pero no los renglones de impuestos ni el ahorro', () => {
    const r = parseReceiptText('LECHE CONAPROLE 82,62\n2 x 41,31\nUD. AHORRO $ 9,18\nSUBTOTAL 82,62\nIVA 10% 7,51\nNETO GRAVADO T.MIN. 75,11\nTOTAL $ 82,62');
    expect([r.lines.length, r.difference]).toEqual([1, 0]);
  });

  it('ni los renglones de cantidad de artículos o puntos antes del total', () => {
    for (const footer of ['CANT. ARTICULOS 3,00', 'CANTIDAD DE ARTICULOS: 3,00', 'PUNTOS ACUMULADOS 9,49']) {
      const r = parseReceiptText(`LECHE CONAPROLE 91,80\n2 x 45,90\n${footer}\nTOTAL $ 91,80`);
      expect([r.lines.length, r.difference]).toEqual([1, 0]);
    }
  });

  it('en Disco no hay productos de un renglón (siempre imprime «1.000 UN x»): un renglón suelto no se vuelve producto', () => {
    const noisy = 'AGUJA SIN HUESO 422.36\n1.324 KG x 319.00\nPANAL BABYSEC PREMIU 943.00\n1.000 UN x 94.00';
    for (const footer of ['CANT. ARTICULOS 3.00', 'CLUB MAS ACUMULASTE 9.49', 'USTED AHORRO $ 94.90', 'GRACIAS POR SU COMPRA 1.00']) {
      const r = parseReceiptText(`Disco\n${noisy}\n${footer}\nTOTAL: $ 1371.36`);
      expect(r.lines.map((l) => l.description)).toEqual(['AGUJA SIN HUESO', 'PANAL BABYSEC PREMIU']);
    }
  });

  it('formato en un renglón con cantidad entera', () => {
    for (const row of ['LECHE CONAPROLE ENTERA 1L 2 45,90 91,80', 'LECHE CONAPROLE ENTERA 1L 2 UN 45,90 91,80', 'LECHE CONAPROLE ENTERA 1L 2,00 45,90 91,80']) {
      const r = parseReceiptText(`${row}\nTOTAL $ 91,80`);
      expect(rowsOf(r)).toEqual([['LECHE CONAPROLE ENTERA 1L', 2, 45.9, 91.8]]);
      expect(r.difference).toBe(0);
    }
    const coded = parseReceiptText('123456 LECHE CONAPROLE ENTERA 1L 2 45,90 91,80\nTOTAL $ 91,80');
    expect(coded.lines[0]).toMatchObject({ storeCode: '123456', description: 'LECHE CONAPROLE ENTERA 1L' });
  });
});

describe('renglones juntados que no cierran', () => {
  it('se arma el producto y avisa la diferencia', () => {
    const r = parseReceiptText('LECHE CONAPROLE 2 x 45,90 81,80\nTOTAL $ 91,80');
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE', 2, 45.9, 81.8]]);
    expect(r.difference).toBe(-10);
  });
});

describe('cantidad primero con el monto en el mismo renglón', () => {
  it('cada cantidad va con el nombre de abajo', () => {
    const r = parseReceiptText('2 x 45,90 91,80\nLECHE CONAPROLE\n1 x 89,00 89,00\nYOGUR BIOTOP\nTOTAL $ 180,80');
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE', 2, 45.9, 91.8], ['YOGUR BIOTOP', 1, 89, 89]]);
    expect(r.difference).toBe(0);
  });

  it('el monto del producto de arriba no se toma como un tamaño del nombre', () => {
    const r = parseReceiptText('2 x 89,00\nYOGUR BIOTOP 178,00\n1 x 45,90 45,90\nLECHE CONAPROLE\nTOTAL $ 223,90');
    expect(rowsOf(r)).toEqual([['YOGUR BIOTOP', 2, 89, 178], ['LECHE CONAPROLE', 1, 45.9, 45.9]]);
    expect(r.difference).toBe(0);
  });
});

describe('Macromercado: renglones partidos o juntados por la foto', () => {
  it('la descripción arriba y los números abajo', () => {
    const r = expectMacro(LECHE_MACRO, '168953 LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4\n2,000 185,07 370,14E');
    expect(r.lines.find((l) => l.storeCode === '168953')).toMatchObject({ quantity: 2, unitPrice: 185.07, amount: 370.14, units: 8 });
    expectMacro('32320 LIMPIADOR POETT SUAVIDAD ALGODON 900 ML. 2,000 88,56 177,12B', '32320 LIMPIADOR POETT SUAVIDAD ALGODON 900 ML. 2,000\n88,56 177,12B');
    expectMacro(LECHE_MACRO, '168953 LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4 2,000 185,07\n370,14E');
  });

  it('dos productos en un renglón se separan', () => {
    const r = expectMacro(
      '64517 ESPONJA MORTIMER ANTIBACTERIAL 1,000 56,19 56,19B\n137077 LUSTRAMUEBLES BLEM AERO.RENUEVA ARG.360C 1,000 313,36 313,36B',
      '64517 ESPONJA MORTIMER ANTIBACTERIAL 1,000 56,19 56,19B 137077 LUSTRAMUEBLES BLEM AERO.RENUEVA ARG.360C 1,000 313,36 313,36B',
    );
    expect(r.lines.find((l) => l.storeCode === '64517')).toMatchObject({ quantity: 1, amount: 56.19, description: 'ESPONJA MORTIMER ANTIBACTERIAL' });
  });

  it('las dos descripciones y después los dos grupos de números: no mezcla un producto con los números del otro', () => {
    const r = parseReceiptText(`MACROMERCADO\n168953 LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4 1359 QUESO CONAPROLE UNT.REQUESON LIGHT 250GR 2,000 185,07 370,14E 1,000 161,93 161,93B\nTOTAL DE COMPRA: $ 532,07`);
    expect(r.lines.filter((l) => l.storeCode === '168953' && l.amount !== 370.14)).toEqual([]);
    expect(r.difference).not.toBe(0);
  });

  it('la letra del IVA leída como número o con un punto de más', () => {
    expectMacro('64517 ESPONJA MORTIMER ANTIBACTERIAL 1,000 56,19 56,19B', '64517 ESPONJA MORTIMER ANTIBACTERIAL 1,000 56,19 56,198');
    expectMacro(QUESO_MACRO, '1359 QUESO CONAPROLE UNT.REQUESON LIGHT 250GR 1,000 161,93 161,938');
    expectMacro(LECHE_MACRO, `${LECHE_MACRO}.`);
  });

  it('número sin coma: solo si la cuenta cierra', () => {
    expectMacro(LECHE_MACRO, LECHE_MACRO.replace('370,14E', '37014E'));
    const r = expectMacro(LECHE_MACRO, LECHE_MACRO.replace('2,000', '2000'));
    expect(r.lines.find((l) => l.storeCode === '168953')).toMatchObject({ quantity: 2, units: 8 });
  });

  it('código mal leído o pegado a la descripción', () => {
    for (const row of [LECHE_MACRO.replace('168953', '1689S3'), LECHE_MACRO.replace('168953 ', '168953')]) {
      const r = expectMacro(LECHE_MACRO, row);
      expect(r.lines.find((l) => l.storeCode === '168953')).toMatchObject({ description: 'LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4', amount: 370.14 });
    }
  });
});

describe('letras en lugar de números (O por 0, l o I por 1)', () => {
  it.each([
    ['949.00', '949.O0'],
    ['1.324 KG x 319.00', '1.324 KG x 319.O0'],
    ['1.000 UN x 949.00', '1.0O0 UN x 949.00'],
    ['1.324 KG x 319.00', 'l.324 KG x 319.00'],
    ['1.000 UN x 949.00', 'I.000 UN x 949.00'],
  ])('Disco «%s» → «%s»', (from, to) => expectReal(BASE.replace(from, to)));

  it.each([
    [LECHE_MACRO, LECHE_MACRO.replace('2,000', '2,O00')],
    [LECHE_MACRO, LECHE_MACRO.replace('370,14E', '37O,14E')],
    [QUESO_MACRO, QUESO_MACRO.replace('1,000 161,93', '1,000 l61,93')],
  ])('Macromercado «%s»', (from, to) => {
    expectMacro(from, to);
  });
});

describe('otros ruidos del OCR en el ticket de Disco', () => {
  it.each(['42236', '422. 36', '422 .36'])('el monto perdió el punto o tiene un espacio («%s»)', (a) => expectReal(BASE.replace('422.36', a)));

  it.each([
    ['MONEDA: UYU\nAGUJA', 'MONEDA: UYU AGUJA'],
    ['CONSUMO FINAL\nMONEDA: UYU\nAGUJA', 'MONEDA: UYU\nCONSUMO FINAL AGUJA'],
  ])('el encabezado pegado al primer producto', (from, to) => {
    const r = parseReceiptText(realDisco(BASE, '1620.19').replace(from, to));
    expect(rowsOf(r)).toEqual(EXPECTED);
    expect(r.difference).toBe(0);
  });

  it.each([
    ['1.324 KG x 319.00', '1.324 KG x 319.00 |'],
    ['1.324 KG x 319.00', '- 1.324 KG x 319.00'],
    ['422.36', '422.36 ,'],
    ['AGUJA', '| AGUJA'],
  ])('un signo suelto en el borde del renglón («%s»)', (from, to) => {
    expectReal(BASE.replace(from, to));
    expect(parseReceiptText(realDisco(BASE.replace(from, to), '1620.19')).lines[0].clean).toBe('Aguja sin hueso');
  });

  it.each([
    ['1.670 KG x 149.00', '1.670 KG 149.00'],
    ['1.000 UN x 949.00', '1.000 UM x 949.00'],
    ['1.324 KG x 319.00', '1.324 K6 x 319.00'],
  ])('renglón de cantidad sin la «x» o con la unidad mal leída («%s»)', (from, to) => expectReal(BASE.replace(from, to)));
});

describe('variantes del renglón de cantidad', () => {
  it.each(['0,560 KG x 299,00/KG', '0,560 Kg x $ 299,00 /Kg', '0,560 KGS. x 299,00'])('«%s»', (q) => {
    const r = parseReceiptText(`MORRON ROJO 167,44\n${q}\nTOTAL $ 167,44`);
    expect(rowsOf(r)).toEqual([['MORRON ROJO', 0.56, 299, 167.44]]);
    expect(r.lines[0].weighed).toBe(true);
  });

  it.each(['LECHE CONAPROLE 91,80\n2 UNI. x 45,90', 'LECHE CONAPROLE 91,80\n2 x 45,90 c/u', 'LECHE CONAPROLE\n2 x 45,90 = 91,80'])('«%s»', (rows) => {
    const r = parseReceiptText(`${rows}\nTOTAL $ 91,80`);
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE', 2, 45.9, 91.8]]);
    expect(r.difference).toBe(0);
  });
});

describe('redondeo', () => {
  it.each(['Redondeo: -0.19', 'REDONDEO $ -0.19', 'REDONDEO -$ 0.19'])('«%s»', (row) => {
    expect(parseReceiptText(disco(`PAN FLAUTA 45.19\n1.000 UN x 45.19\n${row}`, '45.00')).difference).toBe(0);
  });

  it.each(['Redondeo: 0,48', 'REDONDEO $ 0,48', 'AJUSTE REDONDEO 0,48'])('«%s»', (row) => {
    expect(parseReceiptText(`LECHE CONAPROLE 91,52\n2 x 45,76\n${row}\nTOTAL $ 92,00`).difference).toBe(0);
  });
});

describe('fecha, súper y código de barras', () => {
  it.each(['Fecha: 17/10/26 18:22', 'Fecha: 17-10-2026 18:22', 'Fecha: 17.10.2026'])('fecha «%s»', (row) => {
    expect(parseReceiptText(`${row}\nTOTAL $ 1,00`).date).toBe('2026-10-17');
  });

  it('una fecha imposible no se toma', () => {
    expect(parseReceiptText('Fecha: 17/13/2026\nTOTAL $ 1,00').date).toBeNull();
  });

  it('Tienda Inglesa: la hora y los datos del pago con tarjeta no son productos', () => {
    const r = parseReceiptText('FECHA: 19/10/2026\nHORA: 20,19\nPAN $45,00\nLOTE: 918 $1,00\nTOTAL: $45,00');
    expect(r.lines.map((l) => l.description)).toEqual(['PAN']);
    expect(parseReceiptText('HORA:20:19 $242,60\nTOTAL: $242,60').lines).toEqual([]);
  });

  it('Tienda Inglesa por la dirección web o con el logo en dos renglones; Multi Ahorro con guion', () => {
    expect(parseReceiptText('Rut: 210000000000\nwww.tiendainglesa.com.uy\nTOTAL $ 1,00').store).toBe('tienda-inglesa');
    expect(parseReceiptText('TIENDA\nINGLESA\nTOTAL $ 1,00').store).toBe('tienda-inglesa');
    expect(parseReceiptText('MULTI-AHORRO\nTOTAL $ 1,00').store).toBe('multi-ahorro');
  });

  it('sin el logo, la marca de más abajo le gana a la razón social de Disco', () => {
    expect(parseReceiptText('Supermercados Disco del Uruguay S.A.\nGEANT NUEVOCENTRO\nTOTAL: $ 45.00').store).toBe('geant');
    expect(parseReceiptText('Supermercados Disco del Uruguay S.A.\nPAN 45.00\nwww.geant.com.uy').store).toBe('geant');
    expect(parseReceiptText('Supermercados Disco del Uruguay S.A.\nTOTAL: $ 45.00').store).toBe('disco');
  });

  it('código de barras de 9 a 13 cifras en el formato de un renglón', () => {
    for (const code of ['7730205030115', '773020503']) {
      const r = parseReceiptText(`${code} LECHE CONAPROLE 1L 2,000 45,90 91,80\nTOTAL $ 91,80`);
      expect(r.lines[0]).toMatchObject({ storeCode: code, description: 'LECHE CONAPROLE 1L' });
    }
  });
});

describe('utilidades con ruido', () => {
  it('separadores mal leídos', () => {
    expect(parseNumber('1.410.48')).toBe(1410.48);
    expect(parseNumber('1,410,48')).toBe(1410.48);
    expect(parseNumber('1,089.65')).toBe(1089.65);
    expect(parseNumber('2,00')).toBe(2);
    expect(parseNumber('1.000')).toBe(1);
  });

  it('un tamaño con decimales después de la X no es un pack', () => {
    expect(packSizeOf('COCA COLA X 2.25L')).toBe(1);
    expect(packSizeOf('PAPA X 2,5 KG')).toBe(1);
    expect(packSizeOf('COCA COLA X 2.25 LT')).toBe(1);
    expect(packSizeOf('PANAL PAMPERS XXG X52')).toBe(52);
    const r = parseReceiptText(disco('COCA COLA X 2.25L 135.00\n1.000 UN x 135.00', '135.00'));
    expect(r.lines[0].units).toBe(1);
  });
});

/*
 * Segunda ronda: encabezados que no son productos, otras formas del TOTAL y de la cantidad, descuentos de toda la
 * compra con otras palabras, anulaciones y más ruido del OCR. Cada línea que queda cumple cantidad × precio ≈ monto,
 * o la diferencia no es 0.
 */
const closes = (l: Parsed['lines'][number]) => Math.abs(l.quantity * l.unitPrice - l.amount) <= Math.max(0.02, l.amount * 0.02);

describe('cantidad y monto arriba del nombre: el renglón de arriba del primero es del encabezado', () => {
  const ITEMS = '2 x 45,90 91,80\nLECHE CONAPROLE 1L\n0,845 Kg x 79,00 66,76\nBANANA ECUADOR\n1 x 89,00 89,00\nYOGUR BIOTOP 1KG\nTOTAL $ 247,56';
  it.each(['DESCRIPCION IMPORTE', 'CONSUMIDOR FINAL', 'Contado', 'Sucursal Pocitos', 'Fecha: 17/10/2026 18:22', 'TIENDA INGLESA'])('«%s»', (header) => {
    const r = parseReceiptText(`TA-TA\nRUT 210000000000\n${header}\n${ITEMS}`);
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE 1L', 2, 45.9, 91.8], ['BANANA ECUADOR', 0.845, 79, 66.76], ['YOGUR BIOTOP 1KG', 1, 89, 89]]);
    expect(r.difference).toBe(0);
  });

  it.each(['SOLYMAR', 'CONTADO'])('Disco con «%s» arriba', (header) => {
    const r = parseReceiptText(`Disco\n${header}\n1.324 KG x 319.00 422.36\nAGUJA SIN HUESO\n1.670 KG x 149.00 248.83\nBONDIOLA ENTER MEDIA\nTOTAL: $ 671.19`);
    expect(rowsOf(r)).toEqual(EXPECTED.slice(0, 2));
    expect(r.difference).toBe(0);
  });

  it('pero con el nombre arriba (foto curvada) sigue yendo con el de arriba', () => {
    const r = parseReceiptText('Disco\nAGUJA SIN HUESO\n1.324 KG x 319.00 422.36\nOFERTA 2X1\nTOTAL: $ 422.36');
    expect(rowsOf(r)).toEqual(EXPECTED.slice(0, 1));
  });
});

describe('un monto suelto arriba del nombre no se pega al encabezado', () => {
  it.each(['CONTADO', 'CONSUMIDOR FINAL', 'Fecha: 17/10/2026 18:22'])('«%s»', (header) => {
    const r = parseReceiptText(`${header}\n91,80\nLECHE CONAPROLE\n2 x 45,90\nTOTAL $ 91,80`);
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE', 2, 45.9, 91.8]]);
    expect(r.difference).toBe(0);
  });

  it('Disco: la columna de montos subió un renglón', () => {
    const body = 'AGUJA SIN HUESO\n1.324 KG x 319.00 248.83\nBONDIOLA ENTER MEDIA\n1.670 KG x 149.00 949.00\nPANAL BABYSEC PREMIU\n1.000 UN x 949.00';
    const r = parseReceiptText(realDisco(body, '1620.19').replace('MONEDA: UYU', 'MONEDA: UYU 422.36'));
    expect(rowsOf(r)).toEqual(EXPECTED);
    expect(r.difference).toBe(0);
  });

  it('Macromercado: el monto del redondeo arriba de su renglón no rompe el producto de arriba', () => {
    const r = expectMacro('Redondeo -0,08M', '-0,08M\nRedondeo');
    expect(r.lines.find((l) => l.storeCode === '156671')?.amount).toBe(197.2);
  });
});

describe('otras formas del TOTAL: el pago de abajo nunca es un producto', () => {
  it.each(['TOTAL....: 90,90', 'TOTAL: 90,90 UYU', 'TOTAL COMPRA $ 90,90', 'TOTAL CONTADO 90,90', 'T O T A L 90,90', 'TOTAI $ 90,90'])('«%s»', (t) => {
    const r = parseReceiptText(`TA-TA\nLECHE CONAPROLE 1L 45,90\nPAN FLAUTA 45,00\n${t}\nVISA $ 90,90\nMASTERCARD 90,90`);
    expect(r.lines.map((l) => l.description)).toEqual(['LECHE CONAPROLE 1L', 'PAN FLAUTA']);
    expect(r.total).toBe(90.9);
    expect(r.difference).toBe(0);
  });

  it('el TOTAL pegado al renglón de la cantidad', () => {
    const r = parseReceiptText('TA-TA\nLECHE CONAPROLE 91,80\n2 x 45,90 TOTAL $ 91,80');
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE', 2, 45.9, 91.8]]);
    expect(r.total).toBe(91.8);
  });

  it('puntos guía entre el nombre y el monto', () => {
    expect(parseReceiptText('ALMACEN\nPAN FLAUTA ........ 45,00\nTOTAL $ 45,00').lines.map((l) => l.description)).toEqual(['PAN FLAUTA']);
  });

  it.each([
    'TOTAL DE COMPRA: S 13.130,00',
    'TOTAL DE COMPRA; $ 13.130,00',
    'TOTAL DE COMPRA. $ 13.130,00',
    'TOTAL DECOMPRA: $ 13.130,00',
    'TOTAL DE COMPRA: $ 13.130,00.',
    'TOTAL DE COMPRA: $ 13.130,00,',
    'TOTAL DE COMPRA: $ l3.130,00',
  ])('Macromercado «%s»', (row) => {
    expect(expectMacro('TOTAL DE COMPRA: $ 13.130,00', row).total).toBe(13130);
  });

  it('Macromercado: con el total mal leído, un producto que falta igual se avisa', () => {
    const r = parseReceiptText(MACRO
      .replace('85637 PRODAL NUECES PELADAS 600 GRS. 1,000 589,30 589,30B\n', '')
      .replace('TOTAL DE COMPRA: $ 13.130,00', 'TOTAL DE COMPRA: S 13.130,00'));
    expect(r.lines).toHaveLength(56);
    expect(r.difference).toBe(-589.3);
  });
});

describe('renglón de cantidad con otra unidad, otro signo o letras por cifras: nunca es un producto', () => {
  it.each([
    ['COCA COLA 600ML 90,00', '2 UND x 45,00', ['COCA COLA 600ML', 2, 45, 90]],
    ['COCA COLA 600ML 90,00', '2 PZA x 45,00', ['COCA COLA 600ML', 2, 45, 90]],
    ['COCA COLA 600ML 90,00', '2 UN @ 45,00', ['COCA COLA 600ML', 2, 45, 90]],
    ['BANANA ECUADOR 66,76', '0,845 KILOS x 79,00', ['BANANA ECUADOR', 0.845, 79, 66.76]],
    ['BANANA ECUADOR 66,76', '0,845 Kgr x 79,00', ['BANANA ECUADOR', 0.845, 79, 66.76]],
    ['COCA COLA 600ML 130,00', '2 @ 65,00', ['COCA COLA 600ML', 2, 65, 130]],
    ['COCA COLA 600ML 130,00', 'Cant: 2 x 65,00', ['COCA COLA 600ML', 2, 65, 130]],
  ])('«%s» / «%s»', (name, qty, line) => {
    const r = parseReceiptText(`TA-TA\n${name}\n${qty}\nTOTAL $ ${String(line[3]).replace('.', ',')}`);
    expect(rowsOf(r)).toEqual([line]);
    expect(r.lines[0].units).toBe(Number.isInteger(line[1]) ? line[1] : 1);
    expect(r.difference).toBe(0);
  });

  it.each(['2 x 45,90.', '2 x 4S,90', 'Z x 45,90', '2 x 45;90', '2 x 4 5,90'])('«%s»: 2 × 45,90, no 1 × 91,80', (q) => {
    const r = parseReceiptText(`TA-TA\nLECHE CONAPROLE 91,80\n${q}\nTOTAL $ 91,80`);
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE', 2, 45.9, 91.8]]);
    expect(r.difference).toBe(0);
  });

  it.each(['0,560 KG x 299,00 $/KG', '0,560 KG x 299,0', '0,560 KG x 2SS,00', '0,S60 KG x 299,00'])('pesado «%s»', (q) => {
    const r = parseReceiptText(`TA-TA\nMORRON ROJO 167,44\n${q}\nTOTAL $ 167,44`);
    expect(rowsOf(r)).toEqual([['MORRON ROJO', 0.56, 299, 167.44]]);
    expect(r.lines[0].weighed).toBe(true);
  });

  it('si no se puede leer, el producto no se finge de una unidad: falta y la diferencia lo avisa', () => {
    const r = parseReceiptText('TA-TA\nLECHE CONAPROLE 91,80\nZ x SS,SO\nTOTAL $ 91,80');
    expect(r.lines).toEqual([]);
    expect(r.difference).toBe(-91.8);
  });
});

describe('una cifra mal leída en la cantidad o el precio: la lectura que cierra con el monto', () => {
  it.each([
    ['1.324 KG x 319.00', '1.324 KG x 819.00'],
    ['1.324 KG x 319.00', '1.824 KG x 319.00'],
  ])('Disco «%s» → «%s»', (from, to) => expectReal(BASE.replace(from, to)));

  it.each([
    ['1.670 KG x 149.00', '1.670 KG x 194.00'],
    ['248.83', '284.83'],
  ])('dos cifras al revés («%s» → «%s»)', (from, to) => {
    const r = parseReceiptText(realDisco(BASE.replace(from, to), '1620.19'));
    expect(r.lines.map((l) => l.description)).toEqual(EXPECTED.map((l) => l[0]));
  });

  it.each([
    ['41949 HARINA DEMAS 0000 1 KG. 12,000 38,32 459,84M', '41949 HARINA DEMAS 0000 1 KG. 2,000 38,32 459,84M', ['HARINA DEMAS 0000 1 KG.', 12]],
    ['64368 PURE DE PAPA DEMAS 120 GRS. 11,000 41,26 453,86B', '64368 PURE DE PAPA DEMAS 120 GRS. 1 1,000 41,26 453,86B', ['PURE DE PAPA DEMAS 120 GRS.', 11]],
    [LECHE_MACRO, LECHE_MACRO.replace('185,07', '1B5,07'), ['LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4', 2]],
  ])('Macromercado «%s»', (from, to, [description, quantity]) => {
    const r = expectMacro(from, to);
    expect(r.lines.find((l) => l.storeCode === to.split(' ')[0])).toMatchObject({ description, quantity });
  });

  it('un renglón que no cierra con nada no se junta con el monto de otro producto', () => {
    const r = parseReceiptText('Géant\nCOCA COLA 2.25L 135.00\n7790895000997\n1.000 UN x 135.00\nPAN FLAUTA 45.00\n7730000000012\n1.000 UN x 45.00\nTOTAL: $ 180.00');
    expect(r.lines.every(closes)).toBe(true);
    expect(r.difference).not.toBe(0);
  });
});

describe('Macromercado: el resumen de impuestos con ruido no es un producto, y un renglón que cierra sí lo es', () => {
  it.each([
    ['T.E.Imp.: 370,14', 'T.E.lmp.: 370,14'],
    ['T.E.Imp.: 370,14', 'TE.Imp.: 370,14'],
  ])('«%s» → «%s»', (from, to) => {
    expectMacro(from, to);
  });

  it('la l por I en los tres renglones', () => {
    const r = parseReceiptText(MACRO.replace(/\.Imp\./g, '.lmp.'));
    expect([r.lines.length, r.difference]).toEqual([57, 0]);
  });

  it.each([
    ['55501 CAJA DE FOSFOROS FIAT LUX X 10 1,000 45,00 45,00B', 45],
    ['55503 TOTAL CLEAN DESENGRASANTE 500ML 1,000 99,00 99,00B', 99],
    ['55504 PAGO DEL SOL VINO TINTO 750ML 1,000 289,00 289,00B', 289],
    ['55505 TARJETA ANTEL 200 1,000 200,00 200,00E', 200],
  ])('«%s»', (row, amount) => {
    const r = parseReceiptText(`MACROMERCADO\n${QUESO_MACRO}\n${row}\nTOTAL DE COMPRA: $ ${(161.93 + amount).toFixed(2).replace('.', ',')}`);
    expect(r.lines).toHaveLength(2);
    expect(r.difference).toBe(0);
  });
});

describe('renglones de impuestos, ahorro o información con ruido o con otras palabras (súper con productos de un renglón)', () => {
  it.each([
    'lVA 10% 8,35', 'IVA10% 8,35', 'UD. AHORR0 $ 9,18', 'USTED AH0RRO $ 9,18', 'AHORRASTE $ 9,18', 'UD. AHORRA $ 9,18', 'AHORROS 9,18',
    'UD. DESC 9,18', 'PRECIO REGULAR 50,90', 'PRECIO ANTERIOR 50,90', 'P. UNIT. 45,90', 'UNIDADES 2,00',
  ])('«%s»', (row) => {
    const r = parseReceiptText(`TA-TA\nLECHE CONAPROLE 91,80\n2 x 45,90\n${row}\nTOTAL $ 91,80`);
    expect(rowsOf(r)).toEqual([['LECHE CONAPROLE', 2, 45.9, 91.8]]);
    expect(r.difference).toBe(0);
  });

  it.each(['SUB-TOTAL 380,80', '5UBTOTAL 380,80'])('«%s» y un descuento de toda la compra', (row) => {
    const r = parseReceiptText(`TA-TA\nLECHE CONAPROLE 91,80\n2 x 45,90\nYERBA CANARIAS 1KG 289,00\n1 x 289,00\n${row}\nDESC. CLUB CARD 10% -38,08\nTOTAL $ 342,72`);
    expect(amounts(r)).toEqual([91.8, 289]);
    expect(r.discounts).toBe(-38.08);
    expect(r.difference).toBe(0);
  });

  it.each(['IVA INCLUIDO', 'IVA 22% INCLUIDO'])('«%s» en el encabezado no corta los productos', (h) => {
    const r = parseReceiptText(`TA-TA\n${h}\nLECHE CONAPROLE 1L 45,90\nPAN FLAUTA 45,00\nTOTAL $ 90,90`);
    expect(r.lines.map((l) => l.description)).toEqual(['LECHE CONAPROLE 1L', 'PAN FLAUTA']);
    expect(r.difference).toBe(0);
  });
});

describe('«DESC» de descremada o descartable en el nombre de un producto', () => {
  it('Disco', () => {
    const r = parseReceiptText(disco('LECHE DESC CONAPROLE 45.90\n1.000 UN x 45.90\nVASOS DESC. X 50 89.00\n1.000 UN x 89.00', '134.90'));
    expect(r.lines.map((l) => [l.description, l.units])).toEqual([['LECHE DESC CONAPROLE', 1], ['VASOS DESC. X 50', 50]]);
    expect(r.difference).toBe(0);
  });

  it('Ta-Ta, en un renglón', () => {
    expect(parseReceiptText('TA-TA\nLECHE DESC. CONAPROLE 1L 45,90\nTOTAL $ 45,90').lines.map((l) => l.description)).toEqual(['LECHE DESC. CONAPROLE 1L']);
  });
});

describe('tabla DESCRIPCION CANT IMPORTE (cantidad sin precio unitario)', () => {
  it('cantidad con decimales en cero', () => {
    expect(rowsOf(parseReceiptText('AUTOSERVICIO\nPAN FLAUTA 2,00 90,00\nCOCA COLA 600ML 2,00 130,00\nTOTAL $ 220,00')))
      .toEqual([['PAN FLAUTA', 2, 45, 90], ['COCA COLA 600ML', 2, 65, 130]]);
  });

  it('cantidad entera, con el encabezado de la tabla', () => {
    const r = parseReceiptText('EL DORADO\nDESCRIPCION CANT. IMPORTE\nCOCA COLA 2.25L 2 270,00\nPAN FLAUTA 1 45,00\nTOTAL $ 315,00');
    expect(rowsOf(r)).toEqual([['COCA COLA 2.25L', 2, 135, 270], ['PAN FLAUTA', 1, 45, 45]]);
  });

  it('sin el encabezado, un número entero al final es parte del nombre', () => {
    expect(rowsOf(parseReceiptText('AUTOSERVICIO\nPILAS DURACELL AA 4 289,00\nTOTAL $ 289,00'))).toEqual([['PILAS DURACELL AA 4', 1, 289, 289]]);
  });
});

describe('un producto con el mismo monto que el total no se descarta', () => {
  it('2x1 con las dos unidades impresas', () => {
    const r = parseReceiptText('KINKO\nALFAJOR PORTEZUELO 45,00\nALFAJOR PORTEZUELO 45,00\nDESC. 2X1 -45,00\nTOTAL $ 45,00');
    expect(r.lines.reduce((a, l) => a + l.units, 0)).toBe(2);
    expect(amounts(r).reduce((a, b) => a + b, 0)).toBe(45);
    expect(r.difference).toBe(0);
  });

  it('canje de puntos', () => {
    const r = parseReceiptText('TA-TA\nYERBA CANARIAS 1KG 289,00\nCANJE PUNTOS -289,00\nPAN FLAUTA 45,00\nTOTAL $ 45,00');
    expect(r.lines.map((l) => [l.description, l.amount])).toEqual([['YERBA CANARIAS 1KG', 0], ['PAN FLAUTA', 45]]);
    expect(r.difference).toBe(0);
  });
});

describe('descuentos de toda la compra con otras palabras o por el porcentaje', () => {
  const BODY = 'YERBA CANARIAS 1KG 289,00\n1 x 289,00\nPAN FLAUTA 45,00\n1 x 45,00';
  it.each(['DESCUENTO JUBILADOS 10% -33,40', 'DESCUENTO 10% -33,40', 'DESC. BANCO REPUBLICA 10% -33,40', 'DESCUENTO AMEX 10% -33,40'])('«%s»', (d) => {
    const r = parseReceiptText(`TIENDA INGLESA\n${BODY}\n${d}\nTOTAL $ 300,60`);
    expect(amounts(r)).toEqual([289, 45]);
    expect(r.discounts).toBe(-33.4);
    expect(r.difference).toBe(0);
  });

  it.each(['DEV. I.V.A. -0.74', 'DEVOLUCION IMPUESTO TARJETA DEBITO -0.74'])('«%s»', (d) => {
    const r = parseReceiptText(disco(`PAN FLAUTA 45.00\n1.000 UN x 45.00\n${d}`, '44.26'));
    expect([r.lines[0].amount, r.discounts, r.difference]).toEqual([45, -0.74, 0]);
  });

  it('un porcentaje del producto de arriba sigue siendo del producto', () => {
    const r = parseReceiptText(`${BODY.replace('PAN FLAUTA 45,00\n1 x 45,00', 'LECHE CONAPROLE 91,80\n2 x 45,90')}\nDTO 10% -9,18\nTOTAL $ 371,62`);
    expect([amounts(r), r.discounts, r.difference]).toEqual([[289, 82.62], 0, 0]);
  });
});

describe('descuento del producto con otro renglón en el medio', () => {
  it('Devoto «OFERTA 2DA AL 50%» y abajo el descuento', () => {
    const r = parseReceiptText('DEVOTO\nCOCA COLA 2.25L 270.00\n2.000 UN x 135.00\nOFERTA 2DA AL 50%\nDTO -67.50\nPAN FLAUTA 45.00\n1.000 UN x 45.00\nTOTAL: $ 247.50');
    expect(amounts(r)).toEqual([202.5, 45]);
    expect(r.difference).toBe(0);
  });

  it('el monto del descuento debajo de su nombre', () => {
    const r = parseReceiptText(realDisco(BASE.replace('1.000 UN x 949.00', '1.000 UN x 949.00\nDESC. TARJETA\n-94.90'), '1525.29'));
    expect(r.lines.find((l) => l.description.startsWith('PANAL'))).toMatchObject({ amount: 854.1, promo: true });
    expect([r.discounts, r.difference]).toEqual([0, 0]);
  });

  it('«2X1» solo con el monto', () => {
    const r = parseReceiptText('TA-TA\nALFAJOR PORTEZUELO 90,00\n2 x 45,00\n2X1 -45,00\nTOTAL $ 45,00');
    expect(r.lines[0]).toMatchObject({ amount: 45, units: 2, promo: true });
    expect(r.difference).toBe(0);
  });
});

describe('anulación de un producto (el cajero lo pasó de más)', () => {
  it('sale de la lista', () => {
    const r = parseReceiptText(disco('COCA COLA 2.25L 135.00\n1.000 UN x 135.00\nCOCA COLA 2.25L -135.00\n-1.000 UN x 135.00\nPAN FLAUTA 45.00\n1.000 UN x 45.00', '45.00'));
    expect(r.lines.map((l) => [l.description, l.amount])).toEqual([['PAN FLAUTA', 45]]);
    expect(r.difference).toBe(0);
  });

  it('o le saca las unidades anuladas', () => {
    const r = parseReceiptText(disco('COCA COLA 2.25L 270.00\n2.000 UN x 135.00\nCOCA COLA 2.25L -135.00\n-1.000 UN x 135.00', '135.00'));
    expect(rowsOf(r)).toEqual([['COCA COLA 2.25L', 1, 135, 135]]);
    expect([r.lines[0].units, r.difference]).toEqual([1, 0]);
  });
});

describe('un peso o un largo después de la X no es un pack', () => {
  it.each(['QUESO RALLADO X 150 GRS', 'JAMON COCIDO X 200 GRS.', 'PAPA BLANCA X 2 KGS', 'PAPEL HIGIENICO X 30 MTS', 'COCA COLA X 2 LITROS'])('%s', (d) => {
    expect(packSizeOf(d)).toBe(1);
  });

  it('en el ticket', () => {
    expect(parseReceiptText('TIENDA INGLESA\nQUESO RALLADO X 150 GRS 129,00\n1 x 129,00\nTOTAL $ 129,00').lines[0]).toMatchObject({ packSize: 1, units: 1 });
    expect(packSizeOf('HUEVOS COLOR CAJA X 12')).toBe(12);
  });
});
