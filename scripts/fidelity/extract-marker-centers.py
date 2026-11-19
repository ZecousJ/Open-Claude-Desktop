import argparse,subprocess,json
from pathlib import Path
parser=argparse.ArgumentParser(description='Track orange marker components in every source-timestamped video frame.')
parser.add_argument('recording',type=Path)
parser.add_argument('output',type=Path)
parser.add_argument('--crop',default='24:24:442:357',help='FFmpeg crop width:height:x:y; defaults to the original reference marker ROI')
parser.add_argument('--start',type=float,default=6)
parser.add_argument('--end',type=float,default=20)
parser.add_argument('--jsonl',action='store_true',help='Write one compact JSON object per frame instead of a pretty JSON array')
args=parser.parse_args()
parts=[int(value) for value in args.crop.split(':')]
if len(parts)!=4 or any(value<0 for value in parts) or parts[0]<1 or parts[1]<1 or args.end<=args.start:raise SystemExit('Invalid crop or time range')
width,height,x0,y0=parts
p=args.recording
pts=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(p)]))['frames']
raw=subprocess.check_output(['ffmpeg','-v','fatal','-i',str(p),'-vf',f'crop={args.crop}','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
frame_bytes=width*height*3
assert len(raw) == len(pts) * frame_bytes, 'Decoded frame count must match original timestamps'
rows=[]
for i,t in enumerate(pts):
 ts=float(t['best_effort_timestamp_time'])
 if not args.start<=ts<=args.end:continue
 b=raw[i*frame_bytes:(i+1)*frame_bytes]; pixels={(j%width,j//width):b[j*3] for j in range(width*height) if b[j*3]>70 and b[j*3]-b[j*3+1]>20 and b[j*3+1]-b[j*3+2]>7}
 comps=[]
 while pixels:
  start=next(iter(pixels)); stack=[start]; group=[]
  while stack:
   xy=stack.pop()
   if xy not in pixels:continue
   w=pixels.pop(xy);group.append((*xy,w))
   x,y=xy
   stack.extend([(x-1,y),(x+1,y),(x,y-1),(x,y+1)])
  if len(group)>=2:
   weight=sum(v[2] for v in group);comps.append([round(sum(v[0]*v[2] for v in group)/weight,3),round(sum(v[1]*v[2] for v in group)/weight,3),len(group)])
 rows.append({'frame':i,'t':ts,'centers':comps})
args.output.write_text(('\n'.join(json.dumps(row,separators=(',',':')) for row in rows)+'\n') if args.jsonl else json.dumps(rows,indent=2))
print(json.dumps({'analyzedFrames':len(pts),'trackedFrames':len(rows),'roi':[x0,y0,width,height],'rangeSeconds':[args.start,args.end]}))
