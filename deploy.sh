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

if ! command -v node >/dev/null 2>&1; then
    echo "node is required to sanitize dashboard JSON files" >&2
    exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp -R ./dashboards/. "$TMP_DIR"/

node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];

function removeGithubLinks(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value.links)) {
        value.links = value.links.filter((link) => {
            const title = String(link?.title ?? "");
            const url = String(link?.url ?? "");
            return !(title === "Source (GitHub)" || url.includes("github.com"));
        });
    }

    for (const child of Object.values(value)) removeGithubLinks(child);
}

for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const filePath = path.join(dir, file);
    const dashboard = JSON.parse(fs.readFileSync(filePath, "utf8"));
    removeGithubLinks(dashboard);
    fs.writeFileSync(filePath, JSON.stringify(dashboard, null, 2) + "\n");
}
' "$TMP_DIR"

echo "Copying to $HOST"
sshpass -f "$PASSKEY_FILE" rsync -rv -e "ssh -p $PORT" "$TMP_DIR"/ $USER@$HOST:$FOLDER/

echo "Dashboard Deployment finished successfully at $(date +"%Y-%m-%d %H:%M:%S")."
