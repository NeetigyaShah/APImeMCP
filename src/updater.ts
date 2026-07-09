import { execSync } from 'node:child_process';

// Note: this repo's default branch is "master", not "main" - confirmed live
// against the GitHub API (a hardcoded "main" 404s with "No commit found for
// SHA: main"). If the default branch is ever renamed, update this.
const REPO_COMMITS_URL = 'https://api.github.com/repos/neetigyashah/apimemcp/commits/master';

export interface UpdateStatus {
  updateAvailable: boolean;
  latestCommit: string | null;
}

function getLocalCommitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const localSha = getLocalCommitSha();
  if (!localSha) {
    return { updateAvailable: false, latestCommit: null };
  }

  try {
    const response = await fetch(REPO_COMMITS_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'APImeMCP' },
    });
    if (!response.ok) {
      return { updateAvailable: false, latestCommit: null };
    }
    const data = (await response.json()) as { sha?: string };
    const latestCommit = data.sha ?? null;
    if (!latestCommit) {
      return { updateAvailable: false, latestCommit: null };
    }
    return { updateAvailable: latestCommit !== localSha, latestCommit };
  } catch {
    return { updateAvailable: false, latestCommit: null };
  }
}
