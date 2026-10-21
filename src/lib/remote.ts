/**
 * El servidor del hogar compartido. El motor (lib/sync.ts) habla solo con RemoteStore: la implementación de Supabase
 * (createSupabaseRemote) y FakeRemote, en memoria, para las pruebas (varios teléfonos contra el mismo servidor, con las
 * reglas de las migraciones de supabase/migrations).
 *
 * Sin correo ni contraseña: cada teléfono es un usuario anónimo de Supabase (signInAnonymously); lo que se comparte es
 * el hogar, con su código de invitación. Cada integrante tiene además una llave (un secreto al azar del que el servidor
 * guarda solo el hash): con el código y la llave, otro teléfono vuelve a entrar como el mismo integrante. Supabase se
 * carga recién cuando hace falta (no pesa al abrir la app).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { cyrb53 } from '../domain/hash';
import { recordKey, type OutRecord, type RecordKind, type RemoteRecord } from '../domain/sync';
import { deleteAuth, readAuth, writeAuth } from './db';
import { fakePhone } from './fakePhone';
import { isPreview } from './platform';

export interface Household {
  id: string;
  name: string;
  /** 12 letras y números, sin los que se confunden */
  inviteCode: string;
}

export interface Member {
  /** El usuario de Supabase del teléfono de ese integrante (cambia si vuelve a entrar desde otro) */
  userId: string;
  /** El integrante: no cambia aunque vuelva a entrar desde otro teléfono. Es el de Movement.createdBy */
  memberId: string;
  displayName: string | null;
  joinedAt: string;
}

/** Cómo quedó al unirse */
export interface Joined {
  household: Household;
  /** Con quién se entró (el integrante nuevo, o el de la llave) */
  memberId: string;
  /** La llave era de un integrante del hogar: este teléfono pasó a ser ese integrante (no se sumó otro) */
  reclaimed: boolean;
  displayName: string | null;
}

/** Qué avisó el servidor que cambió */
export type RemoteChange = 'records' | 'members' | 'household';

/**
 * offline: sin conexión (o el servidor no contestó). auth: la sesión no vale. session: este teléfono ya no tiene su
 * sesión (y no se crea otra: para el servidor sería otra persona). denied: no sos miembro (o ya no). invalid-code: el
 * código no es de ningún hogar. limit: demasiados códigos que no existen (hay que esperar). rejected: el servidor no
 * acepta ese registro o archivo (no sirve reintentar). setup: falta la migración o el ingreso anónimo en el proyecto de
 * Supabase. other: lo demás (se reintenta)
 */
export type RemoteErrorKind = 'offline' | 'auth' | 'session' | 'denied' | 'invalid-code' | 'limit' | 'rejected' | 'setup' | 'other';

export class RemoteError extends Error {
  constructor(readonly kind: RemoteErrorKind, message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

export interface RemoteStore {
  /**
   * El usuario de este teléfono: el guardado o, con `create`, uno anónimo nuevo. Sin sesión y sin `create` tira
   * RemoteError('session'); si no se pudo leer la sesión, tira (no es lo mismo que no tenerla)
   */
  session(opts?: { create?: boolean }): Promise<{ userId: string }>;
  /** `token`: la llave de quien lo crea (el servidor guarda su hash) */
  createHousehold(name: string, displayName: string | null, token: string): Promise<Household>;
  /**
   * Con la llave de un integrante de ese hogar, este teléfono pasa a ser ese integrante; si no, se suma uno nuevo con esa
   * llave. Tira RemoteError('invalid-code') si el código no es de ningún hogar. Repetirlo no duplica
   */
  joinHousehold(code: string, displayName: string | null, token: string): Promise<Joined>;
  /** Cambia la llave de este integrante (la de quien ya estaba antes de que existieran, o si se perdió) */
  setRecovery(householdId: string, token: string): Promise<void>;
  /** El hogar (nombre y código al día), o null si ya no sos miembro */
  household(householdId: string): Promise<Household | null>;
  /** Salir. Si eras el último, el hogar se borra con sus registros y sus archivos (si los archivos no se pueden borrar, tira y no sale) */
  leave(householdId: string): Promise<void>;
  /** Saca a otro integrante del hogar (por ejemplo, un teléfono que ya no se usa) */
  removeMember(householdId: string, userId: string): Promise<void>;
  regenerateCode(householdId: string): Promise<string>;
  members(householdId: string): Promise<Member[]>;
  setDisplayName(householdId: string, name: string | null): Promise<void>;
  renameHousehold(householdId: string, name: string): Promise<void>;
  /** Todo lo cambiado desde `since` (ISO, incluido; null: todo), en orden de updated_at, con la hora del servidor. Quien no es miembro: denied */
  pull(householdId: string, since: string | null): Promise<RemoteRecord[]>;
  /** Guarda los registros (y lápidas). El servidor les pone updated_at y updated_by */
  push(householdId: string, records: OutRecord[]): Promise<void>;
  uploadFile(householdId: string, id: string, file: Blob): Promise<void>;
  /** El archivo, o null si no está en el servidor */
  downloadFile(householdId: string, id: string): Promise<Blob | null>;
  deleteFile(householdId: string, id: string): Promise<void>;
  /**
   * Avisa cuando cambia algo del hogar (también al reconectar), con quién cambió los registros si se sabe. Devuelve cómo
   * dejar de escuchar
   */
  subscribe(householdId: string, onChange: (what: RemoteChange, by?: string | null) => void): () => void;
}

// --- Configuración (.env): VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY ---

const JUNK = /^[\s"'“”‘’`<>\\]+|[\s"'“”‘’`<>\\]+$/g;

/** La dirección del proyecto limpia de lo que se cuela al copiar y pegar (comillas, barra final, «/rest/v1»), o null */
export function cleanSupabaseUrl(raw: string | undefined | null): string | null {
  let s = (raw ?? '').replace(JUNK, '');
  if (!s) return null;
  // Supabase local (npx supabase start) usa http://localhost
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.exec(s);
  if (local) return local[0].toLowerCase();
  s = `https://${s.replace(/^((https?:?)\/*)+/i, '')}`.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  try {
    const u = new URL(s);
    return u.hostname.includes('.') ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/** La clave pública limpia, o null. La secreta (sb_secret_…) nunca va en la app: da acceso a todo */
export function cleanSupabaseKey(raw: string | undefined | null): string | null {
  const s = (raw ?? '').replace(JUNK, '');
  return s && !/\s/.test(s) && !s.startsWith('sb_secret_') ? s : null;
}

const config = {
  url: cleanSupabaseUrl(import.meta.env.VITE_SUPABASE_URL),
  key: cleanSupabaseKey(import.meta.env.VITE_SUPABASE_ANON_KEY),
};

/**
 * ¿Hay un proyecto de Supabase configurado? En la vista previa web nunca (no puede conectarse con otros sitios). Con
 * VITE_FAKE_REMOTE=1 (solo para probar en el navegador) hay uno de mentira: lib/fakeRemote
 */
export const isRemoteConfigured = (): boolean => !isPreview && (fakePhone !== null || (!!config.url && !!config.key));

// --- Supabase ---

const BUCKET = 'pengar-files';
const PAGE = 1000;

interface PgError {
  message?: string;
  code?: string;
  status?: number;
  statusCode?: string;
  name?: string;
}

function toRemoteError(e: PgError | null | undefined, what: string): RemoteError {
  const code = e?.code ?? '';
  const msg = e?.message ?? String(e);
  let kind: RemoteErrorKind = 'other';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) kind = 'offline';
  else if (code === 'P0002') kind = 'invalid-code';
  else if (code === 'PT429' || e?.status === 429) kind = 'limit';
  else if (code === '42501' || e?.status === 403 || e?.statusCode === '403' || /row-level security/i.test(msg)) kind = 'denied';
  else if (code === '28000' || code === 'PGRST301' || code === 'PGRST302' || e?.status === 401) kind = 'auth';
  else if (['PGRST202', 'PGRST204', 'PGRST205', '42P01', '42703', '42883', 'anonymous_provider_disabled'].includes(code) || /anonymous/i.test(msg)) kind = 'setup';
  else if (/^(22|23)/.test(code) || code === 'PGRST102' || e?.status === 413 || e?.statusCode === '413') kind = 'rejected';
  // Sin código ni estado: no hubo respuesta (sin conexión, «Load failed» en el iPhone)
  else if (!code && !e?.status) kind = 'offline';
  return new RemoteError(kind, `${what}: ${msg}`);
}

function check<T>(res: { data: T; error: PgError | null }, what: string): T {
  if (res.error) throw toRemoteError(res.error, what);
  return res.data;
}

/** jsonb no admite el carácter nulo (puede venir del texto de un PDF): se saca, si no el registro no entra nunca */
function jsonSafe(data: unknown): unknown {
  const s = JSON.stringify(data);
  return s.includes('\\u0000') ? JSON.parse(s.replace(/\\u0000/g, '')) : data;
}

interface HouseholdRow {
  id: string;
  name: string;
  invite_code: string;
}
interface JoinRow extends HouseholdRow {
  member_id: string;
  display_name: string | null;
  reclaimed: boolean;
}
interface RecordRow {
  kind: RecordKind;
  id: string;
  data: unknown;
  updated_at: string;
  updated_by: string | null;
  deleted: boolean;
  server_time?: string;
}
const toHousehold = (r: HouseholdRow): Household => ({ id: r.id, name: r.name, inviteCode: r.invite_code });

let clientPromise: Promise<SupabaseClient> | null = null;

/**
 * La sesión va a IndexedDB, con los datos (si se pierde, este teléfono queda fuera del hogar hasta unirse de nuevo).
 * «No se pudo leer» tira: no es «no hay sesión» (si no, se crearía otra y el teléfono quedaría fuera del hogar)
 */
const authStorage = {
  getItem: async (key: string) => (await readAuth(key)) ?? null,
  setItem: (key: string, value: string) => writeAuth(key, value).then(() => {}),
  removeItem: (key: string) => deleteAuth(key),
};

function client(): Promise<SupabaseClient> {
  if (!config.url || !config.key) return Promise.reject(new RemoteError('setup', 'Supabase no está configurado'));
  const { url, key } = config;
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'pengar-auth', storage: authStorage },
      realtime: { params: { eventsPerSecond: 10 } },
    }),
  );
  clientPromise.catch(() => {
    clientPromise = null;
  });
  return clientPromise;
}

export function createSupabaseRemote(): RemoteStore {
  const me = async (c: SupabaseClient) => {
    const { data } = await c.auth.getSession();
    if (!data.session) throw new RemoteError('auth', 'Sin sesión');
    return data.session.user.id;
  };
  const filePath = (hh: string, id: string) => `${hh}/${id}`;

  const remote: RemoteStore = {
    async session(opts = {}) {
      const c = await client();
      const { data, error } = await c.auth.getSession();
      // Con el token vencido y el servidor sin contestar, auth-js devuelve el error y ninguna sesión: no es «no hay»
      if (error) throw toRemoteError(error as PgError, 'Leer la sesión');
      if (data.session) return { userId: data.session.user.id };
      if (!opts.create) throw new RemoteError('session', 'Este teléfono perdió su sesión');
      const res = await c.auth.signInAnonymously();
      if (res.error || !res.data.user) throw toRemoteError(res.error ?? { message: 'Sin usuario' }, 'Ingresar');
      return { userId: res.data.user.id };
    },
    async createHousehold(name, displayName, token) {
      const c = await client();
      const row = check(await c.rpc('pengar_create_household', { p_name: name, p_display_name: displayName, p_token: token }).single(), 'Crear el hogar');
      return toHousehold(row as HouseholdRow);
    },
    async joinHousehold(code, displayName, token) {
      const c = await client();
      // Un código que no es de ningún hogar no devuelve nada (el servidor lleva la cuenta de los intentos)
      const row = check(await c.rpc('pengar_join_household', { p_code: code, p_display_name: displayName, p_token: token }).maybeSingle(), 'Unirse al hogar') as JoinRow | null;
      if (!row) throw new RemoteError('invalid-code', 'Unirse al hogar: código inválido');
      return { household: toHousehold(row), memberId: row.member_id, reclaimed: row.reclaimed === true, displayName: row.display_name };
    },
    async setRecovery(hh, token) {
      const c = await client();
      check(await c.rpc('pengar_set_recovery', { p_household_id: hh, p_token: token }), 'Guardar la llave');
    },
    async household(hh) {
      const c = await client();
      const row = check(await c.from('pengar_households').select('id,name,invite_code').eq('id', hh).maybeSingle(), 'Leer el hogar');
      return row ? toHousehold(row as HouseholdRow) : null;
    },
    async leave(hh) {
      const c = await client();
      // Si es el último, el servidor no borra nada todavía (y cambia el código: ya nadie entra): primero se borran los
      // archivos (Storage no se borra desde SQL) y, si salió bien, se sale de verdad. Si no, tira y sigue en el hogar
      const res = check(await c.rpc('pengar_leave_household', { p_household_id: hh, p_files_cleared: false }), 'Salir del hogar');
      if (res !== 'last') return;
      await removeFolder(c, hh);
      check(await c.rpc('pengar_leave_household', { p_household_id: hh, p_files_cleared: true }), 'Salir del hogar');
    },
    async removeMember(hh, userId) {
      const c = await client();
      check(await c.rpc('pengar_remove_member', { p_household_id: hh, p_user_id: userId }), 'Sacar al integrante');
    },
    async regenerateCode(hh) {
      const c = await client();
      return check(await c.rpc('pengar_regenerate_code', { p_household_id: hh }), 'Código nuevo') as string;
    },
    async members(hh) {
      const c = await client();
      const rows = check(
        await c.from('pengar_members').select('user_id,member_id,display_name,joined_at').eq('household_id', hh).order('joined_at'),
        'Leer los miembros',
      ) as { user_id: string; member_id: string | null; display_name: string | null; joined_at: string }[];
      return rows.map((r) => ({ userId: r.user_id, memberId: r.member_id ?? r.user_id, displayName: r.display_name, joinedAt: r.joined_at }));
    },
    // Quien ya no es miembro no ve la fila (RLS): el UPDATE no cambia nada y no da error. Se pide qué cambió (solo columnas
    // que se pueden leer: `select *` daría 42501 por recovery_hash) y, si nada, es que no tiene permiso
    async setDisplayName(hh, name) {
      const c = await client();
      const rows = check(
        await c.from('pengar_members').update({ display_name: name?.trim().slice(0, 60) || null }).eq('household_id', hh).eq('user_id', await me(c)).select('user_id'),
        'Cambiar el nombre',
      ) as unknown[] | null;
      if (!rows?.length) throw new RemoteError('denied', 'Cambiar el nombre: sin permiso');
    },
    async renameHousehold(hh, name) {
      const c = await client();
      const rows = check(await c.from('pengar_households').update({ name: name.trim().slice(0, 80) || 'Casa' }).eq('id', hh).select('id'), 'Cambiar el nombre del hogar') as unknown[] | null;
      if (!rows?.length) throw new RemoteError('denied', 'Cambiar el nombre del hogar: sin permiso');
    },
    async pull(hh, since) {
      const c = await client();
      const out: RemoteRecord[] = [];
      let after: { at: string; kind: string; id: string } | null = null;
      for (;;) {
        const rows = check(
          await c.rpc('pengar_pull', {
            p_household_id: hh,
            p_since: after?.at ?? since,
            p_after_kind: after?.kind ?? null,
            p_after_id: after?.id ?? null,
            p_limit: PAGE,
          }),
          'Traer los cambios',
        ) as RecordRow[];
        for (const r of rows) {
          out.push({ kind: r.kind, id: r.id, data: r.data, updatedAt: r.updated_at, updatedBy: r.updated_by, deleted: r.deleted, ...(r.server_time ? { serverTime: r.server_time } : {}) });
        }
        // Una página corta es la última (si el proyecto limita las filas a menos de 1000, se sigue pidiendo)
        if (rows.length < 100) return out;
        const last = rows[rows.length - 1];
        after = { at: last.updated_at, kind: last.kind, id: last.id };
      }
    },
    async push(hh, records) {
      if (!records.length) return;
      const c = await client();
      const rows = records.map((r) => ({ household_id: hh, kind: r.kind, id: r.id, data: jsonSafe(r.data), deleted: r.deleted }));
      check(await c.from('pengar_records').upsert(rows, { onConflict: 'household_id,kind,id' }), 'Mandar los cambios');
    },
    async uploadFile(hh, id, file) {
      const c = await client();
      const { error } = await c.storage.from(BUCKET).upload(filePath(hh, id), file, { upsert: true, contentType: file.type || 'application/octet-stream' });
      if (error) throw toRemoteError(error as PgError, 'Subir el archivo');
    },
    async downloadFile(hh, id) {
      const c = await client();
      const { data, error } = await c.storage.from(BUCKET).download(filePath(hh, id));
      if (error) {
        const e = error as PgError;
        if (e.status === 404 || e.statusCode === '404' || /not.?found/i.test(`${e.message} ${e.statusCode}`)) return null;
        throw toRemoteError(e.name === 'StorageUnknownError' ? { message: e.message } : e, 'Bajar el archivo');
      }
      return data;
    },
    async deleteFile(hh, id) {
      const c = await client();
      const { error } = await c.storage.from(BUCKET).remove([filePath(hh, id)]);
      if (error) throw toRemoteError(error as PgError, 'Borrar el archivo');
    },
    subscribe(hh, onChange) {
      let closed = false;
      let off: (() => void) | undefined;
      void client()
        .then((c) => {
          if (closed) return;
          // Un aviso por hogar (pengar_signals): qué cambió y quién. Las tablas de verdad no van a Realtime (sus DELETE
          // le llegarían a cualquiera, sin RLS)
          const filter = `household_id=eq.${hh}`;
          const signal = (row: unknown) => {
            const what = (row as { what?: unknown } | null)?.what;
            onChange(what === 'members' || what === 'household' ? what : 'records', updatedBy(row));
          };
          const ch = c
            .channel(`pengar:${hh}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pengar_signals', filter }, (p) => signal(p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pengar_signals', filter }, (p) => signal(p.new))
            // Al (re)conectar: lo que haya cambiado mientras tanto
            .subscribe((status) => status === 'SUBSCRIBED' && onChange('records'));
          off = () => void c.removeChannel(ch);
        })
        .catch((e) => console.warn('Sin aviso de cambios', e));
      return () => {
        closed = true;
        off?.();
      };
    },
  };
  return remote;
}

const updatedBy = (row: unknown): string | null => {
  const v = (row as { by?: unknown } | null)?.by;
  return typeof v === 'string' ? v : null;
};

/** Borra todos los archivos de la carpeta del hogar */
async function removeFolder(c: SupabaseClient, hh: string): Promise<void> {
  for (;;) {
    const { data, error } = await c.storage.from(BUCKET).list(hh, { limit: 100 });
    if (error) throw toRemoteError(error as PgError, 'Listar los archivos');
    if (!data?.length) return;
    const { error: e2 } = await c.storage.from(BUCKET).remove(data.map((f) => `${hh}/${f.name}`));
    if (e2) throw toRemoteError(e2 as PgError, 'Borrar los archivos');
  }
}

// --- En memoria, para las pruebas ---

interface FakeRow {
  kind: RecordKind;
  id: string;
  data: unknown;
  updatedAt: string;
  updatedBy: string;
  deleted: boolean;
}

/** Copia como la guarda jsonb: sin undefined y con las claves en otro orden (más cortas primero) */
function jsonbCopy(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : jsonbCopy(x)));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((k) => [k, jsonbCopy(o[k])]));
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Servidor en memoria: `connect()` da un teléfono (un usuario) que habla con él. Sigue las reglas de la migración:
 * solo los miembros leen y escriben, la hora la pone el servidor (la misma para todo un envío), salir siendo el último
 * borra el hogar. `offline` en un teléfono hace fallar todo lo suyo como sin conexión.
 */
export class FakeRemote {
  readonly households = new Map<string, Household>();
  readonly members = new Map<string, Member[]>();
  /** El hash de la llave de cada integrante («hogar|integrante»): como recovery_hash, nadie lo lee */
  readonly tokens = new Map<string, string>();
  /** Los que se sacaron con «Sacar», con el hash de su llave (como pengar_departed): vuelven como el mismo integrante */
  readonly departed = new Map<string, { memberId: string; hash: string; displayName: string | null }[]>();
  readonly records = new Map<string, Map<string, FakeRow>>();
  readonly files = new Map<string, Blob>();
  /** Para simular un registro que el servidor no acepta (como un check de la tabla) */
  reject: ((r: OutRecord) => boolean) | null = null;
  /** Para simular que los avisos (Realtime) no llegan */
  silent = false;
  private clock: number;
  private users = 0;
  private listeners = new Set<{ hh: string; client: FakeClient; fn: (what: RemoteChange, by?: string | null) => void }>();

  constructor(start = Date.parse('2026-10-21T12:00:00.000Z')) {
    this.clock = start;
  }

  connect(): FakeClient {
    this.users++;
    return new FakeClient(this, `00000000-0000-4000-8000-${String(this.users).padStart(12, '0')}`);
  }

  /** Pasa el tiempo del servidor */
  tick(ms = 1000): void {
    this.clock += ms;
  }

  /** La hora del servidor (ms). La guarda y la sigue el servidor de las pestañas de prueba (lib/fakeRemote) */
  get time(): number {
    return this.clock;
  }
  set time(ms: number) {
    this.clock = ms;
  }

  /** La hora del servidor para un envío (cada uno, un poco después del anterior) */
  stamp(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  isMember(hh: string, userId: string): boolean {
    return !!this.members.get(hh)?.some((m) => m.userId === userId);
  }

  newCode(): string {
    let code = '';
    do code = Array.from({ length: 12 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    while ([...this.households.values()].some((h) => h.inviteCode === code));
    return code;
  }

  /** El registro como lo tiene el servidor */
  row(hh: string, kind: RecordKind, id: string): FakeRow | undefined {
    return this.records.get(hh)?.get(recordKey(kind, id));
  }

  listen(hh: string, client: FakeClient, fn: (what: RemoteChange, by?: string | null) => void): () => void {
    const l = { hh, client, fn };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  notify(hh: string, what: RemoteChange, by?: string): void {
    if (this.silent) return;
    for (const l of this.listeners) if (l.hh === hh && !l.client.offline) queueMicrotask(() => l.fn(what, by));
  }

  dropHousehold(hh: string): void {
    this.households.delete(hh);
    this.members.delete(hh);
    this.records.delete(hh);
    for (const k of [...this.files.keys()]) if (k.startsWith(`${hh}/`)) this.files.delete(k);
    for (const k of [...this.tokens.keys()]) if (k.startsWith(`${hh}|`)) this.tokens.delete(k);
    this.departed.delete(hh);
  }

  /** Como pengar_recovery_hash: una llave que no tiene el largo de las de la app no sirve */
  tokenHash(token: string | null | undefined): string | null {
    if (token == null) return null;
    if (token.length < 32 || token.length > 200) throw new RemoteError('rejected', 'Llave inválida');
    return cyrb53(`llave:${token}`);
  }

  /** Saca integrantes (y sus llaves) */
  dropMembers(hh: string, gone: (m: Member) => boolean): void {
    const list = this.members.get(hh) ?? [];
    for (const m of list) if (gone(m)) this.tokens.delete(`${hh}|${m.memberId}`);
    this.members.set(hh, list.filter((m) => !gone(m)));
  }
}

export class FakeClient implements RemoteStore {
  offline = false;
  /** Para simular que el teléfono perdió su sesión */
  noSession = false;
  /** Cuántas veces se llamó a cada función (para las pruebas) */
  readonly calls: Record<string, number> = {};

  constructor(readonly server: FakeRemote, readonly userId: string) {}

  private async enter(what: string): Promise<void> {
    this.calls[what] = (this.calls[what] ?? 0) + 1;
    await Promise.resolve();
    if (this.offline) throw new RemoteError('offline', `${what}: sin conexión`);
  }

  private member(hh: string, what: string): void {
    if (!this.server.isMember(hh, this.userId)) throw new RemoteError('denied', `${what}: sin permiso`);
  }

  async session(opts: { create?: boolean } = {}) {
    await this.enter('session');
    if (this.noSession && !opts.create) throw new RemoteError('session', 'Sin sesión');
    return { userId: this.userId };
  }

  async createHousehold(name: string, displayName: string | null, token: string): Promise<Household> {
    await this.enter('createHousehold');
    const hash = this.server.tokenHash(token);
    const hh: Household = { id: crypto.randomUUID(), name: name.trim().slice(0, 80) || 'Casa', inviteCode: this.server.newCode() };
    this.server.households.set(hh.id, hh);
    this.server.members.set(hh.id, [{ userId: this.userId, memberId: this.userId, displayName: displayName?.trim() || null, joinedAt: this.server.stamp() }]);
    if (hash) this.server.tokens.set(`${hh.id}|${this.userId}`, hash);
    this.server.records.set(hh.id, new Map());
    return { ...hh };
  }

  async joinHousehold(code: string, displayName: string | null, token: string): Promise<Joined> {
    await this.enter('joinHousehold');
    const hash = this.server.tokenHash(token);
    const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const hh = [...this.server.households.values()].find((h) => h.inviteCode === clean);
    if (!hh) throw new RemoteError('invalid-code', 'Código inválido');
    const name = displayName?.trim() || null;
    const key = (m: Member) => `${hh.id}|${m.memberId}`;
    // Como pengar_join_household: con la llave de un integrante, este teléfono pasa a ser ese integrante
    const owner = hash ? this.server.members.get(hh.id)!.find((m) => this.server.tokens.get(key(m)) === hash) : undefined;
    if (owner) {
      if (owner.userId !== this.userId) {
        this.server.dropMembers(hh.id, (m) => m.userId === this.userId);
        owner.userId = this.userId;
      }
      if (name) owner.displayName = name;
      this.server.notify(hh.id, 'members');
      return { household: { ...hh }, memberId: owner.memberId, reclaimed: true, displayName: owner.displayName };
    }
    const list = () => this.server.members.get(hh.id)!;
    const gone = this.server.departed.get(hh.id) ?? [];
    const forget = (memberId: string) => this.server.departed.set(hh.id, gone.filter((d) => d.memberId !== memberId));
    // Lo habían sacado y vuelve con su llave: el mismo integrante, si su id está libre
    const back = hash ? gone.find((d) => d.hash === hash && !list().some((m) => m.memberId === d.memberId)) : undefined;
    if (back) {
      this.server.dropMembers(hh.id, (m) => m.userId === this.userId);
      const restored: Member = { userId: this.userId, memberId: back.memberId, displayName: name ?? back.displayName, joinedAt: this.server.stamp() };
      list().push(restored);
      this.server.tokens.set(key(restored), back.hash);
      forget(back.memberId);
      this.server.notify(hh.id, 'members');
      return { household: { ...hh }, memberId: restored.memberId, reclaimed: true, displayName: restored.displayName };
    }
    let mine = list().find((m) => m.userId === this.userId);
    if (mine) mine.displayName = name || mine.displayName;
    else {
      // Como en la base: el id de integrante es único en el hogar. Si el de este usuario ya es de otro (alguien que volvió
      // a entrar desde otro teléfono con la llave de este), uno nuevo
      const taken = list().some((m) => m.memberId === this.userId);
      mine = { userId: this.userId, memberId: taken ? crypto.randomUUID() : this.userId, displayName: name, joinedAt: this.server.stamp() };
      list().push(mine);
    }
    if (hash) this.server.tokens.set(key(mine), hash);
    forget(mine.memberId);
    this.server.notify(hh.id, 'members');
    return { household: { ...hh }, memberId: mine.memberId, reclaimed: false, displayName: mine.displayName };
  }

  async setRecovery(hh: string, token: string): Promise<void> {
    await this.enter('setRecovery');
    const hash = this.server.tokenHash(token);
    const mine = this.server.members.get(hh)?.find((m) => m.userId === this.userId);
    if (!mine || !hash) throw new RemoteError('denied', 'Guardar la llave: sin permiso');
    this.server.tokens.set(`${hh}|${mine.memberId}`, hash);
  }

  async household(hh: string): Promise<Household | null> {
    await this.enter('household');
    const h = this.server.households.get(hh);
    return h && this.server.isMember(hh, this.userId) ? { ...h } : null;
  }

  async leave(hh: string): Promise<void> {
    await this.enter('leave');
    const list = this.server.members.get(hh);
    if (!list?.some((m) => m.userId === this.userId)) return;
    const rest = list.filter((m) => m.userId !== this.userId);
    if (!rest.length) this.server.dropHousehold(hh);
    else {
      this.server.dropMembers(hh, (m) => m.userId === this.userId);
      this.server.notify(hh, 'members');
    }
  }

  async removeMember(hh: string, userId: string): Promise<void> {
    await this.enter('removeMember');
    this.member(hh, 'Sacar al integrante');
    // Como pengar_remove_member: queda su id con el hash de su llave, para que vuelva como el mismo
    const out = userId === this.userId ? undefined : this.server.members.get(hh)?.find((m) => m.userId === userId);
    const hash = out && this.server.tokens.get(`${hh}|${out.memberId}`);
    if (out && hash) {
      const gone = (this.server.departed.get(hh) ?? []).filter((d) => d.memberId !== out.memberId);
      this.server.departed.set(hh, [...gone, { memberId: out.memberId, hash, displayName: out.displayName }]);
    }
    this.server.dropMembers(hh, (m) => m.userId === userId && userId !== this.userId);
    this.server.notify(hh, 'members');
  }

  async regenerateCode(hh: string): Promise<string> {
    await this.enter('regenerateCode');
    this.member(hh, 'Código nuevo');
    const h = this.server.households.get(hh)!;
    h.inviteCode = this.server.newCode();
    this.server.notify(hh, 'household');
    return h.inviteCode;
  }

  async members(hh: string): Promise<Member[]> {
    await this.enter('members');
    if (!this.server.isMember(hh, this.userId)) return [];
    return this.server.members.get(hh)!.map((m) => ({ ...m }));
  }

  async setDisplayName(hh: string, name: string | null): Promise<void> {
    await this.enter('setDisplayName');
    // Como en Supabase (con el .select() que lo detecta): quien ya no es miembro no cambia nada
    const m = this.server.members.get(hh)?.find((x) => x.userId === this.userId);
    if (!m) throw new RemoteError('denied', 'Cambiar el nombre: sin permiso');
    m.displayName = name?.trim() || null;
    this.server.notify(hh, 'members');
  }

  async renameHousehold(hh: string, name: string): Promise<void> {
    await this.enter('renameHousehold');
    this.member(hh, 'Cambiar el nombre del hogar');
    this.server.households.get(hh)!.name = name.trim() || 'Casa';
    this.server.notify(hh, 'household');
  }

  async pull(hh: string, since: string | null): Promise<RemoteRecord[]> {
    await this.enter('pull');
    // Como pengar_pull: quien no es miembro no recibe un hogar vacío, recibe un error
    this.member(hh, 'Traer los cambios');
    const from = since === null ? null : Date.parse(since);
    const serverTime = new Date(this.server.time).toISOString();
    return [...(this.server.records.get(hh)?.values() ?? [])]
      .filter((r) => from === null || Date.parse(r.updatedAt) >= from)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
      .map((r) => ({ kind: r.kind, id: r.id, data: jsonbCopy(r.data), updatedAt: r.updatedAt, updatedBy: r.updatedBy, deleted: r.deleted, serverTime }));
  }

  async push(hh: string, records: OutRecord[]): Promise<void> {
    await this.enter('push');
    this.member(hh, 'Mandar los cambios');
    if (this.server.reject && records.some(this.server.reject)) throw new RemoteError('rejected', 'Mandar los cambios: registro rechazado');
    // Todo el envío con la misma hora, como now() en una transacción
    const at = this.server.stamp();
    const rows = this.server.records.get(hh)!;
    for (const r of records) {
      rows.set(recordKey(r.kind, r.id), { kind: r.kind, id: r.id, data: jsonbCopy(JSON.parse(JSON.stringify(r.data ?? {}))), updatedAt: at, updatedBy: this.userId, deleted: r.deleted });
    }
    if (records.length) this.server.notify(hh, 'records', this.userId);
  }

  async uploadFile(hh: string, id: string, file: Blob): Promise<void> {
    await this.enter('uploadFile');
    this.member(hh, 'Subir el archivo');
    this.server.files.set(`${hh}/${id}`, file);
  }

  async downloadFile(hh: string, id: string): Promise<Blob | null> {
    await this.enter('downloadFile');
    this.member(hh, 'Bajar el archivo');
    return this.server.files.get(`${hh}/${id}`) ?? null;
  }

  async deleteFile(hh: string, id: string): Promise<void> {
    await this.enter('deleteFile');
    this.member(hh, 'Borrar el archivo');
    this.server.files.delete(`${hh}/${id}`);
  }

  subscribe(hh: string, onChange: (what: RemoteChange, by?: string | null) => void): () => void {
    return this.server.listen(hh, this, onChange);
  }
}
