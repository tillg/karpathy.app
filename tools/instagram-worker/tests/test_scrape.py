import sys

import instagrapi.exceptions as igex
import instascraper.auth as auth
import instascraper.config as iconfig
import instascraper.scraper as scraper
import pytest
from instascraper.behavior import Humanizer

from karpathy_instagram_worker import scrape
from karpathy_instagram_worker.scrape import NeedsLogin, Permanent, RateLimited, SessionCheckFailed, Transient

CODE = "C0deAbc12"
URL = f"https://www.instagram.com/p/{CODE}/"


def run(tmp_path, username="tills"):
    return scrape.scrape_post(CODE, URL, tmp_path / "work", humanizer=Humanizer(), username=username)


@pytest.mark.parametrize("exc", [igex.MediaNotFound("gone"), igex.ClientNotFoundError("404")])
def test_not_found_is_permanent(tmp_path, monkeypatch, exc):
    monkeypatch.setattr(scraper, "SCRAPE_RAISES", exc)
    with pytest.raises(Permanent):
        run(tmp_path)


@pytest.mark.parametrize("exc", [igex.LoginRequired("x"), igex.ChallengeRequired("x"), igex.ClientLoginRequired("x")])
def test_login_problems_from_get_client_need_login(tmp_path, monkeypatch, exc):
    monkeypatch.setattr(auth, "GET_CLIENT_RAISES", exc)
    with pytest.raises(NeedsLogin, match="karpathy-instagram-worker login"):
        run(tmp_path)
    assert scraper.CALLS == []


def test_a_system_exit_from_get_client_is_a_failed_session_check_not_a_login(tmp_path, monkeypatch):
    # Without a TTY, instascraper turns any failed session check (network error, 429, PleaseWaitFewMinutes) into
    # SystemExit: it says nothing for sure about the session, so it is not needs-login (yet).
    monkeypatch.setattr(auth, "GET_CLIENT_RAISES", SystemExit("@tills needs to log in (no usable session)"))
    with pytest.raises(SessionCheckFailed) as err:
        run(tmp_path)
    assert not isinstance(err.value, NeedsLogin)
    assert scraper.CALLS == []


def test_on_client_is_called_once_get_client_succeeded(tmp_path, monkeypatch):
    calls = []
    scrape.scrape_post(CODE, URL, tmp_path / "work", humanizer=Humanizer(), username="tills", on_client=lambda: calls.append(1))
    assert calls == [1]
    monkeypatch.setattr(auth, "GET_CLIENT_RAISES", SystemExit("no session"))
    with pytest.raises(SessionCheckFailed):
        scrape.scrape_post(CODE, URL, tmp_path / "work2", humanizer=Humanizer(), username="tills", on_client=lambda: calls.append(2))
    assert calls == [1]


@pytest.mark.parametrize("exc", [igex.LoginRequired("x"), igex.ChallengeRequired("x")])
def test_login_problems_while_scraping_need_login(tmp_path, monkeypatch, exc):
    monkeypatch.setattr(scraper, "SCRAPE_RAISES", exc)
    with pytest.raises(NeedsLogin):
        run(tmp_path)


class Http429(Exception):
    def __init__(self):
        super().__init__("Too Many Requests")
        self.response = type("R", (), {"status_code": 429})()


@pytest.mark.parametrize("exc", [igex.PleaseWaitFewMinutes("wait"), igex.ClientThrottledError("429"), Http429()])
def test_rate_limits_are_rate_limited(tmp_path, monkeypatch, exc):
    monkeypatch.setattr(scraper, "SCRAPE_RAISES", exc)
    with pytest.raises(RateLimited):
        run(tmp_path)


def test_anything_else_is_transient_with_type_and_message_cut_at_200(tmp_path, monkeypatch):
    monkeypatch.setattr(scraper, "SCRAPE_RAISES", ValueError("x" * 500))
    with pytest.raises(Transient) as e:
        run(tmp_path)
    assert e.value.reason.startswith("ValueError: xxx")
    assert len(e.value.reason) == 200


def test_a_job_url_for_another_shortcode_is_permanent(tmp_path):
    with pytest.raises(Permanent, match="shortcode"):
        scrape.scrape_post(CODE, "https://www.instagram.com/p/Other1234/", tmp_path, humanizer=Humanizer(),
                           username="tills")


def test_success_returns_the_shortcode_dir_with_post_md_and_metadata_json(tmp_path):
    h = Humanizer()
    out = scrape.scrape_post(CODE, URL, tmp_path / "work", humanizer=h, username="tills")
    assert out == tmp_path / "work" / CODE
    assert (out / "post.md").is_file() and (out / "metadata.json").is_file()
    [call] = auth.GET_CLIENT_CALLS
    assert call["username"] == "tills" and call["humanizer"] is h and call["password"] is None
    assert scraper.CALLS[0]["source_url"] == URL and scraper.CALLS[0]["humanizer"] is h
    assert h.recorded == ["post"]


def test_get_client_never_sees_a_terminal_to_prompt_for_a_password(tmp_path, monkeypatch):
    seen = []
    real = auth.get_client

    def spy(**kw):
        seen.append(sys.stdin.isatty())
        return real(**kw)

    monkeypatch.setattr(auth, "get_client", spy)
    run(tmp_path)
    assert seen == [False]


def test_the_instagram_username_comes_from_instascrapers_env_file():
    assert scrape.ig_username() is None
    iconfig.save_config({"IG_USERNAME": "tills"}, path=iconfig.CONFIG_PATH)
    assert scrape.ig_username() == "tills"
    assert scrape.session_path("tills") == auth.DEFAULT_SESSION_DIR / "session-tills.json"
