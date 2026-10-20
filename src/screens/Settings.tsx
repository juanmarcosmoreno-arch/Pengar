import { Download, Sparkles, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { ImportFlow, ImportFormatHelp } from '../components/ImportFlow';
import { PageHeader } from '../components/Sheet';
import { Segmented } from '../components/Toggle';
import { useToast } from '../components/Toast';
import { today } from '../domain/dates';
import { movementsCsv } from '../domain/export';
import { emptyData } from '../domain/template';
import { makeBackup, readBackup } from '../lib/backup';
import { saveOrShare } from '../lib/files';
import { getTheme, setTheme, type ThemeChoice } from '../lib/theme';
import { useStore } from '../store/store';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (la mejor lectura)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (más barato)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (el más barato)' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xl text-muted">{title}</h2>
      <div className="card space-y-3 p-4">{children}</div>
    </section>
  );
}

export function Settings({ onBack }: { onBack: () => void }) {
  const { data, updateSettings, replaceAll } = useStore();
  const toast = useToast();
  const s = data.settings;
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [importing, setImporting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const restore = useRef<HTMLInputElement>(null);

  return (
    <div>
      <PageHeader title="Ajustes" onBack={onBack} />
      <div className="space-y-5 px-4 pb-12">
        <Section title="Vos">
          <div>
            <label className="label">Nombre</label>
            <input className="field" value={s.name} onChange={(e) => updateSettings({ name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Símbolo de la moneda</label>
              <input className="field" value={s.currency.symbol} onChange={(e) => updateSettings({ currency: { ...s.currency, symbol: e.target.value.slice(0, 4) } })} />
            </div>
            <div>
              <label className="label">Decimales</label>
              <select className="field" value={s.currency.decimals} onChange={(e) => updateSettings({ currency: { ...s.currency, decimals: Number(e.target.value) } })}>
                <option value={0}>Sin decimales</option>
                <option value={2}>Con 2 decimales</option>
              </select>
            </div>
          </div>
          <div>
            <div className="label">Apariencia</div>
            <Segmented
              value={theme}
              onChange={(t) => { setThemeState(t); setTheme(t); }}
              options={[{ id: 'auto', label: 'Como el iPhone' }, { id: 'light', label: 'Clara' }, { id: 'dark', label: 'Oscura' }]}
            />
          </div>
        </Section>

        <Section title="Lectura de facturas con IA">
          <p className="flex gap-2 text-[16px] text-muted">
            <Sparkles size={18} className="mt-0.5 shrink-0 text-primary" />
            Sin esto, las facturas se leen en el teléfono (gratis y sin conexión). Con una clave de la API de Claude, la foto o el PDF se mandan a Anthropic y se lee mejor, sobre todo tickets arrugados y facturas largas. Cada lectura tiene un costo chico en tu cuenta de Anthropic.
          </p>
          <div>
            <label className="label">Clave de la API (console.anthropic.com)</label>
            <div className="flex gap-2">
              <input
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
            <label className="label">Modelo</label>
            <select className="field" value={s.ai.model} onChange={(e) => updateSettings({ ai: { ...s.ai, model: e.target.value } })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          {Object.keys(s.learned).length > 0 && (
            <button className="btn-ghost -ml-4" onClick={() => { updateSettings({ learned: {} }); toast('Listo: se olvidó lo aprendido'); }}>
              Olvidar lo aprendido de las facturas ({Object.keys(s.learned).length})
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
            onClick={() => saveOrShare(new Blob(['﻿' + movementsCsv(data)], { type: 'text/csv' }), `pengar-movimientos-${today()}.csv`)}
          >
            <Download size={18} /> Movimientos en CSV (Excel)
          </button>
          <button
            className="btn-outline w-full"
            onClick={async () => saveOrShare(await makeBackup(data), `pengar-respaldo-${today()}.json`)}
          >
            <Download size={18} /> Respaldo completo (con facturas)
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
                const d = await readBackup(f);
                if (confirm('Esto reemplaza todos los datos de este teléfono por los del respaldo. ¿Seguimos?')) {
                  replaceAll({ ...d, settings: { ...d.settings, ai: s.ai, onboarded: true } });
                  toast('Respaldo restaurado');
                }
              } catch (err) {
                toast(err instanceof Error ? err.message : 'No se pudo leer el respaldo');
              }
            }}
          />
        </Section>

        <Section title="Empezar de nuevo">
          <button
            className="btn-ghost -ml-4 text-danger"
            onClick={() => {
              if (confirm('¿Borrar todos los movimientos, rubros, categorías y metas de este teléfono? No se puede deshacer.')) replaceAll(emptyData());
            }}
          >
            Borrar todo
          </button>
        </Section>
        <p className="text-center text-[14px] text-muted">Pengar · versión {__APP_VERSION__}</p>
      </div>
    </div>
  );
}
