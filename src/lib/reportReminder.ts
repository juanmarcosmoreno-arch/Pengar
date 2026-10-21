/**
 * Aviso del resumen del mes: una notificación local del iPhone el 1 de cada mes a las 9 (se programa en el
 * teléfono, sin servidor). En la web y en la vista previa no hay.
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative, isPreview } from './platform';

export const canRemind = isNative && !isPreview;

/** Id fijo del aviso: reprogramarlo pisa el anterior */
const ID = 7101;

async function scheduled(): Promise<boolean> {
  const { notifications } = await LocalNotifications.getPending();
  return notifications.some((n) => n.id === ID);
}

async function schedule(): Promise<void> {
  await LocalNotifications.schedule({
    notifications: [{
      id: ID,
      title: 'Tu resumen del mes está listo',
      body: 'Mirá cómo te fue el mes pasado: lo que entró, lo que gastaste y el presupuesto.',
      schedule: { on: { day: 1, hour: 9, minute: 0 }, repeats: true, allowWhileIdle: true },
      extra: { report: true },
    }],
  });
}

/** Pide permiso (la primera vez, iOS muestra su cartel) y programa el aviso. false si no lo permitieron */
export async function enableReminder(): Promise<boolean> {
  if (!canRemind) return false;
  try {
    const { display } = await LocalNotifications.requestPermissions();
    if (display !== 'granted') return false;
    if (!(await scheduled())) await schedule();
    return true;
  } catch (e) {
    console.warn('No se pudo programar el aviso', e);
    return false;
  }
}

export async function disableReminder(): Promise<void> {
  if (!canRemind) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: ID }] });
  } catch {
    /* no había nada que cancelar */
  }
}

/**
 * Deja el aviso como dice el ajuste (al abrir la app, o con datos nuevos: un respaldo, «Borrar todo»). Prendido, solo
 * lo programa si ya hay permiso: no muestra el cartel de iOS sin que lo pidan.
 */
export async function syncReminder(on: boolean): Promise<void> {
  if (!canRemind) return;
  if (!on) return disableReminder();
  try {
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
    if (!(await scheduled())) await schedule();
  } catch (e) {
    console.warn('No se pudo revisar el aviso', e);
  }
}

/** ¿Las notificaciones de Pengar se negaron en el iPhone? (el ajuste prendido no alcanza: hay que permitirlas en Ajustes) */
export async function reminderDenied(): Promise<boolean> {
  if (!canRemind) return false;
  try {
    return (await LocalNotifications.checkPermissions()).display === 'denied';
  } catch {
    return false;
  }
}

/** Al tocar el aviso (también si abrió la app: el evento espera a que haya quien lo escuche) */
export function onReminderTap(run: () => void): () => void {
  if (!canRemind) return () => {};
  const handle = LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
    if (a.notification.id === ID || a.notification.extra?.report) run();
  });
  return () => void handle.then((h) => h.remove());
}
