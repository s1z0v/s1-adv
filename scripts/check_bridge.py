#!/usr/bin/env python3
"""Read-only bridge check. Never prints a token or conversation text."""
import argparse
import getpass
import json
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('url', help='Your HTTPS bridge base URL')
args = p.parse_args()
base = args.url.rstrip('/')
if urlsplit(base).scheme != 'https':
    p.error('Use HTTPS for this authenticated remote check.')
token = getpass.getpass('Device token (hidden): ')

def fetch(path):
    req = Request(base + path, headers={'Authorization': 'Bearer ' + token})
    with urlopen(req, timeout=30) as response:
        return json.load(response)

health = fetch('/healthz')
topics = fetch('/api/cardputer/v1/topics')
items = topics.get('items', topics.get('topics', [])) if isinstance(topics, dict) else topics
result = {'http_ok': health.get('ok'), 'upstream_connected': health.get('upstream_connected'),
          'topic_count': len(items)}
if items:
    history = fetch('/api/cardputer/v1/topics/' + quote(items[0]['topic_key'], safe='') + '/history?limit=1')
    result['history_ok'] = isinstance(history, dict)
print(json.dumps(result, indent=2))
if not health.get('ok') or not health.get('upstream_connected') or not items:
    raise SystemExit(1)
