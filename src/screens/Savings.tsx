import { useEffect, useId, useState } from 'react';
import { DollarCard } from '../components/DollarCard';
import { PageHeader, Sheet } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { Segmented } from '../components/Toggle';
import { useToast } from '../components/Toast';
import { currentMonth, today } from '../domain/dates';
import { formatRate, usd, validUsdRate, withUsdNote } from '../domain/fx';
import { parseAmount, parseDecimal, round2 } from '../domain/money';
import { savingsBalance, transfersIn } from '../domain/savingsBox';
import { newId } from '../domain/template';
import type { Data, SavingsBox } from '../domain/types';
import { brouRates } from '../lib/brou';
import { usdRateOn } from '../lib/fx';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

/** El ahorro (pesos y dólares): el saldo se actualiza a mano y se puede pasar plata del ahorro a lo del mes */
export function Savings({ onBack }: { onBack: () => void }) {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const box = data.settings.savingsBox;
  const bal = savingsBalance(data, ix, box);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const passed = transfersIn(data, box, currentMonth());
  const passedTotal = passed.reduce((s, m) => s + m.amount, 0);
  return (
    <div>
      <PageHeader title="Ahorro" onBack={onBack} />
      <div className="space-y-3 px-4 pb-10">
        <section className="card relative overflow-hidden p-5">
          <div className="text-lg text-muted">Tenés ahorrado</div>
          <div className="mt-1 text-[40px] leading-none">{money(bal.pesos)}</div>
          <div className="mt-2 text-2xl">{usd(bal.usd)}</div>
          <div className="mt-2 pr-24 text-[15px] text-muted">
            {box ? 'Sube con lo que anotás en categorías de ahorro y baja con lo que pasás al mes.' : 'Escribí cuánto tenés para empezar.'}
          </div>
          <Suricata pose="moneda" size={96} className="absolute -bottom-1 right-2" />
        </section>
        <DollarCard usdSaved={bal.usd} />
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-outline" onClick={() => setEditing(true)}>Actualizar saldo</button>
          <button className="btn-primary" onClick={() => setMoving(true)}>Pasar al mes</button>
        </div>
        {passed.length > 0 && (
          <div className="card p-4">
            <div className="text-lg">Este mes pasaste {money(passedTotal)} del ahorro</div>
            <ul className="mt-1 text-[15px] text-muted">
              {passed.map((m) => <li key={m.id}>{Number(m.date.slice(8, 10))}/{Number(m.date.slice(5, 7))} · {money(m.amount)}{m.note ? ` · ${m.note}` : ''}</li>)}
            </ul>
          </div>
        )}
        <p className="px-1 text-[15px] leading-snug text-muted">
          «Pasar al mes» anota un ingreso «Del ahorro» (no lleva diezmo): suma a lo que te queda este mes y baja el ahorro.
          Si te equivocás, borralo en Movimientos.
        </p>
      </div>
      {editing && <EditBalance current={bal} onClose={() => setEditing(false)} />}
      {moving && <MoveToMonth onClose={() => setMoving(false)} />}
    </div>
  );
}

function EditBalance({ current, onClose }: { current: { pesos: number; usd: number }; onClose: () => void }) {
  const { data, updateSettings } = useStore();
  const id = useId();
  const [pesos, setPesos] = useState(current.pesos ? String(current.pesos).replace('.', ',') : '');
  const [dollars, setDollars] = useState(current.usd ? String(current.usd).replace('.', ',') : '');
  const save = () => {
    const box: SavingsBox = { ...data.settings.savingsBox, pesos: parseAmount(pesos) ?? 0, usd: parseAmount(dollars) ?? 0, at: Date.now() };
    updateSettings({ savingsBox: box });
    onClose();
  };
  return (
    <Sheet title="Cuánto tenés ahorrado" onClose={onClose} footer={<button className="btn-primary w-full" onClick={save}>Guardar</button>}>
      <div className="space-y-4">
        <div><label className="label" htmlFor={`${id}-p`}>En pesos</label><input id={`${id}-p`} className="field" inputMode="decimal" value={pesos} onChange={(e) => setPesos(e.target.value)} /></div>
        <div><label className="label" htmlFor={`${id}-u`}>En dólares (U$S)</label><input id={`${id}-u`} className="field" inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} /></div>
        <p className="text-[15px] text-muted">Desde ahora, lo que anotes en categorías de ahorro y lo que pases al mes lo va moviendo solo.</p>
      </div>
    </Sheet>
  );
}

/** El rubro de ingreso «Del ahorro» (lo crea la primera vez, en la primera categoría de ingresos o en una nueva) */
function withTransferRubro(d: Data): { data: Data; rubroId: string } {
  const known = d.settings.savingsBox?.rubroId;
  if (known && d.rubros.some((r) => r.id === known)) return { data: d, rubroId: known };
  let categories = d.categories;
  let cat = categories.find((c) => c.kind === 'ingreso');
  if (!cat) {
    cat = { id: newId('c'), name: 'Ingresos', kind: 'ingreso', icon: 'm:ahorro-3', color: '#176B60', budget: { type: 'none' }, order: categories.length };
    categories = [...categories, cat];
  }
  const rubro = { id: newId('r'), name: 'Del ahorro', categoryId: cat.id, keywords: [] };
  const box: SavingsBox = { pesos: 0, usd: 0, at: Date.now(), ...d.settings.savingsBox, rubroId: rubro.id };
  return { data: { ...d, categories, rubros: [...d.rubros, rubro], settings: { ...d.settings, savingsBox: box } }, rubroId: rubro.id };
}

function MoveToMonth({ onClose }: { onClose: () => void }) {
  const { data, update } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const id = useId();
  const [cur, setCur] = useState<'pesos' | 'usd'>('pesos');
  const [text, setText] = useState('');
  const [rateText, setRateText] = useState('');
  useEffect(() => {
    if (cur !== 'usd') return;
    let alive = true;
    // La compra del eBROU (lo que te dan por tus dólares) o, si no se puede leer, la del BCU
    void brouRates().then(async (b) => {
      const rate = b?.ebrou?.buy ?? b?.billete?.buy ?? (await usdRateOn(today()))?.rate;
      if (alive && rate) setRateText(formatRate(rate));
    });
    return () => { alive = false; };
  }, [cur]);
  const typed = parseAmount(text);
  const rate = parseDecimal(rateText);
  const okRate = rate != null && validUsdRate(rate);
  const pesos = typed && typed > 0 ? (cur === 'usd' ? (okRate ? round2(typed * rate!) : null) : typed) : null;
  const save = () => {
    if (!pesos) return;
    const now = Date.now();
    const movementId = newId('m');
    update((d0) => {
      const { data: d, rubroId } = withTransferRubro(d0);
      const note = cur === 'usd' ? withUsdNote('Del ahorro', typed!, rate!) : 'Del ahorro';
      return { ...d, movements: [...d.movements, { id: movementId, kind: 'ingreso', amount: pesos, rubroId, date: today(), note, origin: 'manual', noTithe: true, createdAt: now }] };
    });
    toast(`Pasaste ${money(pesos)} del ahorro al mes`, { label: 'Deshacer', run: () => update((d) => ({ ...d, movements: d.movements.filter((m) => m.id !== movementId) })) });
    onClose();
  };
  return (
    <Sheet title="Pasar del ahorro al mes" onClose={onClose} footer={<button className="btn-primary w-full" disabled={!pesos} onClick={save}>Pasar {pesos ? money(pesos) : ''}</button>}>
      <div className="space-y-4">
        <Segmented value={cur} onChange={setCur} label="De qué ahorro" options={[{ id: 'pesos', label: 'Pesos' }, { id: 'usd', label: 'Dólares' }]} />
        <div><label className="label" htmlFor={`${id}-m`}>{cur === 'usd' ? 'Cuántos dólares' : 'Cuánto'}</label><input id={`${id}-m`} className="field text-2xl" inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} /></div>
        {cur === 'usd' && (
          <div><label className="label" htmlFor={`${id}-r`}>Cotización</label><input id={`${id}-r`} className="field" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} placeholder="40,10" /></div>
        )}
        <p className="text-[15px] text-muted">Se anota hoy como ingreso «Del ahorro», sin diezmo: suma a lo que te queda este mes.</p>
      </div>
    </Sheet>
  );
}
