// Recorrido del hogar compartido: dos pestañas (Ana y Bruno, cada una otro teléfono) contra el servidor de mentira del
// navegador (src/lib/fakeRemote.ts), con el iPhone simulado (scripts/native-mock.mjs) para el bloqueo con Face ID.
// Crear el hogar, copiar el código, unirse desde la bienvenida, lo que anota cada uno le llega al otro con «Anotado por»,
// sin conexión, la pausa con la pantalla de bloqueo, volver a entrar desde otro teléfono, código nuevo, «Borrar todo» y
// los datos de ejemplo (no tocan el hogar) y salir.
// Uso: node scripts/e2e-hogar.mjs  (arma dist-fake; con --sin-build usa la que hay). Sale con código 1 si algo no da.
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
const shot = async (page, name) => out && page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'es-UY', hasTouch: true });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url.replace(/\/$/, '') });
await mockFx(ctx);
await mockNative(ctx);

/** Un teléfono: una pestaña con su ?telefono= */
async function phone(name) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror (${name}) ${e.message}`));
  await page.goto(`${url}?telefono=${name}`);
  return page;
}
const nav = (page, tab) => page.getByRole('navigation').getByRole('button', { name: tab }).click();
const openHousehold = async (page) => {
  await nav(page, 'Más');
  await page.getByRole('button', { name: /Hogar compartido/ }).click();
  await page.getByRole('heading', { name: 'Hogar compartido' }).waitFor();
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
/** El monto en la lista de movimientos (con lo que dice debajo, como «Anotado por Ana · Alimentación») */
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
const serverCount = (page, kind) => page.evaluate((k) => {
  const s = JSON.parse(localStorage.getItem('pengar-fake:servidor') ?? 'null');
  return (s?.records ?? []).flatMap(([, rows]) => rows).filter((r) => r.kind === k && !r.deleted).length;
}, kind);
const calls = (page, what) => page.evaluate((w) => window.__pengarFake.calls[w] ?? 0, what);
const start = async (page, name) => {
  await page.getByRole('button', { name: 'Comenzar' }).click();
  await page.getByPlaceholder('Tu nombre').fill(name);
  await page.getByRole('button', { name: 'Empezar de cero' }).click();
  await page.getByRole('navigation').waitFor();
};
const joinWith = async (page, name, code) => {
  const dialog = page.getByRole('dialog', { name: 'Unirme con un código' });
  await dialog.getByLabel(/Tu nombre/).fill(name);
  await dialog.getByLabel('Código del hogar').fill(code);
  await dialog.getByRole('button', { name: 'Unirme' }).click();
};

// --- Ana crea el hogar con lo suyo ---
const ana = await phone('ana');
await start(ana, 'Ana');
await addExpense(ana, 1240, 'Supermercado');
await openHousehold(ana);
await ana.getByText('Pengar entre varios').waitFor();
await shot(ana, 'hogar-sin-hogar');
await ana.getByRole('button', { name: 'Crear un hogar' }).click();
check((await ana.getByLabel(/Tu nombre/).inputValue()) === 'Ana', 'crear: el nombre viene de Ajustes');
await ana.getByLabel('Nombre del hogar').fill('Casa');
await ana.getByRole('button', { name: 'Crear el hogar' }).click();
await ana.getByRole('dialog', { name: 'Hogar creado' }).waitFor({ timeout: 10000 });
const code = (await ana.getByRole('dialog').last().locator('p.font-mono [aria-hidden="true"]').innerText()).replace(/\s/g, '');
check(/^[A-HJ-NP-Z2-9]{12}$/.test(code), `el código: ${code}`);
await shot(ana, 'hogar-creado');
await ana.getByRole('dialog').last().getByRole('button', { name: 'Copiar' }).click();
await ana.getByText('Código copiado').waitFor();
check((await ana.evaluate(() => navigator.clipboard.readText())) === code, 'Copiar deja el código en el portapapeles');
check((await ana.getByRole('dialog').last().getByRole('button', { name: 'Compartir' }).count()) === 1, 'en el iPhone, también Compartir');
await ana.getByRole('dialog').last().getByRole('button', { name: 'Listo' }).click();
check(await serverCount(ana, 'movement') === 1, 'el gasto de Ana está en el hogar');
await ana.getByText(/Sincronizado (hace un momento|hace 1 min)/).waitFor();
check(true, 'Ana: «Sincronizado hace un momento»');

// --- Bruno entra desde la bienvenida con el código (escrito como sea) ---
const bruno = await phone('bruno');
await bruno.getByRole('button', { name: 'Tengo un código de hogar' }).click();
await joinWith(bruno, 'Bruno', `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
await bruno.getByRole('navigation').waitFor({ timeout: 10000 });
check(true, 'Bruno entra desde la bienvenida sin confirmar (no tenía datos)');
check(await hasRow(bruno, 1240), 'Bruno ve el gasto de Ana');
check(await row(bruno, 1240).getByText(/Anotado por Ana/).count() === 1, 'con «Anotado por Ana»');
await row(bruno, 1240).first().click();
check(await bruno.getByRole('dialog').last().getByText('Anotado por Ana').count() === 1, 'y en el movimiento abierto');
await shot(bruno, 'hogar-anotado-por');
await bruno.getByRole('dialog').last().getByLabel('Cerrar').last().click();
// Ana ve a Bruno entre los integrantes (el aviso llega solo)
await ana.getByText('Bruno').waitFor({ timeout: 6000 });
check(true, 'Ana ve a Bruno en los integrantes');
await shot(ana, 'hogar-integrantes');

// --- Lo que anota Bruno le llega a Ana ---
await addExpense(bruno, 980, 'Comer afuera');
check(await hasRow(ana, 980), 'a Ana le llega el gasto de Bruno');
check(await row(ana, 980).getByText(/Anotado por Bruno/).count() === 1, 'con «Anotado por Bruno»');
check(await row(ana, 1240).getByText(/Anotado por/).count() === 0, 'lo de Ana no dice quién lo anotó');

// --- Sin conexión: queda pendiente y se manda al volver ---
await ctx.setOffline(true);
await addExpense(bruno, 500, 'Farmacia');
await openHousehold(bruno);
await bruno.getByText('Sin conexión: se manda cuando vuelva (1 cambio)').waitFor({ timeout: 6000 });
check(true, 'Bruno: «Sin conexión: se manda cuando vuelva (1 cambio)»');
await shot(bruno, 'hogar-sin-conexion');
check(!(await hasRow(ana, 500, 2500)), 'Ana todavía no lo tiene');
await ctx.setOffline(false);
check(await hasRow(ana, 500, 8000), 'al volver la conexión le llega a Ana');
await bruno.getByText(/Sincronizado/).waitFor({ timeout: 6000 });
check(true, 'Bruno: «Sincronizado» de nuevo');

// --- Con la pantalla de bloqueo, Bruno no trae nada; al desbloquear se pone al día ---
await nav(bruno, 'Más');
await bruno.getByRole('button', { name: /Ajustes/ }).click();
await bruno.getByRole('switch', { name: 'Pedir Face ID al abrir' }).click();
await bruno.waitForFunction(() => window.__lock.pending);
await bruno.evaluate(() => window.__lock.answer('ok'));
await bruno.getByText(/Listo: Pengar te pide Face ID/).waitFor();
await nav(bruno, 'Movimientos');
await leaveApp(bruno);
await bruno.waitForTimeout(500);
const pullsLocked = await calls(bruno, 'pull');
await addExpense(ana, 333, 'Supermercado');
await bruno.waitForTimeout(3000);
check(await calls(bruno, 'pull') === pullsLocked, 'bloqueado, Bruno no pide nada al servidor');
await backToApp(bruno);
await bruno.getByRole('button', { name: 'Desbloquear con Face ID' }).waitFor();
await bruno.waitForFunction(() => window.__lock.pending);
check(await calls(bruno, 'pull') === pullsLocked, 'tampoco con Face ID esperando');
await bruno.evaluate(() => window.__lock.answer('ok'));
await row(bruno, 333).first().waitFor({ timeout: 6000 }).then(() => check(true, 'al desbloquear le llega lo de Ana'), () => check(false, 'al desbloquear le llega lo de Ana'));

// --- Otro teléfono: entrar con el código trae todo de vuelta ---
const ana2 = await phone('ana2');
await ana2.getByRole('button', { name: 'Comenzar' }).click();
await ana2.getByPlaceholder('Tu nombre').fill('Ana');
await ana2.getByRole('button', { name: 'Empezar de cero' }).click();
await addExpense(ana2, 77, 'Supermercado');
await openHousehold(ana2);
await ana2.getByText('Si cambiás de teléfono, entrá con el código y vuelven tus datos', { exact: false }).first().waitFor();
await ana2.getByRole('button', { name: 'Unirme con un código' }).click();
await joinWith(ana2, 'Ana', code);
const confirm = ana2.getByRole('dialog', { name: '¿Reemplazar tus datos?' });
await confirm.waitFor();
check(await confirm.getByRole('button', { name: 'Guardar un respaldo antes' }).count() === 1, 'con datos propios, avisa y ofrece un respaldo');
await confirm.getByRole('button', { name: 'Guardar un respaldo antes' }).click();
await confirm.getByRole('button', { name: 'Respaldo guardado' }).waitFor();
check((await ana2.evaluate(() => window.__backup.writes.length)) > 0, 'el respaldo automático se guardó antes de unirse');
await shot(ana2, 'hogar-reemplazar');
await confirm.getByRole('button', { name: 'Unirme' }).click();
await ana2.getByText(/Listo: estás en «Casa»/).waitFor({ timeout: 8000 });
for (const amount of [1240, 980, 500, 333]) check(await hasRow(ana2, amount), `el otro teléfono de Ana tiene ${amount}`);
check(!(await hasRow(ana2, 77, 1000)), 'lo que tenía ese teléfono se reemplazó');

// --- Código nuevo: el viejo deja de servir ---
await openHousehold(ana);
await ana.getByRole('button', { name: 'Cambiar el código' }).click();
await ana.getByRole('dialog').last().getByRole('button', { name: 'Cambiar' }).click();
await ana.getByText(/Código nuevo:/).waitFor();
const code2 = (await ana.locator('p.font-mono [aria-hidden="true"]').innerText()).replace(/\s/g, '');
check(code2 !== code && /^[A-HJ-NP-Z2-9]{12}$/.test(code2), 'código nuevo');
const carla = await phone('carla');
await carla.getByRole('button', { name: 'Tengo un código de hogar' }).click();
await joinWith(carla, 'Carla', code);
await carla.getByText('Ese código no es de ningún hogar.', { exact: false }).waitFor();
check(true, 'el código viejo ya no sirve');
await carla.close();

// --- «Borrar todo» y los datos de ejemplo no tocan el hogar ---
const before = await serverCount(ana2, 'movement');
await nav(ana2, 'Más');
await ana2.getByRole('button', { name: /Ajustes/ }).click();
await ana2.getByRole('button', { name: 'Borrar todo' }).click();
check(await ana2.getByRole('dialog').last().getByText(/En el hogar «Casa» no se borra nada/).count() === 1, '«Borrar todo» avisa que el hogar queda');
await ana2.getByRole('dialog').last().getByRole('button', { name: 'Borrar todo' }).click();
await ana2.getByText('Seguís en el hogar «Casa»: al empezar, vuelven sus datos.').waitFor();
check(true, 'la bienvenida dice que se sigue en el hogar');
check(await ana2.getByRole('button', { name: 'Restaurar un respaldo' }).count() === 0, 'en un hogar, la bienvenida no ofrece restaurar (se descartaría)');
await ana2.getByRole('button', { name: 'Mirar con datos de ejemplo' }).click();
await ana2.getByText('Estás viendo datos de ejemplo (inventados).').first().waitFor({ timeout: 20000 });
await ana2.waitForTimeout(3000);
check(await serverCount(ana2, 'movement') === before, 'los datos de ejemplo no llegan al hogar');
await openHousehold(ana2);
await ana2.getByText(/En pausa con los datos de ejemplo/).waitFor();
check(true, 'el hogar dice «En pausa» con el ejemplo');
check(await ana2.getByRole('button', { name: 'Salir del hogar' }).isDisabled(), 'con el ejemplo puesto no deja salir (lo del hogar no está en el teléfono)');
await nav(ana2, 'Más');
await ana2.getByRole('button', { name: 'Empezar con los míos' }).click();
await ana2.getByRole('dialog').last().getByRole('button', { name: 'Empezar', exact: true }).click();
await ana2.getByRole('button', { name: 'Comenzar' }).click();
check(await ana2.getByRole('button', { name: 'Empezar de cero' }).count() === 0, 'en un hogar, la bienvenida ofrece volver a sus datos (no empezar de cero)');
await ana2.getByPlaceholder('Tu nombre').fill('Ana');
await ana2.getByRole('button', { name: 'Volver a los datos del hogar' }).click();
await ana2.getByRole('navigation').waitFor({ timeout: 10000 });
check(await hasRow(ana2, 333, 8000), 'al empezar de nuevo, vuelven los datos del hogar');
check(await serverCount(ana2, 'movement') === before, 'y el hogar quedó igual');

// --- Bruno sale: se queda con su copia ---
await openHousehold(bruno);
await bruno.getByRole('button', { name: 'Salir del hogar' }).click();
check(await bruno.getByRole('dialog').last().getByText(/como copia propia/).count() === 1, 'salir avisa que los datos quedan');
await bruno.getByRole('dialog').last().getByRole('button', { name: 'Salir' }).click();
await bruno.getByText(/Saliste del hogar/).waitFor();
await bruno.getByRole('button', { name: 'Crear un hogar' }).waitFor();
check(await hasRow(bruno, 1240), 'Bruno se queda con los datos');
check(await row(bruno, 1240).getByText(/Anotado por/).count() === 0, 'sin hogar, ya no dice quién anotó');
await openHousehold(ana);
await ana.getByText('Bruno').waitFor({ state: 'detached', timeout: 6000 }).then(() => check(true, 'Ana ya no ve a Bruno'), () => check(false, 'Ana ya no ve a Bruno'));

await ctx.close();
await browser.close();
close();
console.log(problems.length ? `\n✗ ${problems.length} problemas:\n${problems.join('\n')}` : '\n✓ todo bien');
process.exit(problems.length ? 1 : 0);
