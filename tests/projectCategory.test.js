import Project from '../models/Project.js';

describe('Project categories', () => {
  test('defaults legacy projects to web', () => {
    const project = new Project({ title_zh: '项目', title_en: 'Project' });
    expect(project.category).toBe('web');
    expect(project.validateSync()).toBeUndefined();
  });

  test.each(['web', 'fullstack', 'mobile', 'tools'])('accepts %s projects', (category) => {
    const project = new Project({ title_zh: '项目', title_en: 'Project', category });
    expect(project.validateSync()).toBeUndefined();
  });

  test('accepts multiple categories', () => {
    const project = new Project({
      title_zh: '项目',
      title_en: 'Project',
      categories: ['tools', 'web']
    });
    expect(project.categories).toEqual(['tools', 'web']);
    expect(project.validateSync()).toBeUndefined();
  });

  test('rejects unsupported categories', () => {
    const project = new Project({ title_zh: '项目', title_en: 'Project', category: 'desktop' });
    expect(project.validateSync()?.errors.category).toBeDefined();
  });
});
