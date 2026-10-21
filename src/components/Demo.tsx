/**
 * Modo demo (Ajustes → Modo demo): el chip «Demo» de Inicio y Más, con la hoja para salir, y la salida, que en el
 * iPhone pide siempre Face ID o el código (aunque el bloqueo esté apagado): quien tiene el teléfono en la mano para
 * mirar la app no puede volver a tus datos. Un iPhone sin código no tiene con qué: pide confirmar, y los textos lo dicen.
 */
import { Presentation } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authenticate, canLock, lockAvailability, unlockName, type LockAvailability } from '../lib/lock';
import { isPreview } from '../lib/platform';
import { useStore } from '../store/store';
import { ConfirmSheet } from './ConfirmSheet';
import { Sheet } from './Sheet';
import { Suricata } from './Suricata';
import { useToast } from './Toast';

export const DEMO_EXPLAINED = 'Muestra datos inventados para enseñar la app. Tus datos quedan guardados y vuelven al salir.';

/** Ajustes ofrece el modo demo: no en la vista previa ni con el ejemplo de la bienvenida (ya son datos inventados) */
export const demoOffered = (example: boolean | undefined, demo: boolean) => !isPreview && (demo || !example);

const WEB: LockAvailability = { biometry: 'none', available: false };

/** Con qué se comprueba quién sale del demo en este teléfono (null mientras pregunta; en la web, con nada) */
export function useExitLock(): LockAvailability | null {
  const [avail, setAvail] = useState<LockAvailability | null>(canLock ? null : WEB);
  useEffect(() => {
    if (!canLock) return;
    let alive = true;
    void lockAvailability().then((a) => alive && setAvail(a));
    return () => { alive = false; };
  }, []);
  return avail;
}

/** «Face ID o el código del iPhone» (Touch ID, Optic ID; sin biometría, solo el código) */
export const exitWith = (a: LockAvailability) => (a.biometry === 'none' ? 'el código del iPhone' : `${unlockName(a.biometry)} o el código del iPhone`);

/** El iPhone no tiene código: salir del demo pide solo confirmar */
export const NO_PASSCODE = 'Este iPhone no tiene código: para salir del demo alcanza con confirmar.';

/**
 * «Salir del modo demo»: en el iPhone, Face ID o el código del iPhone; si el iPhone no tiene ni código, una
 * confirmación (como en la web). Si se cancela, sigue en el demo
 */
export function useExitDemo() {
  const { exitDemo } = useStore();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    setBusy(true);
    try {
      await exitDemo();
      toast('Volviste a tus datos');
    } catch (e) {
      console.error(e);
      toast('No se pudo salir del modo demo: probá de nuevo');
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (busy) return;
    if (!canLock) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    const avail = await lockAvailability();
    if (!avail.available) {
      setBusy(false);
      setConfirm(true);
      return;
    }
    const res = await authenticate('Para salir del modo demo y volver a tus datos');
    setBusy(false);
    if (res === 'ok') await leave();
    // Le sacaron el código al iPhone mientras tanto: no hay con qué comprobarlo
    else if (res === 'notAvailable' && !(await lockAvailability()).available) setConfirm(true);
    else if (res === 'lockout') toast(`${avail.biometry === 'none' ? 'Demasiados intentos' : `${unlockName(avail.biometry)} está bloqueado`}: desbloqueá el iPhone con su código y probá de nuevo`);
    else if (res === 'failed' || res === 'notAvailable') toast('No se pudo comprobar que seas vos: seguís en el modo demo');
  };
  const sheet = confirm && (
    <ConfirmSheet
      title="¿Salir del modo demo?"
      message="Vuelven tus datos. Lo que se anotó en el demo queda ahí para la próxima."
      confirmLabel="Salir del demo"
      onConfirm={() => void leave()}
      onClose={() => setConfirm(false)}
    />
  );
  return { start: () => void start(), busy, sheet };
}

/** El chip «Demo» (solo en el modo demo): chico, para que no moleste al mostrar la app. Tocarlo abre la salida */
export function DemoChip({ className = '' }: { className?: string }) {
  const { demo } = useStore();
  const [open, setOpen] = useState(false);
  const exit = useExitDemo();
  const lock = useExitLock();
  if (!demo) return null;
  const how = !canLock
    ? ' Tus datos están guardados y vuelven al salir.'
    : !lock ? '' : lock.available ? ` Para volver a los tuyos te pide ${exitWith(lock)}.` : ` ${NO_PASSCODE}`;
  return (
    <>
      {/* Chico a la vista, pero el toque llega a 44 px (30 + 7 arriba y 7 abajo) */}
      <button
        className={`tap-area tap-area-44 inline-flex min-h-[30px] shrink-0 items-center gap-1 rounded-full border border-primary/50 bg-soft/30 px-2.5 text-[15px] leading-none text-primary ${className}`}
        onClick={() => setOpen(true)}
        aria-label="Modo demo: los datos son inventados"
      >
        <Presentation size={15} strokeWidth={2} aria-hidden="true" /> Demo
      </button>
      {/* Fuera del encabezado: con su fondo borroso (backdrop-filter), una hoja fija adentro quedaría atrapada en él */}
      {open && createPortal(
        <Sheet
          title="Modo demo"
          onClose={() => setOpen(false)}
          footer={
            <button className="btn-primary w-full" disabled={exit.busy} onClick={exit.start}>
              Salir del modo demo
            </button>
          }
        >
          <div className="flex items-center gap-4 pb-2">
            <Suricata pose="cara-curioso" size={72} className="shrink-0" />
            <p className="text-lg">Los datos que ves son inventados, para mostrar la app.{how}</p>
          </div>
        </Sheet>,
        document.getElementById('root') ?? document.body,
      )}
      {exit.sheet && createPortal(exit.sheet, document.getElementById('root') ?? document.body)}
    </>
  );
}

/**
 * En el modo demo con datos que no son del demo (no debería pasar: se arman de nuevo al entrar y al abrir). Nunca la
 * bienvenida, que ofrece restaurar un respaldo: se rehacen solos y, si no se puede, probar de nuevo o salir
 */
export function DemoRepair() {
  const { resetDemo } = useStore();
  const exit = useExitDemo();
  const [failed, setFailed] = useState(false);
  const redo = useRef(resetDemo);
  redo.current = resetDemo;
  const tried = useRef(false);
  const run = () => {
    setFailed(false);
    redo.current().catch((e) => {
      console.error(e);
      setFailed(true);
    });
  };
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Suricata pose="cara-curioso" size={120} />
      <h1 className="text-3xl">{failed ? 'No se pudo armar el demo' : 'Preparando el demo…'}</h1>
      {failed && (
        <>
          <p className="text-lg text-muted">Tus datos no se tocaron. Probá de nuevo o volvé a ellos.</p>
          <button className="btn-primary mt-2 w-full max-w-xs" onClick={run}>Probar de nuevo</button>
          <button className="btn-outline w-full max-w-xs" disabled={exit.busy} onClick={exit.start}>Salir del modo demo</button>
        </>
      )}
      {exit.sheet}
    </div>
  );
}
