// Edge function "ghl" - lee la subcuenta de un cliente en GoHighLevel.
//
// El navegador no puede pegarle a services.leadconnectorhq.com: no manda
// cabeceras CORS, asi que cualquier fetch desde la pagina muere en el preflight.
// Por eso el pedido pasa por aca.
//
// El token del cliente viaja en el cuerpo, no vive en la funcion: cada cliente
// tiene el suyo y ya esta guardado en el tracker. Lo unico que guarda la
// funcion es el secreto que la protege.
//
// Variables de entorno: GHL_SECRETO
//
// Acciones:
//   ?s=SECRETO&accion=calendarios   POST {token, location}
//                                        -> {ok, calendarios:[{id,nombre,slug,activo}]}
//   ?s=SECRETO&accion=eventos       POST {token, location, calendarios[], desde, hasta}
//                                        -> {ok, eventos:[{id,titulo,inicio,estado,con,mail,...}]}
//   ?s=SECRETO&accion=campos        POST {token, location, campos:[{l,tipo,req}]}
//                                        -> {ok, creados:[], existentes:[], errores:[]}
//   ?s=SECRETO&accion=formularios   POST {token, location} -> {ok, formularios:[{id,nombre}]}
//   ?s=SECRETO&accion=asignar       POST {token, location, calendario, formulario}
//                                        -> {ok} ; formulario vacio lo desasigna
//   ?s=SECRETO&accion=config        POST {token, location, guardar?:{...}}
//                                        -> {ok, config:{...}}  lee o escribe la
//                                           configuracion en un contacto de sistema
//   ?accion=respuestas              POST {landing, email, nombre, telefono, ...}
//                                        SIN secreto: la llama la landing publica.
//                                        Escribe en GHL y no guarda nada.
//   ?accion=slots                   POST {landing, desde, hasta, tz}
//                                        SIN secreto -> {ok, dias:{"2026-09-08":["..."]}}
//   ?accion=reservar                POST {landing, email, nombre, telefono, inicio, tz, ...}
//                                        SIN secreto: crea el contacto y la cita.
//                                        El calendario lo pone el servidor, no la pagina.
//   ?s=SECRETO&accion=ping                                 -> {ok:true}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// GHL versiona por cabecera con una fecha, pero los endpoints nuevos de
// calendarios piden "v3". Cual acepta cada subcuenta depende de en que version
// del producto esta, asi que se prueban las dos en vez de elegir una y fallar.
const VERSIONES = ['2021-04-15', 'v3'];

async function traerCalendarios(token: string, location: string) {
  const url = 'https://services.leadconnectorhq.com/calendars/?locationId=' +
    encodeURIComponent(location);
  let ultimo = { status: 0, texto: '' };
  for (const version of VERSIONES) {
    const r = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        Version: version,
        Accept: 'application/json',
      },
    });
    const texto = await r.text();
    if (r.ok) {
      let d: any = {};
      try { d = JSON.parse(texto); } catch (_e) { /* respuesta rara: cae abajo */ }
      const lista = d.calendars || d.calendar || [];
      return {
        ok: true,
        version,
        calendarios: (Array.isArray(lista) ? lista : []).map((c: any) => ({
          id: String(c.id || c._id || ''),
          nombre: String(c.name || c.calendarName || c.id || ''),
          // La URL de reserva se arma con el slug, no con el id: el id da 404
          // en /widget/booking/. widgetSlug es el que usa Compartir; slug es el
          // de respaldo cuando el calendario no tiene widget propio.
          slug: String(c.widgetSlug || c.slug || ''),
          // Sirve para no ofrecer uno apagado, que acepta el embed y no muestra
          // ningun turno libre.
          activo: c.isActive !== false,
        })).filter((c: any) => c.id),
      };
    }
    ultimo = { status: r.status, texto };
    // 401/403 es el token o el scope: probar otra version no cambia nada.
    if (r.status === 401 || r.status === 403) break;
  }
  let msg = ultimo.texto;
  try { msg = JSON.parse(ultimo.texto).message || msg; } catch (_e) { /* texto plano */ }
  // 401 y 403 no son lo mismo y confundirlos manda a buscar donde no es: 401
  // es el token (invalido, vencido, o de la API vieja v1, que no sirve para
  // services.leadconnectorhq.com); 403 si es permiso que falta.
  if (ultimo.status === 401) {
    msg = 'GHL rechazo el token (401). Tiene que ser el de una Private ' +
      'Integration de esa subcuenta, no una API key vieja. Dijo: ' + msg;
  } else if (ultimo.status === 403) {
    msg = 'Al token le falta el scope calendars.readonly (403). Dijo: ' + msg;
  }
  return { ok: false, status: ultimo.status, error: String(msg).slice(0, 500) };
}

// Las citas de un rango, de todos los calendarios que se le pasen. GHL pide un
// calendario por llamada, asi que se recorren y se juntan aca: al tracker le
// llega una sola lista y no tiene que saber como esta partida la subcuenta.
async function traerEventos(
  token: string,
  location: string,
  calendarios: string[],
  desde: number,
  hasta: number,
) {
  const cab = (version: string) => ({
    Authorization: 'Bearer ' + token,
    Version: version,
    Accept: 'application/json',
  });

  // El nombre del contacto no viene en el evento, solo su id. Se resuelve una
  // vez por contacto: varias etapas del mismo cliente comparten persona.
  // Nombre y mail del contacto. El mail es lo que permite atar la cita a un
  // cliente sin depender de como este escrito el titulo: el nombre falla cuando
  // la empresa se llama de una forma y la persona de otra.
  const gente = new Map<string, { nombre: string; mail: string }>();
  async function contactoDe(id: string) {
    if (!id) return { nombre: '', mail: '' };
    if (gente.has(id)) return gente.get(id)!;
    let out = { nombre: '', mail: '' };
    try {
      const r = await fetch('https://services.leadconnectorhq.com/contacts/' + id, {
        headers: cab('2021-07-28'),
      });
      if (r.ok) {
        const d = await r.json();
        const c = d.contact || d;
        out = {
          nombre: String(c.name || ((c.firstName || '') + ' ' + (c.lastName || '')).trim() ||
            c.email || ''),
          mail: String(c.email || '').trim().toLowerCase(),
        };
      }
    } catch (_e) { /* sin contacto se sigue igual: el titulo puede alcanzar */ }
    gente.set(id, out);
    return out;
  }

  // Quien la toma de nuestro lado. Pide otro scope, asi que si falla se sigue
  // sin nombres de equipo en vez de romper toda la consulta.
  const equipo = new Map<string, string>();
  try {
    const r = await fetch(
      'https://services.leadconnectorhq.com/users/?locationId=' + encodeURIComponent(location),
      { headers: cab('2021-07-28') },
    );
    if (r.ok) {
      const d = await r.json();
      (d.users || []).forEach((u: any) => {
        equipo.set(String(u.id), String(u.name || u.firstName || u.email || ''));
      });
    }
  } catch (_e) { /* opcional */ }

  const out: any[] = [];
  const fallos: string[] = [];
  const vistos = new Set<string>();
  // Se pregunta por calendario Y por usuario. Las reuniones agendadas a mano en
  // el Google Calendar de alguien del equipo llegan a GHL sin calendario
  // asignado ("Source: Google calendar", "Calendar: -"), asi que preguntando
  // solo por calendario no aparecen nunca. Por usuario si.
  const consultas: Array<{ tipo: string; id: string }> = [];
  for (const id of calendarios) consultas.push({ tipo: 'calendarId', id: id });
  for (const id of equipo.keys()) consultas.push({ tipo: 'userId', id: id });

  for (const q of consultas) {
    const calId = q.id;
    const qs = new URLSearchParams({
      locationId: location,
      startTime: String(desde),
      endTime: String(hasta),
    });
    qs.set(q.tipo, q.id);
    let hecho = false;
    for (const version of VERSIONES) {
      const r = await fetch(
        'https://services.leadconnectorhq.com/calendars/events?' + qs.toString(),
        { headers: cab(version) },
      );
      const texto = await r.text();
      if (r.ok) {
        let d: any = {};
        try { d = JSON.parse(texto); } catch (_e) { /* respuesta rara */ }
        for (const e of (d.events || [])) {
          // La misma cita vuelve por calendario y por usuario: se queda una.
          const clave = String(e.id || '');
          if (clave && vistos.has(clave)) continue;
          if (clave) vistos.add(clave);
          const ini = e.startTime;
          const quien = await contactoDe(String(e.contactId || ''));
          out.push({
            id: String(e.id || ''),
            calendario: String(e.calendarId || calId),
            titulo: String(e.title || ''),
            inicio: typeof ini === 'string' ? ini : (ini?.dateTime || ini?.date || ''),
            fin: typeof e.endTime === 'string' ? e.endTime : (e.endTime?.dateTime || ''),
            // confirmed | cancelled | showed | noshow | invalid
            estado: String(e.appointmentStatus || ''),
            contactoId: String(e.contactId || ''),
            con: quien.nombre,
            mail: quien.mail,
            deNuestroLado: equipo.get(String(e.assignedUserId || '')) || '',
            // Con esto el tracker detecta que se movio de horario sin guardar
            // un historial: si cambio dateUpdated y cambio inicio, se reprogramo.
            actualizado: typeof e.dateUpdated === 'string'
              ? e.dateUpdated
              : (e.dateUpdated?.dateTime || ''),
          });
        }
        hecho = true;
        break;
      }
      if (r.status === 401 || r.status === 403) {
        fallos.push(calId + ': ' + r.status);
        hecho = true;
        break;
      }
    }
    if (!hecho) fallos.push(calId + ': sin respuesta');
  }
  // El orden por fecha lo espera el tracker: la primera es la proxima.
  out.sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
  return { ok: true, eventos: out, fallos };
}

// Crea en la subcuenta los campos que se definieron en el tracker, para no
// tipearlos de nuevo en el armador de formularios de GHL. No crea el
// formulario: eso la API no lo permite, solo campos.
const TIPOS: Record<string, string> = {
  texto: 'TEXT',
  'texto largo': 'LARGE_TEXT',
  largo: 'LARGE_TEXT',
  email: 'TEXT',
  mail: 'TEXT',
  tel: 'PHONE',
  telefono: 'PHONE',
  whatsapp: 'PHONE',
  numero: 'NUMERICAL',
  fecha: 'DATE',
  opcion: 'SINGLE_OPTIONS',
  si_no: 'CHECKBOX',
};

function claveDe(nombre: string) {
  return nombre.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'campo';
}

async function crearCampos(
  token: string,
  location: string,
  campos: Array<{ l: string; tipo?: string; req?: boolean; ops?: string[]; k?: string }>,
) {
  // POST /custom-fields/ es para objetos personalizados: con objectKey "contact"
  // contesta "Api does not support objectKey of type contact or opportunity".
  // Los campos de contacto se crean en el endpoint de la location.
  const base = 'https://services.leadconnectorhq.com/locations/' +
    encodeURIComponent(location) + '/customFields';
  const cab = (version: string) => ({
    Authorization: 'Bearer ' + token,
    Version: version,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  // Igual que en calendarios: cual acepta cada subcuenta depende de en que
  // version del producto esta, asi que se prueban en vez de elegir una.
  const VERS = ['2021-07-28', 'v3', '2021-04-15'];

  // Lo que ya existe no se duplica: correr esto dos veces no tiene que dejar
  // el mismo campo repetido en la subcuenta.
  const yaHay = new Set<string>();
  let versionBuena = '';
  for (const v of VERS) {
    try {
      const r = await fetch(base + '?model=contact', { headers: cab(v) });
      if (!r.ok) continue;
      const d = await r.json().catch(() => ({}));
      (d.customFields || d.customField || d.fields || []).forEach((f: any) => {
        yaHay.add(String(f.name || '').trim().toLowerCase());
      });
      versionBuena = v;
      break;
    } catch (_e) { /* se prueba la siguiente */ }
  }

  const creados: string[] = [], existentes: string[] = [], errores: string[] = [];
  for (const campo of campos) {
    const nombre = String(campo.l || '').trim();
    if (!nombre) continue;
    if (yaHay.has(nombre.toLowerCase())) { existentes.push(nombre); continue; }
    const tipo = TIPOS[String(campo.tipo || '').trim().toLowerCase()] || 'TEXT';

    const ops = Array.isArray(campo.ops) ? campo.ops.filter(Boolean).map(String) : [];
    const conOpciones = /OPTION|RADIO|CHECKBOX/i.test(tipo) && ops.length > 0;
    // La doc muestra picklistOptions en la respuesta pero no dice como se
    // manda. Se prueban los dos nombres antes de darlo por perdido.
    const claves = conOpciones ? ['picklistOptions', 'options'] : [''];
    const versiones = versionBuena ? [versionBuena, ...VERS.filter((v) => v !== versionBuena)] : VERS;

    let ultimo = 'sin respuesta';
    let hecho = false;
    for (const v of versiones) {
      for (const clave of claves) {
        const cuerpo: any = { name: nombre, dataType: tipo, model: 'contact' };
        if (clave) cuerpo[clave] = ops;
        try {
          const r = await fetch(base, { method: 'POST', headers: cab(v), body: JSON.stringify(cuerpo) });
          const texto = await r.text();
          if (r.ok) { creados.push(nombre); hecho = true; break; }
          let msg = texto;
          try { msg = JSON.parse(texto).message || msg; } catch (_e) { /* texto plano */ }
          ultimo = String(Array.isArray(msg) ? msg.join(' | ') : msg).slice(0, 160);
          // El token o el scope no se arreglan probando otra combinacion.
          if (r.status === 401 || r.status === 403) { hecho = false; break; }
        } catch (e) {
          ultimo = String(e).slice(0, 120);
        }
      }
      if (hecho) break;
    }
    if (!hecho) errores.push(nombre + ': ' + ultimo);
  }
  return { ok: true, creados, existentes, errores, carpeta: '' };
}

// Los formularios que ya existen en la subcuenta. Crearlos no se puede por API
// —Forms es de solo lectura— pero elegir cual va en un calendario si.
async function traerFormularios(token: string, location: string) {
  const r = await fetch(
    'https://services.leadconnectorhq.com/forms/?locationId=' + encodeURIComponent(location) +
      '&limit=100',
    { headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28', Accept: 'application/json' } },
  );
  const texto = await r.text();
  if (!r.ok) {
    let msg = texto;
    try { msg = JSON.parse(texto).message || msg; } catch (_e) { /* texto plano */ }
    return { ok: false, status: r.status, error: String(msg).slice(0, 300) };
  }
  let d: any = {};
  try { d = JSON.parse(texto); } catch (_e) { /* respuesta rara */ }
  return {
    ok: true,
    formularios: (d.forms || []).map((f: any) => ({
      id: String(f.id || ''),
      nombre: String(f.name || f.id || ''),
    })).filter((f: any) => f.id),
  };
}

// Pega un formulario a un calendario. Es lo unico de esta cadena que la API
// deja escribir, y es el paso que ahorra entrar a GHL por cada cliente.
async function asignarFormulario(
  token: string,
  location: string,
  calendario: string,
  formulario: string,
) {
  const r = await fetch(
    'https://services.leadconnectorhq.com/calendars/' + encodeURIComponent(calendario),
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        Version: '2021-04-15',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      // Solo el campo que se cambia: el DTO no exige nada mas, y mandar el
      // calendario entero pisaria ajustes que no tocamos.
      body: JSON.stringify({ formId: formulario || null }),
    },
  );
  const texto = await r.text();
  if (!r.ok) {
    let msg = texto;
    try { msg = JSON.parse(texto).message || msg; } catch (_e) { /* texto plano */ }
    return { ok: false, status: r.status, error: String(msg).slice(0, 300) };
  }
  return { ok: true };
}

// La configuracion de la landing guardada dentro de la subcuenta del cliente,
// en un contacto reservado. Asi viaja con el cliente en vez de vivir en una
// base nuestra: si se entrega la subcuenta o cambia la herramienta, la config
// va con ella. Lo lee y lo escribe el tracker, que si esta autenticado; la
// landing publica nunca lo toca.
const CONF_MAIL = 'sistema@evolve.tracker';
const CONF_TAG = 'evolve-config';

async function contactoConfig(token: string, location: string, guardar: any) {
  const cab = {
    Authorization: 'Bearer ' + token,
    Version: '2021-07-28',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const base = 'https://services.leadconnectorhq.com';

  // upsert hace las dos cosas: si no existe lo crea, si existe lo actualiza.
  // Sin esto habria que buscar primero y manejar el caso "todavia no esta".
  const cuerpo: any = {
    locationId: location,
    email: CONF_MAIL,
    firstName: 'EVOLVE',
    lastName: 'config',
    tags: [CONF_TAG],
  };
  if (guardar && typeof guardar === 'object') {
    // Se guarda como un solo JSON en un campo: la config cambia de forma
    // seguido y no vale la pena crear un campo custom por clave.
    cuerpo.customFields = [{ key: 'contact.evolve_config', field_value: JSON.stringify(guardar) }];
  }

  const r = await fetch(base + '/contacts/upsert', {
    method: 'POST',
    headers: cab,
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  if (!r.ok) {
    let msg = texto;
    try { msg = JSON.parse(texto).message || msg; } catch (_e) { /* texto plano */ }
    return { ok: false, status: r.status, error: String(msg).slice(0, 300) };
  }

  let d: any = {};
  try { d = JSON.parse(texto); } catch (_e) { /* respuesta rara */ }
  const c = d.contact || d;
  let config: any = {};
  const campos = c.customFields || c.custom_fields || [];
  for (const f of campos) {
    const v = f.value ?? f.field_value ?? '';
    if (typeof v === 'string' && v.trim().charAt(0) === '{') {
      try { config = JSON.parse(v); break; } catch (_e) { /* no era el nuestro */ }
    }
  }
  return { ok: true, contactoId: String(c.id || ''), config };
}

// ---- Lo que puede llamar una landing publica ----------------------------
// Estas acciones no piden el secreto: las llama el navegador de un visitante,
// que no puede tener credenciales. Lo que las protege es que la pagina solo
// dice DE QUE LANDING viene: el token, la subcuenta y el calendario los pone
// el servidor. Una landing no puede leer ni escribir nada de otra, ni tocar
// otro calendario de la misma subcuenta.

async function landingDe(id: string) {
  const landing = String(id || '').trim();
  if (!landing) return { ok: false as const, error: 'falta la landing' };
  const url = Deno.env.get('SUPABASE_URL') || '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !key) return { ok: false as const, error: 'falta la configuracion de Supabase' };
  const r = await fetch(
    url + '/rest/v1/landings?id=eq.' + encodeURIComponent(landing) +
      '&activa=is.true&select=ghl_token,ghl_location,calendario_id,calendario_tz',
    { headers: { apikey: key, Authorization: 'Bearer ' + key } },
  );
  const filas = r.ok ? await r.json().catch(() => []) : [];
  if (!filas.length) return { ok: false as const, error: 'landing desconocida' };
  return {
    ok: true as const,
    token: String(filas[0].ghl_token || ''),
    location: String(filas[0].ghl_location || ''),
    calendario: String(filas[0].calendario_id || ''),
    tz: String(filas[0].calendario_tz || ''),
  };
}

// Todo lo que no sea dato de contacto ni ruido de transporte entra como campo
// del contacto: sumar una pregunta no obliga a tocar esto.
const RESERVADAS = ['landing', 'email', 'nombre', 'telefono', 'inicio', 'tz', 'calendario'];
function camposDe(cuerpo: any) {
  const campos: any[] = [];
  for (const k of Object.keys(cuerpo)) {
    if (RESERVADAS.indexOf(k) >= 0) continue;
    const v = cuerpo[k];
    if (v === '' || v === null || v === undefined) continue;
    campos.push({ key: 'contact.' + k, field_value: String(v).slice(0, 500) });
  }
  return campos;
}

// Devuelve el id del contacto: la cita se crea contra un contacto, no contra
// un mail suelto.
async function upsertContacto(token: string, location: string, cuerpo: any) {
  const email = String(cuerpo.email || '').trim().toLowerCase();
  const partes = String(cuerpo.nombre || '').trim().split(/\s+/);
  const r = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Version: '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      locationId: location,
      email,
      firstName: partes[0] || undefined,
      lastName: partes.slice(1).join(' ') || undefined,
      phone: String(cuerpo.telefono || '') || undefined,
      customFields: camposDe(cuerpo),
    }),
  });
  const texto = await r.text();
  if (!r.ok) {
    let msg = texto;
    try { msg = JSON.parse(texto).message || msg; } catch (_e) { /* texto plano */ }
    return { ok: false as const, status: r.status, error: String(msg).slice(0, 200) };
  }
  let d: any = {};
  try { d = JSON.parse(texto); } catch (_e) { /* respuesta rara */ }
  const id = String((d.contact && d.contact.id) || d.id || '');
  if (!id) return { ok: false as const, status: 502, error: 'GHL no devolvio el id del contacto' };
  return { ok: true as const, id, campos: camposDe(cuerpo).length };
}

// Los horarios libres del calendario de esta landing. Es informacion que el
// widget de GHL ya le muestra a cualquiera: lo que se cuida es que la pagina
// no pueda pedir los de otro calendario.
async function pedirSlots(cuerpo: any) {
  const L = await landingDe(cuerpo.landing);
  if (!L.ok) return L;
  if (!L.calendario) return { ok: false, error: 'la landing no tiene calendario cargado' };

  const desde = Number(cuerpo.desde || 0);
  const hasta = Number(cuerpo.hasta || 0);
  if (!desde || !hasta || hasta <= desde) return { ok: false, error: 'rango invalido' };
  // GHL rechaza rangos de mas de 31 dias. Se corta aca para que el error sea
  // nuestro y no una respuesta rara de ellos.
  const DIA = 86400000;
  if (hasta - desde > 31 * DIA) return { ok: false, error: 'el rango no puede pasar de 31 dias' };

  const tz = String(cuerpo.tz || L.tz || '');
  const q = 'startDate=' + desde + '&endDate=' + hasta +
    (tz ? '&timezone=' + encodeURIComponent(tz) : '');
  const url = 'https://services.leadconnectorhq.com/calendars/' +
    encodeURIComponent(L.calendario) + '/free-slots?' + q;

  let ultimo = { status: 0, texto: '' };
  for (const version of VERSIONES) {
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + L.token, Version: version, Accept: 'application/json' },
    });
    const texto = await r.text();
    if (r.ok) {
      let d: any = {};
      try { d = JSON.parse(texto); } catch (_e) { /* cae abajo */ }
      // La respuesta es un mapa por fecha: {"2026-09-08":{slots:[...]}}. Se
      // aplana a {fecha:[horarios]} para que la pagina no tenga que saberlo.
      const dias: Record<string, string[]> = {};
      for (const k of Object.keys(d || {})) {
        const v: any = (d as any)[k];
        const lista = Array.isArray(v) ? v : (v && Array.isArray(v.slots) ? v.slots : null);
        if (lista && /^\d{4}-\d{2}-\d{2}$/.test(k)) dias[k] = lista.map((x: any) => String(x));
      }
      return { ok: true, version, tz, dias };
    }
    ultimo = { status: r.status, texto };
    // 401 es el token, 403 el scope: reintentar con otra version no arregla
    // ninguno de los dos y solo tapa el motivo real.
    if (r.status === 401 || r.status === 403) break;
  }
  let msg = ultimo.texto;
  try { msg = JSON.parse(ultimo.texto).message || msg; } catch (_e) { /* texto plano */ }
  return {
    ok: false,
    status: ultimo.status,
    error: (ultimo.status === 401
      ? 'GHL rechazo el token de esta landing: '
      : ultimo.status === 403
      ? 'al token le falta el scope calendars.readonly: '
      : 'GHL: ') + String(msg).slice(0, 200),
  };
}

// Crea el contacto y la cita. El calendario y la subcuenta salen de la fila de
// la landing: la pagina solo elige el horario.
async function reservar(cuerpo: any) {
  const L = await landingDe(cuerpo.landing);
  if (!L.ok) return L;
  if (!L.calendario) return { ok: false, error: 'la landing no tiene calendario cargado' };

  const email = String(cuerpo.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'falta el email' };
  const inicio = String(cuerpo.inicio || '').trim();
  if (!inicio) return { ok: false, error: 'falta el horario' };

  const c = await upsertContacto(L.token, L.location, cuerpo);
  if (!c.ok) return c;

  const cuerpoCita: any = {
    calendarId: L.calendario,
    locationId: L.location,
    contactId: c.id,
    startTime: inicio,
    // La pagina promete "te llega la confirmacion por mail", asi que se pide
    // explicito en vez de confiar en cual es el default de la subcuenta.
    toNotify: true,
  };
  const tz = String(cuerpo.tz || L.tz || '');
  if (tz) cuerpoCita.ignoreDateRange = false;

  let ultimo = { status: 0, texto: '' };
  for (const version of VERSIONES) {
    const r = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + L.token,
        Version: version,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cuerpoCita),
    });
    const texto = await r.text();
    if (r.ok) {
      let d: any = {};
      try { d = JSON.parse(texto); } catch (_e) { /* cae abajo */ }
      return {
        ok: true,
        version,
        cita: String(d.id || (d.event && d.event.id) || ''),
        contacto: c.id,
        campos: c.campos,
        inicio,
      };
    }
    ultimo = { status: r.status, texto };
    if (r.status === 401 || r.status === 403) break;
    // 400 con el horario ya tomado tampoco se arregla cambiando de version.
    if (r.status === 400 || r.status === 422) break;
  }
  let msg = ultimo.texto;
  try { msg = JSON.parse(ultimo.texto).message || msg; } catch (_e) { /* texto plano */ }
  const texto = String(msg).slice(0, 200);
  // El contacto ya quedo creado aunque la cita falle: el lead no se pierde.
  return {
    ok: false,
    status: ultimo.status,
    contacto: c.id,
    // Que el horario se haya ocupado entre que se pinto y se apreto es lo
    // unico que la pagina puede resolver sola, asi que se marca aparte.
    ocupado: /slot|not available|unavailable|already/i.test(texto),
    error: (ultimo.status === 401
      ? 'GHL rechazo el token de esta landing: '
      : ultimo.status === 403
      ? 'al token le falta el scope calendars/events.write: '
      : 'GHL: ') + texto,
  };
}

// Las respuestas que manda una landing publicada. Es la unica accion que no
// pide el secreto: la llama el navegador de un visitante, que no puede tener
// credenciales. Lo que la protege es que solo sabe hacer una cosa —escribirle
// campos a un contacto— y que el token lo pone el servidor, no la pagina.
//
// No guarda nada: recibe, se lo pasa a GHL y contesta. Los datos del lead viven
// en la subcuenta del cliente y en ningun otro lado.
async function guardarRespuestas(cuerpo: any) {
  const email = String(cuerpo.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'falta el email' };
  const L = await landingDe(cuerpo.landing);
  if (!L.ok) return L;
  const c = await upsertContacto(L.token, L.location, cuerpo);
  if (!c.ok) return c;
  return { ok: true, campos: c.campos };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const u = new URL(req.url);

  // La landing publica no puede llevar el secreto. Estas son las unicas
  // acciones que se atienden antes de pedirlo, y todas identifican al cliente
  // por el id de la landing: el token nunca sale del servidor.
  const PUBLICAS: Record<string, (c: any) => Promise<any>> = {
    respuestas: guardarRespuestas,
    slots: pedirSlots,
    reservar: reservar,
  };
  const publica = PUBLICAS[u.searchParams.get('accion') || ''];
  if (publica) {
    let c: any = {};
    try { c = await req.json(); } catch (_e) { /* sin cuerpo */ }
    try {
      const r = await publica(c);
      return json(r, r.ok ? 200 : 400);
    } catch (e) {
      return json({ ok: false, error: 'no se pudo procesar: ' + String(e) }, 502);
    }
  }

  // Mismo nombre que FATHOM_SECRETO, que es la convencion del proyecto. Se
  // acepta SECRETO a secas por si quedo cargado con ese nombre.
  const secreto = Deno.env.get('GHL_SECRETO') || Deno.env.get('SECRETO') || '';
  if (!secreto || u.searchParams.get('s') !== secreto) {
    return json({ ok: false, error: 'secreto invalido' }, 401);
  }

  const accion = u.searchParams.get('accion') || 'calendarios';
  if (accion === 'ping') return json({ ok: true, servicio: 'ghl' });

  const CONOCIDAS = ['calendarios', 'eventos', 'campos', 'formularios', 'asignar', 'config'];
  if (CONOCIDAS.indexOf(accion) < 0) {
    return json({ ok: false, error: 'accion desconocida: ' + accion }, 400);
  }

  let cuerpo: any = {};
  try { cuerpo = await req.json(); } catch (_e) { /* sin cuerpo */ }
  const token = String(cuerpo.token || '').trim();
  const location = String(cuerpo.location || '').trim();
  if (!token || !location) {
    return json({ ok: false, error: 'faltan token y location del cliente' }, 400);
  }

  try {
    if (accion === 'eventos') {
      const cals = (cuerpo.calendarios || []).map((x: any) => String(x || '').trim())
        .filter(Boolean);
      if (!cals.length) {
        return json({ ok: false, error: 'no me pasaste ningun calendario' }, 400);
      }
      // Por defecto, de hace una semana a dos meses: atras alcanza para ver la
      // que ya paso, adelante para las que estan agendadas.
      const ahora = Number(cuerpo.ahora) || 0;
      if (!ahora) return json({ ok: false, error: 'falta ahora (epoch en millis)' }, 400);
      const desde = Number(cuerpo.desde) || (ahora - 7 * 24 * 3600 * 1000);
      const hasta = Number(cuerpo.hasta) || (ahora + 60 * 24 * 3600 * 1000);
      const r = await traerEventos(token, location, cals, desde, hasta);
      return json(r, 200);
    }
    if (accion === 'config') {
      const r = await contactoConfig(token, location, cuerpo.guardar);
      return json(r, r.ok ? 200 : 502);
    }
    if (accion === 'formularios') {
      const r = await traerFormularios(token, location);
      return json(r, r.ok ? 200 : 502);
    }
    if (accion === 'asignar') {
      const cal = String(cuerpo.calendario || '').trim();
      if (!cal) return json({ ok: false, error: 'falta el calendario' }, 400);
      const r = await asignarFormulario(token, location, cal,
        String(cuerpo.formulario || '').trim());
      return json(r, r.ok ? 200 : 502);
    }
    if (accion === 'campos') {
      const campos = Array.isArray(cuerpo.campos) ? cuerpo.campos : [];
      if (!campos.length) return json({ ok: false, error: 'no me pasaste ningun campo' }, 400);
      const r = await crearCampos(token, location, campos);
      return json(r, 200);
    }
    const r = await traerCalendarios(token, location);
    return json(r, r.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: 'no se pudo consultar GHL: ' + String(e) }, 502);
  }
});
