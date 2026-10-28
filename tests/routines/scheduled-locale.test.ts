import test from "node:test";
import assert from "node:assert/strict";
import { locales } from "../../shared/locales";
import { currentLocale, formatText, setLocale, t } from "../../src/i18n";

const keys = [
  "Unknown computer",
  "Your computer",
  "Runs on {host}",
  "Asleep or app closed",
  "Filter runs",
  "Trigger",
  "No loaded runs match these filters.",
  "Edit the schedule to turn this scheduled task back on.",
  "Task type",
  "This task will run on your computer because it uses a local folder. Remove the folder to run it in the cloud.",
  "View task",
  "New scheduled task",
];
const expectedIdentity = {
  "zh-CN": ["未知电脑", "在 {host} 上运行", "触发方式"],
  "fr-FR": ["Ordinateur inconnu", "S’exécute sur {host}", "Déclencheur"],
  "de-DE": ["Unbekannter Computer", "Wird auf {host} ausgeführt", "Auslöser"],
  "hi-IN": ["अज्ञात कंप्यूटर", "{host} पर चलता है", "ट्रिगर"],
  "id-ID": ["Komputer tidak dikenal", "Berjalan di {host}", "Pemicu"],
  "it-IT": ["Computer sconosciuto", "In esecuzione su {host}", "Attivazione"],
  "ja-JP": ["不明なコンピューター", "{host} で実行", "トリガー"],
  "ko-KR": ["알 수 없는 컴퓨터", "{host}에서 실행", "트리거"],
  "pt-BR": ["Computador desconhecido", "Executa em {host}", "Gatilho"],
  "es-419": ["Computadora desconocida", "Se ejecuta en {host}", "Activador"],
  "es-ES": ["Ordenador desconocido", "Se ejecuta en {host}", "Activador"],
};

const expectedCreationTitles = {
  "zh-CN": "新建定时任务",
  "fr-FR": "Nouvelle tâche planifiée",
  "de-DE": "Neue geplante Aufgabe",
  "hi-IN": "नया शेड्यूल किया गया कार्य",
  "id-ID": "Tugas terjadwal baru",
  "it-IT": "Nuova attività pianificata",
  "ja-JP": "新しいスケジュールされたタスク",
  "ko-KR": "새 예약 작업",
  "pt-BR": "Nova tarefa agendada",
  "es-419": "Nueva tarea programada",
  "es-ES": "Nueva tarea programada",
};

for (const { id } of locales.filter((locale) => locale.id !== "en-US")) {
  test(`${id}: scheduled labels load through the real locale runtime and preserve the device placeholder`, async () => {
    try {
      await setLocale(id);
      assert.equal(currentLocale(), id);
      for (const key of keys) {
        const translated = t(key);
        assert.notEqual(
          translated,
          key,
          `${id}: ${key} must not fall back to English`,
        );
        assert.ok(translated.trim().length > 0, key);
        assert.equal(translated.includes("{host}"), key === "Runs on {host}");
      }
      const [unknown, hostTemplate, trigger] =
        expectedIdentity[id as keyof typeof expectedIdentity];
      assert.equal(
        t("New scheduled task"),
        expectedCreationTitles[id as keyof typeof expectedCreationTitles],
      );
      assert.notEqual(
        t("New scheduled task"),
        t("Edit scheduled task"),
        "create and edit retain distinct localized titles",
      );
      assert.equal(t("Unknown computer"), unknown);
      assert.equal(t("Runs on {host}"), hostTemplate);
      assert.equal(
        t("Trigger"),
        trigger,
        "reuse the established Trigger translation",
      );
      const host = "Studio Mac 夸我 · 42";
      assert.equal(
        formatText("Runs on {host}", { host }),
        hostTemplate.replace("{host}", host),
      );
      assert.equal(t(`Runs on ${host}`), hostTemplate.replace("{host}", host));
    } finally {
      await setLocale("en-US");
    }
  });
}
