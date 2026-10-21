/// <reference types="vitest" />
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * VITE_FAKE_REMOTE=1: el hogar compartido contra un servidor de mentira en el navegador (lib/fakeRemote), solo para
 * probar. Compila en dist-fake y nunca en dist, que es lo que va al iPhone (capacitor.config.ts → webDir)
 */
const fakeGuard = (fake: boolean): Plugin => ({
  name: 'pengar-fake-guard',
  configResolved(c) {
    if (fake && c.command === 'build' && resolve(c.root, c.build.outDir) === resolve(c.root, 'dist')) {
      throw new Error('VITE_FAKE_REMOTE=1 es solo para probar: no se compila en dist (es lo que va al iPhone). Usá --outDir dist-fake');
    }
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const fake = env.VITE_FAKE_REMOTE === '1';
  // La vista previa web se publica y se comparte: no lleva la dirección ni la clave del proyecto de Supabase del .env
  const preview = (process.env.VITE_PREVIEW ?? env.VITE_PREVIEW) === '1';
  return {
    plugins: [react(), fakeGuard(fake)],
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
      ...(preview ? { 'import.meta.env.VITE_SUPABASE_URL': '""', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '""' } : {}),
    },
    // Rutas relativas: la misma build sirve en el iPhone (Capacitor) y en cualquier carpeta web
    base: './',
    build: { chunkSizeWarningLimit: 1500, ...(fake ? { outDir: 'dist-fake' } : {}) },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
