// ============================================================
//  La funcion que recibe las llamadas de Fathom.
//
//  Hace tres cosas segun la URL con la que la llamen:
//    ?s=SECRETO               -> recibe el webhook de Fathom (lo de siempre)
//    ?s=SECRETO&accion=alta   -> da de alta el webhook en la cuenta de alguien
//    ?s=SECRETO&accion=buscar -> busca reuniones viejas de un cliente
//
//  Lo segundo existe porque Fathom saco la pantalla de webhooks de su UI:
//  ahora solo se pueden crear por API, y el navegador no puede llamar a
//  api.fathom.ai directo (CORS). Asi el tracker le pide a esta funcion que
//  lo haga, y nadie tiene que abrir una terminal.
//
//  Recorda: "Verify JWT" desmarcado en la pantalla de la funcion.
// ============================================================

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRETO = Deno.env.get('FATHOM_SECRETO') || '';

// El tracker vive en otro dominio (github.io), asi que sin estos headers el
// navegador ni siquiera deja salir el pedido.
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// Cuantas paginas de Fathom se recorren como maximo en una busqueda. Antes se
// leia solo la primera: si el cliente tenia reuniones mas viejas que las 25
// ultimas de la cuenta, no aparecian nunca y parecia que no existian.
const MAX_PAGINAS = 10;

Deno.serve(async (req) => {
  // El preflight del navegador. Sin esto el boton del tracker falla antes de
  // mandar nada, con un error de CORS que no dice cual es el problema real.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);

  if (req.method === 'GET') {
    return json({ ok: true, secreto_cargado: !!SECRETO });
  }
  if (req.method !== 'POST') {
    return new Response('metodo no permitido', { status: 405, headers: CORS });
  }

  // Antes decia `if (SECRETO && ...)`: si el secreto no estaba cargado, la
  // validacion se salteaba entera y el endpoint quedaba abierto. Ahora falla
  // ruidoso en vez de abrirse solo.
  if (!SECRETO) return new Response('secreto no configurado', { status: 500, headers: CORS });
  if (url.searchParams.get('s') !== SECRETO) {
    return new Response('secreto invalido', { status: 401, headers: CORS });
  }

  let ev: any;
  try {
    ev = await req.json();
  } catch {
    return new Response('cuerpo ilegible', { status: 400, headers: CORS });
  }

  // ---- Buscar reuniones de un cliente en Fathom ----
  // El webhook solo trae lo que pasa de ahora en mas. Esto sirve para lo
  // anterior: las llamadas viejas que nunca entraron.
  // La key vive como secreto de la funcion, nunca en el navegador. Ojo con el
  // techo: una API key de Fathom solo ve las grabaciones de su dueno y las
  // compartidas con su Team. En plan free, solo las propias.
  if (url.searchParams.get('accion') === 'buscar') {
    const emails = (Array.isArray(ev.emails) ? ev.emails : [])
      .map((m: string) => String(m || '').trim().toLowerCase()).filter(Boolean);
    const dominios = (Array.isArray(ev.dominios) ? ev.dominios : [])
      .map((d: string) => String(d || '').trim().toLowerCase()).filter(Boolean);

    // Sin ninguna de las dos cosas no hay busqueda posible: la API devolveria
    // la agenda entera de la agencia y el tracker la cargaria en la ficha de
    // quien haya apretado el boton. Ya paso una vez.
    if (!emails.length && !dominios.length) {
      return json({ error: 'Falta el mail o el dominio del cliente.' }, 400);
    }

    // Todas las keys guardadas. Cada una ve solo las grabaciones de su dueno,
    // asi que para cubrir al equipo hay que preguntarle a todas y juntar.
    const kr = await fetch(`${SB_URL}/rest/v1/fathom_keys?select=email,persona,nombre,api_key`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
    });
    let claves: any[] = [];
    let errTabla = '';
    if (kr.ok) { try { claves = await kr.json(); } catch { errTabla = 'respuesta ilegible'; } }
    // Que la tabla este vacia y que no se pueda leer son cosas distintas, y el
    // mensaje tiene que decir cual es: si PostgREST todavia no vio la tabla
    // recien creada, contesta 404 y parecia que no habia ninguna key cargada.
    else errTabla = 'HTTP ' + kr.status + ': ' + (await kr.text()).slice(0, 200);
    // La del secreto se suma si esta: sirve para arrancar antes de dar de alta
    // a nadie, y como respaldo si la tabla quedo vacia.
    const suelta = Deno.env.get('FATHOM_API_KEY') || '';
    if (suelta && !claves.some((k) => k.api_key === suelta)) {
      claves.push({ email: '(secreto de la funcion)', nombre: '', api_key: suelta });
    }
    if (!claves.length) {
      return json({ error: errTabla
        ? ('No pude leer la tabla fathom_keys — ' + errTabla
           + '. Si dice que no encuentra la tabla, corre en el SQL Editor: '
           + "notify pgrst, 'reload schema';")
        : ('La tabla fathom_keys esta vacia. Reconecta a alguien desde Usuarios.') }, 400);
    }

    // Solo el dominio se le puede pedir a la API: calendar_invitees[] no es un
    // parametro que exista, y mandarlo no hacia nada mas que dar la impresion
    // de que la busqueda estaba filtrada. El mail se filtra mas abajo, con lo
    // que Fathom devuelve.
    const base = new URLSearchParams();
    dominios.forEach((d) => base.append('calendar_invitees_domains[]', d));
    if (ev.desde) base.set('created_after', String(ev.desde));
    if (ev.hasta) base.set('created_before', String(ev.hasta));
    if (ev.transcripcion) base.set('include_transcript', 'true');
    base.set('include_summary', 'true');
    base.set('include_action_items', 'true');

    // Si no hay dominio, la consulta sale sin filtro y hay que recorrer mas
    // paginas para encontrar las del cliente entre todas las de la agencia.
    const paginas = dominios.length ? 3 : MAX_PAGINAS;

    // Es del cliente si alguno de los invitados es el mail que cargaron en la
    // ficha, o si su dominio coincide. Es el filtro que la API no sabe hacer.
    const esDelCliente = (m: any) => {
      const inv = Array.isArray(m.calendar_invitees) ? m.calendar_invitees : [];
      return inv.some((i: any) => {
        const mail = String(i?.email || '').toLowerCase();
        const dom = String(i?.email_domain || mail.split('@')[1] || '').toLowerCase();
        return (mail && emails.includes(mail)) || (dom && dominios.includes(dom));
      });
    };

    const vistos: Record<string, boolean> = {};
    const items: any[] = [];
    const fallos: string[] = [];
    let mirados = 0;

    for (const k of claves) {
      let cursor: string | null = null;
      for (let p = 0; p < paginas; p++) {
        try {
          const q = new URLSearchParams(base);
          if (cursor) q.set('cursor', cursor);
          const r2 = await fetch('https://api.fathom.ai/external/v1/meetings?' + q.toString(), {
            headers: { 'X-Api-Key': k.api_key },
          });
          if (!r2.ok) { fallos.push((k.nombre || k.email) + ': ' + await r2.text()); break; }
          const d2 = await r2.json();

          for (const m of (d2.items || [])) {
            mirados++;
            // El filtro por mail vive aca porque la API no lo ofrece. Sin esto,
            // un cliente con Gmail se llevaba puestas todas las reuniones.
            if (!esDelCliente(m)) continue;
            // La misma reunion puede aparecer en varias cuentas si estuvo
            // compartida. Se deduplica por recording_id.
            const id = String(m.recording_id || m.url || '');
            if (!id || vistos[id]) continue;
            vistos[id] = true;
            items.push({
              recording_id: m.recording_id,
              title: m.title || m.meeting_title || '',
              // La de compartir primero. url apunta a /calls/NNN, que es
              // privada del dueno: quien no es el dueno abre y le pide
              // permiso. share_url es la que existe para esto.
              url: m.share_url || m.url || '',
              fecha: m.recording_start_time || m.created_at || '',
              // La duracion la muestra la ficha al lado de la fecha. Fathom no
              // manda un campo de duracion: sale de restar las dos puntas de la
              // grabacion. Sin esto la llamada importada quedaba con la fecha
              // sola y un guion colgando.
              duracion: (function () {
                const ini = m.recording_start_time, fin = m.recording_end_time;
                const ms = (ini && fin) ? (new Date(fin).getTime() - new Date(ini).getTime()) : 0;
                if (!(ms > 0)) return '';
                const min = Math.round(ms / 60000);
                return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`;
              })(),
              grabo: (m.recorded_by && (m.recorded_by.name || m.recorded_by.email))
                || k.nombre || k.email || '',
              resumen: (typeof m.default_summary === 'string'
                ? m.default_summary : (m.default_summary && m.default_summary.markdown_formatted)) || '',
              transcripcion: typeof m.transcript === 'string'
                ? m.transcript
                : (Array.isArray(m.transcript)
                    ? m.transcript.map((x: any) =>
                        `${x.timestamp || ''} - ${x.speaker?.display_name || ''}: ${x.text || ''}`)
                      .join('\n')
                    : ''),
              action_items: m.action_items || [],
              // Para que el tracker pueda mostrar con quien fue y uno vea si el
              // match tiene sentido antes de importar.
              invitados: (Array.isArray(m.calendar_invitees) ? m.calendar_invitees : [])
                .map((i: any) => i?.email).filter(Boolean),
            });
          }

          cursor = d2.next_cursor ?? null;
          if (!cursor) break;
        } catch (e) {
          fallos.push((k.nombre || k.email) + ': ' + (e as Error).message);
          break;
        }
      }
    }

    items.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    // Se avisa cuantas cuentas se consultaron: si alguien no conecto su Fathom,
    // sus llamadas no van a aparecer y conviene que se note. Y cuantas
    // reuniones se miraron, para distinguir "no hay ninguna del cliente" de
    // "no hay ninguna en la cuenta".
    return json({ ok: true, items, cuentas: claves.length, miradas: mirados, fallos });
  }

  // ---- Que cuentas de Fathom hay conectadas, y de quien ----
  //
  // La pantalla de Personas no puede leer `fathom_keys` sola: la tabla tiene
  // RLS sin policies porque guarda credenciales, asi que el navegador no la
  // alcanza. Hasta ahora eso se suplia con una marca guardada en la config del
  // tracker —`fathomKeyGuardada`—, que dice lo que PASO cuando alguien conecto
  // y no lo que HAY: si la fila despues desaparece, la pantalla sigue en
  // verde. Esto devuelve lo que hay de verdad.
  //
  // ⚠️  NUNCA DEVUELVE `api_key`. Es el unico motivo por el que esta tabla
  //     esta cerrada; una lista "de solo lectura" que la incluya la abre.
  if (url.searchParams.get('accion') === 'keys') {
    const kr = await fetch(
      `${SB_URL}/rest/v1/fathom_keys?select=email,persona,nombre,duenio,webhook_id,creada_at`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } });
    if (!kr.ok) {
      return json({ error: 'No pude leer fathom_keys — HTTP ' + kr.status + ': '
                           + (await kr.text()).slice(0, 200) }, 400);
    }
    let filas: any[] = [];
    try { filas = await kr.json(); } catch { filas = []; }
    return json({ ok: true, cuentas: filas.map((f: any) => ({
      cuenta: f.email, persona: f.persona || f.email, nombre: f.nombre || '',
      duenio: f.duenio || '', tiene_webhook: !!f.webhook_id, desde: f.creada_at,
    })) });
  }

  // ---- Alta del webhook en la cuenta de quien haya pegado su API key ----
  if (url.searchParams.get('accion') === 'alta') {
    const key = String(ev.api_key || '').trim();
    if (!key) return json({ error: 'Falta la API key.' }, 400);

    // El destino se arma con la URL con la que llamaron a esta misma funcion,
    // asi respeta la capitalizacion real y no hay que mantenerla en dos lados.
    // El destino NO se puede derivar de req.url: adentro de una edge function
    // esa es la URL interna (http, host de Supabase), y Fathom la rechaza con
    // "Must be a valid HTTPS URL". La manda el tracker, que tiene la publica
    // guardada y ya probada. Se valida igual para que este parametro no sirva
    // para apuntar el webhook a cualquier lado.
    let destino = String(ev.destino || '').trim();
    if (!destino) {
      // Fallback: el header Host si trae el dominio publico, forzando https.
      const h = req.headers.get('host') || '';
      if (h) destino = `https://${h}${new URL(req.url).pathname}?s=${encodeURIComponent(SECRETO)}`;
    }
    if (!/^https:\/\/[^\/]+\/functions\/v1\/[^?]+/.test(destino)) {
      return json({ error: 'La URL de destino no es valida: ' + destino }, 400);
    }
    // El secreto lo pone la funcion, no el que llama: asi no se puede dar de
    // alta un webhook que despues nuestra propia funcion vaya a rechazar.
    destino = destino.split('?')[0] + '?s=' + encodeURIComponent(SECRETO);

    const cab = { 'X-Api-Key': key, 'Content-Type': 'application/json' };

    // La API de Fathom solo permite crear y borrar webhooks: no hay endpoint
    // para listarlos (GET /webhooks devuelve 404). Asi que no se puede
    // preguntar si ya existe. El control de duplicados lo hace el tracker, que
    // esconde el boton en cuanto la persona figura como conectada.

    // De quien es esta key, segun Fathom. Sirve para que el tracker avise si
    // pegaste la tuya en la fila de otra persona: el webhook quedaria creado
    // igual, pero conectando la cuenta equivocada y sin que nada lo delate.
    // Tambien valida la key antes de crear nada: si esto da 401, la key esta
    // mal y conviene decirlo sin haber tocado la cuenta.
    let duenio = '';
    let keyMal = '';
    try {
      const m = await fetch('https://api.fathom.ai/external/v1/meetings', { headers: cab });
      if (m.status === 401 || m.status === 403) {
        keyMal = await m.text();
      } else if (m.ok) {
        const md = await m.json();
        const it = (md.items || md.meetings || [])[0];
        duenio = it?.recorded_by?.email || '';
      }
    } catch { /* no es motivo para fallar el alta */ }
    if (keyMal) return json({ error: 'Fathom rechazo esa API key: ' + keyMal }, 400);

    const cr = await fetch('https://api.fathom.ai/external/v1/webhooks', {
      method: 'POST',
      headers: cab,
      body: JSON.stringify({
        destination_url: destino,
        triggered_for: ['my_recordings'],
        include_transcript: true,
        include_summary: true,
        include_action_items: true,
        include_crm_matches: false,
      }),
    });
    const crTxt = await cr.text();
    if (!cr.ok) return json({ error: 'Fathom no lo creo: ' + crTxt }, 400);

    let creado: any = null;
    try { creado = JSON.parse(crTxt); } catch {}

    // La key se guarda para poder buscar hacia atras en las grabaciones de esta
    // persona. Va a fathom_keys, que tiene RLS sin policies: solo la alcanza la
    // service_role desde aca dentro. El navegador no puede leerla.
    // ⚠️  LA FILA ES DE LA CUENTA DE FATHOM, NO DE LA PERSONA. `email` es la
    //     clave primaria, asi que guardar ahi el mail de quien conecta daba
    //     una sola cuenta por persona: el segundo Fathom de alguien entraba
    //     por `on_conflict=email,merge-duplicates` y PISABA el primero, sin
    //     error y sin aviso. Ahora la PK es el mail de la cuenta —el
    //     `recorded_by.email` que Fathom devuelve, que ya se venia leyendo
    //     para avisar "ojo, esa key es de otro"— y `persona` dice de quien
    //     del equipo es. Dos cuentas de la misma persona son dos mails, asi
    //     que son dos filas.
    const persona = String(ev.email || duenio || '').trim().toLowerCase();
    const cuenta = String(duenio || '').trim().toLowerCase() || persona;
    // Sin `duenio` no se pueden distinguir dos cuentas de la misma persona:
    // las dos filas caerian en la misma PK y la segunda pisaria a la primera,
    // que es exactamente lo que esto vino a arreglar. Fathom no lo dice cuando
    // la cuenta todavia no tiene ninguna grabacion. Se avisa en vez de pisar.
    const aCiegas = !duenio;
    let guardada = false;
    let errKey = '';
    if (persona) {
      const g = await fetch(`${SB_URL}/rest/v1/fathom_keys?on_conflict=email`, {
        method: 'POST',
        headers: {
          'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          email: cuenta, persona: persona, nombre: String(ev.nombre || ''),
          api_key: key,
          webhook_id: creado?.id ? String(creado.id) : null, duenio: duenio || null,
        }),
      });
      guardada = g.ok;
      if (!g.ok) {
        errKey = await g.text();
        console.error('no pude guardar la key:', errKey);
      }
    } else {
      errKey = 'no vino el email de la persona';
    }
    // Antes esto devolvia guardada:true con solo tener un email, sin mirar si
    // el insert habia salido. El tracker mostraba la fila en verde con la tabla
    // vacia, que es la peor forma de fallar: parece que anda.
    return json({ ok: true, estado: 'creado', id: creado?.id ?? null, duenio,
                  cuenta, persona, a_ciegas: aCiegas,
                  guardada, error_key: errKey });
  }

  // ---- Lo de siempre: guardar la llamada que manda Fathom ----
  const rec = ev.recording || ev.meeting || ev;
  const id = String(
    rec.recording_id ?? rec.id ?? ev.recording_id ?? ev.id ?? ''
  ).trim();
  if (!id) {
    return new Response('sin id de grabacion', { status: 400, headers: CORS });
  }

  const quien = rec.recorded_by || ev.recorded_by || {};
  const transcripcion = typeof rec.transcript === 'string'
    ? rec.transcript
    : Array.isArray(rec.transcript)
      ? rec.transcript.map((t: any) =>
          // Fathom nombra al que habla display_name. Antes solo se probaba
          // .name, asi que los nombres salian vacios en toda la transcripcion.
          `${t.timestamp || t.start || ''} - ${t.speaker?.display_name || t.speaker?.name || t.speaker || ''}: ${t.text || ''}`
        ).join('\n')
      : '';

  const fila = {
    recording_id: id,
    titulo: rec.title || rec.meeting_title || ev.title || '',
    fecha: rec.created_at || rec.scheduled_start_time || ev.created_at || new Date().toISOString(),
    duracion: String(rec.duration ?? rec.recording_duration ?? ''),
    grabo_mail: quien.email || '',
    grabo_nombre: quien.name || '',
    // Misma razon que en la busqueda: la de compartir primero, o el link que
    // queda guardado solo lo abre quien grabo.
    url: rec.share_url || rec.url || rec.recording_url || '',
    resumen: (typeof rec.summary === 'string' ? rec.summary : rec.summary?.markdown_formatted) || '',
    transcripcion,
    action_items: rec.action_items || ev.action_items || [],
    participantes: rec.calendar_invitees || rec.participants || [],
    procesada: false,
  };

  const r = await fetch(
    `${SB_URL}/rest/v1/llamadas_fathom?on_conflict=recording_id`,
    {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(fila),
    }
  );

  if (!r.ok) {
    const detalle = await r.text();
    console.error('no pude guardar:', detalle);
    return new Response(detalle, { status: 500, headers: CORS });
  }

  return json({ ok: true, id });
});