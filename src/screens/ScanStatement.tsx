import { Camera, CreditCard, FileSpreadsheet, FileText, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { RubroPicker } from '../components/RubroPicker';
import { PageHeader, Sheet } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { useToast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { suggestRubro } from '../domain/classify';
import { addDays, MONTHS, monthOf } from '../domain/dates';
import { formatRate, validUsdRate, type UsdRate } from '../domain/fx';
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
  txRates,
  usd,
  usdDates,
  type MerchantGroup,
} from '../domain/statementReview';
import { capital, joinAnd, plural } from '../domain/text';
import { usdRates } from '../lib/fx';
import { PdfPasswordError } from '../lib/pdf';
import { isNative, isPreview } from '../lib/platform';
import { exampleStatement, readStatement, type StatementDraft } from '../lib/readStatement';
import { suggestRubros, type SuggestReason } from '../lib/suggest';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

const AI_NAME: Partial<Record<SuggestReason, string>> = { apple: 'Apple Intelligence', claude: 'Claude' };

/**
 * Solo para buscar los repetidos en dólares sin la cotización del BCU (sin conexión, mientras llega o un día que no tiene)
 * ni la del estado de cuenta: el último recurso
 */
const DEFAULT_USD_RATE = 40;

const SHEETS = '.csv,.xlsx,.xls,.ods,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Estado de cuenta de la tarjeta (PDF, planilla o foto) → revisar por comercio → un gasto por compra */
export function ScanStatement({ onClose }: { onClose: () => void }) {
  const { data } = useStore();
  // Pantalla entera encima de la app: para el lector de pantalla es un diálogo, con este título
  const titleId = useId();
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
    <div className="fixed inset-0 z-30 overflow-y-auto bg-bg" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <PageHeader titleId={titleId} title={draft ? 'Revisar compras' : 'Estado de cuenta'} onBack={() => leave('cerrar')} />
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
          {/* Con los datos de ejemplo y en el modo demo (ahí casi todos sus comercios ya se conocen) */}
          {(data.settings.example || data.settings.demo) && (
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
  // Para los repetidos en dólares de un día sin cotización del BCU: la del estado de cuenta (o la última escrita) o 40
  const fallbackRate = draft.usdRate ?? DEFAULT_USD_RATE;
  const [usdRange] = useState(() => usdDates(txs));
  const hasUsd = !!usdRange;
  // Las compras en dólares van con la cotización del BCU de su fecha (undefined mientras se busca, null si no se
  // pudo); si la persona escribe una, esa para todas
  const [bcu, setBcu] = useState<UsdRate[] | null | undefined>(() => (usdRange ? undefined : null));
  // `force`: «Probar de nuevo» (sin esperar los minutos de pausa después de una falla)
  const [askBcu, setAskBcu] = useState<{ force: boolean }>({ force: false });
  useEffect(() => {
    if (!usdRange) return;
    let alive = true;
    setBcu(undefined);
    // Desde 3 días antes: lo anotado hasta 3 días antes de una compra puede ser un repetido (con la cotización de ese día)
    void usdRates(addDays(usdRange.from, -3), usdRange.to, askBcu).then((r) => alive && setBcu(r));
    return () => { alive = false; };
  }, [askBcu]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rateText, setRateText] = useState('');
  // Con decimales siempre: «39,875» es la cotización, no 39.875 pesos (parseAmount lo leería como miles)
  const parsedRate = rateText.trim() ? parseDecimal(rateText) : null;
  const single = parsedRate != null && validUsdRate(parsedRate) ? parsedRate : null;
  const badRate = !!rateText.trim() && single == null;
  // Las del BCU, si respondió con todas las fechas que hacen falta
  const bcuRates = bcu ? txRates(txs, null, bcu) : null;
  const bcuOk = bcuRates != null;
  const rates = badRate ? null : single ? txRates(txs, single, null) : hasUsd ? bcuRates : txRates(txs, null, null);
  const rateOf = (i: number) => rates?.[i] ?? 0;
  const validRate = rates != null;
  // Algo que eligió la persona (no las sugerencias): salir sin guardar lo pierde
  const [touched, setTouched] = useState(false);
  useEffect(() => onDirty(touched), [touched]); // eslint-disable-line react-hooks/exhaustive-deps

  // Los posibles repetidos: los en dólares, primero con la cotización de respaldo y, cuando llega la del BCU, con la de
  // cada fecha (sin frenar la revisión: se rehacen solos)
  const [dups, setDups] = useState(() => findDuplicates(txs, data.movements, { fallback: fallbackRate }));
  useEffect(() => {
    if (!bcu) return;
    const next = findDuplicates(txs, data.movements, { rates: bcu, fallback: fallbackRate });
    setDups((prev) => (prev.size === next.size && [...next].every(([i, id]) => prev.get(i) === id) ? prev : next));
  }, [bcu]); // eslint-disable-line react-hooks/exhaustive-deps
  // Los comercios (sin las compras repetidas)
  const groups = useMemo(() => groupSpends(txs, (i) => dups.has(i)), [txs, dups]);

  // Lo que no cambia mientras se revisa: meses de la planilla y en qué sección va cada comercio (todos, también los que
  // hoy son solo repetidos: con la cotización del BCU pueden dejar de serlo)
  const [fixed] = useState(() => {
    const rubros = spendRubros(data.rubros, data.categories);
    const section: Record<string, Section> = {};
    const choice: Record<string, Choice> = {};
    for (const g of groupSpends(txs)) {
      const known = knownRubro(txs[g.idx[0]], rubros, data.settings.learned);
      section[g.key] = known === NOT_SPEND ? 'excluido' : known ? 'conocido' : 'nuevo';
      if (known && known !== NOT_SPEND) choice[g.key] = known;
    }
    return { section, choice, months: planillaMonths(txs, data.movements) };
  });
  const [section, setSection] = useState(fixed.section);
  const [choice, setChoice] = useState(fixed.choice);
  const [excluded, setExcluded] = useState(() => new Set(Object.keys(fixed.section).filter((k) => fixed.section[k] === 'excluido')));
  const [skipPlanilla, setSkipPlanilla] = useState(true);
  const [importDup, setImportDup] = useState<Set<number>>(() => new Set());
  const [subtract, setSubtract] = useState<Set<number>>(() => new Set());
  const [showKnown, setShowKnown] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [picking, setPicking] = useState<MerchantGroup | null>(null);
  // Cuántos pedidos de sugerencias hay en curso
  const [suggesting, setSuggesting] = useState(0);
  const [saving, setSaving] = useState(false);

  // Los comercios nuevos se le preguntan a Apple Intelligence (o a Claude) sin frenar la revisión; si con la cotización
  // del BCU aparece otro (una compra que dejó de ser un repetido), también. Cada uno, una sola vez
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const ask = groups.filter((g) => fixed.section[g.key] === 'nuevo' && !asked.current.has(g.key));
    if (!ask.length) return;
    for (const g of ask) asked.current.add(g.key);
    const spend = new Set(spendRubros(data.rubros, data.categories).map((r) => r.id));
    setSuggesting((n) => n + 1);
    void suggestRubros(ask.map((g) => ({ id: g.key, text: g.merchant })), data)
      .then((found) => {
        if (!mounted.current) return;
        // Lo que ya eligió el usuario no se toca
        setChoice((c) => {
          const next = { ...c };
          for (const [key, s] of found) if (!next[key]?.rubroId && spend.has(s.rubroId)) next[key] = s;
          return next;
        });
      })
      .finally(() => mounted.current && setSuggesting((n) => n - 1));
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const local = (i: number) => toLocal(txs[i], rateOf(i));
  const skipMonth = (i: number) => skipPlanilla && fixed.months.includes(monthOf(txs[i].date));
  const rubroOf = (key: string) => (excluded.has(key) ? undefined : choice[key]?.rubroId);
  const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1];
  const monthsText = joinAnd(fixed.months.map(monthName));

  // Lo que se guarda: un gasto por compra (las de los meses de la planilla, si se saltean, no)
  const rows: { i: number; rubroId: string; merchant: string }[] = [];
  for (const g of groups) {
    const rubroId = rubroOf(g.key);
    if (rubroId) for (const i of g.idx) if (!skipMonth(i)) rows.push({ i, rubroId, merchant: g.merchant });
  }
  const dupList = [...dups].filter(([i]) => !skipMonth(i)).sort((a, b) => a[0] - b[0]);
  for (const [i, id] of dupList) {
    if (!importDup.has(i)) continue;
    const rubroId = rubroOf(txs[i].key) ?? data.movements.find((m) => m.id === id)?.rubroId;
    if (rubroId) rows.push({ i, rubroId, merchant: txs[i].merchant });
  }
  rows.sort((a, b) => a.i - b.i);
  const targets = rows.map((r) => txs[r.i]);
  const amounts = applyCredits(rows.map((r) => local(r.i)), targets, [...subtract].map((i) => ({ ...txs[i], amount: local(i) })));
  const movements = rows
    .map((r, k) => ({ date: txs[r.i].date, amount: amounts[k], rubroId: r.rubroId, merchant: r.merchant, note: statementNote(txs[r.i], draft.card, rateOf(r.i)) }))
    .filter((m) => m.amount > 0);
  const total = round2(movements.reduce((s, m) => s + m.amount, 0));

  const pending = (g: MerchantGroup) => !excluded.has(g.key) && !choice[g.key]?.rubroId && g.idx.some((i) => !skipMonth(i));
  const missing = groups.filter(pending).length;

  const spends = txs.map((t, i) => [t, i] as const).filter(([t]) => isSpend(t));
  const spendTotal = round2(spends.reduce((s, [, i]) => s + local(i), 0));
  const usdSpends = spends.filter(([t]) => t.currency === 'usd');
  const usdTotal = round2(usdSpends.reduce((s, [t]) => s + t.amount, 0));
  // La cotización promedio que quedó (las del BCU cambian un poco de un día a otro)
  const usdConverted = txs.map((t, i) => [t, i] as const).filter(([t]) => t.currency === 'usd' && (isSpend(t) || t.kind === 'credito'));
  const usdWeight = usdConverted.reduce((s, [t]) => s + Math.abs(t.amount), 0);
  const avgRate = usdWeight ? usdConverted.reduce((s, [t, i]) => s + Math.abs(t.amount) * rateOf(i), 0) / usdWeight : 0;
  const period = draft.period && `del ${dayMonth(draft.period.from)} al ${dayMonth(draft.period.to)}`;

  const nuevos = groups.filter((g) => section[g.key] === 'nuevo');
  const conocidos = groups.filter((g) => section[g.key] === 'conocido');
  const noGasto = groups.filter((g) => section[g.key] === 'excluido');
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
      for (const g of groups) {
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
        usdRate: single ?? undefined,
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
        <div className="card space-y-3 p-4">
          <div>
            <div className="text-lg">{usdSpends.length ? 'Compras en dólares' : 'Créditos en dólares'}</div>
            {usdSpends.length > 0 && (
              <div className="text-[15px] text-muted">
                {plural(usdSpends.length, 'compra', 'compras')}: {usd(usdTotal)}{validRate ? ` = ${money(round2(usdSpends.reduce((s, [, i]) => s + local(i), 0)))}` : ''}
              </div>
            )}
            <div className={`text-[15px] ${badRate || (!single && bcu !== undefined && !bcuOk) ? 'text-danger' : 'text-muted'}`} aria-live="polite">
              {badRate ? 'Revisá la cotización (por ejemplo, 40,10)'
                : single ? `Con tu cotización (${formatRate(single)}) para todas`
                : bcu === undefined ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-soft border-t-primary" /> Buscando la cotización del BCU…
                  </span>
                )
                : bcuOk ? `Cotización BCU de cada día (≈ ${avgRate.toLocaleString('es-UY', { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`
                : isPreview ? 'En la vista previa no se consulta el BCU: poné la cotización'
                : 'No se pudo traer la cotización del BCU: escribila'}
            </div>
            {!isPreview && !single && bcu === null && (
              <button className="min-h-tap text-[16px] text-primary" onClick={() => setAskBcu({ force: true })}>Probar de nuevo</button>
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-line pt-3">
            <label htmlFor="usd-rate" className="min-w-0 flex-1 leading-tight">
              <span className="block text-[17px]">Usar una sola cotización</span>
              <span className="block text-[14px] text-muted">{bcuOk ? 'Opcional: manda sobre la del BCU' : 'Para todas las compras'}</span>
            </label>
            <input
              id="usd-rate"
              className="field w-[84px] shrink-0 px-3 text-right tabular"
              inputMode="decimal"
              value={rateText}
              onChange={(e) => { setTouched(true); setRateText(e.target.value); }}
            />
          </div>
          {!rateText.trim() && draft.usdRate && (draft.usdRateFrom === 'estado' || (bcu !== undefined && !bcuOk)) && (
            <button className="chip" onClick={() => { setTouched(true); setRateText(formatRate(draft.usdRate!)); }}>
              Usar {formatRate(draft.usdRate)} ({draft.usdRateFrom === 'estado' ? 'la del estado de cuenta' : 'la última que usaste'})
            </button>
          )}
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
          {suggesting > 0 && (
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
          <p className={`pb-2 text-center text-[16px] ${missing === 0 && !badRate && bcu === undefined ? 'text-muted' : 'text-danger'}`}>
            {missing > 0 ? `Faltan ${plural(missing, 'comercio', 'comercios')}`
              : badRate ? 'Revisá la cotización del dólar (por ejemplo, 40,10)'
              : bcu === undefined ? 'Buscando la cotización del dólar…'
              : 'Falta la cotización del dólar'}
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
