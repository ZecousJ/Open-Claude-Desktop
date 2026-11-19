/** InlineAttachment carries extracted text, never the original binary document. */
import { prepareDerivedTextAttachment } from "../../engine/derived-text-attachment";
export { prepareDerivedTextAttachment } from "../../engine/derived-text-attachment";
import type { AdapterContext } from "./context";
import { storeUpload } from "./files";
import { currentAdapterScope } from "./scope";

export async function storePreparedDerivedTextAttachment(
  ctx: AdapterContext,
  prepared: ReturnType<typeof prepareDerivedTextAttachment>,
  incognitoConversation?: string,
) {
  const owner = ctx.account()?.id, identity = ctx.sessionIdentity?.(), root = ctx.stateDirectory?.(), scope = currentAdapterScope();
  const check = () => {
    if (!owner || identity == null || !root || currentAdapterScope() !== scope ||
        ctx.account()?.id !== owner || ctx.sessionIdentity?.() !== identity ||
        ctx.stateDirectory?.() !== root || ctx.isCurrent?.() === false)
      throw Error("The attachment account changed.");
  };
  check();
  const file = await storeUpload(ctx, prepared.name, prepared.data, prepared.mediaType, incognitoConversation);
  check();
  return file;
}
