import fs from 'node:fs';

export class WorkspaceContext {
  constructor(root = process.cwd()) {
    this.root = root;
  }

  load() {
    const file = `${this.root}/.ia/index.md`;

    if (!fs.existsSync(file)) {
      return '';
    }

    return fs.readFileSync(file, 'utf8');
  }
}
