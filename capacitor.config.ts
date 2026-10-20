import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Cambialo por tu propio identificador antes de registrar la app en App Store Connect
  appId: 'uy.pengar.app',
  appName: 'Pengar',
  webDir: 'dist',
  ios: {
    // Los márgenes de la muesca los maneja el CSS con env(safe-area-inset-*)
    contentInset: 'never',
    backgroundColor: '#F5F3EE',
  },
  plugins: {
    SplashScreen: { launchShowDuration: 500, launchAutoHide: true, showSpinner: false, backgroundColor: '#F5F3EE' },
  },
};

export default config;
