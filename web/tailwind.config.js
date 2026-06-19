/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './embed-demo.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        hair: 'var(--hair)',
        'hair-soft': 'var(--hair-soft)',
        ink: 'var(--text)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-faint)',
        brand: {
          DEFAULT: 'var(--brand)',
          light: 'var(--brand-light)',
          dark: 'var(--brand-dark)',
          fg: 'var(--brand-fg)',
        },
      },
      fontFamily: {
        display: ['"Playfair Display"', 'Georgia', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        lux: '0 24px 60px -24px rgba(0,0,0,0.7)',
        'gold-glow': '0 8px 30px -8px var(--brand-glow)',
      },
      borderRadius: {
        '2xl': '1.1rem',
      },
    },
  },
  plugins: [],
};
