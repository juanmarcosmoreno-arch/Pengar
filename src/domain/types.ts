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
  /**
   * Cuenta corriente de una categoría en % del ingreso (el diezmo): desde qué mes se suma lo que faltó o sobró, y el
   * saldo de antes (positivo: lo que faltaba dar). Sin esto, se cuenta desde el primer mes con datos y saldo 0
   */
  ledger?: { from: string; opening: number };
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

/** De dónde salió: anotado a mano, de una factura, de la planilla o del estado de cuenta de la tarjeta */
export type Origin = 'manual' | 'factura' | 'planilla' | 'tarjeta';

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
  /** En un hogar compartido: quién lo anotó (id de usuario de Supabase). Lo pone lib/sync al mandarlo */
  createdBy?: string;
}

export interface InvoiceItem {
  description: string;
  amount: number;
  rubroId?: string;
  /** Fecha de la compra (en los estados de cuenta) */
  date?: string;
}

/**
 * Factura, ticket o estado de cuenta de la tarjeta guardado. El archivo (foto, PDF o planilla) se guarda aparte,
 * con la clave `file:<id>`.
 */
export interface Invoice {
  id: string;
  /** Sin valor es una factura (los datos de antes) */
  kind?: 'factura' | 'estado';
  /** Tarjeta del estado de cuenta («OCA», «Visa BROU») */
  card?: string;
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
  /** Los meses (YYYY-MM) que se saltearon con «Saltar» (para el resumen: no es lo mismo que olvidarse) */
  skipped?: string[];
  createdAt: number;
}

/**
 * Ajustes que van con los datos (y en los respaldos). Los que son solo de este teléfono (el bloqueo con Face ID, el
 * aviso del día 1) están en lib/device.ts. En un hogar compartido se comparten la moneda, lo aprendido y la última
 * cotización escrita; `name`, `ai`, `onboarded`, `example`, `demo` y `lastReportSeen` quedan en cada teléfono (domain/sync.ts).
 */
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
  /**
   * Son los datos del modo demo (inventados, guardados aparte de los de verdad: domain/demo, lib/device). No se
   * sincronizan ni se respaldan nunca
   */
  demo?: boolean;
  /** Última cotización del dólar escrita a mano en el estado de cuenta (si no hay conexión con el BCU, se ofrece) */
  usdRate?: number;
  /** Último resumen del mes abierto (YYYY-MM): hasta abrir el del mes pasado, Inicio lo ofrece */
  lastReportSeen?: string;
  /** Ajustes del hogar que trajo una versión más nueva de la app y esta no conoce: se guardan y se mandan tal cual */
  sharedExtra?: Record<string, unknown>;
}

export interface Data {
  /** 2: íconos ya migrados (ver normalizeData) */
  version: 2;
  /**
   * De qué datos se trata: cambia con «Borrar todo» y con el ejemplo (emptyData); restaurar y la planilla lo conservan.
   * En un hogar compartido, si no es el de lo sincronizado, se bajan los datos del hogar (lib/sync). No se comparte
   */
  datasetId?: string;
  categories: Category[];
  rubros: Rubro[];
  movements: Movement[];
  invoices: Invoice[];
  goals: Goal[];
  recurring: Recurring[];
  settings: Settings;
}
