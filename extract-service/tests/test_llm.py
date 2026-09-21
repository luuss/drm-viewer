from __future__ import annotations

import json

import httpx

from extractor.llm import HttpProvider, LlmConfig, postprocess_issue
from extractor.model import AssembledArticle, LayoutLine, SourceBlock, SourceImage


def config(**overrides) -> LlmConfig:
    values = {
        "use_llm": True,
        "provider": "anthropic",
        "model": "test-vision",
        "api_key": "secret-test-key",
        "base_url": "https://example.invalid/v1/messages",
        "max_pages": 2,
        "retries": 0,
        "retry_base": 0,
    }
    values.update(overrides)
    return LlmConfig(**values)


def line(text: str, y: float, **overrides) -> LayoutLine:
    values = {
        "page_index": 4,
        "text": text,
        "x0": 0.1,
        "y0": y,
        "x1": 0.8,
        "y1": y + 0.02,
        "size": 10.0,
        "max_size": 10.0,
        "font": "Test",
        "column": 0,
    }
    values.update(overrides)
    return LayoutLine(**values)


def fixture():
    heading_line = line("Ein genauer Titel", 0.1, size=18.0, max_size=18.0, bold=True)
    body_lines = (
        line("Der Absatz endet mit Sozial\u00ad", 0.2, continues_word=True),
        line("versicherung und bleibt quelltreu.", 0.23),
    )
    caption_line = line("Das passende Bild zum Absatz", 0.62, size=8.0, max_size=8.0)
    heading = SourceBlock(
        4, heading_line.text, 0.1, 0.1, 0.8, 0.13,
        kind="heading", layout_lines=(heading_line,),
    )
    body = SourceBlock(
        4, "Der Absatz endet mit Sozialversicherung und bleibt quelltreu.",
        0.1, 0.2, 0.8, 0.25, kind="paragraph", layout_lines=body_lines,
    )
    caption = SourceBlock(
        4, caption_line.text, 0.1, 0.62, 0.5, 0.64,
        kind="caption", layout_lines=(caption_line,),
    )
    image = SourceImage(4, 0.1, 0.35, 0.8, 0.6)
    article = AssembledArticle(
        "Ein genauer Titel", blocks=[heading, body], images=[image]
    )
    return [article], [heading, body, caption], [image]


class GoodProvider:
    def complete(self, payload, page_images):
        assert payload["pages"] == [4]
        assert page_images == {4: b"jpeg"}
        return {
            "schemaVersion": 1,
            "articles": [{
                "candidateId": "a0",
                "groups": [
                    {"type": "heading", "lineIds": ["l0_0"], "joins": []},
                    {
                        "type": "paragraph",
                        "lineIds": ["l1_0", "l1_1"],
                        "joins": ["none"],
                    },
                ],
            }],
            "imageLinks": [{
                "imageId": "i0", "candidateId": "a0", "afterLineId": "l1_1"
            }],
            "captions": [{"imageId": "i0", "lineIds": ["l2_0"]}],
            "discarded": [],
        }


def test_llm_rekonstruiert_text_aus_ids_und_verankert_bild():
    articles, blocks, images = fixture()
    report = postprocess_issue(
        articles,
        blocks,
        images,
        {4: b"jpeg"},
        config=config(),
        provider=GoodProvider(),
    )

    assert report.applied_chunks == 1
    assert articles[0].llm_refined is True
    assert [block.kind for block in articles[0].blocks] == ["heading", "paragraph"]
    assert articles[0].blocks[1].text == (
        "Der Absatz endet mit Sozialversicherung und bleibt quelltreu."
    )
    assert articles[0].images == images
    assert images[0].caption == "Das passende Bild zum Absatz"
    assert images[0].after_block_order is None
    assert images[0].after_block is articles[0].blocks[1]


class InvalidProvider:
    def complete(self, payload, page_images):
        return {
            "schemaVersion": 1,
            "articles": [{
                "candidateId": "a0",
                "groups": [{
                    "type": "paragraph", "lineIds": ["erfunden"], "joins": []
                }],
            }],
            "imageLinks": [],
            "captions": [],
            "discarded": [],
        }


def test_ungueltige_ids_lassen_deterministisches_ergebnis_unveraendert():
    articles, blocks, images = fixture()
    original_blocks = list(articles[0].blocks)
    report = postprocess_issue(
        articles,
        blocks,
        images,
        {4: b"jpeg"},
        config=config(),
        provider=InvalidProvider(),
    )

    assert report.failed_chunks == 1
    assert articles[0].blocks == original_blocks
    assert articles[0].images == images
    assert articles[0].llm_refined is False


def test_ohne_explizites_modell_bleibt_llm_aus(monkeypatch):
    monkeypatch.setenv("EXTRACT_USE_LLM", "true")
    monkeypatch.setenv("EXTRACT_LLM_API_KEY", "secret")
    monkeypatch.delenv("EXTRACT_LLM_MODEL", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    articles, blocks, images = fixture()

    report = postprocess_issue(articles, blocks, images, {4: b"jpeg"})

    assert report.attempted_chunks == 0
    assert articles[0].llm_refined is False


def test_standardmaessig_aus(monkeypatch):
    monkeypatch.delenv("EXTRACT_USE_LLM", raising=False)
    monkeypatch.setenv("EXTRACT_LLM_MODEL", "test-vision")
    monkeypatch.setenv("EXTRACT_LLM_API_KEY", "secret")
    from extractor import llm

    assert llm.enabled() is False


def test_openrouter_erzwingt_together_und_zdr():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        assert request.headers["authorization"] == "Bearer secret-test-key"
        return httpx.Response(
            200,
            json={
                "choices": [{
                    "message": {"content": '{"schemaVersion":1}'}
                }]
            },
        )

    openrouter = config(
        provider="openrouter",
        base_url="https://openrouter.ai/api/v1/chat/completions",
        routing_only=("together",),
        require_zdr=True,
        deny_data_collection=True,
        allow_fallbacks=False,
    )
    result = HttpProvider(
        openrouter, transport=httpx.MockTransport(handler)
    ).complete({"schemaVersion": 1}, {4: b"jpeg"})

    assert result == {"schemaVersion": 1}
    assert seen["model"] == "test-vision"
    assert seen["provider"] == {
        "zdr": True,
        "data_collection": "deny",
        "allow_fallbacks": False,
        "only": ["together"],
    }
