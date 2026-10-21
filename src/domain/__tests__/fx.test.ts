import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDays } from '../dates';
import {
  bcuChunks,
  bcuRequestBody,
  cachedRates,
  emptyFx,
  formatRate,
  isUsdSymbol,
  knownDay,
  lookbackStart,
  mergeBcu,
  normalizeFx,
  parseBcuResponse,
  parseErApi,
  pendingDays,
  rateOn,
  splitUsdNote,
  usdNote,
  withUsdNote,
} from '../fx';
import { normalizeMerchant, type StatementTx } from '../statement';
import { statementNote, txRates, usdDates } from '../statementReview';

// Respuestas reales del BCU (pedidas con curl el 21/10/2026)
const fixture = (name: string) => readFileSync(`src/domain/__tests__/fixtures/${name}`, 'utf8');
const OCTOBER = fixture('bcu-2026-10-08-al-21.xml');

/** Una hora local (como la del teléfono) */
const at = (iso: string) => new Date(iso).getTime();

describe('respuesta del BCU', () => {
  it('lee una cotización por día hábil, ordenadas, sin fines de semana ni feriados', () => {
    const rates = parseBcuResponse(OCTOBER);
    expect(rates.map((r) => r.date)).toEqual(['2026-10-08', '2026-10-09', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']);
    expect(rates.find((r) => r.date === '2026-10-14')?.rate).toBe(40.236);
    expect(rates.at(-1)).toEqual({ date: '2026-10-20', rate: 40.077 });
  });

  it('«No existe cotización» es una lista vacía; otro error o algo que no es del BCU tira', () => {
    expect(parseBcuResponse(fixture('bcu-sin-cotizacion.xml'))).toEqual([]);
    expect(() => parseBcuResponse(fixture('bcu-rango-excedido.xml'))).toThrow(/Rango de fechas excede/);
    expect(() => parseBcuResponse('<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="x"></SOAP-ENV:Envelope>')).toThrow(/No es una respuesta/);
    expect(() => parseBcuResponse('<html>502 Bad Gateway</html>')).toThrow();
  });

  it('con TCC y TCV distintas, el promedio; solo la moneda pedida; con o sin prefijos', () => {
    const dato = (fecha: string, moneda: number, tcc: string, tcv: string) =>
      `<ns:datoscotizaciones.dato><ns:Fecha>${fecha}</ns:Fecha><ns:Moneda>${moneda}</ns:Moneda><ns:TCC>${tcc}</ns:TCC><ns:TCV>${tcv}</ns:TCV></ns:datoscotizaciones.dato>`;
    const xml = `<ns:respuestastatus><ns:status>1</ns:status><ns:codigoerror>0</ns:codigoerror><ns:mensaje/></ns:respuestastatus>
      <ns:datoscotizaciones>${dato('2026-10-14', 2225, '39.900000', '40.300000')}${dato('2026-10-14', 2230, '39.000000', '39.000000')}${dato('2026-10-15', 2225, '0', '40.100000')}</ns:datoscotizaciones>`;
    expect(parseBcuResponse(xml)).toEqual([{ date: '2026-10-14', rate: 40.1 }, { date: '2026-10-15', rate: 40.1 }]);
  });

  it('arma el pedido con las fechas y el dólar billete (2225)', () => {
    const body = bcuRequestBody('2026-10-14', '2026-10-20');
    expect(body).toContain('<cot:Moneda><cot:item>2225</cot:item></cot:Moneda>');
    expect(body).toContain('<cot:FechaDesde>2026-10-14</cot:FechaDesde><cot:FechaHasta>2026-10-20</cot:FechaHasta>');
    expect(body.startsWith('<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope')).toBe(true);
  });

  it('los rangos largos se piden de a tramos (el BCU no acepta más de un año)', () => {
    expect(bcuChunks('2026-10-01', '2026-10-20')).toEqual([['2026-10-01', '2026-10-20']]);
    const chunks = bcuChunks('2025-01-01', '2026-10-20', 180);
    expect(chunks[0]).toEqual(['2025-01-01', '2025-06-29']);
    expect(chunks[1][0]).toBe('2025-06-30');
    expect(chunks.at(-1)![1]).toBe('2026-10-20');
    for (let i = 1; i < chunks.length; i++) expect(addDays(chunks[i - 1][1], 1)).toBe(chunks[i][0]);
  });

  it('open.er-api.com: los pesos por dólar, o null', () => {
    expect(parseErApi({ result: 'success', rates: { USD: 1, UYU: 40.0812 } })).toBe(40.08);
    expect(parseErApi({ result: 'error', 'error-type': 'unsupported-code' })).toBeNull();
    expect(parseErApi({ result: 'success', rates: { USD: 1 } })).toBeNull();
    expect(parseErApi(null)).toBeNull();
  });
});

describe('cotización de una fecha', () => {
  const rates = parseBcuResponse(OCTOBER);
  it('la del día o la del último día hábil anterior', () => {
    expect(rateOn('2026-10-14', rates)).toEqual({ date: '2026-10-14', rate: 40.236 });
    // Sábado, domingo y el lunes 12 (feriado): la del viernes 9
    expect(rateOn('2026-10-10', rates)?.date).toBe('2026-10-09');
    expect(rateOn('2026-10-12', rates)?.date).toBe('2026-10-09');
    // Hoy todavía no está publicada: la de ayer
    expect(rateOn('2026-10-21', rates)).toEqual({ date: '2026-10-20', rate: 40.077 });
    expect(rateOn('2026-10-01', rates)).toBeNull();
    // Desordenadas, igual
    expect(rateOn('2026-10-17', [...rates].reverse())?.date).toBe('2026-10-16');
  });
});

describe('caché', () => {
  const rates = parseBcuResponse(OCTOBER);
  const fetchedAt = at('2026-10-21T00:05:00');
  const cache = mergeBcu(emptyFx(), '2026-10-08', '2026-10-21', rates, fetchedAt);

  it('los días ya pasados quedan sabidos para siempre (con cotización o sin ella)', () => {
    expect(knownDay(cache, '2026-10-14', at('2027-05-01T10:00:00'))).toBe(true);
    expect(knownDay(cache, '2026-10-11', at('2027-05-01T10:00:00'))).toBe(true);
    expect(pendingDays(cache, '2026-10-08', '2026-10-20', at('2026-12-01T10:00:00'))).toEqual([]);
    expect(pendingDays(cache, '2026-10-05', '2026-10-09', at('2026-12-01T10:00:00'))).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('hoy se vuelve a pedir pasadas 6 horas, y al día siguiente aunque no hayan pasado', () => {
    expect(knownDay(cache, '2026-10-21', at('2026-10-21T06:00:00'))).toBe(true);
    expect(knownDay(cache, '2026-10-21', at('2026-10-21T06:06:00'))).toBe(false);
    expect(pendingDays(cache, '2026-10-14', '2026-10-21', at('2026-10-21T09:00:00'))).toEqual(['2026-10-21']);
    // Se preguntó por el 21 el mismo 21 (todavía sin publicar): el 22 a la 1 de la mañana se pide de nuevo
    expect(knownDay(cache, '2026-10-21', at('2026-10-22T01:00:00'))).toBe(false);
  });

  it('para un día ya sabido no hace falta ir 14 días para atrás: alcanza con el último día hábil guardado', () => {
    const now = at('2026-12-01T10:00:00');
    expect(lookbackStart(cache, '2026-10-14', now)).toBe('2026-10-14');
    // Domingo 11: desde el viernes 9
    expect(lookbackStart(cache, '2026-10-11', now)).toBe('2026-10-09');
    expect(lookbackStart(cache, '2026-10-05', now)).toBe('2026-09-21');
    expect(lookbackStart(emptyFx(), '2026-10-14', now)).toBe('2026-09-30');
  });

  it('del futuro no se pide nada', () => {
    expect(pendingDays(cache, '2026-10-20', '2026-10-30', at('2026-10-21T03:00:00'))).toEqual([]);
    const later = mergeBcu(cache, '2026-10-21', '2026-10-30', [], at('2026-10-21T09:00:00'));
    expect(Object.keys(later.asked).sort().at(-1)).toBe('2026-10-21');
    expect(later.updatedAt).toBe(at('2026-10-21T09:00:00'));
  });

  it('las guardadas de un rango, ordenadas; lo leído de IndexedDB se limpia', () => {
    expect(cachedRates(cache, '2026-10-13', '2026-10-15').map((r) => r.rate)).toEqual([40.2, 40.236, 40.135]);
    expect(normalizeFx(undefined)).toEqual(emptyFx());
    expect(normalizeFx({ rates: { '2026-10-14': 40.236, x: 3, '2026-10-15': -1 }, asked: { '2026-10-14': 5 }, updatedAt: 9, market: { date: '2026-10-21', rate: 'no' } }))
      .toEqual({ rates: { '2026-10-14': 40.236 }, asked: { '2026-10-14': 5 }, updatedAt: 9 });
    const n = normalizeFx(JSON.parse(JSON.stringify(cache)));
    expect(n.rates).toEqual(cache.rates);
  });
});

describe('notas en dólares', () => {
  it('«U$S 20 × 40,10», con tres decimales si la cotización los tiene', () => {
    expect(usdNote(20, 40.1)).toBe('U$S 20 × 40,10');
    expect(usdNote(12.5, 40.236)).toBe('U$S 12,50 × 40,236');
    expect(formatRate(40)).toBe('40,00');
  });

  it('se separa de la nota y se reemplaza (no se repite al editar)', () => {
    expect(splitUsdNote('Almuerzo · U$S 20 × 40,10')).toEqual({ rest: 'Almuerzo', usd: 20, rate: 40.1 });
    expect(splitUsdNote('U$S 1.234,50 × 39,875')).toEqual({ rest: '', usd: 1234.5, rate: 39.875 });
    expect(splitUsdNote('OCA · cuota 2/3 · U$S 12,99 × 40,236')).toEqual({ rest: 'OCA · cuota 2/3', usd: 12.99, rate: 40.236 });
    expect(splitUsdNote('Regalo de U$S para Juan')).toEqual({ rest: 'Regalo de U$S para Juan' });
    expect(splitUsdNote(undefined)).toEqual({ rest: '' });
    expect(withUsdNote('', 20, 40.1)).toBe('U$S 20 × 40,10');
    expect(withUsdNote('Almuerzo · U$S 15 × 39,90', 20, 40.1)).toBe('Almuerzo · U$S 20 × 40,10');
  });

  it('la moneda de la app ya en dólares', () => {
    expect(isUsdSymbol('U$S')).toBe(true);
    expect(isUsdSymbol('us$')).toBe(true);
    expect(isUsdSymbol('USD')).toBe(true);
    expect(isUsdSymbol('$')).toBe(false);
    expect(isUsdSymbol('$U')).toBe(false);
  });
});

describe('estado de cuenta con la cotización de cada día', () => {
  const tx = (date: string, amount: number, description: string, extra: Partial<StatementTx> = {}): StatementTx =>
    ({ date, amount, description, ...normalizeMerchant(description), currency: 'local', kind: 'compra', ...extra });
  const txs = [
    tx('2026-10-08', 1000, 'TIENDA INGLESA'),
    tx('2026-10-11', 12.99, 'NETFLIX.COM', { currency: 'usd' }),
    tx('2026-10-14', 4.99, 'SPOTIFY', { currency: 'usd' }),
    tx('2026-10-15', -20, 'SU PAGO', { currency: 'usd', kind: 'pago' }),
    tx('2026-10-16', -1.5, 'DEVOLUCION', { currency: 'usd', kind: 'credito' }),
  ];
  const rates = parseBcuResponse(OCTOBER);

  it('las fechas a pedir: de la primera a la última compra o crédito en dólares', () => {
    expect(usdDates(txs)).toEqual({ from: '2026-10-11', to: '2026-10-16' });
    expect(usdDates([txs[0]])).toBeNull();
  });

  it('cada compra con la del BCU de su fecha; una sola si la escribió la persona', () => {
    // El domingo 11, la del viernes 9
    expect(txRates(txs, null, rates)).toEqual([1, 40.184, 40.236, 1, 40.097]);
    expect(txRates(txs, 40.5, null)).toEqual([1, 40.5, 40.5, 1, 40.5]);
    expect(txRates(txs, null, null)).toBeNull();
    expect(txRates(txs, null, rates.filter((r) => r.date > '2026-10-12'))).toBeNull();
    expect(txRates([txs[0]], null, null)).toEqual([1]);
    expect(statementNote(txs[1], 'OCA', 40.184)).toBe('OCA · U$S 12,99 × 40,184');
  });
});
