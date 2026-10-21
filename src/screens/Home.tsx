import { ArrowDown, ArrowUp, Camera, CreditCard, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BudgetRows } from '../components/charts/BudgetRows';
import { Columns } from '../components/charts/Columns';
import { ExampleBanner } from '../components/ExampleBanner';
import { CategoryBubble } from '../components/Icon';
import { Suricata, type Pose } from '../components/Suricata';
import { MovementRow } from '../components/MovementRow';
import { useToast } from '../components/Toast';
import { addMonths, currentMonth, monthLabel, today } from '../domain/dates';
import { formatPct } from '../domain/money';
import { pendingRecurring, type PendingRecurring } from '../domain/recurring';
import { expenseChange, kpis, monthly, monthSummary } from '../domain/stats';
import { OTHER_COLOR } from '../domain/template';
import type { Kind, Movement, Recurring } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

// El suricata saluda solo la primera vez que se abre Inicio en la sesión
let greeted = false;

export function Home({ onAdd, onScan, onStatement, onEdit, onRecord, onGo }: {
  onAdd: (kind: Kind) => void;
  onScan: () => void;
  /** Estado de cuenta de la tarjeta */
  onStatement: () => void;
  onEdit: (m: Movement) => void;
  /** Anotar un gasto fijo (abre el formulario con su monto estimado) */
  onRecord: (r: Recurring) => void;
  onGo: (where: 'movimientos' | 'mes') => void;
}) {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const [wave] = useState(() => !greeted);
  useEffect(() => { greeted = true; }, []);
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
  // La cara del suricata según cómo viene el mes
  const mood: Pose = k.balance < 0 ? 'cara-preocupado' : summary.budget > 0 && summary.diff > 0 ? 'cara-pensando' : k.income > 0 ? 'cara-feliz' : 'cara-normal';

  return (
    <div className="space-y-4 px-4 pt-[calc(env(safe-area-inset-top)+16px)]">
      <header className="flex items-end justify-between px-1">
        <div className="pb-2">
          <div className="text-xl text-muted">Hola,</div>
          <h1 className="text-4xl leading-tight">{data.settings.name || 'de nuevo'}</h1>
        </div>
        <Suricata pose="saludando" size={92} flip motion={wave ? 'wave' : undefined} />
      </header>

      <ExampleBanner />

      <section className="card relative overflow-hidden p-5">
        <div className="text-lg text-muted">Te queda en {monthLabel(month, { year: false }).toLowerCase()}</div>
        <div className={`mt-1 text-[44px] leading-none ${k.balance < 0 ? 'text-danger' : ''}`}>{money(k.balance)}</div>
        <div className="mt-2 pr-20 text-[15px] text-muted">
          Entró {money(k.income)} · Gastaste {money(k.expense)}{savings > 0 ? ` · Ahorraste ${money(savings)}` : ''}
        </div>
        {change != null && (
          <div className={`mt-2 flex items-center gap-1 pr-20 text-[15px] ${change > 0 ? 'text-danger' : 'text-ok'}`}>
            {change > 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            {formatPct(Math.abs(change))} {change > 0 ? 'más' : 'menos'} de gastos que el mes anterior
          </div>
        )}
        <Suricata pose={mood} size={104} flip className="absolute -bottom-1 right-2" />
      </section>

      <section className="grid grid-cols-4 gap-2 px-1">
        {[
          { label: 'Gasto', icon: <Minus size={24} />, run: () => onAdd('gasto') },
          { label: 'Ingreso', icon: <Plus size={24} />, run: () => onAdd('ingreso') },
          { label: 'Factura', icon: <Camera size={24} />, run: onScan },
          { label: 'Tarjeta', icon: <CreditCard size={24} />, run: onStatement },
        ].map((a) => (
          <button key={a.label} className="flex flex-col items-center gap-1 text-[15px]" onClick={a.run}>
            <span className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-soft/25 text-primary">{a.icon}</span>
            {a.label}
          </button>
        ))}
      </section>

      <DueRecurring onRecord={onRecord} />

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
          <div className="flex items-center gap-3 py-3">
            <Suricata pose="lista" size={96} />
            <p className="text-muted">
            {hasMonthsOnly
              ? 'Tus meses importados están en Movimientos. Lo que anotes desde ahora aparece acá, día por día.'
              : 'Todavía no anotaste nada. Tocá «Gasto» o sacale una foto a una factura.'}
            </p>
          </div>
        )}
      </section>
      <div className="h-4" />
    </div>
  );
}

/** «Netflix el 20, Club el 25 y UTE el 28» (los primeros cuatro) */
function laterText(list: PendingRecurring[], name: (r: PendingRecurring) => string): string {
  const parts = list.slice(0, 4).map((r) => `${name(r)} el ${r.day}`);
  if (list.length > 4) parts.push(`${list.length - 4} más`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0];
}

/** Los gastos fijos del mes que ya llegaron a su día y todavía no se anotaron */
function DueRecurring({ onRecord }: { onRecord: (r: Recurring) => void }) {
  const { data, ix, update, markRecurring, recordAllDue } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const now = today();
  const month = currentMonth();
  const pending = pendingRecurring(data, month, now);
  const due = pending.filter((r) => r.due);
  if (!due.length) return null;
  const later = pending.filter((r) => !r.due);
  const name = (r: Recurring) => ix.rubro.get(r.rubroId)?.name ?? 'Sin rubro';
  const original = (r: PendingRecurring) => data.recurring.find((x) => x.id === r.id) ?? r;

  const skip = (r: PendingRecurring) => {
    const before = original(r).doneThrough;
    markRecurring(r.id, month);
    toast(`Salteaste «${name(r)}» este mes`, {
      label: 'Deshacer',
      run: () => update((d) => ({ ...d, recurring: d.recurring.map((x) => (x.id === r.id ? { ...x, doneThrough: before } : x)) })),
    });
  };
  const recordAll = () => {
    const { count, undo } = recordAllDue(month, now);
    if (count) toast(`${count} ${count === 1 ? 'movimiento anotado' : 'movimientos anotados'}`, { label: 'Deshacer', run: undo });
  };

  return (
    <section className="card px-5 pt-4 pb-2">
      <div className="flex items-baseline justify-between">
        <h2 className="section-title">Para anotar este mes</h2>
        {due.length > 1 && <button className="text-primary" onClick={recordAll}>Anotar todos</button>}
      </div>
      <div className="text-[15px] text-muted">Tus gastos fijos, con el monto estimado</div>
      <div className="divide-y divide-line">
        {due.map((r) => {
          const cat = ix.category.get(ix.rubro.get(r.rubroId)?.categoryId ?? '');
          return (
            <div key={r.id} className="flex items-center gap-3 py-2">
              <CategoryBubble icon={cat?.icon ?? 'tag'} color={cat?.color ?? OTHER_COLOR} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-lg leading-tight">{name(r)}</div>
                <div className="truncate text-[15px]">
                  <span className="text-muted">el {r.day} · </span>
                  <span className={`tabular ${r.kind === 'ingreso' ? 'text-ok' : ''}`}>{r.kind === 'ingreso' ? '+ ' : ''}{money(r.amount)}</span>
                </div>
              </div>
              <button className="min-h-tap px-1 text-[16px] text-muted" onClick={() => skip(r)} aria-label={`Saltar ${name(r)}`}>Saltar</button>
              <button className="chip text-primary" onClick={() => onRecord(original(r))} aria-label={`Anotar ${name(r)}`}>Anotar</button>
            </div>
          );
        })}
      </div>
      {later.length > 0 && (
        <p className="border-t border-line py-2 text-[15px] text-muted">Más adelante: {laterText(later, name)}</p>
      )}
    </section>
  );
}
