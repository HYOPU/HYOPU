# SOF Studio

운항 리포트(Time Sheet)를 브라우저에서 읽어 검토 가능한 Statement of Facts(SOF) 엑셀로 만듭니다.

## 실행

정적 웹사이트이므로 `index.html`을 브라우저에서 열거나 Vercel에 배포하면 됩니다. 업로드 파일은 기본적으로 브라우저 밖으로 전송되지 않습니다.

## 배포

Vercel 프로젝트 설정에서 Framework Preset을 **Other**로 지정하고 배포합니다. 별도의 빌드 명령이나 환경 변수는 필요하지 않습니다.

## Supabase 연동 방향

파일·생성 이력을 저장하려면 Supabase Storage 버킷(`reports`)과 `sof_documents` 테이블을 만든 뒤, Vercel 서버리스 API를 추가해 서비스 키를 서버 환경변수로만 사용하세요. 브라우저에 서비스 키를 넣으면 안 됩니다.
