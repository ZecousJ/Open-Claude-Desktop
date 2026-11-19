/** Native overlay (desktop 2.37337.1, index.chunk-BWk6pVUt.js). */
export function teachHtml(
  translate: (text: string) => string = (text) => text,
) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Teaching</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
      width: 100%; height: 100%;
      overflow: hidden;
      background: transparent;
      user-select: none; -webkit-user-select: none;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      -webkit-app-region: no-drag;
      font-family: "Anthropic Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .tooltip {
      position: absolute;
      min-width: 280px;
      max-width: 420px;
      border-radius: 16px;
      padding: 18px 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);

      background: linear-gradient(
        to bottom,
        rgba(255, 255, 255, 1),
        rgba(245, 245, 250, 0.95)
      );

      opacity: 0;
      transform: scale(0.94);
      transform-origin: var(--arrow-origin, center center);
      transition:
        opacity 300ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 300ms cubic-bezier(0.16, 1, 0.3, 1),
        left 300ms cubic-bezier(0.16, 1, 0.3, 1),
        top 300ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .tooltip.visible { opacity: 1; transform: scale(1); }

    .darkTheme .tooltip {
      background: linear-gradient(
        to bottom,
        rgba(64, 63, 62, 0.95),
        rgba(41, 37, 35, 1)
      );
    }

    .tooltip::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 17px;
      pointer-events: none;
      border: 0.5px solid rgba(0, 0, 0, 0.2);
    }
    .darkTheme .tooltip::before {
      border: 0.5px solid rgba(255, 255, 255, 0.2);
    }

    .arrow {
      position: absolute;
      width: 0; height: 0;
      border: 10px solid transparent;
      filter:
        drop-shadow(0 0 1px rgba(0, 0, 0, 0.4))
        drop-shadow(0 2px 4px rgba(0, 0, 0, 0.15));
    }
    .darkTheme .arrow {
      filter:
        drop-shadow(0 0 1px rgba(255, 255, 255, 0.25))
        drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
    }
    .arrow-none { display: none; }

    .arrow-top {
      top: -10px; left: var(--arrow-offset, 50%);
      transform: translateX(-50%);
      border-top: none;
      border-bottom-color: rgba(255, 255, 255, 1);
    }
    .darkTheme .arrow-top { border-bottom-color: rgba(64, 63, 62, 0.95); }

    .arrow-bottom {
      bottom: -10px; left: var(--arrow-offset, 50%);
      transform: translateX(-50%);
      border-bottom: none;
      border-top-color: rgba(245, 245, 250, 0.95);
    }
    .darkTheme .arrow-bottom { border-top-color: rgba(41, 37, 35, 1); }

    .arrow-left {
      left: -10px; top: var(--arrow-offset, 50%);
      transform: translateY(-50%);
      border-left: none;
      border-right-color: rgba(255, 255, 255, 1);
    }
    .darkTheme .arrow-left { border-right-color: rgba(64, 63, 62, 0.95); }

    .arrow-right {
      right: -10px; top: var(--arrow-offset, 50%);
      transform: translateY(-50%);
      border-right: none;
      border-left-color: rgba(255, 255, 255, 1);
    }
    .darkTheme .arrow-right { border-left-color: rgba(64, 63, 62, 0.95); }

    .step { display: flex; flex-direction: column; gap: 10px; }

    .logo-row { display: flex; align-items: center; gap: 8px; }
    .logo { width: 18px; height: 18px; flex-shrink: 0; }

    .explanation {
      font-size: 14px; line-height: 1.5;
      color: #29261b;
      white-space: pre-wrap;      
      word-wrap: break-word;
    }
    .darkTheme .explanation { color: #f5f4ef; }

    .next-preview {
      font-size: 12px; line-height: 1.4;
      color: #656358;
      border-top: 0.5px solid rgba(0, 0, 0, 0.1);
      margin-top: 2px;
      padding-top: 8px;
    }

    .next-preview:empty { display: none; }
    .darkTheme .next-preview {
      color: #b8b5a9;
      border-top-color: rgba(255, 255, 255, 0.1);
    }

    .buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 4px;
    }

    .btn {
      -webkit-app-region: no-drag;
      height: 32px;
      padding: 0 16px;
      border-radius: 8px;
      font-size: 13px;
      font-family: inherit;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 75ms ease-in-out, border-color 75ms ease-in-out;
    }
    .btn-secondary {
      background: transparent;
      border: 0.5px solid rgba(0, 0, 0, 0.15);
      color: #3d3929;
    }
    .darkTheme .btn-secondary {
      border-color: rgba(255, 255, 255, 0.15);
      color: #e5e5e2;
    }
    .btn-secondary:hover {
      background: rgba(0, 0, 0, 0.05);
      border-color: rgba(0, 0, 0, 0.25);
    }
    .darkTheme .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.25);
    }
    .btn-primary {
      background: #D97757;        
      color: #fff;
    }
    .btn-primary:hover { background: #c86a4a; }
    .btn-primary:active { background: #b75e40; }
    .btn:disabled { opacity: 0.5; cursor: default; }

    .working {
      display: none;            
      align-items: center;
      gap: 10px;
    }
    .tooltip.is-working .step { display: none; }
    .tooltip.is-working .working { display: flex; }

    .spinner {
      width: 18px; height: 18px;
      animation: spin 0.8s linear infinite;
      color: #656358;
      flex-shrink: 0;
    }
    .darkTheme .spinner { color: #b8b5a9; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .working-label {
      flex: 1;
      font-size: 14px;
      color: #656358;
    }
    .darkTheme .working-label { color: #b8b5a9; }
  </style>
</head>
<body>
  <div class="tooltip" id="tooltip">
    <div class="arrow arrow-none" id="arrow"></div>

    <div class="step">
      <div class="logo-row">
        <svg class="logo" viewBox="0 0 248 248" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" fill="#D97757" />
        </svg>
      </div>
      <div class="explanation" id="explanation"></div>
      <div class="next-preview" id="next-preview"></div>
      <div class="buttons">
        <button class="btn btn-secondary" id="exit-btn">Exit</button>
        <button class="btn btn-primary" id="next-btn">Next</button>
      </div>
    </div>

    <div class="working">
      <svg class="spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"
        xmlns="http://www.w3.org/2000/svg"><path d="M13.5 8C13.5 11.038 11.038 13.5 8 13.5C4.962 13.5 2.5 11.038 2.5 8C2.5 4.962 4.962 2.5 8 2.5"/></svg>
      <span class="working-label">Working…</span>
      <button class="btn btn-secondary" id="exit-btn-working">Exit</button>
    </div>
  </div>

  <script>

    var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme(dark) { document.body.className = dark ? "darkTheme" : ""; }
    applyTheme(darkQuery.matches);
    darkQuery.addEventListener("change", function(e) { applyTheme(e.matches); });

    var cuTeach = window.cuTeach;

    var tooltip = document.getElementById("tooltip");
    var arrow = document.getElementById("arrow");
    var explanationEl = document.getElementById("explanation");
    var nextPreviewEl = document.getElementById("next-preview");
    var nextBtn = document.getElementById("next-btn");
    var exitBtn = document.getElementById("exit-btn");
    var exitBtnWorking = document.getElementById("exit-btn-working");

    tooltip.addEventListener("mouseenter", function() { cuTeach.mouseEnter(); });
    tooltip.addEventListener("mouseleave", function() { cuTeach.mouseLeave(); });

    function syncHover() {
      if (tooltip.matches(":hover")) {
        cuTeach.mouseEnter();
      } else {
        cuTeach.mouseLeave();
      }
    }

    var ARROW_SIZE = 10;         // matches border width in CSS
    var ARROW_GAP = 16;          // space between arrow tip and anchor point
    var EDGE_MARGIN = 20;        // keep tooltip this far from viewport edges

    function place(anchor) {
      var vw = window.innerWidth, vh = window.innerHeight;

      var w = tooltip.offsetWidth, h = tooltip.offsetHeight;

      if (!anchor) {

        tooltip.style.setProperty("--arrow-origin", "center center");
        arrow.className = "arrow arrow-none";
        tooltip.style.left = Math.round((vw - w) / 2) + "px";
        tooltip.style.top = Math.round((vh - h) / 2) + "px";
        return;
      }

      var ax = Math.max(EDGE_MARGIN, Math.min(vw - EDGE_MARGIN, anchor.x));
      var ay = Math.max(EDGE_MARGIN, Math.min(vh - EDGE_MARGIN, anchor.y));

      var fitsBelow = ay + ARROW_GAP + h + EDGE_MARGIN <= vh;
      var fitsAbove = ay - ARROW_GAP - h - EDGE_MARGIN >= 0;
      var fitsRight = ax + ARROW_GAP + w + EDGE_MARGIN <= vw;
      var fitsLeft  = ax - ARROW_GAP - w - EDGE_MARGIN >= 0;

      var side;
      if (fitsBelow) side = "below";
      else if (fitsAbove) side = "above";
      else if (fitsRight) side = "right";
      else if (fitsLeft) side = "left";
      else side = "below";  // none fit — below is least bad (tooltip clips at bottom)

      var left, top, arrowClass, arrowOrigin, arrowOffset;
      if (side === "below" || side === "above") {

        left = Math.round(ax - w / 2);
        left = Math.max(EDGE_MARGIN, Math.min(vw - w - EDGE_MARGIN, left));
        top = side === "below"
          ? Math.round(ay + ARROW_GAP)
          : Math.round(ay - ARROW_GAP - h);
        arrowClass = side === "below" ? "arrow-top" : "arrow-bottom";

        var arrowX = ax - left;
        arrowX = Math.max(ARROW_SIZE + 6, Math.min(w - ARROW_SIZE - 6, arrowX));
        arrowOffset = arrowX + "px";
        arrowOrigin = arrowX + "px " + (side === "below" ? "0%" : "100%");
      } else {
        top = Math.round(ay - h / 2);
        top = Math.max(EDGE_MARGIN, Math.min(vh - h - EDGE_MARGIN, top));
        left = side === "right"
          ? Math.round(ax + ARROW_GAP)
          : Math.round(ax - ARROW_GAP - w);
        arrowClass = side === "right" ? "arrow-left" : "arrow-right";
        var arrowY = ay - top;
        arrowY = Math.max(ARROW_SIZE + 6, Math.min(h - ARROW_SIZE - 6, arrowY));
        arrowOffset = arrowY + "px";
        arrowOrigin = (side === "right" ? "0%" : "100%") + " " + arrowY + "px";
      }

      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
      tooltip.style.setProperty("--arrow-offset", arrowOffset);
      tooltip.style.setProperty("--arrow-origin", arrowOrigin);
      arrow.className = "arrow " + arrowClass;
    }

    cuTeach.onShow(function(data) {

      tooltip.classList.remove("is-working");
      nextBtn.disabled = false;

      explanationEl.textContent = data.explanation || "";
      nextPreviewEl.textContent = data.nextPreview || "";

      place(data.anchorLogical);
      tooltip.classList.add("visible");

      syncHover();
    });

    cuTeach.onWorking(function() {
      tooltip.classList.add("is-working");

      syncHover();
    });

    cuTeach.onReassertHover(syncHover);

    cuTeach.onHide(function() {
      tooltip.classList.remove("visible");
    });

    function withRearm(btns, fn) {
      for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
      fn();
      setTimeout(function() {
        for (var i = 0; i < btns.length; i++) btns[i].disabled = false;
      }, 3000);
    }

    nextBtn.addEventListener("click", function() {
      withRearm([nextBtn], function() { cuTeach.next(); });

    });

    function doExit() {
      withRearm([exitBtn, exitBtnWorking], function() {
        cuTeach.exit();
      });

    }
    exitBtn.addEventListener("click", doExit);
    exitBtnWorking.addEventListener("click", doExit);
  </script>
</body>
</html>`.replace(
    />Teaching<|>Exit<|>Next<|>Working…</g,
    (match) =>
      `>${translate(match.slice(1, -1)).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!)}<`,
  );
}
