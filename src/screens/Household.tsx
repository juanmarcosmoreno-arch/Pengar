/**
 * Hogar compartido (Más → Hogar compartido): crear un hogar con los datos de este teléfono, unirse con el código (que
 * también sirve para recuperarlos en otro teléfono), quiénes están, el código para sumar a alguien, cómo va la
 * sincronización y salir. El motor es lib/sync.ts. Sin Supabase configurado (o en la vista previa) solo se explica; en el
 * modo demo, tampoco se muestra nada del hogar.
 */
import { Share } from '@capacitor/share';
import { Check, CloudCheck, CloudDownload, CloudOff, CloudUpload, Copy, HousePlus, KeyRound, LogOut, Pause, RefreshCw, Share2, TriangleAlert, UserRound } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { PageHeader, Sheet } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { useToast } from '../components/Toast';
import { sinceDay, timeAgo, toISODate, today } from '../domain/dates';
import { plural } from '../domain/text';
import { canAutoBackup } from '../lib/autoBackup';
import { makeBackup } from '../lib/backup';
import { NO_DOWNLOADS, saveOrShare } from '../lib/files';
import { isNative, isPreview } from '../lib/platform';
import { RemoteError, type Household as HouseholdT } from '../lib/remote';
import { household, LOST_SESSION, SyncError, useSync, type SyncStatus } from '../lib/sync';
import { useStore } from '../store/store';

/** Cuántas letras y números tiene el código del hogar */
export const CODE_LENGTH = 12;

/** Lo que se le agrega a una confirmación cuando el cambio también es para los demás del hogar */
export const sharedNote = (hh: HouseholdT | null) => (hh ? ` Como estás en el hogar «${hh.name}», también cambia para los demás.` : '');

/** El hogar en el que está (null sin hogar o si ya no es miembro) */
export function activeHousehold(s: SyncStatus): HouseholdT | null {
  return s.household && s.phase !== 'removed' ? s.household : null;
}

/** Lo que se le dice cuando algo no sale */
export function householdError(e: unknown): string {
  if (e instanceof SyncError) return `${e.message}.`;
  if (e instanceof RemoteError) {
    if (e.kind === 'offline') return 'Sin conexión. Probá de nuevo cuando tengas internet.';
    if (e.kind === 'invalid-code') return `Ese código no es de ningún hogar. Revisalo: son ${CODE_LENGTH} letras y números.`;
    if (e.kind === 'limit') return 'Probaste muchos códigos que no existen. Esperá una hora y probá de nuevo.';
    if (e.kind === 'session') return 'Este teléfono perdió su acceso al hogar: entrá de nuevo con el código.';
    if (e.kind === 'setup') return 'El servidor del hogar no está listo: falta la migración o el ingreso anónimo en Supabase (ver README).';
    if (e.kind === 'denied') return 'Ya no estás en ese hogar.';
  }
  return 'No se pudo. Probá de nuevo en un rato.';
}

/** «ABCD 2345 EFGH», de a cuatro */
const spaced = (code: string) => code.match(/.{1,4}/g)?.join(' ') ?? code;
/** El código como lo escriben (con guion, espacios o minúsculas) */
const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xl text-muted">{title}</h2>
      <div className="card space-y-3 p-4">{children}</div>
    </section>
  );
}

/** El código grande, con Copiar y (en el iPhone) Compartir */
function CodeBox({ hh }: { hh: HouseholdT }) {
  const toast = useToast();
  const copy = () => {
    // Dentro del toque: si no, el navegador no deja escribir en el portapapeles
    const done = navigator.clipboard?.writeText(hh.inviteCode);
    if (!done) toast('No se pudo copiar: anotalo a mano');
    else done.then(() => toast('Código copiado'), () => toast('No se pudo copiar: anotalo a mano'));
  };
  const share = async () => {
    try {
      await Share.share({
        title: 'Pengar',
        text: `Sumate a «${hh.name}» en Pengar: en Más → Hogar compartido → «Unirme con un código», escribí ${spaced(hh.inviteCode)}.`,
      });
    } catch (e) {
      if (!/cancel/i.test(String(e))) toast('No se pudo compartir');
    }
  };
  return (
    <div>
      {/* VoiceOver lo deletrea (el texto de abajo, leído, sería una palabra) */}
      <p className="text-center font-mono text-[25px] leading-tight tracking-[0.08em] min-[380px]:text-[29px]">
        <span className="select-all" aria-hidden="true">{spaced(hh.inviteCode)}</span>
        <span className="sr-only">Código: {hh.inviteCode.split('').join(' ')}</span>
      </p>
      <div className="mt-3 flex gap-2">
        <button className="btn-outline flex-1 px-3" onClick={copy}><Copy size={18} /> Copiar</button>
        {isNative && <button className="btn-outline flex-1 px-3" onClick={() => void share()}><Share2 size={18} /> Compartir</button>}
      </div>
    </div>
  );
}

/** «Guardar un respaldo antes»: el automático en el iPhone; en la web, el manual (descarga) */
function BackupFirst() {
  const { data, backupNow } = useStore();
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const run = async () => {
    setState('busy');
    try {
      if (canAutoBackup) {
        const res = await backupNow();
        if (!res.saved) throw new Error(res.error ?? 'No se pudo hacer el respaldo');
        toast(res.saved.location === 'icloud' ? 'Respaldo guardado en iCloud Drive' : 'Respaldo guardado en el iPhone');
      } else if (!(await saveOrShare(await makeBackup(data), `pengar-respaldo-${today()}.json`))) {
        toast(NO_DOWNLOADS);
        setState('idle');
        return;
      }
      setState('done');
    } catch (e) {
      console.error(e);
      toast(e instanceof Error ? e.message : 'No se pudo hacer el respaldo');
      setState('idle');
    }
  };
  return (
    <div className="mb-2 rounded-2xl bg-sunken px-4 py-3">
      <p className="text-[16px]">
        Por las dudas, guardá un respaldo antes. Si después querés volver a tus datos, salí del hogar y restauralo desde Ajustes (restaurado estando en el hogar, cambia para todos).
      </p>
      <button className="btn-outline mt-2 w-full" disabled={state !== 'idle'} onClick={() => void run()}>
        {state === 'done' ? <><Check size={18} /> Respaldo guardado</> : state === 'busy' ? 'Guardando…' : <><CloudUpload size={18} /> Guardar un respaldo antes</>}
      </button>
    </div>
  );
}

/**
 * Unirse con el código: también desde la bienvenida y para volver a entrar desde otro teléfono. Si hay datos propios,
 * avisa que se reemplazan por los del hogar (y ofrece un respaldo antes)
 */
export function JoinSheet({ onClose }: { onClose: () => void }) {
  const { data, updateSettings } = useStore();
  const toast = useToast();
  const id = useId();
  const [name, setName] = useState(data.settings.name);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const own = data.settings.onboarded && !data.settings.example;
  const clean = cleanCode(code);
  const valid = !!name.trim() && clean.length === CODE_LENGTH;

  const join = async () => {
    setBusy(true);
    setError('');
    try {
      // El nombre con que te ven los demás es también el de Ajustes
      if (name.trim() !== data.settings.name) updateSettings({ name: name.trim() });
      const hh = await household.join(clean, name.trim());
      toast(`Listo: estás en «${hh.name}»`);
      onClose();
    } catch (e) {
      setError(householdError(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet
        title="Unirme con un código"
        onClose={onClose}
        footer={
          <button className="btn-primary w-full" disabled={!valid || busy} onClick={() => (own ? setAsking(true) : void join())}>
            {busy ? 'Trayendo los datos del hogar…' : 'Unirme'}
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-[17px] text-muted">
            Pedile el código a alguien del hogar (está en su Pengar, en Más → Hogar compartido). Si cambiás de teléfono, entrá con el código y vuelven tus datos; el teléfono de antes queda en Integrantes y lo sacás desde ahí.
          </p>
          <div>
            <label className="label" htmlFor={`${id}-nombre`}>Tu nombre (así te ven los demás)</label>
            <input id={`${id}-nombre`} className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-codigo`}>Código del hogar</label>
            <input
              id={`${id}-codigo`}
              className="field font-mono text-2xl uppercase tracking-[0.1em]"
              value={code}
              maxLength={CODE_LENGTH + 6}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && valid && !busy && (own ? setAsking(true) : void join())}
              placeholder="ABCD 2345 EFGH"
            />
            <p className="mt-1 text-[14px] text-muted">{CODE_LENGTH} letras y números.</p>
          </div>
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>
      </Sheet>
      {asking && (
        <ConfirmSheet
          title="¿Reemplazar tus datos?"
          message="Los movimientos, categorías, presupuesto, metas y facturas de este teléfono se reemplazan por los del hogar. Tu nombre y la clave de Claude quedan."
          confirmLabel="Unirme"
          danger
          extra={<BackupFirst />}
          onConfirm={() => void join()}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

/** Crear un hogar: sube todos los datos de este teléfono y muestra el código para compartir */
function CreateSheet({ onClose }: { onClose: () => void }) {
  const { data, updateSettings } = useStore();
  const id = useId();
  const [name, setName] = useState(data.settings.name);
  const [home, setHome] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<HouseholdT | null>(null);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      if (name.trim() !== data.settings.name) updateSettings({ name: name.trim() });
      setCreated(await household.create(home.trim() || 'Casa', name.trim()));
    } catch (e) {
      setError(householdError(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Sheet title="Hogar creado" onClose={onClose} footer={<button className="btn-primary w-full" onClick={onClose}>Listo</button>}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Suricata pose="celebrando" size={88} className="shrink-0" />
            <p className="text-lg">Listo: «{created.name}» ya tiene tus datos. Pasale este código a quien quieras sumar.</p>
          </div>
          <CodeBox hh={created} />
          <p className="text-[15px] text-muted">Lo escribe en su Pengar, en Más → Hogar compartido → «Unirme con un código». También lo ves acá cuando quieras.</p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Crear un hogar"
      onClose={onClose}
      footer={
        <button className="btn-primary w-full" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? 'Subiendo tus datos…' : 'Crear el hogar'}
        </button>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor={`${id}-nombre`}>Tu nombre (así te ven los demás)</label>
          <input id={`${id}-nombre`} className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-hogar`}>Nombre del hogar</label>
          <input id={`${id}-hogar`} className="field" value={home} maxLength={80} onChange={(e) => setHome(e.target.value)} placeholder="Casa" />
        </div>
        <p className="text-[16px] text-muted">
          Se suben todos tus datos: movimientos, categorías, presupuesto, metas, gastos fijos, facturas y estados de cuenta. Tu nombre lo ven los demás del hogar; la clave de Claude queda solo en este teléfono.
        </p>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Sheet>
  );
}

/** Cómo va: «Sincronizado hace 1 min», «Enviando 3 cambios…», «Sin conexión: se manda cuando vuelva» */
function syncText(s: SyncStatus, now: number): { Icon: typeof CloudCheck; text: string; tone?: string; spin?: boolean } {
  const changes = (n: number) => plural(n, 'cambio', 'cambios');
  if (s.phase === 'syncing') {
    return { Icon: RefreshCw, spin: true, text: s.reload ? 'Bajando los datos del hogar…' : s.pending > 0 ? `Enviando ${changes(s.pending)}…` : 'Sincronizando…' };
  }
  if (s.phase === 'offline') {
    return { Icon: CloudOff, text: s.reload ? 'Sin conexión: los datos del hogar se bajan cuando vuelva' : `Sin conexión: se manda cuando vuelva${s.pending > 0 ? ` (${changes(s.pending)})` : ''}` };
  }
  if (s.phase === 'error') return { Icon: TriangleAlert, tone: 'text-danger', text: 'No se pudo sincronizar: se vuelve a probar solo' };
  if (s.phase === 'held') return { Icon: TriangleAlert, tone: 'text-danger', text: `Lo de este teléfono borraría ${plural(s.held, 'cosa', 'cosas')} del hogar (casi todo). No se mandó: decí qué hacer.` };
  if (s.phase === 'paused') return { Icon: Pause, text: 'En pausa con los datos de ejemplo: al volver a los tuyos, se bajan los del hogar' };
  if (s.pending > 0) return { Icon: CloudUpload, text: `${changes(s.pending)} por enviar` };
  return { Icon: CloudCheck, text: s.lastSyncAt ? `Sincronizado ${timeAgo(s.lastSyncAt, now)}` : 'Sincronizado' };
}

/** Cada medio minuto, para que «hace 1 min» siga siendo cierto */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function InHousehold({ s, hh }: { s: SyncStatus; hh: HouseholdT }) {
  const toast = useToast();
  const now = useNow();
  const [membersFailed, setMembersFailed] = useState(false);
  const [asking, setAsking] = useState<'code' | 'leave' | 'force' | 'send' | null>(null);
  // Archivos que no se pudieron bajar antes de salir
  const [notFetched, setNotFetched] = useState(0);
  // El integrante que se va a sacar
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Al abrir: los integrantes, el nombre y el código al día
  useEffect(() => {
    household.refreshMembers().then(() => setMembersFailed(false), () => setMembersFailed(true));
  }, []);
  const { Icon, text, tone, spin } = syncText(s, now);
  const alone = s.members.length <= 1;

  const newCode = async () => {
    setBusy(true);
    try {
      toast(`Código nuevo: ${spaced(await household.regenerateCode())}`);
    } catch (e) {
      toast(householdError(e));
    } finally {
      setBusy(false);
    }
  };
  const leave = async (force = false) => {
    setBusy(true);
    try {
      await household.leave({ force });
      toast('Saliste del hogar: tus datos quedan en este teléfono');
    } catch (e) {
      setBusy(false);
      if (e instanceof SyncError && e.kind === 'files') {
        setNotFetched(e.count);
        setAsking('force');
        return;
      }
      toast(e instanceof RemoteError && e.kind === 'offline' ? 'Sin conexión: para salir hace falta internet' : householdError(e));
    }
  };
  const remove = async (userId: string) => {
    setBusy(true);
    try {
      await household.removeMember(userId);
      toast('Listo: ya no está en el hogar');
    } catch (e) {
      toast(householdError(e));
    } finally {
      setBusy(false);
    }
  };
  const resolve = (choice: 'send' | 'reload') => void household.resolveHeld(choice).catch((e) => toast(householdError(e)));
  // Con «Borrar todo» o el ejemplo puestos, lo del hogar no está en el teléfono: salir dejaría sin nada
  const away = s.reload;

  return (
    <>
      <div className="card flex items-center gap-3 p-4">
        <Suricata pose="casa" size={84} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-2xl leading-tight">{hh.name}</h2>
          <p className="text-[15px] text-muted">Hogar compartido{s.members.length ? ` · ${plural(s.members.length, 'integrante', 'integrantes')}` : ''}</p>
        </div>
      </div>

      <div className="card space-y-2 p-4">
        <p className={`flex items-start gap-2 text-[17px] ${tone ?? ''}`} aria-live="polite">
          <Icon size={20} className={`mt-0.5 shrink-0 ${tone ? '' : 'text-primary'} ${spin ? 'animate-spin' : ''}`} />
          <span>{text}</span>
        </p>
        {s.rejected > 0 && (
          <p className="text-[14px] text-danger">
            El servidor no aceptó {s.rejected === 1 ? 'un cambio' : `${s.rejected} cambios`}: si lo cambiás de nuevo, se vuelve a probar.
          </p>
        )}
        {s.phase === 'held' ? (
          <div className="space-y-2">
            <p className="text-[15px] text-muted">
              Pasa si se borraron los datos de este teléfono sin que el hogar se enterara. Si no fue a propósito, volvé a los datos del hogar.
            </p>
            <button className="btn-primary w-full" onClick={() => resolve('reload')}><CloudDownload size={18} /> Volver a los datos del hogar</button>
            <button className="btn-ghost w-full text-danger" onClick={() => setAsking('send')}>Borrar igual en el hogar</button>
          </div>
        ) : (
          <button className="btn-ghost -ml-4" disabled={s.phase === 'syncing' || s.phase === 'paused'} onClick={() => void household.syncNow()}>
            <RefreshCw size={18} /> Sincronizar ahora
          </button>
        )}
      </div>

      <Section title="Integrantes">
        {s.members.length ? (
          <ul className="-my-1 divide-y divide-line">
            {s.members.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 py-2">
                <UserRound size={22} className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg">
                    {m.displayName || 'Sin nombre'}
                    {m.userId === s.userId && <span className="text-muted"> (vos)</span>}
                  </div>
                  <div className="text-[14px] text-muted">{sinceDay(toISODate(new Date(m.joinedAt)))}</div>
                </div>
                {m.userId !== s.userId && (
                  <button
                    className="min-h-tap shrink-0 px-2 text-[16px] text-muted"
                    disabled={busy}
                    onClick={() => setRemoving({ userId: m.userId, name: m.displayName || 'Sin nombre' })}
                    aria-label={`Sacar a ${m.displayName || 'este integrante'} del hogar`}
                  >
                    Sacar
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[16px] text-muted">{membersFailed || s.phase === 'offline' ? 'Se ven cuando vuelva la conexión.' : 'Buscando…'}</p>
        )}
        {s.members.length > 1 && (
          <p className="text-[14px] text-muted">Cada teléfono es un integrante. Si cambiaste de teléfono, el de antes sigue en la lista: sacalo con «Sacar».</p>
        )}
      </Section>

      <Section title="Código para sumar a alguien">
        <CodeBox hh={hh} />
        <p className="text-[15px] text-muted">
          Quien lo escriba en su Pengar (Más → Hogar compartido → «Unirme con un código») ve y anota lo mismo que vos. Guardalo: si cambiás de teléfono, entrá con el código y vuelven tus datos (lo que anotaste en el de antes dice «Anotado por» tu nombre).
        </p>
        <button className="btn-ghost -ml-4" disabled={busy} onClick={() => setAsking('code')}>Cambiar el código</button>
      </Section>

      <button className="btn-ghost w-full text-danger" disabled={busy || away} onClick={() => setAsking('leave')}>
        <LogOut size={18} /> {busy ? 'Saliendo…' : 'Salir del hogar'}
      </button>
      {away && (
        <p className="-mt-2 px-1 text-center text-[15px] text-muted">
          Para salir, primero volvé a tus datos («Empezar con los míos»): al volver, se bajan los del hogar. Si no, este teléfono quedaría sin nada.
        </p>
      )}

      {asking === 'code' && (
        <ConfirmSheet
          title="¿Cambiar el código?"
          message="El código de ahora deja de servir para entrar. Quienes ya están en el hogar siguen igual."
          confirmLabel="Cambiar"
          onConfirm={() => void newCode()}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === 'leave' && (
        <ConfirmSheet
          title="¿Salir del hogar?"
          message={alone
            ? 'Sos la única persona del hogar: se borra del servidor, con su código. Antes se bajan las fotos y los PDF que falten: tus datos quedan en este teléfono como copia propia.'
            : 'Antes se bajan las fotos y los PDF que falten: tus datos quedan en este teléfono como copia propia, pero dejan de sincronizarse (lo que anoten los demás ya no te llega). Para volver, entrá con el código.'}
          confirmLabel="Salir"
          danger
          onConfirm={() => void leave()}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === 'force' && (
        <ConfirmSheet
          title="¿Salir igual?"
          message={`${notFetched === 1 ? 'No se pudo bajar la foto o el PDF de una factura' : `No se pudieron bajar las fotos o los PDF de ${notFetched} facturas`}: si salís igual, ${notFetched === 1 ? 'queda' : 'quedan'} sin archivo en este teléfono. Si esperás un rato, se puede probar de nuevo.`}
          confirmLabel="Salir igual"
          danger
          onConfirm={() => void leave(true)}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === 'send' && (
        <ConfirmSheet
          title="¿Borrar casi todo el hogar?"
          message={`Se borran del hogar ${plural(s.held, 'cosa', 'cosas')} que no están en este teléfono, también para los demás. No se puede deshacer.`}
          confirmLabel="Borrar"
          danger
          onConfirm={() => resolve('send')}
          onClose={() => setAsking(null)}
        />
      )}
      {removing && (
        <ConfirmSheet
          title={`¿Sacar a ${removing.name}?`}
          message="Ese teléfono deja de ver y anotar en el hogar (sirve para un teléfono que ya no usás, como el tuyo de antes). Lo que anotó queda. Para volver, tiene que entrar de nuevo con el código."
          confirmLabel="Sacar"
          danger
          onConfirm={() => void remove(removing.userId)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

/** Sin hogar: qué es y los dos caminos */
function NoHousehold({ onOpen }: { onOpen: (sheet: 'create' | 'join') => void }) {
  const { data } = useStore();
  const example = data.settings.example === true;
  return (
    <>
      <div className="card flex flex-col items-center p-5 text-center">
        <Suricata pose="casa" size={150} />
        <h2 className="mt-2 text-2xl">Pengar entre varios</h2>
        <p className="mt-1 text-[17px] text-muted">
          Vos y quien viva con vos anotan cada uno en su teléfono y ven lo mismo: movimientos, presupuesto, metas, gastos fijos, facturas y estados de cuenta.
        </p>
      </div>
      {example && (
        <p className="rounded-2xl bg-sunken px-4 py-3 text-[16px]">Estás viendo los datos de ejemplo: para crear un hogar, primero empezá con los tuyos.</p>
      )}
      <div className="space-y-3">
        <button className="btn-primary w-full" disabled={example} onClick={() => onOpen('create')}><HousePlus size={20} /> Crear un hogar</button>
        <button className="btn-outline w-full" onClick={() => onOpen('join')}><KeyRound size={20} /> Unirme con un código</button>
      </div>
      <p className="px-1 text-[16px] text-muted">
        «Crear un hogar» sube tus datos y te da un código para sumar a alguien. Con «Unirme con un código» traés los del hogar a este teléfono. Si cambiás de teléfono, entrá con el código y vuelven tus datos (el teléfono de antes queda en Integrantes: sacalo desde ahí).
      </p>
    </>
  );
}

/** Ya no es miembro (lo sacaron, el hogar se borró o el teléfono perdió su sesión): sus datos siguen acá */
function Removed({ hh, lost, onJoin }: { hh: HouseholdT; lost: boolean; onJoin: () => void }) {
  const toast = useToast();
  const forget = () =>
    household.leave().then(
      () => toast('Listo: tus datos quedan en este teléfono'),
      (e) => toast(householdError(e)),
    );
  return (
    <>
      <div className="card flex items-center gap-3 p-4">
        <Suricata pose="cara-preocupado" size={72} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl leading-tight">Ya no estás en «{hh.name}»</h2>
          <p className="mt-1 text-[16px] text-muted">
            {lost
              ? 'Este teléfono perdió su acceso al hogar (pasa si se borra lo que guarda la app). Tus datos quedan acá; para volver a sincronizar, entrá de nuevo con el código.'
              : 'Te sacaron del hogar o se borró. Tus datos quedan en este teléfono, pero ya no se sincronizan.'}
          </p>
        </div>
      </div>
      <button className="btn-outline w-full" onClick={onJoin}><KeyRound size={20} /> Unirme con un código</button>
      <button className="btn-ghost w-full" onClick={() => void forget()}>Seguir sin hogar</button>
    </>
  );
}

export function Household({ onBack }: { onBack: () => void }) {
  const s = useSync();
  const { demo } = useStore();
  // Las hojas van acá: al crear o unirse, la pantalla cambia (y la hoja tiene que seguir para mostrar el código)
  const [sheet, setSheet] = useState<'create' | 'join' | null>(null);
  let body: ReactNode;
  if (demo) {
    // Ni el nombre del hogar, ni el código, ni los integrantes: se está mostrando la app
    body = (
      <div className="card flex flex-col items-center p-5 text-center">
        <Suricata pose="casa" size={150} />
        <h2 className="mt-2 text-2xl">En el modo demo no se muestra</h2>
        <p className="mt-1 text-[17px] text-muted">
          Con un hogar compartido, cada uno anota en su teléfono y todos ven lo mismo. En el modo demo no se sincroniza nada: lo que anotes acá no le llega a nadie, y al salir todo sigue como estaba.
        </p>
      </div>
    );
  } else if (!s.configured) {
    body = (
      <div className="card flex flex-col items-center p-5 text-center">
        <Suricata pose="casa" size={150} />
        <h2 className="mt-2 text-2xl">Pengar entre varios</h2>
        <p className="mt-1 text-[17px] text-muted">
          Con un hogar compartido, cada uno anota en su teléfono y todos ven lo mismo.
          {isPreview
            ? ' En la vista previa web no está disponible: funciona en la app de iPhone.'
            : ' Esta versión de la app no tiene el servidor configurado: se configura en el código, con un proyecto de Supabase (los pasos están en el README).'}
        </p>
      </div>
    );
  } else if (!s.loaded) {
    body = <p className="py-8 text-center text-[17px] text-muted">{s.error ?? 'Un momento…'}</p>;
  } else if (!s.household) {
    body = <NoHousehold onOpen={setSheet} />;
  } else if (s.phase === 'removed') {
    body = <Removed hh={s.household} lost={s.error === LOST_SESSION} onJoin={() => setSheet('join')} />;
  } else {
    body = <InHousehold s={s} hh={s.household} />;
  }
  return (
    <div>
      <PageHeader title="Hogar compartido" onBack={onBack} />
      <div className="space-y-4 px-4 pb-12">{body}</div>
      {sheet === 'create' && <CreateSheet onClose={() => setSheet(null)} />}
      {sheet === 'join' && <JoinSheet onClose={() => setSheet(null)} />}
    </div>
  );
}
