/**
 * Carga los datos de ejemplo: la planilla inventada (public/ejemplo.json, generada con scripts/make-example.mjs) más lo
 * anotado en el mes. Sobre la misma planilla se arman los del modo demo (domain/demo).
 */
import { today } from '../domain/dates';
import { demoData, type DemoSet } from '../domain/demo';
import { exampleData } from '../domain/example';
import { importMonthlySheet, isMonthlySheet, type Cell, type ImportResult } from '../domain/importSheet';
import type { Data } from '../domain/types';

async function loadSheet(): Promise<ImportResult> {
  const res = await fetch('./ejemplo.json');
  if (!res.ok) throw new Error(`No se pudo bajar ejemplo.json (${res.status})`);
  const rows = (await res.json()) as Cell[][];
  if (!isMonthlySheet(rows)) throw new Error('ejemplo.json no tiene meses');
  return importMonthlySheet(rows);
}

export async function loadExample(): Promise<Data> {
  return exampleData(await loadSheet(), today());
}

/** Los datos inventados del modo demo, con el archivo de su factura */
export async function loadDemo(): Promise<DemoSet> {
  return demoData(await loadSheet(), today());
}
