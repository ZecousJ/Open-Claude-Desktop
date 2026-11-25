#!/usr/bin/env python3
"""Verify the committed shared renderer before Xcode builds; stdlib only."""
from pathlib import Path, PurePosixPath
import hashlib,json,re
ROOT=Path(__file__).resolve().parents[1]
def verify(root=ROOT):
    lock=json.loads((root/'shared-conversation-lock.json').read_text())
    assert re.fullmatch(r'[0-9a-f]{40}',lock['sourceRevision']), 'Expected exact canonical source commit'
    assert lock['protocol']==1, 'Unsupported native conversation protocol'
    bundle=root/'Claudex/Resources/SharedConversation'
    manifest_path=bundle/'reuse-manifest.json'
    manifest_bytes=manifest_path.read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest()==lock['manifestSha256'], 'Renderer manifest changed; explicitly import an approved build'
    manifest=json.loads(manifest_bytes)
    assert manifest['version']==1 and manifest['protocol']==1 and manifest['entry']=='index.html'
    assert manifest['sourceRevision']==lock['sourceRevision'], 'Renderer is not built from the locked source commit'
    expected={'reuse-manifest.json'}
    for entry in manifest['assets']:
        name=entry['file'];relative=PurePosixPath(name)
        assert not relative.is_absolute() and '..' not in relative.parts and '\\' not in name
        assert name=='index.html' or name.startswith('assets/'), f'Unexpected renderer path: {name}'
        assert name not in expected and not name.endswith('.map'), f'Duplicate/debug renderer asset: {name}'
        expected.add(name);path=bundle/name
        assert path.is_file() and not path.is_symlink(), f'Missing or linked renderer asset: {name}'
        data=path.read_bytes()
        assert len(data)==entry['bytes'] and hashlib.sha256(data).hexdigest()==entry['sha256'], f'Renderer asset changed: {name}'
    assert not any(p.is_symlink() for p in bundle.rglob('*')), 'Renderer symlink is not allowed'
    assert {p.relative_to(bundle).as_posix() for p in bundle.rglob('*') if p.is_file()}==expected, 'Unmanifested renderer file'
    return len(expected),lock['sourceRevision']
if __name__=='__main__':
    count,revision=verify()
    print(f'PASS: {count} renderer files locked to shared source {revision}')
