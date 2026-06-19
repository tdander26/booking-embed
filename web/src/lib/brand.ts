/** Apply a brand color to the CSS variables Tailwind reads. */
export function applyBrand(color?: string): void {
  if (!color) return;
  const root = document.documentElement;
  root.style.setProperty('--brand', color);
  root.style.setProperty('--brand-fg', readableForeground(color));
}

/** Apply the booking-page color theme. 'auto' follows the device preference.
 * Sets data-theme on <html>, which the CSS variable system reads (styles.css). */
export function applyTheme(theme?: 'dark' | 'light' | 'auto'): void {
  let mode: 'dark' | 'light' = 'dark';
  if (theme === 'light') mode = 'light';
  else if (theme === 'auto') {
    mode = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', mode);
}

function readableForeground(hex: string): string {
  const c = hex.replace('#', '');
  if (c.length !== 6) return '#ffffff';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  // Relative luminance; dark text on light brand, white on dark brand.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0f172a' : '#ffffff';
}
