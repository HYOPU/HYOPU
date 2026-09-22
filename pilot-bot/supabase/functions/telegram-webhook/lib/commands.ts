export interface Command { name:string; page?:number; search?:string; token?:string; setting?:string; explicit?:boolean; contextId?:number }
const aliases:Record<string,string>={협운일정:'queue',도선순번:'queue',오늘일정:'today',내일일정:'tomorrow','3일일정':'three',현재상태:'status',도선상태:'status',악천후:'weather',최근변경:'changes',중단기록:'events',선박검색:'search',새로고침:'refresh',감시상태:'health',알림설정:'settings',도움말:'help',감시중지:'stop',감시재개:'resume',테스트알림:'test',디버그:'debug',start:'help',help:'help',queue:'queue',today:'today',tomorrow:'tomorrow',three:'three',status:'status',weather:'weather',changes:'changes',events:'events',search:'search',refresh:'refresh',health:'health',settings:'settings',stop:'stop',resume:'resume',test:'test',debug:'debug'};
export const adminCommands=new Set(['refresh','stop','resume','test','debug','confirm','setting']);
aliases['도선등록현황']='queue';
aliases['현재도선상태']='status';
aliases['도선중단선박조회']='weather';
Object.assign(aliases,{'jstt부두':'jstt_menu','jstt감시':'jstt_menu','jstt현재':'jstt_current','jstt새로고침':'jstt_refresh','jstt감시목록':'jstt_watchlist','jstt최근변경':'jstt_changes'});
adminCommands.add('jstt_refresh');
export function parseCommand(text:string,botUsername=''):Command|null {
 if(text.length>240)return null;
 let value=text.normalize('NFKC').trim().replace(/^[^\p{L}\p{N}/]+/u,'').replace(/^\//,'');
 const mention=value.match(/^([^\s@]+)@([a-z\d_]+)(.*)$/i);
 if(mention){if(mention[2].toLowerCase()!==botUsername.toLowerCase())return null;value=mention[1]+mention[3];}
 const search=value.match(/^(?:선박\s*검색|search)\s+(.+)$/i);if(search)return {name:'search',search:search[1].trim().slice(0,120),explicit:true};
 const key=value.replace(/\s+/gu,'').toLowerCase();if(aliases[key])return {name:aliases[key],explicit:true};
 // Bare vessel names, not normal Korean conversation. The DB additionally
 // requires an actual known unfinished vessel before accepting this update.
 if(/^(?:M\/V\s+)?[A-Z0-9][A-Z0-9 .'-]{2,100}$/.test(value))return {name:'search',search:value,explicit:false};
 return null;
}
export function parseCallback(data:string):Command|null {
 if(data.length>64)return null;
 const parts=data.split(':');if(parts[0]!=='v1')return null;
 if(parts[1]==='jstt'&&['current','watchlist','changes'].includes(parts[2])&&/^\d{1,3}$/.test(parts[3]??''))return {name:'jstt_'+parts[2],page:Number(parts[3])};
 if(parts[1]==='s'&&/^\d{1,15}$/.test(parts[2]??'')&&/^\d{1,3}$/.test(parts[3]??''))return {name:'search',contextId:Number(parts[2]),page:Number(parts[3]),explicit:true};
 if(parts[1]==='q'&&['queue','today','tomorrow','three','weather'].includes(parts[2])&&/^\d{1,3}$/.test(parts[3]??''))return {name:parts[2],page:Number(parts[3])};
 if(parts[1]==='confirm'&&/^[a-f\d-]{36}$/.test(parts[2]??''))return {name:'confirm',token:parts[2]};
 if(parts[1]==='setting'&&/^[A-Z_]{3,24}$/.test(parts[2]??''))return {name:'setting',setting:parts[2]};
 if(parts[1]==='menu'&&Object.values(aliases).includes(parts[2]))return {name:parts[2]};
 return null;
}
