#!/bin/bash
# Pack the dsweb extension into the CRX that Chrome force-installs, and bump
# the version in the Omaha update manifest so Chrome sees a newer build.
#
#   pack.sh            bump the patch version (1.0 -> 1.1 -> 1.2 ...)
#   pack.sh 2.0        set an explicit version
set -eu

BASE="$HOME/.local/share/omarchy-dsweb"
EXT="$BASE/ext"
WEB="$BASE/web"
KEY="$BASE/keys/key.pem"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

python3 - "$EXT/manifest.json" "$WEB/update.xml" "${1:-}" <<'PY'
import json, re, sys
manifest_path, update_path, wanted = sys.argv[1], sys.argv[2], sys.argv[3]
manifest = json.load(open(manifest_path))
if wanted:
    version = wanted
else:
    major, minor = (manifest["version"].split(".") + ["0"])[:2]
    version = "%s.%d" % (major, int(minor) + 1)
manifest["version"] = version
with open(manifest_path, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")

xml = open(update_path).read()
xml = re.sub(r"(<updatecheck[^>]*?)version='[^']*'", r"\g<1>version='%s'" % version, xml)
open(update_path, "w").write(xml)
print(version)
PY
VERSION=$(python3 -c 'import json;print(json.load(open("'"$EXT"'/manifest.json"))["version"])')

mkdir -p "$STAGE"
cp -r "$EXT/." "$STAGE/"

# Every content script reports this build back on its ping, which is how the
# service worker spots a tab still running an older release.
python3 - "$STAGE" "$VERSION" <<'PY'
import glob, os, sys
stage, version = sys.argv[1], sys.argv[2]
stamped = []
for path in sorted(glob.glob(os.path.join(stage, "*.js"))):
    src = open(path).read()
    if "__BUILD__" not in src:
        continue
    open(path, "w").write(src.replace("__BUILD__", version))
    stamped.append(os.path.basename(path))
if not stamped:
    sys.exit("no staged script carries the __BUILD__ placeholder")
print("stamped " + version + " into " + ", ".join(stamped))
PY

# Chrome writes <dir>.crx and <dir>.pem; the key is supplied so the extension id
# stays fixed across rebuilds.
google-chrome-stable --pack-extension="$STAGE" --pack-extension-key="$KEY" --no-message-box >/dev/null 2>&1 || true
if [ ! -f "$STAGE.crx" ]; then
  echo "pack failed: no $STAGE.crx" >&2
  exit 1
fi
install -m 644 "$STAGE.crx" "$WEB/omarchy-dsweb.crx"
echo "packed version $VERSION -> $WEB/omarchy-dsweb.crx ($(stat -c%s "$WEB/omarchy-dsweb.crx") bytes)"
