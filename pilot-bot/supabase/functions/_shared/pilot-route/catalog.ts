// Read-only snapshot of the authenticated official point-search UI, 2026-09-20.
// Source: https://www.ulsanpilot.co.kr/crew/sub01/sub01_01.php
// Empty point search: 452 rendered radio inputs / 226 distinct values, no pagination.
// No credentials, contacts, forecasts or application data are included.
export interface PilotPoint { portCode: string; pointCode: string; name: string; portName: string; description: string }
export interface PointCatalog { version: string; observedAt: string; points: readonly PilotPoint[] }
export const OFFICIAL_POINT_ROWS = `21|21002|P/S|울산항|PILOT STATION
21|21003|P/S(E-1)|울산항|ANCHORAGE
21|21004|P/S(E-2)|울산항|ANCHORAGE
21|21005|P/S(E-3)|울산항|ANCHORAGE
21|21010|E-1|울산항|ANCHORAGE
21|21011|E-2|울산항|ANCHORAGE
21|21012|E-3|울산항|ANCHORAGE
21|21020|M-1|울산항|내항묘지
21|21021|M-2|울산항|내항묘지
21|21022|M-3|울산항|내항묘지
21|21023|M-4|울산항|내항묘지
21|21024|M-5|울산항|내항묘지
21|21025|M-6|울산항|내항묘지
21|21026|M-7|울산항|내항묘지
21|21089|COAL|울산항|석탄부두
21|21090|HCP#1|울산항|현대자동차부두
21|21091|HCP#2|울산항|현대자동차부두
21|21092|HCP#3|울산항|현대자동차부두
21|21100|P#1|울산항|울산항
21|21101|P#21|울산항|울산항
21|21102|P#22|울산항|울산항
21|21103|P#23|울산항|울산항
21|21104|P#31|울산항|울산항
21|21105|P#32|울산항|울산항
21|21106|P#41|울산항|울산항
21|21107|P#42|울산항|울산항
21|21108|P#5|울산항|울산항
21|21109|P#61|울산항|울산항
21|21110|P#62|울산항|울산항
21|21111|P#63|울산항|울산항
21|21112|P#64|울산항|울산항
21|21113|P#65|울산항|울산항
21|21119|G#4|울산항|일반부두
21|21120|G#5|울산항|일반부두
21|21121|G#6|울산항|일반부두
21|21122|G#7|울산항|일반부두
21|21123|G#8|울산항|일반부두
21|21130|SK#1-1|울산항|SK TERMINAL
21|21131|SK#1-2|울산항|SK TERMINAL
21|21132|SK#2-1|울산항|SK TERMINAL
21|21133|SK#2-2|울산항|SK TERMINAL
21|21134|SK#2-3|울산항|SK TERMINAL
21|21135|SK#2-4|울산항|SK TERMINAL
21|21136|SK#2-5|울산항|SK TERMINAL
21|21137|SK#2-6|울산항|SK TERMINAL
21|21138|SK#2-7|울산항|SK TERMINAL
21|21139|SK#3|울산항|SK TERMINAL
21|21140|SK#4-1|울산항|SK TERMINAL
21|21141|SK#4-2|울산항|SK TERMINAL
21|21142|SK#4-3|울산항|SK TERMINAL
21|21143|SK#5-1|울산항|SK TERMINAL
21|21144|SK#5-2|울산항|SK TERMINAL
21|21145|SK#5-3|울산항|SK TERMINAL
21|21146|SK#5-4|울산항|SK TERMINAL
21|21147|SK#5-5|울산항|SK TERMINAL
21|21148|SK#6|울산항|SK TERMINAL
21|21149|SK#7|울산항|SK TERMINAL
21|21150|SK#8|울산항|SK TERMINAL
35|21152|SKB#2|SBM|SK 원유부이
35|21153|SKB#3|SBM|SK 원유부이
21|21154|SK-W/A|울산항|SK WORKING AREA
35|21155|SOIL-BY NO.1|SBM|S-OIL 원유부이 NO.1
21|21160|H.JDOCK|울산항|HANJIN DOCKYARD
21|21161|YJ#1|울산항|UTT
21|21164|SILO|울산항|양곡부두
34|21165|LPG#1|울산북항신항|SK TERMINAL
34|21166|LPG#2|울산북항신항|SK TERMINAL
21|21186|장생포호안|울산항|장생포호안
21|21188|PORT|울산항|PORT
21|21189|P#71|울산항|울산항
21|21190|P#72|울산항|울산항
21|21191|P#81|울산항|울산항
21|21192|P#82|울산항|울산항
21|21194|P#9|울산항|울산항 9부두
21|21196|P#63(T/S)|울산항|63번 T/S
21|21197|P#42(T/S)|울산항|42번 T/S
21|21200|P#2(T/S)|울산항|2부두 T/S
21|21201|P#32(T/S)|울산항|32번 T/S
21|21202|P#41(T/S)|울산항|41번 T/S
21|21203|P#5(T/S)|울산항|5부두 T/S
21|21204|P#1(T/S)|울산항|1부두 T/S
21|21207|SBMAREA|울산항|SBM AREA
21|21208|DREDGING|울산항|DREDGING
21|21209|WORKING|울산항|WORKING
21|21212|P#81(T/S)|울산항|P#81 T/S
21|21215|H.M.D(T/S)|울산항|H.M.D(T/S)
21|21222|P#6(T/S)|울산항|P#62(T/S)
21|21223|YMP#1|울산항|염포1부두(대형선)
21|21224|YMP#1-1|울산항|염포1부두북단(소형선)
21|21225|YMP#1-2|울산항|염포1부두남단(소형선)
21|21226|YMP#2|울산항|염포2부두(대형선)
21|21227|YMP#2-1|울산항|염포2부두북단(소형선)
21|21228|YMP#2-2|울산항|염포2부두남단(소형선)
21|21330|YMP#3|울산항|염포3부두(대형선)
21|21331|YMP#3-1|울산항|염포3부두북단(소형선)
21|21332|YMP#3-2|울산항|염포3부두남단(소형선)
34|21334|YY#1|울산북항신항|북신항 용연부두(N)
34|21335|YY#2|울산북항신항|북신항 용연부두(S)
21|21336|HMD#5(YEP)|울산항|예전부두
21|21337|UTT|울산항|UTT(구 YJ#2)
21|21338|YJ#2|울산항|UTT(구 YJ#3)
21|21339|H-1Q (구 H-15)|울산항|해양 1안벽
21|21340|H-2Q (구 H-16)|울산항|해양 2안벽
21|21341|H-3Q (구 H-17)|울산항|해양 3안벽
21|21342|H-4Q (구 H-18)|울산항|해양 4안벽
21|21343|H-5QN(구 HMD-5)|울산항|해양 5안벽
21|21344|H-5QM(구 HMD-5)|울산항|해양 5안벽
21|21345|H-5QS(구 HMD-5)|울산항|해양 5안벽
21|21346|HMD(구 HMD-1~4)|울산항|해양 1~4안벽
35|22062|KNOC B#2|SBM|KNOC 원유부이 NO.2
22|22200|OP#1|온산항|온산항
22|22201|OP#2|온산항|온산항
22|22202|OP#3|온산항|온산항
22|22203|OP#4|온산항|온산항
22|22204|OP#5|온산항|온산항
22|22205|OP#6|온산항|온산항
22|22210|JSTT1|온산항|온산JSTT
22|22211|JSTT2|온산항|온산JSTT
22|22212|JSTT3|온산항|온산JSTT
22|22213|JSTT4|온산항|온산JSTT
22|22220|KPIC1N|온산항|온산대한유화
22|22221|KPIC1S|온산항|온산대한유화
22|22222|KPIC2N|온산항|온산대한유화
22|22223|KPIC2S|온산항|온산대한유화
22|22230|SOILA1|온산항|S-OIL A-1
22|22231|SOILA2|온산항|S-OIL A-2
22|22232|SOILC1|온산항|S-OIL C-1
22|22233|SOILC2|온산항|S-OIL C-2
22|22234|SOILD1|온산항|S-OIL D-1
22|22235|SOILE1|온산항|S-OIL E-1
35|22236|SOIL-BY|SBM|S-OIL 원유부이
35|22237|KNOC|SBM|KNOC 원유부이
22|22238|SOILD2|온산항|S-OIL D-2
22|22239|OP/FS|온산항|온산역무선
22|22240|JSTT3(T/S)|온산항|온산JSTT T/S
22|22241|JSTT2(T/S)|온산항|온산JSTT T/S
22|22242|KPIC2S(T/S)|온산항|KPIC2S(T/S)
22|22243|OTK(N)|온산항|온산오드펠
22|22244|OTK(S)|온산항|온산오드펠
22|22245|OTK/N(T/S)|온산항|온산오드펠
22|22246|OTK/S(T/S)|온산항|온산오드펠
22|22249|IP#1|온산항|아이포트부두
22|22250|IP#2|온산항|아이포트부두
22|22251|IP#1(T/S)|온산항|아이포트부두 T/S
22|22252|IP#2(T/S)|온산항|아이포트부두 T/S
22|22253|OP#1(T/S)|온산항|온산1부두
22|22258|SOILF1|온산항|S.OIL F-1
22|22259|SOILF2|온산항|S.OIL F-2
22|22260|UNCT#1|온산항|울산신항컨테이너터미널
22|22261|UNCT#2|온산항|울산신항컨테이너터미널
22|22262|UNCT#3|온산항|울산신항컨테이너터미널
22|22263|UNCT#4|온산항|울산신항컨테이너터미널
22|22268|UNCT#4(T/S)|온산항|UNCT#4(T/S)
22|22269|UNCT#3(T/S)|온산항|UNCT#3(T/S)
22|22272|UNCT#1(T/S)|온산항|UNCT#1(T/S)
35|22273|SOIL-BY NO.2|SBM|S-OIL 원유부이 NO.2
22|22274|UTK#1|온산항|UNITED TERMINAL KORE
22|22275|UTK#2|온산항|UNITED TERMINAL KORE
22|22276|SOILG-1|온산항|동북화학 남단
22|22277|SOILG-2|온산항|동북화학 중단
22|22278|SOILG-3|온산항|동북화학 북단
23|23300|MIPO#1(01)|미포항|현대중공업
23|23303|MIPO#1(02)|미포항|현대중공업
23|23304|MIPO#1(03)|미포항|현대중공업
23|23321|전하만|미포항|전하만
33|33001|SP#1|울산남항신항|현대오일터미널 신항1부두
33|33002|SP#2|울산남항신항|현대오일터미널 신항2부두
33|33003|SP#3|울산남항신항|미창석유터미널부두
33|33004|SP#4|울산남항신항|정일스톨트헤븐부두
33|33005|SP#4-1|울산남항신항|북쪽 소형선
33|33006|SP#4-2|울산남항신항|남쪽 소형선
33|33007|SP#5|울산남항신항|정일스톨트헤븐부두
33|33008|SP#5-1|울산남항신항|북쪽 소형선
33|33009|SP#5-2|울산남항신항|남쪽 소형선
33|33010|SP#6|울산남항신항|엘에스니꼬부두
33|33011|SP#7|울산남항신항|대한통운온산부두
33|33012|SP#8|울산남항신항|(주)한진부두
33|33013|SP#9|울산남항신항|(주)태영부두
33|33014|SP#4(T/S)|울산남항신항|SP#4(T/S)
33|33015|SP#5(T/S)|울산남항신항|SP#5(T/S)
33|33016|SP#9(T/S)|울산남항신항|SP#9(T/S)
34|33017|NBTS#1(N)|울산북항신항|북신항T/S#1부두 모선용(북단)
34|33018|NBTS#2(S)|울산북항신항|북신항T/S#2부두 모선용(남단)
34|33019|NBTS#1(T/S)|울산북항신항|북신항T/S#1부두 자선용
34|33020|NBTS#2(T/S)|울산북항신항|북신항T/S#2부두 자선용
34|33021|NP#1|울산북항신항|NP#1
34|33022|NP#2|울산북항신항|NP#2
34|33023|NP#3|울산북항신항|NP#3
34|33024|NP#4|울산북항신항|NP#4
34|33025|NP#5|울산북항신항|NP#5
34|33026|NP#6|울산북항신항|NP#6
34|33027|NP#7|울산북항신항|NP#7
34|33028|NP#8|울산북항신항|NP#8
34|33029|NP#9|울산북항신항|NP#9
34|33030|NP#10|울산북항신항|NP#10
33|33031|SP#8(T/S)|울산남항신항|SP#8(T/S)
33|33040|SBTS#1|울산남항신항|신항TS1부두(북쪽)
33|33041|SBTS#1(T/S)|울산남항신항|SBTS#1(T/S)
33|33042|SBTS#2|울산남항신항|신항TS2부두(남쪽)
33|33043|SBTS#2(T/S)|울산남항신항|SBTS#2(T/S)
34|33044|KET#2|울산북항신항|코리아에너지터미널(주)
34|33045|KET#3|울산북항신항|코리아에너지터미널(주)
34|33046|KET#4|울산북항신항|코리아에너지터미널(주)
34|33047|KET#6|울산북항신항|코리아에너지터미널(주)
34|33048|NLB#1|울산북항신항|북신항 액체부두
23|40001|T-1|미포항|ANCHORAGE - 미포항
23|40002|T-2|미포항|ANCHORAGE - 미포항
23|40003|T-3|미포항|ANCHORAGE - 미포항
22|40004|W-1|온산항|ANCHORAGE - 온산항
21|40005|HMD#6|울산항|현대미포조선6안벽
23|40006|M-1QN|미포항|미포만 1안벽
23|40007|M-1QS|미포항|미포만 1안벽
23|40008|M-2QW (구 M-4)|미포항|미포만 2안벽
23|40009|M-2QE (구 M-4)|미포항|미포만 2안벽
23|40010|M-3Q (구 M-6)|미포항|미포만 3안벽
23|40011|M-4Q (구 M-7)|미포항|미포만 4안벽
23|40012|M-5Q (구 M-8)|미포항|미포만 5안벽
23|40013|M-6Q|미포항|미포만 6안벽
23|40014|M-7Q (구 M-3)|미포항|미포만 7안벽
23|40015|J-1QN (구 J-14)|미포항|전하만 1안벽
23|40016|J-1QS (구 J-14)|미포항|전하만 1안벽
23|40017|J-2Q|미포항|전하만 2안벽
23|40018|J-3Q (구 J-10)|미포항|전하만 3안벽
23|40019|J-4Q (구 J-11)|미포항|전하만 4안벽
23|40020|J-5Q (구 J-12)|미포항|전하만 5안벽
23|40021|J-6Q (구 J-13)|미포항|전하만 6안벽`;

export function parsePointRows(rows: readonly string[]): PilotPoint[] {
  if (!rows.length || rows.length > 2000) throw new Error('INVALID_POINT_CATALOG');
  const result = new Map<string, PilotPoint>();
  for (const row of rows) {
    const parts = row.split('|');
    if (parts.length !== 5 || !/^\d{2}$/.test(parts[0]) || !/^\d{5}$/.test(parts[1]) ||
      parts.slice(2).some(s => !s.trim() || s.length > 160 || /[\x00-\x1f]/.test(s))) throw new Error('INVALID_POINT_ROW');
    const [portCode, pointCode, name, portName, description] = parts;
    const point = { portCode, pointCode, name, portName, description };
    const key = `${portCode}:${pointCode}`;
    if (result.has(key) && JSON.stringify(result.get(key)) !== JSON.stringify(point)) throw new Error('CONFLICTING_POINT_CODE');
    result.set(key, point);
  }
  return [...result.values()];
}

export const OFFICIAL_CATALOG: PointCatalog = {
  version: 'ulsan-points-20260920-v1', observedAt: '2026-09-20T00:00:00Z',
  points: parsePointRows(OFFICIAL_POINT_ROWS.split('\n')),
};
