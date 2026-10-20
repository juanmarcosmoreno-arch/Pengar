// Íconos de la app (iPhone y web) a partir del logo: la «P» con hoja sobre fondo crema.
// Uso: npm run icons
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Mismos trazos que src/components/Logo.tsx
const src = readFileSync(resolve(root, 'src/components/Logo.tsx'), 'utf8');
const paths = [...src.matchAll(/<path [^>]+\/>/g)].map((m) => m[0].replace(/strokeWidth/g, 'stroke-width').replace(/strokeLinecap/g, 'stroke-linecap')).join('');
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}"><rect x="${-pad}" y="${-pad}" width="${100 + pad * 2}" height="${100 + pad * 2}" fill="#F5F3EE"/>${paths}</svg>`;

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
async function render(size, path, pad = 18, type = 'png') {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ path, type });
}

const icons = resolve(root, 'public/icons');
mkdirSync(icons, { recursive: true });
await render(180, resolve(icons, 'apple-touch-icon.png'));
await render(512, resolve(icons, 'icon-512.png'));
await render(64, resolve(root, 'public/favicon.png'), 8);
await render(512, resolve(root, 'public/logo.png'), 8);
await render(1024, resolve(root, 'docs/icono.png'));

const iosIcon = resolve(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
if (existsSync(iosIcon)) {
  // App Store rechaza íconos con transparencia: la captura es opaca (fondo crema)
  await render(1024, iosIcon);
  await page.setViewportSize({ width: 2732, height: 2732 });
  await page.setContent('<html><body style="margin:0;background:#F5F3EE;height:2732px"></body></html>');
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await page.screenshot({ path: resolve(root, 'ios/App/App/Assets.xcassets/Splash.imageset', name) });
  }
}
await browser.close();
console.log('✓ íconos');
