// Cuantos dias llevan prendidas las campanas, y de ahi `_yaLanzo`, que decide
// si un cliente sale de "proximos a lanzar". Las dos tienen que tener la
// misma idea de que campana cuenta.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cargar } from './cargar.js';

const { _p360DiasCampanas } = cargar(['_p360DiasCampanas', 'getActiveLine']);

function cliente(camps, fuera = []) {
  return {
    conversionLines: [
      { dateStart: '2026-01-01', metaCampaigns: camps, excludedCampaigns: fuera },
    ],
  };
}

describe('_p360DiasCampanas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00-03:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('cuenta desde la activa mas vieja', () => {
    const r = _p360DiasCampanas(
      cliente([
        { id: 'a', status: 'ACTIVE', startTime: '2026-09-05T12:00:00-03:00' },
        { id: 'b', status: 'ACTIVE', startTime: '2026-08-29T12:00:00-03:00' },
      ]),
    );
    expect(r).toEqual({ dias: 17, cuantas: 2 });
  });

  // Regresion de 2ef99d3: una campana vieja del cliente, destildada, hacia
  // decir "prendida hace 200 dias". Filtrando tiene que dar la nuestra.
  it('las destildadas no cuentan', () => {
    const r = _p360DiasCampanas(
      cliente(
        [
          { id: 'vieja', status: 'ACTIVE', startTime: '2026-02-27T12:00:00-03:00' },
          { id: 'nuestra', status: 'ACTIVE', startTime: '2026-08-29T12:00:00-03:00' },
        ],
        ['vieja'],
      ),
    );
    expect(r).toEqual({ dias: 17, cuantas: 1 });
  });

  // Regresion de 39db33f: lo sincronizado antes de que se pidiera la fecha no
  // trae startTime. Devolver null se leia como "la funcion no anda".
  it('prendidas sin fecha avisan en vez de callar', () => {
    const r = _p360DiasCampanas(cliente([{ id: 'a', status: 'ACTIVE' }]));
    expect(r).toEqual({ sinFecha: true, cuantas: 1 });
  });

  it('las pausadas no cuentan', () => {
    expect(
      _p360DiasCampanas(cliente([{ id: 'a', status: 'PAUSED', startTime: '2026-08-01' }])),
    ).toBeNull();
  });

  // Regresion: una campana ACTIVE programada para la semana que viene sumaba
  // a `activas` antes de mirar la fecha, asi que devolvia `sinFecha` y
  // `_yaLanzo` la tomaba como lanzada: "Ya lanzo, sincroniza Meta" de un
  // cliente que no arranco.
  it('una programada a futuro no es "prendida sin fecha"', () => {
    const r = _p360DiasCampanas(
      cliente([{ id: 'b', status: 'ACTIVE', startTime: '2026-09-20T12:00:00-03:00' }]),
    );
    expect(r).toBeNull();
  });

  it('manda effectiveStatus sobre status', () => {
    const r = _p360DiasCampanas(
      cliente([
        {
          id: 'a',
          status: 'ACTIVE',
          effectiveStatus: 'CAMPAIGN_PAUSED',
          startTime: '2026-08-01T12:00:00-03:00',
        },
      ]),
    );
    expect(r).toBeNull();
  });
});
