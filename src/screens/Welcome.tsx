import { CloudDownload } from 'lucide-react';
import { useRef, useState } from 'react';
import { ImportFlow, ImportFormatHelp } from '../components/ImportFlow';
import { Landscape } from '../components/Illustrations';
import { Suricata } from '../components/Suricata';
import { withArchives } from '../lib/autoBackup';
import { readBackup } from '../lib/backup';
import { isRemoteConfigured, RemoteError } from '../lib/remote';
import { household, useSync } from '../lib/sync';
import { useStore } from '../store/store';
import { householdError, JoinSheet } from './Household';

/** Primera vez: bienvenida, nombre y cómo empezar (planilla propia o categorías sugeridas) */
export function Welcome() {
  const { data, startWithTemplate, startWithExample, restoreBackup, updateSettings } = useStore();
  const [step, setStep] = useState<'hola' | 'empezar'>('hola');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loadingExample, setLoadingExample] = useState(false);
  // Hogar compartido: entrar con el código trae los datos del hogar (también en un teléfono nuevo)
  const [joining, setJoining] = useState(false);
  const backupInput = useRef<HTMLInputElement>(null);
  // Después de «Borrar todo» (o de dejar el ejemplo) se sigue en el hogar: se vuelve a sus datos (lib/sync). Una planilla,
  // empezar de cero o un respaldo se reemplazarían por los del hogar: no se ofrecen (primero hay que salir del hogar)
  const sync = useSync();
  const inHousehold = sync.household && sync.phase !== 'removed' ? sync.household : null;
  const [returning, setReturning] = useState(false);
  const householdNote = inHousehold && (
    <p className="text-center text-[16px] text-muted">Seguís en el hogar «{inHousehold.name}»: al empezar, vuelven sus datos.</p>
  );
  const backToHousehold = async () => {
    setError('');
    setReturning(true);
    try {
      if (name.trim()) updateSettings({ name: name.trim() });
      await household.reloadNow();
    } catch (e) {
      setError(e instanceof RemoteError && e.kind === 'offline' ? 'Sin conexión: para volver a los datos del hogar hace falta internet.' : householdError(e));
      setReturning(false);
    }
  };

  if (step === 'hola') {
    return (
      <div className="flex min-h-full flex-col items-center px-8 pt-[calc(env(safe-area-inset-top)+var(--app-h)*0.07)] pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <Suricata pose="principal" size={240} motion="breathe" />
        <h1 className="mt-1 text-6xl">Pengar</h1>
        <p className="mt-1 text-xl text-muted">Tu dinero, más simple.</p>
        <Landscape className="mt-auto w-full max-w-sm opacity-90" />
        <div className="mt-6 flex w-full max-w-sm flex-col gap-3">
          <button className="btn-primary text-xl" onClick={() => setStep('empezar')}>Comenzar</button>
          {!inHousehold && <button className="btn-outline" onClick={() => backupInput.current?.click()}>Restaurar un respaldo</button>}
          {isRemoteConfigured() && !inHousehold && <button className="btn-ghost" onClick={() => setJoining(true)}>Tengo un código de hogar</button>}
          <button
            className="btn-ghost"
            disabled={loadingExample}
            onClick={async () => {
              setError('');
              setLoadingExample(true);
              try {
                await startWithExample();
              } catch {
                setError('No se pudieron cargar los datos de ejemplo.');
                setLoadingExample(false);
              }
            }}
          >
            {loadingExample ? 'Cargando el ejemplo…' : 'Mirar con datos de ejemplo'}
          </button>
          {error && <p className="text-center text-danger">{error}</p>}
          {householdNote}
        </div>
        <input
          ref={backupInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            let backup;
            try {
              // Uno automático: sus fotos están aparte, en la carpeta de los automáticos
              backup = await withArchives(await readBackup(f));
            } catch (err) {
              setError(err instanceof Error ? err.message : 'No se pudo leer el respaldo.');
              return;
            }
            try {
              // La clave de Claude que había (la que se puso mirando el ejemplo) queda: el respaldo no la trae
              await restoreBackup(backup, { ai: data.settings.ai, onboarded: true });
            } catch (err) {
              console.error(err);
              setError('No se pudo guardar el respaldo en el teléfono.');
            }
          }}
        />
        {joining && <JoinSheet onClose={() => setJoining(false)} />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 pt-[calc(env(safe-area-inset-top)+32px)] pb-[calc(env(safe-area-inset-bottom)+32px)]">
      <button className="btn-ghost -ml-4" onClick={() => setStep('hola')}>‹ Volver</button>
      <div className="mt-2 flex items-end justify-between">
        <h1 className="text-4xl">¡Hola!</h1>
        <Suricata pose="saludando" size={110} flip motion="wave" />
      </div>
      <label className="mt-6 block">
        <span className="label">¿Cómo te llamás?</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" autoFocus />
      </label>

      {inHousehold ? (
        <>
          <div className="card mt-6 space-y-3 p-4">
            <div className="text-xl">Volver a los datos del hogar</div>
            <p className="text-muted">Seguís en el hogar «{inHousehold.name}»: se bajan sus datos a este teléfono. Hace falta internet.</p>
            <button className="btn-primary w-full" disabled={returning} onClick={() => void backToHousehold()}>
              <CloudDownload size={20} /> {returning ? 'Bajando los datos…' : 'Volver a los datos del hogar'}
            </button>
            {error && <p role="alert" className="text-danger">{error}</p>}
          </div>
          <p className="mt-4 text-[16px] text-muted">
            Para empezar con tu planilla, de cero o con un respaldo, primero salí del hogar: volvé a sus datos y tocá Más → Hogar compartido → «Salir del hogar».
          </p>
        </>
      ) : (
        <>
          <h2 className="mt-8 text-2xl">¿Cómo querés empezar?</h2>
          <div className="card mt-3 space-y-3 p-4">
            <div className="text-xl">Con mi planilla</div>
            <p className="text-muted">Si ya llevás tus gastos en Excel, se importan tus rubros, tus categorías, el presupuesto y todos los meses.</p>
            <ImportFlow mode="replace" name={name.trim()} onDone={() => {}} />
            <ImportFormatHelp />
          </div>
          <div className="card mt-3 space-y-3 p-4">
            <div className="text-xl">De cero</div>
            <p className="text-muted">Con categorías y rubros sugeridos (supermercado, luz, combustible…). Después los cambiás a tu gusto.</p>
            <button className="btn-outline w-full" onClick={() => startWithTemplate(name.trim())}>Empezar de cero</button>
          </div>
        </>
      )}
    </div>
  );
}
