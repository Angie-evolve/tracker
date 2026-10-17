// ============================================================
//  Evolve OS · consulta — servidor MCP de SOLO LECTURA (17/10/2026)
//
//  Para que el Claude de cada persona del equipo (empezando por Santi) tenga
//  el mismo contexto que el de Angie: las llamadas de todos, con su
//  transcripcion, y en que anda cada cliente. Sin la clave maestra.
//
//  ⚠️  NO HAY NINGUNA HERRAMIENTA QUE ESCRIBA. Es a proposito, y es lo que lo
//  hace seguro: aunque a ese Claude le pidan "borra tal cosa", aca no existe
//  con que. Los cambios a la app siguen yendo por "Nueva tarea -> Evolve OS".
//
//  ⚠️  DE UN CLIENTE SALE SOLO UNA LISTA CERRADA DE CAMPOS. `datos` guarda
//  tokens de Meta, GHL y Google: se arma la respuesta campo por campo en vez
//  de sacar los peligrosos, para que un campo nuevo no salga solo.
//
//  Entrada: la clave de cada persona va en el link del conector
//    https://<proyecto>.supabase.co/functions/v1/evolve-mcp/<clave>
//  (claude.ai no deja agregar encabezados a un conector propio). Tambien
//  acepta "Authorization: Bearer <clave>" para Claude Code. Se compara el
//  sha256 contra `mcp_claves` (migracion 040) y se anota cada consulta en
//  `mcp_registro`.
//
//  Se despliega con "Verify JWT" APAGADO: quien llama es claude.ai, no una
//  sesion del tracker. La puerta es la clave.
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const JSONH = { "Content-Type": "application/json" };
const responder = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: JSONH });

async function sb(ruta: string, init: RequestInit = {}) {
  const r = await fetch(SB_URL + "/rest/v1/" + ruta, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const t = await r.text();
  let d: any = null;
  try { d = t ? JSON.parse(t) : null; } catch { /* sin cuerpo */ }
  if (!r.ok) throw new Error("base " + r.status + ": " + t.slice(0, 200));
  return d;
}

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Lo que se escribe en un filtro de PostgREST no puede traer los caracteres de
// su sintaxis: con una coma o un parentesis se podria armar otro filtro.
const limpio = (s: unknown) =>
  String(s ?? "").replace(/[^\p{L}\p{N} @._\-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
const fecha = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : "";

type Clave = { id: number; persona: string; alcance: any };

async function quienEs(req: Request): Promise<Clave | null> {
  const u = new URL(req.url);
  const seg = u.pathname.split("/").filter(Boolean);
  const i = seg.indexOf("evolve-mcp");
  let k = i >= 0 ? (seg[i + 1] || "") : "";
  if (!k) k = u.searchParams.get("k") || "";
  if (!k) k = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(k)) return null;
  const h = await sha256(k);
  const f = await sb("mcp_claves?select=id,persona,alcance&activa=eq.true&hash=eq." + h);
  return Array.isArray(f) && f[0] ? f[0] : null;
}

/* ── Clientes ─────────────────────────────────────────────────────────── */
async function filasClientes(campos: string, filtro = "") {
  return (await sb("clientes?select=id," + campos + "&order=id" + filtro)) || [];
}
// Los de la cartera de esa persona, si su alcance lo pide. null = todos.
async function idsCartera(c: Clave): Promise<Set<string> | null> {
  const a = c.alcance || {};
  if (a.clientes !== "cartera" && a.llamadas !== "cartera") return null;
  const mail = String(a.email || "").toLowerCase();
  const f = await filasClientes("o:datos->>owner");
  return new Set(f.filter((x: any) => String(x.o || "").toLowerCase() === mail).map((x: any) => String(x.id)));
}

function proximaCita(citas: any) {
  const ahora = Date.now();
  let mejor: any = null;
  for (const [etapa, x] of Object.entries(citas || {})) {
    const v: any = x;
    const t = Date.parse(v?.inicio || "");
    if (!isNaN(t) && t > ahora && (!mejor || t < mejor.t)) mejor = { t, etapa, inicio: v.inicio, con: v.deNuestroLado || "" };
  }
  return mejor ? { etapa: mejor.etapa, inicio: mejor.inicio, con: mejor.con } : null;
}

// La lista cerrada. Lo que no esta aca no sale, aunque exista en `datos`.
function fichaSegura(id: string, d: any, m: any) {
  d = d || {}; m = m || {};
  const citas: any[] = [];
  for (const [etapa, x] of Object.entries(d.citas || {})) {
    const v: any = x;
    citas.push({ etapa, inicio: v?.inicio || "", titulo: v?.titulo || "", con: v?.deNuestroLado || "", estado: v?.estado || "" });
  }
  const tareas = (Array.isArray(d.tasks) ? d.tasks : [])
    .filter((t: any) => t && !t.deleted && !t.archivada)
    .slice(0, 40)
    .map((t: any) => ({ texto: String(t.text || "").slice(0, 300), estado: t.estado || (t.done ? "finalizada" : "abierta"),
                         responsable: t.responsible || "", vence: t.due || "", ticket: t.ticket || "" }));
  const equipo = (Array.isArray(d.equipo) ? d.equipo : []).map((p: any) =>
    typeof p === "string" ? { nombre: p } : { nombre: p?.nombre || "", mail: p?.email || p?.mail || "" });
  const llamadas = (Array.isArray(d.fathomCalls) ? d.fathomCalls : []).slice(-15)
    .map((l: any) => ({ titulo: l?.title || "", fecha: l?.date || "", url: l?.url || "" }));
  const oferta = m.oferta || d.oferta;
  const rep = m.reporteCampana || d.reporteCampana;
  const cambios = ((m.cambiosPropuestos || {}).items || []).slice(0, 20)
    .map((x: any) => ({ texto: x?.texto || "", porque: x?.porque || "" }));
  return {
    id, nombre: d.name || "", responsable: d.owner || "", producto: d.producto || "",
    contacto: d.contacto || "", mail: d.email || "", telefono: d.phone || "",
    rubro: d.industry || "", web: d.web || "", alta: d.altaAt || "",
    archivado: !!d.archived, prospecto: !!d.prospecto,
    que_hace: d.queHace || d.que_hace || "", acordado: d.acordado || "",
    equipo, reuniones: citas, proxima_reunion: proximaCita(d.citas),
    etapas_agendadas: d.rutaAgenda || {}, etapas_hechas: d.rutaHechas || {},
    tareas, llamadas_cargadas: llamadas,
    oferta: oferta ? { estado: oferta.estado || "", texto: oferta.texto || "", link: oferta.url || "" } : null,
    reporte_campana: rep && rep.url ? rep.url : "",
    cambios_propuestos: cambios,
  };
}

async function listarClientes(c: Clave, a: any) {
  const cart = (c.alcance || {}).clientes === "cartera" ? await idsCartera(c) : null;
  const f = await filasClientes("n:datos->>name,o:datos->>owner,p:datos->>producto,ar:datos->>archived,pr:datos->>prospecto,al:datos->>altaAt,ci:datos->citas");
  const prod = limpio(a?.producto).toLowerCase();
  return f.filter((x: any) => {
    if (cart && !cart.has(String(x.id))) return false;
    if (!a?.incluir_archivados && x.ar === "true" && x.pr !== "true") return false;
    if (!a?.incluir_prospectos && x.pr === "true") return false;
    if (prod && String(x.p || "").toLowerCase().indexOf(prod) < 0) return false;
    return !!x.n;
  }).map((x: any) => ({ id: String(x.id), nombre: x.n, responsable: x.o || "", producto: x.p || "",
    prospecto: x.pr === "true", archivado: x.ar === "true", alta: x.al || "", proxima_reunion: proximaCita(x.ci) }));
}

// Sin tildes, sin mayusculas y sin letras dobles: "Red Zepellin" (asi quedo
// titulada una llamada) y "Red Zeppelin" (el cliente) tienen que encontrarse.
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9 ]/g, " ").replace(/(.)\1+/g, "$1").replace(/\s+/g, " ").trim();

async function buscarClienteIds(c: Clave, nombre: string) {
  const n = limpio(nombre);
  if (!n) return [];
  const cart = (c.alcance || {}).clientes === "cartera" ? await idsCartera(c) : null;
  const f = await filasClientes("n:datos->>name,ct:datos->>contacto");
  const q = norm(n);
  return f.filter((x: any) => {
    if (cart && !cart.has(String(x.id))) return false;
    if (String(x.id) === n) return true;
    const k = norm(x.n);
    return !!k && (k.includes(q) || q.includes(k));
  }).map((x: any) => ({ id: String(x.id), nombre: x.n, contacto: x.ct || "" }));
}

async function verCliente(c: Clave, a: any) {
  const ids = await buscarClienteIds(c, a?.cliente);
  if (!ids.length) return { error: "No encontré ningún cliente que se llame así (o no está en tu alcance)." };
  if (ids.length > 1 && !ids.some((x) => x.nombre.toLowerCase() === limpio(a?.cliente).toLowerCase()))
    return { varios: ids.slice(0, 15), nota: "Hay varios: pedí uno por su nombre completo o su id." };
  const elegido = ids.find((x) => x.nombre.toLowerCase() === limpio(a?.cliente).toLowerCase()) || ids[0];
  const f = await sb("clientes?select=id,datos,maquina&id=eq." + elegido.id);
  return f && f[0] ? fichaSegura(String(f[0].id), f[0].datos, f[0].maquina) : { error: "No pude leer ese cliente." };
}

/* ── Llamadas ─────────────────────────────────────────────────────────── */
async function nombresDe(ids: string[]) {
  const u = Array.from(new Set(ids.filter((x) => /^\d+$/.test(x))));
  if (!u.length) return {} as Record<string, string>;
  const f = await filasClientes("n:datos->>name", "&id=in.(" + u.join(",") + ")");
  const m: Record<string, string> = {};
  f.forEach((x: any) => { m[String(x.id)] = x.n || ""; });
  return m;
}

async function buscarLlamadas(c: Clave, a: any) {
  const lim = Math.max(1, Math.min(50, parseInt(a?.limite, 10) || 15));
  const COLS = "recording_id,titulo,fecha,duracion,grabo_nombre,url,resumen,cliente_id";
  // Filtros que valen para cualquier consulta. Cada grupo "o esto o aquello" va
  // dentro de un and=(), porque dos or= en la misma consulta se pisan.
  const grupos: string[] = [];
  const resto: string[] = [];
  if (a?.persona) { const p = limpio(a.persona); if (p) grupos.push("or(grabo_nombre.ilike.*" + p + "*,grabo_mail.ilike.*" + p + "*,transcripcion.ilike.*" + p + "*)"); }
  if (a?.texto) { const t = limpio(a.texto); if (t) grupos.push("or(titulo.ilike.*" + t + "*,resumen.ilike.*" + t + "*,transcripcion.ilike.*" + t + "*)"); }
  const d0 = fecha(a?.desde), d1 = fecha(a?.hasta);
  if (d0) resto.push("fecha=gte." + d0);
  if (d1) resto.push("fecha=lte." + d1 + "T23:59:59");
  const consulta = (extra: string[], limite: number) => {
    const g = grupos.concat(extra);
    let q = "llamadas_fathom?select=" + COLS + "&order=fecha.desc&limit=" + limite;
    if (g.length) q += "&and=" + encodeURIComponent("(" + g.join(",") + ")");
    if (resto.length) q += "&" + resto.join("&");
    return sb(q);
  };
  let f: any[] = [];
  if (a?.cliente) {
    const cl = await buscarClienteIds(c, a.cliente);
    // Por cliente asociado, y por titulo: muchas llamadas no quedaron asociadas
    // y el titulo puede estar mal escrito. Se trae ancho por un pedazo de la
    // palabra mas larga y se filtra aca con `norm`.
    const nombres = cl.length ? cl.map((x) => x.nombre) : [limpio(a.cliente)];
    const contactos = cl.map((x) => String(x.contacto || "").split(" ")[0]).filter((x) => x.length >= 4);
    const claves = nombres.map((n) => norm(n).split(" ").sort((p, q) => q.length - p.length)[0]).filter((x) => x && x.length >= 3);
    const porId = cl.length ? await consulta(["cliente_id.in.(" + cl.map((x) => x.id).join(",") + ")"], lim) : [];
    const anchos: any[] = [];
    for (const k of claves.concat(contactos.map(norm))) {
      const r = await consulta(["titulo.ilike.*" + limpio(k.slice(0, 3)) + "*"], 200);
      (r || []).forEach((x: any) => { if (norm(x.titulo).includes(k)) anchos.push(x); });
    }
    const vistos = new Set<string>();
    f = (porId || []).concat(anchos).filter((x: any) => {
      const id = String(x.recording_id); if (vistos.has(id)) return false; vistos.add(id); return true;
    }).sort((x: any, y: any) => String(y.fecha).localeCompare(String(x.fecha))).slice(0, lim);
  } else {
    f = (await consulta([], lim)) || [];
  }
  if ((c.alcance || {}).llamadas === "cartera") {
    const cart = await idsCartera(c);
    f = f.filter((x: any) => cart && cart.has(String(x.cliente_id)));
  }
  const nom = await nombresDe(f.map((x: any) => String(x.cliente_id || "")));
  return {
    llamadas: f.map((x: any) => ({
      id: String(x.recording_id), fecha: x.fecha, titulo: x.titulo, grabo: x.grabo_nombre || "",
      cliente: nom[String(x.cliente_id)] || "", duracion: x.duracion || "", link: x.url || "",
      resumen: String(x.resumen || "").slice(0, 400),
    })),
    nota: f.length ? "Para la transcripción completa usá leer_llamada con el id." : "No encontré llamadas con eso.",
  };
}

async function leerLlamada(c: Clave, a: any) {
  const id = String(a?.id || "").replace(/[^0-9A-Za-z_-]/g, "");
  if (!id) return { error: "Falta el id de la llamada (sale de buscar_llamadas)." };
  const f = await sb("llamadas_fathom?select=recording_id,titulo,fecha,duracion,grabo_nombre,url,resumen,transcripcion,action_items,participantes,cliente_id&recording_id=eq." + encodeURIComponent(id));
  const x = f && f[0];
  if (!x) return { error: "No existe esa llamada." };
  if ((c.alcance || {}).llamadas === "cartera") {
    const cart = await idsCartera(c);
    if (!cart || !cart.has(String(x.cliente_id))) return { error: "Esa llamada no está en tu alcance." };
  }
  const nom = await nombresDe([String(x.cliente_id || "")]);
  const tr = String(x.transcripcion || "");
  const desde = Math.max(0, parseInt(a?.desde, 10) || 0);
  const largo = Math.max(2000, Math.min(60000, parseInt(a?.largo, 10) || 40000));
  const trozo = tr.slice(desde, desde + largo);
  // Solo los nombres de los participantes, sin mails: para el contexto alcanzan.
  const pj = x.participantes;
  const part = Array.isArray(pj) ? pj.map((p: any) => String(p?.name || "")).filter(Boolean)
    : Array.from(String(pj || "").matchAll(/'name':\s*'([^']*)'/g)).map((m) => m[1]);
  return {
    id: String(x.recording_id), fecha: x.fecha, titulo: x.titulo, grabo: x.grabo_nombre || "",
    cliente: nom[String(x.cliente_id)] || "", duracion: x.duracion || "", link: x.url || "",
    participantes: part, resumen: x.resumen || "",
    pendientes: String(x.action_items || "").slice(0, 4000),
    transcripcion: trozo,
    transcripcion_total: tr.length,
    sigue: desde + largo < tr.length ? ("Hay más: pedí leer_llamada con desde=" + (desde + largo)) : "",
  };
}

/* ── MCP ──────────────────────────────────────────────────────────────── */
const HERRAMIENTAS = [
  { name: "buscar_llamadas",
    description: "Busca llamadas grabadas con Fathom del equipo de The Flowing Code (Angie, Joe, Martín, Santi y el resto), de la más nueva a la más vieja. Filtra por cliente, por quién participó o grabó, por una palabra que aparezca en el título, el resumen o la transcripción, y por fechas. Devuelve id, fecha, título, cliente, link y un resumen corto.",
    inputSchema: { type: "object", properties: {
      cliente: { type: "string", description: "Nombre del cliente, ej. «Red Zeppelin»" },
      persona: { type: "string", description: "Nombre o mail de alguien que estuvo en la llamada o la grabó" },
      texto: { type: "string", description: "Palabra o frase a buscar en título, resumen o transcripción" },
      desde: { type: "string", description: "AAAA-MM-DD" }, hasta: { type: "string", description: "AAAA-MM-DD" },
      limite: { type: "number", description: "Cuántas traer (1 a 50, 15 por defecto)" } } } },
  { name: "leer_llamada",
    description: "Trae una llamada completa por su id (el que devuelve buscar_llamadas): participantes, resumen, pendientes y la transcripción. Si la transcripción es larga viene en partes: usá «desde» para seguir.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id: { type: "string" }, desde: { type: "number", description: "Desde qué carácter de la transcripción (0 por defecto)" },
      largo: { type: "number", description: "Cuántos caracteres (hasta 60000, 40000 por defecto)" } } } },
  { name: "listar_clientes",
    description: "Lista los clientes de Evolve OS (el tracker de la agencia): nombre, responsable, producto y su próxima reunión. Por defecto sin archivados ni prospectos.",
    inputSchema: { type: "object", properties: {
      producto: { type: "string" }, incluir_archivados: { type: "boolean" }, incluir_prospectos: { type: "boolean" } } } },
  { name: "ver_cliente",
    description: "La ficha de un cliente: contacto, equipo, reuniones agendadas, etapas, tareas abiertas, llamadas cargadas, estado de la oferta, link al reporte de campaña y cambios propuestos. No incluye credenciales ni montos.",
    inputSchema: { type: "object", required: ["cliente"], properties: {
      cliente: { type: "string", description: "Nombre (o parte) o id del cliente" } } } },
];

async function correr(c: Clave, nombre: string, a: any) {
  if (nombre === "buscar_llamadas") return await buscarLlamadas(c, a);
  if (nombre === "leer_llamada") return await leerLlamada(c, a);
  if (nombre === "listar_clientes") return await listarClientes(c, a);
  if (nombre === "ver_cliente") return await verCliente(c, a);
  throw new Error("No existe la herramienta " + nombre);
}

async function anotar(c: Clave, herramienta: string, a: unknown) {
  try {
    await sb("mcp_registro", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ clave_id: c.id, persona: c.persona, herramienta, args: JSON.stringify(a || {}).slice(0, 1000) }) });
    await sb("mcp_claves?id=eq." + c.id, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ultima_at: new Date().toISOString() }) });
  } catch { /* el registro no frena la consulta */ }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Este conector solo atiende POST (MCP).", { status: 405, headers: { Allow: "POST" } });
  }
  const c = await quienEs(req).catch(() => null);
  if (!c) return responder({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Clave inválida o apagada." } }, 401);

  let m: any;
  try { m = await req.json(); } catch {
    return responder({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }, 400);
  }
  if (Array.isArray(m)) {
    return responder({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Mandá un mensaje por vez." } }, 400);
  }
  const id = m.id ?? null;
  const ok = (result: unknown) => responder({ jsonrpc: "2.0", id, result });

  // Una notificacion no lleva respuesta.
  if (m.id === undefined || String(m.method || "").startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  if (m.method === "initialize") {
    return ok({
      protocolVersion: (m.params && m.params.protocolVersion) || "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "evolve-os-consulta", version: "1.0.0" },
      instructions: "Consulta de solo lectura de Evolve OS, el tracker de The Flowing Code: llamadas grabadas del equipo con su transcripción, y la ficha de cada cliente. Para una llamada: primero buscar_llamadas, después leer_llamada con el id.",
    });
  }
  if (m.method === "ping") return ok({});
  if (m.method === "tools/list") return ok({ tools: HERRAMIENTAS });
  if (m.method === "tools/call") {
    const nombre = String(m.params?.name || "");
    const a = m.params?.arguments || {};
    try {
      const r = await correr(c, nombre, a);
      await anotar(c, nombre, a);
      return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 1) }] });
    } catch (e) {
      return ok({ content: [{ type: "text", text: "No se pudo: " + String((e as Error)?.message || e) }], isError: true });
    }
  }
  return responder({ jsonrpc: "2.0", id, error: { code: -32601, message: "Método no soportado: " + m.method } });
});
