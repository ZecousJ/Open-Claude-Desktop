/** Source-derived mathematical specification: c9d397622-DX28hmOj:402–768.
 * Two passes: low-resolution air field, then atlas glyphs with edge lighting.
 * Uniforms and programs are owned by the local renderer, not a vendor bundle. */
const hash = `
uint randomBits(uint n) {
  uint state = n * 747796405u + 2891336453u;
  uint permuted = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (permuted >> 22u) ^ permuted;
}
float fraction(uint n) { return float(n >> 8u) / 16777216.0; }
`;
const noise = `
vec3 latticeVector(uint n) {
  uint h = randomBits(n);
  return vec3(float(h & 1023u), float((h >> 10u) & 1023u), float((h >> 20u) & 1023u)) * (2.0 / 1023.0) - 1.0;
}
float cornerNoise(ivec3 cell, vec3 delta, uint salt, bool gradient) {
  uint z = randomBits(uint(cell.z) ^ seed ^ salt);
  uint bits = uint(cell.x) ^ randomBits(uint(cell.y) ^ z);
  return gradient ? dot(latticeVector(bits), delta) : fraction(randomBits(bits)) * 2.0 - 1.0;
}
float latticeNoise(vec3 p, uint salt, bool gradient) {
  ivec3 cell = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 fade = f*f*f * (f*(f*6.0-15.0)+10.0);
  float layer[2];
  for (int z=0; z<2; ++z) {
    float line[2];
    for (int y=0; y<2; ++y) {
      float a = cornerNoise(cell+ivec3(0,y,z), f-vec3(0,y,z), salt, gradient);
      float b = cornerNoise(cell+ivec3(1,y,z), f-vec3(1,y,z), salt, gradient);
      line[y] = mix(a,b,fade.x);
    }
    layer[z] = mix(line[0],line[1],fade.y);
  }
  return mix(layer[0],layer[1],fade.z) * (gradient ? 1.5 : 1.0);
}
float valueNoise(vec3 p, uint salt) { return latticeNoise(p,salt,false); }
float gradientNoise(vec3 p, uint salt) { return latticeNoise(p,salt,true); }
`;
const taps = `
uniform float wallTime;
uniform int tapCount;
uniform vec4 taps[6];
float heartRadius(vec2 direction) {
  float h = -direction.x*direction.x*direction.y*direction.y*direction.y;
  float c = sign(h)*pow(abs(h),1.0/3.0);
  float radius=1.0;
  for(int i=0;i<6;++i) radius=sqrt(max(0.05,1.0+c*pow(radius,5.0/3.0)));
  return radius;
}
vec4 clickField(vec2 point, out vec2 glow) {
  vec4 impact=vec4(0.0);
  glow=vec2(0.0);
  for(int i=0;i<6;++i) {
    if(i>=tapCount) break;
    float age=wallTime-taps[i].z;
    vec2 away=point-taps[i].xy;
    float distance=length(away);
    float contour=taps[i].w<0.0 ? distance/heartRadius(away/max(distance,1.0)) : distance;
    float behind=620.0*(1.0-exp(-age/1.3))-contour;
    float width=85.0+60.0*age;
    float front=smoothstep(-16.0,10.0,behind)*exp(-behind*behind/(width*width));
    float swell=abs(taps[i].w)*exp(-age/1.5)*front;
    impact.xy += away/max(distance,1.0) * 44.0*swell;
    impact.z += 1.9*swell*(0.25+0.75*cos(behind*(6.2831853/130.0)));
    impact.w += swell;
    float trail=smoothstep(0.0,70.0,behind)*exp(-max(behind,0.0)/260.0);
    glow.x += abs(taps[i].w)*(exp(-age)*front+0.7*exp(-age/1.3)*trail);
    glow.y += abs(taps[i].w)*(1.0-exp(-age/0.2))*exp(-age/1.2)*trail;
  }
  return impact;
}
`;
export const airVertex = `#version 300 es
precision highp float;
precision highp int;
uniform uint seed;
uniform float time;
uniform vec4 wind;
uniform vec2 canvasCss;
out vec4 air;
${hash}
${noise}
void main(){
  vec2 corner=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  gl_Position=vec4(corner*2.0-1.0,0.0,1.0);
  air=vec4(cos(wind.x),sin(wind.x),wind.y*(time+valueNoise(vec3(time*0.09,3.7,0.0),0x58u)),0.58*(abs(cos(wind.x))*canvasCss.x+abs(sin(wind.x))*canvasCss.y));
}
`;
export const airFragment = `#version 300 es
precision highp float;
precision highp int;
uniform uint seed;
uniform float time,reveal;
uniform vec2 sampleCss,originCss,paneCss;
uniform vec4 wind,gust,shape;
uniform float tail,sweep,morph;
uniform int wakeCount;
uniform vec4 wakes[48],ways[48];
in vec4 air;
out vec4 result;
${hash}
${noise}
${taps}
float handWarmth(vec2 p){
  float sum=0.0;
  for(int i=0;i<48;++i){
    if(i>=wakeCount)break;
    vec2 offset=p-wakes[i].xy;
    offset-=ways[i].xy*clamp(dot(offset,ways[i].xy),-ways[i].z,ways[i].z);
    sum+=wakes[i].z*exp(-dot(offset,offset)*wakes[i].w);
  }
  return 1.0-exp(-1.5*sum);
}
float gustField(vec2 p,float carried){
  float gain=mix(0.38,0.62,shape.x), amplitude=1.0, sum=0.0, power=0.0;
  vec2 size=vec2(0.85,0.75)*wind.zw;
  for(int octave=0;octave<4;++octave){
    float k=float(octave);
    sum+=amplitude*gradientNoise(vec3((p.x-carried*(1.0+0.1*k))/size.x,p.y/size.y,morph*time*(0.03+0.018*k)+11.0*k),0x60u+uint(octave));
    power+=amplitude*amplitude;
    amplitude*=gain; size*=vec2(0.5,0.58);
  }
  float strand=1.0-abs(gradientNoise(vec3((p.x-1.15*carried)/(0.7*wind.z),p.y/(0.95*wind.w),morph*time*0.05+2.0),0x66u));
  float swell=cos((p.x-carried+0.5*air.w*valueNoise(vec3(time*0.045,p.y/(2.5*wind.w),7.0),0x67u))*(6.2831853/air.w));
  return sum*inversesqrt(power)+shape.w*0.5*(strand*strand*strand-0.35)+sweep*swell;
}
void main(){
  vec2 p=originCss+gl_FragCoord.xy*sampleCss;
  vec2 along=air.xy, across=vec2(-along.y,along.x);
  vec4 hand=vec4(0.0); float warmth=0.0;
  if(tapCount+wakeCount>0){
    vec2 warped=p+24.0*vec2(valueNoise(vec3(p/95.0,wallTime*0.12),0x71u),valueNoise(vec3(p/95.0+9.1,wallTime*0.12+4.0),0x72u));
    vec2 glow; hand=clickField(warped,glow); warmth=handWarmth(warped);
    hand.zw+=vec2(0.25,0.05)*warmth;
  }
  vec2 from=p-hand.xy;
  vec2 turn=vec2(valueNoise(vec3(from/gust.y,time*0.04),0x51u),valueNoise(vec3(from/gust.y+17.3,time*0.04+5.0),0x52u));
  vec2 bent=from+gust.x*turn;
  vec2 q=vec2(dot(bent,along),dot(bent,across));
  float carried=air.z;
  vec2 riding=vec2(q.x-0.85*carried,q.y);
  vec2 eddy=vec2(gradientNoise(vec3(riding/(1.15*wind.w),morph*time*0.04),0x59u),gradientNoise(vec3(riding/(1.15*wind.w)+31.7,morph*time*0.04+3.0),0x5au));
  vec2 folded=riding+shape.z*0.9*wind.w*eddy;
  vec2 fine=vec2(gradientNoise(vec3(folded/(0.38*wind.w),morph*time*0.06),0x5bu),gradientNoise(vec3(folded/(0.38*wind.w)+13.1,morph*time*0.06+7.0),0x5cu));
  vec2 creased=(folded+0.3*wind.w*fine)/24.0;
  vec2 tiny=vec2(gradientNoise(vec3(creased,time*0.07),0x5du),gradientNoise(vec3(creased+5.3,time*0.07+1.0),0x5eu));
  vec2 curled=q+shape.z*(1.0+0.9*min(hand.w,1.5))*(wind.w*(0.9*eddy+0.3*fine)+shape.x*30.0*tiny);
  vec2 direction=normalize(along+0.6*turn+hand.xy/14.0+shape.z*((0.45*eddy.x+0.25*fine.x)*along+(0.45*eddy.y+0.25*fine.y)*across));
  float still=gustField(curled,carried), field=still+hand.z;
  float level=mix(0.02,0.82,gust.z), band=mix(0.26,0.03,shape.y);
  bool blowing=field>level-band-0.55*tail;
  float strength=0.0, streak=0.0;
  if(blowing||warmth>0.0){
    float thread=valueNoise(vec3((curled.x-carried*1.6)/140.0,curled.y/30.0,time*0.16),0x57u);
    streak=1.0-smoothstep(0.0,0.5,abs(thread));
  }
  if(blowing){
    float ahead=gustField(curled+vec2(56.0,0.0),carried);
    float leaving=smoothstep(-0.05,0.07,ahead-still);
    float lit=smoothstep(level-band-0.55*tail*leaving,level+band,field);
    float broad=lit*lit*mix(0.45,1.0,clamp((field-level)/0.45,0.0,1.0))*(0.82+0.18*fine.y);
    strength=broad*mix(1.0,0.25+0.95*streak,gust.w);
  }
  if(warmth>0.0){
    float grain=0.55*fine.y+0.45*tiny.x+0.3*(streak-0.4);
    strength=1.0-(1.0-strength)*(1.0-0.85*warmth*smoothstep(-0.5,0.25,grain));
  }
  vec2 distance=(p-vec2(0.5*paneCss.x,0.45*paneCss.y))/vec2(250.0,80.0);
  float calm=1.0-0.7*exp(-0.9*dot(distance,distance));
  float shown=max(reveal,min(1.0,2.0*hand.w+warmth));
  result=vec4(strength*calm*shown,direction*0.5+0.5,calm*shown);
}
`;
export const glyphVertex = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D boxes;
uniform highp sampler2D sequence,field;
uniform ivec2 grid,cell,bufferSize;
uniform uint seed;
uniform float time;
uniform int count;
uniform vec4 cellCss;
out vec2 atlasOffset;
out vec4 atlasBounds;
out vec2 clickGlow;
const ivec2 quad[6]=ivec2[6](ivec2(0,0),ivec2(1,0),ivec2(0,1),ivec2(0,1),ivec2(1,0),ivec2(1,1));
${hash}
${taps}
void main(){
  int id=gl_VertexID/6;
  ivec2 position=ivec2(id%grid.x,id/grid.x);
  uint key=randomBits((uint(position.x)*0x9E3779B9u)^randomBits(uint(position.y)^seed));
  uint pace=randomBits(key);
  int step=int(floor(time*1.2*(0.6+0.8*fraction(pace))+fraction(randomBits(pace))));
  clickGlow=vec2(0.0);
  if(tapCount>0){
    step+=int(floor(6.0*clickField(cellCss.xy+vec2(position)*cellCss.zw,clickGlow).w+fraction(randomBits(pace^0x33u))));
    clickGlow*=0.65+0.35*fraction(randomBits(pace^0x51u));
  }
  if(clickGlow.x<0.04&&clickGlow.y<0.015){
    float strongest=0.0;
    for(int y=-1;y<=2;++y)for(int x=-1;x<=1;++x)
      strongest=max(strongest,texelFetch(field,clamp(position*ivec2(1,2)+ivec2(x,y),ivec2(0),grid*ivec2(1,2)-1),0).r);
    if(strongest==0.0){ gl_Position=vec4(2.0,2.0,0.0,1.0);atlasOffset=vec2(0.0);atlasBounds=vec4(0.0);clickGlow=vec2(0.0);return; }
  }
  int glyph=int(texelFetch(sequence,ivec2((int(key>>8u)+step)%count,0),0).r*255.0+0.5);
  uvec4 bounds=texelFetch(boxes,ivec2(glyph,0),0);
  ivec2 origin=position*cell;
  ivec2 pixel=origin+ivec2(bounds.xy)+quad[gl_VertexID-id*6]*ivec2(bounds.zw);
  ivec2 home=ivec2(glyph&15,glyph>>4)*cell;
  atlasOffset=vec2(home-origin);atlasBounds=vec4(home,home+cell-1);
  vec2 clip=vec2(pixel)/vec2(bufferSize)*2.0-1.0;
  gl_Position=vec4(clip.x,-clip.y,0.0,1.0);
}
`;
export const glyphFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 atlasOffset;
in vec4 atlasBounds;
in vec2 clickGlow;
uniform highp sampler2D atlas,field;
uniform vec3 inkColor,glowColor;
uniform ivec2 bufferSize;
uniform float inkAlpha;
out vec4 result;
float coverage(ivec2 pixel){return texelFetch(atlas,clamp(pixel,ivec2(floor(atlasBounds.xy+0.5)),ivec2(floor(atlasBounds.zw+0.5))),0).r;}
void main(){
  ivec2 pixel=ivec2(int(gl_FragCoord.x),bufferSize.y-1-int(gl_FragCoord.y));
  ivec2 glyphPixel=pixel+ivec2(floor(atlasOffset+0.5));
  float ink=coverage(glyphPixel);
  if(ink<=0.0){result=vec4(0.0);return;}
  vec4 air=texture(field,(vec2(pixel)+0.5)/vec2(bufferSize));
  vec2 edge=vec2(coverage(glyphPixel+ivec2(1,0))-coverage(glyphPixel-ivec2(1,0)),coverage(glyphPixel+ivec2(0,1))-coverage(glyphPixel-ivec2(0,1)));
  float facing=length(edge)>0.02?max(0.0,dot(normalize(edge),air.gb*2.0-1.0)):0.35;
  float light=min(1.0,air.r*mix(1.0,0.45+1.1*facing,0.6))+0.03*air.a;
  float tint=smoothstep(0.04,0.3,clickGlow.x);
  float brightness=min(1.0,light)*mix(inkAlpha,3.0,tint);
  float afterglow=0.3*clickGlow.y*air.a;
  float alpha=ink*min(1.0,(brightness+afterglow)/3.0);
  vec3 rgb=(mix(inkColor,glowColor,tint)*brightness+glowColor*afterglow)/(brightness+afterglow+0.0001);
  result=vec4(rgb*alpha,alpha);
}
`;
