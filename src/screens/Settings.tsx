import { Download, Smartphone, Sparkles, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { ImportFlow, ImportFormatHelp } from '../components/ImportFlow';
import { PageHeader } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { today } from '../domain/dates';
import { movementsCsv } from '../domain/export';
import { emptyData } from '../domain/template';
import { plural } from '../domain/text';
import { appleAIStatus, type AppleAIStatus } from '../lib/appleAI';
import { makeBackup, readBackup, type ReadBackup } from '../lib/backup';
import { NO_DOWNLOADS, saveOrShare } from '../lib/files';
import { isNative, isPreview } from '../lib/platform';
import { useStore } from '../store/store';

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xl text-muted">{title}</h2>
      <div className="card space-y-3 p-4">{children}</div>
    </section>
  );
}

export function Settings({ onBack }: { onBack: () => void }) {
  const { data, update, updateSettings, replaceAll, restoreBackup } = useStore();
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
  // Mientras se arma el respaldo o está abierta «Compartir» (un segundo toque la rechaza)
  const [busy, setBusy] = useState(false);
  // Apple Intelligence en este teléfono (en la web no hay)
  const [apple, setApple] = useState<AppleAIStatus | null>(null);
  useEffect(() => {
    if (isNative && !isPreview) void appleAIStatus().then(setApple);
  }, []);
  const share = async (blob: () => Blob | Promise<Blob>, fileName: string) => {
    setBusy(true);
    try {
      if (!(await saveOrShare(await blob(), fileName))) toast(NO_DOWNLOADS);
    } catch (e) {
      console.error(e);
      toast('No se pudo exportar el archivo');
    } finally {
      setBusy(false);
    }
  };
  const learnedCount = Object.keys(s.learned).length;
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
        <Section title="Vos">
          <div>
            <label className="label" htmlFor={`${id}-nombre`}>Nombre</label>
            <input id={`${id}-nombre`} className="field" value={s.name} onChange={(e) => updateSettings({ name: e.target.value })} />
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
        </Section>

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

        <Section title="Importar">
          {importing ? (
            <ImportFlow mode="ask" compact onDone={() => { setImporting(false); toast('Planilla importada'); }} />
          ) : (
            <button className="btn-outline w-full" onClick={() => setImporting(true)}><Upload size={18} /> Importar una planilla</button>
          )}
          <ImportFormatHelp />
        </Section>

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
            onClick={() => void share(() => makeBackup(data), `pengar-respaldo-${today()}.json`)}
          >
            <Download size={18} /> {busy ? 'Preparando…' : 'Respaldo completo (con facturas)'}
          </button>
          <button className="btn-ghost w-full" onClick={() => restore.current?.click()}>Restaurar un respaldo…</button>
          <p className="text-[14px] text-muted">Los datos viven solo en este teléfono. Guardá un respaldo de vez en cuando (en Archivos o iCloud Drive) por si lo cambiás o se pierde.</p>
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
                setBackup(await readBackup(f));
              } catch (err) {
                toast(err instanceof Error ? err.message : 'No se pudo leer el respaldo');
              }
            }}
          />
        </Section>

        <Section title="Empezar de nuevo">
          <button className="btn-ghost -ml-4 text-danger" onClick={() => setWiping(true)}>Borrar todo</button>
        </Section>
        <p className="text-center text-[14px] text-muted">Pengar · versión {__APP_VERSION__}</p>
      </div>
      {backup && (
        <ConfirmSheet
          title="¿Restaurar el respaldo?"
          message={`Se reemplazan todos los datos de este teléfono por los del respaldo (${plural(backup.data.movements.length, 'movimiento', 'movimientos')}, ${plural(backup.data.invoices.length, 'factura', 'facturas')}).`}
          confirmLabel="Restaurar"
          onConfirm={() => {
            // Los archivos del respaldo se guardan recién ahora (si se cancela, no queda nada)
            restoreBackup(backup, { ai: s.ai, onboarded: true }).then(
              () => toast('Respaldo restaurado'),
              (e) => {
                console.error(e);
                toast('No se pudo restaurar el respaldo');
              },
            );
          }}
          onClose={() => setBackup(null)}
        />
      )}
      {forgetting && (
        <ConfirmSheet
          title="¿Olvidar lo aprendido?"
          message={`Se olvidan ${plural(learnedCount, 'comercio o palabra', 'comercios y palabras')} de las facturas y la tarjeta, también los que marcaste «No es un gasto». La próxima vez te los vuelve a preguntar.`}
          confirmLabel="Olvidar"
          danger
          onConfirm={forget}
          onClose={() => setForgetting(false)}
        />
      )}
      {wiping && (
        <ConfirmSheet
          title="¿Borrar todo?"
          message="Se borran los movimientos, rubros, categorías, metas y facturas de este teléfono. No se puede deshacer."
          confirmLabel="Borrar todo"
          danger
          onConfirm={() => replaceAll(emptyData())}
          onClose={() => setWiping(false)}
        />
      )}
    </div>
  );
}
