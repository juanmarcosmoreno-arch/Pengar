import { useEffect, useState } from 'react';
import { MovementSheet } from './components/MovementSheet';
import { TabBar, type Tab } from './components/TabBar';
import { ToastProvider } from './components/Toast';
import { currentMonth } from './domain/dates';
import type { Kind, Movement } from './domain/types';
import { Budget } from './screens/Budget';
import { Categories } from './screens/Categories';
import { Goals } from './screens/Goals';
import { Help } from './screens/Help';
import { Home } from './screens/Home';
import { Invoices } from './screens/Invoices';
import { More, type MorePage } from './screens/More';
import { Movements } from './screens/Movements';
import { ScanInvoice } from './screens/ScanInvoice';
import { Settings } from './screens/Settings';
import { Stats, type StatsView } from './screens/Stats';
import { Welcome } from './screens/Welcome';
import { useStore } from './store/store';

type Editing = { movement?: Movement; kind?: Kind } | null;

export default function App() {
  const { data, ready } = useStore();
  const [tab, setTab] = useState<Tab>('inicio');
  const [page, setPage] = useState<MorePage | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [scanning, setScanning] = useState(false);
  const [statsView, setStatsView] = useState<StatsView>('mes');
  const [statsMonth, setStatsMonth] = useState(currentMonth());
  const [movMonth, setMovMonth] = useState(currentMonth());

  useEffect(() => window.scrollTo(0, 0), [tab, page]);

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
        onScan={() => setScanning(true)}
        onEdit={(movement) => setEditing({ movement })}
        onGo={(where) => {
          if (where === 'movimientos') go('movimientos');
          else if (where === 'mes') { setStatsView('mes'); setStatsMonth(currentMonth()); go('estadisticas'); }
          else { setTab('mas'); setPage('presupuesto'); }
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
      {editing && <MovementSheet movement={editing.movement} kind={editing.kind} onClose={() => setEditing(null)} />}
      {scanning && <ScanInvoice onClose={() => setScanning(false)} />}
    </ToastProvider>
  );
}
