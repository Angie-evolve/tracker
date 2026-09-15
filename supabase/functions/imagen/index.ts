// Generar imagenes en Higgsfield desde la app.
//
// Va aparte de la funcion de video que ya existe y no adentro: esa esta andando
// y su codigo no esta en el repo, asi que tocarla seria editar a ciegas algo
// que funciona. Dos funciones chicas se entienden mejor que una grande.
//
// La clave de Higgsfield vive SOLO aca. La app manda un secreto compartido, que
// no sirve para nada fuera de esta funcion: si se filtra, se cambia en dos
// lugares y listo, sin tocar la cuenta de Higgsfield.

// Los tres ya existen en el proyecto, puestos para la funcion de video. Los
// nombres son los de ella, no unos nuevos: dos secrets con la misma clave
// adentro es garantia de que un dia se cambie uno solo.
//
// Higgsfield pide DOS credenciales, no una: clave y secreto. HF_SECRETO es otra
// cosa -el secreto compartido con la app-, y se nota porque comparte digest con
// FATHOM_SECRETO y GHL_SECRETO: es la convencion de todas las funciones de acá.
const HF_KEY = Deno.env.get("HF_KEY") ?? "";
const HF_SECRET = Deno.env.get("HF_SECRET") ?? "";
const APP_SECRETO = Deno.env.get("HF_SECRETO") ?? Deno.env.get("HF_SECRET") ?? "";
const HF_BASE = "https://platform.higgsfield.ai/v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function responder(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function hf(ruta: string, init: RequestInit = {}) {
  const r = await fetch(HF_BASE + ruta, {
    ...init,
    headers: {
      "hf-api-key": HF_KEY,
      "hf-secret": HF_SECRET,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const txt = await r.text();
  let d: any = null;
  try { d = txt ? JSON.parse(txt) : null; } catch { /* respuesta sin cuerpo */ }
  return { ok: r.ok, status: r.status, d, txt };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  // El secreto va en la query y no en un header porque asi lo manda ya el
  // resto de la app; cambiar el contrato obligaria a tocar las dos puntas.
  if (!APP_SECRETO || url.searchParams.get("s") !== APP_SECRETO) {
    return responder({ ok: false, error: "secreto invalido" }, 403);
  }
  if (!HF_KEY || !HF_SECRET) {
    return responder({ ok: false, error: "faltan HF_KEY o HF_SECRET en el proyecto" }, 500);
  }

  const accion = url.searchParams.get("accion") || "";
  const body = await req.json().catch(() => ({} as any));

  try {
    if (accion === "imagen") {
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return responder({ ok: false, error: "sin prompt" }, 400);
      const r = await hf("/image/generate", {
        method: "POST",
        body: JSON.stringify({
          model: String(body.modelo || "recraft_v4_1"),
          prompt,
          aspect_ratio: String(body.aspecto || "1:1"),
          count: 1,
        }),
      });
      if (!r.ok) {
        // El cuerpo crudo y el status, sin interpretar: un 404 puede ser que el
        // modelo no exista, que la cuenta no lo tenga, o que la ruta que se
        // pidio este mal. Decidir cual desde aca es adivinar, y adivinar mal
        // manda a buscar el problema al lado equivocado.
        return responder({
          ok: false,
          status: r.status,
          ruta: "/image/generate",
          error: (r.d && (r.d.detail || r.d.message || r.d.error)) || ("HTTP " + r.status),
          crudo: String(r.txt || "").slice(0, 400),
        });
      }
      const id = r.d?.id || r.d?.job_id || r.d?.request_id;
      if (!id) return responder({ ok: false, error: "Higgsfield no devolvio un id" });
      return responder({ ok: true, id });
    }

    if (accion === "estado") {
      const id = String(body.id || "").trim();
      if (!id) return responder({ ok: false, error: "sin id" }, 400);
      const r = await hf("/jobs/" + encodeURIComponent(id));
      if (!r.ok) {
        return responder({
          ok: false,
          error: (r.d && (r.d.detail || r.d.message)) || ("HTTP " + r.status),
        });
      }
      const estado = String(r.d?.status || r.d?.state || "").toLowerCase();
      const termino = ["completed", "succeeded", "failed", "canceled", "cancelled", "error"]
        .includes(estado);
      // La url sale de varios lugares segun el modelo: se busca en los
      // conocidos en vez de asumir uno solo y devolver vacio.
      const url2 = r.d?.results?.[0]?.url || r.d?.output?.[0]?.url
        || r.d?.results?.raw?.url || r.d?.url || "";
      return responder({
        ok: true, termino,
        estado: estado === "succeeded" ? "completed" : estado,
        url: url2,
        motivo: r.d?.error || r.d?.failure_reason || "",
      });
    }

    return responder({ ok: false, error: "accion desconocida" }, 400);
  } catch (e) {
    return responder({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
