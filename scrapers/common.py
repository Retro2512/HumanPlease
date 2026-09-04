"""Shared infrastructure for the corporate-contact extraction pipeline.

Design goals:
- Polite: sequential per host, jittered delay, robots.txt honored via
  urllib.robotparser, honest User-Agent that identifies the project.
- Robust: retries with exponential backoff, tolerates 5xx/timeouts,
  never crashes the whole run on one bad page.
- Resumable: raw HTML cached on disk keyed by URL hash; each scraper
  keeps a frontier/progress file so a killed run continues where it left off.
- Clean: structured records only - phone numbers, addresses, hours,
  emails, and short functional phone-tree steps. No review text, no
  personal opinions, no private individual data.
"""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import logging
import random
import re
import sys
import time
import urllib.robotparser
import socket
import ssl
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 ContactDataResearch/1.0 "
    "(public corporate contact info aggregation)"
)

BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
}
MAX_SITEMAP_URLS = 100_000
MAX_RESPONSE_BYTES = 5_000_000
_HOST_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


class FetchError(Exception):
    pass


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, connect_ip: str, timeout: int):
        super().__init__(hostname, port=443, timeout=timeout, context=ssl.create_default_context())
        self._connect_ip = connect_ip

    def connect(self) -> None:
        sock = socket.create_connection((self._connect_ip, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("scrape")

PHONE_RE = re.compile(
    r"(?<![\d.\-])"
    r"(?:\+?1[\s.\-]?)?"
    r"(?:\(\s*\d{3}\s*\)|\d{3})"
    r"[\s.\-]"
    r"\d{3}"
    r"[\s.\-]"
    r"\d{4}"
    r"(?![\d.\-])"
)

_TOLLFREE_PREFIX = re.compile(r"^(800|833|844|855|866|877|888)$")


def normalize_phone(raw: str) -> str:
    """Return digits-only US-style number ('8005551234') or ''."""
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return ""
    return digits


def pretty_phone(digits10: str) -> str:
    if len(digits10) == 10:
        return f"{digits10[:3]}-{digits10[3:6]}-{digits10[6:]}"
    return digits10


def is_tollfree(digits10: str) -> bool:
    return bool(_TOLLFREE_PREFIX.match(digits10[:3]))


def clean_text(s: str) -> str:
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]", "", s or "")
    s = re.sub(r"\s+", " ", s or "").strip()
    return s


class PoliteFetcher:
    """Sequential, robots-honoring fetcher with disk cache and retries."""

    def __init__(self, site: str, delay: float = 1.0, jitter: float = 0.5,
                 timeout: int = 30, cache: bool = True, respect_robots: bool = True, max_attempts: int = 4,
                 allowed_hosts: tuple[str, ...] = ()):
        if not re.fullmatch(r"[a-z0-9_-]+", site):
            raise ValueError("site cache key is invalid")
        if not allowed_hosts:
            raise ValueError("allowed_hosts is required")
        self.site = site
        normalized_hosts = tuple(host.lower().rstrip(".") for host in allowed_hosts)
        for allowed_host in normalized_hosts:
            suffix = allowed_host.removeprefix(".")
            labels = suffix.split(".")
            if (
                len(suffix) > 253
                or len(labels) < 2
                or any(not _HOST_LABEL_RE.fullmatch(label) for label in labels)
            ):
                raise ValueError("allowed_hosts contains an invalid hostname")
            try:
                ipaddress.ip_address(suffix)
            except ValueError:
                pass
            else:
                raise ValueError("allowed_hosts cannot contain IP addresses")
        self.allowed_hosts = normalized_hosts
        self.delay = delay
        self.jitter = jitter
        self.timeout = timeout
        self.cache = cache
        self.respect_robots = respect_robots
        self.max_attempts = max(1, int(max_attempts))
        self.cache_dir = RAW / site
        if self.cache:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self.stats = {"fetched": 0, "cached": 0, "errors": 0, "robots_blocked": 0}
        self._last_request_time = 0.0

    def _validate_origin(self, url: str) -> str:
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in url):
            raise ValueError("URL contains a control character")
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        allowed = any(host == item or (item.startswith(".") and host.endswith(item)) for item in self.allowed_hosts)
        if parsed.scheme != "https" or not host or not allowed or parsed.username or parsed.password:
            raise ValueError("URL is outside the scraper allowlist")
        try:
            port = parsed.port
        except ValueError as error:
            raise ValueError("URL uses an invalid port") from error
        if port not in (None, 443):
            raise ValueError("URL uses a disallowed port")
        return host

    def _validate_url(self, url: str) -> tuple[str, tuple[str, ...]]:
        host = self._validate_origin(url)
        addresses = tuple(sorted({entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}))
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise ValueError("URL resolves to a non-public address")
        return host, addresses

    def _request_text(self, url: str) -> tuple[int, str]:
        current = url
        for _ in range(6):
            host, addresses = self._validate_url(current)
            parsed = urlparse(current)
            target = parsed.path or "/"
            if parsed.query:
                target += f"?{parsed.query}"
            connection = _PinnedHTTPSConnection(host, addresses[0], self.timeout)
            try:
                connection.request("GET", target, headers={**BASE_HEADERS, "Connection": "close"})
                resp = connection.getresponse()
                if resp.status in (301, 302, 303, 307, 308):
                    location = resp.headers.get("Location")
                    if not location:
                        return resp.status, ""
                    current = urljoin(current, location)
                    continue
                try:
                    declared = int(resp.headers.get("Content-Length", "0") or 0)
                except ValueError as error:
                    raise FetchError("invalid content length") from error
                if declared < 0 or declared > MAX_RESPONSE_BYTES:
                    raise FetchError("response too large")
                if (resp.headers.get("Content-Encoding") or "identity").lower() != "identity":
                    raise FetchError("encoded response refused")
                body = bytearray()
                while chunk := resp.read(64 * 1024):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise FetchError("response too large")
                encoding = resp.headers.get_content_charset() or "utf-8"
                try:
                    text = bytes(body).decode(encoding, errors="replace")
                except LookupError:
                    text = bytes(body).decode("utf-8", errors="replace")
                return resp.status, text
            finally:
                connection.close()
        raise FetchError("too many redirects")

    # ---- robots -------------------------------------------------------
    def _get_robots(self, scheme: str, host: str) -> urllib.robotparser.RobotFileParser | None:
        key = f"{scheme}://{host}"
        if key in self._robots:
            return self._robots[key]
        rp = urllib.robotparser.RobotFileParser()
        url = f"{key}/robots.txt"
        try:
            status, text = self._request_text(url)
            if status == 200:
                rp.parse(text.splitlines())
            else:
                rp = None  # no robots -> allow all
        except (FetchError, OSError, ValueError, http.client.HTTPException, ssl.SSLError):
            rp = None
        self._robots[key] = rp
        return rp

    def robots_allowed(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        p = urlparse(url)
        rp = self._get_robots(p.scheme, p.netloc)
        if rp is None:
            return True
        try:
            return rp.can_fetch(UA, url)
        except Exception:
            return True

    def crawl_delay(self, url: str) -> float | None:
        p = urlparse(url)
        rp = self._get_robots(p.scheme, p.netloc)
        if rp is None:
            return None
        try:
            d = rp.crawl_delay(UA)
            return float(d) if d else None
        except Exception:
            return None

    # ---- cache --------------------------------------------------------
    @staticmethod
    def _cache_key(url: str) -> str:
        return hashlib.sha256(url.encode()).hexdigest()

    def _cache_path(self, url: str) -> Path:
        h = self._cache_key(url)
        return self.cache_dir / f"{h}.html.gz"

    def _load_cache(self, url: str) -> str | None:
        if not self.cache:
            return None
        p = self._cache_path(url)
        if p.exists() and p.stat().st_size > 0:
            import gzip
            try:
                return gzip.decompress(p.read_bytes()).decode("utf-8", errors="replace")
            except OSError:  # legacy uncompressed file
                return p.read_text(encoding="utf-8", errors="replace")
        legacy = self.cache_dir / f"{self._cache_key(url)}.html"
        if legacy.exists() and legacy.stat().st_size > 0:
            return legacy.read_text(encoding="utf-8", errors="replace")
        return None

    def _save_cache(self, url: str, text: str) -> None:
        if not self.cache:
            return
        import gzip
        try:
            self._cache_path(url).write_bytes(gzip.compress(text.encode("utf-8"), 6))
        except OSError:
            pass

    # ---- fetching -----------------------------------------------------
    def _sleep(self, url: str) -> None:
        wait = self.delay + random.uniform(0, self.jitter)
        cd = self.crawl_delay(url)
        if cd and cd > wait:
            wait = cd
        now = time.time()
        remain = wait - (now - self._last_request_time)
        if remain > 0:
            time.sleep(remain)
        self._last_request_time = time.time()

    def get(self, url: str, force: bool = False) -> str | None:
        """GET a URL politely; returns text or None on final failure."""
        try:
            self._validate_url(url)
        except (OSError, ValueError) as error:
            self.stats["errors"] += 1
            log.warning("blocked unsafe URL %s (%s)", url, error)
            return None
        if not force:
            cached = self._load_cache(url)
            if cached is not None:
                self.stats["cached"] += 1
                return cached
        if not self.robots_allowed(url):
            self.stats["robots_blocked"] += 1
            log.warning("robots.txt disallows %s - skipping", url)
            return None

        backoff = 2.0
        for attempt in range(self.max_attempts):
            self._sleep(url)
            try:
                status, text = self._request_text(url)
                if status == 200:
                    self.stats["fetched"] += 1
                    self._save_cache(url, text)
                    return text
                if status in (429, 503):
                    log.warning("%s -> %s, backing off %.0fs", url, status, backoff)
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 120)
                    continue
                if status in (404, 410, 301, 302, 303, 307, 308):
                    log.info("%s -> %s", url, status)
                    return None
                if 500 <= status < 600:
                    log.warning("%s -> %s (attempt %d)", url, status, attempt + 1)
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 120)
                    continue
                log.info("%s -> unexpected %s", url, status)
                return None
            except (FetchError, OSError, ValueError, http.client.HTTPException, ssl.SSLError) as e:
                log.warning("%s -> error %s (attempt %d)", url, e.__class__.__name__, attempt + 1)
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
        self.stats["errors"] += 1
        return None

    def get_xml_urls(self, url: str) -> list[str]:
        """GET a sitemap XML and return a bounded list of allowlisted <loc> entries."""
        text = self.get(url)
        if text is None:
            return []
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", text)
        if not locs and "<sitemapindex" not in text:
            return []
        safe = []
        for location in locs:
            if len(safe) >= MAX_SITEMAP_URLS:
                break
            try:
                self._validate_origin(location)
            except ValueError:
                continue
            safe.append(location)
        return safe


# ---- record/output helpers ---------------------------------------------

def write_outputs(site: str, records: list[dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    jpath = DATA / f"{site}.json"
    jpath.write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("wrote %d records -> %s", len(records), jpath)


def load_json(path: Path) -> dict | list | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def find_phones(text: str) -> list[str]:
    """All normalized 10-digit numbers appearing in a text blob, deduped, order kept."""
    out, seen = [], set()
    for m in PHONE_RE.finditer(text):
        d = normalize_phone(m.group(0))
        if d and d not in seen and not re.fullmatch(r"(\d)\1{9}", d):
            seen.add(d)
            out.append(d)
    return out


# Keystroke / speech navigation extraction ---------------------------------
PRESS_RE = re.compile(
    r"(press|hit|dial|tap|enter|push|select|input|key)[^.;:!?]{0,40}?\b(\d{1,2}|\*|#|zero|one|two|three|four|five|six|seven|eight|nine|star|pound)\b",
    re.I,
)
SAY_RE = re.compile(r"\b(say|speak|dial|shout|ignore|do\s+not\s+(?:say|press|enter))\b[^.;:!?]{0,80}", re.I)


def extract_nav_steps(text: str, max_steps: int = 12) -> list[str]:
    """Distill a block of how-to-get-through guidance into short factual steps.

    Keeps only functional navigation facts (keystrokes, spoken phrases,
    wait/skip hints), trimmed to <=160 chars each.
    """
    steps: list[str] = []
    sentences = re.split(r"(?<=[.!?])\s+|\n+", text or "")
    for s in sentences:
        s = clean_text(s)
        if not (8 <= len(s) <= 220):
            continue
        if PRESS_RE.search(s) or SAY_RE.search(s):
            s = s[:160]
            if s not in steps:
                steps.append(s)
        if len(steps) >= max_steps:
            break
    return steps
