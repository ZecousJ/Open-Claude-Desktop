// CLAUDEX: texts of the Service status console page (admin.claudexStatus).
export default {
  claudexStatus: {
    nav: 'Service status',
    title: 'Service status',
    description:
      'What the Claudex apps show on their Service status page: each channel (the channel monitors, by their names) with a bar a day, and the incidents you handle here.',
    level: { none: 'No data', operational: 'Operational', degraded: 'Degraded', outage: 'Outage' },
    status: { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' },
    impact: { degraded: 'Degraded performance', outage: 'Major outage' },
    channels: {
      title: 'Channels',
      hint: 'From the channel monitors (Channels → Monitoring). Counted every 5 minutes and kept for 400 days. A day’s colour is its uptime: 90% and up green, 80–90% yellow (degraded), below 80% red (outage); slow checks count as passed.',
      none: 'No channel monitor is on yet. Add one under Channels → Monitoring to fill the bars.',
      uptime: '{x} uptime',
      components: '{n} models'
    },
    incidents: {
      title: 'Incidents',
      hint: 'When a channel fails twice in a row an incident is detected and waits here as a draft: people see it only after you approve it. A detected incident resolves by itself once the channels pass again — unless you have posted an update to it, then it stays until you resolve it.',
      draft: 'Pending approval',
      approve: 'Approve and publish',
      unpublish: 'Take offline',
      new: 'New incident',
      none: 'No incidents in the last 90 days.',
      auto: 'Automatic',
      started: 'Started {date}',
      resolved: 'Resolved {date}',
      post: 'Post update',
      edit: 'Edit',
      history: 'Updates ({n})',
      deleteTitle: 'Delete this incident?',
      deleteMessage: 'It disappears from the status page with its updates. To close it for people, resolve it instead.'
    },
    fields: {
      title: 'Title',
      platform: 'Channel',
      allServices: 'All services',
      impact: 'Impact',
      status: 'Status',
      message: 'Message',
      messageHint: 'People see the latest message under the title.',
      updateMessage: 'Message for this update',
      publishNow: 'Publish now (people see it on the status page)'
    },
    actions: { create: 'Open incident', save: 'Save', post: 'Post', cancel: 'Cancel' },
    saved: 'Saved.',
    errors: {
      CLAUDEX_STATUS_INVALID: 'Check the fields: {message}',
      CLAUDEX_STATUS_INCIDENT_NOT_FOUND: 'That incident no longer exists.',
      CLAUDEX_STATUS_UNAVAILABLE: 'Service status needs the database.'
    }
  }
}
