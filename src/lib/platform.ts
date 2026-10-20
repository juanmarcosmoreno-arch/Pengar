import { Capacitor } from '@capacitor/core';

/** ¿Corre dentro de la app de iPhone (Capacitor)? */
export const isNative = Capacitor.isNativePlatform();

/** Build de vista previa web (npm run build:preview): abre con los datos de ejemplo y sin descargas, fotos ni Claude */
export const isPreview = import.meta.env.VITE_PREVIEW === '1';
