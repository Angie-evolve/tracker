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
import difflib
import re

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
        # Igual que armar: se compara contra lo que se dice en camara, no contra
        # el documento. Un bloque de rodaje trae las indicaciones adentro -"un
        # solo clip continuo, camara rodando"- y eso nunca se dijo en voz alta:
        # comparandolo se hunde el puntaje de todos los guiones por igual.
        txt = _lo_que_se_dice(g.get("texto") or "")
        for v in (videos or []):
            c = _cobertura(v.get("palabras") or [], txt)
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


# Menos que esto no es un anuncio, es ruido que calzo de casualidad. Sirve para
# distinguir "lo grabo y lo reconoci" de "no lo grabo": sin este piso salian
# piezas de un segundo hechas de palabras sueltas —"te no con cuanto mas"— que
# se ven como entregables y no lo son.
PIEZA_MINIMA_S = 3.0


# Cuanto tiene que sacarle el guion ganador al segundo para creerle. Los
# puntajes absolutos son bajos —el guion trae rotulos y duraciones que nadie
# dice en camara, y eso hunde el promedio— pero la distancia entre el primero y
# el segundo es clara: sobre material real el ganador saca el doble. Cuando no
# saca esa diferencia, el clip se reporta como dudoso en vez de adivinar.
VENTAJA_MINIMA = 1.3
COBERTURA_PISO = 0.35


def _pertenencia(palabras, texto):
    """
    Que parte de lo que se dice en el clip esta escrito en este guion.

    Se mide asi y no al reves —cuanto del guion aparece en el clip— porque la
    pregunta es de que guion es ESTE clip, y eso no depende de cuanto falte por
    grabar. Con la medida invertida, un cliente que graba un bloque por clip
    daba cero en todo: cada clip cubre un quinto de su guion, y encima si el
    documento viene con saltos de linea simples el guion entero es un solo
    bloque y no llega a ningun umbral.

    Sirve igual para las dos formas de filmar que aparecen: un clip que dice el
    anuncio entero da alto contra el suyo, y uno que dice un solo bloque
    tambien, porque lo que se mide es el clip.
    """
    a = G._claves(palabras or [])
    b = [G._n(x) for x in str(texto or "").split() if G._n(x)]
    if not a or not b:
        return 0.0
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    return round(sum(bl.size for bl in sm.get_matching_blocks()) / float(len(a)), 3)

# El cierre comun: tres beats iguales en todos los anuncios de concepto, que se
# graban UNA vez y se pegan atras de cada uno. En el documento vienen como una
# seccion aparte al final, y cada anuncio que lo lleva lo declara con "+ cierre
# comun". El anuncio que trae su cierre escrito adentro no lo declara y no lo
# recibe.
_RX_CIERRE_SECCION = re.compile(r"^\s*el\s+cierre\s+com[uú]n\s*$", re.I | re.M)
_RX_CIERRE_MARCA   = re.compile(r"^\s*\+\s*cierre\s+com[uú]n\b", re.I | re.M)


# Lo que se dice en camara va entre comillas en el documento; el resto son
# rotulos y duraciones —"01Hook5 s", "Fuera del test 67 s", "34 s"— que nadie
# pronuncia. Compararlos tambien hunde los puntajes y, peor, borra las
# diferencias: el clip del cierre calzaba 0.186 con el anuncio 06 y 0.157 con el
# cierre, cuando dice el cierre ENTERO y del 06 solo tres beats de siete.
_ENTRECOMILLADO = re.compile(r'"([^"]{15,})"')


# Un rotulo de guion: "01Hook5 s", "04Giro6 s", "Aterrizaje 8s", "34 s", "67 s".
# Son la marca del bloque y su duracion, nunca algo que alguien pronuncie.
_ROTULO_BLOQUE = re.compile(
    r"^\s*(?:\d{1,2}\s*)?"
    r"(?:hook|gancho|aterrizaje|desarrollo|giro|cierre|body|cuerpo|cta|remate|prueba)?"
    r"\s*\d{0,3}\s*s?\s*$", re.I)


def _parece_dicho(bloque):
    """
    Si este bloque es algo que una persona dice en camara.

    Sin comillas hay que decidirlo por la forma. Lo que NO se dice son rotulos y
    duraciones: renglones cortos, con numeros, o que son el nombre del beat. Una
    frase de guion tiene varias palabras seguidas y pocas cifras.
    """
    t = (bloque or "").strip()
    if not t or _ROTULO_BLOQUE.match(t):
        return False
    palabras = t.split()
    # Ocho y no menos: probado sobre el documento real sin sus comillas, con seis
    # se cuelan rotulos y se pierde un anuncio entero. El costo es que un hook de
    # siete palabras queda afuera, y es barato: esto solo decide de que guion es
    # cada clip, no que se entrega, y un guion tiene otros bloques para
    # reconocerse. Si ninguno pasara, mas abajo se cae al texto completo.
    if len(palabras) < 8:
        return False
    cifras = sum(1 for w in palabras if re.search(r"\d", w))
    return cifras <= len(palabras) * 0.34


def _lo_que_se_dice(texto):
    """
    Solo lo que se dice en camara, sin los rotulos del documento.

    Primero por comillas, que es como lo marca el documento cuando las usa y no
    deja lugar a dudas. Si no las usa —otro cliente, un PDF, un Word— se filtra
    por la forma de cada bloque. Sin esto se compara contra "01Hook5 s" y "34 s"
    igual que contra el texto, y eso hunde el puntaje de TODOS los guiones por
    igual hasta borrar las diferencias entre ellos, que es lo unico que importa
    para saber de cual es cada clip.

    Si ni asi queda nada, se devuelve el texto entero: es preferible comparar de
    mas que quedarse sin nada con que comparar.
    """
    texto = texto or ""
    dichas = _ENTRECOMILLADO.findall(texto)
    if len(dichas) >= 2:
        return "\n\n".join(d.strip() for d in dichas)
    bloques = [b for b in re.split(r"\n\s*\n", texto) if _parece_dicho(b)]
    return "\n\n".join(b.strip() for b in bloques) if bloques else texto


def _separar_cierre(guiones):
    """
    Saca el cierre comun a un guion propio y anota quien lo lleva.

    El separador de guiones parte por el indice numerado, asi que la seccion del
    cierre —que viene despues del ultimo anuncio— queda pegada al final de ese
    ultimo. Aca se despega: sin esto, el cierre cuenta como bloques del anuncio
    06 y ademas no hay con que comparar los clips para saber si se grabo.
    """
    salida, cierre = [], None
    for g in (guiones or []):
        txt = g.get("texto") or ""
        m = _RX_CIERRE_SECCION.search(txt)
        if m and cierre is None:
            antes, despues = txt[:m.start()].strip(), txt[m.end():].strip()
            if despues:
                cierre = {"titulo": "El cierre común", "texto": despues}
            txt = antes
        salida.append(dict(g, texto=txt,
                           _lleva_cierre=bool(_RX_CIERRE_MARCA.search(txt))))
    return salida, cierre


def cortar_uno(videos, guiones, minimo=0.35):
    """Una sola toma larga con todos los fragmentos adentro.

    armar() reparte clips ENTEROS: sirve cuando cada pieza se grabo en su propio
    archivo. Cuando llega un solo video de diez minutos con los veinticinco
    fragmentos seguidos, no hay clips que repartir: hay que cortar adentro, que
    es lo que hace repartir(). Esto devuelve lo de repartir con la forma que
    espera el worker, para que el resto del camino no cambie.
    """
    piezas, sin_grabar, descartados = repartir(videos, guiones, minimo=minimo)
    porId = {v.get("id"): v for v in (videos or [])}
    encontradas = []
    for pz in piezas:
        dur = float(pz.get("fin") or 0) - float(pz.get("inicio") or 0)
        if dur <= 0:
            continue
        bl = pz.get("bloques") or []
        dichos = sum(1 for b in bl if b.get("encontrado"))
        encontradas.append({
            "titulo": pz.get("titulo") or "Pieza",
            "tramos": [{"video": pz.get("video"),
                        "inicio": round(float(pz.get("inicio") or 0), 2),
                        "fin": round(float(pz.get("fin") or 0), 2),
                        "score": round(float(pz.get("score") or 0), 3),
                        "bloque": (pz.get("titulo") or "")[:70]}],
            "duracion": round(dur, 2),
            "score": round(float(pz.get("score") or 0), 3),
            "bloques": dichos or len(bl),
            "bloques_total": len(bl) or 1,
        })
    return encontradas, sin_grabar, descartados


def armar(videos, guiones, minimo=0.10, min_palabras=4, borde=1.5):
    """
    Arma cada guion con los clips que lo dicen, cada clip entero.

    Lo que decide a que guion va un clip es cuanto de ese guion se reconoce en
    lo que se dijo. Un clip va a UN guion solo: es una toma de algo, no material
    suelto para repartir entre varios.

    El clip se toma COMPLETO. La version anterior emitia un tramo por cada frase
    que calzara literal con el guion y tiraba lo del medio: sobre un clip real
    de 40 segundos que dice el anuncio entero devolvia cuatro pedacitos, 17.8
    segundos en total, cortando a mitad de frase. Recortar es trabajo del
    detector de silencios, que corre despues y sabe donde no se habla; el
    emparejamiento con el guion sirve para saber QUE clip es, no para editarlo.

    minimo y borde quedan aceptados para no romper a quien ya llama a esta
    funcion, pero ya no se usan: el umbral ahora es relativo.
    """
    guiones, cierre = _separar_cierre(guiones)
    # El cierre entra como un guion mas para que el emparejamiento le busque su
    # clip igual que a cualquier otro; despues no se entrega solo, se pega.
    i_cierre = len(guiones) if cierre else -1
    if cierre:
        guiones = list(guiones) + [cierre]
    porId = {v.get("id"): v for v in (videos or [])}
    gtextos = [_lo_que_se_dice(g.get("texto") or "") for g in (guiones or [])]
    coberturas = []           # [clip][guion] -> resultado de _cobertura
    tabla = []                # [clip][guion] -> score

    for v in (videos or []):
        pal = v.get("palabras") or []
        # _cobertura sigue usandose para contar que bloques del guion se
        # dijeron; para decidir de quien es el clip manda _pertenencia.
        coberturas.append([_cobertura(pal, txt) for txt in gtextos])
        tabla.append([_pertenencia(pal, txt) for txt in gtextos])

    asignado, dudosos = {}, []
    for k, fila in enumerate(tabla):
        if not fila:
            continue
        orden = sorted(range(len(fila)), key=lambda i: -fila[i])
        mejor = orden[0]
        segundo = fila[orden[1]] if len(orden) > 1 else 0.0
        if fila[mejor] < COBERTURA_PISO:
            continue
        if segundo > 0 and fila[mejor] < segundo * VENTAJA_MINIMA:
            # Empate: los dos guiones contienen lo que dice el clip. Pasa cuando
            # uno lleva al otro adentro —el anuncio que trae el cierre escrito
            # contra el cierre suelto— y ahi lo que desempata es al reves:
            # cuanto de CADA guion cubre el clip. El corto y cubierto entero le
            # gana al largo del que solo se dijo un pedazo.
            a, b = orden[0], orden[1]
            ca = (coberturas[k][a] or {}).get("score", 0) or 0
            cb = (coberturas[k][b] or {}).get("score", 0) or 0
            if max(ca, cb) > 0 and abs(ca - cb) > 0.001 and \
               max(ca, cb) >= min(ca, cb) * VENTAJA_MINIMA:
                mejor = a if ca > cb else b
            else:
                dudosos.append({"video": (videos[k] or {}).get("id"),
                                "entre": [(guiones[i].get("titulo") or "") for i in orden[:2]],
                                "score": round(fila[mejor], 3)})
                continue
        asignado.setdefault(mejor, []).append(k)

    # Los clips del cierre, si se grabo. Se pegan atras de cada anuncio que lo
    # declara, asi que el mismo clip aparece en varias entregas a proposito: se
    # graba una vez y se reusa, que es justo lo que dice el guion.
    ks_cierre = sorted(asignado.get(i_cierre, [])) if i_cierre >= 0 else []

    piezas, sin_grabar = [], []
    for gi, g in enumerate(guiones or []):
        if gi == i_cierre:
            # El cierre no es una entrega: es una parte de las otras.
            if not ks_cierre:
                sin_grabar.append({"titulo": "El cierre común", "score": 0,
                                   "nota": "lo llevan " + str(sum(
                                       1 for x in guiones if x.get("_lleva_cierre")))
                                       + " anuncios y no está grabado"})
            continue
        # En orden de rodaje: un guion se graba de arriba abajo, asi que los
        # clips que lo cubren vienen en ese orden.
        ks = sorted(asignado.get(gi, []))
        # El anuncio declara que lleva cierre pero el cierre no se grabo: la
        # pieza sale igual porque lo que hay sirve, pero incompleta. Se marca
        # para que no se entregue creyendo que esta terminada.
        falta_cierre = bool(g.get("_lleva_cierre")) and not ks_cierre
        if g.get("_lleva_cierre") and ks and ks_cierre:
            ks = ks + [k for k in ks_cierre if k not in ks]
        tramos, dur_total = [], 0.0
        for k in ks:
            d = float((videos[k] or {}).get("duracion") or 0)
            if d <= 0:
                continue
            tramos.append({"video": videos[k].get("id"), "inicio": 0.0,
                           "fin": round(d, 2), "score": round(tabla[k][gi], 3),
                           "bloque": (g.get("titulo") or "")[:70]})
            dur_total += d
        if not tramos or dur_total < PIEZA_MINIMA_S:
            sin_grabar.append({"titulo": g.get("titulo") or "Guion",
                               "score": round(max([tabla[k][gi] for k in ks] or [0]), 3),
                               "encontrado_s": round(dur_total, 2)})
            continue
        # Que bloques del guion se llegaron a decir, sumando todos sus clips.
        # Los bloques que devuelve mapa() no traen la lista de palabras, solo el
        # titulo y si se encontro: filtrar por largo aca dejaba el conteo en 0/0.
        dichos, total = set(), set()
        for k in ks:
            if k in ks_cierre and k not in asignado.get(gi, []):
                continue          # el clip del cierre no cubre bloques de este guion
            for b in ((coberturas[k][gi] or {}).get("bloques") or []):
                t = b.get("titulo") or ""
                total.add(t)
                if b.get("encontrado"):
                    dichos.add(t)
        piezas.append({
            "titulo": g.get("titulo") or "Guion",
            "tramos": tramos,
            "duracion": round(dur_total, 2),
            "bloques": len(dichos), "bloques_total": len(total),
            "falta_cierre": falta_cierre,
            "score": round(sum(t["score"] for t in tramos) / float(len(tramos)), 3),
        })

    usados = set()
    for ks in asignado.values():
        for k in ks:
            usados.add((videos[k] or {}).get("id"))
    porDudoso = {d["video"]: d for d in dudosos}
    descartados = []
    for v in (videos or []):
        if v.get("id") in usados:
            continue
        d = porDudoso.get(v.get("id"))
        descartados.append({"video": v.get("id"),
                            "duracion": round(float(v.get("duracion") or 0), 1),
                            "motivo": ("no se sabe si es " + " o " .join(d["entre"]))
                                      if d else "no se parece a ningun guion"})
    return piezas, sin_grabar, descartados
