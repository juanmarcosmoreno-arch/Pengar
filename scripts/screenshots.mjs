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

async function run(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'es-UY', hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
  const shot = async (name, full = false) => {
    if (only && !name.startsWith(only)) return;
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
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
  await ctx.close();
}

await run('light');
await browser.close();
server.close();
