/**
 * Ajustes de ESTE teléfono: no van en los datos, así que tampoco viajan en los respaldos ni se van a compartir
 * con el hogar. Se guardan aparte, en IndexedDB (clave 'device').
 *
 * `name` (quién lo usa) y `ai` (la clave de Claude, que no va en los respaldos) quedan en Settings, pero el hogar
 * compartido no los manda: son de cada persona (ver domain/sync.ts).
 */
import { normalizeAutoBackup, type AutoBackupState } from '../domain/autoBackup';
import { LOCK_AFTER, type LockAfter } from '../domain/lock';
import { readDevice, writeDevice } from './db';
import { isNative, isPreview } from './platform';

export interface Device {
  /** Bloqueo con Face ID (o el código del iPhone) al abrir y al volver después de `after` segundos afuera */
  lock: { enabled: boolean; after: LockAfter };
  /** Aviso del resumen el 1 de cada mes: la notificación la programa este teléfono (antes estaba en Settings) */
  reportReminder: boolean;
  /** Respaldo automático en iCloud Drive o en Archivos (lib/autoBackup): prendido de fábrica en el iPhone */
  autoBackup: AutoBackupState;
  /**
   * Modo demo: se ven los datos inventados (guardados aparte: domain/demo) en lugar de los de verdad. Al abrir la app
   * con esto prendido arranca en el demo; salir pide Face ID o el código del iPhone
   */
  demo: boolean;
  /** La animación del suricata al abrir la app (components/Intro): prendida de fábrica */
  intro: boolean;
  /** Avisar en Inicio si al ritmo del mes no llegás a fin de mes */
  forecast: boolean;
}

const autoBackupByDefault = isNative && !isPreview;

export const defaultDevice = (): Device => ({ lock: { enabled: false, after: 0 }, reportReminder: false, autoBackup: { enabled: autoBackupByDefault }, demo: false, intro: true, forecast: true });

/** Completa lo que falte y descarta lo que no sirve (lo guardado por otra versión, o nada) */
export function normalizeDevice(raw: unknown): Device {
  const base = defaultDevice();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as { lock?: { enabled?: unknown; after?: unknown }; reportReminder?: unknown; autoBackup?: unknown; demo?: unknown; intro?: unknown; forecast?: unknown };
  const after = LOCK_AFTER.find((a) => a === r.lock?.after) ?? base.lock.after;
  return {
    lock: { enabled: r.lock?.enabled === true, after },
    reportReminder: r.reportReminder === true,
    autoBackup: normalizeAutoBackup(r.autoBackup, autoBackupByDefault),
    demo: r.demo === true,
    // Solo un «no» explícito la apaga (lo guardado antes de que existiera la tiene prendida)
    intro: r.intro !== false,
    forecast: r.forecast !== false,
  };
}

/** Lo guardado (o lo de fábrica). Si no se pudo leer, tira */
export async function loadDevice(): Promise<Device> {
  return normalizeDevice(await readDevice());
}

/** false si quedó solo en memoria (la vista previa sin lugar). Si no se pudo guardar, tira */
export const saveDevice = (d: Device) => writeDevice(d);
