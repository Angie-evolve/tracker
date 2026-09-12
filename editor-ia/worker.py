#!/usr/bin/env python3
"""
worker.py - la unica pieza que corre fuera del navegador.

Mira la tabla trabajos_video, agarra el que este pendiente, lo procesa con
auto_editor.py y transcribe.py, sube el resultado al bucket y marca la fila.

Variables de entorno (ninguna va nunca al frontend):
    SUPABASE_URL                 https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY    Settings > API > service_role (secreta)
    WHISPER_MODELO               opcional, default 'small'
    INTERVALO                    opcional, segundos entre vueltas (default 8)
"""
import os, sys, time, json, argparse, tempfile, subprocess, traceback
import requests

import auto_editor
import transcribe

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY    = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
MODELO = os.environ.get("WHISPER_MODELO", "small")
CADA   = int(os.environ.get("INTERVALO", "8"))
BUCKET = "videos"

# Las keys nuevas (sb_secret_...) no son JWT: mandarlas tambien en
# Authorization: Bearer hace que Supabase rechace todo con 401.
H = {"apikey": KEY}
if not KEY.startswith("sb_"):
    H["Authorization"] = f"Bearer {KEY}"


# ---------------------------------------------------------------- tabla ----

def _rest(metodo, ruta, extra=None, **kw):
    cab = {**H, "Content-Type": "application/json"}
    if extra:
        cab.update(extra)
    r = requests.request(metodo, f"{SB_URL}/rest/v1/{ruta}",
                         headers=cab, timeout=60, **kw)
    r.raise_for_status()
    return r.json() if r.text else None


def hay_pendiente():
    """
    Solo mira si hay algo, no lo reclama. Es lo que corre el primer step del
    workflow: si contesta que no, la corrida termina ahi y no se instala nada.
    """
    return bool(_rest("GET", "trabajos_video?estado=eq.pendiente&limit=1&select=id"))


def tomar_pendiente():
    """
    Reclama un trabajo. El filtro estado=eq.pendiente va tambien en el PATCH a
    proposito: si algun dia corren dos workers, el segundo recibe una lista
    vacia en vez de pisar el trabajo del primero.
    """
    filas = _rest("GET", "trabajos_video"
                  "?estado=eq.pendiente&order=creado_at.asc&limit=1&select=*")
    if not filas:
        return None
    fila = filas[0]
    tomadas = _rest("PATCH",
                    f"trabajos_video?id=eq.{fila['id']}&estado=eq.pendiente",
                    extra={"Prefer": "return=representation"},
                    json={"estado": "procesando", "tomado_at": _ahora()})
    return tomadas[0] if tomadas else None


def marcar(id_, **campos):
    _rest("PATCH", f"trabajos_video?id=eq.{id_}", json=campos)


def _ahora():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


# -------------------------------------------------------------- storage ----

def bajar(path, destino):
    r = requests.get(f"{SB_URL}/storage/v1/object/{BUCKET}/{path}",
                     headers=H, timeout=600, stream=True)
    r.raise_for_status()
    with open(destino, "wb") as f:
        for trozo in r.iter_content(1024 * 256):
            f.write(trozo)
    return destino


def subir(local, path, tipo="application/octet-stream"):
    with open(local, "rb") as f:
        r = requests.post(f"{SB_URL}/storage/v1/object/{BUCKET}/{path}",
                          headers={**H, "Content-Type": tipo, "x-upsert": "true"},
                          data=f, timeout=600)
    r.raise_for_status()
    return path


# ------------------------------------------------------------ el trabajo ----

def transcribir(video, tmp, out_srt):
    """
    transcribir_video() deja audio_16k.wav en el CWD del proceso. Se llaman los
    tres pasos por separado para que lo temporal quede en la carpeta del
    trabajo y se borre con ella.
    """
    wav = transcribe.extraer_audio(video, os.path.join(tmp, "audio_16k.wav"))
    palabras = transcribe.transcribir_local(wav, modelo=MODELO)
    return transcribe.palabras_a_srt(palabras, out_srt=out_srt)


_FILTROS = None

def hay_filtro(nombre):
    """
    El filtro 'subtitles' lo aporta libass. Hay builds de ffmpeg compiladas sin
    el (por ejemplo la de Homebrew en Mac), y ahi el error que tira es
    "No such filter", que no ayuda en nada a entender que falta.
    """
    global _FILTROS
    if _FILTROS is None:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                           capture_output=True, text=True)
        _FILTROS = r.stdout
    return f" {nombre} " in _FILTROS


def quemar_subtitulos(video, srt, salida):
    """
    Los subtitulos van pegados en la imagen. El filtro se corre con cwd en la
    carpeta del srt: el nombre del archivo entra crudo en el string del filtro
    y cualquier ':' o espacio del path lo rompe.
    """
    if not hay_filtro("subtitles"):
        raise RuntimeError(
            "este ffmpeg no trae el filtro 'subtitles' (le falta libass), "
            "asi que no puedo quemar los subtitulos. En Debian/Ubuntu se "
            "resuelve con: apt-get install -y ffmpeg")
    # Solo el srt entra crudo en el string del filtro, asi que ese es el unico
    # que va relativo; la entrada y la salida van con path completo.
    subprocess.run(
        ["ffmpeg", "-y", "-i", os.path.abspath(video),
         "-vf", f"subtitles={os.path.basename(srt)}",
         "-c:a", "copy", os.path.abspath(salida), "-loglevel", "error"],
        cwd=os.path.dirname(os.path.abspath(srt)), check=True)
    return salida


def procesar(fila, tmp):
    carpeta = fila["video_path"].split("/")[0]        # el uuid del usuario
    base    = os.path.join(tmp, "fuente.mp4")
    bajar(fila["video_path"], base)

    # Las perillas de la pantalla. Si el trabajo es viejo o vino sin opciones,
    # se usan los mismos defaults que tiene auto_editor por su cuenta.
    op        = fila.get("opciones") or {}
    dur       = auto_editor.ffprobe_duration(base)
    silencios = auto_editor.detectar_silencios(
                    base,
                    umbral_db=float(op.get("umbral_db", -30)),
                    min_silencio=float(op.get("min_silencio", 0.6)))
    clips     = auto_editor.armar_cortes(dur, silencios)
    final_s   = auto_editor.duracion_total(clips)

    # Se guarda apenas se calcula: la pantalla puede mostrar los numeros reales
    # mientras todavia falta la parte lenta, que es Whisper.
    marcar(fila["id"], analisis={
        "duracion": round(dur, 2),
        "silencios": [{"inicio": round(a, 2), "fin": round(b, 2)} for a, b in silencios],
        "clips": [{"inicio": a, "fin": b} for a, b in clips],
        "duracion_final": final_s,
        "ahorro_pct": round(100 * (dur - final_s) / dur) if dur else 0,
    })

    sello = str(int(time.time()))

    if fila["modo"] == "render":
        cortado = os.path.join(tmp, "cortado.mp4")
        auto_editor.render_final(base, clips, cortado)
        # Se transcribe el video YA CORTADO: los tiempos del srt tienen que
        # coincidir con el video que se entrega, no con el crudo.
        srt = transcribir(cortado, tmp, os.path.join(tmp, "subs.srt"))
        listo = os.path.join(tmp, "final.mp4")
        quemar_subtitulos(cortado, srt, listo)
        p_video = subir(listo, f"{carpeta}/{sello}_final.mp4", "video/mp4")
        p_srt   = subir(srt,   f"{carpeta}/{sello}_final.srt", "text/plain")
    else:
        # En CapCut se importa el video CRUDO y se le aplica el plan, asi que
        # el srt tiene que estar en la linea de tiempo del crudo.
        srt = transcribir(base, tmp, os.path.join(tmp, "subs.srt"))
        plan = os.path.join(tmp, "plan_de_corte.json")
        with open(srt, encoding="utf-8") as f:
            texto_srt = f.read()
        auto_editor.exportar_capcut(clips, plan, os.path.join(tmp, "plan.srt"),
                                    fuente_srt=texto_srt)
        p_video = subir(plan, f"{carpeta}/{sello}_plan.json", "application/json")
        p_srt   = subir(os.path.join(tmp, "plan.srt"), f"{carpeta}/{sello}_plan.srt",
                        "text/plain")

    marcar(fila["id"], estado="listo", listo_at=_ahora(),
           resultado_path=p_video, resultado_srt_path=p_srt)


def una_vuelta():
    """Procesa como mucho un trabajo. Devuelve si hizo algo."""
    fila = tomar_pendiente()
    if not fila:
        return False
    print(f"-> {fila['id']} modo={fila['modo']}", flush=True)
    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            procesar(fila, tmp)
            print(f"listo {fila['id']} en {int(time.time()-t0)}s", flush=True)
        except Exception as e:
            traceback.print_exc()
            # El detalle completo va al log; en la fila queda el mensaje, que es
            # lo que ve quien subio el video.
            try:
                marcar(fila["id"], estado="error", listo_at=_ahora(),
                       error=f"{type(e).__name__}: {e}"[:500])
            except Exception:
                pass
    return True


def avisar_libass():
    # Se avisa al arrancar y no cuando falla el primer render: asi el problema
    # aparece arriba del log y no despues de que alguien espero media hora.
    if not hay_filtro("subtitles"):
        print("AVISO: este ffmpeg no tiene libass. El modo 'render' va a fallar "
              "al quemar los subtitulos; el modo 'capcut' anda igual.", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Worker del Editor con IA.")
    ap.add_argument("--una-pasada", action="store_true",
                    help="procesa como mucho un trabajo y termina. Es lo que usa "
                         "GitHub Actions, donde el cron hace de loop.")
    args = ap.parse_args()

    if args.una_pasada:
        avisar_libass()
        if not una_vuelta():
            print("sin trabajos pendientes", flush=True)
        return

    print(f"Worker andando contra {SB_URL} (modelo Whisper: {MODELO})", flush=True)
    avisar_libass()
    while True:
        try:
            if not una_vuelta():
                time.sleep(CADA)
        except Exception as e:
            print("no pude leer la cola:", e, flush=True)
            time.sleep(CADA)


if __name__ == "__main__":
    main()
