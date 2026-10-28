# The SSH host of the R9 end-to-end test (scripts/ssh-e2e/run.sh): OpenSSH's
# sshd on Alpine (musl, like the Codex Linux runtime), with git, curl and a
# login shell, and two accounts: "dev" signs in with the test's key, "pw"
# with a password only (answered through Claudex's askpass).
#
# The base is node:24-alpine only because the project's checks already use
# it (no extra pull); Node itself is not used on the host.
ARG BASE=node:24-alpine
FROM ${BASE}
RUN for i in 1 2 3 4 5; do \
      apk add --no-cache openssh-server openssh-keygen git curl bash tar && break; \
      echo "apk failed, retrying ($i)" >&2; sleep 5; \
    done \
 && command -v sshd && command -v git && command -v curl
RUN adduser -D -s /bin/bash dev \
 && adduser -D -s /bin/sh pw \
 && mkdir -p /home/dev/.ssh \
 && chmod 700 /home/dev/.ssh \
 && chown dev:dev /home/dev/.ssh
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/ssh-e2e-entrypoint
RUN chmod 755 /usr/local/bin/ssh-e2e-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/ssh-e2e-entrypoint"]
