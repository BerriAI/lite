#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo 'Litespeed packages currently support macOS.' >&2; exit 1; fi
case "$(uname -m)" in arm64) architecture=arm64;; x86_64) architecture=x64;; *) echo 'Unsupported Mac architecture.' >&2; exit 1;; esac
release_url=https://github.com/BerriAI/litespeed/releases/latest/download
scratch=$(mktemp -d "${TMPDIR:-/tmp}/litespeed-install.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
echo 'Downloading Litespeed for your Mac…'
curl --fail --silent --show-error --location --retry 2 --max-time 30 "$release_url/manifest.json" -o "$scratch/manifest.json"
version=$(plutil -extract version raw -o - "$scratch/manifest.json")
file=$(plutil -extract "assets.darwin-$architecture.file" raw -o - "$scratch/manifest.json")
checksum=$(plutil -extract "assets.darwin-$architecture.sha256" raw -o - "$scratch/manifest.json")
# Values are data from the release manifest, never shell commands.
printf '%s\n' "$version" | /usr/bin/awk '!/^[0-9]+\.[0-9]+\.[0-9]+$/ { exit 1 }'
[ "$file" = "litespeed-$version-darwin-$architecture.tar.gz" ]
[ "${#checksum}" -eq 64 ]
case "$checksum" in *[!a-f0-9]*) echo 'Invalid release checksum.' >&2; exit 1;; esac
curl --fail --show-error --location --retry 2 --max-time 300 "https://github.com/BerriAI/litespeed/releases/download/v$version/$file" -o "$scratch/$file"
(cd "$scratch" && printf '%s  %s\n' "$checksum" "$file" | /usr/bin/shasum -a 256 -c -)
/usr/bin/tar -tzf "$scratch/$file" > "$scratch/files"
/usr/bin/awk '/^\// || /(^|\/)\.\.(\/|$)/ || !/^litespeed\// { bad=1 } END { exit bad }' "$scratch/files"
/usr/bin/tar -xzf "$scratch/$file" -C "$scratch"
"$scratch/litespeed/runtime/node" "$scratch/litespeed/bin/install.mjs" "$scratch/$file" "$scratch/manifest.json"
