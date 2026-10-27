"""Stub of instascraper.scraper (v1.1.0): `scrape` with the real signature, no network."""

from __future__ import annotations

from dataclasses import dataclass

# Set to an exception to make scrape raise it.
SCRAPE_RAISES: BaseException | None = None
CALLS: list[dict] = []


@dataclass
class FakeMedia:
    media_type: int = 1


@dataclass
class ScrapeResult:
    shortcode: str
    source_url: str
    owner: str


def scrape(client, shortcode: str, source_url: str, account: str, sort: str = "likes", scan_limit: int = 200,
           progress=None, humanizer=None):
    CALLS.append(dict(shortcode=shortcode, source_url=source_url, account=account, humanizer=humanizer))
    if SCRAPE_RAISES is not None:
        raise SCRAPE_RAISES
    return FakeMedia(), ScrapeResult(shortcode=shortcode, source_url=source_url, owner="someone")
