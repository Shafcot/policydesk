// Light / dark mode, remembered per browser. Light (blue & white) is the default.
import { useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'pd-theme';
export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
export function applyTheme(t: Theme) {
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(KEY, t); } catch { /* storage blocked: still applies for this visit */ }
}
export function useTheme() {
  const [theme, set] = useState<Theme>(currentTheme);
  return { theme, toggle: () => { const t: Theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(t); set(t); } };
}
