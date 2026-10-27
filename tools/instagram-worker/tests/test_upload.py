import io
import os
import tarfile

import pytest

from karpathy_instagram_worker import upload
from karpathy_instagram_worker.client import JobClient, TokenRejected
from karpathy_instagram_worker.upload import ResultRejected, build_tarball, result_files

CODE = "C0deAbc12"


def result_dir(tmp_path, n_media=1):
    d = tmp_path / CODE
    d.mkdir()
    (d / "post.md").write_text("# post\n")
    (d / "metadata.json").write_text('{"shortcode": "%s"}' % CODE)
    for i in range(n_media):
        (d / f"{CODE}_{i + 1}.jpg").write_bytes(os.urandom(2000))
    return d


def client_for(server, sleeps=None):
    return JobClient(server.url, "tok-1", "mbp", sleep=(sleeps.append if sleeps is not None else lambda s: None))


def names_in(data: bytes) -> list[tarfile.TarInfo]:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        return tar.getmembers()


def test_the_tarball_holds_exactly_the_dirs_files_flat_no_links(tmp_path):
    d = result_dir(tmp_path, n_media=2)
    (d / "sub").mkdir()
    (d / "sub" / "nested.txt").write_text("no")
    out = tmp_path / "r.tar.gz"
    build_tarball(result_files(d), out)
    members = names_in(out.read_bytes())
    assert sorted(m.name for m in members) == sorted(["post.md", "metadata.json", f"{CODE}_1.jpg", f"{CODE}_2.jpg"])
    assert all(m.isfile() for m in members)
    assert all(m.uid == 0 and m.uname == "" for m in members)


def test_a_symlink_in_the_dir_is_left_out(tmp_path):
    d = result_dir(tmp_path)
    (tmp_path / "secret.txt").write_text("outside")
    (d / "link.txt").symlink_to(tmp_path / "secret.txt")
    assert "link.txt" not in [p.name for p in result_files(d)]


def test_the_fake_server_receives_content_length_and_the_full_body(server, tmp_path):
    d = result_dir(tmp_path, n_media=3)
    upload.upload(client_for(server), CODE, d)
    [req] = server.calls("PUT", f"/jobs/{CODE}/result")
    assert req["headers"]["Content-Type"] == "application/gzip"
    assert req["headers"]["Authorization"] == "Bearer tok-1"
    assert int(req["headers"]["Content-Length"]) == len(req["body"])
    with tarfile.open(fileobj=io.BytesIO(req["body"]), mode="r:gz") as tar:
        assert tar.extractfile("metadata.json").read() == (d / "metadata.json").read_bytes()
        assert tar.extractfile(f"{CODE}_3.jpg").read() == (d / f"{CODE}_3.jpg").read_bytes()


def test_a_body_bigger_than_one_chunk_arrives_whole(server, tmp_path, monkeypatch):
    monkeypatch.setattr(upload, "CHUNK", 1024)
    d = result_dir(tmp_path, n_media=5)
    upload.upload(client_for(server), CODE, d)
    [req] = server.calls("PUT", f"/jobs/{CODE}/result")
    assert len(names_in(req["body"])) == 7


def test_41_files_is_result_rejected_before_any_request(server, tmp_path):
    d = result_dir(tmp_path, n_media=39)
    with pytest.raises(ResultRejected, match="41 files"):
        upload.upload(client_for(server), CODE, d)
    assert server.requests == []


def test_over_the_size_limit_is_result_rejected_before_any_request(server, tmp_path, monkeypatch):
    monkeypatch.setattr(upload, "MAX_BYTES", 1000)
    d = result_dir(tmp_path, n_media=2)
    with pytest.raises(ResultRejected, match="MB"):
        upload.upload(client_for(server), CODE, d)
    assert server.requests == []


def test_a_422_with_a_message_is_result_rejected_carrying_it(server, tmp_path):
    server.script("PUT", f"/jobs/{CODE}/result", (422, {"error": "invalid-result", "message": "post.md missing"}))
    with pytest.raises(ResultRejected, match="post.md missing"):
        upload.upload(client_for(server), CODE, result_dir(tmp_path))


def test_a_413_is_result_rejected(server, tmp_path):
    server.script("PUT", f"/jobs/{CODE}/result", (413, {"error": "too-large"}))
    with pytest.raises(ResultRejected, match="too-large"):
        upload.upload(client_for(server), CODE, result_dir(tmp_path))


def test_a_401_is_token_rejected(server, tmp_path):
    server.script("PUT", f"/jobs/{CODE}/result", (401, None))
    with pytest.raises(TokenRejected):
        upload.upload(client_for(server), CODE, result_dir(tmp_path))


def test_a_503_is_retried_with_the_whole_body_again(server, tmp_path):
    server.script("PUT", f"/jobs/{CODE}/result", (503, None), (204, None))
    sleeps = []
    upload.upload(client_for(server, sleeps), CODE, result_dir(tmp_path))
    first, second = server.calls("PUT", f"/jobs/{CODE}/result")
    assert first["body"] == second["body"] and len(second["body"]) > 0
    assert sleeps == [60]
