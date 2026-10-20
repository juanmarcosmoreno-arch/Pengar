/** Carga los datos de ejemplo: la planilla inventada (public/ejemplo.json, generada con scripts/make-example.mjs) más lo anotado en el mes. */
import { today } from '../domain/dates';
import { exampleData } from '../domain/example';
import { importMonthlySheet, isMonthlySheet, type Cell } from '../domain/importSheet';
import type { Data } from '../domain/types';

export async function loadExample(): Promise<Data> {
  const res = await fetch('./ejemplo.json');
  if (!res.ok) throw new Error(`No se pudo bajar ejemplo.json (${res.status})`);
  const rows = (await res.json()) as Cell[][];
  if (!isMonthlySheet(rows)) throw new Error('ejemplo.json no tiene meses');
  return exampleData(importMonthlySheet(rows), today());
}
