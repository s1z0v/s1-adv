#!/usr/bin/env python3
"""Portable PlatformIO entry point. Private provisioning stays in .env."""
import argparse
import datetime
import os
from pathlib import Path
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def environment():
    env = os.environ.copy()
    path = ROOT / '.env'
    if path.exists():
        for number, line in enumerate(path.read_text().splitlines(), 1):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            key, sep, value = line.removeprefix('export ').partition('=')
            key = key.strip()
            if not sep or not key.isidentifier():
                raise SystemExit(f'Invalid .env assignment at line {number}')
            value = value.strip()
            if value.startswith(('"', "'")):
                parts = shlex.split(value)
                if len(parts) != 1:
                    raise SystemExit(f'Invalid quoted .env value at line {number}')
                value = parts[0]
            env.setdefault(key, value)
    defaults = {
        'DEFAULT_WIFI_SSID': '', 'DEFAULT_WIFI_PASSWORD': '',
        'DEFAULT_HUB_HOST': '', 'DEFAULT_HUB_PORT': '443',
        'DEFAULT_DEVICE_ID': 'cardputer-adv-01', 'DEFAULT_DEVICE_TOKEN': '',
        'DEFAULT_TOPIC_KEY': 'cardputer:main',
        'BUILD_TIME': datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'),
    }
    for key, value in defaults.items():
        env.setdefault(key, value)
    for key in defaults:
        if any(c in env[key] for c in ('"', '\\', '\n', '\r')):
            raise SystemExit(f'{key} contains characters unsupported by compiler flags. Use device setup for credentials.')
    if not env['DEFAULT_TOPIC_KEY'] or not env['DEFAULT_DEVICE_ID']:
        raise SystemExit('Device ID and topic key must be nonempty.')
    try:
        if not 1 <= int(env['DEFAULT_HUB_PORT']) <= 65535:
            raise ValueError()
    except ValueError:
        raise SystemExit('DEFAULT_HUB_PORT must be between 1 and 65535.')
    ref = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--short', 'HEAD'],
                         capture_output=True, text=True)
    env.setdefault('BUILD_GIT_SHA', ref.stdout.strip() if ref.returncode == 0 else 'local')
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['build', 'upload', 'monitor', 'ports'])
    parser.add_argument('--port', help='Actual USB port, e.g. /dev/cu.usbmodem1101 or COM3')
    args = parser.parse_args()
    env = environment()
    cmd = [sys.executable, '-m', 'platformio']
    if args.action == 'ports':
        cmd += ['device', 'list']
    elif args.action == 'monitor':
        cmd += ['device', 'monitor', '--baud', '115200']
        if args.port:
            cmd += ['--port', args.port]
    else:
        cmd += ['run', '-d', str(ROOT / 'bots/CardputerADV'), '-e', 'cardputer_adv']
        if args.action == 'upload':
            cmd += ['--target', 'upload']
            if args.port:
                cmd += ['--upload-port', args.port]
    return subprocess.call(cmd, cwd=ROOT, env=env)


if __name__ == '__main__':
    raise SystemExit(main())
