import type { Category, Data, Rubro, Settings } from './types';
import { DEFAULT_CURRENCY } from './money';

/**
 * Colores de las categorías, en orden fijo (validados para daltonismo y para distinguirse entre vecinos).
 * Pasadas las ocho categorías más grandes, las gráficas juntan el resto en «Otras» (gris).
 */
export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const OTHER_COLOR = '#8A9894';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export function defaultSettings(): Settings {
  return {
    name: '',
    currency: { ...DEFAULT_CURRENCY },
    ai: { apiKey: '', model: DEFAULT_MODEL },
    learned: {},
    onboarded: false,
  };
}

interface TemplateCategory {
  code: string;
  name: string;
  icon: string;
  kind?: 'ingreso';
  budget?: number;
  savings?: boolean;
  rubros: [string, string[]][];
}

/**
 * Categorías y rubros sugeridos para empezar de cero. Son un punto de partida: todo se puede renombrar,
 * borrar o agregar en Más → Categorías y rubros. Las palabras clave asignan las facturas solas.
 */
const TEMPLATE: TemplateCategory[] = [
  { code: 'A', name: 'Alimentación', icon: 'm:super', rubros: [
    ['Supermercado', ['super', 'tienda inglesa', 'disco', 'devoto', 'geant', 'tata', 'macromercado', 'el dorado', 'frigo', 'almacen', 'kinko']],
    ['Feria', ['feria', 'verduleria', 'fruteria']],
    ['Carnicería', ['carniceria', 'carne', 'pollo']],
    ['Panadería', ['panaderia', 'pan ', 'confiteria']],
  ] },
  { code: 'F', name: 'Fijos', icon: 'm:servicios', rubros: [
    ['Alquiler', ['alquiler', 'inmobiliaria', 'gastos comunes']],
    ['Luz', ['ute', 'energia electrica']],
    ['Agua', ['ose', 'agua']],
    ['Teléfono e internet', ['antel', 'claro', 'movistar', 'fibra']],
  ] },
  { code: 'T', name: 'Transporte', icon: 'm:mant-auto', rubros: [
    ['Combustible', ['ancap', 'axion', 'petrobras', 'nafta', 'gasoil', 'combustible', 'disa']],
    ['Mantenimiento del auto', ['taller', 'service', 'neumatico', 'gomeria', 'lavadero']],
    ['Seguro y patente', ['seguro', 'patente', 'sucive', 'bse', 'mapfre', 'sura', 'porto']],
    ['Ómnibus y taxi', ['cutcsa', 'stm', 'uber', 'cabify', 'taxi']],
  ] },
  { code: 'S', name: 'Salud', icon: 'm:salud', rubros: [
    ['Mutualista y emergencia', ['mutualista', 'emergencia', 'semm', 'ucm', 'sms', 'medica uruguaya', 'casmu', 'smi', 'cosem']],
    ['Farmacia', ['farmacia', 'farmashop', 'san roque', 'medicamento']],
  ] },
  { code: 'E', name: 'Educación', icon: 'm:educacion', rubros: [
    ['Colegio y cursos', ['colegio', 'escuela', 'liceo', 'universidad', 'curso', 'cuota']],
    ['Librería', ['libreria', 'papeleria', 'cuaderno']],
    ['Club y deportes', ['club', 'gimnasio', 'gym']],
  ] },
  { code: 'H', name: 'Limpieza', icon: 'm:limpieza', rubros: [
    ['Artículos de limpieza', ['limpieza', 'detergente', 'lavandina', 'jabon']],
  ] },
  { code: 'M', name: 'Mantenimiento', icon: 'm:mant-casa', rubros: [
    ['Arreglos de la casa', ['ferreteria', 'sodimac', 'pintureria', 'barraca', 'plomero', 'electricista']],
  ] },
  { code: 'B', name: 'Bienes de uso', icon: 'm:tecnologia', rubros: [
    ['Compras online', ['mercado libre', 'mercadolibre', 'amazon', 'temu', 'shein']],
    ['Electrodomésticos y muebles', ['electrodomestico', 'mueble', 'motociclo', 'divino']],
  ] },
  { code: 'V', name: 'Vestimenta', icon: 'm:ropa', rubros: [
    ['Ropa y calzado', ['ropa', 'zapateria', 'calzado', 'zara', 'indian', 'renner']],
  ] },
  { code: 'ST', name: 'Suscripciones', icon: 'm:entretenimiento', rubros: [
    ['Streaming', ['netflix', 'spotify', 'hbo', 'max', 'disney', 'prime video', 'youtube', 'apple']],
  ] },
  { code: 'X', name: 'Salidas y extras', icon: 'm:salidas', rubros: [
    ['Comer afuera', ['restaurante', 'restaurant', 'parrilla', 'pizzeria', 'cafe', 'bar ', 'pedidosya', 'rappi']],
    ['Paseos y viajes', ['hotel', 'pasaje', 'booking', 'airbnb', 'cine', 'entrada']],
    ['Regalos', ['regalo', 'jugueteria']],
  ] },
  { code: 'O', name: 'Otros', icon: 'm:otros', rubros: [
    ['Varios', []],
  ] },
  { code: 'I', name: 'Ahorro e inversión', icon: 'm:ahorro', savings: true, rubros: [
    ['Ahorro', ['ahorro', 'plazo fijo', 'inversion']],
  ] },
  { code: 'IN', name: 'Ingresos', icon: 'm:inversiones', kind: 'ingreso', rubros: [
    ['Sueldo', ['sueldo', 'salario', 'haberes']],
    ['Otros ingresos', []],
  ] },
];

let counter = 0;
export function newId(prefix = ''): string {
  counter = (counter + 1) % 1e6;
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

/** Rubros sugeridos con sus palabras clave (para completar los rubros de una planilla importada) */
export function templateKeywords(): { name: string; keywords: string[] }[] {
  return TEMPLATE.flatMap((t) => t.rubros.map(([name, keywords]) => ({ name, keywords })));
}

export function templateData(): Pick<Data, 'categories' | 'rubros'> {
  const categories: Category[] = [];
  const rubros: Rubro[] = [];
  let expenseIndex = 0;
  TEMPLATE.forEach((t, order) => {
    const id = newId('c');
    const isIncome = t.kind === 'ingreso';
    categories.push({
      id,
      name: t.name,
      code: t.code,
      kind: isIncome ? 'ingreso' : 'gasto',
      icon: t.icon,
      color: isIncome ? '#176B60' : t.code === 'O' ? OTHER_COLOR : PALETTE[expenseIndex++ % PALETTE.length],
      budget: t.budget ? { type: 'fixed', amount: t.budget } : { type: 'none' },
      savings: t.savings,
      order,
    });
    for (const [name, keywords] of t.rubros) rubros.push({ id: newId('r'), name, categoryId: id, keywords });
  });
  return { categories, rubros };
}

export function emptyData(): Data {
  return { version: 1, categories: [], rubros: [], movements: [], invoices: [], goals: [], settings: defaultSettings() };
}

/**
 * Ilustraciones del suricata para las categorías (src/assets/suricata/cat). En los datos van como «m:nombre».
 */
export const ART: [string, string][] = [
  ['super', 'Compras del súper'], ['comida', 'Comida'], ['restaurantes', 'Restaurantes'], ['salidas', 'Salidas y ocio'],
  ['servicios', 'Servicios'], ['vivienda', 'Vivienda / alquiler'], ['mant-casa', 'Mantenimiento de la casa'], ['hogar', 'Hogar y decoración'],
  ['limpieza', 'Limpieza'], ['jardin', 'Jardín'], ['mant-auto', 'Auto'], ['viajes', 'Viajes'], ['salud', 'Salud'], ['deporte', 'Deporte'],
  ['educacion', 'Educación'], ['libros', 'Libros y cultura'], ['ropa', 'Ropa'], ['regalos', 'Regalos'], ['entretenimiento', 'Entretenimiento'],
  ['telefonia', 'Telefonía e internet'], ['tecnologia', 'Tecnología'], ['mascotas', 'Mascotas'], ['familia', 'Hijos / familia'],
  ['seguros', 'Seguros'], ['ahorro', 'Ahorro'], ['inversiones', 'Inversiones'], ['otros', 'Otros'], ['imprevistos', 'Imprevistos'],
];

/** Íconos de línea de versiones anteriores → ilustración equivalente (los que no tienen equivalente quedan igual) */
export const LEGACY_ICON_TO_ART: Record<string, string> = {
  cart: 'm:super', home: 'm:vivienda', car: 'm:mant-auto', fuel: 'm:mant-auto', heart: 'm:salud', pill: 'm:salud',
  graduation: 'm:educacion', book: 'm:libros', sparkles: 'm:limpieza', wrench: 'm:mant-casa', sofa: 'm:hogar', shirt: 'm:ropa',
  tv: 'm:entretenimiento', music: 'm:entretenimiento', wifi: 'm:telefonia', phone: 'm:telefonia', zap: 'm:servicios',
  droplet: 'm:servicios', flame: 'm:servicios', utensils: 'm:restaurantes', coffee: 'm:restaurantes', plane: 'm:viajes',
  palm: 'm:viajes', gift: 'm:regalos', paw: 'm:mascotas', baby: 'm:familia', dumbbell: 'm:deporte', piggy: 'm:ahorro',
  coins: 'm:inversiones', tag: 'm:otros',
};

/** Íconos que se pueden elegir para una categoría o una meta: primero las ilustraciones, después los de línea */
export const ICON_CHOICES = [
  ...ART.map(([n]) => `m:${n}`),
  'cart', 'home', 'car', 'fuel', 'bus', 'heart', 'pill', 'graduation', 'book', 'sparkles', 'wrench', 'sofa', 'shirt',
  'tv', 'music', 'wifi', 'phone', 'zap', 'droplet', 'flame', 'utensils', 'coffee', 'plane', 'palm', 'gift', 'hand-heart',
  'paw', 'baby', 'dumbbell', 'piggy', 'coins', 'briefcase', 'landmark', 'receipt', 'tag', 'target',
];
