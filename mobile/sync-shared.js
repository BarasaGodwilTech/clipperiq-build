// Copies the shared modules, limits and fonts from the computer version into the phone app.
const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '..'); const out = path.join(__dirname, 'www', 'shared');
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
for (const f of ['lowerThird.js', 'adjust.js', 'framing.js']) fs.copyFileSync(path.join(root, 'js', 'shared', f), path.join(out, f));
fs.copyFileSync(path.join(root, 'config', 'clip-adjustments.json'), path.join(out, 'clip-adjustments.json'));
for (const f of ['ArchivoBlack-Regular.ttf', 'Inter-ExtraBold.woff', 'Oswald-Bold.woff']) fs.copyFileSync(path.join(root, 'server', 'assets', 'fonts', f), path.join(out, 'fonts', f));
console.log('shared files copied to', out);
