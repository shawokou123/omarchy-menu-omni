#!/bin/bash
# Omarchy Web AI Bridge 一键安装脚本
# 用于配置 Chrome 原生消息宿主、Systemd 自动激活服务以及扩展强制安装策略
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
echo "=== 正在安装 Omarchy Web AI Bridge ==="

# 1. 安装客户端和宿主脚本到 ~/.local/bin
mkdir -p "$HOME/.local/bin"
cp "$HERE/bin/dsweb" "$HOME/.local/bin/dsweb"
cp "$HERE/bin/omarchy-dsweb-host" "$HOME/.local/bin/omarchy-dsweb-host"
cp "$HERE/bin/omarchy-dsweb-crx-serve" "$HOME/.local/bin/omarchy-dsweb-crx-serve"
chmod +x "$HOME/.local/bin/dsweb" "$HOME/.local/bin/omarchy-dsweb-host" "$HOME/.local/bin/omarchy-dsweb-crx-serve"

# 2. 安装扩展数据与本地更新文件
mkdir -p "$HOME/.local/share/omarchy-dsweb"
cp -r "$HERE/share/"* "$HOME/.local/share/omarchy-dsweb/"
chmod +x "$HOME/.local/share/omarchy-dsweb/pack.sh" "$HOME/.local/share/omarchy-dsweb/rotate.sh" 2>/dev/null || true

# 3. 安装 Chrome Native Messaging 配置文件
NATIVE_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
mkdir -p "$NATIVE_DIR"
sed "s|/home/[^/]*/\.local/bin|$HOME/.local/bin|g" "$HERE/com.omarchy.dsweb.json" > "$NATIVE_DIR/com.omarchy.dsweb.json"

# 4. 配置 Systemd CRX 更新服务（socket 触发，零空闲占用）
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
sed "s|/home/[^/]*/\.local/bin|$HOME/.local/bin|g" "$HERE/systemd/omarchy-dsweb-crx.service" > "$SYSTEMD_DIR/omarchy-dsweb-crx.service"
cp "$HERE/systemd/omarchy-dsweb-crx.socket" "$SYSTEMD_DIR/omarchy-dsweb-crx.socket"
systemctl --user daemon-reload
systemctl --user enable --now omarchy-dsweb-crx.socket

# 5. 配置 Chrome 策略以自动安装扩展（需要管理员权限）
POLICY_DIR="/etc/opt/chrome/policies/managed"
echo "正在配置 Chrome 企业管理策略 (需要 sudo 权限)..."
sudo mkdir -p "$POLICY_DIR"
sudo cp "$HERE/omarchy-dsweb.json" "$POLICY_DIR/omarchy-dsweb.json"

echo "=== 安装完成！==="
echo "请打开 Chrome 并访问 DeepSeek (chat.deepseek.com) 或 ChatGPT (chatgpt.com) 保持登录状态。"
echo "现在您可以在启动器中使用 'ai <问题>' 或 'ai 帮我翻译 @<文件路径>' 进行提问！"
