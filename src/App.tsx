import { useEffect, useState } from 'react';
import { DemoRepair } from './components/Demo';
import { Intro, introAllowed } from './components/Intro';
import { LockGate } from './components/LockScreen';
import { MovementSheet, type MovementPreset } from './components/MovementSheet';
import { Suricata } from './components/Suricata';
import { TabBar, type Tab } from './components/TabBar';
import { ToastProvider } from './components/Toast';
import { addMonths, currentMonth, monthOf, today } from './domain/dates';
import { isDemoData } from './domain/demo';
import { recurringDate, recurringMovementId } from './domain/recurring';
import type { Kind, Movement } from './domain/types';
import { onReminderTap, syncReminder } from './lib/reportReminder';
import { scrollToTop } from './lib/scroll';
import { Budget } from './screens/Budget';
import { Categories } from './screens/Categories';
import { Goals } from './screens/Goals';
import { Help } from './screens/Help';
import { Home } from './screens/Home';
import { Household } from './screens/Household';
import { InstallmentsScreen } from './screens/Installments';
import { Invoices } from './screens/Invoices';
import { More, type MorePage } from './screens/More';
import { Savings } from './screens/Savings';
import { MonthReport } from './screens/MonthReport';
import { Movements } from './screens/Movements';
import { RecurringScreen } from './screens/Recurring';
import { ScanInvoice } from './screens/ScanInvoice';
import { ScanStatement } from './screens/ScanStatement';
import { Settings } from './screens/Settings';
import { Stats, type StatsView } from './screens/Stats';
import { Welcome } from './screens/Welcome';
import { useStore } from './store/store';

type Editing = { movement?: Movement; kind?: Kind; preset?: MovementPreset; onSaved?: () => void } | null;

/** No se pudieron leer los datos: ni la bienvenida ni nada que los pise, hasta que se puedan leer */
function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Suricata pose="cara-preocupado" size={120} />
      <h1 className="text-3xl">No pude leer tus datos</h1>
      <p className="text-lg text-muted">Siguen guardados en el teléfono. Probá de nuevo; si sigue igual, cerrá la app del todo y volvé a abrirla.</p>
      <button className="btn-primary mt-2 w-full max-w-xs" onClick={onRetry}>Probar de nuevo</button>
    </div>
  );
}

/** El último cambio no se pudo guardar (poco lugar, la conexión con el almacenamiento se cortó): se avisa y se reintenta */
function SaveError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+8px)] z-50 flex items-center gap-3 rounded-2xl border border-danger/50 bg-surface px-4 py-2 shadow-lg">
      <p className="flex-1 text-[16px] leading-snug text-danger">No se pudo guardar en el teléfono. Lo último que hiciste se puede perder.</p>
      <button className="min-h-tap shrink-0 px-2 text-primary" onClick={onRetry}>Reintentar</button>
    </div>
  );
}

/**
 * La animación de entrada (el suricata sale del pozo y se vuelve a meter) una vez por arranque, si está prendida en
 * este teléfono: no al volver de otra app. Mientras se va (el fundido de salida) ya se arma la app debajo, así que el
 * bloqueo pide Face ID recién cuando la animación termina.
 */
export default function App() {
  const { device, ready } = useStore();
  // 'esperando': hasta leer los ajustes del teléfono no se sabe si va. Se decide una sola vez: prenderla en Ajustes no la muestra
  const [intro, setIntro] = useState<'esperando' | 'si' | 'saliendo' | 'no'>('esperando');
  useEffect(() => {
    if (ready && intro === 'esperando') setIntro(device.intro && introAllowed() ? 'si' : 'no');
  }, [ready, intro, device.intro]);
  if (!ready || intro === 'esperando') return null;
  return (
    <>
      {intro !== 'si' && <AppContent />}
      {intro !== 'no' && <Intro onLeaving={() => setIntro('saliendo')} onDone={() => setIntro('no')} />}
    </>
  );
}

function AppContent() {
  const { data, device, demo, ready, loadError, retryLoad, saveError, saveNow, markRecurring } = useStore();
  const [tab, setTab] = useState<Tab>('inicio');
  const [page, setPage] = useState<MorePage | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [scanning, setScanning] = useState<'factura' | 'tarjeta' | null>(null);
  const [statsView, setStatsView] = useState<StatsView>('mes');
  const [statsMonth, setStatsMonth] = useState(currentMonth());
  // «Incluir ahorro» de Estadísticas → Mes: desde el resumen se abre apagado (el resumen cuenta sin el ahorro)
  const [statsSavings, setStatsSavings] = useState(true);
  const [movMonth, setMovMonth] = useState(currentMonth());
  // Resumen del mes abierto (YYYY-MM)
  const [report, setReport] = useState<string | null>(null);

  useEffect(scrollToTop, [tab, page]);
  // Tocar el aviso del día 1 abre el resumen del mes que cerró
  useEffect(() => onReminderTap(() => setReport(addMonths(currentMonth(), -1))), []);
  // El aviso programado en el iPhone sigue al ajuste de este teléfono (también después de borrar todo)
  const reminder = device.reportReminder;
  useEffect(() => {
    if (ready && !loadError) void syncReminder(reminder);
  }, [ready, loadError, reminder]);
  // Al terminar la bienvenida (también después de dejar los datos de ejemplo) se arranca en Inicio
  const onboarded = data.settings.onboarded;
  useEffect(() => {
    if (!onboarded) {
      setTab('inicio');
      setPage(null);
    }
  }, [onboarded]);

  if (!ready) return null;
  if (loadError) return <LoadError onRetry={retryLoad} />;
  // En el modo demo nunca la bienvenida (ofrece restaurar un respaldo de verdad) ni datos sin la marca del demo: se rehacen
  if (demo && !isDemoData(data)) return <LockGate><ToastProvider><DemoRepair /></ToastProvider></LockGate>;
  // El mismo LockGate en la bienvenida y en la app: al terminar la bienvenida no se vuelve a bloquear
  if (!data.settings.onboarded) return <LockGate><ToastProvider>{saveError && <SaveError onRetry={saveNow} />}<Welcome /></ToastProvider></LockGate>;

  const back = () => setPage(null);
  const go = (t: Tab) => {
    setTab(t);
    setPage(null);
  };
  const statsMonthView = (m: string, opts: { savings?: boolean } = {}) => {
    setStatsView('mes');
    setStatsMonth(m);
    if (opts.savings !== undefined) setStatsSavings(opts.savings);
    go('estadisticas');
  };

  let content: React.ReactNode;
  // «Tarjetas y cuotas» también se abre desde Inicio: «volver» lleva a donde estaba
  if (page && (tab === 'mas' || page === 'cuotas')) {
    content = {
      ahorro: <Savings onBack={back} />,
      presupuesto: <Budget onBack={back} />,
      fijos: <RecurringScreen onBack={back} />,
      cuotas: <InstallmentsScreen onBack={back} onStatement={() => setScanning('tarjeta')} />,
      categorias: <Categories onBack={back} />,
      metas: <Goals onBack={back} />,
      facturas: <Invoices onBack={back} />,
      hogar: <Household onBack={back} />,
      ajustes: <Settings onBack={back} />,
      ayuda: <Help onBack={back} />,
    }[page];
  } else if (tab === 'inicio') {
    content = (
      <Home
        onAdd={(kind) => setEditing({ kind })}
        onScan={() => setScanning('factura')}
        onStatement={() => setScanning('tarjeta')}
        onEdit={(movement) => setEditing({ movement })}
        onRecord={(r) => {
          // Un gasto fijo: se abre con su monto estimado y, al guardarlo, queda anotado este mes
          const now = today();
          const month = monthOf(now);
          setEditing({
            preset: { kind: r.kind, rubroId: r.rubroId, amount: r.amount, note: r.note, date: recurringDate(r, month, now), id: recurringMovementId(r.id, month) },
            onSaved: () => markRecurring(r.id, month),
          });
        }}
        onGo={(where) => (where === 'movimientos' ? go('movimientos') : statsMonthView(currentMonth()))}
        onReport={setReport}
        onInstallments={() => setPage('cuotas')}
      />
    );
  } else if (tab === 'movimientos') {
    content = <Movements month={movMonth} setMonth={setMovMonth} onAdd={() => setEditing({ kind: 'gasto' })} onEdit={(movement) => setEditing({ movement })} />;
  } else if (tab === 'estadisticas') {
    content = (
      <Stats
        view={statsView}
        setView={setStatsView}
        month={statsMonth}
        setMonth={setStatsMonth}
        savings={statsSavings}
        setSavings={setStatsSavings}
        onReport={setReport}
      />
    );
  } else {
    content = <More onOpen={setPage} />;
  }

  // Con una pantalla entera encima (escanear, el resumen), lo de abajo no se toca ni lo recorre el lector de pantalla
  const behind = report || scanning ? ({ inert: '', 'aria-hidden': true } as Record<string, unknown>) : {};

  return (
    // Con el bloqueo prendido, nada de esto se arma ni se ve hasta desbloquear
    <LockGate>
      <ToastProvider>
        {saveError && <SaveError onRetry={saveNow} />}
        <main className="mx-auto max-w-xl pb-[calc(env(safe-area-inset-bottom)+76px)]" {...behind}>{content}</main>
        <div {...behind}>
          <TabBar tab={tab} onChange={go} />
        </div>
        {editing && <MovementSheet movement={editing.movement} kind={editing.kind} preset={editing.preset} onSaved={editing.onSaved} onClose={() => setEditing(null)} />}
        {scanning === 'factura' && <ScanInvoice onClose={() => setScanning(null)} />}
        {scanning === 'tarjeta' && <ScanStatement onClose={() => setScanning(null)} />}
        {report && (
          <MonthReport
            month={report}
            onClose={() => setReport(null)}
            onStats={(m) => {
              setReport(null);
              statsMonthView(m, { savings: false });
            }}
          />
        )}
      </ToastProvider>
    </LockGate>
  );
}
