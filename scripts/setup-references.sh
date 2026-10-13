#!/bin/bash
# Fetches the repositories the dev stack is built from, at the revisions this project was tested against, and
# applies our small patches to them. Re-runnable: a repository already present is left as it is.
#
#   references/twake-workplace-docker   the Twake stack (cozy-stack, LemonLDAP, Meet/LiveKit, Traefik)
#   references/twake-drive              host app that carries the Phone widget (optional)
#   references/minipbx                  the dev PBX (base image)
#
# The patches live in docker/stack/. Nothing here touches your global Docker or system configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REFS="$ROOT/references"
mkdir -p "$REFS"

fetch() { # name url revision
  local name="$1" url="$2" rev="$3"
  if [[ -d "$REFS/$name/.git" ]]; then
    echo "  $name: already present"
    return
  fi
  echo "  $name: cloning $url @ ${rev:0:9}"
  git clone --quiet "$url" "$REFS/$name"
  git -C "$REFS/$name" checkout --quiet "$rev"
}

patch_repo() { # name patch
  local name="$1" file="$ROOT/docker/stack/$2"
  if git -C "$REFS/$name" apply --check --reverse "$file" 2>/dev/null; then
    echo "  $name: patch already applied"
  else
    git -C "$REFS/$name" apply "$file"
    echo "  $name: patch applied"
  fi
}

echo "References"
fetch twake-workplace-docker https://github.com/linagora/twake-workplace-docker.git 50fa62ebb8527fd5800bde1a08684df6ee1c9431
fetch twake-drive https://github.com/linagora/twake-drive.git 77dc096f0cc6a78d2b624315f054f6c91787e9f9
fetch minipbx https://git.oriatec.fr/ORIATEC/minipbx.git 5050ccf86dda30c23538e3c8a3fe1e698ee91057

echo "Patches"
patch_repo twake-workplace-docker twake-workplace-docker.patch
patch_repo twake-drive twake-drive.patch

# Local settings of the stack (paths of this checkout, loopback alias for Traefik). Never overwritten once set.
ENV="$REFS/twake-workplace-docker/.env"
set_env() { # key value
  if grep -qE "^$1=" "$ENV"; then
    sed -i.bak -E "s#^$1=.*#$1=$2#" "$ENV" && rm -f "$ENV.bak"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV"
  fi
}
echo "Stack settings"
set_env COZY_DEV_APP_SLUG phone
set_env COZY_DEV_APP_BUILD "$ROOT/apps/phone/build"
set_env TRAEFIK_BIND "${TRAEFIK_BIND:-127.0.0.2}"
set_env COZY_DEV_APP2_SLUG drive
set_env COZY_DEV_APP2_BUILD "$REFS/twake-drive/build"
echo "  written to references/twake-workplace-docker/.env"
