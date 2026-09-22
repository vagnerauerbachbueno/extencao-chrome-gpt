import fs from 'node:fs';
import path from 'node:path';

export class SkillLoader {
  constructor(basePath = '.ia/skills') {
    this.basePath = basePath;
  }

  loadAll() {
    if (!fs.existsSync(this.basePath)) return [];

    return fs.readdirSync(this.basePath)
      .filter(file => file.endsWith('.md'))
      .map(file => ({
        name: path.basename(file, '.md'),
        content: fs.readFileSync(path.join(this.basePath, file), 'utf8')
      }));
  }
}
