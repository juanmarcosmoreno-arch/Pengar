import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// La red, el guardado y la plataforma, simulados (cada prueba carga lib/fx de cero)
const mocks = vi.hoisted(() => ({
  http: vi.fn(),
  stored: undefined as unknown,
  platform: { isNative: true, isPreview: false },
}));
vi.mock('@capacitor/core', () => ({ CapacitorHttp: { request: mocks.http } }));
vi.mock('../db', () => ({
  loadFx: async () => mocks.stored,
  saveFx: async (v: unknown) => { mocks.stored = JSON.parse(JSON.stringify(v)); return true; },
}));
vi.mock('../platform', () => mocks.platform);

const OCTOBER = readFileSync('src/domain/__tests__/fixtures/bcu-2026-10-08-al-21.xml', 'utf8');
const fetchMock = vi.fn();

async function fresh() {
  vi.resetModules();
  return import('../fx');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T09:12:00'));
  mocks.stored = undefined;
  mocks.platform.isNative = true;
  mocks.platform.isPreview = false;
  mocks.http.mockReset().mockResolvedValue({ status: 200, data: OCTOBER, headers: {}, url: '' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cotización del dólar (lib)', () => {
  it('en el iPhone le pide al BCU con el HTTP nativo y guarda: la segunda vez no pide nada', async () => {
    const fx = await fresh();
    expect(await fx.usdRateOn('2026-10-14')).toMatchObject({ date: '2026-10-14', rate: 40.236, source: 'bcu' });
    expect(mocks.http).toHaveBeenCalledTimes(1);
    const req = mocks.http.mock.calls[0][0];
    expect(req).toMatchObject({ method: 'POST', url: 'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones', responseType: 'text' });
    expect(req.headers).toEqual({ 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"Cotizaactionaction/AWSBCUCOTIZACIONES.Execute"' });
    // Con los días de antes, por si la fecha cae en fin de semana
    expect(req.data).toContain('<cot:FechaDesde>2026-09-30</cot:FechaDesde><cot:FechaHasta>2026-10-14</cot:FechaHasta>');
    expect(fetchMock).not.toHaveBeenCalled();
    // Un domingo ya consultado: la del viernes, sin pedir de nuevo (ni después de reiniciar la app)
    expect((await fx.usdRateOn('2026-10-11'))?.date).toBe('2026-10-09');
    const again = await fresh();
    expect((await again.usdRates('2026-10-08', '2026-10-14'))?.at(-1)).toEqual({ date: '2026-10-14', rate: 40.236 });
    expect(mocks.http).toHaveBeenCalledTimes(1);
  });

  it('la de hoy: la del último día hábil si todavía no salió, y se vuelve a pedir pasadas 6 horas', async () => {
    const fx = await fresh();
    expect(await fx.usdRateToday()).toMatchObject({ date: '2026-10-20', rate: 40.077, source: 'bcu', at: new Date('2026-10-21T09:12:00').getTime() });
    expect(mocks.http).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-21T14:00:00'));
    await fx.usdRateToday();
    expect(mocks.http).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-21T15:30:00'));
    await fx.usdRateToday();
    expect(mocks.http).toHaveBeenCalledTimes(2);
    // Solo se pide hoy: lo de antes ya se sabe
    expect(mocks.http.mock.calls[1][0].data).toContain('<cot:FechaDesde>2026-10-21</cot:FechaDesde><cot:FechaHasta>2026-10-21</cot:FechaHasta>');
    // «Actualizar» pide aunque esté guardada
    await fx.usdRateToday({ force: true });
    expect(mocks.http).toHaveBeenCalledTimes(3);
  });

  it('sin conexión: lo guardado sirve; si falta un día pasado, null (nunca tira)', async () => {
    const fx = await fresh();
    await fx.usdRateToday();
    mocks.http.mockRejectedValue(new Error('The Internet connection appears to be offline.'));
    vi.setSystemTime(new Date('2026-10-21T18:00:00'));
    // Hoy no se pudo refrescar: vale la del 20, que ya estaba
    expect((await fx.usdRateToday())?.rate).toBe(40.077);
    // Un mes que nunca se consultó
    expect(await fx.usdRateOn('2026-08-14')).toBeNull();
    expect(await fx.usdRates('2026-08-01', '2026-08-31')).toBeNull();
    // El BCU responde un error: tampoco tira
    const other = await fresh();
    mocks.stored = undefined;
    mocks.http.mockResolvedValue({ status: 200, data: '<html>Service Unavailable</html>', headers: {}, url: '' });
    expect(await other.usdRateOn('2026-10-14')).toBeNull();
    mocks.http.mockResolvedValue({ status: 503, data: '', headers: {}, url: '' });
    expect(await (await fresh()).usdRateOn('2026-10-14')).toBeNull();
  });

  it('en la web: si el BCU no deja (CORS), para hoy open.er-api.com; para otro día, null', async () => {
    mocks.platform.isNative = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('bcu.gub.uy')) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ result: 'success', rates: { USD: 1, UYU: 40.1234 } }) };
    });
    const fx = await fresh();
    expect(await fx.usdRateToday()).toMatchObject({ date: '2026-10-21', rate: 40.12, source: 'mercado' });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://cotizaciones.bcu.gub.uy/wscotizaciones/servlet/awsbcucotizaciones',
      'https://open.er-api.com/v6/latest/USD',
    ]);
    expect(await fx.usdRateOn('2026-10-14')).toBeNull();
    // Después de una falla, no insiste por un rato (ni a open.er-api.com, que queda guardada)
    const calls = fetchMock.mock.calls.length;
    expect((await fx.usdRateToday())?.rate).toBe(40.12);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(mocks.http).not.toHaveBeenCalled();
  });

  it('en la web, si el BCU responde, se usa el BCU', async () => {
    mocks.platform.isNative = false;
    fetchMock.mockResolvedValue({ ok: true, text: async () => OCTOBER });
    const fx = await fresh();
    expect(await fx.usdRateOn('2026-10-14')).toMatchObject({ rate: 40.236, source: 'bcu' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { SOAPAction: '"Cotizaactionaction/AWSBCUCOTIZACIONES.Execute"' } });
  });

  it('en la vista previa no pide nada: lo guardado o null', async () => {
    mocks.platform.isNative = false;
    mocks.platform.isPreview = true;
    const fx = await fresh();
    expect(await fx.usdRateToday()).toBeNull();
    expect(await fx.usdRates('2026-10-08', '2026-10-20')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.http).not.toHaveBeenCalled();
    // Con algo guardado de antes, eso
    const { emptyFx, mergeBcu, parseBcuResponse } = await import('../../domain/fx');
    mocks.stored = mergeBcu(emptyFx(), '2026-10-01', '2026-10-21', parseBcuResponse(OCTOBER), new Date('2026-10-21T08:00:00').getTime());
    const cached = await fresh();
    expect((await cached.usdRateOn('2026-10-14'))?.rate).toBe(40.236);
    expect((await cached.cachedUsdRateToday())?.date).toBe('2026-10-20');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
