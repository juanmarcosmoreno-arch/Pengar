/**
 * Modo demo (Ajustes → Modo demo): el chip «Demo» de Inicio y Más, con la hoja para salir, y la salida, que en el
 * iPhone pide siempre Face ID o el código (aunque el bloqueo esté apagado): quien tiene el teléfono en la mano para
 * mirar la app no puede volver a tus datos.
 */
import { Presentation } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { authenticate, canLock, lockAvailability } from '../lib/lock';
import { useStore } from '../store/store';
import { ConfirmSheet } from './ConfirmSheet';
import { Sheet } from './Sheet';
import { Suricata } from './Suricata';
import { useToast } from './Toast';

export const DEMO_EXPLAINED = 'Muestra datos inventados para enseñar la app. Tus datos quedan guardados y vuelven al salir.';

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
    else if (res === 'lockout') toast('Face ID está bloqueado: desbloqueá el iPhone con su código y probá de nuevo');
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
  if (!demo) return null;
  return (
    <>
      <button
        className={`tap-area inline-flex min-h-[30px] shrink-0 items-center gap-1 rounded-full border border-primary/50 bg-soft/30 px-2.5 text-[15px] leading-none text-primary ${className}`}
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
            <p className="text-lg">Los datos que ves son inventados, para mostrar la app. {canLock ? 'Para volver a los tuyos te pide Face ID o el código del iPhone.' : 'Tus datos están guardados y vuelven al salir.'}</p>
          </div>
        </Sheet>,
        document.getElementById('root') ?? document.body,
      )}
      {exit.sheet && createPortal(exit.sheet, document.getElementById('root') ?? document.body)}
    </>
  );
}
