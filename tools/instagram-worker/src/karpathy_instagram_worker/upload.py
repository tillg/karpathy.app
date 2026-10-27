"""The result upload: instascraper's `<shortcode>/` as a flat tar.gz, streamed with `PUT` and a Content-Length.

The worker refuses locally what the server would refuse (over 40 files, over 500 MB), so it never sends a result that
can only come back 413/422. Only regular files directly inside the directory go in: no subdirectories, no links.
"""

from __future__ import annotations

import http.client
import logging
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from .client import JobClient, parse_error

MAX_FILES = 40
MAX_BYTES = 500 * 1024 * 1024
CHUNK = 1024 * 1024
TIMEOUT_S = 600

log = logging.getLogger("karpathy_instagram_worker.upload")


class ResultRejected(Exception):
    """The result can't be accepted (too big, too many files, or the server's 413/422). A verdict on the post."""


def result_files(result_dir: Path) -> list[Path]:
    """The regular files directly inside `result_dir`, sorted; symlinks and directories are left out."""
    return sorted(p for p in Path(result_dir).iterdir() if not p.is_symlink() and p.is_file())


def build_tarball(files: list[Path], dest: Path) -> None:
    """A gzip tarball of `files`, flat (each under its bare name), owned by nobody in particular."""
    with tarfile.open(dest, mode="w:gz") as tar:
        for f in files:
            info = tar.gettarinfo(str(f), arcname=f.name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            with open(f, "rb") as fh:
                tar.addfile(info, fh)


def _put_file(client: JobClient, path: str, body: Path, size: int) -> tuple[int, bytes]:
    parts = urlsplit(client.url(path))
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.hostname, parts.port, timeout=TIMEOUT_S)
    try:
        conn.putrequest("PUT", parts.path, skip_accept_encoding=True)
        for key, value in client.headers().items():
            conn.putheader(key, value)
        conn.putheader("Content-Type", "application/gzip")
        conn.putheader("Content-Length", str(size))
        conn.endheaders()
        try:
            with open(body, "rb") as fh:
                while chunk := fh.read(CHUNK):
                    conn.send(chunk)
        except OSError:
            # The server may answer (e.g. 413) and close before the body is through: read that answer. Without
            # one, getresponse raises and the retry wrapper treats it as unreachable.
            resp = conn.getresponse()
            return resp.status, resp.read()
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def upload(client: JobClient, job_id: str, result_dir: Path) -> None:
    """Upload `result_dir` as job `job_id`'s result. Raises ResultRejected, TokenRejected, ServerUnavailable or
    ApiError (e.g. 404 unknown-job: nobody wants the post any more)."""
    job_id = client.check_id(job_id)
    files = result_files(result_dir)
    if len(files) > MAX_FILES:
        raise ResultRejected(f"the result has {len(files)} files; the server takes at most {MAX_FILES}")
    with tempfile.TemporaryDirectory(prefix="karpathy-worker-") as tmp:
        tgz = Path(tmp) / f"{job_id}.tar.gz"
        build_tarball(files, tgz)
        size = tgz.stat().st_size
        if size > MAX_BYTES:
            raise ResultRejected(
                f"the result is {size / 1e6:.0f} MB; the server takes at most {MAX_BYTES / 1e6:.0f} MB"
            )
        log.info("uploading %s: %d files, %.1f MB", job_id, len(files), size / 1e6)
        path = f"/jobs/{job_id}/result"
        status, body = client.retrying(f"PUT {path}", lambda: _put_file(client, path, tgz, size))
    if status in (200, 204):
        return
    if status in (413, 422):
        err = parse_error(status, body)
        raise ResultRejected(f"the server refused the result ({status} {err.message or err.error})")
    raise parse_error(status, body)
