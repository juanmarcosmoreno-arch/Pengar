// Recorrido del respaldo automático con el iPhone simulado (scripts/native-mock.mjs, PengarBackup en memoria): al
// salir de la app, uno por día y solo con cambios, «Hacer un respaldo ahora», los que se borran, un error, apagarlo,
// restaurar uno (con la clave de Claude y los ajustes del teléfono como estaban), iCloud Drive, «Borrar todo», los
// datos de ejemplo y la web. Uso: npx vite build && node scripts/e2e-backup.mjs  (sale con código 1 si algo no da)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { mockFx } from './bcu-mock.mjs';
import { leaveApp, mockNative } from './native-mock.mjs';

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
const DAY = 24 * 60 * 60 * 1000;
const problems = [];
const check = (ok, label) => {
  console.log(ok ? '✓' : '✗', label);
  if (!ok) problems.push(label);
};
const shot = async (page, name) => out && page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });

/** Un contexto nuevo (sin nada guardado). `example`: con los datos de ejemplo; si no, «Empezar de cero» */
async function start({ native, example = false, width = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, locale: 'es-UY', hasTouch: true });
  await mockFx(ctx);
  if (native) await mockNative(ctx, native);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  await page.clock.setFixedTime(new Date(T0));
  await page.goto(url);
  if (example) {
    await page.getByRole('button', { name: 'Mirar con datos de ejemplo' }).click();
    await page.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor({ timeout: 20000 });
  } else {
    await page.getByRole('button', { name: 'Comenzar' }).click();
    // Que pase el respaldo de al abrir (3 s) con la bienvenida: sin datos no hace nada
    await page.waitForTimeout(3500);
    await page.getByPlaceholder('Tu nombre').fill('Juan');
    await page.getByRole('button', { name: 'Empezar de cero' }).click();
    await page.getByRole('navigation').waitFor();
  }
  return { ctx, page };
}

const writes = (page) => page.evaluate(() => [...window.__backup.writes]);
const files = (page) => page.evaluate(() => [...window.__backup.files.keys()].sort());
const at = (page, ms) => page.clock.setFixedTime(new Date(T0 + ms));
/** Sale de la app y espera a que termine lo que haga al salir */
const leave = async (page) => {
  await leaveApp(page);
  await page.waitForTimeout(400);
};
const openSettings = async (page) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Más' }).click();
  await page.getByRole('button', { name: /Ajustes/ }).click();
  await page.getByRole('heading', { name: 'Ajustes' }).waitFor();
};
const section = (page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Respaldo automático' }) });
const addExpense = async (page, amount) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Inicio' }).click();
  await page.getByRole('button', { name: 'Gasto', exact: true }).click();
  await page.getByLabel('Monto').fill(String(amount));
  await page.getByPlaceholder('Buscar rubro…').fill('Supermercado');
  await page.getByRole('button', { name: 'Supermercado', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.waitForTimeout(400);
};
/** Lo guardado en IndexedDB (idb-keyval: base «pengar», tabla «kv») */
const idb = (page, key) => page.evaluate((k) => new Promise((resolve, reject) => {
  const req = indexedDB.open('pengar');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const get = req.result.transaction('kv').objectStore('kv').get(k);
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => reject(get.error);
  };
}), key);
const toast = (page, text) => page.getByRole('status').getByText(text).waitFor({ timeout: 4000 }).then(() => true, () => false);

// --- iPhone sin iCloud: la carpeta de la app en Archivos ---
{
  const { ctx, page } = await start({ native: {} });
  check((await writes(page)).length === 0, 'al abrir con la bienvenida no respalda nada');
  await leave(page);
  check(JSON.stringify(await writes(page)) === '["pengar-2026-10-21.json"]', 'al salir con datos propios: el primero, «pengar-2026-10-21.json»');
  const first = JSON.parse(await page.evaluate(() => window.__backup.files.get('pengar-2026-10-21.json').data));
  check(first.pengar === 1 && first.data.settings.name === 'Juan' && first.data.settings.ai.apiKey === '' && typeof first.files === 'object', 'es el respaldo de siempre (sin la clave de Claude, con las facturas)');

  await openSettings(page);
  const box = section(page);
  check(await box.isVisible(), 'Ajustes → «Respaldo automático» en el iPhone');
  const toggle = page.getByRole('switch', { name: 'Hacer un respaldo por día' });
  check(await toggle.getAttribute('aria-checked') === 'true', 'prendido de fábrica');
  const text = await box.textContent();
  check(text.includes('Último: hoy 9:12 · en Archivos › En mi iPhone › Pengar › Respaldos (para guardarlos en iCloud Drive, ver Ayuda: si borrás la app, los de «En mi iPhone» se borran con ella)'), `dice cuándo y dónde: ${text.slice(0, 160)}`);
  await page.getByRole('heading', { name: 'Respaldo automático' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'backup-ajustes');

  // El mismo día, aunque haya cambios: no otro
  await addExpense(page, 1240);
  await leave(page);
  check((await writes(page)).length === 1, 'el mismo día: no hace otro');
  // Al día siguiente, con lo que cambió ayer: sí
  await at(page, DAY);
  await leave(page);
  check((await writes(page)).at(-1) === 'pengar-2026-10-22.json' && (await writes(page)).length === 2, 'al día siguiente, con cambios: «pengar-2026-10-22.json»');
  // Al otro, sin cambios: no
  await at(page, 2 * DAY);
  await leave(page);
  check((await writes(page)).length === 2, 'otro día sin cambios: no');
  // Al abrir (3 s después) también respalda: un cambio, otro día y recargar
  await addExpense(page, 300);
  await at(page, 3 * DAY);
  await page.reload();
  await page.getByRole('navigation').waitFor();
  await page.waitForTimeout(3600);
  check((await writes(page)).at(-1) === 'pengar-2026-10-24.json', 'al abrir la app, otro día y con cambios: respalda');

  // «Hacer un respaldo ahora», con muchos viejos: después quedan los 14 más nuevos y uno por mes
  await page.evaluate(() => {
    // Del 21/9 al 20/10
    const day = (i) => new Date(Date.UTC(2026, 8, 21 + i)).toISOString().slice(0, 10);
    for (let i = 0; i < 30; i++) window.__backup.files.set(`pengar-${day(i)}.json`, { data: '{}', modified: 0 });
    window.__backup.files.set('mio.json', { data: '{}', modified: 0 });
  });
  await openSettings(page);
  await page.getByRole('button', { name: 'Hacer un respaldo ahora' }).click();
  check(await toast(page, 'Respaldo guardado en el iPhone'), '«Hacer un respaldo ahora» avisa');
  const left = await files(page);
  check(left.length === 16 && left.includes('mio.json') && left.includes('pengar-2026-09-30.json') && left.includes('pengar-2026-10-10.json') && !left.includes('pengar-2026-10-09.json'),
    `quedan los 14 más nuevos, el último de setiembre y lo que no es automático (${left.length}: ${left.slice(0, 3).join(', ')}…)`);

  // Un error: lo dice, en el aviso y en Ajustes; solo no vuelve a probar hasta pasada una hora
  await page.evaluate(() => { window.__backup.fail = 'write'; });
  await page.getByRole('button', { name: 'Hacer un respaldo ahora' }).click();
  check(await toast(page, 'No se pudo guardar el respaldo: no hay lugar'), 'si falla, lo avisa');
  check((await section(page).textContent()).includes('No se pudo guardar el respaldo: no hay lugar (hoy 9:12). Se vuelve a probar solo.'), 'y queda en Ajustes');
  await page.evaluate(() => { window.__backup.fail = null; });
  await addExpense(page, 99);
  await at(page, 4 * DAY);
  const before = (await writes(page)).length;
  await leave(page);
  check((await writes(page)).length === before + 1, 'otro día: vuelve a probar y sale');
  await openSettings(page);
  check(!(await section(page).textContent()).includes('No se pudo'), 'salió bien: el error ya no se muestra');

  // Apagado: no respalda (y queda apagado al abrir de nuevo)
  await page.getByRole('switch', { name: 'Hacer un respaldo por día' }).click();
  await addExpense(page, 50);
  await at(page, 5 * DAY);
  const n = (await writes(page)).length;
  await leave(page);
  await page.reload();
  await page.getByRole('navigation').waitFor();
  await page.waitForTimeout(3600);
  check((await writes(page)).length === n, 'apagado: no respalda ni al salir ni al abrir');
  check((await idb(page, 'device')).autoBackup.enabled === false, 'apagado queda guardado en el teléfono');

  // Restaurar uno: la clave de Claude y los ajustes del teléfono quedan
  await openSettings(page);
  await page.getByLabel('Clave de la API (console.anthropic.com)').fill('sk-ant-prueba');
  await page.waitForTimeout(400);
  const movementsBefore = (await idb(page, 'data')).movements.length;
  await page.getByRole('button', { name: 'Restaurar uno automático…' }).click();
  const list = page.getByRole('dialog', { name: 'Respaldos automáticos' });
  await list.getByRole('button').filter({ hasText: 'Miércoles 21 de octubre' }).waitFor();
  const rows = await list.getByRole('listitem').allTextContents();
  check(rows.length === 16 && rows[0].startsWith('Ayer') && rows[1].startsWith('Sábado 24 de octubre'), `la lista, del más nuevo al más viejo (${rows.length}: ${rows.slice(0, 2).join(' | ')})`);
  await shot(page, 'backup-lista');
  await list.getByRole('button').filter({ hasText: 'Miércoles 21 de octubre' }).click();
  const confirm = page.getByRole('dialog', { name: '¿Restaurar este respaldo?' });
  await confirm.waitFor();
  const msg = await confirm.textContent();
  check(msg.includes('por los del respaldo del miércoles 21 de octubre (0 movimientos, 0 facturas)') && msg.includes('La clave de Claude y los ajustes de este teléfono quedan como están.'), `pregunta antes: ${msg}`);
  await shot(page, 'backup-confirmar');
  await confirm.getByRole('button', { name: 'Restaurar' }).click();
  check(await toast(page, 'Respaldo restaurado'), 'restaurado');
  await page.waitForTimeout(500);
  const data = await idb(page, 'data');
  check(movementsBefore === 4 && data.movements.length === 0, `los datos son los del respaldo (${movementsBefore} → ${data.movements.length} movimientos)`);
  check(data.settings.ai.apiKey === 'sk-ant-prueba', 'la clave de Claude queda');
  check(await page.getByRole('switch', { name: 'Hacer un respaldo por día' }).getAttribute('aria-checked') === 'false', 'el ajuste del teléfono queda (apagado)');
  check(await page.getByRole('dialog').last().count() === 0, 'se cierran la lista y la confirmación');

  // «Borrar todo»: los respaldos quedan, y empezar de nuevo el mismo día no pisa el de hoy
  await page.getByRole('switch', { name: 'Hacer un respaldo por día' }).click();
  await page.getByRole('button', { name: 'Hacer un respaldo ahora' }).click();
  check(await toast(page, 'Respaldo guardado en el iPhone'), 'uno de hoy, con lo restaurado');
  const kept = await files(page);
  await page.getByRole('button', { name: 'Borrar todo' }).click();
  const wipe = await page.getByRole('dialog').last().textContent();
  check(wipe.includes('Antes se guarda un respaldo automático con lo de ahora (los respaldos automáticos no se borran).'), `«Borrar todo» avisa que guarda uno antes y que los respaldos quedan: ${wipe}`);
  await page.getByRole('dialog').last().getByRole('button', { name: 'Borrar todo' }).click();
  await page.getByRole('button', { name: 'Comenzar' }).waitFor();
  await page.getByRole('button', { name: 'Comenzar' }).click();
  await page.getByPlaceholder('Tu nombre').fill('Otra');
  await page.getByRole('button', { name: 'Empezar de cero' }).click();
  await page.getByRole('navigation').waitFor();
  const w = (await writes(page)).length;
  await leave(page);
  check((await writes(page)).length === w && JSON.stringify(await files(page)) === JSON.stringify(kept), 'después de «Borrar todo», el mismo día no pisa el de hoy');
  check((await idb(page, 'device')).autoBackup.enabled === true, 'el respaldo automático sigue prendido');
  await ctx.close();
}

// --- iPhone con iCloud Drive ---
{
  const { ctx, page } = await start({ native: { iCloud: true } });
  await leave(page);
  await openSettings(page);
  const text = await section(page).textContent();
  check(text.includes('Último: hoy 9:12 · en iCloud Drive › Pengar › Respaldos') && !text.includes('activá iCloud Drive'), `con iCloud: «en iCloud Drive › Pengar › Respaldos» (${text.slice(0, 120)})`);
  await page.getByRole('button', { name: 'Hacer un respaldo ahora' }).click();
  check(await toast(page, 'Respaldo guardado en iCloud Drive'), '«Respaldo guardado en iCloud Drive»');
  await ctx.close();
}

// --- 320 px ---
{
  const { ctx, page } = await start({ native: {}, width: 320 });
  await leave(page);
  await openSettings(page);
  await page.getByRole('heading', { name: 'Respaldo automático' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check(width <= 320, `a 320 px no se sale de la pantalla (${width})`);
  await shot(page, 'backup-ajustes-320');
  await page.getByRole('button', { name: 'Restaurar uno automático…' }).click();
  await page.getByRole('dialog', { name: 'Respaldos automáticos' }).getByRole('listitem').first().waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth) <= 320, 'la lista tampoco');
  await shot(page, 'backup-lista-320');
  await ctx.close();
}

// --- Los datos de ejemplo no se respaldan ---
{
  const { ctx, page } = await start({ native: {}, example: true });
  await page.waitForTimeout(3500);
  await leave(page);
  check((await writes(page)).length === 0, 'con los datos de ejemplo: nada, ni al abrir ni al salir');
  await openSettings(page);
  const text = await section(page).textContent();
  check(text.includes('Con los datos de ejemplo no se hacen respaldos') && await page.getByRole('button', { name: 'Hacer un respaldo ahora' }).count() === 0, 'Ajustes lo dice y no ofrece «ahora»');
  check(await page.getByRole('button', { name: 'Restaurar uno automático…' }).isVisible(), 'restaurar uno sí (para salir del ejemplo)');
  await ctx.close();
}

// --- En la web no hay ---
{
  const { ctx, page } = await start({ example: true });
  await openSettings(page);
  check(await page.getByRole('heading', { name: 'Respaldo automático' }).count() === 0, 'en la web, Ajustes no tiene «Respaldo automático»');
  check(await page.getByRole('button', { name: /Respaldo completo/ }).isVisible(), 'el respaldo manual sigue igual');
  await ctx.close();
}

await browser.close();
server.close();
console.log(problems.length ? `\n✗ ${problems.length} problemas:\n- ${problems.join('\n- ')}` : '\n✓ todo bien');
process.exit(problems.length ? 1 : 0);
