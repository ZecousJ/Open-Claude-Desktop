import test from "node:test";
import assert from "node:assert/strict";
import {
  onboardingBody,
  onboardingFrom,
  scienceFields,
} from "../../shared/onboarding-api";

test("the Scientist role's fields go to the service and come back in the original's order", () => {
  assert.equal(scienceFields.length, 10);
  assert.deepEqual(
    onboardingBody({
      workFunction: "Scientist",
      scienceFields: ["physics", "biology"],
    }),
    { work_function: "Scientist", science_fields: ["physics", "biology"] },
  );
  assert.deepEqual(
    onboardingFrom({
      pending: true,
      answers: { science_fields: ["physics", "alchemy", "biology"] },
    }).answers.scienceFields,
    ["biology", "physics"],
  );
});
