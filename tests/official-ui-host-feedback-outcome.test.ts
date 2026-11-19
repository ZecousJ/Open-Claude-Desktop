import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import {
  deriveOfficialUiHostFeedbackOutcomeModule as derive,
  hostFeedbackOutcomeHelper as helper,
  hostFeedbackOutcomeInputHashes as hashes,
  hostFeedbackOutcomeOriginalHashes as originalHashes,
} from "../scripts/official-ui-host-feedback-outcome.mjs";
const [modalFile, hubFile, transportFile, entryFile, mountFile] =
  Object.keys(hashes);
const read = (name: string) =>
  fs.readFileSync("build/official-ui/ui/assets/v1/" + name, "utf8");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function pinnedInput(file: string) {
  const raw = archivedModule(file);
  assert.equal(
    sha(raw),
    originalHashes[file],
    "Original archive module must match pin",
  );
  const input = brandedModule(raw);
  assert.equal(
    sha(input),
    hashes[file],
    "Real branding must yield exact transform input",
  );
  return input;
}
function archivedModule(file: string) {
  return fs.readFileSync(
    ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/" +
      file,
    "utf8",
  );
}
const unknown = {
  claudexProductFeedback: true,
  deliveryState: "unknown",
  failureReason: "unconfirmed",
  statusCode: 409,
};
const intl = (locale: string) => ({
  locale,
  formatMessage: (m: any, v: any = {}) =>
    m.defaultMessage.replace("{detail}", v.detail ?? ""),
});
function consumers() {
  const shared = read("shared-7-D_yzHgAj.js");
  const helpers: any = {};
  vm.runInNewContext(
    shared.slice(
      shared.indexOf("function zx(e)"),
      shared.indexOf("var FS =", shared.indexOf("function zx(e)")),
    ) + ";this.detail=zx;this.retry=Mu;",
    helpers,
  );
  const transformed = (file: string) => {
    const expected = derive(file, pinnedInput(file));
    const root = process.env.CLAUDEX_FEEDBACK_INERT_MODULE_ROOT;
    if (root)
      assert.equal(fs.readFileSync(root + "/" + file, "utf8"), expected);
    return expected;
  };
  const modal = transformed(modalFile),
    hub = transformed(hubFile);
  const ms: any = { S: helpers.detail, ve: helpers.retry, _: () => {} };
  vm.runInNewContext(
    helper +
      modal.slice(
        modal.indexOf("async function ke("),
        modal.indexOf("function w()", modal.indexOf("async function ke(")),
      ) +
      ";this.run=ke;",
    ms,
  );
  const hs: any = {
    xr: () => false,
    XH: { report: "other" },
    eU: () => "inert",
    Iy: helpers.retry,
    In() {},
    ZH: {},
    an: { flush() {} },
  };
  vm.runInNewContext(
    helper +
      hub.slice(
        hub.indexOf("async function iU("),
        hub.indexOf("function aU(", hub.indexOf("async function iU(")),
      ) +
      ";this.run=iU;",
    hs,
  );
  const ast = ts.createSourceFile(
    hubFile,
    hub,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let callback: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isArrowFunction(node) &&
      node.getText(ast).includes('C(t === "claudex_delivery_unknown"') &&
      node.getText(ast).includes("IX.toastThanks")
    ) {
      assert.equal(callback, undefined);
      callback = node.getText(ast);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  return { ms, hs, callback };
}
test("exact transforms reject drift and do not mutate archived source", () => {
  for (const file of Object.keys(hashes)) {
    assert.notEqual(derive(file, pinnedInput(file)), pinnedInput(file));
    assert.throws(
      () => derive(file, pinnedInput(file) + "\n"),
      /input mismatch/,
    );
  }
});
test("actual modal and hub producer→original toast callback preserve success/errors and show unknown in both locales", async () => {
  const { ms, hs, callback } = consumers();
  for (const locale of ["en-US", "zh-CN"])
    for (const result of [
      unknown,
      { feedbackId: "inert-id" },
      { failureReason: "unconfirmed", statusCode: 503 },
      { unavailableReason: "Original refusal" },
    ]) {
      const errors: string[] = [],
        success: string[] = [];
      let closed = 0;
      await ms.run({
        form: {},
        submitFeedbackBundle: async () => result,
        isStale: () => false,
        setError: (s: string) => errors.push(s),
        setIsSubmitting() {},
        intl: intl(locale),
        addSuccess: (s: string) => success.push(s),
        close() {
          closed++;
        },
        track() {},
      });
      const outcome = await hs.run(
        async () => result,
        () => {},
        { intent: "report", surface: "chat", reasons: [], text: "inert" },
      );
      const scope: any = {
        Ce: false,
        fe: false,
        W() {},
        re: { current: 1 },
        i: async () => outcome,
        n: "report",
        V: [],
        ue: "inert",
        r: "chat",
        S: (s: string) => success.push(s),
        C: (s: string) => errors.push(s),
        b: intl(locale),
        IX: {
          toastThanks: { defaultMessage: "Original success" },
          toastFailed: { defaultMessage: "Couldn’t send that. Try again?" },
          deniedNotice: { defaultMessage: "Couldn’t send this from here." },
        },
        a() {
          closed++;
        },
        te() {},
      };
      vm.runInNewContext(helper + ";this.run=" + callback, scope);
      await scope.run();
      if (result === unknown) {
        assert.equal(outcome, "claudex_delivery_unknown");
        assert.equal(errors.length, 2);
        assert.equal(errors[0], errors[1]);
        assert.doesNotMatch(errors[0], /Try again/);
        assert.match(
          errors[0],
          locale.startsWith("zh")
            ? /无法确认反馈是否已发送/
            : /Couldn’t confirm whether/,
        );
        assert.equal(closed, 0);
      } else if ("feedbackId" in result) {
        assert.equal(outcome, "sent");
        assert.equal(closed, 2);
        assert.equal(errors.length, 0);
      } else if ("unavailableReason" in result) {
        assert.equal(errors[0], "Original refusal");
        assert.equal(outcome, "denied");
      } else {
        assert.equal(outcome, "retry");
        assert.match(errors[0], /Try again/);
        assert.match(errors[1], /Try again/);
      }
    }
});

const claudexAccount = {
  uuid: "account",
  claudex_host_authentication: {
    version: 1,
    status: "authenticated",
    account_uuid: "account",
  },
};

function actualFunction(
  file: string,
  name: string,
  bindings: object,
  dependencies: string[] = [],
  source = derive(file, pinnedInput(file)),
) {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const includesFunction = (
    node: ts.Statement,
  ): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name;
  const entry = ast.statements.find(includesFunction);
  assert.ok(entry);
  const functions = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name &&
      (node.name.text.startsWith("__claudex") ||
        dependencies.includes(node.name.text)),
  );
  const context: { run?: (...args: unknown[]) => any } = { ...bindings };
  vm.runInNewContext(
    [...functions, entry].map((node) => node.getText(ast)).join("\n") +
      "\nthis.run = " +
      name,
    context,
  );
  return context.run;
}

test("ordinary product feedback uses the current authenticated Web or native transport", async () => {
  const form = {
    reportType: "bug",
    details: "Original authored details",
    urgency: "n_a",
    impact: "blocks_me",
  };
  const received: unknown[][] = [];
  const accept = (channel: string) => async (input: unknown) => {
    received.push([channel, input]);
    return { feedbackId: "accepted" };
  };
  const common = {
    J9: () => [],
    J3: () => true,
    K3: (
      _slots: unknown,
      _index: number,
      _org: string,
      _client: unknown,
      _host: boolean,
      cb: unknown,
    ) => cb,
    a() {},
    e() {},
    i: () => ({ account: claudexAccount, activeOrganization: { uuid: "org" } }),
    l: () => assert.fail("Claudex product feedback must use the host"),
  };
  const native = actualFunction(transportFile, "u", {
    ...common,
    r: { submitFeedback: accept("native") },
  });
  const web = actualFunction(transportFile, "u", {
    ...common,
    r: { submitFeedback: accept("native") },
    __claudexProductFeedback: {
      version: 1,
      submit: accept("web"),
      submitCode() {},
    },
  });
  const unavailable = actualFunction(transportFile, "u", {
    ...common,
    r: undefined,
  });
  for (const hook of [web, native]) {
    assert.ok(typeof hook === "function");
    assert.equal((await hook()(form)).feedbackId, "accepted");
    assert.equal(
      (await hook()({ ...form, includeLogs: true })).failureReason,
      "attachments_unavailable",
    );
  }
  assert.ok(typeof unavailable === "function");
  assert.equal((await unavailable()(form)).failureReason, "unavailable");
  assert.deepEqual(received, [
    ["web", form],
    ["native", form],
  ]);
});

test("ordinary Cowork entry and mount share the authenticated transport gate", () => {
  const bridge = { version: 1, submit() {}, submitCode() {} };
  const entry = (
    account: unknown,
    capability: unknown,
    native?: object,
    restricted = false,
  ) =>
    actualFunction(
      entryFile,
      "re",
      {
        BW: () => true,
        a9: () => false,
        fh: () => ({ orgAvailable: true }),
        kC: () => restricted,
        __claudexFeedbackAccount: () => ({ account }),
        UG: native,
        __claudexProductFeedback: capability,
      },
      ["CL", "Ge"],
    );
  const mount = (account: unknown, capability: unknown) =>
    actualFunction(mountFile, "aT", {
      J9: () => [],
      J1: () => true,
      K1: (
        _slots: unknown,
        _index: number,
        _available: boolean,
        child: unknown,
      ) => child,
      lR: () => false,
      x5: () => ({ orgAvailable: true }),
      pr: (name: string) => name === "cowork_feedback_bundle",
      Q6: () => ({ account }),
      xg: undefined,
      __claudexProductFeedback: capability,
      tT: () => "Original Cowork modal",
      AZ: {},
    });
  assert.equal(entry(claudexAccount, bridge)?.(), true);
  assert.equal(
    entry(claudexAccount, undefined, { submitFeedback() {} })?.(),
    true,
  );
  assert.equal(entry(claudexAccount, bridge, undefined, true)?.(), false);
  assert.equal(mount(claudexAccount, bridge)?.(), "Original Cowork modal");
  for (const [account, capability] of [
    [claudexAccount, { ...bridge, version: 2 }],
    [{ uuid: "other" }, bridge],
  ]) {
    assert.equal(entry(account, capability)?.(), false);
    assert.equal(mount(account, capability)?.(), null);
  }
});

test("sidebar footer offers host feedback on Cowork routes and keeps the official Code and vendor paths", () => {
  const footerFile = "shared-22-Ciy9U3_0.js";
  const routerFile = "shared-m-4-CbJwwS_m.js";
  const no = () => false;
  const yes = () => true;
  const slot = (...args: unknown[]) => args.at(-1);
  const classify = actualFunction(
    routerFile,
    "lm",
    {
      fc: () => undefined,
      hq: no,
      OK: no,
      N0: no,
      eC: no,
      a9: no,
      q1: no,
      zZ: no,
      _G: no,
      A7: no,
      Eh: "/cowork/plugins",
    },
    [],
    archivedModule(routerFile),
  );
  assert.ok(classify);
  const render = (pathname: string, mode: string, vendor = false) => {
    const eligible = actualFunction(
      entryFile,
      "re",
      {
        BW: yes,
        a9: () => vendor,
        fh: () => ({ orgAvailable: true }),
        kC: no,
        UG: undefined,
        __claudexFeedbackAccount: () => ({
          account: vendor ? { uuid: "vendor" } : claudexAccount,
        }),
        __claudexProductFeedback: { version: 1, submit() {}, submitCode() {} },
      },
      ["CL", "Ge"],
    );
    assert.ok(eligible);
    const footer = actualFunction(
      footerFile,
      "Zj",
      {
        J9: () => [],
        J0: yes, J1: yes, J2: yes,
        K0: slot, K1: slot, K2: slot,
        pT: () => intl("en-US"),
        Pv: () => mode,
        As: (select: (path: string) => unknown) => select(pathname),
        __claudexFeedbackRouteMode: classify,
        re: eligible,
        vG: () => () => {},
        kC: no,
        fJ: true,
        gl: (component: string, props: { "aria-label"?: string }) =>
          props["aria-label"] ?? component,
        dR: () => "bug",
        tw: "button",
        Rh: "Send feedback",
      },
      [],
      derive(footerFile, brandedModule(archivedModule(footerFile))),
    );
    assert.ok(footer);
    return footer({ codeSearch: true });
  };
  assert.equal(render("/service-api", "cowork"), null);
  assert.equal(render("/new", "cowork"), null);
  assert.equal(render("/new", "chat"), null);
  assert.equal(render("/cowork/agent", "cowork"), "Give feedback");
  assert.equal(render("/space", "cowork"), "Give feedback");
  assert.equal(render("/code", "code"), "Send feedback");
  assert.equal(render("/new", "cowork", true), "Give feedback");
});

test("early-access product feedback keeps the host transport for a Claudex account with a vendor address", () => {
  const usesVendorStaffRoute = actualFunction(hubFile, "aU", {});
  assert.ok(usesVendorStaffRoute);
  const staffEmail = { email_address: "example@anthropic.com" };
  assert.equal(usesVendorStaffRoute(staffEmail), true);
  assert.equal(
    usesVendorStaffRoute({ ...claudexAccount, ...staffEmail }),
    false,
  );
});
