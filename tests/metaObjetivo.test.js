// Cual es "el resultado" de un conjunto: el evento por el que optimiza, como
// lo muestra Ads Manager. Si se equivoca, la columna de resultados muestra
// otro numero que Meta (ya paso: 11 donde Meta decia 48).
import { describe, it, expect } from 'vitest';
import { cargar } from './cargar.js';

const { _metaObjetivoResultado, _metaObjCampana } = cargar([
  '_metaObjetivoResultado',
  '_metaObjCampana',
  '_META_EV_BALDE',
  '_META_OPT_BALDE',
  '_cfgEs',
  '_EV_ES',
]);

describe('_metaObjetivoResultado', () => {
  it('formulario nativo optimizado por leads', () => {
    expect(_metaObjetivoResultado({ optimization_goal: 'LEAD_GENERATION' })).toEqual({
      clave: 'leads',
      nombre: 'Clientes potenciales',
    });
  });

  it('conversiones del sitio: el evento sale de promoted_object', () => {
    const r = _metaObjetivoResultado({
      optimization_goal: 'OFFSITE_CONVERSIONS',
      promoted_object: { pixel_id: '000', custom_event_type: 'lead' },
    });
    expect(r).toEqual({ clave: 'leads', nombre: 'Lead' });
  });

  it('conversion personalizada lleva su id en la clave', () => {
    const r = _metaObjetivoResultado({
      optimization_goal: 'VALUE',
      promoted_object: { custom_conversion_id: '123' },
    });
    expect(r.clave).toBe('custom:123');
  });

  // Un balde inventado mostraria 0, que es peor que el numero aproximado.
  it('evento que no sabemos leer devuelve null, no un cero', () => {
    expect(
      _metaObjetivoResultado({
        optimization_goal: 'OFFSITE_CONVERSIONS',
        promoted_object: { custom_event_type: 'ADD_TO_CART' },
      }),
    ).toBeNull();
    expect(_metaObjetivoResultado({ optimization_goal: 'OFFSITE_CONVERSIONS' })).toBeNull();
    expect(_metaObjetivoResultado(null)).toBeNull();
  });

  // Regresion de 1e44454: el conjunto ya guardado solo conserva `optGoal`
  // (sin `optimization_goal` ni `promoted_object`), y la funcion devolvia null.
  it('acepta la forma guardada, con optGoal', () => {
    expect(_metaObjetivoResultado({ optGoal: 'LEAD_GENERATION' })).toEqual({
      clave: 'leads',
      nombre: 'Clientes potenciales',
    });
  });

  // Regresion de 1e44454: la campana recalculaba sobre los conjuntos ya
  // mapeados y caia al orden viejo. El conjunto decia 48 y la campana 11.
  it('la campana lee el objResultado guardado de sus conjuntos', () => {
    const obj = { clave: 'leads', nombre: 'Lead' };
    const camp = {
      adsets: [
        { optGoal: 'OFFSITE_CONVERSIONS', objResultado: obj },
        { optGoal: 'OFFSITE_CONVERSIONS', objResultado: obj },
      ],
    };
    expect(_metaObjCampana(camp)).toEqual(obj);
    // Si los conjuntos optimizan por cosas distintas no hay una columna limpia.
    camp.adsets[1] = { objResultado: { clave: 'compras', nombre: 'Compra' } };
    expect(_metaObjCampana(camp)).toBeNull();
  });
});
