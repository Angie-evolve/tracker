// A que ficha va una reunion de Fathom. Un falso positivo mete la llamada de
// otra persona en un cliente (y alimenta su onboarding con eso); por eso casi
// todos estos casos son "esto NO tiene que engancharse".
//
// Todos los nombres son inventados. Los bugs se descubrieron con datos de
// verdad; aca se reproduce la misma FORMA con gente que no existe.
import { describe, it, expect, beforeEach } from 'vitest';
import { cargar } from './cargar.js';

// DB se pasa por referencia: cada test le cambia la lista de clientes.
const DB = { clients: [], personas: [] };
const { _fathomMatchClient } = cargar(
  [
    '_fathomMatchClient',
    '_n',
    'esProspecto',
    '_fathomMails',
    '_fathomSenas',
    '_fathomDomClave',
    '_fathomContiene',
    '_fathomAlias',
    '_fathomAliasUnicos',
  ],
  { DB },
  // Las tres ultimas nacieron en 143f401. Contra versiones de antes se cargan
  // sin ellas, que es justamente lo que se quiere comparar.
  { opcionales: ['_fathomContiene', '_fathomAlias', '_fathomAliasUnicos'] },
);

const quien = (m) => (m ? m.name : null);
const match = (titulo, mails) =>
  quien(_fathomMatchClient(titulo, mails ? { participantes: mails.map((email) => ({ email })) } : null));

describe('_fathomMatchClient', () => {
  beforeEach(() => {
    DB.clients = [];
    DB.personas = [{ nombre: 'Nico Equipo' }];
  });

  it('la palabra clave escrita a mano le gana al nombre de otra ficha', () => {
    DB.clients = [
      { id: 1, name: 'Ferreteria Ejemplo' },
      { id: 2, name: 'Panaderia Prueba', fathomKeywords: ['ferreteria ejemplo sucursal'] },
    ];
    expect(match('Revision Ferreteria Ejemplo sucursal norte')).toBe('Panaderia Prueba');
    expect(match('Revision Ferreteria Ejemplo')).toBe('Ferreteria Ejemplo');
  });

  // Regresion de 143f401: "contiene" hacia que un cliente corto se llevara
  // cualquier titulo que tuviera su nombre adentro de otra palabra.
  it('el nombre se compara por palabra entera', () => {
    DB.clients = [{ id: 1, name: 'Zafiro' }];
    expect(match('Kickoff Zafirotech')).toBeNull();
    expect(match('Kickoff Zafiro')).toBe('Zafiro');
  });

  // Regresion de c01c846: contacto de tres palabras. El nombre del medio
  // quedaba suelto como palabra del cliente y se llevaba cualquier reunion
  // con alguien que se llamara igual.
  it('el segundo nombre del contacto no engancha reuniones ajenas', () => {
    DB.clients = [
      { id: 1, name: 'Ferreteria Ejemplo', contacto: 'Rodrigo Tomas Inventado' },
    ];
    expect(match('R2 con Tomas Otro Apellidoficticio')).toBeNull();
    // Lo que si identifica: el apellido, y el nombre entero.
    expect(match('Seguimiento con Inventado')).toBe('Ferreteria Ejemplo');
  });

  // Regresion de 3030b2d: contacto cargado con el nombre de pila solo. Se
  // deduce el apellido de la parte de adelante del mail.
  it('deduce el apellido del mail cuando el contacto es un nombre solo', () => {
    DB.clients = [
      {
        id: 1,
        name: 'Estudio Ejemplo',
        contacto: 'Ana',
        email: 'anaprovisoria@gmail.com',
      },
    ];
    expect(match('Llamada con Ana Provisoria')).toBe('Estudio Ejemplo');
  });

  it('un nombre solo, sin un mail que empiece igual, no engancha', () => {
    DB.clients = [
      { id: 1, name: 'Estudio Ejemplo', contacto: 'Ana', email: 'contacto@gmail.com' },
    ];
    expect(match('Llamada con Ana')).toBeNull();
  });

  // Regresion de 30b2d4d: un prospecto se llama como la persona. Con el nombre
  // de pila solo se quedaba con las reuniones de cualquier tocayo; ahi manda
  // el mail con el que se creo.
  it('un prospecto de una palabra no se queda con las de su tocayo', () => {
    DB.clients = [
      { id: 1, name: 'Valentin', prospecto: true, email: 'valentin@ejemplo-uno.com' },
    ];
    expect(match('Diagnostico con Valentin', ['valentin.otro@gmail.com'])).toBeNull();
    expect(match('Diagnostico con Valentin', ['valentin@ejemplo-uno.com'])).toBe('Valentin');
  });

  // Regresion de ed364fd: en una ficha con nombre de persona, la primera
  // palabra es el nombre de pila, que es como se titulan las internas.
  // Y el nombre de alguien del equipo nunca identifica a un cliente.
  it('el nombre de pila de la ficha no se lleva las reuniones internas', () => {
    DB.clients = [{ id: 1, name: 'Lucas Ficticio' }];
    expect(match('Pia y Lucas')).toBeNull();
    expect(match('Revision con Ficticio')).toBe('Lucas Ficticio');
    DB.clients = [{ id: 1, name: 'Tienda Nico' }];
    expect(match('Nico y Pia')).toBeNull();
  });

  it('el dominio del invitado reconoce al cliente, pero exacto y no generico', () => {
    DB.clients = [
      { id: 1, name: 'Ferreteria Ejemplo' },
      { id: 2, name: 'Zafiro' },
    ];
    expect(match('Meet sin titulo', ['ana@ferreteriaejemplo.com.ar'])).toBe('Ferreteria Ejemplo');
    expect(match('Meet sin titulo', ['ana@zafirotech.com'])).toBeNull();
    expect(match('Meet sin titulo', ['zafiro@gmail.com'])).toBeNull();
  });

  // ⚠️  BUG VIVO, documentado y sin arreglar (it.fails = hoy falla a proposito).
  // `_fathomSenas` y el chequeo de dominio de `_fathomMatchClient` tratan como
  // genericos gmail/hotmail/outlook/yahoo/icloud/live/proton, pero NO me.com,
  // mac.com ni aol.com, que `_fathomAlias` si reconoce como genericos. Un
  // cliente con el mail cargado en me.com se lleva la reunion de cualquier
  // invitado con casilla de iCloud. El dia que se arregle, sacarle el `.fails`.
  it.fails('un dominio generico de iCloud (me.com) no asigna reuniones', () => {
    DB.clients = [{ id: 1, name: 'Estudio Ejemplo', email: 'ana@me.com' }];
    expect(match('Meet sin titulo', ['otra.persona@me.com'])).toBeNull();
  });
});
