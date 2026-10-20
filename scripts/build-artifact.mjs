// Arma la vista previa web para publicar como artefacto, a partir de la build de vista previa (dist-preview).
// Uso: npm run build:preview  → dist-preview/pengar.html (la página) y dist-preview/files.json (los archivos de al lado).
// La página se publica dentro de un esqueleto (<!doctype><html><head><body>), así que no los trae: solo el título,
// los estilos, los scripts y el contenido. Todo con rutas relativas.
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

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

// El suricata de la vitrina, al lado de la página
copyFileSync(join(root, 'src/assets/suricata/principal.webp'), join(dist, 'vitrina.webp'));

const vitrinaStyle = `
.vitrina { display: none; }
@media (min-width: 960px) {
  .vitrina { display: block; flex: none; width: 300px; color: #22302C; font-family: 'Patrick Hand', ui-rounded, system-ui, sans-serif; }
  .vitrina img { display: block; height: 180px; width: auto; margin-left: -6px; }
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
}`;

const vitrina = `<aside class="vitrina" aria-label="Sobre esta vista previa">
  <img src="vitrina.webp" alt="" width="129" height="180">
  <h1>Pengar</h1>
  <p class="lema">Tu dinero, más simple.</p>
  <h2>Para probar</h2>
  <ol>
    <li>Anotá un gasto o un ingreso desde Inicio.</li>
    <li>Mirá Estadísticas: el mes y las tendencias.</li>
    <li>Subí el PDF de una factura: lee el comercio, el total y cada renglón.</li>
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
const SKIP = new Set(['pengar.html', 'index.html', 'files.json']);
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
writeFileSync(join(dist, 'files.json'), JSON.stringify(files, null, 2) + '\n');

// pdf.js arranca su worker con una ruta relativa al módulo que lo pide (new URL(…, import.meta.url))
const worker = files.find((f) => /pdf\.worker[^/]*\.mjs$/.test(f.path));
const js = files.filter((f) => f.path.endsWith('.js')).map((f) => readFileSync(join(root, f.from), 'utf8')).join('\n');
const workerName = worker?.path.split('/').pop();
if (!worker || !js.includes(`new URL("${workerName}",import.meta.url)`)) throw new Error('No encontré el worker de pdf.js con ruta relativa');
if (!files.some((f) => f.path === 'ejemplo.xlsx')) throw new Error('Falta ejemplo.xlsx (public/ejemplo.xlsx)');

const size = files.reduce((s, f) => s + statSync(join(root, f.from)).size, 0);
console.log(`✓ dist-preview/pengar.html y files.json (${files.length} archivos, ${(size / 1024 / 1024).toFixed(1)} MB)`);
