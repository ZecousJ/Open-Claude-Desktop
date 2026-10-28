#!/usr/bin/env python3
"""Pinned source mapping, not runtime availability or live/native acceptance."""
from pathlib import Path
import json,re
root=Path(__file__).resolve().parents[1]
contract=json.loads((root/'docs/web-route-contract.json').read_text())
source=(root/'Claudex/Core/AccountFeatures.swift').read_text()
rpc=set(re.findall(r'rpc\.call\("([A-Za-z]+)"',source))
allowed=set(contract['account_features_remote_runner'])
assert rpc <= allowed, f'Not classified as runner RPC: {rpc-allowed}'
for method,endpoints in contract['browser_owned_native_equivalents'].items():
 assert method not in rpc, f'{method} is browser-owned and needs native HTTP'
 for endpoint in endpoints:
  method,path=endpoint.split(' ',1)
  assert 'requestBound("'+path.lstrip('/')+'"' in source, endpoint
  assert '"'+path.lstrip('/')+'"' in (root/'Claudex/Core/DirectServiceClient.swift').read_text(), endpoint
print('PASS: account-feature RPC/native HTTP mapping matches pinned web classifications')
