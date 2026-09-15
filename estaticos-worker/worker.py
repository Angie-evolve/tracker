#!/usr/bin/env python3
"""
worker.py - el puente entre la app y las dos herramientas que no viven en el
navegador.

El tracker se sirve publico desde GitHub Pages: cualquiera lee su codigo. Por
eso no puede llamar ni a Claude ni a Higgsfield, que necesitarian una clave a
la vista. Lo que hace en cambio es dejar un pedido en la tabla
estaticos_pedidos, y esto lo levanta desde la maquina de Angie, donde las dos
sesiones ya estan abiertas.

  claude -p       -> los angulos, el copy y los prompts. Gasta el PLAN de
                     Claude, no la API facturada por token.
  higgsfield      -> las imagenes. Gasta los creditos del plan de Higgsfield,
                     no la billetera separada de api.higgsfield.ai.

Las dos son las mismas sesiones que Angie usa a mano. Esa es toda la gracia:
no hay una credencial nueva en ningun lado.

  python3 worker.py            corre hasta que lo cortes
  python3 worker.py --una      procesa un pedido y sale
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

SB_URL = "https://onnysveksgxtmspxgbow.supabase.co"
LLAVERO = "evolve-claude-sbkey"
CADA = 10                 # segundos entre miradas a la cola
COLGADO_MIN = 20          # un pedido tomado hace mas de esto vuelve a la cola
MODELO_IMG = "nano_banana_2"
TOPE_CLAUDE_S = 600       # diez minutos: una tanda de ocho angulos es larga
TOPE_IMAGEN_S = 300


def _clave():
    """
    La clave sale del Llavero una sola vez, al arrancar, y se queda en memoria.

    En un archivo quedaria para siempre y en una variable de entorno la ve
    cualquier proceso. Leerla en cada vuelta abriria un dialogo del sistema cada
    diez segundos, que es peor que inutil: se termina apretando "permitir
    siempre" para sacarselo de encima.
    """
    r = subprocess.run(["security", "find-generic-password", "-s", LLAVERO, "-w"],
                       capture_output=True, text=True)
    k = (r.stdout or "").strip()
    if not k:
        sys.exit("No encontre la clave en el Llavero (%s). Guardala con:\n"
                 "  security add-generic-password -U -s %s -a \"$USER\" -w"
                 % (LLAVERO, LLAVERO))
    return k


CLAVE = None


def _rest(metodo, ruta, cuerpo=None, extra=None):
    cab = {"apikey": CLAVE, "Authorization": "Bearer " + CLAVE,
           "Content-Type": "application/json"}
    if extra:
        cab.update(extra)
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    pedido = urllib.request.Request(SB_URL + "/rest/v1/" + ruta, data=datos,
                                    headers=cab, method=metodo)
    try:
        with urllib.request.urlopen(pedido, timeout=60) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt.strip() else None
    except urllib.error.HTTPError as e:
        raise RuntimeError("%s %s -> %s %s" % (metodo, ruta, e.code,
                                               e.read().decode()[:300]))


def marcar(id_, **campos):
    _rest("PATCH", "estaticos_pedidos?id=eq." + id_, campos)


def reciclar():
    """
    Si el worker muere a mitad de camino, la fila queda en procesando para
    siempre y ese pedido no lo agarra nadie nunca mas. Se devuelven a la cola.
    """
    corte = time.strftime("%Y-%m-%dT%H:%M:%S",
                          time.gmtime(time.time() - COLGADO_MIN * 60))
    viejos = _rest("GET", "estaticos_pedidos?estado=eq.procesando"
                          "&tomado_at=lt.%s&select=id" % corte) or []
    for v in viejos:
        print("  reciclo", v["id"][:8], flush=True)
        marcar(v["id"], estado="pendiente", tomado_at=None)


def tomar():
    """
    Reclama un pedido. El filtro por estado va TAMBIEN en el PATCH: si hubiera
    dos workers, el segundo no encuentra nada que actualizar en vez de ponerse
    a trabajar sobre el mismo.
    """
    filas = _rest("GET", "estaticos_pedidos?estado=eq.pendiente"
                         "&order=creado_at.asc&limit=1&select=*") or []
    if not filas:
        return None
    f = filas[0]
    tomada = _rest("PATCH",
                   "estaticos_pedidos?id=eq.%s&estado=eq.pendiente" % f["id"],
                   {"estado": "procesando", "tomado_at": "now()"},
                   {"Prefer": "return=representation"})
    return f if tomada else None


def _json_de(texto):
    """
    Claude puede contestar con una frase antes, o envolver en markdown. Se
    busca el JSON adentro en vez de exigir que la respuesta sea solo el JSON.
    """
    a, b = texto.find("["), texto.rfind("]")
    if a < 0 or b < a:
        raise RuntimeError("la respuesta no trae un JSON: " + texto[:300])
    return json.loads(texto[a:b + 1])


def hacer_angulos(entrada):
    pedido = str(entrada.get("pedido") or "").strip()
    if not pedido:
        raise RuntimeError("el pedido vino sin texto")
    # El texto lo arma la app, no este archivo: si las reglas vivieran en los
    # dos lados, un dia cambiarian en uno solo.
    r = subprocess.run(["claude", "-p", "--output-format", "text"],
                       input=pedido, capture_output=True, text=True,
                       timeout=TOPE_CLAUDE_S, cwd="/tmp")
    if r.returncode != 0:
        raise RuntimeError("claude fallo: " + (r.stderr or "")[:300])
    datos = _json_de(r.stdout)
    if not datos:
        raise RuntimeError("Claude devolvio una lista vacia")
    return {"angulos": datos}


def hacer_imagenes(entrada):
    piezas = entrada.get("piezas") or []
    if not piezas:
        raise RuntimeError("no vino ninguna pieza")
    aspecto = str(entrada.get("aspecto") or "1:1")
    salida = []
    for p in piezas:
        i = p.get("i")
        prompt = str(p.get("prompt") or "").strip()
        if not prompt:
            salida.append({"i": i, "error": "sin prompt"})
            continue
        print("   imagen %s/%s" % (len(salida) + 1, len(piezas)), flush=True)
        r = subprocess.run(["higgsfield", "generate", "create", MODELO_IMG,
                            "--prompt", prompt, "--aspect_ratio", aspecto,
                            "--wait", "--wait-timeout", "4m", "--json"],
                           capture_output=True, text=True, timeout=TOPE_IMAGEN_S)
        if r.returncode != 0:
            # Una sola que falle no tira abajo la tanda: se anota y se sigue.
            # Casi siempre es la misma causa para todas -creditos- pero dejar
            # las anteriores hechas es mejor que perderlas.
            salida.append({"i": i, "error": (r.stderr or r.stdout or "")[:200]})
            continue
        try:
            d = json.loads(r.stdout)
            uno = d[0] if isinstance(d, list) else d
            url = uno.get("result_url") or uno.get("min_result_url") or ""
        except Exception:
            url = ""
        salida.append({"i": i, "url": url} if url
                      else {"i": i, "error": "sin url en la respuesta"})
    return {"piezas": salida}


def procesar(f):
    tipo = f.get("tipo")
    entrada = f.get("entrada") or {}
    if tipo == "angulos":
        return hacer_angulos(entrada)
    if tipo == "imagenes":
        return hacer_imagenes(entrada)
    raise RuntimeError("tipo desconocido: " + str(tipo))


def una_vuelta():
    reciclar()
    f = tomar()
    if not f:
        return False
    print("pedido %s  %s  de %s" % (f["id"][:8], f["tipo"], f.get("pedido_por")),
          flush=True)
    try:
        salida = procesar(f)
        marcar(f["id"], estado="listo", salida=salida, listo_at="now()")
        print("  listo", flush=True)
    except Exception as e:
        # El motivo va a la fila, no solo a la pantalla: quien pidio esto no
        # esta mirando esta terminal.
        print("  error:", e, flush=True)
        marcar(f["id"], estado="error", error=str(e)[:500], listo_at="now()")
    return True


def main():
    global CLAVE
    CLAVE = _clave()
    una = "--una" in sys.argv
    print("worker de estaticos en marcha. Ctrl+C para cortar.", flush=True)
    while True:
        try:
            hubo = una_vuelta()
        except Exception as e:
            print("no pude mirar la cola:", e, flush=True)
            hubo = False
        if una and hubo:
            return
        if not hubo:
            time.sleep(CADA)


if __name__ == "__main__":
    main()
