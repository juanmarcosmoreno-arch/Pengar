/** Carga los datos de ejemplo: la planilla inventada (public/ejemplo.xlsx) más lo anotado en el mes. */
import { today } from '../domain/dates';
import { exampleData } from '../domain/example';
import { importMonthlySheet, isMonthlySheet } from '../domain/importSheet';
import type { Data } from '../domain/types';
import { readSpreadsheet } from './files';

export async function loadExample(): Promise<Data> {
  const res = await fetch('./ejemplo.xlsx');
  if (!res.ok) throw new Error(`No se pudo bajar ejemplo.xlsx (${res.status})`);
  const sheets = await readSpreadsheet(new File([await res.blob()], 'ejemplo.xlsx'));
  const sheet = sheets.find((s) => isMonthlySheet(s.rows));
  if (!sheet) throw new Error('ejemplo.xlsx no tiene meses');
  return exampleData(importMonthlySheet(sheet.rows), today());
}
