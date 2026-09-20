"""Ablage grosser Dateien.

Im Self-Hosting liegt alles in einem S3-kompatiblen Eimer (MinIO). Ist keiner
eingerichtet, faellt das Modul auf die Convex-Dateiablage zurueck, damit die
Entwicklung ohne MinIO laeuft. Das Datenmodell aendert sich dadurch nicht:
`assets.key` bleibt die Adresse, der Ablageort steht daneben.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class StoredObject:
    key: str
    bucket: str | None
    convex_storage_id: str | None
    bytes: int


class Storage:
    def __init__(self, convex: "ConvexClient") -> None:
        self.convex = convex
        self.bucket = os.environ.get("MEDIA_BUCKET", "emag-media")
        self.endpoint = os.environ.get("S3_ENDPOINT_URL", "").strip()
        self._s3 = None
        if self.endpoint:
            import boto3  # nur noetig, wenn wirklich S3 im Spiel ist

            self._s3 = boto3.client(
                "s3",
                endpoint_url=self.endpoint,
                aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
                aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
                region_name=os.environ.get("AWS_REGION", "us-east-1"),
            )

    @property
    def uses_s3(self) -> bool:
        return self._s3 is not None

    def put(self, key: str, data: bytes, content_type: str) -> StoredObject:
        if self._s3 is not None:
            self._s3.put_object(
                Bucket=self.bucket, Key=key, Body=data, ContentType=content_type
            )
            return StoredObject(key, self.bucket, None, len(data))

        upload_url = self.convex.post("/service/storage/upload-url", {})["uploadUrl"]
        res = httpx.post(
            upload_url,
            content=data,
            headers={"Content-Type": content_type},
            timeout=300.0,
        )
        res.raise_for_status()
        return StoredObject(key, None, res.json()["storageId"], len(data))

    def get(self, key: str) -> bytes:
        if self._s3 is None:
            raise RuntimeError("Ohne S3 wird ueber die Convex-Adresse gelesen")
        obj = self._s3.get_object(Bucket=self.bucket, Key=key)
        return obj["Body"].read()


class ConvexClient:
    """Aufrufe an die Dienst-Endpunkte des Backends."""

    def __init__(self, site_url: str, secret: str, timeout: float = 120.0) -> None:
        self.site_url = site_url.rstrip("/")
        self.secret = secret
        self._client = httpx.Client(timeout=timeout, follow_redirects=False)

    @staticmethod
    def _strip_none(value: Any) -> Any:
        """Leere Felder weglassen.

        Der Validator im Backend nimmt fehlende Felder an, aber kein null —
        sonst scheitert die Rueckmeldung still am Rand.
        """
        if isinstance(value, dict):
            return {
                k: ConvexClient._strip_none(v) for k, v in value.items() if v is not None
            }
        if isinstance(value, list):
            return [ConvexClient._strip_none(v) for v in value]
        return value

    def post(self, path: str, body: dict) -> Any:
        body = self._strip_none(body)
        res = self._client.post(
            f"{self.site_url}{path}",
            json=body,
            headers={"x-service-secret": self.secret},
        )
        if res.status_code != 200:
            raise RuntimeError(
                f"{path} scheiterte: {res.status_code} {res.text[:300]}"
            )
        return res.json()

    def download(self, url: str, max_bytes: int) -> bytes:
        chunks: list[bytes] = []
        size = 0
        with self._client.stream("GET", url, timeout=900.0) as res:
            if res.status_code != 200:
                raise RuntimeError(f"Quelle nicht ladbar: {res.status_code}")
            for chunk in res.iter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise RuntimeError("Quelldatei zu gross")
                chunks.append(chunk)
        return b"".join(chunks)


def issue_key(publication_id: str, issue_id: str, *parts: str) -> str:
    return "/".join(
        ["publications", publication_id, "issues", issue_id, *[str(p) for p in parts]]
    )
