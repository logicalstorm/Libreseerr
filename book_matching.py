"""Pure helpers for matching a requested book against search results and the
library. Kept free of Flask/HTTP so they can be unit-tested directly."""

import re

_LEADING_ARTICLE = re.compile(r"^(the|a|an)\s+")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def norm_title(title: str) -> str:
    """Comparable form of a title: lowercase, subtitle dropped, leading
    article dropped, punctuation collapsed. "The Big Short: Inside the
    Doomsday Machine" and "big short" both become "big short"."""
    t = (title or "").lower()
    t = re.split(r"[:(\[]", t, maxsplit=1)[0]
    t = _NON_ALNUM.sub(" ", t).strip()
    t = _LEADING_ARTICLE.sub("", t)
    return t.strip()


def _author_surname(author: str) -> str:
    parts = _NON_ALNUM.sub(" ", (author or "").lower()).split()
    return parts[-1] if parts else ""


def best_match(candidates: list, title: str, author: str) -> dict | None:
    """Pick the search result that is really the requested book.

    LazyLibrarian's findBook often ranks junk first (e.g. an "Unknown Author"
    record whose title is "Yesteryear | Caro Claire Burke"). Prefer results
    whose author shares the requested author's surname and whose normalised
    title matches; fall back to the original order. Returns None for an
    empty list."""
    if not candidates:
        return None
    want_title = norm_title(title)
    surname = _author_surname(author)

    def score(item):
        idx, cand = item
        cand_author = (cand.get("author") or {}).get("authorName", "").lower()
        cand_title = norm_title(cand.get("title", ""))
        author_ok = bool(surname) and surname in cand_author
        title_exact = cand_title == want_title
        title_close = bool(want_title) and (want_title in cand_title or cand_title in want_title)
        return (author_ok, title_exact, title_close, -idx)

    return max(enumerate(candidates), key=score)[1]


def find_in_library(title: str, index: dict) -> str | None:
    """Library item id for `title` in a {title: item_id} index, matching on
    normalised titles. None when the book isn't there."""
    want = norm_title(title)
    if not want:
        return None
    for lib_title, item_id in index.items():
        if norm_title(lib_title) == want:
            return item_id
    return None


def same_user(a: str, b: str) -> bool:
    """Usernames are emails for most GOJ users and Jellyfin matches them
    case-insensitively, so Libreseerr must too."""
    return (a or "").casefold() == (b or "").casefold()
