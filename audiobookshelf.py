import logging

import requests

logger = logging.getLogger(__name__)


class AudiobookshelfClient:
    """Read-only client for checking what's actually already sitting in the
    Audiobookshelf library — the real serving library users listen from,
    distinct from whatever the configured Readarr/Bookshelf/LazyLibrarian
    download manager happens to be tracking. Most of GOJ's audiobooks arrive
    via a separate Libation-export pipeline that download manager never
    sees, so checking only it misses the majority of what's genuinely
    already available."""

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {api_key}"})

    def test_connection(self) -> dict:
        resp = self.session.get(f"{self.base_url}/api/libraries", timeout=10)
        resp.raise_for_status()
        return resp.json()

    def _book_library_ids(self) -> list:
        resp = self.session.get(f"{self.base_url}/api/libraries", timeout=10)
        resp.raise_for_status()
        libraries = resp.json().get("libraries", [])
        book_libs = [lib["id"] for lib in libraries if lib.get("mediaType") == "book"]
        return book_libs or [lib["id"] for lib in libraries]

    def get_available_titles(self) -> set:
        """Every book/audiobook title currently in the library, lowercased —
        same matching convention check_availability() already uses for the
        Readarr/Bookshelf/LazyLibrarian title set."""
        titles = set()
        for library_id in self._book_library_ids():
            resp = self.session.get(
                f"{self.base_url}/api/libraries/{library_id}/items",
                params={"limit": 100000},
                timeout=30,
            )
            resp.raise_for_status()
            for item in resp.json().get("results", []):
                metadata = item.get("media", {}).get("metadata", {})
                title = metadata.get("title", "")
                if title:
                    titles.add(title.strip().lower())
        return titles
