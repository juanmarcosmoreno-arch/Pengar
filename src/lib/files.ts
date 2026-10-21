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
 * Las hojas de una planilla. Los CSV quedan como texto, sin convertir fechas ni números: traen «05/10/2026» y
 * «1.234,56», que la conversión automática lee al estilo de Estados Unidos (el 10 de mayo y 1,23456). Quien los lee
 * (importar, estados de cuenta) ya entiende el texto.
 */
export async function readSpreadsheet(file: File): Promise<Sheet[]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = /\.csv$/i.test(file.name)
    ? XLSX.read(decodeText(buf), { type: 'string', cellDates: true, raw: true })
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
 * Cerrar «Compartir» sin elegir nada no es un error; si no se pudo escribir el archivo o compartir, tira.
 */
export async function saveOrShare(blob: Blob, fileName: string): Promise<boolean> {
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: fileName, data: await blobToBase64(blob), directory: Directory.Cache });
    try {
      await Share.share({ title: fileName, url: uri });
    } catch (e) {
      if (!/cancel/i.test(String(e))) throw e;
    }
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
