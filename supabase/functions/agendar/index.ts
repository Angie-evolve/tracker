// Agendar una reunion en un calendario de GHL desde el tracker.
//
// Por que vive aca y no en un Apps Script como el resto:
//
// Los proxies de Apps Script reciben el token de GHL en el cuerpo del pedido,
// asi que la app lo guarda en el navegador y viaja en cada llamada. Alcanza una
// captura de pantalla de Integraciones para filtrarlo, y paso. Aca el token es
// una variable de entorno de Supabase: el navegador no lo ve nunca.
//
// Y el permiso: los Apps Script se protegen con un secreto compartido en la
// URL. Cualquiera que lo tenga entra. Esto valida la sesion de Supabase de
// quien llama y ademas exige que este en el equipo, igual que la de invitar.
//
// SECRETOS QUE HAY QUE CARGAR (Supabase > Edge Functions > agendar > Secrets):
//   GHL_TOKEN     el PIT de la subcuenta interna, con scope calendars.write
//                 y contacts.readonly
//   GHL_LOCATION  el id de esa subcuenta
// Se cargan a mano desde el panel. No los pongas en el repo ni los mandes por
// chat: son justo lo que este cambio viene a proteger.

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GHL_TOKEN = Deno.env.get("GHL_TOKEN") || "";
const GHL_LOCATION = Deno.env.get("GHL_LOCATION") || "";

const GHL_BASE = "https://services.leadconnectorhq.com";
// La misma que usan los Apps Script que ya funcionan. Si se cambia aca y no
// alla, dos partes de la app le hablan a dos versiones distintas de la API.
const GHL_VERSION = "2021-07-28";

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

async function admin(ruta: string, init: RequestInit = {}) {
  const r = await fetch(URL_SB + ruta, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: "Bearer " + SERVICE,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const txt = await r.text();
  let d: any = null;
  try { d = txt ? JSON.parse(txt) : null; } catch { /* sin cuerpo */ }
  if (!r.ok) throw new Error((d && (d.message || d.error)) || "HTTP " + r.status);
  return d;
}

async function quienLlama(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(URL_SB + "/auth/v1/user", {
    headers: { apikey: SERVICE, Authorization: auth },
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return (u && u.email) ? String(u.email).toLowerCase() : null;
}

async function esDelEquipo(email: string): Promise<boolean> {
  const filas = await admin(
    "/rest/v1/equipo_video?select=email&email=eq." + encodeURIComponent(email),
  );
  return Array.isArray(filas) && filas.length > 0;
}

// Llamada a GHL. Devuelve el cuerpo crudo ademas del parseado: cuando algo
// falla, el mensaje de GHL es lo unico que explica por que, y perderlo obliga
// a adivinar contra una API que no se puede leer desde aca.
async function ghl(ruta: string, init: RequestInit = {}) {
  const r = await fetch(GHL_BASE + ruta, {
    ...init,
    headers: {
      Authorization: "Bearer " + GHL_TOKEN,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const txt = await r.text();
  let d: any = null;
  try { d = txt ? JSON.parse(txt) : null; } catch { /* sin cuerpo */ }
  return { ok: r.ok, status: r.status, datos: d, crudo: txt.slice(0, 400) };
}

// El contacto ya existe: los leads entran por campanas de venta a GHL. Se busca
// por mail y no se crea nada: si no aparece, es mas probable que el mail del
// tracker este mal que que el contacto no exista, y crear uno duplicado ensucia
// la subcuenta sin arreglar nada.
async function buscarContacto(email: string) {
  const r = await ghl(
    "/contacts/?locationId=" + encodeURIComponent(GHL_LOCATION) +
    "&query=" + encodeURIComponent(email),
  );
  if (!r.ok) return { error: "GHL " + r.status + ": " + r.crudo };
  const lista = (r.datos && (r.datos.contacts || r.datos.contact)) || [];
  const arr = Array.isArray(lista) ? lista : [lista];
  const exacto = arr.find((c: any) =>
    String(c && c.email || "").toLowerCase() === email.toLowerCase()
  );
  if (!exacto) return { error: "No encontre un contacto con el mail " + email };
  return { id: exacto.id, nombre: exacto.contactName || exacto.firstName || "" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!GHL_TOKEN || !GHL_LOCATION) {
      return responder({ error: "Faltan los secretos GHL_TOKEN y GHL_LOCATION." }, 500);
    }
    const quien = await quienLlama(req);
    if (!quien) return responder({ error: "Hay que iniciar sesion." }, 401);
    if (!(await esDelEquipo(quien))) {
      return responder({ error: "Solo el equipo puede agendar." }, 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const accion = String(body.accion || "agendar");

    // Prueba de conexion: no crea nada. Sirve para saber si los secretos estan
    // bien antes de intentar agendar algo de verdad.
    if (accion === "ping") {
      const r = await ghl("/calendars/?locationId=" + encodeURIComponent(GHL_LOCATION));
      if (!r.ok) return responder({ error: "GHL " + r.status + ": " + r.crudo }, 502);
      const cals = ((r.datos && r.datos.calendars) || []).map((c: any) => ({
        id: c.id, nombre: c.name,
      }));
      return responder({ ok: true, location: GHL_LOCATION, calendarios: cals });
    }

    if (accion !== "agendar") {
      return responder({ error: "Accion desconocida: " + accion }, 400);
    }

    const email = String(body.email || "").trim().toLowerCase();
    const calendarId = String(body.calendarId || "").trim();
    const inicio = String(body.inicio || "").trim();      // ISO con zona
    const minutos = Math.max(5, Math.min(480, parseInt(body.minutos, 10) || 60));
    const titulo = String(body.titulo || "").trim();

    if (!email) return responder({ error: "Falta el mail del cliente." }, 400);
    if (!calendarId) return responder({ error: "Esa etapa no tiene calendario de GHL." }, 400);
    if (!inicio) return responder({ error: "Falta la fecha y hora." }, 400);
    const t0 = Date.parse(inicio);
    if (isNaN(t0)) return responder({ error: "La fecha no se entiende: " + inicio }, 400);

    const c = await buscarContacto(email);
    if ("error" in c) return responder({ error: c.error }, 404);

    const fin = new Date(t0 + minutos * 60000).toISOString();
    const r = await ghl("/calendars/events/appointments", {
      method: "POST",
      body: JSON.stringify({
        calendarId,
        locationId: GHL_LOCATION,
        contactId: c.id,
        startTime: new Date(t0).toISOString(),
        endTime: fin,
        title: titulo || "Reunion",
        appointmentStatus: "confirmed",
        // Que el cliente reciba lo que recibe siempre: invitacion, link y
        // recordatorios los arma GHL con la configuracion del calendario.
        ignoreFreeSlotValidation: false,
      }),
    });

    if (!r.ok) {
      // El texto de GHL va tal cual. Traducirlo a "no se pudo agendar" es lo
      // que hace imposible entender por que falla -paso hoy con otra API.
      return responder({ error: "GHL " + r.status + ": " + r.crudo }, 502);
    }
    const ev = (r.datos && (r.datos.event || r.datos.appointment || r.datos)) || {};
    return responder({
      ok: true,
      id: ev.id || "",
      inicio: ev.startTime || new Date(t0).toISOString(),
      fin: ev.endTime || fin,
      contacto: c.nombre || email,
    });
  } catch (e) {
    return responder({ error: String((e as Error).message || e) }, 500);
  }
});
