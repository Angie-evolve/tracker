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

// Le pregunta a GHL los huecos del dia del horario que rechazo y los devuelve
// junto al que se mando. Con eso se ve de un vistazo si el nuestro esta en la
// lista -y entonces el problema es el formato o algo del lado de GHL- o si no
// esta -y entonces el hueco se ocupo de verdad.
async function diagnosticarHueco(calendarId: string, inicio: string) {
  try {
    const t = Date.parse(inicio);
    if (isNaN(t)) return { nota: "la fecha no se entiende" };
    const r = await ghl(
      "/calendars/" + encodeURIComponent(calendarId) + "/free-slots" +
      "?startDate=" + (t - 12 * 3600 * 1000) + "&endDate=" + (t + 12 * 3600 * 1000),
    );
    if (!r.ok) return { nota: "no pude releer los huecos: " + r.status };
    const slots: string[] = [];
    const juntar = (v: any) => {
      if (!v) return;
      if (Array.isArray(v)) { v.forEach((x) => typeof x === "string" && slots.push(x)); return; }
      if (typeof v === "object") Object.keys(v).forEach((k) => juntar(v[k]));
    };
    juntar(r.datos);
    // Dos comparaciones: la cadena exacta, y el instante. Si coincide el
    // instante pero no la cadena, lo que molesta es el formato.
    const exacto = slots.includes(inicio);
    const mismoInstante = slots.some((x) => Date.parse(x) === t);
    return {
      mandamos: inicio,
      huecos: slots.slice(0, 12),
      total: slots.length,
      coincide_exacto: exacto,
      coincide_el_instante: mismoInstante,
      lectura: exacto
        ? "el hueco sigue libre y lo mandamos igual: el rechazo es de GHL por otra cosa"
        : (mismoInstante
          ? "el instante esta libre pero la cadena no coincide: es el formato"
          : "ese horario ya no esta entre los libres: lo tomo alguien"),
    };
  } catch (e) {
    return { nota: String((e as Error).message || e) };
  }
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

    // Los horarios libres de un calendario para un dia. Los calcula GHL con la
    // disponibilidad configurada -horario de atencion, duracion del turno, lo
    // ya ocupado-, asi que es la misma verdad que ve el cliente en el widget.
    //
    // El rango se pide ancho a proposito y el filtrado por dia lo hace la app:
    // acotarlo aca obligaria a hacer cuentas de zona horaria del lado del
    // servidor, que es donde se cuelan los errores de un dia de corrimiento.
    if (accion === "huecos") {
      const calendarId = String(body.calendarId || "").trim();
      const dia = String(body.dia || "").trim();            // AAAA-MM-DD
      if (!calendarId) return responder({ error: "Esa etapa no tiene calendario de GHL." }, 400);
      const base = Date.parse(dia + "T00:00:00Z");
      if (isNaN(base)) return responder({ error: "El dia no se entiende: " + dia }, 400);
      const desde = base - 24 * 3600 * 1000;
      const hasta = base + 48 * 3600 * 1000;
      const r = await ghl(
        "/calendars/" + encodeURIComponent(calendarId) + "/free-slots" +
        "?startDate=" + desde + "&endDate=" + hasta,
      );
      if (!r.ok) return responder({ error: "GHL " + r.status + ": " + r.crudo }, 502);
      // GHL devuelve un objeto con una clave por dia y los turnos adentro. La
      // forma cambio entre versiones, asi que se juntan todos los que aparezcan
      // en vez de asumir una estructura.
      const slots: string[] = [];
      const juntar = (v: any) => {
        if (!v) return;
        if (Array.isArray(v)) { v.forEach((x) => typeof x === "string" && slots.push(x)); return; }
        if (typeof v === "object") Object.keys(v).forEach((k) => juntar(v[k]));
      };
      juntar(r.datos);
      return responder({ ok: true, slots: slots.slice(0, 400) });
    }

    // Mover una cita que ya existe. Va por el mismo camino que crearla porque
    // es la misma decision: si la etapa ya tiene reunion, cambiar la fecha es
    // reprogramar esa, no crear una segunda y dejar al cliente con dos
    // invitaciones para la misma cosa.
    if (accion === "reprogramar") {
      const id = String(body.eventId || "").trim();
      const inicio = String(body.inicio || "").trim();
      if (!id) return responder({ error: "Falta el id de la cita." }, 400);
      const t0 = Date.parse(inicio);
      if (isNaN(t0)) return responder({ error: "La fecha no se entiende: " + inicio }, 400);
      // Sin endTime: la duracion la define el calendario. Mandarla nuestra da
      // "Selected slot duration is not a valid duration option for this
      // calendar" -GHL solo acepta las duraciones que tiene configuradas.
      // Igual que al agendar: el horario va tal cual lo dio GHL. Reescribirlo
      // en UTC lo hace irreconocible para su propia validacion de huecos.
      const cuerpo: Record<string, unknown> = { startTime: inicio };
      if (body.minutos) {
        const m = Math.max(5, Math.min(480, parseInt(body.minutos, 10)));
        cuerpo.endTime = new Date(t0 + m * 60000).toISOString();
      }
      const r = await ghl("/calendars/events/appointments/" + encodeURIComponent(id), {
        method: "PUT",
        body: JSON.stringify(cuerpo),
      });
      if (!r.ok) {
        // Mismo tratamiento que al agendar. Faltaba aca, y aca es donde caen
        // los clientes que YA tenian una reunion: mover la del 16 al 23 pasa
        // por PUT, no por POST, asi que todo lo que se arreglo del otro lado no
        // llegaba a tocarse.
        if (/no longer available/i.test(r.crudo || "")) {
          const calId = String(body.calendarId || "").trim();
          const diag = calId
            ? await diagnosticarHueco(calId, inicio)
            : { lectura: "no puedo releer los huecos: falta el calendario en el pedido" };
          const d = diag as any;
          if (d && d.coincide_exacto) {
            const r2 = await ghl("/calendars/events/appointments/" + encodeURIComponent(id), {
              method: "PUT",
              body: JSON.stringify({ ...cuerpo, ignoreFreeSlotValidation: true }),
            });
            if (r2.ok) {
              const e2 = (r2.datos && (r2.datos.event || r2.datos.appointment || r2.datos)) || {};
              return responder({
                ok: true, id: e2.id || id,
                inicio: e2.startTime || inicio,
                fin: e2.endTime || "",
                nota: "GHL rechazo el horario que el mismo ofrecia; se movio igual.",
              });
            }
            return responder({
              error: "GHL " + r2.status + ": " + r2.crudo
                + " \u2014 el hueco seguia libre y tampoco entro sin validacion",
              diagnostico: diag,
            }, 502);
          }
          const resumen = d && d.lectura
            ? (" \u2014 " + d.lectura +
               (d.huecos && d.huecos.length
                 ? (" | mandamos " + d.mandamos +
                    " | GHL ofrece ahora: " + d.huecos.slice(0, 6).join(", ")) : ""))
            : "";
          return responder({
            error: "GHL " + r.status + ": " + r.crudo + resumen,
            diagnostico: diag,
          }, 502);
        }
        return responder({ error: "GHL " + r.status + ": " + r.crudo }, 502);
      }
      const ev = (r.datos && (r.datos.event || r.datos.appointment || r.datos)) || {};
      return responder({
        ok: true, id: ev.id || id,
        inicio: ev.startTime || new Date(t0).toISOString(),
        fin: ev.endTime || "",
      });
    }

    if (accion !== "agendar") {
      return responder({ error: "Accion desconocida: " + accion }, 400);
    }

    const email = String(body.email || "").trim().toLowerCase();
    const calendarId = String(body.calendarId || "").trim();
    const inicio = String(body.inicio || "").trim();      // ISO con zona
    const titulo = String(body.titulo || "").trim();

    if (!email) return responder({ error: "Falta el mail del cliente." }, 400);
    if (!calendarId) return responder({ error: "Esa etapa no tiene calendario de GHL." }, 400);
    if (!inicio) return responder({ error: "Falta la fecha y hora." }, 400);
    const t0 = Date.parse(inicio);
    if (isNaN(t0)) return responder({ error: "La fecha no se entiende: " + inicio }, 400);

    const c = await buscarContacto(email);
    if ("error" in c) return responder({ error: c.error }, 404);

    // Sin endTime a proposito: la duracion es la que tiene configurada el
    // calendario. Mandar una propia hace que GHL rechace con "Selected slot
    // duration is not a valid duration option for this calendar", y ademas
    // crearia reuniones de un largo que el cliente no espera.
    const nueva: Record<string, unknown> = {
      calendarId,
      locationId: GHL_LOCATION,
      contactId: c.id,
      // El horario va TAL CUAL lo mando la app, que a su vez es tal cual lo
      // devolvio free-slots. Aca se pasaba por new Date().toISOString(), que lo
      // reescribe en UTC: "2026-09-23T12:00:00-03:00" salia como
      // "2026-09-23T15:00:00.000Z". Con ignoreFreeSlotValidation en false, GHL
      // compara contra su propia lista de huecos y no lo reconoce, y contesta
      // "The slot you have selected is no longer available" sobre un horario
      // que el mismo acababa de ofrecer.
      //
      // Date.parse de arriba se sigue usando, pero solo para validar que la
      // fecha se entienda y para calcular endTime cuando viene minutos.
      startTime: inicio,
      title: titulo || "Reunion",
      appointmentStatus: "confirmed",
      // Que el cliente reciba lo que recibe siempre: invitacion, link y
      // recordatorios los arma GHL con la configuracion del calendario.
      ignoreFreeSlotValidation: false,
    };
    if (body.minutos) {
      const m = Math.max(5, Math.min(480, parseInt(body.minutos, 10)));
      nueva.endTime = new Date(t0 + m * 60000).toISOString();
    }
    const r = await ghl("/calendars/events/appointments", {
      method: "POST",
      body: JSON.stringify(nueva),
    });

    if (!r.ok) {
      // "The slot you have selected is no longer available" no dice nada por si
      // solo: el horario venia de la lista que GHL acababa de dar. Asi que
      // cuando pasa eso, se le vuelve a preguntar por los huecos de ese dia y
      // se compara, para saber de una vez si el problema es que el hueco se
      // ocupo, o que lo que mandamos no es lo que el espera.
      if (/no longer available/i.test(r.crudo || "")) {
        const diag = await diagnosticarHueco(calendarId, inicio);
        // Si el hueco SIGUE en la lista de GHL y aun asi lo rechazo, el que se
        // esta equivocando es su validacion, no nosotros. En ese caso -y solo
        // en ese- se reintenta pidiendole que no valide: ya validamos nosotros
        // contra su propia lista, un segundo antes, con su propia respuesta.
        //
        // Cuando el hueco NO esta en la lista se respeta el rechazo: ahi el
        // horario se ocupo de verdad y saltearse la validacion crearia una
        // reunion encima de otra.
        if (diag && (diag as any).coincide_exacto) {
          const r2 = await ghl("/calendars/events/appointments", {
            method: "POST",
            body: JSON.stringify({ ...nueva, ignoreFreeSlotValidation: true }),
          });
          if (r2.ok) {
            // La misma forma que la respuesta normal: quien llama no tiene
            // por que saber que hubo un reintento.
            const e2 = (r2.datos && (r2.datos.event || r2.datos.appointment || r2.datos)) || {};
            return responder({
              ok: true,
              id: e2.id || "",
              inicio: e2.startTime || inicio,
              fin: e2.endTime || "",
              contacto: c.nombre || email,
              nota: "GHL rechazo el horario que el mismo ofrecia; se creo igual.",
            });
          }
          return responder({
            error: "GHL " + r2.status + ": " + r2.crudo
              + " \u2014 el hueco seguia libre y tampoco entro sin validacion",
            diagnostico: diag,
          }, 502);
        }
        // El diagnostico va DENTRO del texto del error y no solo en un campo
        // aparte: el campo lo muestra la version nueva de la app, y el navegador
        // puede estar sirviendo la vieja de cache. En el texto lo ve cualquiera.
        const d = diag as any;
        const resumen = d && d.lectura
          ? (" \u2014 " + d.lectura +
             (d.huecos && d.huecos.length
               ? (" | mandamos " + d.mandamos +
                  " | GHL ofrece ahora: " + d.huecos.slice(0, 6).join(", ")) : ""))
          : "";
        return responder({
          error: "GHL " + r.status + ": " + r.crudo + resumen,
          diagnostico: diag,
        }, 502);
      }
      // El texto de GHL va tal cual. Traducirlo a "no se pudo agendar" es lo
      // que hace imposible entender por que falla -paso hoy con otra API.
      return responder({ error: "GHL " + r.status + ": " + r.crudo }, 502);
    }
    const ev = (r.datos && (r.datos.event || r.datos.appointment || r.datos)) || {};
    return responder({
      ok: true,
      id: ev.id || "",
      inicio: ev.startTime || new Date(t0).toISOString(),
      fin: ev.endTime || "",
      contacto: c.nombre || email,
    });
  } catch (e) {
    return responder({ error: String((e as Error).message || e) }, 500);
  }
});
