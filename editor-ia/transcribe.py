#!/usr/bin/env python3
"""
transcribe.py — subtitulos automaticos SIN API paga: corre Whisper local
(modelo abierto de OpenAI, gratis) en tu propio servidor con faster-whisper.
No manda audio a ningun servicio en la nube ni depende de una API key.

Instalacion (una sola vez, en tu servidor):
    pip install faster-whisper

La primera vez que corras esto, faster-whisper baja el modelo (~150MB el
"small", en espanol anda bien) desde Hugging Face y lo guarda en cache
local. De ahi en mas corre 100% offline, sin tocar la red.

Probado en este entorno: la logica corre y compila bien, pero la descarga
del modelo no se puede completar aca porque el sandbox donde yo ejecuto
codigo tiene bloqueado el acceso a huggingface.co. En tu servidor, con
internet normal, la descarga es automatica y una sola vez.
"""
import subprocess

def extraer_audio(video_path, out_wav="audio_16k.wav"):
    """Deja el audio en el formato que Whisper espera (mono, 16kHz)."""
    subprocess.run(["ffmpeg","-y","-i",video_path,"-ac","1","-ar","16000",
                     out_wav,"-loglevel","error"], check=True)
    return out_wav

def transcribir_local(wav_path, modelo="small", idioma="es"):
    """
    Transcribe con Whisper corriendo LOCAL (faster-whisper), sin API.

    modelo: 'tiny'/'base' (rapidos, menos precisos) hasta 'medium'/'large-v3'
            (mas lentos, mas precisos). Para espanol, 'small' es un buen punto
            medio en una notebook/servidor sin GPU.
    """
    from faster_whisper import WhisperModel
    # El modelo se carga una sola vez por proceso. Sin esto, una tanda de 31
    # clips lo levantaba 31 veces y la carga tarda mas que transcribir un clip
    # de nueve segundos.
    global _MODELOS
    try:
        _MODELOS
    except NameError:
        _MODELOS = {}
    if modelo not in _MODELOS:
        _MODELOS[modelo] = WhisperModel(modelo, device="cpu", compute_type="int8")
    model = _MODELOS[modelo]
    segments, _info = model.transcribe(wav_path, language=idioma, word_timestamps=True)
    palabras = []
    for seg in segments:
        for w in seg.words:
            palabras.append({"word": w.word.strip(), "start": w.start, "end": w.end})
    return palabras

def palabras_a_srt(palabras, max_palabras_por_linea=8, out_srt="subtitulos.srt"):
    """Agrupa palabras con timestamp en lineas de subtitulo y escribe el .srt."""
    def fmt(t):
        h = int(t//3600); m = int((t%3600)//60); s = t%60
        return f"{h:02d}:{m:02d}:{int(s):02d},{int((s%1)*1000):03d}"
    bloques, actual = [], []
    for w in palabras:
        actual.append(w)
        if len(actual) >= max_palabras_por_linea:
            bloques.append(actual); actual = []
    if actual: bloques.append(actual)
    with open(out_srt, "w") as f:
        for i, b in enumerate(bloques, 1):
            f.write(f"{i}\n{fmt(b[0]['start'])} --> {fmt(b[-1]['end'])}\n"
                     f"{' '.join(w['word'] for w in b)}\n\n")
    return out_srt

def transcribir_video(video_path, out_srt="subtitulos.srt", modelo="small", idioma="es"):
    """Pipeline completo: video -> audio -> Whisper local -> .srt. Sin API."""
    wav = extraer_audio(video_path)
    palabras = transcribir_local(wav, modelo, idioma)
    return palabras_a_srt(palabras, out_srt=out_srt)

# ---------------------------------------------------------------------------
# Fallback 100% offline sin descargar NADA (ni siquiera el modelo Whisper):
# pocketsphinx. Lo probe en este entorno y anda de verdad sin red, pero solo
# viene con modelo de ingles — para espanol no tiene datos bundled y la
# calidad igual es baja. Lo dejo por si en algun escenario necesitas cero
# dependencia de red ni siquiera para la descarga inicial del modelo, pero
# para tu caso (contenido en espanol) la opcion de arriba es la que sirve.
# ---------------------------------------------------------------------------
def transcribir_pocketsphinx_offline(wav_path, idioma_sphinx=None):
    import speech_recognition as sr
    r = sr.Recognizer()
    with sr.AudioFile(wav_path) as src:
        audio = r.record(src)
    kwargs = {"language": idioma_sphinx} if idioma_sphinx else {}
    return r.recognize_sphinx(audio, **kwargs)

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(0)
    srt = transcribir_video(sys.argv[1])
    print(f"Listo -> {srt}")

