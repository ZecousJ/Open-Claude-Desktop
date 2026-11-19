export const privacyControlsAsset = "cc5f29bb3-BXhX9Yk_.js";
export const privacyControlsChinese = {
  "claudex.privacy.storage": "本机会话保存在此电脑上。云端会话和同步数据由你的 Claudex 服务保存。模型请求适用接收方的数据政策。",
  "claudex.privacy.location": "将服务提供的大致位置（城市、地区和国家或地区）添加到对话和 Cowork 的模型请求中。",
  "claudex.privacy.reporting": "帮助改进 Claudex",
  "claudex.privacy.reporting.description": "允许向你的 Claudex 服务发送错误报告和回复反馈。错误报告不含提示词。仅当你选择随反馈附上对话时，才会发送对话摘录。",
  "claudex.privacy.reporting.error": "无法保存报告设置。请重试。",
  "claudex.privacy.uploads.scope": "这里只列出保存在这台电脑上的附件副本。删除副本后，从文件提取并已保存在对话里的文字仍会保留。",
  "claudex.privacy.uploads.partial": "有些附件副本未能列出。",
  "claudex.privacy.feedback.scope": "查看发送给你的 Claudex 服务的回复反馈。",
  "claudex.privacy.feedback.excerpt": "已附上对话摘录",
};

export function derivePrivacyControls(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw Error("Pinned privacy controls anchor did not match: " + before.slice(0, 120));
    source = source.replace(before, after);
  };
  replace(
    "function Aa() {",
    `function claudexPrivacyPath(org, action) {
  return "/api/organizations/" + org + "/__claudex/privacy/" + action;
}
async function claudexPrivacyRequest(org, action, options) {
  const response = await fetch(claudexPrivacyPath(org, action), options);
  if (!response.ok) throw Error("Privacy request failed");
  return response.json();
}
const claudexReportingLabel = { defaultMessage: "Help improve Claudex", id: "claudex.privacy.reporting" };
function ClaudexReporting({ org, status, queryKey }) {
  const intl = J(), client = at();
  const [pending, setPending] = o(false), [failed, setFailed] = o(false);
  async function save(consented) {
    setPending(true);
    setFailed(false);
    try {
      const reporting = await claudexPrivacyRequest(org, "reporting", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consented }),
      });
      client.setQueryData(queryKey, (current) => ({ ...current, reporting }));
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return g(De, {
    label: g(q, claudexReportingLabel),
    description: l(u, { children: [
      g(q, { defaultMessage: "Allow error reports and reply feedback to be sent to your Claudex service. Error reports contain no prompts. A conversation excerpt is sent only when you choose to include it with feedback.", id: "claudex.privacy.reporting.description" }),
      failed && g("p", { role: "alert", children: g(q, { defaultMessage: "The reporting preference could not be saved. Try again.", id: "claudex.privacy.reporting.error" }) }),
    ] }),
    control: g(P, { checked: status.consented, disabled: pending, onCheckedChange: save, "aria-label": intl.formatMessage(claudexReportingLabel) }),
  });
}
const claudexFeedbackLabel = { defaultMessage: "Your feedback", id: "05vLZxGUnU" };
const claudexWithdrawLabel = { defaultMessage: "Withdraw", id: "PXAur5" };
function ClaudexFeedback({ onBack, org }) {
  const intl = J(), queryClient = at(), back = s(null);
  const queryKey = ["claudex-privacy-feedback", org];
  const { data, isPending, isFetchingNextPage, hasNextPage, fetchNextPage, error } = I(
    claudexPrivacyPath(org, "feedback"),
    { queryKey, pageParamName: "cursor", nextPageField: "nextCursor", staleTime: 0, meta: { noToast: true } },
  );
  const [selected, setSelected] = o(null), [pending, setPending] = o(false), [failed, setFailed] = o(false);
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  async function withdraw() {
    if (!selected || pending) return;
    setPending(true);
    setFailed(false);
    try {
      await claudexPrivacyRequest(org, "feedback/" + encodeURIComponent(selected.id), { method: "DELETE" });
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey });
      back.current?.focus();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return l(Sn, {
    onBack, backButtonRef: back, title: g(q, claudexFeedbackLabel),
    description: g(q, { defaultMessage: "Review reply feedback sent to your Claudex service.", id: "claudex.privacy.feedback.scope" }),
    children: [
      isPending && g("p", { role: "status", children: g(q, { defaultMessage: "Loading…", id: "T4VxQN" }) }),
      error && g(_n, { children: g(q, { defaultMessage: "Couldn’t load your feedback. Refresh and try again.", id: "LzYyLD" }) }),
      !isPending && !error && rows.length === 0 && g(_n, { children: g(q, { defaultMessage: "No feedback found", id: "fdz8ZP" }) }),
      g("ul", { className: "divide-y", children: rows.map((item) => l("li", {
        className: "flex items-start justify-between gap-md py-4",
        children: [
          l("div", { className: "min-w-0 break-words", children: [
            g("p", { children: intl.formatDate(item.createdAt) + " · " + intl.formatMessage(item.rating === "up"
              ? { defaultMessage: "Thumbs up", id: "pOkBLE" } : { defaultMessage: "Thumbs down", id: "eaAnDM" }) }),
            item.categories.length > 0 && g("p", { children: item.categories.join(", ") }),
            item.comment && g("p", { children: item.comment }),
            item.hasExcerpt && g("p", { children: g(q, { defaultMessage: "Conversation excerpt included", id: "claudex.privacy.feedback.excerpt" }) }),
          ] }),
          g(O, { variant: "secondary", onClick: () => { setFailed(false); setSelected(item); }, children: g(q, claudexWithdrawLabel) }),
        ],
      }, item.id)) }),
      hasNextPage && g(O, { variant: "secondary", busy: isFetchingNextPage, onClick: () => fetchNextPage(), children: g(q, { defaultMessage: "Show more", id: "aWpBzjCXKS" }) }),
      g(E, {
        open: !!selected,
        onOpenChange: (open) => { if (!open && !pending) setSelected(null); },
        title: g(q, { defaultMessage: "Withdraw feedback?", id: "m+44xo" }),
        description: l(u, { children: [
          g(q, { defaultMessage: "Withdrawing removes feedback you’ve given.", id: "oofKLI" }),
          failed && g("p", { role: "alert", children: g(q, { defaultMessage: "Feedback couldn’t be withdrawn. Try again.", id: "AzN2SI" }) }),
        ] }),
        confirmLabel: g(q, claudexWithdrawLabel), confirmVariant: "danger",
        closeOnConfirm: false, onConfirm: withdraw,
      }),
    ],
  });
}
function useClaudexPrivacyStatus(privacy, org, queryKey) {
  return ct({
    queryKey,
    queryFn: () => claudexPrivacyRequest(org, "status"),
    enabled: !!privacy && !!org,
    meta: { noToast: true },
  });
}
function Aa() {
  const { account: privacyAccount, activeOrganization: privacyOrganization } = W();
  const privacyOrg = privacyOrganization?.uuid;
  const nativePrivacy = privacyAccount?.claudex_native_privacy;
  const privacy = nativePrivacy?.organization_uuid === privacyOrg ? nativePrivacy : undefined;
  const privacyQueryKey = ["claudex-privacy-status", privacyOrg];
  const { data: privacyStatus, isPending: privacyPending } = useClaudexPrivacyStatus(privacy, privacyOrg, privacyQueryKey);
  const reporting = privacyStatus?.reporting;
  const showReporting = reporting?.diagnostics || reporting?.feedback;`,
  );
  replace("    c = !e || i,", "    c = privacy?.location_metadata && (!e || i),");
  replace(
    "    { show: A, isPending: j } = Ut(e, E),\n    M = Ht(e, E),",
    "    A = !!privacy && !!privacyOrg, j = A && privacyPending,\n    M = A && !j && privacyStatus?.feedback !== false,",
  );
  replace("  let ht = c || x,", "  let ht = c || showReporting,");
  replace(
    "                            children: [c && g(Fa, {}), x && g(Ia, {})],",
    "                            children: [c && g(Fa, {}), showReporting && g(ClaudexReporting, { org: privacyOrg, status: reporting, queryKey: privacyQueryKey })],",
  );
  replace("              ? g(vr, { onBack: Ze })", "              ? g(ClaudexFeedback, { onBack: Ze, org: privacyOrg })");
  const intro = source.indexOf("function ja({ claudeGroveEnabled: e })");
  const afterIntro = source.indexOf("function Ma(", intro);
  if (intro === -1 || afterIntro === -1)
    throw Error("Pinned privacy introduction did not match.");
  source = source.slice(0, intro) + `function ja() {
  return l("div", { className: "flex flex-col gap-sm mb-xl", children: [
    g("h2", { className: "text-heading-semibold text-primary", children: g(q, { defaultMessage: "Privacy", id: "cXBJ7U" }) }),
    g("p", { className: "text-body text-secondary", children: g(q, {
      defaultMessage: "Local sessions are stored on this computer. Your Claudex service stores cloud sessions and synced data. Model requests follow the data policies of the provider that receives them.",
      id: "claudex.privacy.storage",
    }) }),
  ] });
}
` + source.slice(afterIntro);
  replace(
    '        "Allow Claudex to use coarse location metadata (city/region) to improve product experiences. <a>Learn more</a>.",\n      id: "kqcCIk",',
    '        "Include the approximate city, region, and country from your Claudex service in Chat and Cowork model requests.",\n      id: "claudex.privacy.location",',
  );
  replace(
    "`/api/organizations/${t}/account/files?limit=${ra}`",
    'claudexPrivacyPath(t, "uploads")',
  );
  replace(
    '      queryKey: [ie, { orgUuid: t }],\n      staleTime: 0,\n      pageParamName: "cursor",\n      nextPageField: "next_cursor",',
    '      queryKey: [ie, { orgUuid: t }],\n      staleTime: 0,\n      pageParamName: "cursor",\n      nextPageField: "nextCursor",',
  );
  const uploadDelete = source.indexOf("function ua(e, t) {");
  const afterUploadDelete = source.indexOf("function da() {", uploadDelete);
  if (uploadDelete === -1 || afterUploadDelete === -1)
    throw Error("Pinned uploaded file deletion did not match.");
  source = source.slice(0, uploadDelete) +
    'function ua(org, id) { return claudexPrivacyPath(org, "uploads/" + encodeURIComponent(id)); }\n' +
    source.slice(afterUploadDelete);
  const uploadInvalidate = source.indexOf("function fa() {", uploadDelete);
  const afterUploadInvalidate = source.indexOf("var pa =", uploadInvalidate);
  if (uploadInvalidate === -1 || afterUploadInvalidate === -1)
    throw Error("Pinned uploaded file invalidation did not match.");
  source = source.slice(0, uploadInvalidate) + `function fa() {
  const { activeOrganization } = W(), client = at();
  return () => client.invalidateQueries({ queryKey: [ie, { orgUuid: activeOrganization?.uuid }] });
}
` + source.slice(afterUploadInvalidate);
  replace(
    "    m = b(() => a?.pages.flatMap((e) => e.files) ?? [], [a]),",
    `    m = b(() => a?.pages.flatMap((page) => page.items.map((item) => ({
      file_uuid: item.id, file_name: item.name, size_bytes: item.bytes, created_at: item.uploadedAt,
      surface: item.surface, project: null, conversation_uuids: item.locations.map((location) => location.conversationId),
      conversation_names: Object.fromEntries(item.locations.map((location) => [location.conversationId, location.title])),
    }))) ?? [], [a]),`,
  );
  replace(
    '            "Deleting a file removes it from storage. Text already extracted into a chat isn’t removed. To fully remove it, delete the chat.",\n          id: "3JFHhB",',
    '            "Only attachment copies on this computer are listed. Deleting a copy leaves any text already extracted into a conversation.",\n          id: "claudex.privacy.uploads.scope",',
  );
  replace(
    "      (c || N.length > 0 || d) &&",
    `      a?.pages.some((page) => page.skipped || page.truncated) &&
        g("p", { role: "status", children: g(q, { defaultMessage: "Some attachment copies could not be listed.", id: "claudex.privacy.uploads.partial" }) }),
      (c || N.length > 0 || d) &&`,
  );
  replace(
    "        N.length === 0 &&\n        !d &&",
    "        N.length === 0 &&\n        M.size === 0 &&\n        !d &&",
  );
  replace(
    '            children: n.formatDate(e.created_at, {',
    '            children: e.created_at == null ? "—" : n.formatDate(e.created_at, {',
  );
  replace(
    "    return e.surface === \"project\"",
    '    return e.surface === "code" ? g(k, { variant: "neutral", children: g(q, { defaultMessage: "Code", id: "h2vipu" }) }) : e.surface === "project"',
  );
  replace(
    '                children: g(A, {\n                  className: "block truncate text-body text-secondary",\n                  title: e.name ?? void 0,\n                  render: g($e, {\n                    href:\n                      e.sessionId === null ? `/chat/${e.conversationUuid}` : `/code/${e.sessionId}`,\n                    webBehavior: "new-tab",\n                    desktopBehavior: "navigate",\n                    rel: "noopener noreferrer",\n                  }),',
    '                children: g("span", { className: "block truncate text-body text-secondary", title: e.name ?? void 0,',
  );
  replace(
    '    i = `${t}/public/artifacts/${e.published_artifact_uuid}`,',
    '    i = e.url ?? `${t}/public/artifacts/${e.published_artifact_uuid}`,',
  );
  return source;
}
