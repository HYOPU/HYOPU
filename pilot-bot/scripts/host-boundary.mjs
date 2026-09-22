export const botProject = 'prj_MiqijgcBtjGxlaFOXDItoLQukEkU';
export const miniAppAssets = Object.freeze(['app.js', 'boot.js', 'index.html', 'jstt.js', 'phone.js', 'style.css', 'time.js']);
export function assertBotHost(env) {
  if (env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID !== botProject) {
    throw Error('WRONG_VERCEL_PROJECT: deploy this module only to hyopu-pilot-bot');
  }
  if (env.VERCEL_GIT_REPO_SLUG && env.VERCEL_GIT_REPO_SLUG.toLowerCase() !== 'hyopu') {
    throw Error('WRONG_GIT_REPOSITORY');
  }
}
