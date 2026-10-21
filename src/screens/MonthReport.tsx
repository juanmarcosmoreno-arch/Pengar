import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, Equal } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { CategoryBubble } from '../components/Icon';
import { LedgerSheet, LedgerSummary } from '../components/LedgerSheet';
import { PageHeader } from '../components/Sheet';
import { EmptyState, Suricata, type Pose } from '../components/Suricata';
import { Toggle } from '../components/Toggle';
import { useToast } from '../components/Toast';
import { currentMonth, monthName, shortDate } from '../domain/dates';
import { formatPct } from '../domain/money';
import { monthReport, type BudgetLine, type MonthReport as Report, type ReportMood } from '../domain/report';
import { OTHER_COLOR } from '../domain/template';
import { joinAnd, plural } from '../domain/text';
import { canRemind, disableReminder, enableReminder, reminderDenied } from '../lib/reportReminder';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

const POSE: Record<ReportMood, Pose> = { celebrando: 'celebrando', contento: 'contento', pensando: 'pensando', preocupado: 'cara-preocupado' };

function headline(r: Report): string {
  const over = r.budget?.over.filter((l) => !l.percent) ?? [];
  if (r.mood === 'celebrando') return r.budget ? '¡Muy buen mes! Te sobró plata y no te pasaste del presupuesto.' : '¡Muy buen mes! Entró más de lo que gastaste.';
  if (r.mood === 'contento') return `Buen mes: te sobró plata, aunque te pasaste en ${over.length === 1 ? over[0].category.name : plural(over.length, 'categoría', 'categorías')}.`;
  if (r.mood === 'pensando') return 'Mes justo: gastaste casi lo mismo que entró.';
  return 'Este mes gastaste más de lo que entró.';
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
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Una frase con su ícono: el estado va con ícono y palabras, nunca solo con color */
function Line({ tone, children, sub }: { tone: 'danger' | 'ok' | 'muted'; children: React.ReactNode; sub?: React.ReactNode }) {
  const Icon = tone === 'danger' ? CircleAlert : tone === 'ok' ? CircleCheck : Equal;
  return (
    <li className="flex gap-2 py-1.5">
      <Icon size={18} className={`mt-0.5 shrink-0 ${tone === 'danger' ? 'text-danger' : tone === 'ok' ? 'text-ok' : 'text-muted'}`} />
      <div className="min-w-0">
        <div className="text-[17px] leading-snug">{children}</div>
        {sub && <div className="text-[15px] text-muted">{sub}</div>}
      </div>
    </li>
  );
}

/** «Gastaste 8% menos que en agosto» (con flecha); igual si cambió menos de medio punto */
function Change({ change, than, sub }: { change: number; than: string; sub: string }) {
  const same = Math.abs(change) < 0.005;
  const up = change > 0;
  const Arrow = same ? Equal : up ? ArrowUp : ArrowDown;
  return (
    <li className="flex gap-2 py-1.5">
      <Arrow size={18} className={`mt-0.5 shrink-0 ${same ? 'text-muted' : up ? 'text-danger' : 'text-ok'}`} />
      <div className="min-w-0">
        <div className="text-[17px] leading-snug">{same ? `Gastaste lo mismo que ${than}` : `Gastaste ${formatPct(Math.abs(change))} ${up ? 'más' : 'menos'} que ${than}`}</div>
        <div className="text-[15px] text-muted">{sub}</div>
      </div>
    </li>
  );
}

/** Resumen al cerrar el mes: pantalla entera, como escanear una factura */
export function MonthReport({ month, onClose, onStats }: { month: string; onClose: () => void; onStats: (month: string) => void }) {
  const { data, ix, demo, updateSettings } = useStore();
  const { money } = useMoney();
  const r = useMemo(() => monthReport(data, ix, month), [data, ix, month]);
  const [history, setHistory] = useState<string | null>(null);
  const name = monthName(month);
  // Pantalla entera encima de la app: para el lector de pantalla es un diálogo, con este título
  const titleId = useId();

  // Abrirlo lo da por visto: Inicio deja de ofrecerlo (abrir uno más viejo no cambia nada)
  const seen = data.settings.lastReportSeen ?? '';
  useEffect(() => {
    if (month > seen && month < currentMonth()) updateSettings({ lastReportSeen: month });
  }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const rubroName = (id: string) => ix.rubro.get(id)?.name ?? 'Sin rubro';
  const fixed = r.recurring;
  const fixedTotal = fixed.recorded.length + fixed.skipped.length + fixed.missing.length;
  const underLines = r.budget?.under.filter((l) => !l.percent).slice(0, 3) ?? [];
  const overText = (l: BudgetLine) => (l.percent
    ? <>En <b>{l.category.name}</b> diste {money(l.diff)} más de lo presupuestado</>
    : <>Te pasaste en <b>{l.category.name}</b> por {money(l.diff)}</>);

  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-bg" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <PageHeader titleId={titleId} title={`Resumen de ${name}`} onBack={onClose} />
      <div className="space-y-4 px-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {!r.movements ? (
          <EmptyState pose="analizando" title={`No hay nada anotado en ${name}`}>Cuando anotes gastos e ingresos, acá vas a ver cómo te fue.</EmptyState>
        ) : (
          <>
            <section className="card flex flex-col items-center px-5 pb-5 pt-3 text-center">
              <Suricata pose={POSE[r.mood]} size={r.mood === 'preocupado' ? 120 : 160} motion={r.mood === 'celebrando' ? 'hop' : undefined} />
              <p className="mt-2 text-2xl leading-tight">{headline(r)}</p>
              <div className="mt-4 text-lg text-muted">{r.balance >= 0 ? 'Te quedaron' : 'Gastaste de más'}</div>
              <div className={`text-[44px] leading-none ${r.balance < 0 ? 'text-danger' : 'text-ok'}`}>{money(Math.abs(r.balance))}</div>
              <p className="mt-2 text-[15px] text-muted">Lo que entró menos lo que gastaste (el ahorro no cuenta como gasto)</p>
              {r.onlySheet && <p className="mt-2 text-[15px] text-muted">Este mes viene de tu planilla: son los totales de cada rubro.</p>}
            </section>

            <div className="grid grid-cols-2 gap-3">
              <Kpi label="Entró" value={money(r.income)} />
              <Kpi label="Gastaste" value={money(r.expense)} />
              <Kpi label="Ahorraste" value={money(r.savings)} />
              <Kpi label={r.onlySheet ? 'Totales de la planilla' : 'Movimientos'} value={String(r.movements)} />
            </div>

            {(r.prev || r.average) && (
              <Card title="Contra otros meses" sub="Gastos sin contar el ahorro">
                <ul>
                  {r.prev && <Change change={r.prev.change} than={`en ${monthName(r.prev.month)}`} sub={`${money(r.prev.expense)} en ${monthName(r.prev.month)}`} />}
                  {r.average && (
                    <Change
                      change={r.average.change}
                      than={`tu promedio de ${r.average.months === 6 ? 'los últimos 6 meses' : plural(r.average.months, 'mes', 'meses anteriores')}`}
                      sub={`${money(r.average.expense)} por mes`}
                    />
                  )}
                </ul>
              </Card>
            )}

            <Card title="Presupuesto" sub="Sin contar el ahorro">
              {!r.budget ? (
                <p className="text-muted">No tenés presupuesto. Lo ponés en Más → Presupuesto.</p>
              ) : (
                <>
                  <p className="text-[17px]">
                    Gastaste {money(r.budget.spent)} de {money(r.budget.total)}
                    {r.budget.extra > 0.5 && ` (sin lo que diste de más en ${joinAnd(r.budget.over.filter((l) => l.percent).map((l) => l.category.name))})`}.{' '}
                    {r.budget.diff > 0.5
                      ? <span className="text-danger">Te pasaste {money(r.budget.diff)}.</span>
                      : <span className="text-ok">Te sobraron {money(-r.budget.diff)}.</span>}
                  </p>
                  <ul className="mt-1">
                    {r.budget.over.map((l) => <Line key={l.category.id} tone={l.percent ? 'muted' : 'danger'}>{overText(l)}</Line>)}
                    {underLines.map((l) => (
                      <Line key={l.category.id} tone="ok">
                        {l.real > 0 ? <>En <b>{l.category.name}</b> te sobraron {money(-l.diff)}</> : <>En <b>{l.category.name}</b> no gastaste nada</>}
                      </Line>
                    ))}
                  </ul>
                </>
              )}
            </Card>

            {r.top.length > 0 && (
              <Card title="Lo que más pesó">
                <ul className="divide-y divide-line">
                  {r.top.map((g) => (
                    <li key={g.key} className="flex items-center gap-3 py-2">
                      <CategoryBubble icon={g.icon} color={g.color} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-lg leading-tight">{g.name}</div>
                        <div className="text-[15px] text-muted">{formatPct(g.share)} de lo que gastaste</div>
                      </div>
                      <div className="shrink-0 text-lg tabular">{money(g.total)}</div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {r.biggest.length > 0 && (
              <Card
                title={r.biggestFromSheet ? 'Los rubros más grandes' : 'Los gastos más grandes'}
                sub={r.biggestFromSheet ? 'Totales del mes de la planilla' : r.hasSheet ? 'Sin contar los totales de la planilla' : undefined}
              >
                <ul className="divide-y divide-line">
                  {r.biggest.map((m) => {
                    const cat = ix.categoryOf(m);
                    const detail = m.monthly ? cat?.name : [m.merchant, m.note].filter(Boolean).join(' · ') || cat?.name;
                    return (
                      <li key={m.id} className="flex items-center gap-3 py-2">
                        <CategoryBubble icon={cat?.icon ?? 'tag'} color={cat?.color ?? OTHER_COLOR} size={36} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-lg leading-tight">{rubroName(m.rubroId)}</div>
                          <div className="truncate text-[15px] text-muted">{m.monthly ? detail : `${shortDate(m.date)}${detail ? ` · ${detail}` : ''}`}</div>
                        </div>
                        <div className="shrink-0 text-lg tabular">{money(m.amount)}</div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {r.percent.map((p) => (
              <Card key={p.category.id} title={p.category.name} sub={`El ${p.pct}% de lo que entró en ${name}`}>
                <p className="text-[17px]">
                  Diste {money(p.given)} de {money(p.expected)}.{' '}
                  {p.diff < -0.5 ? <span className="text-danger">Faltaron {money(-p.diff)}.</span>
                    : p.diff > 0.5 ? <span className="text-ok">Diste {money(p.diff)} de más.</span>
                      : <span className="text-ok">Justo lo que tocaba.</span>}
                </p>
                {p.pending != null && <LedgerSummary pending={p.pending} from={p.from} onHistory={() => setHistory(p.category.id)} />}
              </Card>
            ))}

            {fixedTotal > 0 && (
              <Card title="Gastos fijos">
                <p className="text-[17px]">Anotaste {fixed.recorded.length} de {fixedTotal}.</p>
                <ul className="mt-1">
                  {fixed.skipped.length > 0 && <Line tone="muted">Salteaste {joinAnd(fixed.skipped.map((x) => rubroName(x.rubroId)))}</Line>}
                  {fixed.missing.length > 0 && <Line tone="danger">Quedaron sin anotar: {joinAnd(fixed.missing.map((x) => rubroName(x.rubroId)))}</Line>}
                  {!fixed.skipped.length && !fixed.missing.length && <Line tone="ok">Todos anotados</Line>}
                </ul>
              </Card>
            )}
          </>
        )}

        {/* Es un ajuste de este teléfono: en el modo demo no se toca */}
        {canRemind && !demo && <ReminderToggle />}

        <div className="space-y-3 pt-1">
          {r.movements > 0 && <button className="btn-outline w-full" onClick={() => onStats(month)}>Ver en Estadísticas</button>}
          <button className="btn-primary w-full" onClick={onClose}>Cerrar</button>
        </div>
      </div>
      {history && <LedgerSheet categoryId={history} month={month} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** «Avisarme el 1 de cada mes»: solo en el iPhone (una notificación local; la primera vez iOS pide permiso) */
function ReminderToggle() {
  // Es de este teléfono (lo programa acá): va en los ajustes del teléfono, no en los datos
  const { device, updateDevice } = useStore();
  const toast = useToast();
  const on = device.reportReminder;
  const [busy, setBusy] = useState(false);
  // Prendido pero con las notificaciones bloqueadas en el iPhone: se avisa
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (on) void reminderDenied().then(setBlocked);
    else setBlocked(false);
  }, [on]);
  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (!next) {
        await disableReminder();
        updateDevice({ reportReminder: false });
      } else if (await enableReminder()) {
        updateDevice({ reportReminder: true });
        toast('Listo: el 1 de cada mes te aviso');
      } else {
        toast('Para el aviso, permití las notificaciones de Pengar en Ajustes del iPhone');
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card px-4 py-2">
      <Toggle checked={on} onChange={(v) => void change(v)} label="Avisarme el 1 de cada mes" />
      <p className="pb-2 text-[15px] text-muted">
        {blocked ? 'Las notificaciones de Pengar están apagadas en Ajustes del iPhone: prendelas para recibir el aviso.' : 'Una notificación a las 9 de la mañana para mirar el resumen del mes que cerró.'}
      </p>
    </section>
  );
}
