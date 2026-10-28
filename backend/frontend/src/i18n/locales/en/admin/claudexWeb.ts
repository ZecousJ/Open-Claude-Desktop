// CLAUDEX: strings for the Web app console page (keys under admin.claudexWeb, W-ADMIN1).
export default {
  claudexWeb: {
    nav: 'Web app',
    title: 'Web app',
    description: 'Who can use Claudex on the web, the limits of its runs, and the runners that carry them out.',
    fixProblems: 'Fix the highlighted fields, then save again.',
    signInNote: 'Sign-in options for the web app (email code, privacy policy) are on the General page.',
    signInLink: 'Open General',
    access: {
      title: 'Access',
      description:
        'Turn the web app on or off and choose who may use it. Administrators can always sign in while it is on. Turning it off disconnects everyone using it.',
      mode: 'Who can use it',
      off: 'Off',
      allowlist: 'Administrators and listed users',
      everyone: 'Everyone',
      offHint: 'The web app is closed. Nobody can sign in to it, administrators included.',
      allowlistHint: 'Administrators, plus the users on the lists below. Leave the lists empty for administrators only.',
      everyoneHint: 'Every active user can sign in to the web app.',
      offNote: 'Saving turns the web app off. People using it are disconnected within a minute.',
      maxSessions: 'Sessions per user',
      maxSessionsHint: '1 to 50 browser sessions at once. Signing in past the limit ends the oldest one.',
      emails: 'Allowed email addresses',
      emailsPlaceholder: "name{'@'}example.com",
      emailsHint: 'Press Enter or comma to add. Up to 1000.',
      userIds: 'Allowed user IDs',
      userIdsPlaceholder: 'User ID',
      userIdsHint: 'Numbers from the Users page. Up to 1000.'
    },
    limits: {
      title: 'Run limits',
      description: 'How many conversations may run at the same time on the runners, and for how long.',
      maxConcurrent: 'Runs at once (everyone)',
      maxConcurrentHint: '1 to 500 runs across all users. New runs wait for a free slot.',
      maxConcurrentPerUser: 'Runs at once (one user)',
      maxConcurrentPerUserHint: '1 to 20. Cannot be more than the limit for everyone.',
      maxSessionMinutes: 'Longest run (minutes)',
      maxSessionMinutesHint: '1 to 1440. A run that goes on this long is stopped.',
      minutePriceUsd: 'Runner minute price (USD)',
      minutePriceUsdHint: '0 to 100. Shown for information: runner time is recorded, never charged.'
    },
    runners: {
      title: 'Runners',
      description:
        'A runner is the program that runs the web conversations. The local runner sits next to the server; add a runner to link another machine with its own token.',
      add: 'Add runner',
      name: 'Name',
      status: 'Status',
      version: 'Version',
      capacity: 'Capacity',
      users: 'Users',
      lastSeen: 'Last seen',
      actions: 'Actions',
      empty: 'No runners yet.',
      localRunner: 'Runs next to the server',
      created: 'Added {date}',
      now: 'Now',
      neverSeen: 'Never linked',
      status_online: 'Online',
      status_offline: 'Offline',
      status_disabled: 'Switched off',
      status_revoked: 'Revoked',
      statusDraining: 'Draining',
      capacityValue: '{engines} engines, {users} users',
      loadValue: '{engines} engines, {users} users in use',
      summary: '{runs} runs active now, {tabs} users with the web app open.',
      noLocal: 'No local runner is set up on this server.',
      disable: 'Switch off',
      enable: 'Switch on',
      disableTitle: 'Switch off this runner?',
      disableMessage:
        '“{name}” disconnects now and cannot link again until you switch it on. Its token stays valid. Runs on it stop.',
      disabledDone: '“{name}” is switched off.',
      enabledDone: '“{name}” is switched on. It can link again.',
      rename: {
        action: 'Rename',
        title: 'Rename runner',
        submit: 'Rename',
        done: 'Runner renamed.'
      },
      drain: {
        action: 'Drain',
        title: 'Drain this runner?',
        message: '“{name}” finishes its current work and takes no new users. Its users move to another runner.',
        done: '“{name}” is draining.'
      },
      revoke: {
        action: 'Revoke',
        title: 'Revoke this runner?',
        message: 'The token of “{name}” stops working for good and the runner is disconnected. This cannot be undone.',
        done: '“{name}” is revoked.'
      },
      create: {
        title: 'Add a runner',
        submit: 'Create token',
        namePlaceholder: 'For example: office server',
        nameHint: 'A name to tell runners apart, up to 100 characters.',
        createdFor: 'Token created for “{name}”.',
        token: 'Runner token',
        copy: 'Copy',
        copied: 'Copied',
        copiedToast: 'Token copied',
        onceNotice:
          'Copy the token now and put it in the runner’s configuration. It is shown only once; the server keeps a hash and cannot show it again.',
        done: 'Done'
      }
    },
    problems: {
      sessionsPerUser: 'Enter a whole number from 1 to 50.',
      listTooLong: 'The list can hold up to 1000 entries.',
      perUser: 'Enter a whole number from 1 to 20.',
      concurrent: 'Enter a whole number from 1 to 500.',
      perUserOverTotal: 'Cannot be more than the limit for everyone.',
      minutes: 'Enter a whole number from 1 to 1440.',
      price: 'Enter a price from 0 to 100.',
      email: "Enter an email address like name{'@'}example.com.",
      userId: 'Enter a user ID (a whole number above 0).',
      runnerName: 'Enter a name of 1 to 100 characters.'
    },
    errors: {
      CLAUDEX_WEB_SETTINGS_INVALID: 'Some web app settings aren’t valid. Check the form and try again.',
      CLAUDEX_WEB_SETTINGS_CONFLICT:
        'Another administrator changed these settings first. The form now shows what is saved; make your change again.',
      CLAUDEX_WEB_USAGE_SETTINGS_INVALID: 'Some run limits aren’t valid. Check the form and try again.',
      CLAUDEX_WEB_USAGE_SETTINGS_CONFLICT:
        'Another administrator changed these limits first. The form now shows what is saved; make your change again.',
      CLAUDEX_WEB_RUNNER_INVALID: 'Give the runner a name of 1 to 100 characters.',
      CLAUDEX_WEB_RUNNER_NOT_FOUND: 'This runner no longer exists or was already revoked.',
      CLAUDEX_WEB_RUNNERS_UNAVAILABLE: 'The runner list is unavailable right now. Try again in a moment.',
      CLAUDEX_SETTING_INVALID: 'Some values aren’t valid. Check the form and try again.'
    }
  }
}
