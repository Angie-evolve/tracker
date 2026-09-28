// La cuenta regresiva al lanzamiento (onboarding + N dias) y `_yaLanzo`, que
// le gana a la cuenta cuando hay campanas nuestras al aire.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cargar } from './cargar.js';

// La ruta de etapas vive en la configuracion (DB/S); aca va fija. El resto
// son helpers puras de la app y van las reales.
const RUTA = [
  { l: 'Diagnostico' },
  { l: 'Onboarding', kw: 'onboarding, kickoff' },
  { l: 'Lanzamiento', dia: null },
];
const stubs = {
  rutaColumnas: () => RUTA,
  // El alta real sale de facturacion; aca la decide cada test.
  clienteAlta: (c) => (c.altaDePrueba ? new Date(c.altaDePrueba) : null),
};
const { _lanzaCuenta, _yaLanzo } = cargar(
  [
    '_lanzaCuenta',
    '_yaLanzo',
    '_p360DiasCampanas',
    'getActiveLine',
    'esProspecto',
    'parseDDMMYYYY',
    '_rutaRe',
  ],
  stubs,
  // `_yaLanzo` nacio en 73545bc: contra versiones de antes se carga sin el.
  { opcionales: ['_yaLanzo'] },
);

describe('_lanzaCuenta', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0)); // 15/09/2026
    RUTA[2].dia = null;
  });
  afterEach(() => vi.useRealTimers());

  it('un prospecto no tiene cuenta regresiva', () => {
    expect(_lanzaCuenta({ prospecto: true, altaDePrueba: '2026-09-01T12:00' })).toBeNull();
  });

  it('arranca en la reunion de onboarding y promete 30 dias', () => {
    const r = _lanzaCuenta({
      citas: { Onboarding: { inicio: '2026-09-01T15:00:00-03:00', estado: 'confirmed' } },
    });
    expect(r.total).toBe(30);
    expect(r.dia).toBe(14);
    expect(r.faltan).toBe(16);
  });

  it('una cita cancelada no cuenta: pasa a la fecha agendada a mano', () => {
    const r = _lanzaCuenta({
      citas: { Onboarding: { inicio: '2026-09-01T15:00:00-03:00', estado: 'cancelled' } },
      rutaAgenda: { Onboarding: '10/09/2026' },
    });
    expect(r.dia).toBe(5);
    expect(r.faltan).toBe(25);
  });

  it('sin cita toma la llamada de onboarding mas vieja, no cualquier llamada', () => {
    const r = _lanzaCuenta({
      fathomCalls: [
        { title: 'Diagnostico inicial', date: '01/08/2026' },
        { title: 'Kickoff Ferreteria Ejemplo', date: '05/09/2026' },
        { title: 'Onboarding parte 2', date: '08/09/2026' },
      ],
    });
    expect(r.ini.getDate()).toBe(5);
    expect(r.dia).toBe(10);
  });

  it('respeta el dia de lanzamiento de la ruta y cae al alta como ultimo recurso', () => {
    RUTA[2].dia = 45;
    const r = _lanzaCuenta({ altaDePrueba: '2026-09-01T12:00:00' });
    expect(r.total).toBe(45);
    expect(r.faltan).toBe(31);
    expect(_lanzaCuenta({})).toBeNull(); // sin ninguna fecha no hay reloj
  });
});

describe('_yaLanzo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0));
    RUTA[2].dia = null; // los 30 dias por defecto, no lo que dejo otro test
  });
  afterEach(() => vi.useRealTimers());

  // Regresion de 73545bc: "proximos a lanzar" anunciaba "faltan 2 d" a un
  // cliente con una campana corriendo hacia 8. La cuenta es una proyeccion;
  // lo que dice si lanzo son las campanas.
  it('la cuenta dice que faltan 2 dias, pero las campanas ya corren hace 8', () => {
    const c = {
      citas: { Onboarding: { inicio: '2026-08-18T15:00:00-03:00' } },
      conversionLines: [
        {
          dateStart: '2026-08-01',
          metaCampaigns: [{ id: 'n1', status: 'ACTIVE', startTime: '2026-09-07T10:00:00-03:00' }],
          excludedCampaigns: [],
        },
      ],
    };
    expect(_lanzaCuenta(c).faltan).toBe(2);
    expect(_yaLanzo).toBeTypeOf('function');
    expect(_yaLanzo(c)).toEqual({ dias: 8, cuantas: 1 });
  });

  it('una campana ajena destildada no cuenta como lanzamiento', () => {
    const c = {
      conversionLines: [
        {
          dateStart: '2026-08-01',
          metaCampaigns: [{ id: 'aj', status: 'ACTIVE', startTime: '2026-03-01T10:00:00-03:00' }],
          excludedCampaigns: ['aj'],
        },
      ],
    };
    expect(_yaLanzo(c)).toBeNull();
  });
});
