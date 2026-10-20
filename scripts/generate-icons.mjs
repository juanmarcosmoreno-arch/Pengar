// Íconos de la app (iPhone y web): el suricata principal sobre fondo crema.
// Uso: npm run icons   (antes, si cambiaron los dibujos: python3 scripts/suricata.py)
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// El dibujo original, sobre su papel (para el ícono queda mejor que el recorte)
const img = `data:image/webp;base64,${readFileSync(resolve(root, 'docs/marca/suricata-principal.webp')).toString('base64')}`;

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
/** `fill`: tamaño del papel original respecto del ícono */
async function render(size, path, fill = 1.2) {
  await page.setViewportSize({ width: size, height: size });
  // El papel original es cuadrado; se agranda un poco para que el suricata llene el ícono
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden;background:#F1ECE4;display:flex;align-items:center;justify-content:center">
    <img src="${img}" style="width:${Math.round(size * fill)}px;height:auto;flex:none;transform:translate(-3%,-2.5%)"></body></html>`);
  await page.waitForLoadState('networkidle');
  return page.screenshot({ path });
}

const icons = resolve(root, 'public/icons');
mkdirSync(icons, { recursive: true });
await render(180, resolve(icons, 'apple-touch-icon.png'));
await render(512, resolve(icons, 'icon-512.png'));
await render(64, resolve(root, 'public/favicon.png'), 1.6);
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
