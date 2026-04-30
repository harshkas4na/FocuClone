/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Studio Dark palette
        bg: '#0E1014',
        'bg-0': '#08090C',
        'bg-1': '#0E1014',
        'bg-2': '#15171C',
        'bg-3': '#1C1F26',
        'bg-4': '#242832',
        panel: '#15171C',
        panel2: '#1C1F26',
        accent: '#FF5C2B',
        'accent-hi': '#FF7A4D',
        'accent-lo': '#C73F18',
        muted: '#6E7079',
        'fg-1': '#F5F5F7',
        'fg-2': '#A8AAB2',
        'fg-3': '#6E7079',
        'fg-4': '#4A4D55',
        rec: '#FF3B3B',
        ok: '#34D399',
        warn: '#F5B544',
        err: '#FF6B6B'
      },
      fontFamily: {
        ui: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'Menlo', 'monospace']
      }
    }
  },
  plugins: []
}
