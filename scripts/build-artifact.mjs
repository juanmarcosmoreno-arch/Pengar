// Arma la vista previa web para publicar como artefacto, a partir de la build de vista previa (dist-preview).
// Uso: npm run build:preview  → dist-preview/pengar.html (la página) y dist-preview/files.json (los archivos de al lado).
// La página se publica dentro de un esqueleto (<!doctype><html><head><body>), así que no los trae: solo el título,
// los estilos, los scripts y el contenido. Todo con rutas relativas.
// files.json es el mapa que acepta la publicación tal cual, desde la carpeta del proyecto:
// { "assets/index-ABC.js": { "from": "dist-preview/assets/index-ABC.js", "contentType": "text/javascript" }, … }
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadEnv } from 'vite';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist-preview');
const index = readFileSync(join(dist, 'index.html'), 'utf8');

// Lo que hace andar la app: el módulo principal, sus precargas y la hoja de estilos
const tags = [
  ...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g),
  ...index.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*>/g),
  ...index.matchAll(/<script\b[^>]*\btype="module"[^>]*><\/script>/g),
].map((m) => m[0]);
if (!tags.some((t) => t.startsWith('<script'))) throw new Error('No encontré el <script type="module"> en dist-preview/index.html');
for (const t of tags) {
  if (/(src|href)="\//.test(t)) throw new Error(`Ruta absoluta en ${t}: la build tiene que usar base './'`);
}

// El suricata de la vitrina es el mismo de la bienvenida, que ya está en assets (no se copia otro)
const principal = readdirSync(join(dist, 'assets')).find((n) => /^principal-[\w-]+\.webp$/.test(n));
if (!principal) throw new Error('No encontré assets/principal-*.webp en dist-preview');

// La vitrina entra en la ventana (con su propio scroll si hace falta): html y body no scrollean desde los 760 px.
// Necesita el mismo alto que el marco de teléfono (index.css): un teléfono acostado no la muestra
const vitrinaStyle = `
.vitrina { display: none; }
@media (min-width: 960px) and (min-height: 500px) {
  .vitrina { display: block; flex: none; width: 300px; max-height: calc(100vh - 48px); overflow-y: auto; scrollbar-width: none; color: #22302C; font-family: 'Patrick Hand', ui-rounded, system-ui, sans-serif; }
  .vitrina::-webkit-scrollbar { display: none; }
  .vitrina img { display: block; height: min(180px, 20vh); width: auto; margin-left: -6px; }
  .vitrina h1 { margin: 6px 0 0; font-size: 58px; line-height: 1; font-weight: 400; }
  .vitrina .lema { margin: 6px 0 0; font-size: 23px; color: #176B60; }
  .vitrina h2 { margin: 30px 0 6px; font-size: 21px; font-weight: 400; }
  .vitrina ol { margin: 0; padding: 0; list-style: none; counter-reset: paso; }
  .vitrina li { counter-increment: paso; position: relative; padding: 6px 0 6px 40px; font-size: 18px; line-height: 1.3; }
  .vitrina li::before {
    content: counter(paso); position: absolute; left: 0; top: 4px; width: 28px; height: 28px; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center; border: 1.5px solid #176B60; border-radius: 50%;
    color: #176B60; background: #F5F3EE; font-size: 16px;
  }
  .vitrina .nota { margin: 26px 0 0; padding-top: 14px; border-top: 1px solid rgb(34 48 44 / 0.15); font-size: 15px; line-height: 1.35; color: rgb(34 48 44 / 0.68); }
}
@media (min-width: 960px) and (max-height: 640px) {
  .vitrina img { display: none; }
}`;

// loading="lazy": con la vitrina oculta (en el teléfono) la imagen no se baja
const vitrina = `<aside class="vitrina" lang="es" aria-label="Sobre esta vista previa">
  <img src="assets/${principal}" alt="" width="129" height="180" loading="lazy">
  <h1>Pengar</h1>
  <p class="lema">Tu dinero, más simple.</p>
  <h2>Para probar</h2>
  <ol>
    <li>Abrí el resumen del mes pasado, arriba en Inicio.</li>
    <li>Mirá Estadísticas: el mes, el diezmo acumulado y las tendencias.</li>
    <li>Subí el PDF de una factura: lee el comercio, el total y cada renglón.</li>
    <li>Probá «Tarjeta» con el estado de cuenta de ejemplo.</li>
    <li>Cambiá categorías y rubros en Más.</li>
  </ol>
  <p class="nota">Vista previa web con datos de ejemplo. Los datos quedan en este navegador. Las fotos de tickets, la lectura con Claude y las descargas funcionan en la app de iPhone.</p>
</aside>`;

const page = [
  '<title>Pengar</title>',
  '<meta name="color-scheme" content="light only">',
  ...tags.filter((t) => t.startsWith('<link')),
  `<style>${vitrinaStyle}\n</style>`,
  ...tags.filter((t) => t.startsWith('<script')),
  vitrina,
  '<div id="root"></div>',
  '',
].join('\n');
writeFileSync(join(dist, 'pengar.html'), page);

// Los archivos que la página pide, con su tipo
const TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
// Lo que la vista previa no usa: index.html (la página es pengar.html) y los íconos, que solo nombra index.html
const SKIP = new Set(['pengar.html', 'index.html', 'files.json', 'favicon.png', 'icons/apple-touch-icon.png', 'icons/icon-512.png']);
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const files = walk(dist)
  .map((abs) => ({ abs, path: relative(dist, abs).split(sep).join('/') }))
  .filter((f) => !SKIP.has(f.path))
  .sort((a, b) => a.path.localeCompare(b.path))
  .map(({ abs, path }) => {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const contentType = TYPES[ext];
    if (!contentType) throw new Error(`No sé el tipo de ${path}: agregalo a TYPES en scripts/build-artifact.mjs`);
    return { path, from: relative(root, abs).split(sep).join('/'), contentType };
  });
writeFileSync(join(dist, 'files.json'), JSON.stringify(Object.fromEntries(files.map(({ path, from, contentType }) => [path, { from, contentType }])), null, 2) + '\n');

// La publicación no acepta caracteres de control crudos en archivos de texto (pdf.js y xlsx traen algunos dentro de
// cadenas y expresiones regulares): se pasan a su secuencia de escape \xHH, que significa lo mismo
for (const f of files.filter((x) => /\.(m?js|css)$/.test(x.path))) {
  const abs = join(root, f.from);
  const text = readFileSync(abs, 'utf8');
  const clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
  if (clean !== text) writeFileSync(abs, clean);
  if (clean.includes('\uFFFD')) throw new Error(`${f.path} tiene el carácter de reemplazo U+FFFD (la publicación no lo acepta)`);
}

// pdf.js arranca su worker con una ruta relativa al módulo que lo pide (new URL(…, import.meta.url))
const worker = files.find((f) => /pdf\.worker[^/]*\.mjs$/.test(f.path));
const js = files.filter((f) => f.path.endsWith('.js')).map((f) => readFileSync(join(root, f.from), 'utf8')).join('\n');
const workerName = worker?.path.split('/').pop();
if (!worker || !js.includes(`new URL("${workerName}",import.meta.url)`)) throw new Error('No encontré el worker de pdf.js con ruta relativa');
if (!files.some((f) => f.path === 'ejemplo.json')) throw new Error('Falta ejemplo.json (public/ejemplo.json: node scripts/make-example.mjs)');

// La vista previa se comparte: no puede llevar el proyecto de Supabase del .env (vite.config los deja vacíos)
const env = loadEnv('production', root, 'VITE_');
const secrets = [env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY].map((v) => (v ?? '').trim().replace(/^["']|["']$/g, '')).filter((v) => v.length >= 8);
for (const f of files.filter((x) => /\.(m?js|css|json|html)$/.test(x.path))) {
  const text = readFileSync(join(root, f.from), 'utf8');
  if (secrets.some((v) => text.includes(v))) throw new Error(`${f.path} tiene la dirección o la clave de Supabase del .env: la vista previa no las lleva`);
}

const size = files.reduce((s, f) => s + statSync(join(root, f.from)).size, 0);
console.log(`✓ dist-preview/pengar.html y files.json (${files.length} archivos, ${(size / 1024 / 1024).toFixed(1)} MB)`);
