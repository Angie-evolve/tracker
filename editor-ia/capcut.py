#!/usr/bin/env python3
"""
capcut.py - armar un proyecto de CapCut que se abra con los cortes puestos.

El formato de CapCut no esta documentado y cambia entre versiones, asi que nada
se escribe de memoria: se parte de un proyecto REAL de la maquina y se clonan
sus segmentos. Un segmento no es un objeto suelto —arrastra siete materiales por
referencia: velocidad, lienzo, canales de sonido, volumen...— y clonarlo entero
es la unica forma de que CapCut lo acepte.

Medido sobre CapCut 9.4.1 en Mac: draft_info.json es JSON legible, no esta
encriptado. En versiones donde si lo este, esto no va a andar y hay que volver
al .srt, que se sigue entregando igual.
"""
import copy
import json
import os
import shutil
import uuid

# CapCut cuenta todo en microsegundos.
US = 1000000

# Lo que se copia de la plantilla. El resto de la carpeta son los medios y los
# caches del proyecto viejo —setenta megas— que no tienen nada que ver.
ARCHIVOS = ("draft_agency_config.json", "draft_biz_config.json",
            "draft_settings", "key_value.json", "performance_opt_info.json",
            "attachment_pc_common.json", "draft_virtual_store.json",
            "timeline_layout.json")


def _id():
    return str(uuid.uuid4()).upper()


def _us(seg):
    return int(round(float(seg) * US))


def _indice(materiales):
    """De id de material a la categoria en la que vive."""
    idx = {}
    for cat, lst in materiales.items():
        if isinstance(lst, list):
            for m in lst:
                if isinstance(m, dict) and m.get("id"):
                    idx[m["id"]] = cat
    return idx


def _clonar_refs(seg, mats_orig, idx, destino):
    """
    Copia los materiales que cuelgan de un segmento, con ids nuevos.

    Sin esto, dos segmentos comparten el mismo material de velocidad o de
    lienzo y CapCut los trata como el mismo objeto: mover uno mueve el otro.
    """
    nuevos = []
    for ref in seg.get("extra_material_refs", []):
        cat = idx.get(ref)
        if not cat:
            continue
        orig = next((m for m in mats_orig[cat] if m.get("id") == ref), None)
        if not orig:
            continue
        copia = copy.deepcopy(orig)
        copia["id"] = _id()
        destino.setdefault(cat, []).append(copia)
        nuevos.append(copia["id"])
    return nuevos


def armar(plantilla, video, clips, bloques, salida, nombre,
          dims=(1080, 1920), fps=30.0, duracion_video=None):
    """
    plantilla: carpeta de un proyecto de CapCut real, de donde clonar.
    video:     ruta ABSOLUTA al archivo, tal como lo va a ver CapCut.
    clips:     [(inicio, fin)] en segundos del original, lo que se conserva.
    bloques:   [{"inicio":s, "fin":s, "texto":str}] los subtitulos.
    """
    base = json.load(open(os.path.join(plantilla, "draft_info.json"),
                          encoding="utf-8"))
    mats = base["materials"]
    idx = _indice(mats)

    pista_v = next(t for t in base["tracks"] if t["type"] == "video" and t["segments"])
    pista_t = next((t for t in base["tracks"] if t["type"] == "text" and t["segments"]), None)
    proto_v = pista_v["segments"][0]
    proto_mv = next(m for m in mats["videos"] if m["id"] == proto_v["material_id"])
    proto_t = pista_t["segments"][0] if pista_t else None
    proto_mt = (next(m for m in mats["texts"] if m["id"] == proto_t["material_id"])
                if proto_t else None)

    nuevos_mats = {}
    segs_v, cursor = [], 0
    for a, b in clips:
        dur = _us(b) - _us(a)
        if dur <= 0:
            continue
        mv = copy.deepcopy(proto_mv)
        mv.update(id=_id(), path=video, width=dims[0], height=dims[1],
                  duration=_us(duracion_video or (b - a)),
                  material_name=os.path.basename(video))
        nuevos_mats.setdefault("videos", []).append(mv)

        s = copy.deepcopy(proto_v)
        s["id"] = _id()
        s["material_id"] = mv["id"]
        s["source_timerange"] = {"start": _us(a), "duration": dur}
        s["target_timerange"] = {"start": cursor, "duration": dur}
        s["extra_material_refs"] = _clonar_refs(proto_v, mats, idx, nuevos_mats)
        segs_v.append(s)
        cursor += dur

    segs_t = []
    if proto_t:
        for bl in (bloques or []):
            dur = _us(bl["fin"]) - _us(bl["inicio"])
            if dur <= 0:
                continue
            mt = copy.deepcopy(proto_mt)
            mt["id"] = _id()
            # content es un JSON adentro de un string, y ahi vive el estilo:
            # se cambia SOLO el texto para no perder fuente, color ni borde.
            try:
                cont = json.loads(mt["content"])
                cont["text"] = bl["texto"]
                if isinstance(cont.get("styles"), list):
                    for st in cont["styles"]:
                        st["range"] = [0, len(bl["texto"])]
                mt["content"] = json.dumps(cont, ensure_ascii=False)
            except Exception:
                mt["content"] = bl["texto"]
            mt["base_content"] = bl["texto"]
            nuevos_mats.setdefault("texts", []).append(mt)

            s = copy.deepcopy(proto_t)
            s["id"] = _id()
            s["material_id"] = mt["id"]
            s["target_timerange"] = {"start": _us(bl["inicio"]), "duration": dur}
            s["extra_material_refs"] = _clonar_refs(proto_t, mats, idx, nuevos_mats)
            segs_t.append(s)

    total = cursor
    doc = copy.deepcopy(base)
    doc["id"] = _id()
    doc["duration"] = total
    doc["fps"] = float(fps)
    doc["canvas_config"] = {"ratio": "original", "width": dims[0],
                            "height": dims[1], "background": None}
    # Categorias vacias y no borradas: CapCut espera que las claves existan.
    doc["materials"] = {k: (nuevos_mats.get(k, []) if isinstance(v, list) else v)
                        for k, v in mats.items()}
    pv = copy.deepcopy(pista_v); pv.update(id=_id(), segments=segs_v)
    doc["tracks"] = [pv]
    if segs_t:
        pt = copy.deepcopy(pista_t); pt.update(id=_id(), segments=segs_t)
        doc["tracks"].append(pt)

    os.makedirs(salida, exist_ok=True)
    for f in ARCHIVOS:
        o = os.path.join(plantilla, f)
        if os.path.exists(o):
            (shutil.copytree if os.path.isdir(o) else shutil.copy2)(
                o, os.path.join(salida, f), dirs_exist_ok=True) \
                if os.path.isdir(o) else shutil.copy2(o, os.path.join(salida, f))
    crudo = json.dumps(doc, ensure_ascii=False)
    # Los dos nombres: segun la version, CapCut lee uno u otro.
    for f in ("draft_info.json", "draft_content.json"):
        open(os.path.join(salida, f), "w", encoding="utf-8").write(crudo)

    meta = json.load(open(os.path.join(plantilla, "draft_meta_info.json"),
                          encoding="utf-8"))
    meta.update(draft_id=_id(), draft_name=nombre,
                draft_fold_path=os.path.abspath(salida),
                draft_root_path=os.path.dirname(os.path.abspath(salida)),
                tm_duration=total, draft_cover="", draft_materials=[],
                draft_segment_extra_info=[])
    json.dump(meta, open(os.path.join(salida, "draft_meta_info.json"), "w",
                         encoding="utf-8"), ensure_ascii=False)
    return {"carpeta": salida, "segmentos": len(segs_v),
            "subtitulos": len(segs_t), "duracion_s": round(total / US, 2)}


# CapCut exige la ruta COMPLETA del video: probado en 9.4.1, con una ruta
# relativa abre el proyecto con los cortes y los subtitulos en su lugar pero el
# clip en rojo, "Media Not Found". Y el worker no puede saber la ruta, porque no
# sabe en que maquina se va a descomprimir. Asi que la escribe el instalador, que
# corre del lado de quien lo baja y ahi si conoce su propia carpeta.
_INSTALAR_MAC = r"""#!/bin/bash
# Doble click y listo: copia el proyecto a CapCut y le arregla la ruta del video.
cd "$(dirname "$0")" || exit 1
PROY="$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft"
NOMBRE="__NOMBRE__"
if [ ! -d "$PROY" ]; then
  echo "No encontre la carpeta de proyectos de CapCut."
  echo "Buscada en: $PROY"
  echo "Abri CapCut una vez y volve a intentar."
  read -n 1 -s -r -p "Enter para cerrar"; exit 1
fi
DEST="$PROY/$NOMBRE"
rm -rf "$DEST"
cp -R "./$NOMBRE" "$DEST" || { echo "No pude copiar."; read -n 1 -s -r; exit 1; }
VIDEO="$DEST/Resources/video.mp4"
python3 - "$DEST" "$VIDEO" <<'PYFIN'
import json, sys, os
dest, video = sys.argv[1], sys.argv[2]
for f in ("draft_info.json", "draft_content.json"):
    r = os.path.join(dest, f)
    if not os.path.exists(r): continue
    d = json.load(open(r, encoding="utf-8"))
    for m in d.get("materials", {}).get("videos", []):
        m["path"] = video
    json.dump(d, open(r, "w", encoding="utf-8"), ensure_ascii=False)
r = os.path.join(dest, "draft_meta_info.json")
if os.path.exists(r):
    m = json.load(open(r, encoding="utf-8"))
    m["draft_fold_path"] = dest
    m["draft_root_path"] = os.path.dirname(dest)
    json.dump(m, open(r, "w", encoding="utf-8"), ensure_ascii=False)
print("Listo: " + dest)
PYFIN
echo ""
echo "Abri CapCut: el proyecto '$NOMBRE' va a estar en la lista."
read -n 1 -s -r -p "Enter para cerrar"
"""

_INSTALAR_WIN = r"""@echo off
REM Doble click y listo: copia el proyecto a CapCut y le arregla la ruta del video.
cd /d "%~dp0"
set "NOMBRE=__NOMBRE__"
set "PROY=%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft"
if not exist "%PROY%" (
  echo No encontre la carpeta de proyectos de CapCut.
  echo Buscada en: %PROY%
  pause & exit /b 1
)
set "DEST=%PROY%\%NOMBRE%"
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy /e /i /q "%NOMBRE%" "%DEST%" >nul
python -c "import json,os,sys;d=sys.argv[1];v=os.path.join(d,'Resources','video.mp4');[ (lambda r: [json.dump((lambda j: (([m.__setitem__('path',v) for m in j.get('materials',{}).get('videos',[])]), j)[1])(json.load(open(r,encoding='utf-8'))), open(r,'w',encoding='utf-8'), ensure_ascii=False)] )(os.path.join(d,f)) for f in ('draft_info.json','draft_content.json') if os.path.exists(os.path.join(d,f))]" "%DEST%"
echo.
echo Abri CapCut: el proyecto "%NOMBRE%" va a estar en la lista.
pause
"""


_LEEME = """PROYECTO DE CAPCUT - %s

Doble click al instalador de TU sistema:

  Mac      ->  "Mac - ABRIR EN CAPCUT.command"
  Windows  ->  "Windows - ABRIR EN CAPCUT.bat"

El instalador copia el proyecto a la carpeta de CapCut y le corrige la ruta del
video. Sin ese paso CapCut abre el proyecto pero muestra el clip en rojo.

En Mac, la primera vez el sistema puede avisar que es de un desarrollador no
identificado: click derecho sobre el instalador -> Abrir.

Despues abri CapCut: el proyecto va a estar en la lista.
"""


def escribir_instaladores(carpeta_zip, nombre):
    """
    Deja un instalador por sistema al lado de la carpeta del proyecto.

    El sistema va PRIMERO en el nombre y no al final: con "INSTALAR-mac" y
    "INSTALAR-windows" los dos empiezan igual, y de un vistazo se agarra el que
    no es —pasa de verdad—. Asi la primera palabra ya dice cual es cual, y
    ordenados alfabeticamente el de Mac queda arriba.
    """
    mac = os.path.join(carpeta_zip, "Mac - ABRIR EN CAPCUT.command")
    with open(mac, "w", encoding="utf-8") as f:
        f.write(_INSTALAR_MAC.replace("__NOMBRE__", nombre))
    os.chmod(mac, 0o755)
    win = os.path.join(carpeta_zip, "Windows - ABRIR EN CAPCUT.bat")
    with open(win, "w", encoding="utf-8") as f:
        f.write(_INSTALAR_WIN.replace("__NOMBRE__", nombre))
    leeme = os.path.join(carpeta_zip, "LEEME.txt")
    with open(leeme, "w", encoding="utf-8") as f:
        f.write(_LEEME % nombre)
    return [mac, win, leeme]
