#!/usr/bin/env sh
# Installs the pinned gitleaks (secret scanner, #141) into <dir> and prints the binary's path. Checksum-verified;
# a no-op when <dir>/gitleaks already is this version. Used by the backend image (Dockerfile), CI, `just check`
# and the backend tests (vitest.config.ts). POSIX sh: it also runs in the alpine image (busybox wget, sha256sum).
# Run: deploy/gitleaks/install.sh [<dir>, default tmp/tools/gitleaks-<version> in this checkout]
set -eu

VERSION=8.30.1
# From gitleaks_${VERSION}_checksums.txt of the GitHub release.
SHA_linux_x64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
SHA_linux_arm64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
SHA_darwin_x64=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709
SHA_darwin_arm64=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5

here=$(cd "$(dirname "$0")" && pwd)
dir=${1:-$(cd "$here/../.." && pwd)/tmp/tools/gitleaks-$VERSION}
bin=$dir/gitleaks

if [ -x "$bin" ] && [ "$("$bin" version 2>/dev/null)" = "$VERSION" ]; then
  echo "$bin"
  exit 0
fi

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "gitleaks install: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "gitleaks install: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
eval "sha=\$SHA_${os}_${arch}"

tarball=gitleaks_${VERSION}_${os}_${arch}.tar.gz
url=https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/$tarball
mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$tmp/$tarball" "$url"; else wget -qO "$tmp/$tarball" "$url"; fi
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$tarball" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/$tarball" | cut -d' ' -f1); fi
if [ "$got" != "$sha" ]; then
  echo "gitleaks install: checksum mismatch for $tarball" >&2
  exit 1
fi
tar -xzf "$tmp/$tarball" -C "$tmp" gitleaks
mv "$tmp/gitleaks" "$bin"
chmod 755 "$bin"
echo "$bin"
