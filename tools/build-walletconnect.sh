#!/usr/bin/env bash
# Rebuilds vendor/walletconnect-ethereum-provider-2.25.0.mjs, the WalletConnect bundle seal.html loads only when
# the browser has no wallet of its own. Built from tools/walletconnect/package-lock.json with a clean `npm ci`;
# the output is byte-identical on every run, so `git diff --exit-code vendor/` after this script proves the
# committed bundle is the one the lockfile pins.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
out="$root/vendor/walletconnect-ethereum-provider-2.25.0.mjs"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$here/walletconnect/package.json" "$here/walletconnect/package-lock.json" "$here/walletconnect/entry.mjs" "$work/"
cd "$work"
npm ci --no-audit --no-fund --ignore-scripts >/dev/null
./node_modules/.bin/esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2020 --minify \
  --legal-comments=none --define:process.env.NODE_ENV='"production"' --define:global=globalThis \
  --log-level=warning --outfile="$out"
sha256sum "$out" | sed "s#$root/##"
