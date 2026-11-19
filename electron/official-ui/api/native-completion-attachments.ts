import { inlineDisplayForSend } from "./inline-attachment-displays";
import type { InlineAttachmentDisplay, InlineQuoteSource } from "../../../shared/inline-attachment-display";
import { isCompletionQuoteSourceId } from '../../../shared/completion-quotes';
import { resolveCompletionQuoteSources } from './completion-quote-source';
import { assistantMessageId, userMessageId, messageRef } from './conversations';
/** Native REST attachments reuse the existing upload store and send handler. */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareDerivedTextAttachment} from './derived-text-attachment';
import type {AdapterContext} from './context';
import type {Conversation} from '../../../shared/types';
import {attachmentKind, builtInAttachmentBytes} from '../../../shared/client-policy';
import {currentAdapterScope} from './scope';
import {bindIncognitoFiles, knownFile, storeUpload} from './files';
import {incognitoDraftId} from '../../workspace/incognito-upload';
import {completionFilesSchema, nativeCompletionInlineSchema, CompletionAttachmentError, type PreparedCompletionAttachment} from './completion-attachments';

export function withNativeCompletionAttachments(ctx: AdapterContext): AdapterContext {
  if(ctx.readOnly || ctx.prepareCompletionAttachments || ctx.submitCompletionWithAttachments)return ctx;
  // Internal results only, never renderer-issued authority. Existing account scope remains authoritative.
  const pending=new WeakMap<PreparedCompletionAttachment[],{check:()=>void; signature:string; validateSources:()=>Promise<void>}>();
  const failure=(status:number,code:string,message:string)=>new CompletionAttachmentError(status,code,message);
  const prepare:NonNullable<AdapterContext['prepareCompletionAttachments']>=async input=>{
    const owner=ctx.account()?.id, identity=ctx.sessionIdentity?.(), root=ctx.stateDirectory?.(), scope=currentAdapterScope();
    const check=()=>{
      if(currentAdapterScope()!==scope || !owner || identity===undefined || identity===null || !root || ctx.isCurrent?.()===false || ctx.account()?.id!==owner || ctx.sessionIdentity?.()!==identity || ctx.stateDirectory?.()!==root)
        throw failure(409,'attachment_activation_changed','The account changed. Reattach the files before sending.');
    };
    check();
    const files=completionFilesSchema.parse(input.files), inline=nativeCompletionInlineSchema.parse(input.attachments);
    const cited=inline.filter(item=>item.quote_message_uuid!==undefined);
    for(const item of cited)if(item.kind!=="excerpt" || item.file_name!=="excerpt_from_previous_claude_message.txt" || item.file_type!=="txt" || !isCompletionQuoteSourceId(item.quote_message_uuid!) || Array.from(item.extracted_content).length>10000 || item.file_size!==Buffer.byteLength(item.extracted_content,"utf8"))
      throw failure(400,"invalid_quote_source","The quoted passage is invalid.");
    let sourceById = new Map<string, InlineQuoteSource>();
    const validateSources=async()=>{
      if(!cited.length)return;
      check();
      if(!input.conversationId)throw failure(409,"quote_source_unavailable","The quoted source is unavailable.");
      const conversation=await ctx.loadConversation(input.conversationId);
      check();
      if(!conversation || conversation.id!==input.conversationId)throw failure(409,"quote_source_unavailable","The quoted source is unavailable.");
      try{
        const nextSources = new Map<string, InlineQuoteSource>();
        for(let offset=0;offset<cited.length;offset+=10) {
          const resolved = resolveCompletionQuoteSources({conversation,current:()=>{try{check();return true;}catch{return false;}},userMessageId,assistantMessageId,messageRef:id=>messageRef(conversation.id,id)},cited.slice(offset,offset+10).map(item=>({passage:{case:"excerpt",value:{text:item.extracted_content,targetMessageId:item.quote_message_uuid}}})));
          for (const entry of resolved.sources) if (entry.targetMessageId && entry.source) nextSources.set(entry.targetMessageId, entry.source);
        }
        if (sourceById.size && JSON.stringify([...sourceById]) !== JSON.stringify([...nextSources])) throw Error("The quoted source changed.");
        sourceById = nextSources;
      }catch{throw failure(409,"quote_source_unavailable","The quoted source changed or is unavailable.");}
      check();
    };
    await validateSources();
    if(files.length+inline.length>12)throw failure(413,'attachment_limit','Attach at most 12 files to this message.');
    if(new Set(files).size!==files.length)throw failure(400,'duplicate_attachment','The same file was attached more than once.');
    const result:PreparedCompletionAttachment[]=[];
    // Stored native files retain the existing per-file policy. Web transport's
    // 32 MB aggregate budget does not apply to already stored native file IDs.
    for(const id of files){
      check();const file=knownFile(id);
      if(!file)throw failure(404,'files_not_found','An attachment is unavailable in this account. Add it again.');
      const kind=attachmentKind(path.extname(file.name).slice(1));
      if(!Number.isSafeInteger(file.size)||file.size<0||file.size>builtInAttachmentBytes[kind])throw failure(413,'attachment_limit','The stored attachment exceeds its file-type limit.');
      result.push({source:'owned-file',id,name:file.name,size:file.size,kind});
    }
    for(const item of inline){
      let derived:ReturnType<typeof prepareDerivedTextAttachment>;
      try{derived=prepareDerivedTextAttachment({fileName:item.file_name,fileType:item.file_type,extractedContent:item.extracted_content});}
      catch{throw failure(400,'invalid_extracted_attachment','The extracted text attachment is invalid. Remove it and attach it again.');}
      result.push({source:'extracted-text',...(item.quote_message_uuid ? {quoteSource:sourceById.get(item.quote_message_uuid)} : {}),display:{file_name:item.file_name,file_type:item.file_type,...(item.kind?{kind:item.kind}:{}),...(item.quote_message_uuid?{quote_message_uuid:item.quote_message_uuid}:{})},name:derived.name,mediaType:'text/plain',size:derived.data.byteLength,sha256:createHash('sha256').update(derived.data).digest('hex'),text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(derived.data)});
    }
    check();pending.set(result,{check,signature:JSON.stringify(result),validateSources});return result;
  };
  const submit:NonNullable<AdapterContext['submitCompletionWithAttachments']>=async(send,attachments)=>{
    const operation=pending.get(attachments);pending.delete(attachments);
    if(!operation || operation.signature!==JSON.stringify(attachments))throw failure(409,'attachment_preparation_changed','Reattach the files before sending.');
    operation.check();
    await operation.validateSources();
    operation.check();
    const draft = send.incognito ? incognitoDraftId.parse(send.conversationId ?? send.newConversationId) : undefined;
    const ids:string[]=[], displays: InlineAttachmentDisplay[] = [];
    // Validate every existing identity before creating any inline attachment.
    for(const item of attachments)if(item.source==='owned-file'){
      const file=knownFile(item.id);
      if(!file || file.incognitoDraft && !send.incognito || file.name!==item.name || file.size!==item.size || attachmentKind(path.extname(file.name).slice(1))!==item.kind)
        throw failure(404,'files_not_found','An attachment is unavailable in this account. Add it again.');
    }
    bindIncognitoFiles(attachments.flatMap(item => item.source === 'owned-file' ? [item.id] : []), draft);
    for(const item of attachments){
      operation.check();
      if(item.source==='owned-file')ids.push(item.id);
      else {
        const file=await storeUpload(ctx,item.name,new TextEncoder().encode(item.text),'text/plain',draft);
        operation.check();
        if(item.display)displays.push(inlineDisplayForSend(file.id,item.display,item.text,item.quoteSource));
        ids.push(file.id);
      }
    }
    operation.check();
    await operation.validateSources();
    operation.check();
    const result=await ctx.call('send',{...send,attachments:ids.map(id=>({id})), ...(displays.length ? {inlineAttachmentDisplays:displays} : {})});
    operation.check();
    operation.check();return result as Conversation;
  };
  return new Proxy(ctx,{get(target,key,receiver){
    if(key==='prepareCompletionAttachments')return prepare;
    if(key==='submitCompletionWithAttachments')return submit;
    return Reflect.get(target,key,receiver);
  }});
}
