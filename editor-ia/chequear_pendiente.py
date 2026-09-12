#!/usr/bin/env python3
"""
chequear_pendiente.py - el paso barato del workflow.

Pregunta si hay algun trabajo en cola y escribe la respuesta en GITHUB_OUTPUT.
Corre antes de instalar ffmpeg y faster-whisper: si no hay nada pendiente, la
corrida termina en segundos y no gasta ni disco ni tiempo en preparar una
maquina que no va a usar.

Lo unico que necesita instalado es requests.
"""
import os
import worker   # solo usa requests; faster_whisper se importa recien al transcribir

hay = worker.hay_pendiente()

salida = os.environ.get("GITHUB_OUTPUT")
if salida:
    with open(salida, "a") as f:
        f.write("hay_trabajo=%s\n" % ("true" if hay else "false"))

print("hay un trabajo en cola" if hay else "no hay nada pendiente")
