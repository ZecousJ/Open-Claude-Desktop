import { useContext, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";
import { formatText, useT } from "../i18n";
import {
  skillImportNotice,
  type SkillImportFile,
  type SkillImportOutcome,
} from "../../shared/skill-import";
import { showToast } from "../ui/toast-store";
import { acceptsSkillFile, skillFileTypes } from "../../shared/skill-upload";
import { Button, Row, Section } from "./controls";
import { skillSourceFiles } from "./skill-import-files";

export function SkillImport({
  onError,
  onSkills,
}: {
  onError: (error: unknown) => void;
  onSkills: () => void;
}) {
  const t = useT();
  const app = useContext(AppContext);
  const openSkills = () => {
    if (!app) return onSkills();
    app.setSettingsOpen(false);
    app.setPage("customize");
    window.dispatchEvent(new Event("claudex:customize-skills"));
  };
  const input = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<SkillImportFile[]>([]);
  const [outcomes, setOutcomes] = useState<SkillImportOutcome[]>([]);
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    setBusy(true);
    try {
      const results = await window.desktop.importSkillFiles(files);
      setOutcomes(results.filter((result) => !result.ok));
      const added = results.filter((result) => result.ok).length;
      const remaining = results.length - added;
      setFiles((current) => current.filter((_, index) => !results[index]?.ok));
      if (added) {
        const notice = skillImportNotice(added, remaining);
        showToast(
          [
            formatText(notice.title, { n: added, total: results.length }),
            t(notice.detail),
            notice.remaining && t(notice.remaining),
          ]
            .filter(Boolean)
            .join("\n"),
          { action: { label: t("Skills"), onSelect: openSkills } },
        );
      } else
        showToast(
          t(
            files.length === 1
              ? "Review and add it in Settings › Import."
              : "Review and add them in Settings › Import.",
          ),
        );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (selected: File[], directory: boolean) => {
    setBusy(true);
    try {
      if (!directory && selected.some((file) => !acceptsSkillFile(file.name)))
        throw Error(t("Choose a .md, .zip, or .skill file."));
      if (!directory && selected.length > 20)
        throw Error(t("You can upload up to 20 files at a time."));
      if (!directory && selected.some((file) => file.size > 30 * 1024 * 1024))
        throw Error(t("Skill files are too large to upload."));
      const next = directory
        ? await skillSourceFiles(selected)
        : await Promise.all(
            selected.map(async (file) => ({
              name: file.name,
              data: new Uint8Array(await file.arrayBuffer()),
            })),
          );
      setFiles(next);
      setOutcomes([]);
      if (next.length)
        showToast(
          t(
            next.length === 1
              ? "Review and add it in Settings › Import."
              : "Review and add them in Settings › Import.",
          ),
        );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section>
      <Row
        label="Skills"
        description="Review and add them in Settings › Import."
      >
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept={skillFileTypes.join(",")}
          onChange={(event) => {
            void choose(Array.from(event.target.files ?? []), false);
            event.target.value = "";
          }}
        />
        <input
          ref={folder}
          type="file"
          hidden
          multiple
          {...{ webkitdirectory: "" }}
          onChange={(event) => {
            void choose(Array.from(event.target.files ?? []), true);
            event.target.value = "";
          }}
        />
        <Button disabled={busy} onClick={() => folder.current?.click()}>
          Choose folder
        </Button>
        <Button disabled={busy} onClick={() => input.current?.click()}>
          Choose files
        </Button>
      </Row>
      {files.map((file, index) => {
        const result = outcomes[index];
        return (
          <Row
            key={`${file.name}:${index}`}
            label={<span translate="no">{file.name}</span>}
            description={result && !result.ok ? result.message : undefined}
          >
            <Button
              disabled={busy}
              onClick={() => {
                setFiles((current) =>
                  current.filter((_, position) => position !== index),
                );
                setOutcomes((current) =>
                  current.filter((_, position) => position !== index),
                );
              }}
            >
              Remove
            </Button>
          </Row>
        );
      })}
      {files.length > 0 && (
        <Button primary disabled={busy} onClick={() => void upload()}>
          {busy ? "Uploading..." : "Upload"}
        </Button>
      )}
    </Section>
  );
}
