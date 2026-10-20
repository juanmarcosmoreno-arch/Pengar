import { CircleAlert, CircleCheck, CircleDashed } from 'lucide-react';
import { formatPct } from '../../domain/money';
import type { CategoryCompare } from '../../domain/stats';
import { useMoney } from '../../lib/useMoney';
import { Icon } from '../Icon';

/**
 * Real contra presupuesto, una fila por categoría: la barra es lo gastado, la marca vertical es el presupuesto.
 * Lo que se pasa del presupuesto se pinta en rojo. El estado va con ícono y palabra, nunca solo con color.
 */
export function BudgetRows({ rows, onSelect }: { rows: CategoryCompare[]; onSelect?: (categoryId: string) => void }) {
  const { money } = useMoney();
  const max = Math.max(1, ...rows.map((r) => Math.max(r.real, r.budget)));
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => {
        const spentW = (Math.min(r.real, r.hasBudget ? r.budget : r.real) / max) * 100;
        const overW = r.hasBudget ? (Math.max(0, r.real - r.budget) / max) * 100 : 0;
        const budgetX = (r.budget / max) * 100;
        return (
          <li key={r.category.id}>
            <button className="w-full py-3 text-left" onClick={() => onSelect?.(r.category.id)}>
              <div className="flex items-center gap-2">
                <Icon name={r.category.icon} size={18} className="text-muted" />
                <span className="min-w-0 flex-1 truncate">{r.category.name}</span>
                <span className="tabular">{money(r.real)}</span>
              </div>
              <div className="relative mt-1.5 h-3 rounded-full bg-sunken">
                {r.hasBudget && <div className="absolute inset-y-0 left-0 rounded-full bg-soft/35" style={{ width: `${budgetX}%` }} />}
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${spentW}%`, background: r.hasBudget ? 'rgb(var(--primary))' : 'rgb(var(--muted))' }} />
                {overW > 0 && (
                  <div className="absolute inset-y-0 rounded-r-full bg-danger" style={{ left: `calc(${budgetX}% + 2px)`, width: `calc(${overW}% - 2px)` }} />
                )}
                {r.hasBudget && <div className="absolute -top-1 -bottom-1 w-[2px] rounded bg-ink/70" style={{ left: `${budgetX}%` }} />}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[14px] text-muted">
                {r.status === 'over' && <><CircleAlert size={14} className="text-danger" /><span className="text-danger">Pasado por {money(r.diff)}</span></>}
                {r.status === 'ok' && <><CircleCheck size={14} className="text-ok" /><span>Quedan {money(-r.diff)}</span></>}
                {r.status === 'none' && <><CircleDashed size={14} /><span>Sin presupuesto</span></>}
                {r.hasBudget && <span className="ml-auto tabular">de {money(r.budget)}{r.pct != null && r.budget > 0 ? ` · ${formatPct(r.real / r.budget)}` : ''}</span>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
