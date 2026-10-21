import { useState } from 'react';
import { emptyData } from '../domain/template';
import { useSync } from '../lib/sync';
import { useStore } from '../store/store';
import { ConfirmSheet } from './ConfirmSheet';
import { Suricata } from './Suricata';

/** Aviso de que son los datos de ejemplo, con la salida para empezar con los propios (vuelve a la bienvenida) */
export function ExampleBanner({ className = '' }: { className?: string }) {
  const { data, replaceAll } = useStore();
  // En un hogar compartido, el ejemplo no lo tocó: al volver a empezar se bajan sus datos
  const { household, phase } = useSync();
  const [asking, setAsking] = useState(false);
  if (!data.settings.example) return null;
  return (
    <>
      <section className={`card flex items-center gap-3 border-primary/40 bg-soft/20 px-4 py-3 ${className}`}>
        <Suricata pose="cara-curioso" size={52} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[16px] leading-snug">Estás viendo datos de ejemplo (inventados).</p>
          <button className="chip mt-1.5 border-primary/60 text-primary" onClick={() => setAsking(true)}>Empezar con los míos</button>
        </div>
      </section>
      {asking && (
        <ConfirmSheet
          title="¿Empezar con tus datos?"
          message={household && phase !== 'removed'
            ? `Se borran los datos de ejemplo y volvés a la bienvenida. Seguís en el hogar «${household.name}»: al empezar, vuelven sus datos.`
            : 'Se borran los datos de ejemplo y volvés a la bienvenida para cargar tu planilla o empezar de cero.'}
          confirmLabel="Empezar"
          onConfirm={() => {
            // La clave de Claude no es parte del ejemplo: queda
            const e = emptyData();
            replaceAll({ ...e, settings: { ...e.settings, ai: data.settings.ai } });
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}
