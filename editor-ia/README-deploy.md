# Editor con IA — como se pone en marcha

Tres pasos. Los tres son en tu cuenta, no se pueden hacer desde el tracker.

## 1. La tabla y las policies

Supabase → SQL Editor → New query → pegar `01-tabla.sql` → Run.

Antes de correrlo, crear el bucket: Storage → New bucket, nombre **videos**,
**privado** (sin marcar "Public bucket"). El SQL asume eso.

## 2. El worker

Necesita estar siempre prendido: es un loop que pregunta cada 8 segundos si hay
algo pendiente. Railway, Render o Fly sirven igual; con el `Dockerfile` de esta
carpeta se despliega sin configurar nada mas.

Variables de entorno:

| variable | que va |
|---|---|
| `SUPABASE_URL` | `https://onnysveksgxtmspxgbow.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → `service_role`. **Secreta.** No es la anon que ya esta en index.html |
| `WHISPER_MODELO` | opcional, default `small` |
| `INTERVALO` | opcional, segundos entre vueltas, default `8` |

El Dockerfile baja el modelo de Whisper en el build, no en el primer video: si
se dejara para despues, la primera transcripcion del dia se come una descarga
de ~150 MB y desde afuera parece que el worker se colgo.

**No lo pongas con auto-sleep.** Si la maquina se duerme, la cola queda quieta.

## 3. Probar

1. Subir un video corto desde la pestana.
2. Mirar que aparezca la fila en `trabajos_video` con `estado='pendiente'`.
3. En el log del worker tiene que salir `-> <id> modo=...` y despues `listo`.
4. Descargar el resultado desde la pantalla.
5. Repetir con la cuenta de tu colaboradora: cada una ve solo lo suyo.

## Cuanto tarda

Whisper sin GPU corre a mas o menos tiempo real: un video de 20 minutos son
~20 minutos de transcripcion, mas el render. El modo `capcut` es igual de lento
porque tambien transcribe; lo unico rapido es el corte, que es puro ffmpeg.

Si queda muy lento, `WHISPER_MODELO=base` es bastante mas rapido y en espanol
pierde algo de precision. `tiny` ya se nota mal.

## Detalle que rompe si se cambia la imagen

El modo `render` quema los subtitulos con el filtro `subtitles` de ffmpeg, que
lo aporta **libass**. El ffmpeg de Debian lo trae; hay builds que no (la de
Homebrew en Mac, por ejemplo). El worker lo chequea al arrancar y lo avisa en el
log en vez de fallar recien en el primer render.

## Compresion antes de subir

El tope de subida del proyecto es **50 MB por archivo** (medido: acepta 50, rechaza
100). Es el techo del plan Free; con Pro sube hasta 50 GB.

Un iPhone graba 1080p60 a ~22 Mbps = 168 MB por minuto, asi que en 50 MB entran
18 segundos. Por eso la pantalla recomprime sola cuando el archivo no entra:
reproduce el video contra un canvas de 1280 de ancho y graba la salida con
MediaRecorder, apuntando al bitrate que hace que entre.

Dos cosas que se sienten:

- **Tarda lo que dura el video.** No hay forma de apurarlo sin acelerar tambien
  el audio. Igual termina antes que subir dos giga.
- **El maximo es la duracion, no el peso**: ~17 minutos. Pasado eso el bitrate
  necesario baja tanto que no se veria nada, y en vez de entregar un video
  ilegible lo rechaza y pide cortarlo en partes.

La copia comprimida dura lo mismo que el original (medido: 12.06s contra 12.00s).
Importa para el modo `capcut`, donde el plan de corte se aplica al video original
en CapCut: si la copia durara distinto, todos los cortes quedarian corridos.

Si se pasa a Pro o el video se sube directo al worker, subir `ED_LIMITE_MB` en
index.html alcanza para que deje de comprimir.
