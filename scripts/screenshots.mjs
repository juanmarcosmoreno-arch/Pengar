// Capturas de la app en tamaño iPhone, con la planilla de ejemplo (datos/ejemplo.xlsx) importada.
// Uso: npm run build && npm run shots  → quedan en docs/capturas/
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { mockFx } from './bcu-mock.mjs';
import { buildFake, fakeDist, serve } from './fake-remote.mjs';
import { mockNative } from './native-mock.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const out = join(root, 'docs/capturas');
await mkdir(out, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = existsSync(path) && !path.endsWith('/') ? path : join(dist, 'index.html');
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
  res.end(await readFile(file));
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const only = process.argv[2];

// Un ticket de texto en PDF, como el que baja de una compra online (montos inventados)
async function ticketPdf() {
  const page = await browser.newPage();
  const row = (a, b, bold = false) => `<div style="display:flex;justify-content:space-between${bold ? ';font-weight:bold' : ''}"><span>${a}</span><span>${b}</span></div>`;
  await page.setContent(`<div style="font:15px monospace;width:260px;padding:16px">
    <div style="font-size:22px;text-align:center">DISCO</div><div>Fecha: 18/10/2026</div><br>
    ${row('LECHE CONAPROLE 1L', '90,00')}${row('PAN FLAUTA', '60,00')}${row('DETERGENTE NEVEX', '250,00')}<br>${row('TOTAL', '400,00', true)}
  </div>`);
  const pdf = await page.pdf({ width: '80mm', height: '120mm' });
  await page.close();
  return pdf;
}

// Un estado de cuenta de tarjeta en PDF, con las columnas de OCA (FECHA, DESCRIPCION, IMPORTE $, IMPORTE U$S)
async function statementPdf({ from, closing, rows }) {
  const page = await browser.newPage();
  const tr = ([date, desc, pesos = '', dolares = '']) => `<tr><td>${date}</td><td>${desc}</td><td class="n">${pesos}</td><td class="n">${dolares}</td></tr>`;
  await page.setContent(`<style>body{font:12px Helvetica,Arial,sans-serif;margin:32px}td,th{padding:3px 8px;text-align:left}.n{text-align:right}</style>
    <h2>OCA</h2><div>Estado de cuenta</div><div>Período del ${from} al ${closing}</div><div>Fecha de cierre: ${closing}</div><br>
    <table><tr><th>FECHA</th><th>DESCRIPCION</th><th class="n">IMPORTE $</th><th class="n">IMPORTE U$S</th></tr>${rows.map(tr).join('')}</table>
    <br><div>Cotización del dólar: 40,30</div>`);
  const pdf = await page.pdf({ format: 'A4' });
  await page.close();
  return pdf;
}

async function run(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'es-UY', hasTouch: true });
  // La cotización del BCU, simulada (sin salir a la red)
  await mockFx(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
  const shot = async (name, full = false) => {
    if (only && !name.startsWith(only)) return;
    await page.waitForTimeout(350);
    // Sin animaciones: el suricata queda quieto en su pose (las que terminan, terminadas)
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: full, animations: 'disabled' });
    console.log('✓', name);
  };
  // Las pantallas fijas que scrollean adentro (revisar el estado de cuenta) se sacan enteras agrandando la ventana
  const shotScroller = async (name) => {
    if (only && !name.startsWith(only)) return;
    const h = await page.locator('.fixed.inset-0.overflow-y-auto').evaluate((el) => el.scrollHeight);
    await page.setViewportSize({ width: 390, height: h });
    await shot(name);
    await page.setViewportSize({ width: 390, height: 844 });
  };
  await page.goto(url);
  await shot('01-bienvenida');
  await page.getByRole('button', { name: 'Comenzar' }).click();
  await page.getByPlaceholder('Tu nombre').fill('Ana');
  await shot('02-empezar');
  await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles(join(root, 'datos/ejemplo.xlsx'));
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  // Unos gastos anotados hoy, como se usaría a diario
  for (const [amount, rubro] of [['1240', 'Supermercado'], ['980', 'Comer afuera'], ['2150', 'Combustible']]) {
    await page.getByRole('button', { name: 'Gasto', exact: true }).click();
    await page.getByLabel('Monto').fill(amount);
    await page.getByPlaceholder('Buscar rubro…').fill(rubro);
    await page.getByRole('button', { name: rubro, exact: true }).click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(4200);
  await shot('03-inicio');
  await shot('03-inicio-completo', true);
  await page.getByRole('button', { name: 'Gasto', exact: true }).click();
  await page.getByLabel('Monto').fill('450');
  await shot('04-nuevo-gasto');
  // En dólares: se guarda en pesos con la cotización del BCU del día
  await page.getByRole('group', { name: 'Moneda' }).getByRole('button', { name: 'U$S' }).click();
  await page.getByLabel('Monto').fill('20');
  await page.getByText(/al dólar BCU de hoy/).waitFor();
  await shot('29-gasto-en-dolares');
  await page.getByLabel('Cerrar').last().click();
  await page.getByRole('navigation').getByRole('button', { name: 'Movimientos' }).click();
  await shot('05-movimientos', true);
  await page.getByRole('navigation').getByRole('button', { name: 'Estadísticas' }).click();
  await shot('06-mes', true);
  await page.getByRole('button', { name: 'Tendencias' }).click();
  await shot('07-tendencias', true);
  await page.getByRole('button', { name: 'Rubros', exact: true }).click();
  await shot('08-tendencias-rubros', true);
  await page.getByRole('navigation').getByRole('button', { name: 'Inicio' }).click();
  await page.getByRole('button', { name: 'Factura' }).click();
  await shot('09-factura');
  await page.getByLabel('Volver').click();
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await shot('10-mas');
  await page.getByRole('button', { name: /Presupuesto/ }).click();
  await shot('11-presupuesto', true);
  await page.getByLabel('Volver').click();
  await page.getByRole('button', { name: /Categorías y rubros/ }).click();
  await page.getByRole('button', { name: /^Alimentación/ }).click();
  await shot('12-categorias', true);
  // Gastos fijos: los sugeridos salen de la planilla; se agregan algunos
  await page.getByLabel('Volver').click();
  await page.getByRole('button', { name: /Gastos fijos/ }).click();
  await shot('14-gastos-fijos', true);
  for (const rubro of ['Alquiler', 'UTE', 'Antel', 'Emergencia móvil', 'Netflix', 'Entrada']) {
    await page.getByRole('button', { name: `Agregar ${rubro}`, exact: true }).click();
  }
  await page.waitForTimeout(4200);
  await page.getByRole('button', { name: /^Netflix/ }).click();
  await page.getByLabel('Día del mes').selectOption('20');
  await shot('15-editar-fijo');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('16-gastos-fijos-lista', true);
  // Al mes siguiente, Inicio pide anotarlos (los de octubre ya vinieron en la planilla)
  await page.waitForTimeout(500);
  await page.clock.setFixedTime(new Date('2026-11-12T10:00:00'));
  await page.reload();
  const due = page.getByText('Para anotar este mes');
  await due.evaluate((el) => window.scrollTo(0, el.closest('section').getBoundingClientRect().top + window.scrollY - 24));
  await shot('17-inicio-fijos');
  await page.getByRole('button', { name: 'Anotar UTE' }).click();
  await page.getByLabel('Monto').fill('5730');
  await shot('18-anotar-fijo');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('button', { name: 'Anotar todos' }).click();
  await due.waitFor({ state: 'detached' });
  // Resumen del mes que cerró (octubre): Inicio lo ofrece desde el 1 hasta que se abre
  await page.getByText(/movimientos anotados/).waitFor({ state: 'detached' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('26-inicio-resumen');
  await page.getByRole('button', { name: /Tu resumen de octubre está listo/ }).click();
  await page.getByRole('heading', { name: 'Resumen de octubre' }).waitFor();
  await shotScroller('27-resumen');
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  // Diezmo acumulado: el 10% de lo que entró en noviembre todavía no se dio
  await page.getByRole('navigation').getByRole('button', { name: 'Estadísticas' }).click();
  await page.getByRole('button', { name: 'Ver historial' }).first().click();
  await page.getByRole('dialog').last().getByText('Mes a mes').waitFor();
  await shot('28-diezmo-historial');
  await page.getByRole('dialog').last().getByLabel('Cerrar').last().click();
  await page.getByRole('navigation').getByRole('button', { name: 'Inicio' }).click();
  // Factura en PDF: escanear, revisar y verla guardada dentro de la app
  await page.getByRole('button', { name: 'Factura' }).click();
  await page.locator('input[type=file][accept*="pdf"]').setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: await ticketPdf() });
  await page.getByRole('heading', { name: 'Revisar factura' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(4200); // que se vayan los avisos
  await shot('13-revisar-factura');
  await page.getByRole('button', { name: /^Guardar/ }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Facturas y estados de cuenta/ }).click();
  await page.getByRole('button', { name: /^DISCO/ }).click();
  await page.locator('[aria-label="Páginas de la factura"] canvas').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(4200);
  await shot('19-ver-factura');
  await page.getByLabel('Cerrar').last().click();
  await page.getByLabel('Volver').click();
  // Estado de cuenta de la tarjeta: la primera vez se le dice el rubro de cada comercio nuevo
  await page.getByRole('navigation').getByRole('button', { name: 'Inicio' }).click();
  // Una compra ya anotada a mano (aparece en «Posibles repetidos»)
  await page.getByRole('button', { name: 'Gasto', exact: true }).click();
  await page.getByLabel('Monto').fill('1240');
  await page.getByPlaceholder('Buscar rubro…').fill('Supermercado');
  await page.getByRole('button', { name: 'Supermercado', exact: true }).click();
  await page.getByRole('dialog').last().locator('input[type=date]').fill('2026-11-05');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('button', { name: 'Tarjeta', exact: true }).click();
  await page.waitForTimeout(4200); // que se vaya el aviso del gasto
  await shot('22-tarjeta');
  const october = await statementPdf({
    from: '11/10/2026',
    closing: '10/11/2026',
    rows: [
      ['11/10', 'SALDO ANTERIOR', '15.200,00'],
      ['14/10', 'TIENDA INGLESA SUC 12 MONTEVIDEO', '2.345,60'],
      ['20/10', 'MERCADOPAGO*LA PASIVA', '890,00'],
      ['25/10', 'SU PAGO - GRACIAS', '-15.200,00'],
      ['01/11', 'NETFLIX.COM', '', '15,99'],
      ['02/11', 'ANCAP EST 1234 CARRASCO', '2.100,00'],
      ['03/11', 'MERCADOPAGO*LA PASIVA', '760,00'],
      ['05/11', 'TIENDA INGLESA 7', '1.240,00'],
      ['06/11', 'FARMASHOP 14 CUOTA 02/03', '1.500,00'],
      ['07/11', 'MOVIE CENTER', '980,00'],
      ['08/11', 'PEDIDOSYA*BURGER KING', '715,00'],
      ['08/11', 'REINTEGRO IVA LEY 19210', '-38,40'],
      ['09/11', 'DLO*UBER TRIP', '312,00'],
      ['10/11', 'ZARA 18 DE JULIO', '3.290,00'],
      ['10/11', 'SPOTIFY P2A4B6C8', '', '4,99'],
    ],
  });
  await page.locator('input[type=file][accept*="pdf"]').setInputFiles({ name: 'oca-octubre.pdf', mimeType: 'application/pdf', buffer: october });
  await page.getByRole('heading', { name: 'Revisar compras' }).waitFor({ timeout: 30000 });
  const nuevos = page.locator('section', { has: page.getByRole('heading', { name: 'Nuevos: decime de qué rubro son' }) });
  const newNames = () => nuevos.getByRole('group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const first = await newNames();
  if (JSON.stringify(first) !== JSON.stringify(['La Pasiva', 'Movie Center', 'Uber Trip'])) throw new Error(`Nuevos la primera vez: ${first}`);
  await shot('23-revisar-tarjeta');
  await page.getByRole('button', { name: 'Ver y cambiar' }).click();
  // Las compras en cuotas y lo que no son gastos
  await page.getByRole('region', { name: 'Compras en cuotas' }).getByRole('button', { name: 'Ver las compras en cuotas' }).click();
  await page.getByRole('button', { name: 'Ver lo que no son gastos' }).click();
  await shotScroller('24-revisar-tarjeta-completo');
  for (const [merchant, rubro] of [['La Pasiva', 'Comer afuera'], ['Movie Center', 'Paseos'], ['Uber Trip', 'Paseos']]) {
    await nuevos.getByRole('group', { name: merchant }).getByRole('button', { name: 'Elegir rubro' }).click();
    await page.getByRole('dialog').last().getByPlaceholder('Buscar rubro…').fill(rubro);
    await page.getByRole('dialog').last().getByRole('button', { name: rubro, exact: true }).click();
  }
  await page.getByRole('button', { name: /^Guardar \d+ gastos/ }).click();
  await page.getByText(/gastos guardados/).waitFor();
  // El mes siguiente solo pregunta por los comercios que no conoce
  await page.waitForTimeout(500);
  await page.clock.setFixedTime(new Date('2026-12-12T10:00:00'));
  await page.reload();
  const november = await statementPdf({
    from: '11/11/2026',
    closing: '10/12/2026',
    rows: [
      ['11/11', 'SALDO ANTERIOR', '12.645,20', '20,98'],
      ['13/11', 'TIENDA INGLESA SUC 3', '2.980,50'],
      ['16/11', 'MERCADOPAGO*LA PASIVA', '1.120,00'],
      ['20/11', 'SU PAGO - GRACIAS', '-12.645,20'],
      ['20/11', 'SU PAGO - GRACIAS', '', '-20,98'],
      ['22/11', 'DLO*UBER TRIP', '295,00'],
      ['25/11', 'MOSCA HNOS 4', '890,00'],
      ['01/12', 'NETFLIX.COM', '', '15,99'],
      ['02/12', 'ANCAP EST 1234 CARRASCO', '2.300,00'],
      ['04/12', 'MOVIE CENTER', '1.100,00'],
      ['06/12', 'FARMASHOP 14 CUOTA 03/03', '1.500,00'],
      ['08/12', 'PETSHOP EL PERRO FELIZ', '1.340,00'],
    ],
  });
  await page.getByRole('button', { name: 'Tarjeta', exact: true }).click();
  await page.locator('input[type=file][accept*="pdf"]').setInputFiles({ name: 'oca-noviembre.pdf', mimeType: 'application/pdf', buffer: november });
  await page.getByRole('heading', { name: 'Revisar compras' }).waitFor({ timeout: 30000 });
  const second = await newNames();
  if (JSON.stringify(second) !== JSON.stringify(['Mosca Hnos', 'Petshop el Perro Feliz'])) throw new Error(`Nuevos la segunda vez: ${second}`);
  await shot('25-tarjeta-segunda-vez');
  await page.getByLabel('Volver').click();
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  // Metas: al completar una con «Sumar», el suricata festeja
  await page.getByRole('button', { name: /^Metas/ }).click();
  await page.getByRole('button', { name: 'Nueva meta' }).first().click();
  await page.getByPlaceholder('Vacaciones').fill('Vacaciones');
  const amounts = page.getByRole('dialog').last().locator('input[inputmode=decimal]');
  await amounts.nth(0).fill('30000'); // Necesito
  await amounts.nth(1).fill('24500'); // Ya tengo
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('button', { name: 'Sumar', exact: true }).click();
  await page.getByRole('dialog').last().locator('input').fill('5500');
  await page.getByRole('dialog').last().getByRole('button', { name: /^Sumar a «/ }).click();
  await page.getByRole('button', { name: '¡Bien!' }).waitFor();
  await shot('21-meta-cumplida');
  await page.getByRole('button', { name: '¡Bien!' }).click();
  await page.getByLabel('Volver').click();
  // Borrar todo pide confirmar dentro de la app
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByRole('button', { name: 'Borrar todo' }).click();
  await shot('20-borrar-todo');
  await page.getByRole('dialog').last().getByRole('button', { name: 'Borrar todo' }).click();
  await page.getByRole('button', { name: 'Comenzar' }).waitFor();
  await ctx.close();
}

// Bloqueo con Face ID: con el iPhone simulado (scripts/native-mock.mjs) y los datos de ejemplo
async function runLock() {
  const names = ['30-bloqueo', '31-ajustes-privacidad'];
  if (only && !names.some((n) => n.startsWith(only))) return;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'es-UY', hasTouch: true });
  await mockFx(ctx);
  await mockNative(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  const shot = async (name) => {
    if (only && !name.startsWith(only)) return;
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
    console.log('✓', name);
  };
  const answer = async (code) => {
    await page.waitForFunction(() => window.__lock.pending);
    await page.evaluate((c) => window.__lock.answer(c), code);
  };
  await page.goto(url);
  await page.getByRole('button', { name: 'Mirar con datos de ejemplo' }).click();
  await page.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor({ timeout: 20000 });
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByRole('switch', { name: 'Pedir Face ID al abrir' }).click();
  await answer('ok');
  await page.getByRole('group', { name: 'Al volver a la app' }).getByRole('button', { name: '1 minuto' }).click();
  await page.waitForTimeout(4200); // que se vaya el aviso
  // La sección entera, debajo del encabezado
  await page.getByRole('heading', { name: 'Privacidad' }).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
  await shot('31-ajustes-privacidad');
  // Al abrir de nuevo: bloqueada, con el botón (se canceló el Face ID que pide solo)
  await page.reload();
  await answer('cancel');
  await page.getByRole('button', { name: 'Desbloquear con Face ID' }).waitFor();
  await shot('30-bloqueo');
  await ctx.close();
}

// Tarjetas y cuotas: con los datos de ejemplo (estados de cuenta inventados de tres tarjetas) en un día fijo
async function runCuotas() {
  const names = ['40-tarjetas-y-cuotas', '41-me-da-para-comprar', '42-revisar-cuotas', '43-inicio-mes-que-viene'];
  if (only && !names.some((n) => n.startsWith(only))) return;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'es-UY', hasTouch: true });
  await mockFx(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  const shot = async (name) => {
    if (only && !name.startsWith(only)) return;
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
    console.log('✓', name);
  };
  // Entera, con la ventana del alto de la página (fullPage dejaría la barra de pestañas por la mitad)
  const shotWhole = async (name, height) => {
    if (only && !name.startsWith(only)) return;
    await page.setViewportSize({ width: 390, height: height ?? await page.evaluate(() => document.documentElement.scrollHeight) });
    await shot(name);
    await page.setViewportSize({ width: 390, height: 844 });
  };
  await page.clock.setFixedTime(new Date('2026-10-21T10:00:00'));
  await page.goto(url);
  await page.getByRole('button', { name: 'Mirar con datos de ejemplo' }).click();
  await page.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: /El mes que viene/ }).waitFor();
  await shot('43-inicio-mes-que-viene');
  await page.getByRole('button', { name: /El mes que viene/ }).click();
  await page.getByRole('heading', { name: 'Tarjetas y cuotas' }).waitFor();
  await shotWhole('40-tarjetas-y-cuotas');
  await page.getByLabel('Cuánto sale').fill('18000');
  await page.getByRole('button', { name: '6 cuotas' }).click();
  await page.getByRole('group', { name: 'Con qué tarjeta (opcional)' }).getByRole('button', { name: 'OCA' }).click();
  await page.getByRole('heading', { name: '¿Me da para comprar?' }).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
  await shot('41-me-da-para-comprar');
  // El estado de cuenta de ejemplo: el bloque de las cuotas, abierto
  await page.getByLabel('Volver').click();
  await page.getByRole('button', { name: 'Tarjeta', exact: true }).click();
  await page.getByRole('button', { name: 'Probar con un estado de cuenta de ejemplo' }).click();
  await page.getByRole('heading', { name: 'Revisar compras' }).waitFor();
  const block = page.getByRole('region', { name: 'Compras en cuotas' });
  await block.getByRole('button', { name: 'Ver las compras en cuotas' }).click();
  await page.getByText(/Cotización BCU de cada día/).waitFor();
  await block.evaluate((el) => el.closest('.overflow-y-auto').scrollTo(0, el.offsetTop - 70));
  await shot('42-revisar-cuotas');
  await ctx.close();
}

// Respaldo automático: con el iPhone simulado (sin iCloud: la carpeta de la app en Archivos) y datos propios
async function runBackup() {
  const name = '32-respaldo-automatico';
  if (only && !name.startsWith(only)) return;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'es-UY', hasTouch: true });
  await mockFx(ctx);
  await mockNative(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.clock.setFixedTime(new Date(new Date().setHours(9, 12, 0, 0)));
  await page.goto(url);
  await page.getByRole('button', { name: 'Comenzar' }).click();
  await page.getByPlaceholder('Tu nombre').fill('Ana');
  await page.getByRole('button', { name: 'Empezar de cero' }).click();
  await page.getByRole('navigation').waitFor();
  // Al pasar a segundo plano hace el del día
  await page.evaluate(() => window.__app.emit('pause'));
  await page.waitForFunction(() => window.__backup.writes.length > 0);
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByRole('heading', { name: 'Respaldo automático' }).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
  console.log('✓', name);
  await ctx.close();
}

// Hogar compartido: dos pestañas (Ana y Bruno, cada una otro iPhone simulado) contra el servidor de mentira del
// navegador. Arma la build de prueba en dist-fake (scripts/fake-remote.mjs; nunca va al iPhone)
async function runHousehold() {
  const names = ['33-hogar', '34-hogar-crear', '35-hogar-codigo', '36-hogar-unirse', '37-hogar-reemplazar', '38-hogar-integrantes', '39-anotado-por'];
  if (only && !names.some((n) => n.startsWith(only))) return;
  await buildFake();
  const fake = serve(fakeDist);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'es-UY', hasTouch: true });
  await mockFx(ctx);
  await mockNative(ctx);
  const open = async (phone) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', phone, e.message));
    await page.goto(`${fake.url}?telefono=${phone}`);
    return page;
  };
  const shot = async (page, name, full = false) => {
    if (only && !name.startsWith(only)) return;
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: full, animations: 'disabled' });
    console.log('✓', name);
  };
  const tab = (page, name) => page.getByRole('navigation').getByRole('button', { name }).click();
  const openHousehold = async (page) => {
    await tab(page, 'Más');
    await page.getByRole('button', { name: /Hogar compartido/ }).click();
  };
  const expense = async (page, amount, rubro) => {
    await tab(page, 'Inicio');
    await page.getByRole('button', { name: 'Gasto', exact: true }).click();
    await page.getByLabel('Monto').fill(amount);
    await page.getByPlaceholder('Buscar rubro…').fill(rubro);
    await page.getByRole('button', { name: rubro, exact: true }).click();
    await page.getByRole('button', { name: 'Guardar' }).click();
  };
  // Ana, con su planilla y un gasto de hoy, crea el hogar
  const ana = await open('ana');
  await ana.getByRole('button', { name: 'Comenzar' }).click();
  await ana.getByPlaceholder('Tu nombre').fill('Ana');
  await ana.locator('input[type=file][accept*=".xlsx"]').setInputFiles(join(root, 'datos/ejemplo.xlsx'));
  await ana.getByRole('button', { name: 'Importar', exact: true }).click();
  await ana.getByRole('navigation').waitFor();
  await expense(ana, '1240', 'Supermercado');
  await ana.waitForTimeout(4200); // que se vaya el aviso
  await openHousehold(ana);
  await shot(ana, '33-hogar');
  await ana.getByRole('button', { name: 'Crear un hogar' }).click();
  await ana.getByLabel('Nombre del hogar').fill('Casa');
  await shot(ana, '34-hogar-crear');
  await ana.getByRole('button', { name: 'Crear el hogar' }).click();
  await ana.getByRole('dialog', { name: 'Hogar creado' }).waitFor({ timeout: 20000 });
  const code = (await ana.getByRole('dialog').last().locator('p.font-mono [aria-hidden="true"]').innerText()).replace(/\s/g, '');
  await shot(ana, '35-hogar-codigo');
  await ana.getByRole('dialog').last().getByRole('button', { name: 'Listo' }).click();
  // Bruno ya había empezado: unirse le avisa que sus datos se reemplazan
  const bruno = await open('bruno');
  await bruno.getByRole('button', { name: 'Comenzar' }).click();
  await bruno.getByPlaceholder('Tu nombre').fill('Bruno');
  await bruno.getByRole('button', { name: 'Empezar de cero' }).click();
  await openHousehold(bruno);
  await bruno.getByRole('button', { name: 'Unirme con un código' }).click();
  await bruno.getByLabel('Código del hogar').fill(code);
  await shot(bruno, '36-hogar-unirse');
  await bruno.getByRole('dialog').last().getByRole('button', { name: 'Unirme' }).click();
  await bruno.getByRole('dialog', { name: '¿Reemplazar tus datos?' }).waitFor();
  await shot(bruno, '37-hogar-reemplazar');
  await bruno.getByRole('dialog', { name: '¿Reemplazar tus datos?' }).getByRole('button', { name: 'Unirme' }).click();
  await bruno.getByText(/Listo: estás en «Casa»/).waitFor({ timeout: 20000 });
  await expense(bruno, '980', 'Comer afuera');
  // A Ana le llegan Bruno y su gasto
  await ana.getByText('Bruno').waitFor({ timeout: 10000 });
  await ana.waitForTimeout(4200);
  // Entera, con la ventana del alto de la pantalla (fullPage dejaría la barra de pestañas por la mitad)
  await ana.setViewportSize({ width: 390, height: await ana.evaluate(() => document.documentElement.scrollHeight) });
  await shot(ana, '38-hogar-integrantes');
  await ana.setViewportSize({ width: 390, height: 844 });
  await tab(ana, 'Movimientos');
  await ana.getByText(/Anotado por Bruno/).waitFor({ timeout: 10000 });
  await shot(ana, '39-anotado-por');
  await ctx.close();
  fake.close();
}

// La entrada (?intro), con el reloj quieto: un paso a la mitad, el cuadro 14 recién entrado sobre el 13. Tiene que verse
// uno solo (los cuadros son transparentes fuera del dibujo: con el anterior debajo, se ven dos suricatas)
async function runIntro() {
  if (only && !'44-entrada'.startsWith(only)) return;
  const steps = JSON.parse(await readFile(join(root, 'src/assets/intro/timing.json'), 'utf8'));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'es-UY', hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.clock.install({ time: new Date('2026-10-21T09:00:00') });
  await page.clock.pauseAt(new Date('2026-10-21T09:00:01'));
  await page.goto(`${url}?intro`);
  const frames = page.locator('button[aria-label="Saltar la presentación"] img');
  await frames.first().waitFor({ state: 'attached' });
  const step = steps.findIndex(([frame]) => frame === 14);
  await page.clock.runFor(Math.round(steps.slice(0, step).reduce((s, [, t]) => s + t, 0) * 1000) + 50);
  // El fundido (70 ms) es una animación: corre con el reloj de verdad
  await page.waitForTimeout(300);
  const visible = await frames.evaluateAll((imgs) => imgs.filter((im) => Number(getComputedStyle(im).opacity) > 0.01).length);
  if (visible !== 1) {
    console.error(`✗ 44-entrada: se ven ${visible} cuadros a la vez`);
    process.exitCode = 1;
  }
  await page.screenshot({ path: join(out, '44-entrada.png') });
  console.log('✓', '44-entrada');
  await ctx.close();
}

await run('light');
await runIntro();
await runCuotas();
await runLock();
await runBackup();
await runHousehold();
await browser.close();
server.close();
