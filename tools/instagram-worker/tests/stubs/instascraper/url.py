"""Copy of instascraper.url (v1.1.0)."""

import re

_SHORTCODE_RE = re.compile(
    r"https?://(?:www\.)?instagram\.com/(?:p|reel|tv)/(?P<shortcode>[A-Za-z0-9_-]+)"
)


def parse_shortcode(url: str) -> str:
    match = _SHORTCODE_RE.match(url.strip())
    if not match:
        raise ValueError(f"Not a recognized Instagram post/reel/tv URL: {url!r}")
    return match.group("shortcode")
