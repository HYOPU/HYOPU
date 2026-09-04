# Excel 웹 ETA → HYOPU 연결

이 구성은 회사 운영 규정에 맞춰 Office Script 안의 전용 `HYOPU_SYNC_KEY`로 HYOPU를 직접 호출합니다. 이 키는 Supabase 키나 Microsoft 비밀번호가 아니라 ETA 동기화만 허용하는 `FLOW_SYNC_SECRET`입니다. 실제 키는 Excel 웹의 개인/공유 스크립트에만 넣고 GitHub에는 올리지 않습니다.

## 1. Excel for web에 코드 넣기

1. `KOREA ETA UPDATE 2020.08.31.xlsx`를 Excel for web에서 엽니다.
2. 상단 **자동화(Automate)** → **새 스크립트(New Script)** → **코드 편집기에서 만들기(Create in Code Editor)**를 누릅니다.
3. 기본 코드를 모두 지우고 [`office-scripts/hyopu-eta-sync.ts`](office-scripts/hyopu-eta-sync.ts)의 내용을 붙여넣습니다.
4. 코드 위쪽의 `PASTE_FLOW_SYNC_SECRET_HERE`만 Vercel Production의 `FLOW_SYNC_SECRET`과 같은 값으로 바꿉니다.
5. 이름을 `HYOPU ETA 동기화`로 저장하고 **실행**합니다. `41건 확인` 완료 문구가 나오는지 확인합니다.

첨부 파일은 현재 표 41건 뒤 1,035행에 오래된 행이 하나 남아 있습니다. 이 스크립트는 헤더 아래의 연속된 현재 표까지만 반환하므로 그 행은 보내지 않습니다.

## 2. 반복 실행 버튼 추가

1. **자동화** → **스크립트 보기**에서 `HYOPU ETA 동기화`를 엽니다.
2. **이 통합 문서와 연결(Associate with workbook)**을 켭니다.
3. **워크시트에 단추 추가(Add button to worksheet)**를 눌러 ETA NOTICE 영역에 배치합니다.
4. ETA 표를 수정·저장한 뒤 이 버튼을 누르면 HYOPU로 직접 반영됩니다.

스크립트는 **맨 앞 `ETA UPDATE(SC포함)` 시트만** 읽습니다. 다른 시트가 앞으로 이동했거나 시트명이 바뀌면 전송하지 않습니다. Microsoft 정책상 `fetch`가 포함된 Office Script는 Excel 앱에서 직접 실행해야 하며 Power Automate의 `Run script`에서는 실행되지 않습니다.

통합 문서 편집 권한이 있는 사람은 연결된 스크립트의 키를 볼 수 있습니다. 회사 규정에 맞는 편집 권한만 부여하고, 담당자 변경이나 외부 공유 후에는 Vercel의 `FLOW_SYNC_SECRET`을 교체한 뒤 Excel 코드도 같은 값으로 갱신하세요.
