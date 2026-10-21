/** Todo se guarda en el teléfono (IndexedDB): los datos en una clave y cada archivo de factura en la suya. */
import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import { normalizeData } from '../domain/template';
import type { Data } from '../domain/types';
import { isPreview } from './platform';

// Sin IndexedDB (navegación privada vieja) o en la vista previa dentro de otra página, lo que no se puede guardar queda
// en memoria mientras la página esté abierta. En la app, si IndexedDB está pero falla, el error sube: «no se pudo leer»
// no es «no hay datos» (si no, el primer cambio pisaría lo guardado) y «no se pudo guardar» se avisa
let kv: UseStore | null | undefined;
const memory = new Map<string, unknown>();

function store(): UseStore | null {
  if (kv === undefined) {
    try {
      kv = createStore('pengar', 'kv');
    } catch {
      kv = null;
    }
  }
  return kv;
}

async function read<T>(key: string): Promise<T | undefined> {
  if (memory.has(key)) return memory.get(key) as T | undefined;
  const s = store();
  if (!s) return undefined;
  try {
    return await get<T>(key, s);
  } catch (e) {
    if (isPreview) return undefined;
    throw e;
  }
}

/** false si quedó solo en memoria aunque IndexedDB está (en la vista previa: no se pudo guardar ese valor) */
async function write(key: string, value: unknown): Promise<boolean> {
  const s = store();
  if (!s) {
    memory.set(key, value);
    return true;
  }
  try {
    await set(key, value, s);
    memory.delete(key);
    return true;
  } catch (e) {
    if (!isPreview) throw e;
    memory.set(key, value);
    return false;
  }
}

/** Lo guardado, o null si no hay nada. Si no se pudo leer, tira (no es lo mismo que no tener datos) */
export async function loadData(): Promise<Data | null> {
  const d = await read<Data>('data');
  return d ? normalizeData(d) : null;
}

export const saveData = (d: Data) => write('data', d);

export const saveFile = (id: string, file: Blob) => write(`file:${id}`, file);
export const loadFile = (id: string) => read<Blob>(`file:${id}`).catch(() => undefined);
export async function deleteFile(id: string): Promise<void> {
  memory.delete(`file:${id}`);
  const s = store();
  if (s) await del(`file:${id}`, s).catch(() => {});
}

/** Borra los archivos de facturas y estados de cuenta que ya no están en los datos (después de «Borrar todo», restaurar…) */
export async function pruneFiles(keep: Set<string>): Promise<void> {
  const stale = (k: string) => k.startsWith('file:') && !keep.has(k.slice(5));
  for (const k of [...memory.keys()]) if (stale(k)) memory.delete(k);
  const s = store();
  if (!s) return;
  const all = await keys(s).catch(() => [] as IDBValidKey[]);
  for (const k of all) if (typeof k === 'string' && stale(k)) await del(k, s).catch(() => {});
}
