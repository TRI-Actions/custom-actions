'use strict';

// Structural checks on every actions/pr-pipeline/*/action.yaml, read as plain text
// (no YAML library, so the suite runs on a bare node install).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FAMILY_DIR = path.join(__dirname, '..');
const LIB_DIR = path.join(FAMILY_DIR, 'lib');
const REQUIRE_PATTERN =
  /require\(path\.join\(process\.env\.ACTION_PATH, '\.\.', 'lib', '([^']+)'\)\)/g;
const FORBIDDEN = ['${{ inputs.', '${{ github.event'];

function leadingSpaces(line) {
  return line.length - line.trimStart().length;
}

// Returns the text of every `script:` and `run:` value: the rest of the key line plus
// every following line that is blank or indented deeper than the key (block scalars
// and multi-line flow scalars alike).
function scriptBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*(?:-\s+)?)(script|run):(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyIndent = match[1].length;
    const body = [match[3]];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || leadingSpaces(lines[j]) > keyIndent)) {
      body.push(lines[j]);
      j += 1;
    }
    blocks.push({ key: match[2], line: i + 1, text: body.join('\n') });
    i = j - 1;
  }
  return blocks;
}

const actions = fs
  .readdirSync(FAMILY_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(FAMILY_DIR, entry.name, 'action.yaml')))
  .map((entry) => entry.name)
  .sort();

test('scriptBlocks finds block and inline script/run values', () => {
  const sample = [
    'runs:',
    '  steps:',
    '    - run: echo ${{ inputs.inline }}',
    '    - uses: actions/github-script@v7',
    '      with:',
    '        script: |',
    '          const a = 1;',
    '',
    '          const b = "${{ github.event.comment.body }}";',
    '      env:',
    '        SAFE: ${{ inputs.safe }}',
    '    - name: block run',
    '      run: >-',
    '        echo hi',
  ].join('\n');
  const blocks = scriptBlocks(sample);
  assert.deepEqual(
    blocks.map((b) => [b.key, b.line]),
    [
      ['run', 3],
      ['script', 6],
      ['run', 13],
    ],
  );
  assert.ok(blocks[0].text.includes('${{ inputs.inline }}'));
  assert.ok(blocks[1].text.includes('${{ github.event.comment.body }}'));
  assert.ok(!blocks[1].text.includes('SAFE'));
  assert.ok(blocks[2].text.includes('echo hi'));
});

test('the family has sub-actions', () => {
  assert.ok(actions.length > 0, `no action.yaml found under ${FAMILY_DIR}`);
});

for (const name of actions) {
  const file = path.join(FAMILY_DIR, name, 'action.yaml');
  const text = fs.readFileSync(file, 'utf8');

  test(`${name}: is named pr-pipeline/${name}`, () => {
    assert.match(text, new RegExp(`^name: 'pr-pipeline/${name}'$`, 'm'));
  });

  test(`${name}: uses actions/github-script@v7`, () => {
    assert.match(text, /^\s*(?:-\s+)?uses:\s*actions\/github-script@v7\s*$/m);
    const versions = text.match(/actions\/github-script@\S+/g);
    assert.deepEqual([...new Set(versions)], ['actions/github-script@v7']);
  });

  test(`${name}: sets ACTION_PATH from github.action_path`, () => {
    assert.match(text, /^\s+ACTION_PATH: \$\{\{ github\.action_path \}\}\s*$/m);
  });

  test(`${name}: requires an existing lib module`, () => {
    const modules = [...text.matchAll(REQUIRE_PATTERN)].map((m) => m[1]);
    assert.ok(modules.length > 0, 'no require(path.join(process.env.ACTION_PATH, ..., lib, ...)) line');
    for (const mod of modules) {
      assert.ok(fs.existsSync(path.join(LIB_DIR, mod)), `lib/${mod} does not exist`);
    }
  });

  test(`${name}: no script or run block interpolates inputs or event data`, () => {
    const blocks = scriptBlocks(text);
    assert.ok(blocks.some((b) => b.key === 'script'), 'no script: block found');
    for (const block of blocks) {
      for (const needle of FORBIDDEN) {
        assert.ok(
          !block.text.includes(needle),
          `${block.key}: block at line ${block.line} contains "${needle}"; pass the value through env: instead`,
        );
      }
    }
  });
}
