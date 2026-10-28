export const approvalPrefix = "chat-device:";

export const scopeOf = (accountScope: string) => ({
  version: 1 as const,
  accountScope,
  organizationId: null,
});
