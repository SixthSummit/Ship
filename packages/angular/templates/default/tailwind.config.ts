/** @type {import('tailwindcss').Config} */
module.exports = {
  important: true,
  darkMode: 'class',
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        // Base palette for accents and text
        primary: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#b6d3ff',
          300: '#8bb6ff',
          400: '#5a90ff',
          500: '#3a6bff',
          600: '#2a52e6',
          700: '#243ec0',
          800: '#1f3398',
          900: '#1c2c7b',
        },
        // Helpful tints for borders/lines over glass
        line: {
          light: 'rgba(255,255,255,0.35)',
        },
        // Optional page background gradients
        canvas: {
          light: '#0b1220',
        },
      },
      backdropBlur: {
        xs: '2px',
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '24px',
      },
      boxShadow: {
        glass: '0 8px 30px rgba(0,0,0,0.25)',
        'glass-sm': '0 6px 18px rgba(0,0,0,0.18)',
        glow: '0 0 0 1px rgba(255,255,255,0.15), 0 0 32px rgba(59,130,246,0.25)',
        'neon-blue': '0 0 24px rgba(59,130,246,0.45)',
      },
      borderRadius: {
        glass: '1rem',
        '2xl': '1.25rem',
      },
      backgroundImage: {
        // soft sheen for depth
        'glass-sheen':
          'linear-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 100%)',
      },
    },
  },
  plugins: [
    // Minimal utilities for glass components
    function ({ addUtilities, theme }: { addUtilities: any; theme: any }) {
      const utilities = {
        /* Light mode glass */
        '.glass': {
          backgroundColor: 'rgba(255,255,255,0.12)',
          backgroundImage: theme('backgroundImage.glass-sheen'),
          border: `1px solid ${theme('colors.line.light')}`,
          boxShadow: theme('boxShadow.glass-sm'),
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderRadius: theme('borderRadius.glass'),
        },
        '.glass-strong': {
          backgroundColor: 'rgba(255,255,255,0.18)',
          backgroundImage: theme('backgroundImage.glass-sheen'),
          border: `1px solid ${theme('colors.line.light')}`,
          boxShadow: theme('boxShadow.glass'),
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderRadius: theme("borderRadius['2xl']"),
        },
        '.glass-glow': {
          boxShadow: theme('boxShadow.glow'),
        },
        '.glass-neon': {
          boxShadow: theme("boxShadow['neon-blue']"),
        },
      };

      addUtilities(utilities, ['responsive', 'hover', 'focus', 'active']);
    },
  ],
};
