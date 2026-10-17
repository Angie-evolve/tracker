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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const u = new URL(req.url);
  // Mismo nombre que FATHOM_SECRETO, que es la convencion del proyecto. Se
  // acepta SECRETO a secas por si quedo cargado con ese nombre.
  const secreto = Deno.env.get('GHL_SECRETO') || Deno.env.get('SECRETO') || '';
  if (!secreto || u.searchParams.get('s') !== secreto) {
    return json({ ok: false, error: 'secreto invalido' }, 401);
  }

  const accion = u.searchParams.get('accion') || 'calendarios';
  if (accion === 'ping') return json({ ok: true, servicio: 'ghl' });

  if (accion !== 'calendarios' && accion !== 'eventos') {
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
    const r = await traerCalendarios(token, location);
    return json(r, r.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: 'no se pudo consultar GHL: ' + String(e) }, 502);
  }
});
