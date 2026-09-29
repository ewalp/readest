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

# Xcode 会复用仍有效的本地描述文件。先备份并移走此应用与设备的缓存，
# 让自动签名向 Apple 请求新文件；最终是否签发仍由 Apple 决定。
STARTED_AT="$(date +%s)"
PROFILE_BACKUP="$(python3 "$PROJECT_ROOT/ios_profile_refresh.py" prepare --device-id "$DEVICE_ID")"
restore_profiles_on_failure() {
  if [ "$?" -ne 0 ]; then
    python3 "$PROJECT_ROOT/ios_profile_refresh.py" restore --backup "$PROFILE_BACKUP" || true
    echo "❌ 构建、签名或安装未完成。旧描述文件已尝试恢复，备份：$PROFILE_BACKUP"
  fi
}
trap restore_profiles_on_failure EXIT

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

echo "🔐 正在针对已连接的 iPad 请求新的个人开发者描述文件..."
PROVISION_LOG="$(mktemp "${TMPDIR:-/tmp}/readest-provision.XXXXXX")"
if ! xcodebuild \
  -project "$PROJECT_ROOT/apps/readest-app/src-tauri/gen/apple/Readest.xcodeproj" \
  -scheme Readest_iOS \
  -configuration debug \
  -destination "platform=iOS,id=$DEVICE_ID" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build > "$PROVISION_LOG" 2>&1; then
  if ! python3 "$PROJECT_ROOT/ios_profile_refresh.py" verify-cache --device-id "$DEVICE_ID" --started "$STARTED_AT"; then
    tail -80 "$PROVISION_LOG"
    exit 1
  fi
  echo "✅ Xcode 已签发新的描述文件；预备构建的 Tauri 脚本报错不影响后续正式构建。"
else
  python3 "$PROJECT_ROOT/ios_profile_refresh.py" verify-cache --device-id "$DEVICE_ID" --started "$STARTED_AT"
fi

echo "📦 [1/2] 正在编译前端、Rust 后端并自动完成 iOS 签名..."
pnpm --filter @readest/readest-app tauri ios build --debug --export-method debugging

if [ ! -f "$IPA_PATH" ]; then
  echo "❌ 错误: 未能找到生成的 IPA 文件: $IPA_PATH"
  exit 1
fi

python3 "$PROJECT_ROOT/ios_profile_refresh.py" verify --ipa "$IPA_PATH" --device-id "$DEVICE_ID" --started "$STARTED_AT"

echo "📲 [2/2] 正在将最新签名的 Readest.ipa 推送到 iPad (设备: $DEVICE_ID)..."
xcrun devicectl device install app --device "$DEVICE_ID" "$IPA_PATH"
trap - EXIT

echo "=========================================="
echo "🎉 安装成功！Readest 已推送到 iPad！"
echo "💡 描述文件有效期已在安装前验证；如果 iPad 提示信任开发者，请到「设置」->「通用」->「VPN与设备管理」确认。"
echo "=========================================="
