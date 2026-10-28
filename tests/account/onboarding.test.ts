import assert from "node:assert/strict";
import test from "node:test";
import {
  hearAboutSources,
  noOnboarding,
  onboardingBody,
  onboardingFrom,
} from "../../shared/onboarding-api";
import { createOnboardingMethods } from "../../src-web/bridge/onboarding";
import {
  nextStep,
  saveStep,
  savedStep,
  shuffledWithOtherLast,
  stepShown,
} from "../../src/onboarding/onboarding-steps";
import { firstTasks, firstTasksFor } from "../../src/onboarding/first-tasks";
import {
  normalizeWorkType,
  profileInstructions,
  workTypes,
} from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";

test("the service's answer reads as the window's state; anything unknown is dropped", () => {
  assert.deepEqual(onboardingFrom(undefined), noOnboarding);
  assert.deepEqual(
    onboardingFrom({
      pending: true,
      answers: {
        work_function: "SoftwareEngineer",
        hear_about: "social_media",
        hear_about_platform: "reddit",
        hear_about_other: "",
        code_setup: "desktop",
        connected_tools: ["Linear", 3],
        first_task: "",
      },
    }),
    {
      pending: true,
      answers: {
        workFunction: "SoftwareEngineer",
        hearAbout: "social_media",
        hearAboutPlatform: "reddit",
        codeSetup: "desktop",
        connectedTools: ["Linear"],
      },
    },
  );
  const odd = onboardingFrom({
    pending: "yes",
    answers: {
      work_function: "Astronaut",
      hear_about: "radio",
      code_setup: "cli",
    },
  });
  assert.deepEqual(odd, { pending: false, answers: {} });
});

test("only the answers given are sent, hear_about with its platform and text", () => {
  assert.deepEqual(onboardingBody({ workFunction: "Design" }), {
    work_function: "Design",
  });
  assert.deepEqual(
    onboardingBody({ hearAbout: "other", hearAboutOther: "a forum" }, true),
    {
      hear_about: "other",
      hear_about_platform: "",
      hear_about_other: "a forum",
      finished: true,
    },
  );
  assert.deepEqual(
    onboardingBody({ connectedTools: [], firstTask: "own_topic" }),
    {
      connected_tools: [],
      first_task: "own_topic",
    },
  );
});

test("the web bridge reads and saves the onboarding on the service", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const methods = createOnboardingMethods({
    json: async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      return {
        code: 0,
        data: {
          pending: !init,
          answers: { work_function: "Founder" },
        },
      };
    },
  } as never);
  assert.deepEqual(await methods.onboardingState(), {
    pending: true,
    answers: { workFunction: "Founder" },
  });
  assert.deepEqual(
    await methods.saveOnboarding({ firstTask: "fnd_update" }, true),
    { pending: false, answers: { workFunction: "Founder" } },
  );
  assert.equal(calls[0]?.[0], "/api/v1/claudex/onboarding");
  assert.equal(calls[1]?.[1]?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1]?.[1]?.body)), {
    first_task: "fnd_update",
    finished: true,
  });
  // A service that can't answer shows nothing.
  const broken = createOnboardingMethods({
    json: async () => {
      throw new Error("offline");
    },
  } as never);
  assert.deepEqual(await broken.onboardingState(), noOnboarding);
});

test("steps follow the original's order; Set up and start coding only for coding roles", () => {
  assert.equal(nextStep("work", "SoftwareEngineer"), "code");
  assert.equal(nextStep("work", "Product Management"), "code");
  assert.equal(nextStep("work", "Writer"), "connect");
  assert.equal(nextStep("code", "Founder"), "connect");
  assert.equal(nextStep("connect", "Writer"), "hear");
  assert.equal(nextStep("hear", "Writer"), "first");
  assert.equal(nextStep("first", "Writer"), undefined);
  assert.equal(stepShown("code", "Legal"), false);
  assert.equal(stepShown("code", undefined), false);
});

test("a reload opens on the step reached; without a role it starts over", () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  try {
    assert.equal(savedStep("a1", "Writer"), "work");
    saveStep("a1", "hear");
    assert.equal(savedStep("a1", "Writer"), "hear");
    assert.equal(savedStep("a1", undefined), "work");
    assert.equal(savedStep("a2", "Writer"), "work");
    saveStep("a1", "code");
    assert.equal(savedStep("a1", "Writer"), "work", "a step the role skips");
    saveStep("a1", undefined);
    assert.equal(store.size, 0);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  // Storage that throws: the first step.
  assert.equal(savedStep("a1", "Writer"), "work");
});

test("How did you get here? is shuffled with Other last", () => {
  let seed = 0.37;
  const random = () => (seed = (seed * 9301 + 0.49297) % 1);
  const list = shuffledWithOtherLast(hearAboutSources, random);
  assert.equal(list.length, hearAboutSources.length);
  assert.equal(list.at(-1)?.value, "other");
  assert.deepEqual(
    [...list.map((entry) => entry.value)].sort(),
    hearAboutSources.map((entry) => entry.value).sort(),
  );
});

test("every work type has three starter tasks; none chosen reads as Other", () => {
  for (const { value } of workTypes) {
    const tasks = firstTasks[value];
    assert.equal(tasks.length, 3, value);
    for (const task of tasks) {
      assert.match(task.id, /^[a-z][a-z0-9_]*$/);
      assert.ok(task.title && task.prompt, task.id);
    }
  }
  assert.equal(firstTasksFor(undefined), firstTasks.Other);
  assert.equal(firstTasksFor("SoftwareEngineer")[0]?.id, "swe_review_pr");
});

test("the work type is the original's role list; Claudex's earlier ones are read as their roles", () => {
  assert.equal(workTypes.length, 20);
  assert.equal(normalizeWorkType("engineering"), "SoftwareEngineer");
  assert.equal(normalizeWorkType("education"), "Educator");
  assert.equal(normalizeWorkType("Data Science"), "Data Science");
  assert.equal(normalizeWorkType("toString"), undefined);
  assert.equal(normalizeWorkType(3), undefined);
  assert.equal(preferenceFields.workType.parse("writing"), "Writer");
  assert.equal(preferenceFields.workType.parse(undefined), undefined);
  assert.equal(preferenceFields.workType.parse("astronaut"), undefined);
  assert.equal(
    profileInstructions({ workType: "SoftwareEngineer" }),
    "The user's work: software engineer.",
  );
  assert.equal(
    profileInstructions({ workType: "research" as never }),
    "The user's work: researcher.",
  );
});

test("a new account opens on the role question with Continue off until a role is chosen", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: OnboardingFlow } =
    await import("../../src/onboarding/OnboardingFlow");
  const render = (workType?: "Writer") =>
    renderToStaticMarkup(
      createElement(OnboardingFlow, {
        accountId: "a9",
        initial: { pending: true, answers: {} },
        workType,
        onWorkType: () => {},
        onOpenConnectors: () => {},
        onOpenSystem: () => {},
        platform: "darwin",
        onFinish: () => {},
      }),
    );
  const html = render();
  assert.match(html, /What kind of work do you do\?/);
  // The role field is a menu button (not a native select) showing its
  // placeholder until a role is chosen.
  assert.doesNotMatch(html, /<select/);
  assert.match(
    html,
    /<button[^>]*aria-label="Search for your role"[^>]*aria-haspopup="menu"[^>]*><span>Search for your role<\/span>/,
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  // A role from Settings is the starting value.
  assert.doesNotMatch(render("Writer"), /disabled=""[^>]*>Continue/);
  assert.match(render("Writer"), /<span>Writer<\/span>/);
});
