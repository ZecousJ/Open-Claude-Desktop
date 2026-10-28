#!/usr/bin/env python3
"""Import a verified generated distribution from the ONE canonical shared-source build."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('distribution', type=Path)
parser.add_argument('--source-revision', required=True)
parser.add_argument('--manifest-sha256', required=True)
args = parser.parse_args()
assert re.fullmatch(r'[0-9a-f]{40}', args.source_revision), 'Expected pinned Git commit'
assert re.fullmatch(r'[0-9a-f]{64}', args.manifest_sha256), 'Expected canonical manifest SHA-256'
source = args.distribution.resolve()
manifest_path = source / 'reuse-manifest.json'
manifest_bytes = manifest_path.read_bytes()
sha = lambda data: hashlib.sha256(data).hexdigest()
assert sha(manifest_bytes) == args.manifest_sha256, 'Canonical manifest hash mismatch'
manifest = json.loads(manifest_bytes)
assert manifest['version'] == manifest['protocol'] == 1 and manifest['entry'] == 'index.html'
assert manifest['sourceRevision'] == args.source_revision, 'Canonical source revision mismatch'
assets = manifest['assets']
assert 0 < len(assets) < 1024
names = set()
for row in assets:
    name = row['file']
    assert name == 'index.html' or name.startswith('assets/'), 'Unexpected asset path'
    assert '..' not in name and '\\' not in name and not name.endswith('.map')
    path = source / name
    assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(source)
    data = path.read_bytes()
    assert len(data) == row['bytes'] and sha(data) == row['sha256'], f'Asset mismatch: {name}'
    assert name not in names
    names.add(name)
assert 'index.html' in names
assert {str(p.relative_to(source)) for p in source.rglob('*') if p.is_file()} == names | {'reuse-manifest.json'}
assert sum(row['bytes'] for row in assets) <= 32 * 1024 * 1024, 'Unexpectedly large renderer bundle'
destination = root / 'app/src/main/assets/conversation'
assert not destination.is_symlink()
destination.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='conversation-import-', dir=destination.parent) as temp:
    staged = Path(temp) / 'bundle'
    staged.mkdir()
    for name in sorted(names | {'reuse-manifest.json'}):
        output = staged / name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, output)
    if destination.exists():
        shutil.rmtree(destination)
    staged.rename(destination)
lock = {'version': 1, 'protocol': 1, 'sourceRevision': args.source_revision, 'manifestSha256': args.manifest_sha256}
(root / 'shared-conversation-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(f'Imported {len(names)} canonical assets from {args.source_revision}; manifest {args.manifest_sha256}')
