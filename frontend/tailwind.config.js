/** @type {import('tailwindcss').Config} */

const channel = (token) => `rgb(var(--${token}) / <alpha-value>)`;

function scale(name) {
  return Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [step, channel(`${name}-${step}`)]),
  );
}

module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
      },
      colors: {
        slate: scale('slate'),
        blue: scale('blue'),
        emerald: scale('blue'),
        green: scale('blue'),
        amber: scale('amber'),
        red: {
          50: '#f8efe9',
          100: '#f3e0d6',
          200: '#ead0c4',
          300: '#d7aa9a',
          400: '#b56d5c',
          500: '#9a5344',
          600: '#8a4034',
          700: '#6e3329',
          800: '#552820',
          900: '#3d1d18',
          950: '#24110d',
        },
      },
    },
  },
  plugins: [],
};
