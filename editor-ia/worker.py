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
import os, sys, re, time, math, json, array, argparse, tempfile, subprocess, traceback
import requests

import auto_editor
import transcribe
import decisiones as D
import guion as Guion
import piezas as Piezas
import subtitulos as Sub
import correcciones as Corr

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY    = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
MODELO = os.environ.get("WHISPER_MODELO", "small")
CADA   = int(os.environ.get("INTERVALO", "8"))
BUCKET = "videos"
# Tope por archivo del bucket. El resultado se sube al mismo lugar que la
# fuente, asi que tiene que entrar igual que ella.
LIMITE_MB = int(os.environ.get("LIMITE_MB", "50"))

# Calidad del encode. Se fija por CRF y no por bitrate: apuntar a "que entre en
# 50 MB" daba 29 Mbps en un clip de seis segundos y 44 MB en una pieza de medio
# minuto —el cupo entero gastado en algo que no se ve— y al mismo tiempo dejaba
# el archivo de CapCut en 2 Mbps, que es el que MENOS deberia perder porque lo
# van a exportar una vez mas.
#
# El tope de tamano sigue existiendo, pero como maxrate: red de seguridad para
# una pieza larga, no objetivo a alcanzar.
# Lo que se entrega —el video final y el archivo para CapCut— va al mismo CRF:
# el final se codifica A PARTIR del de CapCut, asi que bajarle la calidad al
# segundo paso solo suma una perdida sobre algo que ya estaba decidido.
CRF_ENTREGA = 18
CRF_INTERMEDIO = 16   # archivo de paso, no lo ve nadie
PRESET = os.environ.get("X264_PRESET", "veryfast")

# Las keys nuevas (sb_secret_...) no son JWT: mandarlas tambien en
# Authorization: Bearer hace que Supabase rechace todo con 401.
H = {"apikey": KEY}
if not KEY.startswith("sb_"):
    H["Authorization"] = f"Bearer {KEY}"


# ---------------------------------------------------------------- tabla ----

# Cuantas veces se reintenta algo que fallo por causas pasajeras, y cuanto se
# espera entre intento e intento.
ESPERAS = (2, 5, 12)


def _pasajero(e):
    """
    Si el error es del momento o del pedido.

    Un 504 es la base tardando en contestar; un 400 es un pedido mal armado, y
    repetirlo mil veces va a fallar mil veces igual.
    """
    if isinstance(e, (requests.ConnectionError, requests.Timeout)):
        return True
    r = getattr(e, "response", None)
    return r is not None and (r.status_code >= 500 or r.status_code == 429)


def _reintentar(hacer, que):
    """
    Repite una operacion que se puede repetir sin consecuencias.

    Una corrida entera se moria por un 504 suelto en la primera consulta: la
    corrida terminaba en quince segundos, el trabajo quedaba en cola y no habia
    quien lo volviera a mirar hasta el cron siguiente, dos horas despues.
    """
    for i, espera in enumerate(ESPERAS + (None,)):
        try:
            return hacer()
        except Exception as e:
            if espera is None or not _pasajero(e):
                raise
            print("%s fallo (%s), reintento en %ds" % (que, type(e).__name__, espera),
                  flush=True)
            time.sleep(espera)


def _rest(metodo, ruta, extra=None, reintentar=None, **kw):
    """
    reintentar: por defecto, solo los GET. Repetir una escritura que quizas si
    llego duplicaria el efecto; el que sabe que la suya es repetible lo pide.
    """
    cab = {**H, "Content-Type": "application/json"}
    if extra:
        cab.update(extra)

    def hacer():
        r = requests.request(metodo, f"{SB_URL}/rest/v1/{ruta}",
                             headers=cab, timeout=60, **kw)
        r.raise_for_status()
        return r.json() if r.text else None

    if reintentar is None:
        reintentar = (metodo.upper() == "GET")
    return _reintentar(hacer, f"{metodo} {ruta.split('?')[0]}") if reintentar else hacer()


# Cuanto puede estar un trabajo "procesando" antes de darlo por colgado. Una
# tanda de treinta clips tarda unos doce minutos, asi que este margen no pisa
# a nadie que siga trabajando de verdad.
COLGADO_MIN = int(os.environ.get("COLGADO_MIN", "45"))


def reciclar_colgados():
    """
    Devuelve a la cola lo que quedo tomado por un worker que ya no existe.

    El runner se puede quedar sin memoria, pasarse del limite de tiempo o
    perder la conexion justo al guardar el resultado. En cualquiera de esos
    casos la fila queda en "procesando" para siempre: nadie la vuelve a tomar,
    porque tomar_pendiente solo mira las pendientes.
    """
    corte = time.strftime("%Y-%m-%dT%H:%M:%S",
                          time.gmtime(time.time() - COLGADO_MIN * 60)) + "Z"
    try:
        vueltas = _rest("PATCH",
                        f"trabajos_video?estado=eq.procesando&tomado_at=lt.{corte}",
                        extra={"Prefer": "return=representation"},
                        json={"estado": "pendiente", "tomado_at": None},
                        reintentar=True) or []
    except Exception as e:
        # Que falle la limpieza no puede impedir que se procese lo que si esta
        # en cola.
        print("no pude reciclar colgados:", e, flush=True)
        return 0
    for f in vueltas:
        print("vuelve a la cola:", f.get("id"), flush=True)
    return len(vueltas)


def hay_pendiente():
    """
    Solo mira si hay algo, no lo reclama. Es lo que corre el primer step del
    workflow: si contesta que no, la corrida termina ahi y no se instala nada.
    """
    reciclar_colgados()
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
    # Se reintenta: escribir dos veces el mismo estado deja lo mismo, y perder
    # esta llamada deja un trabajo terminado que se ve como si siguiera
    # procesando.
    _rest("PATCH", f"trabajos_video?id=eq.{id_}", json=campos, reintentar=True)


def _ahora():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


# -------------------------------------------------------------- storage ----

def bajar(path, destino):
    def hacer():
        r = requests.get(f"{SB_URL}/storage/v1/object/{BUCKET}/{path}",
                         headers=H, timeout=600, stream=True)
        r.raise_for_status()
        with open(destino, "wb") as f:
            for trozo in r.iter_content(1024 * 256):
                f.write(trozo)
        return destino
    # Bajar es leer: repetirlo no cambia nada, y una tanda son treinta y pico
    # de descargas seguidas donde una sola que se corte tira todo abajo.
    return _reintentar(hacer, f"bajar {path.split('/')[-1]}")


def subir(local, path, tipo="application/octet-stream"):
    mb = os.path.getsize(local) / 1048576.0

    def hacer():
        # El archivo se reabre en cada intento: despues de un envio fallido el
        # descriptor quedo al final y el reintento subiria cero bytes.
        with open(local, "rb") as f:
            r = requests.post(f"{SB_URL}/storage/v1/object/{BUCKET}/{path}",
                              headers={**H, "Content-Type": tipo, "x-upsert": "true"},
                              data=f, timeout=600)
        # Solo los pasajeros se reintentan; el resto se explica abajo.
        if r.status_code >= 500 or r.status_code == 429:
            r.raise_for_status()
        return r

    # Se puede reintentar porque va con x-upsert: la segunda subida pisa a la
    # primera en vez de chocar.
    r = _reintentar(hacer, f"subir {path.split('/')[-1]}")
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


def _sin_zoom(planos):
    return all(float(p.get("zoom") or 1) <= 1.001 for p in planos)


def _seleccion(planos):
    """
    La expresion que le dice a ffmpeg que tramos conservar, en una sola pasada.

    El final va con "lt" y no con "between": between incluye los dos extremos y
    dejaba un cuadro de mas por tramo. Con treinta tramos eso es un segundo de
    corrimiento contra los subtitulos, que se calculan sobre estos mismos
    numeros.
    """
    return "+".join("gte(t,%.4f)*lt(t,%.4f)" % (float(p["inicio"]), float(p["fin"]))
                    for p in planos)


def render_planos(video, planos, salida):
    """
    Deja solo los tramos elegidos, cada uno con su encuadre.

    Se hace en UNA pasada y no cortando a archivos sueltos para despues
    pegarlos: cortar y pegar codifica dos veces el mismo material, y cada
    generacion de x264 se come detalle que ya no vuelve. El resultado de aca es
    ademas el archivo que se entrega para CapCut, donde lo van a exportar una
    vez mas.

    El zoom se hace recortando el centro y volviendo a escalar al tamano
    original. Al reves —escalar primero y recortar despues— se pierde nitidez al
    pedo, porque se agranda todo el cuadro para tirar los bordes.
    """
    if not planos:
        raise RuntimeError("no quedo ningun tramo para renderizar")

    if _sin_zoom(planos):
        # Sin encuadres distintos alcanza con seleccionar cuadros: un solo
        # decodificado, un solo encode y ninguna union.
        sel = _seleccion(planos)
        subprocess.run(
            ["ffmpeg", "-y", "-i", video,
             "-vf", "select='%s',setpts=N/FRAME_RATE/TB" % sel,
             "-af", "aselect='%s',asetpts=N/SR/TB" % sel,
             "-c:v", "libx264", "-crf", str(CRF_ENTREGA), "-preset", PRESET,
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
             salida, "-loglevel", "error"],
            check=True)
        return salida

    # Con zoom cada tramo lleva su propio recorte, asi que se arma el grafo a
    # mano. Sigue siendo una sola pasada: el concat va por filtro, no por
    # archivos intermedios.
    w, h = _dims(video)
    n = len(planos)
    partes, etiquetas = ["[0:v]split=%d%s" % (n, "".join("[v%d]" % i for i in range(n))),
                         "[0:a]asplit=%d%s" % (n, "".join("[a%d]" % i for i in range(n)))], []
    for i, p in enumerate(planos):
        z = float(p.get("zoom") or 1)
        corte = ("crop=iw/%.4f:ih/%.4f,scale=%d:%d," % (z, z, w, h)) if z > 1.001 else ""
        partes.append("[v%d]trim=start=%.4f:end=%.4f,setpts=PTS-STARTPTS,%ssetsar=1[x%d]"
                      % (i, float(p["inicio"]), float(p["fin"]), corte, i))
        partes.append("[a%d]atrim=start=%.4f:end=%.4f,asetpts=PTS-STARTPTS[y%d]"
                      % (i, float(p["inicio"]), float(p["fin"]), i))
        etiquetas.append("[x%d][y%d]" % (i, i))
    partes.append("%sconcat=n=%d:v=1:a=1[v][a]" % ("".join(etiquetas), n))
    subprocess.run(
        ["ffmpeg", "-y", "-i", video, "-filter_complex", ";".join(partes),
         "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-crf", str(CRF_ENTREGA), "-preset", PRESET,
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
         salida, "-loglevel", "error"],
        check=True)
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
    """
    El .srt, cortado igual que el cartel que se quema en el video.

    Antes agrupaba de a N palabras exactas por su cuenta, asi que quien se
    llevaba el .srt a CapCut recibia cortes distintos de los que veia en el
    video. Ahora los dos salen de la misma funcion.
    """
    if sub.get("mayusculas"):
        palabras = [dict(w, word=str(w.get("word", "")).upper()) for w in palabras]
    grupos = Sub.bloques(palabras, int(sub.get("palabras", 3)))

    def t(seg):
        seg = max(0.0, float(seg))
        return "%02d:%02d:%02d,%03d" % (seg // 3600, (seg % 3600) // 60,
                                        seg % 60, (seg % 1) * 1000)

    # utf-8-sig: el BOM es lo que hace que CapCut y los editores de Windows
    # tomen el archivo como UTF-8. Sin el, los acentos llegan rotos.
    with open(ruta, "w", encoding="utf-8-sig") as f:
        for i, b in enumerate(grupos, 1):
            f.write("%d\n%s --> %s\n%s\n\n"
                    % (i, t(b[0]["start"]), t(b[-1]["end"]),
                       " ".join(str(w.get("word", "")) for w in b)))
    return ruta


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

# Sin declarar el juego de caracteres, el navegador lee los bytes UTF-8 como
# latin-1 y muestra "cuestiA³n" donde dice "cuestion".
SRT_TIPO = "text/plain; charset=utf-8"


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
        # CRF manda la calidad; maxrate solo evita pasarse del bucket cuando la
        # pieza es larga. Antes iba al reves —bitrate fijo apuntando a llenar el
        # cupo— y una pieza corta se comia 44 MB para nada.
        cmd += ["-c:v", "libx264", "-crf", str(CRF_ENTREGA), "-preset", PRESET,
                "-maxrate", "%dk" % kbps, "-bufsize", "%dk" % (kbps * 2),
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"]
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
    archivo solo. Se normaliza cada tramo al mismo tamano antes de pegar: dos
    clips de la misma camara suelen coincidir, pero uno grabado de costado o con
    otra resolucion rompe el pegado sin decir por que.

    Todo va en una sola pasada, por filtro y no por archivos intermedios: asi
    el material se codifica una vez sola en lugar de dos.
    """
    if not tramos:
        raise RuntimeError("no hay tramos para concatenar")
    w, h = dims or _dims(tramos[0]["archivo"])
    entradas, partes, etiquetas = [], [], []
    for i, t in enumerate(tramos):
        # Un -i por tramo aunque se repita el archivo: asi cada uno decodifica
        # su propio rango y no hace falta partir el stream.
        entradas += ["-ss", str(t["inicio"]), "-to", str(t["fin"]), "-i", t["archivo"]]
        partes.append(
            "[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,"
            "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS[v%d]"
            % (i, w, h, w, h, i))
        partes.append("[%d:a]aresample=48000,asetpts=PTS-STARTPTS[a%d]" % (i, i))
        etiquetas.append("[v%d][a%d]" % (i, i))
    partes.append("%sconcat=n=%d:v=1:a=1[v][a]" % ("".join(etiquetas), len(tramos)))
    subprocess.run(
        ["ffmpeg", "-y"] + entradas
        + ["-filter_complex", ";".join(partes), "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-crf", str(CRF_INTERMEDIO), "-preset", PRESET,
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
           salida, "-loglevel", "error"],
        check=True)
    return salida


# Cuanto se busca de silencio pegado al arranque. Mas que esto ya no es el
# arranque de la grabacion: es una pausa de verdad y no hay que comersela.
MUDO_MAX = 0.20


def mudo_inicial(archivo, desde):
    """
    Cuanto silencio digital —no bajo: cero— hay pegado al arranque de un tramo.

    Los clips del celular empiezan con 9 a 29 ms de nada, y su pista de audio
    termina algunos ms antes que la de video. Pegados uno atras de otro las dos
    cosas se suman y dejan un bache audible justo donde una frase engancha con
    la siguiente. Medido sobre una pieza real: 28, 16 y 31 ms en las tres
    junturas.
    """
    try:
        crudo = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(desde), "-t", str(MUDO_MAX),
             "-i", archivo, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"],
            check=True, stdout=subprocess.PIPE).stdout
    except Exception:
        # Si no se puede medir, no se toca nada: un bache se escucha, un
        # subtitulo corrido se ve.
        return 0.0
    m = array.array("h")
    m.frombytes(crudo[:len(crudo) // 2 * 2])
    for i, v in enumerate(m):
        if abs(v) >= 8:          # ~-72 dBFS: el ruido de sala siempre lo pasa
            return round(i / 48000.0, 4)
    return 0.0


def sacar_mudo_inicial(tramos):
    """
    Corre el arranque de cada tramo hasta donde empieza a haber sonido.

    Se mueve el tramo entero y no el audio suelto para que el video se corra lo
    mismo: mover solo el audio desincronizaria la boca. Son milisegundos donde
    todavia no se dijo nada, asi que no se pierde imagen util.

    Tiene que pasar ANTES de concatenar y de mapear las palabras: las dos cosas
    leen el mismo inicio, y si una se entera y la otra no, los subtitulos quedan
    corridos.
    """
    for t in tramos:
        m = mudo_inicial(t["archivo"], t["inicio"])
        if m and (t["fin"] - t["inicio"] - m) > 0.2:
            t["inicio"] = round(t["inicio"] + m, 4)
    return tramos


# Cuanto se le suma al piso de ruido para decidir que cuenta como silencio, y
# hasta donde se lo deja llegar. El techo existe porque en una grabacion donde
# el piso casi toca la voz, seguir subiendo el umbral empieza a cortar palabras.
# Cuanto se sube el umbral por vez, y hasta donde. El techo se calcula sobre el
# nivel medio del propio audio: pasarse de ahi es empezar a cortar voz.
PASO_DB = 1.0
MARGEN_MEDIO_DB = 2.0
MARGEN_FINAL_DB = 2.0
UMBRAL_TECHO = -20.0


def nivel_medio(archivo):
    """
    El nivel medio del audio segun ffmpeg, en dBFS.

    Se usa la medicion de ffmpeg y no una propia a proposito: calculandola a
    mano hay que acertar el formato de muestra, y no es obvio. Decodificando el
    mismo archivo a s16 y a f32 dan valores que difieren en exactamente 3 dB, y
    solo el de s16 coincide con lo que reporta ffmpeg. Preguntarle a el saca el
    problema de encima.
    """
    try:
        r = subprocess.run(
            ["ffmpeg", "-v", "info", "-i", archivo, "-af", "volumedetect",
             "-f", "null", "-"],
            capture_output=True, text=True)
    except Exception:
        return None
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", r.stderr or "")
    return float(m.group(1)) if m else None


def umbral_silencio(archivo, configurado, min_silencio=0.5):
    """
    A que nivel deja de haber voz EN ESTA grabacion.

    Un umbral fijo asume que todas las salas suenan igual. Medido sobre una
    pieza real: con el umbral configurado en -32 dB el detector no encontro un
    solo silencio en 33 segundos, y quedaron tres pausas sin cortar —1.3s, 1.4s
    y 0.7s— la ultima de las cuales dejaba el cartel colgado en pantalla mas de
    un segundo sin que nadie hablara.

    No alcanza con mirar el piso de ruido: silencedetect exige que el nivel se
    mantenga bajo durante TODO el tramo, asi que lo que manda son los picos del
    ruido y no su promedio. En esa grabacion el piso estaba en -37 dBFS y aun
    asi -32 no encontraba nada. Por eso se le pregunta al propio detector.

    El criterio es la meseta: se sube de a un dB mientras sigan APARECIENDO
    pausas nuevas y se para cuando dejan de aparecer. A partir de ahi, subir mas
    no encuentra otra pausa, solo agranda las que ya estaban comiendose el borde
    de las palabras. Los dos dB finales son para tomarlas enteras y no
    recortadas, y el nivel medio del audio pone el techo.
    """
    def cuantos(u):
        return len(auto_editor.detectar_silencios(archivo, umbral_db=u,
                                                  min_silencio=min_silencio))

    medio = nivel_medio(archivo)
    techo = UMBRAL_TECHO if medio is None else min(UMBRAL_TECHO, medio - MARGEN_MEDIO_DB)
    mejor_u, mejor_n = configurado, cuantos(configurado)
    u, quietos = configurado, 0
    while u + PASO_DB <= techo:
        u += PASO_DB
        n = cuantos(u)
        if n > mejor_n:
            mejor_u, mejor_n, quietos = u, n, 0
        else:
            quietos += 1
            # Dos pasos sin novedad ya es meseta. Seguir es gastar pasadas.
            if quietos >= 2 and mejor_n:
                break
    if not mejor_n:
        return configurado
    elegido = min(mejor_u + MARGEN_FINAL_DB, techo)
    if elegido > configurado + 0.5:
        print("   con el ruido de esta sala el umbral pasa de %.0f a %.0f dB"
              % (configurado, elegido), flush=True)
    return elegido


# Un tiron de imagen mas largo que esto ya se ve. Pasa cuando el navegador
# frena el dibujado mientras comprime: la imagen se traba y el audio sigue.
# Medido sobre un clip real que salio asi: un congelamiento de 13.2 segundos
# adentro de un clip de 31, y ademas 5.7 segundos de contenido perdidos.
CONGELADO_S = 1.0


def congelado(archivo):
    """
    Cuanto tiempo esta la imagen quieta en este clip, en segundos.

    Se usa freezedetect, que es el filtro de ffmpeg hecho para esto. mpdecimate
    no sirve aca: cuenta cuadros repetidos consecutivos y sobre este material
    devolvia 0% incluso en un clip con trece segundos congelados.
    """
    try:
        r = subprocess.run(
            ["ffmpeg", "-v", "info", "-i", archivo, "-an",
             "-vf", "freezedetect=n=-60dB:d=%.2f" % CONGELADO_S, "-f", "null", "-"],
            capture_output=True, text=True)
    except Exception:
        return 0.0
    duraciones = [float(x) for x in
                  re.findall(r"freeze_duration:\s*([0-9.]+)", r.stderr or "")]
    return round(sum(duraciones), 1)


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
    umbral = umbral_silencio(archivo, float(op.get("umbral_db", -30)), minsil)
    silencios = auto_editor.detectar_silencios(
        archivo, umbral_db=umbral, min_silencio=minsil
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
                fondo_rel=float(sub.get("fondo_rel", 0.645)),
                tam_rel=float(sub.get("tam_rel", 0.055)))
        listo = os.path.join(tmp, nombre + "_final.mp4")
        kb = kbps_para(final_s)
        if kb is not None and kb < 250:
            raise RuntimeError(
                "el video final dura %d min y no entra en %d MB ni bajando la "
                "calidad. Cortalo en piezas mas cortas." % (final_s / 60, LIMITE_MB))
        quemar_subtitulos(cortado, quemar_este, listo, sub, kbps=kb)
        res = subir(listo, f"{carpeta}/{nombre}.mp4", "video/mp4")
        p_srt = subir(srt, f"{carpeta}/{nombre}.srt", SRT_TIPO)
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
                 SRT_TIPO)


def _slug(t, i):
    t = re.sub(r"[^A-Za-z0-9]+", "-", str(t or "")).strip("-")[:40]
    return ("%02d-%s" % (i + 1, t)) if t else ("pieza-%02d" % (i + 1))


def procesar_correccion(fila, tmp):
    """
    Alguien subio su corte final. No hay que editar nada: hay que comparar.

    Se pide el video TERMINADO y no una grabacion del proceso porque el
    resultado es una respuesta exacta —que quedo y que no— y el proceso hay que
    interpretarlo.
    """
    orig = (_rest("GET", "trabajos_video?id=eq.%s&select=*" % fila["corrige"]) or [None])[0]
    if not orig:
        raise RuntimeError("no encuentro el trabajo que corrige")
    if not orig.get("palabras"):
        raise RuntimeError("ese trabajo se proceso antes de que se guardaran las "
                           "palabras, asi que no hay contra que comparar")

    base = os.path.join(tmp, "corregido.mp4")
    bajar(fila["video_path"], base)
    print("  transcribiendo la version corregida", flush=True)
    pal = transcribir(base, tmp)

    clips = ((orig.get("analisis") or {}).get("clips")) or []
    difs = Corr.comparar(orig["palabras"], clips, pal)

    # Cada diferencia entra al banco sola. Es la misma tabla que se llena
    # marcando a mano: un ejemplo es un ejemplo, venga de donde venga.
    filas = [{
        "usuario_id": fila["usuario_id"],
        "pedido_por": fila.get("pedido_por"),
        "trabajo_id": orig["id"],
        "formato": (fila.get("opciones") or {}).get("formato")
                   or (orig.get("opciones") or {}).get("formato"),
        "motivo": "correccion",
        "inicio": d["inicio"], "fin": d["fin"], "texto": d["texto"],
        "veredicto": d["tipo"],
        "nota": "de la version corregida",
    } for d in difs]
    if filas:
        _rest("POST", "ejemplos_edicion", json=filas)

    marcar(fila["id"], estado="listo", listo_at=_ahora(),
           palabras=pal,
           analisis={"correccion": True, "corrige": orig["id"],
                     "diferencias": difs,
                     "de_mas": sum(1 for d in difs if d["tipo"] == "no_iba"),
                     "de_menos": sum(1 for d in difs if d["tipo"] == "faltaba"),
                     "palabras": len(pal)})


def procesar(fila, tmp):
    if fila.get("modo") == "correccion" and fila.get("corrige"):
        return procesar_correccion(fila, tmp)
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
        # Las palabras con sus tiempos quedan guardadas: es lo unico contra lo
        # que despues se puede comparar una version corregida.
        marcar(fila["id"], analisis=analisis, palabras=palabras)
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
    # Un clip que viene congelado no tiene arreglo aguas abajo: hay que volver a
    # subirlo. Se avisa con nombre y segundos para saber cual, en vez de
    # entregar una pieza con la imagen trabada.
    trabados = []
    for v in locales:
        seg = congelado(v["archivo"])
        if seg > CONGELADO_S:
            trabados.append({"video": v["id"], "congelado_s": seg})
            print("   OJO: %s tiene %.1fs de imagen congelada" % (v["id"], seg), flush=True)

    sueltos = Piezas.huerfanos(locales, encontradas)
    # Lo que entendio Whisper de cada clip, con los tiempos. Sin esto, cuando
    # una pieza sale mal no hay forma de saber si el guion no calzo porque el
    # umbral esta flojo o porque el clip dice otra cosa: lo unico que queda es
    # un puntaje suelto y adivinar. Las palabras se guardan aparte del analisis
    # para no inflar lo que la pantalla lee en cada refresco.
    marcar(fila["id"],
           palabras=[{"video": v["id"],
                      "texto": " ".join(str(w.get("word", ""))
                                        for w in (v.get("palabras") or []))[:8000]}
                     for v in locales],
           analisis={"tanda": True, "videos": len(locales),
                     "guiones": len(guiones),
                     "piezas": len(encontradas),
                     "sin_grabar": sin_grabar, "sueltos": sueltos,
                     "descartados": descartados, "trabados": trabados})

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
            sacar_mudo_inicial(trs)
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
