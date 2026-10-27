import os
import tomllib
from pathlib import Path

import pytest

from karpathy_instagram_worker import cli
from karpathy_instagram_worker.client import (
    ApiError,
    Job,
    JobClient,
    NotWorkerMode,
    ServerUnavailable,
    TokenRejected,
)


class Sleeps(list):
    def __call__(self, seconds):
        self.append(seconds)


def make(server, **kw):
    sleeps = Sleeps()
    return JobClient(server.url, "tok-1", "mbp", version="9.9.9", sleep=sleeps, **kw), sleeps


def test_claim_returns_id_url_lease_until(server):
    server.script("POST", "/jobs/claim", (200, {"id": "C0deAbc12", "url": "https://www.instagram.com/p/C0deAbc12/",
                                                "leaseUntil": "2026-10-27T12:30:00Z"}))
    client, _ = make(server)
    assert client.claim() == Job("C0deAbc12", "https://www.instagram.com/p/C0deAbc12/", "2026-10-27T12:30:00Z")
    assert server.json_bodies("POST", "/jobs/claim") == [{"name": "mbp"}]


def test_204_is_none(server):
    server.script("POST", "/jobs/claim", (204, None))
    client, _ = make(server)
    assert client.claim() is None


def test_409_not_worker_mode_raises_not_worker_mode(server):
    server.script("POST", "/jobs/claim", (409, {"error": "not-worker-mode"}))
    client, _ = make(server)
    with pytest.raises(NotWorkerMode):
        client.claim()


def test_a_claimed_id_that_is_not_a_shortcode_is_refused(server):
    server.script("POST", "/jobs/claim", (200, {"id": "../etc", "url": "x", "leaseUntil": "y"}))
    client, _ = make(server)
    with pytest.raises(ApiError):
        client.claim()


def test_every_call_sends_the_bearer_token(server):
    server.script("POST", "/jobs/claim", (204, None))
    client, _ = make(server)
    client.claim()
    client.failure("C0deAbc12", "boom", permanent=False)
    client.release("C0deAbc12")
    client.heartbeat("idle")
    assert len(server.requests) == 4
    for r in server.requests:
        assert r["headers"]["Authorization"] == "Bearer tok-1"
        assert r["headers"]["User-Agent"].startswith("karpathy-instagram-worker/9.9.9")


def test_failure_and_release_post_to_the_job(server):
    client, _ = make(server)
    client.failure("C0deAbc12", "x" * 300, permanent=True)
    client.release("C0deAbc12")
    assert server.json_bodies("POST", "/jobs/C0deAbc12/failure") == [{"reason": "x" * 200, "permanent": True}]
    assert len(server.calls("POST", "/jobs/C0deAbc12/release")) == 1


def test_401_raises_token_rejected_without_retrying(server):
    server.script("POST", "/jobs/claim", (401, {"error": "unauthorized"}))
    client, sleeps = make(server)
    with pytest.raises(TokenRejected):
        client.claim()
    assert sleeps == []


def test_a_503_then_a_200_retries_once_after_the_first_backoff(server):
    server.script("POST", "/jobs/claim", (503, {"error": "ingest-down"}),
                  (200, {"id": "C0deAbc12", "url": "u", "leaseUntil": "l"}))
    client, sleeps = make(server)
    assert client.claim().id == "C0deAbc12"
    assert sleeps == [60]


def test_server_errors_back_off_1_2_5_minutes_then_give_up(server):
    server.script("POST", "/worker/heartbeat", (502, None))
    client, sleeps = make(server)
    with pytest.raises(ServerUnavailable):
        client.heartbeat("idle")
    assert sleeps == [60, 120, 300]
    assert len(server.calls("POST", "/worker/heartbeat")) == 4


def test_an_unreachable_server_is_retried_too(server):
    url = server.url
    server.close()
    sleeps = Sleeps()
    client = JobClient(url, "t", "mbp", sleep=sleeps)
    with pytest.raises(ServerUnavailable):
        client.heartbeat("idle")
    assert sleeps == [60, 120, 300]


def test_other_4xx_raise_api_error_with_the_server_message(server):
    server.script("POST", "/jobs/C0deAbc12/failure", (404, {"error": "unknown-job"}))
    client, sleeps = make(server)
    with pytest.raises(ApiError) as e:
        client.failure("C0deAbc12", "r", permanent=False)
    assert e.value.status == 404 and e.value.error == "unknown-job"
    assert sleeps == []


def test_heartbeat_sends_name_version_state_message(server):
    client, _ = make(server)
    client.heartbeat("scraping", "C0deAbc12")
    client.heartbeat("idle")
    assert server.json_bodies("POST", "/worker/heartbeat") == [
        {"name": "mbp", "version": "9.9.9", "state": "scraping", "message": "C0deAbc12"},
        {"name": "mbp", "version": "9.9.9", "state": "idle"},
    ]


def test_configure_checks_the_token_with_one_heartbeat(server):
    assert cli.main(["configure", "--server", server.url, "--token", "t", "--name", "mbp"]) == 0
    [hb] = server.json_bodies("POST", "/worker/heartbeat")
    assert hb["state"] == "idle" and hb["message"] == "configured" and hb["name"] == "mbp"


def test_configure_does_not_save_a_rejected_token(server, capsys):
    server.script("POST", "/worker/heartbeat", (401, None))
    assert cli.main(["configure", "--server", server.url, "--token", "bad", "--name", "mbp"]) == 1
    err = capsys.readouterr().err
    assert "rejected" in err and "just instagram-worker-token" in err
    assert not Path(os.environ["KARPATHY_WORKER_CONFIG"]).exists()


def test_configure_saves_when_the_server_is_unreachable_and_says_so(server, capsys):
    url = server.url
    server.close()
    assert cli.main(["configure", "--server", url, "--token", "t", "--name", "mbp"]) == 0
    assert "could not reach" in capsys.readouterr().out.lower()
    assert tomllib.loads(Path(os.environ["KARPATHY_WORKER_CONFIG"]).read_text())["token"] == "t"
