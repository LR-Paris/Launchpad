const express = require('express');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const router = express.Router();

// Project root — when running in Docker the host project is bind-mounted
// at /host/project; outside Docker fall back to two levels up from this file.
const IS_DOCKER = fs.existsSync('/host/project');
const PROJECT_DIR = IS_DOCKER
  ? '/host/project'
  : path.join(__dirname, '..', '..');

const GITHUB_REPO = 'LR-Paris/Launchpad';

function readLocalVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_DIR, 'frontend', 'package.json'), 'utf8')
    );
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getGitInfo() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: PROJECT_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    const commit = execSync('git rev-parse --short HEAD', {
      cwd: PROJECT_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    return { branch, commit };
  } catch {
    return { branch: 'unknown', commit: 'unknown' };
  }
}

// Simple semver comparison: returns true if remote is newer than local
function isNewer(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

// Simple https GET helper that returns a promise
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Launchpad-Updater' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// GET /api/system/version — current platform version + git info
router.get('/version', (req, res) => {
  const version = readLocalVersion();
  const git = getGitInfo();
  res.json({ version, git });
});

// GET /api/system/branches — list available remote branches
router.get('/branches', async (req, res) => {
  try {
    // Fetch latest refs from remote
    try {
      execSync('git fetch --all 2>&1', {
        cwd: PROJECT_DIR,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch {
      // If fetch fails, still try to list what we have locally
    }

    const raw = execSync('git branch -r --format="%(refname:short)" 2>&1', {
      cwd: PROJECT_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();

    const branches = raw
      .split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('HEAD'))
      .map(b => b.replace(/^origin\//, ''));

    // De-duplicate
    const unique = [...new Set(branches)];

    const git = getGitInfo();

    res.json({ branches: unique, currentBranch: git.branch });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system/check-update — compare local version with GitHub
router.get('/check-update', async (req, res) => {
  try {
    const localVersion = readLocalVersion();

    // Try releases first, fall back to tags, then raw package.json
    let remoteVersion = null;
    let releaseUrl = null;

    try {
      const releaseData = await httpsGet(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
      );
      const release = JSON.parse(releaseData);
      remoteVersion = (release.tag_name || '').replace(/^v/, '');
      releaseUrl = release.html_url;
    } catch {
      try {
        const tagsData = await httpsGet(
          `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=1`
        );
        const tags = JSON.parse(tagsData);
        if (tags.length > 0) {
          remoteVersion = (tags[0].name || '').replace(/^v/, '');
        }
      } catch {
        try {
          const raw = await httpsGet(
            `https://raw.githubusercontent.com/${GITHUB_REPO}/main/frontend/package.json`
          );
          const pkg = JSON.parse(raw);
          remoteVersion = pkg.version || null;
        } catch {
          // ignore
        }
      }
    }

    const updateAvailable = !!(remoteVersion && isNewer(remoteVersion, localVersion));

    res.json({
      localVersion,
      remoteVersion: remoteVersion || 'unknown',
      updateAvailable,
      releaseUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Strict branch name validation to prevent command injection
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;

// POST /api/system/update — pull latest from GitHub and rebuild
router.post('/update', async (req, res) => {
  const log = [];
  const { branch } = req.body || {};
  const targetBranch = branch || 'main';

  if (!SAFE_BRANCH_RE.test(targetBranch)) {
    return res.status(400).json({ error: 'Invalid branch name.' });
  }

  try {
    // Ensure we're in a git repo
    try {
      execSync('git status', { cwd: PROJECT_DIR, stdio: 'pipe' });
    } catch {
      return res.status(400).json({ error: 'Project directory is not a git repository.' });
    }

    // Stash any local changes
    try {
      const stash = execSync('git stash 2>&1', {
        cwd: PROJECT_DIR,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      log.push(`git stash: ${stash.trim()}`);
    } catch (e) {
      log.push(`git stash warning: ${e.message}`);
    }

    // Switch to target branch if different from current
    const currentBranch = getGitInfo().branch;
    if (targetBranch !== currentBranch) {
      try {
        // Fetch to ensure we have the branch
        execSync(`git fetch origin ${targetBranch} 2>&1`, {
          cwd: PROJECT_DIR, stdio: 'pipe', encoding: 'utf8', timeout: 30000,
        });
        const checkout = execSync(`git checkout ${targetBranch} 2>&1`, {
          cwd: PROJECT_DIR, stdio: 'pipe', encoding: 'utf8',
        });
        log.push(`git checkout ${targetBranch}: ${checkout.trim()}`);
      } catch (e) {
        // Branch might not exist locally yet — try tracking it
        try {
          const checkout = execSync(`git checkout -b ${targetBranch} origin/${targetBranch} 2>&1`, {
            cwd: PROJECT_DIR, stdio: 'pipe', encoding: 'utf8',
          });
          log.push(`git checkout -b ${targetBranch}: ${checkout.trim()}`);
        } catch (e2) {
          log.push(`Failed to switch to branch ${targetBranch}: ${e2.message}`);
          try { execSync('git stash pop 2>&1', { cwd: PROJECT_DIR, stdio: 'pipe' }); } catch {}
          return res.status(500).json({ error: `Could not switch to branch "${targetBranch}".`, log: log.join('\n') });
        }
      }
    }

    // Pull latest
    try {
      const pull = execSync(`git pull origin ${targetBranch} 2>&1`, {
        cwd: PROJECT_DIR,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 60000,
      });
      log.push(`git pull origin ${targetBranch}: ${pull.trim()}`);
    } catch (e) {
      log.push(`git pull failed: ${e.stderr || e.message}`);
      // Try to restore stash before returning error
      try { execSync('git stash pop 2>&1', { cwd: PROJECT_DIR, stdio: 'pipe' }); } catch {}
      return res.status(500).json({ error: 'Git pull failed.', log: log.join('\n') });
    }

    // Pop stash if we had one
    try {
      const pop = execSync('git stash pop 2>&1', {
        cwd: PROJECT_DIR,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      log.push(`git stash pop: ${pop.trim()}`);
    } catch {
      log.push('git stash pop: nothing to pop or conflict (check manually)');
    }

    // Read new version
    const newVersion = readLocalVersion();
    log.push(`Updated to version: ${newVersion}`);

    // In Docker: attempt to trigger container rebuild so changes take effect
    if (IS_DOCKER) {
      const hostDir = process.env.HOST_PROJECT_DIR;
      if (hostDir) {
        try {
          // Spawn a helper container that mounts the host project at its REAL host path
          // so docker compose can correctly resolve relative volume mounts
          execSync(
            `docker run -d --rm --name launchpad-updater ` +
            `-v /var/run/docker.sock:/var/run/docker.sock ` +
            `-v "${hostDir}":"${hostDir}" ` +
            `-w "${hostDir}" ` +
            `docker:cli sh -c "sleep 5 && docker compose up -d --build"`,
            { stdio: 'pipe', encoding: 'utf8', timeout: 30000 }
          );
          log.push('Rebuild triggered — containers will restart in ~30 seconds.');
        } catch {
          log.push(`Auto-rebuild not available. Run on host: cd ${hostDir} && docker compose up -d --build`);
        }
      } else {
        log.push('Run on host to apply: docker compose up -d --build');
      }
    }

    res.json({ message: 'Update complete', version: newVersion, log: log.join('\n') });
  } catch (err) {
    log.push(`Error: ${err.message}`);
    res.status(500).json({ error: err.message, log: log.join('\n') });
  }
});

module.exports = router;
