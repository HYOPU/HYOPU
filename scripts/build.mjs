import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
// This legacy checkout is not the current hyopu-operations-workspace repository.
if (process.env.VERCEL_PROJECT_ID === 'prj_xUTiRACfyBURBplLBcX3hlrGPx3g') {
  throw Error('WRONG_DEPLOYMENT_BOUNDARY: do not overwrite the operations portal from this checkout');
}
await mkdir('dist/templates', {recursive:true});
await build({entryPoints:['app.js'],bundle:true,format:'esm',outfile:'dist/app.js',minify:true});
await build({entryPoints:['dashboard.js'],bundle:true,format:'esm',outfile:'dist/dashboard.js',minify:true});
for(const file of ['index.html','sof.html','styles.css','sof-refresh.css','dashboard.css','dashboard-refresh.css','dashboard-fixes.css','template.css','templates/agent-sof.xlsx'])await copyFile(file,`dist/${file}`);
for(const file of ['og.png','hyop-woon-shipping-logo.png'])await copyFile(`public/${file}`,`dist/${file}`);
// Independent Telegram mini app; no existing portal assets or API routes replaced.
await cp('pilot-bot/pilot-miniapp','dist/pilot-bot',{recursive:true});
