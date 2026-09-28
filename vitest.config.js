import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // La app arma fechas en hora local (`setHours(0,0,0,0)`, `new Date(y,m,d)`).
    // Fijar la zona hace que "cuantos dias faltan" de lo mismo en cualquier
    // maquina; Argentina ademas no tiene horario de verano que corra un dia.
    env: { TZ: 'America/Argentina/Buenos_Aires' },
  },
});
