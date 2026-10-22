import fs from 'node:fs';
import path from 'node:path';

describe('README-first portfolio import contract', () => {
  const root = process.cwd();
  const service = fs.readFileSync(path.join(root, 'services/portfolioImportService.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'routes/projects.js'), 'utf8');

  test('English portfolio copy is sourced from README-derived fields', () => {
    expect(service).toContain('title_en: readmeTitleEn');
    expect(service).toContain('summary_en: readmeSummaryEn');
    expect(service).toContain('description_en: readmeDescriptionEn');
    expect(service).toContain('readmeBacked: Boolean(readme)');
  });

  test('README artwork is reused before generating a cover', () => {
    expect(service).toContain('coverImage: readmeCover');
    expect(service).toContain("if (!readmeCover && options.generateCover !== false)");
    expect(service).toContain('generateCloudflarePortfolioCover(');
  });

  test('stream and preview routes honor generateCover', () => {
    const matches = routes.match(/generateCover: req\.body\.generateCover !== false/g) || [];
    expect(matches).toHaveLength(2);
  });
});
