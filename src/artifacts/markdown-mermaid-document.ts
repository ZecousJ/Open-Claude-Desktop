import { inlineScript, scriptJson } from "./preview-document";

export const mermaidResultType = "claudex-markdown-mermaid";

// .
export function markdownMermaidDocument(
  runtime: { source: string },
  code: string,
  dark: boolean,
) {
  const themeVariables = dark
    ? {
        primaryTextColor: "#E5E5E5",
        lineColor: "#A1A1A1",
        primaryColor: "transparent",
        primaryBorderColor: "#A1A1A1",
        secondaryColor: "transparent",
        tertiaryColor: "#CC785C",
        actorTextColor: "#E5E5E5",
        actorLineColor: "#A1A1A1",
        signalColor: "#E5E5E5",
        signalTextColor: "#E5E5E5",
        noteBkgColor: "#2D2D2D",
        noteTextColor: "#E5E5E5",
        noteBorderColor: "#A1A1A1",
      }
    : {
        primaryTextColor: "#191919",
        lineColor: "#91918D",
        primaryColor: "#F0F0EB",
        primaryBorderColor: "#D9D8D5",
        secondaryColor: "#F5E6D8",
        tertiaryColor: "#CC785C",
        actorTextColor: "#191919",
        actorLineColor: "#91918D",
        signalColor: "#191919",
        signalTextColor: "#191919",
        noteBkgColor: "#F0F0EB",
        noteTextColor: "#191919",
        noteBorderColor: "#D9D8D5",
      };
  const config = {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    maxTextSize: 20_000,
    maxEdges: 400,
    fontFamily: "inherit",
    theme: "base",
    themeVariables,
  };
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:transparent;font-family:system-ui}svg{display:block;max-width:100%;height:auto;margin-inline:auto}</style><div id="diagram"></div>${inlineScript(runtime.source)}${inlineScript(
    `const post=result=>parent.postMessage({type:${scriptJson(mermaidResultType)},...result},"*");` +
      `mermaid.initialize(${scriptJson(config)});mermaid.render("markdown-diagram",${scriptJson(code)}).then(result=>{document.getElementById("diagram").innerHTML=result.svg;const report=()=>post({height:document.documentElement.scrollHeight});new ResizeObserver(report).observe(document.body);report()}).catch(()=>post({error:true}));`,
  )}`;
}
