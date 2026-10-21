/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** '1' en la build de vista previa web (npm run build:preview) */
  readonly VITE_PREVIEW?: string;
  /** Hogar compartido: el proyecto de Supabase (ver .env.example). Sin estas dos, la app no se conecta con nada */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** '1': el hogar compartido contra un servidor de mentira en el navegador, para probar (lib/fakeRemote). Nunca en dist */
  readonly VITE_FAKE_REMOTE?: string;
}
