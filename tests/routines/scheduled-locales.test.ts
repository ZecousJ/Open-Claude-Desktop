import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, formatText, setLocale, t } from "../../src/i18n";

const deviceKeys = [
  "Actions for {device}",
  "Device details",
  "{client} on {os}",
  "Verify each new device before it can connect to Claudex on your computer remotely.",
  "Devices that can control your local machine through remote sessions.",
  "Trusted devices",
  "Device verification requests",
  "Compare this fingerprint with the one shown on your connecting device before approving.",
  "Approve device",
  "Revoke trust",
  "Couldn’t load device verification.",
  "Loading device verification…",
];
const folderKeys = [
  "Select a folder",
  "Folder path",
  "Folders",
  "Parent folder",
  "No folders",
  "Tab to open · Enter to select",
  "Select",
  "Loading folders…",
  "Retry folder access",
  "Folder access is unavailable for this session.",
  "Couldn’t load folders. Try again.",
  "Choose an absolute folder.",
  "Couldn’t open that folder. Check the path and try again.",
  "This folder couldn’t be added. Try again.",
];
// These are the execution-host diagnostics supplied by routine-workspace.ts,
// including distinctions the editor must not flatten into a generic error.
const workspaceKeys = [
  "This folder no longer exists. Edit the task to choose another folder.",
  "This task needs permission to use this folder.",
  "Couldn’t check this folder on its execution host. Try again.",
  "This task has more than 16 folders. Edit the task to choose fewer folders.",
  "This task has duplicate folders. Edit the task to remove duplicates.",
  "This task contains a folder that isn’t supported on its execution host.",
  "Where a task runs can’t be changed after it’s created.",
  "Edit task",
];
const migrationKeys = [
  "Scheduled task migration is unavailable on this computer.",
  "This scheduled task no longer exists.",
  "Turn this task back on to use “{action}”.",
  "Another task is running. Try again when it finishes.",
  "Can’t move this task because its file couldn’t be read.",
  "Can’t move this task because it uses local folders or files.",
  "Can’t move this task yet. Moving would disconnect it from its projects. To run it in the cloud, create a new task instead.",
  "Can’t move this task because it’s linked to a project.",
  "Can’t move this task because Chrome permissions only run locally.",
  "Can’t move this task because it uses a local workspace.",
  "Can’t move this task because it has a computer trigger.",
  "Can’t move this task because it has local approval rules.",
  "Can’t move this task because it runs more than once per hour.",
  "This task’s schedule can’t be moved to the cloud.",
  "This task type isn’t supported by the destination.",
  "This task’s model isn’t available at the destination.",
  "This task wasn’t moved from this computer.",
  "The original task is no longer available on this computer.",
  "This task’s scheduled time has passed.",
  "This task can’t move between computers with different time zones.",
  "Move to cloud",
  "Move back to this computer",
  "Couldn’t move this task to the cloud. You can try again.",
  "Couldn’t move this task back to this computer. You can try again.",
  "Checking whether this task can move…",
  "Couldn’t check task migration. Try again.",
  "Now runs in the cloud",
  "A previous move is unfinished. Retry to safely continue it.",
  "Moved from this computer. Moving it back deletes the cloud version.",
  "Runs when this computer is asleep or offline",
  "Retry move",
  "Move back to this computer?",
  "Move to cloud?",
  "“{taskName}” will run on this computer again.",
  "“{taskName}” will run in the cloud. The local copy will be paused.",
  "The cloud version will be deleted, along with its run history and any changes made to it except the instructions.",
  "Keep in cloud",
  "Move back",
  "Moving…",
  "Cancel",
  "Retry",
];
const keys = [...deviceKeys, ...folderKeys, ...workspaceKeys, ...migrationKeys];
const expectedDetails: Record<string, string> = {
  "zh-CN": "设备详情",
  "fr-FR": "Détails de l’appareil",
  "de-DE": "Gerätedetails",
  "hi-IN": "डिवाइस का विवरण",
  "id-ID": "Detail perangkat",
  "it-IT": "Dettagli del dispositivo",
  "ja-JP": "デバイスの詳細",
  "ko-KR": "기기 세부 정보",
  "pt-BR": "Detalhes do dispositivo",
  "es-419": "Detalles del dispositivo",
  "es-ES": "Detalles del dispositivo",
};
const expectedDeletion: Record<string, string> = {
  "zh-CN": "云端版本及其运行历史和除指令之外的所有更改都将被删除。",
  "fr-FR":
    "La version cloud sera supprimée, ainsi que son historique d’exécution et toutes les modifications qui y ont été apportées, à l’exception des instructions.",
  "de-DE":
    "Die Cloud-Version wird zusammen mit ihrem Ausführungsverlauf und allen daran vorgenommenen Änderungen außer den Anweisungen gelöscht.",
  "hi-IN":
    "क्लाउड संस्करण, उसका रन इतिहास और निर्देशों को छोड़कर उसमें किए गए सभी बदलाव हटा दिए जाएँगे।",
  "id-ID":
    "Versi cloud akan dihapus beserta riwayat eksekusi dan semua perubahan yang dibuat, kecuali instruksinya.",
  "it-IT":
    "La versione cloud verrà eliminata insieme alla cronologia delle esecuzioni e a tutte le modifiche apportate, a eccezione delle istruzioni.",
  "ja-JP":
    "クラウド版は、実行履歴および指示以外のすべての変更とともに削除されます。",
  "ko-KR":
    "클라우드 버전과 실행 기록, 지침을 제외한 모든 변경 사항이 삭제됩니다.",
  "pt-BR":
    "A versão na nuvem será excluída, junto com o histórico de execuções e todas as alterações feitas, exceto as instruções.",
  "es-419":
    "Se eliminará la versión en la nube, junto con su historial de ejecuciones y todos los cambios realizados, excepto las instrucciones.",
  "es-ES":
    "Se eliminará la versión en la nube, junto con su historial de ejecuciones y todos los cambios realizados, excepto las instrucciones.",
};
const placeholders = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
  test(`${id}: device, folder, workspace and migration text uses the loaded catalog and preserves user names`, async () => {
    const before = currentLocale();
    try {
      await setLocale(id);
      assert.equal(currentLocale(), id);
      for (const key of keys) {
        const translated = t(key);
        assert.notEqual(translated, key, `${id}: English fallback for ${key}`);
        assert.ok(translated.trim(), key);
        assert.deepEqual(
          placeholders(translated),
          placeholders(key),
          `${id}: ${key}`,
        );
      }
      assert.equal(t("Device details"), expectedDetails[id]);
      assert.ok(
        t(deviceKeys[3]).includes("Claudex"),
        "preserve the product name",
      );
      assert.equal(
        new Set(workspaceKeys.map((key) => t(key))).size,
        workspaceKeys.length,
        "different diagnostics and editor actions retain distinct wording",
      );
      const values = {
        device: "Studio 夸我 · $& · {literal}",
        client: "Settings <Client>",
        os: "macOS 15 / 设备",
      };
      for (const key of ["Actions for {device}", "{client} on {os}"]) {
        const expected = t(key).replace(
          /\{(\w+)\}/g,
          (_whole, name: keyof typeof values) => values[name],
        );
        assert.equal(
          formatText(key, values),
          expected,
          "interpolate complete sentences without translating or altering user names",
        );
      }
      const taskName = "Settings 夸我 · $& · {literal} <Task>";
      for (const key of [
        "“{taskName}” will run on this computer again.",
        "“{taskName}” will run in the cloud. The local copy will be paused.",
      ]) {
        assert.equal(
          formatText(key, { taskName }),
          t(key).replace("{taskName}", () => taskName),
          "migration confirmations preserve user task names verbatim",
        );
      }
      const action = t("Move to cloud");
      assert.equal(
        formatText("Turn this task back on to use “{action}”.", { action }),
        t("Turn this task back on to use “{action}”.").replace(
          "{action}",
          () => action,
        ),
      );
      const warning =
        "The cloud version will be deleted, along with its run history and any changes made to it except the instructions.";
      assert.equal(
        t(warning),
        expectedDeletion[id],
        "the return-to-computer warning retains cloud deletion, run history, changes, and the instructions exception",
      );
      const name = "Studio 夸我 · 42";
      assert.equal(
        t(`Actions for ${name}`),
        t("Actions for {device}").replace("{device}", name),
      );
      assert.equal(
        formatText("{client} on {os}", {
          client: "Settings",
          os: "Windows",
        }).includes("Settings"),
        true,
        "a user-supplied client name must not become the translated Settings label",
      );
    } finally {
      await setLocale(before);
    }
  });
}

test("new locale entries reuse established keys without duplicate object properties", () => {
  for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
    const file = new URL(
      `../../shared/i18n/catalogs/${id}.ts`,
      import.meta.url,
    );
    const tree = ts.createSourceFile(
      file.pathname,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const counts = new Map<string, number>();
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))
      ) {
        const key = node.name.text;
        if (keys.includes(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    for (const key of keys)
      assert.equal(counts.get(key), 1, `${id}: exactly one ${key}`);
  }
});
