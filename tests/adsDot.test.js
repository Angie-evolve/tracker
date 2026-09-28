// El punto del sidebar y el LIVE de la ficha. Es lo primero que se mira para
// saber si un cliente esta al aire, asi que un falso verde es un cliente
// desatendido que parece atendido.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cargar } from './cargar.js';

// getActiveLine y hc son puras: van las reales, no un stub que podria
// "acertar" por casualidad.
const { adsDot } = cargar(['adsDot', 'getActiveLine', 'hc']);

// Una linea de conversion vigente, con las campanas que se le pasen.
function cliente({ camps = [], fuera = [], gasto = 0, token = false } = {}) {
  return {
    name: 'Ferreteria Ejemplo',
    metaToken: token ? 'no-es-un-token' : undefined,
    conversionLines: [
      { dateStart: '2026-08-01', metaCampaigns: camps, excludedCampaigns: fuera },
    ],
    liveLines: gasto ? [{ rolling: true, metrics: { adSpent: gasto } }] : [],
  };
}
// Campana -> conjunto -> anuncio, cada nivel con su status.
function camp(id, cpSt, asSt = cpSt, adSt = asSt) {
  return { id, status: cpSt, adsets: [{ status: asSt, ads: [{ status: adSt }] }] };
}

describe('adsDot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('verde y LIVE con los tres niveles activos', () => {
    const r = adsDot(cliente({ camps: [camp('c1', 'ACTIVE')] }));
    expect(r.state).toBe('green');
    expect(r.live).toBe(true);
  });

  // Regresion de 04fb327: pausar a nivel conjunto no cambia el status de la
  // campana en Meta, y mirar solo la campana daba LIVE con todo apagado.
  it('campana ACTIVE con el conjunto pausado NO es LIVE', () => {
    const r = adsDot(cliente({ camps: [camp('c1', 'ACTIVE', 'PAUSED')] }));
    expect(r.live).toBe(false);
    expect(r.state).toBe('amber');
  });

  it('sin el arbol sincronizado cae al status de la campana', () => {
    const r = adsDot(cliente({ camps: [{ id: 'c1', status: 'ACTIVE' }] }));
    expect(r.live).toBe(true);
  });

  // Regresion de 73545bc: una campana ajena, destildada, prendia el LIVE
  // aunque la nuestra estuviera pausada.
  it('una campana destildada prendida no hace LIVE', () => {
    const r = adsDot(
      cliente({
        camps: [camp('ajena', 'ACTIVE'), camp('nuestra', 'PAUSED')],
        fuera: ['ajena'],
      }),
    );
    expect(r.live).toBe(false);
  });

  // Regresion de 73545bc: destildarlas todas caia en la rama "no hay
  // campanas", que decide por el gasto de 7 dias de esas mismas campanas
  // ajenas, y volvia a dar LIVE por la ventana.
  it('todas destildadas con gasto en la ventana: gris, no LIVE', () => {
    const r = adsDot(
      cliente({
        camps: [camp('a1', 'ACTIVE'), camp('a2', 'ACTIVE')],
        fuera: ['a1', 'a2'],
        gasto: 500,
        token: true,
      }),
    );
    expect(r.live).toBe(false);
    expect(r.state).toBe('gray');
  });

  it('sin campanas: decide el gasto de 7 dias, y sin Meta queda gris', () => {
    expect(adsDot(cliente({ gasto: 120 })).state).toBe('green');
    expect(adsDot(cliente({ token: true })).state).toBe('amber');
    const sinNada = adsDot(cliente());
    expect(sinNada.state).toBe('gray');
    expect(sinNada.live).toBe(false);
  });
});
