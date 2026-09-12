#!/usr/bin/env python3
"""
auto_editor.py — motor de corte automatico por silencios/aire muerto.

No depende de ninguna API externa: usa el filtro 'silencedetect' de ffmpeg
(analisis de energia del audio) para encontrar los tramos "muertos" de un
video y arma la lista de cortes. A partir de esa lista podes:

  --modo render   -> renderiza el video final ya cortado (ffmpeg concat), sin pasar por CapCut
  --modo capcut   -> exporta un plan de corte (JSON) + un .srt placeholder,
                     listo para importar/ajustar en CapCut

El paso de subtitulos reales (transcripcion) esta separado en transcribe.py
y queda "enchufable": hoy devuelve un srt vacio/placeholder porque este
entorno no tiene salida de red hacia APIs de transcripcion (Whisper /
AssemblyAI / Deepgram). Con una API key real, transcribe.py hace el trabajo
y este script ya sabe usarlo.
"""
import argparse, json, subprocess, re, os, sys

def ffprobe_duration(path):
    out = subprocess.run(
        ["ffprobe","-v","error","-show_entries","format=duration",
         "-of","default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())

def detectar_silencios(path, umbral_db=-30, min_silencio=0.6):
    """Corre el filtro silencedetect de ffmpeg y parsea los tramos de silencio."""
    cmd = ["ffmpeg","-i", path, "-af",
           f"silencedetect=noise={umbral_db}dB:d={min_silencio}",
           "-f","null","-"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    log = r.stderr
    starts = [float(x) for x in re.findall(r"silence_start:\s*([\d.]+)", log)]
    ends   = [float(x) for x in re.findall(r"silence_end:\s*([\d.]+)", log)]
    # silence_end trae tambien la duracion pegada a veces; nos quedamos solo con el primer numero
    silencios = list(zip(starts, ends[:len(starts)]))
    return silencios

def armar_cortes(duracion, silencios, padding=0.12, min_clip=0.3):
    """
    Invierte los tramos de silencio en tramos de 'contenido util' (los que
    se conservan), dejando un pequeno padding para no comerse la primera
    palabra despues de cada silencio.
    """
    conservar = []
    cursor = 0.0
    for s0, s1 in silencios:
        corte_en = max(cursor, s0 + padding)
        if corte_en - cursor >= min_clip:
            conservar.append((round(cursor,3), round(corte_en,3)))
        cursor = max(cursor, s1 - padding)
    if duracion - cursor >= min_clip:
        conservar.append((round(cursor,3), round(duracion,3)))
    return conservar

def duracion_total(clips):
    return round(sum(b-a for a,b in clips), 3)

def render_final(path, clips, out_path):
    """Modo 'sin CapCut': corta y concatena de una, produce el video final."""
    tmp_dir = os.path.splitext(out_path)[0] + "_tmp_clips"
    os.makedirs(tmp_dir, exist_ok=True)
    list_path = os.path.join(tmp_dir, "list.txt")
    partes = []
    with open(list_path, "w") as f:
        for i,(a,b) in enumerate(clips):
            part = os.path.join(tmp_dir, f"clip_{i:03d}.mp4")
            subprocess.run(["ffmpeg","-y","-ss",str(a),"-to",str(b),"-i",path,
                             "-c:v","libx264","-c:a","aac","-avoid_negative_ts","make_zero",
                             part, "-loglevel","error"], check=True)
            partes.append(part)
            f.write(f"file '{os.path.abspath(part)}'\n")
    subprocess.run(["ffmpeg","-y","-f","concat","-safe","0","-i",list_path,
                     "-c","copy", out_path, "-loglevel","error"], check=True)
    return out_path

def exportar_capcut(clips, out_json, out_srt, fuente_srt=None):
    """Modo 'con CapCut': deja el plan de corte + un .srt para importar/ajustar en CapCut."""
    plan = {"cortes_a_conservar": [{"inicio": a, "fin": b, "duracion": round(b-a,3)} for a,b in clips]}
    with open(out_json, "w") as f:
        json.dump(plan, f, indent=2, ensure_ascii=False)
    with open(out_srt, "w") as f:
        if fuente_srt:
            f.write(fuente_srt)
        else:
            f.write("1\n00:00:00,000 --> 00:00:02,000\n"
                    "[subtitulos: conecta transcribe.py con una API de STT para "
                    "generar el texto real]\n\n")
    return out_json, out_srt

def main():
    ap = argparse.ArgumentParser(description="Auto-corte por silencios (sin IA de terceros).")
    ap.add_argument("video")
    ap.add_argument("--modo", choices=["render","capcut"], default="render")
    ap.add_argument("--umbral-db", type=float, default=-30)
    ap.add_argument("--min-silencio", type=float, default=0.6)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    dur = ffprobe_duration(args.video)
    silencios = detectar_silencios(args.video, args.umbral_db, args.min_silencio)
    clips = armar_cortes(dur, silencios)

    print(f"Duracion original: {dur:.2f}s")
    print(f"Silencios detectados: {len(silencios)}")
    for s0,s1 in silencios: print(f"  silencio {s0:.2f}s -> {s1:.2f}s")
    print(f"Clips a conservar: {len(clips)}")
    for a,b in clips: print(f"  conservar {a:.2f}s -> {b:.2f}s")
    nueva = duracion_total(clips)
    print(f"Duracion final estimada: {nueva:.2f}s (ahorro: {dur-nueva:.2f}s, {100*(dur-nueva)/dur:.0f}%)")

    if args.modo == "render":
        out = args.out or "output_cortado.mp4"
        render_final(args.video, clips, out)
        print(f"\nListo -> {out}")
    else:
        out_json = args.out or "plan_de_corte.json"
        out_srt = os.path.splitext(out_json)[0] + ".srt"
        exportar_capcut(clips, out_json, out_srt)
        print(f"\nListo -> {out_json} + {out_srt} (importar/ajustar en CapCut)")

if __name__ == "__main__":
    main()
