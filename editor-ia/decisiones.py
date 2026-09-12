#!/usr/bin/env python3
"""
decisiones.py - que se saca y que se deja.

auto_editor.py sabe una sola cosa: donde baja el audio. Eso alcanza para sacar
aire muerto y nada mas. Este modulo trabaja sobre la transcripcion con tiempos
por palabra, que es lo unico que permite decidir por lo que se DICE: sacar
muletillas, quedarse con la ultima toma de una frase repetida, respetar un
remate.

La forma de razonar es siempre la misma: se junta una lista de tramos a SACAR
—vengan de donde vengan— y recien al final se invierte en la lista de lo que se
conserva. Asi cada criterio nuevo es una funcion que agrega tramos, y no hay que
tocar el resto.
"""
import difflib
import re
import unicodedata

# Las de siempre en rioplatense. Es el default; el formato de edicion las pisa.
MULETILLAS = ["eh", "ehh", "em", "este", "o sea", "digamos", "viste", "nada",
              "tipo", "bueno", "mmm", "ah"]


def _n(t):
    """Sin acentos, sin puntuacion, en minuscula: 'Eh,' y 'eh' son la misma."""
    t = unicodedata.normalize("NFD", str(t or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "", t)


# ---------------------------------------------------------------- tramos ----

def unir(tramos, pegar=0.05):
    """
    Junta los tramos que se tocan o casi. Sin esto, dos silencios separados por
    una muletilla quedan como tres cortes y el video sale picado.
    """
    if not tramos:
        return []
    orden = sorted((float(a), float(b)) for a, b in tramos if b > a)
    salida = [list(orden[0])]
    for a, b in orden[1:]:
        if a - salida[-1][1] <= pegar:
            salida[-1][1] = max(salida[-1][1], b)
        else:
            salida.append([a, b])
    return [(round(a, 3), round(b, 3)) for a, b in salida]


def conservar(duracion, sacar, aire=0.12, clip_min=0.3, exacto=None):
    """
    Invierte "lo que se saca" en "lo que queda".

    aire: cuanto se le devuelve a cada lado del corte. Sin esto se come la
    ultima silaba antes de la pausa y la primera despues, que es exactamente lo
    que hace que un corte automatico suene a corte automatico.

    exacto: tramos que se sacan SIN devolverles aire. Son los que salen de la
    transcripcion —una muletilla, una toma repetida—: ahi no hay que proteger
    ningun borde, hay que sacar la palabra completa. Devolviendole aire quedaba
    el arranque del "eh" pegado al clip anterior, y encima la palabra seguia
    apareciendo en el subtitulo.
    """
    tramos = []
    for a, b in unir(sacar):
        a2, b2 = a + aire, b - aire
        if b2 > a2:
            tramos.append((a2, b2))
    tramos = unir(tramos + list(exacto or []))

    clips, cursor = [], 0.0
    for a, b in tramos:
        if a - cursor >= clip_min:
            clips.append((round(cursor, 3), round(a, 3)))
        cursor = max(cursor, b)
    if duracion - cursor >= clip_min:
        clips.append((round(cursor, 3), round(duracion, 3)))
    return clips


def duracion_total(clips):
    return round(sum(b - a for a, b in clips), 3)


# ------------------------------------------------------------ muletillas ----

def tramos_muletillas(palabras, lista=None, margen=0.03):
    """
    Los tiempos de cada muletilla. Solo palabras enteras: 'este' se saca,
    'estera' no. Las de mas de una palabra ('o sea', 'digamos que') se buscan
    como secuencia; mirando de a una nunca calzaban.
    """
    if not palabras:
        return []
    crudas = lista if lista is not None else MULETILLAS
    # Cada muletilla queda como lista de palabras normalizadas.
    frases = []
    for x in crudas:
        partes = [_n(p) for p in str(x or "").split() if _n(p)]
        if partes:
            frases.append(partes)
    if not frases:
        return []
    # Las mas largas primero: 'o sea que' tiene que ganarle a 'o sea'.
    frases.sort(key=len, reverse=True)

    claves = [_n(w.get("word")) for w in palabras]
    n = len(palabras)
    fuera = []
    i = 0
    while i < n:
        for f in frases:
            L = len(f)
            if i + L <= n and claves[i:i + L] == f:
                a = float(palabras[i].get("start", 0)) - margen
                b = float(palabras[i + L - 1].get("end", 0)) + margen
                if b > a:
                    fuera.append((max(a, 0.0), b))
                i += L
                break
        else:
            i += 1
    return unir(fuera)


# ------------------------------------------------------- tomas repetidas ----

def tramos_tomas_repetidas(palabras, minimo=6, ventana=25.0, elegir=None,
                           umbral=0.8):
    """
    Detecta cuando arrancaste una frase, te trabaste y volviste a arrancarla.

    La primera version pedia que los dos intentos fueran identicos palabra por
    palabra. En la vida real nunca lo son —cambia una palabra, o el segundo
    intento arranca con un "eh"— asi que se perdia casi todo lo que importaba y
    solo agarraba lo que la transcripcion habia normalizado igual.

    Ahora se busca un RE-ARRANQUE: se toma el comienzo de una frase y se busca
    mas adelante otro comienzo parecido. Lo que hay en el medio es el intento
    que no salio, y se saca entero, con el traspie incluido.

    minimo: palabras del arranque que se comparan. Con cuatro gatillaba de mas.
    ventana: pasado ese tiempo ya no es un retake, es el tema volviendo.
    umbral: cuanto se tienen que parecer los dos arranques (0 a 1).
    elegir: (i1, i2, largo) -> cual de los dos intentos sacar. Sin esto se saca
    el primero. Con el guion cargado se saca el que menos se le parece.
    """
    n = len(palabras or [])
    if n < minimo * 2:
        return []
    claves = [_n(w.get("word")) for w in palabras]
    t = [float(w.get("start", 0)) for w in palabras]
    fuera = []
    i = 0
    while i + minimo * 2 <= n:
        arranque = claves[i:i + minimo]
        j = None
        for k in range(i + minimo, n - minimo + 1):
            if t[k] - t[i] > ventana:
                break
            if difflib.SequenceMatcher(a=arranque, b=claves[k:k + minimo],
                                       autojunk=False).ratio() >= umbral:
                j = k
                break
        if j is None:
            i += 1
            continue
        # Por defecto se va el primer intento: va de i hasta donde vuelve a
        # arrancar. Si el guion dice que el bueno era ese, se va el segundo, y
        # se le da el mismo largo porque no hay un tercer arranque que lo cierre.
        largo = j - i
        cual = i
        if elegir:
            try:
                cual = elegir(i, j, minimo)
            except Exception:
                cual = i
        ini = cual
        fin_i = min(ini + largo, n) - 1
        a, b = t[ini], float(palabras[fin_i].get("end", 0))
        if b > a and (b - a) <= ventana:
            fuera.append((a, b))
        i = j + minimo
    return unir(fuera)


# ------------------------------------------------ subtitulos de lo cortado ----

def remapear(palabras, clips):
    """
    Pasa los tiempos de la linea de tiempo original a la del video ya cortado.

    Hace falta para el modo render: los subtitulos se calculan sobre el crudo
    —hay que leer el texto para decidir los cortes— pero se muestran sobre el
    cortado. Sin esto aparecen corridos y cada vez peor a medida que avanza.

    Las palabras que caen adentro de un tramo eliminado desaparecen, que es lo
    correcto: en el video ya no se dicen.
    """
    if not clips:
        return []
    # Cuanto dura lo conservado antes de cada clip.
    desde = []
    acum = 0.0
    for a, b in clips:
        desde.append(acum)
        acum += (b - a)

    salida = []
    for w in palabras or []:
        ini = float(w.get("start", 0))
        fin = float(w.get("end", 0))
        # Se ubica por el punto medio y no por el arranque: una palabra que
        # empieza justo antes del corte pero se dice adentro ya no se escucha, y
        # dejarla en el subtitulo es escribir algo que no suena.
        medio = (ini + fin) / 2.0 if fin > ini else ini
        for k, (a, b) in enumerate(clips):
            if a <= medio < b:
                ini2 = min(max(ini, a), b)
                fin2 = min(max(fin, a), b)
                salida.append({
                    "word": w.get("word", ""),
                    "start": round(desde[k] + (ini2 - a), 3),
                    "end": round(desde[k] + (max(fin2, ini2) - a), 3),
                })
                break
    return salida


# --------------------------------------------------------------- planos ----

def subdividir(clips, palabras, cadencia=1.8, zooms=(1.0, 1.12)):
    """
    Parte lo conservado en planos de ~cadencia segundos y le da a cada uno un
    encuadre distinto.

    Esto NO saca tiempo: es un corte visual sobre material que se queda. Es la
    diferencia entre "sacar los silencios" y "editar": un take unico de una
    persona hablando de frente cansa a los veinte segundos aunque no tenga aire
    muerto, y lo que lo sostiene es el cambio de encuadre.

    Se corta en el borde de una palabra y no en el medio: partir una silaba se
    escucha, aunque el audio sea continuo.
    """
    if not clips:
        return []
    if not cadencia or cadencia <= 0:
        return [{"inicio": a, "fin": b, "zoom": zooms[0]} for a, b in clips]

    bordes = sorted(float(w.get("end", 0)) for w in (palabras or []))
    planos = []
    for a, b in clips:
        cortes = [a]
        objetivo = a + cadencia
        for t in bordes:
            if t <= cortes[-1] + 0.2 or t >= b - 0.2:
                continue
            if t >= objetivo:
                cortes.append(t)
                objetivo = t + cadencia
        cortes.append(b)
        # Sin transcripcion en ese tramo se reparte parejo, para no dejar un
        # plano de treinta segundos en el medio de un video cortado a 1.8.
        if len(cortes) == 2 and (b - a) > cadencia * 1.6:
            n = max(2, int(round((b - a) / cadencia)))
            paso = (b - a) / n
            cortes = [a + i * paso for i in range(n)] + [b]
        for i in range(len(cortes) - 1):
            planos.append({"inicio": round(cortes[i], 3),
                           "fin": round(cortes[i + 1], 3),
                           "zoom": zooms[len(planos) % len(zooms)]})
    return planos


def bloque_central(clips, porcion=0.34):
    """
    Donde va el b-roll: el tramo del medio, que es donde el plano fijo mas se
    cae. Se devuelve en tiempos del video YA cortado, que es contra el que se
    monta.
    """
    total = duracion_total(clips)
    if total <= 0:
        return None
    largo = total * porcion
    ini = (total - largo) / 2.0
    return {"inicio": round(ini, 2), "fin": round(ini + largo, 2),
            "duracion": round(largo, 2)}
