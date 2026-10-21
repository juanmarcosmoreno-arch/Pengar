import { Camera, CreditCard, FileSpreadsheet, FileText, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { RubroPicker } from '../components/RubroPicker';
import { PageHeader, Sheet } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { useToast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { suggestRubro } from '../domain/classify';
import { MONTHS, monthOf } from '../domain/dates';
import { NBSP, parseDecimal, round2 } from '../domain/money';
import { findDuplicates, isSpend, planillaMonths, toLocal, withoutInstallment, type StatementTx } from '../domain/statement';
import {
  applyCredits,
  creditTargets,
  dayMonth,
  groupSpends,
  knownRubro,
  learnedKeyOf,
  NOT_SPEND,
  spendRubros,
  statementNote,
  usd,
  type MerchantGroup,
} from '../domain/statementReview';
import { capital, joinAnd, plural } from '../domain/text';
import { PdfPasswordError } from '../lib/pdf';
import { isNative, isPreview } from '../lib/platform';
import { exampleStatement, readStatement, type StatementDraft } from '../lib/readStatement';
import { suggestRubros, type SuggestReason } from '../lib/suggest';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

const AI_NAME: Partial<Record<SuggestReason, string>> = { apple: 'Apple Intelligence', claude: 'Claude' };

/** Si no hay otra (ni en el estado de cuenta ni la última que se usó) */
const DEFAULT_USD_RATE = 40;

const SHEETS = '.csv,.xlsx,.xls,.ods,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** La cotización que se acepta (la misma de statementInfo): un número fuera de esto es un error de tipeo */
const validUsdRate = (v: number) => v > 10 && v < 200;

/** Estado de cuenta de la tarjeta (PDF, planilla o foto) → revisar por comercio → un gasto por compra */
export function ScanStatement({ onClose }: { onClose: () => void }) {
  const { data } = useStore();
  const [draft, setDraft] = useState<StatementDraft | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  // Un PDF con contraseña espera que la escriban; y si hay cambios en la revisión, salir pide confirmar
  const [locked, setLocked] = useState<{ file: File; wrong: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const dirty = useRef(false);
  const [leaving, setLeaving] = useState<'cerrar' | 'otro' | null>(null);
  const passwordId = useId();
  const pdf = useRef<HTMLInputElement>(null);
  const sheet = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const open = (d: StatementDraft) => {
    if (d.txs.some(isSpend)) setDraft(d);
    else setError('No encontré compras en el archivo. Probá con el PDF que te manda el banco (no una captura de pantalla) o con la planilla que exporta.');
  };

  const onFile = async (file: File | undefined, pass?: string) => {
    if (!file) return;
    setError('');
    if (!pass) setLocked(null);
    setProgress('Leyendo el estado de cuenta…');
    try {
      open(await readStatement(file, data, setProgress, pass));
      setLocked(null);
      setPassword('');
    } catch (e) {
      console.error(e);
      if (e instanceof PdfPasswordError) setLocked({ file, wrong: e.wrong });
      else setError(isPreview
        ? 'No pude leer el archivo. En la vista web se leen los PDF con texto y las planillas (los escaneados, en el iPhone).'
        : 'No pude leer el archivo. Probá con el PDF que te manda el banco o con la planilla que exporta.');
    } finally {
      setProgress('');
    }
  };

  const input = (ref: React.RefObject<HTMLInputElement>, accept: string, capture?: boolean) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      {...(capture ? { capture: 'environment' as const } : {})}
      className="hidden"
      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }}
    />
  );

  const option = (icon: ReactNode, title: string, sub: string, run: () => void) => (
    <button className="card flex w-full items-center gap-4 p-5 text-left" onClick={run}>
      {icon}
      <div><div className="text-xl">{title}</div><div className="text-muted">{sub}</div></div>
    </button>
  );

  const doLeave = (to: 'cerrar' | 'otro') => {
    dirty.current = false;
    if (to === 'cerrar') onClose();
    else setDraft(null);
  };
  const leave = (to: 'cerrar' | 'otro') => (draft && dirty.current ? setLeaving(to) : doLeave(to));

  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-bg">
      <PageHeader title={draft ? 'Revisar compras' : 'Estado de cuenta'} onBack={() => leave('cerrar')} />
      {input(pdf, 'application/pdf,.pdf')}
      {input(sheet, SHEETS)}
      {isNative && input(camera, 'image/*', true)}
      {progress ? (
        <div className="flex flex-col items-center gap-4 px-8 py-24 text-center">
          <Suricata pose="calculadora" size={170} motion="sway" />
          <p className="text-xl">{progress}</p>
          <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-soft border-t-primary" />
        </div>
      ) : draft ? (
        <Review key={draft.fileName + draft.txs.length} draft={draft} onDone={onClose} onRetry={() => leave('otro')} onDirty={(d) => { dirty.current = d; }} />
      ) : (
        <div className="space-y-3 px-4 pb-10">
          <div className="flex justify-center"><Suricata pose="lista" size={150} /></div>
          {locked && (
            <form className="card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); void onFile(locked.file, password); }}>
              <p className="text-xl">Este PDF tiene contraseña</p>
              <p className="text-muted">
                {locked.wrong ? 'La contraseña no es correcta: probá de nuevo.' : 'Muchos bancos le ponen tu cédula. Escribila para abrirlo; no se guarda.'}
              </p>
              <div>
                <label className="label" htmlFor={passwordId}>Contraseña del PDF</label>
                <input id={passwordId} className="field" type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-ghost" onClick={() => { setLocked(null); setPassword(''); }}>Cancelar</button>
                <button className="btn-primary flex-1" disabled={!password}>Abrir</button>
              </div>
            </form>
          )}
          <p className="px-1 text-lg text-muted">
            Subí el estado de cuenta de tu tarjeta. Pengar junta las compras por comercio: la primera vez le decís de qué rubro es cada uno y después se acuerda.
          </p>
          {option(<FileText size={30} className="shrink-0 text-primary" />, 'Subir el PDF del banco', 'El que te llega por mail o bajás de la web (OCA, BROU, Itaú, Santander…)', () => pdf.current?.click())}
          {option(<FileSpreadsheet size={30} className="shrink-0 text-primary" />, 'Subir CSV o Excel', 'Si tu banco te deja exportar los movimientos', () => sheet.current?.click())}
          {isNative && option(<Camera size={30} className="shrink-0 text-primary" />, 'Sacar una foto', 'Del resumen en papel, bien derecho y con luz', () => camera.current?.click())}
          {data.settings.example && (
            <button className="btn-outline w-full" onClick={() => { setError(''); open(exampleStatement(data)); }}>
              Probar con un estado de cuenta de ejemplo
            </button>
          )}
          {error && <p className="px-1 text-danger">{error}</p>}
        </div>
      )}
      {leaving && (
        <ConfirmSheet
          title="¿Salir sin guardar?"
          message="Se pierden los rubros que elegiste en esta revisión."
          confirmLabel="Salir"
          danger
          onConfirm={() => doLeave(leaving)}
          onClose={() => setLeaving(null)}
        />
      )}
    </div>
  );
}

type Section = 'nuevo' | 'conocido' | 'excluido';

interface Choice {
  rubroId?: string;
  reason?: SuggestReason;
}

const KIND_LABEL: Partial<Record<StatementTx['kind'], string>> = { pago: 'Pago de la tarjeta', saldo: 'Saldo', credito: 'Devolución o reintegro' };

function Review({ draft, onDone, onRetry, onDirty }: { draft: StatementDraft; onDone: () => void; onRetry: () => void; onDirty: (dirty: boolean) => void }) {
  const { data, ix, saveStatement } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const { txs } = draft;
  const firstRate = draft.usdRate ?? DEFAULT_USD_RATE;
  const hasUsd = txs.some((t) => t.currency === 'usd' && (isSpend(t) || t.kind === 'credito'));
  const [rateText, setRateText] = useState(String(firstRate).replace('.', ','));
  // Con decimales siempre: «39,875» es la cotización, no 39.875 pesos (parseAmount lo leería como miles)
  const parsedRate = parseDecimal(rateText);
  const rate = parsedRate != null && validUsdRate(parsedRate) ? parsedRate : 0;
  const validRate = !hasUsd || rate > 0;
  // Algo que eligió la persona (no las sugerencias): salir sin guardar lo pierde
  const [touched, setTouched] = useState(false);
  useEffect(() => onDirty(touched), [touched]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lo que no cambia mientras se revisa: repetidos, meses de la planilla y en qué sección va cada comercio
  const [fixed] = useState(() => {
    const dups = findDuplicates(txs, data.movements, firstRate);
    const groups = groupSpends(txs, (i) => dups.has(i));
    const rubros = spendRubros(data.rubros, data.categories);
    const section: Record<string, Section> = {};
    const choice: Record<string, Choice> = {};
    for (const g of groups) {
      const known = knownRubro(txs[g.idx[0]], rubros, data.settings.learned);
      section[g.key] = known === NOT_SPEND ? 'excluido' : known ? 'conocido' : 'nuevo';
      if (known && known !== NOT_SPEND) choice[g.key] = known;
    }
    return { dups, groups, section, choice, months: planillaMonths(txs, data.movements) };
  });
  const [section, setSection] = useState(fixed.section);
  const [choice, setChoice] = useState(fixed.choice);
  const [excluded, setExcluded] = useState(() => new Set(fixed.groups.filter((g) => fixed.section[g.key] === 'excluido').map((g) => g.key)));
  const [skipPlanilla, setSkipPlanilla] = useState(true);
  const [importDup, setImportDup] = useState<Set<number>>(() => new Set());
  const [subtract, setSubtract] = useState<Set<number>>(() => new Set());
  const [showKnown, setShowKnown] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [picking, setPicking] = useState<MerchantGroup | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Los comercios nuevos se le preguntan a Apple Intelligence (o a Claude) sin frenar la revisión
  useEffect(() => {
    const ask = fixed.groups.filter((g) => fixed.section[g.key] === 'nuevo');
    if (!ask.length) return;
    let alive = true;
    const spend = new Set(spendRubros(data.rubros, data.categories).map((r) => r.id));
    setSuggesting(true);
    void suggestRubros(ask.map((g) => ({ id: g.key, text: g.merchant })), data)
      .then((found) => {
        if (!alive) return;
        // Lo que ya eligió el usuario no se toca
        setChoice((c) => {
          const next = { ...c };
          for (const [key, s] of found) if (!next[key]?.rubroId && spend.has(s.rubroId)) next[key] = s;
          return next;
        });
      })
      .finally(() => alive && setSuggesting(false));
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const local = (i: number) => toLocal(txs[i], rate);
  const skipMonth = (i: number) => skipPlanilla && fixed.months.includes(monthOf(txs[i].date));
  const rubroOf = (key: string) => (excluded.has(key) ? undefined : choice[key]?.rubroId);
  const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1];
  const monthsText = joinAnd(fixed.months.map(monthName));

  // Lo que se guarda: un gasto por compra (las de los meses de la planilla, si se saltean, no)
  const rows: { i: number; rubroId: string; merchant: string }[] = [];
  for (const g of fixed.groups) {
    const rubroId = rubroOf(g.key);
    if (rubroId) for (const i of g.idx) if (!skipMonth(i)) rows.push({ i, rubroId, merchant: g.merchant });
  }
  const dupList = [...fixed.dups].filter(([i]) => !skipMonth(i)).sort((a, b) => a[0] - b[0]);
  for (const [i, id] of dupList) {
    if (!importDup.has(i)) continue;
    const rubroId = rubroOf(txs[i].key) ?? data.movements.find((m) => m.id === id)?.rubroId;
    if (rubroId) rows.push({ i, rubroId, merchant: txs[i].merchant });
  }
  rows.sort((a, b) => a.i - b.i);
  const targets = rows.map((r) => txs[r.i]);
  const amounts = applyCredits(rows.map((r) => local(r.i)), targets, [...subtract].map((i) => ({ ...txs[i], amount: local(i) })));
  const movements = rows
    .map((r, k) => ({ date: txs[r.i].date, amount: amounts[k], rubroId: r.rubroId, merchant: r.merchant, note: statementNote(txs[r.i], draft.card, rate) }))
    .filter((m) => m.amount > 0);
  const total = round2(movements.reduce((s, m) => s + m.amount, 0));

  const pending = (g: MerchantGroup) => !excluded.has(g.key) && !choice[g.key]?.rubroId && g.idx.some((i) => !skipMonth(i));
  const missing = fixed.groups.filter(pending).length;

  const spends = txs.map((t, i) => [t, i] as const).filter(([t]) => isSpend(t));
  const spendTotal = round2(spends.reduce((s, [, i]) => s + local(i), 0));
  const usdSpends = spends.filter(([t]) => t.currency === 'usd');
  const usdTotal = round2(usdSpends.reduce((s, [t]) => s + t.amount, 0));
  const period = draft.period && `del ${dayMonth(draft.period.from)} al ${dayMonth(draft.period.to)}`;

  const nuevos = fixed.groups.filter((g) => section[g.key] === 'nuevo');
  const conocidos = fixed.groups.filter((g) => section[g.key] === 'conocido');
  const noGasto = fixed.groups.filter((g) => section[g.key] === 'excluido');
  const others = txs.map((t, i) => [t, i] as const).filter(([t]) => !isSpend(t) && KIND_LABEL[t.kind]);
  const groupTotal = (g: MerchantGroup) => round2(g.idx.reduce((s, i) => s + local(i), 0));

  const exclude = (key: string) => {
    setTouched(true);
    setExcluded((s) => new Set(s).add(key));
  };
  const include = (g: MerchantGroup) => {
    setTouched(true);
    setExcluded((s) => {
      const next = new Set(s);
      next.delete(g.key);
      return next;
    });
    // Venía como «no es un gasto»: pasa a los nuevos, con el rubro de las palabras clave si hay
    if (section[g.key] === 'excluido') {
      setSection((s) => ({ ...s, [g.key]: 'nuevo' }));
      const s = suggestRubro(withoutInstallment(g.description), g.merchant, spendRubros(data.rubros, data.categories), {});
      if (s && !choice[g.key]?.rubroId) setChoice((c) => ({ ...c, [g.key]: s }));
    }
  };
  const toggleIn = (set: (fn: (s: Set<number>) => Set<number>) => void, i: number, on: boolean) => {
    setTouched(true);
    set((s) => {
      const next = new Set(s);
      if (on) next.add(i);
      else next.delete(i);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      // Cada comercio queda aprendido: su rubro o «no es un gasto»
      const learned: Record<string, string> = {};
      for (const g of fixed.groups) {
        const key = learnedKeyOf(txs[g.idx[0]]);
        if (excluded.has(g.key)) learned[key] = NOT_SPEND;
        else if (choice[g.key]?.rubroId) learned[key] = choice[g.key].rubroId!;
      }
      const { count, undo, fileKept } = await saveStatement({
        file: draft.file,
        fileName: draft.fileName,
        mime: draft.mime,
        card: draft.card,
        date: draft.period?.to ?? txs.map((t) => t.date).sort().at(-1),
        movements,
        learned,
        usdRate: hasUsd ? rate : undefined,
      });
      const saved = count ? plural(count, 'gasto guardado', 'gastos guardados') : 'Estado de cuenta guardado';
      toast(fileKept ? saved : `${saved}; el archivo no se pudo guardar en este navegador`, { label: 'Deshacer', run: undo });
      onDone();
    } catch (e) {
      // El archivo no se pudo guardar (poco lugar en el teléfono): no se guarda nada y se puede probar de nuevo
      console.error(e);
      toast('No se pudo guardar en el teléfono. Probá de nuevo.');
    } finally {
      setSaving(false);
    }
  };

  const groupRow = (g: MerchantGroup) => {
    const off = excluded.has(g.key);
    const c = choice[g.key];
    const rubroId = off ? undefined : c?.rubroId;
    const list = g.idx.map((i) => txs[i]);
    // Los meses de la planilla de este comercio (no todos los de la planilla)
    const skippedIdx = g.idx.filter(skipMonth);
    const skipped = skippedIdx.length;
    const skipMonths = [...new Set(skippedIdx.map((i) => monthOf(txs[i].date)))].sort();
    const skipText = joinAnd(skipMonths.map(monthName));
    const n = skipped > 1 ? 'n' : '';
    const usdSum = round2(list.filter((t) => t.currency === 'usd').reduce((s, t) => s + t.amount, 0));
    const cuotas = [...new Set(list.map((t) => t.installment).filter(Boolean))];
    const detail = [
      list.every((t) => t.kind === 'cargo') ? plural(list.length, 'cargo', 'cargos') : plural(list.length, 'compra', 'compras'),
      usdSum > 0 && usd(usdSum),
      cuotas.length > 0 && `cuota ${cuotas.join(', ')}`,
      skipped > 0 && (skipped === list.length
        ? `no se guarda${n} (${skipText} ya ${skipMonths.length > 1 ? 'están' : 'está'} en la planilla)`
        : `${plural(skipped, 'compra', 'compras')} de ${skipText} no se guarda${n}`),
    ].filter(Boolean).join(' · ');
    const ai = c?.reason ? AI_NAME[c.reason] : undefined;
    return (
      <div key={g.key} role="group" aria-label={g.merchant} className="py-3">
        <div className={`flex items-baseline gap-3 ${off ? 'text-muted' : ''}`}>
          <div className="min-w-0 flex-1 truncate text-lg leading-tight">{g.merchant}</div>
          <div className="shrink-0 text-lg tabular">{money(groupTotal(g))}</div>
        </div>
        <div className="text-[15px] text-muted">{detail}</div>
        {off ? (
          <div className="flex items-center gap-2 text-[15px] text-muted">
            No es un gasto: no se guarda
            <button className="ml-auto min-h-tap shrink-0 px-2 text-primary" onClick={() => include(g)}>Es un gasto</button>
          </div>
        ) : (
          <div className="mt-2 flex items-start gap-2">
            <div className="min-w-0">
              <button className={rubroId || !pending(g) ? 'chip' : 'chip border-danger text-danger'} onClick={() => setPicking(g)}>
                {rubroId ? ix.rubro.get(rubroId)?.name : 'Elegir rubro'}
              </button>
              {rubroId && ai && (
                <div className="mt-1 flex items-center gap-1 pl-1 text-[13px] text-muted">
                  <Sparkles size={13} className="shrink-0" /> sugerido por {ai}
                </div>
              )}
            </div>
            <button className="ml-auto min-h-tap shrink-0 px-2 text-[15px] text-muted" onClick={() => exclude(g.key)}>No es un gasto</button>
          </div>
        )}
      </div>
    );
  };

  const knownRubros = [...new Set(conocidos.map((g) => rubroOf(g.key)).filter(Boolean))].map((id) => ix.rubro.get(id!)?.name).filter(Boolean) as string[];
  const otherSummary = [
    others.some(([t]) => t.kind === 'pago') && plural(others.filter(([t]) => t.kind === 'pago').length, 'pago', 'pagos'),
    others.some(([t]) => t.kind === 'saldo') && plural(others.filter(([t]) => t.kind === 'saldo').length, 'saldo', 'saldos'),
    others.some(([t]) => t.kind === 'credito') && plural(others.filter(([t]) => t.kind === 'credito').length, 'devolución o reintegro', 'devoluciones o reintegros'),
    noGasto.length > 0 && plural(noGasto.length, 'comercio que no es un gasto', 'comercios que no son gastos'),
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-5 px-4 pb-[calc(env(safe-area-inset-bottom)+140px)]">
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-soft/25 text-primary"><CreditCard size={24} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl">{draft.card ?? 'Tarjeta'}</div>
            <div className="truncate text-[15px] text-muted">{draft.source === 'ejemplo' ? 'De ejemplo (inventado)' : draft.fileName}</div>
          </div>
          <button className="min-h-tap min-w-tap shrink-0 px-2 text-primary" onClick={onRetry} aria-label="Elegir otro estado de cuenta">Elegir otro</button>
        </div>
        <p className="mt-3 text-lg leading-snug">
          {plural(spends.length, 'movimiento', 'movimientos')} de {plural(new Set(spends.map(([t]) => t.key)).size, 'comercio', 'comercios')} · {money(spendTotal)}
          {period && <> · <span className="whitespace-nowrap">{period}</span></>}
        </p>
      </div>

      {hasUsd && (
        <div className="card flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="usd-rate" className="text-lg">Cotización del dólar</label>
            <div className="text-[15px] text-muted">
              {usdSpends.length ? `${plural(usdSpends.length, 'compra', 'compras')}: ${usd(usdTotal)}${rate > 0 ? ` = ${money(usdTotal * rate)}` : ''}` : 'Para los créditos en dólares'}
            </div>
          </div>
          <input id="usd-rate" className="field w-[84px] shrink-0 px-3 text-right tabular" inputMode="decimal" value={rateText} onChange={(e) => { setTouched(true); setRateText(e.target.value); }} />
        </div>
      )}

      {fixed.months.length > 0 && (
        <div className="card space-y-3 border-danger/40 p-4">
          <p className="flex gap-2 text-lg leading-snug">
            <TriangleAlert size={20} className="mt-0.5 shrink-0 text-danger" />
            <span>
              {capital(monthsText)} ya {fixed.months.length === 1 ? 'tiene' : 'tienen'} los totales de tu planilla: si guardás estos gastos se van a contar dos veces.
            </span>
          </p>
          <Toggle checked={skipPlanilla} onChange={(v) => { setTouched(true); setSkipPlanilla(v); }} label={`No guardar las compras de ${monthsText}`} />
        </div>
      )}

      {nuevos.length > 0 ? (
        <section>
          <h2 className="section-title px-1">Nuevos: decime de qué rubro son</h2>
          <p className="px-1 text-[15px] text-muted">Lo que elijas queda aprendido para los próximos meses.</p>
          {suggesting && (
            <p className="mt-1 flex items-center gap-2 px-1 text-[15px] text-muted">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-soft border-t-primary" /> Buscando sugerencias…
            </p>
          )}
          <div className="card mt-2 divide-y divide-line px-4">{nuevos.map(groupRow)}</div>
        </section>
      ) : (
        <div className="card flex items-center gap-3 p-4">
          <Suricata pose="cara-feliz" size={56} className="shrink-0" />
          <p className="text-lg leading-snug">No hay comercios nuevos: ya los conozco a todos.</p>
        </div>
      )}

      {conocidos.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between px-1">
            <h2 className="section-title">Ya los conozco</h2>
            <button className="min-h-tap px-2 text-primary" aria-expanded={showKnown} onClick={() => setShowKnown((v) => !v)}>
              {showKnown ? 'Ocultar' : 'Ver y cambiar'}
            </button>
          </div>
          <p className="px-1 text-[15px] text-muted">
            {plural(conocidos.length, 'comercio', 'comercios')} · {money(round2(conocidos.reduce((s, g) => s + groupTotal(g), 0)))}
            {knownRubros.length > 0 && ` · ${joinAnd(knownRubros.length > 4 ? [...knownRubros.slice(0, 3), `${knownRubros.length - 3} más`] : knownRubros)}`}
          </p>
          {showKnown && <div className="card mt-2 divide-y divide-line px-4">{conocidos.map(groupRow)}</div>}
        </section>
      )}

      {dupList.length > 0 && (
        <section>
          <h2 className="section-title px-1">Posibles repetidos</h2>
          <p className="px-1 text-[15px] text-muted">Parecen estar anotados: no se guardan otra vez, salvo que lo pidas.</p>
          <div className="card mt-2 divide-y divide-line px-4">
            {dupList.map(([i, id]) => {
              const t = txs[i];
              const m = data.movements.find((x) => x.id === id);
              return (
                <div key={i} role="group" aria-label={t.merchant} className="space-y-1 py-3">
                  <div className="flex items-baseline gap-3">
                    <div className="min-w-0 flex-1 truncate text-lg leading-tight">{t.merchant}</div>
                    <div className="shrink-0 text-lg tabular">{money(local(i))}</div>
                  </div>
                  {m && (
                    <div className="text-[15px] text-muted">
                      {dayMonth(t.date)} · Ya anotaste {money(m.amount)} en {ix.rubro.get(m.rubroId)?.name ?? 'otro rubro'} el {dayMonth(m.date)}
                    </div>
                  )}
                  <Toggle checked={importDup.has(i)} onChange={(on) => toggleIn(setImportDup, i, on)} label="Guardarla igual" />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(others.length > 0 || noGasto.length > 0) && (
        <section>
          <div className="flex items-baseline justify-between px-1">
            <h2 className="section-title">No son gastos</h2>
            <button className="min-h-tap min-w-tap px-2 text-primary" aria-expanded={showOther} onClick={() => setShowOther((v) => !v)}>
              {showOther ? 'Ocultar' : 'Ver'}
            </button>
          </div>
          <p className="px-1 text-[15px] text-muted">{capital(joinAnd(otherSummary))}: no se guardan.</p>
          {showOther && (
            <div className="card mt-2 divide-y divide-line px-4">
              {noGasto.map(groupRow)}
              {others.map(([t, i]) => {
                const first = targets[creditTargets(targets, t)[0]];
                return (
                  <div key={i} role="group" aria-label={t.merchant} className="space-y-1 py-3">
                    <div className="flex items-baseline gap-3">
                      <div className="min-w-0 flex-1 truncate text-lg leading-tight">{t.merchant}</div>
                      <div className="shrink-0 text-lg tabular">{t.currency === 'usd' ? `${t.amount < 0 ? `-${NBSP}` : ''}${usd(Math.abs(t.amount))}` : money(t.amount)}</div>
                    </div>
                    <div className="text-[15px] text-muted">{dayMonth(t.date)} · {KIND_LABEL[t.kind]}</div>
                    {t.kind === 'credito' && (
                      <>
                        <Toggle checked={subtract.has(i)} onChange={(on) => toggleIn(setSubtract, i, on)} label="Restarlo de los gastos" />
                        {subtract.has(i) && (
                          <div className="text-[15px] text-muted">{first ? `Se resta de ${first.merchant} (${dayMonth(first.date)})` : 'No hay compras para restarle'}</div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/95 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
        {(missing > 0 || !validRate) && (
          <p className="pb-2 text-center text-[16px] text-danger">
            {missing > 0 ? `Faltan ${plural(missing, 'comercio', 'comercios')}` : rateText.trim() ? 'Revisá la cotización del dólar (por ejemplo, 40,10)' : 'Falta la cotización del dólar'}
          </p>
        )}
        <button className="btn-primary w-full" disabled={missing > 0 || !validRate || saving} onClick={save}>
          {saving ? 'Guardando…' : movements.length ? `Guardar ${plural(movements.length, 'gasto', 'gastos')} (${money(total)})` : 'Guardar el estado de cuenta'}
        </button>
      </div>

      {picking && (
        <Sheet title={picking.merchant} onClose={() => setPicking(null)}>
          <p className="mb-3 text-muted">¿De qué rubro es? Me acuerdo para la próxima.</p>
          <RubroPicker
            kind="gasto"
            value={choice[picking.key]?.rubroId}
            onChange={(id) => {
              setTouched(true);
              setChoice((c) => ({ ...c, [picking.key]: { rubroId: id } }));
              setPicking(null);
            }}
          />
        </Sheet>
      )}
    </div>
  );
}
