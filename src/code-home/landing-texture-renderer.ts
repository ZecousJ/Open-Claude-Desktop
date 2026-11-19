import {
  airVertex,
  airFragment,
  glyphVertex,
  glyphFragment,
} from "./landing-texture-shaders";
import {
  glyphAlphabet,
  glyphLooks,
  windForSeed,
  type TextureGrid,
  type TextureLook,
  type TextureTouchFrame,
} from "./landing-texture-model";

/** GPU atlas + one sample per half-cell. Reference: c9d397622-DX28hmOj:80–161,769–979. */
export async function createTextureRenderer(
  host: HTMLElement,
  seed: number,
  look: TextureLook,
  aborted: () => boolean,
) {
  const doc = host.ownerDocument;
  const canvas = doc.createElement("canvas");
  canvas.className = "code-texture-canvas";
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) return null;
  const programs: WebGLProgram[] = [],
    textures: WebGLTexture[] = [];
  let framebuffer: WebGLFramebuffer | null = null,
    fence: WebGLSync | null = null;
  const dispose = () => {
    if (fence) gl.deleteSync(fence);
    for (const p of programs) gl.deleteProgram(p);
    for (const t of textures) gl.deleteTexture(t);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  };
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (
      info &&
      /swiftshader|llvmpipe|softpipe|software|warp|basic render/i.test(
        String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
      )
    ) {
      dispose();
      return null;
    }
    const compile = (vertex: string, fragment: string) => {
      const program = gl.createProgram();
      if (!program) throw Error("Texture program unavailable");
      programs.push(program);
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw Error("Texture shader unavailable");
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(program);
      return program;
    };
    const air = compile(airVertex, airFragment),
      glyphs = compile(glyphVertex, glyphFragment);
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    if (parallel) {
      const deadline = performance.now() + 20000;
      while (
        programs.some(
          (p) => !gl.getProgramParameter(p, parallel.COMPLETION_STATUS_KHR),
        )
      ) {
        if (aborted() || performance.now() > deadline) {
          dispose();
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (aborted()) {
      dispose();
      return null;
    }
    for (const p of programs)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw Error(gl.getProgramInfoLog(p) ?? "Texture link failed");
    const uniform = (program: WebGLProgram, name: string) =>
      gl.getUniformLocation(program, name);
    const airU = Object.fromEntries(
      [
        "seed",
        "wind",
        "gust",
        "shape",
        "tail",
        "sweep",
        "morph",
        "time",
        "reveal",
        "sampleCss",
        "originCss",
        "paneCss",
        "canvasCss",
        "wallTime",
        "tapCount",
        "wakeCount",
        "taps",
        "wakes",
        "ways",
      ].map((k) => [k, uniform(air, k)]),
    );
    const glyphU = Object.fromEntries(
      [
        "seed",
        "field",
        "atlas",
        "boxes",
        "sequence",
        "cellCss",
        "grid",
        "cell",
        "bufferSize",
        "count",
        "time",
        "inkColor",
        "inkAlpha",
        "glowColor",
        "wallTime",
        "tapCount",
        "taps",
      ].map((k) => [k, uniform(glyphs, k)]),
    );
    const texture = (slot: number, smooth = false) => {
      const t = gl.createTexture();
      if (!t) throw Error("Texture allocation failed");
      textures.push(t);
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        smooth ? gl.LINEAR : gl.NEAREST,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        smooth ? gl.LINEAR : gl.NEAREST,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const fieldTexture = texture(0, true);
    texture(1);
    texture(2);
    texture(3);
    framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw Error("Texture framebuffer unavailable");
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const upload = (
      slot: number,
      format: "r8" | "rgba" | "integer",
      width: number,
      height: number,
      data: Uint8Array | null,
    ) => {
      gl.activeTexture(gl.TEXTURE0 + slot);
      const internal =
        format === "r8" ? gl.R8 : format === "rgba" ? gl.RGBA8 : gl.RGBA8UI;
      const external =
        format === "r8"
          ? gl.RED
          : format === "rgba"
            ? gl.RGBA
            : gl.RGBA_INTEGER;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internal,
        width,
        height,
        0,
        external,
        gl.UNSIGNED_BYTE,
        data,
      );
    };
    const wind = windForSeed(seed);
    gl.useProgram(air);
    gl.uniform1ui(airU.seed, seed);
    gl.uniform4f(airU.wind, wind.heading, wind.speed, wind.length, wind.width);
    gl.uniform4f(airU.gust, wind.bend, wind.bendScale, 0.5, 0.4);
    gl.uniform4f(airU.shape, 0.6, 0.75, 0.65, 0.5);
    gl.uniform1f(airU.tail, 0.35);
    gl.uniform1f(airU.sweep, 0.3);
    gl.uniform1f(airU.morph, 3);
    gl.useProgram(glyphs);
    gl.uniform1ui(glyphU.seed, seed);
    gl.uniform1i(glyphU.field, 0);
    gl.uniform1i(glyphU.atlas, 1);
    gl.uniform1i(glyphU.boxes, 2);
    gl.uniform1i(glyphU.sequence, 3);
    let columns = 0,
      rows = 0,
      cellWidth = 0,
      frames = 0,
      late = 0;
    const family = getComputedStyle(host).fontFamily;
    const buildAtlas = (grid: TextureGrid) => {
      const { cellWidth: cw, cellHeight: ch, scale } = grid;
      const atlas = doc.createElement("canvas");
      atlas.width = 16 * cw;
      atlas.height = 6 * ch;
      const ctx = atlas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      const weight = scale >= 1.5 ? 300 : 400;
      ctx.font = `${weight} 100px ${family}`;
      const ratio = ctx.measureText("0").width / 100 || 0.6;
      const size = Math.min(
        Math.round(9 * scale),
        Math.floor((cw - 2) / ratio),
      );
      ctx.font = `${weight} ${size}px ${family}`;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "white";
      const metrics = ctx.measureText("Mg|");
      const baseline = Math.round(
        (ch -
          (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) /
          2 +
          metrics.fontBoundingBoxAscent,
      );
      const advance = ctx.measureText("0").width,
        inset = Math.floor((cw - advance) / 2);
      const missing = new Set<number>();
      [...glyphAlphabet].forEach((character, index) => {
        if (Math.abs(ctx.measureText(character).width - advance) > 0.5) {
          missing.add(index);
          return;
        }
        const x = (index % 16) * cw,
          y = Math.floor(index / 16) * ch;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cw, ch);
        ctx.clip();
        ctx.fillText(character, x + inset, y + baseline);
        ctx.restore();
      });
      const rgba = ctx.getImageData(0, 0, atlas.width, atlas.height).data;
      const coverage = new Uint8Array(atlas.width * atlas.height);
      for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4 + 3];
      const bounds = new Uint8Array(96 * 4);
      for (let index = 0; index < 96; index++) {
        const x = (index % 16) * cw,
          y = Math.floor(index / 16) * ch;
        let left = cw,
          top = ch,
          right = -1,
          bottom = -1;
        for (let row = 0; row < ch; row++)
          for (let col = 0; col < cw; col++)
            if (coverage[(y + row) * atlas.width + x + col] >= 8) {
              left = Math.min(left, col);
              top = Math.min(top, row);
              right = Math.max(right, col);
              bottom = Math.max(bottom, row);
            }
        if (right >= 0)
          bounds.set(
            [left, top, right - left + 1, bottom - top + 1],
            index * 4,
          );
      }
      let sequence = [...glyphLooks[look]]
        .map((c) => glyphAlphabet.indexOf(c))
        .filter((i) => i > 0 && !missing.has(i));
      if (!sequence.length) sequence = [glyphAlphabet.indexOf(".")];
      upload(1, "r8", atlas.width, atlas.height, coverage);
      upload(2, "integer", 96, 1, bounds);
      upload(3, "r8", sequence.length, 1, Uint8Array.from(sequence));
      gl.useProgram(glyphs);
      gl.uniform1i(glyphU.count, sequence.length);
      cellWidth = cw;
      return true;
    };
    const touchUniforms = (
      program: WebGLProgram,
      locations: Record<string, WebGLUniformLocation | null>,
      touch?: TextureTouchFrame,
    ) => {
      gl.useProgram(program);
      gl.uniform1i(locations.tapCount, touch?.tapCount ?? 0);
      if (locations.wakeCount)
        gl.uniform1i(locations.wakeCount, touch?.wakeCount ?? 0);
      if (!touch) return;
      gl.uniform1f(locations.wallTime, touch.now);
      if (touch.tapCount) gl.uniform4fv(locations.taps, touch.taps);
      if (touch.wakeCount && locations.wakes) {
        gl.uniform4fv(locations.wakes, touch.wakes);
        gl.uniform4fv(locations.ways, touch.ways);
      }
    };
    host.append(canvas);
    return {
      canvas,
      resize(grid: TextureGrid, pane: [number, number]) {
        if (grid.cellWidth !== cellWidth && !buildAtlas(grid)) return false;
        const width = grid.columns * grid.cellWidth,
          height = grid.rows * grid.cellHeight;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        Object.assign(canvas.style, {
          left: `${grid.left / grid.scale}px`,
          top: `${grid.top / grid.scale}px`,
          width: `${width / grid.scale}px`,
          height: `${height / grid.scale}px`,
        });
        if (grid.columns !== columns || grid.rows !== rows) {
          columns = grid.columns;
          rows = grid.rows;
          upload(0, "rgba", columns, rows * 2, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            fieldTexture,
            0,
          );
          if (
            gl.checkFramebufferStatus(gl.FRAMEBUFFER) !==
            gl.FRAMEBUFFER_COMPLETE
          )
            return false;
        }
        gl.useProgram(air);
        gl.uniform2f(
          airU.sampleCss,
          grid.cellWidth / grid.scale,
          grid.cellHeight / grid.scale / 2,
        );
        gl.uniform2f(
          airU.originCss,
          grid.left / grid.scale,
          grid.top / grid.scale,
        );
        gl.uniform2f(airU.paneCss, ...pane);
        gl.uniform2f(airU.canvasCss, width / grid.scale, height / grid.scale);
        gl.useProgram(glyphs);
        gl.uniform2i(glyphU.grid, columns, rows);
        gl.uniform2i(glyphU.cell, grid.cellWidth, grid.cellHeight);
        gl.uniform2i(glyphU.bufferSize, width, height);
        gl.uniform4f(
          glyphU.cellCss,
          (grid.left + grid.cellWidth / 2) / grid.scale,
          (grid.top + grid.cellHeight / 2) / grid.scale,
          grid.cellWidth / grid.scale,
          grid.cellHeight / grid.scale,
        );
        return true;
      },
      setInk(rgb: readonly number[], alpha = 1) {
        gl.useProgram(glyphs);
        gl.uniform3f(glyphU.inkColor, rgb[0], rgb[1], rgb[2]);
        gl.uniform1f(glyphU.inkAlpha, alpha);
      },
      setGlow(rgb: readonly number[]) {
        gl.useProgram(glyphs);
        gl.uniform3f(glyphU.glowColor, rgb[0], rgb[1], rgb[2]);
      },
      draw({
        time,
        reveal,
        touch,
      }: {
        time: number;
        reveal: number;
        touch?: TextureTouchFrame;
      }) {
        if (!columns || !rows) return;
        if (fence) {
          late =
            gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED
              ? 0
              : late + 1;
          gl.deleteSync(fence);
          fence = null;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, columns, rows * 2);
        touchUniforms(air, airU, touch);
        gl.uniform1f(airU.time, time);
        gl.uniform1f(airU.reveal, reveal);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        touchUniforms(glyphs, glyphU, touch);
        gl.uniform1f(glyphU.time, time);
        gl.drawArrays(gl.TRIANGLES, 0, columns * rows * 6);
        if (++frames % 4 === 0) {
          fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          gl.flush();
        }
      },
      fellBehind() {
        if (late < 2) return false;
        late = 0;
        return true;
      },
      destroy: dispose,
    };
  } catch (error) {
    console.warn("Code landing texture unavailable", error);
    dispose();
    return null;
  }
}
export type TextureRenderer = NonNullable<
  Awaited<ReturnType<typeof createTextureRenderer>>
>;
