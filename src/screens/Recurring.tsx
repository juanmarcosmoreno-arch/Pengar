import { Plus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { CategoryBubble } from '../components/Icon';
import { RubroPicker } from '../components/RubroPicker';
import { PageHeader, Sheet } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { useToast } from '../components/Toast';
import { Segmented, Toggle } from '../components/Toggle';
import { today } from '../domain/dates';
import { parseAmount } from '../domain/money';
import { newRecurring, recurringOf, suggestRecurring } from '../domain/recurring';
import { OTHER_COLOR } from '../domain/template';
import { plural } from '../domain/text';
import type { Kind, Recurring } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

/** Ícono y nombre del rubro de un fijo */
function useRubro() {
  const { ix } = useStore();
  return (rubroId: string) => {
    const rubro = ix.rubro.get(rubroId);
    const cat = ix.category.get(rubro?.categoryId ?? '');
    return { name: rubro?.name ?? 'Sin rubro', icon: cat?.icon ?? 'tag', color: cat?.color ?? OTHER_COLOR, archived: !!rubro?.archived };
  };
}

/** Gastos fijos: lo que se repite todos los meses. Inicio avisa cuando llega el día de anotarlos. */
export function RecurringScreen({ onBack }: { onBack: () => void }) {
  const { data, ix, update } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const rubroOf = useRubro();
  const [edit, setEdit] = useState<Recurring | null>(null);
  const [adding, setAdding] = useState(false);
  const now = today();
  const list = data.recurring.filter((r) => ix.rubro.has(r.rubroId)).sort((a, b) => a.day - b.day || b.amount - a.amount);
  const suggested = useMemo(() => suggestRecurring(data, now), [data, now]);

  const add = (items: Recurring[]) => update((d) => ({ ...d, recurring: [...d.recurring, ...items] }));
  const addAll = () => {
    const items = suggested.map((s) => newRecurring(s, now));
    const ids = new Set(items.map((r) => r.id));
    add(items);
    // Entre los sugeridos puede haber ingresos (el sueldo)
    const incomes = items.filter((r) => r.kind === 'ingreso').length;
    const text = incomes ? `${plural(items.length - incomes, 'gasto', 'gastos')} y ${plural(incomes, 'ingreso', 'ingresos')} fijos` : plural(items.length, 'gasto fijo', 'gastos fijos');
    toast(`Agregaste ${text}`, { label: 'Deshacer', run: () => update((d) => ({ ...d, recurring: d.recurring.filter((r) => !ids.has(r.id)) })) });
  };

  return (
    <div>
      <PageHeader
        title="Gastos fijos"
        onBack={onBack}
        right={<button className="flex min-h-tap min-w-tap items-center justify-center text-primary" onClick={() => setAdding(true)} aria-label="Nuevo gasto fijo"><Plus size={28} /></button>}
      />
      <div className="space-y-5 px-4 pb-10">
        <div className="flex items-center gap-3 px-1">
          <Suricata pose="calculadora" size={84} />
          <p className="text-[17px] text-muted">El alquiler, la luz, Netflix, el sueldo… Cuando llega el día te aviso en Inicio para anotarlo. El monto es una estimación: lo ajustás al anotar.</p>
        </div>

        {!list.length && (
          <div className="card p-4 text-center text-muted">
            Todavía no tenés gastos fijos. Agregalos acá o prendé «Se repite todos los meses» al anotar un gasto.
          </div>
        )}

        {(['gasto', 'ingreso'] as Kind[]).map((kind) => {
          const items = list.filter((r) => r.kind === kind);
          if (!items.length) return null;
          const total = items.filter((r) => !r.paused).reduce((s, r) => s + r.amount, 0);
          return (
            <section key={kind}>
              <div className="flex items-baseline justify-between px-1">
                <h2 className="section-title">{kind === 'gasto' ? 'Gastos' : 'Ingresos'}</h2>
                <span className="text-[15px] text-muted tabular">{money(total)} por mes</span>
              </div>
              <div className="card mt-2 divide-y divide-line px-4">
                {items.map((r) => {
                  const rb = rubroOf(r.rubroId);
                  return (
                    <button key={r.id} className="flex w-full items-center gap-3 py-2.5 text-left" onClick={() => setEdit(r)}>
                      {/* En pausa se atenúa solo el ícono: el texto tiene que seguir leyéndose */}
                      <span className={r.paused || rb.archived ? 'opacity-50' : ''}><CategoryBubble icon={rb.icon} color={rb.color} size={44} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-lg leading-tight">{rb.name}</div>
                        <div className="truncate text-[15px] text-muted">
                          todos los {r.day}{r.paused ? ' · En pausa' : ''}{rb.archived ? ' · Rubro archivado: no se pide' : ''}{r.note ? ` · ${r.note}` : ''}
                        </div>
                      </div>
                      <div className={`shrink-0 text-lg tabular ${kind === 'ingreso' ? 'text-ok' : ''}`}>{money(r.amount)}</div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        <button className="btn-outline w-full" onClick={() => setAdding(true)}><Plus size={18} /> Agregar</button>

        {suggested.length > 0 && (
          <section>
            <h2 className="section-title px-1">Sugeridos según tu historial</h2>
            <p className="px-1 text-[15px] text-muted">Aparecen casi todos los meses, con montos parecidos.</p>
            <div className="card mt-2 divide-y divide-line px-4">
              {suggested.map((s) => {
                const rb = rubroOf(s.rubroId);
                return (
                  <div key={s.rubroId} className="flex items-center gap-3 py-2.5">
                    <CategoryBubble icon={rb.icon} color={rb.color} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-lg leading-tight">{rb.name}</div>
                      <div className={`text-[15px] tabular ${s.kind === 'ingreso' ? 'text-ok' : 'text-muted'}`}>{money(s.amount)}</div>
                    </div>
                    <button
                      className="chip text-primary"
                      aria-label={`Agregar ${rb.name}`}
                      onClick={() => {
                        add([newRecurring(s, now)]);
                        toast(`«${rb.name}» quedó como fijo`);
                      }}
                    >
                      <Plus size={16} /> Agregar
                    </button>
                  </div>
                );
              })}
            </div>
            {suggested.length > 1 && <button className="btn-ghost mt-1 w-full" onClick={addAll}>Agregar todos ({suggested.length})</button>}
          </section>
        )}
      </div>
      {edit && <EditRecurring value={edit} onClose={() => setEdit(null)} />}
      {adding && <AddRecurring onClose={() => setAdding(false)} />}
    </div>
  );
}

function DayField({ value, onChange }: { value: number; onChange: (day: number) => void }) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>Día del mes</label>
      <select id={id} className="field" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </div>
  );
}

function AmountField({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const { symbol } = useMoney();
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>Monto estimado ({symbol})</label>
      <input id={id} className="field tabular" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0" autoFocus={autoFocus} />
    </div>
  );
}

/** Cambiar monto, día, nota o pausa de un fijo; borrarlo pide confirmar ahí mismo */
function EditRecurring({ value, onClose }: { value: Recurring; onClose: () => void }) {
  const { upsertRecurring, deleteRecurring } = useStore();
  const toast = useToast();
  const rb = useRubro()(value.rubroId);
  const [amountText, setAmountText] = useState(String(value.amount).replace('.', ','));
  const [day, setDay] = useState(value.day);
  const [note, setNote] = useState(value.note ?? '');
  const [paused, setPaused] = useState(!!value.paused);
  const [confirming, setConfirming] = useState(false);
  const noteId = useId();
  const amount = parseAmount(amountText);
  const valid = amount != null && amount > 0;

  return (
    <Sheet
      title={rb.name}
      onClose={onClose}
      footer={confirming ? (
        <div className="space-y-2">
          <p className="text-center text-[16px]">¿Borrar este fijo? Lo que ya anotaste queda igual.</p>
          <div className="flex gap-2">
            <button className="btn-outline flex-1" onClick={() => setConfirming(false)}>Cancelar</button>
            <button
              className="btn-primary flex-1 bg-danger"
              onClick={() => {
                deleteRecurring(value.id);
                toast(`«${rb.name}» ya no es fijo`);
                onClose();
              }}
            >
              Borrar
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button className="btn-outline text-danger" onClick={() => setConfirming(true)}>Borrar</button>
          <button
            className="btn-primary flex-1"
            disabled={!valid}
            onClick={() => {
              upsertRecurring({ ...value, amount: amount!, day, note: note.trim() || undefined, paused: paused || undefined });
              onClose();
            }}
          >
            Guardar
          </button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <CategoryBubble icon={rb.icon} color={rb.color} size={44} />
          <span className="text-[16px] text-muted">{value.kind === 'gasto' ? 'Gasto' : 'Ingreso'} de todos los meses</span>
        </div>
        {rb.archived && <p className="text-[15px] text-muted">Su rubro está archivado: no te lo pide en Inicio hasta que lo vuelvas a activar en Categorías y rubros.</p>}
        <div className="grid grid-cols-2 gap-3">
          <AmountField value={amountText} onChange={setAmountText} />
          <DayField value={day} onChange={setDay} />
        </div>
        <div>
          <label className="label" htmlFor={noteId}>Nota</label>
          <input id={noteId} className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" />
        </div>
        <div>
          <Toggle checked={paused} onChange={setPaused} label="En pausa" />
          <p className="mt-1 text-[15px] text-muted">En pausa no te avisa en Inicio hasta que lo vuelvas a prender.</p>
        </div>
      </div>
    </Sheet>
  );
}

/** Agregar un fijo a mano: tipo, rubro, monto y día. Si el rubro ya era fijo, se actualiza ese. */
function AddRecurring({ onClose }: { onClose: () => void }) {
  const { data, upsertRecurring } = useStore();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('gasto');
  const [rubroId, setRubroId] = useState<string>();
  const [amountText, setAmountText] = useState('');
  const [day, setDay] = useState(1);
  const amount = parseAmount(amountText);
  const existing = recurringOf(data, rubroId);
  const valid = amount != null && amount > 0 && !!rubroId;

  return (
    <Sheet
      title={kind === 'gasto' ? 'Nuevo gasto fijo' : 'Nuevo ingreso fijo'}
      onClose={onClose}
      tall
      footer={
        <button
          className="btn-primary w-full"
          disabled={!valid}
          onClick={() => {
            upsertRecurring(existing ? { ...existing, amount: amount!, day } : newRecurring({ rubroId: rubroId!, kind, amount: amount!, day }, today()));
            toast(`${kind === 'gasto' ? 'Gasto' : 'Ingreso'} fijo ${existing ? 'actualizado' : 'agregado'}`);
            onClose();
          }}
        >
          Guardar
        </button>
      }
    >
      <div className="space-y-5">
        <Segmented<Kind>
          value={kind}
          options={[{ id: 'gasto', label: 'Gasto' }, { id: 'ingreso', label: 'Ingreso' }]}
          onChange={(k) => { if (k !== kind) setRubroId(undefined); setKind(k); }}
        />
        <div className="grid grid-cols-2 gap-3">
          <AmountField value={amountText} onChange={setAmountText} autoFocus />
          <DayField value={day} onChange={setDay} />
        </div>
        <div>
          <div className="mb-2 text-xl">Rubro</div>
          <RubroPicker kind={kind} value={rubroId} onChange={setRubroId} />
          {existing && <p className="mt-2 text-[15px] text-muted">Ya es fijo: se actualizan el monto y el día.</p>}
        </div>
      </div>
    </Sheet>
  );
}
