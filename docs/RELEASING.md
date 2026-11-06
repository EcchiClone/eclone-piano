# Windows 배포본 만들기

사용자는 [GitHub Releases](https://github.com/EcchiClone/eclone-piano/releases)의 Setup.exe 또는 ZIP을 사용합니다. 아래는 유지보수자를 위한 빌드 절차입니다.

## 포함하는 구성요소

- Electron + Node.js, 앱 코드와 production npm 의존성.
- .NET 9.0.21 런타임을 포함한 Windows x64 ProcessAudio 도우미. 별도 .NET 설치 없이 EXE로 실행합니다.
- Windows PowerShell MIDI 브리지. PowerShell과 .NET Framework는 지원 Windows에 포함된 구성요소를 사용합니다.
- FFmpeg·FFprobe LGPL shared 빌드와 DLL. 다운로드 URL·SHA-256은 `scripts/release/media-lock.json`으로 고정합니다.
- 앱·Electron·Chromium/Node·.NET·ws·FFmpeg 라이선스와 미디어 빌드 출처. FFmpeg와 원래 빌드 스크립트의 소스 자료는 별도 배포 자산으로 제공합니다.

Kontakt·피아노 음원·loopMIDI·장치 드라이버는 포함하지 않습니다. [사용자 가이드](END_USER.md)에서 준비 방법을 안내합니다.

## 빌드와 검사

Windows x64에서 Node.js와 .NET 9 이상 SDK, 인터넷 연결이 필요합니다.

```powershell
npm ci
npm test
npm run dist:win
npm run test:packaged
npm run release:files
```

`prepare:win`은 `.runtime/distribution/`에 고정 체크섬의 FFmpeg, self-contained 오디오 도우미, 라이선스와 소스를 준비합니다. 이후 electron-builder가 `dist/`에 설치 EXE와 ZIP을 만듭니다. 사용자의 recordings와 개발용 테스트·캐시·진단 파일은 앱 allowlist에 포함되지 않습니다.

`test:packaged`는 실제 빌드한 EXE를 임시 사용자 데이터 폴더에서 실행합니다. PATH에서 Node·dotnet·FFmpeg를 제외하고 네이티브 도우미, 원음이 있는 1080p60 MP4, 오버레이, 설정 저장을 확인합니다. 실제 Kontakt 연주나 장치 드라이버 호환성까지 대신하는 검사는 아닙니다.

설치본·ZIP은 같은 `%APPDATA%\EClone Piano\recordings`를 사용합니다. 앱 파일 교체와 제거가 사용자 데이터를 지우지 않도록 NSIS `deleteAppDataOnUninstall: false`를 유지합니다. `ECLONE_USER_DATA_DIR`은 개발·배포 검증에서만 사용자 데이터 위치를 따로 지정할 때 사용합니다.

## 릴리스

검증한 커밋을 main에 Push하고 버전 태그를 만듭니다. GitHub Releases에 초안으로 자산을 업로드한 뒤 파일 크기·SHA-256과 버전 태그를 확인하고 게시합니다.

- `EClone-Piano-<version>-Windows-x64-Setup.exe`: 권장 설치 프로그램.
- `EClone-Piano-<version>-Windows-x64.zip`: 전체 압축 해제 후 실행. 단일 EXE 이동 금지.
- `EClone-Piano-<version>-ThirdParty-Sources.zip`: FFmpeg 소스와 원래 빌드 스크립트 자료.
- `SHA256SUMS.txt`: 위 파일의 SHA-256.

서명 인증서를 별도로 설정하지 않은 빌드는 unsigned입니다. 릴리스에 그 사실을 적고, 인증서가 생기면 electron-builder의 Windows 코드 서명 설정을 사용합니다. 다운로드 검증을 우회하거나 보안 제품을 끄도록 안내하지 않습니다.

버전 업데이트 시 Electron·.NET 런타임·FFmpeg의 지원 및 보안 패치를 확인하고 lock 파일·고지·소스 자료도 함께 갱신합니다. 빌드 결과의 정확한 버전은 `resources/licenses/`와 `.runtime/distribution/bundle-manifest.json`에 보관합니다.
