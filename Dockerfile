# Multiverse in one container: FalkorDB (embedded, from the falkordblite package) + the console.
# Works on Render, Railway, Hugging Face Spaces or any Docker host. The host sets $PORT.
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 BIND_HOST=0.0.0.0 PORT=8765 FALKORDB_PORT=6380
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt falkordblite==0.10.0
COPY . .
EXPOSE 8765
CMD ["bash", "deploy/start.sh"]