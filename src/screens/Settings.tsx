import { ChevronRight, Cloud, CloudUpload, Download, HardDrive, LockKeyhole, Presentation, RefreshCw, Smartphone, Sparkles, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmSheet, NoticeSheet } from '../components/ConfirmSheet';
import { DEMO_EXPLAINED, useExitDemo } from '../components/Demo';
import { ImportFlow, ImportFormatHelp } from '../components/ImportFlow';
import { PageHeader, Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { Segmented, Toggle } from '../components/Toggle';
import { backupDate, backupWhen, clock } from '../domain/autoBackup';
import { dayLabel, toISODate, today } from '../domain/dates';
import { movementsCsv } from '../domain/export';
import { formatRate, isUsdSymbol } from '../domain/fx';
import { LOCK_AFTER, type LockAfter } from '../domain/lock';
import { dayMonth } from '../domain/statementReview';
import { emptyData } from '../domain/template';
import { capital, fileSize, joinAnd, plural } from '../domain/text';
import { appleAIStatus, type AppleAIStatus } from '../lib/appleAI';
import { backupStatus, canAutoBackup, listAutoBackups, readAutoBackup, withArchives, type BackupFile, type BackupStatus } from '../lib/autoBackup';
import { buildBackup, readBackup, type ReadBackup } from '../lib/backup';
import { defaultDevice } from '../lib/device';
import { NO_DOWNLOADS, saveOrShare } from '../lib/files';
import { cachedUsdRateToday, refreshUsdRate, usdRateToday, type UsdQuote } from '../lib/fx';
import { authenticate, canLock, lockAvailability, unlockName, type LockAvailability } from '../lib/lock';
import { isNative, isPreview } from '../lib/platform';
import { household as hogar, loadInvoiceFile, useSync } from '../lib/sync';
import { useStore } from '../store/store';
import { activeHousehold, sharedNote } from './Household';

/**
 * Antes de reemplazar todos los datos (borrar o restaurar): en un hogar, lo que falta mandar se manda; con el
 * respaldo automático, se guarda uno con lo de ahora (el de hoy puede ser de la mañana). Si no se pudo, pregunta
 */
function useBeforeReplace() {
  const { data, device, backupNow } = useStore();
  const hh = activeHousehold(useSync());
  const toast = useToast();
  const [risky, setRisky] = useState<{ error: string; run: () => void } | null>(null);
  const guard = async (run: () => void) => {
    if (hh) await hogar.syncNow();
    if (canAutoBackup && device.autoBackup.enabled && data.settings.onboarded && !data.settings.example) {
      toast('Guardando un respaldo antes…');
      const res = await backupNow();
      if (!res.saved && res.error) {
        setRisky({ error: res.error, run });
        return;
      }
    }
    run();
  };
  const sheet = risky && (
    <ConfirmSheet
      title="No se pudo guardar el respaldo"
      message={`${risky.error}. Si seguís, lo de ahora no queda en ningún respaldo.`}
      confirmLabel="Seguir igual"
      danger
      onConfirm={risky.run}
      onClose={() => setRisky(null)}
    />
  );
  return { guard, sheet };
}

/** Con el ejemplo puesto en un hogar: lo que se restaure o importe se reemplazaría por los datos del hogar */
function PausedNotice({ name, what, onClose }: { name: string; what: 'restaurar' | 'importar'; onClose: () => void }) {
  return (
    <NoticeSheet
      title={`Seguís en el hogar «${name}»`}
      message={`Con los datos de ejemplo puestos, el hogar está en pausa: lo que ${what === 'restaurar' ? 'restaures' : 'importes'} se reemplazaría por los datos del hogar. Primero tocá «Empezar con los míos» para volver a ellos. Para usar ${what === 'restaurar' ? 'un respaldo' : 'una planilla'} en su lugar, después salí del hogar (Más → Hogar compartido).`}
      onClose={onClose}
    />
  );
}

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (la mejor lectura)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (más barato)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (el más barato)' },
];

const APPLE_AI: Record<AppleAIStatus, string> = {
  available: 'disponible. Se usa para sugerir rubros, en el teléfono y sin costo.',
  notEnabled: 'no está activado en Ajustes del iPhone. Si lo activás, Pengar lo usa para sugerir rubros, en el teléfono y sin costo.',
  notEligible: 'este iPhone no es compatible.',
  notReady: 'se está descargando. Cuando termine, se usa para sugerir rubros.',
  unsupported: 'necesita iOS 26 o más nuevo.',
  sdk: 'esta versión de la app se compiló sin Apple Intelligence (hace falta Xcode 26).',
};

/** «21/10 09:12» */
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${dayMonth(toISODate(d))} ${d.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
};

/** La cotización del dólar de hoy (la del BCU), con «Actualizar» */
function UsdToday() {
  const toast = useToast();
  // undefined mientras se busca; null si no hay
  const [quote, setQuote] = useState<UsdQuote | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    // Lo guardado se ve enseguida; después, lo que responda el BCU (si hacía falta preguntarle)
    void cachedUsdRateToday().then((q) => alive && q && setQuote((prev) => prev ?? q));
    void usdRateToday().then((q) => alive && setQuote(q));
    return () => { alive = false; };
  }, []);
  const refresh = async () => {
    setBusy(true);
    const { quote: q, ok } = await refreshUsdRate();
    setBusy(false);
    setQuote(q);
    if (!ok) toast(isPreview ? 'En la vista previa no se consulta el BCU' : 'No se pudo actualizar: revisá la conexión');
  };
  const bcu = quote?.source !== 'mercado';
  const detail = quote
    ? [
      !bcu && 'De open.er-api.com (en la web el BCU no responde)',
      quote.date !== today() && `La del ${dayMonth(quote.date)}`,
      quote.at && `actualizado ${stamp(quote.at)}`,
    ].filter(Boolean).join(' · ')
    : quote === null ? (isPreview ? 'En la vista previa no se consulta el BCU.' : 'No se pudo consultar: revisá la conexión.') : 'Buscando…';
  return (
    <>
      {isPreview ? (
        // En la vista previa no se consulta el BCU: no hay nada que actualizar
        <p className="text-[16px]">En la vista previa no se consulta el BCU: las compras en dólares piden escribir la cotización.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[10rem] flex-1" aria-live="polite">
            <div className="text-lg">{bcu ? 'Dólar BCU hoy' : 'Dólar hoy'}: {quote ? formatRate(quote.rate) : quote === null ? 'sin datos' : '…'}</div>
            <div className="text-[14px] text-muted">{capital(detail)}</div>
          </div>
          <button className="btn-outline shrink-0 px-4" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={18} className={busy ? 'animate-spin' : ''} /> Actualizar
          </button>
        </div>
      )}
      <p className="text-[14px] text-muted">
        Con la del BCU de cada día se pasan a pesos las compras en dólares de la tarjeta y lo que anotás en U$S.
      </p>
    </>
  );
}

/** La animación del suricata al abrir (components/Intro): es de este teléfono, como el bloqueo */
function IntroSetting() {
  const { device, updateDevice } = useStore();
  return (
    <Section title="Al abrir">
      <Toggle checked={device.intro} onChange={(intro) => updateDevice({ intro })} label="El suricata sale del pozo" />
      <p className="text-[14px] text-muted">
        Una animación cortita cada vez que abrís Pengar de cero (no al volver de otra app; con un toque la salteás). Con «Reducir movimiento» del iPhone no se muestra.
      </p>
    </Section>
  );
}

const AFTER_LABEL: Record<LockAfter, string> = { 0: 'Al instante', 60: '1 minuto', 300: '5 minutos' };

/** Bloqueo con Face ID (o el código del iPhone): solo en el iPhone; es de este teléfono, no va en los respaldos */
function Privacy() {
  const { device, updateDevice } = useStore();
  const toast = useToast();
  const [avail, setAvail] = useState<LockAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void lockAvailability().then(setAvail);
  }, []);
  if (!avail) return null;
  const { enabled, after } = device.lock;
  const name = unlockName(avail.biometry);
  const change = async (next: boolean) => {
    if (busy) return;
    if (!next) {
      updateDevice({ lock: { ...device.lock, enabled: false } });
      return;
    }
    // Antes de prenderlo se prueba una vez: que ande y que sea el dueño del teléfono
    setBusy(true);
    const res = await authenticate(`Para pedir ${name} al abrir Pengar`);
    setBusy(false);
    if (res === 'ok') {
      updateDevice({ lock: { ...device.lock, enabled: true } });
      toast(`Listo: Pengar te pide ${name} al abrir`);
    } else if (res === 'lockout') toast(`${name} está bloqueado: desbloqueá el iPhone con su código y probá de nuevo`);
    else if (res === 'notAvailable') toast('Este iPhone no tiene Face ID ni código');
    else if (res === 'failed') toast('No se pudo comprobar que seas vos');
  };
  return (
    <Section title="Privacidad">
      {(avail.available || enabled) && (
        <Toggle checked={enabled} onChange={(v) => void change(v)} label={`Pedir ${name} al abrir`} />
      )}
      {enabled && (
        <div>
          <p className="label">Al volver a la app</p>
          <Segmented
            label="Al volver a la app"
            value={String(after)}
            onChange={(v) => updateDevice({ lock: { ...device.lock, after: Number(v) as LockAfter } })}
            options={LOCK_AFTER.map((a) => ({ id: String(a), label: AFTER_LABEL[a] }))}
          />
          <p className="mt-1 text-[14px] text-muted">
            {after === 0 ? 'Cada vez que volvés a Pengar.' : `Si estuviste más de ${AFTER_LABEL[after]} en otra app o con el iPhone bloqueado.`}
          </p>
        </div>
      )}
      <p className="flex gap-2 text-[14px] text-muted">
        <LockKeyhole size={16} className="mt-0.5 shrink-0 text-primary" />
        {avail.available
          ? `Te pide ${name}${avail.biometry === 'none' ? ' del iPhone' : ' (si falla, el código del iPhone)'} al abrir Pengar y al volver a la app. Prendido, el selector de apps no muestra tus números. Es solo de este teléfono: no va en los respaldos.`
          : 'Para bloquear Pengar, el iPhone necesita un código: ponelo en los Ajustes del iPhone.'}
      </p>
    </Section>
  );
}

/** «de hoy», «de ayer», «del martes 20 de octubre» o, si no es automático, el nombre entre comillas */
const backupOf = (f: BackupFile) => {
  const date = backupDate(f.name);
  if (!date) return `«${f.name}»`;
  const label = dayLabel(date);
  return label === 'Hoy' || label === 'Ayer' ? `de ${label.toLowerCase()}` : `del ${label.toLowerCase()}`;
};

/** La lista de los respaldos automáticos para elegir cuál restaurar */
function AutoBackupList({ folder, files, reading, onChoose, onClose }: {
  folder: string;
  files: BackupFile[] | null;
  reading: string | null;
  onChoose: (f: BackupFile) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Respaldos automáticos" onClose={onClose}>
      {!files ? (
        <p className="py-6 text-center text-[16px] text-muted">Buscando…</p>
      ) : files.length === 0 ? (
        <p className="py-4 text-[16px] text-muted">Todavía no hay respaldos en {folder}.</p>
      ) : (
        <ul className="divide-y divide-line">
          {files.map((f) => {
            const date = backupDate(f.name);
            const detail = [date ? (f.modified > 0 ? clock(f.modified) : '') : f.modified > 0 ? capital(backupWhen(f.modified)) : '', f.size > 0 ? fileSize(f.size) : ''].filter(Boolean).join(' · ');
            return (
              <li key={f.name}>
                <button className="flex min-h-tap w-full items-center gap-3 py-3 text-left disabled:opacity-60" disabled={reading != null} aria-busy={reading === f.name} onClick={() => onChoose(f)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg">{date ? dayLabel(date) : f.name}</span>
                    {detail && <span className="block text-[14px] text-muted">{detail}</span>}
                  </span>
                  {reading === f.name
                    ? <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-soft border-t-primary" aria-label="Leyendo" />
                    : <ChevronRight size={20} className="shrink-0 text-muted" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {files && files.length > 0 && <p className="pt-2 text-[14px] text-muted">En {folder}. Al elegir uno, te pregunta antes de reemplazar nada.</p>}
    </Sheet>
  );
}

/**
 * Respaldo automático (solo en el iPhone): uno por día en iCloud Drive o, si la app no tiene iCloud, en Archivos.
 * El ajuste es de este teléfono; restaurar uno conserva la clave de Claude y los ajustes del teléfono
 */
function AutoBackup() {
  const { data, device, updateDevice, backupNow, restoreBackup } = useStore();
  const sync = useSync();
  const hh = activeHousehold(sync);
  const toast = useToast();
  const { guard, sheet } = useBeforeReplace();
  const [notice, setNotice] = useState(false);
  const ab = device.autoBackup;
  // undefined mientras pregunta; null si esta app no tiene el plugin
  const [status, setStatus] = useState<BackupStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // La lista para restaurar (abierta: un arreglo, o null mientras busca), el que se está leyendo y el leído que espera confirmación
  const [listing, setListing] = useState<{ files: BackupFile[] | null } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ file: BackupFile; backup: ReadBackup } | null>(null);
  // Dónde: de nuevo después de cada respaldo (pudieron prender iCloud Drive)
  useEffect(() => {
    let alive = true;
    void backupStatus().then((s) => alive && setStatus(s));
    return () => { alive = false; };
  }, [ab.last]);
  if (status === undefined) return null;
  if (status === null) {
    return (
      <Section title="Respaldo automático">
        <p className="text-[16px] text-muted">Esta versión de la app no tiene el respaldo automático. Instalala de nuevo desde Xcode.</p>
      </Section>
    );
  }
  const example = data.settings.example === true;
  // Si está, es que el último intento falló (el que sale bien lo borra)
  const { failed } = ab;
  const icloud = status.location === 'icloud';
  const WhereIcon = icloud ? Cloud : HardDrive;

  const now = async () => {
    setBusy(true);
    const res = await backupNow();
    setBusy(false);
    if (res.saved) toast(res.saved.location === 'icloud' ? 'Respaldo guardado en iCloud Drive' : 'Respaldo guardado en el iPhone');
    else if (res.error) toast(res.error);
    else if (res.skipped === 'example') toast('Con los datos de ejemplo no se hacen respaldos');
  };
  const open = async () => {
    setListing({ files: null });
    try {
      const files = await listAutoBackups();
      setListing((l) => l && { files });
    } catch (e) {
      setListing(null);
      toast(e instanceof Error ? e.message : 'No se pudieron ver los respaldos');
    }
  };
  const choose = async (file: BackupFile) => {
    setReading(file.name);
    try {
      setChosen({ file, backup: await readAutoBackup(file.name) });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se pudo leer el respaldo');
    } finally {
      setReading(null);
    }
  };

  return (
    <Section title="Respaldo automático">
      <Toggle checked={ab.enabled} onChange={(enabled) => updateDevice({ autoBackup: { ...ab, enabled } })} label="Hacer un respaldo por día" />
      <p className="flex gap-2 text-[16px]">
        <WhereIcon size={18} className="mt-0.5 shrink-0 text-primary" />
        <span>
          {ab.last != null ? `Último: ${backupWhen(ab.last)} · en ${status.folder}` : `Todavía no hay ninguno. Van a ${status.folder}`}
          {!icloud && <span className="text-muted"> (para guardarlos en iCloud Drive, ver Ayuda: si borrás la app, los de «En mi iPhone» se borran con ella)</span>}
        </span>
      </p>
      {failed && (
        <p className="text-[14px] text-danger">
          {failed.message} ({backupWhen(failed.at)}).{ab.enabled && !example ? ' Se vuelve a probar solo.' : ''}
        </p>
      )}
      {example ? (
        <p className="rounded-2xl bg-sunken px-4 py-3 text-[16px]">Con los datos de ejemplo no se hacen respaldos. Empezá con los tuyos, o restaurá uno.</p>
      ) : (
        <p className="text-[14px] text-muted">
          Al abrir o al salir de la app, si cambió algo desde el último; con las facturas. Quedan los 14 más nuevos y uno por mes durante un año.
        </p>
      )}
      {!example && (
        <button className="btn-outline w-full" disabled={busy} onClick={() => void now()}>
          <CloudUpload size={18} /> {busy ? 'Guardando…' : 'Hacer un respaldo ahora'}
        </button>
      )}
      <button className="btn-ghost w-full" onClick={() => (hh && sync.reload ? setNotice(true) : void open())}>Restaurar uno automático…</button>
      {notice && hh && <PausedNotice name={hh.name} what="restaurar" onClose={() => setNotice(false)} />}
      {sheet}
      {listing && (
        <AutoBackupList folder={status.folder} files={listing.files} reading={reading} onChoose={(f) => void choose(f)} onClose={() => setListing(null)} />
      )}
      {chosen && (
        <ConfirmSheet
          title="¿Restaurar este respaldo?"
          message={`Se reemplazan todos los datos de este teléfono por los del respaldo ${backupOf(chosen.file)} (${plural(chosen.backup.data.movements.length, 'movimiento', 'movimientos')}, ${plural(chosen.backup.data.invoices.length, 'factura', 'facturas')}). La clave de Claude y los ajustes de este teléfono quedan como están.${sharedNote(hh)}`}
          confirmLabel="Restaurar"
          onConfirm={() => {
            setListing(null);
            const backup = chosen.backup;
            void guard(() => {
              if (hh) hogar.allowBigDelete();
              restoreBackup(backup, { ai: data.settings.ai, onboarded: true }).then(
                () => toast('Respaldo restaurado'),
                (e) => {
                  console.error(e);
                  toast('No se pudo restaurar el respaldo');
                },
              );
            });
          }}
          onClose={() => setChosen(null)}
        />
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xl text-muted">{title}</h2>
      <div className="card space-y-3 p-4">{children}</div>
    </section>
  );
}

/**
 * Modo demo: datos inventados para mostrar la app sin que se vean los tuyos. Entrar pide confirmar; salir, en el
 * iPhone, Face ID o el código. No está en la vista previa (ya son datos de ejemplo) ni con el ejemplo de la bienvenida
 */
function DemoMode() {
  const { demo, enterDemo } = useStore();
  const hh = activeHousehold(useSync());
  const toast = useToast();
  const exit = useExitDemo();
  const [asking, setAsking] = useState(false);
  // Mientras se guardan tus datos y se arma el demo (si el hogar estaba mandando algo, espera que termine)
  const [entering, setEntering] = useState(false);
  if (demo) {
    return (
      <Section title="Modo demo">
        <p className="flex gap-2 rounded-2xl bg-sunken px-4 py-3 text-[16px]">
          <Presentation size={18} className="mt-0.5 shrink-0 text-primary" />
          <span>Estás en el modo demo: los datos son inventados. Lo que anotes o cambies queda en el demo; tus datos no se tocan.</span>
        </p>
        <button className="btn-primary w-full" disabled={exit.busy} onClick={exit.start}>Salir del modo demo</button>
        {canLock && <p className="text-[14px] text-muted">Para volver a tus datos te pide Face ID o el código del iPhone.</p>}
        {exit.sheet}
      </Section>
    );
  }
  return (
    <Section title="Modo demo">
      <p className="flex gap-2 text-[16px]">
        <Presentation size={18} className="mt-0.5 shrink-0 text-primary" />
        <span>{DEMO_EXPLAINED}</span>
      </p>
      <button className="btn-outline w-full" disabled={entering} onClick={() => setAsking(true)}>{entering ? 'Preparando el demo…' : 'Pasar al modo demo'}</button>
      <p className="text-[14px] text-muted">
        {canLock ? 'Para volver te pide Face ID o el código del iPhone, aunque no tengas el bloqueo prendido: quien mira la app no puede ver tus datos. ' : ''}
        Mientras tanto no se sincroniza el hogar compartido ni se hacen respaldos.
      </p>
      {asking && (
        <ConfirmSheet
          title="¿Pasar al modo demo?"
          message={`Vas a ver datos inventados para mostrar la app. Tus datos quedan guardados como están y vuelven al salir.${hh ? ` Mientras tanto no se sincroniza el hogar «${hh.name}»: lo que falte mandar se manda al salir.` : ''}`}
          confirmLabel="Pasar al modo demo"
          onConfirm={() => {
            setEntering(true);
            enterDemo().then(
              () => toast('Modo demo: los datos son inventados'),
              (e) => {
                console.error(e);
                setEntering(false);
                toast('No se pudo pasar al modo demo: probá de nuevo');
              },
            );
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </Section>
  );
}

export function Settings({ onBack }: { onBack: () => void }) {
  const { data, device, demo, update, updateSettings, updateDevice, replaceAll, restoreBackup, resetDemo } = useStore();
  const sync = useSync();
  const hh = activeHousehold(sync);
  // Con el ejemplo puesto en un hogar, lo que se restaure o importe se reemplazaría por los datos del hogar
  const paused = hh && sync.reload ? hh : null;
  const [notice, setNotice] = useState<'restaurar' | 'importar' | null>(null);
  const { guard, sheet } = useBeforeReplace();
  const toast = useToast();
  const id = useId();
  const s = data.settings;
  const [importing, setImporting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const restore = useRef<HTMLInputElement>(null);
  // Respaldo leído que espera confirmación, «Borrar todo» y «Olvidar lo aprendido»
  const [backup, setBackup] = useState<ReadBackup | null>(null);
  const [wiping, setWiping] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  // «Rehacer los datos de demo» (en el modo demo, en lugar de «Borrar todo»)
  const [redoing, setRedoing] = useState(false);
  // El modo demo: no en la vista previa ni con el ejemplo de la bienvenida (ya son datos inventados)
  const demoAvailable = !isPreview && (demo || !s.example);
  // Mientras se arma el respaldo o está abierta «Compartir» (un segundo toque la rechaza)
  const [busy, setBusy] = useState(false);
  // Apple Intelligence en este teléfono (en la web no hay)
  const [apple, setApple] = useState<AppleAIStatus | null>(null);
  useEffect(() => {
    if (isNative && !isPreview) void appleAIStatus().then(setApple);
  }, []);
  const share = async (blob: () => Blob | Promise<Blob | { blob: Blob; missing: number }>, fileName: string) => {
    setBusy(true);
    try {
      const made = await blob();
      const file = made instanceof Blob ? made : made.blob;
      if (!(await saveOrShare(file, fileName))) toast(NO_DOWNLOADS);
      // En un hogar, los archivos que este teléfono no tenía se bajan para el respaldo: los que no se pudieron, se dicen
      else if (!(made instanceof Blob) && made.missing > 0) {
        toast(`El respaldo no tiene ${made.missing === 1 ? 'el archivo de una factura' : `los archivos de ${made.missing} facturas`}: no se pudieron bajar`);
      }
    } catch (e) {
      console.error(e);
      toast('No se pudo exportar el archivo');
    } finally {
      setBusy(false);
    }
  };
  const learnedCount = Object.keys(s.learned).length;
  // Lo de este teléfono que «Borrar todo» también apaga
  const alsoOff = [device.lock.enabled && 'el bloqueo', device.reportReminder && 'el aviso del día 1'].filter((x): x is string => !!x);
  const forget = () => {
    const before = s.learned;
    updateSettings({ learned: {} });
    // Deshacer suma lo de antes a lo que se haya aprendido mientras tanto
    toast('Se olvidó lo aprendido', { label: 'Deshacer', run: () => update((d) => ({ ...d, settings: { ...d.settings, learned: { ...before, ...d.settings.learned } } })) });
  };

  return (
    <div>
      <PageHeader title="Ajustes" onBack={onBack} />
      <div className="space-y-5 px-4 pb-12">
        {/* En el modo demo, lo primero: cómo salir */}
        {demo && <DemoMode />}
        <Section title="Vos">
          <div>
            <label className="label" htmlFor={`${id}-nombre`}>Nombre</label>
            <input
              id={`${id}-nombre`}
              className="field"
              value={s.name}
              onChange={(e) => updateSettings({ name: e.target.value })}
              onBlur={() => {
                // En un hogar, también es el nombre con que te ven los demás
                const name = s.name.trim();
                const me = sync.members.find((m) => m.userId === sync.userId);
                if (!hh || !name || name === (me?.displayName ?? '')) return;
                hogar.setDisplayName(name).catch(() => toast('No se pudo cambiar tu nombre en el hogar: probá de nuevo con conexión'));
              }}
            />
            {hh && <p className="mt-1 text-[14px] text-muted">Así te ven en el hogar «{hh.name}».</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={`${id}-simbolo`}>Símbolo de la moneda</label>
              <input id={`${id}-simbolo`} className="field" value={s.currency.symbol} onChange={(e) => updateSettings({ currency: { ...s.currency, symbol: e.target.value.slice(0, 4) } })} />
            </div>
            <div>
              <label className="label" htmlFor={`${id}-decimales`}>Decimales</label>
              <select id={`${id}-decimales`} className="field" value={s.currency.decimals} onChange={(e) => updateSettings({ currency: { ...s.currency, decimals: Number(e.target.value) } })}>
                <option value={0}>Sin decimales</option>
                <option value={2}>Con 2 decimales</option>
              </select>
            </div>
          </div>
          {hh && <p className="text-[14px] text-muted">La moneda es la del hogar: si la cambiás, cambia para todos.</p>}
        </Section>

        {!isUsdSymbol(s.currency.symbol) && (
          <Section title="Dólar">
            <UsdToday />
          </Section>
        )}

        {/* En el modo demo no se muestra (se está mostrando la app a otra persona) */}
        {canLock && !demo && <Privacy />}
        <IntroSetting />

        <Section title="Facturas y rubros con IA">
          {apple && (
            <p className="flex gap-2 text-[16px]">
              <Smartphone size={18} className="mt-0.5 shrink-0 text-primary" />
              <span>Apple Intelligence: {APPLE_AI[apple]}</span>
            </p>
          )}
          <p className="flex gap-2 text-[16px] text-muted">
            <Sparkles size={18} className="mt-0.5 shrink-0 text-primary" />
            Sin esto, las facturas se leen en el teléfono (gratis y sin conexión). Con una clave de la API de Claude, la foto o el PDF se mandan a Anthropic y se lee mejor, sobre todo tickets arrugados y facturas largas; también sugiere el rubro de lo que Pengar todavía no reconoce, cuando Apple Intelligence no está o no sabe. Cada uso tiene un costo chico en tu cuenta de Anthropic.
          </p>
          {isPreview ? (
            <p className="rounded-2xl bg-sunken px-4 py-3 text-[16px]">
              En la vista previa web, la lectura con Claude no está disponible. Los PDF se leen igual, en el navegador; en la app de iPhone podés poner tu clave.
            </p>
          ) : demo ? (
            <p className="rounded-2xl bg-sunken px-4 py-3 text-[16px]">
              En el modo demo la clave de Claude no se usa ni se muestra: las facturas se leen en el teléfono.
            </p>
          ) : (
            <>
              <div>
                <label className="label" htmlFor={`${id}-clave`}>Clave de la API (console.anthropic.com)</label>
                <div className="flex gap-2">
                  <input
                    id={`${id}-clave`}
                    className="field flex-1"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder="sk-ant-…"
                    value={s.ai.apiKey}
                    onChange={(e) => updateSettings({ ai: { ...s.ai, apiKey: e.target.value.trim() } })}
                  />
                  <button className="btn-outline px-4" onClick={() => setShowKey(!showKey)}>{showKey ? 'Ocultar' : 'Ver'}</button>
                </div>
                <p className="mt-1 text-[14px] text-muted">Queda guardada solo en este teléfono y no va en los respaldos.</p>
              </div>
              <div>
                <label className="label" htmlFor={`${id}-modelo`}>Modelo</label>
                <select id={`${id}-modelo`} className="field" value={s.ai.model} onChange={(e) => updateSettings({ ai: { ...s.ai, model: e.target.value } })}>
                  {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            </>
          )}
          {learnedCount > 0 && (
            <button className="btn-ghost -ml-4" onClick={() => setForgetting(true)}>
              Olvidar los rubros aprendidos ({learnedCount})
            </button>
          )}
        </Section>

        {/* En el modo demo no se importa, ni se respalda, ni se restaura nada: son cosas de los datos de verdad */}
        {!demo && (
          <Section title="Importar">
            {importing ? (
              <ImportFlow mode="ask" compact onDone={() => { setImporting(false); toast('Planilla importada'); }} />
            ) : (
              <button className="btn-outline w-full" onClick={() => (paused ? setNotice('importar') : setImporting(true))}><Upload size={18} /> Importar una planilla</button>
            )}
            <ImportFormatHelp />
          </Section>
        )}

        {canAutoBackup && !demo && <AutoBackup />}

        {!demo && (
          <Section title="Exportar y respaldo">
            <button
              className="btn-outline w-full"
              disabled={busy}
              onClick={() => void share(() => new Blob(['﻿' + movementsCsv(data)], { type: 'text/csv' }), `pengar-movimientos-${today()}.csv`)}
            >
              <Download size={18} /> Movimientos en CSV (Excel)
            </button>
            <button
              className="btn-outline w-full"
              disabled={busy}
              onClick={() => void share(() => buildBackup(data, loadInvoiceFile), `pengar-respaldo-${today()}.json`)}
            >
              <Download size={18} /> {busy ? 'Preparando…' : 'Respaldo completo (con facturas)'}
            </button>
            <button className="btn-ghost w-full" onClick={() => (paused ? setNotice('restaurar') : restore.current?.click())}>Restaurar un respaldo…</button>
            <p className="text-[14px] text-muted">
              {canAutoBackup
                ? 'Además del automático, podés guardar un respaldo cuando quieras (en Archivos, iCloud Drive o por mail), por ejemplo para pasarlo a otro teléfono.'
                : 'Los datos viven solo en este teléfono. Guardá un respaldo de vez en cuando (en Archivos o iCloud Drive) por si lo cambiás o se pierde.'}
            </p>
            <input
              ref={restore}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  // Uno automático copiado a mano: sus fotos están aparte, en la carpeta de los automáticos
                  setBackup(await withArchives(await readBackup(f)));
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'No se pudo leer el respaldo');
                }
              }}
            />
          </Section>
        )}

        {demoAvailable && !demo && <DemoMode />}

        <Section title="Empezar de nuevo">
          {demo
            ? <button className="btn-ghost -ml-4" onClick={() => setRedoing(true)}>Rehacer los datos de demo</button>
            : <button className="btn-ghost -ml-4 text-danger" onClick={() => setWiping(true)}>Borrar todo</button>}
        </Section>
        <p className="text-center text-[14px] text-muted">Pengar · versión {__APP_VERSION__}</p>
      </div>
      {notice && paused && <PausedNotice name={paused.name} what={notice} onClose={() => setNotice(null)} />}
      {sheet}
      {backup && (
        <ConfirmSheet
          title="¿Restaurar el respaldo?"
          message={`Se reemplazan todos los datos de este teléfono por los del respaldo (${plural(backup.data.movements.length, 'movimiento', 'movimientos')}, ${plural(backup.data.invoices.length, 'factura', 'facturas')}).${sharedNote(hh)}`}
          confirmLabel="Restaurar"
          onConfirm={() => {
            void guard(() => {
              // Ya confirmado: en un hogar, la tanda que borra lo de antes no se frena (lib/sync)
              if (hh) hogar.allowBigDelete();
              // Los archivos del respaldo se guardan recién ahora (si se cancela, no queda nada)
              restoreBackup(backup, { ai: s.ai, onboarded: true }).then(
                () => toast('Respaldo restaurado'),
                (e) => {
                  console.error(e);
                  toast('No se pudo restaurar el respaldo');
                },
              );
            });
          }}
          onClose={() => setBackup(null)}
        />
      )}
      {forgetting && (
        <ConfirmSheet
          title="¿Olvidar lo aprendido?"
          message={`Se olvidan ${plural(learnedCount, 'comercio o palabra', 'comercios y palabras')} de las facturas y la tarjeta, también los que marcaste «No es un gasto». La próxima vez te los vuelve a preguntar.${hh ? ` Como estás en el hogar «${hh.name}», se olvidan en todos los teléfonos.` : ''}`}
          confirmLabel="Olvidar"
          danger
          onConfirm={forget}
          onClose={() => setForgetting(false)}
        />
      )}
      {redoing && (
        <ConfirmSheet
          title="¿Rehacer los datos de demo?"
          message="Lo que anotaste o cambiaste en el modo demo se va y se arman de nuevo los datos inventados, al día de hoy. Tus datos no se tocan."
          confirmLabel="Rehacer"
          onConfirm={() => {
            resetDemo().then(
              () => toast('Datos de demo nuevos'),
              (e) => {
                console.error(e);
                toast('No se pudieron rehacer los datos de demo');
              },
            );
          }}
          onClose={() => setRedoing(false)}
        />
      )}
      {wiping && (
        <ConfirmSheet
          title="¿Borrar todo?"
          message={`Se borran los movimientos, rubros, categorías, metas y facturas de este teléfono.${alsoOff.length ? ` También se ${alsoOff.length > 1 ? 'apagan' : 'apaga'} ${joinAnd(alsoOff)}.` : ''}${canAutoBackup && device.autoBackup.enabled ? ' Antes se guarda un respaldo automático con lo de ahora (los respaldos automáticos no se borran).' : canAutoBackup ? ' Los respaldos automáticos no se borran.' : ''}${hh ? ` En el hogar «${hh.name}» no se borra nada: cuando vuelvas a empezar, se bajan sus datos.` : ''}${hh && sync.pending > 0 ? ` Hay ${plural(sync.pending, 'cambio', 'cambios')} sin mandar al hogar: se manda${sync.pending > 1 ? 'n' : ''} antes si hay conexión; si no, se ${sync.pending > 1 ? 'pierden' : 'pierde'}.` : ''} No se puede deshacer.`}
          confirmLabel="Borrar todo"
          danger
          onConfirm={() => {
            void guard(() => {
              replaceAll(emptyData());
              // Como recién instalada: sin bloqueo ni aviso del día 1. El respaldo automático queda como está (con
              // cuándo fue el último: así no pisa el de hoy, que tiene los datos de antes), y la entrada también (es
              // solo cómo se ve al abrir)
              const { autoBackup: _same, demo: _real, intro: _keep, ...factory } = defaultDevice();
              updateDevice(factory);
            });
          }}
          onClose={() => setWiping(false)}
        />
      )}
    </div>
  );
}
