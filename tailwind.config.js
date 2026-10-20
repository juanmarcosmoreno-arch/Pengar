/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        sunken: v('sunken'),
        ink: v('ink'),
        muted: v('muted'),
        line: v('line'),
        primary: v('primary'),
        soft: v('soft'),
        'on-primary': v('on-primary'),
        ok: v('ok'),
        danger: v('danger'),
      },
      fontFamily: {
        hand: ['"Patrick Hand"', 'ui-rounded', 'system-ui', 'sans-serif'],
        sans: ['"Patrick Hand"', 'ui-rounded', 'system-ui', 'sans-serif'],
      },
      spacing: {
        'safe-t': 'env(safe-area-inset-top)',
        'safe-b': 'env(safe-area-inset-bottom)',
      },
      minHeight: { tap: '44px' },
      minWidth: { tap: '44px' },
    },
  },
  plugins: [],
};
