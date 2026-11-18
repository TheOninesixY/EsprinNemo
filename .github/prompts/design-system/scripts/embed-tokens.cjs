#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'assets', 'design-tokens.css'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

const projectRoot = findProjectRoot(process.cwd());
if (!projectRoot) {
  console.error('Error: Could not find assets/design-tokens.css');
  process.exit(1);
}

const tokensPath = path.join(projectRoot, 'assets', 'design-tokens.css');
const MINIMAL_TOKENS = [
  '--primitive-spacing-',
  '--primitive-fontSize-',
  '--primitive-fontWeight-',
  '--primitive-lineHeight-',
  '--primitive-radius-',
  '--primitive-shadow-glow-',
  '--primitive-gradient-',
  '--primitive-duration-',
  '--color-primary',
  '--color-secondary',
  '--color-accent',
  '--color-background',
  '--color-surface',
  '--color-foreground',
  '--color-border',
  '--typography-font-',
  '--card-',
];

function extractTokens(css, minimal = false) {
  const rootMatch = css.match(/:root\s*\{([^}]+)\}/g);
  if (!rootMatch) return '';

  let allVars = [];
  for (const block of rootMatch) {
    const vars = block.match(/--[\w-]+:\s*[^;]+;/g) || [];
    allVars = allVars.concat(vars);
  }

  if (minimal) {
    allVars = allVars.filter(v =>
      MINIMAL_TOKENS.some(token => v.includes(token))
    );
  }
  allVars = [...new Set(allVars)];

  return `:root {\n  ${allVars.join('\n  ')}\n}`;
}
const args = process.argv.slice(2);
const minimal = args.includes('--minimal');
const wrapStyle = args.includes('--style');

try {
  const css = fs.readFileSync(tokensPath, 'utf-8');
  let output = extractTokens(css, minimal);

  if (wrapStyle) {
    output = `<style>\n/* Design Tokens (embedded for standalone HTML) */\n${output}\n</style>`;
  } else {
    output = `/* Design Tokens (embedded for standalone HTML) */\n${output}`;
  }

  console.log(output);
} catch (err) {
  console.error(`Error reading tokens: ${err.message}`);
  process.exit(1);
}
