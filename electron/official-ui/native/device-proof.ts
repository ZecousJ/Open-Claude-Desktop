import { Buffer } from "node:buffer";
import { z } from "zod";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zeroUuid = "00000000-0000-0000-0000-000000000000";
const sha256Pattern = /^[0-9a-f]{64}$/;
const attestationDomain = Buffer.from("anthropic.ccr.client_event.v1\0");
const bindDomains = {
  signSessionBind: "anthropic.ccr.session_bind.v1",
  signConversationBind: "anthropic.ccr.conversation_bind.v1",
  signProjectThreadLink: "anthropic.ccr.project_thread_link.v1",
};

const uuid = z.string().regex(uuidPattern);
const nulFree = z.string().refine((value) => !value.includes("\0"));
const sha256 = z.string().regex(sha256Pattern);
const absent = z.never().optional();
const sessionRequestFields = { orgUuid: uuid, sessionUuid: uuid };
const noFileFields = {
  path: absent,
  contentSha256Hex: absent,
  ifMatchSha256: absent,
};
const sessionRequest = z.discriminatedUnion("surface", [
  z.object({
    ...sessionRequestFields,
    surface: z.literal("session_synced_file_put"),
    contentSha256Hex: sha256,
    path: nulFree,
    ifMatchSha256: nulFree,
    noticeId: absent,
  }),
  z.object({
    ...sessionRequestFields,
    ...noFileFields,
    surface: z.enum(["session_archive", "session_delete"]),
    noticeId: absent,
  }),
  z.object({
    ...sessionRequestFields,
    ...noFileFields,
    surface: z.literal("session_composer_notice_dismiss"),
    noticeId: nulFree.refine((value) => value.length > 0),
  }),
]);
const fileCopyRequest = z.object({
  ...sessionRequestFields,
  fileId: z.string().regex(/^file_[A-Za-z0-9_-]{1,123}$/),
  mountPath: z.string().refine(isUploadPath),
});
const triggerRequest = z.object({
  orgUuid: uuid,
  op: z.enum(["create", "update", "fork", "approve_create"]),
  subjectId: z
    .string()
    .max(512)
    .regex(/^[\x20-\x7e]*$/),
  fireContentHashHex: sha256,
  bindToThisDevice: z.boolean(),
});

interface DeviceProofContext {
  accountId: string;
  orgId?: string;
  rowPk?: string;
  issuedAtMs?: number;
}

interface SignedProof {
  kid: string;
  signatureP1363B64: string;
  issuedAtMs: number;
}

type DeviceProofResult =
  | string
  | { signatureP1363B64: string }
  | SignedProof
  | { signed: SignedProof & { rowPk: string } };

type EncodedDeviceProof =
  | {
      ok: true;
      preimage: Buffer;
      formatResult(signatureP1363B64: string): DeviceProofResult;
    }
  | { ok: false; code: "bad_input"; message: string };

function badInput(message: string): EncodedDeviceProof {
  return { ok: false, code: "bad_input", message };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function terminated(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function isUploadPath(value: string): boolean {
  const filename =
    /^\/mnt\/user-data\/uploads\/([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]*)?)$/u.exec(
      value,
    )?.[1];
  if (filename === undefined || Buffer.byteLength(filename, "utf8") > 210)
    return false;
  const reminderName = filename
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\u00df/g, "ss")
    .replace(/\p{Pd}/gu, "-")
    .replace(/[^a-z-]/g, "");
  return (
    !/s-*y-*s-*t-*e-*m-+r-*e-*m-*i-*n-*d-*e-*r/.test(reminderName) &&
    filename
      .normalize("NFKC")
      .replace(/[\p{M}\p{C}\u115F\u1160]/gu, "")
      .trim() !== ""
  );
}

export function encodeDeviceProof(
  op: string,
  args: readonly unknown[],
  { accountId, orgId, rowPk, issuedAtMs }: DeviceProofContext,
): EncodedDeviceProof {
  if (!isUuid(accountId))
    return badInput("DeviceRegistry: malformed accountUuid");
  if (op === "signAttestationPreimage") {
    const [, preimageB64] = args;
    if (typeof preimageB64 !== "string")
      return badInput("DeviceRegistry: malformed attestation preimage");
    const preimage = Buffer.from(preimageB64, "base64");
    if (
      !preimage.subarray(0, attestationDomain.length).equals(attestationDomain)
    ) {
      return badInput(
        "DeviceRegistry: preimage domain tag not in the allowlist",
      );
    }
    return {
      ok: true,
      preimage,
      formatResult: (signatureP1363B64) => ({ signatureP1363B64 }),
    };
  }

  if (!isUuid(orgId)) return badInput("DeviceRegistry: malformed orgUuid");
  if (
    !isUuid(rowPk) ||
    issuedAtMs === undefined ||
    !Number.isSafeInteger(issuedAtMs) ||
    issuedAtMs < 0
  ) {
    return badInput("DeviceRegistry: malformed proof registration");
  }
  const account = uuidBytes(accountId);
  const org = uuidBytes(orgId);
  const row = uuidBytes(rowPk);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(issuedAtMs));
  const kid = `creg_${rowPk}`;
  const signed = (signatureP1363B64: string): SignedProof => ({
    kid,
    signatureP1363B64,
    issuedAtMs,
  });
  const proof = (parts: Buffer[]): EncodedDeviceProof => ({
    ok: true,
    preimage: Buffer.concat(parts),
    formatResult: signed,
  });

  const [, request, subject, expected] = args;
  switch (op) {
    case "signForSessionHeader": {
      if (!isUuid(subject))
        return badInput("DeviceRegistry: malformed sessionUuid");
      return {
        ok: true,
        preimage: Buffer.concat([
          Buffer.from("anthropic.ccr.stream_connect.v1"),
          uuidBytes(subject),
          row,
          timestamp,
        ]),
        formatResult: (signatureP1363B64) =>
          `${kid}.${issuedAtMs}.${Buffer.from(signatureP1363B64, "base64").toString("base64url")}`,
      };
    }
    case "signCreateSessionBind":
      return proof([
        Buffer.from("anthropic.ccr.create_session_bind.v1"),
        org,
        account,
        row,
        timestamp,
      ]);
    case "signSessionBind":
    case "signConversationBind":
    case "signProjectThreadLink": {
      if (!isUuid(subject))
        return badInput("DeviceRegistry: malformed bind subject UUID");
      if (expected !== null && (!isUuid(expected) || expected === zeroUuid)) {
        return badInput(
          "DeviceRegistry: malformed expectedCurrentDeviceId (use null for unbound)",
        );
      }
      return proof([
        Buffer.from(bindDomains[op]),
        org,
        account,
        uuidBytes(subject),
        uuidBytes(expected ?? zeroUuid),
        row,
        timestamp,
      ]);
    }
    case "signTriggerOp":
    case "signTriggerDigest": {
      const parsed = triggerRequest.safeParse(
        op === "signTriggerDigest"
          ? request
          : {
              orgUuid: request,
              op: subject,
              subjectId: expected,
              fireContentHashHex: args[4],
              bindToThisDevice: false,
            },
      );
      if (!parsed.success)
        return badInput("DeviceRegistry: malformed trigger request");
      const {
        op: action,
        subjectId,
        fireContentHashHex,
        bindToThisDevice,
      } = parsed.data;
      if ((action === "create") !== (subjectId === "")) {
        return badInput(
          "DeviceRegistry: subjectId must be empty for create, set for every other op",
        );
      }
      if (
        action === "approve_create" &&
        (!bindToThisDevice ||
          !/^cse_[A-Za-z0-9_]+\/[A-Za-z0-9_-]{1,256}$/.test(subjectId))
      ) {
        return badInput(
          "DeviceRegistry: approve_create requires a bound device and a <cse_ sessionId>/<toolUseId> subjectId",
        );
      }
      const parts = [
        terminated("anthropic.ccr.trigger.v1"),
        org,
        account,
        terminated(action),
        terminated(subjectId),
        timestamp,
        Buffer.from(fireContentHashHex, "hex"),
      ];
      if (op === "signTriggerOp") return proof(parts);
      if (bindToThisDevice) parts.push(row);
      return {
        ok: true,
        preimage: Buffer.concat(parts),
        formatResult: (signatureP1363B64) => ({
          signed: { ...signed(signatureP1363B64), rowPk },
        }),
      };
    }
    case "signSessionRequest": {
      const parsed = sessionRequest.safeParse(request);
      if (!parsed.success)
        return badInput("DeviceRegistry: malformed session request");
      const data = parsed.data;
      const parts = [
        terminated(`anthropic.ccr.${data.surface}.v1`),
        uuidBytes(data.sessionUuid),
        row,
        timestamp,
      ];
      if (data.surface === "session_synced_file_put") {
        parts.push(
          Buffer.from(data.contentSha256Hex, "hex"),
          terminated(data.path),
          terminated(data.ifMatchSha256),
        );
      } else if (data.surface === "session_composer_notice_dismiss") {
        parts.push(terminated(data.noticeId));
      }
      return proof(parts);
    }
    case "signSessionFileCopy": {
      const parsed = fileCopyRequest.safeParse(request);
      if (!parsed.success)
        return badInput(
          "DeviceRegistry: signSessionFileCopy requires a Files API id and one plain file name in the uploads folder",
        );
      const { sessionUuid, fileId, mountPath } = parsed.data;
      return proof([
        terminated("anthropic.ccr.session_file_add.v1"),
        uuidBytes(sessionUuid),
        row,
        timestamp,
        terminated(fileId),
        terminated(mountPath),
      ]);
    }
    default:
      return badInput("DeviceRegistry: unsupported signing method");
  }
}
