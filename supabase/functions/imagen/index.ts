// Generar imagenes en Higgsfield desde la app.
//
// Va aparte de la funcion de video que ya existe y no adentro: esa esta andando
// y su codigo no esta en el repo, asi que tocarla seria editar a ciegas algo
// que funciona. Dos funciones chicas se entienden mejor que una grande.
//
// La clave de Higgsfield vive SOLO aca. La app manda un secreto compartido, que
// no sirve para nada fuera de esta funcion: si se filtra, se cambia en dos
// lugares y listo, sin tocar la cuenta de Higgsfield.

const HF_KEY = Deno.env.get("HF_API_KEY") ?? "";
const HF_SECRET = Deno.env.get("HF_SECRET") ?? "";
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
      "Authorization": "Bearer " + HF_KEY,
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
  if (!HF_SECRET || url.searchParams.get("s") !== HF_SECRET) {
    return responder({ ok: false, error: "secreto invalido" }, 403);
  }
  if (!HF_KEY) return responder({ ok: false, error: "falta HF_API_KEY en la funcion" }, 500);

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
        // El cuerpo del error es lo unico que distingue "el modelo no existe"
        // de "tu cuenta no lo tiene" de "te quedaste sin creditos".
        return responder({
          ok: false,
          error: (r.d && (r.d.detail || r.d.message || r.d.error)) || ("HTTP " + r.status),
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
