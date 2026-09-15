// Edge function "higgsfield" - genera imagenes y videos para las landings.
//
// La clave de Higgsfield no puede vivir en el tracker: index.html se sirve
// publico desde GitHub Pages y cualquiera lo lee. Por eso vive aca, del lado
// del servidor, y la app la llama con el mismo secreto que usa para GHL.
//
// La alternativa era una cola en la maquina de Angie, pero entonces nada se
// generaba con la compu cerrada y sus colaboradores dependian de ella. Esto
// corre siempre y para todo el equipo.
//
// Variables de entorno: HF_SECRETO, HF_KEY, HF_SECRET
//
// Acciones (todas piden el secreto: solo las llama el tracker, autenticado):
//   ?s=SECRETO&accion=ping                        -> {ok:true}
//   ?s=SECRETO&accion=video   POST {prompt, dur?, aspecto?, res?, modelo?}
//                                                 -> {ok, id}
//   ?s=SECRETO&accion=imagen  POST {prompt, aspecto?, modelo?}
//                                                 -> {ok, id}
//   ?s=SECRETO&accion=estado  POST {id}
//                        -> {ok, estado:'queued|in_progress|completed|failed', url?}
//
// La API es asincrona: se manda el pedido, devuelve un id, y se pregunta por
// el estado hasta que termina. El tracker es el que espera, no esta funcion:
// una edge function que se queda esperando cinco minutos se corta sola.

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

const BASE = 'https://api.higgsfield.ai';
// Seedance por defecto: es el que ya usan los prompts que arma el tracker.
const MODELO_VIDEO = '/bytedance/seedance/v1/pro/fast/text-to-video';
const MODELO_IMAGEN = '/higgsfield-ai/soul/v2/standard';

function credenciales() {
  const k = Deno.env.get('HF_KEY') || '';
  const s = Deno.env.get('HF_SECRET') || '';
  return { ok: !!(k && s), cab: 'Key ' + k + ':' + s };
}

// Los errores se devuelven con el texto literal de Higgsfield. Traducirlos a
// un mensaje propio ya nos costo varias vueltas de diagnostico con GHL.
async function leer(r: Response) {
  const texto = await r.text();
  let d: any = {};
  try { d = JSON.parse(texto); } catch (_e) { /* no era JSON */ }
  if (r.ok) return { ok: true as const, d };
  let msg = d.message || d.error || d.detail || texto;
  if (Array.isArray(msg)) msg = msg.join(' | ');
  if (msg && typeof msg === 'object') msg = JSON.stringify(msg);
  return {
    ok: false as const,
    status: r.status,
    error: (r.status === 401
      ? 'Higgsfield rechazo la clave (401). Tiene que ser el par key + secret: '
      : r.status === 402
      ? 'No alcanzan los creditos de Higgsfield (402): '
      : 'Higgsfield: ') + String(msg).slice(0, 300),
  };
}

async function generar(ruta: string, cuerpo: any) {
  const c = credenciales();
  if (!c.ok) return { ok: false, error: 'faltan HF_KEY y HF_SECRET en la funcion' };
  const r = await fetch(BASE + ruta, {
    method: 'POST',
    headers: {
      Authorization: c.cab,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  });
  const res = await leer(r);
  if (!res.ok) return res;
  const d: any = res.d;
  const id = String(d.request_id || d.id || '');
  if (!id) return { ok: false, status: 502, error: 'Higgsfield no devolvio request_id' };
  return { ok: true, id, estado: String(d.status || 'queued') };
}

// La URL del resultado viene en distinto lugar segun sea imagen o video, y el
// nombre cambio entre versiones. Se busca en todos en vez de elegir uno.
function urlDe(d: any): string {
  const listas = [d.videos, d.images, d.results, d.outputs, d.assets];
  for (const l of listas) {
    if (Array.isArray(l) && l.length) {
      const p = l[0];
      const u = typeof p === 'string' ? p : (p && (p.url || p.uri || p.output_url));
      if (u) return String(u);
    }
  }
  const suelto = d.url || d.output_url || d.video_url || d.image_url
    || (d.result && (d.result.url || d.result.video_url));
  return suelto ? String(suelto) : '';
}

async function estado(id: string) {
  const c = credenciales();
  if (!c.ok) return { ok: false, error: 'faltan HF_KEY y HF_SECRET en la funcion' };
  const r = await fetch(BASE + '/requests/' + encodeURIComponent(id) + '/status', {
    headers: { Authorization: c.cab, Accept: 'application/json' },
  });
  const res = await leer(r);
  if (!res.ok) return res;
  const d: any = res.d;
  const st = String(d.status || '');
  const url = urlDe(d);
  // nsfw y canceled tambien terminan: sin esto el tracker preguntaria para
  // siempre por algo que no va a cambiar nunca.
  const termino = ['completed', 'failed', 'nsfw', 'canceled'].indexOf(st) >= 0;
  return {
    ok: true,
    estado: st,
    termino,
    url,
    // Cuando termina mal, el motivo va tal cual lo dice Higgsfield.
    motivo: (st !== 'completed' && termino)
      ? String(d.reason || d.error || d.message || st).slice(0, 300)
      : '',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const u = new URL(req.url);
  const secreto = Deno.env.get('HF_SECRETO') || '';
  if (!secreto || u.searchParams.get('s') !== secreto) {
    return json({ ok: false, error: 'secreto invalido' }, 401);
  }

  const accion = u.searchParams.get('accion') || 'ping';
  if (accion === 'ping') {
    const c = credenciales();
    return json({ ok: true, servicio: 'higgsfield', credenciales: c.ok });
  }

  let cuerpo: any = {};
  try { cuerpo = await req.json(); } catch (_e) { /* sin cuerpo */ }

  try {
    if (accion === 'estado') {
      const id = String(cuerpo.id || '').trim();
      if (!id) return json({ ok: false, error: 'falta el id' }, 400);
      const r = await estado(id);
      return json(r, r.ok ? 200 : 502);
    }
    const prompt = String(cuerpo.prompt || '').trim();
    if (!prompt) return json({ ok: false, error: 'falta el prompt' }, 400);

    if (accion === 'imagen') {
      // El modelo y el aspecto se pueden pisar desde el tracker, igual que en
      // video. Hace falta para los estaticos: se piden en 1:1, 4:5 o 9:16
      // segun donde van, y sin esto el selector de formato de la app no
      // llegaba hasta aca y todo salia en el aspecto por defecto.
      const ruta = String(cuerpo.modelo || '').trim() || MODELO_IMAGEN;
      const cuerpoHf: any = { prompt };
      if (cuerpo.aspecto) cuerpoHf.aspect_ratio = String(cuerpo.aspecto);
      const r = await generar(ruta, cuerpoHf);
      return json(r, r.ok ? 200 : 502);
    }
    if (accion === 'video') {
      // El modelo se puede pisar desde el tracker: si Higgsfield mueve la ruta
      // o queres el lite en vez del pro, no hay que volver a deployar.
      const ruta = String(cuerpo.modelo || '').trim() || MODELO_VIDEO;
      const cuerpoHf: any = { prompt };
      if (cuerpo.dur) cuerpoHf.duration = Number(cuerpo.dur);
      if (cuerpo.aspecto) cuerpoHf.aspect_ratio = String(cuerpo.aspecto);
      if (cuerpo.res) cuerpoHf.resolution = String(cuerpo.res);
      const r = await generar(ruta, cuerpoHf);
      return json(r, r.ok ? 200 : 502);
    }
    return json({ ok: false, error: 'accion desconocida: ' + accion }, 400);
  } catch (e) {
    return json({ ok: false, error: 'no se pudo consultar Higgsfield: ' + String(e) }, 502);
  }
});
