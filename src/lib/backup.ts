/** Respaldo completo (datos + archivos de facturas) en un solo .json, para guardar en Archivos/iCloud o pasar a otro teléfono. */
import { normalizeData } from '../domain/template';
import type { Data } from '../domain/types';
import { loadFile, saveFile } from './db';

interface Backup {
  pengar: 1;
  exportedAt: string;
  data: Data;
  files: Record<string, { mime: string; base64: string }>;
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function makeBackup(data: Data): Promise<Blob> {
  const files: Backup['files'] = {};
  for (const inv of data.invoices) {
    const blob = await loadFile(inv.id);
    if (blob) files[inv.id] = { mime: inv.mime, base64: await toBase64(blob) };
  }
  // La clave de la IA no viaja en el respaldo
  const safe: Data = { ...data, settings: { ...data.settings, ai: { ...data.settings.ai, apiKey: '' } } };
  const backup: Backup = { pengar: 1, exportedAt: new Date().toISOString(), data: safe, files };
  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

export interface ReadBackup {
  data: Data;
  files: Backup['files'];
}

/** Lee el respaldo sin guardar nada: los archivos se escriben recién al confirmar (restoreFiles) */
export async function readBackup(file: File): Promise<ReadBackup> {
  const parsed = JSON.parse(await file.text()) as Partial<Backup>;
  if (parsed.pengar !== 1 || !parsed.data?.categories) throw new Error('Este archivo no es un respaldo de Pengar.');
  return { data: normalizeData(parsed.data), files: parsed.files ?? {} };
}

/** Guarda en el teléfono los archivos de un respaldo (antes de reemplazar los datos) */
export async function restoreFiles(files: Backup['files']): Promise<void> {
  for (const [id, f] of Object.entries(files)) {
    const bytes = Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0));
    await saveFile(id, new Blob([bytes], { type: f.mime }));
  }
}
