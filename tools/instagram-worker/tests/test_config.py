import os
import stat
import tomllib
from pathlib import Path

import pytest

from karpathy_instagram_worker import __version__, cli, config


def cfg_path() -> Path:
    return Path(os.environ["KARPATHY_WORKER_CONFIG"])


def read_cfg() -> dict:
    return tomllib.loads(cfg_path().read_text())


def test_configure_writes_server_token_name_poll_interval_with_mode_0600(server):
    rc = cli.main(["configure", "--server", server.url, "--token", "tok-123", "--name", "mbp"])
    assert rc == 0
    assert read_cfg() == {"server": server.url, "token": "tok-123", "name": "mbp", "poll_interval_s": 60}
    assert stat.S_IMODE(cfg_path().stat().st_mode) == 0o600
    assert stat.S_IMODE(cfg_path().parent.stat().st_mode) == 0o700


def test_a_missing_token_is_asked_with_getpass_never_echoed(server, monkeypatch, capsys):
    prompts = []

    def fake_getpass(prompt=""):
        prompts.append(prompt)
        return "secret-token-xyz"

    monkeypatch.setattr("getpass.getpass", fake_getpass)
    rc = cli.main(["configure", "--server", server.url, "--name", "mbp"])
    assert rc == 0
    assert len(prompts) == 1 and "token" in prompts[0].lower()
    assert read_cfg()["token"] == "secret-token-xyz"
    out = capsys.readouterr()
    assert "secret-token-xyz" not in out.out + out.err


def test_a_missing_server_is_asked_with_input(server, monkeypatch):
    monkeypatch.setattr("builtins.input", lambda prompt="": server.url + "/")
    rc = cli.main(["configure", "--token", "t", "--name", "mbp"])
    assert rc == 0
    assert read_cfg()["server"] == server.url  # trailing slash dropped


@pytest.mark.parametrize("url", ["http://karpathy.example.com", "ftp://karpathy.example.com", "karpathy.example.com"])
def test_server_must_be_https(url, capsys):
    rc = cli.main(["configure", "--server", url, "--token", "t", "--name", "mbp"])
    assert rc == 2
    assert "https://" in capsys.readouterr().err
    assert not cfg_path().exists()


@pytest.mark.parametrize("url", ["http://localhost:8080", "http://127.0.0.1:9", "https://karpathy.example.com"])
def test_http_is_allowed_only_for_localhost(url):
    assert config.validate_server(url) == url


def test_name_defaults_to_the_short_host_name(server, monkeypatch):
    monkeypatch.setattr("socket.gethostname", lambda: "Tills-MacBook.fritz.box")
    rc = cli.main(["configure", "--server", server.url, "--token", "t"])
    assert rc == 0
    assert read_cfg()["name"] == "Tills-MacBook"


def test_a_bad_name_is_refused(capsys):
    rc = cli.main(["configure", "--server", "https://k.example", "--token", "t", "--name", "my mac"])
    assert rc == 2
    assert "name" in capsys.readouterr().err


def test_configure_again_keeps_what_is_not_given(server):
    assert cli.main(["configure", "--server", server.url, "--token", "old", "--name", "mbp"]) == 0
    assert cli.main(["configure", "--token", "new"]) == 0
    assert read_cfg() == {"server": server.url, "token": "new", "name": "mbp", "poll_interval_s": 60}


def test_load_without_a_config_says_to_run_configure():
    with pytest.raises(config.ConfigError, match="karpathy-instagram-worker configure"):
        config.load()


def test_load_reads_what_save_wrote():
    config.save(config.Config(server="https://k.example", token='a"b\\c', name="mbp", poll_interval_s=30))
    assert config.load() == config.Config(server="https://k.example", token='a"b\\c', name="mbp", poll_interval_s=30)


def test_version_prints_the_package_version(capsys):
    assert cli.main(["version"]) == 0
    assert capsys.readouterr().out.strip() == f"karpathy-instagram-worker {__version__}"
