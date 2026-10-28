/** Native overlay. */
export function indicatorHtml(
  _appName?: string,
  label = "Claudex is using your computer",
) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
  }
  #overlay {
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
  }
  #glow {
    position: fixed;
    inset: 0;
    pointer-events: none;
    animation: glow-pulse 2s ease-in-out infinite;
    box-shadow:
      inset 0 0 50px rgba(217, 119, 87, 0.5),
      inset 0 0 100px rgba(217, 119, 87, 0.3),
      inset 0 0 150px rgba(217, 119, 87, 0.1);
  }
  #badge {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 8px;

    background: rgba(255, 247, 242, 0.95);
    border: 1px solid rgba(217, 119, 87, 0.2);
    border-radius: 999px;
    padding: 8px 16px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    font-weight: 600;
    color: rgb(217, 119, 87);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
  }
  #badge.flash {
    animation: badge-center-to-corner 6s cubic-bezier(0.4, 0, 0.2, 1) 1 forwards;
  }
  #badge-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgb(217, 119, 87);
    animation: dot-pulse 1.8s ease-in-out infinite;
  }
  @keyframes glow-pulse {
    0%, 100% {
      box-shadow:
        inset 0 0 50px rgba(217, 119, 87, 0.5),
        inset 0 0 100px rgba(217, 119, 87, 0.3),
        inset 0 0 150px rgba(217, 119, 87, 0.1);
    }
    50% {
      box-shadow:
        inset 0 0 65px rgba(217, 119, 87, 0.7),
        inset 0 0 115px rgba(217, 119, 87, 0.5),
        inset 0 0 165px rgba(217, 119, 87, 0.2);
    }
  }
  @keyframes badge-center-to-corner {
    0%   { opacity: 0; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(1.4); }
    5%   { opacity: 1; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(1.4); }
    88%  { opacity: 1; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(1.4); }
    100% { opacity: 0; top: 40px; left: calc(100% - 280px); transform: translate(0, 0) scale(0.8); }
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.5; transform: scale(0.7); }
  }
  @media (prefers-reduced-motion: reduce) {

    #glow, #badge-dot, #badge.flash { animation: none; }
  }
</style>
</head>
<body>
  <div id="overlay" style="opacity:1">
    <div id="glow"></div>
    <div id="badge" class="flash"><div id="badge-dot"></div><span id="badge-label">Claudex is using your computer</span></div>
  </div>
</body>
</html>`.replace(
    "Claudex is using your computer",
    label.replace(
      /[&<>]/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!,
    ),
  );
}
