#!/usr/bin/env python3
"""
guion.py - comparar lo que se dijo contra lo que se iba a decir.

Sin guion, el motor solo puede razonar sobre la transcripcion: sabe que una
frase se repitio, pero no cual de los dos intentos era el bueno, y se queda con
el ultimo por descarte. Con el guion puede quedarse con el que mas se le parece,
marcar donde empieza cada bloque, y avisar cual no se dijo.

Todo con difflib de la biblioteca estandar: no hace falta nada instalado, y para
mil palabras contra diez bloques el costo es despreciable.
"""
import difflib
import re
import unicodedata


def _n(t):
    t = unicodedata.normalize("NFD", str(t or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "", t)


def _claves(palabras):
    return [_n(w.get("word")) for w in (palabras or [])]


def _pal(texto):
    return [_n(x) for x in str(texto or "").split() if _n(x)]


def bloques(texto):
    """
    Un bloque por parrafo. Es como se escribe un guion de video —cada idea
    separada por un salto— y no hace falta pedirle ningun formato especial.
    """
    crudos = re.split(r"\\n\\s*\\n|\n\s*\n", str(texto or ""))
    salida = []
    for b in crudos:
        b = b.strip()
        if not b:
            continue
        # El titulo es el arranque, que es con lo que se reconoce el bloque de
        # un vistazo en la pantalla.
        titulo = " ".join(b.split())[:70]
        salida.append({"titulo": titulo, "texto": b, "palabras": _pal(b)})
    return [b for b in salida if b["palabras"]]


def _ubicar(claves_tr, claves_bl, desde=0):
    """
    Donde arranca ese bloque en la transcripcion, buscando de `desde` en
    adelante. Se usa el tramo comun mas largo como ancla: nadie dice el guion
    palabra por palabra, pero si suele clavar una frase entera.
    """
    if not claves_bl or desde >= len(claves_tr):
        return None
    sm = difflib.SequenceMatcher(a=claves_tr[desde:], b=claves_bl, autojunk=False)
    m = sm.find_longest_match(0, len(claves_tr) - desde, 0, len(claves_bl))
    if not m.size:
        return None
    return {"i": desde + m.a, "size": m.size,
            "score": round(m.size / float(len(claves_bl)), 3)}


def mapa(palabras, texto_guion, minimo=0.22):
    """
    Cada bloque del guion con el momento en que arranca.

    Se busca en orden y siempre hacia adelante: un guion se dice en el orden en
    que esta escrito, y permitir que un bloque aparezca antes que el anterior
    solo genera falsos positivos con las muletillas y las frases hechas.

    El fin de cada bloque es el arranque del siguiente. Es una aproximacion, y
    es la buena: marcar el fin por el ultimo match dejaria agujeros justo en lo
    que la persona improviso, que es contenido igual.
    """
    bls = bloques(texto_guion)
    if not bls or not palabras:
        return []
    claves = _claves(palabras)
    cursor = 0
    salida = []
    for b in bls:
        u = _ubicar(claves, b["palabras"], cursor)
        encontrado = bool(u and u["score"] >= minimo)
        salida.append({"titulo": b["titulo"],
                       "i": (u or {}).get("i"),
                       "score": (u or {}).get("score", 0),
                       "encontrado": encontrado})
        if encontrado:
            cursor = u["i"] + u["size"]
    # Los tiempos se resuelven al final, cuando ya se sabe donde arranca el que
    # sigue.
    vistos = [s for s in salida if s["encontrado"]]
    for k, s in enumerate(vistos):
        s["inicio"] = round(float(palabras[s["i"]].get("start", 0)), 2)
        sig = vistos[k + 1]["i"] if k + 1 < len(vistos) else len(palabras) - 1
        s["fin"] = round(float(palabras[max(sig - 1, s["i"])].get("end", 0)), 2)
    for s in salida:
        s.pop("i", None)
        if not s["encontrado"]:
            s["inicio"] = None
            s["fin"] = None
    return salida


def elegir_peor(palabras, i1, i2, largo, texto_guion):
    """
    De dos intentos de la misma frase, cual sacar.

    Sin guion se saca el primero, que es la apuesta razonable: si lo repetiste
    es porque el primero salio mal. Con guion se compara cada intento contra el
    texto y se saca el que menos se le parece, que a veces es el segundo —te
    trabaste en la repeticion y la buena habia sido la primera.
    """
    ref = _pal(texto_guion)
    if not ref:
        return i1
    claves = _claves(palabras)
    def parecido(i):
        trozo = claves[i:i + largo]
        u = _ubicar(ref, trozo)
        return (u or {}).get("score", 0)
    return i1 if parecido(i1) <= parecido(i2) else i2


# ------------------------------------------------------- varios en uno ------

# Como se separa un guion del siguiente adentro del mismo archivo. En orden de
# confianza: lo mas explicito primero. El renglon en blanco NO sirve como
# separador porque ya separa bloques adentro de un guion.
_SEPARADORES = [
    # ## Titulo   /   # Titulo
    (r"^\s{0,3}#{1,4}\s+(?P<t>\S.*?)\s*$", "titulo"),
    # Numerados, en las dos formas que aparecen en un mismo documento:
    #   Body 1 - El escaneo   /   Hook 2   /   Cierre 3
    #   01 Si tenes una PyME que factura bien...
    # Van juntos a proposito: un documento real usa las dos, y probandolas por
    # separado gana la primera y la otra mitad de los guiones se pierde.
    # La linea entra al cuerpo porque el texto ya empezo ahi.
    (r"^\s{0,3}(?P<t>(?:(?:body|hook|gancho|cuerpo|cierre)\s*\d+\b.*"
     r"|\d{1,2}\s+\S+(?:\s+\S+){2,}.*))\s*$", "contenido"),
    # GUION 3 - algo   /   Guion 3:   /   Pieza 2   /   Reel 4
    (r"^\s{0,3}(?P<t>(?:gui[oó]n|pieza|video|reel|anuncio|spot)\s*"
     r"(?:n[°º]?\s*)?\d+\s*[-–—:.)]?.*?)\s*$", "titulo"),
    # 1. Titulo corto   /   2) Titulo corto
    (r"^\s{0,3}(?P<t>\d{1,2}\s*[.)]\s+\S.{0,70})\s*$", "titulo"),
    # --- o ***  (raya sola: el titulo es el primer renglon de lo que sigue)
    (r"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$", "raya"),
]


def _por_encabezado(lineas, rx, incluir=False):
    """
    El marcador ARRANCA cada guion, asi que hacen falta dos para creerlo.

    incluir: si la linea del marcador es tambien la primera del guion. Con "## "
    el rotulo se descarta; con "01 Si tenes una PyME..." el texto ya empezo ahi
    y descartarlo se come la primera frase.
    """
    cortes = [(i, (m.groupdict().get("t") or "").strip())
              for i, l in enumerate(lineas) for m in [rx.match(l)] if m]
    if len(cortes) < 2:
        return []
    partes = []
    for k, (i, titulo) in enumerate(cortes):
        fin = cortes[k + 1][0] if k + 1 < len(cortes) else len(lineas)
        cuerpo = "\n".join(lineas[i if incluir else i + 1:fin]).strip()
        if cuerpo:
            partes.append({"titulo": titulo, "texto": cuerpo})
    return partes


def _por_raya(lineas, rx):
    """
    La raya va ENTRE guiones, no al principio: con dos guiones hay una sola.
    Ademas lo que esta antes de la primera raya tambien es un guion, al reves
    que con los encabezados.
    """
    grupos, actual = [], []
    hubo = False
    for l in lineas:
        if rx.match(l):
            hubo = True
            grupos.append(actual)
            actual = []
        else:
            actual.append(l)
    grupos.append(actual)
    if not hubo:
        return []
    partes = []
    for g in grupos:
        vivos = [c for c in g if c.strip()]
        if not vivos:
            continue
        partes.append({"titulo": vivos[0].strip(), "texto": "\n".join(g).strip()})
    return partes


# Un renglon con una sola palabra capitalizada, en el medio del cuerpo, es un
# rotulo de seccion del documento ("Hooks", "Bodies", "Cierres"). Nadie lo dice
# en camara, asi que lo que viene despues no es parte de este guion.
_ROTULO = re.compile(r"^\s*[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]{2,14}\s*:?\s*$")


def _cortar_en_rotulo(texto):
    lineas = texto.split("\n")
    for i, l in enumerate(lineas):
        if i > 0 and _ROTULO.match(l):
            return "\n".join(lineas[:i]).strip()
    return texto


def separar(texto):
    """
    Parte un archivo con varios guiones adentro.

    Los clientes reciben una lista de guiones en un solo documento y lo
    devuelven asi, sin rotular nada mas. Se prueba un separador por vez y se usa
    el primero que encuentre al menos dos partes: mezclar criterios parte de
    mas, y un guion cortado al medio despues no calza con ningun video.

    Si no encuentra ninguno, devuelve el archivo entero como un solo guion, que
    es lo correcto: mejor una pieza larga que cinco pedazos arbitrarios.
    """
    txt = str(texto or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not txt:
        return []
    lineas = txt.split("\n")

    for patron, clase in _SEPARADORES:
        rx = re.compile(patron, re.I)
        if clase == "raya":
            partes = _por_raya(lineas, rx)
        else:
            partes = _por_encabezado(lineas, rx, incluir=(clase == "contenido"))
        # Lo que hubiera antes del primer encabezado es titulo del documento, no
        # un guion: _por_encabezado lo descarta a proposito.
        if len(partes) >= 2:
            for k, p in enumerate(partes):
                p["titulo"] = (p["titulo"] or ("Guion %d" % (k + 1)))[:80]
                p["texto"] = _cortar_en_rotulo(p["texto"])
            return [p for p in partes if p["texto"]]

    return [{"titulo": (lineas[0].strip() or "Guion")[:80], "texto": txt}]
