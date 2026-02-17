import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyCommits, VerifyOptions, VerificationResult, FailureType, runPreflightChecks } from './verifier';

async function run(): Promise<void> {
  let tempBundlePath = '';

  try {
    // Run pre-flight checks (shallow clone, ssh-keygen)
    await runPreflightChecks();

    // Get inputs
    const allowedSigners = core.getInput('allowed-signers');
    const identityBundle = core.getInput('identity-bundle');
    const identityBundleJson = core.getInput('identity-bundle-json');
    let commitRange = core.getInput('commit-range');
    const failOnUnsigned = core.getInput('fail-on-unsigned') === 'true';
    const skipMergeCommits = core.getInput('skip-merge-commits') !== 'false';

    // Validate mutually exclusive inputs
    const hasIdentityBundle = identityBundle.length > 0;
    const hasIdentityBundleJson = identityBundleJson.length > 0;
    const hasCustomAllowedSigners = allowedSigners !== '.auths/allowed_signers' && allowedSigners.length > 0;

    if ((hasIdentityBundle || hasIdentityBundleJson) && hasCustomAllowedSigners) {
      throw new Error('Cannot use both allowed-signers and identity-bundle/identity-bundle-json. Choose one verification mode.');
    }

    if (hasIdentityBundle && hasIdentityBundleJson) {
      throw new Error('Cannot use both identity-bundle (file path) and identity-bundle-json (inline JSON). Choose one.');
    }

    // Resolve identity bundle path
    let resolvedBundlePath = identityBundle;
    if (hasIdentityBundleJson) {
      tempBundlePath = path.join(os.tmpdir(), `auths-bundle-${Date.now()}.json`);
      fs.writeFileSync(tempBundlePath, identityBundleJson, 'utf8');
      resolvedBundlePath = tempBundlePath;
      core.info('Using identity bundle from inline JSON input');
    }

    // Determine commit range if not provided
    if (!commitRange) {
      commitRange = await getDefaultCommitRange();
    }

    const verificationMode = resolvedBundlePath ? 'identity-bundle' : 'allowed-signers';
    core.info(`Verifying commits in range: ${commitRange}`);
    core.info(`Verification mode: ${verificationMode}`);
    if (skipMergeCommits) {
      core.info('Merge commits will be skipped');
    }

    // Build options
    const options: VerifyOptions = {
      allowedSignersPath: allowedSigners,
      identityBundlePath: resolvedBundlePath,
      skipMergeCommits,
    };

    // Run verification
    const results = await verifyCommits(commitRange, options);

    // Calculate statistics
    const total = results.length;
    const skipped = results.filter(r => r.skipped).length;
    const passed = results.filter(r => r.valid && !r.skipped).length;
    const failed = results.filter(r => !r.valid).length;
    const allVerified = failed === 0;

    // Set outputs
    core.setOutput('verified', allVerified.toString());
    core.setOutput('results', JSON.stringify(results));
    core.setOutput('total', total.toString());
    core.setOutput('passed', passed.toString());
    core.setOutput('failed', failed.toString());

    // Log results
    core.info('');
    core.info('=== Verification Results ===');
    for (const result of results) {
      if (result.skipped) {
        core.info(`\u2192 ${result.commit} - skipped (${result.skipReason})`);
      } else if (result.valid) {
        const signer = result.signer || 'N/A';
        core.info(`\u2713 ${result.commit} - signed by ${signer}`);
      } else {
        const error = result.error || 'unknown error';
        core.warning(`\u2717 ${result.commit} - ${error}`);
      }
    }

    core.info('');
    core.info(`Total: ${total}, Passed: ${passed}, Skipped: ${skipped}, Failed: ${failed}`);

    // Write GitHub Step Summary
    await writeStepSummary(results, passed, skipped, failed, total);

    // Per-failure-type guidance whenever any commit fails
    if (failed > 0) {
      const failedResults = results.filter(r => !r.valid);
      // Determine dominant failure type (most common)
      const typeCounts: Record<string, number> = {};
      for (const r of failedResults) {
        const t = r.failureType ?? 'error';
        typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      }
      const dominantType = (Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0]) as FailureType;
      const firstFailed = failedResults[0];
      core.warning(fixMessageForType(dominantType, firstFailed.commit, failed));
    }

    // Opt-in PR comment
    const postPrComment = core.getInput('post-pr-comment') === 'true';
    if (postPrComment && github.context.eventName === 'pull_request') {
      const token = core.getInput('github-token', { required: true });
      const octokit = github.getOctokit(token);
      const prNumber = github.context.payload.pull_request!.number;
      const commentBody = buildPrCommentBody(results, passed, skipped, failed, total);
      await octokit.rest.issues.createComment({
        ...github.context.repo,
        issue_number: prNumber,
        body: commentBody,
      });
    }

    // Fail if required
    if (!allVerified && failOnUnsigned) {
      core.setFailed(`${failed} commit(s) failed signature verification`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  } finally {
    // Clean up temp bundle file
    if (tempBundlePath && fs.existsSync(tempBundlePath)) {
      fs.unlinkSync(tempBundlePath);
    }
  }
}

/**
 * Return a human-readable fix message for the dominant failure type.
 */
function fixMessageForType(type: FailureType, commit: string, failedCount: number): string {
  const plural = failedCount > 1;
  const amendCmd = plural
    ? `git rebase HEAD~${failedCount} --exec 'git commit --amend --no-edit -S'\ngit push --force-with-lease`
    : `git commit --amend --no-edit -S\ngit push --force-with-lease`;

  switch (type) {
    case 'unsigned':
      return [
        `Commit ${commit.slice(0, 8)} is not signed.`,
        ``,
        `Install auths:`,
        `  macOS:  brew install auths`,
        `  Linux:  See https://github.com/bordumb/auths/releases/latest`,
        ``,
        `Then re-sign and push:`,
        `  ${amendCmd}`,
        ``,
        `Quickstart: https://github.com/bordumb/auths#quickstart`,
      ].join('\n');

    case 'unknown_signer':
      return [
        `Commit ${commit.slice(0, 8)} is signed but the key is not in the allowed signers.`,
        `Ask a maintainer to add your public key, or check your allowed-signers file.`,
        ``,
        `Export your public key:  auths key export --format pub`,
      ].join('\n');

    case 'invalid_signature':
      return `Commit ${commit.slice(0, 8)} has a corrupted or invalid signature. Re-sign it:\n  ${amendCmd}`;

    default:
      return `Commit ${commit.slice(0, 8)} failed verification. See details above.`;
  }
}

/**
 * Write a Markdown summary to $GITHUB_STEP_SUMMARY
 */
function buildSummaryMarkdown(
  results: VerificationResult[],
  passed: number,
  skipped: number,
  failed: number,
  total: number
): string {
  const lines: string[] = [];
  lines.push('## Auths Commit Verification');
  lines.push('');
  lines.push('| Commit | Status | Details |');
  lines.push('|--------|--------|---------|');

  for (const result of results) {
    const shortSha = `\`${result.commit.substring(0, 8)}\``;

    if (result.skipped) {
      lines.push(`| ${shortSha} | Skipped | ${result.skipReason || 'N/A'} |`);
    } else if (result.valid) {
      const signer = result.signer || 'verified';
      lines.push(`| ${shortSha} | \u2705 Verified | Signed by ${signer} |`);
    } else {
      const error = result.error || 'No signature found';
      lines.push(`| ${shortSha} | \u274c Failed | ${error} |`);
    }
  }

  lines.push('');
  const resultEmoji = failed === 0 ? '\u2705' : '\u274c';
  let resultLine = `**Result:** ${resultEmoji} ${passed}/${total} commits verified`;
  if (skipped > 0) {
    resultLine += ` (${skipped} skipped)`;
  }
  lines.push(resultLine);
  lines.push('');

  if (failed > 0) {
    const failedResults = results.filter(r => !r.valid);
    const typeCounts: Record<string, number> = {};
    for (const r of failedResults) {
      const t = r.failureType ?? 'error';
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
    const dominantType = (Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0]) as FailureType;
    const firstFailed = failedResults[0];
    const plural = failed > 1;
    const amendCmd = plural
      ? `git rebase HEAD~${failed} --exec 'git commit --amend --no-edit -S'\ngit push --force-with-lease`
      : `git commit --amend --no-edit -S\ngit push --force-with-lease`;

    lines.push('---');
    lines.push('### How to fix');
    lines.push('');

    switch (dominantType) {
      case 'unsigned':
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` is not signed. Install auths and re-sign:`);
        lines.push('');
        lines.push('**macOS:** `brew install auths`');
        lines.push('**Linux:** Download from [releases](https://github.com/bordumb/auths/releases/latest)');
        lines.push('');
        lines.push('Then re-sign:');
        lines.push('```');
        lines.push(amendCmd);
        lines.push('```');
        lines.push('');
        lines.push('[Quickstart →](https://github.com/bordumb/auths#quickstart)');
        break;
      case 'unknown_signer':
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` is signed but the key is not in the allowed signers.`);
        lines.push('Ask a maintainer to add your public key, or check your allowed-signers file.');
        lines.push('');
        lines.push('Export your public key:');
        lines.push('```');
        lines.push('auths key export --format pub');
        lines.push('```');
        break;
      case 'invalid_signature':
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` has a corrupted or invalid signature. Re-sign it:`);
        lines.push('```');
        lines.push(amendCmd);
        lines.push('```');
        break;
      default:
        lines.push(`Commit \`${firstFailed.commit.slice(0, 8)}\` failed verification. See the Actions log for details.`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function writeStepSummary(
  results: VerificationResult[],
  passed: number,
  skipped: number,
  failed: number,
  total: number
): Promise<void> {
  if (results.length === 0) {
    return;
  }
  const summary = buildSummaryMarkdown(results, passed, skipped, failed, total);
  await core.summary.addRaw(summary).write();
}

function buildPrCommentBody(
  results: VerificationResult[],
  passed: number,
  skipped: number,
  failed: number,
  total: number
): string {
  return buildSummaryMarkdown(results, passed, skipped, failed, total);
}

/**
 * Determine the default commit range based on the GitHub event context.
 */
export async function getDefaultCommitRange(): Promise<string> {
  const context = github.context;

  if (context.eventName === 'pull_request') {
    const pr = context.payload.pull_request;
    if (pr) {
      return `${pr.base.sha}..${pr.head.sha}`;
    }
  }

  if (context.eventName === 'push') {
    const before = context.payload.before;
    const after = context.payload.after;
    if (before && after) {
      if (before === '0000000000000000000000000000000000000000') {
        let stdout = '';
        try {
          await exec.exec('git', ['rev-list', after, '--not', '--remotes'], {
            listeners: {
              stdout: (data: Buffer) => {
                stdout += data.toString();
              }
            },
            ignoreReturnCode: true
          });
          const commits = stdout.trim().split('\n').filter(l => l.length > 0);
          if (commits.length > 0) {
            const oldest = commits[commits.length - 1];
            return `${oldest}^..${after}`;
          }
        } catch {
          // Fall through to single commit
        }
        return `${after}^..${after}`;
      }
      return `${before}..${after}`;
    }
  }

  return 'HEAD^..HEAD';
}

run();
