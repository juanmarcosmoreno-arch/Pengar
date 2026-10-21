/**
 * Respaldo automático (lib/autoBackup, en el iPhone): cuándo toca uno y cuáles se conservan. Uno por día, si
 * cambiaron los datos; quedan los 14 más nuevos y, de los 12 meses más nuevos, el último de cada mes. Los archivos de
 * las facturas no van adentro de cada uno: cada uno se guarda una sola vez («pengar-archivo-<id>.json») y se borra
 * cuando ya no está en ningún respaldo que quede.
 */
import { toISODate } from './dates';
import { cyrb53 } from './hash';
import type { Data } from './types';

/** Lo que recuerda este teléfono (lib/device) */
export interface AutoBackupState {
  enabled: boolean;
  /** Cuándo se hizo el último (ms) y el hash de esos datos */
  last?: number;
  lastHash?: string;
  /** El último intento que falló: se muestra en Ajustes y se borra con el próximo que sale bien */
  failed?: { at: number; message: string };
  /** Archivo de cada factura guardado aparte → el día del último respaldo que lo usa (YYYY-MM-DD) */
  archived?: Record<string, string>;
}

export const KEEP_DAILY = 14;
export const KEEP_MONTHLY = 12;
/** Después de un error no se vuelve a probar solo hasta pasada una hora (cada intento arma el respaldo entero) */
export const RETRY_AFTER = 60 * 60 * 1000;

/** «pengar-2026-10-21.json» */
export const backupName = (date: string) => `pengar-${date}.json`;

/** El archivo de una factura, guardado aparte una sola vez (es .json para que el plugin lo liste y lo pase a iCloud) */
export const archiveName = (id: string) => `pengar-archivo-${id}.json`;
const ARCHIVE = /^pengar-archivo-(.+)\.json$/;
/** El id de la factura de un archivo guardado aparte, o null si es otra cosa */
export const archiveId = (name: string): string | null => ARCHIVE.exec(name)?.[1] ?? null;

/**
 * Los archivos guardados aparte que ya no usa ningún respaldo que queda: los que se usaron por última vez antes del
 * respaldo más viejo que se conserva (`kept`: los nombres de los respaldos que quedan)
 */
export function archivesToRemove(archived: Record<string, string>, kept: string[]): string[] {
  const oldest = kept.map(backupDate).filter((d): d is string => d != null).sort()[0];
  if (!oldest) return [];
  return Object.entries(archived).filter(([, day]) => day < oldest).map(([id]) => id);
}
const NAME = /^pengar-(\d{4}-\d{2}-\d{2})\.json$/;
/** El día de un respaldo automático por su nombre, o null si es otro archivo (esos no se tocan) */
export const backupDate = (name: string): string | null => NAME.exec(name)?.[1] ?? null;

/** Hash de los datos (sin los archivos de las facturas ni la clave de Claude, que no va en el respaldo) */
export const dataHash = (data: Data): string =>
  cyrb53(JSON.stringify({ ...data, settings: { ...data.settings, ai: { ...data.settings.ai, apiKey: '' } } }));

/**
 * Por qué no: apagado, datos de ejemplo, sin datos todavía (la bienvenida, después de «Borrar todo»), ya hay uno de
 * hoy, nada cambió desde el último, o falló hace menos de una hora
 */
export type BackupSkip = 'off' | 'example' | 'empty' | 'today' | 'same' | 'wait';
export type BackupDecision = { due: true; hash: string } | { due: false; why: BackupSkip };

/**
 * ¿Toca un respaldo? Uno por día: el último tiene que ser de otro día (de calendario: con 24 h justas, quien abre la
 * app siempre a la misma hora se saltearía días). `force` («Hacer un respaldo ahora») no mira el día, los cambios ni
 * el apagado; los datos de ejemplo y la app sin datos no se respaldan nunca. El hash se calcula solo si hace falta.
 */
export function backupDue(state: AutoBackupState, data: Data, now: number, force = false): BackupDecision {
  if (!data.settings.onboarded) return { due: false, why: 'empty' };
  // Ni el ejemplo ni los datos del modo demo (en el demo el respaldo ni corre: store)
  if (data.settings.example || data.settings.demo) return { due: false, why: 'example' };
  if (!force) {
    if (!state.enabled) return { due: false, why: 'off' };
    const { failed } = state;
    if (failed && failed.at <= now && now - failed.at < RETRY_AFTER) return { due: false, why: 'wait' };
    // Distinto, no «anterior»: con el reloj atrasado (o un `last` del futuro) también toca
    if (state.last != null && toISODate(new Date(state.last)) === toISODate(new Date(now))) return { due: false, why: 'today' };
  }
  const hash = dataHash(data);
  if (!force && hash === state.lastHash) return { due: false, why: 'same' };
  return { due: true, hash };
}

/**
 * Los respaldos automáticos que sobran: quedan los 14 más nuevos y el último de cada uno de los 12 meses más nuevos
 * que tienen alguno. Por cantidad y no por fecha: si la app no se abrió en un mes, no se borra lo de antes.
 */
export function backupsToRemove(names: string[]): string[] {
  const dated = names
    .map((name) => ({ name, date: backupDate(name) }))
    .filter((x): x is { name: string; date: string } => x.date != null)
    .sort((a, b) => b.date.localeCompare(a.date));
  const keep = new Set(dated.slice(0, KEEP_DAILY).map((x) => x.name));
  const months = new Set<string>();
  for (const x of dated) {
    const month = x.date.slice(0, 7);
    if (months.has(month)) continue;
    if (months.size === KEEP_MONTHLY) break;
    // Del más nuevo al más viejo: el primero de cada mes es el último que se hizo en ese mes
    months.add(month);
    keep.add(x.name);
  }
  return dated.filter((x) => !keep.has(x.name)).map((x) => x.name);
}

/** Lo guardado por otra versión (o nada) queda como uno nuevo; `enabled` de fábrica si no hay */
export function normalizeAutoBackup(raw: unknown, enabled: boolean): AutoBackupState {
  if (!raw || typeof raw !== 'object') return { enabled };
  const r = raw as Partial<Record<keyof AutoBackupState, unknown>>;
  const out: AutoBackupState = { enabled: typeof r.enabled === 'boolean' ? r.enabled : enabled };
  if (typeof r.last === 'number' && Number.isFinite(r.last)) out.last = r.last;
  if (typeof r.lastHash === 'string' && r.lastHash) out.lastHash = r.lastHash;
  const f = r.failed as { at?: unknown; message?: unknown } | undefined;
  if (f && typeof f.at === 'number' && Number.isFinite(f.at) && typeof f.message === 'string') out.failed = { at: f.at, message: f.message };
  if (r.archived && typeof r.archived === 'object') {
    const archived = Object.fromEntries(Object.entries(r.archived).filter((e): e is [string, string] => typeof e[1] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e[1])));
    if (Object.keys(archived).length) out.archived = archived;
  }
  return out;
}

/** «9:12» */
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** «hoy 9:12», «ayer 21:40», «el 18/10 9:12» (con el año si no es este: «el 18/10/2025 9:12») */
export function backupWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = clock(ms);
  const day = toISODate(d);
  const today = new Date(now);
  if (day === toISODate(today)) return `hoy ${time}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
  if (day === toISODate(yesterday)) return `ayer ${time}`;
  const year = d.getFullYear() === today.getFullYear() ? '' : `/${d.getFullYear()}`;
  return `el ${d.getDate()}/${d.getMonth() + 1}${year} ${time}`;
}
