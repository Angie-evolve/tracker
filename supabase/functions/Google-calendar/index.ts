// Edge function "gcal" - lee los calendarios de Google del equipo.
//
// Por que existe: una reunion agendada en el Google Calendar de alguien no
// llega a GHL salvo que el sync de dos vias este prendido, y ese sync crea un
// contacto por cada evento externo —el dentista, un cumpleanos— dentro de la
// subcuenta del cliente. Leyendo Google directo, el tracker ve las reuniones
// sin ensuciarle los contactos a nadie.
//
// El token no puede vivir en el tracker: index.html se sirve publico. Vive
// aca, y el refresh token en una tabla que solo lee esta funcion.
//
// Variables de entorno:
//   GCAL_SECRETO           el secreto que protege esta funcion
//   GOOGLE_CLIENT_ID       del proyecto de Google Cloud
//   GOOGLE_CLIENT_SECRET   idem
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   los pone Supabase sola
//
// Acciones:
//   ?s=SECRETO&accion=url&quien=mail     -> {ok, url}  para mandar a Google
//   GET ?accion=callback&code=...&state= -> pagina de "listo", guarda el token
//   ?s=SECRETO&accion=quien              -> {ok, cuentas:[{quien, desde}]}
//   ?s=SECRETO&accion=eventos POST {desde, hasta, quien?}
//                                        -> {ok, eventos:[...]}
//   ?s=SECRETO&accion=baja    POST {quien} -> {ok}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function html(txt: string) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Calendario</title>' +
    '<body style="margin:0;background:#0E0E12;color:#F0F0F0;font-family:system-ui;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">' +
    '<div style="max-width:32ch;line-height:1.6">' + txt + '</div>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
// Lectura para traer las agendas, y `calendar.events` para sumar invitados a
// un evento que ya existe -la capacitacion semanal-. Es el permiso mas acotado
// que permite escribir: deja tocar eventos, no crear ni borrar calendarios.
//
// ⚠️  CAMBIAR ESTO OBLIGA A RECONECTAR. El refresh token guardado quedo atado
//     al scope viejo: Google no lo amplia solo. Quien ya estaba conectado
//     tiene que volver a pasar por la pantalla de permisos.
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly ' +
  'https://www.googleapis.com/auth/calendar.events openid email';

function sb() {
  return {
    url: Deno.env.get('SUPABASE_URL') || '',
    key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  };
}
function miUrl(req: Request) {
  // Adentro del runtime de Supabase el request llega en http y con el prefijo
  // /functions/v1 ya sacado, asi que reconstruirlo desde req.url manda un
  // redirect_uri que no existe hacia afuera y Google lo rechaza. La unica
  // fuente confiable de la direccion publica es SUPABASE_URL.
  const base = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  const u = new URL(req.url);
  const nombre = u.pathname.replace(/^\/+/, '').replace(/^functions\/v1\//, '');
  if (!base) return u.origin + u.pathname;
  return base + '/functions/v1/' + nombre;
}

/* Devuelve el motivo cuando falla, no solo que fallo. Antes esto contestaba
   un booleano y la pantalla decia "no pude guardarlo" sin mas: con la tabla
   detras de RLS y sin forma de leerla desde el cliente, no habia por donde
   empezar a mirar. El detalle solo se ve al conectar, que lo hace alguien del
   equipo, y nunca incluye el token. */
async function guardarToken(quien: string, refresh: string) {
  const s = sb();
  if (!s.key) return { ok: false, porque: 'falta SUPABASE_SERVICE_ROLE_KEY en la funcion' };
  const r = await fetch(s.url + '/rest/v1/gcal_cuentas', {
    method: 'POST',
    headers: {
      apikey: s.key, Authorization: 'Bearer ' + s.key,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ quien, refresh_token: refresh, desde: new Date().toISOString() }),
  });
  if (r.ok) return { ok: true, porque: '' };
  let txt = '';
  try { txt = (await r.text()).slice(0, 400); } catch (_e) { /* sin cuerpo */ }
  return { ok: false, porque: 'HTTP ' + r.status + ' ' + txt };
}

async function accessToken(quien: string) {
  const s = sb();
  const r = await fetch(
    s.url + '/rest/v1/gcal_cuentas?quien=eq.' + encodeURIComponent(quien) +
      '&select=refresh_token',
    { headers: { apikey: s.key, Authorization: 'Bearer ' + s.key } },
  );
  const filas = r.ok ? await r.json().catch(() => []) : [];
  if (!filas.length) return { ok: false as const, error: 'esa cuenta no esta conectada' };
  const cuerpo = new URLSearchParams({
    client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
    client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
    refresh_token: filas[0].refresh_token,
    grant_type: 'refresh_token',
  });
  const t = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: cuerpo.toString(),
  });
  const d = await t.json().catch(() => ({}));
  if (!t.ok || !d.access_token) {
    // Si Google revoco el permiso, decirlo con esas palabras: el que lo lee
    // tiene que saber que hay que volver a conectar, no que fallo la red.
    return {
      ok: false as const,
      error: 'Google rechazo el refresh de ' + quien + ' (' +
        String(d.error_description || d.error || t.status) + '). Hay que volver a conectarla.',
    };
  }
  return { ok: true as const, token: String(d.access_token) };
}

// Normaliza al mismo shape que ya usan las citas de GHL, para que el tracker
// no tenga que saber de donde vino cada una.
function normalizar(ev: any) {
  const ini = ev.start && (ev.start.dateTime || ev.start.date);
  const fin = ev.end && (ev.end.dateTime || ev.end.date);
  const gente = (ev.attendees || []).filter((a: any) => !a.self && !a.resource);
  const uno = gente[0] || {};
  return {
    id: 'g:' + String(ev.id || ''),
    titulo: String(ev.summary || ''),
    inicio: String(ini || ''),
    fin: String(fin || ''),
    estado: ev.status === 'cancelled' ? 'cancelled' : 'confirmed',
    con: String(uno.displayName || uno.email || ''),
    mail: String(uno.email || '').trim().toLowerCase(),
    deGoogle: true,
  };
}

async function eventos(quien: string, desde: string, hasta: string) {
  const t = await accessToken(quien);
  if (!t.ok) return t;
  const q = new URLSearchParams({
    timeMin: desde, timeMax: hasta,
    // Las series se expanden a sus ocurrencias: sin esto una reunion semanal
    // llega como un solo evento con la fecha de la primera.
    singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
  });
  const r = await fetch(CAL + '?' + q.toString(), {
    headers: { Authorization: 'Bearer ' + t.token },
  });
  const texto = await r.text();
  if (!r.ok) {
    let msg = texto;
    try { msg = JSON.parse(texto).error?.message || msg; } catch (_e) { /* texto plano */ }
    return { ok: false as const, status: r.status, error: 'Google: ' + String(msg).slice(0, 240) };
  }
  let d: any = {};
  try { d = JSON.parse(texto); } catch (_e) { /* cae abajo */ }
  return {
    ok: true as const,
    quien,
    eventos: (d.items || []).map(normalizar).filter((e: any) => e.inicio),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const u = new URL(req.url);
  const accion = u.searchParams.get('accion') || '';

  // El callback lo abre Google en el navegador, no el tracker: no puede
  // llevar el secreto. Lo que lo protege es que sin un code valido de Google
  // no hace nada, y que el code se usa una sola vez.
  if (accion === 'callback') {
    const code = u.searchParams.get('code') || '';
    if (!code) return html('Faltó el código de Google. Cerrá y probá de nuevo.');
    const cuerpo = new URLSearchParams({
      code,
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
      redirect_uri: miUrl(req) + '?accion=callback',
      grant_type: 'authorization_code',
    });
    const t = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: cuerpo.toString(),
    });
    const d = await t.json().catch(() => ({}));
    if (!t.ok || !d.refresh_token) {
      return html('Google no devolvió el permiso permanente.<br><br>' +
        '<span style="opacity:.6;font-size:14px">' +
        String(d.error_description || d.error || 'sin refresh_token') + '</span>');
    }
    // El mail sale del id_token, que viene firmado: se lee el payload sin
    // verificar porque ya vino por TLS directo de Google, no del navegador.
    let quien = '';
    try {
      const p = String(d.id_token || '').split('.')[1];
      quien = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))).email || '';
    } catch (_e) { /* sin mail se guarda igual, con la fecha */ }
    const g = await guardarToken(quien || ('cuenta-' + Date.now()), String(d.refresh_token));
    return html(g.ok
      ? ('Listo, <b>' + (quien || 'la cuenta') + '</b> quedó conectada.<br><br>' +
         '<span style="opacity:.6;font-size:14px">Ya podés cerrar esta pestaña.</span>')
      : ('Se conectó pero no pude guardarlo.<br><br>' +
         '<span style="opacity:.6;font-size:14px">' +
         String(g.porque).replace(/</g, '&lt;') + '</span>'));
  }

  const secreto = Deno.env.get('GCAL_SECRETO') || '';
  if (!secreto || u.searchParams.get('s') !== secreto) {
    return json({ ok: false, error: 'secreto invalido' }, 401);
  }

  if (accion === 'ping') {
    return json({ ok: true, servicio: 'gcal',
      credenciales: !!(Deno.env.get('GOOGLE_CLIENT_ID') && Deno.env.get('GOOGLE_CLIENT_SECRET')) });
  }

  if (accion === 'url') {
    const q = new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
      redirect_uri: miUrl(req) + '?accion=callback',
      response_type: 'code',
      scope: SCOPE,
      // offline + consent es lo unico que hace que Google mande el refresh
      // token. Sin prompt=consent, la segunda vez no lo manda y la cuenta
      // queda conectada a medias.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return json({ ok: true, url: AUTH + '?' + q.toString() });
  }

  const s = sb();
  if (accion === 'quien') {
    const r = await fetch(s.url + '/rest/v1/gcal_cuentas?select=quien,desde',
      { headers: { apikey: s.key, Authorization: 'Bearer ' + s.key } });
    const filas = r.ok ? await r.json().catch(() => []) : [];
    return json({ ok: true, cuentas: filas });
  }

  let cuerpo: any = {};
  try { cuerpo = await req.json(); } catch (_e) { /* sin cuerpo */ }

  if (accion === 'baja') {
    const quien = String(cuerpo.quien || '').trim();
    if (!quien) return json({ ok: false, error: 'falta quien' }, 400);
    const r = await fetch(s.url + '/rest/v1/gcal_cuentas?quien=eq.' + encodeURIComponent(quien),
      { method: 'DELETE', headers: { apikey: s.key, Authorization: 'Bearer ' + s.key } });
    return json({ ok: r.ok });
  }

  /* Quien esta invitado a un evento, con nombre y apellido.

     `eventos` no sirve para esto: `normalizar` se queda con UN invitado -el
     primero- porque lo que necesita el calendario del tracker es "con quien
     es la reunion". Para saber quien de nuestros clientes ya esta adentro de
     una capacitacion hacen falta todos.

     Es de SOLO LECTURA. Deliberadamente no escribe: `invitar` ya existe para
     sumar gente, y mezclar las dos cosas en una accion hace que un error de
     tipeo en el titulo termine invitando a quien no era. */
  if (accion === 'invitados') {
    const desde = String(cuerpo.desde || '');
    const hasta = String(cuerpo.hasta || '');
    const titulo = String(cuerpo.titulo || '').trim().toLowerCase();
    if (!desde || !hasta) return json({ ok: false, error: 'falta el rango' }, 400);

    let quienes: string[] = [];
    if (cuerpo.quien) quienes = [String(cuerpo.quien)];
    else {
      const r = await fetch(s.url + '/rest/v1/gcal_cuentas?select=quien',
        { headers: { apikey: s.key, Authorization: 'Bearer ' + s.key } });
      const filas = r.ok ? await r.json().catch(() => []) : [];
      quienes = filas.map((x: any) => String(x.quien));
    }
    if (!quienes.length) {
      return json({ ok: true, eventos: [], fallos: ['no hay cuentas conectadas'] });
    }

    const out: any[] = [], fallos: string[] = [];
    for (const q of quienes) {
      const tk = await accessToken(q);
      if (!tk.ok) { fallos.push(tk.error || q); continue; }
      const p = new URLSearchParams({
        timeMin: desde, timeMax: hasta,
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      });
      const r = await fetch(CAL + '?' + p.toString(),
        { headers: { Authorization: 'Bearer ' + tk.token } });
      const txt = await r.text();
      if (!r.ok) { fallos.push('Google ' + r.status + ' en ' + q); continue; }
      let d: any = {};
      try { d = JSON.parse(txt); } catch (_e) { fallos.push('respuesta rara en ' + q); continue; }

      for (const ev of (d.items || [])) {
        if (ev.status === 'cancelled') continue;
        const t = String(ev.summary || '');
        // Sin titulo vienen todos; con titulo, los que lo contienen. Es
        // `includes` y no igualdad porque las series suelen llevar sufijos.
        if (titulo && t.toLowerCase().indexOf(titulo) < 0) continue;
        out.push({
          eventId: String(ev.id || ''),
          titulo: t,
          inicio: String((ev.start && (ev.start.dateTime || ev.start.date)) || ''),
          agenda: q,
          // `self` es la cuenta conectada y `resource` son las salas: ninguno
          // de los dos es una persona invitada.
          invitados: (ev.attendees || [])
            .filter((a: any) => !a.resource)
            .map((a: any) => ({
              mail: String(a.email || '').trim().toLowerCase(),
              nombre: String(a.displayName || ''),
              respuesta: String(a.responseStatus || ''),
              organiza: !!a.organizer,
            }))
            .filter((a: any) => a.mail),
        });
      }
    }
    out.sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
    return json({ ok: true, eventos: out, fallos });
  }

  if (accion === 'eventos') {
    const desde = String(cuerpo.desde || '');
    const hasta = String(cuerpo.hasta || '');
    if (!desde || !hasta) return json({ ok: false, error: 'falta el rango' }, 400);
    let quienes: string[] = [];
    if (cuerpo.quien) quienes = [String(cuerpo.quien)];
    else {
      const r = await fetch(s.url + '/rest/v1/gcal_cuentas?select=quien',
        { headers: { apikey: s.key, Authorization: 'Bearer ' + s.key } });
      const filas = r.ok ? await r.json().catch(() => []) : [];
      quienes = filas.map((x: any) => String(x.quien));
    }
    if (!quienes.length) return json({ ok: true, eventos: [], fallos: ['no hay cuentas conectadas'] });
    const out: any[] = [], fallos: string[] = [];
    for (const q of quienes) {
      const r = await eventos(q, desde, hasta);
      if (r.ok) {
        // Cada evento dice de quien es la agenda: el tracker lo usa para
        // mostrar quien toma la reunion, igual que con las de GHL.
        r.eventos.forEach((e: any) => { e.deNuestroLado = q; out.push(e); });
      } else fallos.push(r.error || q);
    }
    out.sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
    return json({ ok: true, eventos: out, fallos });
  }

  /* Suma gente como invitada a un evento que YA EXISTE. Si el evento es
     recurrente, Google la suma a toda la serie: por eso una llamada alcanza
     para el ciclo entero, y por eso existe este camino.

     Reemplaza a crear una cita por sesion en GHL. GHL tiene recurrencia propia
     pero la expande solo cuando la reserva entra por su widget publico: creada
     por API arma una sola cita, con recurring prendido y todo. Probado. */
  if (accion === 'invitar') {
    const quien = String(cuerpo.quien || '').trim().toLowerCase();
    const eventId = String(cuerpo.eventId || '').trim();
    const calendarId = String(cuerpo.calendarId || 'primary').trim();
    const mails: string[] = (Array.isArray(cuerpo.mails) ? cuerpo.mails : [])
      .map((m: unknown) => String(m || '').trim().toLowerCase())
      .filter((m: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m));

    if (!quien) return json({ ok: false, error: 'falta de que cuenta es el calendario' }, 400);
    if (!eventId) return json({ ok: false, error: 'falta el id del evento' }, 400);
    if (!mails.length) return json({ ok: false, error: 'no hay ningun mail valido' }, 400);

    const tk = await accessToken(quien);
    if (!tk.ok) return json({ ok: false, error: tk.error }, 401);

    const base = 'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
    const cab = { Authorization: 'Bearer ' + tk.token, 'Content-Type': 'application/json' };

    const rg = await fetch(base, { headers: cab });
    const crudo = await rg.text();
    if (!rg.ok) {
      return json({ ok: false,
        error: 'Google ' + rg.status + ' al leer el evento: ' + crudo.slice(0, 200) }, 502);
    }
    let ev: any = {};
    try { ev = JSON.parse(crudo); } catch (_e) {
      return json({ ok: false, error: 'Google contesto algo que no es JSON' }, 502);
    }

    /* ⚠️  SE LEE EL EVENTO ANTES DE ESCRIBIRLO. La API de Google PISA la lista
       entera de attendees: mandar solo el mail nuevo borraria a todos los que
       ya estaban. Se trae la lista, se le suma el que falta, y se manda
       completa. */
    const previos: any[] = Array.isArray(ev.attendees) ? ev.attendees : [];
    const yaHay = new Set(previos.map((a: any) => String(a.email || '').toLowerCase()));
    const sumados: string[] = [], yaEstaban: string[] = [];
    const lista = previos.slice();
    for (const m of mails) {
      if (yaHay.has(m)) { yaEstaban.push(m); continue; }
      lista.push({ email: m });
      yaHay.add(m);
      sumados.push(m);
    }

    // Nadie nuevo: no se escribe. Un PATCH sin cambios igual dispara mails de
    // "el evento cambio" a todos los invitados, y molesta por nada.
    if (!sumados.length) {
      return json({ ok: true, sumados: [], yaEstaban, invitados: previos.length,
                    titulo: String(ev.summary || '') });
    }

    // sendUpdates=all a proposito: sin eso Google lo agrega y no le avisa, y
    // queda invitado a algo que no sabe que existe.
    const rp = await fetch(base + '?sendUpdates=all', {
      method: 'PATCH', headers: cab, body: JSON.stringify({ attendees: lista }),
    });
    const crudoP = await rp.text();
    if (!rp.ok) {
      return json({ ok: false,
        error: 'Google ' + rp.status + ' al sumar invitados: ' + crudoP.slice(0, 200) }, 502);
    }
    return json({ ok: true, sumados, yaEstaban, invitados: lista.length,
                  titulo: String(ev.summary || '') });
  }

  return json({ ok: false, error: 'accion desconocida: ' + accion }, 400);
});
