#!/bin/bash
# Make the running Chrome re-install the extension from web/update.xml.
#
# Chrome only fetches a new version when the force-install policy changes or at
# a periodic update check, so this clears the forcelist entry, waits for Chrome
# to release the extension, and puts the entry back. Needs root: the policy file
# lives under /etc/opt/chrome/policies/managed.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
POLICY=/etc/opt/chrome/policies/managed/omarchy-dsweb.json
ID=ofgecdhhcjemflbccnbohdomliblhdjc
TARGET_USER="${SUDO_USER:-$USER}"
TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
SOCK="/run/user/${TARGET_UID}/omarchy-dsweb-${TARGET_UID}.sock"
EXTDIR="$TARGET_HOME/.config/google-chrome/Default/Extensions/$ID"

if [ ! -f "$POLICY" ]; then
  echo "policy file missing: $POLICY" >&2
  exit 1
fi
if ! sudo -n true 2>/dev/null; then
  echo "this needs root to rewrite $POLICY" >&2
fi

OFF=$(mktemp)
ON=$(mktemp)
trap 'rm -f "$OFF" "$ON"' EXIT
echo '{"ExtensionInstallForcelist": []}' > "$OFF"
cp "$POLICY" "$ON"

echo "releasing the extension"
sudo install -m 644 -o root -g root "$OFF" "$POLICY"
for _ in $(seq 1 20); do
  sleep 1
  [ -S "$SOCK" ] || break
done

echo "reinstalling from update.xml"
sudo install -m 644 -o root -g root "$ON" "$POLICY"
for _ in $(seq 1 40); do
  sleep 1
  [ -S "$SOCK" ] && break
done

echo "installed versions:"
ls "$EXTDIR" 2>/dev/null || echo "  (none yet: check that Chrome is running)"
