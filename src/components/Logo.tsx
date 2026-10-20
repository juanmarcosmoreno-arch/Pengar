/** La «P» de Pengar: el trazo vertical es un tallo y el ojo de la P, una hoja con su nervadura. */
export function LogoMark({ size = 64, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden>
      <path d="M30 90 C28 70 28 42 30 24" fill="none" stroke="#176B60" strokeWidth="16" strokeLinecap="round" />
      <path d="M24 26 C30 10 52 6 68 10 C86 15 92 34 82 50 C72 65 50 68 34 60 C28 57 25 50 26 42 Z" fill="#176B60" />
      <path d="M36 54 C48 46 60 34 72 20" fill="none" stroke="#F5F3EE" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}
