import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { Store } from "../../electron/store/store";
import { GeneratedBlobs } from "../../electron/artifacts/generated-blobs";
import { captureOutputFiles } from "../../electron/artifacts/generated-files";
import type { Conversation } from "../../shared/types";
export const outputConversationId = "8cfc6561-4d86-4efa-8e94-72a293f83a45";
/** Real Office ZIP and engine snapshot store; no model, production profile or credential. */
export async function createGeneratedOutputFixture(
  root: string,
  documents = false,
) {
  const profile = path.join(root, "profile"),
    workspace = path.join(root, "workspace");
  const reopen = fs.existsSync(path.join(profile, "conversations.json"));
  fs.mkdirSync(workspace, { recursive: true });
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="对比" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>版本</t></is></c><c r="B1" t="inlineStr"><is><t>建议</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>测试版本</t></is></c><c r="B2" t="inlineStr"><is><t>F019原始文件</t></is></c></row></sheetData></worksheet>',
  );
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  if (!reopen) fs.writeFileSync(path.join(workspace, "版本对比.xlsx"), bytes);
  if (!reopen)
    fs.writeFileSync(
      path.join(workspace, "说明.txt"),
      "F019 generated text 中文",
    );
  if (!reopen && documents) {
    const { generatedDocumentFixtures } =
      await import("./generated-document-fixtures");
    for (const [name, data] of Object.entries(
      await generatedDocumentFixtures(),
    )) {
      fs.mkdirSync(path.dirname(path.join(workspace, name)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(workspace, name), data);
    }
  }
  let store = new Store(profile),
    identity = {},
    owner = "f019-owner";
  const blobs = new GeneratedBlobs(profile);
  const files = reopen
    ? store.conversations[0].turns.flatMap((t) =>
        t.items.flatMap((i) => i.generatedFiles ?? []),
      )
    : captureOutputFiles(
        workspace,
        Date.now() - 5000,
        new Set(),
        blobs,
        "f019-output",
      );
  const c: Conversation = {
    id: outputConversationId,
    title: "F019 生成文件验收",
    mode: "chat",
    providerId: "p",
    model: "fixture-model",
    createdAt: Date.now() - 10000,
    updatedAt: Date.now(),
    cwd: workspace,
    pinned: false,
    archived: false,
    turns: [
      {
        id: "f019-turn",
        prompt: documents
          ? "Create a PowerPoint presentation, a comparison spreadsheet and a text file."
          : "Create a comparison spreadsheet and text file.",
        createdAt: Date.now() - 5000,
        status: "completed",
        attachments: [],
        items: [
          {
            id: "bash",
            type: "commandExecution",
            status: "completed",
            lifecycleStatus: "completed",
            command: "fixture writes local files",
            aggregatedOutput: "Fixture files written",
            exitCode: 0,
          },
          {
            id: "answer",
            type: "agentMessage",
            text: "已生成版本对比表和说明文件。",
          },
          {
            id: "outputs",
            type: "outputFiles",
            status: "completed",
            generatedFiles: files,
          },
        ],
      },
    ],
  };
  if (!reopen) {
    store.conversations = [c];
    store.flush();
  }
  let reads = 0;
  const ctx: any = {
    root: path.resolve("build/official-ui"),
    account: () => ({
      id: owner,
      name: "F019 Test",
      email: "fixture@example.invalid",
    }),
    sessionIdentity: () => identity,
    stateDirectory: () => profile,
    isCurrent: () => true,
    settings: () => ({
      ...store.settings,
      providers: [
        {
          id: "p",
          model: "fixture-model",
          models: ["fixture-model"],
          protocol: "responses",
        },
      ],
      activeProviderId: "p",
      theme: "dark",
    }),
    listConversations: async () => structuredClone(store.conversations),
    loadConversation: async (id: string) => {
      const c = store.conversations.find((c) => c.id === id);
      return c && structuredClone(c);
    },
    snapshot: async () => ({
      settings: store.settings,
      conversations: store.conversations,
      projects: [],
    }),
    modelCatalog: async () => ({
      defaultModel: "fixture-model",
      items: [
        {
          id: "fixture-model",
          displayName: "Fixture model",
          efforts: ["high"],
        },
      ],
    }),
    onEvent: () => () => {},
    log() {},
    appVersion: "test",
    call: async (method: string, ...args: any[]) => {
      if (method === "readGeneratedFile") {
        reads++;
        return blobs.read(args[0]).toString("base64");
      }
      if (method === "artifactNotes") return [];
      if (method === "listSkills" || method === "mcpServers") return [];
      throw Error("Unimplemented fixture method: " + method);
    },
  };
  return {
    ctx,
    profile,
    workspace,
    blobs,
    bytes,
    files,
    get store() {
      return store;
    },
    get reads() {
      return reads;
    },
    restart() {
      store = new Store(profile);
      identity = {};
    },
    retire() {
      identity = {};
    },
    switchAccount() {
      owner = "other";
      identity = {};
    },
  };
}
