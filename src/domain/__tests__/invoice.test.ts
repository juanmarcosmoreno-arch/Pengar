/**
 * La lectura de facturas y tickets: los tickets de súper se leen con el lector de Kvar (receipt.ts) y quedan con el que
 * mejor cierra con el TOTAL; las facturas de servicios siguen con el lector de facturas.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { itemKey, learnFrom } from '../classify';
import { looksLikeReceipt, parseInvoiceText } from '../invoice';

const pairs = (p: ReturnType<typeof parseInvoiceText>) => p.items.map((i) => [i.description, i.amount]);
const sum = (p: ReturnType<typeof parseInvoiceText>) => Math.round(p.items.reduce((s, i) => s + i.amount, 0) * 100) / 100;

/** El ticket de Disco Fresh Market de las pruebas de Kvar (dirección, cliente y códigos inventados): publicidad arriba, ADENDA y código de seguridad abajo */
const disco = (body: string, total = '1620.19') => `en tus productos favoritos
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
Cod. de Seguridad: q7RxP4
Res. DGI 2379/2012`;
const BASE = 'AGUJA SIN HUESO 422.36\n1.324 KG x 319.00\nBONDIOLA ENTER MEDIA 248.83\n1.670 KG x 149.00\nPANAL BABYSEC PREMIU 949.00\n1.000 UN x 949.00';
const PRODUCTS = [['AGUJA SIN HUESO', 422.36], ['BONDIOLA ENTER MEDIA', 248.83], ['PANAL BABYSEC PREMIU', 949]];

describe('ticket de súper impreso (cuando el oficial de la DGI todavía no está)', () => {
  it('Disco en dos renglones: solo los productos (ni la cantidad, ni el año, ni el código de seguridad)', () => {
    const p = parseInvoiceText(disco(BASE));
    expect(pairs(p)).toEqual(PRODUCTS);
    expect(p).toMatchObject({ merchant: 'Disco', date: '2026-10-17', total: 1620.19 });
    const all = p.items.map((i) => i.description).join(' | ');
    expect(all).not.toMatch(/KG x|BJ1000001|Seguridad|Pago|Tarjeta|CAMBIO/);
  });

  it.each([
    ['el monto pegado al renglón de la cantidad (foto curvada)', BASE.replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', 'AGUJA SIN HUESO\n1.324 KG x 319.00 422.36')],
    ['los dos renglones juntos', BASE.replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', 'AGUJA SIN HUESO 1.324 KG x 319.00 422.36')],
    ['la cantidad arriba', BASE.replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', '1.324 KG x 319.00\nAGUJA SIN HUESO 422.36')],
    ['el monto en su renglón', BASE.replace('AGUJA SIN HUESO 422.36', 'AGUJA SIN HUESO\n422.36')],
    ['letras por cifras', BASE.replace('949.00\n1.000', '949.O0\n1.000').replace('1.324', 'l.324')],
    ['el monto sin el punto', BASE.replace('422.36', '42236')],
  ])('%s', (_label, body) => {
    const p = parseInvoiceText(disco(body));
    expect(pairs(p)).toEqual(PRODUCTS);
    expect(sum(p)).toBe(1620.19);
  });

  it('el descuento de un producto queda abajo de él (y sabe de cuál es); el de toda la compra, suelto', () => {
    const body = `${BASE.replace('1.000 UN x 949.00', '1.000 UN x 949.00\nDESC. TARJETA -94.90')}\nBOLSA 5.00\n1.000 UN x 5.00\nDESCUENTO ITAU 20% -50.00`;
    const p = parseInvoiceText(disco(body, '1480.29'));
    expect(p.items.map((i) => [i.description, i.amount, i.discountOf])).toEqual([
      ['AGUJA SIN HUESO', 422.36, undefined],
      ['BONDIOLA ENTER MEDIA', 248.83, undefined],
      ['PANAL BABYSEC PREMIU', 949, undefined],
      ['DESC. TARJETA', -94.9, 2],
      ['BOLSA', 5, undefined],
      ['DESCUENTO ITAU 20%', -50, undefined],
    ]);
    expect(sum(p)).toBe(1480.29);
  });

  it('de un descuento no se aprende nada («DCTO SOCIO» no dice de qué rubro es)', () => {
    const learned = learnFrom({}, 'Ta-Ta', [
      { description: 'AGUJA SIN HUESO', amount: 422.36, rubroId: 'carne' },
      { description: 'DCTO SOCIO', amount: -42.24, rubroId: 'carne' },
      { description: 'LECHE CONAPROLE', amount: 91.8, rubroId: 'super' },
    ]);
    expect(learned[itemKey('DCTO SOCIO')!]).toBeUndefined();
    expect(learned[itemKey('AGUJA SIN HUESO')!]).toBe('carne');
  });

  it('Macromercado (código, cantidad, precio, monto y la letra del IVA): los 57 productos y las bolsas', () => {
    const p = parseInvoiceText(readFileSync(resolve(__dirname, 'fixtures/ticket-macromercado.txt'), 'utf8'));
    expect(p).toMatchObject({ merchant: 'MACROMERCADO', date: '2026-10-02', total: 13130 });
    expect(p.items).toHaveLength(59);
    expect(p.items.slice(0, 2)).toEqual([{ description: 'BOLSONES MACROMERCADO', amount: 60 }, { description: 'LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4', amount: 370.14 }]);
    expect(sum(p)).toBe(13130.08); // el redondeo (-0,08) no es un renglón
  });

  it('Tienda Inglesa con «$monto» y sus descuentos debajo de cada producto', () => {
    const p = parseInvoiceText('TIENDA INGLESA\nFECHA: 19/10/2026 HORA: 20:19\nBANANA DOLE ECUADOR $126,00\n15% SBU BUENOS DIAS PARA AHORRAR $-18,90\nCARBON VEGETAL $179,00\nTOTAL: $286,10');
    expect(p.items.map((i) => [i.description, i.amount, i.discountOf])).toEqual([
      ['BANANA DOLE ECUADOR', 126, undefined], ['15% SBU BUENOS DIAS PARA AHORRAR', -18.9, 0], ['CARBON VEGETAL', 179, undefined],
    ]);
    expect(p).toMatchObject({ merchant: 'TIENDA INGLESA', date: '2026-10-19', total: 286.1 });
  });

  it('arriba hay una publicidad: el comercio es el súper', () => {
    expect(parseInvoiceText(disco(BASE)).merchant).toBe('Disco');
    expect(parseInvoiceText(`Bienvenido\nGEANT NUEVOCENTRO\ne-Ticket\n${BASE}\nTOTAL: $ 1620.19`).merchant).toBe('GEANT NUEVOCENTRO');
    // Un producto que se llama como un súper no cambia el comercio
    const electro = parseInvoiceText('ELECTRO CENTRO\nRUT 219999990011\ne-Ticket A 1234\nFecha: 18/10/2026\nAURICULARES BT 1.290,00\n\nDISCO DURO 1TB 2.890,00\nTOTAL 4.180,00');
    expect(electro).toMatchObject({ merchant: 'ELECTRO CENTRO', total: 4180 });
    expect(pairs(electro)).toEqual([['AURICULARES BT', 1290], ['DISCO DURO 1TB', 2890]]);
  });
});

describe('cuál lector', () => {
  it('parece un ticket de súper: un súper conocido o su RUT, «e-Ticket» o renglones de cantidad × precio', () => {
    expect(looksLikeReceipt('DEVOTO\nPAN 45,00')).toBe(true);
    expect(looksLikeReceipt('Rut: 210094030014\nPAN 45,00')).toBe(true);
    expect(looksLikeReceipt('ALMACEN PEPE\ne-Ticket\nPAN 45,00')).toBe(true);
    expect(looksLikeReceipt('ALMACEN PEPE\nLECHE 91,80\n2 x 45,90')).toBe(true);
    expect(looksLikeReceipt('ALMACEN PEPE\nHUEVOS X 12 189,00\nPILAS AA X 4 320,00')).toBe(false);
    expect(looksLikeReceipt('UTE\nCargo fijo 350,50\nEnergía consumida 1.820,00')).toBe(false);
  });

  it('queda el que cierra con el TOTAL: un ticket de Disco sin renglones de cantidad (compra online) va con el de facturas', () => {
    const p = parseInvoiceText('DISCO\nFecha: 18/10/2026\nLECHE CONAPROLE 1L 90,00\nPAN FLAUTA 60,00\nDETERGENTE NEVEX 250,00\nTOTAL 400,00');
    expect(pairs(p)).toEqual([['LECHE CONAPROLE 1L', 90], ['PAN FLAUTA', 60], ['DETERGENTE NEVEX', 250]]);
  });

  it('factura de UTE: igual que siempre', () => {
    const p = parseInvoiceText(`UTE
Administración Nacional de Usinas
Fecha de emisión 05/10/2026  Vencimiento 25/10/2026
Cargo fijo 350,50
Energía consumida 1.820,00
IVA 22% 554,51
Total a pagar $ 3.075,01`);
    expect(p).toEqual({
      merchant: 'UTE', date: '2026-10-05', total: 3075.01,
      items: [{ description: 'Cargo fijo', amount: 350.5 }, { description: 'Energía consumida', amount: 1820 }],
    });
  });

  it('factura de Antel: igual que siempre', () => {
    const p = parseInvoiceText(`ANTEL
Factura de servicios
Fecha de emisión: 03/10/2026
Vencimiento: 20/10/2026
Cargo fijo Vera 1.190,00
Consumo de datos adicional 245,00
Servicio Antel TV 390,00
IVA 22% 401,50
Total a pagar $ 2.226,50`);
    expect(p).toEqual({
      merchant: 'ANTEL', date: '2026-10-03', total: 2226.5,
      items: [
        { description: 'Cargo fijo Vera', amount: 1190 }, { description: 'Consumo de datos adicional', amount: 245 },
        { description: 'Servicio Antel TV', amount: 390 },
      ],
    });
  });
});

describe('lo que se pagó viene después del TOTAL (un descuento o la propina, y otro total)', () => {
  const base = 'LA PASIVA\ne-Ticket\nFecha 12/10/2026\nCHIVITO CANADIENSE 1.200,00\nCOCA COLA 150,00\nTOTAL 1.350,00\n';
  it.each([
    ['Descuento IVA Ley 19210 -60,00\nTOTAL A PAGAR 1.290,00', 1290, -60],
    ['Descuento IVA Ley 19210 -60,00\nImporte a pagar $ 1.290,00', 1290, -60],
    ['Propina 135,00\nTOTAL CON PROPINA 1.485,00', 1485, 135],
  ])('%s', (tail, paid, extra) => {
    const p = parseInvoiceText(base + tail);
    expect(p.total).toBe(paid);
    // Los renglones del ticket más lo del medio: la suma es lo pagado
    expect(p.items.map((i) => i.amount)).toEqual([1200, 150, extra]);
    expect(sum(p)).toBe(paid);
  });

  it('Disco con DESCUENTO IVA LEY 19210 y TOTAL A PAGAR: lo pagado, con los productos de dos renglones', () => {
    const p = parseInvoiceText('Disco\ne-Ticket\nCOCA COLA 2.25L 270.00\n2.000 UN x 135.00\nPAN FLAUTA 45.00\n1.000 UN x 45.00\nTOTAL: $ 315.00\nDESCUENTO IVA LEY 19210 -5.16\nTOTAL A PAGAR $ 309.84\nTarjeta Credito/Debito $ 309.84');
    expect(p.total).toBe(309.84);
    expect(pairs(p)).toEqual([['COCA COLA 2.25L', 270], ['PAN FLAUTA', 45], ['DESCUENTO IVA LEY 19210', -5.16]]);
  });

  it('sin otro total abajo (el «DTO. IVA LEY 19210» de los tickets de Disco), el TOTAL', () => {
    const p = parseInvoiceText('Disco\ne-Ticket\nCOCA COLA 2.25L 270.00\n2.000 UN x 135.00\nPAN FLAUTA 45.00\n1.000 UN x 45.00\nTOTAL: $ 315.00\nDTO. IVA LEY 19210 -5.16');
    expect(p.total).toBe(315);
  });
});

describe('el súper del encabezado no es un producto que se llama como él', () => {
  it.each([
    ['ELECTRO CENTRO\ne-Ticket\nFecha 18/10/2026\nDISCO DURO 1TB\n1.000 UN x 2.890,00 2.890,00\nTOTAL 2.890,00', 'ELECTRO CENTRO'],
    ['BAZAR LA ESQUINA\nFecha 18/10/2026\nPELOTA DISCO\n2 x 150,00 300,00\nTOTAL 300,00', 'BAZAR LA ESQUINA'],
    ['FERRETERIA EL TORNILLO\nFecha 18/10/2026\nDISCO DE CORTE 115MM\n2 x 85,00 170,00\nTOTAL 170,00', 'FERRETERIA EL TORNILLO'],
    ['FERRETERIA EL TORNILLO\nFecha 18/10/2026\nDISCO DE CORTE 115MM 170,00\nTOTAL 170,00', 'FERRETERIA EL TORNILLO'],
  ])('%s', (text, merchant) => {
    expect(parseInvoiceText(text).merchant).toBe(merchant);
  });

  it('el súper de verdad, arriba, sigue (con una publicidad antes del logo, su nombre)', () => {
    expect(parseInvoiceText('DISCO\nSUC. POCITOS\ne-Ticket\nFecha 18/10/2026\nLECHE ENTERA\n2 x 45,00 90,00\nTOTAL 90,00').merchant).toBe('DISCO');
    expect(parseInvoiceText('LLEVA 2 Y PAGA 1\nDISCO\ne-Ticket\nFecha 18/10/2026\nLECHE ENTERA\n2 x 45,00 90,00\nTOTAL 90,00').merchant).toBe('Disco');
  });
});

describe('facturas de servicios: el vencimiento y las lecturas del medidor', () => {
  it('«Total a pagar» con el vencimiento al lado: ni el año es el total ni la fecha es la del vencimiento', () => {
    const p = parseInvoiceText('ANTEL\nFactura de servicios\nTotal a pagar $ 1.750,70 Vencimiento 20/10/2026\nFecha de emisión: 03/10/2026\nCargo fijo Vera 1.190,00\nConsumo de datos 245,00\nIVA 22% 315,70\nTotal a pagar $ 1.750,70');
    expect(p.total).toBe(1750.7);
    expect(p.date).toBe('2026-10-03');
    expect(pairs(p)).toEqual([['Cargo fijo Vera', 1190], ['Consumo de datos', 245]]);
  });

  it('el vencimiento solo, en el renglón de abajo del total, tampoco es el total', () => {
    const p = parseInvoiceText('OSE\nFecha 05/10/2026\nCargo fijo 300,00\nConsumo de agua 15 m3 450,00\nIVA 10% 75,00\nTotal a pagar\n20/10/2026\nImporte $ 825,00');
    expect(p.total).toBe(825);
    expect(p.date).toBe('2026-10-05');
  });

  it('las lecturas del medidor y los números sin centavos no son plata (los cargos con «kWh» o «m3», sí)', () => {
    const p = parseInvoiceText('UTE\nFecha 05/10/2026\nLectura anterior 12345\nLectura actual 12590\nCargo fijo 350,50\nEnergía consumida 245 kWh 1.820,00\nIVA 22% 477,51\nTotal a pagar 2.648,01');
    expect(pairs(p)).toEqual([['Cargo fijo', 350.5], ['Energía consumida 245 kWh', 1820]]);
    // Contador de minutos de Antel, sin la palabra «lectura»
    expect(pairs(parseInvoiceText('ANTEL\nFecha 05/10/2026\nMinutos usados 340\nCargo fijo 1.190,00\nMinutos a móviles 120,50\nTotal a pagar 1.310,50'))).toEqual([['Cargo fijo', 1190], ['Minutos a móviles', 120.5]]);
  });

  it('un documento sin centavos en ningún monto sigue leyendo los enteros', () => {
    expect(pairs(parseInvoiceText('FERIA DEL BARRIO\nFecha 05/10/2026\nTomates 120\nLechuga 60\nTotal 180'))).toEqual([['Tomates', 120], ['Lechuga', 60]]);
  });
});
