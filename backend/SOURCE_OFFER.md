# Source offer for the Claudex server / Claudex 服务端源码获取

The Claudex server is a modified version of [Sub2API](https://github.com/Wei-Shaw/sub2api)
(upstream commit `a3eb7ef302961cba716dc78b39b93b60c467db0e`). It is licensed under the GNU Lesser
General Public License v3.0 (`LICENSE`), which builds on the GNU General Public License v3.0
(`COPYING`). The changes are listed in [`CLAUDEX_CHANGES.md`](CLAUDEX_CHANGES.md); the date of each
change is in the git history (`git log -- backend/`).

Claudex 服务端是 Sub2API 的修改版，按 LGPL-3.0 发布（`LICENSE`；LGPL-3.0 以 GPL-3.0 为基础，全文见
`COPYING`）。修改清单见 `CLAUDEX_CHANGES.md`，每项修改的日期见 git 历史。

## Corresponding source / 对应源码

Every image or binary of the Claudex server is built from one commit of the Claudex repository
(<https://github.com/ZecousJ/Open-Claude-Desktop>). Its corresponding source is:

- the `backend/` directory at that commit (Go server, Vue admin console, `docs/legal`, and these
  license files), and
- the build scripts at the same commit: `deploy/claudex-server/Dockerfile` with
  `deploy/claudex-server/Dockerfile.dockerignore` and `build-image.sh` for the image,
  `deploy/sub2api/build-from-source.sh` for a binary built without Docker.

The commit is recorded in the build:

- image: `/app/SOURCE.txt` and the OCI labels `org.opencontainers.image.source`,
  `org.opencontainers.image.revision` and `org.opencontainers.image.licenses=LGPL-3.0-only`;
- binary: `SOURCE.txt` next to it, and `sub2api --version` (`<upstream version>+claudex.<N>`).

A build whose commit ends in `-dirty` (or is `unknown`) has no exact corresponding source and must
not be distributed.

每个镜像或二进制都从 Claudex 仓库的某一个提交构建，对应源码是该提交的 `backend/` 目录加同一提交的
构建脚本（镜像：`deploy/claudex-server/Dockerfile`、`Dockerfile.dockerignore`、`build-image.sh`；
不用 Docker 的二进制：`deploy/sub2api/build-from-source.sh`）。提交号写在镜像的 `/app/SOURCE.txt`
与 OCI 标签里、二进制旁的 `SOURCE.txt` 里。提交号带 `-dirty` 或为 `unknown` 的构建没有确切的对应源码，
不得分发。

## When you distribute the server / 分发时

Anyone who gives a copy of the server image or binary to someone else must also give them access to the corresponding source above, under
the LGPL-3.0, for example by:

- a link to that commit of the repository, when the repository is public; or
- the source itself alongside the image or binary, for example
  `git archive --format=tar.gz -o claudex-server-src.tar.gz <commit> backend deploy/claudex-server deploy/sub2api`,
  when the repository is private.

Keep `LICENSE`, `COPYING`, `CLA.md`, the upstream README files and the copyright notices unchanged,
and record every further change to upstream files in `CLAUDEX_CHANGES.md`.

向他人提供服务端镜像或二进制时，必须同时按 LGPL-3.0 提供上述对应源码：仓库公开时可给出该提交的链接；
仓库不公开时随镜像或二进制附上源码包（例如上面的 `git archive` 命令）。保留 `LICENSE`、`COPYING`、
`CLA.md`、上游 README 与版权声明，继续修改上游文件时在 `CLAUDEX_CHANGES.md` 登记。

The Claudex desktop app (Apache-2.0, everything outside `backend/`) contains no code from this
directory; it talks to the server over HTTP only.

Claudex 桌面端（Apache-2.0，即 `backend/` 以外的全部代码）不包含本目录的代码，只通过 HTTP 与服务端通信。

## Upstream notice for the owner / 给所有者的上游声明

The upstream README (`README.md`, section “Important Notice”; `README_CN.md`) states that the
Sub2API developers have never authorized any individual or organization to operate a commercial
service based on the project, and that anyone who does so bears the resulting disputes and
liabilities alone. It also warns about upstream providers' terms of service. This is recorded here
as written; it is not a legal assessment. Read it before offering the server to others.

上游 README（`README.md` 的 “Important Notice”、`README_CN.md` 的“无商业授权”）声明其开发者从未授权
任何个人或组织基于该项目开展商业化运营，相关纠纷与责任由行为方自行承担；并提醒使用可能违反上游服务商条款。
这里只如实记录，不作法律判断；对外提供服务前请先阅读。
