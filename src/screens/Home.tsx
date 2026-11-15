import { ArrowDown, ArrowUp, Camera, ChevronRight, CreditCard, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BudgetRows } from '../components/charts/BudgetRows';
import { Columns } from '../components/charts/Columns';
import { DemoChip } from '../components/Demo';
import { DollarCard } from '../components/DollarCard';
import { ExampleBanner } from '../components/ExampleBanner';
import { CategoryBubble } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { Suricata, type Pose } from '../components/Suricata';
import { MovementRow } from '../components/MovementRow';
import { useToast } from '../components/Toast';
import { cardReminders, monthForecast } from '../domain/alerts';
import { addMonths, currentMonth, monthLabel, monthName, monthOf, today } from '../domain/dates';
import { dayMonth } from '../domain/statementReview';
import { commitments, nextMonthOutlook } from '../domain/installments';
import { formatPct } from '../domain/money';
import { pendingRecurring, type PendingRecurring } from '../domain/recurring';
import { pendingReport } from '../domain/report';
import { savingsBalance } from '../domain/savingsBox';
import { expenseChange, kpis, monthly, monthSummary } from '../domain/stats';
import { OTHER_COLOR } from '../domain/template';
import type { Kind, Movement, Recurring } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

// El suricata saluda solo la primera vez que se abre Inicio en la sesión
let greeted = false;

export function Home({ onAdd, onScan, onStatement, onEdit, onRecord, onGo, onReport, onInstallments, onSavings }: {
  onAdd: (kind: Kind) => void;
  onScan: () => void;
  /** Estado de cuenta de la tarjeta */
  onStatement: () => void;
  onEdit: (m: Movement) => void;
  /** Anotar un gasto fijo (abre el formulario con su monto estimado) */
  onRecord: (r: Recurring) => void;
  onGo: (where: 'movimientos' | 'mes') => void;
  /** Abrir el resumen de un mes */
  onReport: (month: string) => void;
  /** Abrir «Tarjetas y cuotas» */
  onInstallments: () => void;
  /** Abrir «Ahorro» */
  onSavings: () => void;
}) {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const [wave] = useState(() => !greeted);
  useEffect(() => { greeted = true; }, []);
  const month = currentMonth();
  const f = { from: month, to: month, includeSavings: false };
  const k = kpis(data, ix, f);
  const savings = monthly(data, ix, f)[0]?.savings ?? 0;
  // Lo que pasaste al ahorro tampoco lo tenés para gastar
  const left = k.balance - savings;
  const pendingFixed = pendingRecurring(data, month, today()).filter((r) => r.kind === 'gasto').reduce((s, r) => s + r.amount, 0);
  const [detail, setDetail] = useState(false);
  // El mes en curso está incompleto: solo se avisa si ya gastaste más que en todo el mes anterior
  const change = expenseChange(data, ix, month, false, month);
  const columns = monthly(data, ix, { from: addMonths(month, -6), to: month, includeSavings: false }).map((p) => ({
    key: p.month,
    label: monthLabel(p.month, { short: true, year: false }),
    title: monthLabel(p.month),
    value: p.expense,
  }));
  const summary = monthSummary(data, ix, month, false, currentMonth());
  const budgeted = summary.rows.filter((r) => r.hasBudget).sort((a, b) => b.real / (b.budget || 1) - a.real / (a.budget || 1)).slice(0, 4);
  const recent = [...data.movements]
    .filter((m) => !m.monthly)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
    .slice(0, 5);
  const hasMonthsOnly = !recent.length && data.movements.length > 0;
  // Desde el 1 y hasta que lo abras, el resumen del mes que cerró
  const report = pendingReport(data, today());
  // La cara del suricata según cómo viene el mes
  const mood: Pose = k.balance < 0 ? 'cara-preocupado' : summary.budget > 0 && summary.diff > 0 ? 'cara-pensando' : k.income > 0 ? 'cara-feliz' : 'cara-normal';

  return (
    <div className="space-y-4 px-4 pt-[calc(env(safe-area-inset-top)+16px)]">
      <header className="flex items-end justify-between px-1">
        <div className="pb-2">
          <div className="flex items-center gap-2">
            <span className="text-xl text-muted">Hola,</span>
            <DemoChip />
          </div>
          <h1 className="text-4xl leading-tight">{data.settings.name || 'de nuevo'}</h1>
        </div>
        <Suricata pose="saludando" size={92} flip motion={wave ? 'wave' : undefined} />
      </header>

      <ExampleBanner />

      {report && (
        <button className="card flex w-full items-center gap-3 border-primary/40 bg-soft/20 py-2 pl-3 pr-2 text-left" onClick={() => onReport(report)}>
          <Suricata pose="lista" size={64} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-xl leading-tight">Tu resumen de {monthName(report)} está listo</span>
            <span className="block text-[15px] leading-snug text-muted">Cómo te fue: lo que entró, lo que gastaste y el presupuesto</span>
          </span>
          <ChevronRight className="shrink-0 text-muted" size={22} />
        </button>
      )}

      <section className="card relative cursor-pointer overflow-hidden p-5" onClick={() => setDetail(true)}>
        <div className="text-lg text-muted">Te queda en {monthLabel(month, { year: false }).toLowerCase()}</div>
        <div className={`mt-1 text-[44px] leading-none ${left < 0 ? 'text-danger' : ''}`}>{money(left)}</div>
        <div className="mt-2 pr-20 text-[15px] text-muted">
          Entró {money(k.income)} · Gastaste {money(k.expense)}{savings > 0 ? ` · Ahorraste ${money(savings)}` : ''}
        </div>
        {pendingFixed > 0 && (
          <div className="mt-1 pr-20 text-[15px]">
            Después de los fijos que faltan ({money(pendingFixed)}): <span className={left - pendingFixed < 0 ? 'text-danger' : ''}>{money(left - pendingFixed)}</span>
          </div>
        )}
        <div className="mt-1 pr-20 text-[14px] text-primary">Tocá para ver de dónde sale</div>
        {change != null && (
          <div className={`mt-2 flex items-center gap-1 pr-20 text-[15px] ${change > 0 ? 'text-danger' : 'text-ok'}`}>
            {change > 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            {formatPct(Math.abs(change))} {change > 0 ? 'más' : 'menos'} de gastos que el mes anterior
          </div>
        )}
        <Suricata pose={mood} size={104} flip className="absolute -bottom-1 right-2" />
      </section>

      {detail && <LeftDetail month={month} onClose={() => setDetail(false)} />}

      <section className="grid grid-cols-4 gap-2 px-1">
        {[
          { label: 'Gasto', icon: <Minus size={24} />, run: () => onAdd('gasto') },
          { label: 'Ingreso', icon: <Plus size={24} />, run: () => onAdd('ingreso') },
          { label: 'Factura', icon: <Camera size={24} />, run: onScan },
          { label: 'Tarjeta', icon: <CreditCard size={24} />, run: onStatement },
        ].map((a) => (
          <button key={a.label} className="flex flex-col items-center gap-1 text-[15px]" onClick={a.run}>
            <span className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-soft/25 text-primary">{a.icon}</span>
            {a.label}
          </button>
        ))}
      </section>

      <CardReminders onStatement={onStatement} />

      <ForecastCard onSavings={onSavings} />

      <HomeDollar />

      <DueRecurring onRecord={onRecord} />

      <NextMonthCard onOpen={onInstallments} />

      <section className="card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="section-title">Gastos por mes</h2>
          <button className="-my-3 min-h-tap px-1 text-primary" onClick={() => onGo('mes')}>Ver más</button>
        </div>
        <div className="mt-1 text-3xl">{money(k.expense)}</div>
        <div className="text-[15px] text-muted">en {monthLabel(month, { year: false }).toLowerCase()}, sin contar ahorro</div>
        <div className="mt-3">
          <Columns data={columns} highlight={month} />
        </div>
      </section>

      {budgeted.length > 0 && (
        <section className="card px-5 pt-4 pb-2">
          <div className="flex items-baseline justify-between">
            <h2 className="section-title">Presupuesto del mes</h2>
            <button className="-my-3 min-h-tap px-1 text-primary" onClick={() => onGo('mes')}>Ver todo</button>
          </div>
          {/* Solo lo de las categorías con presupuesto: el resto no tiene con qué compararse */}
          <div className="text-[15px] text-muted">Gastaste {money(summary.budgetedExpense)} de {money(summary.budget)}</div>
          <BudgetRows rows={budgeted} onSelect={() => onGo('mes')} />
        </section>
      )}

      <section className="card px-5 pt-4 pb-2">
        <div className="flex items-baseline justify-between">
          <h2 className="section-title">Últimos movimientos</h2>
          <button className="-my-3 min-h-tap px-1 text-primary" onClick={() => onGo('movimientos')}>Ver todos</button>
        </div>
        {recent.length ? (
          <div className="divide-y divide-line">{recent.map((m) => <MovementRow key={m.id} m={m} onClick={() => onEdit(m)} />)}</div>
        ) : (
          <div className="flex items-center gap-3 py-3">
            <Suricata pose="lista" size={96} />
            <p className="text-muted">
            {hasMonthsOnly
              ? 'Tus meses importados están en Movimientos. Lo que anotes desde ahora aparece acá, día por día.'
              : 'Todavía no anotaste nada. Tocá «Gasto» o sacale una foto a una factura.'}
            </p>
          </div>
        )}
      </section>
      <div className="h-4" />
    </div>
  );
}

/**
 * El mes que viene, en un renglón: las cuotas ya comprometidas y el margen estimado. Solo si hay compras en cuotas por
 * delante; tocarla abre «Tarjetas y cuotas»
 */
function NextMonthCard({ onOpen }: { onOpen: () => void }) {
  const { data } = useStore();
  const { money } = useMoney();
  const now = today();
  const ahead = useMemo(() => (data.invoices.some((i) => i.kind === 'estado') ? commitments(data, { today: now, months: 2 }) : null), [data, now]);
  const outlook = useMemo(() => (ahead?.cards.some((c) => c.plans.length) ? nextMonthOutlook(data, { today: now }) : null), [ahead, data, now]);
  if (!outlook) return null;
  return (
    <button className="card flex w-full items-center gap-3 py-3 pl-4 pr-2 text-left" onClick={onOpen}>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-soft/25 text-primary"><CreditCard size={22} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-xl leading-tight">El mes que viene</span>
        <span className="block text-[15px] leading-snug text-muted">
          Cuotas {money(outlook.installments)}
          {outlook.margin != null && <> · <span className={outlook.margin < 0 ? 'text-danger' : ''}>margen ≈ {money(outlook.margin)}</span></>}
        </span>
      </span>
      <ChevronRight className="shrink-0 text-muted" size={22} />
    </button>
  );
}

/** «Netflix el 20, Club el 25 y UTE el 28» (los primeros cuatro) */
function laterText(list: PendingRecurring[], name: (r: PendingRecurring) => string): string {
  const parts = list.slice(0, 4).map((r) => `${name(r)} el ${r.day}`);
  if (list.length > 4) parts.push(`${list.length - 4} más`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0];
}

/** Los gastos fijos del mes que ya llegaron a su día y todavía no se anotaron */
function DueRecurring({ onRecord }: { onRecord: (r: Recurring) => void }) {
  const { data, ix, skipRecurring, recordAllDue } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const now = today();
  const month = currentMonth();
  const pending = pendingRecurring(data, month, now);
  const due = pending.filter((r) => r.due);
  if (!due.length) return null;
  const later = pending.filter((r) => !r.due);
  const name = (r: Recurring) => ix.rubro.get(r.rubroId)?.name ?? 'Sin rubro';
  const original = (r: PendingRecurring) => data.recurring.find((x) => x.id === r.id) ?? r;

  const skip = (r: PendingRecurring) => {
    const undo = skipRecurring(r.id, month);
    toast(`Salteaste «${name(r)}» este mes`, { label: 'Deshacer', run: undo });
  };
  const recordAll = () => {
    const { count, undo } = recordAllDue(month, now);
    if (count) toast(`${count} ${count === 1 ? 'movimiento anotado' : 'movimientos anotados'}`, { label: 'Deshacer', run: undo });
  };

  return (
    <section className="card px-5 pt-4 pb-2">
      <div className="flex items-baseline justify-between">
        <h2 className="section-title">Para anotar este mes</h2>
        {due.length > 1 && <button className="-my-3 min-h-tap px-1 text-primary" onClick={recordAll}>Anotar todos</button>}
      </div>
      <div className="text-[15px] text-muted">Tus gastos fijos, con el monto estimado</div>
      <div className="divide-y divide-line">
        {due.map((r) => {
          const cat = ix.category.get(ix.rubro.get(r.rubroId)?.categoryId ?? '');
          return (
            // En un teléfono angosto los botones bajan a otro renglón: el monto estimado tiene que leerse entero
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 py-2">
              <CategoryBubble icon={cat?.icon ?? 'tag'} color={cat?.color ?? OTHER_COLOR} size={36} />
              <div className="min-w-[7rem] flex-1">
                <div className="truncate text-lg leading-tight">{name(r)}</div>
                <div className="whitespace-nowrap text-[15px]">
                  <span className="text-muted">el {r.day} · </span>
                  <span className={`tabular ${r.kind === 'ingreso' ? 'text-ok' : ''}`}>{money(r.amount, { sign: r.kind === 'ingreso' })}</span>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <button className="min-h-tap px-1 text-[16px] text-muted" onClick={() => skip(r)} aria-label={`Saltar ${name(r)}`}>Saltar</button>
                <button className="chip text-primary" onClick={() => onRecord({ ...original(r), amount: r.amount })} aria-label={`Anotar ${name(r)}`}>Anotar</button>
              </div>
            </div>
          );
        })}
      </div>
      {later.length > 0 && (
        <p className="border-t border-line py-2 text-[15px] text-muted">Más adelante: {laterText(later, name)}</p>
      )}
    </section>
  );
}

/** «Al ritmo de este mes no llegás»: desde el día 8 y hasta el anteúltimo, si se puede apagar en Ajustes */
function ForecastCard({ onSavings }: { onSavings: () => void }) {
  const { data, ix, device } = useStore();
  const { money } = useMoney();
  const now = today();
  const day = Number(now.slice(8, 10));
  const f = useMemo(() => monthForecast(data, ix, now), [data, ix, now]);
  if (!device.forecast || data.settings.example || day < 8 || f.end >= 0) return null;
  return (
    <section className="card flex items-start gap-3 border-danger/40 p-4">
      <Suricata pose="cara-preocupado" size={56} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xl leading-tight">Al ritmo de este mes te faltarían {money(-f.end)}</div>
        <div className="mt-1 text-[15px] leading-snug text-muted">
          En el día a día llevás {money(f.daily)}; si seguís así, a fin de mes serían {money(f.dailyEnd)}
          {f.pendingFixed > 0 ? `, más ${money(f.pendingFixed)} de fijos que faltan` : ''}.
        </div>
        <button className="chip mt-2 text-primary" onClick={onSavings}>Pasar del ahorro</button>
      </div>
    </section>
  );
}

/** Tarjetas: subir el estado de cuenta cuando ya cerró, y no olvidarse de pagarlo cuando vence */
function CardReminders({ onStatement }: { onStatement: () => void }) {
  const { data, update } = useStore();
  const list = cardReminders(data.invoices, today());
  if (!list.length) return null;
  const paid = (id: string) => update((d) => ({ ...d, invoices: d.invoices.map((i) => (i.id === id ? { ...i, paid: true } : i)) }));
  return (
    <>
      {list.map((r) => (
        <section key={`${r.kind}-${r.invoice.id}`} className={`card flex items-center gap-3 p-4 ${r.kind === 'pagar' ? 'border-danger/40' : ''}`}>
          <CreditCard size={26} className={`shrink-0 ${r.kind === 'pagar' ? 'text-danger' : 'text-primary'}`} />
          <div className="min-w-0 flex-1">
            <div className="text-lg leading-tight">
              {r.kind === 'subir' ? `Ya cerró ${r.card}: subí el estado de cuenta` : `${r.date === today() ? 'Hoy vence' : `Vence el ${dayMonth(r.date)}`} ${r.card}: no te olvides de pagar`}
            </div>
          </div>
          {r.kind === 'subir'
            ? <button className="chip shrink-0 text-primary" onClick={onStatement}>Subir</button>
            : <button className="chip shrink-0 text-primary" onClick={() => paid(r.invoice.id)}>Ya pagué</button>}
        </section>
      ))}
    </>
  );
}

/** El dólar alto o bajo, si tenés ahorro en dólares (se apaga en Ajustes) */
function HomeDollar() {
  const { data, ix, device } = useStore();
  if (!device.dollar || data.settings.example) return null;
  const usdSaved = savingsBalance(data, ix, data.settings.savingsBox).usd;
  if (usdSaved <= 0) return null;
  return <DollarCard usdSaved={usdSaved} compact />;
}

/** De dónde sale «Te queda»: lo que entró, lo gastado (anotado y de la tarjeta), lo ahorrado, los fijos que faltan y las tarjetas sin el estado de cuenta de este mes */
function LeftDetail({ month, onClose }: { month: string; onClose: () => void }) {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const now = today();
  const mine = data.movements.filter((m) => monthOf(m.date) === month);
  const byRubro = (list: Movement[]) => {
    const t = new Map<string, number>();
    for (const m of list) t.set(m.rubroId, (t.get(m.rubroId) ?? 0) + m.amount);
    return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => ({ name: ix.rubro.get(id)?.name ?? 'Sin rubro', v }));
  };
  const total = (list: Movement[]) => list.reduce((s, m) => s + m.amount, 0);
  const incomes = mine.filter((m) => m.kind === 'ingreso');
  const spends = mine.filter((m) => m.kind === 'gasto' && !ix.categoryOf(m)?.savings);
  const saved = mine.filter((m) => m.kind === 'gasto' && ix.categoryOf(m)?.savings);
  const card = spends.filter((m) => m.origin === 'tarjeta');
  const sheet = spends.filter((m) => m.monthly);
  const other = spends.filter((m) => m.origin !== 'tarjeta' && !m.monthly);
  const pending = pendingRecurring(data, month, now).filter((r) => r.kind === 'gasto');
  const left = total(incomes) - total(spends) - total(saved);
  // Las tarjetas: si el estado de cuenta que se paga este mes ya está (sus gastos van con la fecha del pago)
  const cards = new Map<string, { name: string; here: boolean }>();
  for (const inv of data.invoices.filter((i) => i.kind === 'estado')) {
    const name = inv.card?.trim() || 'Tarjeta';
    const key = name.toLowerCase();
    const here = data.movements.some((m) => m.invoiceId === inv.id && monthOf(m.date) === month);
    cards.set(key, { name, here: here || !!cards.get(key)?.here });
  }
  const Line = ({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) => (
    <div className={`flex justify-between gap-3 ${strong ? 'text-lg' : 'text-[15px]'}`}><span className="min-w-0 truncate">{label}</span><span className="shrink-0 tabular">{money(value)}</span></div>
  );
  return (
    <Sheet title={`Te queda en ${monthLabel(month, { year: false }).toLowerCase()}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <Line label="Entró" value={total(incomes)} strong />
          <div className="mt-1 space-y-0.5 pl-3 text-muted">{byRubro(incomes).slice(0, 6).map((r) => <Line key={r.name} label={r.name} value={r.v} />)}</div>
        </div>
        <div>
          <Line label="Gastaste" value={total(spends)} strong />
          <div className="mt-1 space-y-0.5 pl-3 text-muted">
            {other.length > 0 && <Line label="Anotado y facturas" value={total(other)} />}
            {card.length > 0 && <Line label="De la tarjeta (estados de cuenta)" value={total(card)} />}
            {sheet.length > 0 && <Line label="Totales de la planilla" value={total(sheet)} />}
          </div>
        </div>
        {saved.length > 0 && <Line label="Pasaste al ahorro" value={total(saved)} strong />}
        <div className="border-t border-line pt-3"><Line label="Te queda" value={left} strong /></div>
        {pending.length > 0 && (
          <div>
            <Line label="Fijos que faltan anotar" value={pending.reduce((s, r) => s + r.amount, 0)} strong />
            <div className="mt-1 space-y-0.5 pl-3 text-muted">{pending.map((r) => <Line key={r.id} label={`${ix.rubro.get(r.rubroId)?.name ?? 'Fijo'} (el ${r.day})`} value={r.amount} />)}</div>
            <p className="mt-1 text-[15px]">Después de pagarlos te quedarían {money(left - pending.reduce((s, r) => s + r.amount, 0))}.</p>
          </div>
        )}
        {[...cards.values()].some((c) => !c.here) && (
          <div className="rounded-2xl bg-sunken p-3 text-[15px] leading-snug">
            {[...cards.values()].filter((c) => !c.here).map((c) => c.name).join(', ')}: todavía no hay gastos que se paguen este mes. Si ya te llegó el estado de cuenta que pagás en {monthLabel(month, { year: false }).toLowerCase()}, subilo con «Tarjeta»; hasta entonces lo de la tarjeta no se descuenta.
          </div>
        )}
        <p className="text-[14px] text-muted">Lo que compraste con tarjeta este mes se descuenta el mes en que lo pagás, cuando subís ese estado de cuenta.</p>
      </div>
    </Sheet>
  );
}
