# SOF Studio

운항 리포트(Time Sheet)를 브라우저에서 읽어 검토 가능한 Statement of Facts(SOF) 엑셀로 만듭니다.

## 실행

정적 웹사이트이므로 `index.html`을 브라우저에서 열거나 Vercel에 배포하면 됩니다. 업로드 파일은 기본적으로 브라우저 밖으로 전송되지 않습니다.

## 배포

Vercel에서는 Framework Preset을 **Other**로 설정합니다. 별도의 빌드 명령은 필요하지 않습니다.

## Supabase 연동

1. Supabase SQL Editor에서 `supabase/schema.sql`을 실행합니다.
2. Vercel Environment Variables에 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`를 추가합니다.
3. 생성된 SOF 파일과 메타데이터는 비공개 `sof-documents` Storage 버킷 및 `sof_documents` 테이블에 기록됩니다.

서비스 키는 Vercel 서버 환경 변수로만 보관하며, 브라우저에 노출하지 않습니다.
