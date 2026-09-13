# Worker del Editor con IA. Nada de esto se sirve al navegador.
FROM python:3.11-slim

# ffmpeg de Debian: trae libass, que es lo que habilita el filtro 'subtitles'
# para quemar los carteles. Sin eso el modo 'render' no puede terminar.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# El modelo de Whisper se baja una sola vez, en el build. Si se dejara para la
# primera transcripcion, el primer video del dia se comeria la descarga de
# ~150MB y desde afuera parece que el worker se colgo.
ARG WHISPER_MODELO=small
ENV WHISPER_MODELO=${WHISPER_MODELO}
RUN python -c "from faster_whisper import WhisperModel; \
WhisperModel('${WHISPER_MODELO}', device='cpu', compute_type='int8')"

COPY auto_editor.py transcribe.py decisiones.py guion.py piezas.py subtitulos.py worker.py ./
COPY fonts ./fonts

CMD ["python", "-u", "worker.py"]
