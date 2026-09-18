#!/bin/bash
set -e

echo "=========================================="
echo "🚀 开始一键编译、重签并安装 Readest 到 iPad"
echo "=========================================="

# 1. 自动配置环境变量 (确保包含 pnpm, node, cargo)
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"
[ -s "$HOME/.cargo/env" ] && \. "$HOME/.cargo/env"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVICE_ID="00008030-000A49E60E60C02E"
IPA_PATH="$PROJECT_ROOT/apps/readest-app/src-tauri/gen/apple/build/arm64/Readest.ipa"
ENTITLEMENTS_FILE="$PROJECT_ROOT/apps/readest-app/src-tauri/gen/apple/Readest_iOS/Readest_iOS.entitlements"

cd "$PROJECT_ROOT"

# 2. 自动修正个人免费开发者特权配置（移除付费特权 associated-domains，确保个人证书免阻断）
if [ -f "$ENTITLEMENTS_FILE" ]; then
  cat << 'EOF' > "$ENTITLEMENTS_FILE"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
EOF
fi

echo "📦 [1/2] 正在编译前端、Rust 后端并自动完成 iOS 签名..."
pnpm --filter @readest/readest-app tauri ios build --debug --export-method debugging

if [ ! -f "$IPA_PATH" ]; then
  echo "❌ 错误: 未能找到生成的 IPA 文件: $IPA_PATH"
  exit 1
fi

echo "📲 [2/2] 正在将最新签名的 Readest.ipa 推送到 iPad (设备: $DEVICE_ID)..."
xcrun devicectl device install app --device "$DEVICE_ID" "$IPA_PATH"

echo "=========================================="
echo "🎉 安装成功！Readest 已推送到 iPad！"
echo "💡 提示: 若7天证书过期后重新执行本脚本，在 iPad 的「设置」->「通用」->「VPN与设备管理」重新确认信任即可继续使用。"
echo "=========================================="
