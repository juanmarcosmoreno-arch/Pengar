import { describe, expect, it } from 'vitest';
import { dollarLevel, parseBrou } from '../brou';

describe('cotizaciones del BROU', () => {
  it('lee el billete y el eBROU, compra y venta', () => {
    const html = `<tr><td><p class="moneda">Dólar</p></td><td>&nbsp;</td><td><p class="valor"> 38,90000 </p></td><td><p class="valor"> 41,30000 </p></td><td>1,00000</td></tr>
      <tr><td><p class="moneda">Dólar eBROU</p></td><td><p class="valor"> 39,40000 </p></td><td><p class="valor"> 40,80000 </p></td></tr>
      <tr><td>Dólar eBROU - Cotización preferencial</td></tr>`;
    expect(parseBrou(html)).toEqual({ billete: { buy: 38.9, sell: 41.3 }, ebrou: { buy: 39.4, sell: 40.8 } });
    expect(parseBrou('<html>sin cotizaciones</html>')).toBeNull();
  });
  it('el dólar alto o bajo contra el promedio de 3 meses', () => {
    const hist = Array.from({ length: 60 }, () => 40);
    expect(dollarLevel(41.5, hist)?.level).toBe('alto');
    expect(dollarLevel(38.5, hist)?.level).toBe('bajo');
    expect(dollarLevel(40.5, hist)?.level).toBe('normal');
    expect(dollarLevel(40, [40])).toBeNull();
  });
});
