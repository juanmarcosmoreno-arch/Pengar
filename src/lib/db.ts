/** Todo se guarda en el teléfono (IndexedDB): los datos en una clave y cada archivo de factura en la suya. */
import { createStore, del, get, set } from 'idb-keyval';
import { emptyData } from '../domain/template';
import type { Data } from '../domain/types';

const store = createStore('pengar', 'kv');

export async function loadData(): Promise<Data | null> {
  const d = await get<Data>('data', store);
  if (!d) return null;
  // Completa campos nuevos si los datos son de una versión anterior
  const base = emptyData();
  return { ...base, ...d, settings: { ...base.settings, ...d.settings, ai: { ...base.settings.ai, ...d.settings?.ai }, currency: { ...base.settings.currency, ...d.settings?.currency } } };
}

export const saveData = (d: Data) => set('data', d, store);

export const saveFile = (id: string, file: Blob) => set(`file:${id}`, file, store);
export const loadFile = (id: string) => get<Blob>(`file:${id}`, store);
export const deleteFile = (id: string) => del(`file:${id}`, store);
