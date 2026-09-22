FROM python:3.12-slim

# Der Dienst ist ein Worker, kein Webdienst: er holt Auftraege aus der
# Warteschlange im Backend. Deshalb kein uvicorn und kein offener Port.
WORKDIR /app

# Tesseract liest die Kopfzeile der Titelseite: Heftnummer, Erscheinungszeitraum
# und Preis stehen dort als Bild. Fehlt es, laeuft der Import weiter, nur ohne
# diese Angaben.
RUN apt-get update \
    && apt-get install --no-install-recommends -y tesseract-ocr tesseract-ocr-deu \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py render.py storage.py ./
COPY extractor ./extractor

CMD ["python", "worker.py"]
