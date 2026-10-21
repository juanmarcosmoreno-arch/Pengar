/**
 * Hogar compartido: los datos como registros sueltos (kind, id, data) para mandarlos al servidor y recibir los de los
 * demás. Puro: lo usa el motor (lib/sync.ts).
 *
 * Qué se comparte: categorías, rubros, movimientos, facturas y estados de cuenta (sin el archivo, que va aparte),
 * metas, gastos fijos y un único registro 'settings' con la moneda, lo aprendido y la última cotización escrita.
 * Qué no: el nombre de la persona, la clave de Claude, si ya pasó la bienvenida, el último resumen abierto, la llave para
 * volver a entrar desde otro teléfono (settings.recovery: va en los respaldos, nunca al hogar) y los ajustes del teléfono
 * (lib/device.ts, que ni siquiera están en los datos). Los datos de ejemplo nunca se sincronizan.
 *
 * Reglas al recibir: gana el último (el servidor pone updated_at), salvo que acá haya un cambio todavía sin mandar,
 * que se queda y se manda después. Lo borrado viaja como lápida (deleted). Los ajustes compartidos se mezclan campo
 * por campo (y lo aprendido, palabra por palabra) contra la última versión recibida, para que dos teléfonos que
 * aprenden a la vez no se pisen; lo ahorrado en una meta, igual (se suman los aportes de los dos). Un rubro o una
 * categoría que otro borró, pero que algo de acá sin mandar todavía usa, se queda (y vuelve al hogar). Lo que esta
 * versión no conoce (un campo de los ajustes, un tipo de factura) se guarda tal cual y se manda tal cual.
 */
import { monthOf } from './dates';
import { cyrb53, stableStringify } from './hash';
import { norm, sameCategory } from './importSheet';
import { round2 } from './money';
import { emptyData, normalizeData } from './template';
import type { Budget, Category, Data, Goal, Invoice, Movement, Recurring, Rubro, Settings } from './types';

export type RecordKind = 'category' | 'rubro' | 'movement' | 'invoice' | 'goal' | 'recurring' | 'settings';
export const RECORD_KINDS: readonly RecordKind[] = ['category', 'rubro', 'movement', 'invoice', 'goal', 'recurring', 'settings'];

/** Cada tipo de registro con su lista en Data (los ajustes van aparte) */
const LISTS = {
  category: 'categories',
  rubro: 'rubros',
  movement: 'movements',
  invoice: 'invoices',
  goal: 'goals',
  recurring: 'recurring',
} as const;
type ListKind = keyof typeof LISTS;
type Item = Category | Rubro | Movement | Invoice | Goal | Recurring;
const LIST_KINDS = Object.keys(LISTS) as ListKind[];

/** Id del único registro de ajustes del hogar */
export const SETTINGS_ID = 'hogar';

/** Los ajustes que son del hogar */
export interface SharedSettings {
  currency: Settings['currency'];
  learned: Settings['learned'];
  usdRate?: number;
}

export interface SyncRecord {
  kind: RecordKind;
  id: string;
  data: unknown;
}
/** Como lo devuelve el servidor */
export interface RemoteRecord extends SyncRecord {
  /** Lo pone el servidor (timestamptz en ISO) */
  updatedAt: string;
  updatedBy?: string | null;
  deleted: boolean;
  /** La hora del servidor al contestar (ISO): lo cambiado antes ya se recibió, no hace falta pedirlo de nuevo */
  serverTime?: string;
}
/** Para mandar: el registro o su lápida (data {}) */
export interface OutRecord extends SyncRecord {
  deleted: boolean;
}
/** Clave del registro («movement:m123») → hash de su data */
export type Hashes = Record<string, string>;
export interface HashedRecord extends SyncRecord {
  key: string;
  hash: string;
}
export interface Diff {
  changed: HashedRecord[];
  deleted: { kind: RecordKind; id: string; key: string }[];
}

export const recordKey = (kind: RecordKind, id: string) => `${kind}:${id}`;

export function parseKey(key: string): { kind: RecordKind; id: string } | null {
  const i = key.indexOf(':');
  if (i < 1) return null;
  const kind = key.slice(0, i) as RecordKind;
  return RECORD_KINDS.includes(kind) && i < key.length - 1 ? { kind, id: key.slice(i + 1) } : null;
}

/**
 * Se sincroniza solo con datos propios ya empezados: ni la bienvenida (o después de «Borrar todo») ni el ejemplo. Los
 * del modo demo tampoco (el motor ni los ve: lib/sync se para; esto es por si acaso)
 */
export const syncable = (d: Data): boolean => d.settings.onboarded === true && !d.settings.example && !d.settings.demo;

/** Los ajustes del hogar (con lo que trajo una versión más nueva y esta no conoce, tal cual: Settings.sharedExtra) */
export function sharedSettings(s: Settings): SharedSettings {
  return { ...(s.sharedExtra ?? {}), currency: s.currency, learned: s.learned, ...(s.usdRate ? { usdRate: s.usdRate } : {}) };
}

const KNOWN_SHARED = new Set(['currency', 'learned', 'usdRate']);
/** Lo de los ajustes recibidos que esta versión no conoce */
function extraShared(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const extra = Object.fromEntries(Object.entries(data).filter(([k, v]) => !KNOWN_SHARED.has(k) && v !== undefined));
  return Object.keys(extra).length ? extra : undefined;
}

/** Los datos como registros (sin mirar si se pueden sincronizar: eso lo dice localChanges) */
export function toRecords(data: Data): SyncRecord[] {
  const out: SyncRecord[] = [];
  for (const kind of LIST_KINDS) for (const item of data[LISTS[kind]] as Item[]) out.push({ kind, id: item.id, data: item });
  out.push({ kind: 'settings', id: SETTINGS_ID, data: sharedSettings(data.settings) });
  return out;
}

export const hashData = (data: unknown): string => cyrb53(stableStringify(data));
export const hashRecord = (r: SyncRecord): string => hashData(r.data);

export function recordHashes(records: SyncRecord[], hash: (r: SyncRecord) => string = hashRecord): Hashes {
  const out: Hashes = {};
  for (const r of records) out[recordKey(r.kind, r.id)] = hash(r);
  return out;
}

/** Qué cambió de `prev` (los hashes de lo que tiene el servidor, o los registros de antes) a `next` */
export function diffRecords(prev: Hashes | SyncRecord[], next: SyncRecord[], hash: (r: SyncRecord) => string = hashRecord): Diff {
  const before = Array.isArray(prev) ? recordHashes(prev, hash) : prev;
  const seen = new Set<string>();
  const changed: HashedRecord[] = [];
  for (const r of next) {
    const key = recordKey(r.kind, r.id);
    // Un id repetido en la misma lista (no debería pasar) cuenta una vez: el último
    if (seen.has(key)) {
      const i = changed.findIndex((c) => c.key === key);
      if (i >= 0) changed.splice(i, 1);
    }
    seen.add(key);
    const h = hash(r);
    if (before[key] !== h) changed.push({ ...r, key, hash: h });
  }
  const deleted: Diff['deleted'] = [];
  for (const key of Object.keys(before)) {
    if (seen.has(key)) continue;
    const k = parseKey(key);
    if (k) deleted.push({ ...k, key });
  }
  return { changed, deleted };
}

const NO_CHANGES: Diff = { changed: [], deleted: [] };

/**
 * Lo que hay para mandar: los datos contra lo que tiene el servidor. Con la bienvenida o el ejemplo, nada (si no, el
 * ejemplo viajaría al hogar y «Borrar todo» borraría el hogar entero)
 */
export function localChanges(synced: Hashes, data: Data, hash?: (r: SyncRecord) => string): Diff {
  return syncable(data) ? diffRecords(synced, toRecords(data), hash) : NO_CHANGES;
}

export const pendingKeys = (diff: Diff): Set<string> => new Set([...diff.changed.map((c) => c.key), ...diff.deleted.map((d) => d.key)]);

/** Lo que se manda: los cambiados y las lápidas de los borrados */
export function outRecords(diff: Diff): OutRecord[] {
  return [
    ...diff.changed.map(({ kind, id, data }) => ({ kind, id, data, deleted: false })),
    ...diff.deleted.map(({ kind, id }) => ({ kind, id, data: {}, deleted: true })),
  ];
}

// --- Lo recibido: lo mínimo para que la app no se rompa con un registro roto o de una versión que no conoce ---

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isKind = (v: unknown) => v === 'gasto' || v === 'ingreso';

function validBudget(b: unknown): b is Budget {
  if (!isObj(b)) return false;
  if (b.type === 'none') return true;
  if (b.type === 'fixed') return isNum(b.amount);
  if (b.type === 'percentIncome') return isNum(b.pct);
  return false;
}

const validLine = (it: unknown) => isObj(it) && isStr(it.description) && isNum(it.amount);

/** El registro como elemento de los datos (con el id del registro), o null si no sirve: se ignora */
export function readRecord(kind: Exclude<RecordKind, 'settings'>, id: string, data: unknown): Item | null {
  if (!isObj(data)) return null;
  const d: Record<string, unknown> = { ...data, id };
  switch (kind) {
    case 'category':
      return isStr(d.name) && isKind(d.kind) && isStr(d.icon) && isStr(d.color) && validBudget(d.budget) && isNum(d.order) ? (d as unknown as Category) : null;
    case 'rubro':
      if (!isStr(d.name) || !isStr(d.categoryId)) return null;
      if (d.keywords === undefined) return { ...d, keywords: [] } as unknown as Rubro;
      return Array.isArray(d.keywords) && d.keywords.every(isStr) ? (d as unknown as Rubro) : null;
    case 'movement':
      return isStr(d.date) && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && isNum(d.amount) && isKind(d.kind) && isStr(d.rubroId) && isStr(d.origin) && isNum(d.createdAt)
        ? (d as unknown as Movement)
        : null;
    case 'invoice':
      return isStr(d.fileName) && isStr(d.mime) && Array.isArray(d.items) && d.items.every(validLine) && isNum(d.createdAt) ? (d as unknown as Invoice) : null;
    case 'goal':
      return isStr(d.name) && isStr(d.icon) && isNum(d.target) && isNum(d.saved) ? (d as unknown as Goal) : null;
    case 'recurring':
      return isStr(d.rubroId) && isKind(d.kind) && isNum(d.amount) && isNum(d.day) && isNum(d.createdAt) ? (d as unknown as Recurring) : null;
  }
}

/** Los ajustes del hogar recibidos, o null si no sirven. La moneda o lo aprendido rotos quedan como estaban acá */
export function readShared(data: unknown): (Partial<SharedSettings> & { usdRate?: number }) | null {
  if (!isObj(data)) return null;
  const out: Partial<SharedSettings> = {};
  const c = data.currency;
  if (isObj(c) && isStr(c.symbol) && isStr(c.locale) && isNum(c.decimals)) out.currency = { symbol: c.symbol, locale: c.locale, decimals: c.decimals };
  if (isObj(data.learned) && Object.values(data.learned).every(isStr)) out.learned = data.learned as Settings['learned'];
  if (isNum(data.usdRate) && data.usdRate > 0) out.usdRate = data.usdRate;
  return out;
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/**
 * Mezcla de tres: lo que cambió acá desde `base` (la última versión recibida) se queda; lo demás viene de `remote`.
 * Lo aprendido, palabra por palabra (también lo olvidado). Sin `base`, gana lo de acá y lo aprendido se suma
 */
export function mergeShared(base: SharedSettings | undefined, local: SharedSettings, remote: SharedSettings): SharedSettings {
  const pick = <T,>(l: T, r: T, b: T | undefined): T => (base && same(l, b) ? r : l);
  const learned: Settings['learned'] = {};
  for (const k of new Set([...Object.keys(remote.learned), ...Object.keys(local.learned)])) {
    const l = local.learned[k];
    const v = base ? (l === base.learned[k] ? remote.learned[k] : l) : (l ?? remote.learned[k]);
    if (v !== undefined) learned[k] = v;
  }
  const usdRate = pick(local.usdRate, remote.usdRate, base?.usdRate);
  return { currency: pick(local.currency, remote.currency, base?.currency), learned, ...(usdRate ? { usdRate } : {}) };
}

const ts = (s: string) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
};

/** El más nuevo de cada registro (en una tanda puede venir dos veces) */
export function latestByKey(remote: RemoteRecord[]): Map<string, RemoteRecord> {
  const out = new Map<string, RemoteRecord>();
  for (const r of remote) {
    if (!RECORD_KINDS.includes(r.kind) || !isStr(r.id) || !r.id) continue;
    const key = recordKey(r.kind, r.id);
    const prev = out.get(key);
    if (!prev || ts(r.updatedAt) >= ts(prev.updatedAt)) out.set(key, r);
  }
  return out;
}

/** Hasta dónde se recibió (ms): el updated_at más nuevo */
export function cursorOf(remote: RemoteRecord[], prev: number | null): number | null {
  let max = prev;
  for (const r of remote) {
    const t = Date.parse(r.updatedAt);
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * Hasta qué hora del servidor (ms) ya se pidió: la más temprana de la respuesta (si vino en varias páginas, la de la
 * primera), nunca para atrás. Sin la hora del servidor, la de antes
 */
export function seenOf(remote: RemoteRecord[], prev: number | undefined): number | undefined {
  let min: number | undefined;
  for (const r of remote) {
    const t = r.serverTime ? Date.parse(r.serverTime) : Number.NaN;
    if (!Number.isNaN(t) && (min === undefined || t < min)) min = t;
  }
  if (min === undefined) return prev;
  return prev === undefined ? min : Math.max(prev, min);
}

export interface MergeResult {
  data: Data;
  /** Registros que cambiaron los datos */
  applied: string[];
  /** Recibidos que no se aplicaron porque acá hay un cambio sin mandar (se queda lo de acá, que se manda después) */
  kept: string[];
  /** Recibidos rotos o de una versión que esta no entiende: se ignoran y no se tocan */
  skipped: string[];
  /** Lo que tiene el servidor ahora: hash de cada registro recibido (null: borrado). Sin los ignorados */
  hashes: Record<string, string | null>;
  /** Los ajustes del hogar recibidos (la base de la próxima mezcla), si vinieron */
  base?: SharedSettings;
  /** Facturas y estados de cuenta que borró otro (para borrar el archivo del teléfono) */
  removedInvoices: string[];
  /** Lo ahorrado en cada meta según lo recibido (la base de la próxima mezcla; null: la meta se borró) */
  goalBases: Record<string, number | null>;
  /** Rubros y categorías que otro borró y quedan porque algo de acá sin mandar los usa (vuelven al hogar) */
  revived: string[];
}

/**
 * Aplica lo recibido. `pending`: los registros con cambios de acá todavía sin mandar (localChanges), que no se pisan;
 * los ajustes con cambios sin mandar se mezclan con `base` (mergeShared) y lo ahorrado en una meta con `goals` (lo
 * ahorrado de la última versión recibida de cada meta). Con la bienvenida o el ejemplo no se toca nada.
 *
 * Los hashes de lo aplicado son los de cómo quedó acá (normalizado): así lo que esta versión acomoda al recibir no se
 * vuelve a mandar como si fuera un cambio de acá.
 */
export function mergeRemote(
  data: Data,
  remote: RemoteRecord[],
  pending: Iterable<string>,
  opts: { base?: SharedSettings; goals?: Record<string, number> } = {},
): MergeResult {
  const res: MergeResult = { data, applied: [], kept: [], skipped: [], hashes: {}, removedInvoices: [], goalBases: {}, revived: [] };
  if (!syncable(data)) return res;
  const waiting = new Set(pending);
  const maps = new Map<ListKind, Map<string, Item>>();
  const mapOf = (kind: ListKind) => {
    let m = maps.get(kind);
    if (!m) {
      m = new Map((data[LISTS[kind]] as Item[]).map((x) => [x.id, x]));
      maps.set(kind, m);
    }
    return m;
  };
  let settings = data.settings;
  // Lápidas de rubros y categorías: al final, cuando se sabe si algo de acá sin mandar los usa
  const tombstones: { kind: 'rubro' | 'category'; id: string; key: string }[] = [];
  // Una meta con lo ahorrado mezclado (cambió acá aunque el registro quede como cambio de acá)
  let merged = false;

  for (const [key, r] of latestByKey(remote)) {
    if (r.kind === 'settings') {
      const got = r.id === SETTINGS_ID && !r.deleted ? readShared(r.data) : null;
      if (!got) {
        res.skipped.push(key);
        continue;
      }
      const local = sharedSettings(settings);
      const incoming: SharedSettings = { currency: got.currency ?? local.currency, learned: got.learned ?? local.learned, ...(got.usdRate ? { usdRate: got.usdRate } : {}) };
      const extra = extraShared(r.data as Record<string, unknown>);
      res.hashes[key] = hashRecord(r);
      res.base = incoming;
      const next = waiting.has(key) ? mergeShared(opts.base, local, incoming) : incoming;
      if (waiting.has(key)) res.kept.push(key);
      if (!same({ ...(extra ?? {}), ...next }, local)) {
        settings = { ...settings, currency: next.currency, learned: next.learned, usdRate: next.usdRate, sharedExtra: extra };
        if (!waiting.has(key)) res.applied.push(key);
      }
      continue;
    }
    const kind = r.kind as ListKind;
    if (r.deleted) {
      res.hashes[key] = null;
      if (kind === 'goal') res.goalBases[r.id] = null;
      if (waiting.has(key)) {
        res.kept.push(key);
        continue;
      }
      if (kind === 'rubro' || kind === 'category') {
        tombstones.push({ kind, id: r.id, key });
        continue;
      }
      if (mapOf(kind).delete(r.id)) {
        res.applied.push(key);
        if (kind === 'invoice') res.removedInvoices.push(r.id);
      }
      continue;
    }
    const item = readRecord(kind, r.id, r.data);
    if (!item) {
      res.skipped.push(key);
      continue;
    }
    res.hashes[key] = hashRecord(r);
    if (kind === 'goal') res.goalBases[r.id] = (item as Goal).saved;
    if (waiting.has(key)) {
      res.kept.push(key);
      // Dos aportes a la misma meta casi a la vez: lo de acá más lo que sumó el otro desde la última versión recibida
      const mine = kind === 'goal' ? (mapOf('goal').get(r.id) as Goal | undefined) : undefined;
      const base = opts.goals?.[r.id];
      if (mine && base !== undefined && (item as Goal).saved !== base) {
        mapOf('goal').set(r.id, { ...mine, saved: round2(mine.saved + (item as Goal).saved - base) });
        merged = true;
      }
      continue;
    }
    const prev = mapOf(kind).get(r.id);
    if (prev && same(prev, item)) continue;
    mapOf(kind).set(r.id, item);
    res.applied.push(key);
  }

  if (tombstones.length) {
    // Lo de acá sin mandar que usa un rubro o una categoría: si otro los borró (o unió) mientras tanto, se quedan
    const waits = (kind: RecordKind, id: string) => waiting.has(recordKey(kind, id));
    const usedRubros = new Set<string>();
    for (const m of mapOf('movement').values() as Iterable<Movement>) if (waits('movement', m.id)) usedRubros.add(m.rubroId);
    for (const x of mapOf('recurring').values() as Iterable<Recurring>) if (waits('recurring', x.id)) usedRubros.add(x.rubroId);
    const usedCategories = new Set<string>();
    for (const x of mapOf('rubro').values() as Iterable<Rubro>) if (waits('rubro', x.id)) usedCategories.add(x.categoryId);
    const drop = (t: (typeof tombstones)[number], used: Set<string>) => {
      const local = mapOf(t.kind).get(t.id);
      if (!local) return;
      if (used.has(t.id)) {
        res.revived.push(t.key);
        if (t.kind === 'rubro') usedCategories.add((local as Rubro).categoryId);
        return;
      }
      mapOf(t.kind).delete(t.id);
      res.applied.push(t.key);
    };
    for (const t of tombstones) if (t.kind === 'rubro') drop(t, usedRubros);
    for (const t of tombstones) if (t.kind === 'category') drop(t, usedCategories);
  }

  if (!res.applied.length && !merged && settings === data.settings) return finalHashes(res, data, waiting);
  const next: Data = { ...data, settings };
  for (const [kind, m] of maps) (next as unknown as Record<string, Item[]>)[LISTS[kind]] = [...m.values()];
  res.data = normalizeData(next);
  return finalHashes(res, res.data, waiting);
}

/**
 * Lo recibido como quedó acá: si esta versión lo acomodó al leerlo (normalizeData, readRecord), el hash es el de acá,
 * para que no cuente como un cambio de acá y no se mande de vuelta (ida y vuelta entre versiones)
 */
function finalHashes(res: MergeResult, data: Data, waiting: Set<string>): MergeResult {
  let lists: Map<string, Map<string, Item>> | null = null;
  for (const [key, h] of Object.entries(res.hashes)) {
    if (h === null || waiting.has(key)) continue;
    const k = parseKey(key);
    if (!k) continue;
    if (k.kind === 'settings') {
      res.hashes[key] = hashData(sharedSettings(data.settings));
      continue;
    }
    lists ??= new Map(LIST_KINDS.map((kind) => [kind, new Map((data[LISTS[kind]] as Item[]).map((x) => [x.id, x]))]));
    const item = lists.get(k.kind)?.get(k.id);
    if (item) res.hashes[key] = hashData(item);
  }
  return res;
}

/**
 * Los datos del hogar en lugar de los de acá (al unirse, o al volver a tener datos después de «Borrar todo»). De acá
 * quedan el nombre, la clave de Claude, el último resumen abierto y la llave del hogar; la moneda, si el hogar no tiene
 * ajustes
 */
export function replaceWithRemote(remote: RemoteRecord[], local: Data): MergeResult {
  const s = local.settings;
  const base = emptyData();
  base.settings = { ...base.settings, name: s.name, ai: s.ai, currency: s.currency, lastReportSeen: s.lastReportSeen, recovery: s.recovery, onboarded: true };
  return mergeRemote(base, remote, []);
}

/** Los registros de vuelta como datos (ver replaceWithRemote) */
export const fromRecords = (remote: RemoteRecord[], local: Data): Data => replaceWithRemote(remote, local).data;

/** Los hashes de lo que tiene el servidor, sin los borrados */
export const presentHashes = (hashes: MergeResult['hashes']): Hashes =>
  Object.fromEntries(Object.entries(hashes).filter((e): e is [string, string] => e[1] !== null));

// --- La llave para volver a entrar ---

/**
 * Una llave nueva: 32 bytes al azar (base64url, 43 letras). El servidor guarda solo su hash; con ella y el código, otro
 * teléfono vuelve a entrar como el mismo integrante (lib/sync)
 */
export function newRecoveryToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- «Sumar mis datos al hogar» al unirse ---

export interface SumResult {
  data: Data;
  /** Lo que se sumó de acá */
  added: { movements: number; categories: number; rubros: number; invoices: number; goals: number; recurring: number };
  /** Movimientos que el hogar ya tenía (el mismo, o uno igual: fecha, tipo, rubro, monto, nota y comercio) */
  repeated: number;
  /**
   * Meses con totales de planilla que el hogar ya tenía (YYYY-MM, en orden): de esos meses no se suman los de acá del
   * mismo rubro y tipo (como al sumar una planilla); los de otros rubros, sí
   */
  sheetMonths: string[];
  /** Lo de acá que el hogar ya había borrado (movimientos, facturas, metas, gastos fijos, rubros y categorías): no vuelve */
  deleted: number;
  /** Metas de acá con el nombre de una del hogar (los nombres del hogar): a esa se le sumó lo ahorrado acá */
  goalsJoined: string[];
  /** Gastos fijos de acá de un rubro que el hogar ya tiene como fijo: queda el del hogar (anotado hasta el más nuevo) */
  recurringKept: number;
}

const looseKey = (m: Movement) => [m.date, m.kind, m.rubroId, round2(m.amount), m.note ?? '', m.merchant ?? ''].join('|');
/** Un total de planilla: su mes, rubro y tipo (como lo reemplaza importSheet) */
const sheetKey = (m: Movement) => `${m.rubroId}|${m.kind}|${monthOf(m.date)}`;

/** Lo que el hogar borró: los registros cuya última versión es una lápida (en lo bajado del servidor) */
export function tombstones(remote: RemoteRecord[]): Set<string> {
  return new Set([...latestByKey(remote)].filter(([, r]) => r.deleted).map(([key]) => key));
}

/**
 * Lo de acá sumado a lo del hogar (`hh`: los datos del hogar como quedan en este teléfono, replaceWithRemote; `gone`: lo
 * que el hogar borró, tombstones). Las categorías y los rubros con el mismo nombre se unen (como al sumar una planilla:
 * importSheet) y lo de acá pasa a usar los del hogar; lo que el hogar no tiene, se agrega: un rubro, solo si lo usa algo
 * que se suma (o lo aprendido, o es de una categoría nueva con presupuesto), y una categoría, si la usa un rubro nuevo o
 * tiene presupuesto. No duplica: lo que tiene el mismo id que algo del hogar (un respaldo de ese hogar) queda como en
 * el hogar, lo que el hogar borró no vuelve (salvo un rubro o una categoría que use algo nuevo de acá, como al
 * sincronizar), los movimientos iguales se saltean (contando cuántas veces está cada uno, así dos compras iguales no se
 * pierden) y los totales de planilla de un mes, rubro y tipo que el hogar ya tiene no se suman (si los dos importaron la
 * misma planilla, queda una vez). Un gasto fijo de un rubro que el hogar ya tiene como fijo no se suma (el del hogar
 * queda anotado hasta el mes más nuevo de los dos) y una meta con el mismo nombre se junta con la del hogar (se suma lo
 * ahorrado): se cuentan, para decirlo. Del hogar quedan el presupuesto, la moneda y lo aprendido (lo de acá que el
 * hogar no tiene, se suma). Los movimientos sumados quedan sin «Anotado por» (el motor les pone quién se une), salvo
 * que ya digan alguien que anotó en el hogar
 */
export function sumIntoHousehold(hh: Data, mine: Data, gone: ReadonlySet<string> = new Set()): SumResult {
  const dead = (kind: RecordKind, id: string) => gone.has(recordKey(kind, id));
  let deleted = 0;
  const hhCats = new Map(hh.categories.map((c) => [c.id, c]));
  const catMap = new Map<string, string>();
  for (const c of mine.categories) {
    const same = hhCats.has(c.id) ? hhCats.get(c.id) : hh.categories.find((x) => sameCategory(x, c));
    if (same) catMap.set(c.id, same.id);
  }
  const kindOf = new Map([...hh.categories, ...mine.categories].map((c) => [catMap.get(c.id) ?? c.id, c.kind]));

  // Los rubros de acá que el hogar no tiene: se agregan después, solo los que se usan
  const hhRubros = new Map(hh.rubros.map((r) => [r.id, r]));
  const rubroMap = new Map<string, string>();
  const candidates = new Map<string, Rubro>();
  for (const r of mine.rubros) {
    if (hhRubros.has(r.id)) {
      rubroMap.set(r.id, r.id);
      continue;
    }
    const categoryId = catMap.get(r.categoryId) ?? r.categoryId;
    const name = norm(r.name);
    // En la misma categoría o, si no, el único del hogar con ese nombre (en una categoría del mismo tipo)
    const same =
      hh.rubros.find((x) => x.categoryId === categoryId && norm(x.name) === name) ??
      ((xs) => (xs.length === 1 ? xs[0] : undefined))(hh.rubros.filter((x) => norm(x.name) === name && kindOf.get(x.categoryId) === kindOf.get(categoryId)));
    if (same) rubroMap.set(r.id, same.id);
    else candidates.set(r.id, { ...r, categoryId });
  }
  const rubro = (id: string) => rubroMap.get(id) ?? id;

  const ids = new Set(hh.movements.map((m) => m.id));
  const authors = new Set(hh.movements.flatMap((m) => (m.createdBy ? [m.createdBy] : [])));
  const loose = new Map<string, number>();
  const sheet = new Set<string>();
  for (const m of hh.movements) {
    if (m.monthly) sheet.add(sheetKey(m));
    else loose.set(looseKey(m), (loose.get(looseKey(m)) ?? 0) + 1);
  }
  const movements: Movement[] = [];
  const skippedMonths = new Set<string>();
  let repeated = 0;
  for (const local of mine.movements) {
    if (ids.has(local.id)) {
      repeated++;
      continue;
    }
    if (dead('movement', local.id)) {
      deleted++;
      continue;
    }
    const m: Movement = {
      ...local,
      rubroId: rubro(local.rubroId),
      createdBy: local.createdBy && authors.has(local.createdBy) ? local.createdBy : undefined,
      // La factura la borró el hogar: el movimiento queda, sin ella (como al borrarla acá)
      ...(local.invoiceId && dead('invoice', local.invoiceId) ? { invoiceId: undefined } : {}),
    };
    if (m.monthly) {
      if (sheet.has(sheetKey(m))) {
        skippedMonths.add(monthOf(m.date));
        continue;
      }
    } else {
      const left = loose.get(looseKey(m)) ?? 0;
      if (left > 0) {
        loose.set(looseKey(m), left - 1);
        repeated++;
        continue;
      }
    }
    movements.push(m);
  }

  // Facturas y estados de cuenta: los que no están en el hogar y siguen con algún movimiento sumado (o no tenían
  // ninguno). Si todos sus movimientos ya estaban, es el mismo estado de cuenta: no se suma otra vez
  const hhInvoices = new Set(hh.invoices.map((i) => i.id));
  const withMovements = new Set(mine.movements.flatMap((m) => (m.invoiceId ? [m.invoiceId] : [])));
  const addedInvoices = new Set(movements.flatMap((m) => (m.invoiceId ? [m.invoiceId] : [])));
  const invoices: Invoice[] = [];
  for (const i of mine.invoices) {
    if (hhInvoices.has(i.id)) continue;
    if (dead('invoice', i.id)) {
      deleted++;
      continue;
    }
    if (addedInvoices.has(i.id) || !withMovements.has(i.id)) {
      invoices.push({ ...i, items: i.items.map((it) => (it.rubroId ? { ...it, rubroId: rubro(it.rubroId) } : it)) });
    }
  }

  // Una meta con el nombre de una del hogar es la misma: se le suma lo ahorrado acá
  const goalByName = new Map(hh.goals.map((g) => [norm(g.name), g]));
  const extraSaved = new Map<string, number>();
  const goals: Goal[] = [];
  for (const g of mine.goals) {
    if (hh.goals.some((x) => x.id === g.id)) continue;
    if (dead('goal', g.id)) {
      deleted++;
      continue;
    }
    const same = goalByName.get(norm(g.name));
    if (same) extraSaved.set(same.id, (extraSaved.get(same.id) ?? 0) + (g.saved || 0));
    else goals.push(g);
  }
  const hhGoals = hh.goals.map((g) => (extraSaved.has(g.id) ? { ...g, saved: round2(g.saved + extraSaved.get(g.id)!) } : g));

  // Un fijo de un rubro que el hogar ya tiene como fijo: queda el del hogar, anotado hasta el mes más nuevo
  const fixed = new Map(hh.recurring.map((r) => [`${r.rubroId}|${r.kind}`, r]));
  const doneThrough = new Map<string, string>();
  let recurringKept = 0;
  const recurring: Recurring[] = [];
  for (const r0 of mine.recurring) {
    if (hh.recurring.some((x) => x.id === r0.id)) continue;
    if (dead('recurring', r0.id)) {
      deleted++;
      continue;
    }
    const r = { ...r0, rubroId: rubro(r0.rubroId) };
    const same = fixed.get(`${r.rubroId}|${r.kind}`);
    if (!same) {
      recurring.push(r);
      continue;
    }
    recurringKept++;
    const newest = [same.doneThrough, doneThrough.get(same.id), r.doneThrough].filter((x): x is string => !!x).sort().at(-1);
    if (newest && newest !== same.doneThrough) doneThrough.set(same.id, newest);
  }
  const hhRecurring = hh.recurring.map((r) => (doneThrough.has(r.id) ? { ...r, doneThrough: doneThrough.get(r.id) } : r));

  // Los rubros de acá que el hogar no tiene: los que usa lo que se suma (o lo aprendido), y los de una categoría nueva
  // con presupuesto (así no queda vacía). Lo que el hogar borró, solo si lo usa algo nuevo de acá
  const usedBy = new Set<string>([
    ...movements.map((m) => m.rubroId),
    ...recurring.map((r) => r.rubroId),
    ...invoices.flatMap((i) => i.items.flatMap((it) => (it.rubroId ? [it.rubroId] : []))),
  ]);
  const budgeted = new Set(mine.categories.filter((c) => !catMap.has(c.id) && c.budget.type !== 'none' && !dead('category', c.id)).map((c) => c.id));
  const learnedRubros = new Set(Object.values(mine.settings.learned));
  const newRubros: Rubro[] = [];
  for (const r of candidates.values()) {
    if (usedBy.has(r.id) || (!dead('rubro', r.id) && (learnedRubros.has(r.id) || budgeted.has(r.categoryId)))) newRubros.push(r);
    else if (dead('rubro', r.id)) deleted++;
  }

  // Las categorías de acá que no están en el hogar: si las usa un rubro nuevo o tienen presupuesto (si el hogar no la borró)
  const used = new Set(newRubros.map((r) => r.categoryId));
  const newCats: Category[] = [];
  for (const c of mine.categories) {
    if (catMap.has(c.id)) continue;
    if (used.has(c.id) || budgeted.has(c.id)) newCats.push({ ...c, order: hh.categories.length + newCats.length });
    else if (dead('category', c.id)) deleted++;
  }

  const rubros = [...hh.rubros, ...newRubros];
  const live = new Set(rubros.map((r) => r.id));
  const learned: Settings['learned'] = {};
  for (const [k, v] of Object.entries(mine.settings.learned)) if (live.has(rubro(v))) learned[k] = rubro(v);

  const data = normalizeData({
    ...hh,
    categories: [...hh.categories, ...newCats],
    rubros,
    movements: [...hh.movements, ...movements],
    invoices: [...hh.invoices, ...invoices],
    goals: [...hhGoals, ...goals],
    recurring: [...hhRecurring, ...recurring],
    settings: {
      ...hh.settings,
      learned: { ...learned, ...hh.settings.learned },
      ...(hh.settings.usdRate || !mine.settings.usdRate ? {} : { usdRate: mine.settings.usdRate }),
    },
  });
  return {
    data,
    added: { movements: movements.length, categories: newCats.length, rubros: newRubros.length, invoices: invoices.length, goals: goals.length, recurring: recurring.length },
    repeated,
    sheetMonths: [...skippedMonths].sort(),
    deleted,
    goalsJoined: [...new Set(hh.goals.filter((g) => extraSaved.has(g.id)).map((g) => g.name))],
    recurringKept,
  };
}
