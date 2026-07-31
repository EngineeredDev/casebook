#!/bin/sh
# Install Casebook on macOS.
#
# Downloads the latest release, extracts Casebook.app into /Applications and
# opens it. This is the recommended way in, for one specific reason: a file
# fetched by curl never gets the com.apple.quarantine attribute, because only
# quarantine-aware apps — browsers, Mail — set it. No quarantine means
# Gatekeeper never engages, so there is no "Apple could not verify" dialog to
# argue with, and no App Translocation running the app from a read-only mount
# where it could not update itself.
#
# Casebook is ad-hoc signed and will never be notarized; there is no Apple
# Developer certificate behind this project. Downloading the .dmg from the
# releases page works too, and costs one trip through System Settings →
# Privacy & Security → Open Anyway. See the README.
#
# usage: install-macos.sh                                    download and install
#        install-macos.sh /path/to/Casebook-mac-arm64.zip    install a local build
#        install-macos.sh --uninstall
#
# Re-run it to upgrade. Your data lives in ~/Casebook and is never touched by
# this script — not on upgrade, not on uninstall.
set -e

REPO="EngineeredDev/casebook"
ASSET="Casebook-mac-arm64.zip"
APP="Casebook.app"
URL="https://github.com/$REPO/releases/latest/download/$ASSET"

# The pre-Electron Casebook: a bare executable started by a LaunchAgent at every
# login. Only ever removed on --uninstall, and deliberately left alone when
# installing — the new app looks for it on first run and offers to bring the
# data across before anything is deleted.
OLD_LABEL="com.casebook.server"
OLD_PLIST="$HOME/Library/LaunchAgents/$OLD_LABEL.plist"

usage() {
  echo "usage: install-macos.sh [/path/to/$ASSET]"
  echo "       install-macos.sh --uninstall"
}

# Where an already-installed copy is, if it is anywhere.
installed_at() {
  for dir in /Applications "$HOME/Applications"; do
    [ -d "$dir/$APP" ] && {
      echo "$dir/$APP"
      return 0
    }
  done
  return 1
}

# Nothing can be replaced while it is running, and macOS will happily delete a
# running bundle out from under itself and leave it running.
quit_casebook() {
  osascript -e 'tell application "Casebook" to quit' 2>/dev/null || true
  i=0
  while [ "$i" -lt 10 ]; do
    pgrep -x Casebook >/dev/null 2>&1 || return 0
    sleep 1
    i=$((i + 1))
  done
  pkill -x Casebook 2>/dev/null || true
  sleep 1
}

retire_old_launchagent() {
  [ -f "$OLD_PLIST" ] || return 0
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
  rm -f "$OLD_PLIST"
  echo "Removed the old $OLD_LABEL login item."
}

case "$1" in
  --uninstall)
    quit_casebook
    if app=$(installed_at); then
      rm -rf "$app"
      echo "Removed $app."
    else
      echo "Casebook.app wasn't in /Applications or ~/Applications."
    fi
    retire_old_launchagent
    echo
    echo "Your data is untouched, in ~/Casebook. Delete that folder yourself if"
    echo "you really want it gone — nothing else will."
    exit 0
    ;;
  -h | --help)
    usage
    exit 0
    ;;
esac

[ "$(uname -s)" = Darwin ] || {
  echo "Casebook is macOS-only." >&2
  exit 1
}

# uname reports x86_64 for a shell running under Rosetta, which would make an
# Apple-silicon Mac look like the wrong target for an arm64 build. This flag
# describes the hardware.
[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] || {
  echo "This build is for Apple silicon (M1 and later) and this Mac is Intel." >&2
  echo "Building for Intel is a one-line change — open an issue." >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -n "$1" ]; then
  [ -f "$1" ] || {
    echo "No such file: $1" >&2
    usage >&2
    exit 1
  }
  zip=$1
else
  # /releases/latest/download resolves to the newest release that is not a
  # prerelease, so this URL is both stable and always current. Untagged CI
  # builds are invisible to it on purpose — see RELEASING.md.
  zip="$tmp/$ASSET"
  echo "Downloading Casebook"
  curl -fL --progress-bar -o "$zip" "$URL"
fi

# ditto rather than unzip: it is the tool that round-trips a signed bundle with
# its symlinks, execute bits and signature intact. unzip mangles all three, and
# the result is an app that will not launch.
ditto -x -k "$zip" "$tmp/extracted"
[ -d "$tmp/extracted/$APP" ] || {
  echo "Unexpected archive layout: no $APP inside $(basename "$zip")." >&2
  exit 1
}

# Admin accounts can write to /Applications without elevation, which is where an
# app belongs. A standard account cannot, and ~/Applications works just as well
# — the app finds its own data either way.
if [ -w /Applications ]; then
  dest=/Applications
else
  dest="$HOME/Applications"
  mkdir -p "$dest"
  echo "No write access to /Applications, installing to $dest instead."
fi

# An existing copy might be in the *other* location, and leaving it there would
# mean two Casebooks and a coin flip over which one opens.
if existing=$(installed_at); then
  quit_casebook
  rm -rf "$existing"
fi

ditto "$tmp/extracted/$APP" "$dest/$APP"

# Belt and braces. A curl download carries no quarantine, but this script also
# accepts a zip from anywhere, and a quarantined bundle gets translocated to a
# read-only mount where the in-app updater cannot replace it.
xattr -dr com.apple.quarantine "$dest/$APP" 2>/dev/null || true

# A truncated download extracts cleanly and then fails at launch with a dialog
# that explains nothing. The signature is a whole-bundle checksum; use it as one.
codesign --verify --deep --strict "$dest/$APP" 2>/dev/null || {
  echo "The downloaded app failed its signature check and was not installed." >&2
  rm -rf "$dest/$APP"
  exit 1
}

open "$dest/$APP"

echo
echo "Casebook is installed at $dest/$APP and starting now."
echo "Your data lives in ~/Casebook."
echo
if [ -f "$OLD_PLIST" ]; then
  echo "The older Casebook is still on this Mac. The app will offer to bring its"
  echo "data across and tidy it up when it opens — let it do that rather than"
  echo "deleting anything yourself."
  echo
fi
echo "Run this again to upgrade. To remove it: install-macos.sh --uninstall"
