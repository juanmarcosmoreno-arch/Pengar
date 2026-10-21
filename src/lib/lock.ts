/**
 * Bloqueo con Face ID (plugin PengarLock, LocalAuthentication): si Face ID falla, el iPhone ofrece su código. En la
 * web y en la vista previa no hay. La tapa del selector de apps la pone el iPhone (SceneDelegate) si está prendido.
 */
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';
import type { AppEvent } from '../domain/lock';
import { isNative, isPreview } from './platform';

export type Biometry = 'faceID' | 'touchID' | 'opticID' | 'none';
/** `available`: hay Face ID, Touch ID o al menos el código del iPhone */
export interface LockAvailability {
  biometry: Biometry;
  available: boolean;
}
export type AuthResult = 'ok' | 'cancel' | 'fallback' | 'lockout' | 'notAvailable' | 'failed';

interface PengarLockPlugin {
  availability(): Promise<LockAvailability>;
  authenticate(options: { reason: string }): Promise<void>;
  setPrivacyCover(options: { enabled: boolean }): Promise<void>;
}

const PengarLock = registerPlugin<PengarLockPlugin>('PengarLock');

export const canLock = isNative && !isPreview;

const NONE: LockAvailability = { biometry: 'none', available: false };
const BIOMETRY: Biometry[] = ['faceID', 'touchID', 'opticID', 'none'];
const FAILURES: AuthResult[] = ['cancel', 'fallback', 'lockout', 'notAvailable', 'failed'];

export async function lockAvailability(): Promise<LockAvailability> {
  if (!canLock) return NONE;
  try {
    const res = await PengarLock.availability();
    return { biometry: BIOMETRY.includes(res.biometry) ? res.biometry : 'none', available: res.available === true };
  } catch {
    // Sin el plugin (una app vieja): como si no hubiera
    return NONE;
  }
}

/** Pide Face ID (o el código). Nunca tira: dice cómo terminó */
export async function authenticate(reason: string): Promise<AuthResult> {
  if (!canLock) return 'notAvailable';
  try {
    await PengarLock.authenticate({ reason });
    return 'ok';
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return FAILURES.find((f) => f === code) ?? 'failed';
  }
}

/** El iPhone tapa la app en el selector de apps solo con el bloqueo prendido (lo recuerda aunque se cierre) */
export async function setPrivacyCover(enabled: boolean): Promise<void> {
  if (!canLock) return;
  await PengarLock.setPrivacyCover({ enabled }).catch(() => {});
}

/** «Face ID», «Touch ID», «Optic ID» o «el código» (sin biometría, el del iPhone) */
export const unlockName = (b: Biometry) => ({ faceID: 'Face ID', touchID: 'Touch ID', opticID: 'Optic ID', none: 'el código' })[b];

/** Lo que pasa con la app (ver domain/lock: trackAway). Devuelve cómo dejar de escuchar */
export function onAppState(run: (event: AppEvent) => void): () => void {
  if (!canLock) return () => {};
  const handles = [
    App.addListener('appStateChange', ({ isActive }) => run(isActive ? 'active' : 'inactive')),
    App.addListener('pause', () => run('background')),
    // Vuelve de segundo plano (llega antes del appStateChange): por si el aviso de salida no llegó a la web
    App.addListener('resume', () => run('background')),
  ];
  return () => handles.forEach((h) => void h.then((x) => x.remove()));
}
