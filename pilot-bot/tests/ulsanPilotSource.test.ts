import { describe, expect, it } from "vitest";
import { normalizeStatus, parseForecast, fetchForecast } from "../supabase/functions/ulsan-pilot-watcher/lib/source";

// Public response observed 2026-09-20: STATUS is cell 2, L/A cell 13.
const cells = ["1", "<span class='redTxt'>Bad weather</span>", "", "00:00", "GINGA TIGER", "", "S6SZ7", "16,232", "160", "6.0", "P/S", "SOILG-3", "협운", "B", "S", "Y", "2", "글로", "승검", "기상 도선가능시 연락부탁드립니다."];
const row = (c = cells) => `<tr>${c.map((v,i) => `<td>${v}</td>${i === 2 ? '<!--td>NOT A COLUMN</td-->' : ''}`).join('')}</tr>`;
describe("observed Ulsan HTML contract", () => {
  it("normalizes status and ignores commented cells; identity ignores time/order", async () => {
    for (const value of ["BAD WEATHER", "Bad Weather", "bad  weather", "BAD\u00a0WEATHER"]) expect(normalizeStatus(value)).toBe("BAD_WEATHER");
    const [first] = await parseForecast(row(), "2026-09-20", false);
    const changed = [...cells]; changed[0] = "52"; changed[3] = "13:00";
    const [second] = await parseForecast(row(changed), "2026-09-20", false);
    expect(first.agent).toBe("협운"); expect(first.identity).toBe(second.identity);
    expect(first.from_location).toBe("P/S"); expect(first.status).toBe("BAD_WEATHER");
  });
  it("cancel-filter PROCESSING must never be a processing candidate", async () => {
    const c = [...cells]; c[1] = "PROCESSING";
    const [result] = await parseForecast(row(c), "2026-09-20", true);
    expect(result.status).toBe("CANCELLED"); expect(result.raw_status).toBe("PROCESSING");
  });
  it("rejects malformed, blocked and unverified empty responses", async () => {
    for (const html of ["", "error", "<html>blocked</html>", row(cells.slice(1))]) await expect(parseForecast(html,"2026-09-20",false)).rejects.toThrow();
  });
  it("fetches precisely four feeds without follow-up assets and hashes canonical order", async () => {
    const requests: RequestInit[] = [];
    const fake = (async (_url: unknown, init: RequestInit) => { requests.push(init); return new Response(row(), {headers:{"date":new Date().toUTCString(),"content-type":"text/html; charset=utf-8"}}); }) as typeof fetch;
    const result = await fetchForecast(fake);
    expect(requests).toHaveLength(4); expect(result.rows).toHaveLength(4);
    expect(requests.filter(r => String(r.body).endsWith("s_fg_status6=090"))).toHaveLength(2);
  });
  const feed = (bodies: string[], change?: (response: Response, index: number) => Response) => {
    let index = 0;
    return (async () => {
      const i = index++;
      const response = new Response(bodies[i], { headers: { date: new Date().toUTCString(), "content-type": "text/html; charset=utf-8" } });
      return change ? change(response, i) : response;
    }) as typeof fetch;
  };
  it.each([2, 3, -1])("accepts the verified CRLF cancellation sentinel with healthy paired base feeds (%s)", async index => {
    const bodies = [row(), row(), row(), row()];
    if (index < 0) bodies[2] = bodies[3] = "\r\n"; else bodies[index] = "\r\n";
    const result = await fetchForecast(feed(bodies));
    expect(result.rows).toHaveLength(index < 0 ? 2 : 3);
    expect(result.rows.filter(r => !r.cancelled)).toHaveLength(2);
    expect(result.ingress).toBe(bodies.reduce((n, html) => n + new TextEncoder().encode(html).length, 0));
    expect((await fetchForecast(feed(bodies))).hash).toBe(result.hash);
  });
  it.each(["", " ", "\n", "<div></div>", "<html>access denied</html>"])("rejects unverified empty/error cancellation responses (%j)", async html => {
    await expect(fetchForecast(feed([row(), row(), row(), html]))).rejects.toThrow();
  });
  it.each([0, 1])("does not accept an empty base feed even with empty cancellation sentinel (%s)", async index => {
    const bodies = [row(), row(), "\r\n", "\r\n"]; bodies[index] = "\r\n";
    await expect(fetchForecast(feed(bodies))).rejects.toThrow("EMPTY_SOURCE_UNVERIFIED");
  });
  it.each(["status", "date", "content-type", "stream"])("still requires a complete, healthy empty-cancellation response (%s)", async fault => {
    const fake = feed([row(), row(), row(), "\r\n"], (response, i) => {
      if (i !== 3) return response;
      if (fault === "status") return new Response("\r\n", { status: 500, headers: response.headers });
      if (fault === "stream") return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("\r\n"));c.error(new Error("TRUNCATED"));}}), {headers: response.headers});
      response.headers.set(fault, fault === "date" ? "Sun, 20 Sep 2020 00:00:00 GMT" : "text/plain");
      return response;
    });
    await expect(fetchForecast(fake)).rejects.toThrow();
  });
});
