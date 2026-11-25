#!/usr/bin/env python3
"""Copy an already built shared web/PC transcript bundle byte-for-byte.

The source remains the web repository. Never patch CSS/JS in iOS Resources.
Usage: python3 scripts/sync_shared_conversation.py /path/to/dist-mobile-conversation SOURCE_COMMIT MANIFEST_SHA256
"""
from pathlib import Path
import argparse, hashlib, json, shutil
root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('bundle', type=Path)
parser.add_argument('source_commit')
parser.add_argument('manifest_sha256')
args = parser.parse_args()
source = args.bundle.resolve()
assert (source/'index.html').is_file() and (source/'assets').is_dir(), 'Build the shared conversation bundle first'
manifest_bytes=(source/'reuse-manifest.json').read_bytes()
assert hashlib.sha256(manifest_bytes).hexdigest()==args.manifest_sha256, 'Wrong canonical build manifest'
manifest=json.loads(manifest_bytes)
assert manifest['sourceRevision']==args.source_commit and manifest['protocol']==1, 'Wrong source revision or protocol'
files = sorted(p for p in source.rglob('*') if p.is_file())
assert files and not any(p.is_symlink() for p in source.rglob('*')), 'Symlink bundle entries are not allowed'
html = (source/'index.html').read_text()
assert 'Content-Security-Policy' in html and "connect-src 'none'" in html and "frame-src 'none'" in html
assert any(p.suffix == '.css' for p in files) and any(p.suffix == '.js' for p in files)
destination = root/'Claudex/Resources/SharedConversation'
if destination.exists(): shutil.rmtree(destination)
shutil.copytree(source, destination)
records = [{'path':p.relative_to(source).as_posix(), 'bytes':p.stat().st_size, 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
for record in records:
    p = destination/record['path']
    assert hashlib.sha256(p.read_bytes()).hexdigest() == record['sha256']
(root/'docs/shared-conversation-bundle.json').write_text(json.dumps({'format':1,'source':'web/PC dist-mobile-conversation (same component sources and CSS)','files':records}, indent=2)+'\n')
(root/'shared-conversation-lock.json').write_text(json.dumps({'sourceRevision':args.source_commit,'protocol':1,'manifestSha256':args.manifest_sha256},indent=2)+'\n')
from verify_shared_conversation_bundle import verify
verify(root)
print(f'Copied and SHA256-verified {len(records)} shared bundle files without modification')
