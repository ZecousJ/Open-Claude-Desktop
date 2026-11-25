#!/usr/bin/env python3
"""Run the prepared synthetic host on an explicitly chosen dedicated simulator.

No runtime installation, erase, credentials, live network or provider calls.
Results are retained on failure; only the chosen shutdown device is booted.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prepared-host', type=Path, required=True)
parser.add_argument('--derived-data', type=Path, required=True)
parser.add_argument('--device', required=True, help='Dedicated synthetic-test simulator UDID')
parser.add_argument('--evidence', type=Path, required=True, help='New output directory')
parser.add_argument('--test', action='append', help='ConversationUXUITests[/method]; defaults to all cases')
args = parser.parse_args()
manifest = json.loads((args.prepared_host / 'synthetic-ui-source-manifest.json').read_text())
identifiers = args.test or ['ConversationUXUITests']
if any(not value.startswith('ConversationUXUITests') for value in identifiers):
    parser.error('Only the synthetic ConversationUXUITests suite is allowed')
products = args.derived_data / 'Build/Products'
sources = list(products.glob('Claudex_iphonesimulator*.xctestrun'))
if len(sources) != 1:
    parser.error('Expected exactly one generated simulator xctestrun; build the prepared host first')
configuration = plistlib.loads(sources[0].read_bytes())
def test_target(name):
    return configuration.get(name) or next(
    t for c in configuration['TestConfigurations'] for t in c['TestTargets']
    if t['BlueprintName'] == name)
target = test_target('ClaudexUITests')
target.update(OnlyTestIdentifiers=identifiers, UserAttachmentLifetime='keepAlways',
              SystemAttachmentLifetime='keepAlways', TestTimeoutsEnabled=True,
              DefaultTestExecutionTimeAllowance=120, MaximumTestExecutionTimeAllowance=120)
def resolve_testroot(value):
    if isinstance(value, str):
        return value.replace('__TESTROOT__', str(products.resolve()))
    if isinstance(value, dict):
        return {key: resolve_testroot(item) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_testroot(item) for item in value]
    return value
target = resolve_testroot(target)
targets = {'ClaudexUITests': target}
devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '--json'], timeout=30))
chosen = next(d for group in devices['devices'].values() for d in group if d['udid'] == args.device)
if chosen['state'] != 'Shutdown' or not chosen.get('isAvailable'):
    parser.error('Selected device must be available and shutdown; leave an in-use device untouched')
args.evidence.mkdir(parents=True, exist_ok=False)
run_file = args.evidence.resolve() / 'synthetic-ui.xctestrun'
run_file.write_bytes(plistlib.dumps({**targets, '__xctestrun_metadata__': {'FormatVersion': 1}}))
receipt = {'device': chosen, 'sourceManifest': manifest, 'only': identifiers,
           'phases': []}

def run(name, command, deadline):
    record = {'name': name, 'command': command, 'startedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with (args.evidence / (name + '.log')).open('w') as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            record['returncode'] = process.wait(timeout=deadline)
        except subprocess.TimeoutExpired:
            record['timedOut'] = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                record['returncode'] = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                record['returncode'] = process.wait()
    record['finishedAtUTC'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    receipt['phases'].append(record)
    (args.evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(name, record['returncode'], flush=True)
    return record['returncode'] == 0

booted = False
passed = False
try:
    booted = run('boot', ['xcrun', 'simctl', 'boot', args.device], 45)
    if booted and run('bootstatus', ['xcrun', 'simctl', 'bootstatus', args.device, '-b'], 180):
        passed = run('tests', ['xcodebuild', 'test-without-building', '-xctestrun', str(run_file),
                    '-destination', 'platform=iOS Simulator,id=' + args.device,
                    '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1',
                    '-resultBundlePath', str(args.evidence.resolve() / 'tests.xcresult')], 600)
finally:
    if booted:
        run('shutdown', ['xcrun', 'simctl', 'shutdown', args.device], 30)
raise SystemExit(0 if passed else 1)
