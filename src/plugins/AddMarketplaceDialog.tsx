import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHost } from "../host/HostContext";
import type { GitHubRepository, GitHubStatus } from "../../shared/github-api";
import { useDismiss } from "../ui/useDismiss";
import { marketplaceAddError, pluginErrorText } from "./plugin-model";
import {
  usePluginOwner,
  isPluginOperationRetired,
  type PluginsState,
} from "./usePlugins";
import "../settings/directory/directory.css";
import "../collections/customize/customize.css";
import "../collections/customize/customize-directory.css";
import "./plugins.css";
import "./plugin-lifecycle.css";
import "../collections/customize/customize-yours.css";
import { addMarketplaceView } from "./AddMarketplaceView";

/**
 * Add marketplace: Anthropic's, or a GitHub owner/repo or Git address the
 * runtime syncs. The repository step keeps the original's trust warning.
 */
/** Uses the same accepted sources as PluginService: owner/repo or credential-free HTTPS. */
export function marketplaceInputError(value: string): string | undefined {
  const source = value.trim();
  if (!source) return "Enter a GitHub repository or a Git URL.";
  if (source.length > 500) return "That address is too long.";
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,98}\/[A-Za-z0-9._-]{1,100}$/.test(source))
    return;
  try {
    const url = new URL(source);
    if (
      url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password
    )
      return;
  } catch {}
  return "Use a GitHub owner/repo or an https:// address of a Git repository.";
}

// The default-source picker is server backed in readable1016 cda3634bf:31–93.
// Public GitHub sources are also listed in c6f6cf4c2:2089–2120; the signed-in
// sources capture supplies the Healthcare and Claude Tag rows and display order.
export const anthropicSources = [
  {
    id: "anthropic-plugin-directory",
    title: "Directory",
    source: undefined,
  },
  {
    id: "knowledge-work-plugins",
    title: "Knowledge Work",
    source: "anthropics/knowledge-work-plugins",
  },
  {
    id: "life-sciences",
    title: "Life Sciences",
    source: "anthropics/life-sciences",
  },
  {
    id: "financial-services",
    title: "Financial Services",
    source: "anthropics/financial-services",
  },
  {
    id: "claude-for-legal",
    title: "Legal",
    source: "anthropics/claude-for-legal",
  },
  {
    id: "claude-tag-plugins",
    title: "Claudex Tag",
    source: "anthropics/claude-tag-plugins",
  },
  { id: "healthcare", title: "Healthcare", source: "anthropics/healthcare" },
] as const;

export function githubMarketplaceSource(
  value: string | undefined,
): string | undefined {
  if (!value) return;
  let source = value.trim();
  if (source.startsWith("https://")) {
    try {
      const url = new URL(source);
      if (
        url.hostname !== "github.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return;
      source = url.pathname.slice(1).replace(/\/$/, "");
    } catch {
      return;
    }
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}\/[A-Za-z0-9._-]{1,100}$/.test(source)
    ? source.replace(/\.git$/i, "").toLowerCase()
    : undefined;
}

export function AnthropicSourceMark() {
  // Verbatim mark used by 1016 cda3634bf:128 → c89362a96:1572 → c7a185bac:12–25.
  return (
    <svg
      viewBox="0 0 28 28"
      width={20}
      height={20}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20 4h-4.3l7.7 19.5h4.2L20 4ZM7.6 4 0 23.5h4.3L6 19.4h8l1.6 4h4.3L12.1 4H7.7Zm-.4 11.8 2.6-6.9 2.7 6.9H7.3Z" />
    </svg>
  );
}

export function AddMarketplaceDialog({
  plugins,
  onClose,
  onAdded,
}: {
  plugins: PluginsState;
  onClose: () => void;
  onAdded: () => void;
}) {
  const host = useHost();
  const { scope, bridge, current: ownsDialog } = usePluginOwner();
  const [step, setStep] = useState<"choose" | "repository" | "anthropic">(
    "choose",
  );
  const [url, setUrl] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [querySubmitted, setQuerySubmitted] = useState(false);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const pickerPopup = useRef<HTMLDivElement>(null);
  const [pickerPosition, setPickerPosition] = useState<{
    left: number;
    top: number;
    width: number;
  }>();
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);
  const requestPending = useRef(false);
  const [github, setGithub] = useState<GitHubStatus>();
  const [githubFailure, setGithubFailure] = useState("");
  const [githubRevision, setGithubRevision] = useState(0);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searchFailure, setSearchFailure] = useState("");
  const searchGeneration = useRef(0);
  const [searchRevision, setSearchRevision] = useState(0);
  useLayoutEffect(() => {
    searchGeneration.current++;
    requestPending.current = false;
    setPending(false);
    setStep("choose");
    setUrl("");
    setRepositoryQuery("");
    setQuerySubmitted(false);
    setPickerPosition(undefined);
    setFailure("");
    setGithub(undefined);
    setGithubFailure("");
    setRepositories([]);
    setSearchOpen(false);
    setSearching(false);
    setNextPage(null);
    setTruncated(false);
    setSearchFailure("");
  }, [scope]);
  const connected = Boolean(github?.configured && github.connected);
  const validation = url.trim() ? marketplaceInputError(url) : undefined;
  const queryValidation = repositoryQuery.trim()
    ? marketplaceInputError(repositoryQuery)
    : undefined;
  const closePicker = () => {
    if (!ownsDialog()) return;
    setSearchOpen(false);
    pickerAnchor.current?.focus();
  };
  useDismiss([pickerAnchor, pickerPopup], searchOpen, closePicker);
  const openPicker = () => {
    if (!ownsDialog() || pending || plugins.busy !== undefined) return;
    const rect = pickerAnchor.current!.getBoundingClientRect();
    setPickerPosition({
      left: rect.left,
      top: rect.bottom + 6,
      width: rect.width,
    });
    setRepositoryQuery(url);
    setQuerySubmitted(false);
    setSearchOpen(true);
  };
  const selectRepository = (source: string) => {
    if (!ownsDialog()) return;
    setQuerySubmitted(true);
    if (marketplaceInputError(source)) return;
    setUrl(source.trim());
    setFailure("");
    closePicker();
  };
  useEffect(() => {
    if (step !== "repository" || !ownsDialog() || !bridge) return;
    let live = true;
    setGithubFailure("");
    void bridge
      .githubStatus()
      .then((status) => {
        if (live && ownsDialog()) setGithub(status);
      })
      .catch((error) => {
        if (live && ownsDialog()) setGithubFailure(pluginErrorText(error));
      });
    return () => {
      live = false;
    };
  }, [step, githubRevision, scope, bridge, ownsDialog]);
  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!ownsDialog() || !bridge) return;
    if (
      step !== "repository" ||
      !connected ||
      !searchOpen ||
      /^https?:/i.test(repositoryQuery)
    ) {
      setSearching(false);
      setRepositories([]);
      setNextPage(null);
      setSearchFailure("");
      setTruncated(false);
      return;
    }
    setSearching(true);
    setSearchFailure("");
    setRepositories([]);
    setNextPage(null);
    const timer = setTimeout(() => {
      if (!ownsDialog()) return;
      void bridge
        .githubRepositories({ query: repositoryQuery.trim(), page: 1 })
        .then((result) => {
          if (!ownsDialog() || generation !== searchGeneration.current) return;
          setRepositories(result.items);
          setNextPage(result.nextPage);
          setTruncated(result.truncated);
        })
        .catch((error) => {
          if (ownsDialog() && generation === searchGeneration.current)
            setSearchFailure(pluginErrorText(error));
        })
        .finally(() => {
          if (ownsDialog() && generation === searchGeneration.current)
            setSearching(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      searchGeneration.current++;
    };
  }, [
    step,
    connected,
    searchOpen,
    repositoryQuery,
    searchRevision,
    scope,
    bridge,
    ownsDialog,
  ]);
  const loadMore = async () => {
    if (!ownsDialog() || !bridge || searching || nextPage === null) return;
    const generation = searchGeneration.current;
    setSearching(true);
    setSearchFailure("");
    try {
      const result = await bridge.githubRepositories({
        query: repositoryQuery.trim(),
        page: nextPage,
      });
      if (!ownsDialog() || generation !== searchGeneration.current) return;
      setRepositories((old) => [
        ...old,
        ...result.items.filter(
          (item) =>
            !old.some((existing) => existing.fullName === item.fullName),
        ),
      ]);
      setNextPage(result.nextPage);
      setTruncated(result.truncated);
    } catch (error) {
      if (ownsDialog() && generation === searchGeneration.current)
        setSearchFailure(pluginErrorText(error));
    } finally {
      if (ownsDialog() && generation === searchGeneration.current)
        setSearching(false);
    }
  };
  const busy = pending || plugins.busy !== undefined;
  const close = () => {
    if (!ownsDialog() || requestPending.current || busy) return;
    if (searchOpen) closePicker();
    else onClose();
  };
  const add = async (source: string, closeWhenAdded = true) => {
    if (!ownsDialog() || requestPending.current || plugins.busy !== undefined)
      return;
    const error = marketplaceInputError(source);
    if (error) {
      setFailure(error);
      return;
    }
    requestPending.current = true;
    setSearchOpen(false);
    setPending(true);
    setFailure("");
    try {
      await plugins.addMarketplace(source.trim());
      if (!ownsDialog()) return;
      onAdded();
      if (!ownsDialog()) return;
      if (closeWhenAdded) onClose();
    } catch (error) {
      if (ownsDialog() && !isPluginOperationRetired(error))
        setFailure(marketplaceAddError(error));
    } finally {
      if (ownsDialog()) {
        requestPending.current = false;
        setPending(false);
      }
    }
  };
  const addMarketplaceViewView = addMarketplaceView({
    add,
    busy,
    close,
    closePicker,
    connected,
    failure,
    github,
    githubFailure,
    host,
    loadMore,
    nextPage,
    onClose,
    openPicker,
    ownsDialog,
    pickerAnchor,
    pickerPopup,
    pickerPosition,
    plugins,
    querySubmitted,
    queryValidation,
    repositories,
    repositoryQuery,
    searchFailure,
    searchOpen,
    searching,
    selectRepository,
    setGithubRevision,
    setQuerySubmitted,
    setRepositoryQuery,
    setSearchRevision,
    setStep,
    step,
    truncated,
    url,
    validation,
  });
  return addMarketplaceViewView;
}
