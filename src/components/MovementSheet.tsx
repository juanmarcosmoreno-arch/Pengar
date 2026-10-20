import { Paperclip, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { today } from '../domain/dates';
import { formatMoney, parseAmount } from '../domain/money';
import type { Kind, Movement } from '../domain/types';
import { loadFile } from '../lib/db';
import { openFile } from '../lib/files';
import { useStore } from '../store/store';
import { RubroPicker } from './RubroPicker';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

/** Anotar o editar un gasto o un ingreso: monto, rubro y listo (fecha y nota son opcionales) */
export function MovementSheet({ movement, kind: initialKind = 'gasto', onClose }: { movement?: Movement; kind?: Kind; onClose: () => void }) {
  const { data, addMovement, updateMovement, deleteMovement, update } = useStore();
  const toast = useToast();
  const c = data.settings.currency;
  const [kind, setKind] = useState<Kind>(movement?.kind ?? initialKind);
  const [amountText, setAmountText] = useState(movement ? String(movement.amount).replace('.', ',') : '');
  const [rubroId, setRubroId] = useState(movement?.rubroId);
  const [date, setDate] = useState(movement?.date ?? today());
  const [note, setNote] = useState(movement?.note ?? '');
  const amount = parseAmount(amountText);
  const valid = amount != null && amount > 0 && !!rubroId && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const invoice = movement?.invoiceId ? data.invoices.find((i) => i.id === movement.invoiceId) : undefined;

  const save = () => {
    if (!valid) return;
    const fields = { kind, amount: amount!, rubroId: rubroId!, date, note: note.trim() || undefined };
    if (movement) updateMovement(movement.id, fields);
    else addMovement({ ...fields, origin: 'manual' });
    toast(movement ? 'Cambios guardados' : `${kind === 'gasto' ? 'Gasto' : 'Ingreso'} anotado: ${formatMoney(amount!, c)}`);
    onClose();
  };

  const remove = () => {
    if (!movement) return;
    deleteMovement(movement.id);
    toast('Movimiento borrado', { label: 'Deshacer', run: () => update((d) => ({ ...d, movements: [...d.movements, movement] })) });
    onClose();
  };

  return (
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
            autoFocus={!movement}
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

        {movement?.merchant && <p className="text-muted">Comercio: {movement.merchant}</p>}
        {invoice && (
          <button
            className="chip"
            onClick={async () => {
              const blob = await loadFile(invoice.id);
              if (blob) await openFile(blob, invoice.fileName);
              else toast('No se encontró el archivo de la factura');
            }}
          >
            <Paperclip size={16} /> Ver factura{invoice.merchant ? ` de ${invoice.merchant}` : ''}
          </button>
        )}
      </div>
    </Sheet>
  );
}
