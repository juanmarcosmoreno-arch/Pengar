import { useId, useMemo, useState } from 'react';
import { currentMonth, monthLabel, monthRange } from '../domain/dates';
import { percentLedger } from '../domain/ledger';
import { parseAmount } from '../domain/money';
import { dataSpan } from '../domain/stats';
import type { Category } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';
import { Sheet } from './Sheet';
import { Segmented } from './Toggle';

/** «Faltan $ 1.200», «Diste $ 300 de más» o «Estás al día» (pending > 0: falta dar) */
export function pendingText(pending: number, money: (n: number) => string): { text: string; tone: 'danger' | 'ok' } {
  if (pending > 0.5) return { text: `Faltan ${money(pending)}`, tone: 'danger' };
  if (pending < -0.5) return { text: `Diste ${money(-pending)} de más`, tone: 'ok' };
  return { text: 'Estás al día', tone: 'ok' };
}

/**
 * Lo acumulado de una categoría en % del ingreso, con «Ver historial» (lo usan Estadísticas y el resumen del mes).
 * `month`: el mes que se mira; si es anterior a «Contar desde», todavía no hay acumulado. `note`: una aclaración abajo
 */
export function LedgerSummary({ pending, from, month, note, onHistory }: { pending: number; from: string; month?: string; note?: string; onHistory?: () => void }) {
  const { money } = useMoney();
  const p = pendingText(pending, money);
  const before = month != null && month < from;
  return (
    // En un teléfono angosto el botón baja: el monto acumulado se lee entero
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-sunken/70 px-3 py-2.5">
      <div className="min-w-[10rem] flex-1">
        {before ? (
          <div className="text-[17px] leading-snug">Se cuenta desde {monthLabel(from).toLowerCase()}</div>
        ) : (
          <>
            <div className="text-[15px] text-muted">Acumulado desde {monthLabel(from).toLowerCase()}</div>
            <div className={`text-xl leading-tight ${p.tone === 'danger' ? 'text-danger' : 'text-ok'}`}>{p.text}</div>
          </>
        )}
        {note && <div className="text-[14px] text-muted">{note}</div>}
      </div>
      {onHistory && <button className="chip ml-auto text-primary" onClick={onHistory}>Ver historial</button>}
    </div>
  );
}

/** Signo de la tabla: − faltó, + de más */
const signed = (n: number, number: (n: number) => string) => (Math.abs(n) < 0.5 ? '0' : `${n < 0 ? '-' : '+'}${number(n)}`);
const tone = (n: number) => (Math.abs(n) < 0.5 ? 'text-muted' : n < 0 ? 'text-danger' : 'text-ok');

/** Historial mes a mes de una categoría en % del ingreso (el diezmo), con desde cuándo se cuenta y el saldo de antes */
export function LedgerSheet({ categoryId, month, onClose }: { categoryId: string; month: string; onClose: () => void }) {
  const { data, ix } = useStore();
  const { money, number, symbol } = useMoney();
  const ledger = useMemo(() => percentLedger(data, ix, categoryId, month), [data, ix, categoryId, month]);
  const category = data.categories.find((c) => c.id === categoryId);
  if (!category) return null;
  const pct = category.budget.type === 'percentIncome' ? category.budget.pct : 0;
  const p = pendingText(ledger.pending, money);
  // Mirando un mes anterior a «Contar desde»: todavía no hay nada acumulado
  const before = month < ledger.from;
  // Lo más nuevo arriba, como un estado de cuenta
  const rows = [...ledger.rows].reverse();
  return (
    <Sheet title={category.name} onClose={onClose} tall>
      <div className="space-y-4">
        {before ? (
          <p className="text-xl leading-snug">Todavía no se cuenta: empieza en {monthLabel(ledger.from).toLowerCase()}.</p>
        ) : (
          <div>
            <div className="text-[15px] text-muted">Acumulado desde {monthLabel(ledger.from).toLowerCase()} hasta {monthLabel(month).toLowerCase()}</div>
            <div className={`text-3xl leading-tight ${p.tone === 'danger' ? 'text-danger' : 'text-ok'}`}>{p.text}</div>
          </div>
        )}

        <LedgerSettings category={category} from={ledger.from} />

        <section>
          <h3 className="section-title">Mes a mes</h3>
          <p className="text-[15px] text-muted">En {symbol}. Con «-», lo que faltó dar; con «+», lo que diste de más.</p>
          {/* Cinco columnas en 280 px (un teléfono de 320): sin el símbolo y con los títulos en dos renglones */}
          <table className="mt-2 w-full table-fixed text-[15px] tabular">
            <colgroup>
              <col className="w-[16%]" /><col className="w-[19%]" /><col className="w-[19%]" /><col className="w-[20%]" /><col className="w-[26%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line text-[13px] leading-tight text-muted">
                <th className="pb-1.5 text-left font-normal">Mes</th>
                <th className="pb-1.5 pl-1 text-right font-normal">{pct}% del ingreso</th>
                <th className="pb-1.5 pl-1 text-right font-normal">Dado</th>
                <th className="pb-1.5 pl-1 text-right font-normal">Diferencia</th>
                <th className="pb-1.5 pl-1 text-right font-normal">Acumulado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.month}>
                  <td className="whitespace-nowrap py-1.5">{monthLabel(r.month, { short: true })}</td>
                  <td className="whitespace-nowrap py-1.5 pl-1 text-right">{number(r.expected)}</td>
                  <td className="whitespace-nowrap py-1.5 pl-1 text-right">{number(r.given)}</td>
                  <td className={`whitespace-nowrap py-1.5 pl-1 text-right ${tone(r.diff)}`}>{signed(r.diff, number)}</td>
                  <td className={`whitespace-nowrap py-1.5 pl-1 text-right ${tone(-r.pending)}`}>{signed(-r.pending, number)}</td>
                </tr>
              ))}
              {ledger.opening !== 0 && (
                <tr>
                  <td colSpan={4} className="py-1.5 text-muted">Saldo inicial</td>
                  <td className={`whitespace-nowrap py-1.5 pl-1 text-right ${tone(-ledger.opening)}`}>{signed(-ledger.opening, number)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {!rows.length && <p className="py-3 text-muted">{before ? `Se cuenta desde ${monthLabel(ledger.from).toLowerCase()}.` : 'Todavía no hay meses para contar.'}</p>}
        </section>
      </div>
    </Sheet>
  );
}

/** «Contar desde» y «Saldo inicial»: se guardan en la categoría al cambiarlos */
function LedgerSettings({ category, from }: { category: Category; from: string }) {
  const { data, upsertCategory } = useStore();
  const { symbol } = useMoney();
  // `category` es la de los datos de ahora (LedgerSheet la busca en cada cambio)
  const fromId = useId();
  const openingId = useId();
  const first = dataSpan(data)?.from ?? currentMonth();
  const start = category.ledger?.from && category.ledger.from < first ? category.ledger.from : first;
  const months = monthRange(start, currentMonth() > from ? currentMonth() : from).reverse();
  const opening = category.ledger?.opening ?? 0;
  const [text, setText] = useState(opening ? String(Math.abs(opening)).replace('.', ',') : '');
  const [ahead, setAhead] = useState(opening < 0);
  // Un saldo que no es un número no se guarda (no pasa a ser 0 sin avisar)
  const bad = !!text.trim() && parseAmount(text) == null;

  const save = (patch: { from?: string | null; amount?: number; ahead?: boolean }) => {
    if (bad && patch.from === undefined && patch.ahead === undefined) return;
    const nextFrom = patch.from === undefined ? category.ledger?.from : patch.from ?? undefined;
    // Con el saldo mal escrito, lo demás se guarda con el saldo que había
    const amount = patch.amount ?? (bad ? Math.abs(opening) : parseAmount(text) ?? 0);
    const value = Math.abs(amount) * ((patch.ahead ?? ahead) ? -1 : 1);
    // Sin mes elegido ni saldo no hace falta guardar nada; con saldo y sin mes, cuenta desde el primer mes con datos
    upsertCategory({ ...category, ledger: !nextFrom && !value ? undefined : { from: nextFrom ?? first, opening: value } });
  };

  return (
    <section className="card space-y-3 p-4">
      <div>
        <label className="label" htmlFor={fromId}>Contar desde</label>
        <select id={fromId} className="field" value={category.ledger?.from ?? ''} onChange={(e) => save({ from: e.target.value || null })}>
          {/* Corto: en un teléfono angosto el nombre del mes queda en la etiqueta del saldo */}
          <option value="">Desde el principio</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor={openingId}>Saldo inicial (lo de antes de {monthLabel(from).toLowerCase()})</label>
        <div className="flex items-center gap-2">
          <span className="text-muted">{symbol}</span>
          <input
            id={openingId}
            className="field min-w-0 flex-1 tabular"
            inputMode="decimal"
            placeholder="0"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => save({})}
            aria-invalid={bad}
            aria-describedby={bad ? `${openingId}-error` : undefined}
          />
        </div>
        {bad && <p id={`${openingId}-error`} role="alert" className="mt-1 text-[15px] text-danger">Revisá el monto (por ejemplo, 1.200): así no se guarda.</p>}
        <div className="mt-2">
          <Segmented
            label="Saldo inicial"
            value={ahead ? 'ahead' : 'owed'}
            onChange={(v) => {
              setAhead(v === 'ahead');
              save({ ahead: v === 'ahead' });
            }}
            options={[{ id: 'owed', label: 'Faltaba dar' }, { id: 'ahead', label: 'Di de más' }]}
          />
        </div>
      </div>
    </section>
  );
}
