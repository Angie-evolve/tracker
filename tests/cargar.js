// Trae funciones sueltas de index.html para probarlas, sin levantar la app.
//
// La app es un solo <script> de ~66k lineas que al cargarse toca el DOM,
// localStorage, Supabase y arranca timers. Ejecutarlo entero para probar una
// funcion de diez lineas es imposible fuera del navegador, y ademas no es lo
// que queremos: el test tiene que decir exactamente de que depende cada
// funcion. Por eso se parsea el script con acorn, se recorta SOLO lo que el
// test pide por nombre, y eso se evalua en un contexto `vm` vacio donde el
// test pone a mano lo demas (stubs). Nada del resto del script se ejecuta.
//
// Tampoco se modifica index.html: se lee tal cual se publica.
//
// Para correr los mismos tests contra una version vieja (y comprobar que un
// test de regresion de verdad agarra el bug), apuntar TRACKER_HTML a otro
// archivo:
//   git show <commit>^:index.html > /tmp/viejo.html
//   TRACKER_HTML=/tmp/viejo.html npx vitest run tests/adsDot.test.js

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTUAL = path.join(RAIZ, 'index.html');

export function rutaHtml() {
  return process.env.TRACKER_HTML ? path.resolve(process.env.TRACKER_HTML) : ACTUAL;
}

// Contra una version vieja pueden faltar helpers que se agregaron despues;
// ahi `opcionales` no es error. Contra el index.html de hoy todo es obligatorio:
// si alguien renombra una helper, el test tiene que gritar, no saltearla.
function contraActual() {
  return rutaHtml() === ACTUAL;
}

// Parsear 66k lineas tarda; se hace una vez por archivo y por proceso.
const cache = new Map();

function extraerScript(html, ruta) {
  // El script principal abre en una linea sola `<script>` y cierra con el
  // ultimo `</script>` del archivo. Adentro hay strings con "<script>" y
  // "<\/script>" (landings que genera la app), por eso NO se corta en el
  // primer cierre que aparezca.
  const ab = html.search(/^<script>\s*$/m);
  const ci = html.lastIndexOf('</script>');
  if (ab < 0 || ci < ab) {
    throw new Error(`cargar: no encontre el <script> principal en ${ruta}`);
  }
  const ini = html.indexOf('>', ab) + 1;
  return html.slice(ini, ci);
}

function indexar(ruta) {
  if (cache.has(ruta)) return cache.get(ruta);
  const html = fs.readFileSync(ruta, 'utf8');
  const src = extraerScript(html, ruta);
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  // nombre -> {orden, codigo}. Solo nivel superior: una funcion anidada no es
  // alcanzable desde afuera y no tiene sentido pedirla.
  const decl = new Map();
  ast.body.forEach((nodo, orden) => {
    if (nodo.type === 'FunctionDeclaration' || nodo.type === 'ClassDeclaration') {
      decl.set(nodo.id.name, { orden, codigo: src.slice(nodo.start, nodo.end) });
    } else if (nodo.type === 'VariableDeclaration') {
      // `var a=1, b=2;` se parte en dos, para poder pedir una sin la otra.
      nodo.declarations.forEach((d) => {
        if (d.id.type !== 'Identifier') return;
        const init = d.init ? '=' + src.slice(d.init.start, d.init.end) : '';
        decl.set(d.id.name, { orden, codigo: `${nodo.kind} ${d.id.name}${init};` });
      });
    }
  });
  const out = { decl };
  cache.set(ruta, out);
  return out;
}

/**
 * cargar(['adsDot','getActiveLine','hc'], { DB: {...} })
 *   -> { adsDot, getActiveLine, hc, ctx }
 *
 * `stubs` se vuelven globales dentro del contexto. Se pasan por referencia:
 * si el test muta `stubs.DB.clients`, la funcion lo ve.
 * `opciones.opcionales`: nombres que pueden faltar en una version vieja.
 */
export function cargar(nombres, stubs = {}, opciones = {}) {
  const ruta = rutaHtml();
  const { decl } = indexar(ruta);
  const opcionales = new Set(opciones.opcionales || []);
  const faltan = nombres.filter((n) => !decl.has(n));
  const faltanDeVerdad = faltan.filter((n) => contraActual() || !opcionales.has(n));
  if (faltanDeVerdad.length) {
    throw new Error(
      `cargar: no existe${faltanDeVerdad.length > 1 ? 'n' : ''} ` +
        faltanDeVerdad.map((n) => `"${n}"`).join(', ') +
        ` como declaracion de nivel superior en ${ruta}`,
    );
  }
  const presentes = nombres.filter((n) => decl.has(n));
  // En el orden del archivo: un `var` que usa otro `var` necesita que el
  // primero ya este asignado.
  const codigo = presentes
    .slice()
    .sort((a, b) => decl.get(a).orden - decl.get(b).orden)
    .map((n) => decl.get(n).codigo)
    .join('\n');

  const sandbox = { ...stubs };
  // `Date` se lee del contexto del test EN CADA USO, no al crear el sandbox:
  // asi `vi.useFakeTimers()`/`vi.setSystemTime()` congelan tambien el reloj de
  // las funciones de la app, que si no tendrian su propio Date de verdad.
  if (!('Date' in stubs)) {
    Object.defineProperty(sandbox, 'Date', { get: () => globalThis.Date, enumerable: true });
  }
  const ctx = vm.createContext(sandbox);
  const devolver = `({${presentes.map((n) => `${JSON.stringify(n)}: ${n}`).join(',')}})`;
  const obj = vm.runInContext(`${codigo}\n;${devolver}`, ctx, { filename: ruta });
  return { ...obj, ctx };
}
