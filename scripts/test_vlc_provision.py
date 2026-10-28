#!/usr/bin/env python3
"""Private defaults generation; no owner data or credential arguments."""
from pathlib import Path
import importlib.util, tempfile, json, os
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('vlc_provision',ROOT/'bots/CardputerADV/scripts/vlc_provision.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='vlc-private-') as tmp:
 p=Path(tmp);source=p/'config.json';output=p/'private'/'s1_vlc_private.h'
 config=dict(host='vlc-test.local',fallback_ip='192.168.5.2',port=8080,username='',password='synthetic-fixture-only',service_type='_vlc-http._tcp',status_path='/requests/status.json',playlist_path='/requests/playlist.json')
 source.write_text(json.dumps(config));source.chmod(0o600)
 module.generate(source,output)
 text=output.read_text();assert config['password'] not in text and 'kVlc_password' in text
 assert (output.stat().st_mode & 0o777)==0o600
 for key,value in [('port',0),('port',65536),('username','x'),('host','example.com'),('fallback_ip','8.8.8.8'),('password',''),('status_path','/admin'),('service_type','_http._tcp')]:
  bad=dict(config);bad[key]=value;source.write_text(json.dumps(bad))
  try:module.generate(source,output)
  except ValueError as error:assert config['password'] not in str(error)
  else:raise AssertionError('accepted invalid field '+key)
 source.write_text(json.dumps(config));source.chmod(0o644)
 try:module.generate(source,output)
 except ValueError:pass
 else:raise AssertionError('accepted public credential file')
print('PASS private VLC generation: ignored owner header, restrictive modes, no credential flags, field/path/host/auth validation')
