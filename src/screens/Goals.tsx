import { Plus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { CategoryBubble, Icon, iconLabel } from '../components/Icon';
import { PageHeader, Sheet } from '../components/Sheet';
import { EmptyState, Suricata } from '../components/Suricata';
import { useToast } from '../components/Toast';
import { Segmented } from '../components/Toggle';
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
  const [reached, setReached] = useState<Goal | null>(null);
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
      {add && <AddToGoal goal={add} onClose={() => setAdd(null)} onReached={setReached} />}
      {reached && <GoalReached goal={reached} onClose={() => setReached(null)} />}
    </div>
  );
}

function GoalSheet({ value, onClose }: { value: Goal | 'new'; onClose: () => void }) {
  const { data, upsertGoal, deleteGoal } = useStore();
  const toast = useToast();
  const id = useId();
  const [g, setG] = useState<Goal>(value === 'new' ? { id: newId('g'), name: '', icon: 'm:viajes', target: 0, saved: 0 } : value);
  const [target, setTarget] = useState(g.target ? String(g.target) : '');
  const [saved, setSaved] = useState(g.saved ? String(g.saved) : '');
  const t = parseAmount(target) ?? 0;
  // «Ya tengo» sin tocar queda como está ahora (en un hogar, alguien pudo sumar mientras la hoja estaba abierta)
  const savedNow = () => {
    const typed = parseAmount(saved) ?? 0;
    return value !== 'new' && typed === value.saved ? data.goals.find((x) => x.id === value.id)?.saved ?? typed : typed;
  };
  return (
    <Sheet
      title={value === 'new' ? 'Nueva meta' : 'Editar meta'}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          {value !== 'new' && (
            <button
              className="btn-outline text-danger"
              onClick={() => {
                deleteGoal(value.id);
                // Se recupera la meta como estaba guardada, no lo que se estaba editando
                toast(`Meta «${value.name}» borrada`, { label: 'Deshacer', run: () => upsertGoal(value) });
                onClose();
              }}
            >
              Borrar
            </button>
          )}
          <button className="btn-primary flex-1" disabled={!g.name.trim() || t <= 0} onClick={() => { upsertGoal({ ...g, name: g.name.trim(), target: t, saved: savedNow() }); onClose(); }}>Guardar</button>
        </div>
      }
    >
      <div className="space-y-4">
        <div><label className="label" htmlFor={`${id}-nombre`}>Nombre</label><input id={`${id}-nombre`} className="field" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} placeholder="Vacaciones" autoFocus /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor={`${id}-necesito`}>Necesito</label><input id={`${id}-necesito`} className="field" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          <div><label className="label" htmlFor={`${id}-tengo`}>Ya tengo</label><input id={`${id}-tengo`} className="field" inputMode="decimal" value={saved} onChange={(e) => setSaved(e.target.value)} /></div>
        </div>
        <div className="grid grid-cols-6 gap-2" role="group" aria-label="Ícono">
          {ICON_CHOICES.map((name) => (
            <button key={name} className={`relative flex h-12 items-center justify-center rounded-2xl border after:absolute after:inset-y-0 after:-inset-x-1 after:content-[''] ${g.icon === name ? 'border-primary bg-soft/30' : 'border-line bg-surface'}`} onClick={() => setG({ ...g, icon: name })} aria-label={iconLabel(name)} aria-pressed={g.icon === name}>
              <Icon name={name} size={22} />
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function AddToGoal({ goal: opened, onClose, onReached }: { goal: Goal; onClose: () => void; onReached: (g: Goal) => void }) {
  const { data, upsertGoal } = useStore();
  // La meta como está ahora (en un hogar, otro pudo sumar mientras la hoja estaba abierta)
  const goal = data.goals.find((x) => x.id === opened.id) ?? opened;
  const [text, setText] = useState('');
  // En el iPhone el teclado de números no tiene «-»: se elige si se suma o se resta
  const [how, setHow] = useState<'sumar' | 'restar'>('sumar');
  const n = Math.abs(parseAmount(text) ?? 0) * (how === 'restar' ? -1 : 1);
  const title = how === 'sumar' ? `Sumar a «${goal.name}»` : `Restar de «${goal.name}»`;
  const add = () => {
    const g = { ...goal, saved: Math.max(0, goal.saved + n) };
    upsertGoal(g);
    onClose();
    // Festejo solo si esta suma la completa (no si ya estaba cumplida)
    if (goal.saved < goal.target && g.saved >= goal.target) onReached(g);
  };
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={<button className="btn-primary w-full" disabled={!n} onClick={add}>{title}</button>}
    >
      <div className="space-y-3">
        <Segmented value={how} onChange={setHow} options={[{ id: 'sumar', label: 'Sumar' }, { id: 'restar', label: 'Restar' }]} />
        <input
          className="field text-center text-3xl"
          inputMode="decimal"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="0"
          aria-label={how === 'sumar' ? 'Monto que sumás' : 'Monto que restás'}
        />
        <p className="text-[15px] text-muted">Las metas son aparte de los gastos: si querés que el ahorro aparezca en las gráficas, anotalo también como gasto en tu categoría de ahorro.</p>
      </div>
    </Sheet>
  );
}

/** Festejo al completar una meta: tarjeta centrada con el suricata saltando */
function GoalReached({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-8" role="dialog" aria-modal="true" aria-label="Meta cumplida">
      <button className="absolute inset-0 bg-black/30 animate-fade" aria-label="Cerrar" onClick={onClose} />
      <div className="card relative flex w-full max-w-xs flex-col items-center px-6 pt-7 pb-5 text-center shadow-2xl animate-pop">
        <Suricata pose="celebrando" size={150} motion="hop" />
        <p className="mt-3 break-words text-2xl leading-tight">¡Llegaste a tu meta «{goal.name}»!</p>
        <button className="btn-primary mt-5 w-full text-xl" onClick={onClose}>¡Bien!</button>
      </div>
    </div>
  );
}
