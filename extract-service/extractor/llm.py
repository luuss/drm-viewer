"""Optionale KI-Stufe: gruppiert erkannte Textbloecke zu Artikeln.

Der Volltext bleibt lokal. An das Modell geht nur ein Verzeichnis der Bloecke
mit Seite, Position, Schriftgroesse und den ersten Zeichen. Das Modell liefert
nur Gruppen und Titel zurueck. Das haelt die Kosten pro Heft im Centbereich und
verhindert, dass Textfehler durch Halluzination entstehen.
"""

from __future__ import annotations

import json
import os
import urllib.request

MODEL = os.environ.get("EXTRACT_LLM_MODEL", "claude-sonnet-5")
API_URL = "https://api.anthropic.com/v1/messages"

SYSTEM = (
    "Du ordnest Textbloecke einer Zeitschriftenseite zu Artikeln. "
    "Ein Artikel kann ueber mehrere Seiten laufen und auf einer Seite koennen "
    "mehrere Artikel stehen. Antworte nur mit JSON."
)

PROMPT = """Hier ist das Blockverzeichnis eines Hefts. Jeder Block hat eine id,
die Seite, die Position (x0,y0 in Punkten), die groesste Schriftgroesse, die
erkannte Art und einen Textanfang.

Gruppiere die Bloecke zu Artikeln in Lesereihenfolge. Regeln:
- Jeder Block gehoert zu genau einem Artikel, ausser er ist Beiwerk (Seitenzahl,
  Kolumnentitel, Anzeige, Bildnachweis) — dann lass ihn weg.
- Ein Artikel beginnt mit seiner Ueberschrift.
- Fortsetzungen auf der naechsten Seite gehoeren zum selben Artikel.
- Bildunterschriften und Schmuckzitate gehoeren nicht in den Fliesstext.

Antworte als JSON:
{"articles":[{"title":"...","subtitle":null,"blockIds":[1,2,3]}]}

Blockverzeichnis:
%s
"""


def enabled() -> bool:
    """Die KI-Stufe ist aus, solange sie nicht ausdruecklich eingeschaltet wird.

    Sie entscheidet nur ueber die Gruppierung; der Text bleibt so, wie er in der
    Druckdatei steht.
    """
    if os.environ.get("EXTRACT_USE_LLM", "").lower() not in ("1", "true", "ja"):
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def available() -> bool:
    return enabled()


def _digest(blocks: list[dict], limit: int = 90) -> str:
    rows = []
    for b in blocks:
        rows.append(
            {
                "id": b["id"],
                "page": b["page"],
                "x": round(b["x0"]),
                "y": round(b["y0"]),
                "size": round(b["size"], 1),
                "kind": b["kind"],
                "chars": b["chars"],
                "start": b["start"][:limit],
            }
        )
    return json.dumps(rows, ensure_ascii=False)


def group_with_llm(blocks: list[dict], timeout: float = 240.0) -> list[dict] | None:
    """Gibt Gruppen zurueck oder None, wenn die Stufe nicht nutzbar ist."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None

    payload = {
        "model": MODEL,
        "max_tokens": 8000,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": PROMPT % _digest(blocks)}],
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        data = json.loads(res.read().decode())

    text = "".join(part.get("text", "") for part in data.get("content", []))
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    parsed = json.loads(text[start : end + 1])
    return parsed.get("articles")
