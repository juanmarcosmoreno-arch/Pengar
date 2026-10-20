// Capturas de la app en tamaño iPhone, con la planilla de ejemplo (datos/ejemplo.xlsx) importada.
// Uso: npm run build && npm run shots  → quedan en docs/capturas/
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

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

async function run(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'es-UY', hasTouch: true });
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
  // Factura en PDF: escanear, revisar y verla guardada dentro de la app
  await page.getByRole('button', { name: 'Factura' }).click();
  await page.locator('input[type=file][accept*="pdf"]').setInputFiles({ name: 'ticket.pdf', mimeType: 'application/pdf', buffer: await ticketPdf() });
  await page.getByRole('heading', { name: 'Revisar factura' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(4200); // que se vayan los avisos
  await shot('13-revisar-factura');
  await page.getByRole('button', { name: /^Guardar/ }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Facturas guardadas/ }).click();
  await page.getByRole('button', { name: /^DISCO/ }).click();
  await page.locator('[aria-label="Páginas de la factura"] canvas').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(4200);
  await shot('19-ver-factura');
  await page.getByLabel('Cerrar').last().click();
  await page.getByLabel('Volver').click();
  // Metas: al completar una con «Sumar», el suricata festeja
  await page.getByRole('button', { name: /^Metas/ }).click();
  await page.getByRole('button', { name: 'Nueva meta' }).first().click();
  await page.getByPlaceholder('Vacaciones').fill('Vacaciones');
  const amounts = page.getByRole('dialog').locator('input[inputmode=decimal]');
  await amounts.nth(0).fill('30000'); // Necesito
  await amounts.nth(1).fill('24500'); // Ya tengo
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('button', { name: 'Sumar', exact: true }).click();
  await page.getByRole('dialog').locator('input').fill('5500');
  await page.getByRole('dialog').getByRole('button', { name: 'Sumar', exact: true }).click();
  await page.getByRole('button', { name: '¡Bien!' }).waitFor();
  await shot('21-meta-cumplida');
  await page.getByRole('button', { name: '¡Bien!' }).click();
  await page.getByLabel('Volver').click();
  // Borrar todo pide confirmar dentro de la app
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByRole('button', { name: 'Borrar todo' }).click();
  await shot('20-borrar-todo');
  await page.getByRole('dialog').getByRole('button', { name: 'Borrar todo' }).click();
  await page.getByRole('button', { name: 'Comenzar' }).waitFor();
  await ctx.close();
}

await run('light');
await browser.close();
server.close();
