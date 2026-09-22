# HYOPU 배포 경계 오류와 승인된 복구 결과 — 2026-09-22

## 확인한 문제

앞선 봇 배포 때 오래된 README를 현재 운영 경로로 받아들여 이 체크아웃을
기존 협운 운영 사이트의 Vercel 프로젝트에 수동 배포했다. 결과적으로 새 봇 경로는
작동하지만 기존 운영 사이트의 최신 번들이 오래된 기반 코드로 교체됐다.
추가 배포를 중지했으며, 자동 롤백/프로젝트 재연결/권한 우회는 하지 않았다.

| 대상 | 실제 확인값 |
|---|---|
| 봇 작업 저장소/브랜치 | `HYOPU/HYOPU`, `codex/hyopu-pilot-bot` |
| 봇 기반 커밋 | `ef848fb338af8c24f0831dc6b39f021e45e23897` |
| Vercel 프로젝트 | `hyopu`, `prj_xUTiRACfyBURBplLBcX3hlrGPx3g` |
| Vercel 실제 Git 연결 | `Hestiafamily/hyopu-operations-workspace`, `main` |
| 현재 운영 주소 | `https://hyopu-ten.vercel.app` |
| 복구 전 주소의 앞선 봇 배포 | `dpl_GX2zrPkzLYVbx4fKjjLQW4zDCHLm` (READY) |
| 직전 정상 운영 Git 배포 | `dpl_83qaoUMcS5Ws4nnkmDgbfnmFaatf` (READY) |
| 직전 운영 커밋 | `ae5be166f14d151e4ac76609e9711b5477e6881a` |
| 차단된 최신 봇 배포 | `dpl_D5D9JhfrBPRcR6vPFVmLMkEpWtBN` (BLOCKED) |

근거는 Vercel project/deployment API 및 두 배포의 실제 브라우저 DOM이다.
직전 배포 URL은 `https://hyopu-3kf0wqqma-hestias-projects-57e91111.vercel.app`다.

복구 전 주소의 메뉴는 운항 캘린더/업무 체크리스트 두 항목인 반면, 직전 운영 배포에는
선박 항차, 부두정보, 담당자 관리, ETA UPDATE도 존재한다. 이는 전체 UI/업무 흐름
비교를 끝냈다는 뜻은 아니지만 기존 최신 기능의 누락을 입증한다.
이 확인에서는 업무 입력·저장·삭제를 하지 않았다.

## 기존 보고의 정정

- GitHub 작성자 Hestiafamily는 정상 인식됐고 Vercel Authentication에도 연결돼 있다.
  따라서 'GitHub 연결만 하면 해결된다'고 단정하지 않는다. Vercel의 차단 문구는
  TEAM_ACCESS_REQUIRED지만 내부 원인은 확정하지 않았다.
- 147개 root 테스트는 이 구형 기반 코드의 테스트이며 실제 운영 저장소의 테스트가 아니다.
- Supabase `hyopu_*` 함수/권한/데이터 보존 검증은 유효하나 웹 번들 보존을 뜻하지 않는다.
- DB 자료 삭제/변조는 이 감사에서 발견하지 않았지만 모든 기존 웹 작업의 영향 범위를
  조사 완료한 것은 아니다. 기존 운영 DB 전체를 복원하거나 되돌려서는 안 된다.

## 복구 전 봇 상태

12:14:58 KST 기준 새 Supabase watcher/webhook 및 additive migration032~037은 운영 중이다.
1분 실행55/55 정상, JSTT20분 예약3/3 정상, 예약 누락0, 중복 알림키/영수증0이다.
초기 과거 수집 완료, 활성5건/오늘~+7일4건, 완료·청구·취소 유입0이다.
외부 신청 제출0, 사용자 수정 초안1건은 그대로 보존했다.
신규 코드 CI는37파일794개 통과했으나 Vercel collector/인앱 최신 코드는 배포 대기다.

## 승인받은 안전한 복구 순서

1. 같은 조직에 협운 봇 전용 Vercel 프로젝트를 만들고 봇 화면/JSTT 수집기만 배포한다.
   기존 portal 환경변수를 복제하지 않고 필요한 HPBOT 서버 전용 변수만 이전한다.
2. 새 주소에서 인증·인앱·JSTT 수집을 검증한다. 임의 실제 도선신청은 하지 않는다.
3. Telegram Mini App URL, Supabase 허용 origin/collector dispatch 주소를 전환한다.
   기존 DB, 채팅방, 봇 ID, 초안, 예산, 중복 방지 기록은 유지한다.
4. 기존 `hyopu` 주소를 직전 정상 운영 배포로 복구하고 운영 UI/API를 읽기 전용 검증한다.
   복구 직전에 더 최신의 정당한 운영 배포가 생겼는지도 확인한다.
5. 기존 운영 저장소의 후속 배포와 봇 배포가 서로 영향을 주지 않는지 검증한다.

사용자는 ‘봇 분리 후 기존 사이트 복구’를 승인했다. 아래와 같이 실행했다.
새 유료 요금제 가입, 유료 좌석 추가, 비용 상한 변경, DB 롤백은 하지 않았다.

## 복구 실행 및 검증

- 봇 전용 Vercel 프로젝트 `hyopu-pilot-bot` / `prj_MiqijgcBtjGxlaFOXDItoLQukEkU`
  생성. 기존 조직 안에 만들었으며 새 요금제는 추가하지 않았다.
- 봇 서버 변수 다섯 개만 sensitive/production으로 저장했다. 기존 portal 변수는
  복제하지 않았으며 모든 키 값은 출력하지 않았다. 정상 Git 작성자/메타데이터 유지.
- 배포 `dpl_5ygj2dfkmkf9Ht2ELq3iZVh42voh`, 기능 코드 `1d1f531`, READY.
  주소 `https://hyopu-pilot-bot.vercel.app/pilot-bot/`.
- 신규 호스트 read-only 수집 probe: HTTP200, HEALTHY, unknown0, 26.304초.
  STOLT FOCUS / 09/23 0700 / N4 확인. 실제 신청 및 테스트용 배정 알림 없음.
- migration038로 고정된 dispatcher endpoint와 Vault URL만 전환하고 이력 등록했다.
  Cron, 인증키, 기존 사건·발송 영수증·현재 자료·예산은 유지했다.
- Supabase mini-app origin을 새 호스트로 변경하고 전용 Edge만 재배포했다.
- 12:33:21 KST BotFather Mini App URL 변경 성공. 기존 방의 도선신청서 링크에서
  새 origin iframe과 Telegram 인증 후 신규/복사/수정 선택 화면을 확인했다.
  JSTT 인앱에서도 협운 STOLT FOCUS/N4와 ‘20분마다 자동 수집’, 선박명 단독 등록
  화면을 확인했다. 중간 입력·가짜 신청·감시목록 변경은 하지 않았다.
- 12:36 KST경 정상 운영 배포 `dpl_83qaoUMcS5Ws4nnkmDgbfnmFaatf`를 promote했다.
  `vercel inspect https://hyopu-ten.vercel.app`로 해당 production alias 확인.
  실제 운영 URL에서 선박 항차·부두정보·담당자 관리·ETA UPDATE 복구 및
  ‘공유 업무 공간 연결됨’, 37 port calls를 읽기 전용으로 확인했다.
  운영 업무자료 저장·삭제·DB 복원은 수행하지 않았다.
- 이 저장소 root build는 기존 운영 프로젝트 배포를 거부하며, 봇 build는
  전용 프로젝트 ID와 저장소 경계를 검증한다. 향후 봇 CLI 배포는 `pilot-bot/`에서만 한다.
  HYOPU 저장소 자동 Git 연결은 구성하지 않았으므로 수동 CLI 배포임을 명시한다.
- 로컬 및 CI `35683284934`: 38파일800/800 통과. 봇 build7개 자산, portal자산0.
- 새 호스트의 12:40 Cron 수집은 12:40:24 정상 완료(23.688초)했다.
  12:41:46 감사상 watcher82/82, JSTT예약5/5, 누락0, 중복키/영수증0,
  신규/수정/복사 활성 유지, 외부 신청 제출0. 완료·청구·취소의 활성 유입0.

복구 검증은 배포 ID·실제 메뉴·공유 자료 로드 범위이며 모든 운영 편집/엑셀 업무의
전체 회귀를 실운영에서 실행했다는 뜻은 아니다. 실제 도선 제출과24시간 비용 검증은 별도다.
