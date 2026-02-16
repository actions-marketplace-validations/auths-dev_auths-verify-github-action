# Auths Verify Action

Verify commit signatures using [Auths](https://github.com/bordumb/auths) identity keys. Ensures every commit in a PR or push is cryptographically signed by an authorized developer.

## Quickstart

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: bordumb/auths-verify-action@v1
  with:
    allowed-signers: '.auths/allowed_signers'
```

That's it. The action auto-detects the commit range from the GitHub event (PR or push), downloads the `auths` CLI, and verifies each commit.

## Features

- Verifies SSH commit signatures against allowed signers or identity bundles
- Auto-detects commit range from pull request or push events
- Downloads and caches the `auths` CLI automatically (with SHA256 checksum verification)
- Skips merge commits by default
- Gracefully handles GPG-signed commits (skips rather than fails)
- Generates a GitHub Step Summary with per-commit results table
- Pre-flight checks: detects shallow clones and missing `ssh-keygen`

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `allowed-signers` | Path to allowed_signers file | No | `.auths/allowed_signers` |
| `identity-bundle` | Path to identity bundle JSON file (alternative to allowed-signers) | No | `''` |
| `identity-bundle-json` | Raw identity bundle JSON content (written to temp file automatically) | No | `''` |
| `commit-range` | Git commit range to verify (e.g. `HEAD~5..HEAD`) | No | Auto-detected from event |
| `auths-version` | Auths CLI version to use (e.g. `0.5.0`) | No | `''` (latest) |
| `fail-on-unsigned` | Whether to fail the action if unsigned commits are found | No | `true` |
| `skip-merge-commits` | Whether to skip merge commits during verification | No | `true` |

> **Note:** `allowed-signers` and `identity-bundle`/`identity-bundle-json` are mutually exclusive. Use one verification mode or the other.

## Outputs

| Output | Description |
|--------|-------------|
| `verified` | `true` if all commits passed verification |
| `results` | JSON array of per-commit verification results |
| `total` | Total number of commits checked |
| `passed` | Number of commits that passed verification |
| `failed` | Number of commits that failed verification |

## Verification Modes

### Mode 1: Allowed Signers File (default)

Commit the team's public keys to your repo:

```
# .auths/allowed_signers
alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
bob@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

```yaml
- uses: bordumb/auths-verify-action@v1
  with:
    allowed-signers: '.auths/allowed_signers'
```

### Mode 2: Identity Bundle (stateless CI)

Export your identity bundle locally and store it as a GitHub secret:

```bash
auths id export-bundle --alias mykey --output bundle.json
gh secret set AUTHS_IDENTITY_BUNDLE < bundle.json
```

Then use the secret in your workflow:

```yaml
- uses: bordumb/auths-verify-action@v1
  with:
    identity-bundle-json: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
```

Or commit the bundle (it contains only public data) and reference the file:

```yaml
- uses: bordumb/auths-verify-action@v1
  with:
    identity-bundle: '.auths/identity-bundle.json'
```

## Example Workflows

### Basic PR Verification

```yaml
name: Verify Commits
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: bordumb/auths-verify-action@v1
        with:
          allowed-signers: '.auths/allowed_signers'
```

### Identity Bundle with Secret

```yaml
name: Verify Commits
on: [pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: bordumb/auths-verify-action@v1
        with:
          identity-bundle-json: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
```

### Non-blocking (Warn Only)

```yaml
- uses: bordumb/auths-verify-action@v1
  with:
    allowed-signers: '.auths/allowed_signers'
    fail-on-unsigned: 'false'
```

### Using Outputs

```yaml
- name: Verify commits
  id: verify
  uses: bordumb/auths-verify-action@v1
  with:
    allowed-signers: '.auths/allowed_signers'
    fail-on-unsigned: 'false'

- name: Comment on PR
  if: steps.verify.outputs.verified == 'false'
  uses: actions/github-script@v7
  with:
    script: |
      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `${context.actor}, ${steps.verify.outputs.failed} of ${steps.verify.outputs.total} commits are unsigned.`
      })
```

### Org-Wide Reusable Workflow

Store in your org's `.github` repo at `.github/workflows/auths-verify.yml`:

```yaml
name: Auths Verify
on:
  workflow_call:
    inputs:
      mode:
        description: 'warn or enforce'
        type: string
        default: 'enforce'
    secrets:
      AUTHS_IDENTITY_BUNDLE:
        required: false

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: bordumb/auths-verify-action@v1
        with:
          identity-bundle-json: ${{ secrets.AUTHS_IDENTITY_BUNDLE }}
          fail-on-unsigned: ${{ inputs.mode == 'enforce' && 'true' || 'false' }}
```

Then each repo opts in:

```yaml
name: Verify
on: [pull_request]
jobs:
  auths:
    uses: your-org/.github/.github/workflows/auths-verify.yml@main
    with:
      mode: enforce
    secrets: inherit
```

## Requirements

- **`fetch-depth: 0`** on `actions/checkout` (the action detects shallow clones and provides a fix message)
- Commits must be SSH-signed (the action downloads `auths` CLI automatically)
- OpenSSH 8.0+ on the runner (pre-installed on GitHub-hosted runners)

## How It Works

1. Runs pre-flight checks (shallow clone detection, ssh-keygen availability)
2. Downloads and caches the `auths` CLI binary (with SHA256 checksum verification)
3. Determines the commit range from the GitHub event context
4. Runs `auths verify-commit` with `--json` output
5. Parses results, skipping merge commits and GPG-signed commits
6. Writes a Markdown summary table to GitHub Step Summary
7. Sets outputs and fails the workflow if unsigned commits are found (configurable)

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- [Auths](https://github.com/bordumb/auths) - Decentralized identity for developers
- [Auths CLI](https://github.com/bordumb/auths/tree/main/crates/auths-cli) - Command-line tool
- [Signing commits with Auths](https://github.com/bordumb/auths#readme) - Setup guide
