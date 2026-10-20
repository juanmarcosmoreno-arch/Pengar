import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ToastMsg {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const Ctx = createContext<(text: string, action?: ToastMsg['action']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msgs, setMsgs] = useState<ToastMsg[]>([]);
  const show = useCallback((text: string, action?: ToastMsg['action']) => {
    const id = Date.now() + Math.random();
    setMsgs((m) => [...m.slice(-1), { id, text, action }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-50 flex flex-col items-center gap-2 px-4">
        {msgs.map((m) => (
          <div key={m.id} className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink px-5 py-2.5 text-bg shadow-lg animate-fade">
            <span>{m.text}</span>
            {m.action && (
              <button className="text-soft underline" onClick={() => { m.action!.run(); setMsgs((x) => x.filter((y) => y.id !== m.id)); }}>
                {m.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
