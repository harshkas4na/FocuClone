/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0e0e10',
        panel: '#17171a',
        panel2: '#1f1f23',
        accent: '#f97316',
        muted: '#5d5d66'
      }
    }
  },
  plugins: []
}
