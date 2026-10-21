import { useEffect, useState } from 'react';
import { MovementSheet, type MovementPreset } from './components/MovementSheet';
import { TabBar, type Tab } from './components/TabBar';
import { ToastProvider } from './components/Toast';
import { currentMonth, monthOf, today } from './domain/dates';
import { recurringDate } from './domain/recurring';
import type { Kind, Movement } from './domain/types';
import { scrollToTop } from './lib/scroll';
import { Budget } from './screens/Budget';
import { Categories } from './screens/Categories';
import { Goals } from './screens/Goals';
import { Help } from './screens/Help';
import { Home } from './screens/Home';
import { Invoices } from './screens/Invoices';
import { More, type MorePage } from './screens/More';
import { Movements } from './screens/Movements';
import { RecurringScreen } from './screens/Recurring';
import { ScanInvoice } from './screens/ScanInvoice';
import { ScanStatement } from './screens/ScanStatement';
import { Settings } from './screens/Settings';
import { Stats, type StatsView } from './screens/Stats';
import { Welcome } from './screens/Welcome';
import { useStore } from './store/store';

type Editing = { movement?: Movement; kind?: Kind; preset?: MovementPreset; onSaved?: () => void } | null;

export default function App() {
  const { data, ready, markRecurring } = useStore();
  const [tab, setTab] = useState<Tab>('inicio');
  const [page, setPage] = useState<MorePage | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [scanning, setScanning] = useState<'factura' | 'tarjeta' | null>(null);
  const [statsView, setStatsView] = useState<StatsView>('mes');
  const [statsMonth, setStatsMonth] = useState(currentMonth());
  const [movMonth, setMovMonth] = useState(currentMonth());

  useEffect(scrollToTop, [tab, page]);
  // Al terminar la bienvenida (también después de dejar los datos de ejemplo) se arranca en Inicio
  const onboarded = data.settings.onboarded;
  useEffect(() => {
    if (!onboarded) {
      setTab('inicio');
      setPage(null);
    }
  }, [onboarded]);

  if (!ready) return null;
  if (!data.settings.onboarded) return <ToastProvider><Welcome /></ToastProvider>;

  const back = () => setPage(null);
  const go = (t: Tab) => {
    setTab(t);
    setPage(null);
  };

  let content: React.ReactNode;
  if (tab === 'mas' && page) {
    content = {
      presupuesto: <Budget onBack={back} />,
      fijos: <RecurringScreen onBack={back} />,
      categorias: <Categories onBack={back} />,
      metas: <Goals onBack={back} />,
      facturas: <Invoices onBack={back} />,
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
            preset: { kind: r.kind, rubroId: r.rubroId, amount: r.amount, note: r.note, date: recurringDate(r, month, now) },
            onSaved: () => markRecurring(r.id, month),
          });
        }}
        onGo={(where) => {
          if (where === 'movimientos') go('movimientos');
          else { setStatsView('mes'); setStatsMonth(currentMonth()); go('estadisticas'); }
        }}
      />
    );
  } else if (tab === 'movimientos') {
    content = <Movements month={movMonth} setMonth={setMovMonth} onAdd={() => setEditing({ kind: 'gasto' })} onEdit={(movement) => setEditing({ movement })} />;
  } else if (tab === 'estadisticas') {
    content = <Stats view={statsView} setView={setStatsView} month={statsMonth} setMonth={setStatsMonth} />;
  } else {
    content = <More onOpen={setPage} />;
  }

  return (
    <ToastProvider>
      <main className="mx-auto max-w-xl pb-[calc(env(safe-area-inset-bottom)+76px)]">{content}</main>
      <TabBar tab={tab} onChange={go} />
      {editing && <MovementSheet movement={editing.movement} kind={editing.kind} preset={editing.preset} onSaved={editing.onSaved} onClose={() => setEditing(null)} />}
      {scanning === 'factura' && <ScanInvoice onClose={() => setScanning(null)} />}
      {scanning === 'tarjeta' && <ScanStatement onClose={() => setScanning(null)} />}
    </ToastProvider>
  );
}
