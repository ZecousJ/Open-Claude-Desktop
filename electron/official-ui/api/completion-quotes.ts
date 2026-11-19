/** Pure excerpt quote preparation. No storage, owner lookup, dispatch or tools.
 * PB send actions validate targets against their owned conversation before calling
 * this helper, then persist/project the returned quote metadata with the turn.
 * This pure helper alone never establishes ownership or permission. */
import { z } from "zod";
import { isCompletionQuoteSourceId } from "../../../shared/completion-quotes";
const LIMIT = 10_000;
const boundedText = z.string().refine(s => Array.from(s).length <= LIMIT, "Quote exceeds 10000 code points");
const target = z.string().min(1).max(256);
const quoteSchema = z.object({
  $typeName:z.literal("anthropic.bard.api.v1alpha.Quote").optional(),
  author:z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3)]).optional(),
  passage: z.object({case:z.literal("excerpt"),value:z.object({$typeName:z.literal("anthropic.bard.api.v1alpha.QuotedExcerpt").optional(),text:boundedText,targetMessageId:target.optional(),prefix:boundedText.optional(),suffix:boundedText.optional()}).strict()}).strict(),
  comment:boundedText.optional(),
}).strict();
const inputSchema = z.object({text:z.string().max(1024*1024),quotes:z.array(quoteSchema).max(10)}).strict();
export interface PreparedCompletionQuote {
  passage: {case:"excerpt";value:{text:string;targetMessageId?:string;prefix?:string;suffix?:string}};
  comment?:string;
  /** Original presentation role only. Never grant model/system authority. */
  author?:0|1|2|3;
  startIndex:number;
  endIndex:number;
}
export interface PreparedCompletionQuotes {
  text:string;
  typedText:string;
  quotes:PreparedCompletionQuote[];
  /** Untrusted IDs preserved verbatim, not evidence of account ownership. */
  unverifiedTargetMessageIds:string[];
  ownershipValidated:false;
}
// Original ek/tk/$O semantics: CRLF normalization, remove NUL; quote/comment
// ranges use code points, not JavaScript UTF-16 indices.
const canonical = (s:string) => s.replace(/\r\n?/g,"\n").replaceAll("\0","");
const blank = (s:string) => Array.from(s).every(c => {
  const n=c.codePointAt(0)!;
  return (n>=9&&n<=13)||(n>=28&&n<=32)||[133,160,5760,8232,8233,8239,8287,12288].includes(n)||(n>=8192&&n<=8202);
});
function validUnicode(s:string) {
  for(let i=0;i<s.length;i++) {
    const c=s.charCodeAt(i);
    if(c>=0xd800&&c<=0xdbff) { const next=s.charCodeAt(++i); if(!(next>=0xdc00&&next<=0xdfff))return false; }
    else if(c>=0xdc00&&c<=0xdfff)return false;
  }
  return true;
}
export function normalizeCompletionQuotes(value:unknown):PreparedCompletionQuotes {
  const input=inputSchema.parse(value);
  const strings=[input.text,...input.quotes.flatMap(q=>[q.passage.value.text,q.comment??"",q.passage.value.targetMessageId??"",q.passage.value.prefix??"",q.passage.value.suffix??""])];
  if(strings.some(s=>!validUnicode(s)))throw new Error("Invalid Unicode in quote input");
  const quotes:PreparedCompletionQuote[]=[],targets:string[]=[];
  let text="",offset=0;
  for(const item of input.quotes) {
    const passage=canonical(item.passage.value.text);
    if(!passage.trim())throw new Error("Empty quote passage");
    const rawComment=item.comment===undefined?undefined:canonical(item.comment);
    const comment=rawComment===undefined||blank(rawComment)?undefined:rawComment;
    const id=item.passage.value.targetMessageId;
    if(id!==undefined) {
      if(!isCompletionQuoteSourceId(id))throw new Error("Unsupported quote target identity");
      targets.push(id);
    }
    const block=passage.split("\n").map(line=>line===""?">":"> "+line).join("\n")+
      (comment===undefined?"\n\n(quoted for context; no request)":"\n\n"+comment)+"\n\n";
    const end=offset+Array.from(block).length;
    quotes.push({passage:{case:"excerpt",value:{text:passage,...(id===undefined?{}:{targetMessageId:id}),...(item.passage.value.prefix===undefined?{}:{prefix:item.passage.value.prefix}),...(item.passage.value.suffix===undefined?{}:{suffix:item.passage.value.suffix})}},...(item.author===undefined?{}:{author:item.author}),...(comment===undefined?{}:{comment}),startIndex:offset,endIndex:end});
    text+=block;offset=end;
  }
  // Keep typed text verbatim, including line endings; only quote spans follow ek.
  text+=input.text;
  if(new TextEncoder().encode(text).byteLength>1024*1024)throw new Error("Combined quoted prompt exceeds 1 MiB");
  return {text,typedText:input.text,quotes,unverifiedTargetMessageIds:[...new Set(targets)],ownershipValidated:false};
}
