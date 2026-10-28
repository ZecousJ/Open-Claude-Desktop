/**
 * The browser half of a passkey sign-in: Sub2API's `passkey/login/begin`
 * answers WebAuthn request options as JSON (base64url buffers); the browser
 * signs the challenge and the assertion goes back to `passkey/login/finish` as
 * JSON again. Same conversion as the console's
 * backend/frontend/src/api/passkey.ts.
 */

type Json = Record<string, unknown>;

function fromBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
}

function toBase64Url(value: ArrayBuffer | null): string | null {
  if (value === null) return null;
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** The request options of a begin answer (`options.publicKey`), decoded. */
export function requestOptions(
  value: unknown,
): PublicKeyCredentialRequestOptions {
  const outer = (value ?? {}) as Json;
  const publicKey = ((outer.publicKey as Json | undefined) ?? outer) as Json;
  const options: Json = { ...publicKey };
  options.challenge = fromBase64Url(String(publicKey.challenge ?? ""));
  if (Array.isArray(publicKey.allowCredentials))
    options.allowCredentials = publicKey.allowCredentials.map((item) => ({
      ...(item as Json),
      id: fromBase64Url(String((item as Json).id ?? "")),
    }));
  return options as unknown as PublicKeyCredentialRequestOptions;
}

/** Runs the ceremony; resolves to the assertion as JSON. */
export async function passkeyAssertion(options: unknown): Promise<Json> {
  const credential = await navigator.credentials.get({
    publicKey: requestOptions(options),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey sign-in was cancelled.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
      userHandle: toBase64Url(response.userHandle),
    },
  };
}

/** The creation options of a register begin answer (`options.publicKey`), decoded. */
export function creationOptions(
  value: unknown,
): PublicKeyCredentialCreationOptions {
  const outer = (value ?? {}) as Json;
  const publicKey = ((outer.publicKey as Json | undefined) ?? outer) as Json;
  const options: Json = { ...publicKey };
  options.challenge = fromBase64Url(String(publicKey.challenge ?? ""));
  const user = (publicKey.user ?? {}) as Json;
  options.user = { ...user, id: fromBase64Url(String(user.id ?? "")) };
  if (Array.isArray(publicKey.excludeCredentials))
    options.excludeCredentials = publicKey.excludeCredentials.map((item) => ({
      ...(item as Json),
      id: fromBase64Url(String((item as Json).id ?? "")),
    }));
  return options as unknown as PublicKeyCredentialCreationOptions;
}

/** Makes a passkey on this device; resolves to the attestation as JSON. */
export async function passkeyAttestation(options: unknown): Promise<Json> {
  const credential = await navigator.credentials.create({
    publicKey: creationOptions(options),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey setup was cancelled.");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      attestationObject: toBase64Url(response.attestationObject),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      transports: response.getTransports?.() ?? [],
    },
  };
}
