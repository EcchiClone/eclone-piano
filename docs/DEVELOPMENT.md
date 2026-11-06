# EClone Piano 개발

[README](../README.md) · [설치와 연결](SETUP.md)

## 구조

| 경로                   | 역할                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `public/`              | 스튜디오 UI, Canvas 렌더러, WebCodecs 영상 인코딩              |
| `server/`              | 로컬 HTTP/WebSocket 서버, MIDI 상태, 녹음·재생·파일 관리       |
| `desktop/`             | Electron 스튜디오와 클릭 통과 오버레이                         |
| `shared/paths.cjs`     | 서버·데스크톱·도구에서 함께 쓰는 프로젝트/네이티브 실행 경로   |
| `native/midi/`         | Windows PowerShell에서 실행하는 C# WinMM MIDI 브리지           |
| `native/audio/`        | .NET 9 x64 WASAPI 오디오 도우미. bin/obj는 빌드 산출물         |
| `scripts/doctor.mjs`   | 설치 환경과 기능별 준비 상태 진단                              |
| `scripts/diagnostics/` | 실제 장치 확인·짧은 진단 녹음·기존 WAV 분석                    |
| `scripts/docs/`        | 합성 데모를 사용한 README 스크린샷 생성                        |
| `scripts/lib/`         | 브라우저 선택과 임시 산출물 경로의 공통 코드                   |
| `tests/`               | unit / integration / ui / export / desktop 검사와 공통 fixture |
| `docs/`                | 설치·개발·검증 가이드, 공개용 이미지                           |
| `recordings/`          | 사용자 연주와 설정. Git 추적 제외                              |
| `.runtime/`            | 개발 산출물과 과거 진단 자료. Git 추적 제외                    |

[검사 구성과 실행 명령](../tests/README.md) · [수동 진단 도구](../scripts/diagnostics/README.md)

네이티브 상세: [MIDI 프로토콜](../native/midi/README.md), [오디오 프로토콜](../native/audio/README.md).

## 로컬 검증

```powershell
npm ci
npm run setup
npm test
npm run check
npm run test:ui
npm run test:export
dotnet native/audio/bin/Release/net9.0-windows/ProcessAudio.dll --self-test
```

브라우저 검사는 기본적으로 `C:\Program Files\Google\Chrome\Application\chrome.exe`를 사용합니다. Chrome 경로가 다르면 환경 변수를 지정하세요.

```powershell
$env:ECLONE_TEST_BROWSER = 'C:\path\to\chrome.exe'
npm run test:ui
```

`npm test`는 순수 로직과 가짜 네이티브 프로세스를 사용하는 서버 검사를 포함합니다. 렌더링 픽셀 검사는 사용 가능한 브라우저가 있을 때 실행합니다. UI·영상 검사는 각각 별도 서버와 임시 데이터 디렉터리를 쓰며 실제 녹음을 편집하지 않습니다. 검증 이미지와 결과는 Git에서 제외된 `.runtime/`에 보관합니다. MP4 검사는 FFmpeg·FFprobe·H.264 WebCodecs 지원이 필요합니다.

`npm run test:desktop`은 실행 중인 스튜디오를 종료한 뒤 수행하세요. 테스트가 자신의 Electron 창을 열고 Windows 창 속성과 투명도를 확인합니다. 물리적 클릭 통과·다중 모니터·실제 MIDI/오디오 드라이버 동작은 실제 장치에서도 확인해야 합니다.

다음 검사는 실제 장치를 열거하거나 Kontakt를 잠깐 녹음하므로 개발자가 명시적으로 실행합니다. CI에서는 실행하지 않습니다.

```powershell
npm run diagnose:midi
npm run diagnose:audio -- <Kontakt PID>
```

GitHub Actions는 Windows에서 의존성 설치, 문법·단위·서버 검사, 오디오 도우미 빌드와 합성 오디오 자체검사를 실행합니다. 실제 연주 품질을 CI 통과만으로 보증하지 않습니다.

## 파일을 추가할 때

- 런타임 코드는 public / server / desktop / native 중 담당 계층에 둡니다. 네이티브 도우미 경로는 shared/paths.cjs에서 가져옵니다.
- 자동 검사는 tests 하위의 해당 종류에, 실제 장치를 건드리는 수동 도구는 scripts/diagnostics에 둡니다.
- 공개 README 이미지는 docs/images에 저장하고 `npm run docs:images`로 다시 생성합니다. 테스트 스크린샷과 섞지 않습니다.
- `npm run check`는 모든 JavaScript 소스·도구·검사를 찾아 문법을 확인합니다. 파일을 추가할 때 검사 대상 목록을 따로 고칠 필요가 없습니다.

### 로컬 산출물

| 위치                    | 내용과 수명                                                |
| ----------------------- | ---------------------------------------------------------- |
| `.runtime/reports/`     | 최신 검사 JSON 보고서. 같은 검사를 실행하면 갱신           |
| `.runtime/screenshots/` | 최신 테스트 스크린샷                                       |
| `.runtime/tmp/`         | 테스트별 임시 데이터. 자동 검사는 종료 시 자기 폴더만 정리 |
| `.runtime/archive/`     | 보관한 과거 진단 자료. 자동 검사에서 읽거나 지우지 않음    |

기존 평면 구조의 진단 자료는 정리 시점의 archive 하위 폴더에 원래 파일명으로 보관했습니다. MANIFEST.json에 파일 크기와 SHA-256을 기록했습니다. 과거 일회성 스크립트는 당시 경로를 담은 기록이므로 재실행에는 현재 scripts의 도구를 사용하세요. 이 보관 폴더는 해당 PC의 개발 자료이며 Git에 포함하지 않습니다.

## 설계에서 지켜야 할 점

- MIDI와 PCM은 같은 단조 시계 기준으로 수집하고 저장 시 오디오 프레임 위치에 맞춥니다. 원본 MIDI 바이트와 원래 이벤트 시각은 보존합니다.
- 녹음 샘플레이트는 소스와 맞춥니다. 시스템 시계의 작은 오차를 보정하려고 PCM 중간에 반복적인 무음을 삽입하지 않습니다.
- 라이브 피아노는 재타건과 채널별 서스테인을 처리합니다. 오래 누른 음을 임의의 시간 제한으로 제거하지 않습니다.
- 저장한 연주의 소리는 명시적으로 재생을 시작한 스튜디오에서 한 번만 출력합니다. OBS `audio=1`은 별도 사용자 선택입니다.
- MP4는 `frameIndex / 60` 시점마다 렌더링합니다. 실시간 화면 캡처의 누락 프레임을 복제로 채우지 않습니다. 완료 전에 실제 프레임 수를 확인합니다.
- 녹음·삭제·다운로드·내보내기의 파일 경합과 종료 시 정리를 유지합니다. 사용자 연주는 테스트 fixture로 사용하지 않습니다.
- 서버는 로컬 루프백만 사용합니다. 새로운 원격 접근이나 클라우드 업로드는 별도 설계가 필요합니다.

## 변경 제안

이슈에는 재현 단계와 예상/실제 동작을, PR에는 변경 이유와 관련 검증 결과를 적어 주세요. 개인 녹음·사용자 설정·장치 로그·빌드 산출물은 커밋하지 않습니다. 화면 변경 시 [문서 이미지 생성](images/README.md)으로 README도 갱신합니다.
