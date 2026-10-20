import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { MovementRow } from '../components/MovementRow';
import { PageHeader } from '../components/Sheet';
import { addMonths, currentMonth, dayLabel, monthLabel, monthOf } from '../domain/dates';
import { norm } from '../domain/importSheet';
import type { Movement } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

type KindFilter = 'todos' | 'gasto' | 'ingreso';

export function Movements({ onAdd, onEdit, month, setMonth }: {
  onAdd: () => void;
  onEdit: (m: Movement) => void;
  month: string;
  setMonth: (m: string) => void;
}) {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('todos');

  const list = useMemo(() => {
    const nq = norm(q);
    return data.movements
      .filter((m) => (q ? true : monthOf(m.date) === month))
      .filter((m) => kind === 'todos' || m.kind === kind)
      .filter((m) => {
        if (!nq) return true;
        const text = [ix.rubro.get(m.rubroId)?.name, ix.categoryOf(m)?.name, m.note, m.merchant].filter(Boolean).join(' ');
        return norm(text).includes(nq);
      })
      .sort((a, b) => b.date.localeCompare(a.date) || Number(!!a.monthly) - Number(!!b.monthly) || b.createdAt - a.createdAt);
  }, [data.movements, month, q, kind, ix]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: Movement[] }[] = [];
    for (const m of list) {
      const key = m.monthly ? `mes:${monthOf(m.date)}` : m.date;
      const label = m.monthly ? `${monthLabel(monthOf(m.date))} · totales de la planilla` : dayLabel(m.date);
      const g = out[out.length - 1];
      if (g?.key === key) g.items.push(m);
      else out.push({ key, label, items: [m] });
    }
    return out;
  }, [list]);

  const spent = list.filter((m) => m.kind === 'gasto').reduce((s, m) => s + m.amount, 0);
  const earned = list.filter((m) => m.kind === 'ingreso').reduce((s, m) => s + m.amount, 0);

  return (
    <div>
      <PageHeader title="Movimientos" />
      <div className="space-y-3 px-4">
        <div className="relative">
          <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input className="field rounded-full pl-10" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!q && (
          <div className="flex items-center justify-between">
            <button className="flex min-h-tap min-w-tap items-center justify-center" onClick={() => setMonth(addMonths(month, -1))} aria-label="Mes anterior"><ChevronLeft /></button>
            <div className="text-xl">{monthLabel(month)}</div>
            <button className="flex min-h-tap min-w-tap items-center justify-center disabled:opacity-30" disabled={month >= currentMonth()} onClick={() => setMonth(addMonths(month, 1))} aria-label="Mes siguiente"><ChevronRight /></button>
          </div>
        )}
        <div className="flex gap-2">
          {(['todos', 'gasto', 'ingreso'] as KindFilter[]).map((k) => (
            <button key={k} className={kind === k ? 'chip-on' : 'chip'} onClick={() => setKind(k)}>
              {k === 'todos' ? 'Todos' : k === 'gasto' ? 'Gastos' : 'Ingresos'}
            </button>
          ))}
        </div>
        <div className="flex gap-4 text-[15px] text-muted">
          <span>Gastos {money(spent)}</span>
          <span>Ingresos {money(earned)}</span>
        </div>

        {groups.map((g) => (
          <section key={g.key}>
            <h2 className="mt-2 text-lg text-muted">{g.label}</h2>
            <div className="divide-y divide-line">{g.items.map((m) => <MovementRow key={m.id} m={m} onClick={() => onEdit(m)} />)}</div>
          </section>
        ))}
        {!groups.length && <p className="py-10 text-center text-muted">{q ? 'Nada coincide con la búsqueda.' : 'No hay movimientos este mes.'}</p>}
        <div className="h-20" />
      </div>
      <button
        className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom)+80px)] z-20 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-on-primary shadow-lg active:scale-95"
        onClick={onAdd}
        aria-label="Agregar movimiento"
      >
        <Plus size={30} />
      </button>
    </div>
  );
}
