// Invitar gente al equipo y sacarla.
//
// Esto vive en una edge function y no en la app por una sola razon: para crear
// una cuenta o mandar una invitacion hace falta la service_role key, y esa
// clave abre la base entera salteandose el RLS. En el navegador quedaria a la
// vista de cualquiera que abra el codigo fuente, y el repo ademas es publico.
// Aca la clave la pone Supabase como variable de entorno y nunca sale.
//
// Quien llama tiene que ser del equipo. No alcanza con estar logueado: eso lo
// esta cualquiera que se haya hecho una cuenta.

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// La app corre en GitHub Pages y en localhost, asi que el origen varia.
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
  try { d = txt ? JSON.parse(txt) : null; } catch { /* respuesta sin cuerpo */ }
  if (!r.ok) {
    throw new Error(
      (d && (d.msg || d.message || d.error_description || d.error)) || "HTTP " + r.status,
    );
  }
  return d;
}

// El mail de quien llama sale del token que valida Supabase, nunca del cuerpo
// del pedido: si viniera del cuerpo, cualquiera diria ser quien quiera.
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

// Se recorre la lista en vez de usar el filtro del endpoint porque ese filtro
// cambio entre versiones de GoTrue y aca hay cinco usuarios, no cinco mil.
async function buscarUsuario(email: string): Promise<any | null> {
  for (let pagina = 1; pagina <= 10; pagina++) {
    const d = await admin(`/auth/v1/admin/users?page=${pagina}&per_page=200`);
    const lista = (d && d.users) || [];
    const hit = lista.find((u: any) => String(u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (lista.length < 200) return null;
  }
  return null;
}

// Un ano largo. Se prefiere banear antes que borrar: sacarle el acceso a
// alguien no deberia destruir lo que hizo, y volver atras es una linea.
const BAN = "876000h";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const quien = await quienLlama(req);
    if (!quien) return responder({ error: "Hay que iniciar sesion." }, 401);
    if (!(await esDelEquipo(quien))) {
      return responder({ error: "Solo quien ya esta en el equipo puede invitar." }, 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const accion = String(body.accion || "");
    const mail = String(body.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
      return responder({ error: "Ese mail no parece un mail." }, 400);
    }

    if (accion === "invitar") {
      const ya = await buscarUsuario(mail);
      let aviso = "";
      if (ya) {
        // Ya tiene cuenta: no se le manda una invitacion que no puede usar, se
        // le levanta el ban si lo tenia y listo.
        await admin("/auth/v1/admin/users/" + ya.id, {
          method: "PUT",
          body: JSON.stringify({ ban_duration: "none" }),
        });
        aviso = "Ya tenia cuenta: le devolvimos el acceso sin mandarle nada.";
      } else {
        await admin("/auth/v1/invite", {
          method: "POST",
          body: JSON.stringify({ email: mail, data: { invitado_por: quien } }),
        });
        aviso = "Le llego un mail para elegir su contrasena.";
      }
      // El alta en la lista va ultima: si la invitacion falla, no queremos
      // haber abierto el acceso igual.
      await admin("/rest/v1/equipo_video", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({ email: mail }),
      });
      return responder({ ok: true, email: mail, aviso });
    }

    if (accion === "sacar") {
      if (mail === quien) return responder({ error: "No te podes sacar a vos misma." }, 400);
      // Las dos cosas hacen falta. Sacarla de la lista le tapa los datos del
      // equipo, pero la cuenta sigue viva y puede seguir encolando trabajos
      // que procesa el worker. El ban le cierra la puerta.
      await admin("/rest/v1/equipo_video?email=eq." + encodeURIComponent(mail), {
        method: "DELETE",
      });
      const u = await buscarUsuario(mail);
      if (u) {
        await admin("/auth/v1/admin/users/" + u.id, {
          method: "PUT",
          body: JSON.stringify({ ban_duration: BAN }),
        });
      }
      return responder({ ok: true, email: mail });
    }

    return responder({ error: "Accion desconocida." }, 400);
  } catch (e) {
    return responder({ error: String((e as Error).message || e) }, 500);
  }
});
