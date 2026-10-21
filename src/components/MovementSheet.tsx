import { Calculator as CalcIcon, CreditCard, Paperclip, Trash2, Users } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { monthOf, today } from '../domain/dates';
import { formatRate, isUsdSymbol, splitUsdNote, validUsdRate, withUsdNote } from '../domain/fx';
import { formatMoney, parseAmount, parseDecimal, round2 } from '../domain/money';
import { clampDay, newRecurring, recurringOf } from '../domain/recurring';
import { dayMonth } from '../domain/statementReview';
import { capital } from '../domain/text';
import type { Kind, Movement } from '../domain/types';
import { usdRateOn, type UsdQuote } from '../lib/fx';
import { isPreview } from '../lib/platform';
import { authorLabel, useAuthors } from '../lib/sync';
import { useStore } from '../store/store';
import { Calculator } from './Calculator';
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
  /** El id del movimiento nuevo (el de un gasto fijo es siempre el mismo en el mes: recurringMovementId) */
  id?: string;
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
  const id = useId();
  const c = data.settings.currency;
  const start = movement ?? preset;
  // En dólares: se guarda en pesos, con la cotización del BCU de la fecha (o la que se escriba) y la cuenta en la nota
  const canUsd = !isUsdSymbol(c.symbol);
  // Un gasto anotado en dólares se vuelve a abrir en dólares (si el monto sigue siendo la cuenta de la nota)
  const [startUsd] = useState(() => {
    const u = splitUsdNote(start?.note);
    return canUsd && start && u.usd && u.rate && Math.abs(round2(u.usd * u.rate) - start.amount) < 0.01 ? u : null;
  });
  const [kind, setKind] = useState<Kind>(start?.kind ?? initialKind);
  const [amountText, setAmountText] = useState(startUsd ? String(startUsd.usd).replace('.', ',') : start ? String(start.amount).replace('.', ',') : '');
  const [rubroId, setRubroId] = useState(start?.rubroId);
  const [date, setDate] = useState(start?.date ?? today());
  const [note, setNote] = useState(startUsd ? startUsd.rest : start?.note ?? '');
  const [calc, setCalc] = useState(false);
  // Al abrir, el monto arriba y listo para escribir: el teclado del iPhone corría la hoja hacia abajo
  const amountRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = amountRef.current;
    if (!el) return;
    const top = () => {
      el.closest('.overflow-y-auto')?.scrollTo({ top: 0 });
      window.scrollTo(0, 0);
    };
    if (!start) el.focus({ preventScroll: true });
    const timers = [50, 300, 600].map((ms) => setTimeout(top, ms));
    return () => timers.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [repeats, setRepeats] = useState(false);
  const [viewing, setViewing] = useState(false);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const [inUsd, setInUsd] = useState(!!startUsd);
  const [quote, setQuote] = useState<UsdQuote | null | undefined>(undefined);
  const [rateText, setRateText] = useState(startUsd?.rate ? formatRate(startUsd.rate) : '');
  const [ownRate, setOwnRate] = useState(!!startUsd);
  useEffect(() => {
    if (!inUsd || !validDate) return;
    let alive = true;
    setQuote(undefined);
    void usdRateOn(date).then((q) => alive && setQuote(q));
    return () => { alive = false; };
  }, [inUsd, date, validDate]);
  const typedRate = parseDecimal(rateText);
  const manualRate = typedRate != null && validUsdRate(typedRate) ? typedRate : null;
  const showRate = ownRate || quote === null;
  const rate = showRate && rateText.trim() ? manualRate : quote?.rate ?? null;
  const typed = parseAmount(amountText);
  const amount = typed != null && inUsd ? (rate ? round2(typed * rate) : null) : typed;
  const valid = amount != null && amount > 0 && !!rubroId && validDate;
  // «≈ $ 802 al dólar BCU de hoy (40,10)»
  const pesos = typed && amount ? `≈ ${formatMoney(amount, c)}` : '';
  const dollar = quote?.source === 'mercado' ? 'dólar' : 'dólar BCU';
  // La fecha de la cotización que se usa (un domingo o una fecha futura usan la del último día publicado)
  const when = quote ? (quote.date === today() ? 'de hoy' : `del ${dayMonth(quote.date)}`) : '';
  const usdLine = showRate
    ? rate ? `${pesos ? `${pesos} a` : 'A'} ${formatRate(rate)} el dólar`
      : rateText.trim() ? 'Revisá la cotización (por ejemplo, 40,10)'
      : quote === null ? (isPreview ? 'En la vista previa no se consulta el BCU: escribí la cotización' : 'No hay cotización del BCU: escribila')
      : 'Escribí la cotización del dólar'
    : quote ? (pesos ? `${pesos} al ${dollar} ${when} (${formatRate(quote.rate)})` : `${capital(dollar)} ${when}: ${formatRate(quote.rate)}`)
      : 'Buscando la cotización del BCU…';
  const invoice = movement?.invoiceId ? data.invoices.find((i) => i.id === movement.invoiceId) : undefined;
  const fixed = recurringOf(data, rubroId);
  // Un ingreso lleva diezmo (cuenta para los «% del ingreso») salvo que se apague
  const percentCat = data.categories.find((x) => x.budget.type === 'percentIncome');
  const [tithe, setTithe] = useState(!movement?.noTithe);
  const titheLabel = percentCat && /diezmo/i.test(percentCat.name) ? 'Lleva diezmo' : `Cuenta para «${percentCat?.name ?? ''}»`;
  const author = authorLabel(useAuthors(), movement?.createdBy);

  const save = () => {
    if (!valid) return;
    const fields = {
      kind,
      amount: amount!,
      rubroId: rubroId!,
      date,
      note: (inUsd ? withUsdNote(note, typed!, rate!) : note.trim()) || undefined,
      noTithe: kind === 'ingreso' && percentCat && !tithe ? true : undefined,
    };
    if (movement) updateMovement(movement.id, fields);
    else addMovement({ ...fields, origin: 'manual', ...(preset?.id ? { id: preset.id } : {}) });
    // «Se repite todos los meses»: queda como gasto fijo, ya anotado en el mes de este movimiento
    if (!movement && repeats) {
      const day = clampDay(Number(date.slice(8, 10)));
      upsertRecurring(fixed
        ? { ...fixed, amount: amount!, day }
        // Sin la cuenta en dólares: el mes que viene la cotización es otra
        : newRecurring({ rubroId: rubroId!, kind, amount: amount!, day, note: splitUsdNote(fields.note).rest || undefined, doneThrough: monthOf(date) }, today()));
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
          {author && <p className="-mb-2 flex items-center gap-2 text-[16px] text-muted"><Users size={18} className="shrink-0 text-primary" /> {author}</p>}
          <div className="flex rounded-full bg-sunken p-1" role="group" aria-label="Tipo">
            {(['gasto', 'ingreso'] as Kind[]).map((k) => (
              <button
                key={k}
                aria-pressed={kind === k}
                className={`tap-area flex-1 rounded-full py-2 text-lg ${kind === k ? 'bg-surface shadow-sm' : 'text-muted'}`}
                onClick={() => { setKind(k); if (k !== kind) setRubroId(undefined); }}
              >
                {k === 'gasto' ? 'Gasto' : 'Ingreso'}
              </button>
            ))}
          </div>

          <div>
            <div className="flex items-center gap-2 border-b-2 border-line pb-2 focus-within:border-primary">
              <label className="flex min-w-0 flex-1 items-baseline justify-center gap-2">
                <span className="shrink-0 text-3xl text-muted">{inUsd ? 'U$S' : c.symbol}</span>
                <input
                  className="w-full min-w-0 max-w-[240px] bg-transparent text-center text-5xl outline-none placeholder:text-line"
                  inputMode="decimal"
                  ref={amountRef}
                  placeholder="0"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value.replace(/[^\d.,]/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && save()}
                  aria-label={inUsd ? 'Monto en dólares' : 'Monto'}
                />
              </label>
              <button
                type="button"
                className={`flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-full ${calc ? 'bg-soft/40 text-primary' : 'text-muted'}`}
                onClick={() => { amountRef.current?.blur(); setCalc((v) => !v); }}
                aria-label="Calculadora"
                aria-pressed={calc}
              >
                <CalcIcon size={22} />
              </button>
              {canUsd && (
                <div className="flex shrink-0 rounded-full bg-sunken p-1" role="group" aria-label="Moneda">
                  {([false, true] as const).map((usd) => (
                    <button
                      key={String(usd)}
                      type="button"
                      aria-pressed={inUsd === usd}
                      className={`tap-area min-w-tap rounded-full px-3 py-1.5 text-[17px] ${inUsd === usd ? 'bg-surface shadow-sm' : 'text-muted'}`}
                      onClick={() => setInUsd(usd)}
                    >
                      {usd ? 'U$S' : c.symbol}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {calc && (
              <Calculator start={parseAmount(amountText)} onUse={(t) => { setAmountText(t); setCalc(false); }} onClose={() => setCalc(false)} />
            )}
            {inUsd && (
              <div className="mt-2 space-y-2 text-center text-[16px]" aria-live="polite">
                <p className="text-muted">{usdLine}</p>
                {showRate ? (
                  <div className="flex items-center justify-center gap-2">
                    <label className="text-muted" htmlFor={`${id}-cotizacion`}>Cotización</label>
                    <input id={`${id}-cotizacion`} className="field w-[96px] px-3 text-right tabular" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
                    {quote && (
                      <button className="min-h-tap px-2 text-primary" onClick={() => { setOwnRate(false); setRateText(''); }}>La del BCU</button>
                    )}
                  </div>
                ) : (
                  <button className="min-h-tap px-2 text-primary" onClick={() => { setOwnRate(true); setRateText(quote ? formatRate(quote.rate) : ''); }}>Otra cotización</button>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 text-xl">Rubro</div>
            <RubroPicker kind={kind} value={rubroId} onChange={setRubroId} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`${id}-fecha`}>Fecha</label>
              <input id={`${id}-fecha`} type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor={`${id}-nota`}>Nota</label>
              <input id={`${id}-nota`} className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" />
            </div>
          </div>

          {kind === 'ingreso' && percentCat && <Toggle checked={tithe} onChange={setTithe} label={titheLabel} />}

          {!movement && (fixed
            ? <p className="text-[15px] text-muted">Se anota todos los meses · Más → Gastos fijos</p>
            : <Toggle checked={repeats} onChange={setRepeats} label="Se repite todos los meses" />)}

          {movement?.merchant && <p className="text-muted">Comercio: {movement.merchant}</p>}
          {invoice && (
            <button className="chip" onClick={() => setViewing(true)}>
              {invoice.kind === 'estado'
                ? <><CreditCard size={16} /> Ver estado de cuenta{invoice.card ? ` de ${invoice.card}` : ''}</>
                : <><Paperclip size={16} /> Ver factura{invoice.merchant ? ` de ${invoice.merchant}` : ''}</>}
            </button>
          )}
        </div>
      </Sheet>
      {viewing && invoice && <InvoiceViewer invoice={invoice} onClose={() => setViewing(false)} />}
    </>
  );
}
