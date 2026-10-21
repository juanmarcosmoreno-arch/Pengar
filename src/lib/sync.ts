/**
 * Motor del hogar compartido. Se engancha al store sin tocar cada acción: cuando cambian los datos (con una espera de
 * 1,5 s) compara lo de acá contra lo que tiene el servidor (un hash por registro) y manda la diferencia; trae lo de los
 * demás al abrir, al volver a la app, cada minuto con la app abierta y cuando el servidor avisa (Realtime).
 *
 * Su estado va en IndexedDB (clave 'sync'): el hogar, hasta dónde recibió y el hash de cada registro que tiene el
 * servidor. Lo pendiente es lo que difiere de esos hashes: esa es la cola, y no se pierde aunque se cierre la app sin
 * conexión. Si algo falla, se reintenta con una espera cada vez más larga (hasta 5 minutos).
 *
 * Archivos de facturas y estados de cuenta: los nuevos se suben a pengar-files/<hogar>/<id> después de mandar el
 * registro; quien no lo tiene lo baja la primera vez que lo abre (loadInvoiceFile, en el visor).
 *
 * «Borrar todo» y los datos de ejemplo no tocan el hogar: el motor queda en pausa y, cuando la app vuelve a tener datos
 * propios, baja los del hogar en lugar de lo que haya acá. Para enterarse aunque el motor no lo vea (no pudo leer su
 * estado, o la app se compiló sin el servidor), los datos llevan un id (Data.datasetId) que cambia con «Borrar todo» y
 * el ejemplo: si no es el de lo sincronizado, también se bajan los del hogar. Y una tanda que borraría casi todo el
 * hogar no se manda sin preguntar.
 */
import { useSyncExternalStore } from 'react';
import {
  cursorOf,
  hashData,
  localChanges,
  mergeRemote,
  pendingKeys,
  presentHashes,
  readShared,
  recordKey,
  replaceWithRemote,
  seenOf,
  syncable,
  type Hashes,
  type OutRecord,
  type RemoteRecord,
  type SharedSettings,
} from '../domain/sync';
import type { Data, Goal } from '../domain/types';
import { deleteFile, loadFile, loadSyncState, pruneFiles, saveFile, saveSyncState } from './db';
import { fakePhone } from './fakePhone';
import { createFakeRemote } from './fakeRemote';
import { createSupabaseRemote, isRemoteConfigured, RemoteError, type Household, type Member, type RemoteStore } from './remote';

/** Lo que el motor necesita de la app (el store y los archivos del teléfono) */
export interface SyncHost {
  getData(): Data;
  /** Aplica un cambio ya: getData lo devuelve enseguida */
  setData(fn: (d: Data) => Data): void;
  /** Guarda en el teléfono lo pendiente de los datos. Tira si no se pudo */
  saveData(): Promise<void>;
  loadFile(id: string): Promise<Blob | undefined>;
  saveFile(id: string, file: Blob): Promise<unknown>;
  deleteFile(id: string): Promise<void>;
  /** Borra los archivos de facturas que no están en `keep` */
  pruneFiles(keep: Set<string>): Promise<void>;
}

/** Dónde se guarda el estado del motor (IndexedDB, clave 'sync') */
export interface SyncStateStore {
  load(): Promise<unknown>;
  save(state: SyncState): Promise<unknown>;
}

export interface SyncState {
  v: 1;
  household: Household | null;
  userId: string | null;
  /** El updated_at más nuevo recibido (ms). Se pide desde un rato antes: lo que tardó en confirmarse no se pierde */
  cursor: number | null;
  /** Lo que tiene el servidor: hash de cada registro */
  synced: Hashes;
  /** Los ajustes del hogar que tiene el servidor (para mezclarlos con los de acá) */
  base?: SharedSettings;
  /** Lo ahorrado en cada meta según el servidor (para sumar los aportes de dos teléfonos a la vez) */
  goals?: Record<string, number>;
  /** Archivos de facturas: 'up' falta subirlo, 'del' falta borrarlo del servidor */
  files: Record<string, 'up' | 'del'>;
  /** Registros que el servidor no aceptó, con el hash rechazado: no se reintentan hasta que cambien */
  rejected: Hashes;
  /** Se borraron los datos (o se pasó al ejemplo) estando en el hogar: al volver a tener datos, se bajan los del hogar */
  reload: boolean;
  /** Los integrantes de la última vez: así se sabe quién anotó cada cosa también sin conexión */
  members?: Member[];
  /** De qué datos es lo sincronizado (Data.datasetId): si en el teléfono hay otros, se bajan los del hogar */
  datasetId?: string;
  /** Hasta qué hora del servidor (ms) ya se pidió: lo de antes no se vuelve a pedir (menos el rato de margen) */
  seen?: number;
}

/**
 * off: sin hogar. idle: al día. syncing: mandando o trayendo. offline: sin conexión (se reintenta). error: otro error
 * (se reintenta). paused: la bienvenida o el ejemplo, no se sincroniza. held: lo de acá borraría casi todo el hogar y
 * espera que la persona diga qué hacer (resolveHeld). removed: ya no es miembro del hogar (o se perdió la sesión)
 */
export type SyncPhase = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'paused' | 'held' | 'removed';

export interface SyncStatus {
  /** Hay un proyecto de Supabase configurado (si no, no hay hogar compartido) */
  configured: boolean;
  /** Ya se leyó del teléfono si hay hogar (antes, `household` null no quiere decir que no haya) */
  loaded: boolean;
  household: Household | null;
  /** El usuario de este teléfono (para Movement.createdBy) */
  userId: string | null;
  members: Member[];
  phase: SyncPhase;
  /** Cambios de acá todavía sin mandar */
  pending: number;
  /** Registros que el servidor no aceptó */
  rejected: number;
  /** Se borró todo o se pasó al ejemplo: al volver a los datos, se bajan los del hogar (lo de acá no se manda) */
  reload: boolean;
  /** Fase 'held': cuántas cosas del hogar borraría lo de acá */
  held: number;
  lastSyncAt: number | null;
  error: string | null;
}

export type SyncErrorKind = 'unavailable' | 'in-household' | 'no-household' | 'example' | 'not-ready' | 'storage' | 'files' | 'removed';

/** Algo que no se puede hacer (las fallas del servidor llegan como RemoteError). `count`: con 'files', cuántos archivos */
export class SyncError extends Error {
  constructor(readonly kind: SyncErrorKind, message: string, readonly count = 0) {
    super(message);
    this.name = 'SyncError';
  }
}

/** Lo que dice el estado cuando el teléfono perdió su sesión (para el servidor sería otra persona) */
export const LOST_SESSION = 'Este teléfono perdió su acceso al hogar';

export interface SyncOptions {
  debounceMs?: number;
  pollMs?: number;
  /** Espera después de un aviso de Realtime (llegan varios juntos) */
  realtimeMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  /** Volver a la app y recuperar la conexión (en las pruebas no hay ventana) */
  listenWindow?: boolean;
  now?: () => number;
}

/** De a cuántos registros se mandan */
export const CHUNK = 500;
/** Se pide desde un rato antes de lo último recibido: un envío que tardó en confirmarse puede tener una hora anterior */
export const OVERLAP_MS = 15_000;
/** Una tanda con al menos tantas lápidas, que borra el 80 % o más de lo del hogar, se frena y se pregunta (fase 'held') */
export const BIG_DELETE = 20;

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const emptyState = (userId: string | null = null): SyncState => ({
  v: 1,
  household: null,
  userId,
  cursor: null,
  synced: {},
  files: {},
  rejected: {},
  reload: false,
});

const isMember = (m: unknown): m is Member => {
  const x = m as Partial<Member> | null;
  return !!x && typeof x.userId === 'string' && typeof x.joinedAt === 'string' && (x.displayName === null || typeof x.displayName === 'string');
};

const strings = (m: unknown): Hashes =>
  m && typeof m === 'object' ? Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

/** Lo guardado (o nada, o de otra versión) como un estado que sirve */
export function normalizeSyncState(raw: unknown): SyncState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const r = raw as Partial<Record<keyof SyncState, unknown>>;
  const userId = typeof r.userId === 'string' ? r.userId : null;
  const h = r.household as Partial<Household> | null | undefined;
  if (!h || typeof h.id !== 'string' || typeof h.name !== 'string' || typeof h.inviteCode !== 'string') return emptyState(userId);
  const shared = readShared(r.base);
  const members = Array.isArray(r.members) ? r.members.filter(isMember).map(({ userId, displayName, joinedAt }) => ({ userId, displayName, joinedAt })) : [];
  return {
    v: 1,
    household: { id: h.id, name: h.name, inviteCode: h.inviteCode },
    userId,
    cursor: typeof r.cursor === 'number' && Number.isFinite(r.cursor) ? r.cursor : null,
    synced: strings(r.synced),
    ...(shared?.currency && shared.learned ? { base: shared as SharedSettings } : {}),
    files: Object.fromEntries(Object.entries(strings(r.files)).filter((e): e is [string, 'up' | 'del'] => e[1] === 'up' || e[1] === 'del')),
    rejected: strings(r.rejected),
    reload: r.reload === true,
    ...(members.length ? { members } : {}),
    ...(typeof r.datasetId === 'string' && r.datasetId ? { datasetId: r.datasetId } : {}),
    ...(r.goals && typeof r.goals === 'object'
      ? { goals: Object.fromEntries(Object.entries(r.goals).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))) }
      : {}),
    ...(typeof r.seen === 'number' && Number.isFinite(r.seen) ? { seen: r.seen } : {}),
  };
}

/** Anota lo ahorrado de cada meta según el servidor (null: se borró). true si cambió algo */
function setGoalBases(state: SyncState, bases: Record<string, number | null>): boolean {
  let changed = false;
  for (const [id, saved] of Object.entries(bases)) {
    if ((state.goals?.[id] ?? null) === saved) continue;
    state.goals ??= {};
    if (saved === null) delete state.goals[id];
    else state.goals[id] = saved;
    changed = true;
  }
  return changed;
}

interface PushItem {
  key: string;
  hash: string;
  rec: OutRecord;
}

export class SyncEngine {
  private state = emptyState();
  private status: SyncStatus = {
    configured: true,
    loaded: false,
    household: null,
    userId: null,
    members: [],
    phase: 'off',
    pending: 0,
    rejected: 0,
    reload: false,
    held: 0,
    lastSyncAt: null,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private loading: Promise<boolean> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private realtimeTimer?: ReturnType<typeof setTimeout>;
  private detachFns: (() => void)[] = [];
  private failures = 0;
  private running = false;
  /** Se aplicó algo recibido que todavía no se guardó en el teléfono (se guarda antes que el estado) */
  private dataDirty = false;
  /** La persona confirmó un reemplazo (restaurar, la planilla) o dijo «Borrar igual»: la próxima tanda puede borrar mucho */
  private bigDeleteOk = false;
  private readonly o: Required<SyncOptions>;

  constructor(
    readonly remote: RemoteStore,
    private host: SyncHost,
    private readonly store: SyncStateStore,
    opts: SyncOptions = {},
  ) {
    this.o = {
      debounceMs: 1500,
      pollMs: 60_000,
      realtimeMs: 300,
      retryMs: 2000,
      maxRetryMs: 5 * 60_000,
      listenWindow: typeof window !== 'undefined' && typeof document !== 'undefined',
      now: Date.now,
      ...opts,
    };
  }

  getStatus = (): SyncStatus => this.status;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** El estado guardado (para las pruebas y para mirar desde la consola) */
  get snapshot(): SyncState {
    return structuredClone(this.state);
  }

  setHost(host: SyncHost): void {
    this.host = host;
  }

  /** Al abrir: lee el estado y, si hay hogar, trae y manda lo pendiente */
  async start(): Promise<void> {
    this.running = true;
    if (!(await this.ensureLoaded())) {
      // No se pudo leer el estado (IndexedDB): se vuelve a probar en un rato
      if (this.running) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.start(), this.o.retryMs * 5);
      }
      return;
    }
    if (!this.running) return;
    if (this.state.household) {
      this.attach();
      await this.syncNow();
      void this.refreshMembers().catch(() => {});
    }
  }

  /** Deja de escuchar y de programar (lo que esté en curso termina) */
  stop(): void {
    this.running = false;
    this.detach();
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.realtimeTimer);
    this.debounceTimer = undefined;
  }

  /**
   * Cambiaron los datos (el store avisa enseguida, en cada cambio): dentro de un rato se manda lo que haya. «Borrar todo»
   * o el ejemplo se anotan ya: lo que venga después (la plantilla, un respaldo) no se toma como cambios para el hogar
   */
  dataChanged(): void {
    // Sin el estado leído no se sabe si hay hogar: se lee y se vuelve a mirar (un «Borrar todo» no se puede escapar)
    if (!this.status.loaded) {
      void this.ensureLoaded().then((ok) => {
        if (!ok || !this.state.household) return;
        if (this.running && !this.detachFns.length) this.attach();
        this.dataChanged();
      });
      return;
    }
    if (!this.state.household) return;
    const data = this.host.getData();
    if (!syncable(data) || this.otherDataset(data)) {
      if (!this.state.reload) {
        this.state.reload = true;
        this.store.save(this.state).catch((e) => console.warn('Hogar compartido: no se pudo guardar su estado', e));
      }
      if (this.status.phase !== 'removed') this.setStatus({ phase: 'paused', pending: 0, rejected: 0, held: 0, reload: true });
    }
    if (!this.running) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      const counts = this.counts();
      this.setStatus(counts);
      // Con datos propios otra vez después de «Borrar todo» o del ejemplo: se bajan los del hogar
      if (counts.pending > 0 || (this.state.reload && syncable(this.host.getData()))) void this.syncNow();
    }, this.o.debounceMs);
  }

  /**
   * En pausa (la pantalla de bloqueo): deja de escuchar y de programar, como stop. Lo que esperaba la espera de 1,5 s se
   * manda ya (puede ser que la app pase a segundo plano). Se sigue con start
   */
  pause(): void {
    const waiting = this.debounceTimer !== undefined;
    this.stop();
    if (waiting) void this.syncNow();
  }

  /** Manda lo pendiente y trae lo nuevo. Nunca tira: cómo salió queda en el estado (getStatus) */
  syncNow(): Promise<void> {
    this.queued ??= this.exclusive(async () => {
      this.queued = null;
      await this.cycle();
    });
    return this.queued;
  }

  /** Crea un hogar con lo de este teléfono (se manda todo, con los archivos) */
  async createHousehold(name: string, displayName: string | null): Promise<Household> {
    await this.loadedOrThrow();
    return this.exclusive(async () => {
      if (this.state.household && this.status.phase !== 'removed') throw new SyncError('in-household', 'Ya estás en un hogar');
      const data = this.host.getData();
      if (!syncable(data)) {
        throw data.settings.example
          ? new SyncError('example', 'Con los datos de ejemplo no se puede crear un hogar')
          : new SyncError('not-ready', 'Primero empezá con tus datos');
      }
      const { userId } = await this.remote.session({ create: true });
      const hh = await this.remote.createHousehold(name, displayName);
      this.state = { ...emptyState(userId), household: hh, ...(data.datasetId ? { datasetId: data.datasetId } : {}) };
      await this.save();
      this.setStatus({ household: hh, userId, members: [], error: null, phase: 'idle', reload: false, held: 0 });
      this.attach();
      await this.cycle();
      await this.refreshMembers().catch(() => {});
      return hh;
    });
  }

  /**
   * Se une al hogar del código. Lo de acá se reemplaza por lo del hogar (de acá quedan el nombre y la clave de Claude);
   * con `keepLocal`, lo de acá se suma al hogar. Tira RemoteError('invalid-code') si el código no es de ningún hogar;
   * si no se pudo bajar lo del hogar, tira y no cambia nada (unirse de nuevo no duplica)
   */
  async joinHousehold(code: string, displayName: string | null, opts: { keepLocal?: boolean } = {}): Promise<Household> {
    await this.loadedOrThrow();
    return this.exclusive(async () => {
      if (this.state.household && this.status.phase !== 'removed') throw new SyncError('in-household', 'Ya estás en un hogar');
      const { userId } = await this.remote.session({ create: true });
      const hh = await this.remote.joinHousehold(code, displayName);
      const remote = await this.remote.pull(hh.id, null);
      this.detach();
      const data = this.host.getData();
      this.state = { ...emptyState(userId), household: hh };
      if (opts.keepLocal && syncable(data)) {
        if (data.datasetId) this.state.datasetId = data.datasetId;
        await this.applyRemote(remote);
      } else await this.replaceLocal(remote);
      this.setStatus({ household: hh, userId, members: [], error: null, phase: 'idle', reload: false, held: 0 });
      this.attach();
      await this.cycle();
      await this.refreshMembers().catch(() => {});
      return hh;
    });
  }

  /**
   * Sale del hogar. Antes manda lo pendiente (si puede), sube los archivos que faltaban y baja los de las facturas que
   * este teléfono nunca abrió: lo de acá queda como copia propia, con sus fotos y PDF. Si era el último miembro, el
   * hogar se borra del servidor. Sin conexión tira y no cambia nada. Si algún archivo no baja, tira SyncError('files')
   * sin salir; con `force`, sale igual. Con «Borrar todo» o el ejemplo puestos no sale (lo del hogar no está acá).
   * Si ya no era miembro, solo se olvida el hogar (también sin conexión)
   */
  async leave(opts: { force?: boolean } = {}): Promise<void> {
    await this.loadedOrThrow();
    return this.exclusive(async () => {
      const hh = this.state.household;
      if (!hh) return;
      if (this.status.phase === 'removed') {
        await this.remote.leave(hh.id).catch((e) => console.warn('Hogar compartido: no se pudo avisar la salida', e));
      } else {
        if (this.state.reload) throw new SyncError('not-ready', 'Primero volvé a tus datos: al volver, se bajan los del hogar');
        await this.pushChanges(hh).catch((e) => {
          if (e instanceof RemoteError && e.kind === 'offline') throw e;
          console.warn('Hogar compartido: no se pudo mandar lo último', e);
        });
        // Un archivo que no se llegó a subir: después de salir, los demás no lo tendrían nunca
        await this.syncFiles(hh);
        const failed = await this.fetchMissingFiles(hh);
        if (failed > 0 && !opts.force) {
          throw new SyncError('files', failed === 1 ? 'No se pudo bajar un archivo' : `No se pudieron bajar ${failed} archivos`, failed);
        }
        await this.remote.leave(hh.id);
      }
      this.detach();
      clearTimeout(this.retryTimer);
      clearTimeout(this.debounceTimer);
      this.failures = 0;
      this.state = emptyState(this.state.userId);
      await this.save();
      this.setStatus({ household: null, members: [], phase: 'off', pending: 0, rejected: 0, reload: false, held: 0, error: null });
    });
  }

  /**
   * «Volver a los datos del hogar» (en la bienvenida, después de «Borrar todo» o del ejemplo): los baja ya, en lugar de
   * lo que haya acá. Sin conexión tira y no cambia nada
   */
  async reloadNow(): Promise<void> {
    await this.loadedOrThrow();
    return this.exclusive(async () => {
      const hh = this.requireHousehold();
      if (this.status.phase === 'removed') throw new SyncError('removed', 'Ya no estás en este hogar');
      await this.ensureSession().catch((e) => {
        if (e instanceof RemoteError && e.kind === 'session') {
          this.detach();
          this.setStatus({ phase: 'removed', members: [], error: LOST_SESSION });
        }
        throw e;
      });
      if (!(await this.stillMember(hh))) throw new SyncError('removed', 'Ya no estás en este hogar');
      await this.replaceLocal(await this.remote.pull(hh.id, null));
      this.failures = 0;
      this.setStatus({ phase: 'idle', error: null, lastSyncAt: this.o.now(), ...this.counts() });
      if (this.running) this.attach();
    });
  }

  /**
   * Lo de acá borraría casi todo el hogar (fase 'held'): 'send' lo manda igual; 'reload' lo descarta y baja los datos
   * del hogar
   */
  async resolveHeld(choice: 'send' | 'reload'): Promise<void> {
    await this.loadedOrThrow();
    if (choice === 'send') this.bigDeleteOk = true;
    else if (this.state.household && !this.state.reload) {
      this.state.reload = true;
      await this.save();
    }
    this.setStatus({ held: 0 });
    await this.syncNow();
  }

  /** Antes de un reemplazo que la persona confirmó (restaurar un respaldo, la planilla): puede borrar mucho del hogar */
  allowBigDelete(): void {
    this.bigDeleteOk = true;
  }

  /** Código de invitación nuevo (el anterior deja de servir) */
  async regenerateCode(): Promise<string> {
    await this.loadedOrThrow();
    return this.exclusive(async () => {
      const hh = this.requireHousehold();
      const code = await this.remote.regenerateCode(hh.id);
      await this.updateHousehold({ ...hh, inviteCode: code });
      return code;
    });
  }

  /** Los miembros (y el nombre y el código del hogar al día). Si ya no es miembro, pasa a 'removed' */
  async refreshMembers(): Promise<Member[]> {
    await this.loadedOrThrow();
    const hh = this.state.household;
    if (!hh) return [];
    const [members, fresh] = await Promise.all([this.remote.members(hh.id), this.remote.household(hh.id)]);
    if (this.state.household?.id !== hh.id) return members;
    if (!fresh) {
      this.detach();
      this.setStatus({ phase: 'removed', members: [], error: 'Ya no estás en este hogar' });
      return [];
    }
    await this.updateHousehold(fresh);
    if (JSON.stringify(members) !== JSON.stringify(this.state.members ?? [])) {
      this.state.members = members;
      await this.save();
    }
    this.setStatus({ members });
    return members;
  }

  /** Saca a otro integrante (un teléfono que ya no se usa). A uno mismo no: para eso es leave */
  async removeMember(userId: string): Promise<void> {
    await this.loadedOrThrow();
    const hh = this.requireHousehold();
    if (userId === this.state.userId) throw new SyncError('not-ready', 'Para irte vos, tocá «Salir del hogar»');
    await this.remote.removeMember(hh.id, userId);
    await this.refreshMembers();
  }

  /** El nombre con el que te ven los demás */
  async setDisplayName(name: string | null): Promise<void> {
    await this.loadedOrThrow();
    await this.remote.setDisplayName(this.requireHousehold().id, name);
    await this.refreshMembers();
  }

  async renameHousehold(name: string): Promise<void> {
    await this.loadedOrThrow();
    await this.remote.renameHousehold(this.requireHousehold().id, name);
    await this.refreshMembers();
  }

  /**
   * El archivo de una factura o un estado de cuenta: el del teléfono o, en un hogar, el del servidor (la primera vez se
   * baja y queda guardado). undefined si no está en ningún lado. Sin conexión tira RemoteError('offline')
   */
  async loadInvoiceFile(id: string): Promise<Blob | undefined> {
    const local = await this.host.loadFile(id);
    if (local) return local;
    await this.ensureLoaded();
    const hh = this.state.household;
    if (!hh) return undefined;
    const blob = await this.remote.downloadFile(hh.id, id);
    if (!blob) return undefined;
    await this.host.saveFile(id, blob).catch((e) => console.warn('No se pudo guardar el archivo bajado', e));
    return blob;
  }

  // ---------------------------------------------------------------------------

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }

  private ensureLoaded(): Promise<boolean> {
    this.loading ??= this.store.load().then(
      (raw) => {
        this.state = normalizeSyncState(raw);
        this.setStatus({
          loaded: true,
          household: this.state.household,
          userId: this.state.userId,
          members: this.state.members ?? [],
          phase: this.state.household ? 'idle' : 'off',
          reload: this.state.reload,
        });
        return true;
      },
      (e) => {
        console.warn('Hogar compartido: no se pudo leer su estado', e);
        this.loading = null;
        this.setStatus({ phase: 'error', error: 'No se pudo leer el estado del hogar compartido en el teléfono' });
        return false;
      },
    );
    return this.loading;
  }

  private async loadedOrThrow(): Promise<void> {
    if (!(await this.ensureLoaded())) throw new SyncError('storage', 'No se pudo leer el estado del hogar compartido en el teléfono');
  }

  private requireHousehold(): Household {
    if (!this.state.household) throw new SyncError('no-household', 'No estás en un hogar');
    return this.state.household;
  }

  private async updateHousehold(hh: Household): Promise<void> {
    const cur = this.state.household;
    if (!cur || cur.id !== hh.id) return;
    if (cur.name !== hh.name || cur.inviteCode !== hh.inviteCode) {
      this.state.household = { id: hh.id, name: hh.name, inviteCode: hh.inviteCode };
      await this.save();
    }
    this.setStatus({ household: this.state.household });
  }

  /** De a una: lo que cambia el estado (sincronizar, unirse, salir) no se pisa */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(() => fn());
    this.lock = run.catch(() => {});
    return run;
  }

  /** Primero los datos (si quedó algo recibido sin guardar), después el estado: si se corta, se vuelve a recibir */
  private async save(): Promise<void> {
    if (this.dataDirty) {
      await this.host.saveData();
      this.dataDirty = false;
    }
    await this.store.save(this.state);
  }

  private attach(): void {
    this.detach();
    const hh = this.state.household;
    if (!hh) return;
    const unsub = this.remote.subscribe(hh.id, (what, by) => {
      // Lo que mandó este teléfono ya está acá
      if (what === 'records' && by && by === this.state.userId) return;
      if (what === 'records') {
        clearTimeout(this.realtimeTimer);
        this.realtimeTimer = setTimeout(() => void this.syncNow(), this.o.realtimeMs);
      } else void this.refreshMembers().catch(() => {});
    });
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const poll = setInterval(() => !hidden() && void this.syncNow(), this.o.pollMs);
    this.detachFns.push(unsub, () => clearInterval(poll));
    if (this.o.listenWindow) {
      const onVisibility = () => {
        if (!hidden()) {
          void this.syncNow();
          void this.refreshMembers().catch(() => {});
        } else if (this.debounceTimer) {
          // Se va a segundo plano con algo sin mandar: ya (iOS puede suspender la app)
          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;
          void this.syncNow();
        }
      };
      const onOnline = () => {
        this.failures = 0;
        void this.syncNow();
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('online', onOnline);
      this.detachFns.push(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('online', onOnline);
      });
    }
  }

  private detach(): void {
    for (const off of this.detachFns.splice(0)) off();
    clearTimeout(this.realtimeTimer);
  }

  private counts(): { pending: number; rejected: number } {
    // Lo de acá no se va a mandar: se reemplaza por lo del hogar
    if (this.state.reload) return { pending: 0, rejected: 0 };
    const diff = localChanges(this.state.synced, this.host.getData());
    let pending = diff.deleted.length;
    let rejected = 0;
    for (const c of diff.changed) {
      if (this.state.rejected[c.key] === c.hash) rejected++;
      else pending++;
    }
    return { pending, rejected };
  }

  private async cycle(): Promise<void> {
    if (!(await this.ensureLoaded())) return;
    const hh = this.state.household;
    if (!hh || this.status.phase === 'removed') return;
    try {
      // Con la bienvenida o el ejemplo ni se le habla al servidor
      if (!(await this.gate())) return;
      this.setStatus({ phase: 'syncing' });
      await this.ensureSession();
      if (this.state.reload) {
        // Quien ya no es miembro recibiría un hogar vacío: antes de reemplazar nada, ¿sigue siendo miembro?
        if (!(await this.stillMember(hh))) return;
        await this.replaceLocal(await this.remote.pull(hh.id, null));
      } else {
        // Primero lo de los demás: así los ajustes cambiados en los dos lados se mezclan antes de mandar los de acá
        await this.pullChanges(hh);
        const held = await this.pushChanges(hh);
        if (held) {
          this.failures = 0;
          this.setStatus({ phase: 'held', held, error: null, ...this.counts() });
          return;
        }
        // Un archivo que no sube no frena lo demás: se reintenta con el resto
        await this.syncFiles(hh);
      }
      this.failures = 0;
      clearTimeout(this.retryTimer);
      this.setStatus({ phase: 'idle', error: null, lastSyncAt: this.o.now(), reload: this.state.reload, held: 0, ...this.counts() });
    } catch (e) {
      await this.fail(e);
    }
  }

  /** La sesión de siempre: estando en un hogar no se crea otra (sería otra persona para el servidor) */
  private async ensureSession(): Promise<void> {
    const { userId } = await this.remote.session({ create: !this.state.household });
    if (userId !== this.state.userId) {
      this.state.userId = userId;
      await this.save();
      this.setStatus({ userId });
    }
  }

  /**
   * Con la bienvenida o el ejemplo no se sincroniza; al volver a tener datos propios, se bajan los del hogar. También si
   * los datos son otros que los sincronizados (Data.datasetId: «Borrar todo» mientras el motor no miraba)
   */
  private async gate(): Promise<boolean> {
    const data = this.host.getData();
    if (syncable(data)) {
      const other = this.otherDataset(data);
      if (other && !this.state.reload) {
        console.warn('Hogar compartido: los datos del teléfono no son los sincronizados; se bajan los del hogar');
        this.state.reload = true;
        await this.save();
      } else if (!other && data.datasetId && !this.state.datasetId && !this.state.reload) {
        this.state.datasetId = data.datasetId;
        await this.save();
      }
      return true;
    }
    if (!this.state.reload) {
      this.state.reload = true;
      await this.save();
    }
    this.setStatus({ phase: 'paused', pending: 0, rejected: 0, held: 0, reload: true });
    return false;
  }

  /** Los datos del teléfono no son de los que habla lo sincronizado (si alguno no tiene id, no se sabe: no cuenta) */
  private otherDataset(data: Data): boolean {
    return !!data.datasetId && !!this.state.datasetId && data.datasetId !== this.state.datasetId;
  }

  /** ¿Sigue siendo miembro? Si no, pasa a 'removed' (sin tocar nada) */
  private async stillMember(hh: Household): Promise<boolean> {
    if (await this.remote.household(hh.id)) return true;
    this.detach();
    this.setStatus({ phase: 'removed', members: [], error: 'Ya no estás en este hogar' });
    return false;
  }

  /**
   * Antes de salir: los archivos de las facturas que este teléfono nunca abrió (después ya no se pueden bajar). Sin
   * conexión tira; devuelve cuántos no se pudieron bajar por otra falla (los que no están en el servidor no cuentan)
   */
  private async fetchMissingFiles(hh: Household): Promise<number> {
    let failed = 0;
    for (const inv of this.host.getData().invoices) {
      if (await this.host.loadFile(inv.id)) continue;
      try {
        const blob = await this.remote.downloadFile(hh.id, inv.id);
        if (blob) await this.host.saveFile(inv.id, blob);
      } catch (e) {
        if (e instanceof RemoteError && e.kind === 'offline') throw e;
        console.warn('Hogar compartido: no se pudo bajar el archivo', inv.id, e);
        failed++;
      }
    }
    return failed;
  }

  /** Los movimientos nuevos llevan quién los anotó (los recibidos ya lo traen, o no se les inventa) */
  private stampMovements(): void {
    const me = this.state.userId;
    const synced = this.state.synced;
    const fresh = (m: Data['movements'][number]) => !m.createdBy && !has(synced, recordKey('movement', m.id));
    const data = this.host.getData();
    if (!me || !syncable(data) || !data.movements.some(fresh)) return;
    this.host.setData((d) => ({ ...d, movements: d.movements.map((m) => (fresh(m) ? { ...m, createdBy: me } : m)) }));
  }

  /** Manda lo de acá. Devuelve cuántas lápidas quedaron frenadas por la red de seguridad (0: se mandó todo) */
  private async pushChanges(hh: Household): Promise<number> {
    // Hay que bajar todo de nuevo: lo de acá no es del hogar
    if (this.state.reload) return 0;
    this.stampMovements();
    // Lo que se manda ya está guardado en el teléfono (si no, al reabrir se volvería a mandar lo de antes)
    await this.host.saveData();
    this.dataDirty = false;
    const diff = localChanges(this.state.synced, this.host.getData());
    // Red de seguridad: borrar casi todo el hogar de una vez (unos datos que no son los del hogar, sin que el motor se
    // enterara) no se manda sin preguntar. Restaurar o la planilla, ya confirmados, avisan antes (allowBigDelete)
    const total = Object.keys(this.state.synced).length;
    if (!this.bigDeleteOk && diff.deleted.length >= BIG_DELETE && diff.deleted.length >= total * 0.8) return diff.deleted.length;
    const items: PushItem[] = [
      ...diff.changed.map(({ key, hash, kind, id, data }) => ({ key, hash, rec: { kind, id, data, deleted: false } })),
      ...diff.deleted.map(({ key, kind, id }) => ({ key, hash: '-', rec: { kind, id, data: {}, deleted: true } })),
    ].filter((x) => this.state.rejected[x.key] !== x.hash);
    if (!items.length) return 0;
    // «Enviando 3 cambios…»
    this.setStatus({ pending: items.length });
    // Los archivos de las facturas nuevas se suben; los de las borradas, se borran del servidor
    for (const c of diff.changed) if (c.kind === 'invoice' && !has(this.state.synced, c.key)) this.state.files[c.id] ??= 'up';
    for (const d of diff.deleted) if (d.kind === 'invoice') this.state.files[d.id] = 'del';
    for (let i = 0; i < items.length; i += CHUNK) await this.pushChunk(hh, items.slice(i, i + CHUNK));
    this.bigDeleteOk = false;
    return 0;
  }

  private async pushChunk(hh: Household, chunk: PushItem[]): Promise<void> {
    try {
      await this.remote.push(hh.id, chunk.map((x) => x.rec));
    } catch (e) {
      if (!(e instanceof RemoteError) || e.kind !== 'rejected') throw e;
      if (chunk.length === 1) {
        console.warn('Hogar compartido: el servidor no aceptó', chunk[0].key, e);
        this.state.rejected[chunk[0].key] = chunk[0].hash;
        await this.save();
        return;
      }
      // Por mitades, para que uno roto no frene a los demás
      const half = Math.ceil(chunk.length / 2);
      await this.pushChunk(hh, chunk.slice(0, half));
      await this.pushChunk(hh, chunk.slice(half));
      return;
    }
    for (const x of chunk) {
      if (x.rec.deleted) delete this.state.synced[x.key];
      else this.state.synced[x.key] = x.hash;
      delete this.state.rejected[x.key];
      if (x.rec.kind === 'settings') this.state.base = x.rec.data as SharedSettings;
      if (x.rec.kind === 'goal') setGoalBases(this.state, { [x.rec.id]: x.rec.deleted ? null : (x.rec.data as Goal).saved });
    }
    await this.save();
  }

  private async syncFiles(hh: Household): Promise<void> {
    for (const [id, op] of Object.entries(this.state.files)) {
      if (op === 'up') {
        const file = await this.host.loadFile(id);
        // Sin el archivo en el teléfono no hay nada que subir. Uno que el servidor no acepta (muy grande) no se reintenta
        if (file) {
          await this.remote.uploadFile(hh.id, id, file).catch((e) => {
            if (!(e instanceof RemoteError && e.kind === 'rejected')) throw e;
            console.warn('Hogar compartido: el servidor no aceptó el archivo', id, e);
          });
        }
      } else await this.remote.deleteFile(hh.id, id);
      delete this.state.files[id];
      await this.save();
    }
  }

  private async pullChanges(hh: Household): Promise<void> {
    // Desde lo último recibido o, si ya se pidió más tarde, desde esa hora del servidor (con margen): un envío grande
    // no se vuelve a bajar entero en cada vuelta
    const { cursor, seen } = this.state;
    const from = cursor === null ? seen ?? null : Math.max(cursor, seen ?? cursor);
    const since = from === null ? null : new Date(from - OVERLAP_MS).toISOString();
    const remote = await this.remote.pull(hh.id, since);
    if (remote.length) await this.applyRemote(remote);
  }

  /** Aplica lo recibido sin pisar lo de acá sin mandar, y anota qué tiene el servidor */
  private async applyRemote(remote: RemoteRecord[]): Promise<void> {
    const data = this.host.getData();
    // Mientras tanto se borró todo o se pasó al ejemplo: no se toca nada (al volver se baja todo)
    if (!syncable(data) || this.state.reload) return;
    const { synced, base, goals } = this.state;
    const merge = (d: Data) => mergeRemote(d, remote, pendingKeys(localChanges(synced, d)), { base, goals });
    const res = merge(data);
    let changed = false;
    if (res.data !== data) {
      this.host.setData((prev) => (prev === data ? res.data : merge(prev).data));
      this.dataDirty = true;
      changed = true;
    }
    for (const [k, h] of Object.entries(res.hashes)) {
      if ((this.state.synced[k] ?? null) === h) continue;
      if (h === null) delete this.state.synced[k];
      else this.state.synced[k] = h;
      changed = true;
    }
    if (res.base && hashData(res.base) !== hashData(this.state.base ?? null)) {
      this.state.base = res.base;
      changed = true;
    }
    if (setGoalBases(this.state, res.goalBases)) changed = true;
    const cursor = cursorOf(remote, this.state.cursor);
    const seen = seenOf(remote, this.state.seen);
    if (cursor !== this.state.cursor || seen !== this.state.seen) changed = true;
    this.state.cursor = cursor;
    if (seen !== undefined) this.state.seen = seen;
    // Lo mismo que ya estaba (el margen trae de nuevo lo último): no se guarda nada
    if (changed) await this.save();
    // Las facturas que borró otro: también su archivo de este teléfono
    for (const id of res.removedInvoices) {
      delete this.state.files[id];
      await this.host.deleteFile(id).catch(() => {});
    }
  }

  /** Lo del hogar en lugar de lo de acá (al unirse, o después de «Borrar todo» o el ejemplo) */
  private async replaceLocal(remote: RemoteRecord[]): Promise<void> {
    const res = replaceWithRemote(remote, this.host.getData());
    this.host.setData(() => res.data);
    this.dataDirty = true;
    const seen = seenOf(remote, undefined);
    this.state = {
      ...this.state,
      cursor: cursorOf(remote, null),
      synced: presentHashes(res.hashes),
      base: res.base,
      files: {},
      rejected: {},
      reload: false,
      ...(res.data.datasetId ? { datasetId: res.data.datasetId } : {}),
      goals: {},
    };
    setGoalBases(this.state, res.goalBases);
    if (seen !== undefined) this.state.seen = seen;
    else delete this.state.seen;
    this.setStatus({ reload: false, held: 0 });
    await this.save();
    await this.host.pruneFiles(new Set(res.data.invoices.map((i) => i.id))).catch((e) => console.warn('No se pudieron borrar los archivos de antes', e));
  }

  private async fail(e: unknown): Promise<void> {
    const kind = e instanceof RemoteError ? e.kind : 'other';
    // Sin sesión estando en un hogar: no se crea otra (sería otra persona); hay que entrar de nuevo con el código
    if (kind === 'session') {
      this.detach();
      this.setStatus({ phase: 'removed', members: [], error: LOST_SESSION });
      return;
    }
    // Sin permiso: ¿sigue siendo miembro? (null: no)
    if (kind === 'denied') {
      const hh = this.state.household;
      const still = hh ? await this.remote.household(hh.id).catch(() => undefined) : undefined;
      if (still === null) {
        this.detach();
        this.setStatus({ phase: 'removed', members: [], error: 'Ya no estás en este hogar' });
        return;
      }
    }
    if (kind !== 'offline') console.warn('Hogar compartido: no se pudo sincronizar', e);
    this.failures++;
    if (this.running) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => void this.syncNow(), Math.min(this.o.retryMs * 2 ** (this.failures - 1), this.o.maxRetryMs));
    }
    this.setStatus({ phase: kind === 'offline' ? 'offline' : 'error', error: e instanceof Error ? e.message : String(e), ...this.counts() });
  }
}

// --- El motor de la app (uno solo) y lo que usan las pantallas ---

let engine: SyncEngine | null = null;
const OFF: SyncStatus = {
  configured: false, loaded: false, household: null, userId: null, members: [], phase: 'off', pending: 0, rejected: 0, reload: false, held: 0, lastSyncAt: null, error: null,
};
const statusListeners = new Set<() => void>();
/** La pantalla de bloqueo está puesta (holdSync): el motor no arranca ni sigue hasta que se saque */
let held = false;
let started = false;

/**
 * Lo engancha el store cuando los datos ya se leyeron. Sin Supabase configurado (o en la vista previa) no hace nada.
 * Con VITE_FAKE_REMOTE=1 (solo para probar en el navegador) usa el servidor de mentira de lib/fakeRemote.
 * Devuelve cómo pararlo
 */
export function startSync(host: Pick<SyncHost, 'getData' | 'setData' | 'saveData'> & Partial<SyncHost>): () => void {
  if (!isRemoteConfigured()) return () => {};
  const full: SyncHost = { loadFile, saveFile, deleteFile, pruneFiles, ...host };
  if (!engine) {
    engine = new SyncEngine(fakePhone ? createFakeRemote(fakePhone) : createSupabaseRemote(), full, { load: loadSyncState, save: saveSyncState });
    engine.subscribe(() => statusListeners.forEach((l) => l()));
  } else engine.setHost(full);
  const e = engine;
  started = true;
  if (!held) void e.start();
  return () => {
    started = false;
    e.stop();
  };
}

/**
 * Mientras está la pantalla de bloqueo (Face ID) el hogar no trae ni manda nada (lo que esperaba para mandarse, se manda
 * ya); al sacarla, se pone al día. La pone LockGate antes de que arranque el motor, así al abrir bloqueada no sale nada
 */
export function holdSync(on: boolean): void {
  if (held === on) return;
  held = on;
  if (!engine || !started) return;
  if (on) engine.pause();
  else void engine.start();
}

/** El store avisa cada vez que cambian los datos */
export const notifyDataChanged = (): void => engine?.dataChanged();

export const getSyncStatus = (): SyncStatus => engine?.getStatus() ?? OFF;

const subscribeStatus = (l: () => void) => {
  statusListeners.add(l);
  return () => statusListeners.delete(l);
};

/** El estado del hogar compartido para las pantallas */
export const useSync = (): SyncStatus => useSyncExternalStore(subscribeStatus, getSyncStatus);

/** Quién anotó cada movimiento: el usuario de este teléfono y el nombre de los demás integrantes */
export interface Authors {
  me: string | null;
  /** Solo en un hogar: sin hogar (o después de salir) no se dice quién anotó */
  inHousehold: boolean;
  names: ReadonlyMap<string, string>;
}
let authors: { from: SyncStatus['members']; me: string | null; hh: string | null; value: Authors } | null = null;
const getAuthors = (): Authors => {
  const s = getSyncStatus();
  const hh = s.household?.id ?? null;
  if (!authors || authors.from !== s.members || authors.me !== s.userId || authors.hh !== hh) {
    const names = new Map(s.members.flatMap((m) => (m.displayName ? [[m.userId, m.displayName] as const] : [])));
    authors = { from: s.members, me: s.userId, hh, value: { me: s.userId, inHousehold: hh !== null, names } };
  }
  return authors.value;
};

/** Para las filas de movimientos: cambia solo si cambian los integrantes (no con cada vuelta de la sincronización) */
export const useAuthors = (): Authors => useSyncExternalStore(subscribeStatus, getAuthors);

/**
 * «Anotado por Ana» si lo anotó otra persona del hogar (con nombre, o «otra persona» si ya no está o no puso nombre);
 * null si lo anotaste vos, si no se sabe o si no hay hogar
 */
export function authorLabel(a: Authors, createdBy: string | undefined): string | null {
  if (!a.inHousehold || !createdBy || !a.me || createdBy === a.me) return null;
  return `Anotado por ${a.names.get(createdBy) ?? 'otra persona'}`;
}

const need = (): SyncEngine => {
  if (!engine) throw new SyncError('unavailable', 'El hogar compartido no está configurado');
  return engine;
};

/** Lo que pueden hacer las pantallas (ver SyncEngine) */
export const household = {
  create: (name: string, displayName: string | null) => need().createHousehold(name, displayName),
  join: (code: string, displayName: string | null, opts?: { keepLocal?: boolean }) => need().joinHousehold(code, displayName, opts),
  leave: (opts?: { force?: boolean }) => need().leave(opts),
  reloadNow: () => need().reloadNow(),
  resolveHeld: (choice: 'send' | 'reload') => need().resolveHeld(choice),
  allowBigDelete: () => engine?.allowBigDelete(),
  removeMember: (userId: string) => need().removeMember(userId),
  regenerateCode: () => need().regenerateCode(),
  refreshMembers: () => need().refreshMembers(),
  setDisplayName: (name: string | null) => need().setDisplayName(name),
  rename: (name: string) => need().renameHousehold(name),
  syncNow: () => engine?.syncNow() ?? Promise.resolve(),
};

/** El archivo de una factura: el del teléfono o, en un hogar, el del servidor (ver SyncEngine.loadInvoiceFile) */
export const loadInvoiceFile = (id: string): Promise<Blob | undefined> => (engine ? engine.loadInvoiceFile(id) : loadFile(id));
