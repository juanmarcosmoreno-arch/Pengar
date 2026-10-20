/** Todo se guarda en el teléfono (IndexedDB): los datos en una clave y cada archivo de factura en la suya. */
import { createStore, del, get, set, type UseStore } from 'idb-keyval';
import { normalizeData } from '../domain/template';
import type { Data } from '../domain/types';

// Si IndexedDB no está o falla (navegación privada, la vista previa dentro de otra página), lo que no se pudo
// guardar queda en memoria mientras la página esté abierta
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
  } catch {
    return undefined;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  const s = store();
  try {
    if (!s) throw new Error('sin IndexedDB');
    await set(key, value, s);
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}

export async function loadData(): Promise<Data | null> {
  const d = await read<Data>('data');
  return d ? normalizeData(d) : null;
}

export const saveData = (d: Data) => write('data', d);

export const saveFile = (id: string, file: Blob) => write(`file:${id}`, file);
export const loadFile = (id: string) => read<Blob>(`file:${id}`);
export async function deleteFile(id: string): Promise<void> {
  memory.delete(`file:${id}`);
  const s = store();
  if (s) await del(`file:${id}`, s).catch(() => {});
}
