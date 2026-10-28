# Local Office add-in bridge

Settings → Extensions → Microsoft Office → Manage opens the connected-file
picker. **Get the add-in** exports an Office task-pane manifest and its local
HTTPS certificate. The installation needs `openssl` on PATH. Trust the exported
`claudex-office.crt` for HTTPS in your operating system, then sideload
`claudex-office.xml` in Office. Keep Claudex signed in to that account while
using the add-in. Live Office-host installation has not been verified here.

The manifest contains a private bearer capability. Do not share it. Its bridge
listens only on 127.0.0.1, validates Host/Origin and authorization, and closes
on sign-out. The certificate, private key, port and capability live in the
account's `office-addin` profile directory; private files are owner-only.

The task pane registers the open document, receives active-conversation
summaries, and displays explicitly handed-off conversation messages. **Continue
in** in the picker asks for an Office document, queues a two-minute handoff and
opens it through the operating system. Tool calls are excluded. Pending
handoffs can be cancelled. A stale task-pane connection expires after 30 seconds.

This is a local Claudex implementation, not Anthropic's authenticated cloud
Office bridge. Native automatic sideloading, Office agent execution and web-host
Office connections are not implemented. Microsoft Entra and enterprise-managed
Office access policies are outside this personal bridge.
