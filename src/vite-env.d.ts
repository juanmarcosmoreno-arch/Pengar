/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** '1' en la build de vista previa web (npm run build:preview) */
  readonly VITE_PREVIEW?: string;
}
