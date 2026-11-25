const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
test('el artefacto de Pages incluye el álbum sin dependencias ni archivos privados y conserva el resto', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-pages.yml'), 'utf8');
  assert.match(workflow, /- 'album\/\*\*'/);
  const blocks = [...workflow.matchAll(/        run: \|\n((?:          .*\n)+)/g)].map(m => m[1].split('\n').map(line => line.slice(10)).join('\n'));
  assert.equal(blocks.length, 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-pages-'));
  try {
    fs.copyFileSync(path.join(root, 'index.html'), path.join(tmp, 'index.html'));
    for (const dir of ['admin', 'assets', 'css', 'js']) fs.cpSync(path.join(root, dir), path.join(tmp, dir), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'album'));
    for (const name of ['index.html', 'admin.html', 'album.css', 'album.bundle.js', 'admin.bundle.js']) fs.copyFileSync(path.join(root, 'album', name), path.join(tmp, 'album', name));
    fs.mkdirSync(path.join(tmp, 'album', 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'album', 'node_modules', 'private-marker'), 'no publicar');
    for (const block of blocks) execFileSync('bash', ['-e', '-c', block], { cwd: tmp });
    const published = path.join(tmp, 'public');
    assert.deepEqual(fs.readdirSync(path.join(published, 'album')).sort(), ['admin.bundle.js','admin.html','album.bundle.js','album.css','index.html']);
    for (const name of ['index.html','admin/index.html','admin/admin.js','css/styles.css','js/rsvp-config.js']) assert.deepEqual(fs.readFileSync(path.join(published,name)),fs.readFileSync(path.join(root,name)));
    assert.equal(fs.existsSync(path.join(published, 'album', 'node_modules')), false);
    const html = fs.readFileSync(path.join(published, 'album', 'index.html'), 'utf8');
    assert.match(html, /src="\.\.\/js\/rsvp-config\.js"/); assert.match(html, /src="album\.bundle\.js"/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
