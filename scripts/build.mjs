import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/templates', {recursive:true});
await build({entryPoints:['app.js'],bundle:true,format:'esm',outfile:'dist/app.js',minify:true});
for(const file of ['index.html','styles.css','template.css','templates/agent-sof.xlsx'])await copyFile(file,`dist/${file}`);
