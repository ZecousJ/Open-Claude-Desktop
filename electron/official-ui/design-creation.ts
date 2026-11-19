import { z } from "zod";
import type { CreateBlankArtifactInput } from "../../shared/blank-artifacts";
import type { Provider } from "../../shared/types";

const createdDesign = z.object({
  conversation: z.object({
    blankArtifact: z.object({
      id: z.uuid(),
      kind: z.literal("design"),
    }),
  }),
});

export interface OfficialDesignCreationInput {
  requestId: string;
  title: string;
  retryInFlight?: true;
}

export async function createOfficialBlankDesign(
  input: OfficialDesignCreationInput,
  providers: Provider[],
  create: (input: CreateBlankArtifactInput) => Promise<unknown>,
) {
  const provider = providers[0];
  if (!provider?.model) throw Error("No model is available for this design.");
  const result = createdDesign.parse(
    await create({
      requestId: input.requestId,
      kind: "design",
      name: input.title,
      providerId: provider.id,
      model: provider.model,
      ...(input.retryInFlight && { retryInFlight: true }),
    }),
  );
  return { slug: result.conversation.blankArtifact.id };
}
