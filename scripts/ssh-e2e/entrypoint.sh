#!/bin/sh
# The SSH test host's start: a fresh host key for every container (so each
# run meets an unknown host and the known_hosts question), the test's public
# key for "dev", the test's password for "pw", then sshd in the foreground.
set -eu
rm -f /etc/ssh/ssh_host_*
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
if [ -f /e2e/authorized_keys ]; then
  install -m 600 -o dev -g dev /e2e/authorized_keys /home/dev/.ssh/authorized_keys
fi
# Accounts must not be locked ("!"): sshd refuses a locked account even with a key.
printf 'dev:%s\n' "$(head -c 24 /dev/urandom | base64)" | chpasswd
printf 'pw:%s\n' "${E2E_PASSWORD:?E2E_PASSWORD is not set}" | chpasswd
# A git identity for the repository the test commits in.
su dev -c 'git config --global user.email dev@example.test && git config --global user.name Dev'
# Let the test read the host key's fingerprint (it checks the prompt shows it).
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}' > /run/host-fingerprint
exec /usr/sbin/sshd -D -e
