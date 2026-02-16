import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyCommits, VerifyOptions, VerificationResult, runPreflightChecks } from './verifier';

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

    // Enhanced failure message when all commits are unsigned
    if (failed > 0 && failed === total - skipped) {
      core.warning(
        'No signed commits found. To sign commits with auths:\n' +
        '1. Install: cargo install auths-cli\n' +
        '2. Set up: auths setup\n' +
        '3. Sign: git commit -S\n' +
        'Docs: https://github.com/bordumb/auths#readme'
      );
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
 * Write a Markdown summary to $GITHUB_STEP_SUMMARY
 */
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
  lines.push(`**Result:** ${resultEmoji} ${passed}/${total} commits verified`);
  if (skipped > 0) {
    lines.push(` (${skipped} skipped)`);
  }
  lines.push('');

  const summary = lines.join('\n');
  await core.summary.addRaw(summary).write();
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
