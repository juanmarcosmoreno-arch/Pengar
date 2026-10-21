/**
 * El lector de tickets de súper (copiado de Kvar con sus pruebas: src/domain/__tests__/receipt.test.ts; las de los
 * productos de la casa, que son de Kvar, no están). Al final, lo propio de Pengar: `entries`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanDescription, packSizeOf, parseNumber, parseReceiptText } from '../receipt';

/** Un ticket de Macromercado inventado (con el formato de los de verdad: código, cantidad, precio, monto y la letra del IVA) */
const ticket = readFileSync(resolve(__dirname, 'fixtures/ticket-macromercado.txt'), 'utf8');

describe('ticket de Macromercado', () => {
  const r = parseReceiptText(ticket);

  it('encuentra el súper, la fecha y todas las líneas', () => {
    expect(r.store).toBe('macromercado');
    expect(r.date).toBe('2026-10-02');
    expect(r.lines).toHaveLength(57);
    expect(r.ignored).toEqual(['BOLSONES MACROMERCADO', 'BOLSAS CAMISETA MACRO']);
  });

  it('la suma cierra con el total (control de lectura)', () => {
    expect(r.total).toBe(13130);
    expect(r.difference).toBe(0);
  });

  it('packs, peso y ofertas', () => {
    const leche = r.lines.find((l) => l.storeCode === '168953')!;
    expect(leche).toMatchObject({ quantity: 2, packSize: 4, units: 8, amount: 370.14, weighed: false });
    const pollo = r.lines.find((l) => l.storeCode === '70947')!;
    expect(pollo).toMatchObject({ quantity: 9.686, weighed: true, units: 1, amount: 1410.48 });
    expect(pollo.clean).toBe('Pollo con menudos');
    const arroz = r.lines.find((l) => l.storeCode === '25659')!;
    expect(arroz.promo).toBe(true);
    expect(arroz.clean).toBe('Arroz saman blanco 5 kg.');
    const panales = r.lines.find((l) => l.storeCode === '139634')!;
    expect(panales.units).toBe(26);
  });

  it('expande abreviaturas', () => {
    expect(cleanDescription('GALL. EL TRIGAL CON LECHE 190 GRS.')).toBe('Galletitas el trigal con leche 190 grs.');
    expect(cleanDescription('ADEREZO HELLMANN\'S ASADO S/GLUTEN 250GRS')).toBe("Aderezo hellmann's asado sin gluten 250grs");
    expect(cleanDescription('DESOD. REXONA M SPRAY')).toBe('Desodorante rexona m spray');
  });
});

describe('utilidades', () => {
  it('números con coma decimal y punto de miles', () => {
    expect(parseNumber('1.410,48')).toBe(1410.48);
    expect(parseNumber('9,686')).toBe(9.686);
    expect(parseNumber('11.851,00')).toBe(11851);
    expect(parseNumber('-0,08')).toBe(-0.08);
  });

  it('tamaño de pack', () => {
    expect(packSizeOf('LECHE 1LT X 4')).toBe(4);
    expect(packSizeOf('MARIA RKA CHICA X3 300G')).toBe(3);
    expect(packSizeOf('HARINA 1 KG.')).toBe(1);
    expect(packSizeOf('QUESO X 500 GR')).toBe(1);
  });
});

/** Un ticket de Disco Fresh Market (la dirección, el cliente y los códigos, inventados), como lo arma el lector de fotos: un producto en dos renglones */
const DISCO = `en tus productos favoritos
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
AGUJA SIN HUESO 422.36
1.324 KG x 319.00
BONDIOLA ENTER MEDIA 248.83
1.670 KG x 149.00
PANAL BABYSEC PREMIU 949.00
1.000 UN x 949.00
TOTAL: $ 1620.19
Tarjeta Credito/Debito $ 1620.19
Pago total $ 1620.19
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

describe('ticket de Disco en dos renglones', () => {
  const expectDisco = (r: ReturnType<typeof parseReceiptText>) => {
    expect(r.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.amount, l.weighed, l.units])).toEqual([
      ['AGUJA SIN HUESO', 1.324, 319, 422.36, true, 1],
      ['BONDIOLA ENTER MEDIA', 1.67, 149, 248.83, true, 1],
      ['PANAL BABYSEC PREMIU', 1, 949, 949, false, 1],
    ]);
    expect(r.total).toBe(1620.19);
    expect(r.difference).toBe(0);
  };

  it('lee los productos, el súper, la fecha y el total', () => {
    const r = parseReceiptText(DISCO);
    expect(r.store).toBe('disco');
    expect(r.date).toBe('2026-10-17');
    expectDisco(r);
    expect(r.lines[0].clean).toBe('Aguja sin hueso');
  });

  it('aunque el OCR pegue el monto al renglón de la cantidad (foto curvada)', () => {
    const curved = DISCO.replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', 'AGUJA SIN HUESO\n1.324 KG x 319.00 422.36')
      .replace('PANAL BABYSEC PREMIU 949.00\n1.000 UN x 949.00', 'PANAL BABYSEC PREMIU\n1.000 UN x 949.00 949.00');
    expectDisco(parseReceiptText(curved));
  });

  it('aunque el OCR junte los dos renglones en uno', () => {
    expectDisco(parseReceiptText(DISCO.replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', 'AGUJA SIN HUESO 1.324 KG x 319.00 422.36')));
  });

  it('con la cantidad arriba de la descripción', () => {
    const reversed = DISCO.replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', '1.324 KG x 319.00\nAGUJA SIN HUESO 422.36')
      .replace('BONDIOLA ENTER MEDIA 248.83\n1.670 KG x 149.00', '1.670 KG x 149.00\nBONDIOLA ENTER MEDIA 248.83')
      .replace('PANAL BABYSEC PREMIU 949.00\n1.000 UN x 949.00', '1.000 UN x 949.00\nPANAL BABYSEC PREMIU 949.00');
    expectDisco(parseReceiptText(reversed));
  });

  it('con coma decimal y un número mal leído igual arma el producto (y avisa la diferencia)', () => {
    const r = parseReceiptText(DISCO.replace('1.670 KG x 149.00', '1,670 KG x 149,00').replace('PANAL BABYSEC PREMIU 949.00', 'PANAL BABYSEC PREMIU 943.00'));
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1].quantity).toBe(1.67);
    expect(r.difference).toBe(-6);
  });

  it('un descuento se resta del producto de arriba', () => {
    const r = parseReceiptText(DISCO.replace('1.000 UN x 949.00', '1.000 UN x 949.00\nDESC. TARJETA -94.90').replace('TOTAL: $ 1620.19', 'TOTAL: $ 1525.29'));
    const panal = r.lines.find((l) => l.description.startsWith('PANAL'))!;
    expect(panal.amount).toBe(854.1);
    expect(panal.promo).toBe(true);
    expect(r.difference).toBe(0);
  });

  it('SUBTOTAL no es el total', () => {
    const r = parseReceiptText(DISCO.replace('TOTAL: $ 1620.19', 'SUBTOTAL 1620.19\nTOTAL: $ 1620.19'));
    expect(r.total).toBe(1620.19);
    expect(r.lines).toHaveLength(3);
  });

  it('el súper es la marca de arriba, no la razón social', () => {
    expect(parseReceiptText(`DEVOTO\nSupermercados Disco del Uruguay S.A.\n${DISCO.split('MONEDA: UYU')[1]}`).store).toBe('devoto');
    expect(parseReceiptText(`Géant\nSupermercados Disco del Uruguay S.A.\nTOTAL 10,00`).store).toBe('geant');
  });
});

describe('ticket de Disco con el monto suelto', () => {
  it('el monto en su propio renglón se pega a la descripción o a la cantidad', () => {
    const r = parseReceiptText(DISCO
      .replace('AGUJA SIN HUESO 422.36\n1.324 KG x 319.00', 'AGUJA SIN HUESO\n422.36\n1.324 KG x 319.00')
      .replace('BONDIOLA ENTER MEDIA 248.83\n1.670 KG x 149.00', 'BONDIOLA ENTER MEDIA\n1.670 KG x 149.00\n248.83'));
    expect(r.lines.map((l) => l.amount)).toEqual([422.36, 248.83, 949]);
    expect(r.difference).toBe(0);
  });
});

// --- Pengar: cada renglón de plata, con los descuentos y las bolsas aparte -----------------------------------------

describe('los renglones de plata (entries)', () => {
  const entries = (text: string) => parseReceiptText(text).entries;

  it('el producto con su monto impreso y abajo su descuento (que sabe de qué producto es)', () => {
    const e = entries(DISCO.replace('1.000 UN x 949.00', '1.000 UN x 949.00\nDESC. TARJETA -94.90').replace('TOTAL: $ 1620.19', 'TOTAL: $ 1525.29'));
    expect(e).toEqual([
      { description: 'AGUJA SIN HUESO', amount: 422.36 },
      { description: 'BONDIOLA ENTER MEDIA', amount: 248.83 },
      { description: 'PANAL BABYSEC PREMIU', amount: 949 },
      { description: 'DESC. TARJETA', amount: -94.9, of: 2 },
    ]);
  });

  it('el renglón de la promoción va en el nombre del descuento; solo el monto, el nombre de abajo', () => {
    const devoto = entries('DEVOTO\nCOCA COLA 2.25L 270.00\n2.000 UN x 135.00\nOFERTA 2DA AL 50%\nDTO -67.50\nPAN FLAUTA 45.00\n1.000 UN x 45.00\nTOTAL: $ 247.50');
    expect(devoto).toEqual([
      { description: 'COCA COLA 2.25L', amount: 270 },
      { description: 'OFERTA 2DA AL 50% DTO', amount: -67.5, of: 0 },
      { description: 'PAN FLAUTA', amount: 45 },
    ]);
    const suelto = entries('LECHE CONAPROLE 91,80\n2 x 45,90\n-9,18\nDESC. SOCIO\nTOTAL $ 82,62');
    expect(suelto[1]).toEqual({ description: 'DESC. SOCIO', amount: -9.18, of: 0 });
  });

  it('las bolsas del súper y los descuentos de toda la compra son renglones sueltos', () => {
    const e = entries('Disco\ne-Ticket\nCOCA COLA 2.25L 270.00\n2.000 UN x 135.00\nBOLSA 5.00\n1.000 UN x 5.00\nPAN FLAUTA 45.00\n1.000 UN x 45.00\nDESCUENTO ITAU 20% -64.00\nTOTAL: $ 256.00');
    expect(e).toEqual([
      { description: 'COCA COLA 2.25L', amount: 270 },
      { description: 'BOLSA', amount: 5 },
      { description: 'PAN FLAUTA', amount: 45 },
      { description: 'DESCUENTO ITAU 20%', amount: -64 },
    ]);
    expect(e.reduce((s, x) => s + x.amount, 0)).toBe(256);
  });

  it('una anulación saca el producto (no queda como renglón)', () => {
    const disco = 'Disco\nCOCA COLA 2.25L 135.00\n1.000 UN x 135.00\nCOCA COLA 2.25L -135.00\n-1.000 UN x 135.00\nPAN FLAUTA 45.00\n1.000 UN x 45.00\nTOTAL: $ 45.00';
    expect(entries(disco)).toEqual([{ description: 'PAN FLAUTA', amount: 45 }]);
  });

  it('en el ticket de Macromercado suman el total (con el redondeo)', () => {
    const r = parseReceiptText(ticket);
    expect(r.entries).toHaveLength(59); // 57 productos y 2 bolsas
    expect(Math.round(r.entries.reduce((s, x) => s + x.amount, 0) * 100) / 100).toBe(13130.08);
  });
});
