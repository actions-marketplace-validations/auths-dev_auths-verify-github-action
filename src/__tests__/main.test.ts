// Test getDefaultCommitRange with mocked GitHub context

jest.mock('@actions/github', () => ({
  context: {
    eventName: '',
    payload: {},
  },
}));

jest.mock('@actions/exec', () => ({
  exec: jest.fn(),
}));

import * as github from '@actions/github';
import * as exec from '@actions/exec';

// Import after mocks are set up
import { getDefaultCommitRange } from '../main';

describe('getDefaultCommitRange', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns base..head for pull_request events', async () => {
    (github.context as any).eventName = 'pull_request';
    (github.context as any).payload = {
      pull_request: {
        base: { sha: 'abc123' },
        head: { sha: 'def456' },
      },
    };

    const range = await getDefaultCommitRange();
    expect(range).toBe('abc123..def456');
  });

  it('returns before..after for push events', async () => {
    (github.context as any).eventName = 'push';
    (github.context as any).payload = {
      before: 'aaa111',
      after: 'bbb222',
    };

    const range = await getDefaultCommitRange();
    expect(range).toBe('aaa111..bbb222');
  });

  it('handles new branch push by using rev-list --not --remotes', async () => {
    (github.context as any).eventName = 'push';
    (github.context as any).payload = {
      before: '0000000000000000000000000000000000000000',
      after: 'newbranch123',
    };

    // Mock exec to simulate git rev-list output with multiple commits
    (exec.exec as jest.Mock).mockImplementation(async (_cmd: string, args: string[], options: any) => {
      if (args && args.includes('--not')) {
        // Simulate rev-list returning multiple commits (newest first)
        const data = Buffer.from('newbranch123\nmidcommit456\nfirstcommit789\n');
        options?.listeners?.stdout?.(data);
      }
      return 0;
    });

    const range = await getDefaultCommitRange();
    expect(range).toBe('firstcommit789^..newbranch123');
  });

  it('falls back to single commit on new branch when rev-list fails', async () => {
    (github.context as any).eventName = 'push';
    (github.context as any).payload = {
      before: '0000000000000000000000000000000000000000',
      after: 'abc999',
    };

    // Mock exec to simulate failure
    (exec.exec as jest.Mock).mockRejectedValue(new Error('git failed'));

    const range = await getDefaultCommitRange();
    expect(range).toBe('abc999^..abc999');
  });

  it('defaults to HEAD^..HEAD for unknown events', async () => {
    (github.context as any).eventName = 'workflow_dispatch';
    (github.context as any).payload = {};

    const range = await getDefaultCommitRange();
    expect(range).toBe('HEAD^..HEAD');
  });
});
