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
