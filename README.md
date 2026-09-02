# SOF Studio

운항 리포트(Time Sheet)를 브라우저에서 읽어 검토 가능한 Statement of Facts(SOF) 엑셀로 만듭니다.

## 실행

Node.js 22 이상에서 `npm ci`, `npm test`, `npm run build`, `npm run dev`를 실행하고 `http://127.0.0.1:4173`을 엽니다. 직접 `index.html`을 열지 마세요. 런타임 라이브러리는 빌드에 포함되며 CDN 스크립트를 실행하지 않습니다.

TXT 업로드 또는 이메일 붙여넣기 → 부두/코스터별 검토 → HYOP WOON TIME SHEET XLSX 다운로드 순서입니다. XLSX/XLS/CSV 입력과 기존 SOF의 여러 시트 읽기도 지원합니다. 입력은 브라우저 안에서 처리되며, **Supabase 이력 저장을 선택한 경우에만** 결과 파일을 서버로 전송합니다.

## 배포

Vercel Framework Preset은 **Other**, 빌드 명령은 `npm run build`, 출력 폴더는 `dist`입니다 (`vercel.json`에 설정). PR 브랜치에 push하면 Git 연동 프리뷰가 배포됩니다. `.github/workflows/verify.yml`이 파서/실제 XLSX 재열기 회귀 테스트와 빌드를 실행합니다.

이 저장소의 프로젝트는 `HYOPU/HYOPU` → Vercel `hyopu1/sof-studio`입니다. `jhmarine.kr`에 연결된 저장소나 배포와 동일하다고 가정하지 않습니다. PR 병합/운영 승격은 협업 프로젝트 관리자의 결정입니다.

## Supabase 연동

1. Supabase SQL Editor에서 `supabase/schema.sql`을 실행합니다.
2. Vercel Environment Variables에 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`를 추가합니다.
3. 생성된 SOF 파일과 메타데이터는 비공개 `sof-documents` Storage 버킷 및 `sof_documents` 테이블에 기록됩니다.

PR 프리뷰는 Supabase 환경 변수와 함께 배포됩니다. 서비스 키는 Vercel 서버 환경 변수로만 보관하며, 브라우저에 노출하지 않습니다.

`GET /api/documents`는 설정 유무와 실제 Storage 버킷/테이블 연결 상태만 반환하며 문서 데이터나 키를 노출하지 않습니다. 설정 누락, 업로드 실패, DB 기록 실패는 다운로드 성공과 구분해 화면에 표시합니다. 로컬 정적 서버에는 이 API가 없으므로 클라우드 저장 확인은 배포 환경에서 수행하세요.

운영 보안 주의: 기존 문서 POST API에는 사용자 인증이 없습니다. 운영 공개 전 인증/권한 및 호출 제한을 구성해야 합니다. 현재 이 PR은 협업 프리뷰에서 검증하며, 서버 키의 RLS 우회 권한을 클라이언트 보안으로 간주하지 않습니다.

## 변환 계약과 검증 사례

- BETULA: OP6 / JSTT3 / OTK(S) / CTK, 4시트·7화물. 6월→7월 이월과 전날 검사 주석을 구분합니다.
- KASHI: P42, 1시트·2양하 화물. 선행 NLB#1 대기, NOR, 검역, 샘플 분석을 보존합니다.
- LARIX: P63 / JSTT SP5 / OCEAN ACE 11 / YUE DAN / WOORI HANA / UTT / SK3 / P22, 8시트·10화물. SBTS#1 환적을 코스터별로 분리하며, 취소된 도선이 아니라 실제 출항 직전 도선을 사용합니다.
- 부두는 화물 소속으로, 검사/샘플 주석은 명시된 CGO 번호로 연결합니다. ETA, 선원 이동, 타선 LINE UP 시각을 본선 입출항 시각으로 쓰지 않습니다.
- **리포트의 수치를 우선**합니다. BETULA #390 완료는 `29/1845` (첨부 예시 `29/2018` 아님), CTK #310 B/L은 `1000.278` (예시 `1000.287` 아님)입니다.
- 원문에 없는 NOR TENDERED/ACCEPTED는 추정하지 않고 `REVIEW`와 사유를 출력합니다. HOSE ON이나 검사 통과 시각을 NOR ACCEPTED로 자동 대체하지 않습니다.
- LARIX #115/#117의 명목 수량 5,000MT를 B/L 또는 SHIP 실측량으로 간주하지 않습니다. 리포트의 탱크를 사용하고 예시 문서의 다른 탱크/SHIP FIG를 가져오지 않습니다.
- `templates/agent-sof.xlsx`는 참고 양식의 셀 배치·병합·색상·숫자 형식을 재현한 **서명 없는 빈 양식**입니다. 원본 서명·도장·로고 이미지는 저장소나 새 문서에 복제하지 않습니다.
- 시트당 5화물/14비고를 넘으면 continuation 시트를 추가합니다. 수량은 숫자형과 소수점 3자리 형식으로 저장하며, 모든 입력 문자열은 수식이 아닌 텍스트로 기록합니다.
- 원본 예시는 서로 다른 열폭/행 수/서명 및 일부 미완성 셀이 있습니다. 출력은 동일한 58행 표준 양식으로 통일하며 예시 파일의 바이트 단위 복제는 아닙니다.

코드: `sof-parser.mjs` (순수 파서), `sof-export.mjs` (빈 양식 기반 XLSX), `sof-workbook.mjs` (기존 파일 입력), `app.js` (편집/다운로드 UI). 테스트 fixture는 회귀 검증에 필요한 운항 구간만 포함하고 수신자·연락처·개인 이동 상세는 제외합니다.
