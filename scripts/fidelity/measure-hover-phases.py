#!/usr/bin/env python3
"""Sample two documented hover ROIs in every recorded frame, preserving original PTS."""

import argparse
import csv
import json
from pathlib import Path
import subprocess


def rectangle(value: str) -> tuple[int, int, int, int]:
    numbers = tuple(int(part) for part in value.split(','))
    if len(numbers) != 4 or any(part < 0 for part in numbers[:2]) or any(part <= 0 for part in numbers[2:]):
        raise argparse.ArgumentTypeError('ROI must be x,y,width,height with positive size')
    return numbers


def decoded_roi(recording: Path, roi: tuple[int, int, int, int], dimensions: tuple[int, int], count: int) -> bytes:
    x, y, width, height = roi
    if x + width > dimensions[0] or y + height > dimensions[1]:
        raise ValueError('ROI exceeds the decoded frame')
    command = ['ffmpeg', '-v', 'error', '-i', str(recording), '-map', '0:v:0',
               '-vf', f'format=gray,crop={width}:{height}:{x}:{y}', '-fps_mode', 'passthrough',
               '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']
    raw = subprocess.run(command, check=True, capture_output=True).stdout
    if len(raw) != width * height * count:
        raise RuntimeError('ROI decode count does not match the original PTS report')
    return raw


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording', type=Path)
    parser.add_argument('frame_report', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--hover-roi', required=True, type=rectangle)
    parser.add_argument('--tooltip-roi', required=True, type=rectangle)
    parser.add_argument('--foreground', type=int, default=150)
    args = parser.parse_args()
    source = json.loads(args.frame_report.read_text())
    times = [row['timestampSeconds'] for row in source['frames']]
    dimensions = (source['sourceWidth'], source['sourceHeight'])
    hover_bytes = decoded_roi(args.recording, args.hover_roi, dimensions, len(times))
    tooltip_bytes = decoded_roi(args.recording, args.tooltip_roi, dimensions, len(times))
    hover_size = args.hover_roi[2] * args.hover_roi[3]
    tooltip_size = args.tooltip_roi[2] * args.tooltip_roi[3]
    rows = []
    for index, timestamp in enumerate(times):
        hover = hover_bytes[index * hover_size:(index + 1) * hover_size]
        tooltip = tooltip_bytes[index * tooltip_size:(index + 1) * tooltip_size]
        rows.append({
            'frame': index,
            'timestampSeconds': timestamp,
            'hoverForegroundPixels': sum(value > args.foreground for value in hover),
            'tooltipMedian': sorted(tooltip)[tooltip_size // 2],
            'tooltipForegroundPixels': sum(value > 120 for value in tooltip),
        })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'recording': str(args.recording), 'hoverRoi': args.hover_roi,
                                       'tooltipRoi': args.tooltip_roi, 'foregroundThreshold': args.foreground,
                                       'frames': rows}, indent=2) + '\n')
    with args.output.with_suffix('.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({'frames': len(rows), 'json': str(args.output), 'csv': str(args.output.with_suffix('.csv'))}))


if __name__ == '__main__':
    main()
