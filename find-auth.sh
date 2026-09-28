#!/usr/bin/env bash
# 登录 codebuddy 后，定位 CLI 写下的凭据文件并复制为反代的 auth.json
set -euo pipefail

DEST=/opt/codebuddy-proxy/auth.json
[ "$(id -u)" = "0" ] || DEST="$HOME/codebuddy-proxy/auth.json"
PORT="${PORT:-8787}"

shopt -s nullglob
CANDIDATES=(
  "$HOME"/.codebuddy/local_storage/*.info
  "$HOME"/.local/share/CodeBuddyExtension/Data/Public/auth/*.info
  /root/.codebuddy/local_storage/*.info
  /root/.local/share/CodeBuddyExtension/Data/Public/auth/*.info
)
for f in "${CANDIDATES[@]}"; do
  [ -f "$f" ] || continue
  if grep -q '"accessToken"' "$f" 2>/dev/null; then
    mkdir -p "$(dirname "$DEST")"
    cp "$f" "$DEST"
    chmod 600 "$DEST"
    echo "已复制: $f -> $DEST"
    if command -v systemctl >/dev/null 2>&1; then systemctl restart codebuddy-proxy 2>/dev/null || true; fi
    sleep 1
    echo "--- /health ---"
    curl -s "http://127.0.0.1:$PORT/health" || true
    echo
    exit 0
  fi
done

echo "未找到含 accessToken 的凭据文件。请先完成登录："
echo "  1) 运行 codebuddy，选 'Log in via Chinese Site'，手机号登录"
echo "  2) 重新运行本脚本"
echo "  或者用方式 B：把 Windows 桌面端的 workbuddy-desktop.info scp 上来作为 auth.json"
exit 1
