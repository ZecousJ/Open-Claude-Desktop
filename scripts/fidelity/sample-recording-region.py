#!/usr/bin/env python3
"""Sample one recorded window region on every decoded frame, preserving source PTS."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('recording', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--roi', nargs=4, type=int, required=True, metavar=('X', 'Y', 'WIDTH', 'HEIGHT'))
args = parser.parse_args()
source = args.recording.resolve(strict=True)
probe = json.loads(subprocess.run([
    'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames',
    '-show_entries', 'stream=width,height:frame=best_effort_timestamp_time', '-of', 'json', str(source),
], check=True, capture_output=True, text=True).stdout)
stream = probe['streams'][0]
x, y, width, height = args.roi
if min(x, y) < 0 or min(width, height) < 1 or x + width > stream['width'] or y + height > stream['height']:
    parser.error('ROI must be a non-empty region contained in the source video.')
# Convert before cropping so odd-coordinate/small regions are not rounded to chroma blocks.
command = [
    'ffmpeg', '-v', 'error', '-i', str(source), '-map', '0:v:0',
    '-vf', f'format=rgb24,crop={width}:{height}:{x}:{y},scale=1:1:flags=area',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
]
result = subprocess.run(command, check=True, capture_output=True)
if len(result.stdout) % 3:
    raise RuntimeError('Incomplete RGB frame returned by decoder.')
timestamps = probe['frames']
count = len(result.stdout) // 3
if count != len(timestamps):
    raise RuntimeError(f'Decoded {count} frames but found {len(timestamps)} source timestamps; no report written.')
frames = [{'index': i, 'timestampSeconds': float(timestamps[i]['best_effort_timestamp_time']),
           'rgb': list(result.stdout[i * 3:i * 3 + 3])} for i in range(count)]
hasher = hashlib.sha256()
with source.open('rb') as source_file:
    for chunk in iter(lambda: source_file.read(1024 * 1024), b''):
        hasher.update(chunk)
digest = hasher.hexdigest()
report = {
    'source': str(source), 'sha256': digest, 'sourceWidth': stream['width'], 'sourceHeight': stream['height'],
    'roi': {'x': x, 'y': y, 'width': width, 'height': height}, 'frameCount': count,
    'method': 'RGB24 conversion, exact ROI crop, FFmpeg area average to one RGB pixel; original frame PTS.',
    'limits': 'Colors include recording compression and integer rounding. This measures recorded pixels, not CSS values, event latency or unsampled sub-frame behavior.',
    'frames': frames,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + '\n')
with args.output.with_suffix('.csv').open('w', newline='') as output_csv:
    writer = csv.writer(output_csv)
    writer.writerow(['index', 'timestamp_seconds', 'red', 'green', 'blue'])
    writer.writerows([f['index'], f['timestampSeconds'], *f['rgb']] for f in frames)
print(json.dumps({'frameCount': count, 'roi': report['roi'], 'report': str(args.output.resolve())}))
