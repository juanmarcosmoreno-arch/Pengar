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
