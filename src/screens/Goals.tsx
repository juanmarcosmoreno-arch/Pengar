import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CategoryBubble, Icon } from '../components/Icon';
import { PageHeader, Sheet } from '../components/Sheet';
import { EmptyState, Suricata } from '../components/Suricata';
import { parseAmount } from '../domain/money';
import { ICON_CHOICES, newId } from '../domain/template';
import type { Goal } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

/** Metas de ahorro: un objetivo y cuánto llevás juntado */
export function Goals({ onBack }: { onBack: () => void }) {
  const { data } = useStore();
  const { money } = useMoney();
  const [edit, setEdit] = useState<Goal | 'new' | null>(null);
  const [add, setAdd] = useState<Goal | null>(null);
  return (
    <div>
      <PageHeader
        title="Metas"
        onBack={onBack}
        right={<button className="flex min-h-tap min-w-tap items-center justify-center text-primary" onClick={() => setEdit('new')} aria-label="Nueva meta"><Plus size={28} /></button>}
      />
      <div className="space-y-3 px-4 pb-10">
        {!data.goals.length && (
          <div className="card">
            <EmptyState pose="metas" title="¿Estás juntando para algo?">
              <p>Vacaciones, el auto, la casa… Poné cuánto necesitás y andá sumando.</p>
              <button className="btn-primary mt-4" onClick={() => setEdit('new')}><Plus size={18} /> Nueva meta</button>
            </EmptyState>
          </div>
        )}
        {data.goals.map((g) => {
          const pct = g.target > 0 ? Math.min(1, g.saved / g.target) : 0;
          return (
            <div key={g.id} className="card flex items-center gap-4 p-4">
              <button onClick={() => setEdit(g)} aria-label={`Editar ${g.name}`}>
                {pct >= 1 ? <Suricata pose="celebrando" size={64} /> : <CategoryBubble icon={g.icon} color="#176B60" size={60} />}
              </button>
              <div className="min-w-0 flex-1">
                <button className="w-full text-left" onClick={() => setEdit(g)}>
                  <div className="text-xl">{g.name}{pct >= 1 && <span className="ml-2 text-[15px] text-ok">¡Lo lograste!</span>}</div>
                  <div className="text-[16px]">{money(g.saved)} <span className="text-muted">/ {money(g.target)}</span></div>
                </button>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-2.5 flex-1 rounded-full bg-sunken"><div className="h-full rounded-full bg-primary" style={{ width: `${pct * 100}%` }} /></div>
                  <span className="w-10 text-right text-[15px] text-muted">{Math.round(pct * 100)}%</span>
                </div>
              </div>
              <button className="chip text-primary" onClick={() => setAdd(g)}>Sumar</button>
            </div>
          );
        })}
      </div>
      {edit && <GoalSheet value={edit} onClose={() => setEdit(null)} />}
      {add && <AddToGoal goal={add} onClose={() => setAdd(null)} />}
    </div>
  );
}

function GoalSheet({ value, onClose }: { value: Goal | 'new'; onClose: () => void }) {
  const { upsertGoal, deleteGoal } = useStore();
  const [g, setG] = useState<Goal>(value === 'new' ? { id: newId('g'), name: '', icon: 'palm', target: 0, saved: 0 } : value);
  const [target, setTarget] = useState(g.target ? String(g.target) : '');
  const [saved, setSaved] = useState(g.saved ? String(g.saved) : '');
  const t = parseAmount(target) ?? 0;
  return (
    <Sheet
      title={value === 'new' ? 'Nueva meta' : 'Editar meta'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          {value !== 'new' && <button className="btn-outline text-danger" onClick={() => { deleteGoal(g.id); onClose(); }}>Borrar</button>}
          <button className="btn-primary flex-1" disabled={!g.name.trim() || t <= 0} onClick={() => { upsertGoal({ ...g, name: g.name.trim(), target: t, saved: parseAmount(saved) ?? 0 }); onClose(); }}>Guardar</button>
        </div>
      }
    >
      <div className="space-y-4">
        <div><label className="label">Nombre</label><input className="field" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} placeholder="Vacaciones" autoFocus /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Necesito</label><input className="field" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          <div><label className="label">Ya tengo</label><input className="field" inputMode="decimal" value={saved} onChange={(e) => setSaved(e.target.value)} /></div>
        </div>
        <div className="grid grid-cols-6 gap-2">
          {ICON_CHOICES.map((name) => (
            <button key={name} className={`flex h-12 items-center justify-center rounded-2xl border ${g.icon === name ? 'border-primary bg-soft/30' : 'border-line bg-surface'}`} onClick={() => setG({ ...g, icon: name })} aria-label={name}>
              <Icon name={name} size={22} />
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function AddToGoal({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const { upsertGoal } = useStore();
  const [text, setText] = useState('');
  const n = parseAmount(text) ?? 0;
  return (
    <Sheet
      title={`Sumar a «${goal.name}»`}
      onClose={onClose}
      footer={<button className="btn-primary w-full" disabled={!n} onClick={() => { upsertGoal({ ...goal, saved: Math.max(0, goal.saved + n) }); onClose(); }}>Sumar</button>}
    >
      <input className="field text-center text-3xl" inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="0" />
      <p className="mt-2 text-[15px] text-muted">Para restar, poné un número negativo. Las metas son aparte de los gastos: si querés que el ahorro aparezca en las gráficas, anotalo también como gasto en tu categoría de ahorro.</p>
    </Sheet>
  );
}
