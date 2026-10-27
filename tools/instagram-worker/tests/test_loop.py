import io
import os
import signal
import tarfile

import instagrapi.exceptions as igex
import instascraper.activity as activity
import instascraper.auth as auth
import instascraper.behavior as behavior
import instascraper.config as iconfig
import instascraper.scraper as scraper
import pytest

from karpathy_instagram_worker import cli, config, loop, upload
from karpathy_instagram_worker.client import JobClient, TokenRejected

CODE = "C0deAbc12"
JOB = (200, {"id": CODE, "url": f"https://www.instagram.com/p/{CODE}/", "leaseUntil": "2026-10-27T12:30:00Z"})


class Sleeps(list):
    def __call__(self, seconds):
        self.append(seconds)


def session_file(username="tills"):
    path = auth.DEFAULT_SESSION_DIR / f"session-{username}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def worker(server, username="tills", session=True):
    if session and username:
        session_file(username).write_text("{}")
    sleeps = Sleeps()
    cfg = config.Config(server=server.url, token="tok", name="mbp", poll_interval_s=60)
    client = JobClient(server.url, "tok", "mbp", sleep=sleeps)
    return loop.Worker(cfg, client, username=username, sleep=sleeps), sleeps


def states(server):
    return [b["state"] for b in server.json_bodies("POST", "/worker/heartbeat")]


def configure_cli(server):
    config.save(config.Config(server=server.url, token="tok", name="mbp", poll_interval_s=60))
    iconfig.save_config({"IG_USERNAME": "tills"}, path=iconfig.CONFIG_PATH)
    session_file().write_text("{}")


def test_each_step_builds_one_humanizer_on_the_accounts_ledger(server):
    server.script("POST", "/jobs/claim", JOB)
    w, _ = worker(server)
    w.step()
    [ledger] = activity.OPENED
    assert ledger.path == activity.activity_path("tills")
    assert ledger.entered and ledger.exited
    [h] = behavior.BUILT
    assert h.ledger is ledger and h.gates == ["post"]
    assert scraper.CALLS[0]["humanizer"] is h


def test_a_closed_gate_claims_nothing_and_reports_night(server, monkeypatch):
    monkeypatch.setattr(behavior, "NEXT_GATE", behavior.GateResult(behavior.STOP, reason="outside active hours 08:00–23:00"))
    w, _ = worker(server)
    step = w.step()
    assert server.calls("POST", "/jobs/claim") == []
    [hb] = server.json_bodies("POST", "/worker/heartbeat")
    assert hb["state"] == "night" and "active hours" in hb["message"]
    assert step.state == "night" and 0 < step.sleep_s <= 30 * 60


def test_a_day_ceiling_reports_resting(server, monkeypatch):
    monkeypatch.setattr(behavior, "NEXT_GATE", behavior.GateResult(behavior.STOP, reason="daily post ceiling reached (50)"))
    w, _ = worker(server)
    assert w.step().state == "resting"
    assert states(server) == ["resting"]
    assert server.calls("POST", "/jobs/claim") == []


def test_a_window_wait_rests_for_the_gates_seconds_at_most_30_min(server, monkeypatch):
    monkeypatch.setattr(behavior, "NEXT_GATE", behavior.GateResult(behavior.WAIT, seconds=7200, reason="80 requests"))
    w, _ = worker(server)
    step = w.step()
    assert step.state == "resting" and step.sleep_s == 30 * 60
    assert server.calls("POST", "/jobs/claim") == []


def test_a_busy_ledger_rests_and_claims_nothing(server, monkeypatch):
    monkeypatch.setattr(activity, "BUSY", True)
    w, _ = worker(server)
    step = w.step()
    assert step.state == "resting" and step.sleep_s == 60
    assert server.calls("POST", "/jobs/claim") == []


def test_no_job_is_an_idle_heartbeat_and_a_poll_interval_sleep(server):
    server.script("POST", "/jobs/claim", (204, None))
    w, _ = worker(server)
    step = w.step()
    assert states(server) == ["idle"]
    assert step.state == "idle" and step.sleep_s == 60


def test_a_local_mode_server_is_idle_with_a_message(server):
    server.script("POST", "/jobs/claim", (409, {"error": "not-worker-mode"}))
    w, _ = worker(server)
    step = w.step()
    [hb] = server.json_bodies("POST", "/worker/heartbeat")
    assert hb["state"] == "idle" and "local" in hb["message"]
    assert step.sleep_s == 60


def test_success_uploads_and_reports_idle_then_paces(server):
    server.script("POST", "/jobs/claim", JOB)
    w, _ = worker(server)
    step = w.step()
    [put] = server.calls("PUT", f"/jobs/{CODE}/result")
    with tarfile.open(fileobj=io.BytesIO(put["body"]), mode="r:gz") as tar:
        assert {"post.md", "metadata.json"} <= set(tar.getnames())
    assert states(server) == ["scraping", "idle"]
    assert server.json_bodies("POST", "/worker/heartbeat")[0]["message"] == CODE
    assert step.state == "idle" and step.sleep_s == behavior.POST_DELAY
    assert server.calls("POST", f"/jobs/{CODE}/failure") == []


def test_permanent_is_a_permanent_failure(server, monkeypatch):
    server.script("POST", "/jobs/claim", JOB)
    monkeypatch.setattr(scraper, "SCRAPE_RAISES", igex.MediaNotFound("gone"))
    w, _ = worker(server)
    assert w.step().state == "idle"
    [f] = server.json_bodies("POST", f"/jobs/{CODE}/failure")
    assert f["permanent"] is True and "MediaNotFound" in f["reason"]
    assert states(server) == ["scraping", "idle"]


def test_result_rejected_is_a_permanent_failure(server, monkeypatch):
    server.script("POST", "/jobs/claim", JOB)
    server.script("PUT", f"/jobs/{CODE}/result", (422, {"error": "invalid-result", "message": "41 files"}))
    w, _ = worker(server)
    w.step()
    [f] = server.json_bodies("POST", f"/jobs/{CODE}/failure")
    assert f["permanent"] is True and "41 files" in f["reason"]


def test_transient_is_a_non_permanent_failure_state_error_then_idle(server, monkeypatch):
    server.script("POST", "/jobs/claim", JOB, (204, None))
    monkeypatch.setattr(scraper, "SCRAPE_RAISES", ValueError("network hiccup"))
    w, _ = worker(server)
    assert w.step().state == "error"
    [f] = server.json_bodies("POST", f"/jobs/{CODE}/failure")
    assert f == {"reason": "ValueError: network hiccup", "permanent": False}
    assert w.step().state == "idle"
    assert states(server) == ["scraping", "error", "idle"]


def test_needs_login_releases_reports_needs_login_and_sleeps_10_minutes(server, monkeypatch):
    server.script("POST", "/jobs/claim", JOB)
    monkeypatch.setattr(auth, "GET_CLIENT_RAISES", igex.LoginRequired("dead"))
    w, _ = worker(server)
    step = w.step()
    assert len(server.calls("POST", f"/jobs/{CODE}/release")) == 1
    assert server.calls("POST", f"/jobs/{CODE}/failure") == []
    hb = server.json_bodies("POST", "/worker/heartbeat")[-1]
    assert hb["state"] == "needs-login" and "karpathy-instagram-worker login" in hb["message"]
    assert step.sleep_s == 10 * 60


def test_no_instagram_account_is_needs_login_before_claiming(server):
    w, _ = worker(server, username=None)
    step = w.step()
    assert step.state == "needs-login"
    assert server.calls("POST", "/jobs/claim") == []


def test_no_session_file_is_needs_login_before_claiming(server):
    w, _ = worker(server, session=False)
    step = w.step()
    assert step.state == "needs-login" and step.sleep_s == 10 * 60
    assert server.calls("POST", "/jobs/claim") == []
    hb = server.json_bodies("POST", "/worker/heartbeat")[-1]
    assert hb["state"] == "needs-login" and "karpathy-instagram-worker login" in hb["message"]


def test_rate_limited_releases_reports_rate_limited_and_sleeps_30_minutes(server, monkeypatch):
    server.script("POST", "/jobs/claim", JOB)
    monkeypatch.setattr(scraper, "SCRAPE_RAISES", igex.PleaseWaitFewMinutes("slow down"))
    w, _ = worker(server)
    step = w.step()
    assert len(server.calls("POST", f"/jobs/{CODE}/release")) == 1
    assert states(server)[-1] == "rate-limited"
    assert step.sleep_s == 30 * 60


def test_an_upload_for_a_job_nobody_wants_any_more_is_just_logged(server):
    server.script("POST", "/jobs/claim", JOB)
    server.script("PUT", f"/jobs/{CODE}/result", (404, {"error": "unknown-job"}))
    w, _ = worker(server)
    assert w.step().state == "idle"
    assert server.calls("POST", f"/jobs/{CODE}/failure") == []


@pytest.mark.parametrize(
    "answer",
    [
        (400, {"error": "upload-ended-early"}),
        (408, None),
        (411, {"error": "length-required"}),
        (404, {"error": "not-found"}),
    ],
)
def test_any_other_upload_refusal_is_a_non_permanent_failure(server, answer):
    # Only 404 unknown-job means "not wanted"; anything else must reach the server's backoff (permanent after 5),
    # or the post would be claimed again and again.
    server.script("POST", "/jobs/claim", JOB)
    server.script("PUT", f"/jobs/{CODE}/result", answer)
    w, _ = worker(server)
    step = w.step()
    [f] = server.json_bodies("POST", f"/jobs/{CODE}/failure")
    assert f["permanent"] is False and f"HTTP {answer[0]}" in f["reason"]
    assert step.state == "error" and states(server)[-1] == "error"


def test_token_rejected_propagates_from_step(server):
    server.script("POST", "/jobs/claim", (401, None))
    w, _ = worker(server)
    with pytest.raises(TokenRejected):
        w.step()


def test_token_rejected_stops_run_with_exit_1(server, capsys):
    configure_cli(server)
    server.script("POST", "/jobs/claim", (401, None))
    assert cli.main(["run"]) == 1
    err = capsys.readouterr().err
    assert "rejected the worker token" in err and "configure" in err


def test_once_exits_0_after_one_step(server):
    configure_cli(server)
    server.script("POST", "/jobs/claim", (204, None))
    assert cli.main(["once"]) == 0
    assert len(server.calls("POST", "/jobs/claim")) == 1


def test_once_exits_1_when_instagram_needs_a_login(server, monkeypatch, capsys):
    configure_cli(server)
    server.script("POST", "/jobs/claim", JOB)
    monkeypatch.setattr(auth, "GET_CLIENT_RAISES", SystemExit("no session"))
    assert cli.main(["once"]) == 1
    assert "karpathy-instagram-worker login" in capsys.readouterr().out


def test_sigterm_ends_run_after_the_current_job(server, monkeypatch):
    configure_cli(server)
    server.script("POST", "/jobs/claim", JOB)
    real_scrape = scraper.scrape

    def scrape_then_sigterm(*args, **kw):
        os.kill(os.getpid(), signal.SIGTERM)
        return real_scrape(*args, **kw)

    monkeypatch.setattr(scraper, "scrape", scrape_then_sigterm)
    assert cli.main(["run"]) == 0
    assert len(server.calls("PUT", f"/jobs/{CODE}/result")) == 1  # the job in progress still finished
    assert len(server.calls("POST", "/jobs/claim")) == 1  # and no new one was claimed
