import { CreditCard, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { StackedColumns } from '../components/charts/StackedColumns';
import { Legend } from '../components/charts/TimeChart';
import { PageHeader } from '../components/Sheet';
import { EmptyState, Suricata } from '../components/Suricata';
import { Toggle } from '../components/Toggle';
import { addMonths, monthLabel, monthName as monthNameIn, monthOf, shortDate, today } from '../domain/dates';
import { usd } from '../domain/fx';
import {
  cardOrder,
  commitments,
  isStale,
  missingStatement,
  nextMonthOutlook,
  nextStatementMonth,
  sameCard,
  simulatePurchase,
  type CardInstallments,
  type Commitments,
  type Outlook,
} from '../domain/installments';
import { parseAmount } from '../domain/money';
import { OTHER_COLOR, PALETTE } from '../domain/template';
import { joinAnd, plural } from '../domain/text';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

/** Meses de la gráfica */
const CHART_MONTHS = 6;
/** Compras de cada tarjeta que se ven sin tocar «Ver las…» */
const SHOWN_PLANS = 3;
/** Las cuotas que se ofrecen en el simulador (o «Otra») */
const COUNTS = [1, 2, 3, 6, 10, 12, 18];

/** «de los últimos 3 meses con datos», «del último mes con datos» */
const ofLastMonths = (n: number) => (n === 1 ? 'del último mes con datos' : `de los últimos ${n} meses con datos`);

/**
 * Tarjetas y cuotas: lo que ya está comprometido de cada tarjeta para los meses que vienen (de su último estado de
 * cuenta), el mes que viene con el margen estimado y «¿Me da para comprar?». Los números salen de domain/installments
 */
export function InstallmentsScreen({ onBack, onStatement }: { onBack: () => void; onStatement: () => void }) {
  const { data } = useStore();
  const now = today();
  // Como el resumen del mes: el ahorro no es un gasto, salvo que se pida
  const [includeSavings, setIncludeSavings] = useState(false);
  const c = useMemo(() => commitments(data, { today: now }), [data, now]);
  const outlook = useMemo(() => nextMonthOutlook(data, { today: now, includeSavings }), [data, now, includeSavings]);
  const order = useMemo(() => cardOrder(data.invoices), [data.invoices]);
  // El color sigue a la tarjeta (el orden en que se subió la primera vez), no a su lugar en la lista
  const colorOf = (card: string) => {
    const i = order.findIndex((x) => sameCard(x, card));
    return i >= 0 && i < PALETTE.length ? PALETTE[i] : OTHER_COLOR;
  };

  // Las que ya no se usan (sin cuotas por delante y sin un estado de cuenta de los últimos meses), en un renglón
  const old = c.cards.filter((x) => !x.plans.length && !x.stale && isStale(x.closing, now));
  const active = c.cards.filter((x) => !old.includes(x));

  if (!c.cards.length) {
    return (
      <div>
        <PageHeader title="Tarjetas y cuotas" onBack={onBack} />
        <div className="px-4 pb-10">
          <div className="card">
            <EmptyState pose="calculadora" title="Todavía no subiste estados de cuenta">
              En Inicio tocá «Tarjeta» y subí el PDF que te manda el banco (Itaú, OCA, BROU, Scotiabank…). Pengar lee las
              compras en cuotas y te dice cuánto ya tenés comprometido para los próximos meses y si te da para comprar algo más.
            </EmptyState>
            <div className="px-5 pb-5">
              <button className="btn-primary w-full" onClick={onStatement}><CreditCard size={20} /> Subir un estado de cuenta</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Tarjetas y cuotas" onBack={onBack} />
      <div className="space-y-4 px-4 pb-10">
        <NextMonth outlook={outlook} c={c} includeSavings={includeSavings} setIncludeSavings={setIncludeSavings} now={now} />
        <Chart c={c} colorOf={colorOf} now={now} />
        <section className="space-y-3" aria-labelledby="tarjetas-titulo">
          <h2 id="tarjetas-titulo" className="section-title px-1">Tus tarjetas</h2>
          {active.map((card) => <CardBlock key={card.card} card={card} months={c.months} color={colorOf(card.card)} now={now} />)}
          {old.length > 0 && (
            <p className="px-1 text-[15px] leading-snug text-muted">
              Sin cuotas por delante: {joinAnd(old.map((x) => `${x.card} (último estado de cuenta de ${monthLabel(monthOf(x.closing), { year: true })})`))}.
            </p>
          )}
        </section>
        <Simulator cards={c.cards.map((x) => x.card)} includeSavings={includeSavings} now={now} />
        <button className="btn-outline w-full" onClick={onStatement}><CreditCard size={20} strokeWidth={1.75} /> Subir otro estado de cuenta</button>
      </div>
    </div>
  );
}

// --- El mes que viene ------------------------------------------------------------------------------------

function Line({ label, sub, value, strong = false, tone }: { label: string; sub?: string; value: string; strong?: boolean; tone?: 'danger' }) {
  return (
    <div className="flex items-baseline gap-3 py-2">
      <dt className="min-w-0 flex-1">
        <span className={`block ${strong ? 'text-lg' : ''}`}>{label}</span>
        {sub && <span className="block text-[14px] leading-snug text-muted">{sub}</span>}
      </dt>
      <dd className={`shrink-0 tabular ${strong ? 'text-lg' : ''} ${tone === 'danger' ? 'text-danger' : ''}`}>{value}</dd>
    </div>
  );
}

function NextMonth({ outlook: o, c, includeSavings, setIncludeSavings, now }: {
  outlook: Outlook;
  c: Commitments;
  includeSavings: boolean;
  setIncludeSavings: (v: boolean) => void;
  now: string;
}) {
  const { money } = useMoney();
  const k = c.months.indexOf(o.month);
  const withCuotas = c.cards.filter((x) => k >= 0 && x.byMonth[k] > 0).map((x) => x.card);
  const minus = (n: number) => (n > 0 ? `−${' '}${money(n)}` : money(0));
  const hero = o.margin != null
    ? { label: 'Margen estimado', value: o.margin, text: o.margin >= 0 ? 'Lo que te quedaría para comprar o ahorrar, si el mes viene como siempre.' : 'Si el mes viene como siempre, no te alcanza: lo comprometido y lo de siempre pasan lo que entra.' }
    : !o.income
      ? { label: 'Cuotas ya comprometidas', value: o.installments, text: 'Para estimar el margen me falta saber cuánto te entra: anotá tus ingresos o marcá el sueldo como fijo en Más → Gastos fijos.' }
      : { label: 'Te queda después de fijos y cuotas', value: o.free ?? 0, text: 'Para el margen me falta saber cuánto gastás en un mes habitual: todavía no hay meses completos anotados.' };
  return (
    <section className="card p-4" aria-labelledby="mes-que-viene">
      <h2 id="mes-que-viene" className="section-title">El mes que viene</h2>
      <p className="text-[15px] text-muted">{monthLabel(o.month, { year: o.month.slice(0, 4) !== now.slice(0, 4) })} · es una estimación</p>
      <div className="mt-3 text-[15px] text-muted">{hero.label}</div>
      <div className={`text-[40px] leading-none ${hero.value < 0 ? 'text-danger' : ''}`}>{money(hero.value)}</div>
      <p className="mt-1 text-[15px] leading-snug text-muted">{hero.text}</p>
      <dl className="mt-3 divide-y divide-line border-t border-line">
        <Line
          label="Ingresos estimados"
          sub={!o.income ? 'No hay ingresos anotados en los últimos meses' : o.income.from === 'fijos' ? 'Tus ingresos fijos (Más → Gastos fijos)' : `El promedio ${ofLastMonths(o.income.months ?? 1)}`}
          value={o.income ? money(o.income.amount) : 'Sin datos'}
        />
        <Line
          label="Gastos fijos"
          sub={o.fixed > 0 ? `Los de Más → Gastos fijos${includeSavings ? '' : ', sin el ahorro'}` : 'No marcaste gastos fijos: van en el resto de los gastos'}
          value={minus(o.fixed)}
        />
        <Line
          label="Cuotas ya comprometidas"
          sub={withCuotas.length ? `De los estados de cuenta de ${joinAnd(withCuotas)}` : 'Ninguna cuota ese mes'}
          value={minus(o.installments)}
        />
        {o.free != null && <Line label="Te queda" sub="Lo que entra menos los fijos y las cuotas" value={money(o.free)} tone={o.free < 0 ? 'danger' : undefined} />}
        <Line
          label="El resto de los gastos"
          sub={o.usual ? `Lo de un mes habitual: el promedio ${ofLastMonths(o.usual.months)}, sin las cuotas que siguen ni los fijos` : 'Todavía no hay meses completos anotados'}
          value={o.usual ? minus(o.usual.amount) : 'Sin datos'}
        />
        {o.margin != null && <Line strong label="Margen estimado" value={money(o.margin)} tone={o.margin < 0 ? 'danger' : undefined} />}
      </dl>
      {o.staleCards.length > 0 && (
        <p className="mt-2 flex gap-2 text-[15px] leading-snug">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-danger" />
          <span>Puede haber más cuotas: falta el último estado de cuenta de {joinAnd(o.staleCards)} (más abajo).</span>
        </p>
      )}
      <div className="mt-2 border-t border-line pt-1">
        <Toggle checked={includeSavings} onChange={setIncludeSavings} label="Descontar lo que ahorrás" />
        <p className="text-[14px] leading-snug text-muted">
          {includeSavings
            ? 'Lo que ahorrás cada mes cuenta como gasto: el margen es lo que queda para comprar.'
            : 'El ahorro no se resta: el margen es lo que queda para comprar o para ahorrar.'}
          {' '}Sale de lo que anotaste: si un mes viene distinto (un aguinaldo, un arreglo), el margen también.
        </p>
      </div>
    </section>
  );
}

// --- La gráfica ------------------------------------------------------------------------------------------

function Chart({ c, colorOf, now }: { c: Commitments; colorOf: (card: string) => string; now: string }) {
  const { money } = useMoney();
  // Desde este mes si todavía falta cerrar algún estado de cuenta con cuotas; si no, desde el que viene
  const start = c.total[0] > 0 ? 0 : 1;
  const months = c.months.slice(start, start + CHART_MONTHS);
  const cards = c.cards.filter((x) => x.byMonth.slice(start, start + CHART_MONTHS).some((v) => v > 0));
  const series = cards.map((x) => ({ key: x.card, name: x.card, color: colorOf(x.card) }));
  const columns = months.map((m, i) => ({
    key: m,
    label: monthLabel(m, { short: true, year: false }),
    title: monthLabel(m),
    values: Object.fromEntries(cards.map((x) => [x.card, x.byMonth[start + i]])),
  }));
  const totals = c.total.slice(start, start + CHART_MONTHS);
  const next = addMonths(monthOf(now), 1);
  // Lo de cada tarjeta también, para el lector de pantalla (el detalle de la gráfica se abre tocando)
  const label = `Cuotas comprometidas por mes${cards.length > 1 ? ', por tarjeta' : ''}: ${months.map((m, i) => {
    const parts = cards.filter((x) => x.byMonth[start + i] > 0).map((x) => `${x.card} ${money(x.byMonth[start + i])}`);
    return `${monthNameIn(m, monthOf(now))} ${money(totals[i])}${cards.length > 1 && parts.length ? ` (${parts.join(', ')})` : ''}`;
  }).join('; ')}`;
  return (
    <section className="card p-4" aria-labelledby="grafica-cuotas">
      <h2 id="grafica-cuotas" className="section-title">Cuotas de los próximos meses</h2>
      <p className="text-[15px] leading-snug text-muted">
        Lo que ya está comprometido{series.length === 1 ? ` en ${series[0].name}` : ', por tarjeta'}, en el mes en que cierra cada estado de cuenta. Tocá un mes para ver el detalle.
      </p>
      {series.length ? (
        <div className="mt-3">
          <StackedColumns series={series} data={columns} highlight={months.includes(next) ? next : months[0]} label={label} />
          {series.length > 1 && <Legend series={series} />}
        </div>
      ) : (
        <p className="mt-3 text-muted">No tenés cuotas por delante.</p>
      )}
    </section>
  );
}

// --- Cada tarjeta ----------------------------------------------------------------------------------------

function CardBlock({ card, months, color, now }: { card: CardInstallments; months: string[]; color: string; now: string }) {
  const { money } = useMoney();
  const [open, setOpen] = useState(false);
  const name = (m: string) => monthNameIn(m, monthOf(now));
  const nextM = nextStatementMonth(card.closing, now);
  const nextIdx = months.indexOf(nextM);
  const nextAmount = nextIdx >= 0 ? card.byMonth[nextIdx] : 0;
  const missing = card.stale ? missingStatement(card.closing, now) : null;
  const shown = open ? card.plans : card.plans.slice(0, SHOWN_PLANS);
  const titleId = useId();
  const row = (label: string, value: ReactNode) => (
    <div className="flex items-baseline gap-3 py-1.5">
      <dt className="min-w-0 flex-1 text-muted">{label}</dt>
      <dd className="shrink-0 text-right tabular">{value}</dd>
    </div>
  );
  return (
    <section className="card p-4" aria-labelledby={titleId}>
      <div className="flex items-center gap-3">
        {/* El mismo color que en la gráfica */}
        <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: color }} />
        <h3 id={titleId} className="min-w-0 flex-1 truncate text-xl">{card.card}</h3>
        <div className="shrink-0 text-right leading-tight">
          <div className="text-[13px] text-muted">Falta en cuotas</div>
          <div className="text-lg tabular">{money(card.left)}</div>
        </div>
      </div>
      <dl className="mt-2 divide-y divide-line border-t border-line text-[16px]">
        {row('Último cierre', shortDate(card.closing))}
        {card.available != null && row('Disponible al cierre', card.limit ? `${money(card.available)} de ${money(card.limit)}` : money(card.available))}
        {card.available == null && card.limit != null && row('Límite de crédito', money(card.limit))}
        {row(`Cuotas del estado de cuenta de ${name(nextM)}`, money(nextAmount))}
      </dl>
      {missing && (
        <p className="mt-2 flex gap-2 rounded-2xl border border-danger/40 px-3 py-2 text-[16px] leading-snug">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-danger" />
          <span>Subí el estado de cuenta de {name(missing)} de {card.card} para tener las cuotas al día.</span>
        </p>
      )}
      {card.plans.length ? (
        <>
          <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-2">
            <h4 className="text-lg">{plural(card.plans.length, 'compra en cuotas', 'compras en cuotas')}</h4>
            {card.plans.length > SHOWN_PLANS && (
              <button className="-my-3 min-h-tap shrink-0 px-1 text-primary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {open ? 'Ver menos' : `Ver las ${card.plans.length}`}
              </button>
            )}
          </div>
          <ul className="divide-y divide-line">
            {shown.map((p, i) => {
              const left = p.months.length;
              // La última que ya se cobró (si falta subir algún estado de cuenta, no es la del último subido): con
              // las que quedan, suman el total
              const paid = p.of - left;
              return (
                <li key={`${p.key}-${i}`} className="py-2">
                  <div className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate">{p.merchant}</span>
                    <span className="shrink-0 tabular">{money(p.amount)}<span className="text-[14px] text-muted"> por mes</span></span>
                  </div>
                  <div className="text-[14px] leading-snug text-muted">
                    cuota {paid} de {p.of} · {left === 1 ? `queda 1, en ${name(p.ends)}` : `quedan ${left} · termina en ${name(p.ends)}`}
                    {p.usd ? ` · ${usd(p.usd)}` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="mt-2 border-t border-line pt-2 text-[16px] text-muted">No tiene compras en cuotas por delante.</p>
      )}
    </section>
  );
}

// --- ¿Me da para comprar? --------------------------------------------------------------------------------

function Simulator({ cards, includeSavings, now }: { cards: string[]; includeSavings: boolean; now: string }) {
  const { data } = useStore();
  const { money, symbol } = useMoney();
  const [amountText, setAmountText] = useState('');
  const [count, setCount] = useState<number | 'otra'>(1);
  const [otherText, setOtherText] = useState('');
  const [card, setCard] = useState<string | null>(null);
  const amountId = useId();
  const otherId = useId();
  const countsId = useId();
  const cardsId = useId();
  const name = (m: string) => monthNameIn(m, monthOf(now));

  const amount = parseAmount(amountText);
  const n = count === 'otra' ? Number(otherText.trim()) : count;
  const badCount = count === 'otra' && !!otherText.trim() && !(Number.isInteger(n) && n >= 2 && n <= 72);
  // Con «Otra», de 2 a 72 (1 es «1»): con el aviso de error no hay resultado
  const sim = amount != null && amount > 0 && Number.isInteger(n) && n >= (count === 'otra' ? 2 : 1) && n <= 72
    ? simulatePurchase(data, { amount, count: n, card: card ?? undefined }, { today: now, includeSavings })
    : null;

  let summaryBlock: ReactNode = null;
  let tableBlock: ReactNode = null;
  if (sim) {
    const o = sim.outlook;
    const first = sim.cuotas[0];
    const last = sim.cuotas.at(-1)!;
    const k = sim.months.indexOf(o.month);
    const before = k >= 0 ? sim.before[k] : 0;
    const after = k >= 0 ? sim.after[k] : 0;
    const summary = sim.cuotas.length === 1
      ? `Un pago de ${money(first.amount)}, en el estado de cuenta de ${name(first.month)}.`
      : `${sim.cuotas.length} cuotas de ${money(first.amount)} por mes, de ${name(first.month)} a ${name(last.month)}.`;
    // Lo que cae en el estado de cuenta de este mes sale de la plata de este mes (como las cuotas: cada una en el mes en
    // que cierra su estado de cuenta)
    const closes = sim.closingDay ? `que cierra el ${sim.closingDay}` : 'que cierra este mes';
    const missingFor = `me falta saber ${o.income ? 'cuánto gastás en un mes habitual' : 'cuánto te entra'}`;
    const thisText = `Suma ${money(sim.thisMonth)} al estado de cuenta de ${name(first.month)}, ${closes}: sale de la plata de este mes.`;
    type Verdict = { pose: 'cara-feliz' | 'cara-preocupado' | 'cara-pensando'; title: string; text: string };
    let verdict: Verdict = sim.nextMonth === 0
      ? sim.thisMonth === 0
        ? { pose: 'cara-pensando', title: 'El mes que viene no cambia', text: `Va en el estado de cuenta de ${name(first.month)}.` }
        : sim.thisMargin == null
          ? { pose: 'cara-pensando', title: `Suma ${money(sim.thisMonth)} al estado de cuenta de ${name(first.month)}, ${closes}`, text: `Sale de la plata de este mes. Para saber si te da, ${missingFor}.` }
          : sim.thisMargin >= 0
            ? { pose: 'cara-feliz', title: `Te da: este mes te quedarían ≈ ${money(sim.thisMargin)}`, text: thisText }
            : { pose: 'cara-preocupado', title: `No te da: este mes te faltarían ≈ ${money(-sim.thisMargin)}`, text: thisText }
      : sim.margin == null
        ? {
          pose: 'cara-pensando',
          title: `Las cuotas del mes que viene pasarían de ${money(before)} a ${money(after)}`,
          text: `Para saber si te da, me falta saber ${o.income ? 'cuánto gastás en un mes habitual' : 'cuánto te entra'}.`,
        }
        : sim.margin >= 0
          ? { pose: 'cara-feliz', title: `Te da: el mes que viene te quedarían ≈ ${money(sim.margin)}`, text: `Sin la compra, ≈ ${money(o.margin!)} de margen.` }
          : o.margin! >= 0
            ? { pose: 'cara-preocupado', title: `No te da: el mes que viene te faltarían ≈ ${money(-sim.margin)}`, text: `Sin la compra te quedaban ≈ ${money(o.margin!)} de margen.` }
            : { pose: 'cara-preocupado', title: `No te da: ya sin la compra te faltaban ≈ ${money(-o.margin!)}`, text: `Con la compra te faltarían ≈ ${money(-sim.margin)}.` };
    // En cuotas, con la primera en el estado de cuenta de este mes: también cuenta este mes
    if (sim.nextMonth > 0 && sim.thisMonth > 0) {
      const short = sim.thisMargin != null && sim.thisMargin < 0;
      verdict = {
        pose: short ? 'cara-preocupado' : verdict.pose,
        title: verdict.title,
        text: `${verdict.text} La primera (${money(sim.thisMonth)}) va en el estado de cuenta de ${name(first.month)}, ${closes}${short ? `: este mes te faltarían ≈ ${money(-sim.thisMargin!)}` : ''}.`,
      };
    }
    // Los meses con cuotas, hasta la última de la compra (como mucho 6)
    const rows = sim.months
      .map((m, i) => ({ m, before: sim.before[i], after: sim.after[i] }))
      .filter((r) => r.m >= first.month && r.m <= last.month)
      .slice(0, 6);
    summaryBlock = (
      <div className="mt-4 space-y-3 border-t border-line pt-3">
        <p className="text-lg leading-snug">{summary}</p>
        <div className="flex items-center gap-3 rounded-2xl bg-sunken px-3 py-2">
          <Suricata pose={verdict.pose} size={56} className="shrink-0" />
          <div className="min-w-0">
            <p className="text-[17px] leading-snug">{verdict.title}</p>
            <p className="text-[15px] leading-snug text-muted">{verdict.text}</p>
          </div>
        </div>
      </div>
    );
    tableBlock = (
      <div className="mt-3 space-y-3">
        <table className="w-full text-[16px]">
          <caption className="pb-1 text-left text-[15px] text-muted">Cuotas de cada mes{cards.length > 1 ? ', todas las tarjetas' : ''}</caption>
          <thead>
            <tr className="text-[14px] text-muted">
              <th scope="col" className="py-1 text-left font-normal">Mes</th>
              <th scope="col" className="py-1 text-right font-normal">Ahora</th>
              <th scope="col" className="py-1 text-right font-normal">Con la compra</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {rows.map((r) => (
              <tr key={r.m}>
                <th scope="row" className="py-1.5 text-left font-normal">{monthLabel(r.m, { year: r.m.slice(0, 4) !== now.slice(0, 4) })}</th>
                <td className="py-1.5 text-right tabular text-muted">{money(r.before)}</td>
                <td className="py-1.5 text-right tabular">{money(r.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sim.cuotas.length > rows.length && <p className="text-[15px] text-muted">Y {plural(sim.cuotas.length - rows.length, 'cuota más', 'cuotas más')}, hasta {name(last.month)}.</p>}
      </div>
    );
  }

  return (
    <section className="card p-4" aria-labelledby="me-da">
      <h2 id="me-da" className="section-title">¿Me da para comprar?</h2>
      <p className="text-[15px] leading-snug text-muted">Escribí cuánto sale y en cuántas cuotas: te digo cómo quedan los próximos meses. No se guarda.</p>
      <div className="mt-3 space-y-3">
        <div>
          <label className="label" htmlFor={amountId}>Cuánto sale</label>
          <input id={amountId} className="field tabular" inputMode="decimal" autoComplete="off" placeholder={`${symbol} 12.000`} value={amountText} onChange={(e) => setAmountText(e.target.value)} />
        </div>
        <div role="group" aria-labelledby={countsId}>
          <div id={countsId} className="label">En cuántas cuotas</div>
          <div className="flex flex-wrap gap-2">
            {COUNTS.map((x) => (
              <button key={x} className={`min-w-tap justify-center ${count === x ? 'chip-on' : 'chip'}`} aria-pressed={count === x} aria-label={x === 1 ? '1 pago' : `${x} cuotas`} onClick={() => setCount(x)}>{x}</button>
            ))}
            <button className={count === 'otra' ? 'chip-on' : 'chip'} aria-pressed={count === 'otra'} onClick={() => setCount('otra')}>Otra</button>
          </div>
        </div>
        {count === 'otra' && (
          <div>
            <label className="label" htmlFor={otherId}>Cantidad de cuotas (de 2 a 72)</label>
            <input id={otherId} className="field w-28 tabular" inputMode="numeric" autoComplete="off" value={otherText} onChange={(e) => setOtherText(e.target.value.replace(/\D/g, ''))} />
            {badCount && <p className="mt-1 text-[15px] text-danger">Tienen que ser de 2 a 72 cuotas.</p>}
          </div>
        )}
        {cards.length > 0 && (
          <div role="group" aria-labelledby={cardsId}>
            <div id={cardsId} className="label">Con qué tarjeta (opcional)</div>
            <div className="flex flex-wrap gap-2">
              <button className={card == null ? 'chip-on' : 'chip'} aria-pressed={card == null} onClick={() => setCard(null)}>Sin elegir</button>
              {cards.map((x) => (
                <button key={x} className={`max-w-full ${card === x ? 'chip-on' : 'chip'}`} aria-pressed={card === x} onClick={() => setCard(x)}>
                  <span className="truncate">{x}</span>
                </button>
              ))}
            </div>
            <p className="mt-1 text-[14px] leading-snug text-muted">
              {card ? `La primera cuota va en el próximo cierre de ${card}.` : 'Sin elegir la tarjeta, la primera cuota va el mes que viene.'}
            </p>
          </div>
        )}
      </div>
      {/* Siempre en la página (vacía sin resultado), así el lector de pantalla anuncia el primero; solo el resumen y el veredicto, no la tabla */}
      <div aria-live="polite">{summaryBlock}</div>
      {tableBlock}
    </section>
  );
}
