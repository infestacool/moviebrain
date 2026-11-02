#!/bin/sh
# Run as PUID:PGID (default 99:100, Unraid's nobody:users) and make sure that
# user owns /config, so settings can be saved on Unraid, QNAP or any Docker host.
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
export PUID PGID

if [ "$(id -u)" = "0" ]; then
    mkdir -p /config
    if ! chown -R "$PUID:$PGID" /config 2>/dev/null; then
        echo "Warning: couldn't change the owner of /config to $PUID:$PGID; saving settings may fail." >&2
    fi
    # Drop root before starting the app. Python is already in the image, so no extra tools are needed.
    exec python -c 'import os, sys
os.setgroups([])
os.setgid(int(os.environ["PGID"]))
os.setuid(int(os.environ["PUID"]))
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
fi

# Started with --user: just run as that user.
exec "$@"
