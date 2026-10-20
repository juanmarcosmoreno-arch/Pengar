/** Modo oscuro: sigue al iPhone, salvo que se elija otro en Ajustes (se recuerda en este dispositivo). */
export type ThemeChoice = 'auto' | 'light' | 'dark';

const KEY = 'pengar-theme';
const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function getTheme(): ThemeChoice {
  try {
    return (localStorage.getItem(KEY) as ThemeChoice) || 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(choice: ThemeChoice = getTheme()) {
  const dark = choice === 'dark' || (choice === 'auto' && !!media?.matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function setTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* sin almacenamiento: vale solo por esta sesión */
  }
  applyTheme(choice);
}

media?.addEventListener('change', () => applyTheme());
