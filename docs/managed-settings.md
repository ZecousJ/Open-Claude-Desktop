# Machine-managed desktop settings

Desktop policy combines the signed-in account's service policy (including the
cached/bootstrap policy) with a machine-local policy. Local restrictions apply
to local and service accounts alike and cannot enable a feature the service
denies. They refresh on focus and at least once a minute.

Administrators can provision one of these sources:

- macOS: `/Library/Managed Preferences/dev.claudex.desktop.plist`, followed by
  `/Library/Managed Preferences/<username>/dev.claudex.desktop.plist`. The user
  plist overrides individual machine-plist keys. Use the app's bundle ID as the
  MDM preference domain. Values are native plist booleans, arrays and dictionaries.
- Windows: `HKLM\SOFTWARE\Policies\Claudex`, with a `Settings` value of type
  `REG_SZ` containing the JSON object below.
- Linux: `/etc/claudex/managed-settings.json` containing that JSON object.

Provision these locations with administrator-only write access. The application
only reads them; it never creates or modifies managed configuration.

```json
{
  "permissionModes": ["manual", "plan"],
  "webSearch": false,
  "localMcpEditing": false,
  "browser": {
    "enabled": true,
    "externalSites": false,
    "allowScript": false,
    "devServers": true,
    "blockedDomains": ["example.com"]
  }
}
```

Other supported boolean restrictions are `incognito`, `voice`,
`developerModeEnabled`, `remoteImages`, `externalLinks`, `sshRemote`, `workflows`
and `approvalsAlwaysAllow`. Omitted keys impose no additional restriction;
`false` denies the feature and `true` preserves the service's decision.
Permission modes are intersected with the service's modes; blocked domains are
combined. Bypass permissions remains the user's explicit preference, as in the
existing policy contract.

An absent source adds no restrictions. A present but unreadable, malformed or
unsupported configuration fails closed until repaired; diagnostics are written
to the main-process log. JSON/plist input is limited to 256 kB. This is the
Claudex policy vocabulary, not Anthropic organization configuration or Claude
Code SDK project settings; those are not interchangeable.
