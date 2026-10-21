import { ChevronRight, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { CategoryBubble, Icon, iconLabel } from '../components/Icon';
import { PageHeader, Sheet } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { Segmented, Toggle } from '../components/Toggle';
import { useToast } from '../components/Toast';
import { guessIcon, norm } from '../domain/importSheet';
import { recurringOf } from '../domain/recurring';
import { ICON_CHOICES, newId, OTHER_COLOR, PALETTE } from '../domain/template';
import { plural } from '../domain/text';
import type { Category, Kind, Rubro } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

const COLORS = [...PALETTE, '#176B60', '#7FC4AC', '#B07A4A', OTHER_COLOR];
/** Nombre de cada color para el lector de pantalla (en el mismo orden que COLORS) */
const COLOR_NAMES = ['Azul', 'Naranja', 'Verde', 'Amarillo', 'Rosa', 'Verde oscuro', 'Violeta', 'Rojo', 'Verde azulado', 'Verde agua', 'Marrón', 'Gris'];

export function Categories({ onBack }: { onBack: () => void }) {
  const { data } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const [editCat, setEditCat] = useState<Category | 'new-gasto' | 'new-ingreso' | null>(null);
  const [editRubro, setEditRubro] = useState<Rubro | { categoryId: string } | null>(null);
  const counts = new Map<string, number>();
  for (const m of data.movements) counts.set(m.rubroId, (counts.get(m.rubroId) ?? 0) + 1);

  const section = (kind: Kind, title: string) => {
    const cats = data.categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order);
    return (
      <section className="space-y-2">
        <h2 className="px-1 text-xl text-muted">{title}</h2>
        <div className="card divide-y divide-line px-4">
          {cats.map((c) => {
            const rubros = data.rubros.filter((r) => r.categoryId === c.id).sort((a, b) => a.name.localeCompare(b.name));
            const isOpen = open === c.id;
            return (
              <div key={c.id}>
                <div className="flex items-center gap-3 py-2.5">
                  <button onClick={() => setEditCat(c)} aria-label={`Editar ${c.name}`}><CategoryBubble icon={c.icon} color={c.color} size={40} /></button>
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(isOpen ? null : c.id)}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-lg">{c.name}</div>
                      <div className="truncate text-[14px] text-muted">{plural(rubros.length, 'rubro', 'rubros')}{c.savings ? ' · cuenta como ahorro' : ''}</div>
                    </div>
                    <ChevronRight size={20} className={`text-muted transition ${isOpen ? 'rotate-90' : ''}`} />
                  </button>
                </div>
                {isOpen && (
                  <div className="space-y-1 pb-3 pl-[52px]">
                    {rubros.map((r) => (
                      <button key={r.id} className="flex w-full items-center justify-between py-1.5 text-left" onClick={() => setEditRubro(r)}>
                        <span className={r.archived ? 'text-muted line-through' : ''}>{r.name}</span>
                        <span className="text-[14px] text-muted">{counts.get(r.id) ?? 0}</span>
                      </button>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <button className="chip text-primary" onClick={() => setEditRubro({ categoryId: c.id })}><Plus size={16} /> Rubro</button>
                      <button className="chip" onClick={() => setEditCat(c)}>Editar categoría</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <button className="flex w-full items-center gap-2 py-3 text-primary" onClick={() => setEditCat(kind === 'gasto' ? 'new-gasto' : 'new-ingreso')}>
            <Plus size={18} /> Nueva categoría
          </button>
        </div>
      </section>
    );
  };

  return (
    <div>
      <PageHeader title="Categorías y rubros" onBack={onBack} />
      <div className="space-y-5 px-4 pb-10">
        <div className="flex items-center gap-3 px-1">
        <p className="flex-1 text-muted">
          Las <b>categorías</b> agrupan (Alimentación, Transporte…) y tienen presupuesto. Los <b>rubros</b> son lo que elegís al anotar (Feria, UTE, Netflix…).
          Tocá el ícono para cambiar nombre, color o ícono.
        </p>
        <Suricata pose="compras" size={100} flip />
        </div>
        {section('gasto', 'Gastos')}
        {section('ingreso', 'Ingresos')}
      </div>
      {editCat && <CategorySheet value={editCat} onClose={() => setEditCat(null)} />}
      {editRubro && <RubroSheet value={editRubro} count={'id' in editRubro ? counts.get(editRubro.id) ?? 0 : 0} onClose={() => setEditRubro(null)} />}
    </div>
  );
}

function CategorySheet({ value, onClose }: { value: Category | 'new-gasto' | 'new-ingreso'; onClose: () => void }) {
  const { data, upsertCategory, deleteCategory } = useStore();
  const toast = useToast();
  const isNew = typeof value === 'string';
  const base: Category = isNew
    ? { id: newId('c'), name: '', kind: value === 'new-ingreso' ? 'ingreso' : 'gasto', icon: 'tag', color: PALETTE[data.categories.length % PALETTE.length], budget: { type: 'none' }, order: data.categories.length }
    : value;
  const [c, setC] = useState<Category>(base);
  const [iconTouched, setIconTouched] = useState(!isNew);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const others = data.categories.filter((x) => x.id !== c.id && x.kind === c.kind);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '');
  const rubroCount = data.rubros.filter((r) => r.categoryId === c.id).length;

  return (
    <Sheet
      title={isNew ? 'Nueva categoría' : 'Editar categoría'}
      onClose={onClose}
      footer={<button className="btn-primary w-full" disabled={!c.name.trim()} onClick={() => { upsertCategory({ ...c, name: c.name.trim() }); onClose(); }}>Guardar</button>}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <CategoryBubble icon={c.icon} color={c.color} size={52} />
          <input
            className="field flex-1"
            placeholder="Nombre"
            aria-label="Nombre de la categoría"
            autoFocus={isNew}
            value={c.name}
            onChange={(e) => setC({ ...c, name: e.target.value, icon: iconTouched ? c.icon : guessIcon(e.target.value) })}
          />
        </div>
        <div>
          <div className="label">Color (en las gráficas)</div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Color">
            {COLORS.map((col, i) => (
              <button
                key={col}
                className={`h-9 w-9 rounded-full ${c.color === col ? 'ring-2 ring-ink ring-offset-2 ring-offset-bg' : ''}`}
                style={{ background: col }}
                onClick={() => setC({ ...c, color: col })}
                aria-label={COLOR_NAMES[i]}
                aria-pressed={c.color === col}
              />
            ))}
          </div>
        </div>
        <div>
          <div className="label">Ícono</div>
          <div className="grid grid-cols-6 gap-2" role="group" aria-label="Ícono">
            {ICON_CHOICES.map((name) => (
              <button
                key={name}
                className={`flex h-12 items-center justify-center rounded-2xl border ${c.icon === name ? 'border-primary bg-soft/30' : 'border-line bg-surface'}`}
                onClick={() => { setC({ ...c, icon: name }); setIconTouched(true); }}
                aria-label={iconLabel(name)}
                aria-pressed={c.icon === name}
              >
                <Icon name={name} size={22} />
              </button>
            ))}
          </div>
        </div>
        {c.kind === 'gasto' && (
          <Toggle checked={!!c.savings} onChange={(v) => setC({ ...c, savings: v || undefined })} label="Cuenta como ahorro o inversión" />
        )}
        {!isNew && (
          <div className="border-t border-line pt-4">
            {!confirmDelete ? (
              <button className="btn-ghost -ml-4 text-danger" onClick={() => setConfirmDelete(true)}>Borrar categoría</button>
            ) : (
              <div className="space-y-2">
                {rubroCount > 0 && others.length > 0 ? (
                  <>
                    <p>{rubroCount === 1 ? 'Su rubro (con sus movimientos) pasa a:' : `Sus ${rubroCount} rubros (con sus movimientos) pasan a:`}</p>
                    <select className="field" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Categoría a donde pasan">
                      {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </>
                ) : rubroCount > 0 ? (
                  <p className="text-danger">No hay otra categoría a donde pasar sus rubros: creá una primero.</p>
                ) : null}
                <button
                  className="btn-primary w-full bg-danger"
                  disabled={rubroCount > 0 && !moveTo}
                  onClick={() => { deleteCategory(c.id, rubroCount > 0 ? moveTo : undefined); toast('Categoría borrada'); onClose(); }}
                >
                  Borrar «{c.name}»
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function RubroSheet({ value, count, onClose }: { value: Rubro | { categoryId: string }; count: number; onClose: () => void }) {
  const { data, upsertRubro, deleteRubro } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const id = useId();
  const isNew = !('id' in value);
  const [r, setR] = useState<Rubro>(isNew ? { id: newId('r'), name: '', categoryId: value.categoryId, keywords: [] } : value);
  const [keywords, setKeywords] = useState(r.keywords.join(', '));
  const [action, setAction] = useState<'none' | 'delete'>('none');
  const cat = data.categories.find((c) => c.id === r.categoryId);
  const sameKind = data.categories.filter((c) => c.kind === cat?.kind);
  const mergeOptions = data.rubros.filter((x) => x.id !== r.id && sameKind.some((c) => c.id === x.categoryId));
  // Su gasto fijo: se pierde al borrar, y al unir también si el otro rubro ya tiene uno (ver deleteRubro)
  const fixed = isNew ? undefined : recurringOf(data, r.id);
  const [mergeInto, setMergeInto] = useState(count > 0 || fixed ? mergeOptions[0]?.id ?? '' : '');
  const fixedLost = fixed && (!mergeInto || recurringOf(data, mergeInto));

  const save = () => {
    const kw = keywords.split(',').map((k) => norm(k)).filter(Boolean);
    upsertRubro({ ...r, name: r.name.trim(), keywords: [...new Set(kw)] });
    onClose();
  };

  return (
    <Sheet
      title={isNew ? 'Nuevo rubro' : 'Editar rubro'}
      onClose={onClose}
      footer={<button className="btn-primary w-full" disabled={!r.name.trim()} onClick={save}>Guardar</button>}
    >
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor={`${id}-nombre`}>Nombre</label>
          <input id={`${id}-nombre`} className="field" autoFocus={isNew} value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Ej.: Feria" />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-categoria`}>Categoría</label>
          <select id={`${id}-categoria`} className="field" value={r.categoryId} onChange={(e) => setR({ ...r, categoryId: e.target.value })}>
            {sameKind.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-palabras`}>Palabras para reconocerlo en las facturas</label>
          <textarea id={`${id}-palabras`} className="field min-h-[80px] py-2" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="ute, energía eléctrica" />
          <p className="mt-1 text-[14px] text-muted">Separadas por coma. Si aparecen en un renglón o en el nombre del comercio, se elige este rubro. Pengar también aprende de lo que corregís.</p>
        </div>
        {!isNew && (
          <Toggle checked={!!r.archived} onChange={(v) => setR({ ...r, archived: v || undefined })} label="Archivado (no aparece al anotar)" />
        )}
        {!isNew && (
          <div className="border-t border-line pt-4">
            {action === 'none' ? (
              <button className="btn-ghost -ml-4 text-danger" onClick={() => setAction('delete')}>Borrar o unir con otro</button>
            ) : (
              <div className="space-y-2">
                {(count > 0 || fixed) && (
                  <>
                    <p>
                      {count > 0
                        ? `Tiene ${plural(count, 'movimiento', 'movimientos')}${fixed ? ' y es gasto fijo' : ''}. ¿A qué rubro ${count === 1 ? 'lo' : 'los'} paso?`
                        : 'Es gasto fijo. ¿Lo paso a otro rubro?'}
                    </p>
                    <Segmented
                      value={mergeInto ? 'unir' : 'borrar'}
                      onChange={(v) => setMergeInto(v === 'unir' ? mergeOptions[0]?.id ?? '' : '')}
                      options={[{ id: 'unir', label: 'Unir con otro' }, { id: 'borrar', label: count > 1 ? 'Borrarlos' : 'Borrarlo' }]}
                    />
                    {mergeInto && (
                      <select className="field" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} aria-label="Rubro con el que se une">
                        {mergeOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    )}
                  </>
                )}
                {fixed && fixedLost && (
                  <p className="text-[15px] text-danger">
                    {mergeInto
                      ? `Su gasto fijo de ${money(fixed.amount)} se pierde: el otro rubro ya tiene uno.`
                      : `También se borra su gasto fijo de ${money(fixed.amount)}.`}
                  </p>
                )}
                <button
                  className="btn-primary w-full bg-danger"
                  onClick={() => { deleteRubro(r.id, mergeInto || undefined); toast(mergeInto ? 'Rubros unidos' : 'Rubro borrado'); onClose(); }}
                >
                  {mergeInto ? `Unir «${r.name}» y borrarlo` : count > 0 ? `Borrar «${r.name}» y ${count === 1 ? 'su movimiento' : `sus ${count} movimientos`}` : `Borrar «${r.name}»`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
