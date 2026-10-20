import { ArrowDown, ArrowUp, Camera, Minus, Plus, Target } from 'lucide-react';
import { BudgetRows } from '../components/charts/BudgetRows';
import { Columns } from '../components/charts/Columns';
import { Sprout } from '../components/Illustrations';
import { MovementRow } from '../components/MovementRow';
import { addMonths, currentMonth, monthLabel } from '../domain/dates';
import { formatPct } from '../domain/money';
import { expenseChange, kpis, monthly, monthSummary } from '../domain/stats';
import type { Kind, Movement } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

export function Home({ onAdd, onScan, onEdit, onGo }: {
  onAdd: (kind: Kind) => void;
  onScan: () => void;
  onEdit: (m: Movement) => void;
  onGo: (where: 'movimientos' | 'mes' | 'presupuesto') => void;
}) {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const month = currentMonth();
  const f = { from: month, to: month, includeSavings: false };
  const k = kpis(data, ix, f);
  const savings = monthly(data, ix, f)[0]?.savings ?? 0;
  const change = expenseChange(data, ix, month);
  const columns = monthly(data, ix, { from: addMonths(month, -6), to: month, includeSavings: false }).map((p) => ({
    key: p.month,
    label: monthLabel(p.month, { short: true, year: false }),
    title: monthLabel(p.month),
    value: p.expense,
  }));
  const summary = monthSummary(data, ix, month, false);
  const budgeted = summary.rows.filter((r) => r.hasBudget).sort((a, b) => b.real / (b.budget || 1) - a.real / (a.budget || 1)).slice(0, 4);
  const recent = [...data.movements]
    .filter((m) => !m.monthly)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
    .slice(0, 5);
  const hasMonthsOnly = !recent.length && data.movements.length > 0;

  return (
    <div className="space-y-4 px-4 pt-[calc(env(safe-area-inset-top)+16px)]">
      <header className="px-1">
        <div className="text-xl text-muted">Hola,</div>
        <h1 className="text-4xl leading-tight">{data.settings.name || 'de nuevo'}</h1>
      </header>

      <section className="card relative overflow-hidden p-5">
        <div className="text-lg text-muted">Te queda en {monthLabel(month, { year: false }).toLowerCase()}</div>
        <div className={`mt-1 text-[44px] leading-none ${k.balance < 0 ? 'text-danger' : ''}`}>{money(k.balance)}</div>
        <div className="mt-2 text-[15px] text-muted">
          Entró {money(k.income)} · Gastaste {money(k.expense)}{savings > 0 ? ` · Ahorraste ${money(savings)}` : ''}
        </div>
        {change != null && (
          <div className={`mt-2 flex items-center gap-1 text-[15px] ${change > 0 ? 'text-danger' : 'text-ok'}`}>
            {change > 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            {formatPct(Math.abs(change))} {change > 0 ? 'más' : 'menos'} de gastos que el mes anterior
          </div>
        )}
        <Sprout className="absolute -right-1 top-3 h-24 w-24 opacity-90" />
      </section>

      <section className="grid grid-cols-4 gap-2 px-1">
        {[
          { label: 'Gasto', icon: <Minus size={24} />, run: () => onAdd('gasto') },
          { label: 'Ingreso', icon: <Plus size={24} />, run: () => onAdd('ingreso') },
          { label: 'Factura', icon: <Camera size={24} />, run: onScan },
          { label: 'Presupuesto', icon: <Target size={24} />, run: () => onGo('presupuesto') },
        ].map((a) => (
          <button key={a.label} className="flex flex-col items-center gap-1 text-[15px]" onClick={a.run}>
            <span className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-soft/25 text-primary">{a.icon}</span>
            {a.label}
          </button>
        ))}
      </section>

      <section className="card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="section-title">Gastos por mes</h2>
          <button className="text-primary" onClick={() => onGo('mes')}>Ver más</button>
        </div>
        <div className="mt-1 text-3xl">{money(k.expense)}</div>
        <div className="text-[15px] text-muted">en {monthLabel(month, { year: false }).toLowerCase()}, sin contar ahorro</div>
        <div className="mt-3">
          <Columns data={columns} highlight={month} />
        </div>
      </section>

      {budgeted.length > 0 && (
        <section className="card px-5 pt-4 pb-2">
          <div className="flex items-baseline justify-between">
            <h2 className="section-title">Presupuesto del mes</h2>
            <button className="text-primary" onClick={() => onGo('mes')}>Ver todo</button>
          </div>
          <div className="text-[15px] text-muted">Gastaste {money(summary.expense)} de {money(summary.budget)}</div>
          <BudgetRows rows={budgeted} onSelect={() => onGo('mes')} />
        </section>
      )}

      <section className="card px-5 pt-4 pb-2">
        <div className="flex items-baseline justify-between">
          <h2 className="section-title">Últimos movimientos</h2>
          <button className="text-primary" onClick={() => onGo('movimientos')}>Ver todos</button>
        </div>
        {recent.length ? (
          <div className="divide-y divide-line">{recent.map((m) => <MovementRow key={m.id} m={m} onClick={() => onEdit(m)} />)}</div>
        ) : (
          <p className="py-4 text-muted">
            {hasMonthsOnly
              ? 'Tus meses importados están en Movimientos. Lo que anotes desde ahora aparece acá, día por día.'
              : 'Todavía no anotaste nada. Tocá «Gasto» o sacale una foto a una factura.'}
          </p>
        )}
      </section>
      <div className="h-4" />
    </div>
  );
}
