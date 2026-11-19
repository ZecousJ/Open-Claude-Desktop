"""Compare unlabeled animated marker centroids from two decoded videos.

Both inputs come from extract-marker-centers.py and retain source frame PTS.
Translation is removed per frame; phase and uniform scale are searched. Missing
or merged dots are skipped rather than synthesized.
"""
import argparse
import bisect
import hashlib
import itertools
import json
import math
import statistics
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('reference', type=Path)
parser.add_argument('local', type=Path)
parser.add_argument('--reference-start', type=float, required=True)
parser.add_argument('--local-start', type=float, required=True)
parser.add_argument('--local-end', type=float, required=True)
parser.add_argument('--period', type=float, required=True)
parser.add_argument('--dots', type=int, default=4)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
if args.period <= 0 or args.dots not in (3, 4) or args.local_end <= args.local_start:
    raise SystemExit('Invalid period, dot count or local range')


def load(path, start, end):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line] if path.suffix == '.jsonl' else json.loads(path.read_text())
    return [row for row in rows if start <= row['t'] <= end and len(row['centers']) == args.dots]


def centered(row):
    points = row['centers']
    mx = sum(point[0] for point in points) / len(points)
    my = sum(point[1] for point in points) / len(points)
    return [(point[0] - mx, point[1] - my) for point in points]


permutations = list(itertools.permutations(range(args.dots)))


def shape_error(left, right, scale=1.0):
    return min(
        sum((left[i][0] * scale - right[j][0]) ** 2 +
            (left[i][1] * scale - right[j][1]) ** 2
            for i, j in enumerate(order)) / args.dots
        for order in permutations
    )


def recurrence(rows, low=0.5, high=3.0, step=0.025):
    times = [row['t'] for row in rows]
    shapes = [centered(row) for row in rows]
    result = []
    for index in range(round(low / step), round(high / step) + 1):
        lag = index * step
        errors = []
        for time, shape in zip(times, shapes):
            position = bisect.bisect_left(times, time + lag)
            choices = [j for j in (position - 1, position) if 0 <= j < len(times)]
            if not choices:
                continue
            nearest = min(choices, key=lambda j: abs(times[j] - (time + lag)))
            if abs(times[nearest] - (time + lag)) <= 0.035:
                errors.append(shape_error(shape, shapes[nearest]))
        if len(errors) > 25:
            result.append({'lagSeconds': round(lag, 3), 'meanSquaredCenterError': round(sum(errors) / len(errors), 6), 'framePairs': len(errors)})
    return sorted(result, key=lambda item: item['meanSquaredCenterError'])[:8]


reference = load(args.reference, args.reference_start, args.reference_start + args.period)
local = load(args.local, args.local_start, args.local_end)
if not reference or not local:
    raise SystemExit('No frames have the required number of separately resolved dots')
phases = [row['t'] - args.reference_start for row in reference]
reference_shapes = [centered(row) for row in reference]
local_shapes = [centered(row) for row in local]
results = []
for shift_index in range(round(args.period / 0.025) + 1):
    shift = shift_index * 0.025
    for scale_index in range(17):
        scale = 0.8 + scale_index * 0.025
        errors = []
        for row, shape in zip(local, local_shapes):
            phase = (row['t'] - shift) % args.period
            position = bisect.bisect_left(phases, phase)
            choices = [j for j in (position - 1, position) if 0 <= j < len(phases)]
            if not choices:
                continue
            nearest = min(choices, key=lambda j: abs(phases[j] - phase))
            if abs(phases[nearest] - phase) <= 0.04:
                errors.append(shape_error(reference_shapes[nearest], shape, scale))
        if len(errors) > 90:
            mean = sum(errors) / len(errors)
            results.append((mean, shift, scale, len(errors)))
if not results:
    raise SystemExit('Too few corresponding frames to compare motion')
mean, shift, scale, compared = min(results)
report = {
    'reference': str(args.reference),
    'referenceSha256': hashlib.sha256(args.reference.read_bytes()).hexdigest(),
    'local': str(args.local),
    'localSha256': hashlib.sha256(args.local.read_bytes()).hexdigest(),
    'sourcePeriodSeconds': args.period,
    'referenceCycleStartSeconds': args.reference_start,
    'localRangeSeconds': [args.local_start, args.local_end],
    'referenceResolvedFrames': len(reference),
    'localResolvedFrames': len(local),
    'referenceMedianThresholdedComponentPixels': statistics.median(point[2] for row in reference for point in row['centers']),
    'localMedianThresholdedComponentPixels': statistics.median(point[2] for row in local for point in row['centers']),
    'matchedFrames': compared,
    'matchedLocalFraction': round(compared / len(local), 6),
    'largestReferenceResolvedFrameGapSeconds': round(max((b['t'] - a['t'] for a, b in zip(reference, reference[1:])), default=0), 6),
    'bestPhaseOffsetSeconds': round(shift, 3),
    'bestSpatialScale': round(scale, 3),
    'meanSquaredCenterErrorPixels': round(mean, 6),
    'rmsCenterErrorPixels': round(math.sqrt(mean), 6),
    'referenceRecurrence': recurrence(load(args.reference, args.reference_start, args.reference_start + 5.5)),
    'localRecurrence': recurrence(local),
    'limits': 'Only separately resolved centroids are compared. Thresholded component area differs but is confounded by the unnormalized reference zoom and video color pipeline. Opacity, interpolation in merged intervals, and zoom-normalized rendering are not established.',
}
payload = json.dumps(report, indent=2) + '\n'
if args.output:
    args.output.write_text(payload)
else:
    print(payload, end='')
