import fs from "node:fs";
import path from "node:path";

// Install both validated trees together, restoring the previous trees on failure.
export function installOfficialUi(stage, build, rename = fs.renameSync) {
  const names = ["official-ui", "official-usercontent"];
  const movedOld = [], movedNew = [];
  try {
    for (const name of names) {
      const target = path.join(build, name);
      if (fs.existsSync(target)) {
        rename(target, path.join(stage, "previous-" + name));
        movedOld.push(name);
      }
      rename(path.join(stage, name), target);
      movedNew.push(name);
    }
  } catch (error) {
    const failures = [];
    for (const name of movedNew.reverse()) {
      try { rename(path.join(build, name), path.join(stage, name)); }
      catch (failure) { failures.push(failure); }
    }
    for (const name of movedOld.reverse()) {
      try { rename(path.join(stage, "previous-" + name), path.join(build, name)); }
      catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], `Official UI rollback failed; recover previous trees from ${stage}`);
    throw error;
  }
}
