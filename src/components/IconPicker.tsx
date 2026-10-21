import { ICON_CHOICES } from '../domain/template';
import { artUrl, Icon, iconLabel } from './Icon';

const ART_CHOICES = ICON_CHOICES.filter((n) => n.startsWith('m:'));
const LINE_CHOICES = ICON_CHOICES.filter((n) => !n.startsWith('m:'));

/** Elegir el ícono de una categoría o una meta: los dibujos grandes, de a cuatro, para que se distingan; abajo los íconos simples */
export function IconPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const look = (name: string) => (value === name ? 'border-primary bg-soft/40 ring-2 ring-primary' : 'border-line bg-surface');
  return (
    <div role="group" aria-label="Ícono">
      <div className="grid grid-cols-4 gap-2">
        {ART_CHOICES.map((name) => (
          <button
            key={name}
            type="button"
            className={`flex aspect-square items-center justify-center rounded-2xl border ${look(name)}`}
            onClick={() => onChange(name)}
            aria-label={iconLabel(name)}
            aria-pressed={value === name}
          >
            <img src={artUrl(name)} alt="" draggable={false} loading="lazy" className="h-[84%] w-[84%]" />
          </button>
        ))}
      </div>
      <div className="mb-2 mt-4 text-sm text-muted">Íconos simples</div>
      <div className="grid grid-cols-6 gap-2">
        {LINE_CHOICES.map((name) => (
          <button
            key={name}
            type="button"
            className={`flex h-12 items-center justify-center rounded-2xl border ${look(name)}`}
            onClick={() => onChange(name)}
            aria-label={iconLabel(name)}
            aria-pressed={value === name}
          >
            <Icon name={name} size={24} />
          </button>
        ))}
      </div>
    </div>
  );
}
