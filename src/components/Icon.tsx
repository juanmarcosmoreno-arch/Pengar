import {
  Baby, BookOpen, Briefcase, Bus, Car, Coffee, Coins, Droplet, Dumbbell, Ellipsis, Flame, Fuel, Gift, GraduationCap, HandHeart,
  Heart, House, Landmark, Music, PawPrint, PiggyBank, Pill, Plane, Receipt, Shirt, ShoppingCart, Smartphone, Sofa, Sparkles, Tag,
  Target, TreePalm, Tv, Utensils, Wifi, Wrench, Zap, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  cart: ShoppingCart, home: House, car: Car, fuel: Fuel, bus: Bus, heart: Heart, pill: Pill, graduation: GraduationCap,
  book: BookOpen, sparkles: Sparkles, wrench: Wrench, sofa: Sofa, shirt: Shirt, tv: Tv, music: Music, wifi: Wifi,
  phone: Smartphone, zap: Zap, droplet: Droplet, flame: Flame, utensils: Utensils, coffee: Coffee, plane: Plane, palm: TreePalm,
  gift: Gift, 'hand-heart': HandHeart, paw: PawPrint, baby: Baby, dumbbell: Dumbbell, piggy: PiggyBank, coins: Coins,
  briefcase: Briefcase, landmark: Landmark, receipt: Receipt, tag: Tag, target: Target, more: Ellipsis,
};

/** Ilustraciones del suricata (categorías): «m:super», «m:salud»… */
const ART = import.meta.glob<string>('../assets/suricata/cat/*.webp', { eager: true, query: '?url', import: 'default' });
const artUrl = (name: string) => (name.startsWith('m:') ? ART[`../assets/suricata/cat/${name.slice(2)}.webp`] : undefined);

export function Icon({ name, size = 22, className, strokeWidth = 1.75 }: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  const art = artUrl(name);
  // En renglones chicos la ilustración se ve un poco más grande que un ícono de línea, para que se distinga
  if (art) return <img src={art} alt="" draggable={false} className={`inline-block shrink-0 ${className ?? ''}`} style={{ width: size * 1.4, height: size * 1.4 }} />;
  const C = ICONS[name] ?? Tag;
  return <C size={size} className={className} strokeWidth={strokeWidth} aria-hidden />;
}

/** Ícono de categoría en un círculo con su color suave de fondo (como en el boceto) */
export function CategoryBubble({ icon, color, size = 44 }: { icon: string; color: string; size?: number }) {
  const art = artUrl(icon);
  if (art) {
    // La ilustración ya trae su círculo de color; el aro fino es el color de la categoría (el de las gráficas)
    return (
      <img
        src={art}
        alt=""
        draggable={false}
        className="inline-block shrink-0 rounded-full"
        style={{ width: size, height: size, boxShadow: `0 0 0 2px ${color}AA` }}
      />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-ink"
      style={{ width: size, height: size, background: `${color}26`, boxShadow: `inset 0 0 0 1.5px ${color}55` }}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </span>
  );
}
