/** Leer planillas y exportar archivos (en el iPhone, con la hoja de «Compartir»). */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { Cell } from '../domain/importSheet';
import { isNative } from './platform';

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export async function readSpreadsheet(file: File): Promise<Sheet[]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = /\.csv$/i.test(file.name)
    ? XLSX.read(new TextDecoder().decode(buf), { type: 'string', cellDates: true, raw: false })
    : XLSX.read(buf, { cellDates: true });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null }),
  }));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Descarga (web) o abre «Compartir» (iPhone) para guardar en Archivos, mandar por mail, etc. */
export async function saveOrShare(blob: Blob, fileName: string): Promise<void> {
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: fileName, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title: fileName, url: uri });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Abre una factura guardada para verla */
export async function openFile(blob: Blob, fileName: string): Promise<void> {
  if (isNative) return saveOrShare(blob, fileName);
  window.open(URL.createObjectURL(blob), '_blank');
}
