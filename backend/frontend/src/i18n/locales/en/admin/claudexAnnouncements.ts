// CLAUDEX: strings for the claudexAnnouncements console page (keys under admin.claudexAnnouncements).
export default {
  claudexAnnouncements: {
    nav: 'Announcements',
    title: 'Announcements',
    description:
      'Pop-up notices that Claudex shows once to every signed-in user, and e-mail notices to chosen users. Each pop-up uses the standard layout: fill in the title, text, button and (optionally) a picture.',
    tabs: { popups: 'Pop-ups', mail: 'E-mail' },
    status: { draft: 'Draft', published: 'Published', withdrawn: 'Withdrawn', expired: 'Expired' },
    popups: {
      intro:
        'A pop-up appears once for each person, in the Claudex app and on the web. Whatever they press, it doesn’t come back. When the time is up it comes down by itself, seen or not.',
      new: 'New pop-up',
      none: 'No pop-ups yet.',
      untitled: 'Untitled',
      reads: 'closed by {n}',
      until: 'Shown until {date}',
      endedOn: 'Ended {date}',
      updatedOn: 'Edited {date}',
      publish: 'Publish',
      withdraw: 'Withdraw',
      deleteTitle: 'Delete this pop-up?',
      deleteMessage: 'It disappears from the app if it is showing, and its record of who closed it is deleted.'
    },
    fields: {
      badge: 'Badge (optional)',
      title: 'Title',
      body: 'Content',
      bodyHint: 'Each line is a paragraph. The title, buttons and picture keep the standard pop-up layout.',
      bodyHtml: 'Content (HTML)',
      bodyHintHtml:
        'HTML with its own <style>. It is drawn in a frame without scripts, so it can look however you like but can’t run code.',
      useHtml: 'Write custom HTML',
      useTemplate: 'Use plain text',
      image: 'Picture (optional)',
      imageHint: 'An https:// address. The picture fills the right half of the card; without one the card is a single column.',
      primaryLabel: 'Button text',
      primaryUrl: 'Button link (optional)',
      primaryUrlHint: 'With a link the pop-up has that button and a “Not now” button. Without one it has a single “Done” button.',
      dismissLabel: 'Second button text',
      resetReads: 'Show it again to everyone who already closed it'
    },
    publish: { duration: 'How long to publish', extend: 'Save and publish again' },
    durations: { day: '1 day', threeDays: '3 days', week: '1 week', twoWeeks: '2 weeks', month: '30 days' },
    preview: {
      title: 'Preview',
      light: 'Light',
      dark: 'Dark',
      frame: 'Announcement content',
      dismissDefault: 'Not now',
      doneDefault: 'Done',
      openDefault: 'Open',
      note: 'This is how the pop-up looks in the app. The buttons here do nothing.'
    },
    mail: {
      off: 'This service has no SMTP settings yet, so e-mail can’t be sent. Set up SMTP in the settings first.',
      subject: 'Subject',
      body: 'Message (HTML)',
      bodyHint: 'HTML, as in a mail. Use inline styles: many mail programs ignore <style> blocks.',
      recipients: 'Send to',
      searchPlaceholder: 'Search users by e-mail…',
      addAll: 'Add all active users',
      clear: 'Clear',
      count: '{n} of {max} chosen',
      tooMany: 'Send to at most {max} people at a time.',
      send: 'Send e-mail',
      confirmTitle: 'Send this e-mail?',
      confirmMessage: 'It goes to {n} people. This can’t be undone.',
      history: 'Sent',
      none: 'Nothing sent yet.',
      state: { sending: 'Sending', done: 'Done' },
      progress: '{sent} sent, {failed} failed, of {total}',
      previewNote: 'Mail programs draw HTML a little differently; keep the layout simple.'
    },
    toasts: {
      saved: 'Saved.',
      published: 'Published.',
      withdrawn: 'Withdrawn.',
      deleted: 'Deleted.',
      mailQueued: 'Sending to {n} people.',
      actionFailed: 'That didn’t work. Try again.'
    },
    errors: {
      CLAUDEX_ANNOUNCEMENT_NOT_FOUND: 'That pop-up no longer exists.',
      CLAUDEX_ANNOUNCEMENT_MAIL_OFF: 'This service can’t send e-mail: set up SMTP in the settings first.'
    }
  }
}
