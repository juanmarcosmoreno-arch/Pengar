import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../store/store';

interface ToastMsg {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  /** Los datos que se veían al mostrarlo (store: epoch) */
  epoch: number;
}

const Ctx = createContext<(text: string, action?: ToastMsg['action']) => void>(() => {});

/** Los avisos con «Deshacer» duran más: es la única forma de deshacer (guardar un estado de cuenta, borrar…) */
const DURATION = 4000;
const WITH_ACTION = 8000;

/**
 * Cada aviso es de los datos que se veían al mostrarlo: al entrar o salir del modo demo, los de antes se van (sus
 * montos no se ven en los otros datos y su «Deshacer» los cambiaría). Los que salen después del cambio quedan
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { epoch, epochNow } = useStore();
  const [msgs, setMsgs] = useState<ToastMsg[]>([]);
  const show = useCallback((text: string, action?: ToastMsg['action']) => {
    const id = Date.now() + Math.random();
    setMsgs((m) => [...m.slice(-1), { id, text, action, epoch: epochNow() }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), action ? WITH_ACTION : DURATION);
  }, [epochNow]);
  useEffect(() => {
    setMsgs((m) => (m.some((x) => x.epoch !== epoch) ? m.filter((x) => x.epoch === epoch) : m));
  }, [epoch]);
  const run = (m: ToastMsg) => {
    setMsgs((x) => x.filter((y) => y.id !== m.id));
    if (m.epoch === epochNow()) m.action?.run();
  };
  return (
    <Ctx.Provider value={show}>
      {children}
      {/* Siempre montado, así el lector de pantalla anuncia cada aviso que aparece */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-50 flex flex-col items-center gap-2 px-4"
      >
        {msgs.filter((m) => m.epoch === epoch).map((m) => (
          <div key={m.id} className="pointer-events-auto flex items-center gap-2 rounded-full bg-ink py-1 pl-5 pr-2 text-bg shadow-lg animate-fade">
            <span className="py-1.5">{m.text}</span>
            {m.action ? (
              <button className="min-h-tap px-3 text-soft underline" onClick={() => run(m)}>
                {m.action.label}
              </button>
            ) : <span className="pr-3" />}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
