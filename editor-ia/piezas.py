#!/usr/bin/env python3
"""
piezas.py - repartir varios guiones entre varios videos.

El caso real: al cliente se le mandan cinco guiones y devuelve lo que le sale.
A veces un video largo con los cinco seguidos, a veces cinco archivos, a veces
tres archivos con dos guiones adentro de uno. Nadie rotula nada.

Asi que no se empareja por nombre de archivo —nunca coinciden— sino por lo que
se dice: cada guion se busca en la transcripcion de cada video y se queda donde
mejor calza. Lo que sobra se avisa en vez de desaparecer: un guion que no se
grabo y un tramo de video que no corresponde a ningun guion son las dos cosas
que hay que saber antes de entregar.
"""
import guion as G


def _cobertura(palabras, texto):
    """Que parte del guion aparece en esta transcripcion, y donde."""
    bls = G.mapa(palabras, texto)
    if not bls:
        return None
    vistos = [b for b in bls if b["encontrado"]]
    if not vistos:
        return {"score": 0.0, "inicio": None, "fin": None, "bloques": bls}
    # El score es continuo y no la fraccion de bloques encontrados: con 31 clips
    # que son cuatro tomas del mismo guion, la fraccion da 1.00 en todas y gana
    # cualquiera. Promediando cuanto se dijo de cada bloque gana la toma mas
    # completa, que es la que hay que entregar.
    return {"score": round(sum(b.get("score", 0) for b in bls) / float(len(bls)), 3),
            "inicio": vistos[0]["inicio"],
            "fin": vistos[-1]["fin"],
            "bloques": bls}


def repartir(videos, guiones, minimo=0.35):
    """
    videos:  [{"id":..., "palabras":[...], "duracion":float}]
    guiones: [{"titulo":..., "texto":...}]

    Devuelve (piezas, sin_grabar) donde cada pieza es
    {"video", "titulo", "inicio", "fin", "score", "bloques"}.

    Cada guion va a UN solo video: el que mejor lo contiene. Si el mismo guion
    calzara en dos, es que se grabo dos veces, y entregar las dos tomas seria
    entregar basura.
    """
    candidatos = []
    for g in (guiones or []):
        mejor = None
        for v in (videos or []):
            c = _cobertura(v.get("palabras") or [], g.get("texto") or "")
            if not c:
                continue
            if not mejor or c["score"] > mejor["score"]:
                mejor = dict(c, video=v.get("id"))
        if mejor and mejor["score"] >= minimo and mejor["inicio"] is not None:
            candidatos.append({"video": mejor["video"],
                               "titulo": g.get("titulo") or "Pieza",
                               "inicio": mejor["inicio"], "fin": mejor["fin"],
                               "score": mejor["score"], "bloques": mejor["bloques"]})
        else:
            candidatos.append({"video": None, "titulo": g.get("titulo") or "Pieza",
                               "score": (mejor or {}).get("score", 0)})

    piezas = [c for c in candidatos if c["video"] is not None]
    sin_grabar = [{"titulo": c["titulo"], "score": c["score"]}
                  for c in candidatos if c["video"] is None]

    # Los videos que no quedaron en ninguna pieza. Con 31 clips y 8 guiones son
    # las otras tomas, y desaparecer 23 archivos en silencio seria peor que
    # entregar de mas: se listan con a que guion se parecian.
    usados = set(p["video"] for p in piezas)
    descartados = []
    for v in (videos or []):
        if v.get("id") in usados:
            continue
        mejor, tit = 0.0, ""
        for g in (guiones or []):
            c = _cobertura(v.get("palabras") or [], g.get("texto") or "")
            if c and c["score"] > mejor:
                mejor, tit = c["score"], g.get("titulo") or ""
        descartados.append({"video": v.get("id"), "parecido_a": tit,
                            "score": round(mejor, 3),
                            "duracion": round(float(v.get("duracion") or 0), 1)})

    # Adentro de cada video las piezas van una atras de la otra. El fin que trae
    # cada una llega hasta el final de la transcripcion —el mapa no sabe que
    # viene otro guion despues— asi que se recorta contra el arranque del que
    # sigue. Sin esto la primera pieza se lleva el video entero.
    dur = {v.get("id"): v.get("duracion") for v in (videos or [])}
    for vid in set(p["video"] for p in piezas):
        enEste = sorted([p for p in piezas if p["video"] == vid],
                        key=lambda p: p["inicio"])
        for i, p in enumerate(enEste):
            if i + 1 < len(enEste):
                p["fin"] = min(p["fin"], enEste[i + 1]["inicio"])
            elif dur.get(vid):
                # La ultima llega hasta el final: lo que se dijo despues del
                # ultimo bloque suele ser el cierre, no descarte.
                p["fin"] = max(p["fin"], min(p["fin"], dur[vid]))
        for p in enEste:
            p["duracion"] = round(max(0.0, p["fin"] - p["inicio"]), 2)
    return piezas, sin_grabar, descartados


def huerfanos(videos, piezas, minimo=8.0):
    """
    Tramos de video que no quedaron dentro de ninguna pieza.

    Casi siempre es la charla de antes de arrancar, y esta bien tirarla. Pero a
    veces es un guion que el cliente improviso, y ahi hay que mirarlo: por eso
    se avisan en vez de borrarlos en silencio.
    """
    fuera = []
    for v in (videos or []):
        dur = float(v.get("duracion") or 0)
        if dur <= 0:
            continue
        # Una pieza se arma con tramos de varios clips, asi que lo tomado de
        # este video hay que juntarlo de todas las piezas que lo usan.
        tomados = sorted([(t["inicio"], t["fin"])
                          for p in piezas for t in (p.get("tramos") or [])
                          if t.get("video") == v.get("id")])
        cursor = 0.0
        for a, b in tomados:
            if a - cursor >= minimo:
                fuera.append({"video": v.get("id"), "inicio": round(cursor, 2),
                              "fin": round(a, 2)})
            cursor = max(cursor, b)
        if dur - cursor >= minimo:
            fuera.append({"video": v.get("id"), "inicio": round(cursor, 2),
                          "fin": round(dur, 2)})
    return fuera


# ------------------------------------------------------------- ensamblar ----

def _tiempos(palabras, i, size):
    return (round(float(palabras[i].get("start", 0)), 2),
            round(float(palabras[min(i + size - 1, len(palabras) - 1)].get("end", 0)), 2))


def armar(videos, guiones, minimo=0.10, min_palabras=4, borde=1.5):
    """
    Arma cada guion juntando los clips que dicen sus bloques, en orden.

    Es como filma la gente de verdad: un parrafo por toma, se corta, se acomoda
    y se graba el siguiente. Medido sobre un rodaje real de 31 clips y 6
    guiones, cada bloque cayo en un archivo distinto y consecutivo.

    La version anterior buscaba el guion ENTERO adentro de un solo video. Con
    este material no encontraba nada, porque ningun clip contiene un guion
    completo.

    minimo: cuanto tiene que reconocerse un bloque para darlo por dicho. Va bajo
    a proposito: la transcripcion automatica destroza los nombres propios —"En
    Potential" sale "Empotencia"— y exigir mucho deja todo afuera.
    min_palabras: un bloque de una o dos palabras calza con cualquier cosa. Casi
    siempre es un titulo que quedo partido en el PDF, no algo que alguien diga.
    """
    # Los clips vienen en orden de rodaje, y un guion se graba de arriba abajo:
    # el bloque 2 se filmo despues del bloque 1. Esa restriccion es la que
    # permite bajar el umbral sin empezar a inventar coincidencias, y de paso
    # evita que un mismo clip de cierre se lo lleven tres guiones distintos
    # porque los tres terminan parecido.
    claves = [G._claves(v.get("palabras") or []) for v in (videos or [])]

    porBloque = []
    for gi, g in enumerate(guiones or []):
        cursor = 0
        for bi, b in enumerate(G.bloques(g.get("texto") or "")):
            if len(b["palabras"]) < min_palabras:
                continue
            mejor, mejorGlobal = None, None
            for k, v in enumerate(videos or []):
                u = G._ubicar(claves[k], b["palabras"])
                if not u:
                    continue
                cand = dict(u, video=v.get("id"), k=k)
                if not mejorGlobal or u["score"] > mejorGlobal["score"]:
                    mejorGlobal = cand
                if k >= cursor and (not mejor or u["score"] > mejor["score"]):
                    mejor = cand
            # Primero el mejor de aca en adelante. Si ninguno llega, se acepta
            # el mejor de todos pero exigiendole mas: puede ser una toma que se
            # rehizo fuera de orden.
            elegido = None
            if mejor and mejor["score"] >= minimo:
                elegido = mejor
            elif mejorGlobal and mejorGlobal["score"] >= minimo * 2:
                elegido = mejorGlobal
            if not elegido:
                continue
            cursor = elegido["k"] + 1
            porBloque.append({"guion": gi, "orden": bi, "video": elegido["video"],
                              "i": elegido["i"], "size": elegido["size"],
                              "score": round(elegido["score"], 3),
                              "titulo": b["titulo"]})

    porId = {v.get("id"): v for v in (videos or [])}

    # Cuanto del clip se lleva cada bloque. Si el clip entero es ese bloque
    # —que es el caso normal— se toma completo: recortar por donde calzo la
    # transcripcion se come el arranque y el cierre de la frase.
    for vid, v in porId.items():
        mios = sorted([x for x in porBloque if x["video"] == vid], key=lambda x: x["i"])
        dur = float(v.get("duracion") or 0)
        pal = v.get("palabras") or []
        for k, x in enumerate(mios):
            a, b = _tiempos(pal, x["i"], x["size"])
            if len(mios) == 1:
                x["inicio"], x["fin"] = 0.0, dur
            else:
                x["inicio"] = 0.0 if (k == 0 and a <= borde) else a
                x["fin"] = dur if (k == len(mios) - 1 and dur - b <= borde) else b

    piezas, sin_grabar = [], []
    for gi, g in enumerate(guiones or []):
        tramos = sorted([x for x in porBloque if x["guion"] == gi],
                        key=lambda x: x["orden"])
        if not tramos:
            sin_grabar.append({"titulo": g.get("titulo") or "Guion", "score": 0})
            continue
        total = sorted(set(b["titulo"] for b in G.bloques(g.get("texto") or "")
                           if len(b["palabras"]) >= min_palabras))
        piezas.append({
            "titulo": g.get("titulo") or "Guion",
            "tramos": [{"video": t["video"], "inicio": t["inicio"], "fin": t["fin"],
                        "score": t["score"], "bloque": t["titulo"][:70]} for t in tramos],
            "duracion": round(sum(t["fin"] - t["inicio"] for t in tramos), 2),
            "bloques": len(tramos), "bloques_total": len(total),
            "score": round(sum(t["score"] for t in tramos) / float(len(tramos)), 3),
        })

    usados = set(x["video"] for x in porBloque)
    descartados = [{"video": v.get("id"),
                    "duracion": round(float(v.get("duracion") or 0), 1)}
                   for v in (videos or []) if v.get("id") not in usados]
    return piezas, sin_grabar, descartados
