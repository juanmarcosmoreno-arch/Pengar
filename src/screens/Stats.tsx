import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BudgetRows } from '../components/charts/BudgetRows';
import { Donut } from '../components/charts/Donut';
import { HBars } from '../components/charts/HBars';
import { Legend, TimeChart } from '../components/charts/TimeChart';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Sheet';
import { Segmented, Toggle } from '../components/Toggle';
import { addMonths, currentMonth, monthLabel, monthOf } from '../domain/dates';
import { formatPct } from '../domain/money';
import {
  dataSpan, foldOthers, groupTotals, kpis, monthly, monthSummary, percentCards, stack, type Filter, type GroupBy,
} from '../domain/stats';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

export type StatsView = 'mes' | 'tendencias';
type Period = '6' | '12' | 'anio' | 'todo';

const INCOME_COLOR = '#176B60';
const SAVINGS_COLOR = '#6250d6';

export function Stats({ view, setView, month, setMonth }: { view: StatsView; setView: (v: StatsView) => void; month: string; setMonth: (m: string) => void }) {
  return (
    <div>
      <PageHeader title="Estadísticas" />
      <div className="space-y-4 px-4 pb-6">
        <Segmented value={view} onChange={setView} options={[{ id: 'mes', label: 'Mes' }, { id: 'tendencias', label: 'Tendencias' }]} />
        {view === 'mes' ? <MonthView month={month} setMonth={setMonth} /> : <Trends />}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'ok' }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-[15px] text-muted">{label}</div>
      <div className={`text-2xl leading-tight ${tone === 'danger' ? 'text-danger' : tone === 'ok' ? 'text-ok' : ''}`}>{value}</div>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="section-title">{title}</h2>
      {sub && <p className="text-[15px] text-muted">{sub}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

// --- Tendencias ----------------------------------------------------------------------------------------

function Trends() {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const [period, setPeriod] = useState<Period>('12');
  const [by, setBy] = useState<GroupBy>('category');
  const [includeSavings, setIncludeSavings] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const span = dataSpan(data);
  const to = currentMonth() > (span?.to ?? '') ? currentMonth() : span!.to;
  const from = period === 'todo' ? span?.from ?? to : period === 'anio' ? `${to.slice(0, 4)}-01` : addMonths(to, -(Number(period) - 1));
  const f: Filter = { from, to, includeSavings };

  const k = kpis(data, ix, f);
  const points = monthly(data, ix, f);
  const groups = useMemo(() => groupTotals(data, ix, f, by), [data, ix, from, to, includeSavings, by]); // eslint-disable-line react-hooks/exhaustive-deps
  const folded = foldOthers(groups, 8, by);
  const st = useMemo(() => stack(data, ix, f, by), [data, ix, from, to, by]); // eslint-disable-line react-hooks/exhaustive-deps
  const avg = foldOthers(groups, 12, by);
  const top = groupTotals(data, ix, f, 'rubro').slice(0, 10);
  const activeGroup = folded.find((g) => g.key === active);
  const label = by === 'category' ? 'categoría' : 'rubro';

  if (!span) return <p className="py-10 text-center text-muted">Cuando anotes gastos, acá vas a ver cómo cambian en el tiempo.</p>;

  return (
    <>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {([['6', '6 meses'], ['12', '12 meses'], ['anio', 'Este año'], ['todo', 'Todo']] as [Period, string][]).map(([id, l]) => (
          <button key={id} className={period === id ? 'chip-on' : 'chip'} onClick={() => setPeriod(id)}>{l}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-48"><Segmented value={by} onChange={setBy} options={[{ id: 'category', label: 'Categorías' }, { id: 'rubro', label: 'Rubros' }]} /></div>
        <Toggle checked={includeSavings} onChange={setIncludeSavings} label="Incluir ahorro" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Kpi label="Ingresos" value={money(k.income)} />
        <Kpi label="Gastos" value={money(k.expense)} />
        <Kpi label="Balance" value={money(k.balance)} tone={k.balance < 0 ? 'danger' : 'ok'} />
        <Kpi label="Promedio por mes" value={money(k.monthlyAverage)} />
      </div>

      <Card title="Ingresos y ahorro" sub={`${monthLabel(from)} – ${monthLabel(to)}`}>
        <TimeChart
          series={[{ key: 'income', name: 'Ingresos', color: INCOME_COLOR }, { key: 'savings', name: 'Ahorro e inversión', color: SAVINGS_COLOR }]}
          rows={points.map((p) => ({ month: p.month, values: { income: p.income, savings: p.savings } }))}
        />
        <Legend line series={[{ key: 'i', name: 'Ingresos', color: INCOME_COLOR }, { key: 's', name: 'Ahorro e inversión', color: SAVINGS_COLOR }]} />
      </Card>

      <Card title={`Gastos en el tiempo, por ${label}`} sub="Sin contar ahorro. Tocá un mes para ver el detalle.">
        <TimeChart stacked series={st.series} rows={st.rows} height={240} />
        <Legend series={st.series} />
      </Card>

      <Card title={`Distribución por ${label}`}>
        <div className="flex justify-center">
          <Donut
            data={folded.map((g) => ({ key: g.key, value: g.total, color: g.color }))}
            active={active}
            onSelect={setActive}
            center={activeGroup ? (
              <>
                <div className="max-w-[110px] truncate text-[15px] text-muted">{activeGroup.name}</div>
                <div className="text-2xl">{money(activeGroup.total)}</div>
                <div className="text-[15px] text-muted">{formatPct(activeGroup.share)}</div>
              </>
            ) : (
              <>
                <div className="text-2xl">{money(k.expense)}</div>
                <div className="text-[15px] text-muted">{{ '6': 'en 6 meses', '12': 'en 12 meses', anio: 'en el año', todo: 'en total' }[period]}</div>
              </>
            )}
          />
        </div>
        <ul className="mt-3 divide-y divide-line">
          {folded.map((g) => (
            <li key={g.key}>
              <button className={`flex w-full items-center gap-2.5 py-2 text-left ${active && active !== g.key ? 'opacity-50' : ''}`} onClick={() => setActive(active === g.key ? null : g.key)}>
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: g.color }} />
                {by === 'category' && <Icon name={g.icon} size={18} className="text-muted" />}
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="w-12 text-right text-[15px] text-muted tabular">{formatPct(g.share)}</span>
                <span className="w-24 text-right tabular">{money(g.total)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Promedio por mes, por ${label}`} sub={`Total del período ÷ ${k.months || 1} meses con gastos`}>
        <HBars data={avg.map((g) => ({ key: g.key, label: g.name, value: g.average, color: g.color }))} />
      </Card>

      <Card title="Los 10 rubros con más gasto">
        <HBars
          labelWidth={130}
          data={top.map((g) => ({ key: g.key, label: g.name, sub: ix.category.get(g.categoryId)?.name, value: g.total, color: g.color }))}
        />
      </Card>
    </>
  );
}

// --- Mes -----------------------------------------------------------------------------------------------

function MonthView({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const { data, ix } = useStore();
  const { money } = useMoney();
  const [includeSavings, setIncludeSavings] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const s = monthSummary(data, ix, month, includeSavings);
  const cards = percentCards(data, ix, month);

  const detail = useMemo(() => {
    const byCat = new Map<string, Map<string, number>>();
    for (const m of data.movements) {
      if (m.kind !== 'gasto' || monthOf(m.date) !== month) continue;
      const c = ix.categoryOf(m);
      if (!c || (!includeSavings && c.savings)) continue;
      const rubros = byCat.get(c.id) ?? new Map<string, number>();
      rubros.set(m.rubroId, (rubros.get(m.rubroId) ?? 0) + m.amount);
      byCat.set(c.id, rubros);
    }
    return byCat;
  }, [data.movements, ix, month, includeSavings]);

  return (
    <>
      <div className="flex items-center justify-between">
        <button className="flex min-h-tap min-w-tap items-center justify-center" onClick={() => setMonth(addMonths(month, -1))} aria-label="Mes anterior"><ChevronLeft /></button>
        <div className="text-2xl">{monthLabel(month)}</div>
        <button className="flex min-h-tap min-w-tap items-center justify-center disabled:opacity-30" disabled={month >= currentMonth()} onClick={() => setMonth(addMonths(month, 1))} aria-label="Mes siguiente"><ChevronRight /></button>
      </div>
      <Toggle checked={includeSavings} onChange={setIncludeSavings} label="Incluir ahorro" />

      <div className="grid grid-cols-2 gap-3">
        <Kpi label="Ingresos" value={money(s.income)} />
        <Kpi label="Gastos" value={money(s.expense)} />
        <Kpi label="Presupuesto" value={money(s.budget)} />
        <Kpi label={s.diff > 0 ? 'Pasado del presupuesto' : 'Debajo del presupuesto'} value={money(Math.abs(s.diff))} tone={s.diff > 0 ? 'danger' : 'ok'} />
      </div>

      <Card title="Real contra presupuesto" sub="La barra es lo gastado; la rayita, el presupuesto de la categoría.">
        {s.rows.length ? <BudgetRows rows={s.rows} onSelect={(id) => setOpen(open === id ? null : id)} /> : <p className="text-muted">No hay gastos ni presupuesto este mes.</p>}
      </Card>

      {cards.map((c) => (
        <Card key={c.category.id} title={c.category.name} sub={`Presupuesto: ${c.pct}% de lo que entra en el mes`}>
          <dl className="divide-y divide-line text-[17px]">
            {[
              [`Ingresos${c.incomeEstimated ? ' (del mes anterior)' : ''}`, money(c.income)],
              [`${c.pct}% del ingreso`, money(c.expected)],
              ['Dado este mes', money(c.real)],
            ].map(([l, v]) => (
              <div key={l} className="flex justify-between py-1.5"><dt className="text-muted">{l}</dt><dd className="tabular">{v}</dd></div>
            ))}
            <div className="flex justify-between py-1.5">
              <dt className="text-muted">Diferencia</dt>
              <dd className={`tabular ${c.diff < 0 ? 'text-danger' : 'text-ok'}`}>{c.diff < 0 ? `Faltan ${money(-c.diff)}` : `${money(c.diff)} de más`}</dd>
            </div>
          </dl>
        </Card>
      ))}

      <Card title="Detalle del mes" sub="Por categoría y rubro">
        <ul className="divide-y divide-line">
          {s.rows.filter((r) => r.real > 0).map((r) => (
            <li key={r.category.id}>
              <button className="flex w-full items-center gap-2 py-2.5 text-left" onClick={() => setOpen(open === r.category.id ? null : r.category.id)}>
                <Icon name={r.category.icon} size={18} className="text-muted" />
                <span className="flex-1">{r.category.name}</span>
                <span className="tabular">{money(r.real)}</span>
                <ChevronRight size={18} className={`text-muted transition ${open === r.category.id ? 'rotate-90' : ''}`} />
              </button>
              {open === r.category.id && (
                <ul className="pb-2 pl-7">
                  {[...(detail.get(r.category.id) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([rid, v]) => (
                    <li key={rid} className="flex justify-between py-1 text-[16px]">
                      <span className="text-muted">{ix.rubro.get(rid)?.name}</span>
                      <span className="tabular">{money(v)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
