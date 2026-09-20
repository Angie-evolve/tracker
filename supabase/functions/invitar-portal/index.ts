// Crea la cuenta de un cliente para el portal y le deja el perfil listo.
// Solo la puede llamar alguien con rol 'agencia'.
// La llave maestra vive acá y nunca sale.

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function admin(path: string, init: RequestInit = {}) {
  return fetch(SB_URL + path, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: 'Bearer ' + SERVICE,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

// Sin eñes ni caracteres que se confundan al dictarla por WhatsApp.
function generarClave() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const n = new Uint8Array(14);
  crypto.getRandomValues(n);
  return Array.from(n, b => abc[b % abc.length]).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Usá POST' }, 405);

  // 1. Quién llama.
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Falta el carnet' }, 401);

  const who = await fetch(SB_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE, Authorization: auth },
  });
  if (!who.ok) return json({ error: 'Carnet invalido' }, 401);
  const user = await who.json();

  // 2. ¿Es de la agencia? SIN ESTO, esta URL es una puerta abierta para que
  //    cualquiera se cree usuarios. Es el chequeo mas importante del archivo.
  const perf  = await admin('/rest/v1/perfiles?select=rol&user_id=eq.' + user.id);
  const filas = await perf.json();
  if (!Array.isArray(filas) || !filas[0] || filas[0].rol !== 'agencia') {
    return json({ error: 'Solo la agencia puede invitar' }, 403);
  }

  // 3. El pedido.
  const body      = await req.json().catch(() => ({}));
  const email     = String(body.email || '').trim().toLowerCase();
  const clienteId = String(body.cliente_id || '').trim();
  const nombre    = String(body.nombre || '').trim();
  if (!email || !clienteId) return json({ error: 'Faltan email o cliente_id' }, 400);

  // 4. Que el cliente exista. Un cliente_id mal escrito dejaria al usuario
  //    entrando y sin ver nada, sin ninguna pista de por que.
  const cli  = await admin('/rest/v1/clientes?select=id&id=eq.' + encodeURIComponent(clienteId));
  const rows = await cli.json();
  if (!Array.isArray(rows) || !rows.length) {
    return json({ error: 'Ese cliente no existe: ' + clienteId }, 400);
  }

  // 5. La cuenta.
  const clave = generarClave();
  const alta  = await admin('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: clave, email_confirm: true }),
  });
  const cuenta = await alta.json();
  if (!alta.ok) {
    return json({ error: cuenta?.msg || cuenta?.error_description
      || 'No pude crear la cuenta (¿ya existe ese mail?)' }, 400);
  }

  // 6. El perfil. El disparador ya creo uno como 'cliente' sin cliente
  //    asignado: aca se le pone cual.
  const perfil = await admin('/rest/v1/perfiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      user_id: cuenta.id, rol: 'cliente',
      cliente_id: clienteId, nombre: nombre || email,
    }),
  });
  if (!perfil.ok) {
    return json({ error: 'Cuenta creada pero fallo el perfil: ' + await perfil.text() }, 500);
  }

  return json({ ok: true, email, cliente_id: clienteId, clave });
});
