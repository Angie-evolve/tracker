// La pestana Rentabilidad: que separe abono de implementacion, que el LTV de
// un mixto cuente la implementacion, que cada aviso diga el motivo correcto y
// que un mes sin gastos no se lea como 100% de margen.
// Todos los clientes son inventados: el repo es publico.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cargar } from './cargar.js';

const DB = { clients: [], eerr: {} };
const S = {};
const F = cargar(
  [
    '_feeMensual', '_rtMesesImpl', 'rtPartesEn', 'rtMensualEn', 'rtMensual', '_rtHitoPendiente',
    '_contratoDias', '_fecha', '_isoLocal', 'clienteAltaInfo', 'clienteAlta', 'clienteAltaFiable',
    '_pagos', '_pagoFecha', '_primerCobro', '_eerrAltaEfectiva', '_eerrAltaFiable', '_eerrEsCartera',
    'esAgencia', 'esProspecto', '_bajaMes', '_bajaPorArchivo', '_bajaEfectiva', '_eerrCuenta',
    '_eerrDesde', '_eerrFinVencidoAntesDeEmpezar', '_eerrHasta', '_eerrHastaContrato', '_eerrVencida',
    '_eerrCubre', 'eerrAbonosDetalle', 'eerrAbonosMes', 'eerrPartesMes', 'eerrAnio',
    '_ltvMesCerrado', '_ltvMeses', '_ltvPactados', '_ltvCobrado', '_ltvTicketInfo', '_ltvTicket',
    '_eerrRelacionMensual', '_eerrPreguntaBaja', 'eerrVencen', 'eerrVencidosBaja', 'eerrSinAporte',
    'EERR_CATS', '_eerrDatos', '_eerrMesKey', 'eerrVal', 'eerrEsPasado', 'eerrCobradoMes',
    '_eerrIngresoSugerido', 'eerrIngreso', 'eerrGastos', 'eerrHayGastos', 'eerrResultado',
    'eerrIngresoNeto', '_eerrTitMargen',
  ],
  { DB, S, _iAltaCliente: () => -1, _llegoAAlta: () => true },
);

const cobro = (fecha, monto) => ({ fecha, monto, pagadoAt: fecha + 'T12:00:00' });

function mixto(extra = {}) {
  return {
    id: 1, name: 'Estudio Mixto', serviceType: 'mixto', recurrente: true,
    monthlyFee: '100', contractValue: '2000', contract: { durationDays: 30 },
    altaAt: '2026-09-04', pagos: [cobro('2026-09-04', 2000)], ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T12:00:00-03:00'));
  DB.clients = [];
  DB.eerr = {};
  delete S._eerrAnio;
});
afterEach(() => vi.useRealTimers());

// Arreglo 2: la implementacion prorrateada no es abono.
describe('abono e implementacion por separado', () => {
  it('un mixto en su mes de implementacion aporta pago unico, no abono', () => {
    const c = mixto();
    expect(F.rtPartesEn(c, 2026, 8)).toEqual({ abono: 0, unico: 2000 });
    expect(F.rtPartesEn(c, 2026, 9)).toEqual({ abono: 100, unico: 0 });
  });

  it('el total del EERR no cambia: abono + pago unico = rtMensualEn', () => {
    const recurrente = {
      id: 2, name: 'Abono Puro', serviceType: 'recurrente', recurrente: true, monthlyFee: '300',
      altaAt: '2026-08-01', pagos: [cobro('2026-08-01', 300)],
    };
    const garantia = {
      id: 3, name: 'Garantia Tres Meses', serviceType: 'one-time', contractValue: '900',
      contract: { durationDays: 90 }, altaAt: '2026-09-01', pagos: [cobro('2026-09-01', 300)],
    };
    DB.clients = [mixto(), recurrente, garantia];
    const partes = F.eerrPartesMes(2026, 8);
    expect(partes).toEqual({ abono: 300, unico: 2300 });
    expect(partes.abono + partes.unico).toBe(F.eerrAbonosMes(2026, 8));
    DB.clients.forEach((c) => {
      const p = F.rtPartesEn(c, 2026, 8);
      expect(p.abono + p.unico).toBe(F.rtMensualEn(c, 2026, 8));
    });
  });
});

// Arreglo 3: el LTV de un mixto incluye la implementacion.
describe('_ltvTicket de un mixto', () => {
  it('implementacion mas el fee de los meses posteriores', () => {
    // Alta en junio, 30 dias de implementacion: jul y ago ya son de abono.
    const c = mixto({ altaAt: '2026-06-10', pagos: [cobro('2026-06-10', 2000)] });
    expect(F._ltvTicket(c)).toBe(2000 + 100 * 2);
  });

  it('con valor de contrato y sin fee no sale en cero', () => {
    const c = mixto({ monthlyFee: '', altaAt: '2026-08-10', pagos: [cobro('2026-08-10', 1500)], contractValue: '1500' });
    expect(F._ltvTicket(c)).toBe(1500);
  });

  it('con hito pendiente vale lo cobrado, no el ticket entero', () => {
    const c = {
      id: 4, name: 'Por Hito', contractValue: '1000', contract: { plazoTipo: 'hito' },
      altaAt: '2026-08-01', pagos: [cobro('2026-08-01', 400), { monto: 600 }],
    };
    expect(F._ltvTicketInfo(c)).toMatchObject({ ticket: 400, parcial: true });
  });
});

// Arreglo 5 (y 1 y 4): cada aviso con su motivo.
describe('eerrSinAporte: motivos', () => {
  const motivos = () => F.eerrSinAporte().map((x) => [x.c.name, x.motivo]);

  it('separa mixto sin fee, fee por % incompleto, cobro sin valor y hito sin fecha', () => {
    DB.clients = [
      mixto({ id: 10, name: 'Mixto Sin Fee', monthlyFee: '', altaAt: '2026-07-01', pagos: [cobro('2026-07-01', 2000)] }),
      mixto({ id: 11, name: 'Fee Porcentual', monthlyFee: '', feeTipo: 'pct', altaAt: '2026-07-01', pagos: [cobro('2026-07-01', 2000)] }),
      { id: 12, name: 'Cobro Sin Valor', serviceType: 'mixto', recurrente: true, altaAt: '2026-09-01', pagos: [cobro('2026-09-01', 500)] },
      mixto({ id: 13, name: 'Hito Sin Fecha', contract: { plazoTipo: 'hito' } }),
    ];
    expect(motivos()).toEqual([
      ['Mixto Sin Fee', 'mixto-sin-fee'],
      ['Fee Porcentual', 'fee-pct'],
      ['Cobro Sin Valor', 'cobro-sin-valor'],
      ['Hito Sin Fecha', 'sin-hito'],
    ]);
    // Ninguno cae en el generico de antes.
    expect(motivos().some(([, m]) => m === 'sin-plazo')).toBe(false);
  });

  it('nombra al que tiene abono sin ninguna cuota cobrada, y no a archivados ni prospectos', () => {
    DB.clients = [
      { id: 20, name: 'Recurrente Sin Tildar', serviceType: 'recurrente', recurrente: true, monthlyFee: '1500', altaAt: '2026-01-01', pagos: [] },
      { id: 21, name: 'Archivado Sin Tildar', serviceType: 'recurrente', monthlyFee: '1500', archived: true, pagos: [] },
      { id: 22, name: 'Prospecto Sin Tildar', contractValue: '800', prospecto: true, pagos: [] },
      { id: 23, name: 'Agencia Propia', monthlyFee: '1', recurrente: true, esAgencia: true, pagos: [] },
    ];
    expect(motivos()).toEqual([['Recurrente Sin Tildar', 'sin-cobro']]);
    // El criterio de cartera no cambia: sigue afuera de la cuenta.
    expect(F._eerrEsCartera(DB.clients[0])).toBe(false);
  });

  it('un one-time terminado no es un vencido a dar de baja', () => {
    const unaVez = {
      id: 30, name: 'Una Vez', serviceType: 'one-time', contractValue: '900',
      contract: { durationDays: 60 }, altaAt: '2026-05-01', pagos: [cobro('2026-05-01', 900)],
    };
    const mensual = {
      id: 31, name: 'Mensual Vencido', serviceType: 'recurrente', recurrente: true, monthlyFee: '200',
      contract: { durationDays: 60 }, altaAt: '2026-05-01', pagos: [cobro('2026-05-01', 200)],
    };
    DB.clients = [unaVez, mensual];
    expect(F.eerrVencidosBaja().map((x) => x.c.name)).toEqual(['Mensual Vencido']);
    expect(motivos()).toEqual([['Mensual Vencido', 'vencido']]);
  });

  it('el fin de la implementacion de un mixto no es un vencimiento', () => {
    const c = mixto({ contract: { durationDays: 30, endDate: '2026-12-31' }, altaAt: '2026-06-01', pagos: [cobro('2026-06-01', 2000)] });
    // Con endDate el mixto tiene fin, pero sale de la duracion: es la implementacion.
    expect(F._eerrHasta(c)).toMatchObject({ porPlazo: true });
    expect(F._eerrPreguntaBaja(c)).toBe(false);
  });
});

// Arreglo 6: sin gastos no hay margen, y sin ingreso no hay "$0".
describe('eerrResultado sin gastos cargados', () => {
  it('margen null si no hay ningun gasto cargado', () => {
    DB.eerr = { '2026-10': { ingresos: 5000 } };
    const r = F.eerrResultado(9);
    expect(r.margen).toBeNull();
    expect(r.margenBruto).toBeNull();
    expect(F._eerrTitMargen(9, r.margen)).toBe('sin gastos cargados');
  });

  it('con un gasto cargado, aunque sea cero, el margen se calcula', () => {
    DB.eerr = { '2026-10': { ingresos: 5000, alquiler: 1000 } };
    expect(F.eerrResultado(9).margen).toBe(80);
    DB.eerr = { '2026-10': { ingresos: 5000, alquiler: 0 } };
    expect(F.eerrResultado(9).margen).toBe(100);
  });

  it('ingreso neto de un mes pasado sin dato es null, no cero', () => {
    expect(F.eerrIngreso(2)).toBeNull();
    expect(F.eerrIngresoNeto(2)).toBeNull();
    DB.eerr = { '2026-03': { otrosIngresos: 250 } };
    expect(F.eerrIngresoNeto(2)).toBe(250);
  });
});
