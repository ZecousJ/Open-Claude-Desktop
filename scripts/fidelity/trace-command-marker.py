"""Reconstruct vector keyframes from separately resolved points in recorded frames.
Usage: trace-command-marker.py centers.json output.css track.json [tools|thinking]
No raster imagery is included in the application. Ambiguous merges are interpolated
and listed in the output evidence, never claimed as exact observations.
"""
import json,itertools,sys
from pathlib import Path
if len(sys.argv) not in (4,5): raise SystemExit(__doc__)
phase=sys.argv[4] if len(sys.argv)==5 else 'tools'
if phase not in ('tools','thinking'): raise SystemExit('Unknown phase')
rows=json.loads(Path(sys.argv[1]).read_text())
start,period,count=(8.015,2.565,4) if phase=='tools' else (16.2,1.86,3)
valid=[r for r in rows if start-.15<=r['t']<=start+period+.15 and len(r['centers'])==count]
prev=sorted(valid[0]['centers'],key=lambda p:(p[1],p[0])); tracks=[]
for r in valid:
 pts=min(itertools.permutations(r['centers']),key=lambda pp:sum((a[0]-b[0])**2+(a[1]-b[1])**2 for a,b in zip(prev,pp)))
 tracks.append((r['t'],pts));prev=pts

def at(t):
 for (ta,a),(tb,b) in zip(tracks,tracks[1:]):
  if ta<=t<=tb:
   u=(t-ta)/(tb-ta);return [[p[0]+(q[0]-p[0])*u,p[1]+(q[1]-p[1])*u] for p,q in zip(a,b)]
 return tracks[0 if t<tracks[0][0] else -1][1]
samples=[(0,at(start))]+[((t-start)/period*100,p) for t,p in tracks if start<t<start+period]+[(100,at(start+period))]
a=samples[0][1];z=samples[-1][1]
perm=min(itertools.permutations(range(count)),key=lambda pp:sum((z[i][0]-a[pp[i]][0])**2+(z[i][1]-a[pp[i]][1])**2 for i in range(count)))
order=list(range(count));cycles=[]
for _ in range(24):
 cycles.append(order[:]);order=[perm[j] for j in order]
 if order==list(range(count)):break
lines=[f'/* Measured {phase} trajectory from agent-lifecycle-001.mov. See fidelity/observations/agent-lifecycle.md. */']
for dot in range(count):
 lines.append(f'@keyframes {phase}-dot-{dot} {{')
 for cycle,order in enumerate(cycles):
  for k,(pct,pts) in enumerate(samples):
   if cycle and k==0:continue
   x,y=pts[order[dot]][:2]
   lines.append(f'  {(cycle*100+pct)/len(cycles):.4f}% {{ transform: translate({x-3:.3f}px, {y-4:.3f}px); }}')
 lines.append('}')
 lines.append(f'.activity-mark[data-phase="{phase}"] i:nth-child({dot+1}) {{ animation: {phase}-dot-{dot} {period*len(cycles):.3f}s linear infinite; }}')
lines.append(f'@media (prefers-reduced-motion: reduce) {{ .activity-mark[data-phase="{phase}"] i {{ animation: none !important; }} }}')
Path(sys.argv[2]).write_text('\n'.join(lines)+'\n')
uncertain=[[a[0],b[0]] for a,b in zip(tracks,tracks[1:]) if b[0]-a[0]>.07]
Path(sys.argv[3]).write_text(json.dumps({'phase':phase,'start':start,'period':period,'samples':samples,'loopPermutation':perm,'cycles':cycles,'unresolvedIntervals':uncertain},indent=2))
print(json.dumps({'phase':phase,'samples':len(samples),'largestUnresolvedInterval':max(b[0]-a[0] for a,b in zip(tracks,tracks[1:]))}))
