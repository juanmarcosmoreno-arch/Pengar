// La build de prueba del hogar compartido (VITE_FAKE_REMOTE=1, en dist-fake: nunca va al iPhone) y un servidor para
// mirarla. La usan las capturas (scripts/screenshots.mjs) y el recorrido de dos pestañas (scripts/e2e-hogar.mjs).
// En esa build cada pestaña con ?telefono=ana (o bruno…) es otro teléfono y el «servidor» del hogar queda en el
// navegador (src/lib/fakeRemote.ts): window.__pengarFake.calls cuenta lo que pidió cada pestaña.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const fakeDist = join(root, 'dist-fake');

/** Arma dist-fake (unos 10 s) */
export async function buildFake() {
  const { build } = await import('vite');
  const before = process.env.VITE_FAKE_REMOTE;
  process.env.VITE_FAKE_REMOTE = '1';
  try {
    await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: fakeDist, emptyOutDir: true } });
  } finally {
    if (before === undefined) delete process.env.VITE_FAKE_REMOTE;
    else process.env.VITE_FAKE_REMOTE = before;
  }
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };

/** Sirve una carpeta de build: { url, close } */
export function serve(dir) {
  const server = createServer(async (req, res) => {
    const path = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = existsSync(path) && !path.endsWith('/') ? path : join(dir, 'index.html');
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  }).listen(0);
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}
