/**
 * Respaldo automático (plugin PengarBackup): uno por día, al abrir la app y al pasar a segundo plano, si cambiaron
 * los datos (cuándo y cuáles quedan, en domain/autoBackup). Va a iCloud Drive › Pengar › Respaldos si la app tiene
 * iCloud (la capability, con la cuenta paga: ver README) y el iPhone iCloud Drive; si no, a una carpeta de la app que
 * se ve en Archivos › En mi iPhone › Pengar y entra en el respaldo del iPhone. Es como el respaldo manual, pero los
 * archivos de las facturas no van adentro: cada uno se guarda una sola vez aparte y cada respaldo dice cuáles usa
 * (si no, cada respaldo diario llevaría todas las fotos). Solo en el iPhone; nunca tira: lo que falla queda en el
 * ajuste, para Ajustes.
 */
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import {
  archiveId, archiveName, archivesToRemove, backupDate, backupDue, backupName, backupsToRemove, type AutoBackupState, type BackupSkip,
} from '../domain/autoBackup';
import { toISODate } from '../domain/dates';
import type { Data } from '../domain/types';
import { backupWithoutFiles, fileToBackup, readBackup, type ReadBackup } from './backup';
import { loadFile } from './db';
import { isNative, isPreview } from './platform';

export type BackupLocation = 'icloud' | 'local';
/** `folder`: dónde se ven, para leer («iCloud Drive › Pengar › Respaldos») */
export interface BackupStatus {
  iCloud: boolean;
  location: BackupLocation;
  folder: string;
}
/** `modified` en ms; `size` en bytes (0 si no se sabe: uno que todavía no bajó de iCloud) */
export interface BackupFile {
  name: string;
  size: number;
  modified: number;
}

interface PengarBackupPlugin {
  status(): Promise<BackupStatus>;
  write(options: { name: string; data: string; encoding?: 'utf8' | 'base64' }): Promise<{ location: BackupLocation }>;
  list(): Promise<{ files: BackupFile[] }>;
  read(options: { name: string }): Promise<{ data: string }>;
  remove(options: { name: string }): Promise<void>;
}

const PengarBackup = registerPlugin<PengarBackupPlugin>('PengarBackup');

export const canAutoBackup = isNative && !isPreview;

/** El mensaje para Ajustes, una frase sin punto final (el plugin ya los da en español: «No se pudo guardar el respaldo: …») */
function errorText(e: unknown): string {
  if ((e as { code?: unknown })?.code === 'UNIMPLEMENTED') return 'Esta versión de la app no tiene el respaldo automático (instalala de nuevo desde Xcode)';
  const message = (e instanceof Error ? e.message : String(e ?? '')).trim().replace(/\.+$/, '');
  return message || 'No se pudo hacer el respaldo';
}

/** Dónde se guardan, o null si no hay (la web, o una app compilada antes del plugin) */
export async function backupStatus(): Promise<BackupStatus | null> {
  if (!canAutoBackup) return null;
  try {
    const s = await PengarBackup.status();
    return { iCloud: s.iCloud === true, location: s.location === 'icloud' ? 'icloud' : 'local', folder: String(s.folder ?? '') };
  } catch (e) {
    console.warn('Sin respaldo automático', e);
    return null;
  }
}

/**
 * Los respaldos de la carpeta, del más nuevo al más viejo: por el día del nombre (iCloud o copiarlos les puede
 * cambiar la fecha del archivo) y, en los demás, por esa fecha. Si no se pueden leer, tira (con el porqué)
 */
export async function listAutoBackups(): Promise<BackupFile[]> {
  let files: BackupFile[];
  try {
    files = (await PengarBackup.list()).files;
  } catch (e) {
    throw new Error(errorText(e));
  }
  const day = (f: BackupFile) => backupDate(f.name) ?? toISODate(new Date(f.modified));
  // Los archivos de las facturas guardados aparte no son respaldos
  return files.filter((f) => !archiveId(f.name)).sort((a, b) => day(b).localeCompare(day(a)) || b.modified - a.modified);
}

/** Lee uno (si está solo en iCloud, el iPhone lo baja primero) sin guardar nada, como un respaldo elegido a mano */
export async function readAutoBackup(name: string): Promise<ReadBackup> {
  let text: string;
  try {
    text = (await PengarBackup.read({ name })).data;
  } catch (e) {
    throw new Error(errorText(e));
  }
  return withArchives(await readBackup(new Blob([text], { type: 'application/json' })));
}

/**
 * Un respaldo automático (también uno elegido a mano, si es de la carpeta de los automáticos) con los archivos de sus
 * facturas, que van aparte. Uno que falte deja esa factura sin archivo; fuera del iPhone, queda como vino
 */
export async function withArchives(backup: ReadBackup): Promise<ReadBackup> {
  if (!canAutoBackup || !backup.fileRefs?.length) return backup;
  const files = { ...backup.files };
  for (const id of backup.fileRefs) {
    if (files[id]) continue;
    try {
      const f = JSON.parse((await PengarBackup.read({ name: archiveName(id) })).data) as { mime?: unknown; base64?: unknown };
      if (typeof f.base64 === 'string') files[id] = { mime: typeof f.mime === 'string' ? f.mime : 'application/octet-stream', base64: f.base64 };
    } catch (e) {
      console.warn('Respaldo: falta el archivo de la factura', id, e);
    }
  }
  return { ...backup, files };
}

/**
 * Borra los respaldos que sobran y los archivos de facturas que ya no usa ninguno de los que quedan (si alguno no se
 * puede, queda para la próxima). Devuelve lo que se sabe de los archivos guardados aparte, sin los borrados
 */
async function rotate(archived: Record<string, string>): Promise<Record<string, string>> {
  const { files } = await PengarBackup.list();
  const names = files.map((f) => f.name);
  const gone = new Set(backupsToRemove(names));
  for (const name of gone) {
    await PengarBackup.remove({ name }).catch((e) => console.warn('No se pudo borrar', name, e));
  }
  const kept = names.filter((n) => backupDate(n) && !gone.has(n));
  const next = { ...archived };
  for (const id of archivesToRemove(archived, kept)) {
    await PengarBackup.remove({ name: archiveName(id) }).then(
      () => delete next[id],
      (e) => console.warn('No se pudo borrar', archiveName(id), e),
    );
  }
  return next;
}

/**
 * Guarda aparte los archivos de las facturas que todavía no están en la carpeta (uno por vez: nada de un texto enorme
 * por el puente con el iPhone) y anota que el respaldo de `day` los usa. Devuelve de cuáles hay archivo
 */
async function writeArchives(data: Data, day: string, archived: Record<string, string>): Promise<{ refs: string[]; archived: Record<string, string> }> {
  const present = new Set((await PengarBackup.list()).files.map((f) => archiveId(f.name)).filter((x): x is string => !!x));
  const next = { ...archived };
  // Los que están en la carpeta y este teléfono no conoce (de antes de instalar la app de nuevo): por las dudas, hoy
  for (const id of present) next[id] ??= day;
  const refs: string[] = [];
  for (const inv of data.invoices) {
    if (!present.has(inv.id)) {
      // Siempre de los datos de verdad (en el modo demo el respaldo no corre: store)
      const blob = await loadFile(inv.id, 'real');
      if (!blob) continue;
      await PengarBackup.write({ name: archiveName(inv.id), data: JSON.stringify(await fileToBackup(blob, inv.mime)) });
    }
    refs.push(inv.id);
    next[inv.id] = day;
  }
  return { refs, archived: next };
}

export interface AutoBackupRun {
  /** Lo que cambia en el ajuste (nada si no se intentó): `last`, `lastHash` y `archived` si salió, `failed` si no */
  state?: Pick<AutoBackupState, 'last' | 'lastHash' | 'failed' | 'archived'>;
  saved?: { name: string; location: BackupLocation };
  /** Por qué no se hizo; 'busy': ya había uno en curso; 'demo': en el modo demo no corre (store) */
  skipped?: BackupSkip | 'busy' | 'demo';
  error?: string;
}

let running: Promise<AutoBackupRun> | null = null;

/**
 * Hace el respaldo si toca (`force`: «Hacer un respaldo ahora», aunque ya haya uno de hoy o nada haya cambiado).
 * Uno a la vez: el automático que llega con otro en curso no hace nada; el de «ahora» espera y se hace igual.
 */
export async function maybeAutoBackup(data: Data, state: AutoBackupState, { force = false, now = Date.now() } = {}): Promise<AutoBackupRun> {
  if (!canAutoBackup) return { skipped: 'off' };
  if (running && !force) return { skipped: 'busy' };
  while (running) await running;
  const decision = backupDue(state, data, now, force);
  if (!decision.due) return { skipped: decision.why };
  const job = (async (): Promise<AutoBackupRun> => {
    const day = toISODate(new Date(now));
    const name = backupName(day);
    try {
      // Primero los archivos: un respaldo nunca nombra uno que no está
      const { refs, archived } = await writeArchives(data, day, state.archived ?? {});
      const { location } = await PengarBackup.write({ name, data: backupWithoutFiles(data, refs) });
      const left = await rotate(archived).catch((e) => {
        console.warn('No se pudieron revisar los respaldos viejos', e);
        return archived;
      });
      return {
        state: { last: now, lastHash: decision.hash, failed: undefined, archived: left },
        saved: { name, location: location === 'icloud' ? 'icloud' : 'local' },
      };
    } catch (e) {
      console.warn('No se pudo hacer el respaldo automático', e);
      const message = errorText(e);
      return { state: { failed: { at: now, message } }, error: message };
    }
  })();
  running = job;
  try {
    return await job;
  } finally {
    running = null;
  }
}

/**
 * Al pasar a segundo plano. Llegan los dos avisos (el de la página y el `pause` del iPhone, por si uno no llega):
 * el segundo encuentra el respaldo en curso o ya hecho. Devuelve cómo dejar de escuchar
 */
export function onBackground(run: () => void): () => void {
  if (!canAutoBackup) return () => {};
  const onHide = () => document.visibilityState === 'hidden' && run();
  document.addEventListener('visibilitychange', onHide);
  const handle = App.addListener('pause', run);
  return () => {
    document.removeEventListener('visibilitychange', onHide);
    void handle.then((h) => h.remove());
  };
}
