// El helper mismo. Si `cargar` dejara pasar un nombre que no existe, un
// rename en index.html dejaria los tests probando `undefined` en silencio.
import { describe, it, expect } from 'vitest';
import { cargar } from './cargar.js';

describe('cargar', () => {
  it('falla claro si un nombre pedido no existe', () => {
    expect(() => cargar(['adsDot', 'funcionQueNoExiste'])).toThrow(
      /no existe "funcionQueNoExiste" como declaracion de nivel superior/,
    );
  });

  it('solo evalua lo pedido: lo demas del script no esta en el contexto', () => {
    const { hc, ctx } = cargar(['hc']);
    expect(hc('green')).toMatch(/^#/);
    // `adsDot` vive en el mismo archivo pero no se pidio.
    expect('adsDot' in ctx).toBe(false);
    expect(typeof ctx.document).toBe('undefined');
  });
});
