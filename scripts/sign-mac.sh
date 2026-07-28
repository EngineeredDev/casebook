#!/bin/sh
# Ad-hoc re-sign a compiled macOS binary.
#
# `bun build --compile` leaves a `linker-signed` signature that seals only the
# original Mach-O, not the JS bundle Bun appends to it. `codesign -v` rejects
# the result, and Gatekeeper reports a quarantined copy as "damaged and can't
# be opened" — with no override button — on any Mac other than the build
# machine. Re-signing seals the whole file and restores the ordinary
# "unidentified developer" prompt, where right-click -> Open works.
#
# Still not notarization: a downloaded copy stays quarantined until the
# recipient clears it (`xattr -c Casebook`) or opens it via right-click.
set -e

target="$1"
[ -n "$target" ] || { echo "usage: sign-mac.sh <binary>" >&2; exit 1; }

if ! command -v codesign >/dev/null 2>&1; then
  echo "WARNING: codesign not found (not macOS?) — $target is left with an" >&2
  echo "invalid signature and will read as \"damaged\" on other Macs." >&2
  exit 0
fi

codesign --force --sign - "$target"
codesign --verify --verbose=1 "$target"
