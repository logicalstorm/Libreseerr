import json

import pytest

import app as app_module
from book_matching import best_match, find_in_library, norm_title, same_user
from lazylibrarian import LazyLibrarianClient


# ─── book_matching ───

def test_norm_title_drops_subtitle_article_and_punctuation():
    assert norm_title("The Big Short: Inside the Doomsday Machine") == "big short"
    assert norm_title("Kitchen Confidential (Updated Edition)") == "kitchen confidential"
    assert norm_title("") == ""


def test_best_match_skips_junk_first_result():
    candidates = [
        {"title": "Yesteryear | Caro Claire Burke", "author": {"authorName": "Unknown Author"}, "foreignBookId": "bad"},
        {"title": "Yesteryear", "author": {"authorName": "Caro Claire Burke"}, "foreignBookId": "good"},
    ]
    assert best_match(candidates, "Yesteryear", "Caro Claire Burke")["foreignBookId"] == "good"


def test_best_match_keeps_order_when_nothing_better_and_handles_empty():
    candidates = [{"title": "A", "author": {"authorName": "X"}}, {"title": "B", "author": {"authorName": "Y"}}]
    assert best_match(candidates, "Zzz", "Nobody") is candidates[0]
    assert best_match([], "A", "B") is None


def test_find_in_library_matches_normalised_titles():
    index = {"kitchen confidential: adventures in the culinary underbelly": "li_1", "sapiens": "li_2"}
    assert find_in_library("Kitchen Confidential", index) == "li_1"
    assert find_in_library("Night School", index) is None


def test_same_user_is_case_insensitive():
    assert same_user("Justinmcdevitt@gmail.com", "justinmcdevitt@gmail.com")
    assert not same_user("a@x.com", "b@x.com")


# ─── LazyLibrarian client ───

def test_add_book_queues_audiobook_requests_as_audiobook():
    calls = []
    client = LazyLibrarianClient("http://ll", "key")
    client._get = lambda cmd, timeout=15, **p: calls.append((cmd, p)) or "OK"
    client.add_book({"title": "Sapiens", "foreignBookId": "123"}, 1, "/books", server_type="audiobook")
    queued = [p for cmd, p in calls if cmd in ("queueBook", "searchBook")]
    assert queued and all(p["type"] == "AudioBook" for p in queued)


def test_add_book_defaults_to_ebook():
    calls = []
    client = LazyLibrarianClient("http://ll", "key")
    client._get = lambda cmd, timeout=15, **p: calls.append((cmd, p)) or "OK"
    client.add_book({"title": "Watchmen", "foreignBookId": "9"}, 1, "/books")
    assert dict(calls)["queueBook"]["type"] == "eBook"


# ─── status polling ───

@pytest.mark.parametrize("ll_status,server_type,expected", [
    ("Wanted", "audiobook", "processing"),
    ("Snatched", "audiobook", "downloading"),
    ("Open", "audiobook", "downloading"),   # on disk, not in Audiobookshelf yet
    ("Open", "ebook", "completed"),
    ("Failed", "ebook", "error"),
])
def test_poll_lazylibrarian_maps_status(ll_status, server_type, expected):
    key = "AudioBook" if server_type == "audiobook" else "eBook"
    req = {"status": "processing", "server_type": server_type, "readarr_book_id": "42", "created_at": "2026-11-18T00:00:00"}
    ctx = {"ll_statuses": {"42": {key: ll_status}}}
    assert app_module._poll_lazylibrarian(req, ctx) == expected


def test_poll_marks_untracked_old_request_as_error():
    req = {"status": "processing", "server_type": "audiobook", "readarr_book_id": "readarr-era", "created_at": "2026-06-01T00:00:00"}
    assert app_module._poll_lazylibrarian(req, {"ll_statuses": {"other": {}}}) == "error"


def test_audiobook_in_library_completes_with_listen_link(monkeypatch):
    monkeypatch.setenv("LIBRESEERR_LISTEN_BASE_URL", "https://audiobooks.example/audiobookshelf")
    req = {"status": "processing", "server_type": "audiobook", "title": "Sapiens"}
    assert app_module._poll_request_status(req, {"abs_index": {"sapiens: a brief history": "li_9"}}) == "completed"
    assert app_module.listen_url(req["abs_item_id"]) == "https://audiobooks.example/audiobookshelf/item/li_9"


# ─── HTTP: login + per-user request visibility ───

@pytest.fixture
def client(tmp_path, monkeypatch):
    users = [
        {"username": "Reader@x.com", "password_hash": "jellyfin", "role": "user"},
        {"username": "other@x.com", "password_hash": "jellyfin", "role": "user"},
        {"username": "boss@x.com", "password_hash": "jellyfin", "role": "admin"},
    ]
    reqs = [
        {"id": 1, "title": "Mine", "status": "pending", "server_type": "audiobook", "requested_by": "Reader@x.com"},
        {"id": 2, "title": "Theirs", "status": "pending", "server_type": "audiobook", "requested_by": "other@x.com"},
    ]
    for name, data in (("users.json", users), ("requests.json", reqs), ("config.json", {"jellyfin": {"enabled": True, "server_url": "http://jf"}})):
        (tmp_path / name).write_text(json.dumps(data))
    monkeypatch.setattr(app_module, "USERS_FILE", str(tmp_path / "users.json"))
    monkeypatch.setattr(app_module, "REQUESTS_FILE", str(tmp_path / "requests.json"))
    monkeypatch.setattr(app_module, "CONFIG_FILE", str(tmp_path / "config.json"))
    monkeypatch.setattr(app_module, "try_jellyfin_auth", lambda u, p: (p == "right", ""))
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def login(c, username, password="right"):
    return c.post("/api/auth/login", json={"username": username, "password": password})


def test_login_is_case_insensitive_and_does_not_duplicate(client):
    assert login(client, "reader@X.com").status_code == 200
    users = json.loads(open(app_module.USERS_FILE).read())
    assert sum(same_user(u["username"], "reader@x.com") for u in users) == 1


def test_wrong_password_rejected(client):
    assert login(client, "reader@x.com", "wrong").status_code == 401


def test_session_cookie_has_its_own_name(client):
    login(client, "reader@x.com")
    assert client.get_cookie("libreseerr_session") is not None


def test_user_sees_and_removes_only_own_requests(client):
    login(client, "reader@x.com")
    titles = [r["title"] for r in client.get("/api/requests").get_json()]
    assert titles == ["Mine"]
    assert client.delete("/api/requests/2").status_code == 404
    assert client.delete("/api/requests/1").status_code == 200


def test_admin_sees_everything(client):
    login(client, "boss@x.com")
    assert len(client.get("/api/requests").get_json()) == 2
