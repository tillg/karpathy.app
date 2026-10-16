#!/usr/bin/env bash
# Assemble the website into _site/: the page files from site/, its screenshots and the shared icons.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site && mkdir -p _site/icons
find site -maxdepth 1 -type f ! -name '*.sh' ! -name '*.mjs' ! -name '*.json' -exec cp {} _site/ \;
cp -R site/screenshots _site/screenshots
cp assets/icons/* _site/icons/
