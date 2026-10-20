/** Modelo de datos de Pengar. Todo vive en el teléfono (IndexedDB); los montos son números en la moneda elegida. */

export type Kind = 'gasto' | 'ingreso';

/** Presupuesto mensual de una categoría: un monto fijo o un porcentaje de lo que entra en el mes. */
export type Budget =
  | { type: 'none' }
  | { type: 'fixed'; amount: number }
  | { type: 'percentIncome'; pct: number };

/** Agrupación grande (Alimentación, Transporte…). Cada rubro pertenece a una. */
export interface Category {
  id: string;
  name: string;
  /** Letra corta de la planilla (A, F, ST…). Opcional: sirve para importar */
  code?: string;
  kind: Kind;
  /** Nombre del ícono (ver lib/icons) */
  icon: string;
  /** Color de la categoría en las gráficas (hex) */
  color: string;
  budget: Budget;
  /** Cuenta como ahorro/inversión: se puede sacar de los gastos con «Incluir ahorro» */
  savings?: boolean;
  order: number;
}

/** Concepto concreto (UTE, Netflix, Feria…). Es lo que se elige al anotar un gasto. */
export interface Rubro {
  id: string;
  name: string;
  categoryId: string;
  /** Palabras que, si aparecen en una factura, la asignan a este rubro */
  keywords: string[];
  archived?: boolean;
}

export type Origin = 'manual' | 'factura' | 'planilla';

export interface Movement {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** Siempre positivo; el signo lo da `kind` */
  amount: number;
  kind: Kind;
  rubroId: string;
  note?: string;
  merchant?: string;
  invoiceId?: string;
  origin: Origin;
  /** Total de un mes entero (importado de la planilla, sin días) */
  monthly?: boolean;
  createdAt: number;
}

export interface InvoiceItem {
  description: string;
  amount: number;
  rubroId?: string;
}

/** Factura o ticket guardado. El archivo (foto o PDF) se guarda aparte, con la clave `file:<id>`. */
export interface Invoice {
  id: string;
  fileName: string;
  mime: string;
  merchant?: string;
  date?: string;
  total?: number;
  items: InvoiceItem[];
  createdAt: number;
}

export interface Goal {
  id: string;
  name: string;
  icon: string;
  target: number;
  saved: number;
}

/** Gasto o ingreso que se repite todos los meses (alquiler, UTE, el sueldo). El monto es una estimación. */
export interface Recurring {
  id: string;
  rubroId: string;
  kind: Kind;
  amount: number;
  /** Día del mes 1..28 */
  day: number;
  note?: string;
  paused?: boolean;
  /** Último mes YYYY-MM ya anotado o salteado */
  doneThrough?: string;
  createdAt: number;
}

export interface Settings {
  name: string;
  currency: {
    symbol: string;
    /** Separadores: «es-UY» → 1.234,50 */
    locale: string;
    decimals: number;
  };
  ai: {
    /** Clave de la API de Claude (opcional): mejora la lectura de facturas. Queda solo en el teléfono */
    apiKey: string;
    model: string;
  };
  /** Rubro que se aprendió para un comercio o una palabra de factura (texto normalizado → rubroId) */
  learned: Record<string, string>;
  onboarded: boolean;
  /** Son los datos de ejemplo (inventados): Inicio y Más muestran un aviso para empezar con los propios */
  example?: boolean;
}

export interface Data {
  version: 1;
  categories: Category[];
  rubros: Rubro[];
  movements: Movement[];
  invoices: Invoice[];
  goals: Goal[];
  recurring: Recurring[];
  settings: Settings;
}
