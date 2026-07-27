/**
 * Mirrors the config that used to live inline in index.html above the Play CDN
 * script. Keep the two in sync if you ever add a token — this file is now the
 * only source of truth.
 */
module.exports = {
  // Only index.html uses Tailwind. admin.html and badge.html have their own
  // hand-written CSS and must not be scanned (they'd add unused utilities).
  content: ['./index.html'],
  // `:class="'object-' + p.imgFit"` builds a class name at runtime, so the
  // scanner cannot see it. imgFit is currently never set on any record, but the
  // code path exists — safelist the whole set so it cannot silently break.
  safelist: [
    'object-cover',
    'object-contain',
    'object-fill',
    'object-none',
    'object-scale-down',
  ],
  theme: {
    extend: {
      colors: {
        ink:  { 950: '#050608', 900: '#0b0d11', 800: '#14171c', 700: '#1c2027', 600: '#2a2f38' },
        steel: { 700: '#1a3057', 600: '#2c4a78', 500: '#3e6aa8', 400: '#6f96c8' },
        ice: '#a8c4e6',
        electric: '#1a8cff',
        gold: '#c9a449',
        amber: '#e8b94a',
        green: '#6fb47a',
        priority: '#e8794c',
      },
      fontFamily: {
        sans: ['Barlow', 'system-ui', 'sans-serif'],
        condensed: ['"Barlow Condensed"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        card: '0 8px 32px rgba(0,0,0,0.4)',
        priority: '0 0 0 1px rgba(232,121,76,.18), 0 8px 32px rgba(0,0,0,.5)',
      },
    },
  },
  plugins: [],
};
