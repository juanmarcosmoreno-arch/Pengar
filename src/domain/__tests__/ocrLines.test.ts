/**
 * Renglones de la foto de un ticket (copiado de Kvar, src/domain/__tests__/ocr.test.ts): la foto torcida, los pedazos
 * desordenados y el papel arrugado. En Pengar se elige la forma de armarlos con `invoiceLinesScore` (la lectura de la
 * factura: la de tickets o la de facturas, la que cierra).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVOICE_CLOSES, invoiceLinesScore, parseInvoiceText } from '../invoice';
import { bestGrouping, groupIntoLines, groupLines, type TextBox } from '../ocrLines';
import { parseReceiptText, RECEIPT_CLOSES, receiptLinesScore } from '../receipt';

/** Un ticket de Macromercado inventado (con el formato de los de verdad: código, cantidad, precio, monto y la letra del IVA) */
const ticket = readFileSync(resolve(__dirname, 'fixtures/ticket-macromercado.txt'), 'utf8');

/**
 * Simula lo que devuelve Vision para una foto de ticket (alto = 2,2 × ancho): cada línea partida en
 * descripción y números, la foto torcida y los pedazos desordenados.
 */
const ASPECT = 2.2;
function simulateVision(text: string, skew = 0.02): TextBox[] {
  const boxes: TextBox[] = [];
  text.split('\n').forEach((line, i) => {
    const y = 0.02 + i * 0.012;
    const m = /^(.*?)\s+(\d+,\d{3}\s+\d+,\d{2}\s+-?\d+,\d{2}[A-Z]?)$/.exec(line);
    const parts = m ? [m[1], m[2]] : [line];
    parts.forEach((p, j) => {
      const x = j === 0 ? 0.05 : 0.62;
      boxes.push({ text: p, x, y: y + (skew * x) / ASPECT, w: j === 0 ? 0.5 : 0.33, h: 0.009, slope: skew });
    });
  });
  return boxes.sort(() => 0.5 - Math.random()); // Vision no garantiza orden
}

// Tienda Inglesa (datos inventados): nombre a la izquierda y «$monto» bien a la derecha, renglones apretados
const TI = [
  'TIENDA INGLESA', 'FECHA: 19/10/2026|HORA: 20:19',
  'MILANESA DE CERDO EMPANADA|$242,60', 'MILANESA DE CERDO EMPANADA|$250,90', 'TIENDA DIAS LUNES|$-148,05',
  'BANANA DOLE ECUADOR|$126,00', '15% SBU BUENOS DIAS PARA AHORRAR|$-18,90', 'CHORIZOS CENTENARIO MIX|$609,00',
  '15% SBU BUENOS DIAS PARA AHORRAR|$-91,35', 'FALDA PARRILLERA CON HUESO|$258,90', '15% SBU BUENOS DIAS PARA AHORRAR|$-38,83',
  'COLITA DE CUADRIL|$710,60', '15% SBU BUENOS DIAS PARA AHORRAR|$-106,60', 'CARBON VEGETAL|$179,00', 'COLECCIONABLE|$-20,00',
  'TOTAL:|$1953,27',
];
/**
 * El papel arrugado: cada parte del ticket algo torcida distinto, y Vision le erra a la inclinación de cada pedazo
 * (cree que baja bastante hacia la derecha): así, cada nombre quedaba con el monto de otro renglón
 */
function wrinkled(rows: string[]): TextBox[] {
  return rows.flatMap((row, i) => {
    const y = 0.3 + i * 0.006;
    const tilt = 0.012 * Math.sin(i / 4); // inclinación real en esta parte
    return row.split('|').map((text, j) => {
      const x = j === 0 ? 0.25 : 0.6;
      const w = j === 0 ? Math.min(0.3, text.length * 0.01) : 0.06;
      return { text, x, y: y + (tilt * (x + w / 2 - 0.25)) / ASPECT, w, h: 0.004, slope: 0.08 };
    });
  });
}

describe('lectura de la foto del ticket', () => {
  it('rearma los renglones aunque la foto esté torcida y los pedazos vengan desordenados', () => {
    const lines = groupIntoLines(simulateVision(ticket, 0.03), ASPECT); // ~1,7° de inclinación
    expect(lines).toContain('168953 LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4 2,000 185,07 370,14E');
    const parsed = parseReceiptText(lines.join('\n'));
    expect(parsed.lines).toHaveLength(57);
    expect(parsed.difference).toBe(0); // la suma sigue cerrando con el total
  });

  it('sin inclinación conocida (una app vieja no la manda), se arregla con fotos derechas', () => {
    const boxes = simulateVision(ticket, 0).map(({ slope: _s, ...b }) => b);
    expect(parseReceiptText(groupIntoLines(boxes, ASPECT).join('\n')).difference).toBe(0);
  });

  it('caja vacía', () => {
    expect(groupIntoLines([])).toEqual([]);
    expect(bestGrouping([], ASPECT, invoiceLinesScore, INVOICE_CLOSES)).toEqual([]);
  });

  it('con el papel arrugado, prueba otras inclinaciones hasta que la suma cierra con el TOTAL', () => {
    const boxes = wrinkled(TI);
    expect(parseReceiptText(groupIntoLines(boxes, ASPECT).join('\n')).difference).not.toBe(0); // así, se mezclaban
    const lines = bestGrouping(boxes, ASPECT, receiptLinesScore, RECEIPT_CLOSES);
    const r = parseReceiptText(lines.join('\n'));
    expect(r.lines.map((l) => [l.description, l.amount])).toEqual([
      ['MILANESA DE CERDO EMPANADA', 242.6], ['MILANESA DE CERDO EMPANADA', 102.85], ['BANANA DOLE ECUADOR', 107.1],
      ['CHORIZOS CENTENARIO MIX', 517.65], ['FALDA PARRILLERA CON HUESO', 220.07], ['COLITA DE CUADRIL', 604], ['CARBON VEGETAL', 159],
    ]);
    expect(r.difference).toBe(0);
    expect(r.lines.map((l) => l.description)).not.toContainEqual(expect.stringMatching(/HORA/));
  });

  it('en Pengar (invoiceLinesScore): la factura queda con cada producto y su descuento abajo, y cierra', () => {
    const boxes = wrinkled(TI);
    const p = parseInvoiceText(bestGrouping(boxes, ASPECT, invoiceLinesScore, INVOICE_CLOSES).join('\n'));
    expect(p.total).toBe(1953.27);
    expect(p.items.map((i) => [i.description, i.amount, i.discountOf])).toEqual([
      ['MILANESA DE CERDO EMPANADA', 242.6, undefined],
      ['MILANESA DE CERDO EMPANADA', 250.9, undefined],
      ['TIENDA DIAS LUNES', -148.05, 1],
      ['BANANA DOLE ECUADOR', 126, undefined],
      ['15% SBU BUENOS DIAS PARA AHORRAR', -18.9, 3],
      ['CHORIZOS CENTENARIO MIX', 609, undefined],
      ['15% SBU BUENOS DIAS PARA AHORRAR', -91.35, 5],
      ['FALDA PARRILLERA CON HUESO', 258.9, undefined],
      ['15% SBU BUENOS DIAS PARA AHORRAR', -38.83, 7],
      ['COLITA DE CUADRIL', 710.6, undefined],
      ['15% SBU BUENOS DIAS PARA AHORRAR', -106.6, 9],
      ['CARBON VEGETAL', 179, undefined],
      ['COLECCIONABLE', -20, 11],
    ]);
    expect(Math.round(p.items.reduce((s, i) => s + i.amount, 0) * 100) / 100).toBe(1953.27);
  });

  it('la foto torcida: con los renglones armados derechos (como antes) no cierra; enderezados, sí', () => {
    const boxes = simulateVision(ticket, 0.03);
    const before = parseInvoiceText(groupLines(boxes).join('\n'));
    expect(before.items.reduce((s, i) => s + i.amount, 0)).not.toBeCloseTo(13130, 0);
    const p = parseInvoiceText(bestGrouping(boxes, ASPECT, invoiceLinesScore, INVOICE_CLOSES).join('\n'));
    expect(p.total).toBe(13130);
    expect(p.items).toHaveLength(59); // 57 productos y 2 bolsas
    expect(Math.round(p.items.reduce((s, i) => s + i.amount, 0) * 100) / 100).toBe(13130.08); // y el redondeo de -0,08
  });

  it('si ya cierra, no prueba nada más', () => {
    const boxes = simulateVision(ticket, 0.03);
    let calls = 0;
    bestGrouping(boxes, ASPECT, (l) => (calls++, invoiceLinesScore(l)), INVOICE_CLOSES);
    expect(calls).toBe(1);
  });
});
