/** Respaldo completo (datos + archivos de facturas) en un solo .json, para guardar en Archivos/iCloud o pasar a otro teléfono. */
import { normalizeData } from '../domain/template';
import type { Data } from '../domain/types';
import { loadFile, saveFile } from './db';

export type BackupFiles = Record<string, { mime: string; base64: string }>;

interface Backup {
  pengar: 1;
  exportedAt: string;
  data: Data;
  files: BackupFiles;
  /**
   * El respaldo automático no lleva los archivos adentro: van una sola vez, cada uno en su archivo (lib/autoBackup).
   * Acá, de qué facturas hay archivo
   */
  fileRefs?: string[];
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export const fileToBackup = async (blob: Blob, mime: string) => ({ mime, base64: await toBase64(blob) });

/** La clave de la IA no viaja en el respaldo */
const safeData = (data: Data): Data => ({ ...data, settings: { ...data.settings, ai: { ...data.settings.ai, apiKey: '' } } });

/**
 * El respaldo con los archivos adentro. `load`: de dónde salen los archivos (en un hogar compartido, el que baja los
 * que este teléfono nunca abrió: lib/sync loadInvoiceFile). `missing`: cuántas facturas quedaron sin su archivo
 */
export async function buildBackup(data: Data, load: (id: string) => Promise<Blob | undefined> = loadFile): Promise<{ blob: Blob; missing: number }> {
  const files: BackupFiles = {};
  let missing = 0;
  for (const inv of data.invoices) {
    const blob = await load(inv.id).catch((e) => {
      console.warn('Respaldo: no se pudo traer el archivo', inv.id, e);
      return undefined;
    });
    if (blob) files[inv.id] = await fileToBackup(blob, inv.mime);
    else missing++;
  }
  const backup: Backup = { pengar: 1, exportedAt: new Date().toISOString(), data: safeData(data), files };
  return { blob: new Blob([JSON.stringify(backup)], { type: 'application/json' }), missing };
}

export const makeBackup = async (data: Data, load?: (id: string) => Promise<Blob | undefined>): Promise<Blob> => (await buildBackup(data, load)).blob;

/** El respaldo automático: los datos solos, con la lista de las facturas que tienen archivo (`fileRefs`) */
export function backupWithoutFiles(data: Data, fileRefs: string[]): string {
  const backup: Backup = { pengar: 1, exportedAt: new Date().toISOString(), data: safeData(data), files: {}, fileRefs };
  return JSON.stringify(backup);
}

export interface ReadBackup {
  data: Data;
  files: BackupFiles;
  /** Uno automático: los archivos van aparte (los junta lib/autoBackup) */
  fileRefs?: string[];
}

const NOT_A_BACKUP = 'Este archivo no es un respaldo de Pengar.';
const LISTS = ['categories', 'rubros', 'movements', 'invoices', 'goals', 'recurring'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Lee el respaldo (el archivo elegido o uno automático) sin guardar nada: los archivos se escriben recién al confirmar
 * (restoreFiles). Uno con las listas rotas (no es una lista, o algo sin id) no se acepta: dejaría la app en blanco
 */
export async function readBackup(file: Blob): Promise<ReadBackup> {
  let parsed: Partial<Backup>;
  try {
    parsed = JSON.parse(await file.text()) as Partial<Backup>;
  } catch {
    // Otro archivo, o uno cortado a la mitad
    throw new Error(NOT_A_BACKUP);
  }
  const d = parsed?.data as unknown;
  if (parsed?.pengar !== 1 || !isObj(d) || !Array.isArray(d.categories)) throw new Error(NOT_A_BACKUP);
  for (const key of LISTS) {
    const list = d[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((x) => isObj(x) && typeof x.id === 'string' && x.id)) throw new Error(NOT_A_BACKUP);
  }
  if (d.settings !== undefined && !isObj(d.settings)) throw new Error(NOT_A_BACKUP);
  const files = isObj(parsed.files) ? (parsed.files as BackupFiles) : {};
  const fileRefs = Array.isArray(parsed.fileRefs) ? parsed.fileRefs.filter((x): x is string => typeof x === 'string') : undefined;
  return { data: normalizeData(d as Partial<Data>), files, ...(fileRefs ? { fileRefs } : {}) };
}

/** Guarda en el teléfono los archivos de un respaldo (antes de reemplazar los datos) */
export async function restoreFiles(files: BackupFiles): Promise<void> {
  for (const [id, f] of Object.entries(files)) {
    if (!f || typeof f.base64 !== 'string') continue;
    const bytes = Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0));
    await saveFile(id, new Blob([bytes], { type: typeof f.mime === 'string' ? f.mime : 'application/octet-stream' }));
  }
}
