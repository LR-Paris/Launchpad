const express = require('express');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const router = express.Router();

// Project root — when running in Docker the host project is bind-mounted
// at /host/project; outside Docker fall back to two levels up from this file.
const PROJECT_DIR = fs.existsSync('/host/project')
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

// GET /api/system/check-update — compare local version with GitHub
router.get('/check-update', async (req, res) => {
  try {
    const localVersion = readLocalVersion();

    // Try releases first, fall back to tags
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
      // No releases — try tags
      try {
        const tagsData = await httpsGet(
          `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=1`
        );
        const tags = JSON.parse(tagsData);
        if (tags.length > 0) {
          remoteVersion = (tags[0].name || '').replace(/^v/, '');
        }
      } catch {
        // No tags either — check the remote package.json on main
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

    const updateAvailable = remoteVersion && remoteVersion !== localVersion;

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

// POST /api/system/update — pull latest from GitHub and rebuild
router.post('/update', async (req, res) => {
  const log = [];

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

    // Pull latest
    const pull = execSync('git pull origin main 2>&1', {
      cwd: PROJECT_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    log.push(`git pull: ${pull.trim()}`);

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

    res.json({ message: 'Update complete', version: newVersion, log: log.join('\n') });
  } catch (err) {
    log.push(`Error: ${err.message}`);
    res.status(500).json({ error: err.message, log: log.join('\n') });
  }
});

module.exports = router;
