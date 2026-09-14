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
_RUTAS_PS1 = r"""# Le pone al proyecto las rutas de ESTA maquina.
#
# Va en un archivo aparte y no adentro del .bat a proposito: escapar comillas
# de PowerShell dentro de un .bat es una fuente conocida de errores silenciosos,
# y aca un error silencioso deja el proyecto sin aparecer en CapCut.
param([Parameter(Mandatory=$true)][string]$Dest)
$ErrorActionPreference = 'Stop'

# En JSON la barra invertida va doblada.
function Escapar([string]$p) { $p.Replace('\', '\\') }
# En el reemplazo de una regex, el signo peso tiene significado propio.
function Literal([string]$s) { $s.Replace('$', '$$') }

$carpeta = (Resolve-Path $Dest).Path.TrimEnd('\')
$raiz    = Split-Path -Parent $carpeta
$video   = Join-Path $carpeta 'Resources\video.mp4'
if (-not (Test-Path $video)) { throw "El proyecto vino sin el video: $video" }

$cJson = Literal (Escapar $carpeta)
$rJson = Literal (Escapar $raiz)

foreach ($f in 'draft_info.json', 'draft_content.json', 'draft_meta_info.json') {
  $p = Join-Path $carpeta $f
  if (-not (Test-Path $p)) { continue }
  $t = [IO.File]::ReadAllText($p)
  # La ruta del video viene relativa. CapCut la necesita completa o el clip
  # queda en rojo.
  $t = $t.Replace('Resources/video.mp4', (Escapar $video))
  # Y estas dos vienen con la ruta de la maquina que armo el proyecto. Si
  # quedan asi, CapCut no lo muestra en la lista: es el motivo por el que
  # antes no aparecia nada.
  $t = [Regex]::Replace($t, '"draft_fold_path"\s*:\s*"[^"]*"', '"draft_fold_path": "' + $cJson + '"')
  $t = [Regex]::Replace($t, '"draft_root_path"\s*:\s*"[^"]*"', '"draft_root_path": "' + $rJson + '"')
  # La ruta relativa tiene que haber desaparecido. Ojo con buscarla suelta:
  # la ruta nueva TERMINA en Resources/video.mp4, asi que sin las comillas de
  # apertura cualquier chequeo da positivo siempre.
  if ($t.Contains('"Resources/video.mp4"')) { throw "No pude reemplazar la ruta en $f" }
  [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))
}
Write-Output 'rutas-ok'

# CapCut no escanea la carpeta: lee root_meta_info.json. Si el proyecto no esta
# ahi, existe en el disco y no aparece en la lista. Eso es lo que pasaba.
$idx = Join-Path $raiz 'root_meta_info.json'
if (-not (Test-Path $idx)) { Write-Output 'indice-no-hay'; exit 0 }
$txt = [IO.File]::ReadAllText($idx)
if ($txt.Contains($carpeta)) { Write-Output 'indice-ya-estaba'; exit 0 }

$m = $txt | ConvertFrom-Json
$lista = $m.all_draft_store
if (-not $lista -or $lista.Count -lt 1) { Write-Output 'indice-vacio'; exit 0 }

# Se clona una entrada que ya funciona en vez de inventar una: asi hereda el
# esquema exacto de ESTA version de CapCut, que cambia entre versiones.
$e = $lista[0] | ConvertTo-Json -Depth 20 | ConvertFrom-Json
$ahora = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) * 1000
$dur = 0
$metaP = Join-Path $carpeta 'draft_meta_info.json'
if (Test-Path $metaP) {
  $mm = [Regex]::Match([IO.File]::ReadAllText($metaP), '"tm_duration"\s*:\s*(\d+)')
  if ($mm.Success) { $dur = [int64]$mm.Groups[1].Value }
}

$nuevo = @{
  draft_name = $Env:CAPCUT_NOMBRE; draft_fold_path = $carpeta; draft_root_path = $raiz
  draft_json_file = (Join-Path $carpeta 'draft_info.json'); draft_cover = ''
  draft_id = ([guid]::NewGuid().ToString().ToUpper())
  tm_draft_create = $ahora; tm_draft_modified = $ahora; tm_draft_removed = 0
  tm_duration = $dur
}
# Los campos de nube del clon apuntan a OTRO proyecto. Si quedan, CapCut puede
# creer que es el mismo y pisarlo en la nube.
$cero = @{
  cloud_draft_cover = $false; cloud_draft_sync = $false
  draft_cloud_last_action_download = $false
  draft_cloud_purchase_info = ''; draft_cloud_template_id = ''
  draft_cloud_tutorial_info = ''; draft_cloud_videocut_purchase_info = ''
  tm_draft_cloud_completed = ''; tm_draft_cloud_entry_id = 0
  tm_draft_cloud_modified = 0; tm_draft_cloud_parent_entry_id = -1
  tm_draft_cloud_space_id = 0; tm_draft_cloud_user_id = 0
  pippit_avatar_url = ''; pippit_extra_info = ''; pippit_id = ''; pippit_user_name = ''
}
# Solo se tocan claves que la entrada clonada ya tenia: inventar campos que
# esta version no conoce es pedir problemas.
$tiene = @{}; foreach ($pr in $e.PSObject.Properties) { $tiene[$pr.Name] = $true }
foreach ($k in @($nuevo.Keys)) { if ($tiene[$k]) { $e.$k = $nuevo[$k] } }
foreach ($k in @($cero.Keys))  { if ($tiene[$k]) { $e.$k = $cero[$k]  } }

$entrada = $e | ConvertTo-Json -Depth 20 -Compress
# Se inserta como texto y no se reescribe el JSON entero: asi el resto del
# archivo -incluidos los enteros largos de la nube, que ConvertTo-Json puede
# estropear- queda igual.
$pos = $txt.IndexOf('"all_draft_store"')
if ($pos -lt 0) { Write-Output 'indice-sin-lista'; exit 0 }
$cor = $txt.IndexOf('[', $pos)
if ($cor -lt 0) { Write-Output 'indice-sin-lista'; exit 0 }
$resto = $txt.Substring($cor + 1)
$coma = if ($resto -match '^\s*\]') { '' } else { ',' }
$nuevoTxt = $txt.Substring(0, $cor + 1) + $entrada + $coma + $resto
try { $null = $nuevoTxt | ConvertFrom-Json } catch { Write-Output 'indice-roto'; exit 0 }

$sello = (Get-Date).ToString('yyyyMMdd-HHmmss')
[IO.File]::WriteAllText("$idx.bak-$sello", $txt, (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($idx, $nuevoTxt, (New-Object Text.UTF8Encoding($false)))
Write-Output 'indice-ok'
"""


_INSTALAR_MAC = r"""#!/bin/bash
# Doble click y listo: copia el proyecto a CapCut y le arregla las rutas.
cd "$(dirname "$0")" || exit 1
NOMBRE="__NOMBRE__"

fin(){ echo ""; read -n 1 -s -r -p "Enter para cerrar"; echo ""; exit "$1"; }

if [ ! -d "./$NOMBRE" ]; then
  echo "No encuentro la carpeta del proyecto al lado de este archivo."
  echo "Descomprimi el .zip primero y corre el instalador desde la carpeta."
  fin 1
fi

PROY="$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft"
if [ ! -d "$PROY" ]; then
  echo "No encontre la carpeta de proyectos de CapCut."
  echo "Buscada en: $PROY"
  echo "Abri CapCut una vez y volve a intentar."
  fin 1
fi

DEST="$PROY/$NOMBRE"
rm -rf "$DEST"
cp -R "./$NOMBRE" "$DEST" || { echo "No pude copiar a $DEST"; fin 1; }
rm -f "$DEST/_rutas.ps1"

VIDEO="$DEST/Resources/video.mp4"
if [ ! -f "$VIDEO" ]; then echo "El proyecto vino sin el video."; fin 1; fi

# perl y no python3: perl viene con macOS, python3 no siempre.
for F in draft_info.json draft_content.json draft_meta_info.json; do
  [ -f "$DEST/$F" ] || continue
  V="$VIDEO" C="$DEST" R="$PROY" perl -i -pe '
    s{Resources/video\.mp4}{$ENV{V}}g;
    s{"draft_fold_path"\s*:\s*"[^"]*"}{"draft_fold_path": "$ENV{C}"}g;
    s{"draft_root_path"\s*:\s*"[^"]*"}{"draft_root_path": "$ENV{R}"}g;
  ' "$DEST/$F"
done

# Se comprueba en vez de avisar que salio bien y listo: antes decia "ya esta"
# aunque no hubiera hecho nada, y del otro lado no aparecia el proyecto.
# CapCut no escanea la carpeta: lee root_meta_info.json. Si el proyecto no
# esta ahi, existe en el disco y no aparece en la lista. En Mac CapCut se
# auto-agrega al arrancar, en Windows no; se registra en los dos por las dudas.
INDICE=$(C="$DEST" R="$PROY" N="$NOMBRE" perl - "$PROY/root_meta_info.json" <<'PLFIN'
use strict; use warnings;
my $idx = shift;
exit 0 unless -f $idx;                      # sin indice, CapCut lo crea el solo
open(my $fh, '<:encoding(UTF-8)', $idx) or exit 0;
my $txt = do { local $/; <$fh> }; close $fh;
exit 0 if index($txt, $ENV{C}) >= 0;        # ya registrado: no duplicar

eval { require JSON::PP; 1 } or exit 0;
my $m = eval { JSON::PP->new->decode($txt) } or exit 0;
my $lista = $m->{all_draft_store};
exit 0 unless ref $lista eq 'ARRAY' && @$lista;

# Se clona una entrada que ya funciona en vez de inventar una: asi hereda el
# esquema exacto de ESTA version de CapCut, que cambia entre versiones.
my %e = %{ $lista->[0] };
my $ahora = int(time() * 1000000);
my $dur = 0;
if (open(my $mf, '<:encoding(UTF-8)', "$ENV{C}/draft_meta_info.json")) {
  my $t = do { local $/; <$mf> }; close $mf;
  $dur = $1 if $t =~ /"tm_duration"\s*:\s*(\d+)/;
}
my @hex = ('0'..'9','A'..'F');
my $id = join '', map { $hex[int rand 16] } 1..32;
$id = join '-', substr($id,0,8), substr($id,8,4), substr($id,12,4), substr($id,16,4), substr($id,20,12);

my %nuevo = (
  draft_name => $ENV{N}, draft_fold_path => $ENV{C}, draft_root_path => $ENV{R},
  draft_json_file => "$ENV{C}/draft_info.json", draft_cover => '', draft_id => $id,
  tm_draft_create => $ahora, tm_draft_modified => $ahora, tm_draft_removed => 0,
  tm_duration => $dur + 0,
);
# Los campos de nube del clon apuntan a OTRO proyecto. Si quedan, CapCut puede
# creer que es el mismo y pisarlo en la nube.
my %cero = (
  cloud_draft_cover => JSON::PP::false(), cloud_draft_sync => JSON::PP::false(),
  draft_cloud_last_action_download => JSON::PP::false(),
  draft_cloud_purchase_info => '', draft_cloud_template_id => '',
  draft_cloud_tutorial_info => '', draft_cloud_videocut_purchase_info => '',
  tm_draft_cloud_completed => '', tm_draft_cloud_entry_id => 0,
  tm_draft_cloud_modified => 0, tm_draft_cloud_parent_entry_id => -1,
  tm_draft_cloud_space_id => 0, tm_draft_cloud_user_id => 0,
  pippit_avatar_url => '', pippit_extra_info => '', pippit_id => '',
  pippit_user_name => '',
);
# Solo se tocan claves que la entrada clonada ya tenia: inventar campos que
# esta version no conoce es pedir problemas.
for my $k (keys %nuevo) { $e{$k} = $nuevo{$k} if exists $e{$k}; }
for my $k (keys %cero)  { $e{$k} = $cero{$k}  if exists $e{$k}; }

my $entrada = JSON::PP->new->canonical->encode(\%e);
# Se inserta como texto y no se reescribe el JSON entero: asi el resto del
# archivo -incluidos los enteros largos de la nube- queda byte por byte igual.
my $pos = index($txt, '"all_draft_store"');
exit 0 if $pos < 0;
my $cor = index($txt, '[', $pos);
exit 0 if $cor < 0;
my $sig = substr($txt, $cor + 1);
my $nuevoTxt = substr($txt, 0, $cor + 1) . $entrada . ($sig =~ /^\s*\]/ ? '' : ',') . $sig;
eval { JSON::PP->new->decode($nuevoTxt); 1 } or exit 0;   # no se escribe algo roto

my @t = localtime; my $sello = sprintf('%04d%02d%02d-%02d%02d%02d',
  $t[5]+1900, $t[4]+1, $t[3], $t[2], $t[1], $t[0]);
my $bk;
if (open($bk, '>:encoding(UTF-8)', "$idx.bak-$sello")) { print $bk $txt; close $bk; }
open(my $out, '>:encoding(UTF-8)', $idx) or exit 0;
print $out $nuevoTxt; close $out;
print "indice-ok\n";
PLFIN
)
if [ "$INDICE" != "indice-ok" ]; then
  echo "AVISO: copie el proyecto pero no pude anotarlo en la lista de CapCut."
  echo "Si no aparece, mandale esta pantalla a Angie."
  echo ""
fi

# Las comillas de apertura son imprescindibles: la ruta nueva TERMINA en
# Resources/video.mp4, asi que buscarla suelta da positivo siempre.
if grep -q '"Resources/video\.mp4"' "$DEST/draft_info.json" 2>/dev/null; then
  echo "Copie el proyecto pero no pude arreglar las rutas."
  echo "Abrilo igual: si el clip sale en rojo, arrastrale el video que esta en"
  echo "$DEST/Resources"
  fin 1
fi

echo "Listo. El proyecto quedo en:"
echo "$DEST"
echo ""
if pgrep -x CapCut >/dev/null 2>&1; then
  echo "OJO: CapCut esta abierto. Cerralo del todo y volve a abrirlo, porque la"
  echo "lista de proyectos se lee al arrancar."
  echo ""
fi
echo "Abri CapCut: '$NOMBRE' va a estar en la lista."
fin 0
"""


_INSTALAR_WIN = r"""@echo off
setlocal enableextensions
cd /d "%~dp0"
set "NOMBRE=__NOMBRE__"
echo.
echo   Instalando "%NOMBRE%" en CapCut
echo.

REM Ejecutarlo desde adentro del .zip es el error mas comun: Windows copia a
REM una carpeta temporal SOLO este archivo, y el proyecto se queda en el zip.
if not exist "%NOMBRE%\" goto sin_carpeta

REM La carpeta de proyectos cambia segun version e instalacion, asi que se
REM prueban las conocidas en vez de dar una por sentada.
set "PROY="
for %%D in (
  "%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft"
  "%APPDATA%\CapCut\User Data\Projects\com.lveditor.draft"
  "%LOCALAPPDATA%\CapCut\User Data\Projects"
) do if not defined PROY if exist "%%~D\" set "PROY=%%~D"
if not defined PROY goto sin_capcut

set "DEST=%PROY%\%NOMBRE%"
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy /e /i /q /y "%NOMBRE%" "%DEST%" >nul
if errorlevel 1 goto sin_copia

REM La comprobacion la hace el propio .ps1, que es donde se pueden escribir
REM comillas sin pelear con el parser del .bat. Aca alcanza su codigo de salida.
set "CAPCUT_NOMBRE=%NOMBRE%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%NOMBRE%\_rutas.ps1" -Dest "%DEST%"
if errorlevel 1 goto sin_rutas
del /q "%DEST%\_rutas.ps1" >nul 2>&1

REM Se comprueba el estado final del indice y no lo que haya dicho PowerShell:
REM lo que importa es si el proyecto quedo anotado, no si el script se quejo.
findstr /c:"%NOMBRE%" "%PROY%\root_meta_info.json" >nul 2>&1
if errorlevel 1 (
  echo   AVISO: copie el proyecto pero no pude anotarlo en la lista de CapCut.
  echo   Si no aparece, mandale esta pantalla a Angie.
  echo.
)

echo   Listo. El proyecto quedo en:
echo   %DEST%
echo.
tasklist /fi "imagename eq CapCut.exe" 2>nul | find /i "CapCut.exe" >nul
if not errorlevel 1 (
  echo   OJO: CapCut esta abierto. Cerralo del todo y volve a abrirlo,
  echo   porque la lista de proyectos se lee al arrancar.
  echo.
)
echo   Abri CapCut: "%NOMBRE%" va a estar en la lista de proyectos.
echo.
pause
exit /b 0

:sin_carpeta
echo   No encuentro la carpeta del proyecto al lado de este archivo.
echo.
echo   Casi siempre es esto: lo ejecutaste desde adentro del .zip. Windows
echo   copia a una carpeta temporal solo el .bat, y el proyecto se queda
echo   adentro del zip.
echo.
echo   Cerra esta ventana, click derecho en el .zip, "Extraer todo", y
echo   recien ahi doble click en este archivo.
echo.
pause
exit /b 1

:sin_capcut
echo   No encontre la carpeta de proyectos de CapCut.
echo   Busque en:
echo     %%LOCALAPPDATA%%\CapCut\User Data\Projects\com.lveditor.draft
echo     %%APPDATA%%\CapCut\User Data\Projects\com.lveditor.draft
echo.
echo   Abri CapCut una vez, cerralo, y volve a intentar. Si ya lo hiciste,
echo   pasale esta pantalla a Angie.
echo.
pause
exit /b 1

:sin_copia
echo   No pude copiar el proyecto a:
echo   %DEST%
echo.
echo   Suele ser CapCut abierto usando la carpeta. Cerralo y volve a intentar.
echo.
pause
exit /b 1

:sin_rutas
echo   Copie el proyecto pero no pude arreglarle las rutas.
echo.
echo   Abrilo igual desde CapCut: si el clip sale en rojo, arrastrale el video
echo   que esta en:
echo   %DEST%\Resources
echo.
pause
exit /b 1
"""


_LEEME = """PROYECTO DE CAPCUT - %s

1. DESCOMPRIMI EL ZIP PRIMERO.

   En Windows: click derecho -> "Extraer todo". Correr el instalador desde
   adentro del zip NO funciona: Windows copia solo el .bat a una carpeta
   temporal y el proyecto se queda adentro del comprimido.

2. Doble click al instalador de TU sistema:

     Mac      ->  "Mac - ABRIR EN CAPCUT.command"
     Windows  ->  "Windows - ABRIR EN CAPCUT.bat"

   Windows va a avisar que el editor es desconocido: es normal, son cuatro
   lineas de texto que podes abrir con el Bloc de notas. Dale "Ejecutar".
   En Mac, si dice que es de un desarrollador no identificado: click derecho
   sobre el instalador -> Abrir.

   El instalador copia el proyecto a la carpeta de CapCut y le corrige las
   rutas. Sin ese paso CapCut ni siquiera lo muestra en la lista.

3. Abri CapCut. Si ya estaba abierto, cerralo del todo y volve a abrirlo: la
   lista de proyectos se lee al arrancar.

El instalador dice al final si salio bien o que fallo. Si falla, mandale esa
pantalla a Angie: ahi esta el motivo.
"""


def escribir_instaladores(carpeta_zip, nombre):
    """
    Deja un instalador por sistema al lado de la carpeta del proyecto.

    El sistema va PRIMERO en el nombre y no al final: con "INSTALAR-mac" y
    "INSTALAR-windows" los dos empiezan igual, y de un vistazo se agarra el que
    no es -pasa de verdad-. Asi la primera palabra ya dice cual es cual, y
    ordenados alfabeticamente el de Mac queda arriba.

    El .ps1 va DENTRO de la carpeta del proyecto y no al lado de los
    instaladores: arriba solo tienen que verse las dos cosas que se tocan.
    """
    mac = os.path.join(carpeta_zip, "Mac - ABRIR EN CAPCUT.command")
    with open(mac, "w", encoding="utf-8") as f:
        f.write(_INSTALAR_MAC.replace("__NOMBRE__", nombre))
    os.chmod(mac, 0o755)
    win = os.path.join(carpeta_zip, "Windows - ABRIR EN CAPCUT.bat")
    # CRLF: el Bloc de notas y algunas versiones de cmd se marean con LF solo.
    with open(win, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(_INSTALAR_WIN.replace("__NOMBRE__", nombre))
    ps1 = os.path.join(carpeta_zip, nombre, "_rutas.ps1")
    with open(ps1, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(_RUTAS_PS1)
    leeme = os.path.join(carpeta_zip, "LEEME.txt")
    with open(leeme, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(_LEEME % nombre)
    return [mac, win, ps1, leeme]
