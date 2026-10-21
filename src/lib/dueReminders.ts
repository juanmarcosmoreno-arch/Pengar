/**
 * Avisos del iPhone para pagar la tarjeta: el día antes del vencimiento de cada estado de cuenta (a las 10) y el mismo
 * día (a las 9), salvo que ya se haya marcado pagado. Se reprograman cada vez que cambian los estados de cuenta.
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { addDays, today } from '../domain/dates';
import { cardName } from '../domain/installments';
import type { Invoice } from '../domain/types';
import { canRemind } from './reportReminder';

const FIRST = 7200;
const LAST = 7299;

/** Pide permiso para los avisos (la primera vez, iOS pregunta) */
export async function askDuePermission(): Promise<void> {
  if (!canRemind) return;
  try { await LocalNotifications.requestPermissions(); } catch { /* sin avisos */ }
}

export async function syncDueReminders(invoices: Invoice[]): Promise<void> {
  if (!canRemind) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    const { notifications } = await LocalNotifications.getPending();
    const old = notifications.filter((n) => n.id >= FIRST && n.id <= LAST).map((n) => ({ id: n.id }));
    if (old.length) await LocalNotifications.cancel({ notifications: old });
    if (display !== 'granted') return;
    const now = today();
    const due = invoices.filter((i) => i.kind === 'estado' && i.due && !i.paid && i.due >= now).sort((a, b) => a.due!.localeCompare(b.due!)).slice(0, 40);
    let id = FIRST;
    const list = [];
    for (const inv of due) {
      const [y, m, d] = inv.due!.split('-').map(Number);
      const before = addDays(inv.due!, -1);
      const [by, bm, bd] = before.split('-').map(Number);
      if (before >= now) list.push({ id: id++, title: `Mañana vence ${cardName(inv)}`, body: 'No te olvides de pagar la tarjeta.', schedule: { at: new Date(by, bm - 1, bd, 10, 0) } });
      list.push({ id: id++, title: `Hoy vence ${cardName(inv)}`, body: 'No te olvides de pagar la tarjeta. Si ya pagaste, marcalo en Inicio.', schedule: { at: new Date(y, m - 1, d, 9, 0) } });
    }
    const future = list.filter((n) => n.schedule.at.getTime() > Date.now());
    if (future.length) await LocalNotifications.schedule({ notifications: future });
  } catch (e) {
    console.warn('No se pudieron programar los avisos de la tarjeta', e);
  }
}
