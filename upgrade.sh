#!/usr/bin/env bash
# Program-only upgrade. Keep server.js, admin.html, ext-assets.js, admin-ui/ and backend/*.cjs together.
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/codebuddy-proxy}"
SERVICE="${SERVICE:-codebuddy-proxy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" = 0 ] || { echo 'Run as root'; exit 1; }
[ -d "$INSTALL_DIR" ] || { echo 'Install directory missing'; exit 1; }
[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] || { echo 'Node 22+ required'; exit 1; }
for f in server.js admin.html ext-assets.js; do [ -f "$SCRIPT_DIR/$f" ]; done
for name in request quota credentials persistence schedule compression request-map geo-ip geo-worker admin-assets hardening http-dispatcher; do
  [ -f "$SCRIPT_DIR/backend/$name.cjs" ]
  node --check "$SCRIPT_DIR/backend/$name.cjs"
done
[ -d "$SCRIPT_DIR/admin-ui/assets" ]
node --check "$SCRIPT_DIR/server.js"
BACKUP_DIR="$INSTALL_DIR/.upgrade-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$BACKUP_DIR"
for f in server.js admin.html ext-assets.js backend; do
  if [ -e "$INSTALL_DIR/$f" ]; then cp -a "$INSTALL_DIR/$f" "$BACKUP_DIR/"; fi
done
# Includes credential/config snapshots; rollback restores programs only to avoid undoing live token refreshes.
for f in auths auth.json .env .api-keys.json settings.json usage-stats.json .ext-providers.json; do
  if [ -e "$INSTALL_DIR/$f" ]; then mkdir -p "$BACKUP_DIR/state"; cp -a "$INSTALL_DIR/$f" "$BACKUP_DIR/state/"; fi
done
cat > "$BACKUP_DIR/rollback.sh" <<EOF
#!/bin/sh
set -eu
for f in server.js admin.html ext-assets.js; do
  if [ -f "$BACKUP_DIR/\$f" ]; then cp -p "$BACKUP_DIR/\$f" "$INSTALL_DIR/\$f"; fi
done
if [ -d "$BACKUP_DIR/backend" ]; then cp -a "$BACKUP_DIR/backend/." "$INSTALL_DIR/backend/"; fi
systemctl restart "$SERVICE"
EOF
chmod 700 "$BACKUP_DIR/rollback.sh"
rollback() { echo 'Upgrade failed; restoring previous program'; bash "$BACKUP_DIR/rollback.sh"; }
trap rollback ERR
OWNER=$(stat -c '%u:%g' "$INSTALL_DIR/server.js")
mkdir -p "$INSTALL_DIR/backend"
mkdir -p "$INSTALL_DIR/data"
chown "$OWNER" "$INSTALL_DIR/data"
# Keep an existing database; a new installation downloads it in the worker.
if [ ! -f "$INSTALL_DIR/data/dbip-city-lite.mmdb" ] && [ -f "$SCRIPT_DIR/data/dbip-city-lite.mmdb" ]; then
  cp "$SCRIPT_DIR/data/dbip-city-lite.mmdb" "$INSTALL_DIR/data/dbip-city-lite.mmdb.new"
  chown "$OWNER" "$INSTALL_DIR/data/dbip-city-lite.mmdb.new"
  chmod 600 "$INSTALL_DIR/data/dbip-city-lite.mmdb.new"
  mv "$INSTALL_DIR/data/dbip-city-lite.mmdb.new" "$INSTALL_DIR/data/dbip-city-lite.mmdb"
fi
for f in "$SCRIPT_DIR"/backend/*.cjs; do
  dest="$INSTALL_DIR/backend/$(basename "$f")"
  cp "$f" "$dest.new"
  chown "$OWNER" "$dest.new"
  chmod 644 "$dest.new"
  mv "$dest.new" "$dest"
done
if [ -d "$SCRIPT_DIR/backend/vendor-source" ]; then mkdir -p "$INSTALL_DIR/backend/vendor-source"; cp -a "$SCRIPT_DIR/backend/vendor-source/." "$INSTALL_DIR/backend/vendor-source/"; fi
# Install hashed assets before switching HTML. Keep previous hashes for open tabs and rollback.
mkdir -p "$INSTALL_DIR/admin-ui/assets"
for f in "$SCRIPT_DIR"/admin-ui/assets/*; do
  dest="$INSTALL_DIR/admin-ui/assets/$(basename "$f")"
  cp "$f" "$dest.new"
  chown "$OWNER" "$dest.new"
  chmod 644 "$dest.new"
  mv "$dest.new" "$dest"
done
cp "$SCRIPT_DIR/admin-ui/Manrope-OFL.txt" "$INSTALL_DIR/admin-ui/Manrope-OFL.txt"
for f in ext-assets.js admin.html server.js; do
  cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f.new"
  chown "$OWNER" "$INSTALL_DIR/$f.new"
  chmod 644 "$INSTALL_DIR/$f.new"
  mv "$INSTALL_DIR/$f.new" "$INSTALL_DIR/$f"
done
systemctl restart "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE"
# Discover effective port from the running service without exposing its environment.
PID=$(systemctl show "$SERVICE" -p MainPID --value)
HTTP_PORT=$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^PORT=//p')
curl --fail --silent --max-time 10 "http://127.0.0.1:${HTTP_PORT:-8787}/health" > /dev/null
trap - ERR
echo "Upgrade complete. Rollback: bash $BACKUP_DIR/rollback.sh"
