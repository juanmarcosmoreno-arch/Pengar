// Recorrido del modo demo con el iPhone simulado (scripts/native-mock.mjs) y el hogar compartido contra el servidor de
// mentira (scripts/fake-remote.mjs): entrar desde Ajustes, los datos inventados (fijos para anotar, el resumen, la
// factura en PDF), lo que se oculta, anotar algo, que el hogar no reciba ni mande nada, que el bloqueo no salte al
// volver ni al reabrir, salir con Face ID (cancelar deja en el demo), los datos de verdad intactos, volver a entrar
// con lo anotado, rehacer el demo, salir sin código en el iPhone y la web (sale con una confirmación).
// Uso: node scripts/e2e-demo.mjs  (arma dist-fake; con --sin-build usa la que hay). Sale con código 1 si algo no da.
// SHOTS_DIR=carpeta guarda capturas de cada paso.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mockFx } from './bcu-mock.mjs';
import { buildFake, fakeDist, serve } from './fake-remote.mjs';
import { backToApp, leaveApp, mockNative } from './native-mock.mjs';

if (!process.argv.includes('--sin-build') || !existsSync(fakeDist)) await buildFake();
const { url, close } = serve(fakeDist);
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const out = process.env.SHOTS_DIR;

const problems = [];
const check = (ok, label) => {
  console.log(ok ? '✓' : '✗', label);
  if (!ok) problems.push(label);
};
const shot = async (page, name) => out && page.screenshot({ path: join(out, `demo-${name}.png`), animations: 'disabled' });

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'es-UY', hasTouch: true });
await mockFx(ctx);
await mockNative(ctx);

async function phone(name, context = ctx) {
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror (${name}) ${e.message}`));
  await page.goto(`${url}?telefono=${name}`);
  return page;
}
const nav = (page, tab) => page.getByRole('navigation').getByRole('button', { name: tab }).click();
const openMore = async (page, item) => {
  await nav(page, 'Más');
  await page.getByRole('button', { name: item }).click();
};
const openSettings = async (page) => {
  await openMore(page, /Ajustes/);
  await page.getByRole('heading', { name: 'Ajustes' }).waitFor();
};
const addExpense = async (page, amount, rubro) => {
  await nav(page, 'Inicio');
  await page.getByRole('button', { name: 'Gasto', exact: true }).click();
  await page.getByLabel('Monto').fill(String(amount));
  await page.getByPlaceholder('Buscar rubro…').fill(rubro);
  await page.getByRole('button', { name: rubro, exact: true }).click();
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.getByRole('dialog').last().waitFor({ state: 'detached' });
};
const row = (page, amount) => page.locator('main button').filter({ hasText: new RegExp(`-\\s*\\$\\s*${amount.toLocaleString('es-UY')}`) });
const hasRow = async (page, amount, timeout = 6000) => {
  await nav(page, 'Movimientos');
  try {
    await row(page, amount).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
};
const serverHas = (page, amount) => page.evaluate((a) => {
  const s = JSON.parse(localStorage.getItem('pengar-fake:servidor') ?? 'null');
  return (s?.records ?? []).flatMap(([, rows]) => rows).some((r) => r.kind === 'movement' && !r.deleted && r.data?.amount === a);
}, amount);
const allCalls = (page) => page.evaluate(() => ({ ...window.__pengarFake.calls }));
const lockCalls = (page) => page.evaluate(() => window.__lock.calls.length);
/** Lo guardado en el IndexedDB de ese teléfono (la base pengar-<teléfono>) */
const stored = (page, key) => page.evaluate(([db, k]) => new Promise((resolve, reject) => {
  const open = indexedDB.open(db);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = open.result.transaction('kv').objectStore('kv').get(k);
    req.onsuccess = () => resolve(req.result instanceof Blob ? `blob:${req.result.size}` : JSON.stringify(req.result ?? null));
    req.onerror = () => reject(req.error);
  };
}), [`pengar-${new URL(page.url()).searchParams.get('telefono')}`, key]);
const storedKeys = (page) => page.evaluate((db) => new Promise((resolve) => {
  const open = indexedDB.open(db);
  open.onsuccess = () => {
    const req = open.result.transaction('kv').objectStore('kv').getAllKeys();
    req.onsuccess = () => resolve(req.result.map(String).sort());
  };
}), `pengar-${new URL(page.url()).searchParams.get('telefono')}`);
const hello = (page, name) => page.getByRole('heading', { level: 1, name }).waitFor({ timeout: 10000 });
const chip = (page) => page.getByRole('button', { name: 'Modo demo: los datos son inventados' });
const waitLock = (page) => page.waitForFunction(() => window.__lock.pending, null, { timeout: 4000 });

// --- Marcos: sus datos de verdad, en un hogar con Bruno, con el bloqueo prendido ---
const marcos = await phone('marcos');
await marcos.getByRole('button', { name: 'Comenzar' }).click();
await marcos.getByPlaceholder('Tu nombre').fill('Marcos');
await marcos.getByRole('button', { name: 'Empezar de cero' }).click();
await marcos.getByRole('navigation').waitFor();
await addExpense(marcos, 1240, 'Supermercado');
await openMore(marcos, /Hogar compartido/);
await marcos.getByRole('button', { name: 'Crear un hogar' }).click();
await marcos.getByLabel('Nombre del hogar').fill('Casa');
await marcos.getByRole('button', { name: 'Crear el hogar' }).click();
await marcos.getByRole('dialog', { name: 'Hogar creado' }).waitFor({ timeout: 10000 });
const code = (await marcos.getByRole('dialog').last().locator('p.font-mono [aria-hidden="true"]').innerText()).replace(/\s/g, '');
await marcos.getByRole('dialog').last().getByRole('button', { name: 'Listo' }).click();
const bruno = await phone('bruno');
await bruno.getByRole('button', { name: 'Tengo un código de hogar' }).click();
const joinSheet = bruno.getByRole('dialog', { name: 'Unirme con un código' });
await joinSheet.getByLabel(/Tu nombre/).fill('Bruno');
await joinSheet.getByLabel('Código del hogar').fill(code);
await joinSheet.getByRole('button', { name: 'Unirme' }).click();
await bruno.getByRole('navigation').waitFor({ timeout: 10000 });
check(await hasRow(bruno, 1240), 'Bruno está en el hogar de Marcos');
await openSettings(marcos);
await marcos.getByRole('switch', { name: 'Pedir Face ID al abrir' }).click();
await waitLock(marcos);
await marcos.evaluate(() => window.__lock.answer('ok'));
await marcos.getByText(/Listo: Pengar te pide Face ID/).waitFor();

// --- Ajustes → Modo demo ---
const section = marcos.getByRole('heading', { name: 'Modo demo' });
check(await section.count() === 1, 'Ajustes tiene la sección «Modo demo»');
check(await marcos.getByText('Muestra datos inventados para enseñar la app. Tus datos quedan guardados y vuelven al salir.').count() === 1, 'con la explicación');
await section.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76));
await shot(marcos, 'ajustes');
await marcos.getByRole('button', { name: 'Pasar al modo demo' }).click();
const enter = marcos.getByRole('dialog', { name: '¿Pasar al modo demo?' });
check(await enter.getByText(/no se sincroniza el hogar «Casa»/).count() === 1, 'la confirmación avisa que el hogar no se sincroniza mientras tanto');
const realBefore = await stored(marcos, 'data');
const callsBefore = await allCalls(marcos);
const lockBefore = await lockCalls(marcos);
await enter.getByRole('button', { name: 'Pasar al modo demo' }).click();
await marcos.getByText('Modo demo: los datos son inventados', { exact: true }).waitFor({ timeout: 10000 });
check(true, 'al entrar: «Modo demo: los datos son inventados»');
check(await lockCalls(marcos) === lockBefore, 'entrar no pide Face ID');
check(await marcos.getByRole('button', { name: 'Salir del modo demo' }).count() === 1, 'en el demo, Ajustes ofrece salir');
for (const hidden of ['Privacidad', 'Respaldo automático', 'Importar', 'Exportar y respaldo']) {
  check(await marcos.getByRole('heading', { name: hidden }).count() === 0, `en el demo no está «${hidden}»`);
}
check(await marcos.getByLabel(/Clave de la API/).count() === 0, 'ni la clave de Claude');
check(await marcos.getByRole('button', { name: 'Borrar todo' }).count() === 0, 'ni «Borrar todo»');
check(await marcos.getByRole('button', { name: 'Rehacer los datos de demo' }).count() === 1, 'en su lugar, «Rehacer los datos de demo»');

// --- Los datos inventados ---
await nav(marcos, 'Inicio');
await hello(marcos, 'Ana');
check(true, 'Inicio: «Hola, Ana»');
check(await chip(marcos).isVisible(), 'el chip «Demo» en Inicio');
check(await marcos.getByText('Para anotar este mes').isVisible(), 'con gastos fijos para anotar');
check(await marcos.getByRole('button', { name: /Tu resumen de .+ está listo/ }).count() === 1, 'y el resumen del mes pasado sin abrir');
await shot(marcos, 'inicio');
await nav(marcos, 'Más');
check(await chip(marcos).isVisible(), 'el chip en Más');
check(await marcos.getByText(/Estás en «Casa»/).count() === 0, 'Más no dice el nombre del hogar');
await marcos.getByRole('button', { name: /Hogar compartido/ }).click();
await marcos.getByText('En el modo demo no se muestra').waitFor();
check(await marcos.locator('p.font-mono').count() === 0 && await marcos.getByText('Bruno').count() === 0, 'el hogar no muestra el código ni los integrantes');
await marcos.getByLabel('Volver').click();
await marcos.getByRole('button', { name: /Facturas y estados de cuenta/ }).click();
await marcos.getByRole('button', { name: /Súper El Trébol/ }).click();
await marcos.locator('[aria-label="Páginas de la factura"] canvas').first().waitFor({ timeout: 15000 });
check(true, 'la factura de ejemplo se ve (el ticket en PDF)');
await shot(marcos, 'factura');
await marcos.getByRole('dialog').last().getByLabel('Cerrar').last().click();
await marcos.getByLabel('Volver').click();

// --- Anotar en el demo: queda en el demo y el hogar no se entera ---
await addExpense(marcos, 777, 'Comer afuera');
check(await hasRow(marcos, 777), 'lo anotado en el demo se ve');
await addExpense(bruno, 555, 'Supermercado');
await marcos.waitForTimeout(4000);
check(!(await serverHas(marcos, 777)), 'lo anotado en el demo no llega al hogar');
check(await serverHas(marcos, 555), 'lo de Bruno sí llega al servidor');
check(!(await hasRow(marcos, 555, 1500)), 'pero no se mete en el demo');
const callsDemo = await allCalls(marcos);
check(JSON.stringify(callsDemo) === JSON.stringify(callsBefore), `en el demo el teléfono no le habla al servidor (${JSON.stringify(callsDemo)})`);
check(await stored(marcos, 'data') === realBefore, 'los datos de verdad no cambiaron');
const keys = await storedKeys(marcos);
check(keys.includes('data-demo') && keys.some((k) => k.startsWith('demo-file:')), 'el demo está en su clave, con su archivo aparte');

// --- El bloqueo no salta al volver ni al reabrir ---
await leaveApp(marcos);
await marcos.waitForTimeout(300);
await backToApp(marcos);
await marcos.waitForTimeout(500);
check(await marcos.getByRole('heading', { name: 'Pengar está bloqueada' }).count() === 0 && await lockCalls(marcos) === lockBefore, 'al volver a la app no bloquea');
await marcos.reload();
await hello(marcos, 'Ana');
// Al recargar, el iPhone simulado empieza a contar de nuevo
check(await lockCalls(marcos) === 0 && await marcos.getByRole('heading', { name: 'Pengar está bloqueada' }).count() === 0, 'al reabrir arranca en el demo sin pedir Face ID');
check(await hasRow(marcos, 777), 'con lo anotado');
await marcos.waitForTimeout(2000);
// Ni se arma la conexión con el servidor (window.__pengarFake aparece al arrancar el motor)
check(await marcos.evaluate(() => !window.__pengarFake || Object.keys(window.__pengarFake.calls).length === 0), 'y sin hablarle al servidor del hogar');

// --- Salir: con Face ID; si se cancela, sigue en el demo ---
await chip(marcos).click();
await marcos.getByRole('dialog', { name: 'Modo demo' }).waitFor();
await shot(marcos, 'salir');
await marcos.getByRole('dialog', { name: 'Modo demo' }).getByRole('button', { name: 'Salir del modo demo' }).click();
await waitLock(marcos);
check(await marcos.evaluate(() => window.__lock.calls.at(-1)) === 'Para salir del modo demo y volver a tus datos', 'salir pide Face ID');
await marcos.evaluate(() => window.__lock.answer('cancel'));
await marcos.waitForTimeout(500);
check(await chip(marcos).count() === 1 && await marcos.getByRole('dialog', { name: 'Modo demo' }).isVisible(), 'cancelado: sigue en el demo (con la hoja abierta)');
await marcos.getByRole('dialog', { name: 'Modo demo' }).getByRole('button', { name: 'Salir del modo demo' }).click();
await waitLock(marcos);
await marcos.evaluate(() => window.__lock.answer('ok'));
await marcos.getByText('Volviste a tus datos').waitFor();
await nav(marcos, 'Inicio');
await hello(marcos, 'Marcos');
check(true, 'con Face ID: vuelven los datos de verdad («Hola, Marcos»)');
check(await chip(marcos).count() === 0, 'sin el chip');
const lockAfter = await lockCalls(marcos);
await marcos.waitForTimeout(500);
check(await marcos.getByRole('heading', { name: 'Pengar está bloqueada' }).count() === 0 && await lockCalls(marcos) === lockAfter, 'no vuelve a pedir Face ID (ya se autenticó)');
check(await hasRow(marcos, 1240), 'lo de verdad está');
check(!(await hasRow(marcos, 777, 1000)), 'lo anotado en el demo no');
check(await hasRow(marcos, 555, 10000), 'el hogar vuelve a andar: llega lo de Bruno');
check(!(await serverHas(marcos, 777)), 'y al hogar nunca llegó nada del demo');
// Con el bloqueo prendido, al volver de otra app sí bloquea de nuevo
await leaveApp(marcos);
await backToApp(marcos);
await marcos.getByRole('heading', { name: 'Pengar está bloqueada' }).waitFor({ timeout: 4000 }).then(() => check(true, 'fuera del demo el bloqueo vuelve a andar'), () => check(false, 'fuera del demo el bloqueo vuelve a andar'));
await waitLock(marcos);
await marcos.evaluate(() => window.__lock.answer('ok'));

// --- Volver a entrar: sigue lo anotado; «Rehacer los datos de demo» lo saca ---
await openSettings(marcos);
await marcos.getByRole('button', { name: 'Pasar al modo demo' }).click();
await marcos.getByRole('dialog', { name: '¿Pasar al modo demo?' }).getByRole('button', { name: 'Pasar al modo demo' }).click();
await marcos.getByText('Modo demo: los datos son inventados', { exact: true }).waitFor({ timeout: 10000 });
check(await hasRow(marcos, 777), 'al volver a entrar sigue lo anotado en el demo');
await openSettings(marcos);
await marcos.getByRole('button', { name: 'Rehacer los datos de demo' }).click();
await marcos.getByRole('dialog', { name: '¿Rehacer los datos de demo?' }).getByRole('button', { name: 'Rehacer' }).click();
await marcos.getByText('Datos de demo nuevos').waitFor({ timeout: 10000 });
check(!(await hasRow(marcos, 777, 1000)), 'rehecho: ya no está lo anotado');
check((await storedKeys(marcos)).filter((k) => k.startsWith('demo-file:')).length === 1, 'y queda un solo archivo del demo');

// --- Un iPhone sin código ni Face ID: salir pide confirmar ---
await marcos.evaluate(() => {
  window.__lock.available = false;
});
const before = await lockCalls(marcos);
await openSettings(marcos);
await marcos.getByRole('button', { name: 'Salir del modo demo' }).click();
const confirm = marcos.getByRole('dialog', { name: '¿Salir del modo demo?' });
await confirm.waitFor();
check(await lockCalls(marcos) === before, 'sin código en el iPhone, no pide Face ID: pide confirmar');
await confirm.getByRole('button', { name: 'Salir del demo' }).click();
await marcos.getByText('Volviste a tus datos').waitFor();
await nav(marcos, 'Inicio');
await hello(marcos, 'Marcos');
check(true, 'y vuelven los datos de verdad');

// --- En la web: la sección está y salir pide confirmar ---
const web = await browser.newContext({ viewport: { width: 320, height: 640 }, deviceScaleFactor: 1, locale: 'es-UY' });
await mockFx(web);
const w = await phone('web', web);
await w.getByRole('button', { name: 'Comenzar' }).click();
await w.getByPlaceholder('Tu nombre').fill('Carla');
await w.getByRole('button', { name: 'Empezar de cero' }).click();
await openSettings(w);
await w.getByRole('button', { name: 'Pasar al modo demo' }).click();
await w.getByRole('dialog', { name: '¿Pasar al modo demo?' }).getByRole('button', { name: 'Pasar al modo demo' }).click();
await w.getByText('Modo demo: los datos son inventados', { exact: true }).waitFor({ timeout: 10000 });
await nav(w, 'Inicio');
await hello(w, 'Ana');
const [chipBox, view] = [await chip(w).boundingBox(), w.viewportSize()];
check(chipBox && chipBox.x + chipBox.width <= view.width, 'a 320 px el chip entra');
check(await w.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'a 320 px no hay scroll de costado');
await shot(w, 'web-320');
await chip(w).click();
await w.getByRole('dialog', { name: 'Modo demo' }).getByRole('button', { name: 'Salir del modo demo' }).click();
await w.getByRole('dialog', { name: '¿Salir del modo demo?' }).getByRole('button', { name: 'Salir del demo' }).click();
await hello(w, 'Carla');
check(true, 'en la web, salir pide confirmar y vuelve a los datos');
// Con el ejemplo de la bienvenida (ya son inventados), Ajustes no ofrece el modo demo
const ex = await phone('ejemplo', web);
await ex.getByRole('button', { name: 'Mirar con datos de ejemplo' }).click();
await ex.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor({ timeout: 20000 });
await openSettings(ex);
check(await ex.getByRole('heading', { name: 'Modo demo' }).count() === 0, 'con los datos de ejemplo, Ajustes no ofrece el modo demo');
await web.close();

await ctx.close();
await browser.close();
close();
console.log(problems.length ? `\n✗ ${problems.length} problemas:\n${problems.join('\n')}` : '\n✓ todo bien');
process.exit(problems.length ? 1 : 0);
