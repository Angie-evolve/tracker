#!/usr/bin/env python3
"""
subir_tanda.py - de una carpeta del cliente a la cola, en un paso.

El cliente manda lo que le sale: un video largo con todo adentro, o varios
cortos, o mezclado, y los guiones en un documento aparte. Esto agarra la carpeta
entera, comprime los videos para que entren en el bucket, los sube, separa los
guiones y deja UN trabajo con todo junto. El reparto lo hace el worker.

Comprime aca y no en el navegador porque ffmpeg va mucho mas rapido que grabar
la pantalla en tiempo real, y porque una carpeta de cinco videos deja Chrome
trabado una hora.

La key sale del Llavero. No se pide, no se escribe, no se muestra.
"""
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import guion as Guion  # noqa: E402

SB_URL = "https://onnysveksgxtmspxgbow.supabase.co"
BUCKET = "videos"
LIMITE_MB = 50
VIDEOS = (".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm")
TEXTOS = (".txt", ".md", ".markdown", ".rtf", ".docx", ".pdf")


def key():
    r = subprocess.run(["security", "find-generic-password",
                        "-s", "evolve-claude-sbkey", "-w"],
                       capture_output=True, text=True)
    k = r.stdout.strip()
    if not k:
        salir("No hay key guardada en el Llavero (evolve-claude-sbkey).")
    return k


def cab(k, extra=None):
    h = {"apikey": k}
    if not k.startswith("sb_"):
        h["Authorization"] = "Bearer " + k
    h.update(extra or {})
    return h


def pedir(metodo, url, k, datos=None, tipo="application/json", extra=None):
    cuerpo = datos
    if isinstance(datos, (dict, list)):
        cuerpo = json.dumps(datos).encode()
    req = urllib.request.Request(url, data=cuerpo, method=metodo,
                                 headers=cab(k, {"Content-Type": tipo, **(extra or {})}))
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            t = r.read().decode() or "null"
            return json.loads(t) if t.strip().startswith(("{", "[")) else t
    except urllib.error.HTTPError as e:
        salir("%s %s -> %s\n%s" % (metodo, url.split("?")[0], e.code,
                                   e.read().decode()[:300]))


def salir(msg):
    print("\n  " + msg + "\n")
    sys.exit(1)


def decir(msg):
    print("  " + msg, flush=True)


# ------------------------------------------------------------- guiones ----

def leer_texto(ruta):
    n = ruta.lower()
    if n.endswith(".docx"):
        import zipfile
        with zipfile.ZipFile(ruta) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        t = re.sub(r"</w:p>", "\n\n", xml)
        t = re.sub(r"<[^>]+>", "", t)
        return (t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    if n.endswith(".pdf"):
        try:
            from pypdf import PdfReader
        except ImportError:
            salir("Falta pypdf para leer PDF. Corré: pip3 install pypdf")
        # layout y no el default: un PDF exportado de Google Docs sale con una
        # palabra por renglon, y asi cada palabra se vuelve un bloque del guion.
        return "\n".join((p.extract_text(extraction_mode="layout") or "")
                         for p in PdfReader(ruta).pages)
    with open(ruta, encoding="utf-8", errors="replace") as f:
        return f.read()


# -------------------------------------------------------------- videos ----

def duracion(v):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", v],
                         capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def comprimir(entrada, salida):
    """
    Al tamano que entra en el bucket. Se escala por el lado largo a 1280: un
    vertical de 1080 de ancho no se achicaba mirando solo el ancho, y ese es el
    formato de casi todo lo que llega.
    """
    dur = duracion(entrada)
    if dur <= 0:
        return None
    kb = int((LIMITE_MB * 0.90 * 8 * 1024) / dur) - 96
    if kb < 250:
        return "muy_largo"
    subprocess.run(
        ["ffmpeg", "-y", "-i", entrada,
         "-vf", "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,"
                "scale=trunc(iw/2)*2:trunc(ih/2)*2",
         "-c:v", "libx264", "-preset", "veryfast",
         "-b:v", "%dk" % kb, "-maxrate", "%dk" % int(kb * 1.35), "-bufsize", "%dk" % (kb * 2),
         "-c:a", "aac", "-b:a", "96k",
         salida, "-loglevel", "error"], check=True)
    return salida


def slug(t):
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^A-Za-z0-9._-]+", "-", t).strip("-")[:60] or "video"


# ---------------------------------------------------------------- main ----

def main():
    carpeta = sys.argv[1] if len(sys.argv) > 1 else ""
    if not carpeta or not os.path.isdir(carpeta):
        salir("Eso no es una carpeta.")
    if subprocess.run(["which", "ffmpeg"], capture_output=True).returncode:
        salir("Falta ffmpeg. Instalalo con: brew install ffmpeg")

    k = key()

    archivos = sorted(os.listdir(carpeta))
    vids = [os.path.join(carpeta, a) for a in archivos
            if a.lower().endswith(VIDEOS) and not a.startswith(".")]
    txts = [os.path.join(carpeta, a) for a in archivos
            if a.lower().endswith(TEXTOS) and not a.startswith(".")]
    if not vids:
        salir("No encontre ningun video en esa carpeta.")

    # --- guiones ---
    guiones = []
    for t in txts:
        for g in Guion.separar(leer_texto(t)):
            guiones.append(g)
    print()
    decir("%d video%s, %d guion%s" % (len(vids), "" if len(vids) == 1 else "s",
                                      len(guiones), "" if len(guiones) == 1 else "es"))
    for g in guiones:
        decir("   guion: " + g["titulo"][:64])
    if not guiones:
        decir("   (sin guiones: va a editar cada video entero)")

    # Se muestra antes de trabajar: si los guiones salieron mal separados, es
    # ahora cuando conviene enterarse y no despues de veinte minutos.
    print()
    if input("  Sigo? [enter para si, cualquier cosa para cortar] ").strip():
        salir("Cortado.")

    # --- de quien es esto ---
    filas = pedir("GET", SB_URL + "/rest/v1/trabajos_video?select=usuario_id&limit=1", k)
    if not filas:
        salir("Subi un video desde el tracker primero, una sola vez, para que "
              "sepa a que usuario asociar la tanda.")
    uid = filas[0]["usuario_id"]

    # --- comprimir y subir ---
    import tempfile
    import time
    sello = str(int(time.time()))
    rutas = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, v in enumerate(vids):
            nombre = os.path.basename(v)
            mb = os.path.getsize(v) / 1048576.0
            decir("[%d/%d] %s (%.0f MB)" % (i + 1, len(vids), nombre[:44], mb))
            destino = os.path.join(tmp, "c%02d.mp4" % i)
            r = comprimir(v, destino)
            if r == "muy_largo":
                decir("      dura demasiado para entrar en %d MB. Salteado." % LIMITE_MB)
                continue
            if not r:
                decir("      no pude leerlo. Salteado.")
                continue
            decir("      comprimido a %.0f MB, subiendo" % (os.path.getsize(destino) / 1048576.0))
            path = "%s/%s-%02d-%s.mp4" % (uid, sello, i, slug(os.path.splitext(nombre)[0]))
            with open(destino, "rb") as f:
                pedir("POST", "%s/storage/v1/object/%s/%s" % (SB_URL, BUCKET, path), k,
                      datos=f.read(), tipo="video/mp4", extra={"x-upsert": "true"})
            rutas.append(path)

    if not rutas:
        salir("No se subio ningun video.")

    fila = pedir("POST", SB_URL + "/rest/v1/trabajos_video", k, datos={
        "usuario_id": uid, "video_path": rutas[0], "videos": rutas,
        "guiones": guiones, "modo": "render",
        "opciones": {"formato": "B2B prolijo", "umbral_db": -32, "min_silencio": 0.35,
                     "aire": 0.05, "clip_min": 0.3, "tomas_repetidas": True,
                     "repetidas_min": 6,
                     "presentacion": {"tipo": "punch_ins", "cadencia": 1.8, "zoom": 1.12},
                     "subtitulo": {"palabras": 5, "tam": 26, "pos": "abajo",
                                   "mayusculas": False, "margen": 60, "borde": 2}},
    }, extra={"Prefer": "return=representation"})

    print()
    decir("Listo: %d video%s en cola." % (len(rutas), "" if len(rutas) == 1 else "s"))
    decir("Segui el avance en el tracker, en Editor con IA.")
    print()


if __name__ == "__main__":
    main()
