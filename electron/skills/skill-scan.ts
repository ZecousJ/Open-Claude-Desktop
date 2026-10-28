const unsafeContent = [
  /EICAR-STANDARD-ANTIVIRUS-TEST-FILE/,
  /(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
  /(?:bash|sh)\s+-i\s+[^\n]*\/dev\/tcp\//i,
  /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|system|developer)\s+(?:instructions|prompts)/i,
  /(?:curl|wget|fetch)\b[^\n]*(?:\.ssh\/id_|\.aws\/credentials|\.codex\/auth\.json)/i,
];

export function scanSkillContents(contents: Map<string, Buffer>, name: string) {
  for (const [file, content] of contents) {
    const executable = /\.(?:exe|dll|dylib|so|com|scr)$/i.test(file);
    const binary =
      content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      content.subarray(0, 2).equals(Buffer.from("MZ"));
    if (
      executable ||
      binary ||
      unsafeContent.some((pattern) => pattern.test(content.toString("utf8")))
    )
      throw new Error(
        `${name} can’t be added because it didn’t pass the security scan`,
      );
  }
}
