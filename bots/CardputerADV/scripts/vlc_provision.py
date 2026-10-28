"""Private VLC defaults: file -> ignored header, never compiler arguments/logs."""
import json
import os
from pathlib import Path
import ipaddress


def generate(source, destination):
    p = Path(source)
    if p.stat().st_mode & 0o077:
        raise ValueError('VLC provisioning file must be private (0600).')
    config = json.loads(p.read_text())
    # Report only field names on validation failure, never configuration values.
    limits = {'host': 127, 'fallback_ip': 15, 'username': 0, 'password': 128,
              'service_type': 32, 'status_path': 64, 'playlist_path': 64}
    for key, limit in limits.items():
        value = config.get(key, '')
        if not isinstance(value, str) or len(value.encode('utf8')) > limit or any(ord(c) < 32 for c in value):
            raise ValueError('Invalid VLC field: ' + key)
    if not config.get('password') or not config.get('host', '').endswith('.local'):
        raise ValueError('VLC needs a password and a .local hostname.')
    if config.get('service_type') != '_vlc-http._tcp':
        raise ValueError('Unsupported VLC service_type.')
    if config.get('status_path') != '/requests/status.json' or config.get('playlist_path') != '/requests/playlist.json':
        raise ValueError('Unsupported VLC API paths.')
    ip = ipaddress.IPv4Address(config['fallback_ip'])
    if not any(ip in ipaddress.IPv4Network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('VLC fallback must be a private LAN address.')
    port = config.get('port')
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError('Invalid VLC port.')
    lines = ['// PRIVATE GENERATED FILE: never commit or attach.', '#pragma once']
    for key in ('host', 'fallback_ip', 'username', 'password'):
        data = ','.join('char(%d)' % b for b in config[key].encode('utf8'))
        lines.append('static const char kVlc_%s[] = {%s%s0};' % (key, data, ',' if data else ''))
    lines.append('static constexpr unsigned kVlc_port = %d;' % port)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    os.chmod(destination, 0o600)


if __name__ == 'SCons.Script':
    Import('env')  # noqa: F821 — supplied by PlatformIO
    source = os.environ.get('S1_ADV_VLC_CONFIG_PATH', '')
    if source:
        folder = Path(env.subst('$BUILD_DIR')) / 'private_vlc'  # noqa: F821
        try:
            generate(source, folder / 's1_vlc_private.h')
        except Exception:
            # Neither malformed JSON nor file exceptions may echo private data.
            raise RuntimeError('Private VLC provisioning failed; inspect the local file privately.') from None
        env.Append(CPPPATH=[str(folder)], CPPDEFINES=['S1_ADV_VLC_PROVISIONED'])  # noqa: F821
