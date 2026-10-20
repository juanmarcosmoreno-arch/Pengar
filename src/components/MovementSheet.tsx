import { Paperclip, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { monthOf, today } from '../domain/dates';
import { formatMoney, parseAmount } from '../domain/money';
import { clampDay, newRecurring, recurringOf } from '../domain/recurring';
import type { Kind, Movement } from '../domain/types';
import { useStore } from '../store/store';
import { InvoiceViewer } from './InvoiceViewer';
import { RubroPicker } from './RubroPicker';
import { Sheet } from './Sheet';
import { useToast } from './Toast';
import { Toggle } from './Toggle';

/** Lo que ya viene cargado al abrir (por ejemplo, un gasto fijo para anotar) */
export interface MovementPreset {
  kind: Kind;
  rubroId: string;
  amount: number;
  note?: string;
  date?: string;
}

/** Anotar o editar un gasto o un ingreso: monto, rubro y listo (fecha y nota son opcionales) */
export function MovementSheet({ movement, kind: initialKind = 'gasto', preset, onSaved, onClose }: {
  movement?: Movement;
  kind?: Kind;
  preset?: MovementPreset;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const { data, addMovement, updateMovement, deleteMovement, update, upsertRecurring } = useStore();
  const toast = useToast();
  const c = data.settings.currency;
  const start = movement ?? preset;
  const [kind, setKind] = useState<Kind>(start?.kind ?? initialKind);
  const [amountText, setAmountText] = useState(start ? String(start.amount).replace('.', ',') : '');
  const [rubroId, setRubroId] = useState(start?.rubroId);
  const [date, setDate] = useState(start?.date ?? today());
  const [note, setNote] = useState(start?.note ?? '');
  const [repeats, setRepeats] = useState(false);
  const [viewing, setViewing] = useState(false);
  const amount = parseAmount(amountText);
  const valid = amount != null && amount > 0 && !!rubroId && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const invoice = movement?.invoiceId ? data.invoices.find((i) => i.id === movement.invoiceId) : undefined;
  const fixed = recurringOf(data, rubroId);

  const save = () => {
    if (!valid) return;
    const fields = { kind, amount: amount!, rubroId: rubroId!, date, note: note.trim() || undefined };
    if (movement) updateMovement(movement.id, fields);
    else addMovement({ ...fields, origin: 'manual' });
    // «Se repite todos los meses»: queda como gasto fijo, ya anotado en el mes de este movimiento
    if (!movement && repeats) {
      const day = clampDay(Number(date.slice(8, 10)));
      upsertRecurring(fixed
        ? { ...fixed, amount: amount!, day }
        : newRecurring({ rubroId: rubroId!, kind, amount: amount!, day, note: fields.note, doneThrough: monthOf(date) }, today()));
    }
    toast(movement ? 'Cambios guardados' : `${kind === 'gasto' ? 'Gasto' : 'Ingreso'} anotado: ${formatMoney(amount!, c)}`);
    onSaved?.();
    onClose();
  };

  const remove = () => {
    if (!movement) return;
    deleteMovement(movement.id);
    toast('Movimiento borrado', { label: 'Deshacer', run: () => update((d) => ({ ...d, movements: [...d.movements, movement] })) });
    onClose();
  };

  return (
    <>
      <Sheet
        title={movement ? 'Editar movimiento' : kind === 'gasto' ? 'Nuevo gasto' : 'Nuevo ingreso'}
        onClose={onClose}
        tall
        footer={
          <div className="flex gap-2">
            {movement && (
              <button className="btn-outline px-4 text-danger" onClick={remove} aria-label="Borrar"><Trash2 size={20} /></button>
            )}
            <button className="btn-primary flex-1" disabled={!valid} onClick={save}>Guardar</button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="flex rounded-full bg-sunken p-1">
            {(['gasto', 'ingreso'] as Kind[]).map((k) => (
              <button
                key={k}
                className={`flex-1 rounded-full py-2 text-lg ${kind === k ? 'bg-surface shadow-sm' : 'text-muted'}`}
                onClick={() => { setKind(k); if (k !== kind) setRubroId(undefined); }}
              >
                {k === 'gasto' ? 'Gasto' : 'Ingreso'}
              </button>
            ))}
          </div>

          <label className="flex items-baseline justify-center gap-2 border-b-2 border-line pb-2 focus-within:border-primary">
            <span className="text-3xl text-muted">{c.symbol}</span>
            <input
              className="w-full max-w-[240px] bg-transparent text-center text-5xl outline-none placeholder:text-line"
              inputMode="decimal"
              autoFocus={!start}
              placeholder="0"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value.replace(/[^\d.,]/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              aria-label="Monto"
            />
          </label>

          <div>
            <div className="mb-2 text-xl">Rubro</div>
            <RubroPicker kind={kind} value={rubroId} onChange={setRubroId} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Fecha</label>
              <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Nota</label>
              <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" />
            </div>
          </div>

          {!movement && (fixed
            ? <p className="text-[15px] text-muted">Se anota todos los meses · Más → Gastos fijos</p>
            : <Toggle checked={repeats} onChange={setRepeats} label="Se repite todos los meses" />)}

          {movement?.merchant && <p className="text-muted">Comercio: {movement.merchant}</p>}
          {invoice && (
            <button className="chip" onClick={() => setViewing(true)}>
              <Paperclip size={16} /> Ver factura{invoice.merchant ? ` de ${invoice.merchant}` : ''}
            </button>
          )}
        </div>
      </Sheet>
      {viewing && invoice && <InvoiceViewer invoice={invoice} onClose={() => setViewing(false)} />}
    </>
  );
}
