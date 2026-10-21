import { Delete } from 'lucide-react';
import { useState } from 'react';
import { calcText, calculate } from '../domain/calc';

/** Mini calculadora para el monto: empieza con lo escrito; «Usar» pone el resultado */
export function Calculator({ start, onUse, onClose }: { start: number | null; onUse: (text: string) => void; onClose: () => void }) {
  const [expr, setExpr] = useState(start != null && start > 0 ? calcText(start) : '');
  const result = calculate(expr);
  const press = (k: string) => {
    if (k === 'C') return setExpr('');
    if (k === '⌫') return setExpr((e) => e.slice(0, -1));
    if (k === '=') return setExpr(result != null ? calcText(result) : expr);
    setExpr((e) => {
      const last = e.slice(-1);
      // Dos operadores seguidos: queda el último (salvo un «−» para un número negativo)
      if (/[+×÷]/.test(k) && /[+\-×÷]/.test(last)) return e.slice(0, -1) + k;
      if (k === ',' && /,\d*$/.test(e.split(/[+\-×÷]/).at(-1) ?? '')) return e;
      return e + k;
    });
  };
  const keys = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', ',', '0', '⌫', '+'];
  return (
    <div className="mt-3 rounded-3xl border border-line bg-surface p-3" role="group" aria-label="Calculadora">
      <div className="mb-2 flex min-h-[44px] items-baseline justify-end gap-3 px-2 text-right">
        <span className="min-w-0 flex-1 break-all text-2xl tabular" aria-live="polite">{expr || '0'}</span>
        {result != null && /[+\-×÷]/.test(expr) && <span className="shrink-0 text-xl text-muted tabular">= {calcText(result)}</span>}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {keys.map((k) => {
          const op = '÷×−+'.includes(k);
          return (
            <button
              key={k}
              type="button"
              className={`flex h-12 items-center justify-center rounded-2xl text-2xl ${op ? 'bg-soft/40 text-primary' : 'bg-sunken'}`}
              onClick={() => press(k === '−' ? '-' : k)}
              aria-label={k === '⌫' ? 'Borrar' : k === '−' ? 'Menos' : k === '×' ? 'Por' : k === '÷' ? 'Dividido' : k === '+' ? 'Más' : k}
            >
              {k === '⌫' ? <Delete size={22} /> : k}
            </button>
          );
        })}
        <button type="button" className="h-12 rounded-2xl bg-sunken text-xl" onClick={() => press('C')}>C</button>
        <button type="button" className="h-12 rounded-2xl bg-sunken text-xl" onClick={onClose}>Cerrar</button>
        <button
          type="button"
          className="btn-primary col-span-2 h-12"
          disabled={result == null || result <= 0}
          onClick={() => result != null && onUse(calcText(result))}
        >
          Usar {result != null && result > 0 ? calcText(result) : ''}
        </button>
      </div>
    </div>
  );
}
