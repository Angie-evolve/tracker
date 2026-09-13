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
import os, sys, re, time, json, argparse, tempfile, subprocess, traceback
import requests

import auto_editor
import transcribe
import decisiones as D
import guion as Guion
import piezas as Piezas
import subtitulos as Sub

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY    = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
MODELO = os.environ.get("WHISPER_MODELO", "small")
CADA   = int(os.environ.get("INTERVALO", "8"))
BUCKET = "videos"
# Tope por archivo del bucket. El resultado se sube al mismo lugar que la
# fuente, asi que tiene que entrar igual que ella.
LIMITE_MB = int(os.environ.get("LIMITE_MB", "50"))

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
    mb = os.path.getsize(local) / 1048576.0
    with open(local, "rb") as f:
        r = requests.post(f"{SB_URL}/storage/v1/object/{BUCKET}/{path}",
                          headers={**H, "Content-Type": tipo, "x-upsert": "true"},
                          data=f, timeout=600)
    if not r.ok:
        # raise_for_status solo dice "400 Bad Request" y esconde el cuerpo, que
        # es lo unico que explica si fue el tamano, el bucket o los permisos.
        detalle = (r.text or "")[:300]
        if "EntityTooLarge" in detalle or "maximum allowed size" in detalle:
            raise RuntimeError("el resultado pesa %.1f MB y el bucket acepta %d MB"
                               % (mb, LIMITE_MB))
        raise RuntimeError("no pude subir %s (HTTP %d): %s" % (path, r.status_code, detalle))
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
    """
    El tamano COMO SE VE, no como esta guardado.

    Un celular graba de costado y deja la rotacion en los metadatos: el archivo
    dice 1920x1080 pero se ve 1080x1920. ffmpeg aplica la rotacion al decodificar,
    asi que pedirle 1920x1080 de salida metia el video vertical adentro de un
    cuadro apaisado, con dos barras negras enormes a los costados.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_streams", "-of", "json", video],
        capture_output=True, text=True, check=True).stdout
    st = (json.loads(out).get("streams") or [{}])[0]
    w, h = int(st.get("width") or 0), int(st.get("height") or 0)
    rot = 0
    for sd in (st.get("side_data_list") or []):
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if not rot:
        try:
            rot = int((st.get("tags") or {}).get("rotate") or 0)
        except ValueError:
            rot = 0
    if abs(rot) % 180 == 90:
        w, h = h, w
    return w, h


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


def kbps_para(duracion, audio_kbps=128):
    """
    A que bitrate hay que encodear para entrar en el bucket.

    El default de libx264 (CRF 23) para un vertical de trece minutos da bastante
    mas de 50 MB, asi que el render terminaba bien y explotaba al subir, despues
    de veinte minutos de trabajo. Mejor apuntar al tamano desde el encode.
    """
    if not duracion or duracion <= 0:
        return None
    total = (LIMITE_MB * 0.92 * 8 * 1024) / duracion
    return int(max(total - audio_kbps, 0))


FUENTES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")


def quemar_subtitulos(video, srt, salida, sub=None, kbps=None):
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
    if srt.lower().endswith(".ass") and not hay_filtro("ass"):
        raise RuntimeError("este ffmpeg no trae el filtro 'ass' (le falta libass)")
    # Solo el srt entra crudo en el string del filtro, asi que ese es el unico
    # que va relativo; la entrada y la salida van con path completo.
    # El .ass ya trae su estilo adentro; el .srt necesita que se lo pasemos. Y
    # el .ass pide fontsdir porque Montserrat no esta instalada en el sistema:
    # viene con el repo.
    if srt.lower().endswith(".ass"):
        filtro = "ass=%s:fontsdir=%s" % (os.path.basename(srt), FUENTES)
    else:
        filtro = "subtitles=%s:force_style='%s'" % (os.path.basename(srt),
                                                    _force_style(sub or {}))
    cmd = ["ffmpeg", "-y", "-i", os.path.abspath(video), "-vf", filtro]
    if kbps:
        cmd += ["-b:v", "%dk" % kbps, "-maxrate", "%dk" % int(kbps * 1.35),
                "-bufsize", "%dk" % (kbps * 2), "-c:a", "aac", "-b:a", "128k"]
    else:
        cmd += ["-c:a", "copy"]
    cmd += [os.path.abspath(salida), "-loglevel", "error"]
    subprocess.run(cmd, cwd=os.path.dirname(os.path.abspath(srt)), check=True)
    return salida


def _palabras_en(palabras, a, b):
    """Las palabras de un tramo, con los tiempos corridos al arranque del tramo."""
    salida = []
    for w in (palabras or []):
        ini, fin = float(w.get("start", 0)), float(w.get("end", 0))
        if a <= (ini + fin) / 2.0 < b:
            salida.append({"word": w.get("word", ""),
                           "start": round(max(ini - a, 0.0), 3),
                           "end": round(max(fin - a, 0.0), 3)})
    return salida


def concatenar(tramos, salida, dims=None):
    """
    Pega varios tramos —de archivos distintos— en un solo video.

    Una pieza se arma con un clip por parrafo, asi que casi nunca sale de un
    archivo solo. Se reencoda cada tramo al mismo tamano antes de pegar: dos
    clips de la misma camara suelen coincidir, pero uno grabado de costado o con
    otra resolucion rompe el concat sin decir por que.
    """
    carpeta = os.path.splitext(salida)[0] + "_tramos"
    os.makedirs(carpeta, exist_ok=True)
    lista = os.path.join(carpeta, "list.txt")
    w, h = dims or _dims(tramos[0]["archivo"])
    with open(lista, "w") as f:
        for i, t in enumerate(tramos):
            parte = os.path.join(carpeta, "t_%03d.mp4" % i)
            subprocess.run(
                ["ffmpeg", "-y", "-ss", str(t["inicio"]), "-to", str(t["fin"]),
                 "-i", t["archivo"],
                 "-vf", "scale=%d:%d:force_original_aspect_ratio=decrease,"
                        "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1" % (w, h, w, h),
                 "-c:v", "libx264", "-c:a", "aac", "-ar", "48000", "-ac", "2",
                 "-avoid_negative_ts", "make_zero", parte, "-loglevel", "error"],
                check=True)
            f.write("file '%s'\n" % os.path.abspath(parte))
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lista,
                    "-c", "copy", salida, "-loglevel", "error"], check=True)
    return salida


def _palabras_pegadas(tramos):
    """Las palabras de los tramos, corridas como quedan una atras de la otra."""
    salida, offset = [], 0.0
    for t in tramos:
        salida += [{"word": w["word"],
                    "start": round(w["start"] + offset, 3),
                    "end": round(w["end"] + offset, 3)}
                   for w in _palabras_en(t["palabras"], t["inicio"], t["fin"])]
        offset += (t["fin"] - t["inicio"])
    return salida


def recortar(video, a, b, salida):
    """Saca un tramo a archivo propio. Cada pieza se edita como si fuera un
    video suelto: mismo camino, sin ramas paralelas que despues se desincronizan."""
    subprocess.run(["ffmpeg", "-y", "-ss", str(a), "-to", str(b), "-i", video,
                    "-c:v", "libx264", "-c:a", "aac", "-avoid_negative_ts", "make_zero",
                    salida, "-loglevel", "error"], check=True)
    return salida


def _editar(archivo, palabras, op, tmp, carpeta, nombre, modo):
    """
    Todo lo que va despues de transcribir: decidir que se saca, como se muestra,
    renderizar, subtitular y subir. Devuelve (analisis, resultado, srt).

    Se separo de procesar() para que una pieza de una tanda y un video suelto
    recorran exactamente el mismo camino.
    """
    sub     = op.get("subtitulo") or {}
    aire    = float(op.get("aire", 0.12))
    clipmin = float(op.get("clip_min", 0.3))
    muletillas = op.get("muletillas")
    repetidas  = bool(op.get("tomas_repetidas"))

    dur = auto_editor.ffprobe_duration(archivo)

    minsil = float(op.get("min_silencio", 0.6))
    silencios = auto_editor.detectar_silencios(
        archivo, umbral_db=float(op.get("umbral_db", -30)), min_silencio=minsil
    ) if minsil > 0 else []

    txt_guion = str(op.get("guion") or "").strip()
    elegir = (lambda i1, i2, L: Guion.elegir_peor(palabras, i1, i2, L, txt_guion)) \
        if txt_guion else None

    t_mul = D.tramos_muletillas(palabras, muletillas) if muletillas else []
    t_rep = D.tramos_tomas_repetidas(
        palabras, minimo=int(op.get("repetidas_min", 6)), elegir=elegir
    ) if repetidas else []
    bloques = Guion.mapa(palabras, txt_guion) if txt_guion else []

    clips   = D.conservar(dur, list(silencios), aire=aire, clip_min=clipmin,
                          exacto=t_mul + t_rep)
    final_s = D.duracion_total(clips)

    pres     = op.get("presentacion") or {}
    cadencia = float(pres.get("cadencia", 0) or 0)
    zoom     = float(pres.get("zoom", 1.12) or 1.12)
    planos   = D.subdividir(clips, palabras, cadencia=cadencia, zooms=(1.0, zoom))
    broll    = D.bloque_central(clips) if pres.get("tipo") == "b_roll" else None

    analisis = {
        "duracion": round(dur, 2),
        "silencios": [{"inicio": round(a, 2), "fin": round(b, 2)} for a, b in silencios],
        "clips": [{"inicio": a, "fin": b} for a, b in clips],
        "duracion_final": final_s,
        "ahorro_pct": round(100 * (dur - final_s) / dur) if dur else 0,
        "porque": {"silencios": len(silencios), "muletillas": len(t_mul),
                   "repetidas": len(t_rep), "palabras": len(palabras)},
        "planos": len(planos),
        "broll": broll,
        "bloques": bloques,
        "cortes": detalle_cortes(palabras, [("silencio", silencios),
                                            ("muletilla", t_mul),
                                            ("repetida", t_rep)]),
        "texto": " ".join(str(w.get("word", "")) for w in palabras)[:20000],
    }

    if modo == "render":
        cortado = os.path.join(tmp, nombre + "_cortado.mp4")
        render_planos(archivo, planos, cortado)
        pal2 = D.remapear(palabras, clips)
        srt = escribir_srt(pal2, sub, os.path.join(tmp, nombre + ".srt"))
        # El karaoke necesita el tamano del video para calcular todo por
        # proporcion: un numero fijo de pixeles se rompe apenas cambia la
        # resolucion.
        quemar_este = srt
        if sub.get("karaoke"):
            aw, ah = _dims(cortado)
            quemar_este = Sub.escribir_ass(
                pal2, aw, ah, os.path.join(tmp, nombre + ".ass"),
                por_bloque=int(sub.get("palabras", 3)),
                alto_rel=float(sub.get("alto_rel", 0.42)),
                tam_rel=float(sub.get("tam_rel", 0.055)))
        listo = os.path.join(tmp, nombre + "_final.mp4")
        kb = kbps_para(final_s)
        if kb is not None and kb < 250:
            raise RuntimeError(
                "el video final dura %d min y no entra en %d MB ni bajando la "
                "calidad. Cortalo en piezas mas cortas." % (final_s / 60, LIMITE_MB))
        quemar_subtitulos(cortado, quemar_este, listo, sub, kbps=kb)
        res = subir(listo, f"{carpeta}/{nombre}.mp4", "video/mp4")
        p_srt = subir(srt, f"{carpeta}/{nombre}.srt", "text/plain")
        # El mismo corte pero SIN los subtitulos quemados. Es el paso previo,
        # asi que ya esta hecho: subirlo cuesta una subida y evita reprocesar
        # todo cuando se quiere terminar el trabajo en CapCut, donde los
        # carteles se estilan a mano. Quemados no se pueden sacar.
        analisis["capcut"] = None
        try:
            if os.path.getsize(cortado) <= LIMITE_MB * 1048576:
                analisis["capcut"] = subir(cortado, f"{carpeta}/{nombre}_capcut.mp4",
                                           "video/mp4")
            else:
                analisis["capcut_no"] = "el corte sin subtitulos no entra en %d MB" % LIMITE_MB
        except Exception as e:
            # Que falle el extra no puede tirar abajo la pieza, que ya esta.
            analisis["capcut_no"] = str(e)[:160]
        return analisis, res, p_srt

    srt = escribir_srt(palabras, sub, os.path.join(tmp, nombre + ".srt"))
    plan = os.path.join(tmp, nombre + "_plan.json")
    with open(srt, encoding="utf-8") as f:
        texto_srt = f.read()
    auto_editor.exportar_capcut(clips, plan, os.path.join(tmp, nombre + "_plan.srt"),
                                fuente_srt=texto_srt)
    with open(plan, encoding="utf-8") as f:
        _p = json.load(f)
    _p["planos"] = planos
    if broll:
        _p["b_roll"] = broll
    _p["formato"] = op.get("formato", "")
    with open(plan, "w", encoding="utf-8") as f:
        json.dump(_p, f, indent=2, ensure_ascii=False)
    return analisis, subir(plan, f"{carpeta}/{nombre}.json", "application/json"), \
           subir(os.path.join(tmp, nombre + "_plan.srt"), f"{carpeta}/{nombre}.srt",
                 "text/plain")


def _slug(t, i):
    t = re.sub(r"[^A-Za-z0-9]+", "-", str(t or "")).strip("-")[:40]
    return ("%02d-%s" % (i + 1, t)) if t else ("pieza-%02d" % (i + 1))


def procesar(fila, tmp):
    carpeta = fila["video_path"].split("/")[0]        # el uuid del usuario
    rutas   = fila.get("videos") or [fila["video_path"]]
    guiones = fila.get("guiones") or []
    op      = fila.get("opciones") or {}
    modo    = fila["modo"]
    sello   = str(int(time.time()))

    # --- video suelto: el camino de siempre --------------------------------
    if len(rutas) <= 1 and len(guiones) <= 1:
        base = os.path.join(tmp, "fuente.mp4")
        bajar(rutas[0], base)
        palabras = transcribir(base, tmp)
        if guiones:
            op = dict(op, guion=guiones[0].get("texto") or op.get("guion"))
        analisis, res, srt = _editar(base, palabras, op, tmp, carpeta, sello + "_final", modo)
        marcar(fila["id"], analisis=analisis)
        marcar(fila["id"], estado="listo", listo_at=_ahora(),
               resultado_path=res, resultado_srt_path=srt)
        return

    # --- tanda: varios videos, varios guiones ------------------------------
    # Se transcribe TODO primero y recien despues se reparte: un guion puede
    # estar en cualquier video, y saber cual no se grabo exige haber mirado
    # todos.
    locales = []
    for k, ruta in enumerate(rutas):
        f = os.path.join(tmp, "v%02d.mp4" % k)
        bajar(ruta, f)
        print("  transcribiendo %s" % ruta, flush=True)
        locales.append({"id": ruta, "archivo": f,
                        "palabras": transcribir(f, tmp),
                        "duracion": auto_editor.ffprobe_duration(f)})

    if guiones:
        encontradas, sin_grabar, descartados = Piezas.armar(locales, guiones)
    else:
        # Carpeta sin guiones: cada video es su propia pieza, entero. Es lo que
        # promete el arrastrable y lo que espera cualquiera que tire una carpeta
        # de clips sueltos; sin esto repartir() devolvia cero y no se entregaba
        # nada.
        encontradas = [{"titulo": os.path.splitext(os.path.basename(v["id"]))[0],
                        "tramos": [{"video": v["id"], "inicio": 0.0,
                                    "fin": float(v["duracion"]), "score": 1.0}],
                        "duracion": float(v["duracion"]), "score": 1.0,
                        "bloques": 1, "bloques_total": 1}
                       for v in locales if v.get("duracion")]
        sin_grabar, descartados = [], []
    sueltos = Piezas.huerfanos(locales, encontradas)
    marcar(fila["id"], analisis={"tanda": True, "videos": len(locales),
                                 "guiones": len(guiones),
                                 "piezas": len(encontradas),
                                 "sin_grabar": sin_grabar, "sueltos": sueltos,
                                 "descartados": descartados})

    porRuta = {v["id"]: v for v in locales}
    salida = []
    for i, pz in enumerate(encontradas):
        nombre = "%s_%s" % (sello, _slug(pz["titulo"], i))
        print("  pieza %d/%d: %s (%d tramos)" % (i + 1, len(encontradas),
                                                 pz["titulo"], len(pz["tramos"])), flush=True)
        base = {"titulo": pz["titulo"], "tramos": pz["tramos"],
                "bloques": pz.get("bloques"), "bloques_total": pz.get("bloques_total")}
        try:
            trs = [dict(t, archivo=porRuta[t["video"]]["archivo"],
                        palabras=porRuta[t["video"]]["palabras"])
                   for t in pz["tramos"]]
            armado = concatenar(trs, os.path.join(tmp, nombre + "_crudo.mp4"))
            pal = _palabras_pegadas(trs)
            gtxt = next((g.get("texto") for g in guiones
                         if (g.get("titulo") or "") == pz["titulo"]), "")
            an, res, srt = _editar(armado, pal, dict(op, guion=gtxt), tmp,
                                   carpeta, nombre, modo)
        except Exception as e:
            # Una pieza que falla no puede llevarse la tanda entera: se anota y
            # se sigue con las demas.
            salida.append(dict(base, error="%s: %s" % (type(e).__name__, e)))
            continue
        salida.append(dict(base, duracion=an["duracion_final"],
                           ahorro_pct=an["ahorro_pct"], path=res, srt_path=srt,
                           capcut_path=an.get("capcut")))
        marcar(fila["id"], piezas=salida)

    marcar(fila["id"], estado="listo", listo_at=_ahora(), piezas=salida,
           resultado_path=(salida[0].get("path") if salida else None))


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
