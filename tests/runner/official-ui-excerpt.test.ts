import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { toBinary } from "@bufbuild/protobuf";
import { deepCreate, registryFor } from "../../electron/official-ui/api/timeline";
import { officialUiActionPath } from "../../shared/official-ui-web";
import { matchesOfficialInlineUpload, validOfficialExcerpt, validOfficialInline } from "../../runner/src/official-ui-excerpt";

const root = path.resolve("build/official-ui");
const schema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
const name = "excerpt_from_previous_claude_message.txt";
const excerpt = (text: string) => ({
  fileName: name,
  fileType: "txt",
  fileSize: BigInt(Buffer.byteLength(text, "utf8")),
  extractedContent: text,
});

test("original inline excerpts enforce their exact type, size and Unicode length", () => {
  assert.equal(validOfficialExcerpt(excerpt("quoted 中文")), true);
  assert.equal(validOfficialExcerpt(excerpt("😀".repeat(10000))), true);
  assert.equal(validOfficialExcerpt(excerpt("😀".repeat(10001))), false);
  assert.equal(validOfficialExcerpt(excerpt("  ")), false);
  assert.equal(validOfficialExcerpt(excerpt("a\0b")), false);
  assert.equal(validOfficialExcerpt({ ...excerpt("text"), fileSize: 999n }), false);
  assert.equal(validOfficialExcerpt({ ...excerpt("text"), fileName: "other.txt" }), false);
  assert.equal(validOfficialExcerpt({ ...excerpt("text"), fileType: "html" }), false);
});

test("internal excerpt upload is bound to the exact active protobuf action and bytes", () => {
  const body = Buffer.from(toBinary(schema, deepCreate(schema, {
    header: { conversationId: "11111111-1111-4111-8111-111111111111" },
    action: { case: "sendMessage", value: { text: "question", inlineAttachments: [excerpt("quoted 中文")] } },
  })));
  const request = { method: "POST" as const, path: officialUiActionPath, contentType: "Application/Proto", body };
  const nameOnDisk = name + ".extracted.txt";
  const bytes = new TextEncoder().encode("quoted 中文");
  assert.equal(matchesOfficialInlineUpload(request, root, [nameOnDisk, bytes]), true);
  assert.equal(matchesOfficialInlineUpload(request, root, [nameOnDisk, new TextEncoder().encode("different")]), false);
  assert.equal(matchesOfficialInlineUpload(request, root, ["different.txt", bytes]), false);
  assert.equal(matchesOfficialInlineUpload({ ...request, path: "/other" }, root, [nameOnDisk, bytes]), false);
  assert.equal(matchesOfficialInlineUpload({ ...request, contentType: "application/json" }, root, [nameOnDisk, bytes]), false);
  assert.equal(matchesOfficialInlineUpload({ ...request, body: new Uint8Array([255]) }, root, [nameOnDisk, bytes]), false);
});

test("ordinary original picker text authorizes only its exact derived upload", () => {
  const item = { fileName: "f016-picker-test.txt", fileType: "text/plain", fileSize: 47n, extractedContent: "F016 file picker test: the lighthouse is blue.\n" };
  const request = { method: "POST" as const, path: officialUiActionPath, contentType: "application/proto", body: Buffer.from(toBinary(schema, deepCreate(schema, {
    header: { conversationId: "11111111-1111-4111-8111-111111111111" },
    action: { case: "sendMessage", value: { text: "question", inlineAttachments: [item] } },
  }))) };
  const bytes = Buffer.from(item.extractedContent);
  assert.equal(matchesOfficialInlineUpload(request, root, [item.fileName + ".extracted.txt", bytes]), true);
  assert.equal(matchesOfficialInlineUpload(request, root, [item.fileName + ".extracted.txt", Buffer.from("other")]), false);
  assert.equal(matchesOfficialInlineUpload(request, root, ["different.txt", bytes]), false);
  assert.equal(validOfficialInline({ ...item, fileName: name }), false, "reserved excerpts retain strict validation");
  assert.equal(validOfficialInline({ ...item, fileSize: -1n }), false);
  assert.equal(validOfficialInline({ ...item, extractedContent: "bad\0text" }), false);
  assert.equal(validOfficialInline({ ...item, extractedContent: "\ud800" }), false);
});

test("REST excerpt upload must match the active original request exactly",async()=>{
 const {matchesOfficialRestTextUpload}=await import("../../runner/src/official-ui-excerpt");
 const path="/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/22222222-2222-4222-8222-222222222222/completion";
 const row={file_name:name,file_type:"txt",file_size:Buffer.byteLength("quoted 中文"),extracted_content:"quoted 中文",kind:"excerpt",origin:"user_upload"};
 const request={method:"POST" as const,path,contentType:"application/json",body:Buffer.from(JSON.stringify({attachments:[row]}))};
 const derived=[name+".extracted.txt",Buffer.from(row.extracted_content)];
 assert.equal(matchesOfficialRestTextUpload(request,derived),true);
 for(const changed of [{...row,file_name:"other.txt"},{...row,kind:"file"},{...row,file_size:1},{...row,extracted_content:"other"}])
  assert.equal(matchesOfficialRestTextUpload({...request,body:Buffer.from(JSON.stringify({attachments:[changed]}))},derived),false);
 assert.equal(matchesOfficialRestTextUpload({...request,path:path+"?x=1"},derived),false);
 assert.equal(matchesOfficialRestTextUpload(request,[derived[0],Buffer.from("different")]),false);
});

test("ordinary REST extracted text authorizes only the exact request bytes",async()=>{
 const {matchesOfficialRestTextUpload}=await import("../../runner/src/official-ui-excerpt");
 const path="/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/22222222-2222-4222-8222-222222222222/completion";
 const row={file_name:"notes.txt",file_type:"txt",file_size:5,extracted_content:"hello",kind:"file",origin:"user_upload"};
 const request={method:"POST" as const,path,contentType:"application/json",body:Buffer.from(JSON.stringify({attachments:[row]}))};
 assert.equal(matchesOfficialRestTextUpload(request,["notes.txt.extracted.txt",Buffer.from("hello")]),true);
 assert.equal(matchesOfficialRestTextUpload(request,["notes.txt.extracted.txt",Buffer.from("other")]),false);
 const forged={...row,quote_message_uuid:"foreign:assistant"};
 assert.equal(matchesOfficialRestTextUpload({...request,body:Buffer.from(JSON.stringify({attachments:[forged]}))},["notes.txt.extracted.txt",Buffer.from("hello")]),false);
});

test("private derived text uploads require the active temporary conversation", async () => {
  const { matchesOfficialRestTextUpload } = await import("../../runner/src/official-ui-excerpt");
  const id = "22222222-2222-4222-8222-222222222222";
  const row = { file_name: "notes.txt", file_type: "txt", file_size: 5, extracted_content: "hello", kind: "file", origin: "user_upload" };
  const url = `/api/organizations/11111111-1111-4111-8111-111111111111/chat_conversations/${id}/completion`;
  const request = { method: "POST" as const, path: url, contentType: "application/json", body: Buffer.from(JSON.stringify({ attachments: [row], create_conversation_params: { is_temporary: true } })) };
  const args = ["notes.txt.extracted.txt", Buffer.from("hello"), { incognitoDraft: id }];
  assert.equal(matchesOfficialRestTextUpload(request, args), true);
  assert.equal(matchesOfficialRestTextUpload(request, [args[0], args[1], { incognitoDraft: "foreign" }]), false);
  const followup = { ...request, body: Buffer.from(JSON.stringify({ attachments: [row] })) };
  assert.equal(matchesOfficialRestTextUpload(followup, args), false);
  assert.equal(matchesOfficialRestTextUpload(followup, args, candidate => candidate === id), true);
  const body = Buffer.from(toBinary(schema, deepCreate(schema, {
    header: { conversationId: id }, action: { case: "sendMessage", value: { text: "hello", isTemporary: true, inlineAttachments: [excerpt("hello")] } },
  })));
  const protobuf = { method: "POST" as const, path: officialUiActionPath, contentType: "application/proto", body };
  const protoArgs = [name + ".extracted.txt", Buffer.from("hello"), { incognitoDraft: id }];
  assert.equal(matchesOfficialInlineUpload(protobuf, root, protoArgs), true);
  assert.equal(matchesOfficialInlineUpload(protobuf, root, [protoArgs[0], protoArgs[1], { incognitoDraft: "foreign" }]), false);
});
