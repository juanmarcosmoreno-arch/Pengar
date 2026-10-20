import { Capacitor } from '@capacitor/core';

/** ¿Corre dentro de la app de iPhone (Capacitor)? */
export const isNative = Capacitor.isNativePlatform();

