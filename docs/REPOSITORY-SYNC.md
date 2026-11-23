# Repository sync and marketplace listing

Status: the GitHub repository exists and is the marketplace URL; the GitCode
Push mirror still has to be enabled in the GitCode web UI (CLI cannot do it).
This document records the topology, the exact setup, the token permissions, and
the verification/rollback steps.

## 1. Topology

| Role | URL | Notes |
|---|---|---|
| Development source | `https://gitcode.com/gentle-knight/dsh-cannbot-connect` | commit and push here |
| Marketplace / install entry | `https://github.com/gentle-knight/dsh-cannbot-connect` | automatic Push mirror; `package.json.repository` points here |
| Marketplace index | `awesome-dsh-plugin/awesome-dsh-plugin` → `data/plugins/gentle-knight__dsh-cannbot-connect.yml` | category `model`; already present |

The marketplace requires a GitHub URL. GitCode's built-in **Push mirror** copies
the GitCode repository to GitHub on every commit, including branches, tags, and
commit metadata. It force-overwrites the target, so GitHub is a mirror, not a
second development location.

## 2. Required GitHub token

Create a **fine-grained personal access token** at GitHub → Settings →
Developer settings → Personal access tokens → Fine-grained tokens:

- **Repository access**: only `gentle-knight/dsh-cannbot-connect`.
- **Permissions**: `Contents: Read and write`; `Metadata: Read-only` is included
  automatically.
- No Actions, Packages, Administration, or organization permissions are needed.
- Set an expiry you can rotate; a classic token with `repo` scope also works but
  is broader than necessary.

Do not commit the token, put it in the README, paste it into an issue, or send it
in chat. It belongs only in the GitCode mirror settings. Revoke and reissue it
from GitHub if it leaks.

## 3. Configure the GitCode Push mirror

This is a GitCode web-UI operation; there is no repository file or CLI command
for it.

1. Open the GitCode project → **项目设置 / Project settings**.
2. Open **仓库镜像 / Repository mirroring**.
3. Select **Push** → **添加镜像 / Add mirror**.
4. Fill in:
   - Target URL: `https://gentle-knight@github.com/gentle-knight/dsh-cannbot-connect.git`
   - Target platform account: `gentle-knight`
   - Personal access token: the fine-grained token from §2
5. Save. GitCode triggers a sync on every subsequent commit; up to five Push
   mirrors are supported. Code push timeout is 30 minutes (LFS 150 minutes).

GitCode documents the feature at
<https://docs.gitcode.com/docs/help/home/org_project/project_manage/project_settings/repository_mirroring/>.

## 4. Bootstrap when GitHub is behind

If the mirror is not configured yet and GitHub still points at an old commit,
push the current `main` once from a machine that has GitHub credentials:

```bash
git push https://github.com/gentle-knight/dsh-cannbot-connect.git main
```

After the GitCode Push mirror is enabled, do **not** keep pushing directly to
GitHub: the next GitCode commit overwrites the GitHub branch. Direct pushes are
only for the initial bootstrap or emergency repair.

## 5. Verification

```bash
git ls-remote https://gitcode.com/gentle-knight/dsh-cannbot-connect.git refs/heads/main
git ls-remote https://github.com/gentle-knight/dsh-cannbot-connect.git refs/heads/main
```

- The two SHAs must match after the mirror completes.
- On GitHub, the repository's `updated_at` should advance and the file tree
  should show the new `package.json` version, README, `docs/`, `locale/`, and
  `lib/`.
- The GitHub repository must keep the `dsh-plugin` topic; it is already set.
- The marketplace publishes from the repository on its own build schedule; a
  marketplace entry update (description, category, icon) is a separate PR to
  `awesome-dsh-plugin/awesome-dsh-plugin`.

Useful checks:

```bash
# GitHub raw copy of the manifest
curl -sS https://raw.githubusercontent.com/gentle-knight/dsh-cannbot-connect/main/package.json | head

# GitHub repository metadata (topics, default branch, update time)
curl -sS https://api.github.com/repos/gentle-knight/dsh-cannbot-connect
```

## 6. Caveats

- **Force overwrite**: any commit made directly on GitHub is lost on the next
  GitCode sync. This includes edits made in the GitHub web editor.
- **Tags and branches** are mirrored too; do not create a GitHub-only tag.
- **Secrets**: the mirror configuration holds the only copy of the token.
  Never add a `mirror` workflow that embeds a token in a repository file.
- **Private dependencies**: the repository contains no runtime dependency and
  no install script, so the mirror is a plain source copy; no package-manager
  credentials are needed.
- **Marketplace cache**: storefronts and the awesome index rebuild on their own
  schedule; a GitHub update is not instant everywhere. The entry file itself
  lives in the awesome repository and is not modified by the mirror.
- **README badge**: the `verify` badge points at the GitHub Actions workflow;
  it only turns green after the workflow runs on GitHub.
- **Screenshots/icon**: marketplace screenshots are optional raster images
  declared in `screenshots.json`; the marketplace icon must be a GitHub-hosted
  PNG/JPG/WebP declared in the awesome entry. The repository's `icon.svg` is for
  DSH's Plugin Manager, not for the marketplace icon field.

## 7. Disable or roll back

- Disable/remove the Push mirror in GitCode → Project settings → Repository
  mirroring. GitHub then stops receiving updates but keeps its last content.
- To restore an older GitHub state, check out the desired commit locally and
  force-push it to GitHub only after the mirror is disabled; otherwise the next
  GitCode commit overwrites it again.
- To restore a broken GitCode→GitHub sync, re-check the token permissions first
  (Contents read/write on that exact repository), then re-save the mirror.
