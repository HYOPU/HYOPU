import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';
import { JSTT_ORIGIN, JSTT_URL, parseJsttGrid } from './_jstt_berth_core.mjs';
import { selectJsttDate } from './_jstt_berth_dates.mjs';
import { armJsttQuery, waitJsttQuery } from './_jstt_berth_query.mjs';

export function cacheableJsttAsset(url,type,method,headers={}) {
  const u=new URL(url);
  return u.origin===JSTT_ORIGIN&&method==='GET'&&['script','stylesheet'].includes(type)
    &&(/^\/(_content|_framework)\//.test(u.pathname)||/^\/JSTT\.[^/]+\.styles\.css$/.test(u.pathname))
    &&!headers['set-cookie']&&!/private|no-store/i.test(headers['cache-control']??'');
}

/** Independent read-only grid collector. Never touches the LINE UP XLSX cache. */
export async function collectJsttBerths(credentials, window, meter) {
  let browser,context,deadline,page;const pendingSizes=new Set();let stage='BROWSER_START';
  // Per-execution public JS/CSS only. Never cache HTML, API data or credentials.
  // Playwright routing disables the browser HTTP cache; keep static reloads local.
  const assets=new Map(),localResponses=new WeakSet();let assetBytes=0;
  const started=Date.now(),endAt=meter.deadlineAt??started+44000;
  try {
    chromium.setGraphicsMode=false;
    browser=await playwright.launch({args:[...chromium.args,'--lang=ko-KR'],executablePath:await chromium.executablePath(),headless:true,timeout:12000});
    deadline=setTimeout(()=>{void browser?.close().catch(()=>{});},Math.max(1,endAt-Date.now()));
    context=await browser.newContext({locale:'ko-KR',timezoneId:'Asia/Seoul',viewport:{width:1440,height:900},acceptDownloads:false});
    // Network sizes only; no response body, HTML, credential or cookie logging.
    context.on('requestfinished',request=>{
      if(localResponses.has(request))return;
      const pending=request.sizes().then(size=>{meter.ingress+=size.responseBodySize+size.responseHeadersSize;}).catch(()=>{}).finally(()=>pendingSizes.delete(pending));
      pendingSizes.add(pending);
    });
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==JSTT_ORIGIN||url.protocol!=='https:'||['image','font','media'].includes(request.resourceType()))return route.abort();
      if(Date.now()>endAt)return route.abort();
      const staticAsset=cacheableJsttAsset(request.url(),request.resourceType(),request.method());
      const cached=staticAsset?assets.get(request.url()):null;
      if(cached){localResponses.add(request);meter.cacheHits=(meter.cacheHits??0)+1;return route.fulfill(cached);}
      // Count sizes only; cookies/headers/payloads are never retained or logged.
      try{meter.add(Buffer.byteLength(request.postData()??'')+Buffer.byteLength(JSON.stringify(request.headers()))+512);}
      catch{return route.abort();}
      if(staticAsset){
        const response=await route.fetch({maxRedirects:0,timeout:12000}),headers=response.headers();
        if(response.status()===200&&/(javascript|text\/css)/i.test(headers['content-type']??'')
          &&cacheableJsttAsset(request.url(),request.resourceType(),request.method(),headers)){
          const body=await response.body();
          delete headers['content-encoding'];delete headers['content-length'];
          const value={status:200,headers,body};
          if(assetBytes+body.length<=16*1024*1024){assets.set(request.url(),value);assetBytes+=body.length;}
          return route.fulfill(value);
        }
        return route.fulfill({response});
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*',async socket=>{
      const u=new URL(socket.url());
      if(u.origin!==JSTT_ORIGIN.replace('https:','wss:')||u.pathname!=='/_blazor')return socket.close();
      // Let Playwright forward the Blazor binary stream unchanged. Account for
      // frames through its observer API rather than manually re-emitting them.
      socket.connectToServer();
    });
    page=await context.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(12000);
    page.on('websocket',socket=>{
      socket.on('framesent',({payload})=>{try{meter.add(Buffer.byteLength(payload)+128);}catch{void browser.close().catch(()=>{});}});
      socket.on('framereceived',({payload})=>{meter.blazorMessages=(meter.blazorMessages??0)+1;meter.ingress+=Buffer.byteLength(payload);});
    });
    page.on('pageerror',error=>{
      if(meter.probe&&stage.startsWith('LOGIN'))meter.loginNotice=String(error.message).replaceAll(credentials.password,'[redacted]').replaceAll(credentials.userId,'[account]').slice(0,300);
    });
    page.on('dialog',async dialog=>{
      if(meter.probe&&stage==='LOGIN_SUBMIT')meter.loginNotice=dialog.message().replaceAll(credentials.password,'[redacted]').replaceAll(credentials.userId,'[account]').slice(0,300);
      await dialog.dismiss();
    });
    const assertOrigin=()=>{if(new URL(page.url()).origin!==JSTT_ORIGIN)throw Error('JSTT_ORIGIN_INVALID');};
    stage='LOGIN_PAGE';await page.goto(JSTT_ORIGIN+'/accounts/login',{waitUntil:'domcontentloaded'});assertOrigin();
    // SSR inputs can appear before the Blazor circuit attaches event handlers.
    // Wait for server traffic, then verify DOM values before submitting login.
    const circuitUntil=Math.min(endAt,Date.now()+10000);
    while(!(meter.blazorMessages>0)&&Date.now()<circuitUntil)await new Promise(r=>setTimeout(r,50));
    if(!(meter.blazorMessages>0))throw Error('JSTT_LOGIN_CIRCUIT_NOT_READY');
    const enterLogin=async()=>{
      for(const [selector,value] of [['#USER_ID',credentials.userId],['#PASSWORD',credentials.password]]){
        const input=page.locator(selector);
        // Use actual keyboard events as in the existing verified JSTT client.
        // The live form clears its DOM value on blur/server render; that alone
        // is not proof that its server-side login model discarded the value.
        await input.click();await input.press('Control+A');await input.press('Backspace');
        await input.pressSequentially(value,{delay:24});
        await input.press('Tab');
      }
      await page.getByRole('button',{name:'Login',exact:true}).click();
    };
    stage='LOGIN_SUBMIT';await enterLogin();
    const loginResult=()=>Promise.race([
      page.waitForURL(u=>u.origin===JSTT_ORIGIN&&!u.pathname.toLowerCase().startsWith('/accounts/login')).then(()=>true),
      page.getByText('아이디를 입력하세요',{exact:true}).waitFor({state:'visible'}).then(()=>false),
    ]);
    // The actual observed mandatory-ID validation is a client initialization
    // race, not rejection of credentials. Re-enter once; no challenge bypass.
    if(!await loginResult())await enterLogin();
    await page.waitForURL(u=>u.origin===JSTT_ORIGIN&&!u.pathname.toLowerCase().startsWith('/accounts/login'));
    // The observed sidebar click does not navigate reliably. Use the exact
    // verified page URL; public static assets above are reused within this run.
    stage='SCHEDULE_PAGE';await page.goto(JSTT_URL,{waitUntil:'domcontentloaded'});assertOrigin();
    // The initial server-rendered inputs are visible before Blazor is interactive.
    // Wait for the authenticated header and initialized grid filter row first.
    stage='SCHEDULE_READY';await page.waitForFunction(()=>document.body.textContent.includes('대리점그룹')
      &&document.querySelectorAll('input.e-control.e-datepicker.e-keyboard').length===2
      &&!!document.querySelector('[role="grid"] input[aria-label="VESSEL_NM_Filter"]'));
    // The default grid load must finish before our one explicit range query.
    // On this Syncfusion grid each data rebind replaces data-uid="grid-row…".
    await page.waitForFunction(()=>!!document.querySelector('[role="grid"] tr.e-row[data-uid]')
      &&![...document.querySelectorAll('[role="grid"] .e-spinner-pane')].some(e=>!e.classList.contains('e-spin-hide')));
    const dates=page.locator('input[aria-label="datepicker"]');await dates.first().waitFor({state:'visible'});
    if(await dates.count()!==2)throw Error('JSTT_DATE_CONTROLS_INVALID');
    stage='DATE_SELECTION';const selectedWindow={
      start:await selectJsttDate(page,0,window.start),
      end:await selectJsttDate(page,1,window.end),
    };
    // A generic style mutation is NOT query completion. The real site rebinds
    // row generations even when values are unchanged; wait for that evidence.
    await armJsttQuery(page);
    stage='QUERY';await page.getByRole('button',{name:'조회',exact:true}).click();
    await waitJsttQuery(page);
    assertOrigin();if(new URL(page.url()).pathname!=='/TW/VesselSchedule/List')throw Error('JSTT_AUTH_EXPIRED');
    stage='GRID_READ';const grid=await page.evaluate(()=>{
      const g=document.querySelector('input[aria-label="VESSEL_NM_Filter"]')?.closest('[role="grid"]');
      if(!g)throw Error('JSTT_GRID_INVALID');const rows=[...g.querySelectorAll('tr.e-row')];
      return {authenticated:document.body.textContent.includes('대리점그룹')&&!document.querySelector('#PASSWORD'),complete:true,
        start:document.querySelectorAll('input[aria-label="datepicker"]')[0].value,end:document.querySelectorAll('input[aria-label="datepicker"]')[1].value,
        basis:document.querySelector('input[aria-label="dropdownlist"]')?.value,
        headers:[...g.querySelectorAll('th[aria-colindex]')].map(e=>e.textContent.replace('Press Enter to sort','').trim()),
        virtual:!!g.querySelector('.e-virtualtrack,.e-virtualtable'),paged:!!g.querySelector('.e-pager'),rowCount:rows.length,
        rows:rows.map(r=>[...r.querySelectorAll('td')].map(c=>c.textContent.trim()))};
    });
    await Promise.all(pendingSizes);
    if(Date.now()>endAt)throw Error('JSTT_TIMEOUT');
    if(meter.probe)meter.gridDiagnostic={row_count:grid.rowCount,berths:[...new Set(grid.rows.map(r=>r[6]))].slice(0,20),agencies:[...new Set(grid.rows.map(r=>r[7]))].slice(0,40)};
    return parseJsttGrid({...grid,selectedWindow},window);
  }catch(error){
    // Bounded read-only contract diagnostics only for an operator's probe.
    // Do not return form values, cookies, hidden fields or raw browser errors.
    if(meter.probe&&page&&stage==='LOGIN_SUBMIT'){
      try{
        const currentId=await page.locator('#USER_ID').inputValue({timeout:1000});
        meter.loginInputDiagnostic={id_empty:!currentId,id_length:currentId.length,id_casefold_match:currentId.toUpperCase()===credentials.userId.toUpperCase()};
        const text=await page.locator('body').innerText({timeout:1000});
        meter.loginDiagnostic=text.replaceAll(credentials.password,'[redacted]').replaceAll(credentials.userId,'[account]').replace(/\s+/g,' ').trim().slice(0,600);
      }catch{}
    }
    // Browser errors may contain URLs or form values. Return only a fixed stage.
    if(error instanceof Error&&/^JSTT_[A-Z_]+$/.test(error.message))throw error;
    throw Error('JSTT_'+stage+'_FAILED');
  }finally{clearTimeout(deadline);await context?.close().catch(()=>{});await browser?.close().catch(()=>{});}
}
