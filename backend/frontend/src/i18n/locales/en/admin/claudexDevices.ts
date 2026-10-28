// CLAUDEX: strings for the claudexDevices console page (keys under admin.claudexDevices).
// Owned by K3 (views/admin/claudex/ClaudexDevicesView.vue, components/admin/claudex/devices).
export default {
  claudexDevices: {
    title: 'Devices',
    description: 'Desktop devices signed in to Claudex, their device keys, and how new devices get a plan group.',
    errors: {
      CLAUDEX_PROVISIONING_INVALID: 'Some device settings aren’t valid. Check the form and try again.',
      CLAUDEX_DEVICE_NOT_FOUND: 'That device no longer exists. Reload to see the current list.',
      CLAUDEX_GROUP_NOT_FOUND: 'That group no longer exists. Reload and choose another group.',
      CLAUDEX_USER_NOT_FOUND: 'That user no longer exists. Reload and choose another user.',
      CLAUDEX_RESERVED_KEY_NAME: 'Names starting with claudex-device: or claudex-desktop: are reserved for device keys.',
      CLAUDEX_GROUP_NOT_ALLOWED: 'This user can’t use that group. Choose one of the user’s groups, or no group.',
      CLAUDEX_API_KEY_INVALID: 'Some key settings aren’t valid. Check the form and try again.',
      CLAUDEX_API_KEY_NOT_FOUND: 'That API key no longer exists. Reload to see the current list.',
      CLAUDEX_DEVICE_KEY_MANAGED: 'This is a Claudex device key. Revoke the device in the device list instead.'
    },
    userSearch: {
      placeholder: 'Search by email, name or user ID',
      clear: 'Clear user',
      noResults: 'No matching users.',
      userId: 'User ID {id}',
      failed: 'Could not search users'
    },
    provisioning: {
      title: 'Provisioning',
      description:
        'How the Claudex desktop app gets a device key when someone signs in. Changes apply to the next sign-in and to new device keys.',
      enabled: 'Give devices a key when they sign in',
      enabledHint:
        'When this is off, the desktop app can’t register devices or get device keys. Keys already issued keep working.',
      strategy: 'Plan group',
      strategySubscription: 'Latest subscription, then default group',
      strategySubscriptionHint:
        'Uses the user’s subscription that ends last. Without one, the default group, then another group the user can use.',
      strategyFixed: 'Always the default group',
      strategyFixedHint: 'Every device key uses the default group. Users who can’t use it can’t sign in to Claudex.',
      defaultGroup: 'Default group',
      noDefaultGroup: 'No default group',
      defaultGroupHint: 'Used when a user has no subscription in the allowed groups.',
      defaultGroupHintFixed: 'Every device key is bound to this group.',
      allowedGroups: 'Allowed groups',
      allowedGroupsHint: 'Groups Claudex may choose as a plan. Leave all unchecked to allow every group.',
      allowedGroupsAll: 'All groups',
      allowedGroupsCount: '{count} selected',
      groupSearch: 'Search groups',
      missingGroup: 'Group #{id} (deleted or inactive)',
      noGroups: 'No groups yet.',
      grantDefaultGroup: 'Grant access to the default group at sign-up',
      grantDefaultGroupHint:
        'New accounts get the default group added to their allowed groups. Only works when the default group is an exclusive standard group.',
      grantWarning: 'Anyone who can register gets this group.',
      grantNoEffect:
        '{group} isn’t an exclusive standard group, so new accounts don’t get it from this setting. Subscription groups come from the default subscriptions in Settings.',
      keyDefaults: 'New device keys',
      keyDefaultsHint: 'Limits given to each new device key. 0 means no limit; leave Expires empty for keys that don’t expire.',
      quotaUsd: 'Quota (USD)',
      expiresInDays: 'Expires in (days)',
      never: 'Never',
      rateLimit5h: '5-hour limit (USD)',
      rateLimit1d: 'Daily limit (USD)',
      rateLimit7d: '7-day limit (USD)',
      maxDevices: 'Devices per user',
      maxDevicesHint:
        'Default 5, from 1 to 50. You can give a user their own limit from the device list. Lowering it doesn’t sign out devices already signed in.',
      userApiKeys: 'Let users create their own API keys',
      userApiKeysHint:
        'Off by default. When off, regular users can’t create API keys through the API (/api/v1/keys); keys they already have keep working. Administrators can still create keys for a user under User API keys below, and Claudex device keys aren’t affected.',
      revokeAllNote:
        'Signing out of all devices always turns off that user’s Claudex device keys. Keys the user created themselves are not affected.',
      confirmTitle: 'Save device settings?',
      confirmMessage: 'These changes apply to the next device sign-in and to new device keys:',
      confirmSave: 'Save settings',
      changes: {
        enabledOn: 'Devices get keys when they sign in',
        enabledOff: 'Devices stop getting keys (the desktop app can’t register new devices)',
        strategy: 'How the plan group is chosen',
        defaultGroup: 'Default group',
        allowedGroups: 'Allowed groups',
        grantOn: 'New accounts get the default group (anyone who can register gets it)',
        grantOff: 'New accounts no longer get the default group',
        keyDefaults: 'Limits for new device keys',
        maxDevices: 'Up to {count} devices per user (unless a user has their own limit)',
        userApiKeysOn: 'Users can create their own API keys',
        userApiKeysOff: 'Users can no longer create their own API keys'
      }
    },
    validation: {
      strategy: 'Choose how the plan group is picked.',
      defaultGroupFixed: 'Choose a default group, or pick “Latest subscription, then default group”.',
      defaultGroupSignup: 'Choose a default group first.',
      defaultGroupNotAllowed: 'Choose one of the allowed groups, or also allow the default group.',
      usd: 'Enter an amount of 0 or more.',
      expiresInDays: 'Enter whole days from 1 to 3650, or leave it empty.',
      maxDevices: 'Enter a whole number from 1 to 50.'
    },
    limit: {
      title: 'Device limit',
      current: 'Current limit',
      sourceUser: '(this user)',
      sourceDefault: '(default)',
      active: 'Signed-in devices',
      newValue: 'Limit for this user',
      hint: 'From 1 to 50. The default is {default}. Lowering it doesn’t sign out devices already signed in.',
      useDefault: 'Use default',
      save: 'Save limit',
      loadFailed: 'Could not load the device limit',
      confirmSetTitle: 'Change the device limit?',
      confirmSetMessage:
        '{user} can be signed in to Claudex on up to {count} devices. Devices already signed in stay signed in.',
      confirmResetTitle: 'Use the default limit?',
      confirmResetMessage: '{user} goes back to the default of {count} devices.',
      saved: 'Device limit is now {count}.'
    },
    list: {
      title: 'Device list',
      description: 'Every Claudex desktop device and its device key. Revoking signs the device out and turns off its key.',
      filterUser: 'User',
      search: 'Search',
      searchPlaceholder: 'Email or device name',
      status: 'Status',
      statusActive: 'Active',
      statusRevoked: 'Revoked',
      statusAll: 'All',
      userBar: 'Devices of {user}',
      empty: 'No devices match.',
      unnamed: 'Unnamed device',
      registered: 'Added {date}',
      keyLastUsed: 'Used {time}',
      keyNeverUsed: 'Not used yet',
      revoked: 'Revoked',
      loadFailed: 'Could not load the devices'
    },
    columns: {
      user: 'User',
      device: 'Device',
      platform: 'Platform',
      appVersion: 'App version',
      planGroup: 'Plan group',
      key: 'Device key',
      lastSeen: 'Last seen',
      status: 'Status',
      actions: 'Actions'
    },
    actions: {
      revoke: 'Revoke',
      revokeAll: 'Sign out of all devices',
      deviceLimit: 'Device limit',
      showUser: 'Show this user’s devices'
    },
    platforms: {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux'
    },
    keyStatus: {
      active: 'Active',
      inactive: 'Off',
      disabled: 'Off',
      expired: 'Expired',
      quota_exhausted: 'Quota used up',
      deleted: 'Deleted'
    },
    revokedReason: {
      user: 'Signed out by the user',
      admin: 'Revoked by an administrator',
      revoke_all: 'Signed out of all devices',
      unknown: 'Revoked'
    },
    confirm: {
      revokeTitle: 'Revoke this device?',
      revokeMessage:
        '{device} of {user} is signed out of Claudex and its device key is turned off. Signing in again on that device needs the password.',
      revoked: 'Device revoked.',
      revokeAllTitle: 'Sign {user} out of all devices?',
      revokeAllMessage:
        'Claudex signs out on every device of this user and all of the user’s device keys are turned off. API keys the user created themselves keep working.',
      revokedAll: 'Signed out of {count} devices.'
    },
    userKeys: {
      title: 'User API keys',
      description:
        'API keys of a user, without device keys. While users can’t create their own, create keys for them here. Signing a user out of all devices doesn’t affect these keys.',
      pickUser: 'Choose a user to see and manage their API keys.',
      createButton: 'Create API key for user',
      empty: 'This user has no API keys.',
      loadFailed: 'Could not load the API keys',
      noQuota: 'No limit',
      quotaUsed: '{used} of {limit}',
      delete: 'Delete key',
      deleteTitle: 'Delete this API key?',
      deleteMessage: '{name} of {user} stops working right away. This can’t be undone.',
      deleted: 'Deleted {name}.',
      created: 'Created {name}.',
      columns: {
        name: 'Name',
        key: 'Key',
        group: 'Group',
        quota: 'Quota used',
        expires: 'Expires',
        lastUsed: 'Last used'
      },
      create: {
        title: 'Create API key for user',
        name: 'Name',
        namePlaceholder: 'For example: CI deploy',
        group: 'Group',
        noGroup: 'No group',
        groupHint: 'Choose a group this user can use; the server refuses others.',
        quotaHint: '0 means no limit.',
        ipAllowlist: 'IP allowlist',
        ipAllowlistPlaceholder: '203.0.113.0/24',
        ipAllowlistHint: 'One IP address or CIDR range per line. Leave empty to allow any address.',
        userKeyNote:
          'This is a user API key: it isn’t tied to a device, and signing the user out of all devices doesn’t turn it off.',
        submit: 'Create key',
        creating: 'Creating…',
        createdFor: 'Created {name} for {user}.',
        key: 'API key',
        copy: 'Copy',
        copied: 'Copied',
        copiedToast: 'API key copied',
        onceNotice: 'Copy this key now. It won’t be shown again after you close this window.',
        done: 'Done'
      },
      validation: {
        nameRequired: 'Enter a name for the key.',
        nameLength: 'The name can be at most 100 characters.',
        nameReserved: 'Names starting with claudex-device: or claudex-desktop: are reserved for device keys.',
        ipCount: 'The allowlist can have at most 100 entries.'
      }
    },
    passwordResetHint:
      'Resetting the password signs the user out of Claudex desktop. Their device keys keep working after they sign in again.'
  }
}
