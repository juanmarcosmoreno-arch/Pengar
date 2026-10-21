/**
 * Bloqueo con Face ID (Ajustes → Privacidad, solo en el iPhone): al abrir Pengar y al volver después de un rato
 * afuera, la app queda tapada hasta que se desbloquea. Si falla Face ID, el iPhone ofrece su código.
 */
import { Eye, Fingerprint, KeyRound, LockKeyhole, ScanFace } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { HERE, trackAway } from '../domain/lock';
import { authenticate, canLock, lockAvailability, onAppState, setPrivacyCover, unlockName, type AuthResult, type LockAvailability } from '../lib/lock';
import { holdSync } from '../lib/sync';
import { useStore } from '../store/store';
import { Suricata } from './Suricata';

const ICON = { faceID: ScanFace, touchID: Fingerprint, opticID: Eye, none: KeyRound };

/** Lo que se le dice si no se pudo (cancelar no dice nada: queda el botón) */
function problemText(res: AuthResult, name: string): string | null {
  if (res === 'lockout') return `${name} se bloqueó por muchos intentos. Desbloqueá el iPhone con su código y probá de nuevo.`;
  if (res === 'notAvailable') return 'Este iPhone no tiene Face ID ni código. Ponelo en los Ajustes del iPhone.';
  if (res === 'failed') return 'No se pudo comprobar que seas vos. Probá de nuevo.';
  return null;
}

/**
 * Envuelve la app. Al abrir con el bloqueo prendido no se arma nada de la app hasta desbloquear (ni los gastos
 * fijos ni el resumen); al volver bloqueada, lo de abajo queda como estaba (una hoja a medio llenar) pero tapado.
 */
export function LockGate({ children }: { children: ReactNode }) {
  const { device } = useStore();
  const { enabled, after } = device.lock;
  const on = canLock && enabled;
  const [locked, setLocked] = useState(on);
  // Ya se desbloqueó una vez: desde ahí la app queda armada debajo
  const [opened, setOpened] = useState(!on);
  // Afuera con el bloqueo prendido: tapada hasta saber, al volver, si hay que bloquear
  const [covered, setCovered] = useState(false);
  // Cada vez que aparece la pantalla de bloqueo se pide Face ID una vez, sin esperar el toque
  const [ask, setAsk] = useState(on ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<AuthResult | null>(null);
  const [avail, setAvail] = useState<LockAvailability | null>(null);
  const asking = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  // Lo último, para los avisos del iPhone (se escuchan una sola vez)
  const now = useRef({ on, after, locked });
  now.current = { on, after, locked };

  const unlock = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    setProblem(null);
    const res = await authenticate('Para abrir Pengar');
    // Sin Face ID ni código en el iPhone (se lo sacaron): no hay con qué bloquear, se abre
    const open = res === 'ok' || (res === 'notAvailable' && !(await lockAvailability()).available);
    asking.current = false;
    setBusy(false);
    if (open) {
      setLocked(false);
      setOpened(true);
    } else if (res !== 'cancel' && res !== 'fallback') setProblem(res);
  }, []);

  useEffect(() => {
    if (ask > 0 && now.current.locked) void unlock();
  }, [ask, unlock]);
  useEffect(() => {
    if (locked && canLock) void lockAvailability().then(setAvail);
  }, [locked, ask]);
  // El iPhone pone la tapa del selector de apps solo con el bloqueo prendido
  useEffect(() => void setPrivacyCover(on), [on]);
  useEffect(() => {
    if (on) return;
    setLocked(false);
    setCovered(false);
    setOpened(true);
  }, [on]);

  useEffect(() => {
    let away = HERE;
    return onAppState((event) => {
      const { on, after, locked } = now.current;
      const wasBackground = away.background;
      const res = trackAway(away, event, Date.now(), after);
      away = res.away;
      if (!on) return;
      if (event === 'background') {
        // Al instante: queda bloqueada ya, así al volver no se ve nada; si no, tapada hasta saber cuánto estuvo afuera
        if (after === 0) setLocked(true);
        else setCovered(true);
      } else if (event === 'active' && wasBackground) {
        setCovered(false);
        if (res.lock || locked) {
          setLocked(true);
          setAsk((n) => n + 1);
        }
      }
    });
  }, []);

  const hidden = locked || covered;
  useEffect(() => {
    if (content.current) content.current.inert = hidden;
  }, [hidden, opened]);
  // El hogar compartido no trae ni manda nada mientras está bloqueada (al abrir, ni arranca: este efecto va antes que
  // el del store)
  useEffect(() => holdSync(hidden), [hidden]);
  useEffect(() => () => holdSync(false), []);

  if (!canLock) return <>{children}</>;
  const name = unlockName(avail?.biometry ?? 'none');
  const Icon = avail ? ICON[avail.biometry] : LockKeyhole;
  return (
    <>
      {opened && <div ref={content} aria-hidden={hidden || undefined} className={hidden ? 'invisible' : undefined}>{children}</div>}
      {hidden && (
        <section aria-labelledby={locked ? 'bloqueo' : undefined} className="fixed inset-0 z-[60] flex touch-none flex-col items-center justify-center gap-3 overflow-hidden bg-bg px-8 pb-safe-b pt-safe-t text-center">
          <Suricata pose="principal" size={180} motion="breathe" />
          {locked && (
            <>
              <h1 id="bloqueo" className="mt-2 text-3xl">Pengar está bloqueada</h1>
              {problem && <p role="alert" className="text-lg text-muted">{problemText(problem, name)}</p>}
              <button className="btn-primary mt-2 w-full max-w-xs" disabled={busy} onClick={() => void unlock()}>
                <Icon size={22} /> {avail ? `Desbloquear con ${name}` : 'Desbloquear'}
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}
