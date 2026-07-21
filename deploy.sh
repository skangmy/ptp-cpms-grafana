#!/bin/bash

# Check the value of the argument
HOST="ptp-main"
USER="ubuntu"
PORT=22
FOLDER="~/dashboards/cpms"
PASSKEY_FILE=".passkey"

if [ ! -f "$PASSKEY_FILE" ]; then
    echo "Password file not found: $PASSKEY_FILE" >&2
    exit 1
fi

if ! command -v sshpass >/dev/null 2>&1; then
    echo "sshpass is required to read password from $PASSKEY_FILE" >&2
    exit 1
fi

echo "Copying to $HOST"
sshpass -f "$PASSKEY_FILE" rsync -rv -e "ssh -p $PORT" ./dashboards/* $USER@$HOST:$FOLDER/

echo "Dashboard Deployment finished successfully at $(date +"%Y-%m-%d %H:%M:%S")."
