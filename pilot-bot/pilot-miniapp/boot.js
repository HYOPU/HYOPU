import { mountMiniApp } from './app.js';
import { mountJstt } from './jstt.js';
const telegram=window.Telegram?.WebApp;
// Only public project URL. No bot token, source credential or Supabase key here.
const endpoint='https://nhujqbqygnhbnvmfmodi.supabase.co/functions/v1/pilot-miniapp';
const api=async(body)=>{
  if(!telegram?.initData)throw Error('Telegram의 도선신청서 열기 버튼으로 접속해 주세요. 일반 브라우저에서는 신청할 수 없습니다.');
  const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',redirect:'error',
    body:JSON.stringify({...body,initData:telegram.initData}),signal:AbortSignal.timeout(60000)});
  const result=await r.json();
  if(!r.ok||result.error)throw Error((result.message??'처리하지 못했습니다.')+(result.error?' ['+result.error+']':''));
  return result;
};
telegram?.ready();telegram?.enableClosingConfirmation?.();
// A start reference is navigation only; the API independently authenticates every call.
const start=new URLSearchParams(telegram?.initData??'').get('start_param')??'';
const root=document.getElementById('app');
if(start==='jstt'||/^jstt_\d+$/.test(start))mountJstt(root,api,{reference:start.startsWith('jstt_')?start.slice(5):undefined,onBack:()=>mountMiniApp(root,api)});
else mountMiniApp(root,api,/^copy_[a-f0-9-]{36}$/.test(start)?{sourceId:start.slice(5)}:{copyList:start==='copy'});
