import sys
import unittest
import csv
import re
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scrapers"))

import common
from common import PoliteFetcher
from merge import csv_safe


PUBLIC_DNS = [(2, 1, 6, "", ("93.184.216.34", 443))]


class RedirectResponse:
    status = 302

    class Headers(dict):
        def get_content_charset(self):
            return "utf-8"

    headers = Headers({"Location": "https://127.0.0.1/admin"})

    def read(self, _size):
        return b""

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class ScraperUrlSecurityTests(unittest.TestCase):
    def setUp(self):
        self.fetcher = PoliteFetcher("security_test", cache=False, allowed_hosts=("example.com", ".example.org"))

    @patch("common.socket.getaddrinfo", return_value=PUBLIC_DNS)
    def test_allows_only_https_allowlisted_public_hosts(self, _dns):
        self.fetcher._validate_url("https://example.com/page")
        self.fetcher._validate_url("https://support.example.org/page")
        for url in (
            "http://example.com/",
            "https://user:password@example.com/",
            "https://example.com:444/",
            "https://example.net/",
            "https://notexample.org/",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.fetcher._validate_url(url)

    def test_rejects_unsafe_allowlist_configuration(self):
        for allowed_host in ("com", ".com", "localhost", "127.0.0.1", "bad host.example"):
            with self.subTest(allowed_host=allowed_host), self.assertRaises(ValueError):
                PoliteFetcher("security_test", cache=False, allowed_hosts=(allowed_host,))

    @patch("common.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))])
    def test_blocks_hosts_that_resolve_to_private_addresses(self, _dns):
        with self.assertRaises(ValueError):
            self.fetcher._validate_url("https://example.com/")

    @patch("common._PinnedHTTPSConnection")
    @patch("common.socket.getaddrinfo", return_value=PUBLIC_DNS)
    def test_revalidates_every_redirect_target(self, _dns, connection):
        connection.return_value.getresponse.return_value = RedirectResponse()
        with self.assertRaises(ValueError):
            self.fetcher._request_text("https://example.com/")
        connection.assert_called_once_with("example.com", "93.184.216.34", 30)

    @patch("common._PinnedHTTPSConnection")
    @patch("common.socket.getaddrinfo", return_value=PUBLIC_DNS)
    def test_connects_to_the_validated_ip_with_the_original_tls_hostname(self, _dns, connection):
        response = RedirectResponse()
        response.status = 200
        chunks = iter((b"safe", b""))
        response.read = lambda _size: next(chunks)
        connection.return_value.getresponse.return_value = response
        self.assertEqual(self.fetcher._request_text("https://example.com/path?q=1"), (200, "safe"))
        connection.assert_called_once_with("example.com", "93.184.216.34", 30)
        connection.return_value.request.assert_called_once_with(
            "GET",
            "/path?q=1",
            headers={**common.BASE_HEADERS, "Connection": "close"},
        )

    @patch("common._PinnedHTTPSConnection")
    @patch("common.socket.getaddrinfo", return_value=PUBLIC_DNS)
    def test_invalid_response_charset_falls_back_to_utf8(self, _dns, connection):
        response = RedirectResponse()
        response.status = 200
        response.headers = RedirectResponse.Headers({"Content-Type": "text/plain; charset=not-a-codec"})
        response.headers.get_content_charset = lambda: "not-a-codec"
        chunks = iter(("safe ✓".encode(), b""))
        response.read = lambda _size: next(chunks)
        connection.return_value.getresponse.return_value = response
        self.assertEqual(self.fetcher._request_text("https://example.com/"), (200, "safe ✓"))

    def test_sitemap_entries_are_allowlisted_and_bounded(self):
        self.fetcher.get = lambda _url: """<urlset>
            <loc>https://example.com/one</loc>
            <loc>http://example.com/plaintext</loc>
            <loc>https://attacker.example/bad</loc>
            <loc>https://support.example.org/two</loc>
            <loc>https://example.com/three</loc>
        </urlset>"""
        with patch.object(common, "MAX_SITEMAP_URLS", 2):
            self.assertEqual(
                self.fetcher.get_xml_urls("https://example.com/sitemap.xml"),
                ["https://example.com/one", "https://support.example.org/two"],
            )


class CsvSecurityTests(unittest.TestCase):
    def test_neutralizes_spreadsheet_formulas(self):
        for value in ("=HYPERLINK(\"https://attacker.example\")", "+1+1", "-2+3", "@SUM(A1:A2)"):
            self.assertTrue(csv_safe(value).startswith("'"))
        self.assertEqual(csv_safe("Acme, Inc."), "Acme, Inc.")

    def test_generated_csv_cells_are_formula_safe(self):
        root = Path(__file__).resolve().parents[1]
        unsafe_controls = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")
        generated = [root / "data" / name for name in ("master_contacts.csv", "phone_routes.csv")]
        generated = [path for path in generated if path.exists()]
        if not generated:
            self.skipTest("generated CSV artifacts are not present")
        for path in generated:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row_number, row in enumerate(csv.reader(handle), start=1):
                    for value in row:
                        self.assertFalse(
                            value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")),
                            f"{path.name}:{row_number} contains a spreadsheet formula",
                        )
                        self.assertIsNone(unsafe_controls.search(value), f"{path.name}:{row_number} contains unsafe controls")


if __name__ == "__main__":
    unittest.main()
