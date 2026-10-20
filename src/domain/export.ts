import { buildIndex } from './stats';
import type { Data } from './types';

const csvCell = (v: string | number | undefined) => {
  const s = v == null ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Movimientos en CSV (se puede volver a importar en Pengar o abrir en Excel) */
export function movementsCsv(data: Data): string {
  const ix = buildIndex(data);
  const rows = [...data.movements]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((m) => [m.date, m.kind, ix.rubro.get(m.rubroId)?.name, ix.categoryOf(m)?.name, m.amount, m.note, m.merchant].map(csvCell).join(','));
  return ['Fecha,Tipo,Rubro,Categoría,Monto,Nota,Comercio', ...rows].join('\n');
}
