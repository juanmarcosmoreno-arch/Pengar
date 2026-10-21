// Recorrido de la cotización del dólar con el BCU simulado (page.route): que responde, que se cae y la web sin BCU.
// Uso: npx vite build && node scripts/e2e-dolar.mjs  (sale con código 1 si algo no da)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fakeRate, mockFx } from './bcu-mock.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = existsSync(path) && !path.endsWith('/') ? path : join(dist, 'index.html');
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
  res.end(await readFile(file));
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

const TODAY = '2026-10-21';
const fmt = (n, min = 2, max = 3) => n.toLocaleString('es-UY', { minimumFractionDigits: min, maximumFractionDigits: max });
const problems = [];
const check = (ok, label) => {
  console.log(ok ? '✓' : '✗', label);
  if (!ok) problems.push(label);
};

/** Un contexto nuevo (sin nada guardado), con los datos de ejemplo y la red simulada */
async function start(fx, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'es-UY', hasTouch: true });
  const state = await mockFx(ctx, fx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  await page.clock.setFixedTime(new Date(`${TODAY}T09:12:00`));
  await page.goto(url);
  await page.getByRole('button', { name: 'Mirar con datos de ejemplo' }).click();
  await page.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor({ timeout: 20000 });
  return { ctx, page, state };
}

async function newUsdExpense(page, amount) {
  await page.getByRole('button', { name: 'Gasto', exact: true }).click();
  await page.getByRole('group', { name: 'Moneda' }).getByRole('button', { name: 'U$S' }).click();
  await page.getByLabel('Monto').fill(amount);
}

async function pickRubro(page, rubro) {
  await page.getByPlaceholder('Buscar rubro…').fill(rubro);
  await page.getByRole('dialog').last().getByRole('button', { name: rubro, exact: true }).click();
}

// --- El BCU responde ---
{
  const { ctx, page, state } = await start({ bcu: 'ok' });
  const rate = fakeRate(TODAY);
  await newUsdExpense(page, '20');
  const line = page.getByText(/al dólar BCU de hoy/);
  await line.waitFor();
  const pesos = Math.round(20 * rate);
  check((await line.textContent()).includes(`(${fmt(rate)})`) && (await line.textContent()).includes(`$ ${pesos.toLocaleString('es-UY')}`), `«≈ $ ${pesos} al dólar BCU de hoy (${fmt(rate)})»: ${await line.textContent()}`);
  const first = state.log.find((r) => r.host === 'bcu');
  check(first?.to === TODAY && first?.from === '2026-10-07', `pide al BCU del 7/10 al 21/10: ${JSON.stringify(first)}`);
  check(first?.soapAction === '"Cotizaactionaction/AWSBCUCOTIZACIONES.Execute"', 'con el SOAPAction del BCU');
  // Otra fecha: la del día elegido (el domingo 11, la del viernes 9, y dice que es del 9)
  await page.getByRole('dialog').last().locator('input[type=date]').fill('2026-10-11');
  await page.getByText(/al dólar BCU del 9\/10/).waitFor();
  check((await page.getByText(/al dólar BCU del 9\/10/).textContent()).includes(fmt(fakeRate('2026-10-09'))), 'domingo 11: la del viernes 9 (y lo dice)');
  await page.getByRole('dialog').last().locator('input[type=date]').fill(TODAY);
  await page.getByText(/al dólar BCU de hoy/).waitFor();
  await pickRubro(page, 'Netflix');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('status').getByText(`Gasto anotado: $ ${pesos.toLocaleString('es-UY')}`).waitFor();
  check(true, 'se guarda en pesos');
  await page.getByRole('navigation').getByRole('button', { name: 'Movimientos' }).click();
  const note = `U$S 20 × ${fmt(rate)}`;
  check(await page.getByText(note).first().isVisible(), `la nota dice «${note}»`);
  // Al editarlo se abre en dólares, con la cotización que se usó
  await page.getByText(note).first().click();
  check(await page.getByLabel('Monto en dólares').inputValue() === '20', 'al editar, en dólares');
  check(await page.getByLabel('Cotización').inputValue() === fmt(rate), 'con la cotización de la nota');
  await page.getByLabel('Cerrar').last().click();
  // Lo de hoy ya está guardado: no se vuelve a pedir
  const asked = state.log.filter((r) => r.host === 'bcu').length;
  await page.getByRole('navigation').getByRole('button', { name: 'Inicio' }).click();
  await newUsdExpense(page, '5');
  await page.getByText(/al dólar BCU de hoy/).waitFor();
  check(state.log.filter((r) => r.host === 'bcu').length === asked, 'la segunda vez no pide al BCU (caché)');
  await page.getByLabel('Cerrar').last().click();

  // Estado de cuenta: cada compra con la de su día
  await page.getByRole('button', { name: 'Tarjeta', exact: true }).click();
  await page.getByRole('button', { name: 'Probar con un estado de cuenta de ejemplo' }).click();
  await page.getByRole('heading', { name: 'Revisar compras' }).waitFor();
  await page.getByText(/Cotización BCU de cada día \(≈ \d+,\d\)/).waitFor();
  check(true, '«Cotización BCU de cada día (≈ 40,…)»');
  await page.getByRole('button', { name: 'Ver y cambiar' }).click();
  const known = page.locator('section', { has: page.getByRole('heading', { name: 'Ya los conozco' }) });
  const netflix = known.getByRole('group', { name: 'Netflix' });
  const perDay = await netflix.locator('.tabular').textContent();
  await page.getByLabel('Usar una sola cotización').fill('45');
  await page.getByText('Con tu cotización (45,00) para todas').waitFor();
  check((await netflix.locator('.tabular').textContent()) !== perDay, `una sola cotización manda (${perDay} → ${await netflix.locator('.tabular').textContent()})`);
  await page.getByLabel('Usar una sola cotización').fill('4');
  check(await page.getByText('Revisá la cotización (por ejemplo, 40,10)').isVisible(), 'una cotización que no puede ser se avisa');
  await page.getByLabel('Usar una sola cotización').fill('');
  await page.getByText(/Cotización BCU de cada día/).waitFor();
  check(await page.getByRole('button', { name: 'Usar 40,10 (la del estado de cuenta)' }).isVisible(), 'ofrece la del estado de cuenta');
  await page.getByLabel('Volver').click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Salir' }).click({ timeout: 3000 }).catch(() => {});

  // Ajustes: la de hoy y «Actualizar»
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByText(`Dólar BCU hoy: ${fmt(rate)}`).waitFor();
  check(await page.getByText('Actualizado 21/10 09:12').isVisible(), '«actualizado 21/10 09:12»');
  state.bcu = 'caido';
  await page.getByRole('button', { name: 'Actualizar' }).click();
  await page.getByRole('status').getByText('No se pudo actualizar: revisá la conexión').waitFor();
  check(await page.getByText(`Dólar BCU hoy: ${fmt(rate)}`).isVisible(), 'sin conexión, queda la guardada');
  state.bcu = 'ok';
  await page.getByRole('button', { name: 'Actualizar' }).click();
  await page.waitForTimeout(400);
  check(state.log.filter((r) => r.host === 'bcu').at(-1)?.from === TODAY, '«Actualizar» vuelve a pedir la de hoy');
  check(!state.log.some((r) => r.host === 'er-api'), 'con el BCU andando no se usa open.er-api.com');
  await ctx.close();
}

// --- El BCU no responde (sin conexión) ---
{
  const { ctx, page } = await start({ bcu: 'caido', erApi: 'caido' });
  await newUsdExpense(page, '20');
  await page.getByText('No hay cotización del BCU: escribila').waitFor();
  check(await page.getByRole('button', { name: 'Guardar' }).isDisabled(), 'sin cotización no se puede guardar');
  await page.getByLabel('Cotización').fill('40,5');
  await page.getByText('≈ $ 810 a 40,50 el dólar').waitFor();
  check(true, 'escrita a mano: «≈ $ 810 a 40,50 el dólar»');
  await pickRubro(page, 'Netflix');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Movimientos' }).click();
  check(await page.getByText('U$S 20 × 40,50').first().isVisible(), 'la nota con la que se escribió');
  await page.getByRole('navigation').getByRole('button', { name: 'Inicio' }).click();
  await page.getByRole('button', { name: 'Tarjeta', exact: true }).click();
  await page.getByRole('button', { name: 'Probar con un estado de cuenta de ejemplo' }).click();
  await page.getByText('No se pudo traer la cotización del BCU: escribila').waitFor();
  check(await page.getByRole('button', { name: 'Probar de nuevo' }).isVisible(), '«No se pudo traer la cotización del BCU: escribila», con «Probar de nuevo»');
  // Sin comercios pendientes (todos «No es un gasto»), lo único que falta es la cotización
  const nuevos = page.locator('section', { has: page.getByRole('heading', { name: 'Nuevos: decime de qué rubro son' }) });
  while (await nuevos.getByRole('button', { name: 'No es un gasto' }).count()) await nuevos.getByRole('button', { name: 'No es un gasto' }).first().click();
  check(await page.getByText('Falta la cotización del dólar').isVisible(), 'abajo: «Falta la cotización del dólar»');
  check(await page.getByRole('button', { name: /^Guardar/ }).isDisabled(), 'sin cotización no se guarda el estado de cuenta');
  await page.getByRole('button', { name: 'Usar 40,10 (la del estado de cuenta)' }).click();
  check(await page.getByLabel('Usar una sola cotización').inputValue() === '40,10', 'con un toque, la del estado de cuenta');
  check(!(await page.getByText('Falta la cotización del dólar').count()) && await page.getByRole('button', { name: /^Guardar/ }).isEnabled(), 'ya no falta: se puede guardar');
  await page.getByLabel('Volver').click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Salir' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByText('Dólar BCU hoy: sin datos').waitFor();
  check(await page.getByText('No se pudo consultar: revisá la conexión.').isVisible(), 'Ajustes: sin datos');
  await ctx.close();
}

// --- En la web sin BCU (CORS): para hoy, open.er-api.com ---
{
  const { ctx, page, state } = await start({ bcu: 'caido', erApi: 'ok' });
  await newUsdExpense(page, '10');
  await page.getByText('≈ $ 401 al dólar de hoy (40,08)').waitFor();
  check(true, '«≈ $ 401 al dólar de hoy (40,08)» (sin decir BCU)');
  check(state.log.some((r) => r.host === 'er-api'), 'pidió a open.er-api.com');
  await page.getByRole('dialog').last().locator('input[type=date]').fill('2026-10-14');
  await page.getByText('No hay cotización del BCU: escribila').waitFor();
  check(true, 'otro día: a mano');
  await page.getByLabel('Cerrar').last().click();
  await ctx.close();
}

// --- 320 px: el selector entra al lado del monto ---
{
  const { ctx, page } = await start({ bcu: 'ok' }, { width: 320, height: 640 });
  await newUsdExpense(page, '1234,5');
  await page.getByText(/al dólar BCU de hoy/).waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!wide, '320 px sin scroll horizontal');
  const group = await page.getByRole('group', { name: 'Moneda' }).boundingBox();
  check(group && group.x + group.width <= 320, `selector dentro de la pantalla ${JSON.stringify(group)}`);
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'e2e-dolar-320.png') });
  await ctx.close();
}

await browser.close();
server.close();
if (problems.length) {
  console.error(`\n${problems.length} problema(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nTodo bien');
