#!/usr/bin/env python3
"""
subtitulos.py - los carteles estilo karaoke, en formato .ass

Un .srt solo lleva texto y tiempos: no hay forma de pedirle fuente, color,
posicion ni que las palabras aparezcan de a una. Todo eso sale de .ass, que
libass quema igual de facil.

El reveal se hace con varios Dialogue superpuestos y no con las etiquetas \\k de
ASS: cada linea reemplaza a la anterior, el efecto es el mismo, y no depende de
que la version de libass del runner soporte bien el karaoke nativo.
"""
import re

# Cuanto puede quedar una palabra sola en pantalla antes de que se sienta
# colgada. Si la persona duda tres segundos, el cartel no se queda esperando.
COLA_MAX = 0.6
# Una pausa mas larga que esto corta el bloque: son dos ideas, no una.
PAUSA_CORTA = 0.75


def _txt(w):
    """Lo que se muestra. En minuscula, que es el pedido, y sin romper el .ass."""
    t = str(w or "").strip().lower()
    return t.replace("\\", "").replace("{", "(").replace("}", ")")


def bloques(palabras, por_bloque=3):
    """
    Agrupa las palabras en bloques cortos. Corta antes de tiempo cuando hay una
    pausa: juntar dos ideas separadas por un silencio en el mismo cartel se lee
    mal aunque entren las tres palabras.
    """
    salida, actual = [], []
    for i, w in enumerate(palabras or []):
        if not _txt(w.get("word")):
            continue
        actual.append(w)
        ultimo = (i + 1 >= len(palabras))
        hueco = 0 if ultimo else (float(palabras[i + 1].get("start", 0))
                                  - float(w.get("end", 0)))
        if len(actual) >= por_bloque or ultimo or hueco > PAUSA_CORTA:
            salida.append(actual)
            actual = []
    if actual:
        salida.append(actual)
    # Un bloque de una sola palabra se lee como un error, no como un remate.
    # Se pega al anterior salvo que los separe una pausa, que ahi si era a
    # proposito.
    juntos = []
    for b in salida:
        if (juntos and len(b) == 1 and len(juntos[-1]) <= por_bloque
                and float(b[0].get("start", 0)) - float(juntos[-1][-1].get("end", 0))
                <= PAUSA_CORTA):
            juntos[-1].extend(b)
        else:
            juntos.append(b)
    return juntos


def _t(seg):
    seg = max(0.0, float(seg))
    h = int(seg // 3600); m = int((seg % 3600) // 60)
    s = seg % 60
    return "%d:%02d:%05.2f" % (h, m, s)


def armar_ass(palabras, ancho, alto, por_bloque=3, alto_rel=0.42,
              tam_rel=0.055, margen_rel=0.10, resaltar=None):
    """
    Devuelve el .ass completo.

    ancho/alto: los del video. Todo se calcula como proporcion de eso —tamano,
    altura, margenes— para que se vea igual en 9:16 y en 16:9. Un numero fijo de
    pixeles se rompe apenas cambia la resolucion.

    alto_rel: donde queda el texto, medido desde arriba. 0.42 es la altura del
    pecho: lejos del nombre de usuario y el timer de arriba, y lejos del caption
    y el boton de CTA que la plataforma superpone abajo en un anuncio.

    resaltar: palabras que van en otro color. Hoy no se usa; queda aceptado para
    no tener que rehacer el generador cuando aparezca.
    """
    tam = max(12, int(round(alto * tam_rel)))
    mv = int(round(alto * alto_rel))
    mh = int(round(ancho * margen_rel))
    res = set(re.sub(r"[^a-z0-9]", "", str(x).lower()) for x in (resaltar or []))

    cab = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "PlayResX: %d" % ancho,
        "PlayResY: %d" % alto,
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding",
        # Alignment 8 = arriba y centrado. Con 5 (centro) libass ignora MarginV
        # y no hay forma de fijar la altura exacta.
        "Style: Karaoke,Montserrat ExtraBold,%d,&H00FFFFFF,&H00FFFFFF,&H00000000,"
        "&H00000000,0,0,0,0,100,100,0,0,1,%d,0,8,%d,%d,%d,1"
        % (tam, max(2, int(round(tam * 0.09))), mh, mh, mv),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    lineas = []
    bls = bloques(palabras, por_bloque)
    for bi, b in enumerate(bls):
        sigue = bls[bi + 1][0] if bi + 1 < len(bls) else None
        for k in range(len(b)):
            visible = " ".join(_txt(w.get("word")) for w in b[:k + 1])
            ini = float(b[k].get("start", 0))
            if k + 1 < len(b):
                fin = float(b[k + 1].get("start", 0))
            else:
                # El ultimo pedazo del bloque se queda hasta que arranca el
                # siguiente, pero no mas de COLA_MAX despues de dejar de hablar.
                fin = float(b[k].get("end", 0)) + COLA_MAX
                if sigue is not None:
                    fin = min(fin, float(sigue.get("start", 0)))
            if fin <= ini:
                fin = ini + 0.12
            lineas.append("Dialogue: 0,%s,%s,Karaoke,,0,0,0,,%s"
                          % (_t(ini), _t(fin), visible))
    return "\n".join(cab + lineas) + "\n"


def escribir_ass(palabras, ancho, alto, ruta, **kw):
    with open(ruta, "w", encoding="utf-8") as f:
        f.write(armar_ass(palabras, ancho, alto, **kw))
    return ruta
