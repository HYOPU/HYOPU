/** Contract observed on JSTT's server-rendered Syncfusion calendar. */
export function jsttCalendarTitle(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw Error('JSTT_DATE_INVALID');
  const date=new Date(iso+'T00:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==iso)throw Error('JSTT_DATE_INVALID');
  return `${date.getUTCFullYear()}년 ${date.getUTCMonth()+1}월 ${date.getUTCDate()}일 ${['일','월','화','수','목','금','토'][date.getUTCDay()]}요일`;
}

// Typing changes input.value before the Blazor value-change callback completes.
// Select a real calendar day, then reopen it to confirm the committed selection.
// Never query with a merely typed date or silently fall back to the default range.
export async function selectJsttDate(page,index,iso) {
  const title=jsttCalendarTitle(iso);
  const input=page.locator('input[aria-label="datepicker"]').nth(index);
  const icon=input.locator('..').locator('.e-date-icon');
  const dialog=page.getByRole('dialog',{name:'datepicker',exact:true});
  const calendar=page.getByRole('grid',{name:'calendar',exact:true});
  await icon.click();await calendar.waitFor({state:'visible'});
  const day=calendar.locator(`span[title="${title}"]`);
  for(let moves=0;await day.count()===0;moves++){
    if(moves>=2)throw Error('JSTT_CALENDAR_RANGE_INVALID');
    const heading=await dialog.getByRole('button',{name:/^title /}).innerText();
    const month=/^(\d{1,2})월 (\d{4})$/.exec(heading.trim());
    if(!month)throw Error('JSTT_CALENDAR_INVALID');
    const shown=Number(month[2])*12+Number(month[1]),target=Number(iso.slice(0,4))*12+Number(iso.slice(5,7));
    if(target===shown)throw Error('JSTT_CALENDAR_DAY_MISSING');
    await dialog.getByRole('button',{name:target>shown?'next month':'previous month',exact:true}).click();
    await page.waitForFunction(previous=>{
      const h=document.querySelector('[role="dialog"] [role="button"][aria-label^="title "]');
      return h&&h.textContent.trim()!==previous;
    },heading.trim());
  }
  await day.click();await dialog.waitFor({state:'hidden'});
  await icon.click();await calendar.waitFor({state:'visible'});
  const selected=await calendar.locator('td[aria-selected="true"] span').getAttribute('title');
  if(selected!==title)throw Error('JSTT_DATE_NOT_COMMITTED');
  // Selecting the already selected day closes the calendar through its own API.
  await calendar.locator(`span[title="${title}"]`).click();await dialog.waitFor({state:'hidden'});
  if(await input.inputValue()!==iso||await input.getAttribute('aria-invalid')==='true')throw Error('JSTT_DATE_NOT_COMMITTED');
  return iso;
}
