#!/usr/bin/env bash
set -euo pipefail

# install.sh — set up the Plaud → Notations pipeline on this Mac.
#
# Copies the scripts into ~/bin, the UI onto ~/Desktop, generates a personalized
# launchd plist from the template, and bootstraps the login service on port 8791.
# Idempotent: safe to re-run.
#
# Prerequisites it does NOT install for you (see README): ffmpeg, whisper-cpp,
# the whisper model, a Plaud login, and a Notations/Fieldlines MCP token.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$HOME"
LABEL="${PLAUD_LABEL:-com.$(id -un).plaud-pipeline}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"

echo "→ Installing scripts to ~/bin"
mkdir -p "$HOME_DIR/bin"
cp "$REPO/bin/plaud-pipeline-server.mjs" "$HOME_DIR/bin/"
cp "$REPO/bin/plaud-transcribe.sh"       "$HOME_DIR/bin/"
cp "$REPO/bin/plaud-diarize.py"          "$HOME_DIR/bin/"
chmod +x "$HOME_DIR/bin/plaud-transcribe.sh" "$HOME_DIR/bin/plaud-diarize.py"

echo "→ Installing UI to ~/Desktop"
cp "$REPO/web/plaud-pipeline.html" "$HOME_DIR/Desktop/"
cp "$REPO/web/plaud-setup.html"    "$HOME_DIR/Desktop/"

echo "→ Generating launchd plist: $PLIST"
mkdir -p "$HOME_DIR/Library/LaunchAgents"
sed -e "s|__HOME__|$HOME_DIR|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__LABEL__|$LABEL|g" \
    "$REPO/launchd/com.USER.plaud-pipeline.plist.template" > "$PLIST"

echo "→ (Re)loading the service"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo
echo "✓ Installed. Open http://localhost:8791"
echo "  If it isn't up, check ~/Library/Logs/plaud-pipeline.log"
echo
echo "Still required (see README): brew install ffmpeg whisper-cpp,"
echo "the whisper model, 'npx -y @plaud-ai/mcp@latest install' (Plaud login),"
echo "and a NOTATIONS_TOKEN / FIELDLINES_TOKEN."
