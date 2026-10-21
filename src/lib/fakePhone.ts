/**
 * Solo para probar el hogar compartido en el navegador, sin Supabase (VITE_FAKE_REMOTE=1, ver lib/fakeRemote). Cada
 * pestaña con ?telefono=ana (o bruno…) es otro teléfono: sus datos van aparte (lib/db) y es otro usuario. null en la app
 */
export const fakePhone: string | null =
  import.meta.env.VITE_FAKE_REMOTE === '1'
    ? (new URLSearchParams(globalThis.location?.search).get('telefono') ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'uno'
    : null;
