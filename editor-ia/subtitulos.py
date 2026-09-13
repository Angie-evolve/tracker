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
import unicodedata

# Cuanto puede quedar una palabra sola en pantalla antes de que se sienta
# colgada. Si la persona duda tres segundos, el cartel no se queda esperando.
COLA_MAX = 0.6
# Una pausa mas larga que esto corta el bloque: son dos ideas, no una.
PAUSA_CORTA = 0.75


def _txt(w):
    """Lo que se muestra. En minuscula, que es el pedido, y sin romper el .ass."""
    t = str(w or "").strip().lower()
    return t.replace("\\", "").replace("{", "(").replace("}", ")")


# Palabras que se apoyan en la que viene despues. Cortar el cartel justo aca
# deja colgado un "a la" o un "de los" que no significa nada solo. Van sin
# acento: la comparacion normaliza antes.
LIGADURAS = set("""
el la los las un una unos unas lo al del
a ante bajo con contra de desde durante en entre hacia hasta mediante para por
segun sin sobre tras
y e o u ni que si pero aunque porque como cuando donde mientras
mi tu su mis tus sus nuestro nuestra su sus
me te se nos le les lo la
muy mas tan
""".split())

# Cuanto se puede apartar del largo ideal. Menos de dos palabras el cartel
# parpadea; mas de cuatro deja de ser el karaoke corto y pasa a ser un
# subtitulo de frase entera.
MIN_BLOQUE, MAX_BLOQUE = 2, 4


def _limpio(t):
    t = unicodedata.normalize("NFD", str(t or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "", t)


def _cierre(t):
    """Con que signo termina la palabra, si termina con alguno."""
    t = str(t or "").strip()
    if t.endswith((".", "?", "!", "\u2026")):
        return "fuerte"
    if t.endswith((",", ";", ":")):
        return "flojo"
    return ""


def _puntaje(palabras, i, j, ideal):
    """
    Que tan bien queda cortar el cartel despues de la palabra j.

    Se puntua el LUGAR del corte, no la cantidad: el problema de contar de a
    tres fijo era que partia frases al medio ("que hacer? Un" / "mal lider
    no"). El largo entra igual, pero como preferencia y no como regla.
    """
    p = 0.0
    fin = _cierre(palabras[j].get("word"))
    if fin == "fuerte":
        p += 3.0
    elif fin == "flojo":
        p += 2.0
    # Nunca dejar colgada una palabra que se apoya en la siguiente.
    if _limpio(palabras[j].get("word")) in LIGADURAS:
        p -= 3.0
    # Una pausa real es el mejor lugar posible: ahi la persona ya separo.
    if j + 1 < len(palabras):
        hueco = float(palabras[j + 1].get("start", 0)) - float(palabras[j].get("end", 0))
        if hueco > 0.25:
            p += 1.5
    # Y que no quede una sola palabra suelta al final de todo.
    if len(palabras) - (j + 1) == 1 and fin != "fuerte":
        p -= 1.5
    p -= 0.5 * abs((j - i + 1) - ideal)
    return p


def bloques(palabras, por_bloque=3):
    """
    Agrupa las palabras en carteles cortos, cortando donde conviene.

    Antes cortaba cada N palabras exactas, y eso partia las frases al medio. Lo
    que se elige ahora es el LUGAR: despues de un punto o una coma, en una
    pausa, y nunca despues de un articulo o una preposicion, que no significan
    nada separados de lo que viene. El largo sigue rondando N, pero como
    preferencia.
    """
    palabras = [w for w in (palabras or []) if _txt(w.get("word"))]
    if not palabras:
        return []
    tope = max(MAX_BLOQUE, por_bloque)
    piso = min(MIN_BLOQUE, por_bloque)

    salida, i = [], 0
    n = len(palabras)
    while i < n:
        # Una pausa larga corta si o si: son dos ideas, no una, y juntarlas en
        # el mismo cartel se lee mal aunque entren.
        corte = None
        for j in range(i, min(i + tope, n)):
            if j + 1 < n and (float(palabras[j + 1].get("start", 0))
                              - float(palabras[j].get("end", 0))) > PAUSA_CORTA:
                corte = j
                break
        if corte is None:
            ultimo = min(i + tope, n) - 1
            if ultimo >= n - 1:
                corte = n - 1
            else:
                opciones = range(min(i + piso, n) - 1, ultimo + 1)
                corte = max(opciones, key=lambda j: _puntaje(palabras, i, j, por_bloque))
        salida.append(palabras[i:corte + 1])
        i = corte + 1

    # Un cartel de una sola palabra se lee como un error y no como un remate. Se
    # pega al anterior salvo que los separe una pausa, que ahi si era a proposito.
    juntos = []
    for b in salida:
        if (juntos and len(b) == 1 and len(juntos[-1]) < tope
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


def armar_ass(palabras, ancho, alto, por_bloque=3, fondo_rel=0.645,
              tam_rel=0.055, margen_rel=0.10, tracking_rel=-0.045,
              borde_rel=0.012, blur=3, resaltar=None):
    """
    Devuelve el .ass completo.

    ancho/alto: los del video. Todo se calcula como proporcion de eso —tamano,
    altura, margenes— para que se vea igual en 9:16 y en 16:9. Un numero fijo de
    pixeles se rompe apenas cambia la resolucion.

    fondo_rel: donde termina ABAJO el texto, medido desde arriba. Meta unifico en
    marzo de 2026 una sola zona segura 9:16 —14% arriba, 35% abajo, 6% a los
    lados— asi que lo que se publica tiene que vivir entre 14% y 65%. 0.645 deja
    el cartel lo mas abajo posible sin cruzar esa linea.

    Se ancla por ABAJO y no por arriba a proposito: si un bloque necesita dos
    renglones, crece hacia arriba y sigue adentro. Anclado por arriba, el
    renglon de mas lo empujaba justo a la zona que Meta tapa.

    resaltar: palabras que van en otro color. Hoy no se usa; queda aceptado para
    no tener que rehacer el generador cuando aparezca.
    """
    tam = max(12, int(round(alto * tam_rel)))
    # MarginV con alineacion abajo se mide desde el borde inferior.
    mv = max(0, int(round(alto * (1.0 - fondo_rel))))
    mh = int(round(ancho * margen_rel))
    # Las letras del diseño van casi pegadas. Spacing negativo, en proporcion al
    # cuerpo: un valor fijo en pixeles aprieta de mas en un video chico.
    track = round(tam * tracking_rel, 1)
    # Casi sin borde. En el diseño no hay contorno: lo que despega el texto de
    # una remera gris es una sombra difusa, no una linea negra. Un borde marcado
    # convierte el cartel en otra cosa.
    borde = max(1, int(round(tam * borde_rel)))
    sombra = max(1, int(round(tam * 0.022)))
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
        # Poppins y no Montserrat: en el diseño la "a" es de un solo piso, que es
        # lo que distingue una geometrica de una grotesca. Montserrat la tiene de
        # dos pisos y por eso no se parecia.
        # Alignment 2 = abajo y centrado: el MarginV fija el borde INFERIOR del
        # cartel, que es el que no puede cruzar la zona segura.
        # Bold=-1 es "si" en ASS: selecciona la cara Bold de la familia Poppins.
        "Style: Karaoke,Poppins,%d,&H00FFFFFF,&H00FFFFFF,&H50000000,"
        "&H78000000,-1,0,0,0,100,100,%s,0,1,%d,%d,2,%d,%d,%d,1"
        % (tam, track, borde, sombra, mh, mh, mv),
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
            # \blur difumina borde y sombra. Es lo que hace que el canto se
            # lea como un halo y no como un contorno dibujado.
            lineas.append("Dialogue: 0,%s,%s,Karaoke,,0,0,0,,{\\blur%s}%s"
                          % (_t(ini), _t(fin), blur, visible))
    return "\n".join(cab + lineas) + "\n"


def escribir_ass(palabras, ancho, alto, ruta, **kw):
    with open(ruta, "w", encoding="utf-8") as f:
        f.write(armar_ass(palabras, ancho, alto, **kw))
    return ruta
