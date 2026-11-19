import { z } from "zod";
import { connectorUrlError } from "./custom-connector";

const endpoint = z
  .string()
  .max(2048)
  .refine((value) => !connectorUrlError(value));
const discovery = z
  .strictObject({
    issuer: endpoint,
    authorization_endpoint: endpoint,
    token_endpoint: endpoint,
    registration_endpoint: endpoint.nullish(),
    revocation_endpoint: endpoint.nullish(),
    revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  })
  .refine(
    ({
      authorization_endpoint,
      token_endpoint,
      registration_endpoint,
      revocation_endpoint,
    }) =>
      [token_endpoint, registration_endpoint, revocation_endpoint].every(
        (value) =>
          !value ||
          URL.parse(value)?.origin ===
            URL.parse(authorization_endpoint)?.origin,
      ),
  );

export const connectorOAuthOverrides = z
  .strictObject({
    discovery: discovery.nullish(),
    request_parameters: z
      .strictObject({
        scopes: z.array(z.string().trim().min(1).max(256)).min(1).max(64),
      })
      .nullish(),
  })
  .refine((value) => Boolean(value.discovery || value.request_parameters));

export const connectorOAuthOptions = z.strictObject({
  posture: z.enum(["auth_required", "defer_auth"]).optional(),
  registration: z.enum(["dcr", "cimd", "static_per_installation"]).optional(),
  overrides: connectorOAuthOverrides.optional(),
});
export type ConnectorOAuthOptions = z.infer<typeof connectorOAuthOptions>;
