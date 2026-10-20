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

/** Movimientos sutiles hechos con CSS (index.css). Si llegan animaciones cuadro a cuadro, se cambian acá y en el render. */
export type Motion = 'breathe' | 'wave' | 'hop' | 'sway';
const MOTION: Record<Motion, string> = {
  breathe: 'suricata-breathe', // respira, quieto
  wave: 'suricata-wave', // se balancea al saludar (dos veces)
  hop: 'suricata-hop', // saltito de festejo (dos veces)
  sway: 'suricata-sway', // se mece mientras trabaja
};

/** `flip`: que mire para el otro lado (hacia la izquierda). `className` va al envoltorio (posición, márgenes). */
export function Suricata({ pose, size = 120, className = '', alt = '', flip = false, motion }: { pose: Pose; size?: number; className?: string; alt?: string; flip?: boolean; motion?: Motion }) {
  const src = files[`../assets/suricata/${pose}.webp`];
  if (!src) return null;
  // El movimiento va en el envoltorio y el volteo en la imagen: los dos usan transform.
  // max-w-none: con el max-width:100% de Tailwind el envoltorio se achica en filas con texto largo.
  return (
    <span className={`pointer-events-none inline-block select-none ${motion ? MOTION[motion] : ''} ${className}`}>
      <img src={src} alt={alt} draggable={false} className="block max-w-none object-contain" style={{ height: size, width: 'auto', transform: flip ? 'scaleX(-1)' : undefined }} />
    </span>
  );
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
