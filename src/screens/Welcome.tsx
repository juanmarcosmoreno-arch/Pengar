import { useRef, useState } from 'react';
import { ImportFlow, ImportFormatHelp } from '../components/ImportFlow';
import { Landscape } from '../components/Illustrations';
import { Suricata } from '../components/Suricata';
import { readBackup } from '../lib/backup';
import { useStore } from '../store/store';

/** Primera vez: bienvenida, nombre y cómo empezar (planilla propia o categorías sugeridas) */
export function Welcome() {
  const { startWithTemplate, replaceAll } = useStore();
  const [step, setStep] = useState<'hola' | 'empezar'>('hola');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const backupInput = useRef<HTMLInputElement>(null);

  if (step === 'hola') {
    return (
      <div className="flex min-h-full flex-col items-center px-8 pt-[calc(env(safe-area-inset-top)+7vh)] pb-[calc(env(safe-area-inset-bottom)+24px)]">
        <Suricata pose="principal" size={240} />
        <h1 className="mt-1 text-6xl">Pengar</h1>
        <p className="mt-1 text-xl text-muted">Tu dinero, más simple.</p>
        <Landscape className="mt-auto w-full max-w-sm opacity-90" />
        <div className="mt-6 flex w-full max-w-sm flex-col gap-3">
          <button className="btn-primary text-xl" onClick={() => setStep('empezar')}>Comenzar</button>
          <button className="btn-outline" onClick={() => backupInput.current?.click()}>Restaurar un respaldo</button>
          {error && <p className="text-center text-danger">{error}</p>}
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
            try {
              const d = await readBackup(f);
              replaceAll({ ...d, settings: { ...d.settings, onboarded: true } });
            } catch (err) {
              setError(err instanceof Error ? err.message : 'No se pudo leer el respaldo.');
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 pt-[calc(env(safe-area-inset-top)+32px)] pb-[calc(env(safe-area-inset-bottom)+32px)]">
      <button className="btn-ghost -ml-4" onClick={() => setStep('hola')}>‹ Volver</button>
      <div className="mt-2 flex items-end justify-between">
        <h1 className="text-4xl">¡Hola!</h1>
        <Suricata pose="saludando" size={110} flip />
      </div>
      <label className="mt-6 block">
        <span className="label">¿Cómo te llamás?</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" autoFocus />
      </label>

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
    </div>
  );
}
