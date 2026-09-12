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
import decisiones as D
import guion as Guion

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

def transcribir(video, tmp):
    """
    Devuelve las palabras con sus tiempos, no un .srt: sobre eso se deciden los
    cortes, y el .srt se arma despues.

    transcribir_video() ademas deja audio_16k.wav en el CWD del proceso, asi que
    se llaman los pasos por separado para que lo temporal quede en la carpeta
    del trabajo y se borre con ella.
    """
    wav = transcribe.extraer_audio(video, os.path.join(tmp, "audio_16k.wav"))
    return transcribe.transcribir_local(wav, modelo=MODELO)


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


def _dims(video):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", video],
        capture_output=True, text=True, check=True).stdout.strip()
    w, h = out.split("x")[:2]
    return int(w), int(h)


def render_planos(video, planos, salida):
    """
    Como render_final de auto_editor, pero cada plano puede tener su encuadre.

    El zoom se hace recortando el centro y volviendo a escalar al tamano
    original. Al reves —escalar primero y recortar despues— se pierde nitidez al
    pedo, porque se agranda todo el cuadro para tirar los bordes.
    """
    w, h = _dims(video)
    carpeta = os.path.splitext(salida)[0] + "_planos"
    os.makedirs(carpeta, exist_ok=True)
    lista = os.path.join(carpeta, "list.txt")
    with open(lista, "w") as f:
        for i, p in enumerate(planos):
            parte = os.path.join(carpeta, "p_%04d.mp4" % i)
            cmd = ["ffmpeg", "-y", "-ss", str(p["inicio"]), "-to", str(p["fin"]),
                   "-i", video]
            z = float(p.get("zoom") or 1)
            if z > 1.001:
                cmd += ["-vf", "crop=iw/%.4f:ih/%.4f,scale=%d:%d" % (z, z, w, h)]
            cmd += ["-c:v", "libx264", "-c:a", "aac",
                    "-avoid_negative_ts", "make_zero", parte, "-loglevel", "error"]
            subprocess.run(cmd, check=True)
            f.write("file '%s'\n" % os.path.abspath(parte))
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lista,
                    "-c", "copy", salida, "-loglevel", "error"], check=True)
    return salida


def texto_en(palabras, a, b):
    """Lo que se dice adentro de un tramo. Por punto medio, igual que remapear."""
    return " ".join(
        str(w.get("word", "")) for w in (palabras or [])
        if a <= (float(w.get("start", 0)) + float(w.get("end", 0))) / 2.0 < b
    ).strip()


def detalle_cortes(palabras, grupos):
    """
    Cada tramo que se saca, con su motivo y con lo que se decia ahi.

    Sin el texto, un corte es un par de numeros y no hay forma de decir si
    estuvo bien o mal. Es lo que despues permite marcarlos de a uno.
    """
    cortes = []
    for motivo, tramos in grupos:
        for a, b in tramos:
            cortes.append({"inicio": round(float(a), 2), "fin": round(float(b), 2),
                           "motivo": motivo, "texto": texto_en(palabras, a, b)[:300]})
    cortes.sort(key=lambda c: c["inicio"])
    return cortes


def escribir_srt(palabras, sub, ruta):
    """El .srt con el agrupado y las mayusculas que pida el formato."""
    if sub.get("mayusculas"):
        palabras = [dict(w, word=str(w.get("word", "")).upper()) for w in palabras]
    return transcribe.palabras_a_srt(
        palabras, max_palabras_por_linea=int(sub.get("palabras", 8)), out_srt=ruta)


def _force_style(sub):
    """
    El aspecto del cartel quemado, en el formato que entiende libass. Sin esto
    ffmpeg usa su default: Arial 16 pegado abajo, que en vertical no se lee.
    """
    partes = ["Alignment=%d" % {"abajo": 2, "medio": 5, "arriba": 8}.get(sub.get("pos"), 2),
              "MarginV=%d" % int(sub.get("margen", 60)),
              "Outline=%d" % int(sub.get("borde", 2)),
              "FontSize=%d" % int(sub.get("tam", 24))]
    if sub.get("fuente"):
        partes.append("FontName=%s" % sub["fuente"])
    return ",".join(partes)


def quemar_subtitulos(video, srt, salida, sub=None):
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
    filtro = "subtitles=%s:force_style='%s'" % (os.path.basename(srt), _force_style(sub or {}))
    subprocess.run(
        ["ffmpeg", "-y", "-i", os.path.abspath(video),
         "-vf", filtro,
         "-c:a", "copy", os.path.abspath(salida), "-loglevel", "error"],
        cwd=os.path.dirname(os.path.abspath(srt)), check=True)
    return salida


def procesar(fila, tmp):
    carpeta = fila["video_path"].split("/")[0]        # el uuid del usuario
    base    = os.path.join(tmp, "fuente.mp4")
    bajar(fila["video_path"], base)

    op      = fila.get("opciones") or {}
    sub     = op.get("subtitulo") or {}
    aire    = float(op.get("aire", 0.12))
    clipmin = float(op.get("clip_min", 0.3))
    # None = no tocar las muletillas. Lista vacia tambien, para que apagarlo
    # desde la pantalla sea mandar [] y no haya que inventar otro campo.
    muletillas = op.get("muletillas")
    repetidas  = bool(op.get("tomas_repetidas"))

    dur = auto_editor.ffprobe_duration(base)

    # Se transcribe ANTES de cortar, y siempre. Es al reves de como estaba, y es
    # lo que permite decidir por lo que se dice —muletillas, tomas repetidas— y
    # no solo por donde baja el audio. Los subtitulos del modo render se corren
    # despues a la linea de tiempo del cortado.
    palabras = transcribir(base, tmp)

    # min_silencio en 0 es "no cortes nada": el modo take unico, donde el valor
    # esta en que no se note ni una costura.
    minsil = float(op.get("min_silencio", 0.6))
    silencios = auto_editor.detectar_silencios(
        base, umbral_db=float(op.get("umbral_db", -30)), min_silencio=minsil
    ) if minsil > 0 else []

    # El guion, si lo cargo. Cambia dos cosas: cual de dos tomas se queda, y que
    # bloques se marcan. Sin guion todo sigue funcionando igual que antes.
    txt_guion = str(op.get("guion") or "").strip()
    elegir = (lambda i1, i2, L: Guion.elegir_peor(palabras, i1, i2, L, txt_guion)) \
        if txt_guion else None

    t_mul = D.tramos_muletillas(palabras, muletillas) if muletillas else []
    t_rep = D.tramos_tomas_repetidas(
        palabras, minimo=int(op.get("repetidas_min", 6)), elegir=elegir
    ) if repetidas else []
    bloques = Guion.mapa(palabras, txt_guion) if txt_guion else []
    # Los silencios llevan aire; lo que sale de la transcripcion, no.
    clips   = D.conservar(dur, list(silencios), aire=aire, clip_min=clipmin,
                          exacto=t_mul + t_rep)
    final_s = D.duracion_total(clips)

    # Como se muestra lo que queda. Es un eje aparte del de "que se saca": un
    # take unico sin aire muerto sigue siendo un plano fijo de trece minutos.
    pres     = op.get("presentacion") or {}
    cadencia = float(pres.get("cadencia", 0) or 0)
    zoom     = float(pres.get("zoom", 1.12) or 1.12)
    planos   = D.subdividir(clips, palabras, cadencia=cadencia, zooms=(1.0, zoom))
    broll    = D.bloque_central(clips) if pres.get("tipo") == "b_roll" else None

    marcar(fila["id"], analisis={
        "duracion": round(dur, 2),
        "silencios": [{"inicio": round(a, 2), "fin": round(b, 2)} for a, b in silencios],
        "clips": [{"inicio": a, "fin": b} for a, b in clips],
        "duracion_final": final_s,
        "ahorro_pct": round(100 * (dur - final_s) / dur) if dur else 0,
        # De donde salio cada corte. Sin esto, ver "67% mas corto" no dice si
        # sobraba aire o si se comio media charla.
        "porque": {"silencios": len(silencios), "muletillas": len(t_mul),
                   "repetidas": len(t_rep), "palabras": len(palabras)},
        "planos": len(planos),
        "broll": broll,
        # Que bloque del guion se dijo y cual no. Enterarse de que te salteaste
        # uno despues de publicar no sirve de nada.
        "bloques": bloques,
        # El detalle de cada corte y la transcripcion entera. Ocupan, pero sin
        # esto no hay forma de revisar una decision: solo queda el porcentaje.
        "cortes": detalle_cortes(palabras, [("silencio", silencios),
                                            ("muletilla", t_mul),
                                            ("repetida", t_rep)]),
        "texto": " ".join(str(w.get("word", "")) for w in palabras)[:20000],
    })

    sello = str(int(time.time()))

    if fila["modo"] == "render":
        cortado = os.path.join(tmp, "cortado.mp4")
        render_planos(base, planos, cortado)
        # Los tiempos pasan a la linea del video cortado: se calcularon sobre el
        # crudo, pero se muestran sobre el que se entrega.
        srt = escribir_srt(D.remapear(palabras, clips), sub, os.path.join(tmp, "subs.srt"))
        listo = os.path.join(tmp, "final.mp4")
        quemar_subtitulos(cortado, srt, listo, sub)
        p_video = subir(listo, f"{carpeta}/{sello}_final.mp4", "video/mp4")
        p_srt   = subir(srt,   f"{carpeta}/{sello}_final.srt", "text/plain")
    else:
        # En CapCut se importa el video CRUDO y se le aplica el plan, asi que el
        # srt va en la linea de tiempo del crudo: sin remapear.
        srt = escribir_srt(palabras, sub, os.path.join(tmp, "subs.srt"))
        plan = os.path.join(tmp, "plan_de_corte.json")
        with open(srt, encoding="utf-8") as f:
            texto_srt = f.read()
        auto_editor.exportar_capcut(clips, plan, os.path.join(tmp, "plan.srt"),
                                    fuente_srt=texto_srt)
        # exportar_capcut solo escribe los tramos a conservar. El encuadre de
        # cada plano y donde va el b-roll son justo lo que hay que ejecutar a
        # mano en CapCut, asi que se agregan al mismo archivo.
        with open(plan, encoding="utf-8") as f:
            _p = json.load(f)
        _p["planos"] = planos
        if broll:
            _p["b_roll"] = broll
        _p["formato"] = op.get("formato", "")
        with open(plan, "w", encoding="utf-8") as f:
            json.dump(_p, f, indent=2, ensure_ascii=False)
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
