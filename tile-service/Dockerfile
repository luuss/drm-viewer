FROM python:3.12-slim

WORKDIR /app

# Die Abhaengigkeiten stehen ausschliesslich in pyproject.toml. Frueher fuehrte
# dieses Abbild eine zweite, handgepflegte Liste — sie lief auseinander: boto3
# fehlte, obwohl der Dienst die Seitenbilder inzwischen selbst aus dem Eimer
# holt, und pymupdf wurde weiter installiert, obwohl es laengst draussen ist.
COPY pyproject.toml /app/
COPY main.py /app/
RUN pip install --no-cache-dir /app

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
