import type { HelpSlug } from "../../shared/help-links";

export const helpArticles: { slug: HelpSlug; title: string; body: string }[] = [
  {
    slug: "skip-approvals-safety",
    title: "Using skip approvals safely",
    body: "Skip all approvals lets tools act without step-by-step confirmation. Only use trusted connectors and computer apps. Turn off individual connectors in the + menu and return to an approval mode before handling sensitive data. App and system permissions still apply.",
  },
  {
    slug: "browser-safety",
    title: "Browser safety",
    body: "Approve only sites you trust. Allowing all browser actions also permits actions on unapproved sites. Check addresses and review payments, uploads, and account changes yourself. Risk warnings are not a guarantee. Keep cookies can retain signed-in sessions; clear browsing data when needed.",
  },
  {
    slug: "cowork-safety",
    title: "Cowork and scheduled task safety",
    body: "Give Cowork access only to folders needed for the task. Review tools and permissions before running or scheduling work. Scheduled tasks can run later without you watching; check their schedule, permission mode, and results, and pause tasks you no longer need.",
  },
  {
    slug: "memory",
    title: "Chat search and memory",
    body: "Chat search retrieves earlier conversations when enabled. Memory can keep useful context for later chats. Manage search, memory, and your memory summary in Settings. Availability depends on your service and policy; incognito chats do not contribute to memory.",
  },
  {
    slug: "personalization",
    title: "Profile and instructions",
    body: "Set your name, work profile, and instructions in Settings → Profile. Instructions guide future replies but do not grant tool permissions. Avoid storing passwords or secrets in your profile or instructions.",
  },
  {
    slug: "files-and-code",
    title: "Files and code execution",
    body: "Code and Cowork can create or edit files and run commands where tools are available. Desktop work uses the selected workspace; web work uses the cloud environment. Chat file execution depends on host capabilities. Review changes and downloads. Cloud network access can be none, trusted domains, custom domains, or full, subject to service policy.",
  },
  {
    slug: "code-security",
    title: "Claudex Code security",
    body: "Local sandbox isolates commands in new Code sessions. Strict sandbox blocks commands that cannot run inside it instead of allowing an outside fallback. Review permission prompts and workspace access. A sandbox reduces risk; it does not make untrusted code safe.",
  },
  {
    slug: "cloud-environments",
    title: "Cloud environment domains",
    body: "These are the runner’s default trusted domains, including their subdomains. The service can configure a different list. Custom mode uses its configured domains. Private addresses and internal hosts remain blocked even with full network access.",
  },
  {
    slug: "connector-review",
    title: "Directory review badges",
    body: "Verified, community, custom, and organization badges describe directory review or origin, not a security guarantee. A badge is not proof of a new Claudex security audit. Read tool permissions and trust the developer before connecting or installing; tools and behavior can change.",
  },
  {
    slug: "directory-terms",
    title: "Directory submission terms",
    body: "Submit only content you have the right to distribute. Describe permissions, data use, and external services accurately. Do not include secrets, malware, or misleading claims. You remain responsible for maintenance and licensing. Claudex may decline or remove unsafe or inaccurate listings; submission does not guarantee publication.",
  },
  {
    slug: "usage-policy",
    title: "Acceptable use policy",
    body: "Use Claudex lawfully and respect privacy, consent, and intellectual property. Do not use it for fraud, malware, unauthorized access, abuse, or harm. Review generated content before acting on it. Your service operator may apply additional rules and restrict access for misuse.",
  },
  {
    slug: "support",
    title: "Contact Claudex support",
    body: "Use the feedback action on a reply to send a report to your Claudex service administrator. Include a description and reproduction steps, but no passwords or keys. Conversation content is included only if you choose it. Feedback availability depends on your service; if it is disabled or you cannot sign in, contact the operator who provided your account.",
  },
  {
    slug: "location-metadata",
    title: "Location metadata",
    body: "Location metadata is a setting for coarse city or region context when supported by your service. It is not permission to read GPS coordinates. You can turn it off in Settings; browser and operating-system location permissions are separate.",
  },
  {
    slug: "developer-docs",
    title: "Build connectors and plugins",
    body: "A connector is an MCP server: it speaks the Model Context Protocol over streamable HTTP, signs people in with OAuth or a token, and describes each tool’s inputs and effects plainly. A plugin bundles skills, connectors and instructions into one package. Add your connector as a custom connector under Customize → Connectors and try it in a chat before you send it with Submit to the directory.",
  },
];
