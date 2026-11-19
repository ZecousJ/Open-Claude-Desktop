import { useEffect, useRef, useState } from "react";
import type { CustomizeSkill } from "../../shared/collections-api";
import { useApp } from "../app/AppContext";
import { formatText, useT } from "../i18n";
import { setPromptPreview } from "../composer/prompt-preview";
import { Anthropicon } from "../ui/anthropicons";

// Finance starters (live claude.ai bundle, 2026-10-14, shared-23-RHw-hr47.js).
export const financePrompts = [
  {
    title: "Template Creator",
    skillName: "anthropic-ppt-template-creator",
    prompt:
      "Create a reusable skill from our firm's template using anthropic-ppt-template-creator. Extract layouts, placeholders, and formatting standards. [attach firm_brand_template.pptx]",
  },
  {
    title: "Deck Checker",
    skillName: "anthropic-fsi-deck-checker",
    prompt:
      "QC the attached management presentation using anthropic-fsi-deck-checker. Check for number consistency, data-narrative alignment, and formatting issues. [attach ProjectBravo_Mgmt_Presentation.pptx]",
  },
  {
    title: "DCF Valuation",
    skillName: "anthropic-fsi-dcf-model-builder",
    prompt:
      "Create a DCF model for [ServiceNow] using anthropic-fsi-dcf-model-builder. Include 5-year projections, WACC calculation, terminal value via exit multiple, and sensitivity on discount rate and growth.",
  },
  {
    title: "Earnings Analysis",
    skillName: "anthropic-fsi-earnings-analysis",
    prompt:
      "Create an earnings update for [CrowdStrike]'s Q3 FY2025 results using anthropic-fsi-earnings-analysis. Cover beat/miss vs. consensus, key drivers, guidance changes, and updated thesis.",
  },
  {
    title: "Company Profile",
    skillName: "anthropic-fsi-strip-profile",
    prompt:
      "Create a single-slide strip profile for [Snowflake] using anthropic-fsi-strip-profile. Include business overview, key metrics, valuation multiples, stock chart, and top shareholders.",
  },
  {
    title: "Pitch Deck",
    skillName: "anthropic-fsi-pitch-deck",
    prompt:
      "Populate the attached pitch deck template with data from the Excel file using anthropic-fsi-pitch-deck. Map financials to appropriate slides and maintain formatting. [attach template.pptx and financials.xlsx]",
  },
  {
    title: "Initiating Coverage",
    skillName: "anthropic-fsi-initiating-coverage",
    prompt:
      "Creating company research on [MongoDB] using anthropic-fsi-initiating-coverage. Start with Task 1 covering business model, competitive positioning, and key investment thesis points.",
  },
  {
    title: "Competitive Analysis",
    skillName: "anthropic-fsi-competitive-analysis",
    prompt:
      "Create a competitive landscape analysis for [Datadog] using anthropic-fsi-competitive-analysis. Include a 2x2 positioning matrix against Splunk, Dynatrace, New Relic, and Elastic, with competitive moats and strategic implications.",
  },
  {
    title: "3-Statement Model",
    skillName: "anthropic-fsi-3-statements",
    prompt:
      "Build an integrated 3-statement model using anthropic-fsi-3-statements. Populate the attached template with [Salesforce]'s FY2022-2024 historicals from their 10-K and project through FY2027. [attach template.xlsx and CRM 10-K.pdf]",
  },
  {
    title: "Comps Analysis",
    skillName: "anthropic-fsi-comps-analysis",
    prompt:
      "Build a comps analysis for [Shopify] using anthropic-fsi-comps-analysis. Include 10 peers with EV/Revenue, EV/EBITDA, and P/E on LTM and NTM basis, plus implied valuation ranges.",
  },
  {
    title: "Datapack Builder",
    skillName: "anthropic-fsi-datapack-builder",
    prompt:
      "Build a data pack for our IC using anthropic-fsi-datapack-builder. Standardize financials from the attached CIM including ARR growth, net retention, and rule of 40 metrics. [attach ProjectAlpha_CIM.pdf]",
  },
] as const;
const icons = [
  "M216,40H136V24a8,8,0,0,0-16,0V40H40A16,16,0,0,0,24,56V176a16,16,0,0,0,16,16H79.36L57.75,219a8,8,0,0,0,12.5,10l29.59-37h56.32l29.59,37a8,8,0,1,0,12.5-10l-21.61-27H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,136H40V56H216V176ZM104,120v24a8,8,0,0,1-16,0V120a8,8,0,0,1,16,0Zm32-16v40a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm32-16v56a8,8,0,0,1-16,0V88a8,8,0,0,1,16,0Z",
  "M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM224,48V208a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32H208A16,16,0,0,1,224,48ZM208,208V48H48V208H208Z",
  "M232,208a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V48a8,8,0,0,1,16,0v94.37L90.73,98a8,8,0,0,1,10.07-.38l58.81,44.11L218.73,90a8,8,0,1,1,10.54,12l-64,56a8,8,0,0,1-10.07.38L96.39,114.29,40,163.63V200H224A8,8,0,0,1,232,208Z",
  "M240,56v64a8,8,0,0,1-16,0V75.31l-82.34,82.35a8,8,0,0,1-11.32,0L96,123.31,29.66,189.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0L136,140.69,212.69,64H168a8,8,0,0,1,0-16h64A8,8,0,0,1,240,56Z",
  "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm40-68a28,28,0,0,1-28,28h-4v8a8,8,0,0,1-16,0v-8H104a8,8,0,0,1,0-16h36a12,12,0,0,0,0-24H116a28,28,0,0,1,0-56h4V72a8,8,0,0,1,16,0v8h16a8,8,0,0,1,0,16H116a12,12,0,0,0,0,24h24A28,28,0,0,1,168,148Z",
];
export function hasFinanceSkills(skills: CustomizeSkill[]) {
  return financePrompts.every((prompt) =>
    skills.some((skill) => skill.name === prompt.skillName),
  );
}

export function FinanceStarters({
  skills,
  onPick,
  onEnabled,
}: {
  skills: CustomizeSkill[];
  onPick: (prompt: string) => void;
  onEnabled: (path: string) => void;
}) {
  const app = useApp();
  const t = useT();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      setPromptPreview(null);
    };
  }, [open]);
  useEffect(() => () => setPromptPreview(null), []);
  const pick = (prompt: (typeof financePrompts)[number]) => {
    setOpen(false);
    setPromptPreview(null);
    const skill = skills.find((value) => value.name === prompt.skillName);
    if (!skill) return;
    if (skill.enabled) onPick(t(prompt.prompt));
    else
      app.setConfirm({
        title: t("Enable skill to continue"),
        body: formatText(
          t(
            "The skill “{skillName}” needs to be enabled to use this prompt. Enable it now?",
          ),
          { skillName: skill.name },
        ),
        confirm: t("Enable skill"),
        danger: false,
        action: async () => {
          await window.desktop.setSkillEnabled(skill.path, true);
          onEnabled(skill.path);
          onPick(t(prompt.prompt));
        },
      });
  };
  return (
    <div className="finance-starters">
      <div className="finance-starter-chips">
        {financePrompts.slice(0, 4).map((prompt, index) => (
          <div
            key={prompt.skillName}
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <button
              className="starter-chip"
              onClick={() => pick(prompt)}
              onMouseEnter={() => setPromptPreview(t(prompt.prompt))}
              onMouseLeave={() => setPromptPreview(null)}
              onFocus={() => setPromptPreview(t(prompt.prompt))}
              onBlur={() => setPromptPreview(null)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 256 256"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d={icons[index]} />
              </svg>
              {t(prompt.title)}
            </button>
          </div>
        ))}
        <div ref={menu} style={{ animationDelay: "200ms" }}>
          <button
            className="starter-chip"
            aria-expanded={open}
            aria-pressed={open}
            onClick={() => setOpen(!open)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 256 256"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d={icons[4]} />
            </svg>
            <span className="finance-starter-category">
              {t("All Finance Skills")}
              <Anthropicon name="CaretDown" />
            </span>
          </button>
          {open && (
            <div className="finance-starter-menu">
              {financePrompts.slice(4).map((prompt) => (
                <button
                  key={prompt.skillName}
                  onClick={() => pick(prompt)}
                  onMouseEnter={() => setPromptPreview(t(prompt.prompt))}
                  onMouseLeave={() => setPromptPreview(null)}
                  onFocus={() => setPromptPreview(t(prompt.prompt))}
                  onBlur={() => setPromptPreview(null)}
                >
                  {t(prompt.title)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
