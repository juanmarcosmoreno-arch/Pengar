// Recorrido del bloqueo con Face ID con el iPhone simulado (scripts/native-mock.mjs): prenderlo en Ajustes, al abrir,
// al volver según el tiempo afuera, cancelar, el cartel de Face ID que no vuelve a bloquear, «Borrar todo» y la web.
// Uso: npx vite build && node scripts/e2e-lock.mjs  (sale con código 1 si algo no da)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { mockFx } from './bcu-mock.mjs';
import { backToApp, blink, leaveApp, mockNative } from './native-mock.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
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

const T0 = new Date('2026-10-21T09:12:00').getTime();
const problems = [];
const check = (ok, label) => {
  console.log(ok ? '✓' : '✗', label);
  if (!ok) problems.push(label);
};

/** Un contexto nuevo (sin nada guardado) con los datos de ejemplo; `native`: el iPhone simulado */
async function start({ native, width = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, locale: 'es-UY', hasTouch: true });
  await mockFx(ctx);
  if (native) await mockNative(ctx, native);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  await page.clock.setFixedTime(new Date(T0));
  await page.goto(url);
  await page.getByRole('button', { name: 'Mirar con datos de ejemplo' }).click();
  await page.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor({ timeout: 20000 });
  return { ctx, page };
}

const lockState = (page) => page.evaluate(() => ({ calls: window.__lock.calls.length, waiting: !!window.__lock.pending, cover: window.__lock.cover.at(-1) }));
const answer = (page, code) => page.evaluate((c) => window.__lock.answer(c), code);
/** Espera el pedido de Face ID número `n` (contando desde que cargó la página) */
async function asked(page, n, label) {
  await page.waitForFunction((k) => window.__lock.calls.length === k && window.__lock.pending, n, { timeout: 3000 }).catch(() => {});
  const s = await lockState(page);
  check(s.calls === n && s.waiting, `${label} (pedidos: ${s.calls})`);
}
const lockedScreen = (page) => page.getByRole('heading', { name: 'Pengar está bloqueada' });
const at = (page, ms) => page.clock.setFixedTime(new Date(T0 + ms));
const openSettings = async (page) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByRole('heading', { name: 'Ajustes' }).waitFor();
};
const shot = async (page, name) => out && page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });

// --- iPhone con Face ID ---
{
  const { ctx, page } = await start({ native: {} });
  check((await lockState(page)).cover === false, 'al abrir le avisa al iPhone que la tapa está apagada');
  await openSettings(page);
  const toggle = page.getByRole('switch', { name: 'Pedir Face ID al abrir' });
  check(await page.getByRole('heading', { name: 'Privacidad' }).isVisible(), 'Ajustes → Privacidad en el iPhone');
  check(await toggle.getAttribute('aria-checked') === 'false', 'apagado de fábrica');
  check(!(await page.getByRole('group', { name: 'Al volver a la app' }).isVisible()), 'apagado, sin «Al volver»');

  // Prenderlo pide Face ID una vez; si cancela, queda apagado
  await toggle.click();
  await asked(page, 1, 'prenderlo pide Face ID');
  check(await page.evaluate(() => window.__lock.calls[0]) === 'Para pedir Face ID al abrir Pengar', 'con el motivo «Para pedir Face ID al abrir Pengar»');
  await answer(page, 'cancel');
  await page.waitForTimeout(200);
  check(await toggle.getAttribute('aria-checked') === 'false', 'cancelado: sigue apagado');
  await toggle.click();
  await asked(page, 2, 'otra vez');
  await answer(page, 'ok');
  await page.getByRole('status').getByText('Listo: Pengar te pide Face ID al abrir').waitFor();
  check(await toggle.getAttribute('aria-checked') === 'true', 'confirmado: prendido');
  const after = page.getByRole('group', { name: 'Al volver a la app' });
  check(await after.getByRole('button', { name: 'Al instante' }).getAttribute('aria-pressed') === 'true', '«Al volver»: al instante, de fábrica');
  check((await lockState(page)).cover === true, 'le avisa al iPhone que ponga la tapa');
  await page.getByRole('heading', { name: 'Privacidad' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(4200); // que se vaya el aviso
  await shot(page, 'lock-ajustes');

  // El cartel de Face ID (o el centro de control) no bloquea: no salió de la app
  await blink(page);
  await page.waitForTimeout(200);
  check(!(await lockedScreen(page).isVisible()) && (await lockState(page)).calls === 2, 'inactiva un momento sin salir: no bloquea ni pide');

  // Al instante: al salir ya queda bloqueada (al volver no se ve nada) y al volver pide Face ID solo
  await leaveApp(page);
  await lockedScreen(page).waitFor({ timeout: 2000 }).catch(() => {});
  check(await lockedScreen(page).isVisible(), 'al instante: bloqueada ya al salir');
  check(!(await page.getByRole('heading', { name: 'Ajustes' }).isVisible()), 'lo de abajo no se ve');
  check((await lockState(page)).calls === 2, 'en segundo plano no pide Face ID');
  await backToApp(page);
  await asked(page, 3, 'al volver pide Face ID solo');
  await answer(page, 'ok');
  await page.getByRole('heading', { name: 'Ajustes' }).waitFor();
  check(!(await lockedScreen(page).isVisible()), 'desbloqueada: sigue en Ajustes, como estaba');

  // 1 minuto: 30 s afuera no bloquea; 90 s sí
  await after.getByRole('button', { name: '1 minuto' }).click();
  check(await after.getByRole('button', { name: '1 minuto' }).getAttribute('aria-pressed') === 'true', 'elige «1 minuto»');
  await at(page, 10_000);
  await leaveApp(page);
  await page.waitForTimeout(150);
  check(!(await page.getByRole('heading', { name: 'Ajustes' }).isVisible()) && !(await lockedScreen(page).isVisible()), 'afuera queda tapada (sin el cartel de bloqueo)');
  await at(page, 40_000);
  await backToApp(page);
  await page.waitForTimeout(200);
  check(await page.getByRole('heading', { name: 'Ajustes' }).isVisible() && (await lockState(page)).calls === 3, '30 s afuera: no bloquea');
  await at(page, 50_000);
  await leaveApp(page);
  await at(page, 140_000);
  await backToApp(page);
  await asked(page, 4, '90 s afuera: bloquea y pide Face ID');
  check(await lockedScreen(page).isVisible(), 'pantalla de bloqueo');
  // Cancela: queda el botón y no lo vuelve a pedir solo
  await answer(page, 'cancel');
  await page.waitForTimeout(400);
  const button = page.getByRole('button', { name: 'Desbloquear con Face ID' });
  check(await button.isEnabled() && (await lockState(page)).calls === 4, 'cancelado: queda «Desbloquear con Face ID» y no lo vuelve a pedir');
  await shot(page, 'lock-bloqueada');
  await button.click();
  await asked(page, 5, 'el botón pide Face ID');
  await answer(page, 'lockout');
  await page.getByRole('alert').getByText(/Face ID se bloqueó por muchos intentos/).waitFor();
  check(true, 'bloqueado por intentos: lo dice');
  await button.click();
  await asked(page, 6, 'de nuevo');
  await answer(page, 'ok');
  await page.getByRole('heading', { name: 'Ajustes' }).waitFor();
  check(true, 'desbloqueada con el botón');

  // Al abrir: bloqueada, sin armar la app debajo, y pide Face ID una sola vez
  await page.reload();
  await lockedScreen(page).waitFor();
  await asked(page, 1, 'al abrir pide Face ID solo');
  check(await page.evaluate(() => window.__lock.calls[0]) === 'Para abrir Pengar', 'con el motivo «Para abrir Pengar»');
  check(await page.getByRole('navigation').count() === 0 && await page.getByText('Estás viendo datos de ejemplo').count() === 0, 'al abrir no se arma nada de la app');
  await answer(page, 'failed');
  await page.getByRole('alert').getByText('No se pudo comprobar que seas vos. Probá de nuevo.').waitFor();
  check((await lockState(page)).calls === 1, 'falló: lo dice y no insiste');
  // Volver de otra app con la pantalla de bloqueo: lo pide de nuevo
  await leaveApp(page);
  await backToApp(page);
  await asked(page, 2, 'al volver todavía bloqueada, lo pide otra vez');
  await answer(page, 'ok');
  await page.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor();
  check(await page.getByRole('navigation').count() === 1, 'desbloqueada: Inicio');

  // Apagarlo: al abrir ya no pide nada
  await openSettings(page);
  await page.getByRole('switch', { name: 'Pedir Face ID al abrir' }).click();
  check(!(await page.getByRole('group', { name: 'Al volver a la app' }).isVisible()) && (await lockState(page)).cover === false, 'apagado: sin «Al volver» y sin tapa');
  await page.reload();
  await page.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor();
  check(!(await lockedScreen(page).isVisible()) && (await lockState(page)).calls === 0, 'apagado: abre sin pedir');

  // «Borrar todo» también lo apaga (queda como recién instalada)
  await openSettings(page);
  await page.getByRole('switch', { name: 'Pedir Face ID al abrir' }).click();
  await asked(page, 1, 'prenderlo de nuevo');
  await answer(page, 'ok');
  await page.getByRole('button', { name: 'Borrar todo' }).click();
  const msg = await page.getByRole('dialog').last().textContent();
  check(msg.includes('También se apaga el bloqueo.'), `«Borrar todo» avisa que apaga el bloqueo: ${msg}`);
  await page.getByRole('dialog').last().getByRole('button', { name: 'Borrar todo' }).click();
  await page.getByRole('button', { name: 'Comenzar' }).waitFor();
  await page.waitForTimeout(400);
  await page.reload();
  await page.getByRole('button', { name: 'Comenzar' }).waitFor();
  check(!(await lockedScreen(page).isVisible()) && (await lockState(page)).calls === 0, 'después de borrar todo abre sin bloqueo');
  await ctx.close();
}

// --- Touch ID, solo código y sin código ---
{
  const { ctx, page } = await start({ native: { biometry: 'touchID' } });
  await openSettings(page);
  check(await page.getByRole('switch', { name: 'Pedir Touch ID al abrir' }).isVisible(), 'con Touch ID: «Pedir Touch ID al abrir»');
  await ctx.close();
}
{
  const { ctx, page } = await start({ native: { biometry: 'none' }, width: 320 });
  await openSettings(page);
  await page.getByRole('switch', { name: 'Pedir el código al abrir' }).click();
  await asked(page, 1, 'solo código: «Pedir el código al abrir»');
  await answer(page, 'ok');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check(width <= 320, `a 320 px no se sale de la pantalla (${width})`);
  await page.getByRole('heading', { name: 'Privacidad' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(4200);
  await shot(page, 'lock-ajustes-320');
  await page.reload();
  await asked(page, 1, 'al abrir pide el código');
  await answer(page, 'cancel');
  check(await page.getByRole('button', { name: 'Desbloquear con el código' }).isVisible(), '«Desbloquear con el código»');
  await shot(page, 'lock-bloqueada-320');
  await ctx.close();
}
{
  const { ctx, page } = await start({ native: { biometry: 'none', available: false } });
  await openSettings(page);
  check(await page.getByText('el iPhone necesita un código').isVisible() && await page.getByRole('switch', { name: /al abrir/ }).count() === 0, 'sin código en el iPhone: lo explica y no ofrece el interruptor');
  await ctx.close();
}

// --- En la web no hay bloqueo ---
{
  const { ctx, page } = await start();
  await openSettings(page);
  check(await page.getByRole('heading', { name: 'Privacidad' }).count() === 0, 'en la web, Ajustes no tiene Privacidad');
  await ctx.close();
}

await browser.close();
server.close();
console.log(problems.length ? `\n✗ ${problems.length} problemas:\n- ${problems.join('\n- ')}` : '\n✓ todo bien');
process.exit(problems.length ? 1 : 0);
