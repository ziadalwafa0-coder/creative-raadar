import fs from 'node:fs';
import path from 'node:path';

function checkDirectory(dir: string, violations: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'eval') continue;
      checkDirectory(fullPath, violations);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js'))) {
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) {
        continue; // tests are permitted to import fixtures
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          /import\s+.*from\s+['"].*eval\//i.test(line) ||
          /import\s+.*from\s+['"].*fixtures/i.test(line) ||
          /require\(['"].*eval\//i.test(line) ||
          /require\(['"].*fixtures/i.test(line)
        ) {
          violations.push(`${fullPath}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
}

const violations: string[] = [];
checkDirectory(path.resolve(process.cwd(), 'src'), violations);
checkDirectory(path.resolve(process.cwd(), 'config'), violations);

// Also check server.ts
const serverPath = path.resolve(process.cwd(), 'server.ts');
if (fs.existsSync(serverPath)) {
  const content = fs.readFileSync(serverPath, 'utf-8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /import\s+.*from\s+['"].*eval\//i.test(line) ||
      /import\s+.*from\s+['"].*fixtures/i.test(line) ||
      /require\(['"].*eval\//i.test(line) ||
      /require\(['"].*fixtures/i.test(line)
    ) {
      violations.push(`${serverPath}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error('❌ Build Gate Failed: Production code (src/, server.ts, config/) must never import from eval/ or fixtures:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
} else {
  console.log('✅ Cleanliness Check Passed: Zero eval/ or fixture imports in production code (src/, server.ts, config/).');
  process.exit(0);
}
