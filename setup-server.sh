#!/usr/bin/env bash
# codebuddy-proxy 服务器一键部署（在服务器上以 root 执行）
# 用法: 把本脚本与 server.js 放在同一目录，bash setup-server.sh
set -euo pipefail

INSTALL_DIR=/opt/codebuddy-proxy
SERVICE=codebuddy-proxy
PORT="${PORT:-8787}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" = "0" ] || { echo "请用 root 运行"; exit 1; }

echo "==== 1/5 检查 Node.js (>=22) ===="
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  VER="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${VER:-0}" -ge 22 ]; then echo "已有 Node $(node -v)，跳过安装"; NEED_NODE=0; fi
fi
if [ "$NEED_NODE" = "1" ]; then
  echo "安装 Node.js 22 ..."
  if command -v apt-get >/dev/null 2>&1; then
    # NodeSource 源：先下载安装脚本到临时文件，再执行
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    apt-get install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    # NodeSource 源：先下载安装脚本到临时文件，再执行
    curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    yum install -y nodejs
  else
    echo "未识别的包管理器，请手动安装 Node.js 22+ 后重跑"; exit 1
  fi
fi
node -v && npm -v

echo "==== 2/5 安装 codebuddy CLI ===="
npm install -g @tencent-ai/codebuddy-code
command -v codebuddy && codebuddy --version || true

echo "==== 3/5 安装反代到 $INSTALL_DIR ===="
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/server.js" "$INSTALL_DIR/server.js"
cp "$SCRIPT_DIR/admin.html" "$INSTALL_DIR/admin.html"
mkdir -p "$INSTALL_DIR/admin-ui"
cp -a "$SCRIPT_DIR/admin-ui/." "$INSTALL_DIR/admin-ui/"
mkdir -p "$INSTALL_DIR/backend"
cp "$SCRIPT_DIR"/backend/*.cjs "$INSTALL_DIR/backend/"
if [ -d "$SCRIPT_DIR/backend/vendor-source" ]; then cp -a "$SCRIPT_DIR/backend/vendor-source" "$INSTALL_DIR/backend/"; fi
mkdir -p "$INSTALL_DIR/data"
if [ ! -f "$INSTALL_DIR/data/dbip-city-lite.mmdb" ] && [ -f "$SCRIPT_DIR/data/dbip-city-lite.mmdb" ]; then
  cp "$SCRIPT_DIR/data/dbip-city-lite.mmdb" "$INSTALL_DIR/data/dbip-city-lite.mmdb"
  chmod 600 "$INSTALL_DIR/data/dbip-city-lite.mmdb"
fi
cp "$SCRIPT_DIR/ext-assets.js" "$INSTALL_DIR/ext-assets.js"
node --check "$INSTALL_DIR/server.js"
for f in "$INSTALL_DIR"/backend/*.cjs; do node --check "$f"; done
if [ ! -f "$INSTALL_DIR/.env" ]; then
  # 运行时随机生成客户端鉴权密钥（非硬编码），写入仅 root 可读的 .env
  PROXY_SECRET="$(openssl rand -hex 24)"
  {
    echo "HOST=0.0.0.0"
    echo "PORT=$PORT"
    echo "CB_API_KEY=$PROXY_SECRET"
    echo "CB_DESENSITIZE=1"
  } > "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  echo "已生成客户端密钥（记下来，ZCode 配置要用）: $PROXY_SECRET"
else
  echo "$INSTALL_DIR/.env 已存在，保留原配置"
fi

echo "==== 4/5 配置 systemd 服务 ===="
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=CodeBuddy OpenAI-compatible proxy
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$(command -v node) $INSTALL_DIR/server.js
Restart=always
RestartSec=3
# 加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${SERVICE} >/dev/null

echo "==== 5/5 凭据检查与启动 ===="
if [ -f "$INSTALL_DIR/auth.json" ]; then
  echo "已存在 auth.json，启动服务"
  systemctl restart ${SERVICE}
else
  echo "尚未登录。两种方式二选一："
  echo ""
  echo "  方式 A（推荐）：在本服务器登录 codebuddy CLI"
  echo "    1) 运行:  codebuddy"
  echo "    2) 选 'Log in via Chinese Site'，把它打印的 URL 复制到你本地浏览器完成手机号登录"
  echo "    3) 登录成功后运行:  bash $SCRIPT_DIR/find-auth.sh"
  echo ""
  echo "  方式 B：把 Windows 桌面端已有登录态传上来（本机已验证可用）"
  echo "    在 Windows 的 Git Bash 执行:"
  echo "    scp \"\$LOCALAPPDATA/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info\" root@服务器IP:$INSTALL_DIR/auth.json"
  echo "    然后:  systemctl restart $SERVICE"
  echo ""
  echo "（服务已 enable，凭据就位后 systemctl restart $SERVICE 即可）"
  exit 0
fi

sleep 1
systemctl --no-pager status ${SERVICE} | head -8
echo ""
echo "健康检查:  curl -s http://127.0.0.1:$PORT/health"
echo "别忘了: 云安全组放行 TCP $PORT（建议仅放行你自己的出口 IP）"
