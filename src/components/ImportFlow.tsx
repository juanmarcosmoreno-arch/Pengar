import { FileSpreadsheet } from 'lucide-react';
import { useRef, useState } from 'react';
import { monthLabel } from '../domain/dates';
import {
  importMonthlySheet, importMovementSheet, isMonthlySheet, isMovementSheet, type ImportResult,
} from '../domain/importSheet';
import { readSpreadsheet, type Sheet } from '../lib/files';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

/**
 * Importar una planilla (.xlsx o .csv): elegir el archivo, ver un resumen y confirmar.
 * `mode`: 'replace' cambia todo por lo de la planilla (al empezar); 'ask' deja elegir si sumar o reemplazar.
 */
export function ImportFlow({ mode, name, onDone, compact = false }: { mode: 'replace' | 'ask'; name?: string; onDone: () => void; compact?: boolean }) {
  const { data, applyImport } = useStore();
  const { money } = useMoney();
  const input = useRef<HTMLInputElement>(null);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [result, setResult] = useState<{ res: ImportResult; sheet: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const analyze = (s: Sheet) => {
    try {
      if (isMonthlySheet(s.rows)) setResult({ res: importMonthlySheet(s.rows), sheet: s.name });
      else if (isMovementSheet(s.rows)) setResult({ res: importMovementSheet(s.rows, data), sheet: s.name });
      else setError(`No reconozco el formato de la hoja «${s.name}». Mirá el formato esperado más abajo.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo leer la planilla.');
    }
  };

  const onFile = async (file: File) => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const all = await readSpreadsheet(file);
      const usable = all.filter((s) => isMonthlySheet(s.rows) || isMovementSheet(s.rows));
      if (usable.length === 1) analyze(usable[0]);
      else if (usable.length > 1) setSheets(usable);
      else setError('No encontré ni meses en columnas ni una columna de fecha y monto en el archivo.');
    } catch {
      setError('No se pudo abrir el archivo. Tiene que ser .xlsx o .csv.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = (how: 'replace' | 'merge') => {
    if (!result) return;
    applyImport(result.res, how, name);
    onDone();
  };

  const res = result?.res;
  const expense = res ? res.movements.filter((m) => m.kind === 'gasto').reduce((s, m) => s + m.amount, 0) : 0;
  const hasData = data.movements.length > 0 || data.rubros.length > 0;

  return (
    <div className="space-y-4">
      <input
        ref={input}
        type="file"
        accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f); }}
      />
      {!res && (
        <button className={compact ? 'btn-outline w-full' : 'btn-primary w-full'} disabled={busy} onClick={() => input.current?.click()}>
          <FileSpreadsheet size={20} /> {busy ? 'Leyendo…' : 'Elegir planilla (.xlsx o .csv)'}
        </button>
      )}
      {sheets && !res && (
        <div className="space-y-2">
          <p className="text-muted">El archivo tiene varias hojas. ¿Cuál importo?</p>
          {sheets.map((s) => <button key={s.name} className="chip mr-2" onClick={() => analyze(s)}>{s.name}</button>)}
        </div>
      )}
      {error && <p className="text-danger">{error}</p>}
      {res && (
        <div className="card space-y-2 p-4">
          <div className="text-xl">Hoja «{result!.sheet}»</div>
          <ul className="space-y-1 text-[17px]">
            <li>{res.movements.length} montos {res.months.length > 0 && <>de {monthLabel(res.months[0]).toLowerCase()} a {monthLabel(res.months[res.months.length - 1]).toLowerCase()}</>}</li>
            <li>{res.rubros.length} rubros nuevos en {res.categories.length} categorías</li>
            <li>Gastos en total: {money(expense)}</li>
          </ul>
          {res.warnings.slice(0, 4).map((w) => <p key={w} className="text-[15px] text-muted">{w}</p>)}
          <div className="flex flex-col gap-2 pt-2">
            {mode === 'replace' || !hasData ? (
              <button className="btn-primary" onClick={() => confirm('replace')}>Importar</button>
            ) : (
              <>
                <button className="btn-primary" onClick={() => confirm('merge')}>Sumar a lo que ya tengo</button>
                <button className="btn-outline" onClick={() => confirm('replace')}>Reemplazar todo por la planilla</button>
              </>
            )}
            <button className="btn-ghost" onClick={() => { setResult(null); setSheets(null); }}>Elegir otro archivo</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ImportFormatHelp() {
  return (
    <details className="text-[15px] text-muted">
      <summary className="cursor-pointer text-primary">¿Qué formato tiene que tener la planilla?</summary>
      <div className="mt-2 space-y-2">
        <p><b>Un mes por columna</b>: en la primera columna el rubro (UTE, Netflix…), en la segunda la letra de su categoría, y después una columna por mes con la fecha en el encabezado. La fila «Entrada» (o «Ingresos», «Sueldo») son los ingresos; TOTAL y BALANCE se ignoran.</p>
        <p>Opcional: una tabla con la letra, el nombre de cada categoría y una columna <b>PROYECTADO</b> con el presupuesto mensual.</p>
        <p><b>Un movimiento por fila</b>: columnas Fecha, Rubro, Categoría y Monto (y si querés, Tipo y Nota). Es el mismo formato que exporta Pengar.</p>
      </div>
    </details>
  );
}
