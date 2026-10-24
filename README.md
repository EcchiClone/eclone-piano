# Luma Piano

Kontakt 연주를 빛으로 보여 주는 Windows 로컬 스튜디오입니다. 외부 계정이나 클라우드 업로드 없이 이 컴퓨터에서 동작합니다.

## 실행

현재 개발 환경에는 의존성과 오디오 도우미가 설치되어 있습니다. **`Luma Piano.vbs`를 더블클릭**하면 콘솔 창 없이 데스크톱 앱이 열립니다. 또는 프로젝트 폴더에서 `npm start`를 실행하세요.

처음 설치하는 컴퓨터에서는 Windows, Node.js 22 이상, .NET 9 SDK가 필요합니다. MP4 변환에는 PATH에 등록된 FFmpeg가 필요합니다. FFmpeg가 없으면 WebM 원본을 보관합니다.

```powershell
npm ci
npm run build:audio
npm start
```

브라우저 전용 실행: `npm run serve` → <http://127.0.0.1:3210>. 브라우저 전용 서버와 데스크톱 앱은 같은 포트를 사용하므로 하나만 실행하세요. 컴퓨터 전체에 겹쳐지는 오버레이는 데스크톱 앱에서 지원합니다.

## Keystation → Kontakt → Luma 연결

1. [loopMIDI 공식 사이트](https://www.tobias-erichsen.de/software/loopmidi.html)에서 설치·실행하고 `Luma Piano` 포트를 만듭니다. loopMIDI는 실행 상태로 유지합니다.
2. Kontakt **Options → MIDI → Outputs → Luma Piano: On**.
3. **Engine → Send MIDI to outside world**에서 **Incoming notes**, **Incoming CCs**, **GUI keyboard**를 체크합니다. 악기 스크립트가 생성하는 노트까지 필요할 때만 Script generated notes/CCs도 선택합니다.
4. Kontakt의 Keystation 입력은 유지합니다. **Luma Piano MIDI 입력은 Off**로 두어 순환 연결을 피합니다.
5. Luma 스튜디오에서 MIDI 장치 새로고침 → **Luma Piano → 연결**. 건반과 페달을 연주하면 이벤트 수, 키 표시와 노트가 반응해야 합니다.

새 포트가 Kontakt에 보이지 않으면 악기 상태를 저장하고 Kontakt를 다시 실행하세요. 하드웨어 MIDI 장치를 Kontakt와 동시에 직접 열 수 있는지는 드라이버마다 다릅니다. 이 환경의 Keystation 직접 동시 열기는 WinMM 오류 7을 반환했으므로 가상 포트 구성을 사용합니다.

Kontakt 설정은 사용자가 직접 조작합니다. 앱은 Kontakt 설정이나 음색을 변경하지 않습니다.

## 세 가지 사용 방식

### 실시간 시각화 / OBS

실시간은 노트가 건반에서 **위로** 뻗어 나갑니다. 음을 누른 시간, 벨로시티와 채널별 서스테인 페달을 반영합니다.

OBS에서 브라우저 소스를 추가하세요.

| 항목          | 값                                              |
| ------------- | ----------------------------------------------- |
| URL           | `http://127.0.0.1:3210/stage?transparent=1`     |
| 너비 / 높이   | 1920 / 1080                                     |
| 프레임률      | 60                                              |
| 라이브 오디오 | OBS의 **응용 프로그램 오디오 캡처 → Kontakt 7** |

브라우저 소스는 UI 없이 투명 캔버스만 보여 주며 디자인과 재생 위치가 스튜디오와 동기화됩니다. 저장된 연주를 원음과 함께 OBS에 재생하려면 URL 끝에 `&audio=1`을 붙이세요. 동일 원음이 중복 출력되지 않도록 OBS 오디오 경로는 하나만 사용합니다.

### 녹음 / 다시 꾸미기 / 영상 내보내기

1. 연주 이름을 입력하고 현재 Kontakt 프로세스를 선택합니다.
2. **Kontakt 소리만 함께 녹음**을 체크하고 **녹음 시작**을 누릅니다.
3. 오디오 준비가 끝나 버튼에 녹음 시간이 표시되면 연주합니다. 입력 미터로 실제 소리 수신을 확인하세요.
4. **녹음 종료**를 누르면 `recordings/`에 원음 WAV와 MIDI 이벤트 세션을 따로 저장합니다.
5. 내 연주에서 재생하고 색상·방향·속도·건반 표시를 바꿉니다. **위에서 아래로** 떨어지는 시각화는 저장된 연주와 데모에서 사용할 수 있습니다.
6. **영상 내보내기**는 현재 디자인을 1920×1080 영상으로 렌더링합니다. 렌더링 동안 앱을 열어 두세요. 원음이 있으면 영상에 포함됩니다. 완성된 영상은 MP4, 변환기를 사용할 수 없으면 WebM입니다.

원음은 Windows의 프로세스별 WASAPI loopback으로 선택한 Kontakt 프로세스 및 하위 프로세스만 캡처합니다. 마이크와 전체 시스템 믹스로 자동 전환하지 않습니다. ASIO·독점 출력은 Windows 공유 오디오 경로를 우회할 수 있습니다. 소리는 들리는데 미터가 조용하면 Kontakt 출력 방식이나 별도 오디오 라우팅을 확인하세요. 현재 개발 컴퓨터의 Kontakt에서는 실제 신호 캡처를 확인했습니다.

WAV는 48 kHz stereo / 16-bit PCM입니다. MIDI는 표준 `.mid`로도 내려받을 수 있습니다. `.session.json`에는 이벤트와 디자인이 저장됩니다. 세션 JSON 가져오기는 MIDI 이벤트를 가져오며 WAV는 포함하지 않습니다. 다른 컴퓨터로 전체 원본을 옮길 때는 해당 UUID의 `.session.json`과 `.wav`를 함께 `recordings/`에 복사하세요. 원음 자체는 변경하지 않으므로 Kontakt 음색을 재합성하는 기능과는 다릅니다.

### 데스크톱 오버레이

모니터를 선택하고 **데스크톱 오버레이**를 누르면 전체 화면의 투명·항상 위·클릭 통과 창이 열립니다.

- **Ctrl + Shift + F10**: 오버레이 켜기 / 끄기
- **Ctrl + Shift + F12**: 오버레이 닫고 스튜디오로 돌아오기

다른 앱이 같은 단축키를 사용하면 스튜디오 버튼으로 닫을 수 있습니다. 스튜디오를 종료하면 오버레이와 로컬 서버도 종료됩니다.

## 디자인

Aurora / Golden / Violet 테마, 파티클, 글로우, 화면에 보이는 시간, 전체 88건반 / 중앙 37건반, 음 이름, 건반 숨김, 투명 배경을 제공합니다. 데모는 디자인 확인용 무음 연주이며 실제 MIDI 연결과 구분해 표시합니다.

## 검증과 개발

```powershell
npm test
npm run check
node native/test-bridge.mjs
dotnet native-audio/bin/Release/net9.0-windows/ProcessAudio.dll --self-test
node native-audio/smoke-test.mjs
```

실행된 서버에서 `node tests/ui-smoke.mjs`는 Chrome headless로 디자인·투명 소스·반응형 화면을 확인하고 `.runtime/`에 스크린샷을 저장합니다. 이 테스트는 잠시 공유 디자인과 재생 위치를 변경한 뒤 복원하므로 방송 중에는 실행하지 마세요. 데스크톱 앱의 자체 테스트는 사용자 앱을 조작하지 않습니다.

구성: `public/` 스튜디오·렌더러, `server/` 로컬 서버·세션, `desktop/` Electron 오버레이, `native/` WinMM MIDI, `native-audio/` 프로세스 오디오 캡처. 자세한 네이티브 프로토콜과 제한은 각 폴더 README를 참고하세요.

연주 파일과 영상, 의존성, 임시 테스트 자료는 Git에 포함하지 않습니다. 기능 단위 커밋으로 구현 이력을 관리합니다.
