#!/usr/bin/env python3
"""Refresh Xcode's cached Readest provisioning profile and check the built IPA."""

import argparse
import datetime as dt
import plistlib
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def decode_profile(data: bytes) -> dict:
    result = subprocess.run(
        ["openssl", "cms", "-verify", "-inform", "DER", "-noverify"],
        input=data,
        capture_output=True,
        check=True,
    )
    return plistlib.loads(result.stdout)


def matching(profile: dict, app_id: str, device_id: str) -> bool:
    return (
        profile.get("Entitlements", {}).get("application-identifier") == app_id
        and device_id in profile.get("ProvisionedDevices", [])
    )


def prepare(app_id: str, device_id: str) -> None:
    home = Path.home()
    folders = (
        home / "Library/MobileDevice/Provisioning Profiles",
        home / "Library/Developer/Xcode/UserData/Provisioning Profiles",
    )
    backup = Path(tempfile.mkdtemp(prefix="readest-profiles-"))
    count = 0
    for index, folder in enumerate(folders):
        if not folder.is_dir():
            continue
        for path in folder.glob("*.mobileprovision"):
            try:
                profile = decode_profile(path.read_bytes())
            except (OSError, subprocess.CalledProcessError, ValueError):
                continue
            if matching(profile, app_id, device_id):
                destination = backup / str(index)
                destination.mkdir(exist_ok=True)
                shutil.move(str(path), str(destination / path.name))
                count += 1
    print(f"已备份并移走 {count} 个匹配的本地描述文件；备份目录：{backup}", file=sys.stderr)
    print(backup)


def restore(backup: Path) -> None:
    folders = (
        Path.home() / "Library/MobileDevice/Provisioning Profiles",
        Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
    )
    for index, folder in enumerate(folders):
        source = backup / str(index)
        if source.is_dir():
            folder.mkdir(parents=True, exist_ok=True)
            for path in source.iterdir():
                target = folder / path.name
                if not target.exists():
                    shutil.move(str(path), str(target))


def verify(ipa: Path, app_id: str, device_id: str, started: float) -> None:
    with zipfile.ZipFile(ipa) as archive:
        path = next(
            (name for name in archive.namelist() if name.count("/") == 2 and name.endswith(".app/embedded.mobileprovision")),
            None,
        )
        if path is None:
            raise ValueError("IPA 中找不到主应用的 embedded.mobileprovision")
        profile = decode_profile(archive.read(path))
    if not matching(profile, app_id, device_id):
        raise ValueError("IPA 的描述文件与此应用或 iPad 不匹配")
    # plistlib decodes plist dates as naive UTC datetimes.
    check_freshness(profile, started)


def check_freshness(profile: dict, started: float) -> None:
    created = profile["CreationDate"].replace(tzinfo=dt.timezone.utc)
    expires = profile["ExpirationDate"].replace(tzinfo=dt.timezone.utc)
    start = dt.datetime.fromtimestamp(started, dt.timezone.utc)
    print(f"描述文件签发时间：{created.astimezone().isoformat(timespec='seconds')}")
    print(f"描述文件到期时间：{expires.astimezone().isoformat(timespec='seconds')}")
    if created < start - dt.timedelta(minutes=15) or expires < start + dt.timedelta(days=6, hours=23):
        raise ValueError("Apple/Xcode 仍使用旧描述文件，未获得从本次安装起约 7 天的有效期；已停止安装")


def verify_cache(app_id: str, device_id: str, started: float) -> None:
    folders = (
        Path.home() / "Library/MobileDevice/Provisioning Profiles",
        Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
    )
    for folder in folders:
        for path in folder.glob("*.mobileprovision"):
            try:
                profile = decode_profile(path.read_bytes())
                if matching(profile, app_id, device_id):
                    check_freshness(profile, started)
                    return
            except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
                continue
    raise ValueError("Xcode 没有为此应用和 iPad 签发新的描述文件")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "restore", "verify", "verify-cache"))
    parser.add_argument("--app-id", default="8BX6X22NU6.com.walpinjd.readest")
    parser.add_argument("--device-id", default="00008030-000A49E60E60C02E")
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--ipa", type=Path)
    parser.add_argument("--started", type=float)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.app_id, args.device_id)
    elif args.action == "restore":
        restore(args.backup)
    elif args.action == "verify":
        verify(args.ipa, args.app_id, args.device_id, args.started)
    else:
        verify_cache(args.app_id, args.device_id, args.started)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"描述文件处理失败：{error}", file=sys.stderr)
        sys.exit(1)
