#!/usr/bin/env python3
"""Generate native queue expectations from an exact canonical web commit.

Uses already-installed Node/react/tsx; no dependency installation or network.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile

source = Path(__file__).resolve().parents[1]
repo = source.parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reference', default='4e7593f7a080f10c92c94891278f9d915fc9a5b7')
parser.add_argument('--node-modules', type=Path, required=True, help='Existing node_modules with react and tsx')
args = parser.parse_args()
modules = args.node_modules.resolve()
loader = modules / 'tsx/dist/loader.mjs'
if not loader.is_file() or not (modules / 'react/package.json').is_file():
    parser.error('Use existing react/tsx dependencies; this script does not install them')
reference = subprocess.check_output(['git', 'rev-parse', '--verify', args.reference + '^{commit}'], cwd=repo, text=True).strip()
destination = Path(tempfile.mkdtemp(prefix='claudex-web-queue-', dir='/tmp'))
files = ['src/composer/queue.ts', 'shared/agent-api.ts', 'shared/bridge-methods.ts',
         'shared/composer-api.ts', 'src/app/composer-send.ts']
receipt = {'main': reference, 'sha256': {}}
for relative in files:
    data = subprocess.check_output(['git', 'show', reference + ':' + relative], cwd=repo)
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    receipt['sha256'][relative] = hashlib.sha256(data).hexdigest()
os.symlink(modules, destination / 'node_modules')
generator = destination / 'generate.ts'
shutil.copyfile(source / 'scripts/queue_vectors.ts', generator)
output = source / 'ClaudexTests/Fixtures/composer-queue.json'
output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', '--import', str(loader), str(generator), str(output)], check=True)
if len(json.loads(output.read_text())) != 10:
    raise SystemExit('Unexpected canonical vector count')
(output.parent / 'queue-reference-hashes.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'reference': reference, 'vectors': 10, 'output': str(output), 'retainedSourceCopy': str(destination)}))
