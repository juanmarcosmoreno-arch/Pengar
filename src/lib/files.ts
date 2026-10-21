/** Leer planillas y exportar archivos (en el iPhone, con la hoja de «Compartir»). */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { Cell } from '../domain/importSheet';
import { isNative, isPreview } from './platform';

export interface Sheet {
  name: string;
  rows: Cell[][];
}

/** CSV en UTF-8 o, si no lo es (los que exportan algunos bancos), en Windows-1252 */
function decodeText(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder().decode(buf);
  return utf8.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

/**
 * `text`: el CSV queda como texto, sin convertir fechas ni números (los estados de cuenta traen «12/09/2025» y
 * «1.234,56», que la conversión automática lee al estilo de Estados Unidos).
 */
export async function readSpreadsheet(file: File, opts: { text?: boolean } = {}): Promise<Sheet[]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = /\.csv$/i.test(file.name)
    ? XLSX.read(decodeText(buf), { type: 'string', cellDates: true, raw: !!opts.text })
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

export const NO_DOWNLOADS = 'En la vista previa no se pueden descargar archivos. En el iPhone se abre «Compartir».';

/**
 * Descarga (web) o abre «Compartir» (iPhone) para guardar en Archivos, mandar por mail, etc.
 * Devuelve false en la vista previa web, donde no se puede descargar: quien llama avisa con NO_DOWNLOADS.
 */
export async function saveOrShare(blob: Blob, fileName: string): Promise<boolean> {
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: fileName, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title: fileName, url: uri });
    return true;
  }
  if (isPreview) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}
