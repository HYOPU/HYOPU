// Only bot-scoped credentials are accepted on the dedicated hosting project.
import { createJsttBerthHandler } from './jstt_berth_watch.mjs';
export default async function handler(req, res) {
  const env = {
    SUPABASE_URL: 'https://nhujqbqygnhbnvmfmodi.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: process.env.HPBOT_SUPABASE_SERVICE_KEY,
    JSTT_SCHEDULE_USER_ID: process.env.HPBOT_JSTT_USER_ID,
    JSTT_SCHEDULE_PASSWORD: process.env.HPBOT_JSTT_PASSWORD,
    JSTT_BERTH_KEY: process.env.HPBOT_JSTT_KEY,
    JSTT_BERTH_MONITOR_ENABLED: process.env.HPBOT_JSTT_ENABLED,
  };
  return createJsttBerthHandler({ env })(req, res);
}
