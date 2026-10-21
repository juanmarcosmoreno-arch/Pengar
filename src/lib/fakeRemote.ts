/**
 * Solo para probar el hogar compartido en el navegador, sin Supabase. Con VITE_FAKE_REMOTE=1 (`VITE_FAKE_REMOTE=1 npm
 * run dev`, o la build en dist-fake de las capturas y de npm run e2e:hogar) la app habla con un FakeRemote (lib/remote)
 * en lugar de Supabase. vite.config no deja compilarlo en dist, que es lo que va al iPhone.
 *
 * El «servidor» queda en el navegador y lo comparten las pestañas: hogares, integrantes (con el hash de sus llaves) y
 * registros en localStorage; los
 * archivos, en otra base de IndexedDB (pengar-fake). Cada pestaña con ?telefono=ana es otro teléfono y otro usuario
 * (lib/fakePhone). Los avisos de Realtime llegan a las demás pestañas con el evento storage. Sin conexión (la del
 * navegador, context.setOffline en Playwright, o `offline` acá abajo para una sola pestaña) todo falla como en Supabase.
 *
 * Desde la consola: window.__pengarFake (calls: cuántas veces se llamó a cada función; offline; reset(): vacía el servidor)
 */
import { clear, createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import { recordKey } from '../domain/sync';
import { FakeClient, FakeRemote, RemoteError, type Household, type Member, type RemoteChange, type RemoteStore } from './remote';

type Row = NonNullable<ReturnType<FakeRemote['row']>>;
interface Saved {
  clock: number;
  households: Household[];
  members: [string, Member[]][];
  records: [string, Row[]][];
  tokens?: [string, string][];
}
interface Notice {
  hh: string;
  what: RemoteChange;
  by: string | null;
}
export interface FakeHandle {
  phone: string;
  userId: string;
  calls: Record<string, number>;
  /** Esta pestaña sin conexión (las demás siguen). Al volver: window.dispatchEvent(new Event('online')) */
  offline: boolean;
  reset(): Promise<void>;
}

const KEY = 'pengar-fake:servidor';
const NOTICE = 'pengar-fake:aviso';

export function createFakeRemote(phone: string): RemoteStore {
  const server = new FakeRemote(Date.now());
  const client = new FakeClient(server, `fake-${phone}`);
  let fileDb: UseStore | undefined;
  const files = () => (fileDb ??= createStore('pengar-fake', 'files'));
  const notices: Notice[] = [];
  const handle: FakeHandle = {
    phone,
    userId: client.userId,
    calls: {},
    offline: false,
    async reset() {
      localStorage.removeItem(KEY);
      await clear(files());
    },
  };
  (window as unknown as { __pengarFake: FakeHandle }).__pengarFake = handle;
  const offline = () => handle.offline || navigator.onLine === false;

  // Lo que avisa el servidor: a esta pestaña, como siempre, y a las demás después de guardar (que lean lo nuevo)
  const notifyHere = server.notify.bind(server);
  server.notify = (hh: string, what: RemoteChange, by?: string) => {
    notifyHere(hh, what, by);
    notices.push({ hh, what, by: by ?? null });
  };
  window.addEventListener('storage', (e) => {
    if (e.key !== NOTICE || !e.newValue || offline()) return;
    const n = JSON.parse(e.newValue) as Notice;
    notifyHere(n.hh, n.what, n.by ?? undefined);
  });

  const load = () => {
    let saved: Saved | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    } catch {
      saved = null;
    }
    server.households.clear();
    server.members.clear();
    server.records.clear();
    server.tokens.clear();
    for (const h of saved?.households ?? []) server.households.set(h.id, h);
    // Los de antes de las llaves: su id de integrante es su usuario
    for (const [hh, list] of saved?.members ?? []) server.members.set(hh, list.map((m) => ({ ...m, memberId: m.memberId ?? m.userId })));
    for (const [k, v] of saved?.tokens ?? []) server.tokens.set(k, v);
    for (const [hh, rows] of saved?.records ?? []) server.records.set(hh, new Map(rows.map((r) => [recordKey(r.kind, r.id), r])));
    // La hora sigue a la de las otras pestañas (nunca para atrás: el motor pide «desde» la última que recibió)
    server.time = Math.max(server.time, saved?.clock ?? 0, Date.now());
  };
  const save = () => {
    const saved: Saved = {
      clock: server.time,
      households: [...server.households.values()],
      members: [...server.members],
      records: [...server.records].map(([hh, rows]) => [hh, [...rows.values()]]),
      tokens: [...server.tokens],
    };
    localStorage.setItem(KEY, JSON.stringify(saved));
    for (const n of notices.splice(0)) localStorage.setItem(NOTICE, JSON.stringify({ ...n, nonce: Math.random() }));
  };

  /** Lee el servidor, hace lo pedido y, si cambia algo, lo guarda */
  const call = async <T,>(name: string, writes: boolean, fn: () => Promise<T>): Promise<T> => {
    handle.calls[name] = (handle.calls[name] ?? 0) + 1;
    if (offline()) throw new RemoteError('offline', `${name}: sin conexión`);
    load();
    try {
      return await fn();
    } finally {
      if (writes) save();
      else notices.length = 0;
    }
  };

  return {
    session: (opts) => call('session', false, () => client.session(opts)),
    createHousehold: (name, displayName, token) => call('createHousehold', true, () => client.createHousehold(name, displayName, token)),
    joinHousehold: (code, displayName, token) => call('joinHousehold', true, () => client.joinHousehold(code, displayName, token)),
    setRecovery: (hh, token) => call('setRecovery', true, () => client.setRecovery(hh, token)),
    household: (hh) => call('household', false, () => client.household(hh)),
    leave: (hh) =>
      call('leave', true, async () => {
        await client.leave(hh);
        // El último en salir: se van también los archivos
        if (!server.households.has(hh)) {
          for (const k of await keys(files())) if (typeof k === 'string' && k.startsWith(`${hh}/`)) await del(k, files());
        }
      }),
    removeMember: (hh, userId) => call('removeMember', true, () => client.removeMember(hh, userId)),
    regenerateCode: (hh) => call('regenerateCode', true, () => client.regenerateCode(hh)),
    members: (hh) => call('members', false, () => client.members(hh)),
    setDisplayName: (hh, name) => call('setDisplayName', true, () => client.setDisplayName(hh, name)),
    renameHousehold: (hh, name) => call('renameHousehold', true, () => client.renameHousehold(hh, name)),
    pull: (hh, since) => call('pull', false, () => client.pull(hh, since)),
    push: (hh, records) => call('push', true, () => client.push(hh, records)),
    uploadFile: (hh, id, file) =>
      call('uploadFile', false, async () => {
        await client.uploadFile(hh, id, file);
        await set(`${hh}/${id}`, file, files());
      }),
    downloadFile: (hh, id) =>
      call('downloadFile', false, async () => {
        const blob = await get<Blob>(`${hh}/${id}`, files());
        if (blob) server.files.set(`${hh}/${id}`, blob);
        return client.downloadFile(hh, id);
      }),
    deleteFile: (hh, id) =>
      call('deleteFile', false, async () => {
        await client.deleteFile(hh, id);
        await del(`${hh}/${id}`, files());
      }),
    subscribe: (hh, onChange) => client.subscribe(hh, onChange),
  };
}
