import type { Conversation } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
export function blankConversationArtifact(
  conversation: Conversation,
): Artifact | undefined {
  const descriptor = conversation.blankArtifact;
  return descriptor
    ? {
        id: descriptor.id,
        blankArtifact: descriptor,
        conversationId: conversation.id,
        name: descriptor.name,
        filename: descriptor.file,
        language: descriptor.kind === "design" ? "svg" : "html",
        content: "",
        surface: "artifact",
        updatedAt: conversation.updatedAt,
      }
    : undefined;
}
/** Display user/agent HTML in the editor without executing it in the app.
 * The actual backing file remains separate; dashboard runs only in a sandbox. */
export function editorMarkup(input: string) {
  const template = document.createElement("template");
  template.innerHTML = input;
  for (const element of [
    ...template.content.querySelectorAll(
      "script,style,iframe,object,embed,link,meta,base,form,input,button,animate,animateMotion,animateTransform,set,foreignObject",
    ),
  ])
    element.remove();
  for (const element of template.content.querySelectorAll("*"))
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name.startsWith("on") ||
        ["srcdoc", "contenteditable", "autofocus"].includes(attribute.name)
      )
        element.removeAttribute(attribute.name);
      if (
        ["href", "src", "xlink:href"].includes(attribute.name) &&
        !/^(https?:|data:image\/(?:png|gif|jpeg|webp);base64,|#)/i.test(
          attribute.value,
        )
      )
        element.removeAttribute(attribute.name);
      if (
        attribute.name === "style" &&
        /url\s*\(|expression\s*\(|@import/i.test(attribute.value)
      )
        element.removeAttribute("style");
    }
  return template.innerHTML;
}
export function parseBlankContent(content: string) {
  return new DOMParser().parseFromString(content, "text/html");
}
export function serializeBlankContent(doc: Document) {
  return `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
}
