/** Dibujos de línea, en el estilo del boceto (lápiz verde) */

export function Landscape({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 120" className={className} fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M0 78 C40 60 70 58 110 70 C150 82 180 62 220 56 C260 50 290 60 320 66 V120 H0Z" fill="#7FC4AC" fillOpacity="0.28" />
      <path d="M0 96 C50 82 100 84 150 92 C200 100 250 86 320 84 V120 H0Z" fill="#7FC4AC" fillOpacity="0.45" />
      <path d="M0 78 C40 60 70 58 110 70 C150 82 180 62 220 56 C260 50 290 60 320 66" stroke="#176B60" strokeOpacity="0.55" strokeWidth="1.5" />
      <path d="M0 96 C50 82 100 84 150 92 C200 100 250 86 320 84" stroke="#176B60" strokeOpacity="0.6" strokeWidth="1.5" />
      <path d="M20 104 C60 98 90 101 120 106 M170 108 C210 102 250 104 300 100" stroke="#176B60" strokeOpacity="0.35" strokeWidth="1.2" />
      {/* árboles */}
      <g stroke="#176B60" strokeWidth="1.6">
        <path d="M38 90 V62 M38 62 L28 80 H48 Z M38 54 L30 70 H46 Z" fill="#176B60" fillOpacity="0.55" />
        <path d="M58 88 V70 M58 66 L51 80 H65 Z M58 60 L53 72 H63 Z" fill="#176B60" fillOpacity="0.4" />
        <path d="M284 80 V52 M284 50 L274 68 H294 Z M284 42 L276 58 H292 Z" fill="#176B60" fillOpacity="0.55" />
        <path d="M302 78 V62 M302 58 L296 70 H308 Z" fill="#176B60" fillOpacity="0.4" />
      </g>
      {/* casita */}
      <g stroke="#22302C" strokeOpacity="0.75" strokeWidth="1.4">
        <path d="M196 66 V52 L208 43 L220 52 V66 Z" fill="#F5F3EE" />
        <path d="M193 54 L208 41 L223 54" />
        <path d="M205 66 V58 H211 V66" />
      </g>
      <path d="M248 30 c4 -3 8 -3 12 0 M262 26 c3 -2 6 -2 9 0" stroke="#22302C" strokeOpacity="0.5" strokeWidth="1.2" />
    </svg>
  );
}

export function Sprout({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 80" className={className} fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 72 C24 68 56 68 72 72" stroke="#8A9894" strokeWidth="1.5" />
      <path d="M40 70 C40 56 41 44 44 34" stroke="#176B60" strokeWidth="2" />
      <path d="M43 38 C46 22 58 12 74 10 C72 28 60 38 43 38 Z" fill="#7FC4AC" fillOpacity="0.6" stroke="#176B60" strokeWidth="1.6" />
      <path d="M46 35 C54 28 62 20 70 14" stroke="#176B60" strokeWidth="1" />
      <path d="M41 50 C34 38 22 34 10 36 C14 48 26 54 41 50 Z" fill="#7FC4AC" fillOpacity="0.45" stroke="#176B60" strokeWidth="1.6" />
      <path d="M38 48 C30 44 22 40 14 38" stroke="#176B60" strokeWidth="1" />
    </svg>
  );
}
