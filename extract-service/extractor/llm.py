"""Texttreue, optionale LLM-Nachbearbeitung der Druckextraktion.

Das Modell sieht kleine Seitenfenster als JPEG sowie vollstaendige, stabile
Zeilen- und Bild-IDs. Es darf ausschliesslich IDs ordnen und klassifizieren.
Der eigentliche Text wird hier aus den PDF-Zeilen rekonstruiert; erfundener
oder umformulierter Inhalt kann deshalb nicht in die Ausgabe gelangen.

Jeder ungueltige oder fehlgeschlagene Chunk faellt auf die deterministische
Extraktion zurueck. Ein LLM-Problem darf niemals den gesamten Import zerstoeren.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import time
from dataclasses import dataclass, replace
from typing import Callable, Protocol

import httpx

from .model import AssembledArticle, LayoutLine, SourceBlock, SourceImage
from .textutil import SOFT_HYPHEN, clean_text

ALLOWED_TYPES = {
    "heading", "subheading", "lead", "paragraph", "quote", "box", "other"
}
ALLOWED_DISCARD_REASONS = {"furniture", "advertisement", "duplicate", "map_label"}

SYSTEM = """Du pruefst eine Magazinextraktion anhand der sichtbaren Druckseiten.
Antworte ausschliesslich als JSON entsprechend dem beschriebenen Schema.
Du darfst Text niemals umschreiben oder ergaenzen, sondern nur vorhandene IDs
ordnen, zu Absaetzen gruppieren, Rollen bestimmen, Bilder Artikeln zuweisen und
Bildunterschriften verknuepfen. Jede lineId und imageId muss genau einmal
vorkommen. Kartenbeschriftungen, Anzeigen und Beiwerk gehoeren in discarded.
Ein Artikel darf ueber Spalten und Seiten laufen. Die Reihenfolge muss dem
visuellen und semantischen Lesefluss entsprechen."""

OUTPUT_CONTRACT = {
    "schemaVersion": 1,
    "articles": [{
        "candidateId": "a0",
        "groups": [{
            "type": "paragraph",
            "lineIds": ["l0"],
            "joins": [],
        }],
    }],
    "imageLinks": [{
        "imageId": "i0",
        "candidateId": "a0",
        "afterLineId": "l0 oder null fuer vor dem ersten Absatz",
    }],
    "captions": [{"imageId": "i0", "lineIds": ["l1"]}],
    "discarded": [{"lineId": "l2", "reason": "map_label"}],
}


class Provider(Protocol):
    def complete(self, payload: dict, page_images: dict[int, bytes]) -> dict: ...


@dataclass(frozen=True)
class LlmConfig:
    use_llm: bool
    provider: str
    model: str
    api_key: str
    base_url: str
    timeout: float = 120.0
    max_pages: int = 2
    retries: int = 2
    retry_base: float = 1.0
    routing_only: tuple[str, ...] = ()
    require_zdr: bool = True
    deny_data_collection: bool = True
    allow_fallbacks: bool = False

    @classmethod
    def from_env(cls) -> "LlmConfig":
        use = os.environ.get("EXTRACT_USE_LLM", "").lower() in ("1", "true", "ja")
        provider = os.environ.get("EXTRACT_LLM_PROVIDER", "anthropic").strip().lower()
        legacy_key = (
            os.environ.get("ANTHROPIC_API_KEY", "") if provider == "anthropic"
            else os.environ.get("OPENAI_API_KEY", "")
        )
        key = os.environ.get("EXTRACT_LLM_API_KEY", "") or legacy_key
        if provider == "anthropic":
            default_url = "https://api.anthropic.com/v1/messages"
        elif provider == "openrouter":
            default_url = "https://openrouter.ai/api/v1/chat/completions"
        else:
            default_url = "https://api.openai.com/v1/chat/completions"
        routing_only = tuple(
            value.strip()
            for value in os.environ.get("EXTRACT_LLM_ROUTING_ONLY", "").split(",")
            if value.strip()
        )
        env_bool = lambda name, default: os.environ.get(
            name, "true" if default else "false"
        ).lower() in ("1", "true", "ja", "yes")
        return cls(
            use_llm=use,
            provider=provider,
            model=os.environ.get("EXTRACT_LLM_MODEL", "").strip(),
            api_key=key,
            base_url=(os.environ.get("EXTRACT_LLM_BASE_URL") or default_url).strip(),
            timeout=float(os.environ.get("EXTRACT_LLM_TIMEOUT", "120")),
            max_pages=max(1, min(3, int(os.environ.get("EXTRACT_LLM_MAX_PAGES", "2")))),
            retries=max(0, min(4, int(os.environ.get("EXTRACT_LLM_RETRIES", "2")))),
            retry_base=max(0.0, float(os.environ.get("EXTRACT_LLM_RETRY_BASE", "1"))),
            routing_only=routing_only,
            require_zdr=env_bool("EXTRACT_LLM_ZDR", True),
            deny_data_collection=(
                os.environ.get("EXTRACT_LLM_DATA_COLLECTION", "deny").lower() == "deny"
            ),
            allow_fallbacks=env_bool("EXTRACT_LLM_ALLOW_FALLBACKS", False),
        )

    @property
    def enabled(self) -> bool:
        return (
            self.use_llm
            and self.provider in ("anthropic", "openai", "openrouter")
            and bool(self.model)
            and bool(self.api_key)
        )


def enabled() -> bool:
    """Nur explizite, vollstaendige Worker-Konfiguration aktiviert die Stufe."""
    return LlmConfig.from_env().enabled


def available() -> bool:
    return enabled()


class HttpProvider:
    """Kleiner multimodaler Adapter ohne Anbieter-SDK."""

    def __init__(self, config: LlmConfig, transport=None) -> None:
        self.config = config
        self.transport = transport

    def complete(self, payload: dict, page_images: dict[int, bytes]) -> dict:
        prompt = json.dumps(
            {"outputContract": OUTPUT_CONTRACT, "input": payload},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        if self.config.provider == "anthropic":
            content: list[dict] = []
            for page, jpeg in sorted(page_images.items()):
                content.append({"type": "text", "text": f"Druckseite page={page}"})
                content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": base64.b64encode(jpeg).decode("ascii"),
                    },
                })
            content.append({"type": "text", "text": prompt})
            body = {
                "model": self.config.model,
                "max_tokens": 12000,
                "system": SYSTEM,
                "messages": [{"role": "user", "content": content}],
            }
            headers = {
                "x-api-key": self.config.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
        else:
            content = [{"type": "text", "text": SYSTEM + "\n\n" + prompt}]
            for page, jpeg in sorted(page_images.items()):
                data = base64.b64encode(jpeg).decode("ascii")
                content.append({"type": "text", "text": f"Druckseite page={page}"})
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{data}", "detail": "high"},
                })
            body = {
                "model": self.config.model,
                "max_tokens": 12000,
                "messages": [{"role": "user", "content": content}],
                "response_format": {"type": "json_object"},
            }
            if self.config.provider == "openrouter":
                routing: dict = {
                    "zdr": self.config.require_zdr,
                    "data_collection": (
                        "deny" if self.config.deny_data_collection else "allow"
                    ),
                    "allow_fallbacks": self.config.allow_fallbacks,
                }
                if self.config.routing_only:
                    routing["only"] = list(self.config.routing_only)
                body["provider"] = routing
            headers = {
                "authorization": f"Bearer {self.config.api_key}",
                "content-type": "application/json",
            }

        with httpx.Client(timeout=self.config.timeout, transport=self.transport) as client:
            response = client.post(self.config.base_url, headers=headers, json=body)
            response.raise_for_status()
            data = response.json()
        if self.config.provider == "anthropic":
            text = "".join(
                part.get("text", "")
                for part in data.get("content", [])
                if part.get("type") == "text"
            )
        else:
            text = data["choices"][0]["message"]["content"]
        return _parse_json(text)


def _parse_json(text: str | dict) -> dict:
    if isinstance(text, dict):
        return text
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("LLM-Antwort enthaelt kein JSON-Objekt")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("LLM-Antwort ist kein JSON-Objekt")
    return parsed


def _layout_lines(block: SourceBlock) -> tuple[LayoutLine, ...]:
    if block.layout_lines:
        return block.layout_lines
    return (
        LayoutLine(
            page_index=block.page_index,
            text=block.text,
            x0=block.x0,
            y0=block.y0,
            x1=block.x1,
            y1=block.y1,
            size=block.size,
            max_size=block.max_size,
            font=block.font,
            bold=block.bold,
            column=block.column,
            continues_word=block.continues_word,
        ),
    )


def _join_lines(lines: list[LayoutLine], joins: list[str]) -> str:
    text = lines[0].text.strip()
    for mode, line in zip(joins, lines[1:]):
        following = line.text.strip()
        if mode == "none":
            if text.endswith(SOFT_HYPHEN):
                text = text[:-1]
            elif text.endswith("-"):
                text = text[:-1]
            text += following
        else:
            text += " " + following
    return clean_text(text)


def _build_chunk(
    articles: list[AssembledArticle],
    blocks: list[SourceBlock],
    images: list[SourceImage],
    pages: list[int],
) -> tuple[dict, dict[str, LayoutLine], dict[str, SourceBlock], dict[str, SourceImage]]:
    page_set = set(pages)
    article_ids = {id(article): f"a{i}" for i, article in enumerate(articles)}
    block_candidate: dict[int, str] = {}
    for article in articles:
        candidate = article_ids[id(article)]
        for block in article.blocks:
            block_candidate[id(block)] = candidate

    line_map: dict[str, LayoutLine] = {}
    line_source: dict[str, SourceBlock] = {}
    rows = []
    for block_index, block in enumerate(blocks):
        if block.page_index not in page_set or block.drop:
            continue
        block_id = f"b{block_index}"
        for line_index, line in enumerate(_layout_lines(block)):
            line_id = f"l{block_index}_{line_index}"
            line_map[line_id] = line
            line_source[line_id] = block
            rows.append({
                "id": line_id,
                "blockId": block_id,
                "candidateId": block_candidate.get(id(block)),
                "page": line.page_index,
                "bbox": [round(line.x0, 5), round(line.y0, 5),
                         round(line.x1, 5), round(line.y1, 5)],
                "text": line.text,
                "size": round(line.size, 2),
                "font": line.font,
                "bold": line.bold,
                "column": line.column,
                "currentRole": block.kind,
                "storyId": block.story_id,
                "styleName": block.style_name,
                "continuesWord": line.continues_word,
            })

    image_map: dict[str, SourceImage] = {}
    image_rows = []
    current_image_article = {
        id(image): article_ids[id(article)]
        for article in articles
        for image in article.images
    }
    for index, image in enumerate(images):
        if image.page_index not in page_set:
            continue
        image_id = f"i{index}"
        image_map[image_id] = image
        image_rows.append({
            "id": image_id,
            "page": image.page_index,
            "bbox": [round(image.x0, 5), round(image.y0, 5),
                     round(image.x1, 5), round(image.y1, 5)],
            "candidateId": current_image_article.get(id(image)),
            "currentCaption": image.caption,
        })

    candidate_rows = []
    for article in articles:
        candidate = article_ids[id(article)]
        ids = [row["id"] for row in rows if row["candidateId"] == candidate]
        if ids:
            candidate_rows.append({
                "id": candidate,
                "title": article.title,
                "lineIds": ids,
            })
    payload = {
        "schemaVersion": 1,
        "pages": pages,
        "candidateArticles": candidate_rows,
        "lines": rows,
        "images": image_rows,
    }
    return payload, line_map, line_source, image_map


def _validate(
    result: dict,
    payload: dict,
    line_map: dict[str, LayoutLine],
    image_map: dict[str, SourceImage],
) -> None:
    if result.get("schemaVersion") != 1:
        raise ValueError("falsche schemaVersion")
    candidates = {row["id"] for row in payload["candidateArticles"]}
    seen_lines: set[str] = set()
    grouped_lines: dict[str, str] = {}
    article_rows = result.get("articles")
    if not isinstance(article_rows, list):
        raise ValueError("articles fehlt")
    seen_candidates: set[str] = set()
    for article in article_rows:
        candidate = article.get("candidateId")
        if candidate not in candidates or candidate in seen_candidates:
            raise ValueError("unbekannte oder doppelte candidateId")
        seen_candidates.add(candidate)
        if not isinstance(article.get("groups"), list):
            raise ValueError("groups fehlt")
        for group in article["groups"]:
            ids = group.get("lineIds")
            joins = group.get("joins")
            if group.get("type") not in ALLOWED_TYPES or not isinstance(ids, list) or not ids:
                raise ValueError("ungueltige Gruppe")
            if not isinstance(joins, list) or len(joins) != len(ids) - 1:
                raise ValueError("joins passt nicht zu lineIds")
            if any(join not in ("space", "none") for join in joins):
                raise ValueError("unbekannter Join")
            if any(line_id not in line_map for line_id in ids):
                raise ValueError("unbekannte lineId")
            if len({line_map[line_id].page_index for line_id in ids}) != 1:
                raise ValueError("Absatz darf keine Seiten mischen")
            for line_id in ids:
                if line_id in seen_lines:
                    raise ValueError("doppelte lineId")
                seen_lines.add(line_id)
                grouped_lines[line_id] = candidate

    if seen_candidates != candidates:
        raise ValueError("LLM hat einen Artikelkandidaten ausgelassen")

    for caption in result.get("captions", []):
        if caption.get("imageId") not in image_map:
            raise ValueError("unbekannte caption imageId")
        ids = caption.get("lineIds")
        if not isinstance(ids, list) or not ids:
            raise ValueError("leere Bildunterschrift")
        if any(line_id not in line_map for line_id in ids):
            raise ValueError("unbekannte Caption-lineId")
        image_page = image_map[caption["imageId"]].page_index
        if any(line_map[line_id].page_index != image_page for line_id in ids):
            raise ValueError("Caption und Bild liegen auf verschiedenen Seiten")
        for line_id in ids:
            if line_id in seen_lines:
                raise ValueError("doppelte Caption-lineId")
            seen_lines.add(line_id)

    for discarded in result.get("discarded", []):
        line_id = discarded.get("lineId")
        if line_id not in line_map or line_id in seen_lines:
            raise ValueError("unbekannte oder doppelte discarded lineId")
        if discarded.get("reason") not in ALLOWED_DISCARD_REASONS:
            raise ValueError("unbekannter Ausschlussgrund")
        seen_lines.add(line_id)

    if seen_lines != set(line_map):
        raise ValueError("LLM hat Zeilen ausgelassen")

    links = result.get("imageLinks")
    if not isinstance(links, list):
        raise ValueError("imageLinks fehlt")
    seen_images: set[str] = set()
    for link in links:
        image_id = link.get("imageId")
        candidate = link.get("candidateId")
        anchor = link.get("afterLineId")
        if image_id not in image_map or image_id in seen_images:
            raise ValueError("unbekannte oder doppelte imageId")
        if candidate not in candidates:
            raise ValueError("Bild verweist auf unbekannten Artikel")
        if anchor is not None and grouped_lines.get(anchor) != candidate:
            raise ValueError("Bildanker liegt nicht im Zielartikel")
        seen_images.add(image_id)
    if seen_images != set(image_map):
        raise ValueError("LLM hat Bilder ausgelassen")


def _block_from_group(
    group: dict,
    line_map: dict[str, LayoutLine],
    line_source: dict[str, SourceBlock],
) -> SourceBlock:
    ids = group["lineIds"]
    lines = [line_map[line_id] for line_id in ids]
    source = line_source[ids[0]]
    sizes = [line.size for line in lines if line.size]
    return replace(
        source,
        page_index=lines[0].page_index,
        text=_join_lines(lines, group["joins"]),
        x0=min(line.x0 for line in lines),
        y0=min(line.y0 for line in lines),
        x1=max(line.x1 for line in lines),
        y1=max(line.y1 for line in lines),
        size=sum(sizes) / len(sizes) if sizes else source.size,
        max_size=max((line.max_size for line in lines), default=source.max_size),
        kind=group["type"],
        column=lines[0].column,
        continues_word=lines[-1].continues_word,
        layout_lines=tuple(lines),
        llm_refined=True,
    )


def _apply(
    result: dict,
    articles: list[AssembledArticle],
    pages: list[int],
    line_map: dict[str, LayoutLine],
    line_source: dict[str, SourceBlock],
    image_map: dict[str, SourceImage],
) -> None:
    page_set = set(pages)
    by_candidate = {f"a{i}": article for i, article in enumerate(articles)}
    replacement: dict[str, list[SourceBlock]] = {}
    line_to_block: dict[str, SourceBlock] = {}
    for row in result["articles"]:
        candidate = row["candidateId"]
        groups = []
        for group in row["groups"]:
            block = _block_from_group(group, line_map, line_source)
            groups.append(block)
            for line_id in group["lineIds"]:
                line_to_block[line_id] = block
        replacement[candidate] = groups

    for candidate, article in by_candidate.items():
        groups = replacement.get(candidate)
        if groups is None:
            continue
        existing_by_page: dict[int, list[SourceBlock]] = {}
        for block in article.blocks:
            existing_by_page.setdefault(block.page_index, []).append(block)
        replacement_by_page: dict[int, list[SourceBlock]] = {}
        for block in groups:
            replacement_by_page.setdefault(block.page_index, []).append(block)
        rebuilt: list[SourceBlock] = []
        for page in sorted(set(existing_by_page) | set(replacement_by_page)):
            rebuilt.extend(
                replacement_by_page.get(page, [])
                if page in page_set
                else existing_by_page.get(page, [])
            )
        article.blocks = rebuilt
        article.llm_refined = True

    for article in articles:
        article.images = [image for image in article.images if image.page_index not in page_set]

    captions = {row["imageId"]: row["lineIds"] for row in result.get("captions", [])}
    for image_id, ids in captions.items():
        lines = [line_map[line_id] for line_id in ids]
        image_map[image_id].caption = _join_lines(lines, ["space"] * (len(lines) - 1))

    for link in result["imageLinks"]:
        article = by_candidate[link["candidateId"]]
        image = image_map[link["imageId"]]
        anchor = link.get("afterLineId")
        if anchor is None:
            image.after_block_order = 0
            image.after_block = None
        else:
            anchor_block = line_to_block[anchor]
            image.after_block_order = None
            image.after_block = anchor_block
        article.images.append(image)
        article.llm_refined = True

    for article in articles:
        article.images.sort(key=lambda image: (
            image.after_block_order if image.after_block_order is not None else 10**9,
            image.page_index,
            image.y0,
        ))


def _call(
    provider: Provider,
    payload: dict,
    images: dict[int, bytes],
    config: LlmConfig,
) -> dict:
    last: Exception | None = None
    for attempt in range(config.retries + 1):
        try:
            return provider.complete(payload, images)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
            last = exc
            if isinstance(exc, httpx.HTTPStatusError):
                status = exc.response.status_code
                if status not in (408, 429) and status < 500:
                    raise
            if attempt >= config.retries:
                raise
            delay = config.retry_base * (2**attempt) + random.random() * config.retry_base
            if delay:
                time.sleep(delay)
    assert last is not None
    raise last


@dataclass(frozen=True)
class RefinementReport:
    attempted_chunks: int = 0
    applied_chunks: int = 0
    failed_chunks: int = 0

    @property
    def applied(self) -> bool:
        return self.applied_chunks > 0


def postprocess_issue(
    articles: list[AssembledArticle],
    blocks: list[SourceBlock],
    images: list[SourceImage],
    page_images: dict[int, bytes],
    *,
    config: LlmConfig | None = None,
    provider: Provider | None = None,
    heartbeat: Callable[[str], None] | None = None,
    event_log: Callable[..., None] | None = None,
) -> RefinementReport:
    """Verbessert kleine Seitenfenster; Fehler lassen die Originaldaten stehen."""
    config = config or LlmConfig.from_env()
    if not config.enabled and provider is None:
        return RefinementReport()
    provider = provider or HttpProvider(config)
    pages = sorted(
        ({block.page_index for block in blocks if not block.drop}
         | {image.page_index for image in images})
        & set(page_images)
    )
    report = RefinementReport()
    for offset in range(0, len(pages), config.max_pages):
        chunk_pages = pages[offset : offset + config.max_pages]
        payload, line_map, line_source, image_map = _build_chunk(
            articles, blocks, images, chunk_pages
        )
        if not payload["candidateArticles"] or not line_map:
            continue
        fingerprint = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()[:12]
        report = replace(report, attempted_chunks=report.attempted_chunks + 1)
        if heartbeat:
            heartbeat(f"KI prueft Seiten {chunk_pages[0] + 1}–{chunk_pages[-1] + 1}")
        try:
            result = _call(
                provider,
                payload,
                {page: page_images[page] for page in chunk_pages},
                config,
            )
            _validate(result, payload, line_map, image_map)
            _apply(result, articles, chunk_pages, line_map, line_source, image_map)
            report = replace(report, applied_chunks=report.applied_chunks + 1)
            if event_log:
                event_log("llm.chunk", pages=chunk_pages, fingerprint=fingerprint, status="applied")
        except Exception as exc:
            report = replace(report, failed_chunks=report.failed_chunks + 1)
            if event_log:
                event_log(
                    "llm.chunk",
                    pages=chunk_pages,
                    fingerprint=fingerprint,
                    status="fallback",
                    error=type(exc).__name__,
                )
    return report
