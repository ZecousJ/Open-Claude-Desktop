/**
 * Runs inside the sandboxed preview frame. The renderer compiles the artifact
 * to a CommonJS factory; this mounts its default export.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as Lucide from "lucide-react";

type Report = (message: unknown) => void;
const report: Report = (message) =>
  (
    window as unknown as { __claudexReportError?: Report }
  ).__claudexReportError?.(
    message instanceof Error ? `${message.name}: ${message.message}` : message,
  );
const modules: Record<string, unknown> = {
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "lucide-react": Lucide,
};
// Classic JSX without an import refers to a global React.
(window as unknown as { React: typeof React }).React = React;

class Boundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    report(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Factory = (
  require: (name: string) => unknown,
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
) => void;
export function mount(factory: Factory) {
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (name in modules) return modules[name];
    throw new Error(
      `The preview can't load "${name}". Available modules: react, react-dom and lucide-react.`,
    );
  };
  try {
    factory(require, module, module.exports);
  } catch (error) {
    report(error);
    return;
  }
  const component =
    module.exports.default ??
    Object.values(module.exports).find((value) => typeof value === "function");
  if (typeof component !== "function") {
    report("The artifact has no default export to render.");
    return;
  }
  ReactDOMClient.createRoot(document.getElementById("root")!).render(
    React.createElement(
      Boundary,
      null,
      React.createElement(component as React.ComponentType),
    ),
  );
}
