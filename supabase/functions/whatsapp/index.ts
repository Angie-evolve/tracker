// Tasa de respuesta de WhatsApp, por cliente.
//
// QUE CONTESTA
// De los leads a los que les escribimos por WhatsApp, cuantos contestaron.
// Es el agujero que hay hoy en el embudo: entre "Registros" y "Agendas" no
// habia ningun numero, y la mayoria de los clientes tienen el WhatsApp colgado
// de su subcuenta de GHL.
//
// POR QUE ACA Y NO EN EL APPS SCRIPT
// El tracker le habla a GHL a traves del Apps Script porque el navegador no
// puede pegarle directo (CORS). Pero ese script tiene cuota diaria, hay que
// mantenerlo aparte, y ademas el de Oportunidades no implementa las acciones
// de conversaciones. Aca no hay cuota, el CORS lo resuelve la propia funcion,
// y el token del cliente NUNCA sale al navegador: se lee de la base del lado
// del servidor.
//
// PERMISOS
// Se usa el token de QUIEN LLAMA para leer `clientes`, no la service_role. Eso
// no es un detalle: con la service_role se saltea RLS y un CSM veria clientes
// que no son suyos. Usando su token, las policies de `clientes` y la funcion
// `puedo_ver_cliente` del 022 hacen el recorte solas, sin repetir la regla aca.
//
// Los tokens de GHL de los clientes YA tienen permiso de lectura de
// conversaciones: se verifico contra la API antes de escribir esto.

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function responder(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ⚠️  EL User-Agent NO ES DECORATIVO. Sin el, Cloudflare -que esta delante de
//     la API de GHL- contesta 403 desde un servidor. El cuerpo del 403 dice
//     "cloudflare", no "sin permiso", y es facil leerlo como que al token le
//     faltan scopes y mandar a regenerar tokens que estaban bien.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0 Safari/537.36";

const GHL = "https://services.leadconnectorhq.com";

// El codigo de WhatsApp en `messageTypes`. GHL los devuelve como NUMEROS, no
// como el nombre: 19 es TYPE_WHATSAPP, 28 actividad de oportunidad y 31 de
// cita. Se decodifico abriendo mensajes reales, no de la documentacion.
const TIPO_WHATSAPP = 19;

async function ghl(token: string, camino: string) {
  const r = await fetch(GHL + camino, {
    headers: {
      Authorization: "Bearer " + token,
      Version: "2021-04-15",
      Accept: "application/json",
      "User-Agent": UA,
    },
  });
  const txt = await r.text();
  if (!r.ok) {
    const deCloudflare = /cloudflare/i.test(txt);
    throw new Error(
      deCloudflare
        ? `GHL ${r.status}: lo corto Cloudflare, no es un problema de permisos del token`
        : `GHL ${r.status}: ${txt.slice(0, 160)}`,
    );
  }
  return JSON.parse(txt);
}

// Trae TODAS las conversaciones de una subcuenta.
//
// ⚠️  SE PAGINA CON `startAfterDate`, usando el `sort` de la ultima fila.
//     `offset` y `page` NO fallan: devuelven otra vez la primera pagina, sin
//     avisar. Con 143 conversaciones eso da 100 + 100 "nuevas" que son las
//     mismas, y la tasa sale calculada sobre el doble de nada.
async function conversaciones(token: string, location: string, tope = 2000) {
  const todas: any[] = [];
  let cursor: number | null = null;
  let total: number | null = null;

  for (let vuelta = 0; vuelta < 40; vuelta++) {
    const qs = `/conversations/search?locationId=${encodeURIComponent(location)}&limit=100` +
      (cursor === null ? "" : `&startAfterDate=${cursor}`);
    const d = await ghl(token, qs);
    const lote: any[] = d.conversations || [];
    if (total === null && typeof d.total === "number") total = d.total;
    if (!lote.length) break;
    todas.push(...lote);
    if (todas.length >= tope) break;

    const ultima = lote[lote.length - 1];
    const s = ultima && ultima.sort;
    const proximo = Array.isArray(s) ? s[0] : s;
    // Sin cursor nuevo no se puede avanzar: se corta en vez de repetir la
    // misma pagina para siempre.
    if (typeof proximo !== "number" || proximo === cursor) break;
    cursor = proximo;
    if (lote.length < 100) break;
  }
  return { lista: todas, total };
}

// Corre `fn` sobre la lista con un tope de tareas a la vez. Sin tope, una
// subcuenta de 300 hilos dispara 300 pedidos juntos y GHL corta.
async function enTandas<T, R>(lista: T[], tope: number, fn: (x: T) => Promise<R>) {
  const salida: R[] = [];
  for (let i = 0; i < lista.length; i += tope) {
    salida.push(...await Promise.all(lista.slice(i, i + tope).map(fn)));
  }
  return salida;
}

/* Separa "no respondió" de "no le llegó".
 *
 * El estado de entrega NO viene en la lista de conversaciones: hay que abrir
 * el hilo. Por eso se abren SOLO los que podrian cambiar de respuesta —los
 * que tienen WhatsApp y ninguna entrada del lead—, no todos. En Ojapo son 55
 * de 79, y con 8 en paralelo tarda 3 segundos.
 *
 * Un saliente de WhatsApp viene con `status`: delivered, read, sent o failed.
 * Si TODOS los intentos fallaron, el mensaje nunca llego —el numero estaba mal
 * cargado— y ese lead no deberia contar como "no respondio": nunca tuvo la
 * oportunidad de hacerlo.
 */
const TOPE_HILOS = 600;

async function entrega(token: string, mudas: any[]) {
  const recortado = mudas.length > TOPE_HILOS;
  const lote = recortado ? mudas.slice(0, TOPE_HILOS) : mudas;
  const noLlego: string[] = [];
  const sinEnviar: string[] = [];

  await enTandas(lote, 8, async (c: any) => {
    let ms: any[] = [];
    try {
      const d = await ghl(token, `/conversations/${c.id}/messages?limit=100`);
      ms = (d.messages && d.messages.messages) || d.messages || [];
    } catch {
      return; // un hilo que no se pudo leer no se clasifica, no se inventa
    }
    const salientes = ms.filter((m: any) =>
      m && m.direction === "outbound" &&
      (m.messageType === "TYPE_WHATSAPP" || m.type === TIPO_WHATSAPP)
    );
    const id = String(c.contactId || "");
    if (!id) return;
    if (!salientes.length) { sinEnviar.push(id); return; }
    const llego = salientes.some((m: any) =>
      m.status === "delivered" || m.status === "read" || m.status === "sent"
    );
    if (!llego) noLlego.push(id);
  });

  return { noLlego, sinEnviar, recortado };
}

function medir(cs: any[]) {
  const conWhatsapp = cs.filter((c) =>
    Array.isArray(c.messageTypes) && c.messageTypes.includes(TIPO_WHATSAPP)
  );
  // `lastInboundWhatsappMessageDate` lo pone GHL en la propia lista: si esta,
  // el lead escribio por WhatsApp al menos una vez. No hace falta abrir el
  // hilo de cada conversacion, que serian cientos de llamadas por cliente.
  //
  // ⚠️  ESTO MIDE "EL LEAD HABLO", NO "EL LEAD NOS CONTESTO". La lista no dice
  //     quien escribio primero. En una campana de clic-a-WhatsApp el lead
  //     ARRANCA la conversacion, asi que el numero sube por si solo y no habla
  //     de nuestra gestion: es mas parecido a "de los que hicieron clic,
  //     cuantos llegaron a escribir". Se ve en los datos: Albet, que va por
  //     clic-a-WhatsApp, da 93,8%, y Kompensity, que escribe el primero, 1,5%.
  //     Saber quien hablo primero obliga a abrir el hilo de cada conversacion
  //     —cientos de llamadas por cliente—, asi que no se hace aca.
  const respondieron = conWhatsapp.filter((c) => !!c.lastInboundWhatsappMessageDate);
  const sinLeer = conWhatsapp.filter((c) => Number(c.unreadCount || 0) > 0);
  // ⚠️  SE DEVUELVEN LOS contactId, NO SOLO LOS TOTALES. Sin esto el numero es
  //     el de TODA la subcuenta, y el embudo esta mirando otra cosa: los leads
  //     de este cliente, en este periodo y con este segmento. En Ojapo la
  //     diferencia era 21 de 76 contra 15 de 67, y el 15 es el que coincide
  //     con el conteo a mano. Cruzando en el navegador el numero sigue los
  //     mismos filtros que el resto de la columna.
  const id = (c: any) => String(c.contactId || "");
  // Las que hay que abrir en el segundo paso: tienen WhatsApp y el lead nunca
  // escribio, asi que son las unicas donde el estado de entrega cambia algo.
  const mudas = conWhatsapp.filter((c) => !c.lastInboundWhatsappMessageDate);
  return {
    _mudas: mudas,
    conversaciones: cs.length,
    conWhatsapp: conWhatsapp.length,
    respondieron: respondieron.length,
    sinLeer: sinLeer.length,
    contactosWa: conWhatsapp.map(id).filter(Boolean),
    contactosResp: respondieron.map(id).filter(Boolean),
    // Null y no 0 cuando no hay a quien escribirle: "0%" se lee como "nadie
    // contesto", y "todavia no le escribimos a nadie" es otra cosa.
    tasa: conWhatsapp.length ? respondieron.length / conWhatsapp.length : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return responder({ error: "Hay que iniciar sesion." }, 401);
    }
    const cuerpo = await req.json().catch(() => ({}));
    const pedido = String((cuerpo as any).cliente || "").trim();

    // Con el token de quien llama: si no es del equipo, o es un CSM y el
    // cliente no es de su cartera, no vuelve ninguna fila y no hay nada que
    // explicar aparte.
    const filtro = pedido ? `&id=eq.${encodeURIComponent(pedido)}` : "";
    const r = await fetch(
      `${URL_SB}/rest/v1/clientes?select=id,nombre,datos${filtro}`,
      { headers: { apikey: ANON, Authorization: auth } },
    );
    if (!r.ok) {
      return responder({ error: "No pude leer los clientes: " + r.status }, 403);
    }
    const clientes = await r.json();
    if (!Array.isArray(clientes) || !clientes.length) {
      return responder({ error: "No hay clientes a los que puedas ver." }, 404);
    }

    const salida: any[] = [];
    for (const c of clientes) {
      const ghlCfg = (c.datos && c.datos.ghl) || {};
      const token = String(ghlCfg.token || "");
      const location = String(ghlCfg.locationId || "");
      if (!token || !location) {
        salida.push({ id: c.id, nombre: c.nombre, sinGhl: true });
        continue;
      }
      try {
        const { lista, total } = await conversaciones(token, location);
        const m: any = medir(lista);
        const mudas = m._mudas || [];
        delete m._mudas;
        const det = await entrega(token, mudas);
        salida.push({
          id: c.id,
          nombre: c.nombre,
          total,
          leidas: lista.length,
          ...m,
          // Los que nunca recibieron el mensaje. No son "no respondio": el
          // numero estaba mal cargado y nunca tuvieron la oportunidad.
          contactosNoLlego: det.noLlego,
          contactosSinEnviar: det.sinEnviar,
          noLlego: det.noLlego.length,
          sinEnviar: det.sinEnviar.length,
          detalleRecortado: det.recortado,
          at: new Date().toISOString(),
        });
      } catch (e) {
        salida.push({ id: c.id, nombre: c.nombre, error: String((e as Error).message) });
      }
    }
    return responder({ ok: true, clientes: salida });
  } catch (e) {
    return responder({ error: String((e as Error).message) }, 500);
  }
});
