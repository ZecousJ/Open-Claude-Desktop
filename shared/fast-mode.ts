/**
 * Fast mode (R-0357, R-0389): a model's fast tier is a separate catalog
 * entry that names the model it speeds up. The service does not send this
 * yet (the catalog parser in claudex-contract.ts leaves it out), so in the
 * app no model has a fast tier and the Code model menu shows Fast mode
 * disabled. The fidelity fixture sets it to draw the other states.
 */
import type { ModelCatalogItem } from "./model-catalog-api";

export interface FastModeCatalogFields {
  /** This entry is the fast tier of the model with this id. */
  fastOf?: string;
}

export type FastAwareCatalogItem = ModelCatalogItem & FastModeCatalogFields;
