export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    // Toda la fila se toca (44 px de alto), no solo el interruptor
    <label className="inline-flex min-h-tap cursor-pointer items-center gap-2 text-[16px]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full border transition ${checked ? 'border-primary bg-primary' : 'border-ink/60 bg-line'}`}
      >
        <span className={`absolute top-[1px] h-6 w-6 rounded-full bg-white shadow transition-all ${checked ? 'left-[21px]' : 'left-[1px]'}`} />
      </button>
      {label}
    </label>
  );
}

/** `label`: nombre del grupo para el lector de pantalla, si no hay un título que lo diga */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="flex rounded-full bg-sunken p-1" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          className={`tap-area relative flex-1 rounded-full py-1.5 text-[17px] ${value === o.id ? 'bg-surface shadow-sm' : 'text-muted'}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
