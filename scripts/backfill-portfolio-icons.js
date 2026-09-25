import mongoose from 'mongoose';
import Project from '../models/Project.js';
import {
  parseGithubRepoUrl,
  findGithubProjectIcon
} from '../services/portfolioImportService.js';
import { uploadToR2 } from '../utils/r2.js';

const dryRun = process.argv.includes('--dry-run');

function extensionFromMime(mimeType = '') {
  const map = {
    'image/svg+xml': 'svg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
    'image/jpeg': 'jpg'
  };
  return map[mimeType] || 'png';
}

function safeName(value = 'project') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';
}
function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid icon data URL');

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

async function githubRepoMetadata(owner, repo) {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'orion-portfolio-icon-backfill',
        ...(process.env.GITHUB_PORTFOLIO_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_PORTFOLIO_TOKEN}` }
          : {})
      }
    }
  );

  if (!response.ok) throw new Error(`GitHub metadata ${response.status}`);
  return response.json();
}
async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not configured');

  await mongoose.connect(process.env.MONGO_URI);

  const projects = await Project.find({
    repoUrl: { $type: 'string', $ne: '' },
    $or: [
      { iconImage: { $exists: false } },
      { iconImage: '' },
      { iconImage: null }
    ]
  }).sort({ order: -1, createdAt: -1 });

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}${projects.length} project(s) need icon backfill`
  );

  const summary = { found: 0, updated: 0, missing: 0, failed: 0 };

  for (const project of projects) {
    const label = project.title_en || project.title_zh || String(project._id);

    try {
      const { owner, repo } = parseGithubRepoUrl(project.repoUrl);
      const metadata = await githubRepoMetadata(owner, repo);
      const icon = await findGithubProjectIcon(
        owner,
        repo,
        metadata.default_branch
      );

      if (!icon) {
        summary.missing += 1;
        console.log(`MISS  ${label} (${project.repoUrl})`);
        continue;
      }

      summary.found += 1;
      console.log(`FOUND ${label} <- ${icon.path}`);

      if (dryRun) continue;

      const { mimeType, buffer } = decodeDataUrl(icon.dataUrl);
      const ext = extensionFromMime(mimeType);
      const key =
        `uploads/portfolio/icons/${safeName(project.title_en || project.title_zh)}-` +
        `${project._id}.${ext}`;

      const url = await uploadToR2(buffer, key, mimeType);
      project.iconImage = url || key;
      await project.save();

      summary.updated += 1;
      console.log(`OK    ${label} -> ${key}`);
    } catch (error) {
      summary.failed += 1;
      console.error(`FAIL  ${label}: ${error.message}`);
    }
  }

  console.log('SUMMARY', JSON.stringify(summary));
  await mongoose.disconnect();

  if (summary.failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);

  try {
    await mongoose.disconnect();
  } catch (disconnectError) {
    console.warn('Failed to disconnect MongoDB cleanly:', disconnectError.message);
  }

  process.exit(1);
});
