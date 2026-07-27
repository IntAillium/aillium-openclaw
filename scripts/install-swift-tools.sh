#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <install-directory>" >&2
  exit 2
fi

install_dir="$1"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

install_archive() {
  local name="$1"
  local url="$2"
  local checksum="$3"
  local archive="$temp_dir/$name.zip"
  local extract_dir="$temp_dir/$name"

  curl --fail --location --silent --show-error \
    --connect-timeout 10 --max-time 120 \
    --retry 3 --retry-max-time 120 \
    --output "$archive" "$url"
  if [[ "$(shasum -a 256 "$archive" | awk '{print $1}')" != "$checksum" ]]; then
    echo "$name archive checksum mismatch" >&2
    exit 1
  fi

  mkdir -p "$extract_dir"
  unzip -q "$archive" -d "$extract_dir"
  install -m 0755 "$extract_dir/$name" "$install_dir/$name"
}

mkdir -p "$install_dir"

# These are the latest stable releases that existed when this OpenClaw
# snapshot's Swift sources and formatter configuration were authored.
install_archive \
  swiftformat \
  "https://github.com/nicklockwood/SwiftFormat/releases/download/0.60.1/swiftformat.zip" \
  "23b50c75f4223c477e822833c4cf819a1c9abbb6d00e892900bda1c3a8231afd"
install_archive \
  swiftlint \
  "https://github.com/realm/SwiftLint/releases/download/0.63.2/portable_swiftlint.zip" \
  "c59a405c85f95b92ced677a500804e081596a4cae4a6a485af76065557d6ed29"

[[ "$("$install_dir/swiftformat" --version)" == "0.60.1" ]]
[[ "$("$install_dir/swiftlint" version)" == "0.63.2" ]]
