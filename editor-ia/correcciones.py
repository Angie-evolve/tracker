#!/usr/bin/env python3
"""
correcciones.py - que hizo distinto la persona.

Si alguien sube su corte final, no hace falta que marque nada: comparando su
transcripcion contra la del crudo se sabe exactamente que se llevo y que dejo, y
comparando eso contra lo que corto la maquina salen las dos correcciones que
importan:

  no_iba   la maquina lo saco y la persona lo dejo  -> cortamos de mas
  faltaba  la maquina lo dejo y la persona lo saco  -> cortamos de menos

Por eso conviene pedir el video TERMINADO y no una grabacion de pantalla del
proceso: el resultado es una respuesta exacta y el proceso hay que interpretarlo.
"""
import difflib
import re
import unicodedata


def _n(t):
    t = unicodedata.normalize("NFD", str(t or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "", t)


def _quedaron(palabras_orig, palabras_corr):
    """
    Cuales palabras del original sobrevivieron en el corte de la persona.

    Se alinean las dos transcripciones y no se comparan tiempos: el corte
    corrido cambia todos los tiempos, pero las palabras siguen siendo las
    mismas y en el mismo orden.
    """
    a = [_n(w.get("word")) for w in (palabras_orig or [])]
    b = [_n(w.get("word")) for w in (palabras_corr or [])]
    vivos = [False] * len(a)
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for etiqueta, i1, i2, j1, j2 in sm.get_opcodes():
        if etiqueta == "equal":
            for i in range(i1, i2):
                vivos[i] = True
    return vivos


def _en_clips(w, clips):
    m = (float(w.get("start", 0)) + float(w.get("end", 0))) / 2.0
    for c in (clips or []):
        if float(c.get("inicio", 0)) <= m < float(c.get("fin", 0)):
            return True
    return False


def comparar(palabras_orig, clips, palabras_corr, min_palabras=3):
    """
    Devuelve los tramos donde la maquina y la persona no coincidieron.

    min_palabras: una palabra suelta de diferencia casi siempre es la
    transcripcion que escucho distinto, no una decision de edicion. Recien un
    par de palabras seguidas es una senal.
    """
    if not palabras_orig:
        return []
    vivos = _quedaron(palabras_orig, palabras_corr)
    verdicto = []
    for i, w in enumerate(palabras_orig):
        maq = _en_clips(w, clips)
        per = vivos[i]
        if maq == per:
            verdicto.append(None)
        else:
            verdicto.append("no_iba" if per else "faltaba")

    salida, i = [], 0
    n = len(verdicto)
    while i < n:
        if verdicto[i] is None:
            i += 1
            continue
        j = i
        while j + 1 < n and verdicto[j + 1] == verdicto[i]:
            j += 1
        if (j - i + 1) >= min_palabras:
            salida.append({
                "tipo": verdicto[i],
                "inicio": round(float(palabras_orig[i].get("start", 0)), 2),
                "fin": round(float(palabras_orig[j].get("end", 0)), 2),
                "texto": " ".join(str(palabras_orig[k].get("word", ""))
                                  for k in range(i, j + 1))[:300],
            })
        i = j + 1
    return salida
