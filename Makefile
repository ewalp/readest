.PHONY: help build-dmg build-android dev-android dev-macos check format

help:
	@echo "Readest Build Commands:"
	@echo "  make build-dmg      - Build macOS DMG package"
	@echo "  make build-android  - Build Android APK package (aarch64)"
	@echo "  make dev-android    - Build and install Android debug APK"
	@echo "  make dev-macos      - Build and run macOS app"
	@echo "  make check          - Run formatting, clippy and unit tests"

clean-bundle:
	rm -rf target/universal-apple-darwin/release/bundle/dmg/

build-dmg: clean-bundle
	pnpm --filter @readest/readest-app build-macos-universial

build-android: clean-bundle
	pnpm --filter @readest/readest-app tauri android build -t aarch64

dev-android:
	pnpm --filter @readest/readest-app dev-android

dev-macos:
	pnpm --filter @readest/readest-app dev-macos

check:
	pnpm format:check
	pnpm clippy:check
	pnpm test
