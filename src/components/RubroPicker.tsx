import { Plus, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { norm } from '../domain/importSheet';
import { newId } from '../domain/template';
import type { Kind, Rubro } from '../domain/types';
import { useStore } from '../store/store';
import { Icon } from './Icon';

/** Elegir un rubro: primero los más usados, después todos por categoría. Se puede crear uno nuevo ahí mismo. */
export function RubroPicker({ kind, value, onChange }: { kind: Kind; value?: string; onChange: (rubroId: string) => void }) {
  const { data, upsertRubro } = useStore();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const cats = data.categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order);
  const catIds = new Set(cats.map((c) => c.id));
  const rubros = data.rubros.filter((r) => !r.archived && catIds.has(r.categoryId));
  // El elegido se muestra aunque esté archivado (un gasto fijo o un movimiento viejo): si no, no se vería ninguno
  const archived = value ? data.rubros.find((r) => r.id === value && r.archived) : undefined;

  const frequent = useMemo(() => {
    const counts = new Map<string, number>();
    const recent = [...data.movements].sort((a, b) => b.createdAt - a.createdAt).slice(0, 300);
    for (const m of recent) if (!m.monthly) counts.set(m.rubroId, (counts.get(m.rubroId) ?? 0) + 1);
    if (counts.size < 4) for (const m of data.movements.slice(-500)) counts.set(m.rubroId, (counts.get(m.rubroId) ?? 0) + 0.1);
    return rubros.filter((r) => counts.has(r.id)).sort((a, b) => counts.get(b.id)! - counts.get(a.id)!).slice(0, 8);
  }, [data.movements, rubros]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = q ? rubros.filter((r) => norm(r.name).includes(norm(q))) : null;

  const chip = (r: Rubro) => (
    <button key={r.id} type="button" className={value === r.id ? 'chip-on' : 'chip'} aria-pressed={value === r.id} onClick={() => onChange(r.id)}>
      {r.name}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
        <input className="field pl-10" placeholder="Buscar rubro…" aria-label="Buscar rubro" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {archived && (
        <div>
          <div className="label">Elegido (archivado)</div>
          <div className="flex flex-wrap gap-2">{chip(archived)}</div>
        </div>
      )}
      {filtered ? (
        <div className="flex flex-wrap gap-2">
          {filtered.map(chip)}
          {!filtered.length && <p className="text-muted">No hay rubros con ese nombre.</p>}
        </div>
      ) : (
        <>
          {frequent.length > 0 && (
            <div>
              <div className="label">Los que más usás</div>
              <div className="flex flex-wrap gap-2">{frequent.map(chip)}</div>
            </div>
          )}
          {cats.map((c) => {
            const list = rubros.filter((r) => r.categoryId === c.id);
            if (!list.length) return null;
            return (
              <div key={c.id}>
                <div className="label flex items-center gap-1.5"><Icon name={c.icon} size={15} />{c.name}</div>
                <div className="flex flex-wrap gap-2">{list.map(chip)}</div>
              </div>
            );
          })}
        </>
      )}
      {creating ? (
        <NewRubro
          kind={kind}
          initialName={q}
          onCancel={() => setCreating(false)}
          onCreate={(name, categoryId) => {
            const r: Rubro = { id: newId('r'), name, categoryId, keywords: [norm(name)] };
            upsertRubro(r);
            onChange(r.id);
            setCreating(false);
            setQ('');
          }}
        />
      ) : (
        <button type="button" className="chip border-dashed text-primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Nuevo rubro
        </button>
      )}
    </div>
  );
}

function NewRubro({ kind, initialName, onCreate, onCancel }: { kind: Kind; initialName: string; onCreate: (name: string, categoryId: string) => void; onCancel: () => void }) {
  const { data } = useStore();
  const cats = data.categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order);
  const [name, setName] = useState(initialName);
  const [cat, setCat] = useState(cats[0]?.id ?? '');
  const id = useId();
  return (
    <div className="card space-y-3 p-4">
      <div>
        <label className="label" htmlFor={`${id}-nombre`}>Nombre del rubro</label>
        <input id={`${id}-nombre`} className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Veterinaria" />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-categoria`}>Categoría</label>
        <select id={`${id}-categoria`} className="field" value={cat} onChange={(e) => setCat(e.target.value)}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" className="btn-primary" disabled={!name.trim() || !cat} onClick={() => onCreate(name.trim(), cat)}>Crear</button>
      </div>
    </div>
  );
}
