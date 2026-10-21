// Recorrido de las cuotas de la tarjeta: arma dos estados de cuenta en PDF INVENTADOS que imitan el formato de
// Scotiabank (la cuota pegada al comercio, «C01/03», límite y disponible en el encabezado) y de Itaú (sin
// encabezados de columnas, fechas «DD MM YY», los 4 dígitos de la tarjeta, la cuota en su columna «6/ 6», importes en
// $ y en U$S), los sube por «Tarjeta», elige la tarjeta cuando no se reconoce, guarda y revisa «Tarjetas y cuotas»
// (lo comprometido del mes que viene, la lista, el simulador, una tarjeta desactualizada, el estado vacío), Inicio y
// cambiarle el nombre a la tarjeta de uno guardado (el mismo estado de cuenta otra vez va con ese nombre).
// Uso: npx vite build && node scripts/e2e-cuotas.mjs  (sale con código 1 si algo no da). SHOTS_DIR=carpeta guarda capturas.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { mockFx } from './bcu-mock.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = existsSync(path) && !path.endsWith('/') ? path : join(dist, 'index.html');
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
  res.end(await readFile(file));
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const out = process.env.SHOTS_DIR;

// Hoy: fin de noviembre. La planilla de ejemplo llega hasta octubre (sus totales): el mes que viene es diciembre
const TODAY = '2026-11-30';
const problems = [];
const check = (ok, label) => {
  console.log(ok ? '✓' : '✗', label);
  if (!ok) problems.push(label);
};
/** Sin los espacios que no se cortan ni los dobles */
const flat = (s) => (s ?? '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
const shot = async (page, name) => out && page.screenshot({ path: join(out, `cuotas-${name}.png`), animations: 'disabled' });

// --- Los PDF inventados ----------------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Una celda con su borde izquierdo (`x`) o derecho (`r`), en fracción del ancho de la página */
const L = (text, x) => ({ text, x });
const R = (text, r) => ({ text, r });

/** Un PDF A4 con cada renglón en su lugar (texto de verdad, como los que manda el banco) */
async function pdfOf(rows) {
  const page = await browser.newPage();
  const W = 794;
  const cells = rows.flatMap((row, i) => row.map((c) => {
    const pos = c.r != null ? `right:${Math.round((1 - c.r) * W)}px` : `left:${Math.round(c.x * W)}px`;
    return `<div style="position:absolute;top:${48 + i * 13}px;${pos};white-space:pre">${esc(c.text)}</div>`;
  }));
  await page.setContent(`<style>@page{size:A4;margin:0}body{margin:0;font:7px Arial,Helvetica,sans-serif}</style><div style="position:relative;width:${W}px;height:1100px">${cells.join('')}</div>`);
  const pdf = await page.pdf({ format: 'A4', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await page.close();
  return pdf;
}

/** Como Scotiabank: títulos arriba y valores abajo, la cuota pegada al final del comercio. Cierra el 20/11 */
const scotia = () => pdfOf([
  [L('VENC.', 0.45), L('TARJETA NÚMERO', 0.49)],
  [L('ANA PEREZ', 0.09)],
  [L('NUMERO DE CUENTA', 0.057), L('LIMITE DE CREDITO', 0.16), L('CREDITO DISPONIBLE', 0.254), L('FECHA DE CIERRE', 0.359), L('VENCIMIENTO PAGO PROXIMO VENC. PAGO', 0.441)],
  [L('11112222', 0.077), R('$ 150.000,00', 0.246), R('$ 98.765,43', 0.346), L('20/11/2026', 0.37), L('04/12/2026', 0.456), L('07/01/2027', 0.547)],
  [L('FECHA', 0.064), L('TARJETA', 0.109), L('DETALLE', 0.253), R('IMPORTE EN ORIGEN', 0.485), R('IMPORTE $', 0.543), R('IMPORTE U$S', 0.614)],
  [L('02/11/2026', 0.054), L('PAGO EN SCOTIABANK', 0.154), R('-4.000,00', 0.549)],
  // La última cuota de una compra de setiembre (viene con su fecha) y la segunda de una de octubre, pegada sin espacio
  [L('14/09/2026', 0.054), L('LIBRERIA DEL PUERTO C03/03', 0.154), R('640,00', 0.549)],
  [L('12/10/2026', 0.054), L('VIVERO EL CEIBOC02/06', 0.154), R('1.200,00', 0.549)],
  [L('05/11/2026', 0.054), L('ALMACEN LOS ROBLES', 0.154), R('1.210,50', 0.549)],
  [L('08/11/2026', 0.054), L('HELADERIA LA NUBEC01/02', 0.154), R('455,00', 0.549)],
  [L('15/11/2026', 0.054), L('OPTICA DEL SUR C01/03', 0.154), R('2.400,00', 0.549)],
  [L('** TOTAL Tarjeta : ANA PEREZ', 0.154), R('5.905,50', 0.549)],
  [L('20/11/2026', 0.054), L('SEG.VIDA S/SALDO FINAN.CONTRAT', 0.154), R('31,20', 0.549)],
  [L('Total devolucion IVA Ley 17934 en MN', 0.154), R('96,10', 0.487)],
  [L('ELECTRONICA A TRAVES DE SUCURSAL INTERNET: www.scotiabank.com.uy', 0.051)],
]);

/** Un renglón como los de Itaú: día, «mes año», la tarjeta, el comercio, la cuota y los importes donde van */
const itauRow = (d, my, cardNo, desc, cuota, { origen, pesos, usd } = {}) => [
  L(d, 0.112), L(my, 0.133), L(cardNo, 0.182), L(desc, 0.239),
  ...(cuota ? [R(cuota, 0.521)] : []),
  ...(origen ? [R(origen, 0.698)] : []),
  ...(pesos ? [R(pesos, 0.796)] : []),
  ...(usd ? [R(usd, 0.895)] : []),
];
/** El encabezado de Itaú: sin el nombre del banco, ni títulos (la tarjeta no se reconoce) */
const ITAU_HEAD = [
  [L('1/', 0.886), L('1', 0.907)],
  [L('ANA PEREZ', 0.462)],
  [L('CALLE FALSA 123', 0.462)],
  [L('111111-1', 0.109), L('$', 0.209), R('90.000,00', 0.315), L('$', 0.334), R('41.000,00', 0.44)],
];
const itauTail = (pesos, usd) => [
  [L('SEGURO DE VIDA SOBRE SALDO', 0.239), R('300,00', 0.796), R('2,00', 0.895)],
  [L('SALDO CONTADO', 0.189), R(pesos, 0.796), R(usd, 0.895)],
  [L('*', 0.161), L('Los', 0.175), L('montos a financiar y cuotas son meramente indicativos, pudiendo variar de acuerdo', 0.204)],
];

/** Itaú de octubre (cierra el 28/10): octubre ya está en la planilla, así que solo se guardan las cuotas */
const itauOct = () => pdfOf([
  ...ITAU_HEAD,
  [L('SALDO DEL ESTADO DE CUENTA ANTERIOR', 0.225), R('30.000,00', 0.705), R('50,00', 0.782)],
  [L('30', 0.112), L('09 26', 0.133), L('PAGOS', 0.189), R('-30.000,00', 0.796), R('-50,00', 0.895)],
  itauRow('03', '10 26', '2011', 'SUPERMERCADO EL TREBOL', '', { pesos: '1500,00' }),
  itauRow('10', '03 26', '2011', 'VIAJES ARCOIRIS', '7/12', { usd: '150,00' }),
  itauRow('15', '01 26', '2045', 'MUEBLERIA LOS PINOS', '10/10', { pesos: '2000,00' }),
  itauRow('06', '07 26', '2045', 'ZAPATERIA EL PASO', '4/ 6', { pesos: '900,00' }),
  itauRow('12', '10 26', '2011', 'STREAMFLIX.COM', '', { origen: '15,99', usd: '15,99' }),
  itauRow('14', '10 26', '2011', 'CLOUDBOX', '', { origen: '2,99', usd: '2,99' }),
  itauRow('18', '10 26', '2045', 'OPTICA VISION', '1/ 6', { pesos: '960,00' }),
  itauRow('28', '10 26', '2045', 'KIOSCO LA ESQUINA', '', { pesos: '300,00' }),
  ...itauTail('5.960,00', '170,98'),
]);

/** Itaú de noviembre (cierra el 27/11): las cuotas siguen, una compra nueva en 12 y una en dólares */
const itauNov = () => pdfOf([
  ...ITAU_HEAD,
  [L('SALDO DEL ESTADO DE CUENTA ANTERIOR', 0.225), R('5.960,00', 0.705), R('170,98', 0.782)],
  [L('29', 0.112), L('10 26', 0.133), L('PAGOS', 0.189), R('-5.960,00', 0.796), R('-170,98', 0.895)],
  itauRow('04', '11 26', '2011', 'SUPERMERCADO EL TREBOL', '', { pesos: '1800,00' }),
  itauRow('10', '03 26', '2011', 'VIAJES ARCOIRIS', '8/12', { usd: '150,00' }),
  itauRow('06', '07 26', '2045', 'ZAPATERIA EL PASO', '5/ 6', { pesos: '900,00' }),
  itauRow('18', '10 26', '2045', 'OPTICA VISION', '2/ 6', { pesos: '960,00' }),
  itauRow('09', '11 26', '2045', 'COLCHONERIA DESCANSO', '1/12', { pesos: '1250,00' }),
  itauRow('12', '11 26', '2011', 'STREAMFLIX.COM', '', { origen: '15,99', usd: '15,99' }),
  itauRow('14', '11 26', '2011', 'CLOUDBOX', '', { origen: '2,99', usd: '2,99' }),
  itauRow('20', '11 26', '2045', 'PEQUE?OS GIGANTES', '', { pesos: '640,00' }),
  itauRow('27', '11 26', '2045', 'KIOSCO LA ESQUINA', '', { pesos: '300,00' }),
  ...itauTail('6.150,00', '170,98'),
]);

// Lo que queda comprometido para diciembre (el mes que viene), con el dólar a 40 en el de noviembre de Itaú:
// Scotiabank: heladería 455 + vivero 1.200 + óptica 2.400 = 4.055
// Itaú: viajes 150 × 40 = 6.000 + zapatería 900 + óptica 960 + colchonería 1.250 = 9.110
const DEC = 13165;
const fmt = (n) => `$ ${n.toLocaleString('es-UY')}`;

// --- La app ----------------------------------------------------------------------------------------------

async function start(viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'es-UY', hasTouch: true });
  await mockFx(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  await page.clock.setFixedTime(new Date(`${TODAY}T10:00:00`));
  await page.goto(url);
  return { ctx, page };
}
const nav = (page, tab) => page.getByRole('navigation').getByRole('button', { name: tab }).click();
const readData = (page) => page.evaluate(() => new Promise((res, rej) => {
  const open = indexedDB.open('pengar');
  open.onerror = () => rej(open.error);
  open.onsuccess = () => {
    const req = open.result.transaction('kv', 'readonly').objectStore('kv').get('data');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  };
}));

async function upload(page, name, pdf) {
  await nav(page, 'Inicio');
  await page.getByRole('button', { name: 'Tarjeta', exact: true }).click();
  await page.locator('input[type=file][accept*="pdf"]').setInputFiles({ name, mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('heading', { name: 'Revisar compras' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
}
const cuotasBlock = (page) => page.getByRole('region', { name: 'Compras en cuotas' });
/** Un rubro para cada comercio nuevo (Varios) */
async function pickAll(page) {
  for (let k = 0; k < 40; k++) {
    const btn = page.getByRole('button', { name: 'Elegir rubro', exact: true }).first();
    if (!(await btn.count())) break;
    await btn.click();
    await page.getByRole('dialog').last().getByPlaceholder('Buscar rubro…').fill('Varios');
    await page.getByRole('dialog').last().getByRole('button', { name: 'Varios', exact: true }).click();
  }
}
async function save(page) {
  await page.getByRole('button', { name: /^Guardar/ }).click();
  await page.getByText(/gastos? guardados?|Estado de cuenta guardado/).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
}

const { ctx, page } = await start();
await page.getByRole('button', { name: 'Comenzar' }).click();
await page.getByPlaceholder('Tu nombre').fill('Ana');
await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(join(root, 'datos/ejemplo.xlsx'));
await page.getByRole('button', { name: 'Importar', exact: true }).click();
await page.getByRole('navigation').waitFor();
await page.waitForTimeout(4200); // que se vaya el aviso
check(!(await page.getByRole('button', { name: /El mes que viene/ }).count()), 'Inicio: sin cuotas, no muestra «El mes que viene»');

// Sin estados de cuenta: el estado vacío y cómo empezar
await nav(page, 'Más');
await page.getByRole('button', { name: /Tarjetas y cuotas/ }).click();
await page.getByText('Todavía no subiste estados de cuenta').waitFor();
check(true, '«Tarjetas y cuotas» sin estados de cuenta: el estado vacío');
await shot(page, 'vacio');
await page.getByRole('button', { name: 'Subir un estado de cuenta' }).click();
await page.getByRole('heading', { name: 'Estado de cuenta' }).waitFor();
check(true, '«Subir un estado de cuenta» abre «Tarjeta»');
// La de «Tarjeta» (arriba de todo) y la de «Tarjetas y cuotas»
await page.getByLabel('Volver').last().click();
await page.getByLabel('Volver').click();

// --- Scotiabank: se reconoce, con la cuota pegada ---
await upload(page, 'scotia-noviembre.pdf', await scotia());
check(flat(await page.locator('.text-xl.truncate').first().textContent()) === 'Scotiabank', 'Scotiabank: reconoce la tarjeta');
check(await page.getByRole('button', { name: 'Cambiar la tarjeta' }).isVisible(), 'con «Cambiar la tarjeta» (sin preguntar)');
check(!(await page.getByText(/ya tiene los totales de tu planilla/).count()), 'la cuota vieja va al cierre: no cae en octubre (la planilla)');
const scotiaBlock = flat(await cuotasBlock(page).textContent());
check(scotiaBlock.includes('4 compras'), `«Compras en cuotas»: 4 compras (${scotiaBlock.slice(0, 60)}…)`);
check(scotiaBlock.includes(`Ya queda fijo: el mes que viene ${fmt(4055)}`), `«Ya queda fijo: el mes que viene ${fmt(4055)}»`);
check(scotiaBlock.includes(`Después: enero 2027 ${fmt(3600)}, febrero 2027 ${fmt(1200)} y 1 mes más, hasta marzo 2027. En total faltan ${fmt(10055)}.`), 'después, mes a mes, hasta cuándo y el total');
await cuotasBlock(page).getByRole('button', { name: 'Ver las compras en cuotas' }).click();
const scotiaList = flat(await cuotasBlock(page).locator('ul').textContent());
check(scotiaList.includes('Libreria del Puerto') && scotiaList.includes('cuota 3 de 3 · la última'), 'la lista: «cuota 3 de 3 · la última»');
check(scotiaList.includes('Vivero el Ceibo') && scotiaList.includes('cuota 2 de 6 · quedan 4') && !scotiaList.includes('CeiboC'), 'la cuota pegada («…C02/06») no queda en el comercio');
await shot(page, 'revisar-scotia');
await pickAll(page);
await save(page);

// --- Itaú de octubre: no se reconoce la tarjeta y se escribe ---
await upload(page, 'itau-octubre.pdf', await itauOct());
check(flat(await page.locator('.text-xl.truncate').first().textContent()) === 'Tarjeta sin nombre', 'Itaú: sin el nombre del banco, «Tarjeta sin nombre»');
const ask = page.getByRole('group', { name: '¿De qué tarjeta es?' });
check(await ask.isVisible(), 'pregunta «¿De qué tarjeta es?»');
check(flat(await ask.textContent()).includes('No la reconocí'), '«No la reconocí en el estado de cuenta»');
check((await ask.getByRole('button').allTextContents()).map(flat).join('|') === 'Scotiabank', 'ofrece las tarjetas ya usadas');
await ask.getByLabel('Nombre de la tarjeta').fill('Itaú');
check(flat(await page.locator('.text-xl.truncate').first().textContent()) === 'Itaú', 'con el nombre escrito');
check(await page.getByText(/Octubre ya tiene los totales de tu planilla/).isVisible(), 'octubre está en la planilla: avisa');
await page.getByText(/Cotización BCU de cada día/).waitFor();
check(flat(await cuotasBlock(page).textContent()).includes('4 compras'), 'las cuotas igual se leen (4 compras)');
await save(page);

// --- Itaú de noviembre: se elige entre las ya usadas ---
await upload(page, 'itau-noviembre.pdf', await itauNov());
const ask2 = page.getByRole('group', { name: '¿De qué tarjeta es?' });
check((await ask2.getByRole('button').allTextContents()).map(flat).join('|') === 'Scotiabank|Itaú', 'ofrece Scotiabank e Itaú (la del último cierre primero)');
await ask2.getByRole('button', { name: 'Itaú' }).click();
check(await ask2.getByRole('button', { name: 'Itaú' }).getAttribute('aria-pressed') === 'true', 'Itaú elegida');
await page.getByLabel('Usar una sola cotización').fill('40');
await page.getByText('Con tu cotización (40,00) para todas').waitFor();
const itauBlock = flat(await cuotasBlock(page).textContent());
check(itauBlock.includes(`Ya queda fijo: el mes que viene ${fmt(9110)}`), `Itaú: «Ya queda fijo: el mes que viene ${fmt(9110)}» (con la cuota en dólares)`);
await cuotasBlock(page).getByRole('button', { name: 'Ver las compras en cuotas' }).click();
const itauList = flat(await cuotasBlock(page).locator('ul').textContent());
check(itauList.includes('Viajes Arcoiris') && itauList.includes('cuota 8 de 12 · quedan 4 · U$S 150,00') && itauList.includes(fmt(6000)), 'la de dólares, en pesos y con su cuenta');
await shot(page, 'revisar-itau');
await pickAll(page);
await save(page);

// Lo guardado
const d = await readData(page);
const estados = d.invoices.filter((i) => i.kind === 'estado');
check(JSON.stringify(estados.map((i) => [i.card, i.date])) === JSON.stringify([['Scotiabank', '2026-11-20'], ['Itaú', '2026-10-28'], ['Itaú', '2026-11-27']]), `tres estados de cuenta, con la tarjeta y el cierre (${JSON.stringify(estados.map((i) => [i.card, i.date]))})`);
check(estados[0].limit === 150000 && estados[0].available === 98765.43, 'Scotiabank: límite y disponible');
check(estados.map((i) => i.installments.length).join() === '4,4,4', 'cada uno con sus cuotas');
const notes = d.movements.filter((m) => m.origin === 'tarjeta').map((m) => flat(m.note));
check(notes.includes('Scotiabank · cuota 1/2'), 'la tarjeta en la nota («Scotiabank · cuota 1/2»)');
check(notes.includes('Itaú · cuota 2/6 · compra del 18/10/2026'), 'la elegida, también («Itaú · cuota 2/6 · compra del 18/10/2026»)');
check(notes.includes('Itaú · cuota 8/12 · compra del 10/3/2026 · U$S 150,00 × 40,00'), 'y la cuenta en dólares al final');
check(!d.movements.some((m) => m.origin === 'tarjeta' && m.date.startsWith('2026-10')), 'nada de octubre (estaba en la planilla)');

// --- Inicio: «El mes que viene» ---
await nav(page, 'Inicio');
const homeCard = page.getByRole('button', { name: /El mes que viene/ });
const homeText = flat(await homeCard.textContent());
check(homeText.includes(`Cuotas ${fmt(DEC)}`), `Inicio: «El mes que viene» con las cuotas (${homeText})`);
const homeMargin = homeText.match(/margen ≈ (-?\s?\$ [\d.]+)/)?.[1];
check(!!homeMargin, `y el margen estimado (${homeMargin})`);
await shot(page, 'inicio');
await homeCard.click();
await page.getByRole('heading', { name: 'Tarjetas y cuotas' }).waitFor();
check(true, 'tocarla abre «Tarjetas y cuotas»');

// --- Tarjetas y cuotas ---
const line = async (label) => flat(await page.locator('dl > div', { has: page.getByText(label, { exact: true }) }).first().locator('dd').textContent());
check(await line('Cuotas ya comprometidas') === `− ${fmt(DEC)}`, `«Cuotas ya comprometidas»: − ${fmt(DEC)}`);
const sub = flat(await page.locator('dl > div', { has: page.getByText('Cuotas ya comprometidas', { exact: true }) }).first().locator('dt').textContent());
check(sub.includes('De los estados de cuenta de Itaú y Scotiabank'), 'de qué tarjetas');
check(flat(await page.locator('dl > div', { has: page.getByText('Ingresos estimados', { exact: true }) }).first().textContent()).includes('El promedio de los últimos 3 meses con datos'), 'los ingresos: el promedio de los últimos 3 meses (sin fijos)');
check(await line('Margen estimado') === flat(homeMargin), 'el mismo margen que Inicio');
const chart = await page.locator('svg[aria-label^="Cuotas comprometidas por mes"]').getAttribute('aria-label');
check(flat(chart).includes(`diciembre ${fmt(DEC)}`) && flat(chart).includes('enero 2027'), `la gráfica, accesible (${flat(chart).slice(0, 80)}…)`);
check(await page.getByText('Itaú', { exact: true }).first().isVisible() && await page.locator('.mt-2.flex.flex-wrap', { hasText: 'Scotiabank' }).count() > 0, 'con la leyenda de las dos tarjetas');

const itau = page.getByRole('region', { name: 'Itaú', exact: true });
const itauCard = flat(await itau.textContent());
check(itauCard.includes('4 compras en cuotas') && itauCard.includes('Último cierre27 nov 2026'), 'Itaú: el último cierre y 4 compras en cuotas (las del último estado de cuenta)');
check(itauCard.includes(`Cuotas del estado de cuenta de diciembre${fmt(9110)}`), 'las cuotas del próximo estado de cuenta');
check(!itauCard.includes('Muebleria'), 'la que terminó en octubre ya no está');
await itau.getByRole('button', { name: 'Ver las 4' }).click();
const itauPlans = flat(await itau.locator('ul').textContent());
check(itauPlans.includes('Zapateria el Paso') && itauPlans.includes('cuota 5 de 6 · queda 1, en diciembre'), '«cuota 5 de 6 · queda 1, en diciembre»');
check(itauPlans.includes('Colchoneria Descanso') && itauPlans.includes('cuota 1 de 12 · quedan 11 · termina en octubre 2027'), '«cuota 1 de 12 · quedan 11 · termina en octubre 2027»');
const scot = flat(await page.getByRole('region', { name: 'Scotiabank', exact: true }).textContent());
check(scot.includes(`Disponible al cierre${fmt(98765)} de ${fmt(150000)}`), 'Scotiabank: disponible y límite');
check(scot.includes('3 compras en cuotas') && scot.includes(`Falta en cuotas${fmt(10055)}`), 'y lo que falta en cuotas');
check(!(await page.getByText(/Subí el estado de cuenta de/).count()), 'al día: no pide estados de cuenta');
await shot(page, 'pantalla');

// ¿Me da para comprar?
await page.getByLabel('Cuánto sale').fill('12000');
await page.getByRole('button', { name: '6 cuotas' }).click();
await page.getByRole('group', { name: 'Con qué tarjeta (opcional)' }).getByRole('button', { name: 'Itaú' }).click();
const sim = page.getByRole('region', { name: '¿Me da para comprar?' });
const simText = flat(await sim.textContent());
check(simText.includes(`6 cuotas de ${fmt(2000)} por mes, de diciembre a mayo 2027.`), '«6 cuotas de $ 2.000 por mes, de diciembre a mayo 2027»');
const before = Number(flat(homeMargin).replace(/[^\d-]/g, ''));
const expected = before - 2000;
check(simText.includes(expected >= 0 ? `Te da: el mes que viene te quedarían ≈ ${fmt(expected)}` : `No te da: el mes que viene te faltarían ≈ ${fmt(-expected)}`), `el margen con la compra (${fmt(expected)})`);
const dec = flat(await sim.getByRole('row', { name: /^Diciembre/ }).textContent());
check(dec === `Diciembre${fmt(DEC)}${fmt(DEC + 2000)}`, `la tabla: diciembre ${fmt(DEC)} → ${fmt(DEC + 2000)}`);
await sim.getByRole('button', { name: 'Otra' }).click();
await sim.getByLabel('Cantidad de cuotas (de 2 a 72)').fill('80');
check(await sim.getByText('Tienen que ser de 2 a 72 cuotas.').isVisible(), 'otra cantidad que no puede ser se avisa');
await sim.getByLabel('Cantidad de cuotas (de 2 a 72)').fill('1');
check(await sim.getByText('Tienen que ser de 2 a 72 cuotas.').isVisible() && !(await sim.getByText(/Un pago de/).count()), '«Otra» en 1: el aviso, sin el resultado');
await sim.getByLabel('Cantidad de cuotas (de 2 a 72)').fill('24');
check(flat(await sim.textContent()).includes(`24 cuotas de ${fmt(500)} por mes`), 'en 24 cuotas');
await shot(page, 'simulador');
const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check(!wide, '390 px sin scroll horizontal');
await page.setViewportSize({ width: 320, height: 640 });
await page.waitForTimeout(300);
check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), '320 px sin scroll horizontal');
await page.setViewportSize({ width: 390, height: 844 });

// No se guarda nada: al volver, el simulador está vacío
await page.getByLabel('Volver').click();
await nav(page, 'Más');
await page.getByRole('button', { name: /Tarjetas y cuotas/ }).click();
check(await page.getByLabel('Cuánto sale').inputValue() === '', 'el simulador no se guarda');

// --- Un mes y medio después: las dos desactualizadas ---
await page.clock.setFixedTime(new Date('2027-01-15T10:00:00'));
await page.reload();
await nav(page, 'Más');
await page.getByRole('button', { name: /Tarjetas y cuotas/ }).click();
await page.getByRole('heading', { name: 'Tarjetas y cuotas' }).waitFor();
// Diciembre es del año pasado: va con el año
check(await page.getByText('Subí el estado de cuenta de diciembre 2026 de Itaú para tener las cuotas al día.').isVisible(), '«Subí el estado de cuenta de diciembre 2026 de Itaú…»');
check(await page.getByText('Subí el estado de cuenta de diciembre 2026 de Scotiabank para tener las cuotas al día.').isVisible(), '«…de diciembre 2026 de Scotiabank…»');
check(await page.getByText(/Puede haber más cuotas: falta el último estado de cuenta de Itaú y Scotiabank/).isVisible(), 'el mes que viene avisa que puede haber más');
await shot(page, 'desactualizadas');

// --- Otro nombre para la tarjeta de un estado de cuenta guardado, y el mismo la próxima vez ---
await page.getByLabel('Volver').click();
await nav(page, 'Más');
await page.getByRole('button', { name: /Facturas y estados/ }).click();
await page.getByRole('button', { name: /Estado de cuenta · Scotiabank/ }).click();
const viewer = page.getByRole('dialog').last();
await viewer.getByRole('button', { name: 'Cambiar el nombre' }).click();
await viewer.getByLabel('Nombre de la tarjeta').fill('Scotia Visa');
await viewer.getByRole('button', { name: 'Guardar el nombre' }).click();
await page.getByText('Listo: este estado de cuenta es de «Scotia Visa»').waitFor();
check(flat(await viewer.textContent()).includes('Tarjeta: Scotia Visa'), 'Facturas: «Cambiar el nombre» de la tarjeta');
await page.waitForTimeout(600); // que se guarde
const renamed = await readData(page);
check(renamed.movements.some((m) => flat(m.note) === 'Scotia Visa · cuota 1/2'), 'y en la nota de sus gastos');
await viewer.getByLabel('Cerrar').last().click();
await page.getByLabel('Volver').click();
await upload(page, 'scotia-noviembre.pdf', await scotia());
check(flat(await page.locator('.text-xl.truncate').first().textContent()) === 'Scotia Visa', 'el mismo estado de cuenta otra vez: va con el nombre que le pusiste');
check(await page.getByText('Leí «Scotiabank»: va como la última vez, «Scotia Visa».').isVisible(), 'y lo dice');
check(await page.getByRole('heading', { name: 'Posibles repetidos' }).isVisible(), 'y lo encuentra repetido');
await page.getByLabel('Volver').first().click();
await page.getByRole('heading', { name: 'Revisar compras' }).waitFor({ state: 'detached' });

await ctx.close();
await browser.close();
server.close();
if (problems.length) {
  console.error(`\n${problems.length} problema(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nTodo bien');
