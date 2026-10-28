// .
export function exceedsCodeSizeLimit(code: string) {
  return new TextEncoder().encode(code.trimEnd()).length > 204_800;
}

type CodeNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: string[] };
  children?: CodeNode[];
};

export function rehypeCodeSizeLimit() {
  return (tree: CodeNode) => {
    const walk = (node: CodeNode) => {
      if (
        node.tagName === "code" &&
        exceedsCodeSizeLimit(
          node.children?.map((child) => child.value ?? "").join("") ?? "",
        )
      ) {
        node.properties ??= {};
        node.properties.className = [
          ...(node.properties.className ?? []),
          "no-highlight",
        ];
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
