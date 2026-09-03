# HYOPU OneDrive ETA 반자동 동기화

이 도구는 Microsoft Graph·Power Automate 없이, PC의 OneDrive 동기화 폴더에 내려온 `KOREA ETA UPDATE` 엑셀만 HYOPU로 전송합니다. 원본 파일을 외부에 공개하지 않습니다.

## 최초 준비

1. OneDrive에서 ETA 파일이 있는 폴더를 동기화하고, 해당 파일을 **항상 이 장치에 유지**로 설정합니다.
2. HYOPU 운영 담당자에게 받은 동기화 토큰을 Windows 사용자 환경 변수 `HYOPU_ETA_SYNC_TOKEN`으로 설정합니다. 토큰을 파일·Git·메일에 저장하지 마세요.
3. 새 PowerShell 창을 열고 아래처럼 한 번 실행합니다.

```powershell
$env:HYOPU_ETA_SYNC_TOKEN = '<운영 담당자가 전달한 동기화 토큰>'
npm run eta:sync -- --file 'C:\경로\KOREA ETA UPDATE 2020.08.31.xlsx'
```

성공하면 `완료: n건 확인 · n건 갱신`이 표시됩니다. 동일한 파일은 다시 보내지 않습니다.

## 반자동 감시

테스트가 끝난 뒤 아래 명령을 켜 두면 OneDrive 저장이 끝난 45초 후 자동으로 동기화합니다.

```powershell
npm run eta:watch -- --file 'C:\경로\KOREA ETA UPDATE 2020.08.31.xlsx'
```

로그인할 때마다 자동 실행하려면 같은 PowerShell 창에서 다음을 실행합니다.

```powershell
.\scripts\install-eta-sync-task.ps1 -FilePath 'C:\경로\KOREA ETA UPDATE 2020.08.31.xlsx'
```

## 동작과 안전장치

- `.xlsx` 파일이 아닌 경우 전송하지 않습니다.
- 저장 중인 파일은 2초 뒤 다시 확인합니다.
- 동일한 파일 해시는 `%LOCALAPPDATA%\HYOPU\eta-sync-state.json`에 기록해 중복 전송하지 않습니다.
- 파일 변경 뒤 기본 45초를 기다려 OneDrive/Excel의 임시 저장이 끝난 뒤 전송합니다.
- HYOPU 응답이 성공일 때만 동기화 상태를 갱신하므로, 네트워크 오류 뒤에는 다음 파일 변경 또는 수동 실행에서 재시도할 수 있습니다.
