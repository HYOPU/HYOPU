import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertBotHost, botProject, miniAppAssets } from '../scripts/host-boundary.mjs';
describe('dedicated HYOPU bot hosting', () => {
  it('permits local builds and its own project', () => {
    expect(() => assertBotHost({})).not.toThrow();
    expect(() => assertBotHost({ VERCEL_PROJECT_ID: botProject })).not.toThrow();
  });
  it('rejects the operations and Dongjin projects', () => {
    for (const id of ['prj_xUTiRACfyBURBplLBcX3hlrGPx3g', 'prj_ENQoq81WtBAoiDNYiKd1GOibnROb']) {
      expect(() => assertBotHost({ VERCEL_PROJECT_ID: id })).toThrow('WRONG_VERCEL_PROJECT');
    }
  });
  it('rejects operations repository identity', () => {
    expect(() => assertBotHost({ VERCEL_GIT_REPO_SLUG: 'hyopu-operations-workspace' })).toThrow();
  });
  it('publishes only the seven miniapp files', () => {
    expect(miniAppAssets).toHaveLength(7);
    expect(miniAppAssets).not.toContain('dashboard.js');
    const build = readFileSync('scripts/build-host.mjs', 'utf8');
    expect(build).not.toContain('../index.html');
    expect(build).not.toContain('process.env.HPBOT_');
  });
  it('exposes only the bot collector in deployment configuration', () => {
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(Object.keys(cfg.functions)).toEqual(['api/hpbot-jstt.js']);
    expect(cfg.crons).toBeUndefined();
  });
});
