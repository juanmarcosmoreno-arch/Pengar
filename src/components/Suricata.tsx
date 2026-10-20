/**
 * El suricata de Pengar, dibujado a lápiz. Cada pose es un recorte de docs/marca (ver scripts/suricata.py).
 * Poses de cuerpo entero para estados vacíos y pantallas; caras («cara-…») para reaccionar a los números.
 */
const files = import.meta.glob<string>('../assets/suricata/*.webp', { eager: true, query: '?url', import: 'default' });

export type Pose =
  | 'principal' | 'saludando' | 'contento' | 'ahorrando' | 'pensando' | 'calculadora' | 'lista' | 'organizando'
  | 'analizando' | 'metas' | 'compras' | 'transportes' | 'casa' | 'celebrando'
  | 'cara-normal' | 'cara-feliz' | 'cara-sorprendido' | 'cara-pensando' | 'cara-preocupado' | 'cara-decidido'
  | 'cara-triste' | 'cara-entusiasmado' | 'cara-curioso';

export function Suricata({ pose, size = 120, className = '', alt = '' }: { pose: Pose; size?: number; className?: string; alt?: string }) {
  const src = files[`../assets/suricata/${pose}.webp`];
  if (!src) return null;
  return <img src={src} alt={alt} draggable={false} className={`pointer-events-none select-none object-contain ${className}`} style={{ height: size, width: 'auto' }} />;
}

/** Estado vacío: el suricata con un texto debajo */
export function EmptyState({ pose, title, children }: { pose: Pose; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      <Suricata pose={pose} size={150} />
      <p className="mt-3 text-xl">{title}</p>
      {children && <div className="mt-1 text-muted">{children}</div>}
    </div>
  );
}
