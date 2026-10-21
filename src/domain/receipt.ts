/**
 * Lectura de tickets de supermercado (copiado de Kvar, src/domain/receipt.ts, donde se probó con tickets reales de
 * Disco, Devoto, Géant, Tienda Inglesa, Ta-Ta, El Dorado y Macromercado). En Pengar lo usa `parseInvoiceText` cuando
 * el texto parece un ticket de súper, y se queda con esta lectura o la de las facturas según cuál cierra mejor con el
 * TOTAL. Lo propio de Pengar: `entries` (cada renglón de plata, con los descuentos y las bolsas aparte).
 * Formatos uruguayos (e-Ticket):
 *  - En un renglón (Macromercado): CÓDIGO DESCRIPCIÓN CANTIDAD PRECIO MONTO[IVA]
 *      168953 LECHE CLADY ULTRA ENTERA S/FRIO 1LT X 4 2,000 185,07 370,14E
 *  - En dos renglones (Disco, Devoto, Géant y otros): DESCRIPCIÓN MONTO, y abajo CANTIDAD [KG|UN] x PRECIO
 *      AGUJA SIN HUESO          422.36
 *      1.324 KG x 319.00
 * Se lee por etapas: se limpia cada renglón (ruido del OCR), se arreglan los que la foto partió o juntó, se buscan
 * el total y el redondeo, después los productos (primero lo más seguro: cantidad × precio = monto) y al final los
 * descuentos. Ante la duda se pierde el renglón: la diferencia con el total lo avisa («la suma no cierra»).
 */

/** Minúsculas, sin tildes ni puntuación, unidades unificadas («1 LT» → «1l»): para comparar descripciones */
const UNIT_PATTERNS: [RegExp, string][] = [
  [/(\d+(?:[.,]\d+)?)\s*(?:lts?|litros?|l)\b/g, '$1l'],
  [/(\d+(?:[.,]\d+)?)\s*(?:ml|cc)\b/g, '$1ml'],
  [/(\d+(?:[.,]\d+)?)\s*(?:kgs?|kilos?|k)\b/g, '$1kg'],
  [/(\d+(?:[.,]\d+)?)\s*(?:grs?|gramos?|g)\b/g, '$1g'],
  [/(\d+(?:[.,]\d+)?)\s*(?:u|un|unid|unidades?)\b/g, '$1u'],
];
function normalizeAlias(text: string): string {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[^\p{L}\p{N}\p{M}.\s]/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, rep] of UNIT_PATTERNS) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

export interface ReceiptLine {
  raw: string;
  storeCode: string | null; // código interno del súper (el mejor alias posible)
  description: string;      // texto original sin el código
  clean: string;            // descripción legible ("Galletitas el trigal con leche 190 grs")
  quantity: number;         // 2 (unidades) o 9.686 (kg)
  weighed: boolean;         // se vende por peso
  packSize: number;         // "1LT X 4" → 4 unidades por paquete
  units: number;            // unidades para el conteo: 2 packs × 4 = 8; pesados = 1
  unitPrice: number;
  amount: number;
  promo: boolean;           // "OF." = oferta
}

export interface ParsedReceipt {
  store: string | null;
  date: string | null; // AAAA-MM-DD
  lines: ReceiptLine[];
  ignored: string[];   // bolsas, etc.
  total: number | null;
  /** Descuentos de toda la compra que el total ya descuenta (banco, debajo del subtotal): no cambian los productos */
  discounts: number;
  /** Suma de las líneas + bolsas + redondeo + descuentos − total: si no es 0, el OCR leyó mal o faltan líneas. */
  difference: number | null;
  /** (Pengar) Cada renglón de plata antes del TOTAL, en el orden del ticket */
  entries: ReceiptEntry[];
}

/** (Pengar) Un renglón de plata: un producto, su descuento, una bolsa o un descuento de toda la compra */
export interface ReceiptEntry {
  description: string;
  /** El monto impreso (el de un producto, sin restarle sus descuentos; negativo en un descuento) */
  amount: number;
  /** Descuento de un producto: el índice de ese producto en `entries` */
  of?: number;
}

const LETTER = 'A-Za-zÁÉÍÓÚÑáéíóúñ';
const THREE_LETTERS_RE = new RegExp(`[${LETTER}]{3}`);

/** Macromercado: código, descripción, cantidad, precio, monto y la letra del IVA (que el OCR a veces lee como número) */
const LINE_RE =
  /^\s*(?:(\d{1,13})\s+)?(.+?)\s+(\d{1,4}[.,]\d{3})\s+(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[.,]\d{2})\s+(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+[.,]\d{2})\s*([A-Z0-9])?\.?\s*$/;
/** Macromercado sin algún punto o coma («2000 185,07 370,14E», «37014E»): vale solo si la cuenta cierra */
const LOOSE_LINE_RE = /^\s*(?:(\d{1,13})\s+)?(.+?)\s+(\d{1,4}[.,]?\d{3})\s+(\d+[.,]?\d{2})\s+(-?\d+[.,]?\d{2})\s*[A-Z0-9]?\.?\s*$/;
/** Los tres números de un renglón de Macromercado */
const TRIPLE = String.raw`\d{1,4}[.,]\d{3}\s+\d+[.,]\d{2}\s+-?\d+[.,]\d{2}`;
const TRIPLE_RE = new RegExp(TRIPLE);
/** Dos productos de Macromercado en un renglón: se corta después de los números del primero */
const MACRO_BREAK_RE = new RegExp(String.raw`(${TRIPLE}[A-Z]?)\s+(?=\d{1,13}\s+[A-ZÁÉÍÓÚÑ]{2})`, 'g');

/** Monto: «1.410,48», «422.36», «1147.50» (Disco no separa los miles), «-12,00» */
const AMOUNT = String.raw`-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2}`;
/** Cantidad: «1.324», «2», «0,560» */
const QTY = String.raw`\d{1,4}(?:[.,]\d{1,3})?`;
/** Unidad del renglón de cantidad (el OCR a veces pone punto, la escribe en minúscula o lee «K6» y «UM»; otros súper ponen «UND», «PZA», «KILOS» o «Kgr») */
const UNIT = String.raw`(?:KGR?S?\.?|KILOS?|K6|K|UN(?:I|ID|IDAD(?:ES)?|D)?\.?|UDS?\.?|UM|U|PZAS?\.?|PZ\.?|LTS?|L|GRS?|G)`;
/** Entre la cantidad y el precio: «x», «×», «*» o «@» */
const TIMES = '[xX×*@]';
/** Lo que puede seguir al precio: «/KG», «$/KG», «c/u» */
const PER_UNIT = String.raw`(?:\s*\$?\s*\/\s*(?:KGS?|K|UN|U)\.?|\s+c\/u)?`;
/**
 * Renglón de cantidad del formato en dos renglones: «1.324 KG x 319.00», «2 UN x 45,00», «2 @ 65,00», «Cant: 2 x 65,00»,
 * «1.670 KG 149.00» (sin la «x» solo después de la unidad), a veces con el monto al final («2 x 45,90 = 91,80»)
 */
const QTY_LINE_RE = new RegExp(String.raw`^\s*(?:cant(?:idad)?\.?\s*:?\s*)?(${QTY})\s*(?:(${UNIT})\s*${TIMES}?|${TIMES})\s*\$?\s*(${AMOUNT}|\d+[.,]\d|\d+)${PER_UNIT}(?:\s+(?:=\s*)?\$?\s*(?!-)(${AMOUNT})\s*[A-Z]?)?\s*$`, 'i');
/** Cifras que el OCR puede leer como letras */
const LOOK = String.raw`[\dOoSZlIB]`;
/**
 * Forma de renglón de cantidad con alguna cifra leída como letra («0,S60 KG x 299,00», «2 x 4S,90», «Z x 45,90») o con
 * la cantidad negativa de una anulación («-1.000 UN x 135.00»): cantidad, unidad, precio y monto
 */
const QTY_SHAPE_RE = new RegExp(String.raw`^\s*(?:[Cc]ant(?:idad)?\.?\s*:?\s*)?(-?(?:${LOOK}*\d${LOOK}*|[OSZlIB])(?:[.,;]${LOOK}{1,3})?)\s*([A-Za-z]{1,5}\.?)?\s*${TIMES}\s*\$?\s*(${LOOK}+(?:[.,;]${LOOK}{1,3})?)(?:\s+\$?\s*(${LOOK}+[.,;]${LOOK}{2}))?`);
/** Descripción y monto: «AGUJA SIN HUESO 422.36» (código adelante opcional) */
const NAME_AMOUNT_RE = new RegExp(String.raw`^\s*(?:(\d{4,13})\s+)?(.*?[${LETTER}]{2}.*?)\s+\$?\s*(${AMOUNT})\s*[A-Z]?\s*$`);
/** Descripción con un monto que perdió el punto: «AGUJA SIN HUESO 42236» (vale solo si la cuenta cierra) */
const LOST_POINT_RE = new RegExp(String.raw`^\s*(?:(\d{4,13})\s+)?(.*?[${LETTER}]{3}.*?)\s+(\d{3,7})\s*[A-Z]?\s*$`);
/**
 * Todo junto en un renglón (cuando el OCR une los dos): «AGUJA SIN HUESO 1.324 KG x 319.00 422.36». El precio con
 * decimales: «BOLSA RESIDUOS 50X55» o «PROMO 3X2» no son cantidad × precio
 */
const MERGED_RE = new RegExp(String.raw`^\s*(?:(\d{4,13})\s+)?(.*?[${LETTER}]{2}.*?)\s+(${QTY})\s*(${UNIT})?\s*${TIMES}\s*\$?\s*(${AMOUNT})\s+\$?\s*(${AMOUNT})\s*[A-Z]?\s*$`, 'i');
/** Lo mismo con la cantidad primero: «1.324 KG x 319.00 AGUJA SIN HUESO 422.36» */
const QTY_FIRST_RE = new RegExp(String.raw`^\s*(${QTY})\s*(${UNIT})?\s*${TIMES}\s*\$?\s*(${AMOUNT})\s+(?:(\d{4,13})\s+)?(.*?[${LETTER}]{2}.*?)\s+\$?\s*(${AMOUNT})\s*[A-Z]?\s*$`, 'i');
/** Un renglón con cantidad entera, sin «x»: «LECHE CONAPROLE 1L 2 45,90 91,80» */
const INT_ROW_RE = new RegExp(String.raw`^\s*(?:(\d{1,13})\s+)?(.*?[${LETTER}]{2}.*?)\s+(${QTY})\s*(UN|U|KG|K)?\s+(${AMOUNT})\s+(${AMOUNT})\s*[A-Z]?\s*$`, 'i');
/** La cantidad de Disco («1.324 KG x 319.00») dentro de un renglón con otro texto */
const DISCO_QTY_RE = new RegExp(String.raw`(?:^|\s)(\d{1,4}[.,]\d{3}\s*(?:${UNIT})?\s*${TIMES}\s*\$?\s*${AMOUNT})(?=\s|$)`, 'i');
const LONE_AMOUNT_RE = new RegExp(String.raw`^\$?\s*${AMOUNT}\s*[A-Z]?$`);
/** Un renglón que termina en un monto negativo: «DCTO SOCIO -9,18», «2X1 -45,00», «-9,18» */
const NEGATIVE_END_RE = new RegExp(String.raw`^(.*?)\s*\$?\s*(-(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2})\s*[A-Z]?$`);
const NUMBERS_ONLY_RE = /^[\d.,\s-]+[A-Z]?\.?$/;
/** La descripción termina en dos números («… 2000 185,07»): son los números del producto, no un producto suelto */
const TWO_NUMBERS_END_RE = /\d[\d.,]*\s+\$?\s*\d[\d.,]*[.,]\d{2}$/;
/** El renglón termina en un monto («IVA 22% 8,35», «T.E.Imp.: 370,14») */
const AMOUNT_END_RE = /\d[.,]\d{2}\s*[A-Z]?$/;

/** «TOTAL» con el ruido del OCR: «T0TAL», «TOTAI», «T O T A L» (letra doble) */
const TOTAL_WORD = String.raw`t\s?[o0]\s?t\s?a\s?[l1i]`;
/**
 * «TOTAL», «TOTAL DE COMPRA:», «TOTAL A PAGAR $», «TOTAL ($):», «TOTAL....:», «TOTAL COMPRA S» (S por $), «Pago total $»:
 * siempre al principio del renglón
 */
const TOTAL_LABEL = String.raw`^\W*(?:(?:pago|importe|monto)\s+)?${TOTAL_WORD}(?:\s*(?:de\s*)?(?:la\s+)?compra|\s+a\s+pagar|\s+contado)?[\s.:;]*(?:\(\s*\$\s*\)|\$\s*U|UYU)?[\s.:;]*(?:\$|[S5](?=\s))?\s*`;
const TOTAL_RE = new RegExp(String.raw`${TOTAL_LABEL}(\d[\d.,]*)\s*(?:UYU|\$\s*U)?\s*$`, 'i');
const TOTAL_LABEL_RE = new RegExp(`${TOTAL_LABEL}$`, 'i');
/** El renglón del TOTAL aunque el monto no se lea: ahí terminan los productos (y el pago de abajo nunca es uno) */
const TOTAL_ROW_RE = new RegExp(String.raw`${TOTAL_LABEL}[^${LETTER}]*$`, 'i');
/** El que empieza con «TOTAL» es el de la compra (abajo vienen «Pago total», etc.) */
const MAIN_TOTAL_RE = new RegExp(String.raw`^\W*${TOTAL_WORD}`, 'i');
/** El TOTAL pegado al último renglón de cantidad: «2 x 45,90 TOTAL $ 91,80» */
const TOTAL_INSIDE_RE = new RegExp(String.raw`^(.*?\d)\s+(${TOTAL_WORD}\b.*)$`, 'i');
const ROUNDING_RE = /^(?:ajuste\s+(?:por\s+)?)?redondeo\b\s*:?\s*\$?\s*(-?\d[\d.,]*)/i;
const ROUNDING_LABEL_RE = /^(?:ajuste\s+(?:por\s+)?)?redondeo\W*$/i;
/**
 * Donde empieza el resumen de impuestos (Macromercado lo pone antes del total): ahí ya no hay productos sueltos. Con el
 * ruido del OCR («SUB-TOTAL», «lVA», «T.E.lmp.»); solo un renglón con monto («IVA INCLUIDO» del encabezado no cuenta)
 */
const SUMMARY_RE = /^\W*([s5]ub[\s-]*t[o0]tal|[il1]va(?![a-z])|t\.?\s*\w\.?\s*[il1]mp|neto|gravad|exent|base\s+imp)/i;

/** Renglones que no son productos aunque tengan forma de «texto monto»: impuestos, pago, tarjetas y encabezado */
const NOT_ITEM_RE = new RegExp(
  String.raw`\b(?:[s5]ub[\s-]*t[o0]tal|tarjeta|cr[eé]dito|d[eé]bito|efectivo|vuelto|redondeo|[il1]va|saldo|puntaje|puntos|acumul\w*|art[ií]culos|consumo final|consumidor|contado|sucursal|descripci[oó]n|fecha|e-?ticket|cajer[oa]|rut|visa|master\w*|oca|cabal|anda|creditel|amex|diners)(?![${LETTER}])`,
  'i',
);
/**
 * Estas solo cuentan al principio: «PASTA COLGATE TOTAL», «VINO TINTO CAJA 1L» o «VINO PAGO DEL SOL» son productos.
 * «HORA: 20:19» (Tienda Inglesa) y los datos del pago con tarjeta («LOTE», «TERM», «COMERCIO») tampoco lo son.
 */
const NOT_ITEM_START_RE = new RegExp(
  String.raw`^\W*(?:${TOTAL_WORD}|pago|cambio|moneda|caja|hora|lote|term(?:inal)?|comercio|autorizaci\w*|cant(?:idad)?|neto|gravad[oa]|exent[oa]|monto|importe|precio|p\.?\s*unit\w*|unidades|t\.?\s*\w\.?\s*[il1]mp)\b`,
  'i',
);
const isNotItem = (s: string) => NOT_ITEM_RE.test(s) || NOT_ITEM_START_RE.test(s);
/**
 * Palabras de descuento, promoción o ahorro («AHORRASTE», «AH0RRO»): un renglón así nunca es un producto suelto. «DESC»
 * solo al principio o al final («UD. DESC»): en «LECHE DESC CONAPROLE» o «VASOS DESC. X 50» es descremada o descartable
 */
const DISCOUNT_RE = /\b(desc(uentos?|to)|dcto|dto|ah[o0]rr\w*|bonif(icaci[oó]n)?|promo(ci[oó]n)?|rebaja|cup[oó]n|oferta|socio|beneficio|lleva|\d+\s*da|\d\s*x\s*\d)\b|^\W*desc\b|\bdesc\.?$/i;
/** Ahorros y descuentos («USTED AHORRO $ 94.90»): nunca son la descripción de un producto («DESC» solo al principio) */
const SAVINGS_RE = /\b(ah[o0]rr\w*|desc(uentos?|to)|dcto|dto|bonificaci[oó]n|beneficio)\b|^\W*desc\b/i;
/** Renglones con monto negativo que no son descuentos */
const NOT_DISCOUNT_RE = /\b([s5]ub[\s-]*t[o0]tal|t[o0]tal|redondeo|cambio|vuelto|saldo|efectivo|pago)\b/i;
/** Descuento de toda la compra aunque esté debajo de un producto: bancos, tarjetas de crédito, jubilados, leyes (IVA Ley 19.210) */
const RECEIPT_DISCOUNT_RE =
  /\b(ita[uú]|santander|brou|banco|rep[uú]blica|scotia\w*|bbva|hsbc|heritage|bandes|oca|prex|midinero|visa|master\w*|amex|american|diners|cabal|anda|creditel|jubilad\w*|ley|19\.?210|[il1]\.?\s?v\.?\s?a|impuestos?)\b/i;
/** El porcentaje del descuento: «DESCUENTO 10% -33,40» */
const PERCENT_RE = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/;
/** Prefijo de una anulación: «ANULACION COCA COLA -135.00» */
const VOID_PREFIX_RE = /^(?:anula\w*|cancela\w*)\s*:?\s*/i;

/** Bolsas del súper: no son productos de la casa (pero suman al total). Las de residuos, el hielo, etc. sí lo son */
const BAG_RE = /\b(bolsas?|bolsones?)\b/i;
const BAG_PRODUCT_RE = /\b(residuos?|basura|consorcio|herm[eé]tic[oa]s?|freezer|hielo|zip\w*|aspiradora|horno)\b/i;
export const isCheckoutBag = (line: ReceiptLine) => BAG_RE.test(line.description) && !BAG_PRODUCT_RE.test(line.description) && line.unitPrice <= 20;

/** Cifras con letras parecidas («949.O0», «l.324», «37O,14E», «1l.851,00»): el OCR confunde O con 0, y l o I con 1 */
const DIGITS_RE = new RegExp(String.raw`(^|[^${LETTER}\d])([\dOolI]{1,6}(?:[.,][\dOolI]{3})*[.,][\dOolI]{2,3})(?=[A-Z]?(?:\s|$))`, 'g');
/** Más letras por cifras dentro de un número («1B5,07»): se prueban solo si la cuenta cierra */
const DIGIT_LOOKALIKES: Record<string, string> = { O: '0', o: '0', l: '1', I: '1', Z: '2', S: '5', B: '8' };
/** Separador decimal con un espacio: «422. 36», «422 .36» */
const SPACED_POINT_RE = /(\d)(?:\s+([.,])\s*|([.,])\s+)(\d{2})(?=\s|[A-Z]?$)/g;
/** Puntos guía entre la descripción y el monto: «PAN FLAUTA ........ 45,00», «TOTAL....: 90,90» */
const LEADERS_RE = /\s*[.·_-]{3,}\s*/g;
/** Un signo pegado al final del monto: «45,90.», «11.851,00,» */
const TRAILING_SIGN_RE = /(\d[.,]\d{2})[.,;:]+$/;
/** Signo del descuento después del monto o separado: «9,18-», «- 9,18», «-$ 9,18» → «-9,18» */
const MINUS_AFTER_RE = /(^|\s)\$?\s*(\d[\d.,]*[.,]\d{2})-(\s*[A-Z]?)$/;
const MINUS_SPACED_RE = /(^|\s)-\s*\$?\s*(?=\d[\d.,]*[.,]\d{2}\s*[A-Z]?$)/;
/** Signos sueltos en los bordes («| AGUJA», «1.324 KG x 319.00 |»); el «-» de adelante solo si lo sigue un espacio */
const EDGE_START_RE = /^(?:[|'`"·•_,;:]+|-(?=\s))\s*/;
const EDGE_END_RE = /\s+[|'`"·•_,;:-]+$/;
/** Encabezado pegado al primer producto: «MONEDA: UYU AGUJA SIN HUESO 422.36» */
const HEADER_PREFIX_RE = /^(?:MONEDA:?\s*UYU|CONSUMO FINAL|CONTADO)\s+(?=\S)/i;
/** Tabla «DESCRIPCION CANT. IMPORTE»: la cantidad va entre la descripción y el monto, sin precio unitario */
const QTY_COLUMN_HEADER_RE = /\bcant(?:idad)?\b\.?\s+(?:importe|monto|total)\b/i;
/** «PAN FLAUTA 2,00» (la cantidad con decimales en cero) o, con ese encabezado, «PAN FLAUTA 2» */
const QTY_COLUMN_RE = new RegExp(String.raw`^(.*[${LETTER}].*?)\s+(\d{1,3})([.,]0{2,3})?$`);

/** Abreviaturas habituales de los tickets → texto legible */
const ABBREVIATIONS: [RegExp, string][] = [
  [/^OF\.\s*/i, ''],
  [/\bGALL\./gi, 'Galletitas '],
  [/\bDESOD\./gi, 'Desodorante '],
  [/\bS\/G(LUTEN)?\b/gi, 'sin gluten'],
  [/\bS\/FRIO\b/gi, ''],
  [/\bC\/MENUDOS?\b/gi, 'con menudos'],
  [/\bS\/MENUDOS?\b/gi, 'sin menudos'],
  [/\bS\//gi, 'sin '],
  [/\bC\//gi, 'con '],
  [/\bCARNICERIA OFERTA\b/gi, ''],
  [/\bUNT\./gi, 'untable '],
  [/\bBALS\./gi, 'balsámico '],
  [/\bD\.?P\.?$/i, ''],
  [/^E\.\s+/i, ''],
];

/** "1.410,48" → 1410.48 ; "9,686" → 9.686 ; "1.410.48" (un separador mal leído) → 1410.48 */
export function parseNumber(s: string): number {
  const t = s.trim();
  // Con dos o más separadores, el último seguido de dos cifras es el decimal
  const m = /^(-?\d[\d.,]*)[.,](\d{2})$/.exec(t);
  if (m && /[.,]/.test(m[1])) return Number(`${m[1].replace(/[.,]/g, '')}.${m[2]}`);
  if (/,\d{1,3}$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  return Number(t.replace(/,/g, ''));
}

export function cleanDescription(desc: string): string {
  let s = desc;
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "1LT X 4", "X3 300G", "X 26" → unidades por paquete (pero «X 2.25L», «X 150 GRS» o «X 30 MTS» son un tamaño) */
export function packSizeOf(desc: string): number {
  const m = /\bX\s?(\d{1,3})\b(?![.,]\d)(?!\s?(?:GRS?|GRAMOS|G|KGS?|KILOS?|K|ML|CC|L|LTS?|LITROS?|MTS?|M|CM|MM)\b)/i.exec(desc);
  const n = m ? Number(m[1]) : 1;
  return n >= 2 && n <= 200 ? n : 1;
}

const STORES: [RegExp, string][] = [
  [/macromercado/, 'macromercado'],
  [/tienda[\s.-]*inglesa/, 'tienda-inglesa'],
  [/\bdisco\b/, 'disco'],
  [/\bdevoto\b/, 'devoto'],
  [/\bg[eé]ant\b/, 'geant'],
  [/\bta-?ta\b/, 'tata'],
  [/\bel dorado\b/, 'el-dorado'],
  [/multi[\s.-]*ahorro/, 'multi-ahorro'],
  [/\bkinko\b/, 'kinko'],
];
/** (Pengar) Cómo se llama cada súper */
const STORE_NAMES: Record<string, string> = {
  macromercado: 'Macromercado', 'tienda-inglesa': 'Tienda Inglesa', disco: 'Disco', devoto: 'Devoto', geant: 'Géant', tata: 'Ta-Ta',
  'el-dorado': 'El Dorado', 'multi-ahorro': 'Multi Ahorro', kinko: 'Kinko',
};
/** (Pengar) El nombre del súper, salvo que `merchant` (lo leído arriba del ticket) ya lo diga */
export function storeName(key: string | null, merchant?: string): string | undefined {
  const re = STORES.find(([, k]) => k === key)?.[0];
  if (!key || !re) return merchant;
  return merchant && re.test(merchant.toLowerCase()) ? merchant : STORE_NAMES[key];
}
/** Razón social de Disco, Devoto y Géant: no dice cuál de los tres es */
const GDU_RE = /supermercados disco del uruguay/g;

/**
 * El súper del ticket: la marca que aparece primero (el logo va arriba; un ticket de Devoto o Géant puede decir
 * «Supermercados Disco del Uruguay S.A.» más abajo, en la razón social). Si solo está la razón social, es Disco.
 */
export function detectStore(text: string): string | null {
  const t = text.toLowerCase();
  const brands = t.replace(GDU_RE, ' ');
  let best: { at: number; key: string } | null = null;
  for (const [re, key] of STORES) {
    const at = brands.search(re);
    if (at >= 0 && (!best || at < best.at)) best = { at, key };
  }
  return best?.key ?? (brands !== t ? 'disco' : null);
}

/** «17/10/2026», «17-10-2026», «17.10.2026» o «17/10/26» (primero las de año completo) */
const DATE_RE = /\b(\d{2})([/.-])(\d{2})\2(\d{4}|\d{2})\b/g;

function detectDate(text: string): string | null {
  const dates = [...text.matchAll(DATE_RE)].filter(([, d, , m]) => Number(d) >= 1 && Number(d) <= 31 && Number(m) >= 1 && Number(m) <= 12);
  const m = dates.find((d) => d[4].length === 4) ?? dates[0];
  return m ? `${m[4].length === 2 ? `20${m[4]}` : m[4]}-${m[3]}-${m[1]}` : null;
}

/** Se vende por peso: por la unidad («KG», «Kgr»), o si no la tiene, por la cantidad con decimales */
const isWeighed = (unit: string | undefined, qty: number) => (unit ? /^(k|g|l)/i.test(unit) : !Number.isInteger(qty));

/** Una línea de producto armada a partir de sus partes */
export function makeLine(raw: string, code: string | undefined, description: string, quantity: number, unitPrice: number, amount: number, unit?: string): ReceiptLine {
  const weighed = isWeighed(unit, quantity);
  const packSize = packSizeOf(description);
  return {
    raw,
    storeCode: code ?? null,
    description: description.trim(),
    clean: cleanDescription(description),
    quantity,
    weighed,
    packSize,
    units: weighed ? 1 : Math.max(1, Math.round(quantity)) * packSize,
    unitPrice,
    amount,
    promo: /^OF\./i.test(description.trim()),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100 + 0; // + 0: nunca «-0»

/** ¿Cantidad × precio da el monto? (con tolerancia por redondeo) */
const consistent = (qty: number, price: number, amount: number) =>
  qty > 0 && price > 0 && Math.abs(qty * price - amount) <= Math.max(0.02, Math.abs(amount) * 0.02);
/** ¿Cantidad × precio da el monto al centésimo, como lo imprime el súper? */
const closes = (qty: number, price: number, amount: number) => qty > 0 && price > 0 && Math.abs(qty * price - amount) < 0.0051;

/** Cuántas cifras cambió, sacó, agregó o dio vuelta el OCR entre dos números escritos (distancia de edición) */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // Dos cifras vecinas al revés: «284.83» por 248.83
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
/** ¿El OCR pudo leer `read` en lugar de `real` equivocándose en una sola cifra? («819.00» por 319.00, «94.00» por 943.00) */
const oneDigitOff = (read: number, real: number, decimals: number) => editDistance(read.toFixed(decimals), real.toFixed(decimals)) <= 1;

/**
 * Cantidad y precio que no cierran con el monto. Si una sola cifra mal leída del monto lo explica, quedan como se
 * leyeron (la diferencia con el total lo avisa); si es una cifra de la cantidad o del precio, la lectura que cierra
 * («1.824 KG x 319.00» con 422.36 es 1.324 kg). null si ninguna lo explica: no son del mismo producto.
 */
function explain(qty: number, price: number, amount: number, weighed: boolean): { qty: number; price: number } | null {
  if (!(amount > 0 && qty > 0 && price > 0)) return null;
  if (consistent(qty, price, amount) || oneDigitOff(qty * price, amount, 2)) return { qty, price };
  const q = weighed ? Math.round((amount / price) * 1000) / 1000 : Math.round(amount / price);
  if (closes(q, price, amount) && oneDigitOff(qty, q, 3)) return { qty: q, price };
  const p = round2(amount / qty);
  return closes(qty, p, amount) && oneDigitOff(price, p, 2) ? { qty, price: p } : null;
}

/** ¿El número con letras por cifras («2SS,00») puede ser este valor? Cada letra es una cifra que no se leyó */
function fits(read: string, value: number): boolean {
  const decimals = /[.,;](\w*)$/.exec(read)?.[1].length ?? 0;
  const digits = value.toFixed(decimals).replace('.', '');
  const chars = read.replace(/[.,;]/g, '');
  return chars.length === digits.length && [...chars].every((c, k) => !/\d/.test(c) || c === digits[k]);
}

/** Cantidad y precio con letras por cifras («0,S60 KG x 299,00», «2 x 4S,90»): las completa la lectura que cierra con el monto */
function fillDigits(qtyS: string, priceS: string, amount: number): { qty: number; price: number } | null {
  const num = (s: string) => (/[^\d.,;]/.test(s) ? NaN : parseNumber(s.replace(/;/g, ',')));
  let [qty, price] = [num(qtyS), num(priceS)];
  if (Number.isNaN(price)) price = round2(amount / qty);
  else if (Number.isNaN(qty)) qty = Math.round((amount / price) * 1000) / 1000;
  return closes(qty, price, amount) && fits(qtyS, qty) && fits(priceS, price) ? { qty, price } : null;
}

/**
 * Cantidad y precio que mejor cierran con el monto. Si el OCR perdió el punto («1000 UN» por 1.000, «31900» por
 * 319.00) también se prueba la lectura con el punto: nunca se acepta 1000 unidades si 1 cierra.
 */
function readQtyPrice(qtyS: string, priceS: string, amount: number) {
  if (/[^\d.,]/.test(qtyS + priceS)) {
    const filled = fillDigits(qtyS, priceS, amount);
    return filled ? { ...filled, err: 0, ok: true } : { qty: NaN, price: NaN, err: Infinity, ok: false };
  }
  const qty = parseNumber(qtyS);
  const price = parseNumber(priceS);
  const qtys = /^\d{4,}$/.test(qtyS) ? [qty, qty / 1000] : [qty];
  const prices = /^\d{3,}$/.test(priceS) ? [price, price / 100] : [price];
  let best = { qty, price, err: Infinity, ok: false };
  for (const q of qtys) {
    for (const p of prices) {
      const err = Math.abs(q * p - amount);
      if (err < best.err) best = { qty: q, price: p, err, ok: consistent(q, p, amount) };
    }
  }
  return best;
}

/** ¿Tiene forma de renglón de cantidad, aunque alguna cifra se haya leído mal? (nunca es un producto) */
function isQtyLike(row: string): boolean {
  const m = QTY_SHAPE_RE.exec(row);
  return m != null && !THREE_LETTERS_RE.test(row.slice(m[0].length)) && !/-\s*\d/.test(row.slice(m[0].length));
}
const isQtyRow = (row: string) => QTY_LINE_RE.test(row) || isQtyLike(row);

/** Un renglón que puede ser la descripción de un producto (sin monto) */
const isNameOnly = (row: string) =>
  THREE_LETTERS_RE.test(row) && !isNotItem(row) && !isQtyRow(row) && !/\d[.,]\d{2}\s*$/.test(row) && !TRIPLE_RE.test(row);
/** Un renglón de la promoción, sin monto («OFERTA 2DA AL 50%», «DESC. TARJETA»): puede ir entre el producto y su descuento */
const isPromoLabel = (row: string) => (DISCOUNT_RE.test(row) || SAVINGS_RE.test(row)) && !/\d[.,]\d{2}/.test(row) && !isQtyRow(row);

/** Las cifras de los números con letras por cifras («1B5,07»); la letra del IVA del final queda («161,93B») */
const asDigits = (row: string) =>
  row
    .split(' ')
    .map((t) => (/\d/.test(t) && /^[\dOolIZSB.,;]+$/.test(t) ? t.replace(/[OolIZSB](?=[OolIZSB]*[\d.,;])/g, (c) => DIGIT_LOOKALIKES[c]) : t))
    .join(' ');

/** Un espacio dentro del precio: «2 x 4 5,90» (2 × 4 no da 5,90: el precio es 45,90) */
function joinSplitPrice(row: string): string {
  const q = QTY_LINE_RE.exec(row);
  if (!q?.[4] || !/^\d$/.test(q[3]) || consistent(parseNumber(q[1]), Number(q[3]), parseNumber(q[4]))) return row;
  return row.replace(/(\d)\s+(\d{1,2}[.,]\d{2})\s*$/, '$1$2');
}

/** Limpia el ruido del OCR en un renglón: puntos guía, letras por cifras, el signo del descuento, signos sueltos en los bordes */
function normalizeRow(raw: string): string {
  const row = raw
    .trim()
    .replace(LEADERS_RE, ' ')
    .replace(DIGITS_RE, (_, before: string, n: string) => before + (/\d/.test(n) ? n.replace(/[Oo]/g, '0').replace(/[lI]/g, '1') : n))
    .replace(SPACED_POINT_RE, '$1$2$3$4')
    .replace(TRAILING_SIGN_RE, '$1')
    .replace(MINUS_AFTER_RE, '$1-$2$3')
    .replace(MINUS_SPACED_RE, '$1-')
    .replace(EDGE_START_RE, '')
    .replace(EDGE_END_RE, '')
    .replace(HEADER_PREFIX_RE, '')
    .trim();
  return joinSplitPrice(row);
}

/** Producto entero en un renglón; `sure` si cantidad × precio da el monto, `near` si una cifra mal leída lo explica */
interface RowItem {
  code?: string;
  description: string;
  qty: number;
  price: number;
  amount: number;
  unit?: string;
  sure: boolean;
  near?: boolean;
}

/** Código de Macromercado mal leído («1689S3 LECHE») o pegado a la descripción («168953LECHE») */
const fixStoreCode = (row: string) =>
  row.replace(/^([\dOSlI]{3,7}\d)(?=\s|[A-Z]{2})\s*/, (code: string, c: string) =>
    c.replace(/\d/g, '').length > 1 ? code : `${c.replace(/O/g, '0').replace(/S/g, '5').replace(/[lI]/g, '1')} `);

/**
 * El formato de Macromercado: «168953 LECHE … 2,000 185,07 370,14E». Vale si la cuenta cierra, o si una cifra mal
 * leída lo explica («2,000» por 12,000, o el «1» de «11,000» que quedó en la descripción)
 */
function macroItem(row: string): RowItem | null {
  let m = LINE_RE.exec(row);
  if (!m?.[1]) m = LINE_RE.exec(fixStoreCode(row)) ?? m;
  const guessed = !m;
  if (!m) m = LINE_RE.exec(asDigits(fixStoreCode(row)));
  if (m) {
    const [, code, description, qtyS, priceS, amountS, tail] = m;
    const [qty, price, amount] = [parseNumber(qtyS), parseNumber(priceS), parseNumber(amountS)];
    const lost = /^(.*\S)\s+(\d{1,2})$/.exec(description);
    const lostQty = lost ? parseNumber(lost[2] + qtyS) : NaN;
    if (lost && !consistent(qty, price, amount) && consistent(lostQty, price, amount)) return { code, description: lost[1], qty: lostQty, price, amount, sure: true };
    const read = explain(qty, price, amount, !/[.,]0+$/.test(qtyS));
    const sure = read != null && consistent(read.qty, read.price, amount);
    // La letra del IVA leída como número («56,198») o letras por cifras («1B5,07»): valen solo si la cuenta cierra
    if (read && (sure || (!guessed && !/\d/.test(tail ?? '')))) return { code, description, ...read, amount, sure };
  }
  const l = LOOSE_LINE_RE.exec(row);
  if (!l) return null;
  const [, code, description, qtyS, priceS, amountS] = l;
  const read = (s: string, scale: number) => (/[.,]/.test(s) ? parseNumber(s) : Number(s) / scale);
  const [qty, price, amount] = [read(qtyS, 1000), read(priceS, 100), read(amountS, 100)];
  const withPoint = [qtyS, priceS, amountS].filter((s) => /[.,]/.test(s)).length;
  return withPoint >= 2 && consistent(qty, price, amount) ? { code, description, qty, price, amount, sure: true } : null;
}

/** Las partes de un producto con su cantidad × precio leída de la mejor forma */
function itemOf(code: string | undefined, description: string, qtyS: string, unit: string | undefined, priceS: string, amountS: string): RowItem {
  const amount = parseNumber(amountS);
  const r = readQtyPrice(qtyS, priceS, amount);
  const read = r.ok ? r : explain(r.qty, r.price, amount, isWeighed(unit, r.qty));
  const [qty, price] = read ? [read.qty, read.price] : [r.qty, r.price];
  return { code, description, qty, price, amount, unit, sure: consistent(qty, price, amount), near: read != null };
}

/** Los dos renglones que el OCR juntó, con el nombre o la cantidad primero, o el formato con cantidad entera */
function mergedItem(row: string): RowItem | null {
  const m = MERGED_RE.exec(row);
  const merged = m && itemOf(m[1], m[2], m[3], m[4], m[5], m[6]);
  // Si no cierra por una cifra mal leída, igual es un producto (la diferencia lo avisa), pero nunca un descuento
  if (merged) return merged.sure || (merged.near && merged.amount > 0 && !DISCOUNT_RE.test(merged.description)) ? merged : null;
  const f = QTY_FIRST_RE.exec(row);
  const first = f && itemOf(f[4], f[5], f[1], f[2], f[3], f[6]);
  if (first?.sure) return first;
  const n = INT_ROW_RE.exec(row);
  const int = n && itemOf(n[1], n[2], n[3], n[4], n[5], n[6]);
  return int?.sure ? int : null;
}

/**
 * Producto entero en un renglón (nunca uno con los números de otro producto metidos en la descripción). Con código y la
 * cuenta que cierra es un producto aunque empiece con «CAJA», «TOTAL» o «PAGO» (Macromercado)
 */
function oneRowItem(row: string): RowItem | null {
  const item = macroItem(row) ?? mergedItem(row);
  if (!item || TRIPLE_RE.test(item.description)) return null;
  return (item.code && item.sure) || !isNotItem(item.description) ? item : null;
}

/** Renglones que la foto juntó: dos productos de Macromercado, el TOTAL con la última cantidad, o la cantidad de uno con el nombre del siguiente */
function splitRow(row: string): string[] {
  const macro = row.replace(MACRO_BREAK_RE, '$1\n').split('\n');
  if (macro.length > 1) return macro;
  const t = TOTAL_INSIDE_RE.exec(row);
  if (t && QTY_LINE_RE.test(t[1]) && TOTAL_RE.test(t[2])) return [t[1], t[2]];
  const q = DISCO_QTY_RE.exec(row);
  if (!q || QTY_LINE_RE.test(row) || oneRowItem(row)?.sure) return [row];
  const rest = `${row.slice(0, q.index)} ${row.slice(q.index + q[0].length)}`.replace(/\s+/g, ' ').trim();
  return THREE_LETTERS_RE.test(rest) ? [q[1], rest] : [row];
}

/** ¿El renglón es la continuación del de arriba? (la foto curvada parte un renglón en dos) */
function continues(prev: string, row: string): boolean {
  // Macromercado: los números bajaron al renglón de abajo
  if (NUMBERS_ONLY_RE.test(row) && !LINE_RE.test(prev) && LINE_RE.test(`${prev} ${row}`)) return true;
  if (!LONE_AMOUNT_RE.test(row)) return false;
  // «TOTAL» y su monto en dos renglones
  if (TOTAL_LABEL_RE.test(prev)) return true;
  // El monto solo: va con la descripción de arriba, o con la cantidad si le falta (un descuento suelto no)
  const q = QTY_LINE_RE.exec(prev);
  return isNameOnly(prev) || (q != null && !q[4] && !/^\$?\s*-/.test(row));
}

/** ¿La cantidad × precio de este renglón da el monto suelto? */
function closesWith(qtyRow: string, amountRow: string): boolean {
  const q = QTY_LINE_RE.exec(qtyRow);
  return q != null && readQtyPrice(q[1], q[3], parseNumber(amountRow.replace(/[^\d.,-]/g, ''))).ok;
}

function joinRows(rows: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < rows.length; k++) {
    const [row, next = '', after = ''] = [rows[k], rows[k + 1], rows[k + 2]];
    // El monto arriba de su renglón (foto curvada): «-0,08» arriba de «Redondeo», o arriba del nombre si la cantidad de
    // abajo cierra con él (así no se pega a un renglón del encabezado como «CONTADO»)
    if (LONE_AMOUNT_RE.test(row) && (ROUNDING_LABEL_RE.test(next) || (isNameOnly(next) && closesWith(after, row)))) {
      out.push(`${next} ${row}`);
      k++;
    } else if (out.length && continues(out[out.length - 1], row)) out[out.length - 1] = `${out[out.length - 1]} ${row}`;
    else out.push(row);
  }
  return out;
}

/** El monto suelto («422.36») o el que quedó al final de un renglón de cantidad («1.324 KG x 319.00 248.83») */
function strayAmount(row: string): number | null {
  const s = QTY_LINE_RE.exec(row)?.[4] ?? (LONE_AMOUNT_RE.test(row) ? row.replace(/[^\d.,-]/g, '') : null);
  return s ? parseNumber(s) : null;
}

/**
 * Producto en dos renglones: el de cantidad (i) y el de la descripción (j, arriba o abajo). La descripción trae el
 * monto, o el monto quedó pegado a la cantidad (foto curvada; entonces la descripción puede terminar en un tamaño,
 * «COCA COLA 2.25»), o subió un renglón. Estricto: solo si cantidad × precio da el monto; si no, solo si una cifra mal
 * leída lo explica. `weak`: el monto es el de la cantidad, así que cualquier nombre cerraría (no dice si va arriba o abajo).
 */
function pairLine(rows: string[], i: number, j: number, strict: boolean): { line: ReceiptLine; weak: boolean } | null {
  const q = QTY_LINE_RE.exec(rows[i]) ?? (isQtyLike(rows[i]) ? QTY_SHAPE_RE.exec(rows[i]) : null);
  const row = rows[j];
  if (!q || q[1].startsWith('-') || isQtyRow(row) || MERGED_RE.test(row)) return null;
  const [, qtyS, unit, priceS, inQtyS] = q;
  /** Lecturas posibles; `loose`: vale aunque no cierre (pasada no estricta) */
  const options: { code?: string; description: string; amount: number; loose: boolean; weak?: boolean }[] = [];
  const isName = (s: string) => !isNotItem(s) && !SAVINGS_RE.test(s);
  const n = NAME_AMOUNT_RE.exec(row);
  if (n && isName(n[2])) options.push({ code: n[1], description: n[2], amount: parseNumber(n[3]), loose: true });
  // El número del final de la descripción de arriba es un tamaño («2.25»), no el monto de otro producto
  const size = j === i - 1 && (!n || parseNumber(n[3]) < 10);
  const nameOnly = isNameOnly(row) && !DISCOUNT_RE.test(row);
  if (inQtyS && THREE_LETTERS_RE.test(row) && isName(row) && (nameOnly || size)) {
    const code = /^(\d{4,13})\s+/.exec(row)?.[1];
    options.push({ code, description: code ? row.slice(code.length).trim() : row, amount: parseNumber(inQtyS), loose: nameOnly, weak: true });
  }
  const lost = LOST_POINT_RE.exec(row);
  if (lost && isName(lost[2])) options.push({ code: lost[1], description: lost[2], amount: Number(lost[3]) / 100, loose: false });
  // El monto subió un renglón: quedó arriba del nombre, suelto o al final de la cantidad del producto anterior
  const shifted = j === i - 1 && nameOnly ? strayAmount(rows[j - 1] ?? '') : null;
  if (shifted != null) options.push({ description: row, amount: shifted, loose: false });

  let best: { option: (typeof options)[number]; qty: number; price: number } | null = null;
  for (const option of options) {
    const read = readQtyPrice(qtyS, priceS, option.amount);
    if (read.ok) {
      best = { option, qty: read.qty, price: read.price };
      break;
    }
    // Si ninguna cierra (el OCR leyó mal un número): la primera que se explica con una sola cifra mal leída
    const near: { qty: number; price: number } | null =
      !strict && option.loose && !best ? explain(read.qty, read.price, option.amount, isWeighed(unit, read.qty)) : null;
    if (near) best = { option, ...near };
  }
  if (!best || best.option.amount < 0) return null;
  const { option, qty, price } = best;
  const line = makeLine(j < i ? `${row} / ${rows[i]}` : `${rows[i]} / ${row}`, option.code, option.description, qty, price, option.amount, unit);
  return { line, weak: option.weak === true };
}

/** Monto de un renglón de descuento («DCTO SOCIO -9,18», «2X1 -45,00», o «-9,18» solo); null si no lo es */
function discountOf(row: string): number | null {
  const m = NEGATIVE_END_RE.exec(row);
  return m && !NOT_DISCOUNT_RE.test(m[1]) ? parseNumber(m[2]) : null;
}

/**
 * ¿Descuento de toda la compra? Por el nombre (banco, ley, IVA, jubilados) o porque su porcentaje es de lo comprado
 * hasta ahí y no del producto de arriba («DESCUENTO 10% -33,40» con 334 de compra y el pan de 45)
 */
function isReceiptDiscount(label: string, amount: number, itemAmount: number, sumAbove: number): boolean {
  if (RECEIPT_DISCOUNT_RE.test(label)) return true;
  const pct = PERCENT_RE.exec(label);
  if (!pct) return false;
  const isRateOf = (base: number) => Math.abs((base * parseNumber(pct[1])) / 100 + amount) <= Math.max(0.02, Math.abs(amount) * 0.01);
  return isRateOf(sumAbove) && !isRateOf(itemAmount);
}

/**
 * Producto de un renglón «DESCRIPCIÓN MONTO»: una unidad, salvo en la tabla «DESCRIPCION CANT. IMPORTE» («PAN FLAUTA
 * 2,00 90,00» o, con ese encabezado, «PAN FLAUTA 2 90,00»): ahí la cantidad va antes del monto y el precio es monto / cantidad
 */
function singleItem(description: string, amount: number, qtyColumn: boolean) {
  const c = QTY_COLUMN_RE.exec(description);
  if (!c || !(c[3] || qtyColumn) || Number(c[2]) < 1) return { description, qty: 1, price: amount };
  const qty = Number(c[2]);
  const price = round2(amount / qty);
  return closes(qty, price, amount) ? { description: c[1], qty, price } : null;
}

/** Disco, Devoto y Géant imprimen el renglón «1.000 UN x …» aun para una unidad: ahí no hay productos de un renglón */
const GDU_STORES = new Set(['disco', 'devoto', 'geant']);
const UNIT_ROW_RE = /^\s*\d{1,4}[.,]\d{3}\s*UN\b/i;

/** Un renglón «DESCRIPCIÓN MONTO» que sobró es un producto de una unidad, salvo impuestos, ahorro, cantidades o números sueltos */
const isSingleItem = (row: string, description: string) =>
  !isNotItem(description) && !DISCOUNT_RE.test(description) && !isQtyRow(row) && !MERGED_RE.test(row) && !TWO_NUMBERS_END_RE.test(description);

export function parseReceiptText(text: string): ParsedReceipt {
  const store = detectStore(text);
  const rows = joinRows(text.split(/\r?\n/).map(normalizeRow).filter(Boolean).flatMap(splitRow));
  const lines: ReceiptLine[] = [];
  const ignored: string[] = [];
  let bagsSum = 0;
  let discounts = 0;
  const used = new Set<number>();
  /** Renglones de cada producto: el primero da el orden del ticket; justo debajo del último puede venir su descuento */
  const span = new Map<ReceiptLine, { start: number; end: number }>();
  // (Pengar) Lo que no es un producto pero es plata (bolsas y descuentos de toda la compra), y los descuentos de cada producto
  const extras: { at: number; description: string; amount: number }[] = [];
  const ownDiscounts = new Map<ReceiptLine, { description: string; amount: number }[]>();

  const add = (line: ReceiptLine, start: number, end = start) => {
    for (let k = start; k <= end; k++) used.add(k);
    if (isCheckoutBag(line)) {
      ignored.push(line.description);
      bagsSum += line.amount; // las bolsas también suman al total
      extras.push({ at: start, description: line.description, amount: line.amount });
      return;
    }
    lines.push(line);
    span.set(line, { start, end });
  };
  const addItem = (item: RowItem, i: number) => add(makeLine(rows[i], item.code, item.description, item.qty, item.price, item.amount, item.unit), i);

  // 1) Total y redondeo. Los productos van antes del primer total, aunque su monto no se lea: abajo vienen el pago, la
  //    adenda y el pie
  const totals: { row: number; value: number; main: boolean; exact: boolean }[] = [];
  let rounding = 0;
  let itemsEnd = rows.length;
  rows.forEach((row, i) => {
    const t = TOTAL_RE.exec(row);
    if (t || TOTAL_ROW_RE.test(row)) {
      if (t) totals.push({ row: i, value: parseNumber(t[1]), main: MAIN_TOTAL_RE.test(row), exact: /[.,]\d{2}$/.test(t[1]) });
      itemsEnd = Math.min(itemsEnd, i);
      used.add(i);
      return;
    }
    const r = ROUNDING_RE.exec(row);
    if (r) {
      rounding = parseNumber(r[1]);
      used.add(i);
    }
  });
  // El que empieza con «TOTAL» es el de la compra (abajo vienen «Pago total», etc.); uno sin decimales perdió el punto
  const best = totals.find((t) => t.main && t.exact) ?? [...totals].reverse().find((t) => t.exact) ?? totals[totals.length - 1];
  const total = best ? best.value : null;

  // 2) Un producto por renglón: Macromercado, o los dos renglones que el OCR juntó si la cuenta cierra
  const loose: { i: number; item: RowItem }[] = [];
  for (let i = 0; i < itemsEnd; i++) {
    const item = used.has(i) || isQtyRow(rows[i]) ? null : oneRowItem(rows[i]);
    if (item?.sure) addItem(item, i);
    else if (item) loose.push({ i, item });
  }
  /** Macromercado (código, cantidad, precio y monto en cada renglón): ahí no hay productos de «texto monto» */
  const macroFormat = store === 'macromercado' || lines.filter((l) => l.storeCode && TRIPLE_RE.test(l.raw)).length >= 3;

  // 3) Dos renglones. El ticket va siempre igual (cantidad abajo o arriba): manda lo que cierra en la mayoría de los
  //    pares, así un monto mal leído no hace que la cantidad se vaya con el producto vecino. Si los montos están en los
  //    renglones de cantidad, cualquier nombre cierra: en el empate, el renglón de arriba del primero es del encabezado
  //    («CONTADO», la sucursal), así que la cantidad va con el nombre de abajo
  const qtyRows = rows.map((_, i) => i).filter((i) => i < itemsEnd && !used.has(i) && isQtyRow(rows[i]));
  const pairAt = (i: number, j: number, strict: boolean) => (j >= 0 && j < itemsEnd && !used.has(j) ? pairLine(rows, i, j, strict) : null);
  const votes = (d: number) => {
    const pairs = qtyRows.flatMap((i) => pairAt(i, i + d, true) ?? []);
    return { strong: pairs.filter((p) => !p.weak).length, all: pairs.length };
  };
  const [up, down] = [votes(-1), votes(1)];
  const goesDown = up.strong !== down.strong ? down.strong > up.strong : up.all !== down.all ? down.all > up.all : up.all > 0 && up.strong === 0;
  const order = goesDown ? [1, -1] : [-1, 1];
  // Primero los pares que cierran (cantidad × precio = monto), después los que el OCR leyó mal
  for (const strict of [true, false]) {
    for (const d of order) {
      for (const i of qtyRows) {
        const pair = used.has(i) ? null : pairAt(i, i + d, strict);
        if (pair) add(pair.line, Math.min(i, i + d), Math.max(i, i + d));
      }
    }
  }
  // Un renglón de cantidad que quedó solo (no se pudo leer o no cierra con nada): su nombre no es un producto de una
  // unidad. Se pierde y la diferencia lo avisa
  const doubtful = new Set<number>();
  for (const i of qtyRows) {
    if (used.has(i)) continue;
    used.add(i);
    doubtful.add(i + order[0]);
  }

  // 4) Lo que sobró antes del total: los renglones juntados que no cierran (la diferencia lo avisa) y los productos de
  //    un solo renglón («LECHE CONAPROLE 45,90»), sin llegar al resumen de impuestos
  for (const { i, item } of loose) if (!used.has(i)) addItem(item, i);
  const summary = rows.findIndex((r, i) => i < itemsEnd && SUMMARY_RE.test(r) && AMOUNT_END_RE.test(r));
  const singles = !GDU_STORES.has(store ?? '') && !rows.some((r) => UNIT_ROW_RE.test(r)) && !macroFormat;
  const singlesEnd = !singles ? 0 : summary >= 0 ? summary : itemsEnd;
  const qtyColumn = rows.some((r) => QTY_COLUMN_HEADER_RE.test(r));
  for (let i = 0; i < singlesEnd; i++) {
    const n = used.has(i) || doubtful.has(i) ? null : NAME_AMOUNT_RE.exec(rows[i]);
    const amount = n ? parseNumber(n[3]) : 0;
    const item = n && amount > 0 && isSingleItem(rows[i], n[2]) ? singleItem(n[2], amount, qtyColumn) : null;
    if (n && item) add(makeLine(rows[i], n[1], item.description, item.qty, item.price, amount, 'UN'), i);
  }

  // 5) Descuentos (monto negativo). Justo debajo de un producto (o del renglón de su promoción) se le resta, sin dejarlo
  //    por debajo de 0; si no, o si es del banco, de una ley o un porcentaje de toda la compra, es de toda la compra y no
  //    cambia los productos. Después del total ya no cuentan (Ley 19.210, banco, la adenda)
  const sumAbove = (i: number) => lines.reduce((a, l) => (span.get(l)!.end < i ? a + l.amount : a), bagsSum);
  /** Anulación: la misma descripción con monto negativo y abajo la cantidad negativa («-1.000 UN x 135.00»): saca el producto */
  const voids = (i: number, amount: number) => {
    const n = NAME_AMOUNT_RE.exec(rows[i]);
    const next = rows[i + 1] ?? '';
    const name = n && /^\s*-/.test(next) && isQtyLike(next) ? normalizeAlias(n[2].replace(VOID_PREFIX_RE, '')) : null;
    const line = name ? lines.find((l) => normalizeAlias(l.description) === name && l.amount + amount > -0.005) : undefined;
    if (!line) return false;
    used.add(i + 1);
    const left = round2(line.amount + amount);
    if (left < 0.01) lines.splice(lines.indexOf(line), 1);
    else Object.assign(line, makeLine(line.raw, line.storeCode ?? undefined, line.description, round2((line.quantity * left) / line.amount), line.unitPrice, left, line.weighed ? 'KG' : 'UN'));
    return true;
  };
  rows.forEach((row, i) => {
    if (used.has(i) || QTY_LINE_RE.test(row)) return;
    const amount = discountOf(row);
    if (amount == null) return;
    used.add(i);
    if (i > itemsEnd || voids(i, amount)) return;
    // Entre el producto y su descuento puede ir el renglón de la promoción («OFERTA 2DA AL 50%»)
    let k = i - 1;
    let label = row;
    while (k >= 0 && !used.has(k) && isPromoLabel(rows[k])) label = `${rows[k--]} ${label}`;
    const item = lines.find((l) => span.get(l)!.end === k);
    // (Pengar) Cómo se llama el renglón: sin el monto; si es solo el monto, el nombre puede estar abajo («-9,18» / «DESC. SOCIO»)
    const after = rows[i + 1] ?? '';
    const description = label.replace(NEGATIVE_END_RE, '$1').trim() || (!used.has(i + 1) && isPromoLabel(after) ? after : 'Descuento');
    if (item && item.amount + amount >= 0 && !isReceiptDiscount(label, amount, item.amount, sumAbove(i))) {
      item.amount = round2(item.amount + amount);
      item.promo = true;
      span.get(item)!.end = i;
      ownDiscounts.set(item, [...(ownDiscounts.get(item) ?? []), { description, amount }]);
    } else {
      discounts += amount;
      extras.push({ at: i, description, amount });
    }
  });

  lines.sort((a, b) => span.get(a)!.start - span.get(b)!.start);
  const sum = lines.reduce((a, l) => a + l.amount, 0);
  const difference = total == null ? null : round2(sum + bagsSum + rounding + discounts - total);
  // La suma cierra con el total, así que los montos están bien: donde cantidad × precio no da el monto, se corrige la
  // cantidad (si así cierra con unidades enteras) o el precio
  if (difference === 0) {
    for (const l of lines) {
      if (l.promo || consistent(l.quantity, l.unitPrice, l.amount)) continue;
      const q = Math.round(l.amount / l.unitPrice);
      if (!l.weighed && closes(q, l.unitPrice, l.amount)) Object.assign(l, { quantity: q, units: q * l.packSize });
      else if (l.quantity > 0) l.unitPrice = round2(l.amount / l.quantity);
    }
  }

  // (Pengar) Los renglones de plata en el orden del ticket: cada producto con su monto impreso y abajo sus descuentos
  const entries: ReceiptEntry[] = [];
  const inOrder = [
    ...lines.map((line) => ({ at: span.get(line)!.start, line, extra: null })),
    ...extras.map((extra) => ({ at: extra.at, line: null, extra })),
  ].sort((a, b) => a.at - b.at);
  for (const { line, extra } of inOrder) {
    if (extra) entries.push({ description: extra.description, amount: round2(extra.amount) });
    if (!line) continue;
    const own = ownDiscounts.get(line) ?? [];
    const of = entries.length;
    entries.push({ description: line.description, amount: round2(line.amount - own.reduce((a, d) => a + d.amount, 0)) });
    for (const d of own) entries.push({ description: d.description, amount: round2(d.amount), of });
  }

  return { store, date: detectDate(text), lines, ignored, total, discounts: round2(discounts), difference, entries };
}


/** Puntaje de un ticket que encontró el TOTAL y cierra con él */
export const RECEIPT_CLOSES = 10_000;

/** Renglón «texto monto» de la foto: el texto y si el monto es negativo */
const ROW_AMOUNT_RE = /^(.*\p{L}{3}.*?)\s+[$S]?\s*(-?)\s*\$?\s*\d[\d.,]*[.,]\d{2}\s*[A-Z]?$/u;

/**
 * Qué tan bien se leyeron los renglones de la foto de un ticket, para elegir entre formas de armarlos: primero que
 * encuentre el TOTAL, después que la suma cierre, después que cada monto vaya con su renglón (los descuentos con un
 * monto negativo: si la foto se arma corrida, se cruzan) y después cuántos productos.
 * (Un renglón que cuesta lo mismo que el TOTAL no cuenta: es el total pegado a otro renglón.)
 */
export function receiptLinesScore(rows: string[]): number {
  const r = parseReceiptText(rows.join('\n'));
  const items = r.lines.filter((l) => r.total == null || Math.abs(l.amount - r.total) >= 0.5).length;
  const closes = r.total != null && r.difference != null && Math.abs(r.difference) < 0.5;
  return (r.total == null ? -100_000 : 0) + (closes ? RECEIPT_CLOSES : 0) + discountsFit(rows) * 3 + items;
}

/** Cuántos descuentos van con un monto negativo, menos los que no (si la foto se arma corrida, se cruzan) */
export function discountsFit(rows: string[]): number {
  let fit = 0;
  for (const row of rows) {
    const m = ROW_AMOUNT_RE.exec(row);
    if (!m || NOT_ITEM_RE.test(m[1]) || NOT_ITEM_START_RE.test(m[1])) continue;
    // Un descuento con monto positivo está cruzado con el renglón de al lado (al revés no se sabe: «TIENDA DIAS LUNES»
    // es un descuento sin decirlo)
    if (DISCOUNT_RE.test(m[1])) fit += m[2] === '-' ? 1 : -1;
  }
  return fit;
}
