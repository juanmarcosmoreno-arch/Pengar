// Genera datos/ejemplo.xlsx: una planilla con el mismo formato que la planilla real de presupuesto
// (un mes por columna, letra de categoría, tabla con PROYECTADO), con montos inventados.
// Sirve para las pruebas, las capturas y para que alguien vea el formato.
import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const months = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2024, 10 + i, 1)));

// [rubro, letra, monto típico, variación, probabilidad de que haya gasto ese mes]
const rubros = [
  ['Diezmo', 'D', 0, 0, 1],
  ['Alquiler', 'F', 24000, 0.05, 1],
  ['UTE', 'F', 5200, 0.3, 1],
  ['OSE', 'F', 760, 0.15, 1],
  ['Antel', 'F', 2600, 0.05, 1],
  ['Celular', 'F', 1300, 0.05, 1],
  ['Supermercado', 'A', 13000, 0.35, 1],
  ['Feria', 'A', 3200, 0.5, 0.95],
  ['Carnicería', 'A', 4200, 0.4, 0.9],
  ['Limpieza', 'H', 1800, 0.5, 0.9],
  ['Netflix', 'ST', 500, 0, 1],
  ['Spotify', 'ST', 480, 0, 1],
  ['Combustible', 'T', 9000, 0.4, 0.9],
  ['Mantenimiento auto', 'T', 3500, 0.9, 0.5],
  ['Seguro', 'T', 4800, 0.1, 0.6],
  ['Emergencia móvil', 'S', 4900, 0.08, 1],
  ['Farmacia', 'S', 3000, 0.8, 0.85],
  ['Club', 'E', 3200, 0.2, 1],
  ['Librería', 'E', 800, 0.7, 0.7],
  ['Ropa', 'V', 5000, 0.7, 0.85],
  ['Arreglos casa', 'M', 4000, 0.8, 0.8],
  ['Compras online', 'B', 4200, 0.6, 0.9],
  ['Comer afuera', 'X', 3800, 0.6, 0.9],
  ['Paseos', 'X', 6000, 1.2, 0.7],
  ['Regalos', 'X', 2200, 0.8, 0.6],
  ['Leña y gas', 'C', 2500, 0.6, 0.4],
  ['Varios', 'O', 3500, 0.9, 0.85],
  ['Ahorro', 'I', 30000, 0.6, 0.95],
];
const table = [
  ['A', 'Alimentación', 24000], ['B', 'Bienes de Uso', 4000], ['C', 'Calefacción / Gas', 1500], ['D', 'Diezmos / Ofrendas', null],
  ['E', 'Educación', 4000], ['F', 'Fijos', 35000], ['H', 'Limpieza', 2500], ['I', 'Inversión / Ahorro', 30000],
  ['M', 'Mantenimiento', 4000], ['O', 'Otros', 4000], ['S', 'Salud', 8000], ['T', 'Transporte', 16000],
  ['V', 'Vestimenta', 4000], ['X', 'Extras', 9000], ['ST', 'Internet', 1500],
];

const income = months.map((_, i) => Math.round(150000 + i * 1500 + (rnd() - 0.4) * 30000 + (i % 12 === 7 ? 60000 : 0)));
const rows = [['gasto', 'cat', ...months, null, null, 'PROYECTADO']];
rows.push(['Entrada', null, ...income]);
const totals = months.map(() => 0);
for (const [name, cat, base, vari, p] of rubros) {
  const values = months.map((_, i) => {
    if (name === 'Diezmo') return Math.round(income[i] * 0.1);
    if (rnd() > p) return null;
    return Math.max(50, Math.round(base * (1 + (rnd() - 0.5) * 2 * vari)));
  });
  values.forEach((v, i) => (totals[i] += v ?? 0));
  rows.push([name, cat, ...values]);
}
rows.push(['TOTAL', null, ...totals]);
rows.push(['BALANCE', null, ...totals.map((t, i) => income[i] - t)]);
// Tabla de categorías a la derecha (columnas tras dos vacías)
const tcol = 2 + months.length + 2;
table.forEach((t, i) => {
  const r = rows[i + 1] ?? (rows[i + 1] = []);
  r[tcol - 2 + 0] = r[tcol - 2 + 0] ?? null;
  r[tcol] = t[0];
  r[tcol + 1] = t[1];
  r[tcol + 2] = t[2];
});
rows[0][tcol] = null;
rows[0][tcol + 1] = null;
rows[0][tcol + 2] = 'PROYECTADO';
rows[0].length = tcol + 3;
const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'presupuesto');
writeFileSync(resolve(root, 'datos/ejemplo.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
console.log('✓ datos/ejemplo.xlsx', { meses: months.length, rubros: rubros.length + 1 });
