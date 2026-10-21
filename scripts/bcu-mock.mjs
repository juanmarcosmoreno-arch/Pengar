// El BCU y open.er-api.com simulados para los recorridos con Playwright (page.route): las capturas no dependen de la
// red y se puede probar la caída. Las respuestas tienen la misma forma que las reales
// (src/domain/__tests__/fixtures/bcu-2026-10-08-al-21.xml).
export const BCU_PATTERN = 'https://cotizaciones.bcu.gub.uy/**';
export const ER_API_PATTERN = 'https://open.er-api.com/**';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };

const addDays = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** Cotización inventada de un día hábil: alrededor de 40,1, cambia un poco de un día a otro */
export function fakeRate(iso) {
  const n = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400_000;
  return Math.round((40.1 + 0.12 * Math.sin(n / 3)) * 1000) / 1000;
}

/** Respuesta del BCU con los días hábiles (de lunes a viernes) entre dos fechas; `shift`: sumado a cada cotización */
export function bcuXml(from, to, shift = 0) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (weekday(d) % 6 !== 0) days.push(d);
  const dato = (d) => `<datoscotizaciones.dato xmlns="Cotiza"><Fecha>${d}</Fecha><Moneda>2225</Moneda><Nombre>DLS. USA BILLETE</Nombre>`
    + `<CodigoISO>DLS.</CodigoISO><Emisor>ESTADOS UNIDOS</Emisor><TCC>${(fakeRate(d) + shift).toFixed(6)}</TCC><TCV>${(fakeRate(d) + shift).toFixed(6)}</TCV>`
    + '<ArbAct>1.000000</ArbAct><FormaArbitrar>0</FormaArbitrar></datoscotizaciones.dato>';
  const status = days.length
    ? '<status>1</status><codigoerror>0</codigoerror><mensaje/>'
    : '<status>0</status><codigoerror>100</codigoerror><mensaje>No existe cotización para la fecha indicada</mensaje>';
  return '<?xml version="1.0" encoding="utf-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body>'
    + `<wsbcucotizaciones.ExecuteResponse xmlns="Cotiza"><Salida xmlns="Cotiza"><respuestastatus>${status}</respuestastatus>`
    + `<datoscotizaciones>${days.map(dato).join('')}</datoscotizaciones></Salida></wsbcucotizaciones.ExecuteResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

/**
 * Atiende el BCU y open.er-api.com en un contexto (o una página). `state.bcu` y `state.erApi`: 'ok' o 'caido'
 * (se pueden cambiar en el medio). Cada pedido queda en `state.log` ({ host, from, to }). `state.shift`: se suma a cada
 * cotización del BCU (para que no sea la del estado de cuenta); `state.delay`: ms que tarda en contestar.
 */
export async function mockFx(target, state = {}) {
  state.bcu ??= 'ok';
  state.erApi ??= 'caido';
  state.log ??= [];
  await target.route(BCU_PATTERN, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = req.postData() ?? '';
    const from = body.match(/<cot:FechaDesde>([\d-]+)</)?.[1];
    const to = body.match(/<cot:FechaHasta>([\d-]+)</)?.[1];
    state.log.push({ host: 'bcu', from, to, soapAction: req.headers()['soapaction'] });
    if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
    if (state.bcu !== 'ok' || !from || !to) return route.abort('internetdisconnected');
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'text/xml;charset=utf-8' }, body: bcuXml(from, to, state.shift ?? 0) });
  });
  await target.route(ER_API_PATTERN, async (route) => {
    state.log.push({ host: 'er-api' });
    if (state.erApi !== 'ok') return route.abort('internetdisconnected');
    return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'success', base_code: 'USD', rates: { USD: 1, UYU: 40.0812 } }) });
  });
  return state;
}
