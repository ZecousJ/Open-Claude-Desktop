import assert from "node:assert/strict";
import test from "node:test";
import {
  accountProfileBody,
  accountProfileFrom,
  ageOn,
  validBirthdate,
  type SignUpProfile,
} from "../../shared/account-profile-api";
import {
  asksBirthday,
  fieldOfReason,
  profileErrors,
  profileFormErrors,
  rememberTerms,
  rememberedTerms,
  splitTemplate,
  updatingTerms,
} from "../../src/auth/profile-step-form";
import { createAccountProfileMethods } from "../../src-web/bridge/account-profile";

const fresh: SignUpProfile = accountProfileFrom(
  {
    display_name: "ada",
    birthdate: "",
    terms_version: "",
    terms_accepted_at: null,
    current_terms_version: "2026-10-12",
    minimum_age: 18,
    complete: false,
  },
  "https://claudex.example/legal/terms",
);

test("the service's answer is read and checked", () => {
  assert.deepEqual(fresh, {
    displayName: "ada",
    birthdate: "",
    termsVersion: "",
    termsAcceptedAt: null,
    currentTermsVersion: "2026-10-12",
    minimumAge: 18,
    complete: false,
    termsUrl: "https://claudex.example/legal/terms",
  });
  const odd = accountProfileFrom(
    {
      display_name: 4,
      birthdate: "12/01/1990",
      terms_version: "x y",
      terms_accepted_at: "2026-10-12T01:02:03Z",
      minimum_age: 500,
      complete: "yes",
    },
    "/t",
  );
  assert.equal(odd.displayName, "");
  assert.equal(odd.birthdate, "");
  assert.equal(odd.termsVersion, "");
  assert.equal(odd.termsAcceptedAt, Date.parse("2026-10-12T01:02:03Z"));
  assert.equal(odd.minimumAge, 18);
  assert.equal(odd.complete, false);
  assert.deepEqual(
    accountProfileBody({
      name: "  Ada ",
      birthdate: "1990-05-17",
      termsVersion: "2026-10-12",
    }),
    {
      display_name: "Ada",
      birthdate: "1990-05-17",
      accept_terms_version: "2026-10-12",
    },
  );
});

test("birthdays: real dates from 1900 to today, ages in whole years", () => {
  const today = "2026-10-12";
  for (const bad of ["", "1899-12-31", "2026-10-13", "2001-02-30", "1990-5-1"])
    assert.equal(validBirthdate(bad, today), false, bad);
  for (const good of ["1900-01-01", "2026-10-12", "2000-02-29"])
    assert.equal(validBirthdate(good, today), true, good);
  assert.equal(ageOn("2008-10-12", today), 18);
  assert.equal(ageOn("2008-10-13", today), 17);
  assert.equal(ageOn("2008-11-01", today), 17);
});

test("the form checks every field at once, with the original's sentences", () => {
  const today = "2026-10-12";
  const all = profileFormErrors(
    { name: " ", birthdate: "", agreed: false },
    fresh,
    today,
  );
  assert.deepEqual(
    [...all],
    [
      ["name", profileErrors.name],
      ["birthday", profileErrors.invalidDate],
      ["terms", profileErrors.terms],
    ],
  );
  const young = profileFormErrors(
    { name: "Ada", birthdate: "2008-10-13", agreed: true },
    fresh,
    today,
  );
  assert.deepEqual([...young], [["birthday", profileErrors.underage]]);
  assert.equal(
    profileFormErrors(
      { name: "Ada", birthdate: "2008-10-12", agreed: true },
      fresh,
      today,
    ).size,
    0,
  );
});

test("an account accepting new terms keeps its birthday", () => {
  const known = {
    ...fresh,
    birthdate: "1990-05-17",
    termsVersion: "2026-01-01",
  };
  assert.equal(asksBirthday(fresh), true);
  assert.equal(asksBirthday(known), false);
  assert.equal(updatingTerms(fresh), false);
  assert.equal(updatingTerms(known), true);
  assert.equal(
    profileFormErrors({ name: "Ada", birthdate: "", agreed: true }, known).size,
    0,
  );
  assert.equal(fieldOfReason("CLAUDEX_PROFILE_UNDERAGE"), "birthday");
  assert.equal(fieldOfReason("CLAUDEX_PROFILE_TERMS"), "terms");
  assert.equal(fieldOfReason("OTHER"), undefined);
});

test("the finished step is remembered per account and storage may fail", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  assert.equal(rememberedTerms(storage, "a"), "");
  rememberTerms(storage, "a", "2026-10-12");
  assert.equal(rememberedTerms(storage, "a"), "2026-10-12");
  assert.equal(rememberedTerms(storage, "b"), "");
  const broken = {
    getItem: () => {
      throw Error("blocked");
    },
    setItem: () => {
      throw Error("blocked");
    },
  };
  assert.equal(rememberedTerms(broken, "a"), "");
  assert.doesNotThrow(() => rememberTerms(broken, "a", "v"));
  assert.equal(rememberedTerms(undefined, "a"), "");
});

test("a sentence is cut at its holes", () => {
  assert.deepEqual(
    splitTemplate("I agree to {terms} and {aup}.", (name) => ({ name })),
    ["I agree to ", { name: "terms" }, " and ", { name: "aup" }, "."],
  );
  assert.deepEqual(
    splitTemplate("{terms}", (name) => name),
    ["terms"],
  );
});

test("the web bridge reads and saves through the service", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  let answer: unknown = {
    code: 0,
    data: { display_name: "ada", current_terms_version: "2026-10-12" },
  };
  const transport = {
    json: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const methods = createAccountProfileMethods(
    transport,
    "https://claudex.example",
  );
  const profile = (await methods.signUpProfile()) as SignUpProfile;
  assert.equal(profile.displayName, "ada");
  assert.equal(profile.termsUrl, "https://claudex.example/legal/terms");
  assert.equal(calls[0].path, "/api/v1/claudex/account-profile");

  answer = { code: 0, data: { complete: true, display_name: "Ada" } };
  const saved = (await methods.saveSignUpProfile({
    name: "Ada",
    birthdate: "1990-05-17",
    termsVersion: "2026-10-12",
  })) as SignUpProfile;
  assert.equal(saved.complete, true);
  assert.equal(calls[1].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    display_name: "Ada",
    birthdate: "1990-05-17",
    accept_terms_version: "2026-10-12",
  });

  // A service without the step answers 404: no step.
  answer = Object.assign(Error("Not found"), { status: 404 });
  assert.equal(await methods.signUpProfile(), null);
  answer = Object.assign(Error("Down"), { status: 503 });
  await assert.rejects(methods.signUpProfile(), /Down/);
});

test("the step draws the original's fields; new terms skip the birthday", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { ProfileStep } = await import("../../src/auth/ProfileStep");
  const draw = (profile: SignUpProfile) =>
    renderToStaticMarkup(
      createElement(ProfileStep, {
        profile,
        email: "ada@example.com",
        onDone: () => {},
        onUseDifferentEmail: () => {},
      }),
    );
  const first = draw(fresh);
  for (const text of [
    "Let’s create your account",
    "So Claudex knows what to call you.",
    "What is your name?",
    "When is your birthday?",
    "Terms of Service",
    "Acceptable Use Policy",
    "Create account",
    "Email verified as ada@example.com",
    "Use a different email",
  ])
    assert.ok(first.includes(text), text);
  assert.ok(first.includes('value="ada"'));
  assert.ok(
    first.includes('href="https://claudex.example/legal/terms#acceptable-use"'),
  );
  const again = draw({
    ...fresh,
    birthdate: "1990-05-17",
    termsVersion: "2026-01-01",
  });
  assert.ok(again.includes("Updates to the Terms of Service"));
  assert.ok(!again.includes("When is your birthday?"));
  assert.ok(again.includes(">Continue<"));
});
