export const THEME_STORAGE_KEY = 'ledgerlite-theme';

export type ThemeName = 'cobalt' | 'mint';

export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='mint'||t==='cobalt')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export function currentTheme(): ThemeName {
  if (typeof document === 'undefined') return 'cobalt';
  return document.documentElement.dataset.theme === 'mint' ? 'mint' : 'cobalt';
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Preference is visual only; the page still switches for this visit.
  }
}
