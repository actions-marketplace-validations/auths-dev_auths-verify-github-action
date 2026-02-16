import { getAuthsDownloadUrl, getBinaryName, getCommitsInRange, verifyChecksum } from '../verifier';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Mock os module for cross-platform testing
jest.mock('os', () => {
  const realOs = jest.requireActual('os');
  return {
    platform: jest.fn(),
    arch: jest.fn(),
    homedir: jest.fn(() => '/home/test'),
    tmpdir: jest.fn(() => realOs.tmpdir()),
  };
});

jest.mock('@actions/exec', () => ({
  exec: jest.fn(),
}));

jest.mock('@actions/tool-cache', () => ({
  downloadTool: jest.fn(),
  extractTar: jest.fn(),
  extractZip: jest.fn(),
  cacheDir: jest.fn(),
  find: jest.fn(),
}));

const mockOs = require('os');
const mockExec = require('@actions/exec');
const mockTc = require('@actions/tool-cache');

describe('getAuthsDownloadUrl', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns Linux x86_64 tar.gz URL for latest', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('');
    expect(url).toBe(
      'https://github.com/bordumb/auths/releases/latest/download/auths-linux-x86_64.tar.gz'
    );
  });

  it('returns macOS aarch64 tar.gz URL for latest', () => {
    mockOs.platform.mockReturnValue('darwin');
    mockOs.arch.mockReturnValue('arm64');

    const url = getAuthsDownloadUrl('');
    expect(url).toBe(
      'https://github.com/bordumb/auths/releases/latest/download/auths-macos-aarch64.tar.gz'
    );
  });

  it('returns Windows x86_64 zip URL for latest', () => {
    mockOs.platform.mockReturnValue('win32');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('');
    expect(url).toBe(
      'https://github.com/bordumb/auths/releases/latest/download/auths-windows-x86_64.zip'
    );
  });

  it('returns versioned URL when version specified', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('0.5.0');
    expect(url).toBe(
      'https://github.com/bordumb/auths/releases/download/v0.5.0/auths-linux-x86_64.tar.gz'
    );
  });

  it('returns null for unsupported platform', () => {
    mockOs.platform.mockReturnValue('freebsd');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('');
    expect(url).toBeNull();
  });

  it('returns null for unsupported architecture', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('s390x');

    const url = getAuthsDownloadUrl('');
    expect(url).toBeNull();
  });

  it('returns macOS x86_64 URL', () => {
    mockOs.platform.mockReturnValue('darwin');
    mockOs.arch.mockReturnValue('x64');

    const url = getAuthsDownloadUrl('');
    expect(url).toBe(
      'https://github.com/bordumb/auths/releases/latest/download/auths-macos-x86_64.tar.gz'
    );
  });

  it('returns Linux aarch64 URL', () => {
    mockOs.platform.mockReturnValue('linux');
    mockOs.arch.mockReturnValue('arm64');

    const url = getAuthsDownloadUrl('');
    expect(url).toBe(
      'https://github.com/bordumb/auths/releases/latest/download/auths-linux-aarch64.tar.gz'
    );
  });
});

describe('getBinaryName', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns auths.exe on Windows', () => {
    mockOs.platform.mockReturnValue('win32');
    expect(getBinaryName()).toBe('auths.exe');
  });

  it('returns auths on Linux', () => {
    mockOs.platform.mockReturnValue('linux');
    expect(getBinaryName()).toBe('auths');
  });

  it('returns auths on macOS', () => {
    mockOs.platform.mockReturnValue('darwin');
    expect(getBinaryName()).toBe('auths');
  });
});

describe('getCommitsInRange', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('calls git rev-list without --no-merges when skipMerges is false', async () => {
    mockExec.exec.mockImplementation(async (_cmd: string, args: string[], options: any) => {
      const data = Buffer.from('abc123\ndef456\n');
      options?.listeners?.stdout?.(data);
      return 0;
    });

    const commits = await getCommitsInRange('HEAD~2..HEAD', false);
    expect(commits).toEqual(['abc123', 'def456']);
    expect(mockExec.exec).toHaveBeenCalledWith(
      'git',
      ['rev-list', 'HEAD~2..HEAD'],
      expect.any(Object)
    );
  });

  it('calls git rev-list with --no-merges when skipMerges is true', async () => {
    mockExec.exec.mockImplementation(async (_cmd: string, args: string[], options: any) => {
      const data = Buffer.from('abc123\n');
      options?.listeners?.stdout?.(data);
      return 0;
    });

    const commits = await getCommitsInRange('HEAD~2..HEAD', true);
    expect(commits).toEqual(['abc123']);
    expect(mockExec.exec).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--no-merges', 'HEAD~2..HEAD'],
      expect.any(Object)
    );
  });

  it('returns empty array for empty output', async () => {
    mockExec.exec.mockImplementation(async (_cmd: string, _args: string[], options: any) => {
      const data = Buffer.from('');
      options?.listeners?.stdout?.(data);
      return 0;
    });

    const commits = await getCommitsInRange('HEAD~0..HEAD', false);
    expect(commits).toEqual([]);
  });
});

describe('verifyChecksum', () => {
  const testDir = path.join(require('os').tmpdir(), 'auths-test-checksum');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    jest.resetAllMocks();
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('passes when checksum matches', async () => {
    // Create a test file
    const testFile = path.join(testDir, 'test.tar.gz');
    const content = 'test binary content';
    fs.writeFileSync(testFile, content);

    // Compute its hash
    const hash = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');

    // Create checksum file
    const checksumFile = path.join(testDir, 'test.tar.gz.sha256');
    fs.writeFileSync(checksumFile, `${hash}  test.tar.gz\n`);

    // Mock tc.downloadTool to return the checksum file path
    mockTc.downloadTool.mockResolvedValue(checksumFile);

    // Should not throw
    await expect(verifyChecksum('https://example.com/test.tar.gz', testFile)).resolves.toBeUndefined();
  });

  it('throws when checksum does not match', async () => {
    const testFile = path.join(testDir, 'test.tar.gz');
    fs.writeFileSync(testFile, 'real content');

    const checksumFile = path.join(testDir, 'test.tar.gz.sha256');
    fs.writeFileSync(checksumFile, 'deadbeef00000000000000000000000000000000000000000000000000000000  test.tar.gz\n');

    mockTc.downloadTool.mockResolvedValue(checksumFile);

    await expect(verifyChecksum('https://example.com/test.tar.gz', testFile))
      .rejects.toThrow('checksum mismatch');
  });

  it('warns but continues when checksum file not available', async () => {
    const testFile = path.join(testDir, 'test.tar.gz');
    fs.writeFileSync(testFile, 'content');

    // Mock download failure (404)
    mockTc.downloadTool.mockRejectedValue(new Error('HTTP 404'));

    // Should not throw
    await expect(verifyChecksum('https://example.com/test.tar.gz', testFile)).resolves.toBeUndefined();
  });
});
