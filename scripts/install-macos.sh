#!/bin/sh
# Install Casebook on macOS and run it in the background, from login, with no
# Terminal window.
#
# Double-clicking the executable launches it *through* Terminal.app: the window
# has to stay open, and closing it takes the server down. This hands the process
# to launchd instead — no window, no dock icon, and it comes back at every
# login, so the browser can reach the app whenever the clinician wants it.
#
# The agent claims the base port at login, ahead of any manual launch, which is
# what keeps http://casebook.localhost:4321 a bookmark that always works.
#
# usage: install-macos.sh                  download the latest build and install
#        install-macos.sh /path/to/Casebook   use a copy you already have
#        install-macos.sh --uninstall
#
# Re-run it to upgrade: the download is repeated, the binary replaced in place,
# and data.json left alone.
set -e

REPO="EngineeredDev/casebook"
LABEL="com.casebook.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG="$HOME/Library/Logs/casebook.log"
DEFAULT_DIR="$HOME/Applications/Casebook"

usage() {
  echo "usage: install-macos.sh [/path/to/Casebook]"
  echo "       install-macos.sh --uninstall"
}

# bootout fails when nothing is loaded; that is the normal first-install case.
stop_agent() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
}

case "$1" in
  --uninstall)
    stop_agent
    rm -f "$PLIST"
    echo "Removed $LABEL. The app, data.json and backups/ are untouched."
    exit 0
    ;;
  -h | --help)
    usage
    exit 0
    ;;
esac

[ "$(uname -s)" = Darwin ] || {
  echo "This installer is macOS-only (launchd)." >&2
  exit 1
}

if [ -n "$1" ]; then
  [ -f "$1" ] || {
    echo "No such file: $1" >&2
    usage >&2
    exit 1
  }
  # launchd expands nothing — no ~, no $HOME, no relative paths — and the app
  # derives its data directory from this same path, so resolve it once, here.
  dir=$(cd "$(dirname "$1")" && pwd -P)
  app="$dir/$(basename "$1")"
  download=""
  case "$dir" in
    "$HOME/Downloads"*)
      echo "WARNING: that copy lives in Downloads, and Casebook writes data.json" >&2
      echo "and backups/ beside itself. macOS can clear old downloads, and this" >&2
      echo "agent would keep pointing at the deleted path. Move the app somewhere" >&2
      echo "permanent and re-run this, or run it with no argument to install into" >&2
      echo "$DEFAULT_DIR." >&2
      ;;
  esac
else
  # An existing install wins over the default location. Re-running this script
  # is how you upgrade, and quietly relocating the app would strand the
  # data.json sitting next to the old copy.
  #
  # plutil prints its complaint on *stdout*, so a failed extract is captured as
  # if it were the path — and that text starts with the plist's own path, which
  # makes it look absolute. Trust the exit status, then confirm the answer names
  # a real directory before anything gets written there.
  app=""
  if [ -f "$PLIST" ] && found=$(plutil -extract ProgramArguments.0 raw -o - "$PLIST" 2>/dev/null); then
    [ -d "$(dirname "$found")" ] && app="$found"
  fi
  [ -n "$app" ] || app="$DEFAULT_DIR/Casebook"
  dir=$(dirname "$app")
  download=1
fi

# Nothing can replace the file while it is executing, so the running copy goes
# first — for an upgrade this is also what frees the port for the new one.
stop_agent
pkill -x "$(basename "$app")" 2>/dev/null || true

if [ -n "$download" ]; then
  # uname reports x86_64 for a shell running under Rosetta, which would fetch
  # the Intel build onto an Apple-silicon Mac. This flag describes the hardware.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
    asset="Casebook-mac-arm.zip"
  else
    asset="Casebook-mac-intel.zip"
  fi
  # The `latest` release is force-moved onto every push to main, so this URL is
  # stable and always current — see .github/workflows/release.yml.
  url="https://github.com/$REPO/releases/download/latest/$asset"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  echo "Downloading $asset"
  curl -fL --progress-bar -o "$tmp/$asset" "$url"
  unzip -q -o "$tmp/$asset" -d "$tmp"
  [ -f "$tmp/Casebook" ] || {
    echo "Unexpected archive layout: no Casebook inside $asset." >&2
    exit 1
  }

  mkdir -p "$dir"
  # Replaces the executable only. Anything else in the folder — data.json,
  # backups/ — is what an upgrade exists to preserve.
  mv -f "$tmp/Casebook" "$app"
  echo "Installed to $app"
fi

chmod +x "$app"
# Gatekeeper prompts a *user* about a quarantined download. launchd has no one
# to prompt, so an unquarantined binary is the difference between starting at
# login and failing silently at every login.
xattr -d com.apple.quarantine "$app" 2>/dev/null || true

# A path is arbitrary text going into XML; a username with & or < would
# otherwise write a plist that launchd refuses to parse.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml_escape "$app")</string></array>
  <key>RunAtLoad</key><true/>
  <!-- Crashes restart; clean exits do not. A launch that finds the port already
       taken hands off to the running copy and exits 0 on purpose, and a bare
       KeepAlive would respawn that forever, opening a browser tab each time. -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
</dict>
</plist>
PLIST_EOF

launchctl bootstrap "$DOMAIN" "$PLIST"

# The app opens a browser on start, so a tab is about to appear. Confirm the
# server is actually answering rather than trusting that bootstrap succeeded.
i=0
while [ "$i" -lt 20 ]; do
  if curl -fsS --max-time 1 http://127.0.0.1:4321/api/health 2>/dev/null |
    grep -q '"app":"casebook"'; then
    echo
    echo "Casebook is running at http://casebook.localhost:4321"
    echo "Data file: $dir/data.json"
    echo
    echo "It starts on its own at every login. Bookmark the address above —"
    echo "the executable never needs double-clicking again."
    echo "Upgrade later by re-running this. To remove it: install-macos.sh --uninstall"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done

echo "Installed, but nothing answered on port 4321 within 20s." >&2
echo "Check $LOG" >&2
exit 1
