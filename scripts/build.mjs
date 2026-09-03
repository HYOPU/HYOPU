import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/templates', {recursive:true});
await build({entryPoints:['app.js'],bundle:true,format:'esm',outfile:'dist/app.js',minify:true});
await build({entryPoints:['dashboard.js'],bundle:true,format:'esm',outfile:'dist/dashboard.js',minify:true});
for(const file of ['index.html','sof.html','styles.css','sof-refresh.css','dashboard.css','dashboard-refresh.css','dashboard-fixes.css','template.css','templates/agent-sof.xlsx'])await copyFile(file,`dist/${file}`);
for(const file of ['og.png','hyop-woon-shipping-logo.png'])await copyFile(`public/${file}`,`dist/${file}`);
