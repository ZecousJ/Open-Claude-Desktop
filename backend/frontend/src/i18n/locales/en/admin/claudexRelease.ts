// CLAUDEX: strings for the claudexRelease console page (keys under admin.claudexRelease).
export default {
  claudexRelease: {
    title: 'Desktop release',
    description: 'Latest and minimum Claudex desktop versions, release notes and download links.',
    updatedAt: 'Last saved {time}',
    versions: {
      title: 'Versions',
      description: 'The desktop app compares its own version with these and shows an update notice.',
      latest: 'Latest version',
      latestHint: 'For example 1.4.0. Leave empty if you don’t publish desktop releases here.',
      minimum: 'Minimum version',
      minimumHint: 'Older versions are asked to update. It can’t be newer than the latest version.',
      publishedAt: 'Published at',
      publishedAtHint: 'Shown with the update notice. Entered in your local time.',
      notesUrl: 'Release notes URL',
      notesUrlHint: 'Optional. A page with the full release notes.'
    },
    notes: {
      title: 'Release notes',
      description:
        'Markdown shown in the update notice. Raw HTML is shown as text and images aren’t loaded, in the preview and in Claudex.',
      markdown: 'Markdown',
      placeholder: '## 1.4.0\n- What changed in this version',
      hint: 'The preview matches how Claudex shows the notes.',
      count: '{count} / {max}',
      preview: 'Preview',
      previewEmpty: 'Nothing to preview yet.'
    },
    downloads: {
      title: 'Downloads',
      description:
        'One download per platform. The desktop app only opens https links. Leave a platform empty to show no download button there.',
      url: 'Download URL',
      sha256: 'SHA-256 (optional)',
      sha256Placeholder: '64 hexadecimal characters'
    },
    platforms: {
      macosArm64: 'macOS (Apple silicon)',
      macosX64: 'macOS (Intel)',
      macosUniversal: 'macOS (Universal)',
      windowsX64: 'Windows (x64)',
      windowsArm64: 'Windows (Arm64)',
      linuxX64: 'Linux (x64)',
      linuxArm64: 'Linux (Arm64)'
    },
    enforcement: {
      title: 'Gateway enforcement',
      label: 'Enforce minimum version on the gateway',
      hint: 'Off by default. Applies to requests made with Claudex device keys.',
      warning:
        'When this is on, older Claudex versions stop working until they update. When it’s off, they only see an update notice.',
      noMinimum: 'No minimum version is set, so nothing is enforced yet.'
    },
    problems: {
      version: 'Enter a version like 1.4.0 or 1.4.0-beta.1 (up to 32 characters).',
      minimumWithoutLatest: 'Set the latest version first.',
      minimumAboveLatest: 'The minimum version can’t be newer than the latest version.',
      date: 'Enter a valid date and time.',
      https: 'Enter a full https:// URL.',
      tooLong: 'This URL is too long.',
      notesTooLong: 'Release notes can be up to {max} characters.',
      sha256: 'Enter 64 hexadecimal characters.',
      sha256WithoutUrl: 'Add the download URL for this checksum.',
      server: 'The server didn’t accept this value.'
    },
    fixProblems: 'Fix the highlighted fields, then save again.',
    serverField: '(field: {field})',
    errors: {
      CLAUDEX_RELEASE_INVALID: 'Some release details aren’t valid. Check the form and try again.',
      CLAUDEX_SETTING_INVALID: 'Some values aren’t valid. Check the form and try again.'
    }
  }
}
