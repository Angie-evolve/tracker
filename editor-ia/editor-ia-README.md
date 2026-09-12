# Editor con IA — corte automatico + subtitulos, sin ninguna API paga

## Corte (probado, funciona de verdad)

`auto_editor.py` detecta silencios reales con ffmpeg (`silencedetect`, cero
dependencias externas) y arma la lista de tramos a conservar. Corrida real
sobre un video de prueba de 11.52s con dos silencios reales:

```
Silencios detectados: 2
Duracion final estimada: 7.62s (ahorro: 3.91s, 34%)
```

```bash
python3 auto_editor.py mi_video.mp4 --modo render --out final.mp4    # sin CapCut
python3 auto_editor.py mi_video.mp4 --modo capcut --out plan.json    # para CapCut
```

## Subtitulos — sin API paga

Pediste que sea sin API, asi que `transcribe.py` corre **Whisper local**
(el modelo abierto de OpenAI) con la libreria `faster-whisper`. No manda el
audio a ningun servicio en la nube, no necesita API key, no tiene costo por
uso:

```bash
pip install faster-whisper
python3 transcribe.py mi_video.mp4
```

**Importante sobre la primera vez:** Whisper necesita bajar el modelo una
sola vez (unos 150MB para "small", que anda bien en espanol) desde Hugging
Face. Esa descarga inicial si necesita internet — despues corre 100%
offline, en tu maquina, para siempre. Lo probé en el entorno donde yo
ejecuto codigo y la logica compila y corre bien, pero la descarga del
modelo no se completa aca porque este sandbox especifico tiene bloqueado
el acceso a huggingface.co. En tu servidor, con internet normal, baja solo
la primera vez sin que hagas nada especial.

Si en algun momento necesitas que ni siquiera esa descarga inicial pase
(cero red, ni para bajar el modelo), `transcribe.py` tambien incluye
`transcribir_pocketsphinx_offline()` — lo probé y anda de verdad sin tocar
la red ni una vez, pero **solo tiene modelo de ingles** y la calidad es
bastante mas baja. Para tu contenido en espanol, Whisper local es la opcion
que sirve.

## Como se enchufa con lo que ya tenes

- Modo `capcut`: reemplaza la parte manual de tu skill `guion-edicion-video`
  — la IA saca el plan de corte + el .srt directo del video, vos lo seguis
  ajustando en CapCut igual que ahora.
- Modo `render`: circuito completo resuelto en el servidor, sin CapCut.

## Pantalla dentro de EVOLVE

Ver `editor-ia-mockup.html` — pantalla nueva ("Editor con IA") con los
numeros reales de la corrida de arriba.
