import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ToastMsg {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const Ctx = createContext<(text: string, action?: ToastMsg['action']) => void>(() => {});

/** Los avisos con «Deshacer» duran más: es la única forma de deshacer (guardar un estado de cuenta, borrar…) */
const DURATION = 4000;
const WITH_ACTION = 8000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msgs, setMsgs] = useState<ToastMsg[]>([]);
  const show = useCallback((text: string, action?: ToastMsg['action']) => {
    const id = Date.now() + Math.random();
    setMsgs((m) => [...m.slice(-1), { id, text, action }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), action ? WITH_ACTION : DURATION);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      {/* Siempre montado, así el lector de pantalla anuncia cada aviso que aparece */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-50 flex flex-col items-center gap-2 px-4"
      >
        {msgs.map((m) => (
          <div key={m.id} className="pointer-events-auto flex items-center gap-2 rounded-full bg-ink py-1 pl-5 pr-2 text-bg shadow-lg animate-fade">
            <span className="py-1.5">{m.text}</span>
            {m.action ? (
              <button className="min-h-tap px-3 text-soft underline" onClick={() => { m.action!.run(); setMsgs((x) => x.filter((y) => y.id !== m.id)); }}>
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
