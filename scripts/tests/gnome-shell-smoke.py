#!/usr/bin/env python3
"""Render Copyous in a separate headless Shell with disposable settings and data."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import zipfile

REPO = Path(__file__).resolve().parents[2]
UUID = 'copyous@boerdereinar.dev'
root = Path(tempfile.mkdtemp(prefix='copyous-shell-smoke-'))
env = os.environ.copy()
for key in ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_ID',
            'DEBUG_COPYOUS_SCHEMA', 'DEBUG_COPYOUS_DBPATH', 'DEBUG_COPYOUS_ACTIONS']:
    env.pop(key, None)
for key, name in [('XDG_RUNTIME_DIR', 'runtime'), ('XDG_DATA_HOME', 'data'),
                  ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'),
                  ('XDG_STATE_HOME', 'state')]:
    path = root / name
    path.mkdir(mode=0o700)
    env[key] = str(path)
env.update(GSETTINGS_BACKEND='memory', COPYOUS_SHELL_TEST_ROOT=str(root),
           DEBUG_COPYOUS_TIMINGS='1', LIBGL_ALWAYS_SOFTWARE='1', XDG_SESSION_TYPE='wayland')
if '--default-renderer' in sys.argv:
    env.pop('LIBGL_ALWAYS_SOFTWARE', None)
if '--mask-failure' in sys.argv:
    env['COPYOUS_TEST_MASK_FAILURE'] = '1'
extension = root / 'data/gnome-shell/extensions' / UUID
extension.mkdir(parents=True)
with zipfile.ZipFile(REPO / 'dist' / f'{UUID}.zip') as package:
    package.extractall(extension)
bundle = """const {createRequire} = require('node:module');
const esbuild = createRequire(require.resolve('tsx'))('esbuild');
esbuild.buildSync({entryPoints: [require.resolve('highlight.js/lib/common')],
                  bundle: true, format: 'esm', platform: 'browser', outfile: process.argv[1]});"""
subprocess.run(['node', '-e', bundle, str(extension / 'highlight.min.js')], cwd=REPO, check=True)
subprocess.run(['glib-compile-schemas', '--strict', str(extension / 'schemas')], check=True)
command = ['dbus-run-session', '--', 'gnome-shell', '--headless', '--wayland',
           '--virtual-monitor', '1600x900', '--no-x11', '--automation-script',
           str(REPO / 'scripts/tests/gnome-shell-smoke.mjs')]
print(f'Isolated GNOME Shell artifacts: {root}', flush=True)
process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           text=True, start_new_session=True)
try:
    log, _ = process.communicate(timeout=120)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        log, _ = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        log, _ = process.communicate()
    (root / 'shell.log').write_text(log)
    print('FAIL isolated Shell timed out', flush=True)
    sys.exit(1)
(root / 'shell.log').write_text(log)
report_path = root / 'result.json'
report = json.loads(report_path.read_text()) if report_path.exists() else {}
failures = [line for line in log.splitlines()
            if any(text in line for text in ['JS ERROR:', 'JS WARNING:', 'No object to track signals',
                                             'Gjs-CRITICAL', 'Clutter-CRITICAL', 'GLib-GObject-CRITICAL', 'COGL-WARNING', 'GLSL compilation failed', 'Copyous content mask is unavailable'])]
if '--mask-failure' in sys.argv:
    mask_warnings = [line for line in failures if 'Copyous content mask is unavailable' in line]
    if len(mask_warnings) != 1:
        failures.append('Expected exactly one content mask fallback warning')
    failures = [line for line in failures if 'Copyous content mask is unavailable' not in line]
if process.returncode != 0 or not report.get('passed') or failures:
    print(f'FAIL isolated Shell: exit={process.returncode}, report={report}', flush=True)
    print('\n'.join(failures[-20:]) or log[-6000:])
    sys.exit(1)
print(json.dumps(report, indent=2), flush=True)
print('PASS isolated GNOME Shell native rendering and clipboard lifecycle', flush=True)
