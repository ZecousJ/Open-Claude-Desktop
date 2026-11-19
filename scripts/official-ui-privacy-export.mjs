export const privacyExportAsset = "cd1a8ef40-3ja8tQUN.js";
export const privacyExportChinese = {
  "claudex.privacy.export.device": "将本机保存的数据导出为 ZIP。日期范围只影响对话。",
  "claudex.privacy.export.service": "将账号数据下载为 ZIP。日期范围只影响对话。",
  "claudex.privacy.export.saved": "数据已导出。",
  "claudex.privacy.export.failed": "暂时无法导出数据。请重试。",
  "claudex.privacy.export.settings": "设置",
  "claudex.privacy.export.files": "上传的文件",
  "claudex.privacy.export.artifacts": "Artifacts",
};

export function derivePrivacyExportCopy(source) {
  const replace = (before, after) => {
    const first = source.indexOf(before);
    if (first === -1 || source.indexOf(before, first + before.length) !== -1)
      throw Error("Pinned privacy export anchor did not match: " + before.slice(0, 200));
    source = source.replace(before, after);
  };
  replace(
    'function Y({ isAuditLogs: e, ownDataOnly: n }) {',
    `function Y({ isAuditLogs: e, ownDataOnly: n, hostExport }) {
  const [exportState, setExportState] = t({ pending: false });`,
  );
  replace(
    '      (r.track({\n        event_key: "claudeai.settings.export_data.submitted",',
    `      if (hostExport) {
        if (exportState.pending) return;
        setExportState({ pending: true });
        void hostExport.save(t).then(
          (saved) => setExportState({ pending: false, saved }),
          () => setExportState({ pending: false, failed: true }),
        );
        return;
      }
      (r.track({
        event_key: "claudeai.settings.export_data.submitted",`,
  );
  replace('[j, e, n, D, T, _, x, S, u, r, N]);', '[j, e, n, D, T, _, x, S, u, r, N, hostExport, exportState.pending]);');
  replace('    showIncludeFileContent: u && !e && !n,', '    showIncludeFileContent: u && !e && !n && !hostExport,');
  replace('    isPending: P,', '    isPending: hostExport ? exportState.pending : P,\n    exportState,\n    hostExport,');
  const start = source.indexOf("function Z({ onBack: e, ownDataOnly: t }) {");
  const end = source.indexOf("function ie() {", start);
  if (start === -1 || end === -1) throw Error("Pinned personal export view did not match.");
  source = source.slice(0, start) + `function Z({ onBack: e, ownDataOnly: t }) {
  const hostExport = window.__claudexAccountExport;
  const n = Y({ isAuditLogs: false, ownDataOnly: t, hostExport });
  const description = hostExport?.scope === "device"
    ? { defaultMessage: "Save a ZIP of data stored on this device. The date range applies to conversations.", id: "claudex.privacy.export.device" }
    : hostExport?.scope === "service"
      ? { defaultMessage: "Download a ZIP of your account data. The date range applies to conversations.", id: "claudex.privacy.export.service" }
      : { defaultMessage: "A download link will be sent to your email. Link expires in 24 hours.", id: "uPFTNM" };
  return s(R, {
    onBack: e,
    title: s(k, { defaultMessage: "Export data", id: "7WvgyzdB8p" }),
    description: s(k, description),
    action: s(p, {
      variant: "primary",
      busy: n.isPending,
      disabled: !n.account || n.customRangeInvalid || n.isPending,
      onClick: () => {
        n.submit();
        if (!hostExport) e();
      },
      "data-testid": "export-confirm-button",
      children: s(k, { defaultMessage: "Export", id: "SVwJTM5AmL" }),
    }),
    children: r(i, {
      children: [
        s(Q, { form: n }),
        n.exportState.failed && s("p", {
          role: "alert",
          className: "text-danger",
          children: s(k, { defaultMessage: "Data could not be exported. Please try again.", id: "claudex.privacy.export.failed" }),
        }),
        n.exportState.saved && s("p", {
          role: "status",
          className: "text-secondary",
          children: s(k, { defaultMessage: "Data exported.", id: "claudex.privacy.export.saved" }),
        }),
      ],
    }),
  });
}
` + source.slice(end);
  replace(
    "                points: C\n",
    `                points: e.hostExport
                  ? [
                      { text: s(k, { defaultMessage: "Conversations", id: "1udzha" }) },
                      { text: s(k, { defaultMessage: "Projects", id: "UxTJRa" }) },
                      { text: s(k, { defaultMessage: "Settings", id: "claudex.privacy.export.settings" }) },
                      ...(e.hostExport.scope === "service" ? [
                        { text: s(k, { defaultMessage: "Uploaded files", id: "claudex.privacy.export.files" }) },
                        { text: s(k, { defaultMessage: "Artifacts", id: "claudex.privacy.export.artifacts" }) },
                      ] : []),
                    ]
                  : C
`,
  );
  return source;
}
